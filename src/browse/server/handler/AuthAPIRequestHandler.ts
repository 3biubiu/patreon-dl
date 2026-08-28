import { type Request, type Response } from 'express';
import { type Logger } from '../../../utils/logging/index.js';
import Basehandler from './BaseHandler.js';
import type AuthStore from '../AuthStore.js';
import type HistoryStore from '../HistoryStore.js';
import type QuotaStore from '../QuotaStore.js';
import type LoginLogStore from '../LoginLogStore.js';
import { MAX_LOGIN_LOG_ENTRIES } from '../LoginLogStore.js';
import { normalizeIP } from '../IPLocation.js';
import { clearSession, issueSession, type AuthenticatedRequest } from '../AuthGuard.js';
import { type UserRole } from '../../types/Auth.js';
import { quotaStatus } from '../QuotaGuard.js';
import { type QuotaKind, type UserQuota } from '../../types/Quota.js';

const ROLES: UserRole[] = [ 'admin', 'user' ];

/** What the sign-in log answers with when the caller does not say. */
const DEFAULT_LOGIN_LOG_LIMIT = 10;

/** Long enough to tell one browser from another, short enough to store. */
const MAX_USER_AGENT_LENGTH = 200;

/**
 * The address the request came from.
 *
 * `req.ip` is only the real client once Express has been told how many proxies
 * sit in front of it - see `trustProxy` in `WebServerConfig`. Without that
 * this would be the reverse proxy's own address, on every single row.
 */
function clientIP(req: Request): string {
  return normalizeIP(req.ip) || 'unknown';
}

function clientUserAgent(req: Request): string | null {
  const ua = req.get('user-agent');
  return ua ? ua.slice(0, MAX_USER_AGENT_LENGTH) : null;
}

function readRole(value: unknown): UserRole | undefined {
  return ROLES.includes(value as UserRole) ? value as UserRole : undefined;
}

/**
 * The campaign restriction as it arrived over the wire.
 *
 * Three outcomes, all of them meaningful: `undefined` (the field was not sent -
 * leave the restriction alone), `null` (every campaign) and an array (only
 * these, an empty one included). Anything else is rejected rather than guessed
 * at, so a malformed body cannot widen a permission.
 */
function readVisibleCampaigns(body: unknown): string[] | null | undefined {
  if (!body || typeof body !== 'object' || !('visibleCampaigns' in body)) {
    return undefined;
  }
  const value = (body as { visibleCampaigns: unknown }).visibleCampaigns;
  if (value === null) {
    return null;
  }
  if (Array.isArray(value) && value.every((id) => typeof id === 'string')) {
    return value as string[];
  }
  throw Error('"visibleCampaigns" must be an array of campaign ids, or null');
}

/**
 * One daily limit as it arrived over the wire. `null` is "no limit"; a number
 * is the allowance, zero included. Anything else is rejected rather than
 * guessed at, so a malformed body cannot quietly lift a limit.
 */
function readQuotaValue(value: unknown, kind: QuotaKind): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw Error(`"quota.${kind}" must be a number of 0 or more, or null for no limit`);
  }
  return Math.floor(value);
}

/**
 * The allowance as it arrived. `undefined` means the field was not sent -
 * leave what is on file alone - and a field left out of the object is left
 * alone in the same way.
 */
function readQuota(body: unknown): Partial<UserQuota> | undefined {
  if (!body || typeof body !== 'object' || !('quota' in body)) {
    return undefined;
  }
  const value = (body as { quota: unknown }).quota;
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== 'object') {
    throw Error('"quota" must be an object with "posts" and "videos"');
  }
  const given = value as Partial<Record<QuotaKind, unknown>>;
  const quota: Partial<UserQuota> = {};
  if ('posts' in given) {
    quota.posts = readQuotaValue(given.posts, 'posts');
  }
  if ('videos' in given) {
    quota.videos = readQuotaValue(given.videos, 'videos');
  }
  return quota;
}

export default class AuthAPIRequestHandler extends Basehandler {
  name = 'AuthAPIRequestHandler';

  #store: AuthStore;
  #historyStore: HistoryStore;
  #quotaStore: QuotaStore;
  #loginLogStore: LoginLogStore;

  constructor(
    store: AuthStore,
    historyStore: HistoryStore,
    quotaStore: QuotaStore,
    loginLogStore: LoginLogStore,
    logger?: Logger | null
  ) {
    super(logger);
    this.#store = store;
    this.#historyStore = historyStore;
    this.#quotaStore = quotaStore;
    this.#loginLogStore = loginLogStore;
  }

