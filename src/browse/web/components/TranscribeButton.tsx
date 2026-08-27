import "../assets/styles/TranscribeButton.scss";
import { useState } from "react";
import { Checkbox, Popconfirm } from "antd";
import Icon from "./Icon";
import useTranscription from "../utils/useTranscription";
import useTranslationAvailability from "../utils/useTranslationAvailability";
import { readTranslatePreference, writeTranslatePreference } from "../utils/translatePreference";

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
 * otherwise starting a transcription would also start playing the video. The
 * confirmation itself is portalled to the end of the document, so clicks
 * inside it never reach the tile at all - which is also what makes it safe to
 * put a checkbox in there.
 */
function TranscribeButton(props: TranscribeButtonProps) {
  const { mediaId, enabled = true } = props;
  const {
    running, captioned, percent, error, busy, translating, translated, start, cancel
  } = useTranscription(mediaId, enabled);
  const availability = useTranslationAvailability(enabled);
  const [ confirming, setConfirming ] = useState(false);
  const [ translate, setTranslate ] = useState(readTranslatePreference);

  const canTranslate = !!availability?.available;

  const stop = (e: React.MouseEvent | React.KeyboardEvent) => {
    // Both, and on the button rather than the anchor: `preventDefault` alone
    // still lets lightgallery's delegated handler see the click.
    e.preventDefault();
    e.stopPropagation();
  };

  const handleClick = (e: React.MouseEvent) => {
    stop(e);
    if (!busy) {
      setConfirming(true);
    }
  };

  const handleConfirm = () => {
    setConfirming(false);
    void (running || translating ? cancel() : start(canTranslate && translate));
  };

  const active = running || translating;

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
  else if (translating) {
    modifier = 'transcribe-button--running';
    icon = 'translate';
    label = 'AI';
    title = 'Translating - click to cancel';
  }
  else if (captioned) {
    modifier = 'transcribe-button--done';
    icon = 'closed_caption';
    label = translated ? 'CC 中' : 'CC';
    title = translated ?
      'Subtitles and a Chinese translation are available - click to transcribe again'
      : 'Subtitles available - click to transcribe again';
  }
  else if (error) {
    modifier = 'transcribe-button--error';
    icon = 'error_outline';
    label = 'Failed';
    title = error;
  }

  const description = active ?
    'Progress so far is discarded and nothing is written.'
    : (
      <>
        <div>
          {
            captioned ?
              'This video already has subtitles. Transcribing again replaces them.'
              : 'It runs in the background and costs roughly $0.01 per hour of video.'
          }
        </div>
        {
          canTranslate ? (
            <Checkbox
              checked={translate}
              onChange={(e) => {
                setTranslate(e.target.checked);
                // Remembered, so the answer given once is the answer offered
                // next time rather than a click on every video.
                writeTranslatePreference(e.target.checked);
              }}
              style={{ marginBlockStart: 8 }}
            >
              Also translate to Chinese
            </Checkbox>
          ) : null
        }
      </>
    );

  return (
    <Popconfirm
      open={confirming}
      title={active ? 'Cancel this?' : 'Transcribe this video?'}
      description={description}
      okText={active ? 'Cancel it' : 'Transcribe'}
      cancelText="Never mind"
      okButtonProps={{ danger: active }}
      onConfirm={handleConfirm}
      onCancel={() => setConfirming(false)}
    >
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
    </Popconfirm>
  );
}

export default TranscribeButton;
