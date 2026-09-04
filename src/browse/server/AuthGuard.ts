import crypto from 'crypto';
import { type Request, type Response } from 'express';
import type AuthStore from './AuthStore.js';
import { type AuthUser } from '../types/Auth.js';

const COOKIE_NAME = 'pdl_session';

/** Long enough not to be a nuisance, short enough that a stolen cookie rots. */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Past the halfway mark a session is renewed, so active use never expires. */
const REFRESH_AFTER_MS = TTL_MS / 2;

/**
 * The signed-in user, resolved once per request by the router and read by
 * everything downstream.
 *
 * Content permissions will be checked off this same object - by the time any
 * handler runs, who is asking is already known.
 */
export interface AuthenticatedRequest extends Request {
  authUser?: AuthUser;
}

/**
 * Shared with the download tickets in `DownloadTicket.ts`, which are signed
 * with the same account secret. Those payloads are prefixed with what they
 * are, so that a signature made for one can never be read as the other.
 */
export function sign(secret: string, payload: string) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function readCookie(req: Request, name: string) {
  const header = req.headers.cookie;
  if (!header) {
    return null;
  }
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

/**
 * `sessionToken` is the account's current one from `AuthStore` - freshly
 * rotated at sign-in, carried over unchanged on a refresh. The cookie holds it
 * alongside the user id, and a cookie whose token the store has since replaced
 * is no longer a session.
 */
export function issueSession(res: Response, store: AuthStore, user: AuthUser, sessionToken: string) {
  const expiry = Date.now() + TTL_MS;
  const payload = `${user.id}.${expiry}.${sessionToken}`;
  res.cookie(COOKIE_NAME, `${payload}.${sign(store.secret, payload)}`, {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    maxAge: TTL_MS
  });
}

export function clearSession(res: Response) {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'strict', path: '/' });
}

/**
 * The user this request is signed in as, or `null`. A cookie that fails its
 * signature, has expired, names a user who has since been deleted, or carries
 * a session token the account has since rotated past - someone signed in on
 * another device - counts as signed out.
 */
export function getSessionUser(req: Request, store: AuthStore): AuthUser | null {
  const token = readCookie(req, COOKIE_NAME);
  if (!token) {
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 4) {
    return null;
  }
  const [ userId, expiryPart, sessionToken, mac ] = parts;
  const expiry = Number(expiryPart);
  if (!Number.isFinite(expiry) || Date.now() > expiry) {
    return null;
  }
  const given = Buffer.from(mac);
  const expected = Buffer.from(sign(store.secret, `${userId}.${expiryPart}.${sessionToken}`));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return null;
  }
  // The signature proves the cookie is one we issued; this proves it is the
  // one issued last. An older one belongs to a device someone has since
  // signed in over.
  if (store.getSessionToken(userId) !== sessionToken) {
    return null;
  }
  // A banned account has no sessions, however valid the cookie - the next
  // request after the ban lands is refused, and the sign-in form is where
  // they find out why.
  if (store.isBanned(userId)) {
    return null;
  }
  return store.getUser(userId);
}

/**
 * Extends a session that is more than half spent, so someone who keeps using
 * the app is never signed out mid-session. The session token is carried over
 * unchanged - a refresh extends this device's session, it does not start a
 * new one, so nothing is rotated and no other cookie's standing changes.
 */
export function refreshSessionIfStale(req: Request, res: Response, store: AuthStore, user: AuthUser) {
  const parts = readCookie(req, COOKIE_NAME)?.split('.');
  // Only reached with a cookie getSessionUser accepted, so the parts are there.
  if (!parts || !parts[2]) {
    return;
  }
  const sessionToken = parts[2];
  const expiry = Number(parts[1]);
  if (!Number.isFinite(expiry) || expiry - Date.now() < REFRESH_AFTER_MS) {
    issueSession(res, store, user, sessionToken);
  }
}
