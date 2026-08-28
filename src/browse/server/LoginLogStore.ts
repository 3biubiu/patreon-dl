import fs from 'fs';
import path from 'path';
import { commonLog, type LogLevel } from '../../utils/logging/Logger.js';
import { type Logger } from '../../utils/logging/index.js';
import { type LoginLogEntry } from '../types/Auth.js';
import { localPlace, lookupIPLocations, type IPLocation } from './IPLocation.js';

/**
 * How many sign-ins are kept. Enough to still be useful a few days after
 * something odd happened, and small enough that the file can go on being
 * rewritten whole like the others beside it.
 */
export const MAX_LOGIN_LOG_ENTRIES = 200;

/**
 * A sign-in as stored - what happened and from where, with no place attached.
 * The place is a lookup, and one that would be wrong to freeze at the moment
 * of the sign-in when it can just as well be worked out on the way out.
 */
interface StoredEntry {
  at: string;
  /**
   * Recorded for failures too, which is the whole point of keeping those: an
   * account being guessed at is only visible by name.
   */
  username: string;
  /** `null` for a failed attempt - there is no account to point at. */
  userId: string | null;
  ip: string;
  userAgent: string | null;
  success: boolean;
}

interface LoginLogFile {
  /** Newest first, so reading the last few is the front of the list. */
  entries: StoredEntry[];
  /**
   * Places already looked up, by address. Kept in the file rather than in
   * memory so that a restart does not mean asking the service about the same
   * handful of addresses all over again.
   */
  locations: Record<string, IPLocation | undefined>;
}

/**
 * Who signed in, when, and from where.
 *
 * A file of its own beside the accounts, for the same reason the history and
 * the quota counters have theirs: written on every sign-in, and worth nothing
 * to the running of the server - so an unreadable one is started over rather
 * than thrown, because refusing to let anybody in over a lost audit log would
 * be exactly the wrong trade.
 *
 * Deliberately *not* cleared when an account is deleted, unlike the history
 * and the counters. Those are conveniences belonging to an account that no
 * longer exists; this is a record of what happened, and a log that erases
 * itself the moment somebody removes the account is useless precisely when it
 * is wanted.
 */
export default class LoginLogStore {
  name = 'LoginLogStore';

  #filePath: string;
  #data: LoginLogFile;
  #logger?: Logger | null;

  private constructor(filePath: string, data: LoginLogFile, logger?: Logger | null) {
    this.#filePath = filePath;
    this.#data = data;
    this.#logger = logger;
  }

  static load(filePath: string, logger?: Logger | null) {
    if (fs.existsSync(filePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as LoginLogFile;
        if (Array.isArray(data.entries)) {
          return new LoginLogStore(filePath, {
            entries: data.entries.slice(0, MAX_LOGIN_LOG_ENTRIES),
            locations: data.locations && typeof data.locations === 'object' ? data.locations : {}
          }, logger);
        }
        throw Error('missing "entries"');
      }
      catch (error) {
        commonLog(logger, 'warn', 'LoginLogStore',
          `Ignoring "${filePath}" - it could not be read (${error instanceof Error ? error.message : String(error)}). ` +
          `The sign-in log starts over.`
        );
      }
    }
    return new LoginLogStore(filePath, { entries: [], locations: {} }, logger);
  }

  /**
   * Records one attempt, successful or not.
   *
   * Nothing here talks to the network or waits on anything: this sits on the
   * sign-in path, and the person at the login form should not be able to tell
   * that it runs at all.
   */
  record(entry: StoredEntry) {
    this.#data.entries.unshift(entry);
    if (this.#data.entries.length > MAX_LOGIN_LOG_ENTRIES) {
      this.#data.entries.length = MAX_LOGIN_LOG_ENTRIES;
    }
    this.#save();
  }

  /**
   * The most recent attempts, newest first, with the places filled in.
   *
   * Given an account, only that account's attempts come back - matched by id
   * for the successful ones and by name for the failures, which carry no id.
   * Somebody looking at one user wants the attempts that were made in their
   * name whether or not any of them worked; that is most of the point.
   *
   * Addresses not seen before are looked up here, once, and remembered. If the
   * lookup cannot be done the entries still come back - an address with no
   * place beside it is worth far more than an error where the log should be.
   */
  async listRecent(
    limit: number,
    account?: { id: string; username: string; } | null
  ): Promise<LoginLogEntry[]> {
    const matching = account ?
      this.#data.entries.filter((entry) => (
        entry.userId === account.id ||
        (entry.userId === null && entry.username === account.username)
      )) :
      this.#data.entries;
    const entries = matching.slice(0, Math.max(0, limit));
    await this.#resolveLocations(entries.map((entry) => entry.ip));
    return entries.map((entry) => {
      const local = localPlace(entry.ip);
      const known = local ? { place: local, isp: null } : this.#data.locations[entry.ip];
      return {
        ...entry,
        location: known?.place || null,
        isp: known?.isp || null
      };
    });
  }

  log(level: LogLevel, ...msg: any[]) {
    commonLog(this.#logger, level, this.name, ...msg);
  }

  async #resolveLocations(ips: string[]) {
    const unknown = [ ...new Set(
      ips.filter((ip) => ip && !localPlace(ip) && !this.#data.locations[ip])
    ) ];
    if (unknown.length === 0) {
      return;
    }
    try {
      const found = await lookupIPLocations(unknown);
      if (found.size === 0) {
        return;
      }
      for (const [ ip, location ] of found) {
        this.#data.locations[ip] = location;
      }
      this.#pruneLocations();
      this.#save();
    }
    catch (error) {
      // Worth saying once, and no more than that: the caller asked for a log,
      // and it has one - just without the places this time.
      this.log('warn', 'Could not look up sign-in locations:', error);
    }
  }

  /**
   * Drops places for addresses no entry names any more, so that the cache
   * stays bounded by the log it serves rather than growing for the life of the
   * server.
   */
  #pruneLocations() {
    const inUse = new Set(this.#data.entries.map((entry) => entry.ip));
    for (const ip of Object.keys(this.#data.locations)) {
      if (!inUse.has(ip)) {
        delete this.#data.locations[ip];
      }
    }
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
      // Never worth failing the request that triggered it - that request was
      // somebody signing in.
      this.log('error', `Failed to write "${this.#filePath}":`, error);
    }
  }
}
