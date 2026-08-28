import "../assets/styles/MediaGrid.scss";
import { type Downloadable } from "../../../entities/Downloadable";
import { Badge, Stack } from "react-bootstrap";
import { useState } from "react";
import VideoPlayer, { type VideoPlayerSource } from "./VideoPlayer";

import Lightbox from "./Lightbox";
import LightGalleryItem, { type LightGalleryItemProps } from "./LightGalleryItem";
import path from "path";
import Icon from "./Icon";
import TranscribeButton from "./TranscribeButton";
import { useAuth } from "../contexts/AuthProvider";

const VIDEO_EXTENSIONS = [
  '.mp4', '.m4v', '.mkv', '.webm', '.mov', '.avi', '.flv', '.wmv', '.mpg', '.mpeg', '.ts', '.m2ts', '.ogv'
];

interface MediaGridProps {
  items: Downloadable[];
  title: string;
  noGallery?: boolean;
  /**
   * Poster to use for media whose own thumbnail was never downloaded -
   * typically the post's cover image, which is what Patreon supplies as the
   * embed thumbnail in the first place.
   */
  fallbackThumbnailURL?: string;
}

type MediaGridItemProps =
  Omit<LightGalleryItemProps, 'classNamePrefix' | 'style'> &
  { hidden?: boolean; };

function MediaGridItem(props: MediaGridItemProps) {
  const { hidden = false } = props;
  return (
    <LightGalleryItem
      {...props}
      classNamePrefix="media-grid"
      style={{
        display: hidden ? 'none' : 'inherit'
      }}
    />
  )
}

function MediaGrid(props: MediaGridProps) {
  const { items: _mi, title, noGallery = false, fallbackThumbnailURL } = props;
  const { user } = useAuth();
  // Videos are played here in the page; only the images still go to the
  // lightbox. The tiles are hidden rather than unmounted while one plays, so
  // that the lightbox keeps the elements it was built around.
  const [ playing, setPlaying ] = useState<VideoPlayerSource | null>(null);
  // Making subtitles costs money and writes into the library, so the control
  // is only drawn for the people allowed to do it. The server enforces this
  // too - this just keeps the button out of everyone else's way.
  const canTranscribe = user?.role === 'admin';
  const mediaItems = _mi.filter((mi) => mi.downloaded?.path);
  const lgItemProps = mediaItems.reduce<MediaGridItemProps[]>((result, mi) => {
    // mimeType can be null when the downloader could not sniff the file, which
    // happens with externally downloaded videos. Fall back to the extension so
    // such files are not mistaken for images.
    const mimeType = mi.downloaded?.mimeType;
    const ext = path.extname(mi.downloaded?.path || mi.filename || '').toLowerCase();
    const isVideo = mimeType ?
      mimeType.startsWith('video/')
      : VIDEO_EXTENSIONS.includes(ext);
    const isImage = mimeType ?
      mimeType.startsWith('image/')
      : (!isVideo && !ext);
    const mediaURL = `/media/${mi.id}`;
    const href = isImage ? mediaURL : undefined;
    // Only ask for the stored thumbnail when there actually is one. The server
    // falls back to the full file for images, but returns 404 for anything else
    // (notably videos whose poster was never downloaded), which would otherwise
    // render as a broken image.
    const hasThumbnail = !!mi.downloaded?.thumbnail?.path;
    const thumbnailURL =
      hasThumbnail ? `${mediaURL}?t=1`
      : isImage ? mediaURL
      // Prefer the post's own cover when there is one; otherwise ask for the
      // thumbnail anyway, which lets the server grab a frame from the video.
      : fallbackThumbnailURL ? fallbackThumbnailURL
      : isVideo ? `${mediaURL}?t=1`
      : undefined;
    const dataImage = isImage ? mediaURL : undefined;
    const dataVideo = isVideo ? JSON.stringify({
      source: [
        {
            src: mediaURL,
            type: mi.downloaded?.mimeType as string,
        },
      ],
      attributes: {
        preload: false,
        controls: true,
        playsInline: true,
        // Drops the download entry from the player's own menu, and the
        // picture-in-picture window that would put the stream outside the page.
        controlsList: 'nodownload',
        disablePictureInPicture: true
      }
    }) : undefined;
    const dataPoster = isVideo? thumbnailURL : undefined;
    const dataSubHTML = title ? `<h4>${title}</h4>` : undefined;
    if (dataImage || dataVideo) {
      const source: VideoPlayerSource | null = isVideo ?
        { id: mi.id, src: mediaURL, poster: thumbnailURL, title }
        : null;
      result.push({
        id: mi.id,
        href,
        dataSrc: dataImage,
        dataVideo,
        dataPoster,
        dataSubHTML,
        thumbnailURL,
        overlay: isVideo && canTranscribe ? <TranscribeButton mediaId={mi.id} /> : undefined,
        onClick: source ? () => setPlaying(source) : undefined
      });
    }
    return result;
  }, []);
  if (lgItemProps.length === 0) {
    return null;
  }
  const cells = Math.min(lgItemProps.length, 4);
  const items = lgItemProps.slice(0, cells).map((m) => (
      <Stack
        key={m.id}
        direction="horizontal"
        className="media-grid__item-wrapper justify-content-center overflow-hidden"
      >
        {
          m.thumbnailURL ? (
            <div className="media-grid__thumbnail-backdrop"
              style={{
                background: `url(${m.thumbnailURL})`,
              }}
            />
          ) : null
        }
        <MediaGridItem {...m} />
      </Stack>
    ));

  const grid = (
    <div className={`media-grid media-grid--${cells}${playing ? ' media-grid--hidden' : ''}`}>
      {items}
      {
        lgItemProps.length > 4 ?
          lgItemProps.slice(4).map((lg) => (
            <MediaGridItem {...lg} hidden />
          ))
          : null
      }
      {
        lgItemProps.length > 1 ?
          <Badge className="media-grid__badge d-flex align-items-center">
            <Icon name="image" className="me-2" />
            {lgItemProps.length}
          </Badge>
          : null
      }
    </div>
  );

  const contents = (
    <>
      {grid}
      {
        playing ? (
          <VideoPlayer
            key={playing.id}
            source={playing}
            autoPlay
            onClose={() => setPlaying(null)}
          />
        ) : null
      }
    </>
  );

  if (noGallery) {
    return contents;
  }

  return (
    <Lightbox itemsKey={lgItemProps.map((m) => m.id).join('|')} videojs>
      {contents}
    </Lightbox>
  )
}

export default MediaGrid;