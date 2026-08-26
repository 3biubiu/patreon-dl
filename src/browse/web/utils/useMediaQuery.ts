import { useEffect, useState } from "react";

/**
 * Tracks a CSS media query. Seeded synchronously so the first render already
 * knows the answer - antd's own `useBreakpoint` reports nothing until after
 * mount, which makes the layout flip from mobile to desktop on load.
 */
export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const mq = window.matchMedia(query);
    const handleChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    setMatches(mq.matches);
    mq.addEventListener('change', handleChange);
    return () => mq.removeEventListener('change', handleChange);
  }, [query]);

  return matches;
}

/** Bootstrap's `lg` breakpoint, where the sidebar stops being a drawer. */
export const DESKTOP_QUERY = '(min-width: 992px)';

export const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';
