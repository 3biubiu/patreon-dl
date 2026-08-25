import "../assets/styles/PostGrid.scss";
import { Link } from "react-router";
import { type Post } from "../../../entities";
import { getContentUrl, getPostThumbnailURL } from "../utils/Misc";

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
          const thumbnailURL = getPostThumbnailURL(post);
          return (
            <Link
              key={`post-grid-item-${post.id}`}
              to={postUrl(post, contextQS)}
              className="post-grid__item"
              title={post.title || undefined}
            >
              <div className="post-grid__thumbnail-wrapper">
                {
                  thumbnailURL ?
                    <img className="post-grid__thumbnail" src={thumbnailURL} loading="lazy" alt="" />
                    : (
                      <span className="material-icons-outlined post-grid__thumbnail-placeholder">
                        article
                      </span>
                    )
                }
                {
                  !post.isViewable ? (
                    <span className="material-icons post-grid__lock">lock</span>
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
