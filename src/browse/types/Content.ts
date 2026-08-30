import { type Campaign, type Comment, type Post, type Product, type Tier } from "../../entities/index.js";
import { type PostTag, type Collection } from "../../entities/Post.js";

export type ContentListSortBy = 'a-z' | 'z-a' | 'latest' | 'oldest';
export type ContentType = 'post' | 'product';

export interface PostWithComments extends Post {
  comments: Comment[] | null;
}

export type GetContentListParams<T extends ContentType> =
{
  campaign?: Campaign | string;
  /**
   * Restricts the list to content belonging to these campaigns. `null` or
   * omitted means no restriction. An empty array yields an empty list - a user
   * permitted no campaigns must not be shown everyone's posts.
   *
   * Unlike `campaign`, which says which creator is being browsed, this says
   * which creators the request is allowed to see at all. The campaign-scoped
   * routes enforce that with a guard on the URL's own id; a listing that spans
   * creators - global search - has no such id and needs the restriction in the
   * query instead.
   *
   * Applied in SQL rather than to the returned page, so `total` and the paging
   * built on it describe what the caller may actually see.
   */
  campaignIds?: string[] | null;
  type?: T;
  isViewable?: boolean;
  datePublished?: string; // 'YYYY' or 'YYYY-mm' (e.g. '2025-06')
  limit?: number;
  offset?: number;
} &
(
  T extends 'post' ? {
    postTypes?: string[];
    tiers?: Tier[] | string[];
    collection?: Collection | string;
    tag?: PostTag | string;
  }
  : T extends 'product' ? {}
  : never
) & {
  search?: string;
  /**
   * `best_match` used to be spelled as a union arm that only existed when
   * `search` was a string, so that relevance could not be asked for without a
   * query to be relevant to. That made the type unusable from a request
   * handler, where `search` is `string | undefined` and neither arm fits, and
   * the query builder now answers the question properly anyway: without a
   * query it orders by newest instead, since the FTS table it would score
   * against is not even in the FROM.
   */
  sortBy?: ContentListSortBy | 'best_match';
};

export interface ContentList<T extends ContentType> {
  items: (
    T extends 'post' ? PostWithComments
    : T extends 'product' ? Product
    : PostWithComments | Product
  )[];
  total: number;
}

export type GetContentContext<T extends ContentType> = Omit<GetContentListParams<T>, 'limit' | 'offset'>;

export type GetPreviousNextContentResult<T extends ContentType> =
  T extends 'post' ? {
    previous: PostWithComments | null;
    next: PostWithComments | null;
  }
  : T extends 'product' ? {
    previous: Product | null;
    next: Product | null;
  }
  : never;

export type CollectionListSortBy = 'a-z' | 'z-a' | 'last_created' | 'last_updated';

export interface GetCollectionListParams {
  campaign: Campaign | string;
  search?: string;
  sortBy?: CollectionListSortBy;
  limit?: number;
  offset?: number;
}

export interface CollectionList {
  collections: Collection[];
  total: number;
}

export interface GetPostTagListParams {
  campaign: Campaign | string;
}

export interface PostTagList {
  tags: PostTag[];
  total: number;
}

export type SearchContentParams = {
  campaign?: Campaign | string;
  query: string;
} & ({
  type: 'post';
  collection?: Collection;
  sortBy: ContentListSortBy | 'best_match';
} | {
  type: 'product';
  sortBy: ContentListSortBy | 'best_match';
} | {
  type: 'collection';
  sortBy: CollectionListSortBy | 'best_match';
})