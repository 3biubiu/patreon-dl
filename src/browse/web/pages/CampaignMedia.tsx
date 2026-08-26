import "../assets/styles/Toolbar.scss";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useAPI } from "../contexts/APIProvider";
import { Container, Row, Card } from "react-bootstrap";
import ShowingText from "../components/ShowingText";
import { NavigationType, useNavigationType, useOutletContext, useSearchParams } from "react-router";
import PageNav from "../components/PageNav";
import deepEqual from "deep-equal";
import copy from 'fast-copy';
import { type MediaList } from "../../types/Media";
import { type Filter, type FilterData, type MediaFilterSearchParams } from "../../types/Filter";
import FilterModalButton from "../components/FilterModalButton";
import MediaGallery from "../components/MediaGallery";
import { type BrowseSettings } from "../../types/Settings";
import { useBrowseSettings } from "../contexts/BrowseSettingsProvider";
import { type CampaignLayoutOutletContext } from "../layouts/CampaignLayout";
import { LoadingBlock, LoadingOverlay } from "../components/Loading";

interface ViewParams {
  filter: Filter<MediaFilterSearchParams> | null;
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
    itemsPerPage: settings.galleryItemsPerPage,
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

function CampaignMedia() {
  const subject = { singular: 'media item', plural: 'media items' };
  const { api } = useAPI();
  const { settings } = useBrowseSettings();
  const [viewParams, setViewParams] = useReducer(viewParamsReducer, getInitialViewParams(settings));
  const { campaign } = useOutletContext<CampaignLayoutOutletContext>();
  const [list, setList] = useState<MediaList<any> | null>(null);
  const [loading, setLoading] = useState(false);
  const [filterOptions, setFilterOptions] = useState<FilterData<MediaFilterSearchParams> | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const navigationType = useNavigationType();
  const isFirstLoadRef = useRef(true);

  useEffect(() => {
    setFilterOptions(null);
    if (!campaign) {
      return;
    }
    const abortController = new AbortController();
    void (async () => {
      const options = await api.getMediaFilterOptions(campaign.id);
      if (!abortController.signal.aborted) {
        setFilterOptions(options);
      }
    })();

    return () => abortController.abort();
  }, [api, campaign]);

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
    if (!campaign || !filter || page === null) {
      // The filter has yet to be applied, so what is on screen - if anything -
      // does not answer to the current parameters. Keep the spinner up.
      setLoading(true);
      return;
    }
    const abortController = new AbortController();
    setLoading(true);
    void (async () => {
      try {
        const _list = await api.getMediaList({
          campaign,
          ...viewParams,
          filter,
          page
        });
        if (!abortController.signal.aborted) {
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
  }, [api, campaign, viewParams]);

  useEffect(() => {
    const page = Number(searchParams.get('p')) || 1;
    setViewParams({ page });
  }, [searchParams]);

  const applyFilter = useCallback((filter: Filter<MediaFilterSearchParams>) => {
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
      itemsPerPage: settings.galleryItemsPerPage
    });
  }, [settings.galleryItemsPerPage]);

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

  if (!campaign || !filterOptions) {
    return <LoadingBlock className="mt-5" minHeight="60vh" />;
  }

  return (
    <div className="w-100">
      <Container fluid className="p-0">
        <div className="content-toolbar">
          <div className="content-toolbar__group">
            <FilterModalButton
              options={filterOptions}
              onFilter={applyFilter}
            />
          </div>
        </div>
        <Row className="mb-2 g-0">
          { list && list.items.length > 0 && viewParams.page ? <ShowingText
            total={list.total}
            page={viewParams.page}
            itemsPerPage={viewParams.itemsPerPage}
            subject={subject} /> : null }
        </Row>
      </Container>
      <LoadingOverlay loading={loading} minHeight={!list ? '16em' : undefined}>
        {
          list && list.items.length > 0 ?
            <MediaGallery items={list.items} />
            : null
        }
        {
          list && list.items.length === 0 ? (
            <Card className="my-4" style={{ height: "10em" }}>
              <Card.Body className="d-flex justify-content-center align-items-center">
                No media
              </Card.Body>
            </Card>
          ) : null
        }
      </LoadingOverlay>
      { list ? <PageNav
        total={list.total}
        current={viewParams.page || 1}
        itemsPerPage={viewParams.itemsPerPage}
        onChange={gotoPage}
        disabled={loading}
      /> : null }
    </div>
  )
}

export default CampaignMedia;
