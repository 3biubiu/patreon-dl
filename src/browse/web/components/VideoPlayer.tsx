import "../assets/styles/VideoPlayer.scss";
import { useCallback, useEffect, useRef, useState } from "react";
import Icon from "./Icon";
import PlaybackRateControl from "./PlaybackRateControl";
import PlayerSizeControl, {
  DEFAULT_SIZE_PERCENT,
  MAX_SIZE_PERCENT,
  MIN_SIZE_PERCENT,
  SIZE_PRESETS,
  readStoredPercent,
  readStoredPreset,
  storePercent,
  storePreset,
  type SizePresetKey
} from "./PlayerSizeControl";
import SubtitleControl from "./SubtitleControl";
import SubtitleOverlay from "./SubtitleOverlay";

export interface VideoPlayerSource {
  /** Media id - what captions and watch history are keyed by. */
  id: string;
  src: string;
  poster?: string;
  title?: string;
}

interface VideoPlayerProps {
  source: VideoPlayerSource;
  autoPlay?: boolean;
  /** Renders the button that puts the tiles back. */
  onClose?: () => void;
}

const DEFAULT_ASPECT_RATIO = 16 / 9;
const MIN_FRAME_HEIGHT = 140;
/** What the control bar leaves for the picture when filling the screen. */
const BAR_HEIGHT = 52;
const SEEK_STEP_SECONDS = 5;
const VOLUME_STEP = 0.05;
const VOLUME_STORAGE_KEY = 'patreon-dl.playerVolume';
/** A press that moved less than this was a click on the picture, not a drag. */
const DRAG_THRESHOLD_PX = 4;
/** How long the bar stays up after the pointer stops, in fullscreen. */
const BAR_IDLE_MS = 2500;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '0:00';
  }
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const secs = total % 60;
  const paddedMinutes = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  return `${hours > 0 ? `${hours}:` : ''}${paddedMinutes}:${String(secs).padStart(2, '0')}`;
}

function readStoredVolume(): { volume: number; muted: boolean } {
  try {
    const stored = window.localStorage.getItem(VOLUME_STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) as { volume?: number; muted?: boolean } : null;
    const volume = Number(parsed?.volume);
    return {
      volume: Number.isFinite(volume) ? clamp(volume, 0, 1) : 1,
      muted: !!parsed?.muted
    };
  }
  catch (_error) {
    return { volume: 1, muted: false };
  }
}

function storeVolume(volume: number, muted: boolean) {
  try {
    window.localStorage.setItem(VOLUME_STORAGE_KEY, JSON.stringify({ volume, muted }));
  }
  catch (_error) {
    // Not remembering the level is not worth failing over.
  }
}

/**
 * The video player, in the page rather than in a lightbox.
 *
 * Its controls are drawn here rather than left to the browser for one reason:
 * the native control bar belongs to the video element, and this player scales
 * and drags that element about to let the viewer choose how much of the
 * picture shows. Native controls would be scaled and cropped along with it -
 * and in fullscreen they would cover the speed and caption menus outright.
 *
 * The element itself is still a plain `<video>` this component owns, which is
 * what lets the controls that already existed - speed, captions - be dropped
 * straight in, and what keeps watch history and the quota counter working off
 * the same `play` events they always listened for.
 */
