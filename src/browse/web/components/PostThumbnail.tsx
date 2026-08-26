import { useEffect, useMemo, useState } from "react";
import { type Post } from "../../../entities";
import { getPostThumbnailCandidates, postHasVideo } from "../utils/Misc";
import Icon from "./Icon";

interface PostThumbnailProps {
  post: Post;
  /** BEM prefix of the surrounding block, e.g. "post-grid". */
  classNamePrefix: string;
}

/**
 * Cover image of a post, falling through `getPostThumbnailCandidates()` as
 * candidates fail to load and ending at the "article" placeholder.
 *
 * Without the fallback the tile collapses into a broken-image sliver, which is
 * what an interrupted download leaves behind: the DB records the file, but the
 * server refuses to serve the empty leftover.
 *
 * A play badge is drawn over the cover of a post that has a video, so a video
 * post reads as one at a glance. The surrounding block must position the
 * badge's ancestor (`position: relative`).
 */
function PostThumbnail(props: PostThumbnailProps) {
  const { post, classNamePrefix } = props;
  const candidates = useMemo(() => getPostThumbnailCandidates(post), [post]);
  const [ index, setIndex ] = useState(0);
  useEffect(() => setIndex(0), [candidates]);

  const candidate = candidates[index];
  // Either the cover is a frame grabbed from a video, or it is the poster of
  // one - both mean the tile stands for something playable.
  const isVideoCover = useMemo(
    () => !!candidate && (candidate.isVideo || postHasVideo(post)),
    [candidate, post]
  );

  if (!candidate) {
    return (
      <Icon
        name={postHasVideo(post) ? 'movie' : 'article'}
        outlined
        className={`${classNamePrefix}__thumbnail-placeholder`}
      />
    );
  }
  return (
    <>
      <img
        key={candidate.url}
        className={`${classNamePrefix}__thumbnail`}
        src={candidate.url}
        loading="lazy"
        alt=""
        onError={() => setIndex((current) => current + 1)}
      />
      {
        isVideoCover ? (
          <span className={`${classNamePrefix}__play`} aria-hidden="true">
            <Icon name="play_arrow" />
          </span>
        ) : null
      }
    </>
  );
}

export default PostThumbnail;
