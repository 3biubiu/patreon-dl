/**
 * The shapes that cross between the transcription server and the browser.
 * Shared so the two cannot drift, in the way `Auth.ts` is shared.
 */

import { type ContentType } from './Content.js';
import { type TranslationProgress } from './Translation.js';

export type TranscriptionState =
  /** Asked for, waiting its turn. */
  | 'pending'
  | 'running'
  | 'done'
  | 'error'
  | 'cancelled';

/** Which part of a running job is under way. */
export type TranscriptionStage = 'detecting' | 'transcribing' | 'writing';

/**
 * One video's transcription, from the moment it is asked for to whatever
 * became of it.
 *
 * This is the whole story: there is no separate in-memory job. Progress is
 * written here as it changes, so a restart leaves a record that says where
 * things got to rather than a gap.
 */
export interface TranscriptionRecord {
  mediaId: string;
  /** Relative to the data directory, so the library stays movable. */
  videoPath: string;
  /** File name alone, so a list has something readable to show. */
  videoName: string;
  /**
   * The post or product this video belongs to, and which of the two, so the
   * history can link a row back to where the video is. Filled in when the
   * history is read rather than stored - see the transcription handler. Absent
   * when the media is not tied to any content the database knows about.
   */
  postId?: string | null;
  contentType?: ContentType | null;
  subtitlePath: string | null;
  language: string | null;
  state: TranscriptionState;
  stage: TranscriptionStage | null;
  /** 0-100. Detection is the first tenth, transcription the rest. */
  percent: number;
  error: string | null;
  /** US dollars spent, as reported by the API. */
  cost: number | null;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  /**
   * The AI translation of this transcription, once one has been asked for.
   *
   * It lives here rather than in an index of its own because it is not a thing
   * on its own: it reads the subtitle this record produced, and a history list
   * that showed the two separately would show one video twice.
   */
  translation: TranslationProgress | null;
}

/** One subtitle offered to the player, found beside the video. */
export interface SubtitleFile {
  /** File name on disk; also the id used to ask for its contents. */
  filename: string;
  language: string | null;
  label: string;
}

/** Whether the server can make new subtitles, and why not when it cannot. */
export interface TranscriptionAvailability {
  available: boolean;
  reason: string | null;
}

/**
 * What OpenRouter reports about a key. `label` arrives already masked by
 * OpenRouter, which is why the key itself never has to be sent anywhere to
 * show which one is in use.
 */
export interface KeyDescription {
  label: string | null;
  /** Spent so far, in US dollars. */
  usage: number | null;
  limit: number | null;
  limitRemaining: number | null;
  isFreeTier: boolean | null;
}

/** Which service does the transcribing. */
export type TranscriptionProvider = 'openrouter' | 'gemini';

/** One provider's half of the settings form. */
export interface ProviderSettings {
  configured: boolean;
  /** Where the key in use comes from: saved here, or the environment. */
  source: 'file' | 'env' | null;
  model: string;
  baseUrl: string;
  /**
   * What the provider says about the key. OpenRouter reports spend and limit;
   * Gemini reports nothing about a key beyond whether it works, so this stays
   * null there and `configured` is the whole story.
   */
  key: KeyDescription | null;
  /** Why the key could not be checked, when it could not. */
  keyError: string | null;
}

/** Gemini's half, which has a proxy of its own. */
export interface GeminiProviderSettings extends ProviderSettings {
  /**
   * Proxy the Gemini requests go through. Empty means straight out. Gemini is
   * not reachable everywhere, so this is set by default.
   */
  proxyUrl: string;
}

/**
 * The domain terms a provider that accepts them is steered towards.
 *
 * The text is the file verbatim - comments, blank lines and all - because the
 * file is the thing being edited, whether that happens here or in an editor.
 */
export interface VocabularySettings {
  /** Where the file is, so it can be found without the browser. */
  path: string;
  text: string;
  termCount: number;
  /** Set when the list has grown past the point where biasing still helps. */
  warning: string | null;
  /** False on a provider with no biasing, so the form can say why it is idle. */
  supported: boolean;
}

/**
 * The transcription settings as the browser is allowed to see them.
 *
 * There is deliberately no field for either key. A key goes to the server when
 * an administrator sets it and is never sent back - what returns is
 * `configured` and, where the provider offers one, a masked label, which is
 * all a settings form needs to show.
 */
export interface TranscriptionSettings {
  provider: TranscriptionProvider;
  /** Whether the provider in use has a key. This is what gates the feature. */
  configured: boolean;
  openrouter: ProviderSettings;
  gemini: GeminiProviderSettings;
  vocabulary: VocabularySettings;
}

/** A record is still moving while it is in one of these states. */
export const ACTIVE_STATES: TranscriptionState[] = [ 'pending', 'running' ];

export function isActive(record: { state: TranscriptionState } | null | undefined) {
  return !!record && ACTIVE_STATES.includes(record.state);
}
