import crypto from 'crypto';
import { type Request } from 'express';
import { sign } from './AuthGuard.js';

/**
 * The one way past `MediaAccessGuard`.
 *
 * That guard refuses anything that does not carry `Sec-Fetch-*` headers naming
 * the app as the initiator, which is every download manager, every extension
 * replaying a scraped URL, and every pasted address. It is the point of the
 * thing, so it is not relaxed for administrators, or for anyone else: instead
 * an administrator asks for a ticket, one file at a time, and the ticket is
 * what the guard stands aside for.
 *
 * A ticket is a bearer credential on purpose. It has to work from a client
 * that has no session cookie at all - that is what "hand this URL to a
 * downloader" means - so within its few minutes, whoever holds it can fetch
 * the one file it names. Everything about the shape below follows from that:
 * it is bound to a single media id, it expires quickly, and the id of the
 * administrator who asked for it rides along so a download can be traced back
 * to a person.
 */

/**
 * Typed in by the administrator, checked here rather than in the browser.
 *
 * A second thing to know on top of an administrator's password, so that a
 * session left open on an unlocked machine is not also a way to walk off with
 * the library. It is a speed bump of the same order as the one it accompanies:
 * six digits with the route behind `requireAdmin`, not a secret worth
 * defending on its own.
 */
const DOWNLOAD_CODE = '510623';

/**
 * Long enough for a download manager to open its parallel connections and for
 * a large file to get going, short enough that a URL which escapes - a shared
 * screen, a proxy log, a browser history - is not worth having.
 */
const TICKET_TTL_MS = 10 * 60 * 1000;

/** Distinguishes these signatures from the session cookie's. */
const TICKET_PREFIX = 'dl';

export interface DownloadTicketRequest extends Request {
  /** The administrator a verified ticket was issued to. */
  downloadTicketUserId?: string;
}

function payloadFor(mediaId: string, userId: string, expiry: string, nonce: string) {
  return `${TICKET_PREFIX}.${mediaId}.${userId}.${expiry}.${nonce}`;
}

/** Constant-time, so the code cannot be worked out a digit at a time. */
export function checkDownloadCode(code: unknown): boolean {
  if (typeof code !== 'string') {
    return false;
  }
  const given = Buffer.from(code);
  const expected = Buffer.from(DOWNLOAD_CODE);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

export function issueDownloadTicket(secret: string, mediaId: string, userId: string) {
  const expiry = String(Date.now() + TICKET_TTL_MS);
  // Two tickets for the same file in the same millisecond are still different
  // strings, so one appearing in a log says nothing about the next.
  const nonce = crypto.randomBytes(9).toString('base64url');
  const mac = sign(secret, payloadFor(mediaId, userId, expiry, nonce));
  return {
    token: `${userId}.${expiry}.${nonce}.${mac}`,
    expiresAt: Number(expiry)
  };
}

/**
 * The administrator this ticket was issued to, or `null` if it is not a
 * ticket, has expired, or names a different file than the one being asked for.
 *
 * Deliberately not single-use: a download manager opens several connections
 * against the same URL and resumes on a dropped one, so a ticket that burned
 * on first use would break the only client this exists for. Expiry is what
 * closes it, not consumption.
 */
export function verifyDownloadTicket(
  secret: string, token: string, mediaId: string
): string | null {
  const parts = token.split('.');
  if (parts.length !== 4) {
    return null;
  }
  const [ userId, expiry, nonce, mac ] = parts;
  const expiryMs = Number(expiry);
  if (!Number.isFinite(expiryMs) || Date.now() > expiryMs) {
    return null;
  }
  const given = Buffer.from(mac);
  const expected = Buffer.from(sign(secret, payloadFor(mediaId, userId, expiry, nonce)));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return null;
  }
  return userId;
}

/** Where the token is looked for, on a media URL. Not `t`: that is the thumbnail flag. */
export const TICKET_QUERY_PARAM = 'dlt';

/**
 * Reads and verifies the ticket on a `/media/...` request, so that both the
 * sign-in gate and the media handler are answering the same question. Runs
 * before the route parses its parameters, hence the id off the path.
 */
export function resolveDownloadTicket(req: Request, secret: string): string | null {
  const token = req.query[TICKET_QUERY_PARAM];
  if (typeof token !== 'string' || !token) {
    return null;
  }
  const matched = /^\/media\/([^/]+)$/.exec(req.path);
  if (!matched) {
    return null;
  }
  let mediaId;
  try {
    mediaId = decodeURIComponent(matched[1]);
  }
  catch (_error) {
    // A malformed escape is not a media id this server ever handed out.
    return null;
  }
  return verifyDownloadTicket(secret, token, mediaId);
}
