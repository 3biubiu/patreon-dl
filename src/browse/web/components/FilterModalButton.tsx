import "../assets/styles/FilterPanel.scss";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import copy from 'fast-copy';
import deepEqual from 'deep-equal';
import { type Filter, type FilterOption, type FilterSearchParams, type FilterSection, type FilterData } from "../../types/Filter";
import { Badge, Button, Drawer, Radio, Space, Tag } from "antd";
import { ClearOutlined, FilterOutlined } from "@ant-design/icons";
import { useSearchParams } from "react-router";
import { type SearchInputBoxHandle } from "./SearchInputBox";
import SortSelect from "./SortSelect";

interface FilterModalButtonProps<S extends FilterSearchParams> {
  options: FilterData<S>;
  onFilter: (filter: Filter<S>) => void;
  searchInputBox?: React.RefObject<SearchInputBoxHandle | null>;
}

/** Shown in the toolbar instead of inside the panel - see `SortSelect`. */
const SORT_PARAM = 'sort_by';

/** Has a box of its own in the toolbar, so it is not counted as a filter. */
const SEARCH_PARAM = 'search';

function getFilterValuesFromSearchParams<S extends FilterSearchParams>(searchParams: URLSearchParams): Filter<S>['options'] {
  const values: Filter<S>['options'] = [];
  for (const [p, v] of searchParams.entries()) {
    if (p.startsWith('filter_')) {
      const p2 = p.substring('filter_'.length);
      if (p2) {
        values.push({
          searchParam: p2 as S,
          value: v
        });
      }
    }
  }
  return values;
}

function getInitialFilterValues<S extends FilterSearchParams>(options: FilterData<S>) {
  const result: Filter<S>['options'] = [];
  for (const section of options.sections) {
    const defaultOption = section.options.find((option) => option.isDefault);
    const value = defaultOption?.value || null;
    result.push({
      searchParam: section.searchParam,
      value
    });
  }
  if (options.external) {
    for (const ext of options.external) {
      result.push({
        searchParam: ext.searchParam,
        value: null
      });
    }
  }
  return result;
}

function getSectionValue<S extends FilterSearchParams>(filter: Filter<S>, searchParam: S) {
  return filter.options.find((o) => o.searchParam === searchParam)?.value ?? null;
}

const contentFilterReducer = <S extends FilterSearchParams>(currentFilter: Filter<S> | null, options: Filter<S>['options']) => {
  if (currentFilter && options) {
    const result = copy(currentFilter);
    for (const option of options) {
      const ro = result.options.find((o) => o.searchParam === option.searchParam);
      if (ro) {
        ro.value = option.value;
      }
      else {
        result.options.push({...option})
      }
    }
    return deepEqual(currentFilter, result) ? currentFilter : result;
  }
  const newFilter = currentFilter ? { ...currentFilter, options } : { options };
  return deepEqual(currentFilter, newFilter) ? currentFilter : newFilter;
};

