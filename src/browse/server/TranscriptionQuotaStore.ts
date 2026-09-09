import fs from 'fs';
import path from 'path';
import { commonLog, type LogLevel } from '../../utils/logging/Logger.js';
import { type Logger } from '../../utils/logging/index.js';
import { currentPeriod, nextResetAt } from './QuotaStore.js';
import {
  DAILY_TRANSCRIPTION_SECONDS,
  DAILY_TRANSCRIPTION_VIDEOS,
  type TranscriptionLimitInfo,
  type TranscriptionUsage
} from '../types/TranscriptionQuota.js';

/** One video an account had transcribed today, and how long it was. */
interface TranscribedVideo {
  mediaId: string;
  /**
   * The video's own length in seconds - what ffprobe says the file is, not
   * what the detector finds speech in. A sparse three-hour recording costs
   * three hours of somebody's day here, because that is what it is.
   *
   * `0` when the length could not be probed. The count of videos is what
   * holds the line in that case; refusing a video because its length is
   * unknown would make an unreadable file into a lockout.
   */
  seconds: number;
}

interface UserUsage {
  /** The period this list belongs to; anything older is a fresh start. */
  period: string;
  videos: TranscribedVideo[];
}

interface TranscriptionQuotaFile {
  /** Keyed by account id, the same id the session cookie names. */
  users: Record<string, UserUsage | undefined>;
}

/**
 * The verdict on one request. `allowed` carries nothing else; a refusal
 * carries the numbers, because the browser has to be able to say what was
 * reached and when it comes back.
 */
export type TranscriptionQuotaVerdict =
  | { allowed: true }
  | { allowed: false; info: TranscriptionLimitInfo };

/**
 * What ordinary accounts have had transcribed today, kept in a file of its own
 * beside the view counters.
 *
 * Separate from `QuotaStore` rather than a third kind in it: those two limits
 * are per-account settings an administrator types in, and this is a fixed
 * ceiling on a metered API that nobody tunes. They also count differently -
 * this one has to add up how long the videos were, not just how many.
 *
 * Same trade as `QuotaStore` for a file that cannot be read: today's tallies
 * start over rather than the server refusing to work. It is a day's ceiling on
 * an account that already has the permission, not the permission itself.
 *
 * Administrators never reach here at all - see the guard in `Router`.
 */
export default class TranscriptionQuotaStore {
  name = 'TranscriptionQuotaStore';

  #filePath: string;
  #data: TranscriptionQuotaFile;
  #logger?: Logger | null;

  private constructor(
    filePath: string,
    data: TranscriptionQuotaFile,
    logger?: Logger | null
  ) {
    this.#filePath = filePath;
    this.#data = data;
    this.#logger = logger;
  }

  static load(filePath: string, logger?: Logger | null) {
    if (fs.existsSync(filePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as TranscriptionQuotaFile;
        if (data.users && typeof data.users === 'object') {
          return new TranscriptionQuotaStore(filePath, data, logger);
        }
        throw Error('missing "users"');
      }
      catch (error) {
        commonLog(logger, 'warn', 'TranscriptionQuotaStore',
          `Ignoring "${filePath}" - it could not be read (${error instanceof Error ? error.message : String(error)}). ` +
          `Today's transcription counters start over.`
        );
      }
    }
    return new TranscriptionQuotaStore(filePath, { users: {} }, logger);
  }

  /** How much of today this account has spent. */
  used(userId: string): TranscriptionUsage {
    const usage = this.#currentUsage(userId);
    return {
      videos: usage?.videos.length || 0,
      seconds: usage ? usage.videos.reduce((total, v) => total + v.seconds, 0) : 0
    };
  }

  /**
   * Whether this account asked for this video today.
   *
   * What lets somebody cancel their own job without being handed everyone
   * else's: the queue keeps no requester, and this list is the only record of
   * who set a job going. A job still running from before this morning falls
   * outside it, which costs nothing - transcriptions are minutes long, and an
   * administrator can stop any of them from the history page.
   */
  startedToday(userId: string, mediaId: string): boolean {
    return !!this.#currentUsage(userId)?.videos.some((v) => v.mediaId === mediaId);
  }

