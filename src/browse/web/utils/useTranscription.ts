import { useCallback, useEffect, useState } from "react";
import { useAPI } from "../contexts/APIProvider";
import { isActive, type TranscriptionRecord } from "../../types/Transcription";
import { isTranslationActive, type TranslationProgress } from "../../types/Translation";

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
  /** This video's translation, once one has been asked for. */
  translation: TranslationProgress | null;
  /** The translation is queued or under way. */
  translating: boolean;
  /** A translated subtitle has been produced. */
  translated: boolean;
  /**
   * Transcribes, and queues a translation to follow when `translate` is set.
   * That second step is a request of its own, so a translation that cannot be
   * queued reports why without taking the transcription down with it.
   */
  start: (translate?: boolean) => Promise<void>;
  cancel: () => Promise<void>;
}

/**
 * Follows one video's transcription, and the translation that may follow it.
 *
 * Polling runs only while something is still moving, so a page of tiles that
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
  const translating = isTranslationActive(record?.translation);

  useEffect(() => {
    if (!enabled || (!running && !translating)) {
      return;
    }
    const timer = setInterval(() => { void refresh(); }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [ enabled, running, translating, refresh ]);

  const start = useCallback(async (translate = false) => {
    setBusy(true);
    setLocalError(null);
    try {
      const started = await api.startTranscription(mediaId);
      setRecord(started);
      if (translate) {
        // Marked on the record now and picked up by the server once there is a
        // subtitle to translate, so the two are asked for in one gesture even
        // though they run one after the other.
        setRecord(await api.startTranslation(mediaId));
      }
    }
    catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Could not start transcription');
      // The transcription may well have started even though the translation
      // could not be queued, so what is on the server is what gets shown.
      await refresh();
    }
    finally {
      setBusy(false);
    }
  }, [ api, mediaId, refresh ]);

  const cancel = useCallback(async () => {
    setBusy(true);
    try {
      // Both, and translation first: cancelling the transcription is what lets
      // the queue hand over to a translation that is still marked pending.
      await api.cancelTranslation(mediaId);
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
    error: localError || record?.error || record?.translation?.error || null,
    busy,
    translation: record?.translation ?? null,
    translating,
    translated: record?.translation?.state === 'done',
    start,
    cancel
  };
}

export default useTranscription;
