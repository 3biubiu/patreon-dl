import { fetch, type Response } from 'undici';
import { commonLog, type LogLevel } from '../../../utils/logging/Logger.js';
import type Logger from '../../../utils/logging/Logger.js';
import { createProxyAgentFor } from '../../../utils/Proxy.js';
import { type TranslationKeyDescription } from '../../types/Translation.js';
import { buildSystemPrompt } from './TranslationPrompt.js';

export { type TranslationKeyDescription } from '../../types/Translation.js';

export const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
/**
 * Gemini is not reachable from everywhere, so translation goes through a local
 * proxy unless one is configured otherwise or the setting is cleared. This is
 * the address the usual local proxies listen on.
 */
export const DEFAULT_PROXY_URL = 'http://127.0.0.1:17890';

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
  /** `null` sends the request directly, which is what an empty setting means. */
  proxyUrl: string | null;
  prompt: string | null;
  disableThinking: boolean;
  /**
   * Term translations from the transcription's vocabulary file, offered to
   * every call as reference. Read per call, so an edit to the file is what
   * the next batch is steered with.
   */
  vocabulary: { term: string; translation: string }[];
}

/**
 * What actually went wrong with a request.
 *
 * undici reports every transport failure as "fetch failed" and puts the reason
 * - a refused connection, an unresolved host - in `cause`. Unwrapped here
 * because the common failure of this feature is a proxy that is not listening,
 * and "fetch failed" alone gives an administrator nothing to act on.
 */
function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause = error.cause;
  const detail = cause instanceof Error ? cause.message : null;
  return detail && detail !== error.message ? `${error.message} (${detail})` : error.message;
}

/**
 * The undici dispatcher for `proxyUrl`, or `undefined` to go direct.
 *
 * A bad proxy URL is not worth failing the request over before the request has
 * been tried: it is reported and the call goes direct, which produces the
 * clearer of the two errors.
 */
