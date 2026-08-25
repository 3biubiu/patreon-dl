import { type Campaign, type Post, type Product, type Tier } from "../../entities/index.js";
import { type ContentType } from "./Content.js";

export type MediaListSortBy = 'latest' | 'oldest';

/**
 * Media type as stored in the `media` table. Anything that is not
 * image / video / audio (PDFs, archives, 3D models, documents...) is
 * stored as `other`.
 */
export type MediaItemType = 'image' | 'video' | 'audio' | 'other';

export const MEDIA_ITEM_TYPES: MediaItemType[] = [ 'image', 'video', 'audio', 'other' ];

export type GetMediaListParams<T extends ContentType> = {
  campaign?: Campaign | string;
  sourceType?: T;
  isViewable?: boolean;
  mediaTypes?: MediaItemType[];
  datePublished?: string; // 'YYYY' or 'YYYY-mm' (e.g. '2025-06')
  sortBy?: MediaListSortBy;
  limit?: number;
  offset?: number;
} & 
(
  T extends 'post' ? {
    tiers?: Tier[] | string[];
  }
  : T extends 'product' ? {}
  : never
);

export interface MediaListItem<T extends ContentType> {
  id: string;
  mediaType: MediaItemType;
  mimeType: string | null;
  /**
   * Name of the downloaded file on disk.
   */
  filename: string | null;
  /**
   * Path of the downloaded file, relative to the data directory.
   */
  downloadPath: string | null;
  /**
   * Size of the downloaded file in bytes. Resolved by the server when
   * serving the list; `null` if it could not be determined.
   */
  size: number | null;
  thumbnail: {
    path: string;
    width: number | null;
    height: number | null;
  } | null;
  source: T extends 'post' ? Post : T extends 'product' ? Product : Post | Product;
}

export interface MediaList<T extends ContentType> {
  items: MediaListItem<T>[];
  total: number;
}
