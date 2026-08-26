import { useEffect, useMemo, useState } from "react";
import { type Post } from "../../../entities";
import { getPostThumbnailURLs } from "../utils/Misc";

interface PostThumbnailProps {
  post: Post;
  /** BEM prefix of the surrounding block, e.g. "post-grid". */
  classNamePrefix: string;
}

/**
 * Cover image of a post, falling through `getPostThumbnailURLs()` as candidates
 * fail to load and ending at the "article" placeholder.
 *
 * Without the fallback the tile collapses into a broken-image sliver, which is
 * what an interrupted download leaves behind: the DB records the file, but the
 * server refuses to serve the empty leftover.
 */
function PostThumbnail(props: PostThumbnailProps) {
  const { post, classNamePrefix } = props;
  const urls = useMemo(() => getPostThumbnailURLs(post), [post]);
  const [ index, setIndex ] = useState(0);
  useEffect(() => setIndex(0), [urls]);

  const url = urls[index];
  if (!url) {
    return (
      <span className={`material-icons-outlined ${classNamePrefix}__thumbnail-placeholder`}>
        article
      </span>
    );
  }
  return (
    <img
      key={url}
      className={`${classNamePrefix}__thumbnail`}
      src={url}
      loading="lazy"
      alt=""
      onError={() => setIndex((current) => current + 1)}
    />
  );
}

export default PostThumbnail;
