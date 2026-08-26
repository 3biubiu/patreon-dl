import { type Request } from 'express';

/**
 * Keeps media URLs from working outside the page that served them.
 *
 * Whether the caller is signed in at all is the router's business - this only
 * asks whether the request looks like one the app itself made. It is a speed
 * bump, not protection: anything the browser can decode, the person in front
 * of it can keep. What it stops is the cheap stuff - pasting a media URL into
 * another tab, handing one to a download manager, and the sniffer extensions
 * that work by re-requesting a URL they scraped out of the page.
 *
 * Both checks read headers the browser sets and forbids scripts from touching.
 */

/** Dests a media file may legitimately be fetched for, per `Sec-Fetch-Dest`. */
const MEDIA_ELEMENT_DESTS = [ 'video', 'audio' ];

function isSameOrigin(req: Request) {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string') {
    // Address-bar navigation reports "none" and another site reports
    // "cross-site"; only what the page itself asked for reports "same-origin".
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
 * they have already had to pass `checkMediaAccess`, and be signed in.
 */
export function isMediaElementRequest(req: Request) {
  const dest = req.headers['sec-fetch-dest'];
  if (typeof dest !== 'string') {
    return true;
  }
  return MEDIA_ELEMENT_DESTS.includes(dest);
}
