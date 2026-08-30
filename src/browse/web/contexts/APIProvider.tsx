import { createContext, useContext } from 'react';
import { type CampaignList, type CampaignListSortBy, type CampaignWithCounts } from '../../types/Campaign';
import { type ContentType, type ContentList, type ContentListSortBy, type PostWithComments, type CollectionListSortBy, type CollectionList, type PostTagList } from '../../types/Content';
import { type Campaign, type Product } from '../../../entities';
import { type BrowseSettings, type BrowseSettingOptions as BrowseSettingOptions } from '../../types/Settings';
import { type Filter, type FilterSearchParams, type FilterData, type MediaFilterSearchParams, type PostFilterSearchParams } from '../../types/Filter';
import { type MediaList } from '../../types/Media';
import { type Collection } from '../../../entities/Post';
import { type AuthSession, type AuthUser, type CreateUserRequest, type LoginLogEntry, type Registration, type UpdateUserRequest } from '../../types/Auth';
import { QUOTA_EXCEEDED_CODE, type QuotaStatus } from '../../types/Quota';
import { type SubtitleFile, type TranscriptionAvailability, type TranscriptionProvider, type TranscriptionRecord, type TranscriptionSettings } from '../../types/Transcription';
import { type TranslationAvailability, type TranslationSettings } from '../../types/Translation';
import {
  type FavoriteListItem,
  type RecordWatchedVideoRequest,
  type ViewedPostListItem,
  type WatchedVideo,
  type WatchedVideoListItem
} from '../../types/History';

interface APIProviderProps {
  children: React.ReactNode;
}

export interface APIContextValue {
  api: API;
}


/** Raised when the session has gone away mid-use. */
export class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized');
    this.name = 'UnauthorizedError';
  }
}

export const UNAUTHORIZED_EVENT = 'patreon-dl:unauthorized';

/**
 * Raised when the day's allowance is spent. Its own type because a page has to
 * tell it from a permission refusal - one is "come back tomorrow", the other
 * is "this was never yours to read".
 */
export class QuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuotaExceededError';
  }
}

/**
 * Every data request goes through here so that one expired session is noticed
 * once, in one place.
 *
 * It throws rather than returning the 401 body: callers hand the result
 * straight to `setState`, and letting `{ error: "Unauthorized" }` through
 * would have them render it as if it were content.
 */
async function apiFetch(input: string, init?: RequestInit) {
  const response = await fetch(input, init);
  if (response.status === 401) {
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new UnauthorizedError();
  }
  return response;
}

async function readJSON(response: Response) {
  const data = await response.json() as { error?: string } & Record<string, any>;
  if (!response.ok) {
    throw Error(data?.error || 'Request failed');
  }
  return data;
}

class API {

  async getCampaignList(params: {
    sortBy?: CampaignListSortBy;
    page?: number;
    itemsPerPage: number;
  }): Promise<CampaignList> {
    const urlObj = new URL('/api/campaigns', window.location.href);
    if (params.sortBy) {
      urlObj.searchParams.append('sort_by', params.sortBy);
    }
    this.#setPaginationParams(urlObj, params);
    const result = await apiFetch(urlObj.toString());
    return await result.json();
  }

  /**
   * Posts from every creator, by search term.
   *
   * A separate endpoint from the per-campaign listings rather than the same
   * one without a campaign: the server has to narrow this by the account's
   * campaign permissions inside the query, which is not something the
   * campaign-scoped routes ever have to do.
   */
  async searchPosts(params: {
    search: string;
    sortBy?: ContentListSortBy | 'best_match';
    page?: number;
    itemsPerPage: number;
  }): Promise<ContentList<'post'>> {
    const urlObj = new URL('/api/search', window.location.href);
    urlObj.searchParams.set('search', params.search);
    if (params.sortBy) {
      urlObj.searchParams.set('sort_by', params.sortBy);
    }
    this.#setPaginationParams(urlObj, params);
    const result = await apiFetch(urlObj.toString());
    return await readJSON(result) as ContentList<'post'>;
  }

