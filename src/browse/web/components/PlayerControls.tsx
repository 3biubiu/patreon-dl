import "../assets/styles/PlayerControls.scss";
import { createPortal } from "react-dom";
import useActiveVideo from "../utils/useActiveVideo";
import useLightboxToolbar from "../utils/useLightboxToolbar";
import PlaybackRateControl from "./PlaybackRateControl";
import SubtitleControl from "./SubtitleControl";

/**
 * The controls that sit over a playing video.
 *
 * They render into lightgallery's own toolbar, beside its zoom and close
 * buttons, which is where a viewer looks for them. Appending to that toolbar
 * is what lightgallery's own plugins do - the zoom buttons arrive the same
 * way - so this is joining in rather than working around anything.
 *
 * A portal rather than an lightgallery plugin: the subtitle picker fetches and
 * holds state, which is React's job, and a plugin would mean rebuilding that
 * imperatively. React owns the subtree, lightgallery owns the parent, and the
 * portal is torn down when the toolbar goes.
 *
 * When the toolbar cannot be found - lightgallery renaming a class, say - the
 * controls float over the lightbox instead. Worse looking, still working.
 */
function PlayerControls() {
  const video = useActiveVideo();
  const toolbar = useLightboxToolbar(video);

  if (!video) {
    return null;
  }

  if (toolbar) {
    return createPortal(
      // Its own element so lightgallery's `float: right` toolbar layout keeps
      // the pair together, in order, rather than interleaving them with the
      // buttons already there.
      <div className="player-controls player-controls--toolbar">
        <PlaybackRateControl video={video} variant="toolbar" />
        <SubtitleControl video={video} variant="toolbar" />
      </div>,
      toolbar
    );
  }

  return (
    <div className="player-controls player-controls--floating">
      <SubtitleControl video={video} variant="floating" />
      <PlaybackRateControl video={video} variant="floating" />
    </div>
  );
}

export default PlayerControls;
