import { fetch } from 'undici';
import { translate } from 'google-translate-api-x';
import { commonLog } from '../../../utils/logging/Logger.js';
import type Logger from '../../../utils/logging/Logger.js';
import { dispatcherFor } from './Proxy.js';
import { runBatches, type PdfTranslator, type TranslateResult } from './BatchRunner.js';

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

export interface GoogleTranslatorSettings {
  /** `null` goes direct, which is what an empty setting means. */
  proxyUrl: string | null;
  targetLanguage: string;
  tld: string;
}

export default class GoogleTranslator implements PdfTranslator {
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
   */
  translate(texts: string[], to?: string, signal?: AbortSignal): Promise<TranslateResult> {
    const settings = this.#getSettings();
    const target = to || settings.targetLanguage;
    const dispatcher = dispatcherFor(settings.proxyUrl, this.name, this.#logger);

    return runBatches({
      texts,
      signal,
      logName: this.name,
      logger: this.#logger,
      describeEngine:
        `Google Translate${settings.proxyUrl ? ` through ${settings.proxyUrl}` : ' directly'}`,
      send: async (batch, batchSignal) => {
        const responses = await translate(batch, {
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
        return responses.map((response) => response?.text ?? null);
      }
    });
  }
}