  async getContentList<T extends ContentType>(params: {
    campaign: Campaign;
    type?: ContentType;
    collectionId?: string | null,
    filter: Filter<PostFilterSearchParams>,
    page?: number;
    itemsPerPage: number;
  }): Promise<ContentList<T>> {
    const { campaign, filter } = params;
    const contentType =
      params.type === 'post' ? 'posts'
      : params.type === 'product' ? 'products'
      : 'content';
    const urlObj = new URL(`/api/campaigns/${campaign.id}/${contentType}`, window.location.href);
    if (params.collectionId) {
      urlObj.searchParams.set('collection_id', params.collectionId);
    }
    this.#setFilterParams(urlObj, filter);
    this.#setPaginationParams(urlObj, params);
    const result = await apiFetch(urlObj.toString());
    return await result.json();
  }

  async getCampaign(params: {
    id: string;
    vanity?: never;
    withCounts?: true;
  } | {
    id?: never;
    vanity: string;
    withCounts?: true;
  }): Promise<CampaignWithCounts | null>
  async getCampaign(params: {
    id: string;
    vanity?: never;
    withCounts?: false;
  } | {
    id?: never;
    vanity: string;
    withCounts?: false;
  }): Promise<Campaign | null>
  async getCampaign(params: {
    id: string;
    vanity?: never;
    withCounts?: boolean;
  } | {
    id?: never;
    vanity: string;
    withCounts?: boolean;
  }): Promise<Campaign | CampaignWithCounts | null>
  async getCampaign(params: {
    id: string;
    vanity?: never;
    withCounts?: boolean;
  } | {
    id?: never;
    vanity: string;
    withCounts?: boolean;
  }) {
    const { withCounts = false } = params;
    let urlObj;
    if (params.id !== undefined) {
      urlObj = new URL(`/api/campaigns/${params.id}`, window.location.href);
    }
    else {
      urlObj = new URL(`/api/campaigns/${encodeURIComponent(params.vanity)}`, window.location.href);
      urlObj.searchParams.append('by_vanity', 'true');
    }
    urlObj.searchParams.append('with_counts', withCounts ? 'true' : 'false' );
    const result = await apiFetch(urlObj.toString());
    // A creator that is not there and one this account may not see answer the
    // same way, on purpose. Callers get `null` for both rather than an error
    // body they would otherwise spread into a half-built campaign.
    if (!result.ok) {
      return null;
    }
    return await result.json();
  }

  async getContentFilterOptions(
    campaign: Campaign | string,
    contentType: ContentType
  ): Promise<FilterData<PostFilterSearchParams>> {
    const campaignId = typeof campaign === 'string' ? campaign : campaign.id;
    const ct = contentType === 'post' ? 'posts' : 'products';
    const urlObj = new URL(`/api/campaigns/${campaignId}/${ct}/filter_options`, window.location.href);
    const result = await apiFetch(urlObj.toString());
    return await result.json();
  }

  async getPost(id: string, contextQS = ''): Promise<{ post: PostWithComments; previous: PostWithComments | null; next: PostWithComments | null; }> {
    const urlObj = new URL(`/api/posts/${id}`, window.location.href);
    if (contextQS) {
      urlObj.search = contextQS;
    }
    const result = await apiFetch(urlObj.toString());
    const data = await result.json() as
      { error?: string; code?: string } &
      { post: PostWithComments; previous: PostWithComments | null; next: PostWithComments | null; };
    // The daily limit is the one refusal the page can do something about, so
    // it is raised as itself rather than left to look like an empty post.
    if (data?.code === QUOTA_EXCEEDED_CODE) {
      throw new QuotaExceededError(data.error || 'Daily limit reached');
    }
    return data;
  }

  async getProduct(id: string): Promise<Product | null> {
    const urlObj = new URL(`/api/products/${id}`, window.location.href);
    const result = await apiFetch(urlObj.toString());
    return await result.json();
  }

  async getCollection(id: string): Promise<{ collection: Collection; campaignId: string; } | null> {
    const urlObj = new URL(`/api/collections/${id}`, window.location.href);
    const result = await apiFetch(urlObj.toString());
    if (!result.ok) {
      return null;
    }
    return await result.json();
  }

