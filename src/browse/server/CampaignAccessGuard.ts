import { type Request, type RequestHandler, type Response } from 'express';
import { type DBInstance } from '../db/index.js';
import { type AuthenticatedRequest } from './AuthGuard.js';

/**
 * Keeps a user to the creators they have been given.
 *
 * The restriction lives on the account and is resolved onto the request by the
 * auth guard, so every check here is a question about `req` and a campaign id.
 * What varies between routes is only how that campaign id is arrived at - by
 * URL parameter, or by looking up whatever the route names.
 *
 * Hiding a campaign from the listing is not on its own a permission: the
 * routes that serve its posts, its media and its files have to refuse it too,
 * or the restriction lasts exactly as long as it takes to type a URL. Hence a
 * guard applied per route rather than a filter applied to one list.
 */

/**
 * Which campaigns the signed-in user may see, or `null` when they may see all
 * of them - the default an account carries until someone narrows it.
 *
 * Administrators are never restricted. They can edit their own permissions,
 * so enforcing one against them would only be theatre.
 */
export function getCampaignScope(req: Request): string[] | null {
  const user = (req as AuthenticatedRequest).authUser;
  if (!user || user.role === 'admin') {
    return null;
  }
  return user.visibleCampaigns;
}

/**
 * Whether this request may see something belonging to `campaignId`.
 *
 * Content the database cannot attribute to a campaign is refused to anyone
 * restricted. "Which creator is this from?" having no answer is precisely when
 * guessing is least safe, and a permission that fails open is not one.
 */
export function canSeeCampaign(req: Request, campaignId: string | null): boolean {
  const scope = getCampaignScope(req);
  if (!scope) {
    return true;
  }
  return !!campaignId && scope.includes(campaignId);
}

type CampaignIdResolver = (req: Request, db: DBInstance) => string | null;

/** The campaign id is the route's own `:id`. */
export const byCampaignParam: CampaignIdResolver = (req) => req.params.id || null;

/** The route names a post or product; its campaign is looked up. */
export function byContentParam(contentType: 'post' | 'product'): CampaignIdResolver {
  return (req, db) => db.getCampaignIdForContent(req.params.id, contentType);
}

/** The route names a collection; its campaign is looked up. */
export const byCollectionParam: CampaignIdResolver =
  (req, db) => db.getCampaignIdForCollection(req.params.id);

/** The route names a media file; its campaign is looked up. */
export const byMediaParam: CampaignIdResolver = (req, db) => {
  // A linked attachment has no row in `content_media` - it is stored on the
  // post that links to it, which is the post the request names in "lapid".
  const lapid = req.query.lapid;
  if (typeof lapid === 'string' && lapid) {
    return db.getCampaignIdForContent(lapid, 'post');
  }
  return db.getCampaignIdForMedia(req.params.id);
};

/**
 * Refuses a route whose subject belongs to a campaign the user may not see.
 *
 * The answer is 404, not 403. A 403 would confirm that the campaign, post or
 * file exists and is merely someone else's, which is half of what the
 * restriction is there to hide.
 */
export function requireCampaignAccess(
  db: DBInstance,
  resolveCampaignId: CampaignIdResolver,
  respondNotFound: (res: Response) => void = (res) => { res.status(404).json({ error: 'Not found' }); }
): RequestHandler {
  return (req, res, next) => {
    // Nothing to enforce, and no reason to spend a lookup confirming it.
    if (!getCampaignScope(req)) {
      next();
      return;
    }
    if (!canSeeCampaign(req, resolveCampaignId(req, db))) {
      respondNotFound(res);
      return;
    }
    next();
  };
}
