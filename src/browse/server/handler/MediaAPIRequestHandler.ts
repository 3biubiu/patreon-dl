import { type Request, type Response } from 'express';
import { type Logger } from '../../../utils/logging';
import { type APIInstance } from '../../api';
import Basehandler from './BaseHandler.js';
import { getYearMonthString } from '../../../utils/Misc.js';
import { type ContentType } from '../../types/Content.js';
import { MEDIA_ITEM_TYPES, type MediaItemType, type MediaList, type MediaListSortBy } from '../../types/Media.js';
import path from 'path';
import fs from 'fs';

const DEFAULT_ITEMS_PER_PAGE = 20;

export default class MediaAPIRequestHandler extends Basehandler {
  name = 'MediaAPIRequestHandler';

  #api: APIInstance;
  #dataDir: string;

  constructor(api: APIInstance, dataDir: string, logger?: Logger | null) {
    super(logger);
    this.#api = api;
    this.#dataDir = dataDir;
  }

  /**
   * Fills in the `size` of each item by stat'ing the downloaded file. Kept out of
   * the DB layer because file sizes are not recorded in the database.
   */
  #withFileSizes<T extends ContentType>(list: MediaList<T>): MediaList<T> {
    for (const item of list.items) {
      if (!item.downloadPath) {
        continue;
      }
      try {
        item.size = fs.statSync(path.resolve(this.#dataDir, item.downloadPath)).size;
      }
      catch (error) {
        this.log('debug', `Could not stat media file "${item.downloadPath}":`, error);
      }
    }
    return list;
  }

  handleListRequest(req: Request, res: Response, campaignId?: string) {
    const { limit, offset } = this.getPaginationParams(req, DEFAULT_ITEMS_PER_PAGE);
    const {
      tier_ids,
      date_published,
      source_type,
      media_types
    } = req.query;
    const mediaTypes = media_types ?
      (media_types as string)
        .split(',')
        .map((t) => t.trim())
        .filter((t): t is MediaItemType => (MEDIA_ITEM_TYPES as string[]).includes(t))
      : undefined;
    if (media_types && (!mediaTypes || mediaTypes.length === 0)) {
      throw Error(`Invalid value "${media_types as string}" for param "media_types"`);
    }
    const tiers = tier_ids ? (tier_ids as string).split(',') : undefined;
    if (tiers && tiers.length > 0) {
      if (!campaignId) {
        throw Error('Invalid params: "tier_ids" must be used with "campaign_id"');
      }
      if (source_type !== undefined && source_type !== 'post') {
        throw Error('Invalid params: "tier_ids" is only applicable for posts');
      }
    }
    const sourceType = req.query['source_type'] ? this.getQueryParamValue<ContentType>(
      req,
      'source_type',
      ['post', 'product']
    ) : (
      tiers && tiers.length > 0 ? 'post' : undefined
    );
    const isViewable = req.query['is_viewable'] ? this.getQueryParamValue<'true' | 'false'>(
      req,
      'is_viewable',
      ['true', 'false']
    ) === 'true' ? true : false : undefined;
    const sortBy = this.getQueryParamValue<MediaListSortBy>(
      req,
      'sort_by',
      ['latest', 'oldest'],
      'latest'
    );
    const datePublished = date_published === 'this_month' ? getYearMonthString() : date_published as string | undefined;
    switch (sourceType) {
      case 'post':
        res.json(this.#withFileSizes(this.#api.getMediaList({
          campaign: campaignId,
          sourceType,
          isViewable,
          mediaTypes,
          datePublished,
          tiers,
          sortBy,
          limit,
          offset
        })));
        break;
      default:
        res.json(this.#withFileSizes(this.#api.getMediaList({
          campaign: campaignId,
          sourceType,
          isViewable,
          mediaTypes,
          datePublished,
          sortBy,
          limit,
          offset
        })));
        break;
    }
  }

  handleFilterOptionsRequest(_req: Request, res: Response, campaignId: string) {
    res.json(this.#api.getMediaFilterData(campaignId));
  }
}