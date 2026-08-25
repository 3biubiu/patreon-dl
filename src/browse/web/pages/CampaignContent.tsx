import "../assets/styles/CampaignContent.scss";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useAPI } from "../contexts/APIProvider";
import { Container, Row, Col, Card, Stack } from "react-bootstrap";
import ShowingText from "../components/ShowingText";
import { type ContentType, type ContentList } from "../../types/Content";
import { NavigationType, useNavigationType, useOutletContext, useParams, useSearchParams } from "react-router";
import PostCard from "../components/PostCard";
import PageNav from "../components/PageNav";
import deepEqual from "deep-equal";
import copy from 'fast-copy';
import { useScroll } from "../contexts/MainContentScrollProvider";
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
  const { scrollTo } = useScroll();
  const [viewParams, setViewParams] = useReducer(viewParamsReducer, getInitialViewParams(settings));
  const [collection, setCollection] = useState<Collection | null>(null);
  const [list, setList] = useState<ContentList<T> | null>(null);
  const [filterOptions, setFilterOptions] = useState<FilterData<PostFilterSearchParams> | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const navigationType = useNavigationType();
  const isFirstLoadRef = useRef(true);
  const searchInputBoxRef = useRef<SearchInputBoxHandle>(null);
  
  let subject: { singular: string; plural: string };
  let searchInputBoxPlaceholder: string;
  switch (contentType) {
    case 'post':
      subject = { singular: 'post', plural: 'posts' };
      searchInputBoxPlaceholder = 'Search posts';
      break;
    case 'product':
    default:
      subject = { singular: 'product', plural: 'products' };
      searchInputBoxPlaceholder = 'Search products';
      break;
  }
  if (contentType === 'post' && isCollection) {
    const w = ' in collection';
    subject.singular += w;
    subject.plural += w;
    searchInputBoxPlaceholder += w;
  }
  const withStrParts: string[] = [];
  const q = viewParams.filter?.options.find((opt) => opt.searchParam === 'search')?.value?.trim();
  if (q) {
    withStrParts.push(`with "${q}"`);
  }
  const t = viewParams.filter?.options.find((opt) => opt.searchParam === 'tag_id')?.value?.trim();
  if (t) {
    let t2 = t;
    if (t.startsWith('user_defined;')) {
      t2 = t.substring('user_defined;'.length);
    }
    if (t2) {
      withStrParts.push(`tagged "${t2}"`);
    }
  }
  if (withStrParts.length > 0) {
    const w = withStrParts.join(' and ');
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
      const { collection, campaignId } = await api.getCollection(collectionId);
      const campaign = await api.getCampaign({ id: campaignId });
      if (!abortController.signal.aborted) {
        setCollection(collection);
        setCampaign(campaign);
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
        parts.push(`Collection from ${campaign.name}`);
      }
      if (collection.numPosts !== null) {
        parts.push(`${collection.numPosts} posts`);
      }
      setTitle(parts.join(' | '));
    }
  }, [setTitle, isCollection, collection, campaign]);

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
    if (!campaign || !filter || page === null || (isCollection && !collection)) {
      setList(null);
      return;
    }
    const abortController = new AbortController();
    void (async () => {
      const _list = await api.getContentList({
        campaign,
        type: contentType,
        ...viewParams,
        collectionId: collection?.id,
        filter,
        page
      });
      if (!abortController.signal.aborted) {
        setList(_list);
      }
    })();

    return () => abortController.abort();
  }, [api, campaign, contentType, isCollection, collection, viewParams]);

  useEffect(() => {
    const page = Number(searchParams.get('p')) || 1;
    setViewParams({ page });
    scrollTo(0, 0);
  }, [searchParams, scrollTo]);

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
    return;
  }

  return (
    <div className={
      `campaign-content campaign-content--${contentType} ` +
      `campaign-content--layout-${contentType === 'post' ? postListLayout : 'card'} ` +
      `mw-${settings.maxContentWidth.toLowerCase()}`
    }>
      <Container fluid className="p-0">
        <Row className="mb-3 g-0 align-items-center">
          <Col className="w-auto d-flex justify-content-end align-items-center">
            <SearchInputBox ref={searchInputBoxRef} placeholder={searchInputBoxPlaceholder} />
            <FilterModalButton
              options={filterOptions}
              onFilter={applyFilter}
              searchInputBox={searchInputBoxRef}
            />
            {
              contentType === 'post' ? (
                <PostLayoutSwitch value={postListLayout} onChange={setPostListLayout} />
              ) : null
            }
          </Col>
        </Row>
        <Row className="mb-2 g-0">
          {list && list.items.length > 0 && viewParams.page ? <ShowingText
            total={list.total}
            page={viewParams.page}
            itemsPerPage={viewParams.itemsPerPage}
            subject={subject}/> : null}
        </Row>
      </Container>
      {listEl}
      {
        list && list.items.length === 0 ? (
          <Card className="my-4" style={{ height: "10em" }}>
            <Card.Body className="d-flex justify-content-center align-items-center">
              No {contentType === 'post' ? 'posts' : 'products'}
            </Card.Body>
          </Card>
        ) : null
      }
      {list ? <PageNav
        totalItems={list.total}
        itemsPerPage={viewParams.itemsPerPage}
        onChange={gotoPage}
      /> : null}
    </div>
  )
}

export default CampaignContent;
