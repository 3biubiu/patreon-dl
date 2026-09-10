/**
 * PDF translation, which is its own thing entirely.
 *
 * Nothing here touches the AI translation in `Translation.ts`: that one turns
 * transcribed subtitles into Chinese with Gemini, costs money per call, and is
 * queued and indexed against a video. This one translates a page at a time for
 * whoever is reading it, with an engine of the administrator's choosing. They
 * share no settings, no queue, no cache and no engine, and are not meant to.
 */

/** Google Translate needs nothing; DeepL needs a key. */
export type PdfTranslationEngine = 'google' | 'deepl';

export interface PdfTranslationRequest {
  /** The text blocks of one page, in reading order. */
  blocks: string[];
  /** Target language. Defaults to the server's configured one. */
  to?: string;
}

export interface PdfTranslationResponse {
  /**
   * One entry per requested block, in the same order. `null` where the block
   * could not be translated - the reader shows the original for those rather
   * than a gap.
   */
  translations: (string | null)[];
  /** How many came from the store rather than from the engine. For the log line. */
  cached: number;
  /**
   * Blocks the engine gave nothing back for. The page is still served - the
   * reader shows the original for those - but it is worth saying how many.
   */
  failed: number;
  to: string;
}

export interface PdfTranslationAvailability {
  /** The engine in use, so the reader can name it when something fails. */
  engine: PdfTranslationEngine;
  /** False when DeepL is selected but has no key - nothing will translate. */
  available: boolean;
  /** Whether the page-image translation has credentials. See {@link PdfImageTranslationResult}. */
  imageAvailable: boolean;
  to: string;
}

/**
 * The other kind of translation: the page as a picture rather than as text.
 *
 * The reader sends what it has already drawn - the page canvas - and gets back
 * the same picture with the translation printed into it where the original
 * words were. It is for the pages the text one cannot help with: a scan, a
 * comic, a diagram whose labels are part of the artwork. Baidu does the work,
 * and unlike the text engines it is the only one, so it is configured by
 * credentials rather than chosen from a list.
 *
 * The image itself comes back as image bytes rather than in a JSON field: it
 * is a few hundred kilobytes, and base64 in a JSON body would be a third more
 * of them for nothing.
 */
export interface PdfImageTranslationResult {
  /** An object URL for the translated page, or `null` when it has no text. */
  url: string | null;
  /** True when the server had it on file rather than asking Baidu again. */
  cached: boolean;
}

/**
 * What the settings dialog reads.
 *
 * The DeepL key is write-only, as the Gemini one is: it is sent when it is set
 * and never comes back. What returns is whether one is configured.
 */
export interface PdfTranslationSettings {
  engine: PdfTranslationEngine;
  hasDeepLKey: boolean;
  /** True when the key comes from the command line and the form cannot change it. */
  deepLKeyFromConfig: boolean;
  /**
   * Baidu, for the image translation. Not an engine in the list above: it
   * translates pictures, not text, and the two are separate features that
   * happen to sit in the same dialog.
   *
   * The app id comes back because it is an account name rather than a secret;
   * the key, like every other key here, is write-only.
   */
  baiduAppId: string;
  hasBaiduSecretKey: boolean;
  baiduFromConfig: boolean;
  targetLanguage: string;
  /** Empty string means "go direct". */
  proxyUrl: string;
  /** True when the proxy comes from the command line or the environment. */
  proxyFromConfig: boolean;
}

export interface PdfTranslationSettingsUpdate {
  engine?: PdfTranslationEngine;
  /** Omit to leave as it is; an empty string forgets the key. */
  deepLApiKey?: string;
  baiduAppId?: string;
  /** Omit to leave as it is; an empty string forgets the key. */
  baiduSecretKey?: string;
  targetLanguage?: string;
  proxyUrl?: string;
}

/** What `POST .../deepl/check` answers with when the key works. */
export interface DeepLKeyStatus {
  ok: boolean;
  plan?: 'free' | 'pro';
  characterCount?: number | null;
  characterLimit?: number | null;
  error?: string;
}
