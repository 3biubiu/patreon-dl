import { type Campaign } from "../../entities/index.js";

export type CampaignListSortBy =
  'a-z' |
  'z-a' |
  'most_content' |
  'most_media' |
  'last_downloaded';

export type GetCampaignParams = {
  id: string;
  vanity?: never;
  withCounts?: boolean;
} | {
  id?: never;
  vanity: string;
  withCounts?: boolean;
}

export interface GetCampaignListParams {
  sortBy?: CampaignListSortBy;
  limit?: number;
  offset?: number;
  /**
   * Restricts the list to these campaign ids. `null` or omitted means no
   * restriction. An empty array yields an empty list - a user permitted no
   * campaigns must not be shown all of them.
   *
   * Applied in SQL rather than to the returned page, so `total` and the
   * paging built on it describe what the caller may actually see.
   */
  campaignIds?: string[] | null;
}

export interface CampaignList {
  campaigns: (Campaign & {
    postCount: number;
    productCount: number;
    mediaCount: number;
    collectionCount: number;
  })[];
  total: number;
}

export interface CampaignWithCounts extends Campaign {
  postCount: number;
  collectionCount: number;
  productCount: number;
  mediaCount: number;
}
