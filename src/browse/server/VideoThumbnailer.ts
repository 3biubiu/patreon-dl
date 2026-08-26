import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { commonLog, type LogLevel } from '../../utils/logging/Logger.js';
import type Logger from '../../utils/logging/Logger.js';

const CACHE_DIR_NAME = path.join('.patreon-dl', 'video-thumbnails');
/** Frame to grab. A little way in, to skip fades and black leader frames. */
const SEEK_POSITIONS = [ '10%', '0' ];
const OUTPUT_WIDTH = 640;
/** ffmpeg is heavy; a gallery page can ask for many posters at once. */
const MAX_CONCURRENT = 2;

/**
 * Generates poster frames for videos that have no downloaded thumbnail of
 * their own, and caches them under the data directory.
 *
 * Patreon only supplies an embed thumbnail when the post has a cover image, so
 * plenty of videos end up with nothing to show. This fills that gap locally,
 * without touching the downloader or re-downloading anything.
 */
export default class VideoThumbnailer {
  name = 'VideoThumbnailer';

  #dataDir: string;
  #cacheDir: string;
  #logger?: Logger | null;
  /** `false` once ffmpeg has been found to be unusable, so we stop retrying. */
  #available: boolean;
  #warnedUnavailable: boolean;
  /** In-flight generations, keyed by cache file, so concurrent requests share one run. */
  #pending: Map<string, Promise<string | null>>;
  /** Files ffmpeg could not produce a frame from; not retried for this session. */
  #failed: Set<string>;
  #running: number;
  #queue: (() => void)[];

  constructor(dataDir: string, pathToFFmpeg?: string | null, logger?: Logger | null) {
    this.#dataDir = dataDir;
    this.#cacheDir = path.resolve(dataDir, CACHE_DIR_NAME);
    this.#logger = logger;
    this.#available = true;
    this.#warnedUnavailable = false;
    this.#pending = new Map();
    this.#failed = new Set();
    this.#running = 0;
    this.#queue = [];

    if (pathToFFmpeg) {
      ffmpeg.setFfmpegPath(pathToFFmpeg);
      // ffprobe (needed to resolve percentage seek positions) normally sits
      // next to the ffmpeg binary.
      const probe = path.resolve(
        path.dirname(pathToFFmpeg),
        process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
      );
      if (fs.existsSync(probe)) {
        ffmpeg.setFfprobePath(probe);
      }
    }
  }

  /**
   * Returns the path of a cached poster frame for `videoPath`, generating it
   * if necessary. Returns `null` when no frame could be produced - the caller
   * should then behave as if no thumbnail exists.
   */
  async getThumbnail(videoPath: string): Promise<string | null> {
    if (!this.#available) {
      return null;
    }
    let stats: fs.Stats;
    try {
      stats = fs.statSync(videoPath);
    }
    catch {
      return null;
    }
    // Keying on size + mtime means a re-downloaded video gets a fresh frame
    // instead of silently keeping the old one.
    const key = crypto
      .createHash('sha1')
      .update(`${path.relative(this.#dataDir, videoPath)}:${stats.size}:${stats.mtimeMs}`)
      .digest('hex');
    const cacheFile = path.resolve(this.#cacheDir, `${key}.jpg`);

    if (this.#isUsable(cacheFile)) {
      return cacheFile;
    }
    if (this.#failed.has(key)) {
      return null;
    }
    const inFlight = this.#pending.get(cacheFile);
    if (inFlight) {
      return inFlight;
    }

    const job = this.#generate(videoPath, cacheFile, key)
      .finally(() => this.#pending.delete(cacheFile));
    this.#pending.set(cacheFile, job);
    return job;
  }

  async #generate(videoPath: string, cacheFile: string, key: string): Promise<string | null> {
    await this.#acquireSlot();
    try {
      try {
        fs.mkdirSync(this.#cacheDir, { recursive: true });
      }
      catch (error) {
        this.log('warn', `Could not create video thumbnail cache dir "${this.#cacheDir}":`, error);
        return null;
      }
      for (const seek of SEEK_POSITIONS) {
        try {
          await this.#extractFrame(videoPath, cacheFile, seek);
          if (this.#isUsable(cacheFile)) {
            this.log('debug', `Generated poster frame for "${videoPath}" at ${seek}`);
            return cacheFile;
          }
        }
        catch (error) {
          if (this.#isFFmpegMissing(error)) {
            this.#available = false;
            if (!this.#warnedUnavailable) {
              this.#warnedUnavailable = true;
              this.log('warn',
                'FFmpeg is not available, so poster frames cannot be generated for videos ' +
                'that have no thumbnail. Install FFmpeg or pass its path with "--ffmpeg".'
              );
            }
            return null;
          }
          this.log('debug', `Could not extract frame from "${videoPath}" at ${seek}:`, error);
        }
      }
      this.log('debug', `Giving up on poster frame for "${videoPath}"`);
      this.#failed.add(key);
      return null;
    }
    finally {
      this.#releaseSlot();
    }
  }

  /** ffmpeg can leave a zero-byte file behind when it fails to decode a frame. */
  #isUsable(file: string) {
    try {
      return fs.statSync(file).size > 0;
    }
    catch {
      return false;
    }
  }

  #extractFrame(videoPath: string, cacheFile: string, seek: string) {
    return new Promise<void>((resolve, reject) => {
      ffmpeg(videoPath)
        .on('end', () => resolve())
        .on('error', (error: unknown) => reject(error instanceof Error ? error : Error(String(error))))
        .screenshots({
          timestamps: [seek],
          filename: path.basename(cacheFile),
          folder: path.dirname(cacheFile),
          size: `${OUTPUT_WIDTH}x?`
        });
    });
  }

  #isFFmpegMissing(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('ENOENT') ||
      message.includes('Cannot find ffmpeg') ||
      message.includes('Cannot find ffprobe');
  }

  #acquireSlot() {
    if (this.#running < MAX_CONCURRENT) {
      this.#running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#queue.push(() => {
        this.#running++;
        resolve();
      });
    });
  }

  #releaseSlot() {
    this.#running--;
    const next = this.#queue.shift();
    if (next) {
      next();
    }
  }

  protected log(level: LogLevel, ...msg: any[]) {
    commonLog(this.#logger, level, this.name, ...msg);
  }
}
