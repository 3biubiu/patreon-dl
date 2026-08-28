/**
 * The shapes that cross between the translation server and the browser, kept
 * beside `Transcription.ts` and shared for the same reason: the two sides
 * cannot drift.
 *
 * Translation hangs off a transcription rather than standing on its own - it
 * reads the subtitle a transcription produced - so its progress lives inside
 * `TranscriptionRecord` and there is one history list, not two.
 */

export type TranslationState =
  /** Asked for, waiting its turn - possibly for a transcription to finish. */
  | 'pending'
  | 'running'
  | 'done'
  | 'error'
  | 'cancelled';

/**
 * The only target offered for now. Kept as a constant rather than spelled out
 * at each use so that adding a second one later is a change in one place.
 */
export const TARGET_LANGUAGE = 'zh';

/** One video's translation, from the moment it is asked for. */
export interface TranslationProgress {
  state: TranslationState;
  /** BCP 47 tag, which is also the suffix of the file written. */
  targetLanguage: string;
  /** 0-100, counted in subtitle lines rather than bytes. */
  percent: number;
  /** Relative to the data directory, so the library stays movable. */
  subtitlePath: string | null;
  error: string | null;
  /** Lines translated so far, and how many there are in total. */
  done: number;
  total: number;
  /**
   * Upstream calls actually spent. Gemini bills by the call, so this is the
   * number that matters and it is shown rather than a dollar figure.
   */
  requests: number;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

/** Whether the server can translate, and why not when it cannot. */
export interface TranslationAvailability {
  available: boolean;
  reason: string | null;
}

/**
 * What could be learned about a key by asking Gemini to list the models it can
 * see. Gemini exposes no usage or quota endpoint, so unlike OpenRouter there
 * is no spend to report - only that the key works and whether the configured
 * model is one it may use.
 */
export interface TranslationKeyDescription {
  modelCount: number;
  modelFound: boolean;
}

/**
 * The translation settings as the browser is allowed to see them.
 *
 * As with transcription there is deliberately no field for the key: it goes to
 * the server when an administrator sets it and never comes back.
 */
export interface TranslationSettings {
  configured: boolean;
  /** Where the key in use comes from: saved here, or the environment. */
  source: 'file' | 'env' | null;
  model: string;
  baseUrl: string;
  /** Proxy the Gemini requests go through. Empty means straight out. */
  proxyUrl: string;
  /** What `proxyUrl` is when nobody has set one. */
  defaultProxyUrl: string;
  /**
   * The editable half of the prompt. The half that fixes the output contract
   * is not editable - see `TranslationPrompt.ts`.
   */
  prompt: string;
  /** What `prompt` is reset to, so the form can offer to put it back. */
  defaultPrompt: string;
  /** Source characters aimed at per call. The main lever on the call count. */
  batchCharacters: number;
  /** Ceiling on lines per call, whatever the characters come to. */
  batchLines: number;
  disableThinking: boolean;
  /**
   * Whether the Chinese file's lines are re-cut for readability. The
   * transcription's own subtitle is never touched.
   */
  segmentation: boolean;
  /**
   * Whether the source transcript's captions are re-cut by the model before
   * the subtitle is written. Unlike `segmentation` this costs calls, and it
   * changes the file the transcription itself produces.
   */
  sourceSegmentation: boolean;
  /** Longest Chinese line, in characters. */
  maxLineCjk: number;
  /** Longest line for a language written with spaces, in words. */
  maxLineLatin: number;
  /** Calls spent since this counter was last reset. */
  totalRequests: number;
  key: TranslationKeyDescription | null;
  keyError: string | null;
}

/** A translation is still moving while it is in one of these states. */
export const ACTIVE_TRANSLATION_STATES: TranslationState[] = [ 'pending', 'running' ];

export function isTranslationActive(
  translation: { state: TranslationState } | null | undefined
) {
  return !!translation && ACTIVE_TRANSLATION_STATES.includes(translation.state);
}
