import fs from 'fs';
import path from 'path';
import { commonLog, type LogLevel } from '../../../utils/logging/Logger.js';
import { type Logger } from '../../../utils/logging/index.js';
import {
  type TranscriptionRecord,
  type TranscriptionStage,
  type TranscriptionState
} from '../../types/Transcription.js';
import { type TranslationProgress, type TranslationState } from '../../types/Translation.js';

export {
  type TranscriptionState,
  type TranscriptionStage,
  type TranscriptionRecord
} from '../../types/Transcription.js';

interface IndexFile {
  version: number;
  records: Record<string, TranscriptionRecord>;
}

const CURRENT_VERSION = 1;

/**
 * Progress is written no more often than this. Detection alone reports a
 * hundred times, and rewriting the file for each would put a few hundred
 * writes on the disk holding the library for no one's benefit - a percentage
 * is stale within a second either way.
 */
const PROGRESS_WRITE_INTERVAL_MS = 1500;

/**
 * Every transcription that has been asked for, and what became of it.
 *
 * This is the only place a job's state lives. Keeping progress here as well as
 * the outcome means one source of truth for the history list, and it means a
 * server that stops mid-job leaves behind a record saying where it got to
 * rather than a job that simply vanished.
 *
 * It is also what the grid reads to mark a video as captioned. The
 * alternative - looking beside each video for a subtitle file - costs one
 * directory read per tile, which on a library of a few thousand posts held on
 * an external drive means a few thousand seeks to draw one page.
 */
export default class TranscriptionIndex {
  name = 'TranscriptionIndex';

  #filePath: string;
  #data: IndexFile;
  #logger?: Logger | null;
  /** Set when a progress update has been made but not yet written. */
  #dirty: boolean;
  #flushTimer: NodeJS.Timeout | null;

  private constructor(filePath: string, data: IndexFile, logger?: Logger | null) {
    this.#filePath = filePath;
    this.#data = data;
    this.#logger = logger;
    this.#dirty = false;
    this.#flushTimer = null;
  }

  static load(filePath: string, logger?: Logger | null) {
    let records: Record<string, TranscriptionRecord> = {};
    if (fs.existsSync(filePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as IndexFile;
        if (parsed && typeof parsed === 'object' && parsed.records) {
          records = parsed.records;
          // Written before translation existed, so the field is simply absent
          // rather than null. Filled in here so nothing downstream has to
          // distinguish the two.
          for (const record of Object.values(records)) {
            record.translation = record.translation || null;
          }
        }
      }
      catch (error) {
        // This file is a cache of work that can be redone, so a corrupt one is
        // not worth refusing to start over - unlike the accounts file.
        commonLog(logger, 'warn', 'TranscriptionIndex',
          `Could not read "${filePath}", starting a new one:`, error);
      }
    }

    const index = new TranscriptionIndex(filePath, { version: CURRENT_VERSION, records }, logger);
    index.#reconcileInterrupted();
    return index;
  }

  /**
   * Nothing is running at startup, so any record that still says it is was cut
   * off by a restart.
   *
   * Those are marked failed rather than re-queued: a job that brought the
   * server down would otherwise start again on every boot. Records still
   * waiting their turn are left alone - the queue picks them up, so a
   * transcription asked for just before a restart is not silently forgotten.
   */
  #reconcileInterrupted() {
    let interrupted = 0;
    for (const record of Object.values(this.#data.records)) {
      if (record.state === 'running') {
        record.state = 'error';
        record.stage = null;
        record.error = 'Interrupted by a server restart';
        record.completedAt = new Date().toISOString();
        interrupted++;
      }
      // A translation left running is in the same position. One left pending
      // is not: the translation queue picks those up, and the transcription
      // they were waiting on is resumed the same way.
      if (record.translation?.state === 'running') {
        record.translation.state = 'error';
        record.translation.error = 'Interrupted by a server restart';
        record.translation.completedAt = new Date().toISOString();
        interrupted++;
      }
    }
    if (interrupted > 0) {
      this.log('info', `${interrupted} transcription(s) were interrupted by a restart`);
      this.#write();
    }
  }

