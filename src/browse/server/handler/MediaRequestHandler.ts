import { type Request, type Response } from 'express';
import { type Logger } from '../../../utils/logging';
import { type DBInstance } from '../../db';
import path from 'path';
import fs from 'fs';
import Basehandler from './BaseHandler.js';
import contentDisposition from 'content-disposition';
import { type Downloaded } from '../../../entities';
import { checkMediaAccess, isMediaElementRequest } from '../MediaAccessGuard.js';
import type QuotaStore from '../QuotaStore.js';
import { consumeQuota } from '../QuotaGuard.js';
import mime from 'mime-types';
import type AuthStore from '../AuthStore.js';
import { type AuthenticatedRequest } from '../AuthGuard.js';
import {
  checkDownloadCode,
  issueDownloadTicket,
  type DownloadTicketRequest
} from '../DownloadTicket.js';
import { clientIP } from '../LoginRegionGuard.js';

const VIDEO_EXTENSIONS = [
  '.mp4', '.m4v', '.mkv', '.webm', '.mov', '.avi', '.flv', '.wmv', '.mpg', '.mpeg', '.ts', '.m2ts', '.ogv'
];

/**
 * `mime_type` can be null when the downloader could not sniff the file - which
 * happens often enough with externally downloaded videos (yt-dlp and friends).
 * Fall back to the extension so such files are not mistaken for images.
 */
function looksLikeVideo(filePath: string, mimeType?: string | null) {
  if (mimeType) {
    return mimeType.startsWith('video/');
  }
  return VIDEO_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}

/**
 * A download that failed part-way can leave a zero-byte file behind, which the
 * DB still records as present. Serving one gives the browser a 200 with
 * nothing to render, collapsing whatever tile it was meant to fill - so treat
 * empty files as if they were never downloaded.
 */
function isUsableFile(filePath: string) {
  try {
    return fs.statSync(filePath).size > 0;
  }
  catch {
    return false;
  }
}

function looksLikeImage(filePath: string, mimeType?: string | null) {
  if (mimeType) {
    return mimeType.startsWith('image/');
  }
  return [ '.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp', '.svg' ]
    .includes(path.extname(filePath).toLowerCase());
}

/**
 * The type to serve a file as. Safari refuses to start a video whose
 * `Content-Type` is missing or is not `video/*` - it sits on the spinner
 * rather than sniff the bytes - so a mime type the DB never recorded is worked
 * out from the extension instead of being left off.
 */
function resolveMimeType(filePath: string, mimeType?: string | null) {
  return mimeType || mime.lookup(filePath) || null;
}

export default class MediaRequestHandler extends Basehandler {
  name = 'MediaRequestHandler';

  #db: DBInstance;
  #dataDir: string;
  #quotaStore: QuotaStore;
  #authStore: AuthStore;

  constructor(
    db: DBInstance,
    dataDir: string,
    quotaStore: QuotaStore,
    authStore: AuthStore,
    logger?: Logger | null
  ) {
    super(logger);
    this.#db = db;
    this.#dataDir = dataDir;
    this.#quotaStore = quotaStore;
    // Only for the secret the download tickets are signed with. Who the
    // requester is has already been resolved onto the request by the router.
    this.#authStore = authStore;
  }