  handleLoginRequest(req: Request, res: Response) {
    const { username, password } = (req.body || {}) as { username?: string; password?: string; };
    if (!username || !password) {
      // Nothing recorded: a request with no username names no account, so
      // there is nothing here an administrator could act on.
      res.status(400).json({ error: 'Username and password are required' });
      return;
    }
    const user = this.#store.verifyPassword(username, password);
    if (!user) {
      // Never distinguish "no such user" from "wrong password" - that is how a
      // login form turns into a way to enumerate accounts. The log kept here
      // is on the other side of the door and may say what it likes.
      this.log('warn', `Failed sign-in attempt for "${username}"`);
      this.#recordLogin(req, username, null, false);
      res.status(401).json({ error: 'Incorrect username or password' });
      return;
    }
    issueSession(res, this.#store, user);
    this.#recordLogin(req, user.username, user.id, true);
    res.json({ user });
  }

  /**
   * The recent sign-ins, newest first. Administrators only - it is a record of
   * everybody's addresses, not the asking account's own.
   *
   * `userId` narrows it to one account, which is what the user list asks for.
   * Left out, the whole log comes back - including attempts made in names that
   * match no account, which belong to nobody and so can be seen no other way.
   */
  async handleLoginLogRequest(req: Request, res: Response) {
    // Anything other than a plain number falls back to the default rather
    // than being argued with - the caller is a page asking for a few rows.
    const asked = typeof req.query.limit === 'string' ?
      Number.parseInt(req.query.limit, 10) : Number.NaN;
    const limit = Number.isFinite(asked) && asked > 0 ?
      Math.min(asked, MAX_LOGIN_LOG_ENTRIES) : DEFAULT_LOGIN_LOG_LIMIT;
    let account: { id: string; username: string; } | null = null;
    if (typeof req.query.userId === 'string' && req.query.userId) {
      account = this.#store.getUser(req.query.userId);
      if (!account) {
        // An account that is not there has no sign-ins, which is an empty log
        // rather than a bad request - it may simply have just been deleted.
        res.json({ entries: [] });
        return;
      }
    }
    res.json({ entries: await this.#loginLogStore.listRecent(limit, account) });
  }

  handleLogoutRequest(_req: Request, res: Response) {
    clearSession(res);
    res.json({ user: null });
  }

  handleSessionRequest(req: Request, res: Response) {
    res.json({ user: (req as AuthenticatedRequest).authUser || null });
  }

  /**
   * Where the signed-in account stands today. Answered for administrators too,
   * who simply come back unlimited - the browser can then ask the same
   * question whoever is looking.
   */
  handleQuotaRequest(req: Request, res: Response) {
    const user = (req as AuthenticatedRequest).authUser;
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    res.json({ quota: quotaStatus(this.#quotaStore, user) });
  }

  handleListUsersRequest(_req: Request, res: Response) {
    res.json({ users: this.#store.listUsers() });
  }

  handleCreateUserRequest(req: Request, res: Response) {
    const { username, password } = (req.body || {}) as { username?: string; password?: string; };
    const role = readRole((req.body as { role?: unknown } | undefined)?.role) || 'user';
    if (!username || !password) {
      res.status(400).json({ error: 'Username and password are required' });
      return;
    }
    try {
      const visibleCampaigns = readVisibleCampaigns(req.body);
      const quota = readQuota(req.body);
      res.json({ user: this.#store.createUser({ username, password, role, visibleCampaigns, quota }) });
    }
    catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Could not create user' });
    }
  }

  handleUpdateUserRequest(req: Request, res: Response, id: string) {
    const { password } = (req.body || {}) as { password?: string; };
    const role = readRole((req.body as { role?: unknown } | undefined)?.role);
    try {
      const visibleCampaigns = readVisibleCampaigns(req.body);
      const quota = readQuota(req.body);
      const user = this.#store.updateUser(id, { password, role, visibleCampaigns, quota });
      // Changing your own password does not sign you out: the session names a
      // user id, and that has not changed.
      res.json({ user });
    }
    catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Could not update user' });
    }
  }

  handleDeleteUserRequest(req: Request, res: Response, id: string) {
    if ((req as AuthenticatedRequest).authUser?.id === id) {
      res.status(400).json({ error: 'You cannot remove your own account' });
      return;
    }
    try {
      this.#store.deleteUser(id);
      // Nothing can sign in as this account any more, so what it watched is
      // just a file that grows.
      this.#historyStore.forgetUser(id);
      // Same reasoning for today's counters - nothing can spend them any more.
      this.#quotaStore.forgetUser(id);
      // The sign-in log is deliberately left alone - see `LoginLogStore`.
      res.json({ ok: true });
    }
    catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Could not remove user' });
    }
  }

  /**
   * Writes one attempt to the log, and never lets doing so break the sign-in
   * it is recording: an audit trail that can lock everybody out is worse than
   * no audit trail at all.
   */
  #recordLogin(req: Request, username: string, userId: string | null, success: boolean) {
    try {
      this.#loginLogStore.record({
        at: new Date().toISOString(),
        username,
        userId,
        ip: clientIP(req),
        userAgent: clientUserAgent(req),
        success
      });
    }
    catch (error) {
      this.log('error', 'Failed to record sign-in:', error);
    }
  }
}
