import { fetch } from 'undici';
import { translate } from 'google-translate-api-x';
import { commonLog } from '../../../utils/logging/Logger.js';
import type Logger from '../../../utils/logging/Logger.js';
import { createProxyAgentFor } from '../../../utils/Proxy.js';

/**
 * Google Translate, for PDFs and for nothing else.
 *
 * Deliberately not the translator in `../translation`: that one is Gemini,
 * costs a call per batch, carries a prompt and a vocabulary, and exists to
 * turn transcribed speech into subtitles. A page of a PDF wants none of that -
 * it wants a paragraph in and a paragraph out, free and immediately - so this
 * is a separate engine with its own settings, and the two never meet. Changing
 * anything here cannot affect subtitle translation, which is the point.
 */

/**
 * Google is not reachable from everywhere, so the requests go through a local
 * proxy unless one is configured otherwise or the setting is cleared - the
 * same default the Gemini side carries, for the same reason.
 */
export const DEFAULT_PROXY_URL = 'http://127.0.0.1:17890';
export const DEFAULT_TARGET_LANGUAGE = 'zh-CN';
export const DEFAULT_TLD = 'com';

/**
 * The batch endpoint takes as many strings as are put in one POST body and
 * does no chunking of its own, so the chunking is here. Both limits are well
 * inside what the endpoint accepts; a page of a book is typically one request.
 */
const MAX_CHARS_PER_REQUEST = 3000;
const MAX_BLOCKS_PER_REQUEST = 40;

/** Long enough for a slow proxy, short enough not to hold a page open. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Attempts per chunk, for the failures a second attempt could survive: a
 * refused connection is not one of those, but the free endpoint's rate
 * limiting is, and so is a transient 5xx.
 */
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [ 600, 1800 ];
/** A breath between chunks, so a long page does not read as a flood. */
const CHUNK_GAP_MS = 120;

export interface GoogleTranslatorSettings {
  /** `null` goes direct, which is what an empty setting means. */
  proxyUrl: string | null;
  targetLanguage: string;
  tld: string;
}

export class GoogleTranslationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleTranslationError';
  }
}

export interface TranslateResult {
  /** One per input, in order. `null` where nothing came back. */
  translations: (string | null)[];
  /** How many inputs came back with nothing. */
  failed: number;
  /** Why, when something did fail. Already readable. */
  error: string | null;
}

interface Failure {
  message: string;
  /** True for the kind of failure that a second attempt could survive. */
  retryable: boolean;
}

/**
 * What actually went wrong.
 *
 * undici reports every transport failure as "fetch failed" and puts the reason
 * - a refused connection, an unresolved host - in `cause`, and the library
 * wraps a bad response in an `Error` whose `cause` carries it. Both are walked
 * here, because "fetch failed" on its own has sent more than one person
 * looking in the wrong place.
 */
function describeFailure(error: unknown): Failure {
  let status: number | null = null;
  let code: string | null = null;
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const err = current as { message?: string; code?: string; cause?: unknown; response?: { status?: number } };
    if (err.message && !messages.includes(err.message)) {
      messages.push(err.message);
    }
    if (typeof err.code === 'string') {
      code = err.code;
    }
    const responseStatus = (err as { response?: { status?: number } }).response?.status;
    if (typeof responseStatus === 'number') {
      status = responseStatus;
    }
    current = err.cause;
  }
  const message = [ messages.join(' - '), code, status ? `HTTP ${status}` : null ]
    .filter(Boolean).join(' ') || 'Unknown error';
  // A refused or unreachable proxy fails the same way every time; asking again
  // only makes the reader wait longer for the same answer.
  const hopeless = [ 'ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ERR_PROXY_CONNECTION_FAILED' ];
  if (code && hopeless.includes(code)) {
    return { message, retryable: false };
  }
  if (status !== null) {
    return { message, retryable: status === 429 || status >= 500 };
  }
  return { message, retryable: true };
}

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new GoogleTranslationError('Translation was cancelled'));
    }, { once: true });
  });
}

/**
 * The undici dispatcher for `proxyUrl`, or `undefined` to go direct. A bad
 * proxy URL is reported and then ignored, so the error the caller sees is the
 * request failing rather than the configuration being rejected.
 */
function dispatcherFor(proxyUrl: string | null, logger?: Logger | null) {
  if (!proxyUrl) {
    return undefined;
  }
  try {
    return createProxyAgentFor({ url: proxyUrl })?.agent;
  }
  catch (error) {
    commonLog(logger, 'warn', 'GoogleTranslator',
      `Ignoring the PDF translation proxy "${proxyUrl}":`, error);
    return undefined;
  }
}

