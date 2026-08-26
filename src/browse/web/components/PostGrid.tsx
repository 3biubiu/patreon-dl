import "../assets/styles/PostGrid.scss";
import { Link } from "react-router";
import { type Post } from "../../../entities";
import { getContentUrl } from "../utils/Misc";
import PostThumbnail from "./PostThumbnail";
import Icon from "./Icon";

interface PostGridProps {
  posts: Post[];
  contextQS?: string;
}

function postUrl(post: Post, contextQS?: string) {
  return `${getContentUrl(post)}${contextQS ? `?${contextQS}` : ''}`;
}

/**
 * Thumbnail-and-title tiles. Deliberately minimal - no body text, tags or
 * "show more" - so that as many posts as possible fit on one screen. The
 * number of columns follows the available width.
 */
function PostGrid(props: PostGridProps) {
  const { posts, contextQS } = props;

  return (
    <div className="post-grid mb-4">
      {
        posts.map((post) => {
          return (
            <Link
              key={`post-grid-item-${post.id}`}
              to={postUrl(post, contextQS)}
              className="post-grid__item"
              title={post.title || undefined}
            >
              <div className="post-grid__thumbnail-wrapper">
                <PostThumbnail post={post} classNamePrefix="post-grid" />
                {
                  !post.isViewable ? (
                    <Icon name="lock" className="post-grid__lock" />
                  ) : null
                }
              </div>
              <div className="post-grid__title">{post.title}</div>
            </Link>
          );
        })
      }
    </div>
  );
}

export default PostGrid;
