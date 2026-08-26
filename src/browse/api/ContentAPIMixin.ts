import { type CheerioAPI, load as cheerioLoad } from 'cheerio';
import { type APIConstructor } from ".";
import { type Product, type Post } from "../../entities";
import { type GetContentContext, type ContentListSortBy, type ContentType, type GetContentListParams, type GetCollectionListParams, type CollectionListSortBy, type GetPostTagListParams } from "../types/Content.js";
import RawDataExtractor from '../web/utils/RawDataExtractor.js';
import { URLHelper } from '../../utils/index.js';

const DEFAULT_CONTENT_LIST_SIZE = 10;
const DEFAULT_CONTENT_LIST_SORT_BY: ContentListSortBy = 'a-z';

const DEFAULT_COLLECTION_LIST_SIZE = 10;
const DEFAULT_COLLECTION_LIST_SORT_BY: CollectionListSortBy = 'a-z';

/**
 * Marks an inline link that has been rewritten to point at locally-stored content.
 * `class` is one of the few attributes allowed through `sanitizeHTML()`, so this
 * survives sanitization (unlike a `data-*` attribute would).
 */
export const INTERNAL_LINK_CLASS = 'post-card__internal-link';

/**
 * Link shapes that `URLHelper.analyzeURL()` does not recognise, because the
 * downloader has no use for them, but which are common in post bodies:
 * a bare creator page and a post referenced by id alone.
 */
