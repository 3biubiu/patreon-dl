import "../assets/styles/Loading.scss";
import { Spinner } from "react-bootstrap";

interface LoadingOverlayProps {
  loading: boolean;
  children: React.ReactNode;
  className?: string;
  /** Height the veil falls back to while there is no content behind it yet. */
  minHeight?: string;
}

interface LoadingBlockProps {
  className?: string;
  minHeight?: string;
  label?: string;
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
      className={`loading-overlay ${loading ? 'loading-overlay--active' : ''} ${className}`}
      style={minHeight ? { minHeight } : undefined}
    >
      <div className="loading-overlay__content" aria-busy={loading}>
        {children}
      </div>
      {
        loading ? (
          <div className="loading-overlay__veil">
            <Spinner animation="border" variant="primary" role="status">
              <span className="visually-hidden">Loading...</span>
            </Spinner>
          </div>
        ) : null
      }
    </div>
  );
}

/**
 * Standalone spinner for a view that has nothing to show yet, so the first
 * load isn't a blank screen.
 */
function LoadingBlock(props: LoadingBlockProps) {
  const { className = '', minHeight = '16em', label = 'Loading...' } = props;

  return (
    <div className={`loading-block ${className}`} style={{ minHeight }} role="status">
      <Spinner animation="border" variant="primary" />
      <span className="visually-hidden">{label}</span>
    </div>
  );
}

export { LoadingOverlay, LoadingBlock };
