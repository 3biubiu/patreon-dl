import { useCallback, useEffect, useState } from "react";
import { useAPI } from "../contexts/APIProvider";
import { isActive, type TranscriptionRecord } from "../../types/Transcription";

/** How often a moving record is asked about. */
const POLL_INTERVAL_MS = 2000;

export interface TranscriptionHandle {
  record: TranscriptionRecord | null;
  /** Queued or under way. */
  running: boolean;
  /** A subtitle has been produced for this video. */
  captioned: boolean;
  percent: number;
  error: string | null;
  busy: boolean;
  start: () => Promise<void>;
  cancel: () => Promise<void>;
}

/**
 * Follows one video's transcription.
 *
 * Polling runs only while the record is still moving, so a page of tiles that
 * have all finished settles down to no traffic at all.
 */
export function useTranscription(mediaId: string, enabled = true): TranscriptionHandle {
  const { api } = useAPI();
  const [ record, setRecord ] = useState<TranscriptionRecord | null>(null);
  const [ busy, setBusy ] = useState(false);
  const [ localError, setLocalError ] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRecord(await api.getTranscription(mediaId));
    }
    catch {
      // A failed poll is not worth surfacing: the next one usually works, and
      // a signed-out session is already handled globally.
    }
  }, [ api, mediaId ]);

  useEffect(() => {
    if (enabled) {
      void refresh();
    }
  }, [ enabled, refresh ]);

  const running = isActive(record);

  useEffect(() => {
    if (!enabled || !running) {
      return;
    }
    const timer = setInterval(() => { void refresh(); }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [ enabled, running, refresh ]);

  const start = useCallback(async () => {
    setBusy(true);
    setLocalError(null);
    try {
      setRecord(await api.startTranscription(mediaId));
    }
    catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Could not start transcription');
    }
    finally {
      setBusy(false);
    }
  }, [ api, mediaId ]);

  const cancel = useCallback(async () => {
    setBusy(true);
    try {
      await api.cancelTranscription(mediaId);
      await refresh();
    }
    catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Could not cancel transcription');
    }
    finally {
      setBusy(false);
    }
  }, [ api, mediaId, refresh ]);

  return {
    record,
    running,
    captioned: record?.state === 'done',
    percent: record?.percent ?? 0,
    error: localError || record?.error || null,
    busy,
    start,
    cancel
  };
}

export default useTranscription;
