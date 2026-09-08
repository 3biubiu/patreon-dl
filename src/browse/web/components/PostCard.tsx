import "../assets/styles/PostCard.scss";
import { type Downloadable, type Post } from "../../../entities";
import { Badge, Card, Stack } from "react-bootstrap";
import MediaGrid from "./MediaGrid";
import path from "path";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import MediaImage from "./MediaImage";
import Lightbox from "./Lightbox";
import FadeContent from "./FadeContent";
import PdfViewerModal, { type PdfViewerTarget } from "./PdfViewerModal";
import { getCampaignBaseUrl, getContentUrl, getFileExtension, getFileIcon, isVideoFile } from "../utils/Misc";
import Icon from "./Icon";
import FavoriteButton from "./FavoriteButton";
import { useDownload } from "../contexts/DownloadProvider";

interface PostCardProps {
  post: Post;
  showCampaign?: boolean;
  useShowMore?: boolean;
  contextQS?: string;
  /** Show the save-to-favorites toggle beside the title. Detail page only. */
  showFavorite?: boolean;
}

/** A downloaded file this post links to, however it is reached. */
interface AttachmentFile {
  mediaId: string;
  filename: string;
  /** Where it is served from; carries `lapid` for a linked attachment. */
  url: string;
  /** Read in the page rather than downloaded. */
  isPdf: boolean;
  /** Never handed out, so never offered - see `isVideoFile`. */
  isVideo: boolean;
}