function FilterModalButton<S extends FilterSearchParams>(props: FilterModalButtonProps<S>) {
  const { options: filterOptions, onFilter, searchInputBox } = props;
  const [ searchParams, setSearchParams ] = useSearchParams();
  const [modalFilter, setModalFilterValues] = useReducer(contentFilterReducer, null);
  const [appliedFilter, setAppliedFilterValues] = useReducer(contentFilterReducer, null);
  const [panelOpen, setPanelOpen] = useState(false);
  const initialFilterValuesRef = useRef<Filter<S>['options'] | null>(null);

  useEffect(() => {
    if (!filterOptions) {
      return;
    }
    let initialValues: Filter<S>['options'] = [];
    initialValues = getInitialFilterValues(filterOptions);
    initialFilterValuesRef.current = copy(initialValues);
    const spValues = getFilterValuesFromSearchParams<S>(searchParams);
    for (const sp of spValues) {
      const v = initialValues.find((value) => value.searchParam === sp.searchParam);
      if (v) {
        v.value = sp.value;
      }
      else {
        initialValues.push(sp);
      }
    }
    setModalFilterValues(initialValues);
    setAppliedFilterValues(initialValues);
  }, [filterOptions, searchParams]);

  useEffect(() => {
    if (!searchInputBox?.current) {
      return;
    }
    const box = searchInputBox.current;
    box.onConfirm((value) => {
      setAppliedFilterValues([
        {searchParam: SEARCH_PARAM, value: value || null}
      ]);
    });

    return () => box.onConfirm(null);
  }, [searchInputBox]);

  useEffect(() => {
    const initialValues = initialFilterValuesRef.current;
    if (!appliedFilter || !initialValues) {
      return;
    }
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      for (const option of appliedFilter.options) {
        const paramName = `filter_${option.searchParam}`;
        const optionValue = option.value;
        const iv = initialValues.find((o) => o.searchParam === option.searchParam);
        if (optionValue && (iv === undefined || iv.value !== optionValue)) {
          params.set(paramName, optionValue);
        }
        else {
          params.delete(paramName);
        }
      }
      return params;
    });
    if (searchInputBox?.current) {
      const q = appliedFilter.options.find((opt) => opt.searchParam === SEARCH_PARAM)?.value || '';
      searchInputBox.current.setInput(q);
    }
  }, [searchInputBox, appliedFilter]);

  useEffect(() => {
    const initialValues = initialFilterValuesRef.current;
    if (appliedFilter && initialValues) {
      onFilter(copy(appliedFilter) as Filter<S>);
    }
  }, [appliedFilter, onFilter]);

  const setSectionValue = useCallback((searchParam: S, value: string | null) => {
    if (!modalFilter) {
      return;
    }
    const modalValue = modalFilter.options.find((mv) => mv.searchParam === searchParam);
    if (modalValue && modalValue.value !== value) {
      setModalFilterValues([{ searchParam, value }]);
    }
  }, [modalFilter]);

  const isSectionDisabled = useCallback((section: FilterSection<S>) => {
    if (!section.enableCondition || !modalFilter) {
      return false;
    }
    const { searchParam, condition, value } = section.enableCondition;
    const o = modalFilter.options.find((o) => o.searchParam === searchParam);
    if (o) {
      switch (condition) {
        case 'is':
          return o.value === value;
        case 'not':
          return o.value !== value;
      }
    }
    return undefined as never;
  }, [modalFilter])

  const sectionEls = useMemo(() => {
    if (!modalFilter || !filterOptions) {
      return null;
    }
    return filterOptions.sections
      // Sorting lives in the toolbar now, and a section its condition rules
      // out has nothing to offer.
      .filter((section) => section.searchParam !== SORT_PARAM && !isSectionDisabled(section))
      .map((section) => {
        const currentValue = getSectionValue(modalFilter, section.searchParam);
        let mainContentEl: React.ReactElement;
        switch (section.displayHint) {
          case 'list': {
            mainContentEl = (
              <Radio.Group
                value={currentValue ?? ''}
                onChange={(e) => setSectionValue(section.searchParam, e.target.value || null)}
              >
                <Space direction="vertical" size={8}>
                  {
                    section.options.map((option: FilterOption) => (
                      <Radio
                        key={`${section.searchParam}:${option.value}`}
                        value={option.value ?? ''}
                      >
                        {option.title}
                      </Radio>
                    ))
                  }
                </Space>
              </Radio.Group>
            );
            break;
          }
          case 'pill':
          case 'pill_small':
          default: {
            mainContentEl = (
              <Space size={[8, 8]} wrap>
                {
                  section.options.map((option: FilterOption) => {
                    const checked = currentValue === option.value;
                    return (
                      <Tag.CheckableTag
                        key={`${section.searchParam}:${option.value}`}
                        className="filter-panel__pill"
                        checked={checked}
                        // Picking the selected pill again clears the section.
                        onChange={() => setSectionValue(
                          section.searchParam, checked ? null : option.value
                        )}
                      >
                        {option.title}
                      </Tag.CheckableTag>
                    );
                  })
                }
              </Space>
            );
            break;
          }
        }
        return (
          <div
            key={`filter-panel-section-${section.searchParam}`}
            className="filter-panel__section"
          >
            {
              section.title ? (
                <div className="filter-panel__section-title">{section.title}</div>
              ) : null
            }
            {mainContentEl}
          </div>
        )
      })
  }, [modalFilter, filterOptions, setSectionValue, isSectionDisabled]);

  const sortSection = useMemo(
    () => filterOptions?.sections.find((section) => section.searchParam === SORT_PARAM) || null,
    [filterOptions]
  );

  // Everything the visitor moved away from the defaults, not counting the two
  // controls that sit in the toolbar with a state of their own.
  const activeCount = useMemo(() => {
    const initialValues = initialFilterValuesRef.current;
    if (!appliedFilter || !initialValues) {
      return 0;
    }
    return appliedFilter.options.filter((option) => {
      if (option.searchParam === SORT_PARAM || option.searchParam === SEARCH_PARAM) {
        return false;
      }
      const iv = initialValues.find((o) => o.searchParam === option.searchParam);
      return (option.value || null) !== (iv?.value || null);
    }).length;
  }, [appliedFilter]);

  const showPanel = useCallback(() => {
    setPanelOpen(true);
  }, []);

  const hidePanel = useCallback(() => {
    setPanelOpen(false);
    if (appliedFilter) {
      setModalFilterValues(appliedFilter.options);
    }
  }, [appliedFilter]);

  const handleSortChange = useCallback((value: string | null) => {
    // Sorting takes effect straight away: there is no "apply" step for a
    // control that is already in front of the visitor.
    setModalFilterValues([{ searchParam: SORT_PARAM, value }]);
    setAppliedFilterValues([{ searchParam: SORT_PARAM, value }]);
  }, []);

  const handleApply = useCallback(() => {
    const initialValues = initialFilterValuesRef.current;
    if (!modalFilter || !initialValues) {
      return;
    }
    const sanitizedOptions = copy(modalFilter.options);
    for (const option of modalFilter.options) {
      const iv = initialValues.find((o) => o.searchParam === option.searchParam);
      // Check if option belongs to a disabled section
      const section = filterOptions.sections.find((s) => s.searchParam === option.searchParam);
      if (section && isSectionDisabled(section) && iv) {
        const so = sanitizedOptions.find((s) => s.searchParam === option.searchParam);
        if (so) {
          so.value = iv.value;
        }
      }
    }
    setAppliedFilterValues(sanitizedOptions);
    setPanelOpen(false);
  }, [modalFilter, filterOptions, isSectionDisabled]);

  const handleClear = useCallback(() => {
    const initialValues = initialFilterValuesRef.current;
    if (initialValues) {
      setSearchParams((prev) => {
        const params = new URLSearchParams(prev);
        for (const iv of initialValues) {
          const paramName = `filter_${iv.searchParam}`;
          params.delete(paramName);
        }
        return params;
      });
      setModalFilterValues(initialValues);
      setAppliedFilterValues(initialValues);
    }
    setPanelOpen(false);
  }, [setSearchParams]);

  if (!modalFilter || !sectionEls) {
    return null;
  }

  const sortValue = appliedFilter ? getSectionValue(appliedFilter, SORT_PARAM) : null;

  return (
    <Space className="filter-toolbar" size={8} wrap>
      {
        sectionEls.length > 0 ? (
          <Badge count={activeCount} size="small" offset={[-4, 2]}>
            <Button
              icon={<FilterOutlined />}
              type={activeCount > 0 ? 'primary' : 'default'}
              onClick={showPanel}
            >
              Filters
            </Button>
          </Badge>
        ) : null
      }
      {
        activeCount > 0 ? (
          <Button
            icon={<ClearOutlined />}
            onClick={handleClear}
          >
            Clear
          </Button>
        ) : null
      }
      {
        sortSection ? (
          <SortSelect
            section={sortSection}
            value={sortValue}
            onChange={handleSortChange}
          />
        ) : null
      }
      <Drawer
        title="Filters"
        placement="right"
        width={360}
        rootClassName="filter-panel"
        open={panelOpen}
        onClose={hidePanel}
        footer={
          <div className="filter-panel__footer">
            <Button onClick={handleClear}>Clear all</Button>
            <Button type="primary" onClick={handleApply}>Apply</Button>
          </div>
        }
      >
        {sectionEls}
      </Drawer>
    </Space>
  )
}

export default FilterModalButton;
