/**
 * The shapes that cross between the upload page and the server, shared so the
 * two cannot drift - the way `Auth.ts` and `Transcription.ts` are.
 */

import { type SubtitleFile, type TranscriptionRecord } from './Transcription.js';

/**
 * One video somebody handed to the server to be transcribed.
 *
 * The video itself never arrives: the browser strips it to 16 kHz mono audio
 * before uploading, which is all the transcription pipeline ever looks at and
 * a fraction of the bytes. What is kept here is what the audio came from, so a
 * row in the list still says which video it is.
 */
export interface UploadJob {
  id: string;
  /**
   * What the transcription pipeline knows it by - `upload:<id>`.
   *
   * Deliberately not a media id from the library: nothing in the database
   * answers to it, which is exactly right, and the prefix is what keeps it
   * from ever colliding with something that does.
   */
  mediaId: string;
  /** Who uploaded it. Only they and an administrator ever see the row. */
  userId: string;
  /** Their name at the time, so an administrator's list reads without a join. */
  username: string;
  /** The video's filename on the uploader's machine, extension and all. */
  title: string;
  /** Size of the uploaded audio in bytes - not of the video it came from. */
  size: number;
  /** Length in seconds as the browser measured it, or `null` if it could not. */
  duration: number | null;
  createdAt: string;
}

/** A job with everything the page needs to draw a row for it. */
export interface UploadJobView extends UploadJob {
  /**
   * Where its transcription got to, or `null` when the record has been
   * forgotten - a job whose history was cleared still has its subtitles.
   */
  record: TranscriptionRecord | null;
  /** What can be downloaded, which is empty until the job finishes. */
  subtitles: SubtitleFile[];
}
