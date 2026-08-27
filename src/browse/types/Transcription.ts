/**
 * The shapes that cross between the transcription server and the browser.
 * Shared so the two cannot drift, in the way `Auth.ts` is shared.
 */

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

/**
 * The transcription settings as the browser is allowed to see them.
 *
 * There is deliberately no field for the key. It goes to the server when an
 * administrator sets it and is never sent back - what returns is `configured`
 * and the masked `label`, which is all a settings form needs to show.
 */
export interface TranscriptionSettings {
  configured: boolean;
  /** Where the key in use comes from: saved here, or the environment. */
  source: 'file' | 'env' | null;
  model: string;
  baseUrl: string;
  /** Absent when the key could not be checked, e.g. OpenRouter unreachable. */
  key: KeyDescription | null;
  /** Why the key could not be checked, when it could not. */
  keyError: string | null;
}

/** A record is still moving while it is in one of these states. */
export const ACTIVE_STATES: TranscriptionState[] = [ 'pending', 'running' ];

export function isActive(record: { state: TranscriptionState } | null | undefined) {
  return !!record && ACTIVE_STATES.includes(record.state);
}
