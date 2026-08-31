import "../assets/styles/CampaignContent.scss";
import "../assets/styles/Toolbar.scss";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useAPI } from "../contexts/APIProvider";
import { Container, Row, Card, Stack } from "react-bootstrap";
import ShowingText from "../components/ShowingText";
import { type ContentType, type ContentList } from "../../types/Content";
import { NavigationType, useLocation, useNavigationType, useOutletContext, useParams, useSearchParams } from "react-router";
import PostCard from "../components/PostCard";
import PageNav from "../components/PageNav";
import deepEqual from "deep-equal";
import copy from 'fast-copy';
import { type BrowseSettings, type PostListLayout } from "../../types/Settings";
import { useBrowseSettings } from "../contexts/BrowseSettingsProvider";
import { type Filter, type FilterData, type PostFilterSearchParams } from "../../types/Filter";
import FilterModalButton from "../components/FilterModalButton";
import ProductList from "../components/ProductList";
import PostGrid from "../components/PostGrid";
import PostList from "../components/PostList";
import PostLayoutSwitch from "../components/PostLayoutSwitch";
import SearchInputBox, { type SearchInputBoxHandle } from "../components/SearchInputBox";
import { type Collection } from "../../../entities/Post";
import { useDocument } from "../contexts/DocumentProvider";
import { type CampaignLayoutOutletContext } from "../layouts/CampaignLayout";
import { type Campaign } from "../../../entities";
import { LoadingBlock, LoadingOverlay } from "../components/Loading";
import { readViewCache, writeViewCache } from "../utils/viewCache";
import { useLanguage } from "../contexts/LanguageProvider";

interface CampaignContentProps<T extends ContentType> {
  type: T;
  collection?: T extends 'post' ? (boolean | undefined) : undefined;
}

interface ViewParams {
  filter: Filter<PostFilterSearchParams> | null;
  page: number | null;
  itemsPerPage: number;
}

type ViewParamsValues = {
  [T in keyof ViewParams]?: ViewParams[T];
};

function getInitialViewParams(settings: BrowseSettings): ViewParams {
  return {
    filter: null,
    page: null,
    itemsPerPage: settings.listItemsPerPage
  };
}

const viewParamsReducer = (
  currentParams: ViewParams,
  values: ViewParamsValues
) => {
  const newParams = copy(currentParams);
  if (values.filter !== undefined) {
    newParams.filter = values.filter;
  }
  if (values.page !== undefined) {
    newParams.page = values.page;
  }
  if (values.itemsPerPage !== undefined) {
    newParams.itemsPerPage = values.itemsPerPage;
  }
  return deepEqual(newParams, currentParams) ? currentParams : newParams;
};

