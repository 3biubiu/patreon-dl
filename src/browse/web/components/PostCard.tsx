import "../assets/styles/PostCard.scss";
import { type Downloadable, type Post } from "../../../entities";
import { Badge, Card, Stack } from "react-bootstrap";
import MediaGrid from "./MediaGrid";
import path from "path";
import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import MediaImage from "./MediaImage";
import Lightbox from "./Lightbox";
import FadeContent from "./FadeContent";
import { getCampaignBaseUrl, getContentUrl, getFileIcon } from "../utils/Misc";
import Icon from "./Icon";
import FavoriteButton from "./FavoriteButton";

interface PostCardProps {
  post: Post;
  showCampaign?: boolean;
  useShowMore?: boolean;
  contextQS?: string;
  /** Show the save-to-favorites toggle beside the title. Detail page only. */
  showFavorite?: boolean;
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

  // Post content is injected as raw HTML, so links rewritten by the server to
  // point at locally-stored content are plain anchors and would otherwise
  // trigger a full page load. Route them through the SPA router instead.
  const handleContentClick = useCallback((e: React.MouseEvent<HTMLElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    const anchor = (e.target as HTMLElement).closest('a');
    const href = anchor?.getAttribute('href') || '';
    // Site-relative page links only. Media endpoints must stay real requests
    // so the browser can stream or download them, and protocol-relative URLs
    // ("//host/path") point off-site despite starting with a slash.
    if (!href.startsWith('/') || href.startsWith('//') || href.startsWith('/media/')) {
      return;
    }
    if (anchor?.target && anchor.target !== '_self') {
      return;
    }
    e.preventDefault();
    void navigate(href);
  }, [navigate]);

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
    const links = post.attachments.reduce<{id: string; title: string; url: string}[]>((result, att) => {
      if (att.downloaded?.path) {
        const title = att.filename || path.parse(att.downloaded.path).base;
        result.push({
          id: att.id,
          title,
          url: `/media/${att.id}?dl=1`
        });
      }
      return result;
    }, []);
    if (links.length > 0) {
      return (
        <div ref={attachmentsRef} className="post-card__attachments">
          <p className="post-card__attachments-heading">Attachments:</p>
          <ul className="post-card__attachment-list">
            {
              links.map(({id, title, url}) => (
                <li
                  key={id}
                  data-media-id={id}
                  className={`post-card__attachment ${id === highlightMediaId ? 'post-card__attachment--highlighted' : ''}`}
                >
                  <Icon name={getFileIcon(title)} outlined className="post-card__attachment-icon" />
                  <a href={url}>{title}</a>
                </li>
              ))
            }
          </ul>
        </div>
      )
    }
  }, [post, highlightMediaId]);

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

  if (!hasGallery) {
    return contents;
  }
  
  return (
    // The post body can carry lightbox tiles of its own, so the key covers the
    // content as well as the attachments.
    <Lightbox
      itemsKey={`${post.id}|${mediaItems.map((mi) => mi.id).join('|')}`}
      videojs
    >
      {contents}
    </Lightbox>
  )
}

export default PostCard;