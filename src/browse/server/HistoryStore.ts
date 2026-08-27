import fs from 'fs';
import path from 'path';
import { commonLog, type LogLevel } from '../../utils/logging/Logger.js';
import { type Logger } from '../../utils/logging/index.js';
import { MAX_FAVORITES } from '../types/History.js';

/**
 * How much of each kind is kept per account. Small on purpose: this is what
 * makes resuming possible, not a browsing history, and the cap is what keeps
 * the file small enough to be rewritten whole on every update.
 */
const MAX_ENTRIES = 10;

/**
 * An entry as stored. `campaignId` is bookkeeping the browser never sees - it
 * is what lets a listing be filtered against the reader's creator permissions,
 * so that history recorded before an administrator narrowed an account stops
 * being handed back afterwards.
 */
interface StoredVideo {
  mediaId: string;
  campaignId: string | null;
  postId: string | null;
  position: number;
  duration: number | null;
  watchedAt: string;
}

interface StoredPost {
  postId: string;
  campaignId: string | null;
  viewedAt: string;
}

/**
 * A saved post. `campaignId` is the same bookkeeping the other kinds carry, so
 * a favorite made before an account was narrowed stops being handed back.
 */
interface StoredFavorite {
  postId: string;
  campaignId: string | null;
  favoritedAt: string;
}

interface UserHistory {
  videos: StoredVideo[];
  posts: StoredPost[];
  /** Written before favorites existed, so this can be absent on load. */
  favorites?: StoredFavorite[];
}

interface HistoryFile {
  /** Keyed by account id, the same id the session cookie names. */
  users: Record<string, UserHistory | undefined>;
}

function emptyUserHistory(): UserHistory {
  return { videos: [], posts: [], favorites: [] };
}

/**
 * What each account has watched and read, kept in a file of its own beside the
 * accounts themselves.
 *
 * Separate from `AuthStore` because the two have opposite risk profiles. Losing
 * credentials means nobody can sign in; losing watch positions means a video
 * starts from the beginning. So this one is written far more often, and -
 * unlike the auth file - a corrupt or unreadable one is started over rather
 * than thrown, because refusing to start the server over a lost playback
 * position would be the wrong trade.
 *
 * Writes go through a temporary file and a rename, so an interrupted write
 * cannot leave a half-written file behind.
 */
export default class HistoryStore {
  name = 'HistoryStore';

  #filePath: string;
  #data: HistoryFile;
  #logger?: Logger | null;

  private constructor(filePath: string, data: HistoryFile, logger?: Logger | null) {
    this.#filePath = filePath;
    this.#data = data;
    this.#logger = logger;
  }

  static load(filePath: string, logger?: Logger | null) {
    if (fs.existsSync(filePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as HistoryFile;
        if (data.users && typeof data.users === 'object') {
          return new HistoryStore(filePath, data, logger);
        }
        throw Error('missing "users"');
      }
      catch (error) {
        commonLog(logger, 'warn', 'HistoryStore',
          `Ignoring "${filePath}" - it could not be read (${error instanceof Error ? error.message : String(error)}). ` +
          `Watch history starts over.`
        );
      }
    }
    return new HistoryStore(filePath, { users: {} }, logger);
  }

  /** Most recently watched first. */
  listVideos(userId: string): StoredVideo[] {
    return this.#data.users[userId]?.videos || [];
  }

  /**
   * What is known about one video, or `null` if it is not among the entries
   * kept for this account - which is the same answer as never having watched
   * it, and is what stops a video that has aged out from resuming.
   */
  getVideo(userId: string, mediaId: string): StoredVideo | null {
    return this.listVideos(userId).find((video) => video.mediaId === mediaId) || null;
  }

  /** Most recently viewed first. */
  listPosts(userId: string): StoredPost[] {
    return this.#data.users[userId]?.posts || [];
  }

  recordVideo(userId: string, entry: StoredVideo) {
    const history = this.#userHistory(userId);
    history.videos = HistoryStore.#promote(
      history.videos,
      entry,
      (video) => video.mediaId === entry.mediaId
    );
    this.#save();
  }

  recordPost(userId: string, entry: StoredPost) {
    const history = this.#userHistory(userId);
    history.posts = HistoryStore.#promote(
      history.posts,
      entry,
      (post) => post.postId === entry.postId
    );
    this.#save();
  }

  /** Newest saved first. */
  listFavorites(userId: string): StoredFavorite[] {
    return this.#data.users[userId]?.favorites || [];
  }

  isFavorite(userId: string, postId: string): boolean {
    return this.listFavorites(userId).some((favorite) => favorite.postId === postId);
  }

  /**
   * Saves a post. Unlike the history kinds this does not evict anything: a
   * favorite is kept until the user removes it. When the ceiling is already
   * reached and this post is not one of the ones held, nothing is stored and
   * `full` comes back true so the caller can say why.
   */
  addFavorite(userId: string, entry: StoredFavorite): { added: boolean; full: boolean } {
    const history = this.#userHistory(userId);
    if (!history.favorites) {
      history.favorites = [];
    }
    const favorites = history.favorites;
    if (favorites.some((favorite) => favorite.postId === entry.postId)) {
      return { added: false, full: false };
    }
    if (favorites.length >= MAX_FAVORITES) {
      return { added: false, full: true };
    }
    history.favorites = [ entry, ...favorites ];
    this.#save();
    return { added: true, full: false };
  }

  /** Removes a saved post. Returns whether one was there to remove. */
  removeFavorite(userId: string, postId: string): boolean {
    const history = this.#data.users[userId];
    const favorites = history?.favorites;
    if (!history || !favorites || !favorites.some((favorite) => favorite.postId === postId)) {
      return false;
    }
    history.favorites = favorites.filter((favorite) => favorite.postId !== postId);
    this.#save();
    return true;
  }

  /**
   * Drops everything kept for an account. Called when one is deleted, so that
   * history does not pile up under ids nothing can sign in as any more.
   */
  forgetUser(userId: string) {
    if (!this.#data.users[userId]) {
      return;
    }
    delete this.#data.users[userId];
    this.#save();
  }

  log(level: LogLevel, ...msg: any[]) {
    commonLog(this.#logger, level, this.name, ...msg);
  }

  /**
   * The entry goes to the front, replacing any earlier one for the same thing
   * rather than joining it - watching a video twice is one entry, not two -
   * and the oldest fall off the end.
   */
  static #promote<T>(entries: T[], entry: T, isSame: (existing: T) => boolean): T[] {
    return [ entry, ...entries.filter((existing) => !isSame(existing)) ].slice(0, MAX_ENTRIES);
  }

  #userHistory(userId: string): UserHistory {
    let history = this.#data.users[userId];
    if (!history) {
      history = emptyUserHistory();
      this.#data.users[userId] = history;
    }
    return history;
  }

  #save() {
    try {
      const dir = path.dirname(this.#filePath);
      fs.mkdirSync(dir, { recursive: true });
      // Same directory as the target, so the rename stays within one
      // filesystem and is therefore atomic.
      const tmpFilePath = `${this.#filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpFilePath, JSON.stringify(this.#data, null, 2), { mode: 0o600 });
      fs.renameSync(tmpFilePath, this.#filePath);
    }
    catch (error) {
      // Worth saying once, but not worth failing the request that triggered
      // it: the caller was watching a video, not saving a file.
      this.log('error', `Failed to write "${this.#filePath}":`, error);
    }
  }
}
