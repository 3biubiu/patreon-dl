import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { commonLog, type LogLevel } from '../../../utils/logging/Logger.js';
import type Logger from '../../../utils/logging/Logger.js';
import AudioExtractor, { snapToSpliceGrid } from './AudioExtractor.js';
import VoiceActivityDetector, { type SpeechInterval, type TimeRange, type VADOptions } from './VoiceActivityDetector.js';
import OpenRouterTranscriber, { TranscriptionError } from './OpenRouterTranscriber.js';
import type TranscriptionIndex from './TranscriptionIndex.js';
import { buildSRT, filterHallucinations, type Segment } from './SubtitleBuilder.js';

/**
 * Most audio sent in one request. The endpoint's upstreams give up after 60
 * seconds of processing; 24 minutes of audio measured at 24 seconds, so this
 * leaves a wide margin while keeping the request count low. At the 24 kbps
 * the clips are encoded at it is a 5 MB upload, well inside the 25 MB the
 * endpoint accepts.
 *
 * Half an hour of speech, not half an hour of video: the silence is spliced
 * out before the clip is uploaded, so this is spent entirely on talking.
 */
const MAX_CLIP_SECONDS = 1800;
/** Below this, splitting a failed clip further is not worth another attempt. */
const MIN_CLIP_SECONDS = 30;
/**
 * How far a cut may travel from the even division to reach a silence, as a
 * fraction of the part length.
 *
 * Held to a quarter so cuts stay in order and no part grows much past its
 * share; the ceiling's own headroom caps it further.
 */
const SPLIT_TOLERANCE = 0.25;
/** Detection is fast relative to upload, so it owns only the first slice. */
const DETECT_SHARE = 0.1;

interface QueueEntry {
  mediaId: string;
  videoPath: string;
  controller: AbortController;
}

/**
 * One request's worth of audio: the stretches of speech that go into it, in
 * the video's own time.
 *
 * A clip is not a slice of the video. The silence between its pieces is left
 * out of the file that gets uploaded, which is what lets the ceiling be spent
 * on speech rather than on whatever the speech happens to be spread across -
 * a sparse hour becomes one request instead of forty. The price is that a
 * timestamp coming back has to be walked through `pieces` to find out where
 * in the video it belongs, rather than shifted by the clip's start.
 */
