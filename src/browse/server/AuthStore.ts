import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { commonLog, type LogLevel } from '../../utils/logging/Logger.js';
import { type Logger } from '../../utils/logging/index.js';
import { type AuthUser, type Registration, type UserRole } from '../types/Auth.js';
import {
  DEFAULT_USER_QUOTA,
  UNLIMITED_QUOTA,
  type QuotaKind,
  type UserQuota
} from '../types/Quota.js';
import { normalizeLoginRegions } from '../types/LoginRegion.js';

/**
 * A user as stored on disk. The hash and its salt never leave this module -
 * everything else is handed out as a plain `AuthUser`.
 */
interface StoredUser extends AuthUser {
  salt: string;
  passwordHash: string;
  /**
   * The token the account's one live session carries. Replaced wholesale at
   * every sign-in, which is what signs every other device out. Absent until
   * the first sign-in after sessions became single-device.
   */
  sessionToken?: string;
  /**
   * When a ban was last lifted, as epoch milliseconds.
   *
   * The anomaly rule reads the sign-in log, and lifting a ban does not erase
   * the sign-ins that caused it - they stay for as long as the rule's window.
   * Without this, the next sign-in re-reads that same trail and bans the
   * account again, and the ban can never actually be lifted. Sign-ins before
   * this moment are forgiven; the rule starts counting afresh.
   */
  banClearedAt?: number;
}

/**
 * An application as stored. The password is hashed the moment it arrives and
 * kept exactly as a user's is, so approving one is a move between two lists
 * rather than anything that has to handle a password again.
 */
interface StoredRegistration extends Registration {
  salt: string;
  passwordHash: string;
}

interface AuthFile {
  /**
   * Signs session cookies. Kept with the users rather than regenerated per
   * process, because a fresh secret on every restart would sign everyone out.
   */
  secret: string;
  users: StoredUser[];
  /**
   * Applications waiting on an administrator, in a list of their own.
   *
   * This is the whole of how a pending applicant is kept out: nothing that
   * signs anybody in ever looks here. There is no flag to forget to check and
   * no state an account could be left in - until one of these is approved, the
   * account it asks for does not exist.
   *
   * Absent in files written before applications existed.
   */
  registrations?: StoredRegistration[];
}

const SCRYPT_KEY_LENGTH = 64;
const SALT_BYTES = 16;
const MIN_PASSWORD_LENGTH = 6;
/** Long enough for any name worth having, short enough not to break a table. */
const MAX_USERNAME_LENGTH = 32;
/**
 * A ceiling on the queue, because the form behind it is reachable by anyone
 * who can reach the login page. Past this the server stops accepting rather
 * than letting a stranger grow the credentials file without bound.
 */
const MAX_PENDING_REGISTRATIONS = 50;

/**
 * The stored form of a campaign restriction.
 *
 * Administrators are never restricted, and an empty selection is kept as an
 * empty array rather than being folded into `null` - the two mean opposite
 * things, and quietly turning "nothing" into "everything" is the wrong way for
 * a permission to fail.
 */
function normalizeVisibleCampaigns(
  visibleCampaigns: string[] | null | undefined,
  role: UserRole
): string[] | null {
  if (role === 'admin' || visibleCampaigns === null || visibleCampaigns === undefined) {
    return null;
  }
  if (!Array.isArray(visibleCampaigns)) {
    throw Error('"visibleCampaigns" must be an array of campaign ids, or null');
  }
  const ids = visibleCampaigns
    .filter((id): id is string => typeof id === 'string')
    .map((id) => id.trim())
    .filter((id) => !!id);
  return [ ...new Set(ids) ];
}

/**
 * One daily limit as it arrived. `null` is no limit, and zero is kept as zero -
 * an account that may open nothing today is a real setting, not a mistake.
 */
function normalizeQuotaValue(value: unknown, kind: QuotaKind): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw Error(`The daily limit for ${kind} must be a number of 0 or more, or null for no limit`);
  }
  return Math.floor(value);
}

/**
 * The stored form of a daily allowance.
 *
 * Administrators are never limited, for the same reason they are never
 * restricted to certain creators: they can lift their own allowance, so
 * storing one would only be something to go stale.
 *
 * `fallback` is what an unspecified allowance becomes - the defaults for a new
 * account, and whatever is already on file for an existing one.
 */