function PostCard(props: PostCardProps) {
  const { post, showCampaign = false, useShowMore = false, contextQS, showFavorite = false } = props;
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const contentRef = useRef<HTMLDivElement>(null);
  const attachmentsRef = useRef<HTMLDivElement>(null);
  // Set when arriving from the media gallery, so the file that was clicked
  // there can be pointed out on this page.
  const highlightMediaId = searchParams.get('media');
  const [pdfTarget, setPdfTarget] = useState<PdfViewerTarget | null>(null);
  const { canDownload, requestDownload } = useDownload();

  /**
   * Every file this post can link to, by media id: its own attachments plus
   * the ones linked from other posts, which the server rewrites to
   * `/media/...` in the body.
   *
   * Read by both the attachment list and the body click handler, so that a
   * file behaves the same wherever it is clicked - a PDF opens in the reader
   * the media gallery uses, and anything else is a download, which is a thing
   * an administrator asks for rather than a link anyone can follow.
   */
  const filesById = useMemo(() => {
    const result = new Map<string, AttachmentFile>();
    const add = (id: string, filename: string | null, mimeType?: string | null, query = '') => {
      const name = filename || id;
      result.set(id, {
        mediaId: id,
        filename: name,
        url: `/media/${id}${query}`,
        isPdf: mimeType?.toLowerCase() === 'application/pdf' || getFileExtension(name) === 'pdf',
        isVideo: isVideoFile(name, mimeType)
      });
    };
    for (const att of post.attachments) {
      if (att.downloaded?.path) {
        add(att.id, att.filename || path.parse(att.downloaded.path).base, att.downloaded.mimeType);
      }
    }
    for (const linked of post.linkedAttachments || []) {
      const downloadable = linked.downloadable;
      if (downloadable?.downloaded?.path) {
        add(
          linked.mediaId,
          downloadable.filename || path.parse(downloadable.downloaded.path).base,
          downloadable.downloaded.mimeType,
          // An attachment borrowed from another post has no media row of its
          // own: it is stored on the post that links to it, which is the post
          // the server names in "lapid" when it rewrites the link.
          `?lapid=${encodeURIComponent(post.id)}`
        );
      }
    }
    return result;
  }, [post]);

  /** The reader's view of one of them. */
  const pdfTargetFor = useCallback((file: AttachmentFile): PdfViewerTarget => ({
    url: file.url,
    mediaId: file.mediaId,
    filename: file.filename,
    postId: post.id
  }), [post.id]);

  // Post content is injected as raw HTML, so links rewritten by the server to
  // point at locally-stored content are plain anchors and would otherwise
  // trigger a full page load. Route them through the SPA router instead.
  const handleContentClick = useCallback((e: React.MouseEvent<HTMLElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    const anchor = (e.target as HTMLElement).closest('a');
    const href = anchor?.getAttribute('href') || '';
    // Site-relative page links only. A media link is dealt with just below
    // rather than routed, and protocol-relative URLs ("//host/path") point
    // off-site despite starting with a slash.
    if (!href.startsWith('/') || href.startsWith('//')) {
      return;
    }
    if (href.startsWith('/media/')) {
      const file = filesById.get(
        new URL(href, window.location.origin).pathname.slice('/media/'.length)
      );
      if (!file) {
        return;
      }
      e.preventDefault();
      // A PDF is read in the page, like it is in the gallery.
      if (file.isPdf) {
        setPdfTarget(pdfTargetFor(file));
      }
      // Anything else is a file to keep, and keeping one takes a ticket. For
      // everyone else the click stops here: the server would refuse the
      // request anyway, and an error page is a worse answer than nothing.
      else if (canDownload && !file.isVideo) {
        requestDownload(file);
      }
      return;
    }
    if (anchor?.target && anchor.target !== '_self') {
      return;
    }
    e.preventDefault();
    void navigate(href);
  }, [ navigate, filesById, pdfTargetFor, canDownload, requestDownload ]);

  useEffect(() => {
    if (!highlightMediaId) {
      return;
    }
    const el = attachmentsRef.current?.querySelector(`[data-media-id="${CSS.escape(highlightMediaId)}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlightMediaId, post.id]);

  // Only YouTube embeds are playable inline; see `externalEmbed` below. When
  // one is shown there is no need for a cover in the media grid as well.
  const showsExternalEmbed = !!(
    post.embed && !post.embed.downloaded?.path && post.embed.html &&
    post.embed.provider?.toLowerCase() === 'youtube'
  );

  const mediaItems = useMemo(() => {
    const isDownloaded = (item?: Downloadable<any> | null) => !!item?.downloaded?.path;
    // Images the server has already placed in the post body; showing them in
    // the grid too would just duplicate them.
    const inlinedImageIds = post.inlinedImageIds || [];
    const images = post.images.filter(
      (img) => isDownloaded(img) && !inlinedImageIds.includes(img.id)
    );
    // Each candidate must be checked for a downloaded file of its own,
    // otherwise an undownloaded embed (Streamable and friends) shadows the
    // cover image that is sitting right there.
    if (isDownloaded(post.video)) {
      return [ post.video! ];
    }
    if (isDownloaded(post.embed)) {
      return [ post.embed! ];
    }
    if (isDownloaded(post.videoPreview)) {
      return [ post.videoPreview! ];
    }
    if (images.length > 0) {
      return images;
    }
    if (showsExternalEmbed) {
      return [];
    }
    if (isDownloaded(post.coverImage)) {
      return [ post.coverImage! ];
    }
    if (isDownloaded(post.thumbnail)) {
      return [ post.thumbnail! ];
    }
    return [];
  }, [post, showsExternalEmbed]);

  const attachments = useMemo(() => {
    const files = post.attachments.reduce<AttachmentFile[]>((result, att) => {
      const file = att.downloaded?.path ? filesById.get(att.id) : undefined;
      if (file) {
        result.push(file);
      }
      return result;
    }, []);
    if (files.length === 0) {
      return undefined;
    }
    return (
      <div ref={attachmentsRef} className="post-card__attachments">
        <p className="post-card__attachments-heading">Attachments:</p>
        <ul className="post-card__attachment-list">
          {
            files.map((file) => (
              <li
                key={file.mediaId}
                data-media-id={file.mediaId}
                className={
                  `post-card__attachment ${file.mediaId === highlightMediaId ? 'post-card__attachment--highlighted' : ''}`
                }
              >
                <Icon name={getFileIcon(file.filename)} outlined className="post-card__attachment-icon" />
                {
                  // A PDF is the one attachment with somewhere to go on a
                  // click. The rest are named rather than linked: the link
                  // they used to carry was a download for whoever followed it,
                  // and a download is now a ticket an administrator asks for.
                  file.isPdf ? (
                    <button
                      type="button"
                      className="post-card__attachment-name post-card__attachment-name--open"
                      onClick={() => setPdfTarget(pdfTargetFor(file))}
                    >
                      {file.filename}
                    </button>
                  ) : (
                    <span className="post-card__attachment-name">{file.filename}</span>
                  )
                }
                {
                  // Videos are never handed out, so no button is drawn on one.
                  canDownload && !file.isVideo ? (
                    <button
                      type="button"
                      className="post-card__attachment-download"
                      title={`Download ${file.filename}`}
                      aria-label={`Download ${file.filename}`}
                      onClick={() => requestDownload(file)}
                    >
                      <Icon name="download" />
                    </button>
                  ) : null
                }
              </li>
            ))
          }
        </ul>
      </div>
    );
  }, [ post, filesById, highlightMediaId, pdfTargetFor, canDownload, requestDownload ]);

  // Videos and embeds often have no downloaded poster of their own, because
  // Patreon only supplies one when the post has a cover image. Reuse the post's
  // cover so the player doesn't fall back to a bare placeholder.
  const fallbackThumbnailURL = useMemo(() => {
    if (post.thumbnail?.downloaded?.path) {
      return `/media/${post.thumbnail.id}`;
    }
    if (post.coverImage?.downloaded?.path) {
      return `/media/${post.coverImage.id}`;
    }
    return undefined;
  }, [post]);

  const audio = useMemo(() => {
    const audio =
      post.audio?.downloaded?.path ? post.audio
      : post.audioPreview?.downloaded?.path ? post.audioPreview
      : null;
    if (!audio) {
      return null;
    }
    return (
      <div className="my-4">
        <audio controls controlsList="nodownload" className="w-100 rounded">
          <source src={`/media/${audio.id}`} type={audio.downloaded?.mimeType || ''} />
          Your browser does not support the audio element.
        </audio>
      </div>
    )
  }, [post]);

  const titleEl = useMemo(() => {
    const url = new URL(getContentUrl(post), window.location.href);
    if (contextQS) {
      url.search = contextQS;
    }
    if (location.pathname === url.pathname) {
      return post.title;
    }
    return (
      <Link to={url.toString()}>{post.title}</Link>
    )
  }, [post, location, contextQS]);

  // If there's an embed but no local video, and it's a known provider (YouTube), show the embed.
  const externalEmbed = useMemo(() => {
    // Only YouTube embeds for now
    // Vimeo can't be reliably embedded due to CORS restrictions
    if (showsExternalEmbed && post.embed?.html) {
      const parser = new DOMParser();
      const doc = parser.parseFromString(post.embed.html, 'text/html');
      // Select the iframe and get attributes
      const iframe = doc.querySelector('iframe');
      const width = iframe ? iframe.getAttribute('width') : null;
      const height = iframe ? iframe.getAttribute('height') : null;
      let aspectRatio = '';
      if (width && height) {
        aspectRatio = `${width} / ${height}`;
      }
      const style: React.CSSProperties = {
        width: '100%'
      };
      if (aspectRatio) {
        style.aspectRatio = aspectRatio;
      }
      const caption = post.embed.provider ? `(Embedded from ${post.embed.provider} - not stored locally)` : '(Embedded content - not stored locally)';
      return (
        <div className="post-card__external-embed-wrapper">
          <div
            className="post-card__external-embed"
            style={style}
            dangerouslySetInnerHTML={{__html: post.embed.html}}
          />
          <span className="post-card__external-embed-caption">{caption}</span>
        </div>
      )
    }
    return null;
  }, [post, showsExternalEmbed]);

  const inlineMediaRegex = /class=".*?\s*?lightgallery-item.*?\s*?"/gm;
  const hasInlineMedia = inlineMediaRegex.test(post.content || '');
  const hasGallery = mediaItems.length > 0 || hasInlineMedia;

  const tagsEl = post.tags && post.tags.length > 0 && post.campaign && (
    <Stack direction="horizontal" gap={2} className="mb-3 flex-wrap">
      {post.tags.map((tag) => {
        const tagUrl = new URL(`${getCampaignBaseUrl(post.campaign!)}/posts`, window.location.href);
        tagUrl.searchParams.set('filter_tag_id', tag.id);
        return (
          <Badge key={tag.id} bg="secondary">
            <Link to={tagUrl.toString()} style={{color: 'inherit'}}>
              {tag.value}
            </Link>
          </Badge>
        )
      })}
    </Stack>
  );

  let body = (
    <Stack>
      <Stack direction="horizontal" className="mb-3 justify-content-between gap-4">
        <Card.Title className="m-0">{titleEl}</Card.Title>
        <Stack direction="horizontal" gap={2} className="align-items-center flex-shrink-0">
          {
            !post.isViewable ? (
              <Icon name="lock" className="text-body-secondary" />
            ) : null
          }
          {
            showFavorite && post.id ? (
              <FavoriteButton postId={post.id} />
            ) : null
          }
        </Stack>
      </Stack>
      <Stack direction="horizontal" className="mb-2 text-body-secondary" gap={4}>
        {
          post.publishedAt ? (
            <span>
              {new Date(post.publishedAt).toLocaleString()}
            </span>
          ) : null
        }
        {
          post.commentCount > 0 ? (
            <Stack direction="horizontal" gap={2}>
              <Icon name="comment" style={{ fontSize: '1.2em' }} />
              <span>{post.commentCount}</span>
            </Stack>
          ) : null
        }
      </Stack>
      {tagsEl}
      { audio }
      <Card.Text
        ref={contentRef}
        as="div"
        className="post-card__content"
        onClick={handleContentClick}
        dangerouslySetInnerHTML={{__html: post.content || ''}}
      />
      { attachments }
    </Stack>
  );

  if (useShowMore) {
    body = (
      <FadeContent>
        {body}
      </FadeContent>
    );
  }

  const contents = (
    <Card className="post-card">
      {
        showCampaign && post.campaign && post.campaign.name ? (
          <Card.Header>
            <Stack direction="horizontal" gap={3}>
              <MediaImage
                mediaId={`campaign:${post.campaign.id}:avatar`}
                className="rounded"
                style={{ width: '2.5em', height: '2.5em', objectFit: 'cover'}} />
              <span>
                <Link to={getCampaignBaseUrl(post.campaign)}
                  className="text-body"
                >
                  {post.campaign.name}
                </Link>
              </span>
            </Stack>
          </Card.Header>
        ) : null
      }
      <MediaGrid
        items={mediaItems}
        title={post.title || ''}
        fallbackThumbnailURL={fallbackThumbnailURL}
        noGallery
      />
      { externalEmbed }
      <Card.Body>
        {body}
      </Card.Body>
    </Card>
  );

  // Rendered alongside the card either way: a post can carry a PDF with
  // nothing else to put in a gallery.
  const pdfViewer = (
    <PdfViewerModal target={pdfTarget} onClose={() => setPdfTarget(null)} />
  );

  if (!hasGallery) {
    return (
      <>
        {contents}
        {pdfViewer}
      </>
    );
  }

  return (
    // The post body can carry lightbox tiles of its own, so the key covers the
    // content as well as the attachments.
    <Lightbox
      itemsKey={`${post.id}|${mediaItems.map((mi) => mi.id).join('|')}`}
      videojs
    >
      {contents}
      {pdfViewer}
    </Lightbox>
  )
}

export default PostCard;