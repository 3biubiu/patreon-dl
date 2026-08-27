import { useEffect, useState } from "react";

/**
 * The video element currently playing in the lightbox, or `null`.
 *
 * The player is built by lightgallery and is not ours to render into, so the
 * controls that go with it float above the lightbox instead and reach the
 * element through here.
 */
export function useActiveVideo() {
  const [ video, setVideo ] = useState<HTMLVideoElement | null>(null);

  useEffect(() => {
    const handlePlay = (e: Event) => {
      if (e.target instanceof HTMLVideoElement) {
        setVideo(e.target);
      }
    };
    // "play" does not bubble; it has to be caught on the way down.
    document.addEventListener('play', handlePlay, true);
    return () => document.removeEventListener('play', handlePlay, true);
  }, []);

  useEffect(() => {
    if (!video) {
      return;
    }
    // Closing the lightbox drops the video element with no event to go by.
    // Noticing a beat later is fine for controls that are only there to be
    // clicked.
    const timer = window.setInterval(() => {
      if (!document.contains(video)) {
        setVideo(null);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [ video ]);

  return video;
}

/**
 * The media id a player is showing, taken from its own source URL.
 *
 * Every playable URL this app produces is `/media/<id>`, so the element that
 * is playing already carries the identity its captions have to be looked up
 * by - no bookkeeping needed between the grid and the lightbox.
 */
export function getMediaIdFromVideo(video: HTMLVideoElement | null): string | null {
  if (!video) {
    return null;
  }
  const src = video.currentSrc || video.src ||
    video.querySelector('source')?.getAttribute('src') || '';
  const match = /\/media\/([^/?#]+)/.exec(src);
  return match ? decodeURIComponent(match[1]) : null;
}

export default useActiveVideo;
