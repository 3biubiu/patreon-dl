import fs from 'fs';
import path from 'path';
import { commonLog, type LogLevel } from '../../utils/logging/Logger.js';
import { type Logger } from '../../utils/logging/index.js';
import { type QuotaKind } from '../types/Quota.js';

/**
 * The day these counters belong to runs from 08:00 Beijing time to 08:00 the
 * next morning, rather than from midnight - someone still reading at one in
 * the morning is finishing their day, not starting a new one.
 *
 * Fixed to Beijing rather than taken from the host clock on purpose: the
 * server may well sit in another timezone, and the people it is limiting are
 * the ones the reset has to make sense to.
 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const RESET_HOUR = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

/** How many whole reset-periods have elapsed, which is what names one. */
function periodIndex(now: number) {
  return Math.floor((now + BEIJING_OFFSET_MS - RESET_HOUR * 60 * 60 * 1000) / DAY_MS);
}

/**
 * The current period as a plain Beijing date - readable in the file, and
 * enough to tell "today" from anything written earlier.
 */
export function currentPeriod(now = Date.now()): string {
  return new Date(periodIndex(now) * DAY_MS).toISOString().slice(0, 10);
}

/** When the counters next go back to zero. */
export function nextResetAt(now = Date.now()): Date {
  return new Date(
    (periodIndex(now) + 1) * DAY_MS + RESET_HOUR * 60 * 60 * 1000 - BEIJING_OFFSET_MS
  );
}

/**
 * What one account has already spent today. The ids are kept rather than a
 * bare count so that going back to a post or a video already opened is free -
 * a limit on how much is read, not on how often the page is loaded.
 */
interface UserUsage {
  /** The period these lists belong to; anything older is a fresh start. */
  period: string;
  posts: string[];
  videos: string[];
}

interface QuotaFile {
  /** Keyed by account id, the same id the session cookie names. */
  users: Record<string, UserUsage | undefined>;
}

/**
 * Daily view counters, kept in a file of their own beside the accounts.
 *
 * Same reasoning as `HistoryStore`: written far more often than the accounts
 * are, and worth nothing once the day turns over - so a file that cannot be
 * read is started over rather than thrown, because refusing to serve the
 * library over a lost counter would be the wrong trade.
 *
 * Each list is bounded by the limit that guards it, so nothing here grows
 * without end.
 */
export default class QuotaStore {
  name = 'QuotaStore';

  #filePath: string;
  #data: QuotaFile;
  #logger?: Logger | null;

  private constructor(filePath: string, data: QuotaFile, logger?: Logger | null) {
    this.#filePath = filePath;
    this.#data = data;
    this.#logger = logger;
  }

  static load(filePath: string, logger?: Logger | null) {
    if (fs.existsSync(filePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as QuotaFile;
        if (data.users && typeof data.users === 'object') {
          return new QuotaStore(filePath, data, logger);
        }
        throw Error('missing "users"');
      }
      catch (error) {
        commonLog(logger, 'warn', 'QuotaStore',
          `Ignoring "${filePath}" - it could not be read (${error instanceof Error ? error.message : String(error)}). ` +
          `Today's view counters start over.`
        );
      }
    }
    return new QuotaStore(filePath, { users: {} }, logger);
  }

  /** How much this account has spent in the current period. */
  used(userId: string, kind: QuotaKind): number {
    return this.#currentUsage(userId)?.[kind].length || 0;
  }

  /**
   * Counts one post or video against the account, and says whether it may be
   * served.
   *
   * `limit` is `null` for an unlimited account, in which case nothing is
   * recorded at all - there is no point keeping a tally nothing reads, and it
   * keeps the file to the accounts that are actually limited.
   *
   * Something already counted today is always allowed through, even if the
   * limit has since been lowered past it: what was opened is already open.
   */
  consume(userId: string, kind: QuotaKind, id: string, limit: number | null): boolean {
    if (limit === null) {
      return true;
    }
    const usage = this.#userUsage(userId);
    if (usage[kind].includes(id)) {
      return true;
    }
    if (usage[kind].length >= limit) {
      return false;
    }
    usage[kind].push(id);
    this.#save();
    return true;
  }

  /**
   * Drops everything kept for an account. Called when one is deleted, so that
   * counters do not pile up under ids nothing can sign in as any more.
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

  /** What is on file for this account, or `null` if it is from an earlier day. */
  #currentUsage(userId: string): UserUsage | null {
    const usage = this.#data.users[userId];
    return usage && usage.period === currentPeriod() ? usage : null;
  }

  /**
   * The account's entry for today, replacing a stale one in place - the reset
   * happens the first time an account is looked at after 08:00 rather than on
   * a timer, so nothing has to be running at that hour for it to take effect.
   */
  #userUsage(userId: string): UserUsage {
    let usage = this.#currentUsage(userId);
    if (!usage) {
      usage = { period: currentPeriod(), posts: [], videos: [] };
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
      // Worth saying once, but not worth failing the request that triggered
      // it: the caller was opening a post, not saving a file.
      this.log('error', `Failed to write "${this.#filePath}":`, error);
    }
  }
}
