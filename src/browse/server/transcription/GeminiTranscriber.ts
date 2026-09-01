import fs from 'fs';
import path from 'path';
import { fetch, type RequestInit, type Response } from 'undici';
import { commonLog, type LogLevel } from '../../../utils/logging/Logger.js';
import type Logger from '../../../utils/logging/Logger.js';
import { createProxyAgentFor } from '../../../utils/Proxy.js';
import { MP3_FORMAT } from './AudioExtractor.js';
import { toSegments, type Word } from './CaptionAssembler.js';
import { TranscriptionError, type TranscribeResult, type Transcriber } from './Transcriber.js';

export const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
export const DEFAULT_MODEL = 'gemini-3.5-transcribe';

/**
 * Gemini is not reachable everywhere, so this defaults to a proxy rather than
 * to going direct - the address the usual local proxies listen on.
 *
 * The same default, and the same `GEMINI_PROXY_URL` environment variable, as
 * the translator uses: one proxy serves both, and somebody who already has
 * translation working has nothing more to set up here.
 */
export const DEFAULT_PROXY_URL = 'http://127.0.0.1:17890';

/**
 * The undici dispatcher for `proxyUrl`, or `undefined` to go direct.
 *
 * A bad proxy URL is not worth failing the request over before it has been
 * tried: it is logged and ignored, and the attempt goes out directly.
 */
function dispatcherFor(proxyUrl: string | null | undefined, logger?: Logger | null) {
  if (!proxyUrl) {
    return undefined;
  }
  try {
    return createProxyAgentFor({ url: proxyUrl })?.agent;
  }
  catch (error) {
    commonLog(logger, 'warn', 'GeminiTranscriber',
      `Ignoring the transcription proxy "${proxyUrl}":`, error);
    return undefined;
  }
}

/**
 * Long, because a clip is up to half an hour of speech and the model is not
 * asked for anything until the whole file has been uploaded.
 */
const REQUEST_TIMEOUT_MS = 900_000;
const UPLOAD_TIMEOUT_MS = 300_000;
const MAX_ATTEMPTS = 3;
/** How long to wait for an uploaded file to become usable. */
const FILE_ACTIVE_TIMEOUT_MS = 60_000;
const FILE_POLL_INTERVAL_MS = 1000;

export interface GeminiSettings {
  apiKey: string | null;
  model: string;
  baseUrl: string;
  /** Proxy the requests go through, or null to go straight out. */
  proxyUrl: string | null;
  /** Terms to steer the model towards. Empty is fine - it simply adds no bias. */
  vocabulary: string[];
}

interface UploadedFile {
  /** `files/xxxx` - what a delete is addressed to. */
  name: string;
  uri: string;
  mimeType: string;
}

/** `"0.100s"`, or a bare number on a provider that changes its mind. */
function parseOffset(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const match = value.match(/^(-?\d+(?:\.\d+)?)s?$/);
  return match ? Number(match[1]) : null;
}

/**
 * Every word the response timed, in order, and the transcript they came from.
 *
 * The annotations are nested a few levels down and the shape is not worth
 * trusting field by field, so this walks what came back and takes the objects
 * that look like a timed word.
 */
export function collectWords(json: any): { text: string; words: Word[] } {
  const texts: string[] = [];
  const words: Word[] = [];

  const visitContent = (content: any) => {
    if (!content || typeof content !== 'object') {
      return;
    }
    if (typeof content.text === 'string') {
      texts.push(content.text);
    }
    const annotations = Array.isArray(content.annotations) ? content.annotations : [];
    for (const annotation of annotations) {
      if (!annotation || annotation.type !== 'word_info') {
        continue;
      }
      const start = parseOffset(annotation.start_offset ?? annotation.startOffset);
      const end = parseOffset(annotation.end_offset ?? annotation.endOffset);
      const text = typeof annotation.text === 'string' ? annotation.text : '';
      if (start === null || end === null || !text) {
        continue;
      }
      words.push({ text, start, end: Math.max(start, end) });
    }
  };

  for (const step of Array.isArray(json?.steps) ? json.steps : []) {
    for (const content of Array.isArray(step?.content) ? step.content : []) {
      visitContent(content);
    }
  }

  const text = texts.join('').trim() ||
    (typeof json?.output_text === 'string' ? json.output_text : '');
  return { text, words };
}

/**
 * Transcribes audio clips with Gemini's speech-to-text model.
 *
 * Three things about that endpoint shape the code here. It is not
 * OpenAI-compatible - the request is an `interactions` call carrying a
 * `transcription_config`, not a multipart upload - so this is a class of its
 * own rather than a base URL. It times words rather than captions, so the
 * captions are assembled here. And word timestamps cannot be combined with
 * smart transcription, so the transcript arrives verbatim, filler words and
 * all.
 *
 * It also accepts a custom vocabulary, which is the reason to reach for it on
 * a library full of jargon: a list of domain terms steers it where a general
 * model guesses.
 */
