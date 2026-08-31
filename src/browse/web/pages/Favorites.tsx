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
import { useLanguage } from "../contexts/LanguageProvider";

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
  const { t } = useLanguage();
  const text = title || t('untitled');
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
  const { t } = useLanguage();
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const [ favorites, setFavorites ] = useState<FavoriteListItem[] | null>(null);
  const [ busyPostId, setBusyPostId ] = useState<string | null>(null);
  const [ error, setError ] = useState<string | null>(null);

  useEffect(() => {
    setTitle(t('nav_favorites'));
  }, [ setTitle, t ]);

  const load = useCallback(async () => {
    try {
      setFavorites(await api.listFavorites());
      setError(null);
    }
    catch (e) {
      setError(e instanceof Error ? e.message : t('could_not_load_favorites'));
      setFavorites([]);
    }
  }, [ api, t ]);

  useEffect(() => { void load(); }, [ load ]);

  const removeFavorite = useCallback(async (postId: string) => {
    setBusyPostId(postId);
    try {
      await api.removeFavorite(postId);
      setFavorites((prev) => prev ? prev.filter((favorite) => favorite.postId !== postId) : prev);
      setError(null);
    }
    catch (e) {
      setError(e instanceof Error ? e.message : t('could_not_update_favorites'));
    }
    finally {
      setBusyPostId(null);
    }
  }, [ api, t ]);

  if (!favorites) {
    return <LoadingBlock className="mt-5" minHeight="60vh" />;
  }

  return (
    <div className="history">
      <div className="history__header">
        <h2 className="m-0">{t('nav_favorites')}</h2>
        <span className="history__note">{t('favorites_note', { count: favorites.length, limit: MAX_FAVORITES })}</span>
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
              description={t('favorites_empty')}
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
            title: t('col_post'),
            key: 'title',
            render: (_, item) => (
              <div className="history__entry">
                <EntryTitle title={item.title} to={item.title ? `/posts/${item.postId}` : null} />
                {item.campaignName ? <Tag>{item.campaignName}</Tag> : null}
              </div>
            )
          },
          ...(isDesktop ? [ {
            title: t('col_saved'),
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
                title={t('confirm_remove_question')}
                okText={t('remove')}
                cancelText={t('never_mind')}
                onConfirm={() => void removeFavorite(item.postId)}
              >
                {
                  isDesktop ?
                    <Button size="small" type="text" loading={busyPostId === item.postId}>{t('remove')}</Button>
                    : (
                      <Button
                        size="small"
                        type="text"
                        loading={busyPostId === item.postId}
                        icon={<Icon name="delete_outline" />}
                        aria-label={t('fav_remove')}
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
