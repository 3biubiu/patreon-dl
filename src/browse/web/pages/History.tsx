import "../assets/styles/History.scss";
import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Empty, Popconfirm, Progress, Table, Tabs, Tag } from "antd";
import { Link } from "react-router";
import { useAPI } from "../contexts/APIProvider";
import { useDocument } from "../contexts/DocumentProvider";
import { LoadingBlock } from "../components/Loading";
import Icon from "../components/Icon";
import { DESKTOP_QUERY, useMediaQuery } from "../utils/useMediaQuery";
import {
  MAX_FAVORITES,
  type FavoriteListItem,
  type ViewedPostListItem,
  type WatchedVideoListItem
} from "../../types/History";

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
 * The last ten videos played and the last ten posts opened, per account.
 *
 * Ten is not an arbitrary display limit - it is everything the server keeps.
 * The videos here are exactly the ones that will pick up where they were left,
 * which is what the list is really showing.
 */
function History() {
  const { api } = useAPI();
  const { setTitle } = useDocument();
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const [ videos, setVideos ] = useState<WatchedVideoListItem[] | null>(null);
  const [ posts, setPosts ] = useState<ViewedPostListItem[] | null>(null);
  const [ favorites, setFavorites ] = useState<FavoriteListItem[] | null>(null);
  const [ busyPostId, setBusyPostId ] = useState<string | null>(null);
  const [ error, setError ] = useState<string | null>(null);

  useEffect(() => {
    setTitle('History');
  }, [setTitle]);

  const load = useCallback(async () => {
    try {
      const [ watched, viewed, saved ] = await Promise.all([
        api.listWatchedVideos(),
        api.listViewedPosts(),
        api.listFavorites()
      ]);
      setVideos(watched);
      setPosts(viewed);
      setFavorites(saved);
      setError(null);
    }
    catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load history');
      setVideos([]);
      setPosts([]);
      setFavorites([]);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const removeFavorite = useCallback(async (postId: string) => {
    setBusyPostId(postId);
    try {
      await api.removeFavorite(postId);
      setFavorites((prev) => prev ? prev.filter((favorite) => favorite.postId !== postId) : prev);
      setError(null);
    }
    catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update favorites');
    }
    finally {
      setBusyPostId(null);
    }
  }, [api]);

  if (!videos || !posts || !favorites) {
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

  const favoritesTable = (
    <Table<FavoriteListItem>
      rowKey="postId"
      dataSource={favorites}
      pagination={false}
      locale={{
        emptyText: <Empty description="No favorites yet" image={Empty.PRESENTED_IMAGE_SIMPLE} />
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
          title: 'Saved',
          dataIndex: 'favoritedAt',
          width: 200,
          render: (favoritedAt: string) => formatWhen(favoritedAt)
        } ] : []),
        {
          title: '',
          key: 'actions',
          width: isDesktop ? 110 : 56,
          render: (_: unknown, item: FavoriteListItem) => (
            <Popconfirm
              title="Remove from favorites?"
              okText="Remove"
              cancelText="Never mind"
              onConfirm={() => void removeFavorite(item.postId)}
            >
              {
                isDesktop ?
                  <Button size="small" type="text" loading={busyPostId === item.postId}>Remove</Button>
                  : (
                    <Button
                      size="small"
                      type="text"
                      loading={busyPostId === item.postId}
                      icon={<Icon name="delete_outline" />}
                      aria-label="Remove from favorites"
                    />
                  )
              }
            </Popconfirm>
          )
        }
      ]}
    />
  );

  return (
    <div className="history">
      <div className="history__header">
        <h2 className="m-0">History</h2>
        <span className="history__note">
          The last ten videos and posts are kept; up to {MAX_FAVORITES} favorites.
        </span>
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
          { key: 'posts', label: `Posts (${posts.length})`, children: postsTable },
          { key: 'favorites', label: `Favorites (${favorites.length})`, children: favoritesTable }
        ]}
      />
    </div>
  );
}

export default History;