interface Clip {
  pieces: SpeechInterval[];
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
    const totalSeconds = clips.reduce((total, c) => total + this.#clipDuration(c), 0);
    this.log('info',
      `Transcribing "${path.basename(videoPath)}": ${clips.length} clip(s) spliced from ` +
      `${clips.reduce((total, c) => total + c.pieces.length, 0)} pieces, ` +
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
        // Already on the video's timeline: the clip is the only thing that
        // knows which pieces it was spliced from, so it maps its own
        // timestamps back before handing them over.
        collected.push(...result.segments);
        // Pin the language after the first clip that identifies one, so a
        // later clip of mostly silence cannot come back as another language.
        if (!language && result.language) {
          language = result.language;
        }
        if (result.cost) {
          cost += result.cost;
        }
        doneSeconds += this.#clipDuration(clip);
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
    clip: Clip,
    language: string | null,
    workDir: string,
    signal: AbortSignal
  ): Promise<{ segments: Segment[]; language: string | null; cost: number | null }> {
    const duration = this.#clipDuration(clip);
    const span = this.#clipSpan(clip);
    const file = path.resolve(workDir, `${span.start.toFixed(0)}-${span.end.toFixed(0)}.ogg`);
    await this.#extractor.extractPieces(videoPath, clip.pieces, file, 24, signal);
    try {
      const result = await this.#transcriber.transcribe(file, language, signal);
      return {
        // What comes back is on the spliced file's timeline, where the
        // silence between the pieces does not exist. It goes home through
        // the same piece list the file was cut with.
        segments: result.segments.map((segment) => this.#toSourceTime(clip, segment)),
        language: result.language,
        cost: result.cost
      };
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
      const [ first, second ] = this.#halve(clip);
      if (first.pieces.length === 0 || second.pieces.length === 0) {
        // Nowhere to divide it that leaves audio on both sides. Whatever the
        // endpoint objected to, a second attempt at the same clip will not
        // answer it.
        throw error;
      }
      this.log('debug',
        `Clip ${span.start.toFixed(0)}s-${span.end.toFixed(0)}s failed ` +
        `(${(error as Error).message}); splitting into ` +
        `${first.pieces.length} + ${second.pieces.length} pieces`
      );
      const head = await this.#transcribeClip(videoPath, first, language, workDir, signal);
      const tail = await this.#transcribeClip(
        videoPath, second, head.language || language, workDir, signal
      );
      return {
        // Each half mapped its own timestamps on the way out, so joining them
        // is just putting the two lists end to end.
        segments: [ ...head.segments, ...tail.segments ],
        language: head.language || tail.language,
        cost: (head.cost || 0) + (tail.cost || 0) || null
      };
    }
    finally {
      fs.rmSync(file, { force: true });
    }
  }

  /**
   * Turns the detected speech into as few requests as it will fit into.
   *
   * Anything longer than a single request can hold is divided first, and then
   * consecutive pieces are packed together until the next one would not fit.
   * Because the silence between pieces is dropped on the way out, packing
   * costs nothing but the speech itself: the half hour a request is allowed
   * is half an hour of talking, not half an hour of video with talking
   * somewhere in it.
   *
   * This is also what settles the stray-fragment problem for free. A single
   * second of speech surrounded by silence is never a request of its own -
   * it is simply the next piece of whichever clip is currently being filled.
   */
  #planClips(intervals: SpeechInterval[]): Clip[] {
    const clips: Clip[] = [];
    let pieces: SpeechInterval[] = [];
    let filled = 0;
    for (const piece of intervals.flatMap((interval) => this.#divide(interval))) {
      const duration = piece.end - piece.start;
      if (pieces.length > 0 && filled + duration > MAX_CLIP_SECONDS) {
        clips.push({ pieces });
        pieces = [];
        filled = 0;
      }
      pieces.push(piece);
      filled += duration;
    }
    if (pieces.length > 0) {
      clips.push({ pieces });
    }
    return clips;
  }

  /**
   * Cuts an interval down to pieces a single request can hold, at the
   * silences the detector recorded rather than at an arbitrary second.
   *
   * The number of parts is settled first and the interval divided evenly, so
   * a long stretch never ends in a stub too short to give Whisper any
   * context. Each of those even cut points is then walked to the nearest
   * usable silence, which is what stops a cut from landing inside a word and
   * losing it from both halves. The tolerance is also kept under whatever
   * headroom the ceiling leaves, so moving a cut cannot push a part over it.
   */
  #divide(interval: SpeechInterval): SpeechInterval[] {
    const duration = interval.end - interval.start;
    if (duration <= MAX_CLIP_SECONDS) {
      return [ this.#slice(interval, interval.start, interval.end) ];
    }
    const parts: SpeechInterval[] = [];
    const count = Math.ceil(duration / MAX_CLIP_SECONDS);
    const size = duration / count;
    const tolerance = Math.min(size * SPLIT_TOLERANCE, (MAX_CLIP_SECONDS - size) / 2);
    let start = interval.start;
    for (let i = 1; i < count; i++) {
      const at = this.#cutPoint(interval, interval.start + i * size, tolerance);
      parts.push(this.#slice(interval, start, at));
      start = at;
    }
    parts.push(this.#slice(interval, start, interval.end));
    return parts;
  }

  /** How much audio a clip actually carries, silence excluded. */
  #clipDuration(clip: Clip) {
    return clip.pieces.reduce((total, piece) => total + (piece.end - piece.start), 0);
  }

  /** Where a clip begins and ends in the video, silence included. */
  #clipSpan(clip: Clip): TimeRange {
    return {
      start: clip.pieces[0].start,
      end: clip.pieces[clip.pieces.length - 1].end
    };
  }

  /**
   * Divides a clip in two for a retry.
   *
   * A seam is the natural place to stop - the pieces either side of it are
   * already separated by silence in the video - so the halfway point is only
   * cut into a piece when it falls well inside one. Either half can come back
   * empty when the clip is a single short piece, which the caller reads as
   * "there is nothing to divide".
   */
  #halve(clip: Clip): [ Clip, Clip ] {
    const half = this.#clipDuration(clip) / 2;
    const before: SpeechInterval[] = [];
    const after: SpeechInterval[] = [];
    let filled = 0;
    for (const piece of clip.pieces) {
      const duration = piece.end - piece.start;
      if (filled + duration <= half) {
        before.push(piece);
      }
      else if (filled >= half) {
        after.push(piece);
      }
      else {
        const at = this.#cutPoint(
          piece, piece.start + (half - filled), duration * SPLIT_TOLERANCE);
        before.push(this.#slice(piece, piece.start, at));
        after.push(this.#slice(piece, at, piece.end));
      }
      filled += duration;
    }
    const usable = (pieces: SpeechInterval[]) => pieces.filter((p) => p.end > p.start);
    return [ { pieces: usable(before) }, { pieces: usable(after) } ];
  }

  /**
   * Puts one segment back on the video's timeline.
   *
   * The offset to add depends on which piece the timestamp lands in, so the
   * pieces are walked until the time is accounted for. Anything past the end
   * belongs to the last piece: a caption running over the edge is Whisper
   * guessing at a duration, not a reason to place it elsewhere.
   */
  #toSourceTime(clip: Clip, segment: Segment): Segment {
    const from = this.#locate(clip, segment.start);
    const to = this.#locate(clip, segment.end);
    return {
      ...segment,
      start: from.time,
      // Held inside the piece it started in. A caption that appears to cross
      // a seam would otherwise be stretched over the silence that was cut out
      // between the two, and a seam is a silence long enough that the
      // detector called it the end of the speech - not something one caption
      // spans.
      end: Math.max(from.time, Math.min(to.time, from.piece.end))
    };
  }