  /**
   * Hands out a ticket for one file, to an administrator who can also produce
   * the download code.
   *
   * Issued and verified in the same place as the media itself is served, so
   * that the one way past `MediaAccessGuard` is readable in a single file
   * alongside the guard it stands down.
   */
  handleDownloadTicketRequest(req: Request, res: Response, id: string) {
    const user = (req as AuthenticatedRequest).authUser;
    // The route is already behind `requireAdmin`; this is here so that moving
    // the route cannot quietly move the permission with it.
    if (user?.role !== 'admin') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    const { code } = (req.body || {}) as { code?: unknown };
    if (!checkDownloadCode(code)) {
      // Worth a line at info: a wrong code means someone with an
      // administrator's session did not know the second half of it.
      this.log('info',
        `Refused a download ticket for "${id}" to user "${user.username}" ` +
        `(${clientIP(req)}) - wrong download code`
      );
      res.status(403).json({ error: 'Incorrect download code' });
      return;
    }
    // Videos are not handed out, and an administrator is no exception - the
    // rule is about the file, not about who is asking. Refused here so it is
    // said plainly, as well as at the media route, which would otherwise
    // answer a ticket for one with a bare 403.
    //
    // Whether the file is there at all is that route's question, not this
    // one's: an id that resolves to nothing still gets a ticket, and is
    // answered with the same 404 anything else would get. That is also what
    // keeps a linked attachment - which has no media row to look up - working
    // without a special case, and it is never a video in any event.
    const downloaded = this.#db.getMediaByID(id);
    if (downloaded?.path && looksLikeVideo(downloaded.path, downloaded.mimeType)) {
      this.log('info',
        `Refused a download ticket for video "${id}" to user "${user.username}" (${clientIP(req)})`
      );
      res.status(403).json({ error: 'Videos cannot be downloaded' });
      return;
    }
    const { token, expiresAt } = issueDownloadTicket(this.#authStore.secret, id, user.id);
    this.log('info',
      `Issued a download ticket for "${id}" to user "${user.username}" (${clientIP(req)})`
    );
    res.json({ token, expiresAt });
  }

  /**
   * What the guards saw, for the log line that accompanies a refusal. Every
   * refusal here is indistinguishable from a bug in the player until you can
   * read the headers that caused it, so they are spelled out rather than
   * summarised.
   */
  #describeFetchMetadata(req: Request) {
    const seen = (name: string): string => {
      const value = req.headers[name];
      if (Array.isArray(value)) {
        return value.join(', ');
      }
      return value ?? 'absent';
    };
    return (
      `sec-fetch-site: ${seen('sec-fetch-site')}, ` +
      `sec-fetch-dest: ${seen('sec-fetch-dest')}, ` +
      `referer: ${seen('referer')}, ` +
      `user-agent: ${seen('user-agent')}`
    );
  }

