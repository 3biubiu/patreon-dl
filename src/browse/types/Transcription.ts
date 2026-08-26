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
