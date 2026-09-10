import path from 'path';
import { type Logger } from '../../../utils/logging/index.js';
import GoogleTranslator, {
  DEFAULT_PROXY_URL,
  DEFAULT_TARGET_LANGUAGE,
  DEFAULT_TLD
} from './GoogleTranslator.js';
import DeepLTranslator from './DeepLTranslator.js';
import BaiduImageTranslator from './BaiduImageTranslator.js';
import PdfTranslationStore from './PdfTranslationStore.js';
import PdfImageTranslationStore from './PdfImageTranslationStore.js';
import PdfTranslationSettingsStore from './PdfTranslationSettingsStore.js';
import { type PdfTranslator } from './BatchRunner.js';

export interface PdfTranslationConfig {
  /**
   * Proxy the translation requests go through. Google is not reachable
   * everywhere, so this defaults to a local proxy rather than to going direct
   * - see `DEFAULT_PROXY_URL`. An empty string turns it off.
   *
   * Falls back to the `PDF_TRANSLATE_PROXY_URL` environment variable, and then
   * to whatever an administrator has set in the reader's settings.
   */
  proxyUrl?: string | null;
  /** What pages are translated into. Defaults to `zh-CN`. */
  targetLanguage?: string | null;
  /** TLD of the Google Translate host, for where `.com` is awkward. */
  tld?: string | null;
  /** A DeepL key from the command line, which takes precedence over the stored one. */
  deepLApiKey?: string | null;
  /**
   * Baidu's credentials for the image translation, from the command line.
   *
   * Both halves or neither - an APP ID without its key signs nothing - and
   * like the DeepL key, what is set here takes precedence over what an
   * administrator sets in the reader.
   */
  baiduAppId?: string | null;
  baiduSecretKey?: string | null;
}

export interface PdfTranslationServices {
  /** The engine currently chosen. Resolved per request, not held. */
  translator: () => PdfTranslator;
  google: GoogleTranslator;
  deepL: DeepLTranslator;
  /** Pictures rather than text, and not one of the engines above. */
  baiduImage: BaiduImageTranslator;
  settings: PdfTranslationSettingsStore;
  store: PdfTranslationStore;
  imageStore: PdfImageTranslationStore;
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
  const settings = PdfTranslationSettingsStore.load(
    path.resolve(dataDir, '.patreon-dl', 'pdf-translation.json'),
    logger
  );

  /**
   * Command line first, then the environment, then what an administrator set,
   * then the default - and an empty string anywhere along the way is a choice
   * to go direct rather than an absent setting.
   */
  const resolveProxyUrl = () => {
    const candidates = [ config?.proxyUrl, process.env.PDF_TRANSLATE_PROXY_URL, settings.proxyUrl ];
    for (const candidate of candidates) {
      if (candidate !== undefined && candidate !== null) {
        return candidate || null;
      }
    }
    return DEFAULT_PROXY_URL;
  };
  const resolveTargetLanguage = () =>
    config?.targetLanguage || settings.targetLanguage || DEFAULT_TARGET_LANGUAGE;

  const google = new GoogleTranslator(
    () => ({
      proxyUrl: resolveProxyUrl(),
      targetLanguage: resolveTargetLanguage(),
      tld: config?.tld || DEFAULT_TLD
    }),
    logger
  );

  const deepL = new DeepLTranslator(
    () => ({
      apiKey: config?.deepLApiKey || settings.deepLApiKey,
      proxyUrl: resolveProxyUrl(),
      targetLanguage: resolveTargetLanguage()
    }),
    logger
  );

  const baiduImage = new BaiduImageTranslator(
    () => ({
      // Both halves come from the same place: half a set of credentials from
      // the command line and half from the settings would sign nothing and be
      // a puzzle to work out.
      appId: config?.baiduAppId && config?.baiduSecretKey ?
        config.baiduAppId : settings.baiduAppId,
      secretKey: config?.baiduAppId && config?.baiduSecretKey ?
        config.baiduSecretKey : settings.baiduSecretKey,
      proxyUrl: resolveProxyUrl(),
      targetLanguage: resolveTargetLanguage()
    }),
    logger
  );

  const store = new PdfTranslationStore(
    path.resolve(dataDir, '.patreon-dl', 'pdf-translations'),
    logger
  );

  const imageStore = new PdfImageTranslationStore(
    path.resolve(dataDir, '.patreon-dl', 'pdf-page-images'),
    logger
  );

  return {
    // Read at the moment of use, so switching engines takes effect on the next
    // page rather than on the next restart.
    translator: () => settings.engine === 'deepl' ? deepL : google,
    google,
    deepL,
    baiduImage,
    settings,
    store,
    imageStore
  };
}