function VideoPlayer(props: VideoPlayerProps) {
  const { source, autoPlay = false, onClose } = props;

  const rootRef = useRef<HTMLDivElement>(null);
  const seekRef = useRef<HTMLDivElement>(null);
  const [ video, setVideo ] = useState<HTMLVideoElement | null>(null);

  const [ playing, setPlaying ] = useState(false);
  const [ waiting, setWaiting ] = useState(false);
  const [ currentTime, setCurrentTime ] = useState(0);
  const [ duration, setDuration ] = useState(0);
  const [ bufferedTo, setBufferedTo ] = useState(0);
  const [ volume, setVolume ] = useState(() => readStoredVolume().volume);
  const [ muted, setMuted ] = useState(() => readStoredVolume().muted);
  const [ aspectRatio, setAspectRatio ] = useState(DEFAULT_ASPECT_RATIO);
  const [ fullscreen, setFullscreen ] = useState(false);
  const [ availableWidth, setAvailableWidth ] = useState(0);
  const [ viewportHeight, setViewportHeight ] = useState(() => window.innerHeight);
  const [ preset, setPreset ] = useState<SizePresetKey>(readStoredPreset);
  const [ sizePercent, setSizePercent ] = useState(readStoredPercent);
  const [ pan, setPan ] = useState({ x: 0, y: 0 });
  const [ barVisible, setBarVisible ] = useState(true);

  // Below 100% the frame itself shrinks; above it the frame stays where the
  // preset put it and the picture grows inside it, which is what makes there
  // be something to drag.
  const scale = Math.max(sizePercent / 100, 1);
  const shrink = Math.min(sizePercent / 100, 1);

  const maxFrameHeight = fullscreen ?
    Math.max(viewportHeight - BAR_HEIGHT, MIN_FRAME_HEIGHT)
    : viewportHeight * SIZE_PRESETS[preset].heightRatio;
  const widthBoundHeight = availableWidth > 0 ? availableWidth / aspectRatio : 0;
  // Asking for fullscreen is asking for the whole screen, so a percentage below
  // 100 stays in the page where it was set. Above 100 it still applies: cropping
  // the bars off a letterboxed video is if anything more wanted here.
  const frameHeight = widthBoundHeight > 0 ?
    Math.max(
      Math.min(widthBoundHeight, maxFrameHeight) * (fullscreen ? 1 : shrink),
      // The floor never asks for more width than there is.
      Math.min(MIN_FRAME_HEIGHT, widthBoundHeight)
    )
    : 0;
  const frameWidth = frameHeight * aspectRatio;

  const maxPanX = (frameWidth * (scale - 1)) / 2;
  const maxPanY = (frameHeight * (scale - 1)) / 2;

  /* Measurements. */

  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      setAvailableWidth(entries[0].contentRect.width);
    });
    if (rootRef.current) {
      observer.observe(rootRef.current);
    }
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const handleResize = () => setViewportHeight(window.innerHeight);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Zooming back out, or a frame that got smaller, can leave the picture
  // parked past its own edge.
  useEffect(() => {
    setPan((current) => {
      const x = clamp(current.x, -maxPanX, maxPanX);
      const y = clamp(current.y, -maxPanY, maxPanY);
      return x === current.x && y === current.y ? current : { x, y };
    });
  }, [ maxPanX, maxPanY ]);

  /* The element. */

  useEffect(() => {
    if (!video) {
      return;
    }
    const readBuffered = () => {
      const ranges = video.buffered;
      let end = 0;
      for (let i = 0; i < ranges.length; i++) {
        if (ranges.start(i) <= video.currentTime && ranges.end(i) > end) {
          end = ranges.end(i);
        }
      }
      setBufferedTo(end);
    };
    const handlePlay = () => setPlaying(true);
    const handlePause = () => setPlaying(false);
    const handleTimeUpdate = () => {
      setCurrentTime(video.currentTime);
      readBuffered();
    };
    const handleMetadata = () => {
      setDuration(Number.isFinite(video.duration) ? video.duration : 0);
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        setAspectRatio(video.videoWidth / video.videoHeight);
      }
    };
    const handleVolumeChange = () => {
      setVolume(video.volume);
      setMuted(video.muted);
    };
    const handleWaiting = () => setWaiting(true);
    const handlePlaying = () => setWaiting(false);

    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);
    video.addEventListener('ended', handlePause);
    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('durationchange', handleMetadata);
    video.addEventListener('loadedmetadata', handleMetadata);
    video.addEventListener('progress', readBuffered);
    video.addEventListener('volumechange', handleVolumeChange);
    video.addEventListener('waiting', handleWaiting);
    video.addEventListener('playing', handlePlaying);
    video.addEventListener('canplay', handlePlaying);
    handleMetadata();

    return () => {
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('ended', handlePause);
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('durationchange', handleMetadata);
      video.removeEventListener('loadedmetadata', handleMetadata);
      video.removeEventListener('progress', readBuffered);
      video.removeEventListener('volumechange', handleVolumeChange);
      video.removeEventListener('waiting', handleWaiting);
      video.removeEventListener('playing', handlePlaying);
      video.removeEventListener('canplay', handlePlaying);
    };
  }, [ video ]);

  // The level is the viewer's, not the video's, so it is applied to each new
  // element rather than read back off it. Only on a new element: later changes
  // go through the controls, which set the element themselves.
  useEffect(() => {
    if (video) {
      video.volume = readStoredVolume().volume;
      video.muted = readStoredVolume().muted;
    }
  }, [ video ]);

  /* Playback. */

  const togglePlay = useCallback(() => {
    if (!video) {
      return;
    }
    if (video.paused) {
      void video.play().catch(() => undefined);
    }
    else {
      video.pause();
    }
  }, [ video ]);

  const seekBy = useCallback((seconds: number) => {
    if (!video) {
      return;
    }
    const end = Number.isFinite(video.duration) ? video.duration : video.currentTime;
    video.currentTime = clamp(video.currentTime + seconds, 0, end);
  }, [ video ]);

  const applyVolume = useCallback((next: number, nextMuted: boolean) => {
    const level = clamp(next, 0, 1);
    setVolume(level);
    setMuted(nextMuted);
    storeVolume(level, nextMuted);
    if (video) {
      video.volume = level;
      video.muted = nextMuted;
    }
  }, [ video ]);

  /* Fullscreen. */

  const toggleFullscreen = useCallback(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    if (document.fullscreenElement === root) {
      void document.exitFullscreen().catch(() => undefined);
    }
    else {
      void root.requestFullscreen().catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    const handleChange = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener('fullscreenchange', handleChange);
    return () => document.removeEventListener('fullscreenchange', handleChange);
  }, []);

  // Out of the way while watching, back the moment the pointer moves. Only in
  // fullscreen: in the page there is nothing for the bar to be in the way of.
  useEffect(() => {
    if (!fullscreen || !playing) {
      setBarVisible(true);
      return;
    }
    let timer = 0;
    const show = () => {
      setBarVisible(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setBarVisible(false), BAR_IDLE_MS);
    };
    show();
    const root = rootRef.current;
    root?.addEventListener('pointermove', show);
    return () => {
      window.clearTimeout(timer);
      root?.removeEventListener('pointermove', show);
    };
  }, [ fullscreen, playing ]);

  /* Dragging the picture. */

  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number; moved: boolean } | null>(null);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) {
      return;
    }
    dragRef.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y, moved: false };
    if (scale > 1) {
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  }, [ pan.x, pan.y, scale ]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || scale <= 1) {
      return;
    }
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) {
      return;
    }
    drag.moved = true;
    setPan({
      x: clamp(drag.panX + dx, -maxPanX, maxPanX),
      y: clamp(drag.panY + dy, -maxPanY, maxPanY)
    });
  }, [ maxPanX, maxPanY, scale ]);

  // A press that went nowhere was a click on the picture, which is the oldest
  // way there is to pause a video.
  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    dragRef.current = null;
    if (!drag.moved) {
      togglePlay();
    }
  }, [ togglePlay ]);

  /* Seeking. */

  const seekToClientX = useCallback((clientX: number) => {
    const bar = seekRef.current;
    if (!bar || !video || !Number.isFinite(video.duration)) {
      return;
    }
    const rect = bar.getBoundingClientRect();
    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
    video.currentTime = ratio * video.duration;
    setCurrentTime(video.currentTime);
  }, [ video ]);

  const scrubbingRef = useRef(false);

  const handleSeekPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) {
      return;
    }
    scrubbingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    seekToClientX(e.clientX);
  }, [ seekToClientX ]);

  const handleSeekPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (scrubbingRef.current) {
      seekToClientX(e.clientX);
    }
  }, [ seekToClientX ]);

  const handleSeekPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    scrubbingRef.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  /* Keyboard. */

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case ' ':
      case 'k':
        togglePlay();
        break;
      case 'ArrowLeft':
        seekBy(-SEEK_STEP_SECONDS);
        break;
      case 'ArrowRight':
        seekBy(SEEK_STEP_SECONDS);
        break;
      case 'ArrowUp':
        applyVolume(volume + VOLUME_STEP, false);
        break;
      case 'ArrowDown':
        applyVolume(volume - VOLUME_STEP, muted);
        break;
      case 'm':
        applyVolume(volume, !muted);
        break;
      case 'f':
        toggleFullscreen();
        break;
      case '0':
        setSizePercent(DEFAULT_SIZE_PERCENT);
        storePercent(DEFAULT_SIZE_PERCENT);
        setPan({ x: 0, y: 0 });
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }, [ applyVolume, muted, seekBy, toggleFullscreen, togglePlay, volume ]);

  /* Size. */

  const handlePresetChange = useCallback((next: SizePresetKey) => {
    setPreset(next);
    storePreset(next);
  }, []);

  const handlePercentChange = useCallback((next: number) => {
    const value = clamp(Math.round(next), MIN_SIZE_PERCENT, MAX_SIZE_PERCENT);
    setSizePercent(value);
    storePercent(value);
    if (value <= DEFAULT_SIZE_PERCENT) {
      setPan({ x: 0, y: 0 });
    }
  }, []);

  const handleSizeReset = useCallback(() => {
    handlePercentChange(DEFAULT_SIZE_PERCENT);
    setPan({ x: 0, y: 0 });
  }, [ handlePercentChange ]);

  /* Rendering. */

  const played = duration > 0 ? clamp(currentTime / duration, 0, 1) : 0;
  const loaded = duration > 0 ? clamp(bufferedTo / duration, 0, 1) : 0;
  // antd portals its popups to the end of the document, which in fullscreen is
  // outside the element being shown - so they are given a home in here.
  const getPopupContainer = useCallback(() => rootRef.current || document.body, []);

  return (
    <div
      ref={rootRef}
      className={[
        'video-player',
        fullscreen ? 'video-player--fullscreen' : '',
        barVisible ? '' : 'video-player--bar-hidden'
      ].filter(Boolean).join(' ')}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div
        className={`video-player__frame${scale > 1 ? ' video-player__frame--pannable' : ''}`}
        style={frameHeight > 0 ? {
          width: `${Math.round(frameWidth)}px`,
          height: `${Math.round(frameHeight)}px`
        } : undefined}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <video
          ref={setVideo}
          className="video-player__video"
          src={source.src}
          poster={source.poster}
          title={source.title}
          autoPlay={autoPlay}
          playsInline
          preload="metadata"
          controlsList="nodownload"
          disablePictureInPicture
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }}
        />
        <SubtitleOverlay video={video} />
        {
          !playing || waiting ? (
            <div className="video-player__state" aria-hidden>
              <Icon name={waiting && playing ? 'hourglass_empty' : 'play_arrow'} />
            </div>
          ) : null
        }
      </div>

      <div className="video-player__bar">
        <button
          type="button"
          className="player-menu player-menu--player"
          onClick={togglePlay}
          title={playing ? 'Pause' : 'Play'}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          <Icon name={playing ? 'pause' : 'play_arrow'} />
        </button>

        <span className="video-player__time">
          {formatTime(currentTime)}
          <span className="video-player__time-sep">/</span>
          {formatTime(duration)}
        </span>

        <div
          ref={seekRef}
          className="video-player__seek"
          role="slider"
          tabIndex={-1}
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(currentTime)}
          onPointerDown={handleSeekPointerDown}
          onPointerMove={handleSeekPointerMove}
          onPointerUp={handleSeekPointerUp}
          onPointerCancel={handleSeekPointerUp}
        >
          <div className="video-player__seek-track">
            <div className="video-player__seek-loaded" style={{ width: `${loaded * 100}%` }} />
            <div className="video-player__seek-played" style={{ width: `${played * 100}%` }} />
          </div>
          <div className="video-player__seek-handle" style={{ left: `${played * 100}%` }} />
        </div>

        <div className="video-player__volume">
          <button
            type="button"
            className="player-menu player-menu--player"
            onClick={() => applyVolume(volume, !muted)}
            title={muted ? 'Unmute' : 'Mute'}
            aria-label={muted ? 'Unmute' : 'Mute'}
          >
            <Icon name={muted || volume === 0 ? 'volume_off' : volume < 0.5 ? 'volume_down' : 'volume_up'} />
          </button>
          <input
            type="range"
            className="video-player__volume-slider"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            aria-label="Volume"
            onChange={(e) => applyVolume(Number(e.target.value), false)}
          />
        </div>

        {video ? <PlaybackRateControl video={video} variant="player" getPopupContainer={getPopupContainer} /> : null}
        {video ? <SubtitleControl video={video} variant="player" hideNativeCues getPopupContainer={getPopupContainer} /> : null}

        <PlayerSizeControl
          preset={preset}
          percent={sizePercent}
          onPresetChange={handlePresetChange}
          onPercentChange={handlePercentChange}
          onReset={handleSizeReset}
          pannable={scale > 1}
          getPopupContainer={getPopupContainer}
        />

        <button
          type="button"
          className="player-menu player-menu--player"
          onClick={toggleFullscreen}
          title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        >
          <Icon name={fullscreen ? 'fullscreen_exit' : 'fullscreen'} />
        </button>

        {
          onClose && !fullscreen ? (
            <button
              type="button"
              className="player-menu player-menu--player"
              onClick={onClose}
              title="Close player"
              aria-label="Close player"
            >
              <Icon name="close" />
            </button>
          ) : null
        }
      </div>
    </div>
  );
}

export default VideoPlayer;
