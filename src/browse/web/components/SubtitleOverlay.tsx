import { useEffect, useState } from "react";

/** WebVTT allows inline tags (<i>, <c.classname>...); this shows the words. */
function toPlainText(text: string) {
  return text.replace(/<[^>]*>/g, '').trim();
}

interface SubtitleOverlayProps {
  video: HTMLVideoElement | null;
}

/**
 * Draws the captions itself, instead of letting the browser draw them.
 *
 * The browser renders cues inside the video element, which this player scales
 * and drags about - so at anything above 100% the captions would be cropped
 * along with the picture, and the one thing nobody wants cropped is the
 * subtitles. Drawn here they sit in the frame instead, and stay put however
 * the picture is moved.
 *
 * Depends on whoever attached the track leaving it in `hidden` mode: cues then
 * fire `cuechange` without being painted. `SubtitleControl` does this when it
 * is told captions are being rendered elsewhere.
 */
function SubtitleOverlay(props: SubtitleOverlayProps) {
  const { video } = props;
  const [ lines, setLines ] = useState<string[]>([]);

  useEffect(() => {
    if (!video) {
      setLines([]);
      return;
    }
    const tracks = video.textTracks;

    const update = () => {
      const result: string[] = [];
      for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i];
        // A track the viewer switched off, or one the browser is painting
        // itself - either way not ours to draw.
        if (track.mode !== 'hidden') {
          continue;
        }
        const active = track.activeCues;
        for (let j = 0; j < (active?.length || 0); j++) {
          const cue = active?.[j] as VTTCue | undefined;
          const text = cue?.text ? toPlainText(cue.text) : '';
          if (text) {
            result.push(text);
          }
        }
      }
      setLines(result);
    };

    // Tracks come and go as the viewer picks a language, so the listeners have
    // to follow them rather than being attached once.
    const listening = new Set<TextTrack>();
    const sync = () => {
      for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i];
        if (!listening.has(track)) {
          track.addEventListener('cuechange', update);
          listening.add(track);
        }
      }
      update();
    };

    sync();
    tracks.addEventListener('addtrack', sync);
    tracks.addEventListener('removetrack', sync);
    tracks.addEventListener('change', sync);

    return () => {
      tracks.removeEventListener('addtrack', sync);
      tracks.removeEventListener('removetrack', sync);
      tracks.removeEventListener('change', sync);
      listening.forEach((track) => track.removeEventListener('cuechange', update));
    };
  }, [ video ]);

  if (lines.length === 0) {
    return null;
  }

  return (
    <div className="video-player__captions" aria-live="polite">
      {lines.map((line, index) => (
        <span key={index} className="video-player__caption-line">
          {line.split('\n').map((part, partIndex) => (
            <span key={partIndex} className="video-player__caption-text">{part}</span>
          ))}
        </span>
      ))}
    </div>
  );
}

export default SubtitleOverlay;
