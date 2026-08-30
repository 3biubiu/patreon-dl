import { type Request, type Response } from 'express';
import { type Logger } from '../../../utils/logging';
import { type APIInstance } from '../../api';
import Basehandler from './BaseHandler.js';
import { type CampaignListSortBy } from '../../types/Campaign.js';
import { canSeeCampaign, getCampaignScope } from '../CampaignAccessGuard.js';

const DEFAULT_ITEMS_PER_PAGE = 20;

export default class CampaignAPIRequestHandler extends Basehandler {
  name = 'CampaignAPIRequestHandler';

  #api: APIInstance;

  constructor(api: APIInstance, logger?: Logger | null) {
    super(logger);
    this.#api = api;
  }

  handleListRequest(req: Request, res: Response) {
    const { limit, offset } = this.getPaginationParams(req, DEFAULT_ITEMS_PER_PAGE);
    const sortBy = this.getQueryParamValue<CampaignListSortBy>(
      req,
      'sort_by',
      ['a-z', 'z-a', 'most_content', 'most_media', 'last_downloaded'],
      'a-z'
    );
    // The four per-campaign totals are full table aggregates that a LIMIT does
    // not reduce, so a caller that only needs names and avatars - the sidebar -
    // says so and is spared them.
    const withCounts = req.query['with_counts'] ? this.getQueryParamValue<'true' | 'false'>(
      req,
      'with_counts',
      ['true', 'false']
    ) === 'true' : true;
    const list = this.#api.getCampaignList({
      sortBy,
      limit,
      offset,
      withCounts,
      // Narrowed in the query rather than after it, so that `total` - and the
      // paging the browser builds from it - counts only what this user may see.
      campaignIds: getCampaignScope(req)
    });
    res.json(list);
  }

  handleGetRequest(req: Request, res: Response, id: string) {
    const byVanity = req.query['by_vanity'] ? this.getQueryParamValue<'true' | 'false'>(
      req,
      'by_vanity',
      ['true', 'false']
    ) === 'true' ? true : false : undefined;
    const withCounts = req.query['with_counts'] ? this.getQueryParamValue<'true' | 'false'>(
      req,
      'with_counts',
      ['true', 'false']
    ) === 'true' ? true : false : undefined;
    // Checked on the way out rather than by a guard on the way in: the route's
    // ":id" may be a vanity, and which campaign that names is not known until
    // it has been looked up.
    const campaign = byVanity ?
      this.#api.getCampaign({ vanity: id, withCounts }) :
      this.#api.getCampaign({ id, withCounts });
    if (campaign && !canSeeCampaign(req, campaign.id)) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json(campaign);
  }
}