  async getCollectionList(params: {
    campaign: Campaign | string;
    search?: string;
    sortBy?: CollectionListSortBy;
    page?: number;
    itemsPerPage: number;
  }): Promise<CollectionList> {
    const { campaign, search, sortBy } = params;
    const campaignId = typeof campaign === 'string' ? campaign : campaign.id;
    const urlObj = new URL(`/api/campaigns/${campaignId}/collections`, window.location.href);
    if (search) {
      urlObj.searchParams.append('search', search);
    }
    if (sortBy) {
      urlObj.searchParams.append('sort_by', sortBy);
    }
    this.#setPaginationParams(urlObj, params);
    const result = await apiFetch(urlObj.toString());
    return await result.json();
  }

  async getPostTagList(params: {
    campaign: Campaign | string;
  }): Promise<PostTagList> {
    const { campaign } = params;
    const campaignId = typeof campaign === 'string' ? campaign : campaign.id;
    const urlObj = new URL(`/api/campaigns/${campaignId}/post_tags`, window.location.href);
    const result = await apiFetch(urlObj.toString());
    return await result.json();
  }

  async getBrowseSettings(): Promise<BrowseSettings> {
    const urlObj = new URL(`/api/settings/browse`, window.location.href);
    const result = await apiFetch(urlObj.toString());
    return await result.json();
  }

  async getBrowseSettingOptions(): Promise<BrowseSettingOptions> {
    const urlObj = new URL(`/api/settings/browse/options`, window.location.href);
    const result = await apiFetch(urlObj.toString());
    return await result.json();
  }

  async getMediaList<T extends ContentType>(params: {
    campaign: Campaign;
    filter: Filter<MediaFilterSearchParams>,
    page?: number;
    itemsPerPage: number;
  }): Promise<MediaList<T>> {
    const { campaign, filter } = params;
    const urlObj = new URL(`/api/campaigns/${campaign.id}/media`, window.location.href);
    this.#setFilterParams(urlObj, filter);
    this.#setPaginationParams(urlObj, params);
    const result = await apiFetch(urlObj.toString());
    return await result.json();
  }

  async getMediaFilterOptions(
    campaign: Campaign | string
  ): Promise<FilterData<MediaFilterSearchParams>> {
    const campaignId = typeof campaign === 'string' ? campaign : campaign.id;
    const urlObj = new URL(`/api/campaigns/${campaignId}/media/filter_options`, window.location.href);
    const result = await apiFetch(urlObj.toString());
    return await result.json();
  }

