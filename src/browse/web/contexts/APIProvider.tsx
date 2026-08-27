import { createContext, useContext } from 'react';
import { type CampaignList, type CampaignListSortBy, type CampaignWithCounts } from '../../types/Campaign';
import { type ContentType, type ContentList, type PostWithComments, type CollectionListSortBy, type CollectionList, type PostTagList } from '../../types/Content';
import { type Campaign, type Product } from '../../../entities';
import { type BrowseSettings, type BrowseSettingOptions as BrowseSettingOptions } from '../../types/Settings';
import { type Filter, type FilterSearchParams, type FilterData, type MediaFilterSearchParams, type PostFilterSearchParams } from '../../types/Filter';
import { type MediaList } from '../../types/Media';
import { type Collection } from '../../../entities/Post';
import { type AuthSession, type AuthUser, type CreateUserRequest, type UpdateUserRequest } from '../../types/Auth';
import { type SubtitleFile, type TranscriptionAvailability, type TranscriptionRecord, type TranscriptionSettings } from '../../types/Transcription';

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
  }): Promise<CampaignWithCounts>
  async getCampaign(params: {
    id: string;
    vanity?: never;
    withCounts?: false;
  } | {
    id?: never;
    vanity: string;
    withCounts?: false;
  }): Promise<Campaign>
  async getCampaign(params: {
    id: string;
    vanity?: never;
    withCounts?: boolean;
  } | {
    id?: never;
    vanity: string;
    withCounts?: boolean;
  }): Promise<Campaign | CampaignWithCounts>
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
    return await result.json();
  }

  async getProduct(id: string): Promise<Product | null> {
    const urlObj = new URL(`/api/products/${id}`, window.location.href);
    const result = await apiFetch(urlObj.toString());
    return await result.json();
  }

  async getCollection(id: string): Promise<{ collection: Collection; campaignId: string; }> {
    const urlObj = new URL(`/api/collections/${id}`, window.location.href);
    const result = await apiFetch(urlObj.toString());
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
    apiKey?: string;
    model?: string;
    baseUrl?: string;
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

  async getSubtitles(mediaId: string): Promise<SubtitleFile[]> {
    const data = await readJSON(await apiFetch(`/api/media/${mediaId}/subtitles`));
    return (data.subtitles || []) as SubtitleFile[];
  }

  /** URL of a subtitle as WebVTT, for a `<track>` element to load. */
  getSubtitleURL(mediaId: string, filename: string) {
    return `/api/media/${mediaId}/subtitles/${encodeURIComponent(filename)}`;
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
