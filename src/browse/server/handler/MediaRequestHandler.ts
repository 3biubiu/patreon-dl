import { type Request, type Response } from 'express';
import { type Logger } from '../../../utils/logging';
import { type DBInstance } from '../../db';
import path from 'path';
import fs from 'fs';
import Basehandler from './BaseHandler.js';
import contentDisposition from 'content-disposition';
import { type Downloaded } from '../../../entities';
import type VideoThumbnailer from '../VideoThumbnailer.js';
import { isMediaElementRequest } from '../MediaAccessGuard.js';

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

export default class MediaRequestHandler extends Basehandler {
  name = 'MediaRequestHandler';

  #db: DBInstance;
  #dataDir: string;
  #videoThumbnailer: VideoThumbnailer;

  constructor(db: DBInstance, dataDir: string, videoThumbnailer: VideoThumbnailer, logger?: Logger | null) {
    super(logger);
    this.#db = db;
    this.#dataDir = dataDir;
    this.#videoThumbnailer = videoThumbnailer;
  }

  async handleMediaRequest(req: Request, res: Response, id: string) {
    const { t: isRequestingThumbnail } = req.query;
    const { lapid } = req.query; // Linked attachment parent post Id
    const isDownloadRequest = req.query.dl === '1' && !isRequestingThumbnail;
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
        // No stored thumbnail. For videos we can still produce one locally by
        // grabbing a frame, which is the only option when Patreon supplied no
        // cover image for the post.
        if (looksLikeVideo(mediaFilePath, downloaded?.mimeType) && isUsableFile(mediaFilePath)) {
          const generated = await this.#videoThumbnailer.getThumbnail(mediaFilePath);
          if (generated) {
            res.sendFile(generated, { headers: { 'Content-Type': 'image/jpeg' }, dotfiles: 'allow' });
            return;
          }
          this.log('warn',
            `Could not generate a poster frame for "${mediaFilePath}" - ` +
            `check that FFmpeg is installed, or pass its path with "--ffmpeg"`
          );
        }
        this.log('warn', `Thumbnail for media file "${mediaFilePath}" unavailable`);
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
    const isPlayable =
      looksLikeVideo(mediaFilePath, downloaded.mimeType) ||
      !!downloaded.mimeType?.startsWith('audio/');
    // A video or audio file is there to be played. Asking for one outside a
    // player - a tab navigation, a download manager, an extension replaying
    // the URL - is not something the app ever does.
    if (isPlayable && !isThumbnail && !isDownloadRequest && !isMediaElementRequest(req)) {
      this.log('debug', `Refused non-player request for media file "${mediaFilePath}"`);
      res.status(403).send('Forbidden');
      return;
    }
    // Force a "Save as" instead of letting the browser render the file inline.
    // The filename always comes from the file on disk - never from the request.
    if (isDownloadRequest) {
      res.setHeader('Content-Disposition', contentDisposition(path.basename(mediaFilePath)));
    }
    const isVideo = downloaded.mimeType?.startsWith('video/');
    if (isThumbnail || !isVideo || !req.headers.range) {
      let mimeType: string | null;
      if (isThumbnail) {
        mimeType = downloaded.thumbnail?.mimeType || null;
      }
      else {
        mimeType = downloaded.mimeType || null;
      }
      const headers = mimeType ? { 'Content-Type': mimeType } : undefined;
      res.sendFile(mediaFilePath, { headers, dotfiles: 'allow' });
    }
    else {
      const range = req.headers.range;
        if (!range) {
          res.status(416).send('Requires Range header');
          return;
        }
        const fileSize = fs.statSync(mediaFilePath).size;
        const chunkSize = 10 ** 6; // 1MB chunks
        const start = Number(range.replace(/\D/g, ''));
        const end = Math.min(start + chunkSize, fileSize - 1);

        const headers = {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
          'Content-Type': downloaded.mimeType || undefined
        };

        res.writeHead(206, headers);
        const stream = fs.createReadStream(mediaFilePath, { start, end });
        stream.pipe(res);
    }
  }
}


