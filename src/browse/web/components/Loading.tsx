import "../assets/styles/Loading.scss";
import { Spin } from "antd";

interface LoadingOverlayProps {
  loading: boolean;
  children: React.ReactNode;
  className?: string;
  /** Height the spinner falls back to while there is no content behind it yet. */
  minHeight?: string;
}

interface LoadingBlockProps {
  className?: string;
  minHeight?: string;
}

/**
 * Spinner over a slab of content while the next page of it is being fetched.
 *
 * The current page stays mounted underneath, dimmed and non-interactive, so
 * paging does not collapse the layout to nothing and back - which used to make
 * the whole view jump on every click.
 */
function LoadingOverlay(props: LoadingOverlayProps) {
  const { loading, children, className = '', minHeight } = props;

  return (
    <div
      className={`loading-overlay ${className}`}
      style={minHeight ? { minHeight } : undefined}
    >
      <Spin spinning={loading}>
        {children}
      </Spin>
    </div>
  );
}

/**
 * Standalone spinner for a view that has nothing to show yet, so the first
 * load isn't a blank screen.
 */
function LoadingBlock(props: LoadingBlockProps) {
  const { className = '', minHeight = '16em' } = props;

  return (
    <div className={`loading-block ${className}`} style={{ minHeight }}>
      <Spin size="large" />
    </div>
  );
}

export { LoadingOverlay, LoadingBlock };