export default class GeminiTranscriber implements Transcriber {
  name = 'GeminiTranscriber';

  #getSettings: () => GeminiSettings;
  #logger?: Logger | null;

  /**
   * Settings are read through a function rather than captured, because an
   * administrator can change the key, the model or the vocabulary from the
   * browser between one clip and the next.
   */
  constructor(getSettings: () => GeminiSettings, logger?: Logger | null) {
    this.#getSettings = getSettings;
    this.#logger = logger;
  }

  get model() {
    return this.#getSettings().model;
  }

  /**
   * MP3 rather than the Opus the rest of the pipeline prefers: the documented
   * format list names Ogg Vorbis, and an Opus stream in an Ogg container is
   * not that. A clip is a few megabytes either way.
   */
  get audioFormat() {
    return MP3_FORMAT;
  }

  #settings() {
    const settings = this.#getSettings();
    if (!settings.apiKey) {
      throw new TranscriptionError(
        'No Gemini API key is configured. An administrator can set one in the ' +
        'transcription settings.'
      );
    }
    return {
      ...settings,
      // Repeated after the spread rather than left to it: the check above
      // narrows `apiKey` to a string, and spreading widens it back to the
      // declared `string | null`, which every call below would then have to
      // re-check for a case that cannot reach them.
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl.replace(/\/+$/, '')
    };
  }

  /**
   * Checks a key by asking for the model list, so a mistyped one is caught
   * when it is entered rather than when the first video fails.
   *
   * Gemini reports no quota or spend against a key, so unlike OpenRouter there
   * is nothing to show beyond "this one works".
   */
  static async describeKey(
    apiKey: string,
    baseUrl = DEFAULT_BASE_URL,
    proxyUrl: string | null = DEFAULT_PROXY_URL,
    signal?: AbortSignal
  ): Promise<void> {
    const url = `${baseUrl.replace(/\/+$/, '')}/v1beta/models?pageSize=1`;
    let response: Response;
    try {
      // Through the same proxy the transcriptions themselves go through, so
      // that a key verified here is a key that will work there.
      response = await fetch(url, {
        headers: { 'x-goog-api-key': apiKey },
        dispatcher: dispatcherFor(proxyUrl),
        signal
      });
    }
    catch (error) {
      throw new TranscriptionError(
        `Could not reach Gemini${proxyUrl ? ` through ${proxyUrl}` : ''}: ` +
        `${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!response.ok) {
      const detail = extractError(await response.text());
      const rejected = response.status === 400 || response.status === 401 || response.status === 403;
      throw new TranscriptionError(
        rejected ?
          `Gemini rejected the API key (HTTP ${response.status}): ${detail}`
          : `HTTP ${response.status}: ${detail}`,
        response.status
      );
    }
  }

  async transcribe(
    audioPath: string,
    language: string | null | undefined,
    signal?: AbortSignal
  ): Promise<TranscribeResult> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (signal?.aborted) {
        throw Error('Aborted');
      }
      try {
        return await this.#run(audioPath, language, signal);
      }
      catch (error) {
        lastError = error;
        if (signal?.aborted) {
          throw Error('Aborted');
        }
        const err = error instanceof TranscriptionError ? error : null;
        // A quota that has run out answers 429 the same way a burst does.
        // Both are retried, and then given up on: moving to another provider
        // is a decision for whoever is watching, not something to do quietly
        // at a different price.
        const worthRetrying = !err || err.status === null || err.status === 429 || err.status >= 500;
        if (!worthRetrying || attempt === MAX_ATTEMPTS) {
          throw error;
        }
        const wait = 2000 * attempt;
        this.log('warn',
          `Attempt ${attempt} of ${MAX_ATTEMPTS} failed (${err?.message || String(error)}); ` +
          `retrying in ${wait / 1000}s`
        );
        await sleep(wait, signal);
      }
    }
    throw lastError || new TranscriptionError('Transcription failed');
  }

  /**
   * The deployed API turns away a `custom_vocabulary` sent together with word
   * timestamps, although the documentation shows the two combined. The error
   * is a plain 400, so it is matched on its wording and the request goes out
   * again without the vocabulary rather than failing the whole video: the
   * subtitles still get built, and the polishing pass keeps correcting terms
   * against the vocabulary afterwards. If the API starts accepting the pair,
   * the biasing simply comes back on its own.
   */
  #isVocabularyConflict(error: unknown): boolean {
    return error instanceof TranscriptionError && error.status === 400 &&
      /custom_vocabulary is incompatible/i.test(error.message);
  }

  #buildBody(model: string, file: UploadedFile, language: string | null | undefined, vocabulary: string[]) {
    return {
      model,
      input: [ { type: 'audio', uri: file.uri, mime_type: file.mimeType } ],
      generation_config: {
        transcription_config: {
          // Omitted rather than guessed at, which is what turns on the
          // model's own detection and its handling of code-switching.
          ...(language ? { language_codes: [ language ] } : {}),
          ...(vocabulary.length > 0 ? { custom_vocabulary: vocabulary } : {}),
          mode: {
            // Not "smart": that would clean up filler words and formatting,
            // but cannot be combined with timestamps, and without timestamps
            // there is no subtitle to build.
            type: 'verbatim',
            timestamp_granularities: [ 'word' ]
          }
        }
      }
    };
  }

  async #run(
    audioPath: string,
    language: string | null | undefined,
    signal?: AbortSignal
  ): Promise<TranscribeResult> {
    const { apiKey, model, baseUrl, vocabulary } = this.#settings();
    const file = await this.#upload(audioPath, baseUrl, apiKey, signal);
    try {
      this.log('debug',
        `Transcribing "${path.basename(audioPath)}" with ${model}` +
        `${vocabulary.length > 0 ? ` and ${vocabulary.length} vocabulary terms` : ''}`
      );
      let json: any;
      try {
        json = await this.#post(
          `${baseUrl}/v1beta/interactions`, apiKey,
          this.#buildBody(model, file, language, vocabulary), signal
        );
      }
      catch (error) {
        if (vocabulary.length === 0 || !this.#isVocabularyConflict(error) || signal?.aborted) {
          throw error;
        }
        this.log('warn',
          'Gemini refused the vocabulary together with word timestamps; ' +
          'retrying without it. The polishing pass can still correct the terms.'
        );
        json = await this.#post(
          `${baseUrl}/v1beta/interactions`, apiKey,
          this.#buildBody(model, file, language, []), signal
        );
      }
      const { text, words } = collectWords(json);
      if (words.length === 0) {
        throw new TranscriptionError(
          'The response carried no word timestamps, so subtitles cannot be built. ' +
          `Model "${model}" may not support timestamp_granularities.`
        );
      }
      return {
        segments: toSegments(text, words),
        words,
        // Gemini does not report which language it settled on, so what was
        // asked for is all there is to pass on.
        language: language || null,
        // Nor any usage figures. Null is "not reported" - the history shows a
        // blank rather than a zero that would read as free.
        seconds: null,
        cost: null
      };
    }
    finally {
      // Uploaded clips are kept for 48 hours and count against the project's
      // storage. A long video is dozens of them, so they go as they are used.
      await this.#deleteFile(file.name, baseUrl, apiKey);
    }
  }

  /** The two-stage resumable upload, which is the only one the Files API offers. */
  async #upload(
    audioPath: string,
    baseUrl: string,
    apiKey: string,
    signal?: AbortSignal
  ): Promise<UploadedFile> {
    const bytes = fs.readFileSync(audioPath);
    const mimeType = this.audioFormat.mimeType;
    const displayName = path.basename(audioPath);

    const startResponse = await this.#fetch(
      `${baseUrl}/upload/v1beta/files`,
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'X-Goog-Upload-Protocol': 'resumable',
          'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Length': String(bytes.length),
          'X-Goog-Upload-Header-Content-Type': mimeType,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ file: { display_name: displayName } })
      },
      UPLOAD_TIMEOUT_MS,
      signal
    );
    if (!startResponse.ok) {
      throw this.#fail(startResponse.status, extractError(await startResponse.text()));
    }
    const uploadUrl = startResponse.headers.get('x-goog-upload-url');
    if (!uploadUrl) {
      throw new TranscriptionError('The Files API did not return an upload URL');
    }

    const uploadResponse = await this.#fetch(
      uploadUrl,
      {
        method: 'POST',
        headers: {
          'X-Goog-Upload-Offset': '0',
          'X-Goog-Upload-Command': 'upload, finalize'
        },
        body: new Uint8Array(bytes)
      },
      UPLOAD_TIMEOUT_MS,
      signal
    );
    const uploadBody = await uploadResponse.text();
    if (!uploadResponse.ok) {
      throw this.#fail(uploadResponse.status, extractError(uploadBody));
    }
    let file: any;
    try {
      file = JSON.parse(uploadBody)?.file;
    }
    catch {
      throw new TranscriptionError(`Upload response was not JSON: ${uploadBody.slice(0, 200)}`);
    }
    if (!file?.uri || !file?.name) {
      throw new TranscriptionError('The Files API returned no file to transcribe');
    }
    const uploaded: UploadedFile = {
      name: file.name,
      uri: file.uri,
      mimeType: file.mimeType || file.mime_type || mimeType
    };
    await this.#waitUntilActive(uploaded, file.state, baseUrl, apiKey, signal);
    return uploaded;
  }

  /**
   * Audio is normally usable the moment it finishes uploading, but a file
   * still being processed would be rejected by the model with an error that
   * says nothing about why - so it is waited for rather than raced.
   */
  async #waitUntilActive(
    file: UploadedFile,
    initialState: unknown,
    baseUrl: string,
    apiKey: string,
    signal?: AbortSignal
  ) {
    let state = typeof initialState === 'string' ? initialState : 'ACTIVE';
    const deadline = Date.now() + FILE_ACTIVE_TIMEOUT_MS;
    while (state === 'PROCESSING') {
      if (Date.now() > deadline) {
        throw new TranscriptionError(
          `Uploaded audio was still being processed after ${FILE_ACTIVE_TIMEOUT_MS / 1000}s`,
          null,
          true
        );
      }
      await sleep(FILE_POLL_INTERVAL_MS, signal);
      const response = await this.#fetch(
        `${baseUrl}/v1beta/${file.name}`,
        { headers: { 'x-goog-api-key': apiKey } },
        UPLOAD_TIMEOUT_MS,
        signal
      );
      if (!response.ok) {
        throw this.#fail(response.status, extractError(await response.text()));
      }
      state = ((await response.json()) as any)?.state || 'ACTIVE';
    }
    if (state === 'FAILED') {
      throw new TranscriptionError('Gemini could not process the uploaded audio', null, true);
    }
  }

  /** Best effort: a clip left behind expires on its own in 48 hours. */
  async #deleteFile(name: string, baseUrl: string, apiKey: string) {
    try {
      await fetch(`${baseUrl}/v1beta/${name}`, {
        method: 'DELETE',
        headers: { 'x-goog-api-key': apiKey },
        dispatcher: this.#dispatcher()
      });
    }
    catch (error) {
      this.log('debug', `Could not delete uploaded file "${name}":`, error);
    }
  }

  async #post(url: string, apiKey: string, body: unknown, signal?: AbortSignal) {
    const response = await this.#fetch(
      url,
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      },
      REQUEST_TIMEOUT_MS,
      signal
    );
    const text = await response.text();
    if (!response.ok) {
      throw this.#fail(response.status, extractError(text));
    }
    try {
      return JSON.parse(text);
    }
    catch {
      throw new TranscriptionError(`Response was not JSON: ${text.slice(0, 200)}`);
    }
  }

  /**
   * The proxy in force right now.
   *
   * Read per request rather than held, for the same reason the key is: an
   * administrator can change it between one clip and the next.
   */
  #dispatcher() {
    return dispatcherFor(this.#getSettings().proxyUrl, this.#logger);
  }

  /** `fetch` with a ceiling of its own, and the job's abort wired through. */
  async #fetch(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await fetch(url, {
        ...init,
        dispatcher: this.#dispatcher(),
        signal: controller.signal
      });
    }
    catch (error) {
      if (signal?.aborted) {
        throw Error('Aborted');
      }
      // undici reports every transport failure as "fetch failed" and puts the
      // reason in `cause`, which is worth digging out: the common failure of
      // this feature is a proxy that is not listening, and "fetch failed" on
      // its own sends someone off to look at their API key instead.
      const proxyUrl = this.#getSettings().proxyUrl;
      const cause = (error as { cause?: unknown })?.cause;
      const detail = cause instanceof Error ?
        `${(error as Error).message}: ${cause.message}`
        : error instanceof Error ? error.message : String(error);
      // An upstream that ran out of time closes the connection rather than
      // answering, so a shorter clip may well succeed.
      throw new TranscriptionError(
        `Request failed${proxyUrl ? ` (through ${proxyUrl})` : ''}: ${detail}`,
        null,
        true
      );
    }
    finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  #fail(status: number, detail: string) {
    if (status === 401 || status === 403) {
      return new TranscriptionError(
        `Gemini rejected the API key (HTTP ${status}): ${detail}`, status
      );
    }
    if (status === 429) {
      return new TranscriptionError(
        `Gemini quota or rate limit reached (HTTP 429): ${detail}`, status
      );
    }
    // Half an hour is the ceiling with word timestamps switched on, and a clip
    // over it is exactly what halving fixes.
    const tooLong = /too long|duration|exceeds|payload|size/i.test(detail);
    const splittable = status === 408 || status === 504 || status >= 500 ||
      (status === 400 && tooLong);
    return new TranscriptionError(`HTTP ${status}: ${detail}`, status, splittable);
  }

  protected log(level: LogLevel, ...msg: any[]) {
    commonLog(this.#logger, level, this.name, ...msg);
  }
}

function extractError(body: string) {
  try {
    const json = JSON.parse(body);
    return json?.error?.message || json?.message || body.slice(0, 200);
  }
  catch {
    return body.slice(0, 200);
  }
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(Error('Aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