function CampaignContent<T extends ContentType>(props: CampaignContentProps<T>) {
  const { type: contentType, collection: isCollection } = props;
  const [ contextQS, setContextQS ] = useState('');
  const [ campaign, setCampaign ] = useState<Campaign | null>(!isCollection ?
    useOutletContext<CampaignLayoutOutletContext>().campaign
    : null
  );
  const { id: collectionId } = isCollection ? useParams() : { id: null };

  const { api } = useAPI();
  const { setTitle } = useDocument();
  const { settings, updateSettings } = useBrowseSettings();
  const { t } = useLanguage();
  const [viewParams, setViewParams] = useReducer(viewParamsReducer, getInitialViewParams(settings));
  const [collection, setCollection] = useState<Collection | null>(null);
  const location = useLocation();
  const cacheKey = `campaign-content:${location.key}`;
  const [list, setList] = useState<ContentList<T> | null>(
    () => readViewCache<ContentList<T>>(cacheKey)?.data ?? null
  );
  const [loading, setLoading] = useState(false);
  const [filterOptions, setFilterOptions] = useState<FilterData<PostFilterSearchParams> | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const navigationType = useNavigationType();
  const isFirstLoadRef = useRef(true);
  const searchInputBoxRef = useRef<SearchInputBoxHandle>(null);
  
  let subject: { singular: string; plural: string };
  let searchInputBoxPlaceholder: string;
  switch (contentType) {
    case 'post':
      subject = { singular: t('subject_post'), plural: t('subject_posts') };
      searchInputBoxPlaceholder = t('search_posts');
      break;
    case 'product':
    default:
      subject = { singular: t('subject_product'), plural: t('subject_products') };
      searchInputBoxPlaceholder = t('search_products');
      break;
  }
  if (contentType === 'post' && isCollection) {
    const w = t('in_collection');
    subject.singular += w;
    subject.plural += w;
    searchInputBoxPlaceholder += w;
  }
  const withStrParts: string[] = [];
  const q = viewParams.filter?.options.find((opt) => opt.searchParam === 'search')?.value?.trim();
  if (q) {
    withStrParts.push(t('with_query', { query: q }));
  }
  const tag = viewParams.filter?.options.find((opt) => opt.searchParam === 'tag_id')?.value?.trim();
  if (tag) {
    let tagLabel = tag;
    if (tag.startsWith('user_defined;')) {
      tagLabel = tag.substring('user_defined;'.length);
    }
    if (tagLabel) {
      withStrParts.push(t('tagged_query', { tag: tagLabel }));
    }
  }
  if (withStrParts.length > 0) {
    const w = withStrParts.join(t('separator_and'));
    subject.singular += ` ${w}`;
    subject.plural += ` ${w}`;
  }

  useEffect(() => {
    if (!collectionId) {
      setCollection(null);
      return;
    }
    const abortController = new AbortController();
    void (async () => {
      try {
        const found = await api.getCollection(collectionId);
        const campaign = found ? await api.getCampaign({ id: found.campaignId }) : null;
        if (!abortController.signal.aborted) {
          setCollection(found?.collection || null);
          setCampaign(campaign);
        }
      }
      catch {
        // `getCampaign` now reports a server that did not answer by throwing.
        // The enclosing layout is loading the same creator and has somewhere
        // to say so; here there is nothing to add, and the page stays as it
        // was rather than raising an unhandled rejection.
      }
    })();

    return () => abortController.abort();
  }, [api, collectionId]);

  useEffect(() => {
    if (!campaign) {
      setFilterOptions(null);
      return;
    }
    setFilterOptions(null);
    const abortController = new AbortController();
    void (async () => {
      const options = await api.getContentFilterOptions(campaign.id, contentType);
      if (!abortController.signal.aborted) {
        setFilterOptions(options);
      }
    })();

    return () => abortController.abort();
  }, [api, campaign, contentType]);

  useEffect(() => {
    const parts: string[] = [];
    if (isCollection && collection) {
      if (collection.title) {
        parts.push(collection.title);
      }
      if (campaign?.name) {
        parts.push(t('collection_from', { name: campaign.name }));
      }
      if (collection.numPosts !== null) {
        parts.push(t('posts_count', { count: collection.numPosts }));
      }
      setTitle(parts.join(' | '));
    }
  }, [setTitle, isCollection, collection, campaign, t]);

  const gotoPage = useCallback((page: number, replaceState = false) => {
    setSearchParams((/*prev*/) => {
      // Do not use "prev" passed by setSearchParams, as it can be
      // stale, unless we set the method as a dependency (which will
      // in turn cause ContentFilterButton to needlessly re-render,
      // with filter re-applied, etc.).
      const params = new URLSearchParams(window.location.search);
      params.set('p', String(page));
      return params;
    }, { replace: replaceState });
  }, []);

  // Reset first load status on browser back so page won't get reset to 1
  // on applying filter
  useEffect(() => {
    if (navigationType === NavigationType.Pop) {
      isFirstLoadRef.current = true;
    }
  }, [navigationType]);

  useEffect(() => {
    const { filter, page } = viewParams;
    const cached = readViewCache<ContentList<T>>(cacheKey);
    if (!campaign || !filter || page === null || (isCollection && !collection)) {
      if (cached) {
        // Back navigation: the cached list is already on screen. Hold it while
        // the filter re-applies rather than blanking the page under a spinner.
        setLoading(false);
      }
      else {
        setList(null);
        // Nothing to show and nothing settled yet - the filter is still being
        // applied - so keep the spinner up rather than flashing an empty view.
        setLoading(true);
      }
      return;
    }
    const signature = JSON.stringify({
      viewParams,
      campaignId: campaign.id,
      contentType,
      collectionId: collection?.id
    });
    if (cached?.signature === signature) {
      // Same history entry, same parameters - see `viewCache`.
      setList(cached.data);
      setLoading(false);
      return;
    }
    const abortController = new AbortController();
    setLoading(true);
    void (async () => {
      try {
        const _list = await api.getContentList({
          campaign,
          type: contentType,
          ...viewParams,
          collectionId: collection?.id,
          filter,
          page
        });
        if (!abortController.signal.aborted) {
          writeViewCache(cacheKey, signature, _list);
          setList(_list);
        }
      }
      finally {
        if (!abortController.signal.aborted) {
          setLoading(false);
        }
      }
    })();

    return () => abortController.abort();
  }, [api, campaign, contentType, isCollection, collection, viewParams, cacheKey]);

  useEffect(() => {
    const page = Number(searchParams.get('p')) || 1;
    setViewParams({ page });
  }, [searchParams]);

  const applyFilter = useCallback((filter: Filter<PostFilterSearchParams>) => {
    if (isFirstLoadRef.current) {
      isFirstLoadRef.current = false;
      setViewParams({ filter });
    }
    else {
      setViewParams({ filter, page: 1 });
    }
  }, []);

  useEffect(() => {
    setViewParams({
      itemsPerPage: settings.listItemsPerPage
    });
  }, [settings.listItemsPerPage]);

  useEffect(() => {
    if (list && list.items.length === 0 && list.total > 0) {
      // Most likely page is out of range. If so go to the first page.
      gotoPage(1, true);
    }
  }, [list, gotoPage]);

  // Keep the 'p' param in URL in sync with viewParams.page.
  // Mismatch can happen in applyFilter where reset viewParams.page
  // following a change in the content filter.
  useEffect(() => {
    if (viewParams.page === null) {
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const p = Number(params.get('p')) || 1;
    if (p !== viewParams.page) {
      gotoPage(viewParams.page, true);
    }
  }, [viewParams, gotoPage]);

  useEffect(() => {
    if (isCollection && !collection) {
      setContextQS('');
      return;
    }
    const filter = viewParams.filter;
    const params = new URLSearchParams();
    const collectionId = isCollection ? collection?.id : undefined;
    if (collectionId) {
      params.set('collection_id', collectionId);
    }
    if (filter) {
      for (const { searchParam, value } of filter.options) {
        if (value) {
          params.set(searchParam, value);
        }
      }
    }
    setContextQS(params.toString());
  }, [viewParams.filter, isCollection, collection]);

  const postListLayout = settings.postListLayout;

  const setPostListLayout = useCallback((layout: PostListLayout) => {
    updateSettings({ postListLayout: layout });
  }, [updateSettings]);

  const listEl = useMemo(() => {
    if (!list || list.items.length === 0) {
      return null;
    }
    if (list.items.every((item) => item.type === 'post')) {
      const posts = (list as ContentList<'post'>).items;
      switch (postListLayout) {
        case 'grid':
          return <PostGrid posts={posts} contextQS={contextQS} />;
        case 'list':
          return <PostList posts={posts} contextQS={contextQS} />;
        default:
          return (
            <Stack className="mb-4" gap={4}>
              {
                posts.map((item) => (
                  <PostCard
                    key={`post-card-${item.id}`}
                    post={item}
                    useShowMore
                    contextQS={contextQS}
                  />
                ))
              }
            </Stack>
          );
      }
    }
    if (list.items.every((item) => item.type === 'product')) {
      return (
        <ProductList products={(list as ContentList<'product'>).items} />
      )
    }
    return null;
  }, [list, contextQS, postListLayout]);

  if (!campaign || !filterOptions) {
    return <LoadingBlock className="mt-5" minHeight="60vh" />;
  }

  return (
    <div className={
      `campaign-content campaign-content--${contentType} ` +
      `campaign-content--layout-${contentType === 'post' ? postListLayout : 'card'} ` +
      `mw-${settings.maxContentWidth.toLowerCase()}`
    }>
      <Container fluid className="p-0">
        <div className="content-toolbar">
          <div className="content-toolbar__group">
            <FilterModalButton
              options={filterOptions}
              onFilter={applyFilter}
              searchInputBox={searchInputBoxRef}
            />
          </div>
          <div className="content-toolbar__group">
            <SearchInputBox ref={searchInputBoxRef} placeholder={searchInputBoxPlaceholder} />
            {
              contentType === 'post' ? (
                <PostLayoutSwitch value={postListLayout} onChange={setPostListLayout} />
              ) : null
            }
          </div>
        </div>
        <Row className="mb-2 g-0">
          {list && list.items.length > 0 && viewParams.page ? <ShowingText
            total={list.total}
            page={viewParams.page}
            itemsPerPage={viewParams.itemsPerPage}
            subject={subject}/> : null}
        </Row>
      </Container>
      <LoadingOverlay loading={loading} minHeight={!list ? '16em' : undefined}>
        {listEl}
        {
          list && list.items.length === 0 ? (
            <Card className="my-4" style={{ height: "10em" }}>
              <Card.Body className="d-flex justify-content-center align-items-center">
                No {contentType === 'post' ? t('subject_posts') : t('subject_products')}
              </Card.Body>
            </Card>
          ) : null
        }
      </LoadingOverlay>
      {list ? <PageNav
        total={list.total}
        current={viewParams.page || 1}
        itemsPerPage={viewParams.itemsPerPage}
        onChange={gotoPage}
        disabled={loading}
      /> : null}
    </div>
  )
}

export default CampaignContent;