function normalizeQuota(
  quota: Partial<UserQuota> | null | undefined,
  role: UserRole,
  fallback: UserQuota
): UserQuota {
  if (role === 'admin') {
    return { ...UNLIMITED_QUOTA };
  }
  if (quota === null || quota === undefined) {
    return { posts: fallback.posts, videos: fallback.videos };
  }
  if (typeof quota !== 'object') {
    throw Error('"quota" must be an object with "posts" and "videos"');
  }
  return {
    posts: 'posts' in quota ? normalizeQuotaValue(quota.posts, 'posts') : fallback.posts,
    videos: 'videos' in quota ? normalizeQuotaValue(quota.videos, 'videos') : fallback.videos
  };
}

/**
 * The stored form of a sign-in region restriction.
 *
 * Administrators are never restricted, for the reason they are never limited
 * or narrowed: they can edit their own permissions, so a region list on an
 * administrator is not a restriction, it is a way to lock the one account that
 * could undo it out of the server.
 *
 * Everything else about the shape - `null` for anywhere, an empty array for
 * nowhere, the depth and the ceiling - is decided by `normalizeLoginRegions`
 * beside the rule itself.
 */
function normalizeLoginRegionsFor(
  loginRegions: string[] | null | undefined,
  role: UserRole
): string[] | null {
  if (role === 'admin') {
    return null;
  }
  return normalizeLoginRegions(loginRegions ?? null);
}

function hashPassword(password: string, salt: string) {
  return crypto.scryptSync(password, salt, SCRYPT_KEY_LENGTH).toString('base64');
}

/**
 * Accounts for the browse server, kept in a JSON file of their own.
 *
 * Deliberately not in the content database: that one belongs to the
 * downloader, is guarded by a schema version that refuses anything it does not
 * recognise, and is throw-away - you can delete it and download everything
 * again. Credentials are none of those things.
 *
 * A handful of users needs no indexes and no queries, so the whole file is
 * held in memory and rewritten whole. Writes go through a temporary file and a
 * rename, because a process that dies midway through overwriting this file
 * would otherwise take every account with it.
 */
export default class AuthStore {
  name = 'AuthStore';

  #filePath: string;
  #data: AuthFile;
  #logger?: Logger | null;

  private constructor(filePath: string, data: AuthFile, logger?: Logger | null) {
    this.#filePath = filePath;
    this.#data = data;
    this.#logger = logger;
  }

