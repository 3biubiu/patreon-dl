/**
 * A video the user has played, and where they had got to.
 *
 * `position` is in seconds. `duration` comes from the player rather than the
 * file, so it is null until the browser has read the metadata at least once.
 */
export interface WatchedVideo {
  mediaId: string;
  /** The post the video was played from, when it was played from one. */
  postId: string | null;
  position: number;
  duration: number | null;
  watchedAt: string;
}

/**
 * A PDF the user has read, and the page they had got to.
 *
 * The reading equivalent of {@link WatchedVideo}: what it exists for is to
 * open the file where it was left rather than at page one. `numPages` is kept
 * so a stored page can be sanity-checked against a file that has since been
 * replaced by a shorter one.
 */
export interface ReadPdf {
  mediaId: string;
  /** The post the PDF was opened from, when it was opened from one. */
  postId: string | null;
  page: number;
  numPages: number | null;
  readAt: string;
}

export interface ViewedPost {
  postId: string;
  viewedAt: string;
}

/**
 * A post the user has explicitly saved. Unlike the viewed-post history this is
 * a deliberate act and is not evicted by newer entries - it only leaves when
 * the user removes it, up to a fixed ceiling.
 */
export interface Favorite {
  postId: string;
  favoritedAt: string;
}

/** How many favorites one account may keep. Enforced by the server. */
export const MAX_FAVORITES = 100;

/**
 * A history entry with the details needed to show it in a list.
 *
 * Resolved from the database when the list is asked for, rather than copied
 * into the history when the entry is written - a title that was renamed, or a
 * post that has since been removed, should not be remembered wrongly.
 */
export interface WatchedVideoListItem extends WatchedVideo {
  /** The post or product the video belongs to, when it is still there. */
  contentId: string | null;
  contentType: 'post' | 'product' | null;
  title: string | null;
  campaignName: string | null;
}

export interface ReadPdfListItem extends ReadPdf {
  /** The post or product the file belongs to, when it is still there. */
  contentId: string | null;
  contentType: 'post' | 'product' | null;
  title: string | null;
  campaignName: string | null;
}

export interface ViewedPostListItem extends ViewedPost {
  title: string | null;
  campaignName: string | null;
  /** A picture to show for it, if one was downloaded. */
  thumbnailMediaId: string | null;
}

export interface FavoriteListItem extends Favorite {
  title: string | null;
  campaignName: string | null;
  /** A picture to show for it, if one was downloaded. */
  thumbnailMediaId: string | null;
}

export interface RecordWatchedVideoRequest {
  position: number;
  duration?: number | null;
  postId?: string | null;
}

export interface RecordReadPdfRequest {
  page: number;
  numPages?: number | null;
  postId?: string | null;
}
