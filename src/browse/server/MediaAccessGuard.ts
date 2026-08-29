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
 * Both checks read `Sec-Fetch-*`, which is a forbidden header name: page
 * scripts cannot set it, extensions cannot hand a forged one to a helper
 * program, and a client that is not a browser does not produce it at all. That
 * last part is the whole point, so **absence is a refusal**. An earlier
 * version of this file treated a missing header as "old browser, let it
 * through", which is precisely the shape every download manager arrives in.
 *
 * Two consequences worth knowing before touching this:
 *
 *  - Browsers older than Chrome 76 / Firefox 90 / Safari 16.4 send none of
 *    these and are now refused. They are also the browsers that cannot be told
 *    apart from a download manager, so there is no version of this that keeps
 *    them and still works.
 *
 *  - Fetch Metadata is only sent to a potentially trustworthy origin - HTTPS,
 *    or localhost. Reached over plain http:// on a LAN address, no browser
 *    sends these headers and every media request 403s. Serve this over TLS.
 */

/** Dests a media file may legitimately be fetched for, per `Sec-Fetch-Dest`. */
const MEDIA_ELEMENT_DESTS = [ 'video', 'audio' ];

/**
 * `Sec-Fetch-Site` values that mean "the page asked for this". Address-bar
 * navigation reports "none" and another site reports "cross-site".
 */
const SAME_SITE_VALUES = [ 'same-origin', 'same-site' ];

function isSameOrigin(req: Request) {
  const site = req.headers['sec-fetch-site'];
  return typeof site === 'string' && SAME_SITE_VALUES.includes(site);
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
 * If a service worker is ever put in front of these URLs to carry a private
 * token, its requests arrive as `empty` - the token check belongs beside this
 * one at the call site, as an alternative to it, not in place of it.
 */
export function isMediaElementRequest(req: Request) {
  const dest = req.headers['sec-fetch-dest'];
  return typeof dest === 'string' && MEDIA_ELEMENT_DESTS.includes(dest);
}
