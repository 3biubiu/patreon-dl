import { useEffect } from "react";
import { useAPI } from "../contexts/APIProvider";
import { getMediaIdFromVideo } from "./useActiveVideo";

/**
 * Below this there is nothing worth returning to, and jumping a few seconds in
 * reads as a glitch rather than a convenience.
 */
const MIN_RESUME_SECONDS = 15;

/**
 * Within this of the end the video counts as finished, so playing it again
 * starts from the beginning instead of landing on the closing seconds.
 */
const END_THRESHOLD_SECONDS = 20;

/** How often the position is sent while a video plays. */
const REPORT_INTERVAL_MS = 10000;

interface VideoSource {
  mediaId: string;
  /** The post a linked attachment was played from, when it was one. */
  postId: string | null;
}

function readSource(video: HTMLVideoElement): VideoSource | null {
  const mediaId = getMediaIdFromVideo(video);
  if (!mediaId) {
    return null;
  }
  const src = video.currentSrc || video.src ||
    video.querySelector('source')?.getAttribute('src') || '';
  let postId: string | null = null;
  try {
    postId = new URL(src, window.location.href).searchParams.get('lapid');
  }
  catch {
    // A src that is not a URL simply has no post attached to it.
  }
  return { mediaId, postId };
}

/**
 * Remembers where a video got to, and picks it up there next time.
 *
 * Only videos still among the entries the server keeps can be resumed - it
 * answers for anything older the same way it answers for something never
 * watched, and playback starts from the beginning.
 *
 * The order here matters more than it looks. Nothing is reported until the
 * saved position has been asked for and applied: reporting on play first would
 * write a position of zero over the very thing about to be read back, and the
 * feature would work exactly once per video.
 */
export function useWatchHistory(video: HTMLVideoElement | null) {
  const { api } = useAPI();

  useEffect(() => {
    if (!video) {
      return;
    }
    const source = readSource(video);
    if (!source) {
      return;
    }

    let cancelled = false;
    let ready = false;
    let timer: number | undefined;

    const report = (keepalive = false) => {
      if (!ready || cancelled) {
        return;
      }
      const position = video.currentTime;
      if (!Number.isFinite(position)) {
        return;
      }
      // Best-effort throughout: a history that fails to save must not
      // interrupt the thing the viewer actually came for.
      void api.recordWatchedVideo(source.mediaId, {
        position,
        duration: Number.isFinite(video.duration) ? video.duration : null,
        postId: source.postId
      }, keepalive).catch(() => undefined);
    };

    const seekTo = (position: number) => {
      if (cancelled) {
        return;
      }
      // The end check needs the real duration, which is only known once the
      // metadata is in - hence doing this after `loadedmetadata` rather than
      // trusting the duration that was stored.
      const duration = Number.isFinite(video.duration) ? video.duration : null;
      if (duration !== null && position > duration - END_THRESHOLD_SECONDS) {
        return;
      }
      video.currentTime = position;
    };

    const resumeTo = (position: number, done: () => void) => {
      // Seeking before the browser knows how long the video is does nothing at
      // all, and `preload: false` means that is the usual case here.
      if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
        seekTo(position);
        done();
        return;
      }
      video.addEventListener('loadedmetadata', () => {
        seekTo(position);
        done();
      }, { once: true });
    };

    const handleStop = () => report();
    const handlePageHide = () => report(true);

    /**
     * Starts reporting, which cannot happen a moment sooner.
     *
     * Between asking for the saved position and the seek actually landing, the
     * player is still sitting at zero - and a report sent in that window would
     * write that zero over the position being restored. So nothing is sent,
     * and no listener that might send something is attached, until the seek is
     * done. If the metadata never arrives, nothing is reported at all, which
     * leaves the stored position intact rather than flattening it.
     */
    const startReporting = () => {
      if (cancelled) {
        return;
      }
      ready = true;
      // Recorded from the moment it is played, so a video that is only glanced
      // at still takes its place among the twenty.
      report();
      timer = window.setInterval(() => report(), REPORT_INTERVAL_MS);
      video.addEventListener('pause', handleStop);
      video.addEventListener('ended', handleStop);
      window.addEventListener('pagehide', handlePageHide);
    };

    void (async () => {
      let saved = null;
      try {
        saved = await api.getWatchedVideo(source.mediaId, source.postId);
      }
      catch {
        // Not knowing where they were is the same as starting over.
      }
      if (cancelled) {
        return;
      }
      if (saved && saved.position >= MIN_RESUME_SECONDS) {
        resumeTo(saved.position, startReporting);
      }
      else {
        startReporting();
      }
    })();

    return () => {
      // The last position goes out before anything is torn down - closing the
      // lightbox is the most common way a video is left part-watched.
      report();
      cancelled = true;
      if (timer !== undefined) {
        window.clearInterval(timer);
      }
      video.removeEventListener('pause', handleStop);
      video.removeEventListener('ended', handleStop);
      window.removeEventListener('pagehide', handlePageHide);
    };
  }, [api, video]);
}

export default useWatchHistory;
