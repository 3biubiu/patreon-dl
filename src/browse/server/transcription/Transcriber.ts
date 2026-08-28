/**
 * What the queue needs from a speech-to-text provider, and nothing else.
 *
 * Everything above this line - voice detection, splicing the silence out,
 * packing clips, halving a clip that failed, mapping timestamps back onto the
 * video, building the subtitle - is provider-agnostic and stays that way. A
 * new provider is this interface and a settings field, not a second pipeline.
 */

import { type AudioFormat } from './AudioExtractor.js';
import { type Segment } from './SubtitleBuilder.js';

export class TranscriptionError extends Error {
  status: number | null;
  /** True when splitting the clip and retrying is worth trying. */
  retryableBySplitting: boolean;

  constructor(message: string, status: number | null = null, retryableBySplitting = false) {
    super(message);
    this.name = 'TranscriptionError';
    this.status = status;
    this.retryableBySplitting = retryableBySplitting;
  }
}

export interface TranscribeResult {
  segments: Segment[];
  language: string | null;
  /** Seconds of audio billed, where the provider says. */
  seconds: number | null;
  /** US dollars, where the provider says. Null is "not reported", not "free". */
  cost: number | null;
}

export interface Transcriber {
  /** For the log, so a line says which provider wrote it. */
  readonly name: string;
  /** The model in use, recorded against the job. */
  readonly model: string;
  /**
   * How the clip should be encoded for this provider. Read per clip, so a
   * provider changed in the settings takes effect on the next one rather than
   * at the next restart.
   */
  readonly audioFormat: AudioFormat;
  transcribe(
    audioPath: string,
    language: string | null | undefined,
    signal?: AbortSignal
  ): Promise<TranscribeResult>;
}
