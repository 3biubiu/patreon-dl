import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { commonLog } from '../../../utils/logging/Logger.js';
import type Logger from '../../../utils/logging/Logger.js';

/**
 * What has already been translated, kept on disk so that turning back a page
 * costs nothing.
 *
 * Keyed by the hash of the source text rather than by page number, which makes
 * a running header translated once for the whole document, and makes a
 * re-flowed page - a different width, a different block grouping - reuse
 * whatever text it still has in common with the last time it was read.
 *
 * One file per media id. Nothing in it is precious: a corrupt or missing file
 * means the page is translated again, so every failure here is swallowed and
 * logged rather than raised.
 */

const FILE_VERSION = 1;
/** Writes are batched: a page arrives as a burst of blocks. */
const SAVE_DEBOUNCE_MS = 1000;

interface StoredFile {
  v: number;
  /** Target language to source-hash to translation. */
  langs: Record<string, Record<string, string>>;
}

function hashOf(text: string) {
  return crypto.createHash('sha1').update(text).digest('base64url').slice(0, 22);
}

/** Media ids are tame, but they are not ours to trust as path segments. */
function fileNameFor(mediaId: string) {
  const safe = mediaId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  // Keeps two ids that differ only in the characters replaced above apart.
  return `${safe}.${hashOf(mediaId).slice(0, 8)}.json`;
}

export default class PdfTranslationStore {
  name = 'PdfTranslationStore';

  #dir: string;
  #logger?: Logger | null;
  #loaded: Map<string, StoredFile>;
  #dirty: Set<string>;
  #saveTimer: NodeJS.Timeout | null;

  constructor(dir: string, logger?: Logger | null) {
    this.#dir = dir;
    this.#logger = logger;
    this.#loaded = new Map();
    this.#dirty = new Set();
    this.#saveTimer = null;
  }

  #log(level: Parameters<typeof commonLog>[1], ...msg: any[]) {
    commonLog(this.#logger, level, this.name, ...msg);
  }

  #fileFor(mediaId: string): StoredFile {
    const loaded = this.#loaded.get(mediaId);
    if (loaded) {
      return loaded;
    }
    let file: StoredFile = { v: FILE_VERSION, langs: {} };
    try {
      const raw = fs.readFileSync(path.resolve(this.#dir, fileNameFor(mediaId)), 'utf-8');
      const parsed = JSON.parse(raw) as StoredFile;
      if (parsed?.v === FILE_VERSION && parsed.langs && typeof parsed.langs === 'object') {
        file = parsed;
      }
    }
    catch (_error) {
      // Missing is the normal case; unreadable is handled the same way.
    }
    this.#loaded.set(mediaId, file);
    return file;
  }

  get(mediaId: string, to: string, text: string): string | undefined {
    return this.#fileFor(mediaId).langs[to]?.[hashOf(text)];
  }

  set(mediaId: string, to: string, text: string, translation: string) {
    const file = this.#fileFor(mediaId);
    file.langs[to] = file.langs[to] || {};
    file.langs[to][hashOf(text)] = translation;
    this.#dirty.add(mediaId);
    this.#scheduleSave();
  }

  #scheduleSave() {
    if (this.#saveTimer) {
      return;
    }
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      this.flush();
    }, SAVE_DEBOUNCE_MS);
    // Nothing here is worth holding the process open for.
    this.#saveTimer.unref?.();
  }

  flush() {
    for (const mediaId of this.#dirty) {
      const file = this.#loaded.get(mediaId);
      if (!file) {
        continue;
      }
      try {
        fs.mkdirSync(this.#dir, { recursive: true });
        fs.writeFileSync(
          path.resolve(this.#dir, fileNameFor(mediaId)),
          JSON.stringify(file),
          'utf-8'
        );
      }
      catch (error) {
        this.#log('warn', `Could not save PDF translations for "${mediaId}":`, error);
      }
    }
    this.#dirty.clear();
  }
}
