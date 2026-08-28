import fs from 'fs';
import path from 'path';
import { commonLog, type LogLevel } from '../../../utils/logging/Logger.js';
import type Logger from '../../../utils/logging/Logger.js';
import type TranscriptionIndex from '../transcription/TranscriptionIndex.js';
import type GeminiTranslator from './GeminiTranslator.js';
import { TranslationError, type TranslatableLine } from './GeminiTranslator.js';
import type TranslationSettingsStore from './TranslationSettingsStore.js';
import { buildTranslatedSRT, parseSRT, type Cue } from './SubtitleParser.js';
import { buildSRT, type Segment } from '../transcription/SubtitleBuilder.js';
import { segmentTranscript } from './SubtitleSegmenter.js';
import { TARGET_LANGUAGE } from '../../types/Translation.js';

/** Source lines from the previous batch given to the next one for continuity. */
const CONTEXT_LINES = 2;
/** Below this a batch is not split any further; it is repaired line by line. */
const MIN_SPLIT_LINES = 8;
/**
 * A repair call is only worth making for a tail. When a batch comes back
 * missing more than this share of its lines the model misunderstood the batch
 * rather than ran out of room, and asking again about most of it is a second
 * call for the same answer.
 */
const MAX_REPAIR_SHARE = 0.5;

interface QueueEntry {
  mediaId: string;
  controller: AbortController;
}

/**
 * Runs translation jobs one at a time, recording every step in the same index
 * the transcriptions live in.
 *
 * Separate from `TranscriptionQueue` rather than folded into it: the two talk
 * to different upstreams with different limits, and a translation that took
 * its turn behind an hour of transcription would be waiting on nothing.
 *
 * As with transcription there is no job state here beyond what is queued.
 * Progress goes straight to `TranscriptionIndex`, so the history list has one
 * thing to read and a restart leaves a record saying where things got to.
 */
export default class TranslationQueue {
  name = 'TranslationQueue';

  #dataDir: string;
  #translator: GeminiTranslator;
  #index: TranscriptionIndex;
  #settings: TranslationSettingsStore;
  #logger?: Logger | null;

  #pending: QueueEntry[];
  #current: QueueEntry | null;
  #draining: boolean;

  constructor(
    dataDir: string,
    translator: GeminiTranslator,
    index: TranscriptionIndex,
    settings: TranslationSettingsStore,
    logger?: Logger | null
  ) {
    this.#dataDir = dataDir;
    this.#translator = translator;
    this.#index = index;
    this.#settings = settings;
    this.#logger = logger;
    this.#pending = [];
    this.#current = null;
    this.#draining = false;
  }

