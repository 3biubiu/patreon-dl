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

interface PlaybackRateControlProps {
  video: HTMLVideoElement;
}

/**
 * Speed control for whichever video is currently playing.
 *
 * Browsers do offer one of their own, but not consistently and not somewhere
 * everyone finds: Chrome buries it in the overflow menu, and Firefox puts it
 * in the right-click menu - which this app closes on players, because that is
 * also where "Save video as" lives.
 *
 * A plain `<select>` on purpose: its menu is drawn by the OS, so it cannot end
 * up behind the lightbox the way a stacked-in-page dropdown can.
 */
function PlaybackRateControl(props: PlaybackRateControlProps) {
  const { video } = props;
  const [ rate, setRate ] = useState(readStoredRate);
  // Read inside an effect that must not re-run when the rate changes, so it
  // cannot be allowed to close over a stale value.
  const rateRef = useRef(rate);
  rateRef.current = rate;

  useEffect(() => {
    // Each new element starts at 1x, so the chosen rate is applied per video
    // rather than once.
    video.playbackRate = rateRef.current;
  }, [ video ]);

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
    video.playbackRate = value;
  }, [ video ]);

  return (
    <div className="player-controls__control">
      <label className="player-controls__label" htmlFor="playback-rate-select">
        Speed
      </label>
      <select
        id="playback-rate-select"
        className="player-controls__select"
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
