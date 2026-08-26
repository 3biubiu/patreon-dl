import "../assets/styles/SortSelect.scss";
import { Select } from "antd";
import { SwapOutlined } from "@ant-design/icons";
import { type FilterSearchParams, type FilterSection } from "../../types/Filter";

interface SortSelectProps<S extends FilterSearchParams> {
  section: FilterSection<S>;
  value: string | null;
  onChange: (value: string | null) => void;
}

/**
 * The sort order, lifted out of the filter panel: it is the one choice people
 * change constantly, and burying it behind "open panel, pick, apply" made it
 * cost three clicks.
 */
function SortSelect<S extends FilterSearchParams>(props: SortSelectProps<S>) {
  const { section, value, onChange } = props;

  return (
    <div className="sort-select">
      <SwapOutlined className="sort-select__icon" rotate={90} />
      <Select
        className="sort-select__control"
        aria-label={section.title || 'Sort'}
        value={value ?? undefined}
        placeholder={section.title || 'Sort'}
        popupMatchSelectWidth={false}
        options={section.options.map((option) => ({
          value: option.value ?? '',
          label: option.title
        }))}
        onChange={(next: string) => onChange(next || null)}
      />
    </div>
  )
}

export default SortSelect;
