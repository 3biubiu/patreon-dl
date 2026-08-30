import "../assets/styles/PostList.scss";
import { Badge, Stack } from "react-bootstrap";
import { Link } from "react-router";
import { type Post } from "../../../entities";
import { getCampaignBaseUrl, getContentUrl } from "../utils/Misc";
import PostThumbnail from "./PostThumbnail";
import Icon from "./Icon";

interface PostListProps {
  posts: Post[];
  contextQS?: string;
  /**
   * Name the creator each post belongs to. Off for a campaign's own listing,
   * where every row would say the same thing; on where the list spans
   * creators, as global search results do.
   */
  showCampaign?: boolean;
}

function postUrl(post: Post, contextQS?: string) {
  return `${getContentUrl(post)}${contextQS ? `?${contextQS}` : ''}`;
}

/**
 * Compact rows: thumbnail on the left, title and metadata on the right.
 */
function PostList(props: PostListProps) {
  const { posts, contextQS, showCampaign = false } = props;

  return (
    <div className="post-list mb-4">
      {
        posts.map((post) => {
          return (
            <div key={`post-list-item-${post.id}`} className="post-list__item">
              <Link
                to={postUrl(post, contextQS)}
                className="post-list__thumbnail-wrapper"
                tabIndex={-1}
                aria-hidden="true"
              >
                <PostThumbnail post={post} classNamePrefix="post-list" />
              </Link>
              <div className="post-list__body">
                <Stack direction="horizontal" className="align-items-start gap-2">
                  <Link to={postUrl(post, contextQS)} className="post-list__title">
                    {post.title}
                  </Link>
                  {
                    !post.isViewable ? (
                      <Icon name="lock" className="text-body-secondary flex-shrink-0" />
                    ) : null
                  }
                </Stack>
                <Stack direction="horizontal" className="post-list__meta text-body-secondary" gap={4}>
                  {
                    // First in the row: on a list that spans creators, whose
                    // post this is outranks when it was published.
                    showCampaign && post.campaign ? (
                      <Link
                        to={getCampaignBaseUrl(post.campaign)}
                        className="post-list__campaign"
                      >
                        {post.campaign.name}
                      </Link>
                    ) : null
                  }
                  {
                    post.publishedAt ? (
                      <span>{new Date(post.publishedAt).toLocaleString()}</span>
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
