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
  to: string;
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