/** Splits by both count and total length, so one long block cannot make an oversized body. */
function chunk(texts: { i: number; t: string }[]) {
  const result: { i: number; t: string }[][] = [];
  let current: { i: number; t: string }[] = [];
  let chars = 0;
  for (const entry of texts) {
    if (current.length > 0 &&
      (current.length >= MAX_BLOCKS_PER_REQUEST || chars + entry.t.length > MAX_CHARS_PER_REQUEST)) {
      result.push(current);
      current = [];
      chars = 0;
    }
    current.push(entry);
    chars += entry.t.length;
  }
  if (current.length > 0) {
    result.push(current);
  }
  return result;
}

export default class GoogleTranslator {
  name = 'GoogleTranslator';

  #getSettings: () => GoogleTranslatorSettings;
  #logger?: Logger | null;

  constructor(getSettings: () => GoogleTranslatorSettings, logger?: Logger | null) {
    this.#getSettings = getSettings;
    this.#logger = logger;
  }

  get targetLanguage() {
    return this.#getSettings().targetLanguage;
  }

  protected log(level: Parameters<typeof commonLog>[1], ...msg: any[]) {
    commonLog(this.#logger, level, this.name, ...msg);
  }

  /**
   * Translates the given texts, in order. An entry that could not be
   * translated comes back `null` rather than failing the rest of the page -
   * the reader falls back to the original for those.
   *
   * Empty and whitespace-only entries never leave the process.
   */
  async translate(texts: string[], to?: string, signal?: AbortSignal): Promise<TranslateResult> {
    const settings = this.#getSettings();
    const target = to || settings.targetLanguage;
    const translations: (string | null)[] = texts.map(() => null);
    const pending = texts
      .map((t, i) => ({ i, t }))
      .filter((entry) => entry.t.trim().length > 0);
    if (pending.length === 0) {
      return { translations, failed: 0, error: null };
    }

    const dispatcher = dispatcherFor(settings.proxyUrl, this.#logger);
    const via = settings.proxyUrl ? ` through ${settings.proxyUrl}` : ' directly';
    const batches = chunk(pending);
    let failed = 0;
    let error: string | null = null;

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      if (signal?.aborted) {
        throw new GoogleTranslationError('Translation was cancelled');
      }
      if (batchIndex > 0) {
        await delay(CHUNK_GAP_MS, signal);
      }
      const batch = batches[batchIndex];
      let responses: Awaited<ReturnType<typeof translate<string[]>>> | null = null;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        // Its own timeout, so one wedged batch does not hold the whole page,
        // and still cancelled by the caller's signal.
        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const batchSignal = signal ? AbortSignal.any([ signal, timeout ]) : timeout;
        try {
          responses = await translate(batch.map((entry) => entry.t), {
            to: target,
            forceTo: true,
            tld: settings.tld,
            // Failed entries come back null instead of throwing away the batch.
            rejectOnPartialFail: false,
            // The whole reason the proxy works: the library's default is the
            // global fetch, which has no way to be given a dispatcher.
            requestFunction: (url: string, init: Record<string, unknown>) => fetch(url as any, {
              ...init,
              dispatcher,
              signal: batchSignal
            } as any)
          });
          break;
        }
        catch (thrown) {
          if (signal?.aborted) {
            throw new GoogleTranslationError('Translation was cancelled');
          }
          const failure = describeFailure(thrown);
          error = `Could not reach Google Translate${via}: ${failure.message}`;
          if (!failure.retryable || attempt === MAX_ATTEMPTS) {
            this.log('warn',
              `Giving up on a batch after ${attempt} attempt(s)${via}: ${failure.message}`);
            break;
          }
          this.log('debug',
            `Retrying a batch (attempt ${attempt} of ${MAX_ATTEMPTS})${via}: ${failure.message}`);
          await delay(RETRY_BACKOFF_MS[attempt - 1] ?? RETRY_BACKOFF_MS.at(-1)!, signal);
        }
      }

      // One chunk failing is not the page failing. What did come back is kept
      // and returned, and the caller stores it - so a retry of the same page
      // only asks for the part that is still missing.
      if (!responses) {
        failed += batch.length;
        continue;
      }
      responses.forEach((response, index) => {
        const text = response?.text;
        if (typeof text === 'string' && text.length > 0) {
          translations[batch[index].i] = text;
        }
        else {
          failed++;
        }
      });
    }
    return { translations, failed, error };
  }
}
