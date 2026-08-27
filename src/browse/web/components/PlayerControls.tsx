import "../assets/styles/PlayerControls.scss";
import useActiveVideo from "../utils/useActiveVideo";
import PlaybackRateControl from "./PlaybackRateControl";
import SubtitleControl from "./SubtitleControl";

/**
 * The controls that sit over a playing video.
 *
 * They float above the lightbox rather than living inside it, because the
 * player is built by lightgallery and is not ours to render into. Keeping
 * them in one container means one place decides where they go, and one piece
 * of code works out which video is playing - rather than each control
 * repeating the detection and then trying to line itself up beside the others.
 */
function PlayerControls() {
  const video = useActiveVideo();

  if (!video) {
    return null;
  }

  return (
    <div className="player-controls">
      <SubtitleControl video={video} />
      <PlaybackRateControl video={video} />
    </div>
  );
}

export default PlayerControls;
