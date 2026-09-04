import path from 'path';
import { type Logger } from '../../../utils/logging/index.js';
import GoogleTranslator, {
  DEFAULT_PROXY_URL,
  DEFAULT_TARGET_LANGUAGE,
  DEFAULT_TLD
} from './GoogleTranslator.js';
import PdfTranslationStore from './PdfTranslationStore.js';

export interface PdfTranslationConfig {
  /**
   * Proxy the Google Translate requests go through. Google is not reachable
   * everywhere, so this defaults to a local proxy rather than to going direct
   * - see `DEFAULT_PROXY_URL`. An empty string turns it off.
   *
   * Falls back to the `PDF_TRANSLATE_PROXY_URL` environment variable.
   */
  proxyUrl?: string | null;
  /** What pages are translated into. Defaults to `zh-CN`. */
  targetLanguage?: string | null;
  /** TLD of the Google Translate host, for where `.com` is awkward. */
  tld?: string | null;
}

export interface PdfTranslationServices {
  translator: GoogleTranslator;
  store: PdfTranslationStore;
}

/**
 * The PDF reader's translation, assembled apart from everything else.
 *
 * It shares nothing with `../translation`: no settings store, no queue, no
 * API key, no index. That separation is the requirement, not an accident of
 * layout - subtitle translation must not change because a PDF was read, and
 * this must keep working with the Gemini side switched off entirely.
 */
export function createPdfTranslationServices(
  dataDir: string,
  config?: PdfTranslationConfig | null,
  logger?: Logger | null
): PdfTranslationServices {
  const configuredProxy = config?.proxyUrl !== undefined && config?.proxyUrl !== null ?
    config.proxyUrl : process.env.PDF_TRANSLATE_PROXY_URL;
  const translator = new GoogleTranslator(
    () => ({
      // An empty string is a choice - "go direct" - so only an absent setting
      // falls back to the default proxy.
      proxyUrl: configuredProxy === undefined ? DEFAULT_PROXY_URL : (configuredProxy || null),
      targetLanguage: config?.targetLanguage || DEFAULT_TARGET_LANGUAGE,
      tld: config?.tld || DEFAULT_TLD
    }),
    logger
  );
  const store = new PdfTranslationStore(
    path.resolve(dataDir, '.patreon-dl', 'pdf-translations'),
    logger
  );
  return { translator, store };
}
