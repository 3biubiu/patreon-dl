import { useCallback, useEffect, useState } from "react";
import { useAPI } from "../contexts/APIProvider";
import { getMediaIdFromVideo } from "../utils/useActiveVideo";
import PlayerMenuButton, { type PlayerControlVariant } from "./PlayerMenuButton";
import { type SubtitleFile } from "../../types/Transcription";
import { TARGET_LANGUAGE } from "../../types/Translation";

const OFF = '';

/**
 * Which track a video opens on.
 *
 * The Chinese translation wins whenever there is one - it is the reason it was
 * made, and having to reach for the menu on every video would undo that.
 * Otherwise the first of whatever is there, so a video with only its original
 * captions still opens with them showing.
 */
function pickDefault(subtitles: SubtitleFile[]) {
  const translated = subtitles.find((subtitle) =>
    subtitle.language === TARGET_LANGUAGE ||
    subtitle.language?.startsWith(`${TARGET_LANGUAGE}-`)
  );
  return translated?.filename || subtitles[0]?.filename || OFF;
}

/** Marks the tracks this control put there, so it only ever removes its own. */
const MANAGED = 'data-subtitle-control';

interface SubtitleControlProps {
  video: HTMLVideoElement;
  variant: PlayerControlVariant;
  /**
   * Leaves the chosen track in `hidden` mode: its cues still fire, but the
   * browser does not paint them. For the in-page player, which draws them
   * itself so that zooming the picture cannot crop them away.
   */
  hideNativeCues?: boolean;
  getPopupContainer?: () => HTMLElement;
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
  const { video, variant, hideNativeCues = false, getPopupContainer } = props;
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
      element.track.mode = hideNativeCues ? 'hidden' : 'showing';
    }
  }, [ api, hideNativeCues, mediaId, subtitles, video ]);

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
          setSelected(pickDefault(found));
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
      getPopupContainer={getPopupContainer}
    />
  );
}

export default SubtitleControl;
