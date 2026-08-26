import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { type MediaListItem } from "../../types/Media";
import "../assets/styles/MediaGallery.scss";
import LightGallery from 'lightgallery/react';
import "lightgallery/css/lightgallery.css";
import "lightgallery/css/lg-zoom.css";
import "lightgallery/css/lg-thumbnail.css";
import "lightgallery/css/lg-video.css";
import lgThumbnail from 'lightgallery/plugins/thumbnail';
import lgZoom from 'lightgallery/plugins/zoom';
import lgVideo from 'lightgallery/plugins/video';
import LightGalleryItem, { type LightGalleryItemProps } from "./LightGalleryItem";
import PdfViewerModal, { type PdfViewerTarget } from "./PdfViewerModal";
import { formatFileSize, getContentUrlForMedia, getFileExtension, getFileIcon } from "../utils/Misc";

interface MediaGalleryProps {
  items: MediaListItem<any>[];
}

const ROW_HEIGHT = 160;
const FILE_TILE_WIDTH = 220;
const BORDER_WIDTH = 0;
const GAP = 8;

type LGProps = Omit<LightGalleryItemProps, 'classNamePrefix' | 'style'>;

interface FileProps {
  filename: string;
  extension: string;
  icon: string;
  size: string | null;
  downloadURL: string;
}

/**
 * A single entry in the gallery. Entries with `lg` open in the lightbox;
 * entries with `file` (archives, 3D models, documents...) are shown as a
 * download card, since there is nothing to preview.
 */
interface GalleryTile {
  id: string;
  /** Natural width at `ROW_HEIGHT`, used both for row packing and flex-basis. */
  width: number;
  sourceTitle: string | null;
  sourceURL: string;
  lg?: LGProps;
  file?: FileProps;
  /** Opens in the in-page reader instead of the lightbox. */
  pdf?: PdfViewerTarget;
}