  /**
   * Picks up translations that were waiting when the server last stopped and
   * whose transcription is already finished.
   *
   * A translation still waiting on its transcription is left alone: the
   * transcription queue resumes that, and finishing it is what queues this.
   */
  resumePending() {
    const waiting = this.#index.list().filter((record) =>
      record.translation?.state === 'pending' && record.state === 'done' && record.subtitlePath
    );
    for (const record of waiting) {
      this.#pending.push({ mediaId: record.mediaId, controller: new AbortController() });
    }
    if (this.#pending.length > 0) {
      this.log('info', `Resuming ${this.#pending.length} translation(s) queued before restart`);
      void this.#drain();
    }
    return this.#pending.length;
  }

  /**
   * Queues `mediaId`. Returns the record it belongs to, or `null` when there
   * is nothing to translate yet.
   *
   * A translation already queued or running is left as it is, so a double
   * click does not translate - and pay for - the same file twice.
   */
  enqueue(mediaId: string) {
    const record = this.#index.get(mediaId);
    if (!record) {
      return null;
    }
    const existing = record.translation;
    if (existing && (existing.state === 'pending' || existing.state === 'running')) {
      // Already waiting on its transcription, so only the queue entry is
      // missing - and only once that transcription has produced something.
      if (!this.#queued(mediaId) && record.state === 'done' && record.subtitlePath) {
        this.#pending.push({ mediaId, controller: new AbortController() });
        void this.#drain();
      }
      return record;
    }
    const updated = this.#index.markTranslationPending(mediaId, TARGET_LANGUAGE);
    // A transcription still under way queues its own translation when it is
    // done - see `Config.ts`. Queueing it now would only find no subtitle.
    if (record.state === 'done' && record.subtitlePath) {
      this.#pending.push({ mediaId, controller: new AbortController() });
      void this.#drain();
    }
    return updated;
  }

  #queued(mediaId: string) {
    return this.#current?.mediaId === mediaId ||
      this.#pending.some((entry) => entry.mediaId === mediaId);
  }

  /** Cancels a queued or running translation. */
  cancel(mediaId: string) {
    const queuedIndex = this.#pending.findIndex((entry) => entry.mediaId === mediaId);
    if (queuedIndex >= 0) {
      this.#pending.splice(queuedIndex, 1);
      this.#index.markTranslationCancelled(mediaId);
      return true;
    }
    if (this.#current?.mediaId === mediaId) {
      // The record is marked once the run actually stops, in `#drain`.
      this.#current.controller.abort();
      return true;
    }
    // Waiting on a transcription that has not finished, so there is no entry
    // to remove - only an intention to drop.
    if (this.#index.get(mediaId)?.translation?.state === 'pending') {
      this.#index.markTranslationCancelled(mediaId);
      return true;
    }
    return false;
  }

  /** Stops the running translation and everything waiting behind it. */
  cancelAll() {
    const queued = this.#pending.splice(0, this.#pending.length);
    for (const entry of queued) {
      this.#index.markTranslationCancelled(entry.mediaId);
    }
    let stopped = queued.length;
    if (this.#current) {
      this.#current.controller.abort();
      stopped++;
    }
    // Ones still waiting on a transcription have no entry of their own.
    for (const record of this.#index.list()) {
      if (record.translation?.state === 'pending' && !this.#queued(record.mediaId)) {
        this.#index.markTranslationCancelled(record.mediaId);
        stopped++;
      }
    }
    if (stopped > 0) {
      this.log('info', `Stopped ${stopped} translation(s)`);
    }
    return stopped;
  }

  get activeCount() {
    return this.#pending.length + (this.#current ? 1 : 0);
  }

  async #drain() {
    if (this.#draining) {
      return;
    }
    this.#draining = true;
    try {
      // One at a time, as with transcription: two jobs against one key only
      // makes both slower while doubling the chance of being rate limited.
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
            this.#index.markTranslationCancelled(entry.mediaId);
          }
          else {
            const message = error instanceof Error ? error.message : String(error);
            this.log('error', `Translation of "${entry.mediaId}" failed:`, message);
            this.#index.markTranslationError(entry.mediaId, message);
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
    const { mediaId, controller } = entry;
    const signal = controller.signal;

    const record = this.#index.get(mediaId);
    if (!record?.subtitlePath) {
      throw Error('There is no transcription to translate');
    }
    const sourcePath = path.resolve(this.#dataDir, record.subtitlePath);
    if (!fs.existsSync(sourcePath)) {
      throw Error('The subtitle to translate is no longer where it was');
    }
    const videoPath = path.resolve(this.#dataDir, record.videoPath);
    const outFile = path.resolve(
      path.dirname(videoPath),
      `${path.basename(videoPath, path.extname(videoPath))}.${TARGET_LANGUAGE}.srt`
    );
    // A video that was spoken in Chinese transcribes to this very file, and
    // translating it would replace its own source with a near-copy. Checked
    // before any work, so it costs nothing rather than a whole file of calls.
    if (path.resolve(sourcePath) === outFile) {
      throw Error('This transcription is already in Chinese, so there is nothing to translate');
    }

    const cues = parseSRT(fs.readFileSync(sourcePath, 'utf-8'));
    if (cues.length === 0) {
      throw Error('That subtitle file has no captions in it');
    }

    this.#index.markTranslationRunning(mediaId, cues.length);
    const batches = this.#planBatches(cues);
    this.log('info',
      `Translating "${record.videoName}": ${cues.length} captions in ${batches.length} batch(es)`
    );

    const translations = new Map<number, string>();
    let requests = 0;
    let done = 0;

    for (const batch of batches) {
      if (signal.aborted) {
        throw Error('Aborted');
      }
      // The tail of what came before, so a sentence split across the boundary
      // is translated as one. It costs a few hundred characters, never a call.
      const context = this.#contextFor(cues, batch[0].index);
      try {
        const result = await this.#translateBatch(batch, context, signal);
        requests += result.requests;
        for (const [ index, text ] of result.translations) {
          translations.set(index, text);
        }
      }
      catch (error) {
        // Whatever the failure cost is still owed, so it is counted before
        // the job is abandoned.
        requests += error instanceof TranslationError ? error.requests : 0;
        this.#settings.addRequests(requests);
        throw error;
      }
      done += batch.length;
      this.#index.markTranslationProgress(mediaId, done, requests);
    }

    this.#settings.addRequests(requests);

    const missing = cues.filter((cue) => !translations.has(cue.index)).length;
    if (missing === cues.length) {
      throw Error('Nothing came back translated');
    }
    if (missing > 0) {
      // Those lines keep their original text rather than becoming gaps - see
      // `buildTranslatedSRT`.
      this.log('warn', `${missing} of ${cues.length} captions were left untranslated`);
    }

    const srt = this.#settings.getSegmentation() ?
      this.#recut(cues, translations)
      : buildTranslatedSRT(cues, translations);
    fs.writeFileSync(outFile, srt, 'utf8');
    this.log('info',
      `Wrote "${path.basename(outFile)}" - ${cues.length} captions, ` +
      `${requests} request(s)`
    );

    this.#index.markTranslationDone(mediaId, {
      subtitlePath: path.relative(this.#dataDir, outFile),
      requests
    });
  }

  /**
   * Renders the translation with its lines re-cut for Chinese.
   *
   * The translation itself stays one line per original caption - that is what
   * keeps the timings attached to the words they belong to - and the re-cutting
   * happens here, afterwards, on text that is already in hand. It costs
   * nothing: the punctuation Gemini returns and the silence between captions
   * are both already known.
   *
   * Only the Chinese file is treated this way. The transcription's own subtitle
   * is left exactly as it was written.
   */
  #recut(cues: Cue[], translations: Map<number, string>) {
    // Written by this application, so the timings parse - but a file edited by
    // hand might not, and re-cutting on times that all read as zero would put
    // every caption at the start of the video.
    const timed = cues.length > 0 && cues[cues.length - 1].end > cues[0].start;
    if (!timed) {
      this.log('warn', 'Could not read the timings, so the lines are left as they were');
      return buildTranslatedSRT(cues, translations);
    }
    const source: Segment[] = cues.map((cue) => ({
      start: cue.start,
      end: cue.end,
      // A line that came back untranslated keeps its original, as it does on
      // the plain path - better read in the source language than not at all.
      text: (translations.get(cue.index) || cue.text).trim()
    }));
    const { segments, hardRuns } = segmentTranscript(source, {
      maxCjk: this.#settings.getMaxLineCjk(),
      maxLatin: this.#settings.getMaxLineLatin()
    });
    this.log('debug',
      `Re-cut ${cues.length} captions into ${segments.length}` +
      (hardRuns.length > 0 ? `; ${hardRuns.length} stretch(es) had no punctuation to cut on` : '')
    );
    return buildSRT(segments);
  }

  /**
   * Translates one batch, repairing or splitting when the answer comes back
   * short.
   *
   * Everything here is counted in calls, because that is what Gemini bills by:
   * a clean batch is one, a batch missing its tail is two, and a batch too
   * large for the model to answer is split rather than sent again whole.
   *
   * Every batch is sent. There was a cache here, keyed by the batch text and
   * the settings that shape the answer, so a retry did not pay twice - but a
   * re-run is nearly always asked for because something about the last answer
   * was wrong, and it came back with yesterday's wording for every change the
   * key could not see. Paying for it again is the point of asking.
   */
  async #translateBatch(
    batch: Cue[],
    context: string[],
    signal: AbortSignal
  ): Promise<{ translations: Map<number, string>; requests: number }> {
    const lines: TranslatableLine[] = batch.map((cue) => ({ i: cue.index, t: cue.text }));
    let translations: Map<number, string>;
    let requests: number;
    try {
      const result = await this.#translator.translateBatch(lines, context, signal);
      translations = result.translations;
      requests = result.requests;
    }
    catch (error) {
      const splittable =
        error instanceof TranslationError &&
        error.retryableBySplitting &&
        batch.length >= MIN_SPLIT_LINES * 2 &&
        !signal.aborted;
      if (!splittable) {
        throw error;
      }
      const middle = Math.floor(batch.length / 2);
      this.log('debug',
        `Batch of ${batch.length} failed (${(error as Error).message}); splitting in two`
      );
      const first = await this.#translateBatch(batch.slice(0, middle), context, signal);
      const second = await this.#translateBatch(
        batch.slice(middle),
        this.#tailOf(batch.slice(0, middle)),
        signal
      );
      return {
        translations: new Map([ ...first.translations, ...second.translations ]),
        // The failed attempts were paid for too, so they are added back in.
        requests: error.requests + first.requests + second.requests
      };
    }

    const short = batch.filter((cue) => !translations.has(cue.index));
    if (short.length > 0 && short.length <= batch.length * MAX_REPAIR_SHARE) {
      // One more call, for the missing lines only. Asking for the whole batch
      // again would be the same answer at the same price for the part that
      // already arrived.
      this.log('debug', `Repairing ${short.length} of ${batch.length} captions`);
      try {
        const repair = await this.#translator.translateBatch(
          short.map((cue) => ({ i: cue.index, t: cue.text })),
          context,
          signal
        );
        requests += repair.requests;
        for (const [ index, text ] of repair.translations) {
          translations.set(index, text);
        }
      }
      catch (error) {
        // A failed repair leaves the lines it was for untranslated, which
        // `buildTranslatedSRT` renders as the original. Not worth losing the
        // rest of the batch over.
        requests += error instanceof TranslationError ? error.requests : 0;
        this.log('debug', `Repair failed: ${(error as Error).message}`);
      }
    }

    return { translations, requests };
  }

  /**
   * Groups cues into batches, by characters first and lines second.
   *
   * Characters because that is what decides whether the answer fits in the
   * model's output; lines because a file of very short captions would
   * otherwise put a thousand of them in one call and make the repair of any
   * one of them expensive.
   */
  #planBatches(cues: Cue[]) {
    const maxCharacters = this.#settings.getBatchCharacters();
    const maxLines = this.#settings.getBatchLines();
    const batches: Cue[][] = [];
    let batch: Cue[] = [];
    let characters = 0;
    for (const cue of cues) {
      if (batch.length > 0 && (batch.length >= maxLines || characters + cue.text.length > maxCharacters)) {
        batches.push(batch);
        batch = [];
        characters = 0;
      }
      batch.push(cue);
      characters += cue.text.length;
    }
    if (batch.length > 0) {
      batches.push(batch);
    }
    return batches;
  }

  /** The source lines just before `index`, for continuity across a boundary. */
  #contextFor(cues: Cue[], index: number) {
    const start = Math.max(0, index - 1 - CONTEXT_LINES);
    return cues.slice(start, index - 1).map((cue) => cue.text);
  }

  #tailOf(cues: Cue[]) {
    return cues.slice(-CONTEXT_LINES).map((cue) => cue.text);
  }

  protected log(level: LogLevel, ...msg: any[]) {
    commonLog(this.#logger, level, this.name, ...msg);
  }
}