  static load(filePath: string, logger?: Logger | null) {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw) as AuthFile;
      if (!data.secret || !Array.isArray(data.users)) {
        throw Error(`"${filePath}" is not a valid auth file`);
      }
      // Accounts written before campaign permissions existed have no such
      // field. They kept seeing everything up to this point, so that is what
      // they carry on doing until someone narrows them.
      for (const user of data.users) {
        user.visibleCampaigns = normalizeVisibleCampaigns(user.visibleCampaigns, user.role);
        // Accounts written before daily limits existed have no allowance on
        // file. They have been reading without one up to this point, so that
        // is what they carry on doing until someone sets one - only accounts
        // made from here on start on `DEFAULT_USER_QUOTA`.
        user.quota = normalizeQuota(user.quota, user.role, UNLIMITED_QUOTA);
        // Accounts written before the region restriction existed have no list
        // on file. They have been signing in from anywhere up to this point,
        // and a migration that silently pinned them to a region would lock out
        // whoever happened to be travelling that week.
        user.loginRegions = normalizeLoginRegionsFor(user.loginRegions, user.role);
        // Accounts written before bans existed are not banned; a reason with
        // no ban behind it is stale and dropped.
        user.banned = user.banned === true && user.role !== 'admin';
        user.banReason = user.banned ? (user.banReason ?? null) : null;
      }
      // Absent in files written before applications existed, which is simply
      // an empty queue.
      if (!Array.isArray(data.registrations)) {
        data.registrations = [];
      }
      return new AuthStore(filePath, data, logger);
    }

    // First run. A generated password beats a well-known default, which would
    // be live the moment the server is reachable.
    const password = crypto.randomBytes(9).toString('base64url');
    const salt = crypto.randomBytes(SALT_BYTES).toString('base64');
    const store = new AuthStore(filePath, {
      secret: crypto.randomBytes(32).toString('base64'),
      registrations: [],
      users: [
        {
          id: crypto.randomUUID(),
          username: 'admin',
          role: 'admin',
          createdAt: new Date().toISOString(),
          visibleCampaigns: null,
          quota: { ...UNLIMITED_QUOTA },
          loginRegions: null,
          banned: false,
          banReason: null,
          salt,
          passwordHash: hashPassword(password, salt)
        }
      ]
    }, logger);
    store.#save();
    store.log('info',
      `Created "${filePath}" with an administrator account - ` +
      `username "admin", password "${password}". Change it after signing in.`
    );
    return store;
  }

  get secret() {
    return this.#data.secret;
  }

  listUsers(): AuthUser[] {
    return this.#data.users.map((user) => this.#toAuthUser(user));
  }

  getUser(id: string): AuthUser | null {
    const user = this.#data.users.find((u) => u.id === id);
    return user ? this.#toAuthUser(user) : null;
  }

  /**
   * The token the account's one live session must present. `null` when nobody
   * has signed in since sessions became single-device, which no cookie can
   * match - such an account is simply signed out everywhere.
   */
  getSessionToken(id: string): string | null {
    const user = this.#data.users.find((u) => u.id === id);
    return user?.sessionToken ?? null;
  }

  isBanned(id: string): boolean {
    return this.#data.users.find((u) => u.id === id)?.banned === true;
  }

  /**
   * Locks the account out entirely: the auth guard refuses its sessions and
   * the sign-in refuses its password from here on. Put on by the sign-in
   * anomaly rule; only {@link unbanUser} takes it off.
   *
   * Never an administrator. An administrator locked out by a rule could not
   * unlock anybody, themselves included, and the file would have to be edited
   * by hand - the same reasoning that protects the last administrator from
   * deletion.
   */
  banUser(id: string, reason: string): AuthUser {
    const user = this.#data.users.find((u) => u.id === id);
    if (!user) {
      throw Error('User not found');
    }
    if (user.role === 'admin') {
      throw Error('Administrators cannot be banned');
    }
    user.banned = true;
    user.banReason = reason;
    this.#save();
    return this.#toAuthUser(user);
  }

  unbanUser(id: string): AuthUser {
    const user = this.#data.users.find((u) => u.id === id);
    if (!user) {
      throw Error('User not found');
    }
    user.banned = false;
    user.banReason = null;
    // What the rule may look at from here on. Without it the sign-ins that
    // caused the ban are still in the log, and the account is banned again the
    // moment it signs in.
    user.banClearedAt = Date.now();
    this.#save();
    return this.#toAuthUser(user);
  }

  /**
   * The moment this account's history was forgiven, or `null` if it never was.
   * The anomaly rule counts no sign-in from before it.
   */
  getBanClearedAt(id: string): number | null {
    const at = this.#data.users.find((u) => u.id === id)?.banClearedAt;
    return typeof at === 'number' && Number.isFinite(at) ? at : null;
  }

  /**
   * Replaces the account's session token. Cookies keep the token they were
   * issued with, so the moment this runs, every cookie but the one about to be
   * issued stops being a session - this is the whole of how one sign-in puts
   * every other device out.
   */
  rotateSessionToken(id: string): string {
    const user = this.#data.users.find((u) => u.id === id);
    if (!user) {
      throw Error('User not found');
    }
    user.sessionToken = crypto.randomBytes(16).toString('base64url');
    this.#save();
    return user.sessionToken;
  }

  /**
   * Returns the user when the password matches, `null` otherwise. Callers must
   * not say which half was wrong.
   */
  verifyPassword(username: string, password: string): AuthUser | null {
    const user = this.#data.users.find(
      (u) => u.username.toLowerCase() === username.trim().toLowerCase()
    );
    if (!user) {
      return null;
    }
    const given = Buffer.from(hashPassword(password, user.salt));
    const expected = Buffer.from(user.passwordHash);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      return null;
    }
    return this.#toAuthUser(user);
  }

  createUser(params: {
    username: string;
    password: string;
    role: UserRole;
    visibleCampaigns?: string[] | null;
    quota?: Partial<UserQuota> | null;
    loginRegions?: string[] | null;
  }): AuthUser {
    const username = params.username.trim();
    if (!username) {
      throw Error('Username is required');
    }
    if (this.#data.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
      throw Error(`User "${username}" already exists`);
    }
    this.#assertPassword(params.password);
    const salt = crypto.randomBytes(SALT_BYTES).toString('base64');
    const user: StoredUser = {
      id: crypto.randomUUID(),
      username,
      role: params.role,
      createdAt: new Date().toISOString(),
      visibleCampaigns: normalizeVisibleCampaigns(params.visibleCampaigns, params.role),
      // A new account is limited unless it is told otherwise - the opposite of
      // what the accounts already on file kept.
      quota: normalizeQuota(params.quota, params.role, DEFAULT_USER_QUOTA),
      // A new account may sign in from anywhere unless it is told otherwise.
      // Unlike the daily allowance, there is no sensible default region to
      // start it on - only whoever is creating it knows where it will be used.
      loginRegions: normalizeLoginRegionsFor(params.loginRegions, params.role),
      banned: false,
      banReason: null,
      salt,
      passwordHash: hashPassword(params.password, salt)
    };
    this.#data.users.push(user);
    this.#save();
    return this.#toAuthUser(user);
  }

  updateUser(id: string, params: {
    password?: string;
    role?: UserRole;
    visibleCampaigns?: string[] | null;
    quota?: Partial<UserQuota> | null;
    loginRegions?: string[] | null;
  }): AuthUser {
    const user = this.#data.users.find((u) => u.id === id);
    if (!user) {
      throw Error('User not found');
    }
    if (params.role && params.role !== user.role) {
      // Locking everyone out of user management is not recoverable from the
      // UI, only by editing the file by hand.
      if (user.role === 'admin' && this.#countAdmins() === 1) {
        throw Error('The last administrator cannot be demoted');
      }
      user.role = params.role;
      // An administrator cannot be banned, so promoting someone lifts a ban
      // the same way it lifts the restrictions below - rather than leaving it
      // to be silently reapplied if they are demoted again.
      if (user.role === 'admin') {
        user.banned = false;
        user.banReason = null;
        user.banClearedAt = Date.now();
      }
    }
    // Whether the restriction was sent or not, it is re-normalized against the
    // role that now applies: promoting someone to administrator has to drop a
    // restriction that is about to stop being enforced, rather than leave it
    // in the file to be silently reapplied if they are demoted again.
    user.visibleCampaigns = normalizeVisibleCampaigns(
      params.visibleCampaigns !== undefined ? params.visibleCampaigns : user.visibleCampaigns,
      user.role
    );
    // Re-normalized against the role that now applies, the same way the
    // creator restriction is: promoting someone drops an allowance that is
    // about to stop being enforced, rather than leaving it to be silently
    // reapplied if they are demoted again.
    user.quota = normalizeQuota(params.quota, user.role, user.quota);
    // Re-normalized against the role that now applies, for the same reason as
    // the two above: promoting someone drops a region list that is about to
    // stop being enforced, rather than leaving it in the file to come back to
    // life if they are ever demoted again.
    user.loginRegions = normalizeLoginRegionsFor(
      params.loginRegions !== undefined ? params.loginRegions : user.loginRegions,
      user.role
    );
    if (params.password !== undefined) {
      this.#assertPassword(params.password);
      user.salt = crypto.randomBytes(SALT_BYTES).toString('base64');
      user.passwordHash = hashPassword(params.password, user.salt);
    }
    this.#save();
    return this.#toAuthUser(user);
  }

  deleteUser(id: string) {
    const index = this.#data.users.findIndex((u) => u.id === id);
    if (index === -1) {
      throw Error('User not found');
    }
    if (this.#data.users[index].role === 'admin' && this.#countAdmins() === 1) {
      throw Error('The last administrator cannot be removed');
    }
    this.#data.users.splice(index, 1);
    this.#save();
  }

  /** The queue an administrator is looking at, oldest first. */
  listRegistrations(): Registration[] {
    return this.#pendingList().map((registration) => this.#toRegistration(registration));
  }

  /**
   * Files an application. Reachable by anyone who can reach the login page, so
   * it is the one entry point here that is not behind an administrator - which
   * is why it validates as strictly as it does and why the queue has a ceiling.
   *
   * A name already taken is refused plainly. That does tell the person asking
   * that the name exists, which is the same thing every registration form in
   * the world says; the alternative is accepting an application that could
   * never be approved and leaving them waiting on it.
   */
  createRegistration(params: { username: string; password: string; }): Registration {
    const username = params.username.trim();
    if (!username) {
      throw Error('Username is required');
    }
    if (username.length > MAX_USERNAME_LENGTH) {
      throw Error(`Username must be at most ${MAX_USERNAME_LENGTH} characters`);
    }
    if (this.#usernameTaken(username)) {
      throw Error(`"${username}" is not available`);
    }
    this.#assertPassword(params.password);
    const pending = this.#pendingList();
    if (pending.length >= MAX_PENDING_REGISTRATIONS) {
      throw Error('There are too many applications waiting. Try again later.');
    }
    const salt = crypto.randomBytes(SALT_BYTES).toString('base64');
    const registration: StoredRegistration = {
      id: crypto.randomUUID(),
      username,
      requestedAt: new Date().toISOString(),
      salt,
      passwordHash: hashPassword(params.password, salt)
    };
    pending.push(registration);
    this.#save();
    return this.#toRegistration(registration);
  }

  /**
   * Turns an application into an account, carrying the password across as the
   * hash it has been since it arrived - approving one never handles a password.
   *
   * The new account starts where an account an administrator adds without
   * saying otherwise starts: an ordinary user, every creator visible, on the
   * default daily allowance. Narrowing it is the same edit as for any other.
   */
  approveRegistration(id: string): AuthUser {
    const pending = this.#pendingList();
    const index = pending.findIndex((r) => r.id === id);
    if (index === -1) {
      throw Error('Application not found');
    }
    const registration = pending[index];
    // Checked again rather than trusted from when it was filed: an
    // administrator may have created the name by hand in the meantime, and two
    // accounts answering to one name is not something to discover at sign-in.
    if (this.#data.users.some(
      (u) => u.username.toLowerCase() === registration.username.toLowerCase()
    )) {
      throw Error(`A user named "${registration.username}" already exists`);
    }
    const user: StoredUser = {
      id: crypto.randomUUID(),
      username: registration.username,
      role: 'user',
      createdAt: new Date().toISOString(),
      visibleCampaigns: null,
      quota: { ...DEFAULT_USER_QUOTA },
      loginRegions: null,
      banned: false,
      banReason: null,
      salt: registration.salt,
      passwordHash: registration.passwordHash
    };
    // Removed from the queue and added to the users in one write, so there is
    // no moment where the file holds both or neither.
    pending.splice(index, 1);
    this.#data.users.push(user);
    this.#save();
    return this.#toAuthUser(user);
  }

  /** Turns one down. The application goes; nothing was ever created. */
  rejectRegistration(id: string) {
    const pending = this.#pendingList();
    const index = pending.findIndex((r) => r.id === id);
    if (index === -1) {
      throw Error('Application not found');
    }
    pending.splice(index, 1);
    this.#save();
  }

  log(level: LogLevel, ...msg: any[]) {
    commonLog(this.#logger, level, this.name, ...msg);
  }

  #pendingList(): StoredRegistration[] {
    if (!this.#data.registrations) {
      this.#data.registrations = [];
    }
    return this.#data.registrations;
  }

  /** By an account or by an application already waiting - either way, taken. */
  #usernameTaken(username: string) {
    const name = username.toLowerCase();
    return (
      this.#data.users.some((u) => u.username.toLowerCase() === name) ||
      this.#pendingList().some((r) => r.username.toLowerCase() === name)
    );
  }

  #toRegistration(registration: StoredRegistration): Registration {
    const { id, username, requestedAt } = registration;
    return { id, username, requestedAt };
  }

  #countAdmins() {
    return this.#data.users.filter((u) => u.role === 'admin').length;
  }

  #assertPassword(password: string) {
    if (!password || password.length < MIN_PASSWORD_LENGTH) {
      throw Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
  }

  #toAuthUser(user: StoredUser): AuthUser {
    const {
      id, username, role, createdAt, visibleCampaigns, quota, loginRegions, banned, banReason
    } = user;
    // A copy, so a caller cannot reach into the store and edit a permission
    // in place - the array would otherwise be the live one.
    return {
      id, username, role, createdAt,
      visibleCampaigns: visibleCampaigns ? [ ...visibleCampaigns ] : null,
      quota: { ...quota },
      loginRegions: loginRegions ? [ ...loginRegions ] : null,
      banned,
      banReason
    };
  }

  #save() {
    const dir = path.dirname(this.#filePath);
    fs.mkdirSync(dir, { recursive: true });
    // Same directory as the target, so the rename stays within one filesystem
    // and is therefore atomic.
    const tmpFilePath = `${this.#filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpFilePath, JSON.stringify(this.#data, null, 2), { mode: 0o600 });
    fs.renameSync(tmpFilePath, this.#filePath);
  }
}