  handleMediaRequest(req: Request, res: Response, id: string) {
    // Verified by the router, which needs the answer to let a ticket-bearing
    // request past the sign-in gate at all.
    const ticketUserId = (req as DownloadTicketRequest).downloadTicketUserId;
    // The gate that keeps a media URL from working anywhere but inside the
    // page that served it. It lives here rather than in the route so that a
    // refusal can be logged with the headers behind it.
    const denied = ticketUserId ? null : checkMediaAccess(req);
    if (denied) {
      this.log('debug',
        `Refused media request for "${id}" - ${denied} (${this.#describeFetchMetadata(req)})`
      );
      res.status(403).send('Forbidden');
      return;
    }
    const { t: isRequestingThumbnail } = req.query;
    const { lapid } = req.query; // Linked attachment parent post Id
    // A ticket is only ever asked for in order to download, so it says so on
    // its own - there is no reading of one that does not mean "save this file".
    const isDownloadRequest = (req.query.dl === '1' || !!ticketUserId) && !isRequestingThumbnail;
    let downloaded: Downloaded | null | undefined = null;
    if (lapid) {
      const post = this.#db.getContent(lapid as string, 'post');
      const la = post?.linkedAttachments?.find((att) => att.mediaId === id);
      downloaded = la?.downloadable?.downloaded;
    }
    else {
      downloaded = this.#db.getMediaByID(id);
    }
    let mediaFilePath: string | null = null, isThumbnail = false;
    if (isRequestingThumbnail && downloaded?.thumbnail?.path) {
      const thumbnailFilePath = path.resolve(this.#dataDir, downloaded.thumbnail.path);
      if (isUsableFile(thumbnailFilePath)) {
        mediaFilePath = thumbnailFilePath;
        isThumbnail = true;
      }
    }
    if (!mediaFilePath) {
      mediaFilePath = downloaded?.path ? path.resolve(this.#dataDir, downloaded.path) : null;
    }
    if (isRequestingThumbnail && mediaFilePath && !isThumbnail && !looksLikeImage(mediaFilePath, downloaded?.mimeType)) {
        // No stored thumbnail, and a video is not its own poster frame.
        // Thumbnail files are prepared offline - nothing is generated here,
        // so a request like this is answered immediately rather than by
        // holding the page up while FFmpeg grabs a frame.
        this.log('debug', `Thumbnail for media file "${mediaFilePath}" unavailable`);
        res.status(404).send('Media not found');
        return;
    }
    if (!downloaded || !mediaFilePath || !isUsableFile(mediaFilePath)) {
      if (mediaFilePath) {
        this.log('warn', `Media file "${mediaFilePath}" is missing or empty`);
      }
      res.status(404).send('Media not found');
      return;
    }
    const isVideo = looksLikeVideo(mediaFilePath, downloaded.mimeType);
    const isPlayable = isVideo || !!downloaded.mimeType?.startsWith('audio/');
    // "dl=1" is how the attachment and file-card links offer a plain download,
    // so it excuses a request that did not come from a player - but never for
    // a video. Nothing in the app hands a video out that way, which is what
    // made an appended "dl=1" the one bypass worth having: it turned every
    // media URL into a download endpoint for anyone who thought to add it.
    // Never a video, ticket or no ticket. A ticket stands the fetch-metadata
    // guard down; it does not make a video downloadable, and one issued for
    // a video is refused here as well as at the point it is asked for.
    const isExcusedDownload = isDownloadRequest && !isVideo;
    // A video or audio file is there to be played. Asking for one outside a
    // player - a tab navigation, a download manager, an extension replaying
    // the URL - is not something the app ever does.
    if (isPlayable && !isThumbnail && !isExcusedDownload && !isMediaElementRequest(req)) {
      this.log('debug',
        `Refused non-player request for media file "${mediaFilePath}" ` +
        `(${this.#describeFetchMetadata(req)})`
      );
      res.status(403).send('Forbidden');
      return;
    }
    // Watching a video is what spends the day's allowance, so it is counted
    // here - at the file itself - rather than anywhere the browser could
    // choose not to call. Poster frames are exempt: a grid full of thumbnails
    // is browsing, not watching.
    //
    // Range requests, replays and a second visit to the same post all name the
    // same media id, and an id already counted today is free - which is what
    // makes the limit one on how many videos are watched rather than on how
    // many times the player reconnects.
    if (!isThumbnail && !isRequestingThumbnail && isVideo) {
      if (!consumeQuota(this.#quotaStore, req, 'videos', id)) {
        this.log('debug', `Refused media file "${mediaFilePath}" - daily video limit reached`);
        res.status(403).send('You have reached your daily limit for videos. It resets at 08:00 (Beijing time).');
        return;
      }
    }
    // Force a "Save as" instead of letting the browser render the file inline.
    // The filename always comes from the file on disk - never from the request.
    if (isDownloadRequest) {
      res.setHeader('Content-Disposition', contentDisposition(path.basename(mediaFilePath)));
    }
    // The audit line for the one door in the wall. Logged per request rather
    // than per file, because a download manager's parallel connections are
    // several requests against one ticket and the count is worth seeing.
    if (ticketUserId) {
      this.log('info',
        `Serving "${mediaFilePath}" against a download ticket issued to user id ` +
        `"${ticketUserId}" (${clientIP(req)})`
      );
    }
    const mimeType = isThumbnail ?
      resolveMimeType(mediaFilePath, downloaded.thumbnail?.mimeType) :
      resolveMimeType(mediaFilePath, downloaded.mimeType);
    // Range requests are left to express, whose implementation follows
    // RFC 7233 - it honours the requested end, "bytes=-suffix", "If-Range" and
    // answers 416 on a range it cannot satisfy. The hand-rolled one this
    // replaces read the header by stripping every non-digit and calling what
    // was left the start. Chrome and Firefox only ever ask open-ended
    // ("bytes=0-"), so that happened to work; Safari opens every video with
    // "bytes=0-1", which came out as byte 1, and iOS spun forever on a reply
    // that began in the wrong place.
    const headers = mimeType ? { 'Content-Type': mimeType } : undefined;
    res.sendFile(mediaFilePath, { headers, dotfiles: 'allow', acceptRanges: true });
  }
}


