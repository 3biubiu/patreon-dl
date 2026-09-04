import { fetch } from 'undici';
import { commonLog } from '../../../utils/logging/Logger.js';
import type Logger from '../../../utils/logging/Logger.js';
import { dispatcherFor } from './Proxy.js';
import { runBatches, type PdfTranslator, type TranslateResult } from './BatchRunner.js';

/**
 * DeepL, as an alternative to Google for the PDF reader.
 *
 * Same contract, same batching, same time budget - the only differences are
 * the request shape and that this one needs a key. Which of the two is used is
 * a setting; nothing else in the reader knows the difference.
 */

/**
 * A free key ends in `:fx` and belongs to a different host from a paid one.
 * DeepL documents this suffix as the way to tell, so the endpoint is derived
 * from the key rather than made another thing to configure wrongly.
 */
const FREE_SUFFIX = ':fx';
const FREE_BASE_URL = 'https://api-free.deepl.com/v2';
const PRO_BASE_URL = 'https://api.deepl.com/v2';

/**
 * DeepL wants its own language codes: upper case, and a region only where it
 * offers a choice. Anything not listed is passed through upper-cased, which is
 * right for the plain two-letter codes.
 */
const LANGUAGE_MAP: Record<string, string> = {
  'zh': 'ZH',
  'zh-cn': 'ZH',
  'zh-hans': 'ZH',
  'zh-tw': 'ZH-HANT',
  'zh-hk': 'ZH-HANT',
  'zh-hant': 'ZH-HANT',
  'en': 'EN-US',
  'en-us': 'EN-US',
  'en-gb': 'EN-GB',
  'pt': 'PT-PT',
  'pt-br': 'PT-BR'
};

export function toDeepLLanguage(language: string) {
  return LANGUAGE_MAP[language.toLowerCase()] || language.toUpperCase();
}

export interface DeepLTranslatorSettings {
  apiKey: string | null;
  /** `null` goes direct, which is what an empty setting means. */
  proxyUrl: string | null;
  targetLanguage: string;
}

export class DeepLKeyMissingError extends Error {
  constructor() {
    super('No DeepL API key has been set');
    this.name = 'DeepLKeyMissingError';
  }
}

/** An error carrying the status, so the runner can tell a retry from a refusal. */
class DeepLResponseError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'DeepLResponseError';
    this.status = status;
  }
}

function baseUrlFor(apiKey: string) {
  return apiKey.trim().endsWith(FREE_SUFFIX) ? FREE_BASE_URL : PRO_BASE_URL;
}

/**
 * What DeepL says went wrong. Its errors come back as JSON with a `message`,
 * which is a good deal more useful than the status on its own.
 */
async function readError(response: { status: number; text: () => Promise<string> }) {
  let detail = '';
  try {
    const body = await response.text();
    const parsed = JSON.parse(body) as { message?: string };
    detail = parsed?.message || body.slice(0, 200);
  }
  catch (_error) { /* the status will have to do */ }
  const known: Record<number, string> = {
    403: 'the key was refused',
    429: 'too many requests',
    456: 'the quota for this key is used up'
  };
  return new DeepLResponseError(
    response.status,
    [ known[response.status], detail ].filter(Boolean).join(' - ') || 'request failed'
  );
}

export default class DeepLTranslator implements PdfTranslator {
  name = 'DeepLTranslator';

  #getSettings: () => DeepLTranslatorSettings;
  #logger?: Logger | null;

  constructor(getSettings: () => DeepLTranslatorSettings, logger?: Logger | null) {
    this.#getSettings = getSettings;
    this.#logger = logger;
  }

  get targetLanguage() {
    return this.#getSettings().targetLanguage;
  }

  get configured() {
    return !!this.#getSettings().apiKey;
  }

  protected log(level: Parameters<typeof commonLog>[1], ...msg: any[]) {
    commonLog(this.#logger, level, this.name, ...msg);
  }

  /**
   * Whether the key works, and what is left on it. Used by the settings form,
   * so that a key is known to be good before a page depends on it.
   */
  async checkKey(apiKey?: string | null, signal?: AbortSignal) {
    const settings = this.#getSettings();
    const key = (apiKey || settings.apiKey || '').trim();
    if (!key) {
      throw new DeepLKeyMissingError();
    }
    const response = await fetch(`${baseUrlFor(key)}/usage`, {
      headers: { Authorization: `DeepL-Auth-Key ${key}` },
      dispatcher: dispatcherFor(settings.proxyUrl, this.name, this.#logger),
      signal: signal || AbortSignal.timeout(15_000)
    } as any);
    if (!response.ok) {
      throw await readError(response);
    }
    const usage = await response.json() as { character_count?: number; character_limit?: number };
    return {
      plan: key.endsWith(FREE_SUFFIX) ? 'free' as const : 'pro' as const,
      characterCount: usage.character_count ?? null,
      characterLimit: usage.character_limit ?? null
    };
  }

  translate(texts: string[], to?: string, signal?: AbortSignal): Promise<TranslateResult> {
    const settings = this.#getSettings();
    const key = settings.apiKey?.trim();
    if (!key) {
      // Not thrown: a missing key is a configuration state, not a fault of the
      // page being read, and the reader shows it the same way it shows any
      // other reason a page came back untranslated.
      return Promise.resolve({
        translations: texts.map(() => null),
        failed: texts.length,
        error: 'No DeepL API key has been set'
      });
    }
    const target = toDeepLLanguage(to || settings.targetLanguage);
    const dispatcher = dispatcherFor(settings.proxyUrl, this.name, this.#logger);
    const url = `${baseUrlFor(key)}/translate`;

    return runBatches({
      texts,
      signal,
      logName: this.name,
      logger: this.#logger,
      describeEngine: `DeepL${settings.proxyUrl ? ` through ${settings.proxyUrl}` : ' directly'}`,
      // 403 is a rejected key and 456 an exhausted quota: both answer the same
      // way however many times they are asked.
      statusIsRetryable: (status) => status === 429 || status >= 500,
      send: async (batch, batchSignal) => {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `DeepL-Auth-Key ${key}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ text: batch, target_lang: target }),
          dispatcher,
          signal: batchSignal
        } as any);
        if (!response.ok) {
          throw await readError(response);
        }
        const body = await response.json() as { translations?: { text?: string }[] };
        // Answered in the order asked, one per input - so a short reply is
        // padded rather than silently shifting the page's text along.
        return batch.map((_text, index) => body.translations?.[index]?.text ?? null);
      }
    });
  }
}
