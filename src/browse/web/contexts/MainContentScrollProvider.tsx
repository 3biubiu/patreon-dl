import "../assets/styles/MainScroll.scss";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef } from "react";
import { NavigationType, useLocation, useNavigationType } from "react-router";

interface MainContentScrollProviderProps {
  children: React.ReactNode;
}

interface MainContentScrollContextValue {
  scrollTo: (x: number, y: number) => void;
}

const MainContentScrollContext = createContext({} as MainContentScrollContextValue);

const STORAGE_KEY = 'patreon-dl.scrollPositions';

/**
 * How long to keep re-applying a restored position. The list a visitor comes
 * back to re-fetches on mount, so for the first few hundred milliseconds the
 * page is too short to scroll anywhere near where they left off.
 */
const RESTORE_TIMEOUT = 3000;

function readStoredPositions(): Record<string, number> {
  try {
    const stored = window.sessionStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) as Record<string, number> : {};
  }
  catch (_error) {
    return {};
  }
}

/**
 * The app's scrollport, plus scroll restoration across history navigation.
 *
 * React Router's own `<ScrollRestoration>` is not usable here: it needs a data
 * router, and it only ever restores the window, whereas everything in this app
 * scrolls inside this one element. So the same idea is implemented against it -
 * positions keyed by `location.key`, kept in `sessionStorage`, re-applied on
 * POP and reset to the top on anything else.
 */
function MainContentScrollProvider(props: MainContentScrollProviderProps) {
  const { children } = props;
  const viewRef = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const navigationType = useNavigationType();
  const positionsRef = useRef<Record<string, number>>(readStoredPositions());
  // Which history entry the scrolling below belongs to. A ref, because the
  // scroll listener is attached once and must not go stale.
  const locationKeyRef = useRef(location.key);

  const scrollTo = useCallback((x: number, y: number) => {
    viewRef.current?.scrollTo(x, y);
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }
    const handleScroll = () => {
      positionsRef.current[locationKeyRef.current] = view.scrollTop;
    };
    view.addEventListener('scroll', handleScroll, { passive: true });
    return () => view.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    const save = () => {
      try {
        window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(positionsRef.current));
      }
      catch (_error) {
        // Losing the positions is not worth failing over.
      }
    };
    window.addEventListener('pagehide', save);
    return () => {
      window.removeEventListener('pagehide', save);
      save();
    };
  }, []);

  useLayoutEffect(() => {
    locationKeyRef.current = location.key;
    const view = viewRef.current;
    if (!view) {
      return;
    }
    const target = navigationType === NavigationType.Pop ?
      positionsRef.current[location.key] : undefined;
    if (!target) {
      view.scrollTop = 0;
      return;
    }

    let frame = 0;
    let done = false;
    const deadline = Date.now() + RESTORE_TIMEOUT;

    const stop = () => {
      if (done) {
        return;
      }
      done = true;
      cancelAnimationFrame(frame);
      window.removeEventListener('wheel', stop);
      window.removeEventListener('touchstart', stop);
      window.removeEventListener('keydown', stop);
    };

    const tick = () => {
      const current = viewRef.current;
      if (done || !current) {
        return;
      }
      current.scrollTop = target;
      // A short page clamps the assignment, so keep going until the content
      // has grown enough to hold the position - or until we give up on it.
      if (Math.abs(current.scrollTop - target) < 1 || Date.now() > deadline) {
        stop();
        return;
      }
      frame = requestAnimationFrame(tick);
    };

    // Any deliberate scroll means the visitor no longer wants to be put back.
    window.addEventListener('wheel', stop, { passive: true });
    window.addEventListener('touchstart', stop, { passive: true });
    window.addEventListener('keydown', stop);
    frame = requestAnimationFrame(tick);

    return stop;
  }, [location.key, navigationType]);

  return (
    <MainContentScrollContext.Provider value={{ scrollTo }}>
      <div ref={viewRef} className="main-scroll">
        {children}
      </div>
    </MainContentScrollContext.Provider>
  );
};

const useScroll = () => useContext(MainContentScrollContext);

export { useScroll, MainContentScrollProvider as ScrollProvider };
