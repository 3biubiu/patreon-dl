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
    const isImage = !mi.downloaded?.mimeType || mi.downloaded.mimeType.startsWith('image/');
    const isVideo = mi.downloaded?.mimeType?.startsWith('video/') ?? false;
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
      : fallbackThumbnailURL;
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
        playsInline: true
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
            <span className="material-icons me-2">image</span>
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
      selector=".lightgallery-item"
    >
      {contents}
    </LightGallery>
  )
}

export default MediaGrid;