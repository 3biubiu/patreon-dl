import { useEffect, useState } from "react";

/** How long to keep looking for the toolbar after a video starts playing. */
const RETRY_LIMIT = 10;
const RETRY_INTERVAL_MS = 100;

/**
 * The toolbar of the lightbox the given video is playing in, or `null`.
 *
 * Found by walking up from the video rather than by asking lightgallery for
 * its instance. A page renders one gallery per media grid, so the instance
 * route would mean every grid reporting itself up to a shared context just so
 * the controls could work out which of several toolbars to use - while the
 * element that is playing already sits inside the right one.
 *
 * The cost is a dependency on two of lightgallery's class names, kept here and
 * nowhere else. Returning `null` when they stop matching is deliberate: the
 * controls then fall back to floating over the lightbox, which is worse
 * looking but still works.
 */
export function useLightboxToolbar(video: HTMLVideoElement | null) {
  const [ toolbar, setToolbar ] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!video) {
      setToolbar(null);
      return;
    }
    let attempts = 0;
    let timer: number | undefined;

    const find = () => {
      const container = video.closest('.lg-container');
      const found = container?.querySelector<HTMLElement>('.lg-toolbar') || null;
      if (found) {
        setToolbar(found);
        return;
      }
      // The slide can be in the DOM a beat before the toolbar is, so give it
      // a moment rather than falling back on the first miss.
      if (++attempts < RETRY_LIMIT) {
        timer = window.setTimeout(find, RETRY_INTERVAL_MS);
      }
      else {
        setToolbar(null);
      }
    };
    find();

    return () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [ video ]);

  // The toolbar goes away with the lightbox, and a portal into a detached
  // element renders nowhere. Checked on the same beat as the video itself.
  useEffect(() => {
    if (!toolbar) {
      return;
    }
    const interval = window.setInterval(() => {
      if (!document.contains(toolbar)) {
        setToolbar(null);
      }
    }, 1000);
    return () => window.clearInterval(interval);
  }, [ toolbar ]);

  return toolbar;
}

export default useLightboxToolbar;