const CREATOR_PAGE_URL_REGEX = /^https:\/\/(?:www\.)?patreon\.com\/(?:c\/|cw\/)?([^/?#]+)\/?$/;
const BARE_POST_URL_REGEX = /^https:\/\/(?:www\.)?patreon\.com\/posts\/(\d+)\/?$/;
/** Path segments that look like a vanity but are Patreon's own pages. */
const RESERVED_VANITIES = [ 'posts', 'collection', 'home', 'search', 'login', 'signup', 'join', 'user', 'settings', 'messages', 'notifications' ];

export function ContentAPIMixin<TBase extends APIConstructor>(Base: TBase) {
  return class ContentAPI extends Base {
    getContentList<T extends ContentType>(params: GetContentListParams<T>) {
      const { sortBy = DEFAULT_CONTENT_LIST_SORT_BY, limit = DEFAULT_CONTENT_LIST_SIZE, offset = 0 } = params;
      const list = this.db.getContentList({
        ...params,
        sortBy,
        limit,
        offset,
      });
      for (const item of list.items) {
        switch (item.type) {
          case 'post':
            this.#processPostContentElements(item);
            item.content = this.sanitizeHTML(item.content || '');
            break;
          case 'product': {
            const description = RawDataExtractor.getProductRichTextDescription(item);
            item.description = description ? this.sanitizeHTML(description) : null;
            break;
          }
        }
      }
      return list;
    }

    getPost(id: string) {
      const post = this.db.getContent(id, 'post');
      if (post) {
        this.#processPostContentElements(post);
        post.content = this.sanitizeHTML(post.content || '');
      }
      return post;
    }

    getProduct(id: string) {
      return this.db.getContent(id, 'product');
    }

    getPreviousNextContent<T extends ContentType>(content: Post | Product, context: GetContentContext<T>) {
      return this.db.getPreviousNextContent(content, context);
    }

    getCollection(id: string) {
      return this.db.getCollection(id);
    }

    getCollectionList(params: GetCollectionListParams) {
      const {
        search = '',
        sortBy = DEFAULT_COLLECTION_LIST_SORT_BY,
        limit = DEFAULT_COLLECTION_LIST_SIZE,
        offset = 0
      } = params;
      return this.db.getCollectionList({
        campaign: params.campaign,
        search,
        sortBy,
        limit,
        offset
      });
    }

    getPostTagList(params: GetPostTagListParams) {
      return this.db.getPostTagList({
        campaign: params.campaign,
      });
    }

    #processPostContentElements(post: Post) {
      const html = post.content || '';
      
      if (!html) {
        return;
      }

      const $ = cheerioLoad(html);
      const inlineMediaModified = this.#processInlineMedia($, post);
      const inlineLinksModified = this.#processInlineLinks($);
      if (inlineMediaModified || inlineLinksModified) {
        post.content = $.html();
      }
    }

    #processInlineMedia($: CheerioAPI, post: Post) {
      const hasImages = post.images.length > 0;
      const hasLinkedAttachments = post.linkedAttachments && post.linkedAttachments.length > 0;
      if (!hasImages && !hasLinkedAttachments) {
        return false;
      }
      let hasModified = false;
      
      // Images
      if (hasImages) {
        const replacedMediaIds: string[] = [];
        $('img').each((_, _el) => {
          const el = $(_el);
          const id = el.attr('data-media-id');
          const matched = id ? post.images.find(img => img.id === id && img.downloaded) : null;
          const src = matched ? `/media/${matched.id}` : el.attr('src');
          const imgEl = $('<img>').attr('src', src);
          const aEl = $('<a>')
            .attr('href', src)
            .attr('class', 'lightgallery-item')
            .append(imgEl);
          const wrapperEl = $('<div>')
            .attr('class', 'post-card__inline-media-wrapper')
            .append(aEl);
          if (!matched) {
            const caption = "(Externally hosted - not stored locally)";
            wrapperEl.append(
              $('<span>').attr('class', 'post-card__inline-media-caption').append(caption)
            );
          }
          el.replaceWith(wrapperEl);
          if (id && matched) {
            replacedMediaIds.push(id);
          }
        });
        if (replacedMediaIds.length > 0) {
          hasModified = true;
          // Record - but don't remove - the images that have been inlined.
          // Dropping them here left posts whose every image sits in the body
          // with nothing to show as a cover in the grid / list views.
          post.inlinedImageIds = [
            ...(post.inlinedImageIds || []),
            ...replacedMediaIds
          ];
        }
      }

      // Linked attachments
      if (hasLinkedAttachments) {
        $('a').each((_, _el) => {
          const aEl = $(_el);
          const href = aEl.attr('href') || '';
          const { validated, ownerId, mediaId } = URLHelper.isAttachmentLink(href);
          if (validated) {
            let modifiedPath: string | undefined;
            if (post.id !== ownerId) {
              const isDownloaded = post.linkedAttachments?.find((att) => att.postId === ownerId && att.mediaId === mediaId)?.downloadable?.downloaded;
              modifiedPath = isDownloaded && `/media/${mediaId}?lapid=${post.id}`;
            }
            else {
              const isDownloaded = post.attachments.find((att) => att.id === mediaId)?.downloaded;
              modifiedPath = isDownloaded && `/media/${mediaId}`;
            }
            if (modifiedPath) {
              aEl.attr('href', modifiedPath);
              hasModified = true;
            }
          }
        });
      }

      return hasModified;
    }

    #processInlineLinks($: CheerioAPI) {
      let hasModified = false;
      $('a').each((_, _el) => {
        const el = $(_el);
        const href = el.attr('href') || '';
        const internalPath = this.#resolveInternalPath(href);
        if (internalPath) {
          el.attr('href', internalPath);
          el.removeAttr('target');
          el.removeAttr('rel');
          el.addClass(INTERNAL_LINK_CLASS);
          hasModified = true;
        }
      });
      return hasModified;
    }

    /**
     * Maps a Patreon URL to the equivalent path within this site, but only if the
     * content it points to is actually stored locally. Returns `null` otherwise,
     * so the link is left alone and keeps pointing to the external site.
     */
    #resolveInternalPath(href: string): string | null {
      if (!href) {
        return null;
      }
      // Normalize protocol-relative ("//patreon.com/...") and plain-http links so
      // they get analyzed the same way as https ones.
      let url = href.trim();
      if (url.startsWith('//')) {
        url = `https:${url}`;
      }
      else if (url.startsWith('http://')) {
        url = `https://${url.slice('http://'.length)}`;
      }
      if (!url.startsWith('https://')) {
        return null;
      }
      let an;
      try {
        an = URLHelper.analyzeURL(url);
      }
      catch (error: unknown) {
        this.log('warn', `Error analyzing inline link "${href}":`, error);
        return null;
      }
      if (!an || an.type === 'customURL') {
        return this.#resolveUnanalyzedPath(url);
      }
      switch (an.type) {
        case 'post':
          return this.db.checkContentExists(an.postId, 'post') ? `/posts/${an.postId}` : null;
        case 'product':
          return this.db.checkContentExists(an.productId, 'product') ? `/products/${an.productId}` : null;
        case 'postsByCollection':
          return this.db.checkCollectionExists(an.collectionId) ? `/collections/${an.collectionId}` : null;
        case 'postsByUser': {
          const vanity = this.db.getCampaignVanityIfExists(an.vanity);
          return vanity ? `/${encodeURIComponent(vanity)}/posts` : null;
        }
        case 'shop': {
          const vanity = this.db.getCampaignVanityIfExists(an.vanity);
          return vanity ? `/${encodeURIComponent(vanity)}/shop` : null;
        }
        case 'postsByUserId': {
          const campaignId = this.db.getCampaignIdByCreatorId(an.userId);
          return campaignId ? `/campaigns/${campaignId}/posts` : null;
        }
        default:
          return null;
      }
    }

    #resolveUnanalyzedPath(url: string): string | null {
      // Both patterns are anchored, so query strings and fragments have to go.
      const base = url.split('#')[0].split('?')[0];
      const barePostMatch = BARE_POST_URL_REGEX.exec(base);
      if (barePostMatch) {
        const postId = barePostMatch[1];
        return this.db.checkContentExists(postId, 'post') ? `/posts/${postId}` : null;
      }
      const creatorMatch = CREATOR_PAGE_URL_REGEX.exec(base);
      if (creatorMatch && !RESERVED_VANITIES.includes(creatorMatch[1].toLowerCase())) {
        const vanity = this.db.getCampaignVanityIfExists(decodeURIComponent(creatorMatch[1]));
        return vanity ? `/${encodeURIComponent(vanity)}` : null;
      }
      return null;
    }
  }
}