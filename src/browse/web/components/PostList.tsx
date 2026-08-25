import "../assets/styles/PostList.scss";
import { Badge, Stack } from "react-bootstrap";
import { Link } from "react-router";
import { type Post } from "../../../entities";
import { getCampaignBaseUrl, getContentUrl, getPostThumbnailURL } from "../utils/Misc";

interface PostListProps {
  posts: Post[];
  contextQS?: string;
}

function postUrl(post: Post, contextQS?: string) {
  return `${getContentUrl(post)}${contextQS ? `?${contextQS}` : ''}`;
}

/**
 * Compact rows: thumbnail on the left, title and metadata on the right.
 */
function PostList(props: PostListProps) {
  const { posts, contextQS } = props;

  return (
    <div className="post-list mb-4">
      {
        posts.map((post) => {
          const thumbnailURL = getPostThumbnailURL(post);
          return (
            <div key={`post-list-item-${post.id}`} className="post-list__item">
              <Link
                to={postUrl(post, contextQS)}
                className="post-list__thumbnail-wrapper"
                tabIndex={-1}
                aria-hidden="true"
              >
                {
                  thumbnailURL ?
                    <img className="post-list__thumbnail" src={thumbnailURL} loading="lazy" alt="" />
                    : (
                      <span className="material-icons-outlined post-list__thumbnail-placeholder">
                        article
                      </span>
                    )
                }
              </Link>
              <div className="post-list__body">
                <Stack direction="horizontal" className="align-items-start gap-2">
                  <Link to={postUrl(post, contextQS)} className="post-list__title">
                    {post.title}
                  </Link>
                  {
                    !post.isViewable ? (
                      <span className="material-icons text-body-secondary flex-shrink-0">lock</span>
                    ) : null
                  }
                </Stack>
                <Stack direction="horizontal" className="post-list__meta text-body-secondary" gap={4}>
                  {
                    post.publishedAt ? (
                      <span>{new Date(post.publishedAt).toLocaleString()}</span>
                    ) : null
                  }
                  {
                    post.commentCount > 0 ? (
                      <Stack direction="horizontal" gap={2}>
                        <span className="material-icons" style={{ fontSize: '1.2em' }}>comment</span>
                        <span>{post.commentCount}</span>
                      </Stack>
                    ) : null
                  }
                </Stack>
                {
                  post.tags && post.tags.length > 0 && post.campaign ? (
                    <Stack direction="horizontal" gap={2} className="flex-wrap post-list__tags">
                      {post.tags.map((tag) => {
                        const tagUrl = new URL(`${getCampaignBaseUrl(post.campaign!)}/posts`, window.location.href);
                        tagUrl.searchParams.set('filter_tag_id', tag.id);
                        return (
                          <Badge key={tag.id} bg="secondary">
                            <Link to={tagUrl.toString()} style={{ color: 'inherit' }}>
                              {tag.value}
                            </Link>
                          </Badge>
                        );
                      })}
                    </Stack>
                  ) : null
                }
              </div>
            </div>
          );
        })
      }
    </div>
  );
}

export default PostList;
