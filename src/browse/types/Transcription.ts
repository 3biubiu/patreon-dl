/**
 * The shapes that cross between the transcription server and the browser.
 * Shared so the two cannot drift, in the way `Auth.ts` is shared.
 */

export type JobStatus =
  | 'queued'
  | 'detecting'
  | 'transcribing'
  | 'writing'
  | 'done'
  | 'error'
  | 'cancelled';

/** A run in progress. Lives in memory only, and is gone after a restart. */
export interface TranscriptionJob {
  mediaId: string;
  status: JobStatus;
  /** 0-100. Speech detection is the first tenth, transcription the rest. */
  percent: number;
  error: string | null;
  language: string | null;
  /** Where the subtitle was written, relative to the data directory. */
  subtitlePath: string | null;
  cost: number | null;
  queuedAt: string;
  finishedAt: string | null;
}

export type TranscriptionState = 'pending' | 'done' | 'error';

/**
 * What the index remembers about a video. This is what survives a restart,
 * and what the grid reads to decide whether to mark a tile as captioned.
 */
export interface TranscriptionRecord {
  mediaId: string;
  videoPath: string;
  subtitlePath: string | null;
  language: string | null;
  state: TranscriptionState;
  error: string | null;
  requestedAt: string;
  completedAt: string | null;
  cost: number | null;
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
