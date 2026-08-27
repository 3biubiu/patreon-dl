import { useCallback, useEffect, useState } from "react";
import { useAPI } from "../contexts/APIProvider";
import { getMediaIdFromVideo } from "../utils/useActiveVideo";
import PlayerMenuButton from "./PlayerMenuButton";
import { type SubtitleFile } from "../../types/Transcription";

const OFF = '';

/** Marks the tracks this control put there, so it only ever removes its own. */
const MANAGED = 'data-subtitle-control';

interface SubtitleControlProps {
  video: HTMLVideoElement;
  variant: 'toolbar' | 'floating';
}

/**
 * Picks which captions a player shows.
 *
 * The list comes from the video's own directory, read when a video actually
 * starts playing. That is one directory read for one video, which is what
 * makes it affordable to include captions somebody dropped in by hand rather
 * than only the ones this app generated - the grid, which draws hundreds of
 * tiles, uses the index instead and never touches the library.
 *
 * Tracks are attached to the element directly. The player is lightgallery's,
 * built from a JSON attribute long before this runs, so waiting for a chance
 * to render into it would mean waiting forever.
 */
function SubtitleControl(props: SubtitleControlProps) {
  const { video, variant } = props;
  const { api } = useAPI();
  const mediaId = getMediaIdFromVideo(video);
  const [ subtitles, setSubtitles ] = useState<SubtitleFile[]>([]);
  const [ selected, setSelected ] = useState<string>(OFF);

  /**
   * Points the element at `filename`, or clears captions when it is empty.
   * Tracks that came with the player are switched off rather than removed:
   * they are not ours, and a disabled track is invisible either way.
   */
  const applyTrack = useCallback((filename: string) => {
    if (!mediaId) {
      return;
    }
    video.querySelectorAll(`track[${MANAGED}]`).forEach((track) => track.remove());
    for (let i = 0; i < video.textTracks.length; i++) {
      video.textTracks[i].mode = 'disabled';
    }
    if (!filename) {
      return;
    }
    const subtitle = subtitles.find((s) => s.filename === filename);
    if (!subtitle) {
      return;
    }
    const element = document.createElement('track');
    element.kind = 'captions';
    element.src = api.getSubtitleURL(mediaId, subtitle.filename);
    element.srclang = subtitle.language || 'und';
    element.label = subtitle.label;
    element.setAttribute(MANAGED, '');
    video.appendChild(element);
    // Only valid once the element is in the document, which is why this is
    // not set before appending.
    if (element.track) {
      element.track.mode = 'showing';
    }
  }, [ api, mediaId, subtitles, video ]);

  useEffect(() => {
    if (!mediaId) {
      setSubtitles([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const found = await api.getSubtitles(mediaId);
        if (!cancelled) {
          setSubtitles(found);
          // Whatever the player was given to start with is replaced by this
          // list, which is a superset of it.
          setSelected(found.length > 0 ? found[0].filename : OFF);
        }
      }
      catch {
        if (!cancelled) {
          setSubtitles([]);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [ api, mediaId ]);

  useEffect(() => {
    applyTrack(selected);
  }, [ applyTrack, selected ]);

  // Nothing to choose between, so nothing to show. An empty picker would only
  // raise the question of what is missing.
  if (subtitles.length === 0) {
    return null;
  }

  return (
    <PlayerMenuButton
      icon={selected ? 'closed_caption' : 'closed_caption_disabled'}
      label="Subtitles"
      value={selected}
      items={[
        { key: OFF, label: 'Off' },
        ...subtitles.map((subtitle) => ({ key: subtitle.filename, label: subtitle.label }))
      ]}
      onSelect={setSelected}
      variant={variant}
    />
  );
}

export default SubtitleControl;
