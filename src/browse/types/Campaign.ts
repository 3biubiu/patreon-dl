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
  /**
   * Include each campaign's post / product / media / collection totals.
   *
   * On by default because the creator list on the home page shows them. Each
   * one is a full aggregate over `content`, `content_media` or `collection`,
   * materialised whole however small the `limit` - so a caller that only needs
   * names and avatars, as the sidebar does, should turn them off rather than
   * pay for four table scans it will not read.
   */
  withCounts?: boolean;
}

export interface CampaignList {
  campaigns: CampaignWithCounts[];
  total: number;
}

/** What comes back when the totals were not asked for. */
export interface CampaignSummaryList {
  campaigns: Campaign[];
  total: number;
}

export interface CampaignWithCounts extends Campaign {
  postCount: number;
  collectionCount: number;
  productCount: number;
  mediaCount: number;
}