  saveBrowseSettings(settings: BrowseSettings) {
    return apiFetch("/api/settings/browse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
  }

  // Auth endpoints use plain `fetch`: a 401 from them is an expected answer
  // ("not signed in", "wrong password"), not a session that has lapsed.
  async getSession(): Promise<AuthSession> {
    const result = await fetch('/api/auth/me');
    if (!result.ok) {
      return { user: null };
    }
    return await result.json();
  }

  async login(username: string, password: string): Promise<AuthUser> {
    const result = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await result.json() as { user?: AuthUser; error?: string };
    if (!result.ok || !data.user) {
      throw Error(data?.error || 'Could not sign in');
    }
    return data.user;
  }

  async logout(): Promise<void> {
    await fetch('/api/auth/logout', { method: 'POST' });
  }

  /**
   * Applies for an account. Plain `fetch` for the same reason the sign-in
   * uses one: it is called by somebody with no session, so a refusal is an
   * answer to show them rather than a session that has lapsed.
   *
   * Returns nothing - an application is not a way in, and there is nothing
   * here for the caller to mistake for one.
   */
  async register(username: string, password: string): Promise<void> {
    const result = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await result.json() as { ok?: boolean; error?: string };
    if (!result.ok || !data.ok) {
      throw Error(data?.error || 'Could not send the application');
    }
  }

  /**
   * Where this account stands against its daily limits. Administrators come
   * back unlimited, so the caller can ask without knowing who is signed in.
   */
  async getQuota(): Promise<QuotaStatus> {
    const data = await readJSON(await apiFetch('/api/quota'));
    return data.quota as QuotaStatus;
  }

  async listUsers(): Promise<AuthUser[]> {
    const data = await readJSON(await apiFetch('/api/auth/users'));
    return data.users as AuthUser[];
  }

  async createUser(params: CreateUserRequest): Promise<AuthUser> {
    const data = await readJSON(await apiFetch('/api/auth/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    }));
    return data.user as AuthUser;
  }

  async updateUser(id: string, params: UpdateUserRequest): Promise<AuthUser> {
    const data = await readJSON(await apiFetch(`/api/auth/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    }));
    return data.user as AuthUser;
  }

  async deleteUser(id: string): Promise<void> {
    await readJSON(await apiFetch(`/api/auth/users/${id}`, { method: 'DELETE' }));
  }

  /** Lifts the ban the sign-in anomaly rule put on an account. */
  async unbanUser(id: string): Promise<AuthUser> {
    const data = await readJSON(await apiFetch(`/api/auth/users/${id}/unban`, {
      method: 'POST'
    }));
    return data.user as AuthUser;
  }

  async listRegistrations(): Promise<Registration[]> {
    const data = await readJSON(await apiFetch('/api/auth/registrations'));
    return data.registrations as Registration[];
  }

  /** Approving is what creates the account, and answers with it. */
  async approveRegistration(id: string): Promise<AuthUser> {
    const data = await readJSON(await apiFetch(`/api/auth/registrations/${id}/approve`, {
      method: 'POST'
    }));
    return data.user as AuthUser;
  }

  async rejectRegistration(id: string): Promise<void> {
    await readJSON(await apiFetch(`/api/auth/registrations/${id}`, { method: 'DELETE' }));
  }

  /**
   * The most recent sign-ins, newest first, successful and failed alike.
   * Given a user id, only that account's - failed attempts in its name
   * included.
   *
   * Slower than the other listings when it runs into addresses the server has
   * not placed before, since it looks those up as it answers. Asked for on its
   * own, when somebody opens the panel, rather than with the user table.
   */
  async listLoginLog(limit = 10, userId?: string): Promise<LoginLogEntry[]> {
    const urlObj = new URL('/api/auth/login-log', window.location.href);
    urlObj.searchParams.set('limit', String(limit));
    if (userId) {
      urlObj.searchParams.set('userId', userId);
    }
    const data = await readJSON(await apiFetch(urlObj.toString()));
    return data.entries as LoginLogEntry[];
  }

  /**
   * Where this account had got to in a video, or `null` - which is the answer
   * both for one never watched and for one watched long enough ago to have
   * dropped out of the entries the server keeps.
   */
  async getWatchedVideo(mediaId: string, postId?: string | null): Promise<WatchedVideo | null> {
    const urlObj = this.#historyVideoURL(mediaId, postId);
    const result = await apiFetch(urlObj.toString());
    if (!result.ok) {
      return null;
    }
    const data = await result.json() as { video: WatchedVideo | null };
    return data.video;
  }

  /**
   * `keepalive` lets the last report of a session outlive the page that sent
   * it, which is the only way the position survives a tab being closed
   * mid-video.
   */
  async recordWatchedVideo(
    mediaId: string,
    params: RecordWatchedVideoRequest,
    keepalive = false
  ): Promise<void> {
    await apiFetch(this.#historyVideoURL(mediaId, params.postId).toString(), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      keepalive
    });
  }

  /** The videos this account may resume, most recent first. */
  async listWatchedVideos(): Promise<WatchedVideoListItem[]> {
    const data = await readJSON(await apiFetch('/api/history/videos'));
    return data.videos as WatchedVideoListItem[];
  }

  async listViewedPosts(): Promise<ViewedPostListItem[]> {
    const data = await readJSON(await apiFetch('/api/history/posts'));
    return data.posts as ViewedPostListItem[];
  }

  async recordViewedPost(postId: string): Promise<void> {
    await apiFetch(`/api/history/posts/${encodeURIComponent(postId)}`, { method: 'PUT' });
  }

  /** The posts this account has saved, newest first. */
  async listFavorites(): Promise<FavoriteListItem[]> {
    const data = await readJSON(await apiFetch('/api/history/favorites'));
    return data.favorites as FavoriteListItem[];
  }

  /** Whether one post is among this account's saved posts. */
  async isFavorite(postId: string): Promise<boolean> {
    const data = await readJSON(await apiFetch(`/api/history/favorites/${encodeURIComponent(postId)}`));
    return !!data.favorite;
  }

  /**
   * Saves a post. Throws when the list is already full - the message on the
   * error is what the server said the ceiling is.
   */
  async addFavorite(postId: string): Promise<void> {
    await readJSON(await apiFetch(`/api/history/favorites/${encodeURIComponent(postId)}`, { method: 'PUT' }));
  }

  async removeFavorite(postId: string): Promise<void> {
    await readJSON(await apiFetch(`/api/history/favorites/${encodeURIComponent(postId)}`, { method: 'DELETE' }));
  }

  /**
   * The post is named in the query string as well as the body because the
   * permission check runs before the body is looked at - a linked attachment
   * has no row tying it to a campaign, and the post it hangs off is the only
   * thing that says which creator it belongs to.
   */
  #historyVideoURL(mediaId: string, postId?: string | null) {
    const urlObj = new URL(
      `/api/history/videos/${encodeURIComponent(mediaId)}`,
      window.location.href
    );
    if (postId) {
      urlObj.searchParams.set('lapid', postId);
    }
    return urlObj;
  }

  async getTranscriptionAvailability(): Promise<TranscriptionAvailability> {
    return await readJSON(await apiFetch('/api/transcription/status')) as TranscriptionAvailability;
  }

  async getTranscriptionSettings(): Promise<TranscriptionSettings> {
    const data = await readJSON(await apiFetch('/api/transcription/settings'));
    return data.settings as TranscriptionSettings;
  }

  /**
   * Saves the settings and returns them as they now stand.
   *
   * Passing an empty `apiKey` clears the stored one. Omitting the field
   * entirely leaves it alone, which is how the model can be changed without
   * having to type the key again.
   */
  async saveTranscriptionSettings(params: {
    provider?: TranscriptionProvider;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
    geminiApiKey?: string;
    geminiModel?: string;
    geminiBaseUrl?: string;
    /** Empty turns the proxy off; Gemini is then reached directly. */
    geminiProxyUrl?: string;
    /** The vocabulary file, verbatim. Omitted leaves it alone. */
    vocabulary?: string;
  }): Promise<TranscriptionSettings> {
    const data = await readJSON(await apiFetch('/api/transcription/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    }));
    return data.settings as TranscriptionSettings;
  }

  async startTranscription(mediaId: string): Promise<TranscriptionRecord> {
    const data = await readJSON(await apiFetch(
      `/api/media/${mediaId}/transcribe`, { method: 'POST' }
    ));
    return data.record as TranscriptionRecord;
  }

  async cancelTranscription(mediaId: string): Promise<boolean> {
    const data = await readJSON(await apiFetch(
      `/api/media/${mediaId}/transcribe`, { method: 'DELETE' }
    ));
    return !!data.cancelled;
  }

  /** One video's transcription, at whatever stage it has reached. */
  async getTranscription(mediaId: string): Promise<TranscriptionRecord | null> {
    const data = await readJSON(await apiFetch(`/api/media/${mediaId}/transcription`));
    return (data.record || null) as TranscriptionRecord | null;
  }

  /** The whole transcription history, newest request first. */
  async listTranscriptions(): Promise<TranscriptionRecord[]> {
    const data = await readJSON(await apiFetch('/api/transcriptions'));
    return (data.records || []) as TranscriptionRecord[];
  }

  /**
   * Stops the running transcription and everything queued behind it. Records
   * are kept and marked cancelled - nothing is removed.
   */
  async stopAllTranscriptions(): Promise<TranscriptionRecord[]> {
    const data = await readJSON(await apiFetch('/api/transcriptions/stop', { method: 'POST' }));
    return (data.records || []) as TranscriptionRecord[];
  }

  /** Clears finished records. Anything queued or running is left alone. */
  async clearTranscriptionHistory(): Promise<TranscriptionRecord[]> {
    const data = await readJSON(await apiFetch('/api/transcriptions', { method: 'DELETE' }));
    return (data.records || []) as TranscriptionRecord[];
  }

  /** Forgets one record. The subtitle file it produced is left on disk. */
  async forgetTranscription(mediaId: string): Promise<void> {
    await readJSON(await apiFetch(`/api/transcriptions/${mediaId}`, { method: 'DELETE' }));
  }

  async getTranslationAvailability(): Promise<TranslationAvailability> {
    return await readJSON(await apiFetch('/api/translation/status')) as TranslationAvailability;
  }

  async getTranslationSettings(): Promise<TranslationSettings> {
    const data = await readJSON(await apiFetch('/api/translation/settings'));
    return data.settings as TranslationSettings;
  }

  /**
   * Saves the settings and returns them as they now stand.
   *
   * Passing an empty `apiKey` clears the stored one; omitting the field leaves
   * it alone. Passing an empty `prompt` puts the default prompt back.
   */
  async saveTranslationSettings(params: {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
    proxyUrl?: string;
    prompt?: string;
    batchCharacters?: number;
    batchLines?: number;
    disableThinking?: boolean;
    segmentation?: boolean;
    maxLineCjk?: number;
    maxLineLatin?: number;
  }): Promise<TranslationSettings> {
    const data = await readJSON(await apiFetch('/api/translation/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    }));
    return data.settings as TranslationSettings;
  }

  /**
   * Queues a translation of one video's transcription.
   *
   * Accepted while the transcription is still running, in which case it starts
   * as soon as there is a subtitle to translate.
   */
  async startTranslation(mediaId: string): Promise<TranscriptionRecord> {
    const data = await readJSON(await apiFetch(
      `/api/media/${mediaId}/translate`, { method: 'POST' }
    ));
    return data.record as TranscriptionRecord;
  }

  async cancelTranslation(mediaId: string): Promise<boolean> {
    const data = await readJSON(await apiFetch(
      `/api/media/${mediaId}/translate`, { method: 'DELETE' }
    ));
    return !!data.cancelled;
  }

  /** Stops the running translation and everything queued behind it. */
  async stopAllTranslations(): Promise<TranscriptionRecord[]> {
    const data = await readJSON(await apiFetch('/api/translations/stop', { method: 'POST' }));
    return (data.records || []) as TranscriptionRecord[];
  }

  /** Puts the running count of Gemini calls back to zero. */
  async resetTranslationRequestCount(): Promise<TranslationSettings> {
    const data = await readJSON(await apiFetch(
      '/api/translation/requests/reset', { method: 'POST' }
    ));
    return data.settings as TranslationSettings;
  }

  async getSubtitles(mediaId: string): Promise<SubtitleFile[]> {
    const data = await readJSON(await apiFetch(`/api/media/${mediaId}/subtitles`));
    return (data.subtitles || []) as SubtitleFile[];
  }

  /** URL of a subtitle as WebVTT, for a `<track>` element to load. */
  getSubtitleURL(mediaId: string, filename: string) {
    return `/api/media/${mediaId}/subtitles/${encodeURIComponent(filename)}`;
  }

  /**
   * The same file as text, for reading rather than for playing. The transcript
   * view parses it itself, which a `<track>` gives no way of doing.
   */
  async getSubtitleText(mediaId: string, filename: string): Promise<string> {
    const response = await apiFetch(this.getSubtitleURL(mediaId, filename));
    if (!response.ok) {
      throw Error('Could not read that subtitle file');
    }
    return await response.text();
  }

  #setPaginationParams(
    url: URL,
    params: {
      page?: number;
      itemsPerPage: number;
    }
  ) {
    if (params.page) {
      url.searchParams.append('p', String(params.page));
    }
    url.searchParams.append('n', String(params.itemsPerPage));
  }

  #setFilterParams<S extends FilterSearchParams>(url: URL, filter: Filter<S>) {
    filter.options.forEach(({searchParam: param, value}) => {
      if (value === null) {
        url.searchParams.delete(param);
      }
      else {
        url.searchParams.append(param, value);
      }
    });
  }
}

const APIContext = createContext({} as APIContextValue);

function APIProvider(props: APIProviderProps) {
  const { children } = props;

  return (
    <APIContext.Provider value={{ api: new API() }}>
      {children}
    </APIContext.Provider>
  );
};

const useAPI = () => useContext(APIContext);

export { useAPI, APIProvider };
