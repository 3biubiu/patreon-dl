import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { message } from "antd";
import { type QuotaStatus } from "../../types/Quota";
import { useAPI } from "./APIProvider";
import { useAuth } from "./AuthProvider";

interface QuotaProviderProps {
  children: React.ReactNode;
}

/**
 * The count and the way to re-ask for it are kept apart on purpose.
 *
 * A context value changes for everyone who reads it, and starting a video
 * re-asks for the count a second and a half later. Callers that only ever
 * refresh - the post page - were being re-rendered by that, which used to take
 * the lightbox and the video playing in it down with them. They read
 * `useQuotaRefresh` instead, which never changes.
 */
const QuotaContext = createContext<QuotaStatus | null>(null);
const QuotaRefreshContext = createContext<() => Promise<void>>(() => Promise.resolve());

/** Long enough that a burst of range requests does not become a burst of these. */
const REFRESH_DEBOUNCE_MS = 1500;

/**
 * How much of today's allowance is left, for the parts of the app that show it
 * or have to explain a refusal.
 *
 * The count is the server's - this only mirrors it. It is re-asked after the
 * things that spend it rather than polled, because the only two ways an
 * allowance moves are opening a post and starting a video, and both of them
 * happen right here in the browser.
 */
function QuotaProvider(props: QuotaProviderProps) {
  const { children } = props;
  const { api } = useAPI();
  const { user } = useAuth();
  const [ quota, setQuota ] = useState<QuotaStatus | null>(null);
  const quotaRef = useRef<QuotaStatus | null>(null);
  const timerRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const status = await api.getQuota();
      quotaRef.current = status;
      setQuota(status);
    }
    catch {
      // Not worth surfacing: this only backs a hint in the sidebar, and the
      // limit itself is enforced by the server whatever the browser believes.
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh, user?.id]);

  // Watching a video spends the allowance at the file itself, where nothing in
  // React is involved - so the counter is brought back into line off the
  // player's own events rather than from a call site.
  useEffect(() => {
    if (!user || user.role === 'admin') {
      return;
    }

    const scheduleRefresh = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        void refresh();
      }, REFRESH_DEBOUNCE_MS);
    };

    const handlePlay = (e: Event) => {
      if (e.target instanceof HTMLVideoElement) {
        scheduleRefresh();
      }
    };

    // A refused video is a load error like any other, and the element is not
    // told why. So the counters are re-read, and the limit is named only when
    // they say it has actually run out - anything else is left to look like
    // the missing file it probably is.
    const handleError = (e: Event) => {
      if (!(e.target instanceof HTMLVideoElement)) {
        return;
      }
      void (async () => {
        await refresh();
        if (quotaRef.current?.videos.remaining === 0) {
          void message.warning(
            'You have reached your daily limit for videos. It resets at 08:00 (Beijing time).'
          );
        }
      })();
    };

    // Neither event bubbles; both have to be caught on the way down.
    document.addEventListener('play', handlePlay, true);
    document.addEventListener('error', handleError, true);
    return () => {
      document.removeEventListener('play', handlePlay, true);
      document.removeEventListener('error', handleError, true);
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [refresh, user]);

  return (
    <QuotaRefreshContext.Provider value={refresh}>
      <QuotaContext.Provider value={quota}>
        {children}
      </QuotaContext.Provider>
    </QuotaRefreshContext.Provider>
  );
}

/** The count, for the parts of the app that show it. Re-renders when it moves. */
const useQuota = () => ({
  quota: useContext(QuotaContext),
  refresh: useContext(QuotaRefreshContext)
});

/** Just the way to re-ask, for callers that never display the count. */
const useQuotaRefresh = () => useContext(QuotaRefreshContext);

export { QuotaProvider, useQuota, useQuotaRefresh };
