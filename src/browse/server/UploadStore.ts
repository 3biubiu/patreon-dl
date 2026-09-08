import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { commonLog, type LogLevel } from '../../utils/logging/Logger.js';
import { type Logger } from '../../utils/logging/index.js';
import { type UploadJob } from '../types/Upload.js';

interface StoreFile {
  version: number;
  jobs: UploadJob[];
}

const CURRENT_VERSION = 1;

/** The prefix that keeps an upload's id from ever naming a real media file. */
export const UPLOAD_MEDIA_PREFIX = 'upload:';

/**
 * Uploaded audio and the subtitles made from it, and who each belongs to.
 *
 * Ownership is the whole reason this file exists. Everything else about a job
 * - its stage, its progress, what it cost, whether it was translated - already
 * lives in `TranscriptionIndex`, which knows nothing about accounts because
 * nothing else ever needed it to. Rather than teach it, this keeps the one
 * fact it is missing beside the id, and the two are read together.
 *
 * Each job owns a directory of its own under the data directory, holding the
 * audio and whatever subtitles come out of it. One job, one directory: the
 * subtitle library looks beside a file for its captions, and a shared folder
 * would offer every uploader everyone else's.
 */
export default class UploadStore {
  name = 'UploadStore';

  #filePath: string;
  #uploadsDir: string;
  #data: StoreFile;
  #logger?: Logger | null;

  private constructor(
    filePath: string, uploadsDir: string, data: StoreFile, logger?: Logger | null
  ) {
    this.#filePath = filePath;
    this.#uploadsDir = uploadsDir;
    this.#data = data;
    this.#logger = logger;
  }

  static load(filePath: string, uploadsDir: string, logger?: Logger | null) {
    let jobs: UploadJob[] = [];
    if (fs.existsSync(filePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as StoreFile;
        if (Array.isArray(parsed?.jobs)) {
          jobs = parsed.jobs;
        }
      }
      catch (error) {
        // Losing this loses who owns which upload, which is a permission - so
        // unlike the transcription index it is worth saying loudly. It is
        // still not worth refusing to start: the files are all still there.
        commonLog(logger, 'error', 'UploadStore',
          `Could not read "${filePath}", starting a new one:`, error);
      }
    }
    return new UploadStore(filePath, uploadsDir, { version: CURRENT_VERSION, jobs }, logger);
  }

  /** Everything, newest first. An administrator's view. */
  list(): UploadJob[] {
    return [ ...this.#data.jobs ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** What one account uploaded, newest first. */
  listFor(userId: string): UploadJob[] {
    return this.list().filter((job) => job.userId === userId);
  }

  get(id: string): UploadJob | null {
    return this.#data.jobs.find((job) => job.id === id) || null;
  }

  /** By the id the transcription pipeline knows it as, which is how a record maps back. */
  getByMediaId(mediaId: string): UploadJob | null {
    return this.#data.jobs.find((job) => job.mediaId === mediaId) || null;
  }

  /** How many of this account's uploads have not finished yet. */
  countFor(userId: string): number {
    return this.#data.jobs.filter((job) => job.userId === userId).length;
  }

  /**
   * The directory one job's audio and subtitles live in.
   *
   * Named after the job id, which this file generated - never after anything
   * that came in over the wire.
   */
  directoryFor(id: string) {
    return path.resolve(this.#uploadsDir, id);
  }

  /**
   * Reserves an id and a directory for an upload that is about to arrive.
   *
   * Split from `add` because the audio is streamed to disk before there is
   * anything worth recording: a transfer that breaks half way should leave a
   * file to delete, not a job that claims to exist.
   */
  reserve() {
    const id = crypto.randomUUID();
    const directory = this.directoryFor(id);
    fs.mkdirSync(directory, { recursive: true });
    return { id, mediaId: `${UPLOAD_MEDIA_PREFIX}${id}`, directory };
  }

  /** Records a job whose audio is now on disk. */
  add(job: UploadJob) {
    this.#data.jobs.push(job);
    this.#save();
    return job;
  }

  /**
   * Forgets a job and deletes everything it owns - the audio and the
   * subtitles both. The transcription record is the caller's to clear: it
   * belongs to the index, and cancelling a running job is its business.
   */
  remove(id: string) {
    const index = this.#data.jobs.findIndex((job) => job.id === id);
    if (index === -1) {
      return false;
    }
    this.#data.jobs.splice(index, 1);
    this.#save();
    try {
      fs.rmSync(this.directoryFor(id), { recursive: true, force: true });
    }
    catch (error) {
      // The record is already gone, so the job is gone as far as anyone can
      // see. A directory left behind is disk to reclaim, not a failure to
      // report to whoever pressed delete.
      this.log('warn', `Could not delete the files of upload "${id}":`, error);
    }
    return true;
  }

  log(level: LogLevel, ...msg: any[]) {
    commonLog(this.#logger, level, this.name, ...msg);
  }

  #save() {
    fs.mkdirSync(path.dirname(this.#filePath), { recursive: true });
    const tmpFilePath = `${this.#filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpFilePath, JSON.stringify(this.#data, null, 2));
    fs.renameSync(tmpFilePath, this.#filePath);
  }
}
