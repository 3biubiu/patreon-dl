import { commonLog, type LogLevel } from '../../../utils/logging/Logger.js';
import type Logger from '../../../utils/logging/Logger.js';
import { type TranslationKeyDescription } from '../../types/Translation.js';
import { buildSystemPrompt } from './TranslationPrompt.js';

export { type TranslationKeyDescription } from '../../types/Translation.js';

export const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

/**
 * Long enough for a large batch on a cold model, short enough that a wedged
 * request does not hold a job open indefinitely.
 */
const REQUEST_TIMEOUT_MS = 180_000;
/**
 * Attempts per call, and only for failures a second attempt could survive -
 * rate limiting and upstream errors. Gemini bills by the call, so a fixed
 * ceiling here is a fixed ceiling on what one batch can cost.
 */
const MAX_ATTEMPTS = 3;

export class TranslationError extends Error {
  status: number | null;
  /** True when halving the batch and asking again is worth trying. */
  retryableBySplitting: boolean;
  /** Calls this error cost, so a failed batch is still accounted for. */
  requests: number;

  constructor(message: string, status: number | null = null, retryableBySplitting = false) {
    super(message);
    this.name = 'TranslationError';
    this.status = status;
    this.retryableBySplitting = retryableBySplitting;
    this.requests = 0;
  }
}

/** One subtitle line on its way out, keyed by its position in the file. */
export interface TranslatableLine {
  i: number;
  t: string;
}

export interface TranslateBatchResult {
  /** Index to translation. May come back short of what was asked for. */
  translations: Map<number, string>;
  /** Calls actually made, which is what Gemini bills by. */
  requests: number;
}

export interface TranslatorSettings {
  apiKey: string | null;
  model: string;
  baseUrl: string;
  prompt: string | null;
  disableThinking: boolean;
}

/**
 * The shape asked of the model. Constraining the response to a schema is what
 * keeps a malformed answer - and the extra call it would cost to ask again -
 * rare rather than routine.
 */
const RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      i: { type: 'INTEGER' },
      t: { type: 'STRING' }
    },
    required: [ 'i', 't' ]
  }
};

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
}

/**
 * Translates batches of subtitle lines through Gemini's `generateContent`.
 *
 * Gemini AI Studio bills by the call rather than by the token, and that is
 * what shapes this class: batches are as large as the caller cares to make
 * them, a batch is sent once, and a batch that comes back incomplete is
 * repaired by asking about the missing lines alone rather than by asking for
 * all of them again. There is no reflection pass and no validate-and-resend
 * loop - both multiply the call count for a gain per-call billing does not
 * pay for.
 */
export default class GeminiTranslator {
  name = 'GeminiTranslator';

  #getSettings: () => TranslatorSettings;
  #logger?: Logger | null;

  /**
   * Settings are read through a function rather than captured, so that a key
   * or model set from the browser takes effect without a restart.
   */
  constructor(getSettings: () => TranslatorSettings, logger?: Logger | null) {
    this.#getSettings = getSettings;
    this.#logger = logger;
  }

  get model() {
    return this.#getSettings().model;
  }

