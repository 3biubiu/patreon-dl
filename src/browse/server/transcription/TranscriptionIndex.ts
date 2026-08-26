import fs from 'fs';
import path from 'path';
import { commonLog, type LogLevel } from '../../../utils/logging/Logger.js';
import { type Logger } from '../../../utils/logging/index.js';
import { type TranscriptionRecord } from '../../types/Transcription.js';

export { type TranscriptionState, type TranscriptionRecord } from '../../types/Transcription.js';

interface IndexFile {
  version: number;
  records: Record<string, TranscriptionRecord>;
}

const CURRENT_VERSION = 1;

/**
 * Remembers which videos have been transcribed, so that the browser can be
 * told without anyone touching the media library.
 *
 * The alternative - looking beside each video for a subtitle file - costs one
 * directory read per tile. A library of a few thousand posts on an external
 * drive turns that into a few thousand seeks to draw one page, which is why
 * this file exists.
 *
 * The library itself stays the source of truth for what a player can show: a
 * subtitle can be added or deleted by hand, so the picker reads the video's
 * own directory when a video is actually opened. That is one read for one
 * video, on demand, which is affordable in a way that scanning is not.
 */
export default class TranscriptionIndex {
  name = 'TranscriptionIndex';

  #filePath: string;
  #data: IndexFile;
  #logger?: Logger | null;

  private constructor(filePath: string, data: IndexFile, logger?: Logger | null) {
    this.#filePath = filePath;
    this.#data = data;
    this.#logger = logger;
  }

  static load(filePath: string, logger?: Logger | null) {
    if (fs.existsSync(filePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as IndexFile;
        if (data && typeof data === 'object' && data.records) {
          return new TranscriptionIndex(filePath, {
            version: CURRENT_VERSION,
            records: data.records
          }, logger);
        }
      }
      catch (error) {
        // This file is a cache of work that can be redone, so a corrupt one is
        // not worth refusing to start over - unlike the accounts file.
        commonLog(logger, 'warn', 'TranscriptionIndex',
          `Could not read "${filePath}", starting a new one:`, error);
      }
    }
    return new TranscriptionIndex(filePath, { version: CURRENT_VERSION, records: {} }, logger);
  }

  get(mediaId: string): TranscriptionRecord | null {
    return this.#data.records[mediaId] || null;
  }

  list(): TranscriptionRecord[] {
    return Object.values(this.#data.records);
  }

  /** Records that a transcription was asked for, before any work starts. */
  markRequested(mediaId: string, videoPath: string) {
    const record: TranscriptionRecord = {
      mediaId,
      videoPath,
      subtitlePath: null,
      language: null,
      state: 'pending',
      error: null,
      requestedAt: new Date().toISOString(),
      completedAt: null,
      cost: null
    };
    this.#data.records[mediaId] = record;
    this.#save();
    return record;
  }

  markDone(mediaId: string, params: { subtitlePath: string; language: string; cost: number | null }) {
    const record = this.#data.records[mediaId];
    if (!record) {
      return null;
    }
    Object.assign(record, {
      state: 'done' as const,
      subtitlePath: params.subtitlePath,
      language: params.language,
      cost: params.cost,
      error: null,
      completedAt: new Date().toISOString()
    });
    this.#save();
    return record;
  }

  markError(mediaId: string, error: string) {
    const record = this.#data.records[mediaId];
    if (!record) {
      return null;
    }
    Object.assign(record, {
      state: 'error' as const,
      error,
      completedAt: new Date().toISOString()
    });
    this.#save();
    return record;
  }

  remove(mediaId: string) {
    if (!this.#data.records[mediaId]) {
      return false;
    }
    delete this.#data.records[mediaId];
    this.#save();
    return true;
  }

  #save() {
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
