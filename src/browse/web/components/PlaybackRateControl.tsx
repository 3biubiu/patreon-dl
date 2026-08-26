import "../assets/styles/PlaybackRateControl.scss";
import { useCallback, useEffect, useRef, useState } from "react";

/** Capped at 2x, past which speech stops being followable. */
const RATES = [ 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2 ];

const STORAGE_KEY = 'patreon-dl.playbackRate';

function readStoredRate() {
  try {
    const stored = Number(window.localStorage.getItem(STORAGE_KEY));
    return RATES.includes(stored) ? stored : 1;
  }
  catch (_error) {
    return 1;
  }
}

/**
 * Speed control for whichever video is currently playing.
 *
 * Browsers do offer one of their own, but not consistently and not somewhere
 * everyone finds: Chrome buries it in the overflow menu, and Firefox puts it
 * in the right-click menu - which this app closes on players, because that is
 * also where "Save video as" lives.
 *
 * It floats above the lightbox rather than living inside it, because the
 * player is built by lightgallery and is not ours to render into.
 *
 * A plain `<select>` on purpose: its menu is drawn by the OS, so it cannot end
 * up behind the lightbox the way a stacked-in-page dropdown can.
 */
function PlaybackRateControl() {
  const [ rate, setRate ] = useState(readStoredRate);
  const [ video, setVideo ] = useState<HTMLVideoElement | null>(null);
  // Read from inside a listener that is only attached once, so it cannot be
  // allowed to close over a stale value.
  const rateRef = useRef(rate);
  rateRef.current = rate;

  useEffect(() => {
    const handlePlay = (e: Event) => {
      const target = e.target;
      if (!(target instanceof HTMLVideoElement)) {
        return;
      }
      // Each new element starts at 1x, so the chosen rate is applied per video
      // rather than once.
      target.playbackRate = rateRef.current;
      setVideo(target);
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
    // Noticing a beat later is fine for a control that is only there to be
    // clicked.
    const timer = window.setInterval(() => {
      if (!document.contains(video)) {
        setVideo(null);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [video]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = Number(e.target.value);
    if (!RATES.includes(value)) {
      return;
    }
    setRate(value);
    try {
      window.localStorage.setItem(STORAGE_KEY, String(value));
    }
    catch (_error) {
      // Not remembering the choice is not worth failing over.
    }
    if (video) {
      video.playbackRate = value;
    }
  }, [video]);

  if (!video) {
    return null;
  }

  return (
    <div className="playback-rate">
      <label className="playback-rate__label" htmlFor="playback-rate-select">
        Speed
      </label>
      <select
        id="playback-rate-select"
        className="playback-rate__select"
        value={rate}
        onChange={handleChange}
      >
        {
          RATES.map((value) => (
            <option key={`playback-rate-${value}`} value={value}>
              {value}x
            </option>
          ))
        }
      </select>
    </div>
  );
}

export default PlaybackRateControl;
