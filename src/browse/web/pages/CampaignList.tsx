import "../assets/styles/CampaignList.scss";
import "../assets/styles/Toolbar.scss";
import { useEffect, useReducer, useState } from "react";
import copy from 'fast-copy';
import deepEqual from "deep-equal";
import { useAPI } from "../contexts/APIProvider";
import { type CampaignList, type CampaignListSortBy } from "../../types/Campaign";
import { Container, Row, Col } from "react-bootstrap";
import { Select } from "antd";
import CampaignCard from "../components/CampaignCard";
import ShowingText from "../components/ShowingText";
import PageNav from "../components/PageNav";
import { useLocation, useSearchParams } from "react-router";
import { type BrowseSettings } from "../../types/Settings";
import { useBrowseSettings } from "../contexts/BrowseSettingsProvider";
import { useDocument } from "../contexts/DocumentProvider";
import { LoadingBlock, LoadingOverlay } from "../components/Loading";
import { readViewCache, writeViewCache } from "../utils/viewCache";
import { useLanguage } from "../contexts/LanguageProvider";

interface ViewParams {
  sortBy: CampaignListSortBy;
  page: number | null;
  itemsPerPage: number;
}

type ViewParamsValue = {
  [T in keyof ViewParams]?: ViewParams[T];
};

function getInitialViewParams(settings: BrowseSettings): ViewParams {
  return {
    sortBy: 'last_downloaded',
    page: null,
    itemsPerPage: settings.listItemsPerPage
  };
}

const viewParamsReducer = (
  currentParams: ViewParams,
  values: ViewParamsValue
) => {
  const newParams = copy(currentParams);
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

function CampaignList() {
  const { api } = useAPI();
  const { setTitle } = useDocument();
  const { settings } = useBrowseSettings();
  const { t } = useLanguage();
  const [viewParams, setViewParams] = useReducer(viewParamsReducer, getInitialViewParams(settings));
  const location = useLocation();
  const cacheKey = `campaign-list:${location.key}`;
  const [list, setList] = useState<CampaignList | null>(
    () => readViewCache<CampaignList>(cacheKey)?.data ?? null
  );
  const [loading, setLoading] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    setTitle(t('nav_home'));
  }, [setTitle, t]);

  useEffect(() => {
    const { sortBy, page } = viewParams;
    if (sortBy === null || page === null) {
      return;
    }
    const signature = JSON.stringify(viewParams);
    const cached = readViewCache<CampaignList>(cacheKey);
    if (cached?.signature === signature) {
      // Same history entry, same parameters: a back navigation onto a list we
      // already hold, so keep it instead of fetching it again.
      setList(cached.data);
      setLoading(false);
      return;
    }
    const abortController = new AbortController();
    setLoading(true);
    void (async () => {
      try {
        const _list = await api.getCampaignList({
          ...viewParams,
          sortBy,
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
  }, [api, viewParams, cacheKey]);

  useEffect(() => {
    const page = Number(searchParams.get('p')) || 1;
    setViewParams({ page });
  }, [searchParams]);

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
    if (list && list.campaigns.length === 0 && list.total > 0) {
      // Most likely page is out of range. If so go to the first page.
      gotoPage(1, true);
    }
  }, [list, gotoPage]);

  if (!list) {
    return <LoadingBlock className="mt-5" minHeight="60vh" />;
  }

  return (
    <Container fluid>
      <Row className="g-0 justify-content-center">
        <Col md={10} sm={12} className={`campaign-list mw-${settings.maxContentWidth.toLowerCase()}`}>
          <h2 className="my-4">{t('creators_heading')}</h2>
          <Container fluid className="p-0">
            <Row className="mb-2 g-0 justify-content-center align-items-center">
              <Col className="w-auto flex-fill">
                { viewParams.page ? <ShowingText
                  total={list.total}
                  page={viewParams.page}
                  itemsPerPage={viewParams.itemsPerPage}
                  subject={{
                    singular: t('subject_creator'),
                    plural: t('subject_creators')
                  }} /> : null }
              </Col>
              <Col className="w-auto d-flex justify-content-end">
                <Select
                  className="content-toolbar__sort"
                  aria-label={t('sort')}
                  value={viewParams.sortBy}
                  onChange={(sortBy: CampaignListSortBy) => setViewParams({ sortBy })}
                  options={[
                    { value: 'a-z', label: 'A-Z' },
                    { value: 'z-a', label: 'Z-A' },
                    { value: 'most_media', label: t('sort_most_media') },
                    { value: 'most_content', label: t('sort_most_content') },
                    { value: 'last_downloaded', label: t('sort_last_downloaded') }
                  ]}
                />
              </Col>
            </Row>
          </Container>
          <LoadingOverlay loading={loading} className="mb-4">
            <div className="campaign-list__grid">
              {
                list.campaigns.map((campaign) => (
                  <CampaignCard key={`campaign-card-${campaign.id}`} campaign={campaign} />
                ))
              }
            </div>
          </LoadingOverlay>
          <PageNav
            total={list.total}
            current={viewParams.page || 1}
            itemsPerPage={viewParams.itemsPerPage}
            onChange={gotoPage}
            disabled={loading}
          />
        </Col>
      </Row>
    </Container>
  )
}
export default CampaignList;
