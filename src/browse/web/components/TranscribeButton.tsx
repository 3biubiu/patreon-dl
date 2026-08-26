import "../assets/styles/TranscribeButton.scss";
import Icon from "./Icon";
import useTranscription from "../utils/useTranscription";

interface TranscribeButtonProps {
  mediaId: string;
  /** Skips fetching until the tile is on screen and worth asking about. */
  enabled?: boolean;
}

/**
 * The corner control on a video tile that starts a transcription and then
 * shows how it is going.
 *
 * It sits inside the tile's anchor, which lightgallery uses to open the
 * lightbox, so every event it handles has to be stopped before it gets there -
 * otherwise starting a transcription would also start playing the video.
 */
function TranscribeButton(props: TranscribeButtonProps) {
  const { mediaId, enabled = true } = props;
  const { running, captioned, percent, error, busy, start, cancel } = useTranscription(mediaId, enabled);

  const handleClick = (e: React.MouseEvent) => {
    // Both, and on the button rather than the anchor: `preventDefault` alone
    // still lets lightgallery's delegated handler see the click.
    e.preventDefault();
    e.stopPropagation();
    if (busy) {
      return;
    }
    if (running) {
      void cancel();
    }
    else {
      void start();
    }
  };

  let modifier = '';
  let icon = 'closed_caption';
  let label = 'Transcribe';
  let title = 'Generate subtitles for this video';

  if (running) {
    modifier = 'transcribe-button--running';
    icon = 'hourglass_top';
    label = `${percent}%`;
    title = 'Transcribing - click to cancel';
  }
  else if (captioned) {
    modifier = 'transcribe-button--done';
    icon = 'closed_caption';
    label = 'CC';
    title = 'Subtitles available - click to transcribe again';
  }
  else if (error) {
    modifier = 'transcribe-button--error';
    icon = 'error_outline';
    label = 'Failed';
    title = error;
  }

  return (
    <button
      type="button"
      className={`transcribe-button ${modifier}`}
      onClick={handleClick}
      title={title}
      aria-label={title}
      disabled={busy}
    >
      <Icon name={icon} />
      <span className="transcribe-button__label">{label}</span>
    </button>
  );
}

export default TranscribeButton;
