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
  async translate(texts: string[], to?: string, signal?: AbortSignal): Promise<(string | null)[]> {
    const settings = this.#getSettings();
    const target = to || settings.targetLanguage;
    const result: (string | null)[] = texts.map(() => null);
    const pending = texts
      .map((t, i) => ({ i, t }))
      .filter((entry) => entry.t.trim().length > 0);
    if (pending.length === 0) {
      return result;
    }

    const dispatcher = dispatcherFor(settings.proxyUrl, this.#logger);
    for (const batch of chunk(pending)) {
      if (signal?.aborted) {
        throw new GoogleTranslationError('Translation was cancelled');
      }
      // Its own timeout, so one wedged batch does not hold the whole page,
      // and still cancelled by the caller's signal.
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const batchSignal = signal ? AbortSignal.any([ signal, timeout ]) : timeout;
      let responses;
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
      }
      catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new GoogleTranslationError(
          `Could not reach Google Translate` +
          `${settings.proxyUrl ? ` through ${settings.proxyUrl}` : ''}: ${detail}`
        );
      }
      responses.forEach((response, index) => {
        const text = response?.text;
        result[batch[index].i] = typeof text === 'string' && text.length > 0 ? text : null;
      });
    }
    return result;
  }
}