  /**
   * Counts one video against the account and says whether it may be
   * transcribed.
   *
   * A video already counted today is free, the same way going back to a post
   * already opened is: re-transcribing after a failure, or after changing the
   * settings, is one video's worth of work as far as this is concerned.
   *
   * A video long enough to take the day past the hours ceiling is refused
   * rather than let through and paid for afterwards - which does mean a video
   * longer than the whole day's allowance cannot be started by an ordinary
   * account at all. That is the ceiling working, not a hole in it: the
   * refusal says how long the video was, and an administrator can transcribe
   * it themselves.
   */
  consume(userId: string, mediaId: string, seconds: number | null): TranscriptionQuotaVerdict {
    const usage = this.#userUsage(userId);
    if (usage.videos.some((v) => v.mediaId === mediaId)) {
      return { allowed: true };
    }
    const used = this.used(userId);
    const length = seconds !== null && Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    if (used.videos >= DAILY_TRANSCRIPTION_VIDEOS) {
      return { allowed: false, info: this.#info('videos', used) };
    }
    // Both halves matter: the second is what refuses a video too long to fit
    // in what is left, and the first is what closes the day once the hours are
    // spent, including for a video whose length could not be probed.
    if (
      used.seconds >= DAILY_TRANSCRIPTION_SECONDS ||
      used.seconds + length > DAILY_TRANSCRIPTION_SECONDS
    ) {
      return { allowed: false, info: this.#info('duration', used) };
    }
    usage.videos.push({ mediaId, seconds: length });
    this.#save();
    return { allowed: true };
  }

  /**
   * Drops everything kept for an account, the way the view counters are
   * dropped - nothing can spend these any more.
   */
  forgetUser(userId: string) {
    if (!this.#data.users[userId]) {
      return;
    }
    delete this.#data.users[userId];
    this.#save();
  }

  log(level: LogLevel, ...msg: any[]) {
    commonLog(this.#logger, level, this.name, ...msg);
  }

  #info(
    kind: TranscriptionLimitInfo['kind'],
    used: TranscriptionUsage
  ): TranscriptionLimitInfo {
    return {
      kind,
      videos: DAILY_TRANSCRIPTION_VIDEOS,
      videosUsed: used.videos,
      seconds: DAILY_TRANSCRIPTION_SECONDS,
      secondsUsed: Math.round(used.seconds),
      resetsAt: nextResetAt().toISOString()
    };
  }

  /** What is on file for this account, or `null` if it is from an earlier day. */
  #currentUsage(userId: string): UserUsage | null {
    const usage = this.#data.users[userId];
    return usage && usage.period === currentPeriod() ? usage : null;
  }

  /**
   * The account's entry for today, replacing a stale one in place - the reset
   * happens the first time an account is looked at after 08:00, exactly as it
   * does for the view counters, so nothing has to be running at that hour.
   */
  #userUsage(userId: string): UserUsage {
    let usage = this.#currentUsage(userId);
    if (!usage) {
      usage = { period: currentPeriod(), videos: [] };
      this.#data.users[userId] = usage;
    }
    return usage;
  }

  #save() {
    try {
      const dir = path.dirname(this.#filePath);
      fs.mkdirSync(dir, { recursive: true });
      // Same directory as the target, so the rename stays within one
      // filesystem and is therefore atomic.
      const tmpFilePath = `${this.#filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpFilePath, JSON.stringify(this.#data, null, 2), { mode: 0o600 });
      fs.renameSync(tmpFilePath, this.#filePath);
    }
    catch (error) {
      // Worth saying once, but not worth failing the request: the caller was
      // starting a transcription, not saving a file.
      this.log('error', `Failed to write "${this.#filePath}":`, error);
    }
  }
}
