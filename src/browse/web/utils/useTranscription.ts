import { useCallback, useEffect, useRef, useState } from "react";
import { useAPI } from "../contexts/APIProvider";
import { type TranscriptionJob, type TranscriptionRecord } from "../../types/Transcription";

/** How often a running job is asked about. */
const POLL_INTERVAL_MS = 2000;

const RUNNING: TranscriptionJob['status'][] = [ 'queued', 'detecting', 'transcribing', 'writing' ];

export interface TranscriptionHandle {
  job: TranscriptionJob | null;
  record: TranscriptionRecord | null;
  /** A job is queued or under way. */
  running: boolean;
  /** A subtitle exists for this video. */
  captioned: boolean;
  /** 0-100 while running. */
  percent: number;
  error: string | null;
  busy: boolean;
  start: () => Promise<void>;
  cancel: () => Promise<void>;
}

/**
 * Follows one video's transcription.
 *
 * State is only fetched when `enabled` - the grid asks for it per video, and
 * a page of tiles should not each open a poll of their own before anyone has
 * shown interest. Polling starts when a job is running and stops when it ends.
 */
export function useTranscription(mediaId: string, enabled = true): TranscriptionHandle {
  const { api } = useAPI();
  const [ job, setJob ] = useState<TranscriptionJob | null>(null);
  const [ record, setRecord ] = useState<TranscriptionRecord | null>(null);
  const [ busy, setBusy ] = useState(false);
  const [ localError, setLocalError ] = useState<string | null>(null);
  // Read inside the interval callback, which must not be rebuilt on every tick.
  const runningRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const result = await api.getTranscription(mediaId);
      setJob(result.job);
      setRecord(result.record);
      return result;
    }
    catch {
      // A failed poll is not worth surfacing: the next one usually works, and
      // a signed-out session is already handled globally.
      return null;
    }
  }, [ api, mediaId ]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let cancelled = false;
    void (async () => {
      const result = await refresh();
      if (cancelled || !result?.job) {
        return;
      }
      runningRef.current = RUNNING.includes(result.job.status);
    })();
    return () => { cancelled = true; };
  }, [ enabled, refresh ]);

  const running = !!job && RUNNING.includes(job.status);
  runningRef.current = running;

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
      const started = await api.startTranscription(mediaId);
      setJob(started);
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
    job,
    record,
    running,
    // The index is the cheap answer here - it knows without anyone reading the
    // media library, which is the whole reason it exists.
    captioned: job?.status === 'done' || record?.state === 'done',
    percent: job?.percent ?? 0,
    error: localError || job?.error || record?.error || null,
    busy,
    start,
    cancel
  };
}

export default useTranscription;