  get(mediaId: string): TranscriptionRecord | null {
    return this.#data.records[mediaId] || null;
  }

  /** Newest request first, which is the order a history list wants. */
  list(): TranscriptionRecord[] {
    return Object.values(this.#data.records)
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  }

  /** Records still waiting their turn, oldest first. */
  listPending(): TranscriptionRecord[] {
    return Object.values(this.#data.records)
      .filter((record) => record.state === 'pending')
      .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  }

  /** Records a request, before any work starts. */
  markPending(mediaId: string, videoPath: string, videoName: string) {
    const record: TranscriptionRecord = {
      mediaId,
      videoPath,
      videoName,
      subtitlePath: null,
      language: null,
      state: 'pending',
      stage: null,
      percent: 0,
      error: null,
      cost: null,
      requestedAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      // A fresh transcription is about to replace the subtitle any previous
      // translation was made from, so that translation is no longer about
      // anything. Whoever asks for this one says whether to translate it.
      translation: null
    };
    this.#data.records[mediaId] = record;
    this.#write();
    return record;
  }

  markRunning(mediaId: string, stage: TranscriptionStage) {
    return this.#patch(mediaId, {
      state: 'running',
      stage,
      percent: 0,
      error: null,
      startedAt: new Date().toISOString()
    });
  }

  /** Moves between the parts of a running job without resetting progress. */
  markStage(mediaId: string, stage: TranscriptionStage) {
    return this.#patch(mediaId, { stage });
  }

  /**
   * Updates progress. Written at a bounded rate rather than on every call -
   * see `PROGRESS_WRITE_INTERVAL_MS`.
   */
  markProgress(mediaId: string, percent: number, cost?: number | null) {
    const record = this.#data.records[mediaId];
    if (!record) {
      return null;
    }
    record.percent = Math.max(0, Math.min(100, Math.round(percent)));
    if (cost !== undefined && cost !== null) {
      record.cost = cost;
    }
    this.#scheduleWrite();
    return record;
  }

