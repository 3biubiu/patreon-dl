import { type Request, type RequestHandler } from 'express';
import { type AuthenticatedRequest } from './AuthGuard.js';
import type QuotaStore from './QuotaStore.js';
import { nextResetAt } from './QuotaStore.js';
import { type AuthUser } from '../types/Auth.js';
import {
  QUOTA_EXCEEDED_CODE,
  type QuotaKind,
  type QuotaStatus
} from '../types/Quota.js';

/**
 * The limit that applies to one account, or `null` for none.
 *
 * Administrators are never limited. Restricting one would be a lie for the
 * same reason a creator restriction would be - they can change their own
 * allowance - so the answer does not depend on what is stored against them.
 */
export function limitFor(user: AuthUser | undefined, kind: QuotaKind): number | null {
  if (!user || user.role === 'admin') {
    return null;
  }
  return user.quota?.[kind] ?? null;
}

/**
 * Counts one post or video against the requester and says whether it may be
 * served. An anonymous request never gets this far - the router turns it away
 * first - so one arriving here without a user is let through unchanged.
 */
export function consumeQuota(
  store: QuotaStore,
  req: Request,
  kind: QuotaKind,
  id: string
): boolean {
  const user = (req as AuthenticatedRequest).authUser;
  if (!user) {
    return true;
  }
  return store.consume(user.id, kind, id, limitFor(user, kind));
}

/** Where an account stands today, for the browser to show. */
export function quotaStatus(store: QuotaStore, user: AuthUser): QuotaStatus {
  const counter = (kind: QuotaKind) => {
    const limit = limitFor(user, kind);
    const used = limit === null ? 0 : store.used(user.id, kind);
    return { limit, used, remaining: limit === null ? null : Math.max(0, limit - used) };
  };
  const posts = counter('posts');
  const videos = counter('videos');
  return {
    limited: posts.limit !== null || videos.limit !== null,
    posts,
    videos,
    resetsAt: nextResetAt().toISOString()
  };
}

/**
 * Guards the post detail route.
 *
 * Opening a post is what spends the allowance, not browsing the listings -
 * so this sits on the one route that hands back a whole post, and the grids
 * stay free to page through.
 */
export function requirePostQuota(store: QuotaStore): RequestHandler {
  return (req, res, next) => {
    if (consumeQuota(store, req, 'posts', req.params.id)) {
      next();
      return;
    }
    res.status(403).json({
      code: QUOTA_EXCEEDED_CODE,
      error: 'You have reached your daily limit for posts. It resets at 08:00 (Beijing time).'
    });
  };
}
