import "../assets/styles/MediaGrid.scss";
import { type Downloadable } from "../../../entities/Downloadable";
import { Badge, Stack } from "react-bootstrap";

import LightGallery from 'lightgallery/react';
import "lightgallery/css/lightgallery.css";
import "lightgallery/css/lg-zoom.css";
import "lightgallery/css/lg-thumbnail.css";
import "lightgallery/css/lg-video.css";
import lgThumbnail from 'lightgallery/plugins/thumbnail';
import lgZoom from 'lightgallery/plugins/zoom';
import lgVideo from 'lightgallery/plugins/video';
import LightGalleryItem, { type LightGalleryItemProps } from "./LightGalleryItem";
import path from "path";
import Icon from "./Icon";

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
      result.push({
        id: mi.id,
        href,
        dataSrc: dataImage,
        dataVideo,
        dataPoster,
        dataSubHTML,
        thumbnailURL
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

  const contents = (
    <div className={`media-grid media-grid--${cells}`}>
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

  if (noGallery) {
    return contents;
  }

  return (
    <LightGallery
      speed={500}
      plugins={[lgThumbnail, lgZoom, lgVideo]}
      videojs
      // lightgallery defaults this to true, which puts a download icon in
      // the lightbox toolbar - nothing to do with the player's own controls.
      download={false}
      selector=".lightgallery-item"
    >
      {contents}
    </LightGallery>
  )
}

export default MediaGrid;