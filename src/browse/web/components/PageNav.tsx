import "../assets/styles/PageNav.scss";
import { Pagination } from "antd";

interface PageNavProps {
  total: number;
  itemsPerPage: number;
  current: number;
  /** Blocks further paging while the page being switched to is still loading. */
  disabled?: boolean;
  onChange: (page: number) => void;
}

function PageNav(props: PageNavProps) {
  const { total, itemsPerPage, current, disabled = false, onChange } = props;

  return (
    <div className="page-nav">
      <Pagination
        current={current}
        pageSize={itemsPerPage}
        total={total}
        disabled={disabled}
        hideOnSinglePage
        showSizeChanger={false}
        showQuickJumper
        onChange={onChange}
      />
    </div>
  )
}

export default PageNav;
