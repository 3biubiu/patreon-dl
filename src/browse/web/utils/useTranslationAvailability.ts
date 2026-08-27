import { useEffect, useState } from "react";
import { useAPI } from "../contexts/APIProvider";
import { type TranslationAvailability } from "../../types/Translation";

/**
 * Shared across every caller for the life of the page.
 *
 * A grid draws a transcribe control on every video tile, and each of them
 * wants to know whether a translation can be offered alongside. Asking per
 * tile would be a hundred identical requests to draw one page; this is one,
 * and the answer only changes when an administrator saves a key - at which
 * point they are on the settings page, not the grid.
 */
let pending: Promise<TranslationAvailability> | null = null;

function fetchAvailability(api: { getTranslationAvailability: () => Promise<TranslationAvailability> }) {
  if (!pending) {
    pending = api.getTranslationAvailability().catch((error: unknown) => {
      // Not cached as a failure: a request that failed because the session had
      // just expired would otherwise keep answering "no" for the rest of the
      // page's life.
      pending = null;
      throw error;
    });
  }
  return pending;
}

/** Whether the server can translate. `null` until the answer arrives. */
export function useTranslationAvailability(enabled = true): TranslationAvailability | null {
  const { api } = useAPI();
  const [ availability, setAvailability ] = useState<TranslationAvailability | null>(null);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let cancelled = false;
    void fetchAvailability(api)
      .then((result) => {
        if (!cancelled) {
          setAvailability(result);
        }
      })
      .catch(() => {
        // Left null, which reads as "not offered" - the same as unavailable,
        // and the server refuses the request either way.
      });
    return () => { cancelled = true; };
  }, [ api, enabled ]);

  return availability;
}

export default useTranslationAvailability;
