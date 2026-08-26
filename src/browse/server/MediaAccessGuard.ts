import crypto from 'crypto';
import { type Request, type Response } from 'express';

/**
 * Keeps media URLs from working outside the page that served them.
 *
 * This is a speed bump, not protection: anything the browser can decode, the
 * person in front of it can keep. What it does stop is the cheap stuff -
 * pasting a media URL into another tab, handing one to a download manager, and
 * the sniffer extensions that work by re-requesting a URL they scraped out of
 * the page.
 *
 * Two checks, neither of which a page can forge:
 *
 * 1. A signed cookie, issued when the app itself is served. `SameSite=Strict`
 *    and `HttpOnly` mean it never rides along from another site and page
 *    scripts cannot read it out to replay elsewhere.
 * 2. `Sec-Fetch-Site`, which the browser sets and forbids scripts from
 *    touching. Address-bar navigation reports `none`, another site reports
 *    `cross-site`; only requests the page itself made report `same-origin`.
 */

const COOKIE_NAME = 'pdl_media_access';

/** Long enough to outlast a browsing session, short enough that a leaked URL rots. */
const TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Regenerated on every start, so tokens do not outlive the process that
 * issued them. A restart costs the open tab one refresh.
 */
const SECRET = crypto.randomBytes(32);

/** Dests a media file may legitimately be fetched for, per `Sec-Fetch-Dest`. */
const MEDIA_ELEMENT_DESTS = [ 'video', 'audio' ];

function sign(expiry: number) {
  return crypto.createHmac('sha256', SECRET).update(String(expiry)).digest('base64url');
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
 * Grants the caller access to media for the next `TTL_MS`. Called for every
 * request that is not itself for media, which keeps the cookie fresh for as
 * long as the app is in use.
 */
export function issueMediaAccessCookie(res: Response) {
  const expiry = Date.now() + TTL_MS;
  res.cookie(COOKIE_NAME, `${expiry}.${sign(expiry)}`, {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    maxAge: TTL_MS
  });
}

function hasValidCookie(req: Request) {
  const token = readCookie(req, COOKIE_NAME);
  if (!token) {
    return false;
  }
  const separator = token.indexOf('.');
  if (separator === -1) {
    return false;
  }
  const expiryPart = token.slice(0, separator);
  const expiry = Number(expiryPart);
  if (!Number.isFinite(expiry) || Date.now() > expiry) {
    return false;
  }
  const given = Buffer.from(token.slice(separator + 1));
  const expected = Buffer.from(sign(expiry));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function isSameOrigin(req: Request) {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string') {
    return site === 'same-origin' || site === 'same-site';
  }
  // A browser too old for Sec-Fetch-* still sends a Referer for subresources
  // of its own pages.
  const referer = req.headers.referer;
  if (!referer) {
    return false;
  }
  try {
    return new URL(referer).host === req.headers.host;
  }
  catch {
    return false;
  }
}

/**
 * Whether the request may be served at all. Returns the reason it may not, so
 * the caller can log something more useful than "403".
 */
export function checkMediaAccess(req: Request): string | null {
  if (!hasValidCookie(req)) {
    return 'no valid access cookie';
  }
  if (!isSameOrigin(req)) {
    return 'not initiated by the app itself';
  }
  return null;
}

/**
 * Whether a video or audio stream is being fetched by a player rather than
 * pulled down whole. `Sec-Fetch-Dest` is `video` / `audio` only for a media
 * element; a tab navigation says `document` and `fetch()` says `empty`.
 *
 * Browsers that send no `Sec-Fetch-Dest` are given the benefit of the doubt -
 * they have already had to pass `checkMediaAccess`.
 */
export function isMediaElementRequest(req: Request) {
  const dest = req.headers['sec-fetch-dest'];
  if (typeof dest !== 'string') {
    return true;
  }
  return MEDIA_ELEMENT_DESTS.includes(dest);
}