function dispatcherFor(proxyUrl: string | null | undefined, logger?: Logger | null) {
  if (!proxyUrl) {
    return undefined;
  }
  try {
    return createProxyAgentFor({ url: proxyUrl })?.agent;
  }
  catch (error) {
    commonLog(logger, 'warn', 'GeminiTranslator',
      `Ignoring the translation proxy "${proxyUrl}":`, error);
    return undefined;
  }
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
    proxyUrl: string | null = DEFAULT_PROXY_URL,
    signal?: AbortSignal
  ): Promise<TranslationKeyDescription> {
    const url = `${baseUrl.replace(/\/+$/, '')}/models?pageSize=1000`;
    let response: Response;
    try {
      // Through the same proxy the translations themselves go through, so
      // that a key verified here is a key that will work there.
      response = await fetch(url, {
        headers: { 'x-goog-api-key': apiKey },
        dispatcher: dispatcherFor(proxyUrl),
        signal
      });
    }
    catch (error) {
      throw new TranslationError(
        `Could not reach Gemini${proxyUrl ? ` through ${proxyUrl}` : ''}: ` +
        describeFetchError(error)
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
    const { apiKey, model, baseUrl, proxyUrl, prompt, disableThinking, vocabulary } =
      this.#settings();

    const systemParts: { text: string }[] = [ { text: buildSystemPrompt(prompt) } ];
    if (vocabulary.length > 0) {
      // The same terms the transcription was biased with, here as rules about
      // what they become in Chinese. Without this a term the vocabulary
      // corrected in the transcript gets re-mangled by the translation - one
      // line of "背景虚化" and the next of "背景过滤", for the same word.
      systemParts.push({ text: [
        '<terminology>',
        'These terms appear in the subtitles. When one of them - or a close ' +
        'variant of one - is in a line, translate it exactly as given, and use ' +
        'the same rendering every time it appears.',
        ...vocabulary.map(({ term, translation }) => `${term} => ${translation}`),
        '</terminology>'
      ].join('\n') });
    }

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
      systemInstruction: { parts: systemParts },
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
          dispatcher: dispatcherFor(proxyUrl, this.#logger),
          signal: controller.signal
        }
      );
    }
    catch (error) {
      if (signal?.aborted) {
        throw Error('Aborted');
      }
      // A model that ran out of time closes the connection rather than
      // answering, so a smaller batch may well survive. A proxy that is not
      // listening looks the same from here, which is why it is named.
      throw new TranslationError(
        `Request failed${proxyUrl ? ` (through ${proxyUrl})` : ''}: ` +
        describeFetchError(error),
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
    return this.#parse(answer, candidate?.finishReason === 'MAX_TOKENS', lines);
  }

  /**
   * Reads the answer into a map keyed by the indices that were asked for.
   *
   * The model reports each line's number itself, and an answer that numbered
   * them differently - started at the wrong one, counted a context line it
   * was told not to translate, merged two lines into one - used to attach
   * translations to the wrong captions with nothing downstream any the wiser:
   * the counts added up, and a subtitle showed the sentence after the one on
   * screen. So one-item-per-line answers are matched by position - the order
   * the lines were sent in - and the reported number is only a cross-check.
   * An answer that cannot be matched that way, fewer items than lines or
   * more, falls back to the numbers and keeps only the ones this call asked
   * for: a missing line reaches the caller's repair pass, and an extra one -
   * a context line translated against instructions - goes nowhere near a
   * caption.
   */
  #parse(
    answer: string,
    truncated: boolean,
    lines: TranslatableLine[]
  ): Map<number, string> {
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

    /** The reported index and text of one item, however the model typed them. */
    const read = (item: unknown): { index: number; text: string | null } => {
      if (!item || typeof item !== 'object') {
        return { index: NaN, text: null };
      }
      const { i, t } = item as { i?: unknown; t?: unknown };
      const index = typeof i === 'number' ? i : Number.parseInt(String(i), 10);
      return {
        index: Number.isFinite(index) ? index : NaN,
        text: typeof t === 'string' ? t : null
      };
    };

    const translations = new Map<number, string>();

    if (items.length === lines.length) {
      // One item per line, so position is the authority. A model that
      // renumbered the batch still kept the order; the cross-check says how
      // often that happened without failing an otherwise fine answer.
      let renumbered = 0;
      for (let k = 0; k < items.length; k++) {
        const { index, text } = read(items[k]);
        if (text !== null && text.trim()) {
          translations.set(lines[k].i, text.trim());
          if (index !== lines[k].i) {
            renumbered++;
          }
        }
      }
      if (renumbered > 0) {
        this.log('warn',
          `The answer renumbered ${renumbered} of ${lines.length} line(s); ` +
          'they were matched by position instead'
        );
      }
      return translations;
    }

    // Not one item per line - truncated, merged, or carrying lines it was not
    // asked for. The reported numbers are all there is to go by here, and only
    // the ones this call asked for are kept.
    const wanted = new Set(lines.map((line) => line.i));
    for (const item of items) {
      const { index, text } = read(item);
      if (Number.isFinite(index) && wanted.has(index) &&
          text !== null && text.trim() && !translations.has(index)) {
        translations.set(index, text.trim());
      }
    }

    // Nothing matched: the answer was renumbered as well as miscounted -
    // started at one, counted the context lines it was told to ignore, or
    // merged a few. As it stands the whole batch would keep its English, so
    // one last attempt lines the items up by position: an item offset and a
    // numbering shift that together explain most of the reported numbers.
    // Only a pairing most of the items agree on is trusted - a guess could
    // pin a translation to the caption beside its own, which reads worse
    // than the original.
    if (translations.size === 0 && items.length > 0) {
      const readable = items
        .map(read)
        .filter(({ index, text }) => Number.isFinite(index) && text !== null && text.trim());
      let best: { shift: number; renumber: number; votes: number; overlap: number } | null = null;
      for (let shift = 0; shift <= Math.max(0, readable.length - lines.length); shift++) {
        const overlap = Math.min(lines.length, readable.length - shift);
        if (overlap <= 0) {
          break;
        }
        const votes = new Map<number, number>();
        for (let k = 0; k < overlap; k++) {
          const diff = lines[k].i - readable[shift + k].index;
          votes.set(diff, (votes.get(diff) || 0) + 1);
        }
        for (const [renumber, count] of votes) {
          if (count < 2) {
            continue;
          }
          if (!best || count > best.votes ||
              (count === best.votes && Math.abs(renumber) < Math.abs(best.renumber))) {
            best = { shift, renumber, votes: count, overlap };
          }
        }
      }
      if (best && best.votes >= Math.ceil(best.overlap / 2)) {
        for (let k = 0; k < best.overlap; k++) {
          const text = readable[best.shift + k].text;
          if (text) {
            translations.set(lines[k].i, text.trim());
          }
        }
        this.log('warn',
          `The answer numbered its items so that none of the ${lines.length} line(s) ` +
          'asked for matched; they were lined up by position instead ' +
          `(a renumbering by ${best.renumber >= 0 ? '+' : ''}${best.renumber})`
        );
      }
      else {
        this.log('warn',
          `The answer carried 0 of ${lines.length} line(s) and could not be lined up ` +
          'by position either; the batch keeps its original text'
        );
      }
    }

    const missing = lines.length - translations.size;
    if (missing > 0) {
      this.log('debug',
        `The answer carried ${translations.size} of ${lines.length} line(s); ` +
        `${missing} of them go to the repair pass`
      );
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
