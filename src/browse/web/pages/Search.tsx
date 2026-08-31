import "../assets/styles/Search.scss";
import { useCallback, useEffect, useState } from "react";
import { Empty, Input, Select } from "antd";
import { useSearchParams } from "react-router";
import { useAPI } from "../contexts/APIProvider";
import { useBrowseSettings } from "../contexts/BrowseSettingsProvider";
import { useDocument } from "../contexts/DocumentProvider";
import { LoadingOverlay } from "../components/Loading";
import PostList from "../components/PostList";
import PageNav from "../components/PageNav";
import ShowingText from "../components/ShowingText";
import { useLanguage } from "../contexts/LanguageProvider";
import { type ContentList, type ContentListSortBy } from "../../types/Content";

type SearchSortBy = ContentListSortBy | 'best_match';

const SORT_VALUES: SearchSortBy[] = [ 'best_match', 'latest', 'oldest', 'a-z', 'z-a' ];

function getSortOptions(t: ReturnType<typeof useLanguage>['t']): { value: SearchSortBy; label: string; }[] {
  return [
    { value: 'best_match', label: t('sort_best_match') },
    { value: 'latest', label: t('sort_latest') },
    { value: 'oldest', label: t('sort_oldest') },
    { value: 'a-z', label: 'A-Z' },
    { value: 'z-a', label: 'Z-A' }
  ];
}

/**
 * Posts from every creator, by search term.
 *
 * The query, the page and the order all live in the URL rather than in state,
 * so a result set can be linked to and the back button steps through searches
 * the way it steps through anything else. The box below is only what has been
 * typed since; it becomes the query on submit, not on every keystroke - each
 * one would be a full-text query across the library.
 */
function Search() {
  const { api } = useAPI();
  const { setTitle } = useDocument();
  const { settings } = useBrowseSettings();
  const { t } = useLanguage();
  const [ searchParams, setSearchParams ] = useSearchParams();

  const query = (searchParams.get('q') || '').trim();
  const page = Number(searchParams.get('p')) || 1;
  const sortParam = searchParams.get('sort');
  const sortBy: SearchSortBy = SORT_VALUES.includes(sortParam as SearchSortBy) ?
    sortParam as SearchSortBy :
    'best_match';
  const itemsPerPage = settings.listItemsPerPage;

  const [ input, setInput ] = useState(query);
  const [ list, setList ] = useState<ContentList<'post'> | null>(null);
  const [ loading, setLoading ] = useState(false);
  const [ error, setError ] = useState<string | null>(null);

  useEffect(() => {
    setTitle(query ? `${t('nav_search')} - ${query}` : t('nav_search'));
  }, [ setTitle, query, t ]);

  // Arriving on a link with ?q= already set, or stepping back onto an earlier
  // search, should put that query in the box rather than leave it stale.
  useEffect(() => { setInput(query); }, [ query ]);

  useEffect(() => {
    if (!query) {
      setList(null);
      setError(null);
      return;
    }
    const abortController = new AbortController();
    setLoading(true);
    void (async () => {
      try {
        const result = await api.searchPosts({ search: query, sortBy, page, itemsPerPage });
        if (!abortController.signal.aborted) {
          setList(result);
          setError(null);
        }
      }
      catch (e) {
        if (!abortController.signal.aborted) {
          setError(e instanceof Error ? e.message : 'Search failed');
          setList(null);
        }
      }
      finally {
        if (!abortController.signal.aborted) {
          setLoading(false);
        }
      }
    })();

    return () => abortController.abort();
  }, [ api, query, sortBy, page, itemsPerPage ]);

  /**
   * A new query, or a new order, starts at page one - staying on page 7 of a
   * result set that no longer exists just shows an empty page.
   */
  const updateParams = useCallback((values: { q?: string; sort?: SearchSortBy; p?: number; }) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (values.q !== undefined) {
        if (values.q) {
          next.set('q', values.q);
        }
        else {
          next.delete('q');
        }
      }
      if (values.sort !== undefined) {
        next.set('sort', values.sort);
      }
      if (values.p !== undefined) {
        next.set('p', String(values.p));
      }
      else {
        next.delete('p');
      }
      return next;
    });
  }, [ setSearchParams ]);

  const gotoPage = useCallback((p: number) => updateParams({ p }), [ updateParams ]);

  return (
    <div className={`search mw-${settings.maxContentWidth.toLowerCase()}`}>
      <h2 className="search__heading">{t('search_heading')}</h2>
      <div className="search__controls">
        <Input.Search
          className="search__input"
          size="large"
          allowClear
          autoFocus
          placeholder={t('search_placeholder')}
          value={input}
          enterButton={t('search_button')}
          onChange={(e) => setInput(e.target.value)}
          // Takes the value from the event: clearing the box fires this in the
          // same tick as the change, before state has caught up.
          onSearch={(value) => updateParams({ q: value.trim() })}
        />
        <Select<SearchSortBy>
          className="search__sort"
          size="large"
          aria-label={t('search_order_aria')}
          value={sortBy}
          onChange={(sort) => updateParams({ sort })}
          options={getSortOptions(t)}
        />
      </div>
      {
        !query ? (
          <Empty
            className="search__empty"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={t('search_empty_prompt')}
          />
        ) : (
          <>
            {
              list && list.total > 0 ? (
                <div className="search__showing">
                  <ShowingText
                    total={list.total}
                    page={page}
                    itemsPerPage={itemsPerPage}
                    subject={{ singular: t('subject_post'), plural: t('subject_posts') }}
                  />
                </div>
              ) : null
            }
            <LoadingOverlay loading={loading} minHeight={!list ? '16em' : undefined}>
              {
                error ? (
                  <Empty
                    className="search__empty"
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description={error}
                  />
                ) : list && list.items.length > 0 ? (
                  <PostList posts={list.items} showCampaign />
                ) : list ? (
                  <Empty
                    className="search__empty"
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description={t('search_nothing', { query })}
                  />
                ) : null
              }
            </LoadingOverlay>
            {
              list ? (
                <PageNav
                  total={list.total}
                  current={page}
                  itemsPerPage={itemsPerPage}
                  onChange={gotoPage}
                  disabled={loading}
                />
              ) : null
            }
          </>
        )
      }
    </div>
  );
}

export default Search;
