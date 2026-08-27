import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { commonLog, type LogLevel } from '../../../utils/logging/Logger.js';
import type Logger from '../../../utils/logging/Logger.js';
import AudioExtractor from './AudioExtractor.js';
import VoiceActivityDetector, { type SpeechInterval, type VADOptions } from './VoiceActivityDetector.js';
import OpenRouterTranscriber, { TranscriptionError } from './OpenRouterTranscriber.js';
import type TranscriptionIndex from './TranscriptionIndex.js';
import { buildSRT, filterHallucinations, type Segment } from './SubtitleBuilder.js';

/**
 * Longest clip sent in one request. The endpoint's upstreams give up after 60
 * seconds of processing; 24 minutes of audio measured at 24 seconds, so this
 * leaves a wide margin while keeping the request count low.
 */
const MAX_CLIP_SECONDS = 900;
/** Below this, splitting a failed clip further is not worth another attempt. */
const MIN_CLIP_SECONDS = 30;
/** Detection is fast relative to upload, so it owns only the first slice. */
const DETECT_SHARE = 0.1;

interface QueueEntry {
  mediaId: string;
  videoPath: string;
  controller: AbortController;
}

/**
 * Runs transcription jobs one at a time, recording every step in the index.
 *
 * There is no job state here beyond what is queued: progress, stage and
 * outcome all go straight to `TranscriptionIndex`, which is what the browser
 * reads. One source of truth, and a restart leaves behind a record that says
 * where things got to.
 */
export default class TranscriptionQueue {
  name = 'TranscriptionQueue';

  #dataDir: string;
  #extractor: AudioExtractor;
  #vad: VoiceActivityDetector;
  #transcriber: OpenRouterTranscriber;
  #index: TranscriptionIndex;
  #vadOptions?: VADOptions;
  #logger?: Logger | null;

  #pending: QueueEntry[];
  #current: QueueEntry | null;
  #draining: boolean;
  #onFinished: ((mediaId: string, succeeded: boolean) => void) | null;

  constructor(
    dataDir: string,
    extractor: AudioExtractor,
    vad: VoiceActivityDetector,
    transcriber: OpenRouterTranscriber,
    index: TranscriptionIndex,
    vadOptions?: VADOptions,
    logger?: Logger | null
  ) {
    this.#dataDir = dataDir;
    this.#extractor = extractor;
    this.#vad = vad;
    this.#transcriber = transcriber;
    this.#index = index;
    this.#vadOptions = vadOptions;
    this.#logger = logger;
    this.#pending = [];
    this.#current = null;
    this.#draining = false;
    this.#onFinished = null;
  }

  /**
   * Called after every job, however it ended.
   *
   * Set rather than injected so that translation can follow a transcription
   * without this class knowing anything about translation - which would
   * otherwise be a cycle, since a translation reads what this queue writes.
   */
  setOnFinished(handler: ((mediaId: string, succeeded: boolean) => void) | null) {
    this.#onFinished = handler;
  }