function buildTile(mi: MediaListItem<any>): GalleryTile {
  const mediaURL = `/media/${mi.id}`;
  const isImage = !mi.mimeType || mi.mimeType.startsWith('image/');
  const isVideo = mi.mimeType?.startsWith('video/') ?? false;
  const isAudio = mi.mimeType?.startsWith('audio/') ?? false;
  const isPDF = mi.mimeType?.toLowerCase() === 'application/pdf';

  const sourceTitle = mi.source.type === 'post' ? mi.source.title : mi.source.name;
  const base = {
    id: mi.id,
    sourceTitle,
    sourceURL: getContentUrlForMedia(mi.source, mi.id)
  };

  // Anything without a preview becomes a file card.
  if (!isImage && !isVideo && !isAudio && !isPDF) {
    const filename = mi.filename || mi.id;
    return {
      ...base,
      width: FILE_TILE_WIDTH,
      file: {
        filename,
        extension: getFileExtension(filename).toUpperCase(),
        icon: getFileIcon(filename),
        size: formatFileSize(mi.size),
        downloadURL: `${mediaURL}?dl=1`
      }
    };
  }

  let thumbnailURL: string | undefined = undefined;
  if (mi.thumbnail) {
    thumbnailURL = `${mediaURL}?t=1`;
  }
  // An image with no stored thumbnail is its own best preview - the server
  // serves the full file for "?t=1" in that case. Borrowing the post's cover
  // here showed the wrong picture in the gallery.
  else if (isImage) {
    thumbnailURL = mediaURL;
  }
  // Use post / product image if media has no thumbnail (notably PDFs)
  else if (mi.source.type === 'post') {
    if (mi.source.thumbnail?.downloaded?.path) {
      thumbnailURL = `/media/post:${mi.source.id}:thumbnail`;
    }
    else if (mi.source.coverImage?.downloaded?.path) {
      thumbnailURL = `/media/post:${mi.source.id}:cover`;
    }
  }
  else if (mi.source.type === 'product') {
    const img = mi.source.previewMedia.find((pm: any) => pm.type === 'image' && pm.downloaded?.thumbnail?.path) ||
      mi.source.contentMedia.find((cm: any) => cm.type === 'image' && cm.downloaded?.thumbnail?.path);
    if (img) {
      thumbnailURL = `/media/${img.id}`;
    }
  }
  // Nothing to show for a video: ask anyway, so the server can grab a frame
  // from the video file itself.
  if (!thumbnailURL && isVideo) {
    thumbnailURL = `${mediaURL}?t=1`;
  }

  const dataAV = isVideo || isAudio ? JSON.stringify({
    source: [
      {
        src: mediaURL,
        type: mi.mimeType as string,
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
  const dataSubHTML = sourceTitle ?
    `<h4><a class="media-gallery__source-link" href="${base.sourceURL}">${sourceTitle}</a></h4>`
    : undefined;

  const width = mi.thumbnail?.width && mi.thumbnail?.height ?
    BORDER_WIDTH + (ROW_HEIGHT / mi.thumbnail.height) * mi.thumbnail.width
    : BORDER_WIDTH + ROW_HEIGHT;

  return {
    ...base,
    width,
    lg: {
      id: mi.id,
      href: isImage || isPDF ? mediaURL : undefined,
      dataSrc: isImage ? mediaURL : undefined,
      dataVideo: dataAV,
      dataPoster: isVideo || isAudio ? thumbnailURL : undefined,
      dataSubHTML,
      thumbnailURL,
      badge: isPDF ? 'PDF' : undefined
    },
    pdf: isPDF ? { url: mediaURL, filename: mi.filename || mi.id } : undefined
  };
}

function FileTile(props: { file: FileProps }) {
  const { file } = props;
  return (
    <a
      className="media-gallery__file"
      href={file.downloadURL}
      title={`Download ${file.filename}`}
    >
      <span className="material-icons-outlined media-gallery__file-icon">{file.icon}</span>
      <span className="media-gallery__file-name">{file.filename}</span>
      <span className="media-gallery__file-meta">
        {file.extension ? <span className="media-gallery__file-ext">{file.extension}</span> : null}
        {file.size ? <span>{file.size}</span> : null}
        <span className="material-icons media-gallery__file-download">download</span>
      </span>
    </a>
  );
}

function MediaGallery(props: MediaGalleryProps) {
  const { items } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const [pdfTarget, setPdfTarget] = useState<PdfViewerTarget | null>(null);

   useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      const { width } = entries[0].contentRect;
      setContainerWidth(width);
    });

    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => observer.disconnect();
  }, []);

  const tiles = useMemo(() => items.map(buildTile), [items]);

  // Pack tiles into rows of `containerWidth`. Tiles on the last row keep their
  // natural width instead of stretching to fill it.
  const rows = useMemo(() => {
    if (!containerWidth) {
      return null;
    }
    const result: GalleryTile[][] = [[]];
    let rowIndex = 0;
    let aggregateWidth = 0;
    for (const tile of tiles) {
      let gapWidth = result[rowIndex].length > 0 ? GAP : 0;
      if (result[rowIndex].length > 0 && (aggregateWidth + gapWidth + tile.width > containerWidth)) {
        rowIndex++;
        aggregateWidth = 0;
        gapWidth = 0;
        result.push([]);
      }
      result[rowIndex].push(tile);
      aggregateWidth += gapWidth + tile.width;
    }
    return result;
  }, [tiles, containerWidth]);

  const renderedTiles = useMemo(() => {
    if (!rows) {
      return null;
    }
    return rows.reduce<React.ReactNode[]>((result, rowTiles, rowIndex) => {
      const isLastRow = rowIndex === rows.length - 1;
      for (const tile of rowTiles) {
        result.push(
          <div
            key={`media-gallery-item-${tile.id}`}
            className={`media-gallery__item ${tile.file ? 'media-gallery__item--file' : ''}`}
            style={{
              flexGrow: isLastRow ? 0 : 1,
              flexBasis: `${tile.width}px`
            }}
          >
            {
              tile.lg ?
                <LightGalleryItem
                  {...tile.lg}
                  classNamePrefix="media-gallery"
                  onClick={tile.pdf ? () => setPdfTarget(tile.pdf!) : undefined}
                />
                : tile.file ? <FileTile file={tile.file} /> : null
            }
            {
              tile.sourceTitle ? (
                <Link
                  to={tile.sourceURL}
                  className="media-gallery__source"
                  title={`Go to "${tile.sourceTitle}"`}
                >
                  <span className="material-icons media-gallery__source-icon">subdirectory_arrow_left</span>
                  <span className="media-gallery__source-title">{tile.sourceTitle}</span>
                </Link>
              ) : null
            }
          </div>
        );
      }
      return result;
    }, []);
  }, [rows]);

  return (
    <LightGallery
      speed={500}
      plugins={[lgThumbnail, lgZoom, lgVideo]}
      // lightgallery defaults this to true, which puts a download icon in
      // the lightbox toolbar - nothing to do with the player's own controls.
      download={false}
      selector=".lightgallery-item"
    >
      <div
        ref={containerRef}
        className="w-100 media-gallery mb-4"
        style={{
          '--media-gallery-row-height': `${ROW_HEIGHT}px`,
          '--media-gallery-gap': `${GAP}px`,
          '--media-gallery-thumbnail-border': `${BORDER_WIDTH}px`,
        } as React.CSSProperties}
      >
        {renderedTiles}
      </div>
      <PdfViewerModal target={pdfTarget} onClose={() => setPdfTarget(null)} />
    </LightGallery>
  )
}

export default MediaGallery;
