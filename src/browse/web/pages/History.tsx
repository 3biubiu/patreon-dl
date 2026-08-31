import "../assets/styles/History.scss";
import { useCallback, useEffect, useState } from "react";
import { Alert, Empty, Progress, Select, Table, Tabs, Tag } from "antd";
import { Link } from "react-router";
import { useAPI } from "../contexts/APIProvider";
import { useAuth } from "../contexts/AuthProvider";
import { useDocument } from "../contexts/DocumentProvider";
import { LoadingBlock } from "../components/Loading";
import Icon from "../components/Icon";
import { DESKTOP_QUERY, useMediaQuery } from "../utils/useMediaQuery";
import { type ViewedPostListItem, type WatchedVideoListItem } from "../../types/History";
import { type AuthUser } from "../../types/Auth";

function formatWhen(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

/** `h:mm:ss` past an hour, `m:ss` below it - how a player writes a time. */
function formatClock(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) {
    return '—';
  }
  const whole = Math.floor(seconds);
  const parts = [ Math.floor(whole / 3600), Math.floor((whole % 3600) / 60), whole % 60 ];
  const [ hours ] = parts;
  return (hours > 0 ? parts : parts.slice(1))
    .map((part, index) => index === 0 ? String(part) : String(part).padStart(2, '0'))
    .join(':');
}

/**
 * A picture for an entry, falling back to an icon.
 *
 * The 404 is expected rather than exceptional: a video whose thumbnail was
 * never downloaded and from which no frame could be taken has nothing to show.
 */
function HistoryThumbnail(props: { mediaId: string | null; video?: boolean; }) {
  const { mediaId, video } = props;
  const [ failed, setFailed ] = useState(false);
  useEffect(() => setFailed(false), [mediaId]);

  if (!mediaId || failed) {
    return (
      <span className="history__thumbnail history__thumbnail--empty">
        <Icon name={video ? 'movie' : 'description'} outlined />
      </span>
    );
  }
  return (
    <img
      className="history__thumbnail"
      src={`/media/${encodeURIComponent(mediaId)}${video ? '?t=1' : ''}`}
      onError={() => setFailed(true)}
      alt=""
    />
  );
}

/**
 * A title that links to where the thing can be seen again, or plain text when
 * whatever it belonged to is no longer in the library.
 */
function EntryTitle(props: { title: string | null; to: string | null; }) {
  const { title, to } = props;
  const text = title || 'Untitled';
  if (!to) {
    return <span className="history__title history__title--gone">{text}</span>;
  }
  return <Link className="history__title" to={to}>{text}</Link>;
}

function contentUrl(item: WatchedVideoListItem) {
  if (!item.contentId) {
    return null;
  }
  return item.contentType === 'product' ?
    `/products/${item.contentId}` : `/posts/${item.contentId}`;
}

/**
 * The last twenty videos played and the last twenty posts opened, per account.
 *
 * Twenty is not an arbitrary display limit - it is everything the server keeps.
 * The videos here are exactly the ones that will pick up where they were left,
 * which is what the list is really showing.
 *
 * An administrator sees a picker to choose whose history is shown, since they
 * may look at every account's - the list endpoints accept a `userId` only from
 * an administrator.
 */