  #settings() {
    const settings = this.#getSettings();
    if (!settings.apiKey) {
      throw new TranslationError(
        'No Gemini API key is configured. An administrator can set one in the ' +
        'translation settings.'
      );
    }
    return { ...settings, baseUrl: settings.baseUrl.replace(/\/+$/, '') };
  }

  /**
   * Asks Gemini which models a key can see, so a mistyped key is caught when
   * it is entered rather than at the first video.
   *
   * Doubles as a check that the configured model is one of them: a model name
   * that does not exist otherwise only surfaces as a 404 halfway through a
   * job, after the earlier batches have already been paid for.
   */
  static async describeKey(
    apiKey: string,
    baseUrl = DEFAULT_BASE_URL,
    model = DEFAULT_MODEL,
    signal?: AbortSignal
  ): Promise<TranslationKeyDescription> {
    const url = `${baseUrl.replace(/\/+$/, '')}/models?pageSize=1000`;
    let response: Response;
    try {
      response = await fetch(url, { headers: { 'x-goog-api-key': apiKey }, signal });
    }
    catch (error) {
      throw new TranslationError(
        `Could not reach Gemini: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new TranslationError('Gemini rejected this API key', response.status);
    }
    if (!response.ok) {
      throw new TranslationError(`Gemini returned HTTP ${response.status}`, response.status);
    }
    const json = await response.json() as { models?: { name?: string }[] };
    const models = json.models || [];
    // Names come back as `models/gemini-...`, so compare on the last segment
    // and let either form be typed into the settings form.
    const wanted = model.replace(/^models\//, '');
    return {
      modelCount: models.length,
      modelFound: models.some((m) => (m.name || '').replace(/^models\//, '') === wanted)
    };
  }

  /**
   * Translates one batch. `context` is the tail of the previous batch, given
   * only so a sentence broken across the boundary reads as one - it is not
   * translated and nothing comes back for it.
   */
  async translateBatch(
    lines: TranslatableLine[],
    context: string[],
    signal?: AbortSignal
  ): Promise<TranslateBatchResult> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return { translations: await this.#post(lines, context, signal), requests: attempt };
      }
      catch (error) {
        if (signal?.aborted) {
          throw error;
        }
        const err = error instanceof TranslationError ? error
          : new TranslationError(error instanceof Error ? error.message : String(error));
        // 4xx other than rate limiting will fail the same way next time, and
        // every attempt is another billed call.
        const worthRetrying = err.status === null || err.status === 429 || err.status >= 500;
        if (!worthRetrying || attempt === MAX_ATTEMPTS) {
          err.requests = attempt;
          throw err;
        }
        const backoff = 3000 * attempt;
        this.log('debug', `Attempt ${attempt} failed (${err.message}); retrying in ${backoff}ms`);
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
    // Unreachable: the loop either returns or throws on its last attempt.
    throw new TranslationError('Translation failed');
  }

  async #post(
    lines: TranslatableLine[],
    context: string[],
    signal?: AbortSignal
  ): Promise<Map<number, string>> {
    // Read once per call: an administrator can change the key, model or
    // prompt between one batch and the next.
    const { apiKey, model, baseUrl, prompt, disableThinking } = this.#settings();

    const said: string[] = [];
    if (context.length > 0) {
      said.push(
        '<context>\n' +
        'The lines immediately before these, for continuity only. Do not translate ' +
        'them and do not return them.\n' +
        context.join('\n') +
        '\n</context>\n'
      );
    }
    said.push(JSON.stringify(lines));

    const body: Record<string, unknown> = {
      systemInstruction: { parts: [ { text: buildSystemPrompt(prompt) } ] },
      contents: [ { role: 'user', parts: [ { text: said.join('') } ] } ],
      generationConfig: {
        // Low, not zero: subtitles read better for a little freedom, and zero
        // leaves a model that has started repeating itself doing so.
        temperature: 0.3,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
        // `maxOutputTokens` is deliberately not sent. Gemini defaults it to
        // the model's own ceiling, and a number guessed here would either
        // truncate a large batch or be rejected by a model whose ceiling is
        // lower than the guess.
        ...(disableThinking ? { thinkingConfig: { thinkingBudget: 0 } } : {})
      }
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    let response: Response;
    try {
      response = await fetch(
        `${baseUrl}/models/${encodeURIComponent(model.replace(/^models\//, ''))}:generateContent`,
        {
          method: 'POST',
          headers: { 'x-goog-api-key': apiKey as string, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal
        }
      );
    }
    catch (error) {
      if (signal?.aborted) {
        throw Error('Aborted');
      }
      // A model that ran out of time closes the connection rather than
      // answering, so a smaller batch may well survive.
      throw new TranslationError(
        `Request failed: ${error instanceof Error ? error.message : String(error)}`,
        null,
        true
      );
    }
    finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    const text = await response.text();
    if (!response.ok) {
      const detail = this.#extractError(text);
      if (response.status === 400 || response.status === 401 || response.status === 403) {
        throw new TranslationError(
          `Gemini rejected the request (HTTP ${response.status}): ${detail}`,
          response.status
        );
      }
      if (response.status === 404) {
        throw new TranslationError(
          `Gemini has no model "${model}" for this key (HTTP 404): ${detail}`,
          response.status
        );
      }
      throw new TranslationError(`HTTP ${response.status}: ${detail}`, response.status);
    }

    let json: GeminiResponse;
    try {
      json = JSON.parse(text);
    }
    catch {
      throw new TranslationError(`Response was not JSON: ${text.slice(0, 200)}`);
    }

    if (json.promptFeedback?.blockReason) {
      throw new TranslationError(
        `Gemini refused this batch (${json.promptFeedback.blockReason})`
      );
    }
    const candidate = json.candidates?.[0];
    const answer = (candidate?.content?.parts || []).map((p) => p.text || '').join('');
    if (!answer.trim()) {
      const reason = candidate?.finishReason || 'no candidates';
      throw new TranslationError(
        `Gemini returned nothing (${reason})`,
        null,
        // A batch cut off at the output ceiling is exactly the case a smaller
        // batch fixes.
        reason === 'MAX_TOKENS'
      );
    }
    // `MAX_TOKENS` with text is a truncated array. Whatever parsed is kept and
    // the caller repairs the tail, rather than paying for the batch twice.
    return this.#parse(answer, candidate?.finishReason === 'MAX_TOKENS');
  }

  /**
   * Reads the answer into a map. `truncated` says the JSON was cut off, in
   * which case the salvageable prefix is taken rather than the batch thrown
   * away - the missing tail then costs one small repair call instead of a
   * whole batch.
   */
  #parse(answer: string, truncated: boolean): Map<number, string> {
    const cleaned = answer.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    let items: unknown;
    try {
      items = JSON.parse(cleaned);
    }
    catch (error) {
      if (!truncated) {
        throw new TranslationError(
          `Could not read the translation: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      items = this.#salvage(cleaned);
    }
    if (!Array.isArray(items)) {
      throw new TranslationError('Gemini returned something other than a list of translations');
    }
    const translations = new Map<number, string>();
    for (const item of items) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const { i, t } = item as { i?: unknown; t?: unknown };
      const index = typeof i === 'number' ? i : Number.parseInt(String(i), 10);
      if (Number.isFinite(index) && typeof t === 'string' && t.trim()) {
        translations.set(index, t.trim());
      }
    }
    return translations;
  }

  /**
   * Pulls the complete objects out of a truncated array by closing it after
   * the last one that finished.
   */
  #salvage(cleaned: string): unknown {
    const lastComplete = cleaned.lastIndexOf('}');
    if (lastComplete < 0) {
      return [];
    }
    try {
      return JSON.parse(`${cleaned.slice(0, lastComplete + 1)}]`);
    }
    catch {
      return [];
    }
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
