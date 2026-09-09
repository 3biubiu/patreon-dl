/**
 * The ceiling on what an ordinary account may have transcribed in a day.
 *
 * Shared between the server that enforces it and the browser that has to say
 * why a button did nothing, in the way `Quota.ts` is shared.
 */

/**
 * Videos a day, and hours of video a day. Either one reached closes
 * transcription for the rest of the day - they are two ways of describing the
 * same cost, and a video is only cheap until it is three hours long.
 *
 * Fixed rather than per-account: this is a guard on a metered API, not an
 * allowance somebody is meant to tune. The switch on the account is what
 * decides who gets any of it - see `AuthUser.canTranscribeVideo`.
 */
export const DAILY_TRANSCRIPTION_VIDEOS = 3;
export const DAILY_TRANSCRIPTION_SECONDS = 2 * 60 * 60;

/**
 * The code a refusal carries, so the browser can tell "come back tomorrow"
 * from a permission it never had. Same purpose as `QUOTA_EXCEEDED_CODE`, and
 * deliberately not the same value: they are answered differently.
 */
export const TRANSCRIPTION_LIMIT_CODE = 'transcription_limit_reached';

/** Which of the two ceilings was in the way. */
export type TranscriptionLimitKind = 'videos' | 'duration';

/**
 * A refusal, as the browser is told it.
 *
 * The numbers travel with it rather than only the sentence, so the message can
 * be shown in the reader's own language instead of whatever the server happens
 * to write in.
 */
export interface TranscriptionLimitInfo {
  kind: TranscriptionLimitKind;
  /** How many videos a day, and how many have gone today. */
  videos: number;
  videosUsed: number;
  /** Seconds of video a day, and how much of it has gone today. */
  seconds: number;
  secondsUsed: number;
  /** When it all goes back to zero, as an ISO timestamp. */
  resetsAt: string;
}

/**
 * What one account has spent today. `videos` counts distinct videos, so asking
 * for one that has already been transcribed today costs nothing again.
 */
export interface TranscriptionUsage {
  videos: number;
  seconds: number;
}
