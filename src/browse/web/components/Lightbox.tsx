import { useEffect, useRef } from "react";
import lightGallery from "lightgallery";
import "lightgallery/css/lightgallery.css";
import "lightgallery/css/lg-zoom.css";
import "lightgallery/css/lg-thumbnail.css";
import "lightgallery/css/lg-video.css";
import lgThumbnail from "lightgallery/plugins/thumbnail";
import lgZoom from "lightgallery/plugins/zoom";
import lgVideo from "lightgallery/plugins/video";

/** Hoisted: a fresh array here would be a fresh set of plugins on every render. */
const PLUGINS = [lgThumbnail, lgZoom, lgVideo];

interface LightboxProps {
  children: React.ReactNode;
  /**
   * Changes when the set of tiles does, and only then. The gallery re-reads
   * its items on a change; everything else leaves an open lightbox alone.
   */
  itemsKey?: string;
  /** Hands playback to video.js, for the grids that were already asking for it. */
  videojs?: boolean;
  className?: string;
}

/**
 * The image lightbox, wrapped so that re-rendering does not close it.
 *
 * lightgallery ships a React component, but it re-creates its settings object
 * on every render and re-runs the effect that builds the gallery on every
 * change to it - so each render destroyed the instance and rebuilt it. With a
 * video playing, that reads as the lightbox closing itself a second or two in:
 * the element being played is destroyed along with it. Anything that re-rendered
 * an ancestor did it - a quota refresh, a window resize, opening the PDF reader.
 *
 * So the instance is built here directly, once, and told to re-read its items
 * only when there actually are different ones.
 */
function Lightbox(props: LightboxProps) {
  const { children, itemsKey, videojs = false, className } = props;
  const elRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<ReturnType<typeof lightGallery> | null>(null);

  useEffect(() => {
    if (!elRef.current) {
      return;
    }
    const instance = lightGallery(elRef.current, {
      speed: 500,
      plugins: PLUGINS,
      videojs,
      // lightgallery defaults this to true, which puts a download icon in
      // the lightbox toolbar - nothing to do with the player's own controls.
      download: false,
      selector: '.lightgallery-item'
    });
    instanceRef.current = instance;
    return () => {
      instance.destroy();
      instanceRef.current = null;
    };
  }, [videojs]);

  // Declared after the effect that builds the gallery, so on the first render
  // there is already an instance for this to be a no-op against.
  useEffect(() => {
    instanceRef.current?.refresh();
  }, [itemsKey]);

  return (
    <div ref={elRef} className={`lg-react-element${className ? ` ${className}` : ''}`}>
      {children}
    </div>
  );
}

export default Lightbox;
