import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { commonLog } from '../../../utils/logging/Logger.js';
import type Logger from '../../../utils/logging/Logger.js';

/**
 * Pages that have already been translated as pictures, kept on disk.
 *
 * The text translation beside this one is cached by the hash of the text, so
 * that a running header is translated once for a whole document. A picture has
 * no such thing to key on: the same page drawn at two widths is two different
 * files of bytes, and hashing them would translate the same page again every
 * time the reader was resized. So this one is keyed by the page number, which
 * is what a picture of a page actually is.
 *
 * That makes turning back free, which matters more here than it does for the
 * text: Baidu charges per image, and a reader flipping through a chapter would
 * otherwise pay for every page twice.
 *
 * One file per page, because that is what is served: a cache hit is a file
 * read straight into the response rather than a JSON document to parse. As
 * with the text store, nothing in here is precious - a missing or unreadable
 * file means the page is translated again.
 */

const MAX_PAGE = 100_000;

/** Media ids are tame, but they are not ours to trust as path segments. */
function directoryNameFor(mediaId: string) {
  const safe = mediaId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  const hash = crypto.createHash('sha1').update(mediaId).digest('base64url').slice(0, 8);
  // Keeps two ids that differ only in the characters replaced above apart.
  return `${safe}.${hash}`;
}

/** And nor is a target language, which arrives from the same request. */
function languageNameFor(to: string) {
  return to.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 20) || 'default';
}

export interface StoredPageImage {
  image: Buffer;
  contentType: string;
}

export default class PdfImageTranslationStore {
  name = 'PdfImageTranslationStore';

  #dir: string;
  #logger?: Logger | null;

  constructor(dir: string, logger?: Logger | null) {
    this.#dir = dir;
    this.#logger = logger;
  }

  #log(level: Parameters<typeof commonLog>[1], ...msg: any[]) {
    commonLog(this.#logger, level, this.name, ...msg);
  }

  #pathFor(mediaId: string, to: string, page: number, extension: string) {
    return path.resolve(
      this.#dir,
      directoryNameFor(mediaId),
      `${languageNameFor(to)}-${page}.${extension}`
    );
  }

  /**
   * The translated page, or `null` for one never asked for.
   *
   * A page Baidu found no text on is remembered as an empty file, so that it
   * is not paid for again on every visit: `{ image: empty }` is the answer
   * "there is nothing to show here", which is different from "not asked yet".
   */
  get(mediaId: string, to: string, page: number): StoredPageImage | null {
    for (const [ extension, contentType ] of [
      [ 'jpg', 'image/jpeg' ], [ 'png', 'image/png' ], [ 'none', '' ]
    ]) {
      try {
        const image = fs.readFileSync(this.#pathFor(mediaId, to, page, extension));
        return { image, contentType };
      }
      catch (_error) {
        // Missing is the normal case, and the next extension is worth a look.
      }
    }
    return null;
  }

  /** `null` records a page with nothing on it to translate. */
  set(mediaId: string, to: string, page: number, image: StoredPageImage | null) {
    if (!Number.isInteger(page) || page < 1 || page > MAX_PAGE) {
      return;
    }
    const extension = !image ? 'none' : image.contentType === 'image/png' ? 'png' : 'jpg';
    const filePath = this.#pathFor(mediaId, to, page, extension);
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, image ? image.image : Buffer.alloc(0));
    }
    catch (error) {
      this.#log('warn', `Could not save a translated page image for "${mediaId}":`, error);
    }
  }

  /**
   * Forgets every page of one document.
   *
   * Used when the credentials or the target language change: what is on disk
   * was translated by the old ones, and a reader who has just changed them is
   * asking for the pages to be done again.
   */
  clear(mediaId?: string | null) {
    try {
      fs.rmSync(
        mediaId ? path.resolve(this.#dir, directoryNameFor(mediaId)) : this.#dir,
        { recursive: true, force: true }
      );
    }
    catch (error) {
      this.#log('warn', 'Could not clear the translated page images:', error);
    }
  }
}
