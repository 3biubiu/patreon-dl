import { useCallback, useEffect, useState } from "react";
import { TranscriptionLimitError, useAPI } from "../contexts/APIProvider";
import { useAuth } from "../contexts/AuthProvider";
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

export interface TranscriptionOptions {
  /**
   * Told when the day's transcriptions are spent.
   *
   * Handed out rather than kept here as an error, because it is not one: the
   * request was understood and refused for the day, which is something to say
   * once, where the click happened - not a state for the control to sit in.
   */
  onLimitReached?: (error: TranscriptionLimitError) => void;
}

/**
 * Follows one video's transcription, and the translation that may follow it.
 *
 * Polling runs only while something is still moving, so a page of tiles that
 * have all finished settles down to no traffic at all.
 */
export function useTranscription(
  mediaId: string,
  enabled = true,
  options?: TranscriptionOptions
): TranscriptionHandle {
  const { api } = useAPI();
  // Translation is an administrator's, and this hook drives the control an
  // ordinary account with the transcription permission also sees. Asking for
  // it on their behalf would be a request the server refuses, shown to them as
  // a transcription that failed when it did not.
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const onLimitReached = options?.onLimitReached;
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
      if (translate && isAdmin) {
        // Marked on the record now and picked up by the server once there is a
        // subtitle to translate, so the two are asked for in one gesture even
        // though they run one after the other.
        setRecord(await api.startTranslation(mediaId));
      }
    }
    catch (error) {
      if (error instanceof TranscriptionLimitError) {
        // Nothing was started and nothing is wrong with the video, so this
        // does not become the control's error state - it is said once, to
        // whoever clicked.
        onLimitReached?.(error);
      }
      else {
        setLocalError(error instanceof Error ? error.message : 'Could not start transcription');
      }
      // The transcription may well have started even though the translation
      // could not be queued, so what is on the server is what gets shown.
      await refresh();
    }
    finally {
      setBusy(false);
    }
  }, [ api, mediaId, refresh, isAdmin, onLimitReached ]);

  const cancel = useCallback(async () => {
    setBusy(true);
    try {
      // Both, and translation first: cancelling the transcription is what lets
      // the queue hand over to a translation that is still marked pending.
      // Only an administrator has a translation to cancel - see above.
      if (isAdmin) {
        await api.cancelTranslation(mediaId);
      }
      await api.cancelTranscription(mediaId);
      await refresh();
    }
    catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Could not cancel transcription');
    }
    finally {
      setBusy(false);
    }
  }, [ api, mediaId, refresh, isAdmin ]);

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
