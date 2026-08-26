import "../assets/styles/LightGalleryItem.scss";
import { useEffect, useState } from "react";
import { Badge, Card } from "react-bootstrap";

export interface LightGalleryItemProps {
  id: string;
  href?: string;
  dataSrc?: string;
  dataVideo?: string;
  dataPoster?: string;
  dataIframe?: boolean;
  dataSubHTML?: string;
  thumbnailURL?: string;
  classNamePrefix: string;
  style?: React.CSSProperties;
  badge?: string;
  /**
   * When given, the tile is handled here instead of by lightgallery - it keeps
   * the same look but is no longer picked up as a slide.
   */
  onClick?: () => void;
}

function LightGalleryItem(props: LightGalleryItemProps) {
  const {
    href,
    dataSrc,
    dataVideo,
    dataPoster,
    dataIframe,
    dataSubHTML,
    thumbnailURL,
    classNamePrefix,
    style,
    badge,
    onClick
  } = props;
  // The poster can 404 - e.g. a video whose thumbnail was never downloaded and
  // for which the server could not generate a frame either.
  const [posterFailed, setPosterFailed] = useState(false);
  useEffect(() => setPosterFailed(false), [thumbnailURL]);
  const showPoster = !!thumbnailURL && !posterFailed;

  let extraClassName = dataVideo ? `${classNamePrefix}__thumbnail-wrapper--video` : '';
  if (!showPoster) {
    extraClassName += ` ${classNamePrefix}__thumbnail-wrapper--empty`;
  }
  return (
    <a
      href={href}
      className={`${onClick ? '' : 'lightgallery-item'} ${classNamePrefix}__thumbnail-wrapper ${extraClassName}`}
      onClick={onClick ? (e) => { e.preventDefault(); onClick(); } : undefined}
      data-src={dataSrc}
      data-video={dataVideo}
      data-poster={dataPoster}
      data-iframe={dataIframe || undefined}
      data-sub-html={dataSubHTML}
      style={style}
    > {
        showPoster ? (
          <img
            src={thumbnailURL}
            className={`${classNamePrefix}__thumbnail`}
            onError={() => setPosterFailed(true)}
          />
        )
        : (
          <Card className="w-100 h-100 d-flex align-items-center justify-content-center">
            <span className="material-icons-outlined text-secondary" style={{fontSize: '5em'}}>
              {dataVideo ? 'movie' : 'description'}
            </span>
          </Card>
        )
      }
      {
        badge ? (
          <Badge className="light-gallery-item__badge" bg="secondary">
            {badge}
          </Badge>
        ) : null
      }
    </a>
  )
}

export default LightGalleryItem;