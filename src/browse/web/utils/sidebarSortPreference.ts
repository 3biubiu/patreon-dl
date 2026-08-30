import { type CampaignListSortBy } from "../../types/Campaign";

const KEY = 'patreon-dl:sidebar-campaign-sort';

/**
 * The order the sidebar lists creators in.
 *
 * Download order is the default because the panel's job is to get you back to
 * whatever came in last. It is a preference rather than a setting - it belongs
 * to the browser someone is sitting at, not to the account - so it lives in
 * local storage and simply falls back to the default where storage is off.
 */
export const SIDEBAR_SORT_OPTIONS: { value: CampaignListSortBy; label: string; }[] = [
  { value: 'last_downloaded', label: 'Last downloaded' },
  { value: 'a-z', label: 'A-Z' },
  { value: 'z-a', label: 'Z-A' },
  { value: 'most_content', label: 'Most content' },
  { value: 'most_media', label: 'Most media' }
];

const DEFAULT_SORT: CampaignListSortBy = 'last_downloaded';

export function readSidebarSort(): CampaignListSortBy {
  try {
    const stored = window.localStorage.getItem(KEY);
    return SIDEBAR_SORT_OPTIONS.some(({ value }) => value === stored) ?
      stored as CampaignListSortBy :
      DEFAULT_SORT;
  }
  catch {
    return DEFAULT_SORT;
  }
}

export function writeSidebarSort(value: CampaignListSortBy) {
  try {
    window.localStorage.setItem(KEY, value);
  }
  catch {
    // Nothing to do: the order still applies for this session.
  }
}