function History() {
  const { api } = useAPI();
  const { user: currentUser } = useAuth();
  const { setTitle } = useDocument();
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const isAdmin = currentUser?.role === 'admin';
  const [ users, setUsers ] = useState<AuthUser[] | null>(null);
  /** Whose history is shown. `null` is the signed-in account's own. */
  const [ targetUser, setTargetUser ] = useState<string | null>(null);
  const [ videos, setVideos ] = useState<WatchedVideoListItem[] | null>(null);
  const [ posts, setPosts ] = useState<ViewedPostListItem[] | null>(null);
  const [ error, setError ] = useState<string | null>(null);

  useEffect(() => {
    setTitle('History');
  }, [setTitle]);

  // The names an administrator chooses from. Loaded once, on its own, so a
  // glance at one's own history is not made to wait on the whole user list.
  useEffect(() => {
    if (!isAdmin) {
      return;
    }
    let cancelled = false;
    void api.listUsers()
      .then((list) => { if (!cancelled) { setUsers(list); } })
      .catch(() => { if (!cancelled) { setUsers([]); } });
    return () => { cancelled = true; };
  }, [api, isAdmin]);

  const load = useCallback(async () => {
    try {
      const userId = targetUser ?? undefined;
      const [ watched, viewed ] = await Promise.all([
        api.listWatchedVideos(userId),
        api.listViewedPosts(userId)
      ]);
      setVideos(watched);
      setPosts(viewed);
      setError(null);
    }
    catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load history');
      setVideos([]);
      setPosts([]);
    }
  }, [api, targetUser]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!videos || !posts) {
    return <LoadingBlock className="mt-5" minHeight="60vh" />;
  }

  const videosTable = (
    <Table<WatchedVideoListItem>
      rowKey="mediaId"
      dataSource={videos}
      pagination={false}
      locale={{
        emptyText: <Empty description="No videos watched yet" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      }}
      columns={[
        {
          title: '',
          key: 'thumbnail',
          width: 96,
          render: (_, item) => <HistoryThumbnail mediaId={item.mediaId} video />
        },
        {
          title: 'Video',
          key: 'title',
          render: (_, item) => (
            <div className="history__entry">
              <EntryTitle title={item.title} to={contentUrl(item)} />
              {item.campaignName ? <Tag>{item.campaignName}</Tag> : null}
            </div>
          )
        },
        {
          title: 'Progress',
          key: 'progress',
          width: isDesktop ? 200 : 120,
          render: (_, item) => (
            <div className="history__progress">
              <Progress
                percent={item.duration ? Math.min(100, (item.position / item.duration) * 100) : 0}
                showInfo={false}
                size="small"
              />
              <span className="history__progress-text">
                {formatClock(item.position)}
                {item.duration ? ` / ${formatClock(item.duration)}` : ''}
              </span>
            </div>
          )
        },
        ...(isDesktop ? [ {
          title: 'Watched',
          dataIndex: 'watchedAt',
          width: 200,
          render: (watchedAt: string) => formatWhen(watchedAt)
        } ] : [])
      ]}
    />
  );

  const postsTable = (
    <Table<ViewedPostListItem>
      rowKey="postId"
      dataSource={posts}
      pagination={false}
      locale={{
        emptyText: <Empty description="No posts opened yet" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      }}
      columns={[
        {
          title: '',
          key: 'thumbnail',
          width: 96,
          render: (_, item) => <HistoryThumbnail mediaId={item.thumbnailMediaId} />
        },
        {
          title: 'Post',
          key: 'title',
          render: (_, item) => (
            <div className="history__entry">
              <EntryTitle title={item.title} to={item.title ? `/posts/${item.postId}` : null} />
              {item.campaignName ? <Tag>{item.campaignName}</Tag> : null}
            </div>
          )
        },
        ...(isDesktop ? [ {
          title: 'Opened',
          dataIndex: 'viewedAt',
          width: 200,
          render: (viewedAt: string) => formatWhen(viewedAt)
        } ] : [])
      ]}
    />
  );

  return (
    <div className="history">
      <div className="history__header">
        <h2 className="m-0">History</h2>
        {
          isAdmin ? (
            <Select
              style={{ minWidth: 180 }}
              loading={users === null}
              value={targetUser ?? currentUser?.id}
              onChange={(value) => setTargetUser(value === currentUser?.id ? null : value)}
              options={(users || []).map((u) => ({
                value: u.id,
                label: u.id === currentUser?.id ? `${u.username} (you)` : u.username
              }))}
              aria-label="Whose history"
            />
          ) : null
        }
        <span className="history__note">The last twenty of each are kept.</span>
      </div>
      {
        error ? (
          <Alert className="mb-3" type="error" title={error} showIcon />
        ) : null
      }
      <Tabs
        defaultActiveKey="videos"
        items={[
          { key: 'videos', label: `Videos (${videos.length})`, children: videosTable },
          { key: 'posts', label: `Posts (${posts.length})`, children: postsTable }
        ]}
      />
    </div>
  );
}

export default History;
