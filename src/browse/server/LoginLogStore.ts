import fs from 'fs';
import path from 'path';
import { commonLog, type LogLevel } from '../../utils/logging/Logger.js';
import { type Logger } from '../../utils/logging/index.js';
import { type LoginLogEntry } from '../types/Auth.js';
import {
  localPlace,
  lookupIPLocations,
  LOGIN_LOOKUP_ATTEMPTS,
  type IPLocation
} from './IPLocation.js';
import { loginRegionPath, type LoginRegionParts } from '../types/LoginRegion.js';

/**
 * How many sign-ins are kept. Enough to still be useful a few days after
 * something odd happened, and small enough that the file can go on being
 * rewritten whole like the others beside it. The anomaly rule reads its
 * three-day window out of this same list, which is the other reason it is
 * not smaller.
 */
export const MAX_LOGIN_LOG_ENTRIES = 500;

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
    // Here, and nowhere else, because this is the only thing that drops an
    // entry and so the only thing that can leave a place belonging to nobody.
    //
    // It used to run at the end of every lookup instead, which was wrong in a
    // way that quietly disabled the region restriction: the sign-in path looks
    // an address up *before* recording the sign-in, so the address was not yet
    // in `entries` and the place that had just been fetched for it was deleted
    // again before the caller could read it. The caller saw "cannot be placed"
    // and let the sign-in through. Every address the log had not seen before
    // got in that way, once - which for somebody rotating hosting addresses is
    // every time.
    this.#pruneLocations();
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
      const known = local ? null : this.#data.locations[entry.ip];
      return {
        ...entry,
        location: local || known?.place || null,
        // A local address has no region path: "局域网" is not somewhere an
        // account can be pinned to, and offering it as a rule would be
        // offering one that never matches.
        regionPath: known?.parts ? loginRegionPath(known.parts) : null,
        isp: known?.isp || null
      };
    });
  }

  /**
   * The regions (country and province) this account successfully signed in
   * from since the given time, oldest first, one entry per sign-in.
   *
   * Sign-ins whose address cannot be placed - local addresses, lookup
   * failures - are simply left out rather than breaking the sequence: the
   * caller is counting region *changes*, and an unplaceable stop between two
   * placeable ones says nothing either way.
   */
  async successfulRegionTrail(userId: string, since: number): Promise<string[]> {
    const entries = this.#data.entries
      .filter((entry) =>
        entry.success && entry.userId === userId && Date.parse(entry.at) >= since
      )
      // Stored newest first; the trail reads oldest first.
      .reverse();
    await this.#resolveLocations(entries.map((entry) => entry.ip));
    const trail: string[] = [];
    for (const entry of entries) {
      if (localPlace(entry.ip)) {
        continue;
      }
      const region = this.#data.locations[entry.ip]?.region;
      if (region) {
        trail.push(region);
      }
    }
    return trail;
  }

  /**
   * Where one address is, in the parts the region restriction matches against,
   * or `null` when it cannot be placed.
   *
   * The one method here that a sign-in waits on, and the reason it lives on
   * the log store rather than beside the rule: the places this has already
   * looked up are cached in this file, so an account signing in from an
   * address the log has seen before is answered without touching the network
   * at all. Only a genuinely new address costs a lookup.
   *
   * `null` is "nowhere known" - a local address, or an answer with no country
   * in it. A service that could not be reached at all is a *throw* rather than
   * a `null`, which is the one distinction the caller needs: it refuses either
   * way now, but the two say very different things in the log, and an operator
   * chasing a lockout should not have to guess which one they are looking at.
   */
  async locationParts(ip: string, timeoutMs?: number): Promise<LoginRegionParts | null> {
    if (!ip || localPlace(ip)) {
      return null;
    }
    await this.#resolveLocations([ ip ], timeoutMs, true);
    const parts = this.#data.locations[ip]?.parts;
    // An answer with no country in it places nothing, and returning it would
    // be far worse than returning nothing: every rule would fail to match it
    // and the caller would read that as "somewhere else" rather than as
    // "nowhere known", turning a useless answer into a refusal.
    return parts?.country ? parts : null;
  }

  log(level: LogLevel, ...msg: any[]) {
    commonLog(this.#logger, level, this.name, ...msg);
  }

  /**
   * Fills in the places for these addresses, from the cache where there is one
   * and from the service where there is not.
   *
   * `strict` is what a permission check asks for and what a log does not. The
   * log wants whatever it can get and shows blanks for the rest, so a failure
   * here is a warning and nothing more. A permission check cannot work with a
   * blank, so for it the service is tried twice and a failure is thrown on to
   * the caller, which refuses - see `LoginRegionGuard`.
   */
  async #resolveLocations(ips: string[], timeoutMs?: number, strict = false) {
    const unknown = [ ...new Set(
      ips.filter((ip) => {
        if (!ip || localPlace(ip)) {
          return false;
        }
        const known = this.#data.locations[ip];
        // Entries cached before regions were stored are asked about again,
        // once, so they can carry one - the anomaly rule needs it. Same for
        // the unjoined parts, which the region restriction needs.
        return !known || known.region === undefined || known.parts === undefined;
      })
    ) ];
    if (unknown.length === 0) {
      return;
    }
    // One attempt for the log. Two for a permission check, because the second
    // one is free of charge to everybody except the person waiting at the
    // login form, and it is the difference between a blip at the service and
    // somebody being turned away.
    const attempts = strict ? LOGIN_LOOKUP_ATTEMPTS : 1;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const found = await lookupIPLocations(unknown, timeoutMs);
        // The service answered and placed none of them. That is an answer, not
        // a failure, and asking again would get the same one.
        if (found.size === 0) {
          return;
        }
        for (const [ ip, location ] of found) {
          this.#data.locations[ip] = location;
        }
        this.#save();
        return;
      }
      catch (error) {
        lastError = error;
        this.log('warn',
          `Could not look up sign-in locations (attempt ${attempt} of ${attempts}):`, error
        );
      }
    }
    if (strict) {
      throw lastError instanceof Error ? lastError : Error(String(lastError));
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
