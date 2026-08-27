import "../assets/styles/PostContent.scss";
import { forwardRef, useEffect, useMemo, useReducer, useState } from "react";
import { NavLink, useParams } from "react-router";
import { Container, Row, Col } from "react-bootstrap";
import { LeftOutlined, RightOutlined } from "@ant-design/icons";
import { useAPI } from "../contexts/APIProvider";
import PostCard from "../components/PostCard";
import PostThumbnail from "../components/PostThumbnail";
import CommentsPanel from "../components/CommentsPanel";
import { type PostWithComments } from "../../types/Content";
import { type PostFilterSearchParams } from "../../types/Filter";
import { type UnionToTuple } from "../../../utils/Misc";
import { useScroll } from "../contexts/MainContentScrollProvider";
import { useBrowseSettings } from "../contexts/BrowseSettingsProvider";
import { type BrowseSettings } from "../../types/Settings";
import { useDocument } from "../contexts/DocumentProvider";
import { getContentUrl } from "../utils/Misc";
import { LoadingBlock } from "../components/Loading";

interface PostNav {
  previous: PostWithComments | null;
  next: PostWithComments | null;
}

const CONTEXT_QS_PARAMS: UnionToTuple<PostFilterSearchParams | 'collection_id'> = [
  'post_types',
  'is_viewable',
  'tier_ids',
  'collection_id',
  'sort_by',
  'date_published',
  'search',
  'tag_id'
];

function getContextQS() {
  const searchParams = new URL(window.location.href).searchParams;
  const result = new URLSearchParams();
  for (const param of CONTEXT_QS_PARAMS) {
    if (searchParams.has(param)) {
      result.set(param, searchParams.get(param) as string);
    }
  }
  return result.toString();
}

const contentReducer = (currentContent: PostWithComments | null, newContent: PostWithComments | null) => {
  if (currentContent && newContent) {
    return currentContent.id === newContent.id ? currentContent : newContent;
  }
  return newContent;
}

const ContentColumn = forwardRef<
  HTMLDivElement,
  { children: React.ReactNode, settings: BrowseSettings } & React.HTMLAttributes<HTMLDivElement>
>(({children, settings, ...props}, ref) => {
  return (
    <Container fluid ref={ref} {...props}>
      <Row className="justify-content-center">
        <Col lg={8} md={10} sm={12} className={`p-0 post-content__column mw-${settings.maxContentWidth.toLowerCase()}`}>
          {children}
        </Col>
      </Row>
    </Container>
  );
});

function PostContent() {
  const {id: postId} = useParams();
  const { api } = useAPI();
  const { setTitle } = useDocument();
  const { settings } = useBrowseSettings();
  const { scrollTo } = useScroll();
  const [post, setContent] = useReducer(contentReducer, null);;
  const [postNav, setPostNav] = useState<PostNav>({ previous: null, next: null });

  useEffect(() => {
    // Check if postId is in format <slug>-<id>. If so, extract the id part.
    const resolvedPostId = postId && postId.includes('-') ? postId.split('-').pop() : postId;
    if (!resolvedPostId) {
      return;
    }
    const abortController = new AbortController();
    void (async () => {
      const { post, previous, next } = await api.getPost(resolvedPostId, getContextQS());
      if (!abortController.signal.aborted) {
        setContent(post);
        setPostNav({ previous, next });
      }
    })();

    return () => abortController.abort();
  }, [api, postId]);

  useEffect(() => {
    setTitle(post?.title || null);
  }, [setTitle, post]);

  // Keyed on the id rather than the post, so paging through with the previous
  // and next links records each one - and re-rendering the same post does not.
  useEffect(() => {
    if (!post?.id) {
      return;
    }
    void api.recordViewedPost(post.id).catch(() => undefined);
  }, [api, post?.id]);

  const nav = useMemo(() => {
    const { previous, next } = postNav;
    if (!previous && !next) {
      return null;
    }
    const contextQS = getContextQS();
    const buildLink = (target: PostWithComments, direction: 'previous' | 'next') => (
      <NavLink
        to={`${getContentUrl(target)}${contextQS ? '?' + contextQS : ''}`}
        className={`post-nav__item post-nav__item--${direction}`}
        onClick={() => {
          setPostNav({ previous: null, next: null });
          scrollTo(0, 0);
          setContent(target);
        }}
      >
        <span className="post-nav__arrow">
          {direction === 'previous' ? <LeftOutlined /> : <RightOutlined />}
        </span>
        <span className="post-nav__thumbnail-wrapper">
          <PostThumbnail post={target} classNamePrefix="post-nav" />
        </span>
        <span className="post-nav__text">
          <span className="post-nav__direction">
            {direction === 'previous' ? 'Previous' : 'Next'}
          </span>
          <span className="post-nav__title">{target.title}</span>
        </span>
      </NavLink>
    );
    // One neighbour gets the whole row rather than half of it, which is what
    // used to squeeze the titles hard enough to wrap.
    const single = !previous || !next;
    return (
      <ContentColumn settings={settings}>
        <div className={`post-nav mt-2 mb-3 ${single ? 'post-nav--single' : ''}`}>
          { previous ? buildLink(previous, 'previous') : null }
          { next ? buildLink(next, 'next') : null }
        </div>
      </ContentColumn>
    );
  }, [postNav, scrollTo, settings]);

  if (!post) {
    return <LoadingBlock className="mt-5" minHeight="60vh" />;
  }

  return (
    <>
      <ContentColumn settings={settings}>
        <div className={nav ? 'pt-4' : 'py-4'}>
          <PostCard post={post} showCampaign />
        </div>
      </ContentColumn>
      { nav }
      {
        post.comments && (
          <ContentColumn settings={settings} className="pt-2 pb-4 px-4">
            <h5 className="mb-3">{post.commentCount} {post.comments.length > 1 ? 'comments' : 'comment'}</h5>
            <CommentsPanel comments={post.comments} />
          </ContentColumn>
        )
      }
    </>
  )
}

export default PostContent;