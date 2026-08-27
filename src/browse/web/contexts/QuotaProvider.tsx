import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { message } from "antd";
import { type QuotaStatus } from "../../types/Quota";
import { useAPI } from "./APIProvider";
import { useAuth } from "./AuthProvider";

interface QuotaProviderProps {
  children: React.ReactNode;
}

interface QuotaContextValue {
  /** `null` until the first answer arrives. */
  quota: QuotaStatus | null;
  /** Re-asks the server. Called after anything that might have spent some. */
  refresh: () => Promise<void>;
}

const QuotaContext = createContext({} as QuotaContextValue);

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
    <QuotaContext.Provider value={{ quota, refresh }}>
      {children}
    </QuotaContext.Provider>
  );
}

const useQuota = () => useContext(QuotaContext);

export { QuotaProvider, useQuota };
