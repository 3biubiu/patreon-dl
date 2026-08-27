import fs from 'fs';
import path from 'path';
import { commonLog, type LogLevel } from '../../../utils/logging/Logger.js';
import type Logger from '../../../utils/logging/Logger.js';
import { type Segment } from './SubtitleBuilder.js';
import { type KeyDescription } from '../../types/Transcription.js';

export { type KeyDescription } from '../../types/Transcription.js';

export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
export const DEFAULT_MODEL = 'openai/whisper-large-v3-turbo';

/** Upload ceiling for a multipart request, per OpenRouter's documentation. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/**
 * Generous next to what was measured - 24 minutes of audio came back in 24s,
 * and a cold upstream adds about 10s - but short enough that a wedged request
 * does not hold a job open indefinitely.
 */
const REQUEST_TIMEOUT_MS = 300_000;
const MAX_ATTEMPTS = 3;

export class TranscriptionError extends Error {
  status: number | null;
  /** True when splitting the clip and retrying is worth trying. */
  retryableBySplitting: boolean;

  constructor(message: string, status: number | null = null, retryableBySplitting = false) {
    super(message);
    this.name = 'TranscriptionError';
    this.status = status;
    this.retryableBySplitting = retryableBySplitting;
  }
}

export interface TranscribeResult {
  segments: Segment[];
  language: string | null;
  /** Seconds of audio billed, as reported by the API. */
  seconds: number | null;
  cost: number | null;
}

interface APISegment {
  start: number;
  end: number;
  text: string;
  avg_logprob?: number;
  no_speech_prob?: number;
}

/**
 * Transcribes audio clips through OpenRouter's speech-to-text endpoint.
 *
 * Two things about that endpoint shape the code here. It refuses to emit SRT
 * or VTT, so subtitles are assembled locally from the segment list. And
 * segment timestamps only come back under `verbose_json`, which OpenRouter
 * only honours for OpenAI-compatible upstreams - the default model is served
 * by one, but a model substituted for it might not be, in which case
 * timestamps go missing and there is nothing to build subtitles from.
 */
export interface TranscriberSettings {
  apiKey: string | null;
  model: string;
  baseUrl: string;
}

export default class OpenRouterTranscriber {
  name = 'OpenRouterTranscriber';

  #getSettings: () => TranscriberSettings;
  #logger?: Logger | null;

  /**
   * Settings are read through a function rather than captured, because an
   * administrator can set the key from the browser: a value captured at
   * startup would leave the feature dead until the server was restarted.
   */
  constructor(getSettings: () => TranscriberSettings, logger?: Logger | null) {
    this.#getSettings = getSettings;
    this.#logger = logger;
  }

  get model() {
    return this.#getSettings().model;
  }

