import { type Request, type Response } from 'express';
import { type Logger } from '../../../utils/logging/index.js';
import Basehandler from './BaseHandler.js';
import { type DBInstance } from '../../db/index.js';
import type HistoryStore from '../HistoryStore.js';
import { type AuthenticatedRequest } from '../AuthGuard.js';
import { canSeeCampaign } from '../CampaignAccessGuard.js';
import {
  MAX_FAVORITES,
  type FavoriteListItem,
  type ViewedPostListItem,
  type WatchedVideo,
  type WatchedVideoListItem
} from '../../types/History.js';

/**
 * A position the browser sent. Anything that is not a real, non-negative
 * number is rejected rather than clamped: a player that reports nonsense
 * should not quietly move where the next play starts.
 */
function readSeconds(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

function readOptionalId(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

export default class HistoryAPIRequestHandler extends Basehandler {
  name = 'HistoryAPIRequestHandler';

  #db: DBInstance;
  #store: HistoryStore;

  constructor(db: DBInstance, store: HistoryStore, logger?: Logger | null) {
    super(logger);
    this.#db = db;
    this.#store = store;
  }

  handleListVideosRequest(req: Request, res: Response) {
    const userId = this.#targetUserId(req, res);
    if (!userId) {
      return;
    }
    const videos: WatchedVideoListItem[] = this.#store.listVideos(userId)
      // History outlives a permission change, so what may be seen now is
      // decided now rather than when the entry was written.
      .filter((video) => canSeeCampaign(req, video.campaignId))
      .map(({ mediaId, postId, position, duration, watchedAt }) => {
        // A linked attachment has no row of its own tying it to a post, so the
        // post it was played from is the only thing that names it.
        const owner = postId ?
          { contentId: postId, contentType: 'post' as const } :
          this.#db.getContentMediaOwner(mediaId);
        const summary = owner ?
          this.#db.getContentSummary(owner.contentId, owner.contentType) : null;
        return {
          mediaId,
          postId,
          position,
          duration,
          watchedAt,
          contentId: owner?.contentId || null,
          contentType: owner?.contentType || null,
          title: summary?.title || null,
          campaignName: summary?.campaignName || null
        };
      });
    res.json({ videos });
  }

  /**
   * Where this account had got to in one video, or `null`.
   *
   * `null` covers both "never watched" and "watched, but long enough ago to
   * have fallen out of the entries kept" - which the player treats the same
   * way, by starting from the beginning.
   */
  handleGetVideoRequest(req: Request, res: Response, mediaId: string) {
    const userId = this.#userId(req, res);
    if (!userId) {
      return;
    }
    const stored = this.#store.getVideo(userId, mediaId);
    if (!stored || !canSeeCampaign(req, stored.campaignId)) {
      res.json({ video: null });
      return;
    }
    const { postId, position, duration, watchedAt } = stored;
    res.json({ video: { mediaId, postId, position, duration, watchedAt } satisfies WatchedVideo });
  }

  handleRecordVideoRequest(req: Request, res: Response, mediaId: string) {
    const userId = this.#userId(req, res);
    if (!userId) {
      return;
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const position = readSeconds(body.position);
    if (position === null) {
      res.status(400).json({ error: '"position" must be a number of seconds' });
      return;
    }
    const postId = readOptionalId(body.postId);
    // Resolved here rather than taken from the request: which creator a video
    // belongs to decides who may later be told about it, and that is not the
    // browser's to assert.
    const campaignId = postId ?
      this.#db.getCampaignIdForContent(postId, 'post') :
      this.#db.getCampaignIdForMedia(mediaId);
    this.#store.recordVideo(userId, {
      mediaId,
      campaignId,
      postId,
      position,
      duration: readSeconds(body.duration),
      watchedAt: new Date().toISOString()
    });
    res.json({ ok: true });
  }

  handleListPostsRequest(req: Request, res: Response) {
    const userId = this.#targetUserId(req, res);
    if (!userId) {
      return;
    }
    const posts: ViewedPostListItem[] = this.#store.listPosts(userId)
      .filter((post) => canSeeCampaign(req, post.campaignId))
      .map(({ postId, viewedAt }) => {
        const summary = this.#db.getContentSummary(postId, 'post');
        return {
          postId,
          viewedAt,
          title: summary?.title || null,
          campaignName: summary?.campaignName || null,
          // The thumbnail first, falling back to the cover - the same order the
          // grids use, so a post looks the same here as it does there.
          thumbnailMediaId: this.#db.getExistingMediaId([
            `post:${postId}:thumbnail`,
            `post:${postId}:cover`
          ])
        };
      });
    res.json({ posts });
  }

  handleRecordPostRequest(req: Request, res: Response, postId: string) {
    const userId = this.#userId(req, res);
    if (!userId) {
      return;
    }
    this.#store.recordPost(userId, {
      postId,
      campaignId: this.#db.getCampaignIdForContent(postId, 'post'),
      viewedAt: new Date().toISOString()
    });
    res.json({ ok: true });
  }

  handleListFavoritesRequest(req: Request, res: Response) {
    const userId = this.#userId(req, res);
    if (!userId) {
      return;
    }
    const favorites: FavoriteListItem[] = this.#store.listFavorites(userId)
      .filter((favorite) => canSeeCampaign(req, favorite.campaignId))
      .map(({ postId, favoritedAt }) => {
        const summary = this.#db.getContentSummary(postId, 'post');
        return {
          postId,
          favoritedAt,
          title: summary?.title || null,
          campaignName: summary?.campaignName || null,
          thumbnailMediaId: this.#db.getExistingMediaId([
            `post:${postId}:thumbnail`,
            `post:${postId}:cover`
          ])
        };
      });
    res.json({ favorites });
  }

  /** Whether one post is saved, for the toggle to show the right state. */
  handleGetFavoriteRequest(req: Request, res: Response, postId: string) {
    const userId = this.#userId(req, res);
    if (!userId) {
      return;
    }
    res.json({ favorite: this.#store.isFavorite(userId, postId) });
  }

  handleAddFavoriteRequest(req: Request, res: Response, postId: string) {
    const userId = this.#userId(req, res);
    if (!userId) {
      return;
    }
    const { full } = this.#store.addFavorite(userId, {
      postId,
      campaignId: this.#db.getCampaignIdForContent(postId, 'post'),
      favoritedAt: new Date().toISOString()
    });
    if (full) {
      res.status(409).json({
        error: `The favorites list is full (${MAX_FAVORITES} at most). Remove one to make room.`
      });
      return;
    }
    res.json({ ok: true, favorite: true });
  }

  handleRemoveFavoriteRequest(req: Request, res: Response, postId: string) {
    const userId = this.#userId(req, res);
    if (!userId) {
      return;
    }
    this.#store.removeFavorite(userId, postId);
    res.json({ ok: true, favorite: false });
  }

  /**
   * Whose history a listing is for. An administrator may name any account with
   * `?userId=`; everyone else - and an administrator who does not ask - gets
   * their own. Naming an account that has no history is an empty list, not a
   * bad request.
   */
  #targetUserId(req: Request, res: Response): string | null {
    const user = (req as AuthenticatedRequest).authUser;
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    }
    if (user.role === 'admin') {
      const asked = req.query.userId;
      if (typeof asked === 'string' && asked) {
        return asked;
      }
    }
    return user.id;
  }

  /**
   * History belongs to an account, so there is nothing to answer without one.
   * The router already turns anonymous requests away; this is here so the
   * handler cannot be wired somewhere that does not.
   */
  #userId(req: Request, res: Response): string | null {
    const user = (req as AuthenticatedRequest).authUser;
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    }
    return user.id;
  }
}
