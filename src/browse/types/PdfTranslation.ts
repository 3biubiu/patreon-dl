/**
 * PDF translation, which is its own thing entirely.
 *
 * Nothing here touches the AI translation in `Translation.ts`: that one turns
 * transcribed subtitles into Chinese with Gemini, costs money per call, and is
 * queued and indexed against a video. This one is Google Translate, free,
 * synchronous, and asked for a page at a time by whoever is reading it. They
 * share no settings, no queue, no cache and no engine, and are not meant to.
 */

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
  /** How many came from the store rather than from Google. For the log line. */
  cached: number;
  to: string;
}

export interface PdfTranslationAvailability {
  /** False when the server was started without the feature configured. */
  available: boolean;
  to: string;
}
