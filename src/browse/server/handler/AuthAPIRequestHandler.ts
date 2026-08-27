import { type Request, type Response } from 'express';
import { type Logger } from '../../../utils/logging/index.js';
import Basehandler from './BaseHandler.js';
import type AuthStore from '../AuthStore.js';
import type HistoryStore from '../HistoryStore.js';
import { clearSession, issueSession, type AuthenticatedRequest } from '../AuthGuard.js';
import { type UserRole } from '../../types/Auth.js';

const ROLES: UserRole[] = [ 'admin', 'user' ];

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

export default class AuthAPIRequestHandler extends Basehandler {
  name = 'AuthAPIRequestHandler';

  #store: AuthStore;
  #historyStore: HistoryStore;

  constructor(store: AuthStore, historyStore: HistoryStore, logger?: Logger | null) {
    super(logger);
    this.#store = store;
    this.#historyStore = historyStore;
  }

  handleLoginRequest(req: Request, res: Response) {
    const { username, password } = (req.body || {}) as { username?: string; password?: string; };
    if (!username || !password) {
      res.status(400).json({ error: 'Username and password are required' });
      return;
    }
    const user = this.#store.verifyPassword(username, password);
    if (!user) {
      // Never distinguish "no such user" from "wrong password" - that is how a
      // login form turns into a way to enumerate accounts.
      this.log('warn', `Failed sign-in attempt for "${username}"`);
      res.status(401).json({ error: 'Incorrect username or password' });
      return;
    }
    issueSession(res, this.#store, user);
    res.json({ user });
  }

  handleLogoutRequest(_req: Request, res: Response) {
    clearSession(res);
    res.json({ user: null });
  }

  handleSessionRequest(req: Request, res: Response) {
    res.json({ user: (req as AuthenticatedRequest).authUser || null });
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
      res.json({ user: this.#store.createUser({ username, password, role, visibleCampaigns }) });
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
      const user = this.#store.updateUser(id, { password, role, visibleCampaigns });
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
      res.json({ ok: true });
    }
    catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Could not remove user' });
    }
  }
}