  /**
   * Picks up requests that were still waiting when the server last stopped.
   *
   * Only ones that never started: a job that was mid-flight has already been
   * marked failed by the index, so a request that brought the server down does
   * not start again on every boot.
   */
  resumePending() {
    const waiting = this.#index.listPending();
    if (waiting.length === 0) {
      return 0;
    }
    for (const record of waiting) {
      const videoPath = path.resolve(this.#dataDir, record.videoPath);
      if (!fs.existsSync(videoPath)) {
        this.#index.markError(record.mediaId, 'The video is no longer where it was');
        continue;
      }
      this.#pending.push({
        mediaId: record.mediaId,
        videoPath,
        controller: new AbortController()
      });
    }
    this.log('info', `Resuming ${this.#pending.length} transcription(s) queued before restart`);
    void this.#drain();
    return this.#pending.length;
  }

  /**
   * Queues `mediaId`. Returns the existing record when one is already queued
   * or running, so a double click does not transcribe twice.
   */
  enqueue(mediaId: string, videoPath: string) {
    const existing = this.#index.get(mediaId);
    if (existing && (existing.state === 'pending' || existing.state === 'running')) {
      return existing;
    }
    const record = this.#index.markPending(
      mediaId,
      path.relative(this.#dataDir, videoPath),
      path.basename(videoPath)
    );
    this.#pending.push({ mediaId, videoPath, controller: new AbortController() });
    void this.#drain();
    return record;
  }

  /** Cancels a queued or running job. Returns whether anything was cancelled. */
  cancel(mediaId: string) {
    const queuedIndex = this.#pending.findIndex((entry) => entry.mediaId === mediaId);
    if (queuedIndex >= 0) {
      this.#pending.splice(queuedIndex, 1);
      this.#index.markCancelled(mediaId);
      return true;
    }
    if (this.#current?.mediaId === mediaId) {
      // The record is marked once the run actually stops, in `#drain`.
      this.#current.controller.abort();
      return true;
    }
    return false;
  }

  /**
   * Stops everything: the running job and everything waiting behind it.
   *
   * The queue is emptied first, so the job being aborted does not simply hand
   * over to the next one on its way out.
   */
  cancelAll() {
    const queued = this.#pending.splice(0, this.#pending.length);
    for (const entry of queued) {
      this.#index.markCancelled(entry.mediaId);
    }
    let stopped = queued.length;
    if (this.#current) {
      this.#current.controller.abort();
      stopped++;
    }
    if (stopped > 0) {
      this.log('info', `Stopped ${stopped} transcription(s)`);
    }
    return stopped;
  }

  /** How many jobs are queued or running right now. */
  get activeCount() {
    return this.#pending.length + (this.#current ? 1 : 0);
  }

  async #drain() {
    if (this.#draining) {
      return;
    }
    this.#draining = true;
    try {
      // One at a time: each job is a long series of uploads, and running two
      // only makes both slower while multiplying the rate-limit risk.
      while (this.#pending.length > 0) {
        const entry = this.#pending.shift();
        if (!entry) {
          break;
        }
        this.#current = entry;
        try {
          await this.#run(entry);
        }
        catch (error) {
          if (entry.controller.signal.aborted) {
            this.#index.markCancelled(entry.mediaId);
          }
          else {
            const message = error instanceof Error ? error.message : String(error);
            this.log('error', `Transcription of "${entry.videoPath}" failed:`, message);
            this.#index.markError(entry.mediaId, message);
          }
        }
        finally {
          this.#current = null;
          // Read back rather than inferred from the try/catch: a cancellation
          // arrives as a throw, and a job that was already recorded done is
          // not one to look at the exception to classify.
          const succeeded = this.#index.get(entry.mediaId)?.state === 'done';
          try {
            this.#onFinished?.(entry.mediaId, succeeded);
          }
          catch (error) {
            this.log('warn', 'Handler for a finished transcription threw:', error);
          }
        }
      }
    }
    finally {
      this.#draining = false;
    }
  }

  async #run(entry: QueueEntry) {
    const { mediaId, videoPath, controller } = entry;
    const signal = controller.signal;

    this.#index.markRunning(mediaId, 'detecting');
    const intervals = await this.#vad.detect(
      videoPath,
      this.#vadOptions,
      (fraction) => this.#index.markProgress(mediaId, fraction * DETECT_SHARE * 100),
      signal
    );
    if (intervals.length === 0) {
      throw Error('No speech was detected in this video');
    }

    const clips = this.#planClips(intervals);
    const totalSeconds = clips.reduce((total, c) => total + (c.end - c.start), 0);
    this.log('info',
      `Transcribing "${path.basename(videoPath)}": ${clips.length} clips, ` +
      `${(totalSeconds / 60).toFixed(1)} min of speech`
    );
    this.#index.markStage(mediaId, 'transcribing');

    const workDir = path.resolve(
      this.#dataDir, '.patreon-dl', 'transcription',
      crypto.createHash('sha1').update(mediaId).digest('hex').slice(0, 12)
    );
    const collected: Segment[] = [];
    let language: string | null = null;
    let cost = 0;
    let doneSeconds = 0;

    try {
      for (const clip of clips) {
        if (signal.aborted) {
          throw Error('Aborted');
        }
        const result = await this.#transcribeClip(videoPath, clip, language, workDir, signal);
        // The clip was cut from the middle of the file, so what comes back is
        // relative to the clip. One addition puts it back on the video's
        // timeline - the clip is a contiguous slice, so there is nothing more
        // involved than that.
        for (const segment of result.segments) {
          collected.push({
            ...segment,
            start: segment.start + clip.start,
            end: segment.end + clip.start
          });
        }
        // Pin the language after the first clip that identifies one, so a
        // later clip of mostly silence cannot come back as another language.
        if (!language && result.language) {
          language = result.language;
        }
        if (result.cost) {
          cost += result.cost;
        }
        doneSeconds += clip.end - clip.start;
        const fraction = DETECT_SHARE + (doneSeconds / totalSeconds) * (1 - DETECT_SHARE);
        this.#index.markProgress(mediaId, Math.min(99, fraction * 100), cost);
      }
    }
    finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }

    this.#index.markStage(mediaId, 'writing');
    const { kept, rejected } = filterHallucinations(collected);
    if (rejected.length > 0) {
      const tally = rejected.reduce<Record<string, number>>((counts, r) => {
        counts[r.reason] = (counts[r.reason] || 0) + 1;
        return counts;
      }, {});
      this.log('debug', `Dropped ${rejected.length} of ${collected.length} segments:`, tally);
    }
    if (kept.length === 0) {
      throw Error('Every segment looked like a Whisper artefact, so no subtitle was written');
    }

    const srt = buildSRT(kept);
    const lang = language || 'en';
    const outFile = path.resolve(
      path.dirname(videoPath),
      `${path.basename(videoPath, path.extname(videoPath))}.${lang}.srt`
    );
    fs.writeFileSync(outFile, srt, 'utf8');
    this.log('info',
      `Wrote "${path.basename(outFile)}" - ${kept.length} captions` +
      (cost ? `, $${cost.toFixed(4)}` : '')
    );

    this.#index.markDone(mediaId, {
      subtitlePath: path.relative(this.#dataDir, outFile),
      language: lang,
      cost: cost || null
    });
  }

  /**
   * Transcribes one clip, halving it and retrying when the endpoint fails in a
   * way that a shorter clip might survive.
   */
  async #transcribeClip(
    videoPath: string,
    clip: SpeechInterval,
    language: string | null,
    workDir: string,
    signal: AbortSignal
  ): Promise<{ segments: Segment[]; language: string | null; cost: number | null }> {
    const duration = clip.end - clip.start;
    const file = path.resolve(workDir, `${clip.start.toFixed(0)}-${clip.end.toFixed(0)}.ogg`);
    await this.#extractor.extractClip(videoPath, clip.start, duration, file, 24, signal);
    try {
      const result = await this.#transcriber.transcribe(file, language, signal);
      return { segments: result.segments, language: result.language, cost: result.cost };
    }
    catch (error) {
      const splittable =
        error instanceof TranscriptionError &&
        error.retryableBySplitting &&
        duration > MIN_CLIP_SECONDS * 2 &&
        !signal.aborted;
      if (!splittable) {
        throw error;
      }
      const middle = clip.start + duration / 2;
      this.log('debug',
        `Clip ${clip.start.toFixed(0)}s-${clip.end.toFixed(0)}s failed (${(error as Error).message}); ` +
        `splitting at ${middle.toFixed(0)}s`
      );
      const first = await this.#transcribeClip(
        videoPath, { start: clip.start, end: middle }, language, workDir, signal
      );
      const second = await this.#transcribeClip(
        videoPath, { start: middle, end: clip.end }, first.language || language, workDir, signal
      );
      return {
        segments: [
          ...first.segments,
          // The second half was cut at `middle`, so its timestamps start from
          // zero again and need shifting before the two halves are joined.
          ...second.segments.map((s) => ({
            ...s,
            start: s.start + (middle - clip.start),
            end: s.end + (middle - clip.start)
          }))
        ],
        language: first.language || second.language,
        cost: (first.cost || 0) + (second.cost || 0) || null
      };
    }
    finally {
      fs.rmSync(file, { force: true });
    }
  }

  /** Splits any interval longer than the per-request ceiling into equal parts. */
  #planClips(intervals: SpeechInterval[]) {
    const clips: SpeechInterval[] = [];
    for (const interval of intervals) {
      const duration = interval.end - interval.start;
      if (duration <= MAX_CLIP_SECONDS) {
        clips.push(interval);
        continue;
      }
      // Equal parts rather than a full clip plus a short remainder, which
      // would leave a stub too small to give Whisper any context.
      const parts = Math.ceil(duration / MAX_CLIP_SECONDS);
      const size = duration / parts;
      for (let i = 0; i < parts; i++) {
        clips.push({
          start: interval.start + i * size,
          end: i === parts - 1 ? interval.end : interval.start + (i + 1) * size
        });
      }
    }
    return clips;
  }

  protected log(level: LogLevel, ...msg: any[]) {
    commonLog(this.#logger, level, this.name, ...msg);
  }
}