  /** Which piece of `clip` its own timestamp `at` falls in, and where. */
  #locate(clip: Clip, at: number) {
    let offset = 0;
    for (const piece of clip.pieces) {
      const duration = piece.end - piece.start;
      if (at < offset + duration) {
        return { piece, time: piece.start + Math.max(0, at - offset) };
      }
      offset += duration;
    }
    const piece = clip.pieces[clip.pieces.length - 1];
    return { piece, time: piece.end };
  }

  /**
   * Where to cut `interval` near `target`: the middle of the longest silence
   * within `tolerance`, or `target` itself when the stretch has none.
   *
   * The longest rather than the closest one. A cut in the middle of two
   * seconds of nothing survives the detector's edges being slightly off,
   * where one placed in a quarter-second breath does not, and the longest
   * silence is also where Whisper is most likely to have started inventing -
   * so ending a request there costs nothing that was worth keeping.
   */
  #cutPoint(interval: SpeechInterval, target: number, tolerance: number) {
    let best: TimeRange | null = null;
    for (const gap of interval.gaps) {
      const middle = (gap.start + gap.end) / 2;
      if (Math.abs(middle - target) > tolerance) {
        continue;
      }
      if (!best || gap.end - gap.start > best.end - best.start) {
        best = gap;
      }
    }
    return best ? (best.start + best.end) / 2 : target;
  }

  /**
   * The part of `interval` between `start` and `end`, with the silences it
   * contains.
   *
   * Every piece is born here, and every piece is snapped to the splice grid
   * on the way out: the durations added up to read a timestamp back have to
   * be the durations ffmpeg wrote, or a subtitle drifts a little further out
   * with each piece it is past.
   */
  #slice(interval: SpeechInterval, start: number, end: number): SpeechInterval {
    const from = snapToSpliceGrid(start);
    const to = snapToSpliceGrid(end);
    return {
      start: from,
      end: to,
      gaps: interval.gaps.filter((gap) => gap.start >= from && gap.end <= to)
    };
  }

  protected log(level: LogLevel, ...msg: any[]) {
    commonLog(this.#logger, level, this.name, ...msg);
  }
}