  markDone(mediaId: string, params: { subtitlePath: string; language: string; cost: number | null }) {
    return this.#patch(mediaId, {
      state: 'done',
      stage: null,
      percent: 100,
      error: null,
      subtitlePath: params.subtitlePath,
      language: params.language,
      cost: params.cost,
      completedAt: new Date().toISOString()
    });
  }

  markError(mediaId: string, error: string) {
    return this.#patch(mediaId, {
      state: 'error',
      stage: null,
      error,
      completedAt: new Date().toISOString()
    });
  }

  markCancelled(mediaId: string) {
    return this.#patch(mediaId, {
      state: 'cancelled',
      stage: null,
      error: null,
      completedAt: new Date().toISOString()
    });
  }

  /**
   * Records that a translation has been asked for.
   *
   * It starts pending whether or not the transcription is finished: when it is
   * not, this is the flag that says to queue one as soon as it is - which is
   * what the checkbox on the transcribe confirmation sets.
   */
  markTranslationPending(mediaId: string, targetLanguage: string) {
    const record = this.#data.records[mediaId];
    if (!record) {
      return null;
    }
    const translation: TranslationProgress = {
      state: 'pending',
      targetLanguage,
      percent: 0,
      subtitlePath: null,
      error: null,
      done: 0,
      total: 0,
      requests: 0,
      cached: 0,
      requestedAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null
    };
    record.translation = translation;
    this.#write();
    return record;
  }

  markTranslationRunning(mediaId: string, total: number) {
    return this.#patchTranslation(mediaId, {
      state: 'running',
      percent: 0,
      error: null,
      done: 0,
      total,
      startedAt: new Date().toISOString()
    });
  }

  /**
   * Updates progress. Written at the same bounded rate as transcription
   * progress - see `PROGRESS_WRITE_INTERVAL_MS`.
   */
  markTranslationProgress(mediaId: string, done: number, requests: number, cached: number) {
    const translation = this.#data.records[mediaId]?.translation;
    if (!translation) {
      return null;
    }
    translation.done = done;
    translation.requests = requests;
    translation.cached = cached;
    translation.percent = translation.total > 0 ?
      Math.max(0, Math.min(99, Math.round((done / translation.total) * 100)))
      : 0;
    this.#scheduleWrite();
    return translation;
  }

  markTranslationDone(
    mediaId: string,
    params: { subtitlePath: string; requests: number; cached: number }
  ) {
    return this.#patchTranslation(mediaId, {
      state: 'done',
      percent: 100,
      error: null,
      subtitlePath: params.subtitlePath,
      requests: params.requests,
      cached: params.cached,
      completedAt: new Date().toISOString()
    });
  }

  markTranslationError(mediaId: string, error: string) {
    return this.#patchTranslation(mediaId, {
      state: 'error',
      error,
      completedAt: new Date().toISOString()
    });
  }

  markTranslationCancelled(mediaId: string) {
    return this.#patchTranslation(mediaId, {
      state: 'cancelled',
      error: null,
      completedAt: new Date().toISOString()
    });
  }

  /** Every record whose translation is in one of `states`. */
  listTranslations(states: TranslationState[]): TranscriptionRecord[] {
    return Object.values(this.#data.records)
      .filter((record) => !!record.translation && states.includes(record.translation.state))
      .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  }

  #patchTranslation(mediaId: string, patch: Partial<TranslationProgress>) {
    const translation = this.#data.records[mediaId]?.translation;
    if (!translation) {
      return null;
    }
    Object.assign(translation, patch);
    this.#write();
    return translation;
  }

  /** Forgets a record entirely, so its video looks untouched again. */
  remove(mediaId: string) {
    if (!this.#data.records[mediaId]) {
      return false;
    }
    delete this.#data.records[mediaId];
    this.#write();
    return true;
  }

  /** Drops every record that is no longer moving. */
  clearFinished() {
    let removed = 0;
    for (const [ id, record ] of Object.entries(this.#data.records)) {
      const translating = record.translation?.state === 'pending' ||
        record.translation?.state === 'running';
      if (record.state !== 'pending' && record.state !== 'running' && !translating) {
        delete this.#data.records[id];
        removed++;
      }
    }
    if (removed > 0) {
      this.#write();
    }
    return removed;
  }

  /** A state change is durable immediately; progress can wait. */
  #patch(mediaId: string, patch: Partial<TranscriptionRecord>) {
    const record = this.#data.records[mediaId];
    if (!record) {
      return null;
    }
    Object.assign(record, patch);
    this.#write();
    return record;
  }

  #scheduleWrite() {
    this.#dirty = true;
    if (this.#flushTimer) {
      return;
    }
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      if (this.#dirty) {
        this.#write();
      }
    }, PROGRESS_WRITE_INTERVAL_MS);
    // Never hold the process open just to write a percentage.
    this.#flushTimer.unref?.();
  }

  #write() {
    this.#dirty = false;
    try {
      const dir = path.dirname(this.#filePath);
      fs.mkdirSync(dir, { recursive: true });
      // Same directory as the target, so the rename stays within one
      // filesystem and is therefore atomic.
      const tmpFilePath = `${this.#filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpFilePath, JSON.stringify(this.#data, null, 2));
      fs.renameSync(tmpFilePath, this.#filePath);
    }
    catch (error) {
      // Losing the index costs a redundant re-transcription at worst, so it
      // must never take a running job down with it.
      this.log('warn', `Could not write "${this.#filePath}":`, error);
    }
  }

  protected log(level: LogLevel, ...msg: any[]) {
    commonLog(this.#logger, level, this.name, ...msg);
  }
}
