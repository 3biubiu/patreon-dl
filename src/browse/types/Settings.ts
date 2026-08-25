export interface BrowseTheme {
  name: string;
  value: string;
  stylesheets: string[];
}

export type MaxContentWidth = 'Narrower' | 'Standard' | 'Wider';

/**
 * How the post list is presented:
 * - `card`: full post cards (the original layout)
 * - `grid`: thumbnail + title tiles, as many per row as the width allows
 * - `list`: compact rows with the thumbnail on the left
 */
export type PostListLayout = 'card' | 'grid' | 'list';

export interface BrowseSettings {
  theme: string;
  listItemsPerPage: number;
  galleryItemsPerPage: number;
  maxContentWidth: MaxContentWidth;
  postListLayout: PostListLayout;
}

export interface BrowseSettingOptions {
  themes: BrowseTheme[];
  listItemsPerPage: number[];
  galleryItemsPerPage: number[];
  maxContentWidth: MaxContentWidth[];
  postListLayout: PostListLayout[];
}