  #settings() {
    const settings = this.#getSettings();
    if (!settings.apiKey) {
      throw new TranscriptionError(
        'No OpenRouter API key is configured. An administrator can set one in the ' +
        'transcription settings.'
      );
    }
    return { ...settings, baseUrl: settings.baseUrl.replace(/\/+$/, '') };
  }

  /**
   * Asks OpenRouter about a key, so a mistyped one is caught when it is
   * entered rather than when the first video fails to transcribe.
   *
   * The label comes back already masked by OpenRouter, which saves having to
   * hold the key anywhere just to display part of it.
   */
  static async describeKey(
    apiKey: string,
    baseUrl = DEFAULT_BASE_URL,
    signal?: AbortSignal
  ): Promise<KeyDescription> {
    const url = `${baseUrl.replace(/\/+$/, '')}/key`;
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal
      });
    }
    catch (error) {
      throw new TranscriptionError(
        `Could not reach OpenRouter: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new TranscriptionError('OpenRouter rejected this API key', response.status);
    }
    if (!response.ok) {
      throw new TranscriptionError(`OpenRouter returned HTTP ${response.status}`, response.status);
    }
    const json = await response.json() as {
      data?: {
        label?: string;
        usage?: number;
        limit?: number | null;
        limit_remaining?: number | null;
        is_free_tier?: boolean;
      };
    };
    return {
      label: json.data?.label || null,
      usage: json.data?.usage ?? null,
      limit: json.data?.limit ?? null,
      limitRemaining: json.data?.limit_remaining ?? null,
      isFreeTier: json.data?.is_free_tier ?? null
    };
  }

  /**
   * Transcribes one audio file. `language` should be set once it is known, so
   * that later clips of the same video cannot be detected as something else.
   */
  async transcribe(
    audioPath: string,
    language?: string | null,
    signal?: AbortSignal
  ): Promise<TranscribeResult> {
    const size = fs.statSync(audioPath).size;
    if (size > MAX_UPLOAD_BYTES) {
      throw new TranscriptionError(
        `Audio clip is ${(size / 1048576).toFixed(1)} MB, over the ${MAX_UPLOAD_BYTES / 1048576} MB limit`,
        null,
        true
      );
    }

    let lastError: TranscriptionError | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this.#post(audioPath, language, signal);
      }
      catch (error) {
        if (signal?.aborted) {
          throw error;
        }
        const err = error instanceof TranscriptionError ? error
          : new TranscriptionError(error instanceof Error ? error.message : String(error));
        lastError = err;
        // 4xx other than rate limiting will fail the same way next time.
        const worthRetrying = err.status === null || err.status === 429 || err.status >= 500;
        if (!worthRetrying || attempt === MAX_ATTEMPTS) {
          throw err;
        }
        const backoff = 2000 * attempt;
        this.log('debug', `Attempt ${attempt} failed (${err.message}); retrying in ${backoff}ms`);
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
    throw lastError || new TranscriptionError('Transcription failed');
  }

  async #post(
    audioPath: string,
    language: string | null | undefined,
    signal?: AbortSignal
  ): Promise<TranscribeResult> {
    // Read once per request: an administrator can change the key or model
    // between one clip and the next.
    const { apiKey, model, baseUrl } = this.#settings();
    const form = new FormData();
    const data = fs.readFileSync(audioPath);
    form.append('file', new Blob([ data ], { type: 'audio/ogg' }), path.basename(audioPath));
    form.append('model', model);
    // Without these two the response carries plain text and no timestamps.
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');
    if (language) {
      form.append('language', language);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: controller.signal
      });
    }
    catch (error) {
      if (signal?.aborted) {
        throw Error('Aborted');
      }
      // An upstream that ran out of time closes the connection rather than
      // answering, so a shorter clip may well succeed.
      throw new TranscriptionError(
        `Request failed: ${error instanceof Error ? error.message : String(error)}`,
        null,
        true
      );
    }
    finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    const body = await response.text();
    if (!response.ok) {
      const detail = this.#extractError(body);
      if (response.status === 401 || response.status === 403) {
        throw new TranscriptionError(
          `OpenRouter rejected the API key (HTTP ${response.status}): ${detail}`,
          response.status
        );
      }
      // A timed-out upstream is commonly reported as a gateway error.
      const splittable = response.status === 408 || response.status === 504 || response.status >= 500;
      throw new TranscriptionError(`HTTP ${response.status}: ${detail}`, response.status, splittable);
    }

    let json: {
      segments?: APISegment[];
      language?: string;
      text?: string;
      usage?: { seconds?: number; cost?: number };
    };
    try {
      json = JSON.parse(body);
    }
    catch {
      throw new TranscriptionError(`Response was not JSON: ${body.slice(0, 200)}`);
    }

    if (!Array.isArray(json.segments)) {
      throw new TranscriptionError(
        `Response carried no timestamped segments, so subtitles cannot be built. ` +
        `Model "${model}" may be served by an upstream that does not support ` +
        `verbose_json.`
      );
    }

    const segments: Segment[] = json.segments
      .filter((s) => typeof s.start === 'number' && typeof s.end === 'number')
      .map((s) => ({
        start: s.start,
        end: s.end,
        text: typeof s.text === 'string' ? s.text : '',
        avgLogprob: typeof s.avg_logprob === 'number' ? s.avg_logprob : null
      }));

    return {
      segments,
      language: json.language || null,
      seconds: json.usage?.seconds ?? null,
      cost: json.usage?.cost ?? null
    };
  }

  #extractError(body: string) {
    try {
      const json = JSON.parse(body);
      return json?.error?.message || json?.message || body.slice(0, 200);
    }
    catch {
      return body.slice(0, 200);
    }
  }

  protected log(level: LogLevel, ...msg: any[]) {
    commonLog(this.#logger, level, this.name, ...msg);
  }
}
