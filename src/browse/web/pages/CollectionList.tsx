import "../assets/styles/CollectionList.scss";
import { useCallback, useEffect, useReducer, useState } from "react";
import copy from 'fast-copy';
import deepEqual from "deep-equal";
import { useAPI } from "../contexts/APIProvider";
import { type CollectionList, type CollectionListSortBy } from "../../types/Content";
import { Container, Row, Col, Form } from "react-bootstrap";
import CollectionCard from "../components/CollectionCard";
import ShowingText from "../components/ShowingText";
import PageNav from "../components/PageNav";
import { useOutletContext, useSearchParams } from "react-router";
import { useScroll } from "../contexts/MainContentScrollProvider";
import { type BrowseSettings } from "../../types/Settings";
import { useBrowseSettings } from "../contexts/BrowseSettingsProvider";
import SearchInputBox from "../components/SearchInputBox";
import { type CampaignLayoutOutletContext } from "../layouts/CampaignLayout";
import { LoadingBlock, LoadingOverlay } from "../components/Loading";

interface ViewParams {
  search: string;
  sortBy: CollectionListSortBy;
  page: number | null;
  itemsPerPage: number;
}

type ViewParamsValue = {
  [T in keyof ViewParams]?: ViewParams[T];
};

function getInitialViewParams(settings: BrowseSettings): ViewParams {
  return {
    search: '',
    sortBy: 'last_updated',
    page: null,
    itemsPerPage: settings.listItemsPerPage
  };
}

const viewParamsReducer = (
  currentParams: ViewParams,
  values: ViewParamsValue
) => {
  const newParams = copy(currentParams);
  if (values.search !== undefined) {
    newParams.search = values.search;
  }
  if (values.sortBy !== undefined) {
    newParams.sortBy = values.sortBy;
  }
  if (values.page !== undefined) {
    newParams.page = values.page;
  }
  if (values.itemsPerPage !== undefined) {
    newParams.itemsPerPage = values.itemsPerPage;
  }
  return deepEqual(newParams, currentParams) ? currentParams : newParams;
};

function CollectionList() {
  const { api } = useAPI();
  const { settings } = useBrowseSettings();
  const { scrollTo } = useScroll();
  const [viewParams, setViewParams] = useReducer(viewParamsReducer, getInitialViewParams(settings));
  const [list, setList] = useState<CollectionList | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const { campaign } = useOutletContext<CampaignLayoutOutletContext>();

  const search = useCallback((value: string) => {
    setViewParams({
      search: value
    });
  }, []);

  useEffect(() => {
    const { sortBy, page } = viewParams;
    if (!campaign || sortBy === null || page === null) {
      return;
    }
    const abortController = new AbortController();
    setLoading(true);
    void (async () => {
      try {
        const _list = await api.getCollectionList({
          ...viewParams,
          campaign: campaign.id,
          sortBy,
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
  }, [api, viewParams]);

  useEffect(() => {
    const page = Number(searchParams.get('p')) || 1;
    setViewParams({ page });
    scrollTo(0, 0);
  }, [searchParams, scrollTo]);

  useEffect(() => {
    setViewParams({
      itemsPerPage: settings.listItemsPerPage
    })
  }, [settings.listItemsPerPage]);

  const gotoPage = (page: number, replaceState = false) => {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      params.set('p', String(page));
      return params;
    }, { replace: replaceState });
  }

  useEffect(() => {
    if (list && list.collections.length === 0 && list.total > 0) {
      // Most likely page is out of range. If so go to the first page.
      gotoPage(1, true);
    }
  }, [list, gotoPage]);

  if (!list) {
    return <LoadingBlock className="mt-5" minHeight="60vh" />;
  }

  const subject = {
    singular: 'collection',
    plural: 'collections'
  };
  if (viewParams.search) {
    const w = ` with "${viewParams.search}"`;
    subject.singular += w;
    subject.plural += w;
  }

  return (
    <Container fluid>
      <Row className="g-0 justify-content-center">
        <Col md={10} sm={12} className={`collection-list mw-${settings.maxContentWidth.toLowerCase()}`}>
          <Container fluid className="p-0">
            <Row className="mb-3 g-0 justify-content-center align-items-center">
              <Col className="w-auto flex-fill">
                <SearchInputBox
                  placeholder="Search collections"
                  onConfirm={search}
                />
              </Col>
            </Row>
            <Row className="mb-2 g-0 justify-content-center align-items-center">
              <Col className="w-auto flex-fill">
                { viewParams.page && <ShowingText
                  total={list.total}
                  page={viewParams.page}
                  itemsPerPage={viewParams.itemsPerPage}
                  subject={subject} /> }
              </Col>
              <Col className="w-auto d-flex justify-content-end">
                <Form.Select
                  size="sm"
                  className="w-auto"
                  onChange={(e) => setViewParams({ sortBy: e.currentTarget.value as any })}
                >
                  <option value="a-z" selected={viewParams.sortBy === 'a-z'}>A-Z</option>
                  <option value="z-a" selected={viewParams.sortBy === 'z-a'}>Z-A</option>
                  <option value="last_created" selected={viewParams.sortBy === 'last_created'}>Last created</option>
                  <option value="last_updated" selected={viewParams.sortBy === 'last_updated'}>Last updated</option>
                </Form.Select>
              </Col>
            </Row>
          </Container>
          <LoadingOverlay loading={loading} className="mb-4">
            {
              list.collections.map((collection) => (
                <CollectionCard key={`collection-card-${collection.id}`} collection={collection} />
              ))
            }
          </LoadingOverlay>
          <PageNav
            totalItems={list.total}
            itemsPerPage={viewParams.itemsPerPage}
            onChange={gotoPage}
            disabled={loading}
          />
        </Col>
      </Row>
    </Container>
  )
}
export default CollectionList;
