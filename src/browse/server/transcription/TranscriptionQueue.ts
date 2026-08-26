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
import { type TranscriptionJob } from '../../types/Transcription.js';

export { type JobStatus, type TranscriptionJob } from '../../types/Transcription.js';

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
 * Runs transcription jobs one at a time.
 *
 * Live progress stays in memory - it changes every second and is of no
 * interest once a job ends - while the outcome goes to `TranscriptionIndex`,
 * so the browser can be told what has been transcribed without anyone reading
 * the media library. A job interrupted by a restart is left as `pending` in
 * the index and has to be started again; the alternative was a schema
 * migration, which is a lot to put in front of a feature that can just be
 * re-run.
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

  #jobs: Map<string, TranscriptionJob>;
  #pending: QueueEntry[];
  #current: QueueEntry | null;
  #draining: boolean;

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
    this.#jobs = new Map();
    this.#pending = [];
    this.#current = null;
    this.#draining = false;
  }

  /** Current state for `mediaId`, or `null` if it has never been queued. */
  getJob(mediaId: string) {
    return this.#jobs.get(mediaId) || null;
  }

  listJobs() {
    return [ ...this.#jobs.values() ];
  }

  /**
   * Queues `mediaId`. Returns the existing job when one is already queued or
   * running, so a double click does not transcribe twice.
   */
  enqueue(mediaId: string, videoPath: string): TranscriptionJob {
    const existing = this.#jobs.get(mediaId);
    if (existing && [ 'queued', 'detecting', 'transcribing', 'writing' ].includes(existing.status)) {
      return existing;
    }
    const job: TranscriptionJob = {
      mediaId,
      status: 'queued',
      percent: 0,
      error: null,
      language: null,
      subtitlePath: null,
      cost: null,
      queuedAt: new Date().toISOString(),
      finishedAt: null
    };
    this.#jobs.set(mediaId, job);
    // Recorded before any work starts, so a request survives a crash as a
    // visible `pending` rather than vanishing.
    this.#index.markRequested(mediaId, path.relative(this.#dataDir, videoPath));
    this.#pending.push({ mediaId, videoPath, controller: new AbortController() });
    void this.#drain();
    return job;
  }

  /** Cancels a queued or running job. Returns whether anything was cancelled. */
  cancel(mediaId: string) {
    const queuedIndex = this.#pending.findIndex((entry) => entry.mediaId === mediaId);
    if (queuedIndex >= 0) {
      this.#pending.splice(queuedIndex, 1);
      this.#finish(mediaId, { status: 'cancelled' });
      this.#index.remove(mediaId);
      return true;
    }
    if (this.#current?.mediaId === mediaId) {
      this.#current.controller.abort();
      return true;
    }
    return false;
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
            this.#finish(entry.mediaId, { status: 'cancelled' });
            // A cancelled job left nothing behind, so it should not linger in
            // the index as something that was asked for.
            this.#index.remove(entry.mediaId);
          }
          else {
            const message = error instanceof Error ? error.message : String(error);
            this.log('error', `Transcription of "${entry.videoPath}" failed:`, message);
            this.#finish(entry.mediaId, { status: 'error', error: message });
            this.#index.markError(entry.mediaId, message);
          }
        }
        finally {
          this.#current = null;
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

    this.#update(mediaId, { status: 'detecting', percent: 0 });
    const intervals = await this.#vad.detect(
      videoPath,
      this.#vadOptions,
      (fraction) => this.#update(mediaId, { percent: Math.round(fraction * DETECT_SHARE * 100) }),
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
    this.#update(mediaId, { status: 'transcribing' });

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
          this.#update(mediaId, { language });
        }
        if (result.cost) {
          cost += result.cost;
        }
        doneSeconds += clip.end - clip.start;
        const fraction = DETECT_SHARE + (doneSeconds / totalSeconds) * (1 - DETECT_SHARE);
        this.#update(mediaId, { percent: Math.min(99, Math.round(fraction * 100)), cost });
      }
    }
    finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }

    this.#update(mediaId, { status: 'writing', percent: 99 });
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

    const subtitlePath = path.relative(this.#dataDir, outFile);
    this.#finish(mediaId, {
      status: 'done',
      percent: 100,
      language: lang,
      subtitlePath,
      cost: cost || null
    });
    this.#index.markDone(mediaId, { subtitlePath, language: lang, cost: cost || null });
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

  #update(mediaId: string, patch: Partial<TranscriptionJob>) {
    const job = this.#jobs.get(mediaId);
    if (job) {
      Object.assign(job, patch);
    }
  }

  #finish(mediaId: string, patch: Partial<TranscriptionJob>) {
    this.#update(mediaId, { ...patch, finishedAt: new Date().toISOString() });
  }

  protected log(level: LogLevel, ...msg: any[]) {
    commonLog(this.#logger, level, this.name, ...msg);
  }
}
