import "../assets/styles/History.scss";
import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Empty, Popconfirm, Table, Tag } from "antd";
import { Link } from "react-router";
import { useAPI } from "../contexts/APIProvider";
import { useDocument } from "../contexts/DocumentProvider";
import { LoadingBlock } from "../components/Loading";
import Icon from "../components/Icon";
import { DESKTOP_QUERY, useMediaQuery } from "../utils/useMediaQuery";
import { MAX_FAVORITES, type FavoriteListItem } from "../../types/History";

function formatWhen(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

/**
 * A picture for a saved post, falling back to an icon. Same shape and classes
 * as the history thumbnails, so the two lists read alike.
 */
function FavoriteThumbnail(props: { mediaId: string | null }) {
  const { mediaId } = props;
  const [ failed, setFailed ] = useState(false);
  useEffect(() => setFailed(false), [ mediaId ]);

  if (!mediaId || failed) {
    return (
      <span className="history__thumbnail history__thumbnail--empty">
        <Icon name="description" outlined />
      </span>
    );
  }
  return (
    <img
      className="history__thumbnail"
      src={`/media/${encodeURIComponent(mediaId)}`}
      onError={() => setFailed(true)}
      alt=""
    />
  );
}

/** Links to the post, or plain text once the post has left the library. */
function EntryTitle(props: { title: string | null; to: string | null }) {
  const { title, to } = props;
  const text = title || 'Untitled';
  if (!to) {
    return <span className="history__title history__title--gone">{text}</span>;
  }
  return <Link className="history__title" to={to}>{text}</Link>;
}

/**
 * The posts this account has saved.
 *
 * Its own page, above History in the sidebar, because a favorite is a
 * deliberate act rather than a trace left by browsing - and unlike history it
 * is not evicted as newer entries arrive, only when the user removes it, up to
 * a ceiling of `MAX_FAVORITES`.
 */
function Favorites() {
  const { api } = useAPI();
  const { setTitle } = useDocument();
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const [ favorites, setFavorites ] = useState<FavoriteListItem[] | null>(null);
  const [ busyPostId, setBusyPostId ] = useState<string | null>(null);
  const [ error, setError ] = useState<string | null>(null);

  useEffect(() => {
    setTitle('Favorites');
  }, [ setTitle ]);

  const load = useCallback(async () => {
    try {
      setFavorites(await api.listFavorites());
      setError(null);
    }
    catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load favorites');
      setFavorites([]);
    }
  }, [ api ]);

  useEffect(() => { void load(); }, [ load ]);

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
  }, [ api ]);

  if (!favorites) {
    return <LoadingBlock className="mt-5" minHeight="60vh" />;
  }

  return (
    <div className="history">
      <div className="history__header">
        <h2 className="m-0">Favorites</h2>
        <span className="history__note">{favorites.length} of {MAX_FAVORITES} saved.</span>
      </div>
      {
        error ? <Alert className="mb-3" type="error" title={error} showIcon /> : null
      }
      <Table<FavoriteListItem>
        rowKey="postId"
        dataSource={favorites}
        pagination={false}
        locale={{
          emptyText: (
            <Empty
              description="No favorites yet. Open a post and tap the star."
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            />
          )
        }}
        columns={[
          {
            title: '',
            key: 'thumbnail',
            width: 96,
            render: (_, item) => <FavoriteThumbnail mediaId={item.thumbnailMediaId} />
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
    </div>
  );
}

export default Favorites;
