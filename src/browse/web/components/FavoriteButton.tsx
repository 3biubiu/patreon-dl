import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Tooltip } from "antd";
import { useAPI } from "../contexts/APIProvider";
import Icon from "./Icon";
import { useLanguage } from "../contexts/LanguageProvider";

interface FavoriteButtonProps {
  postId: string;
}

/**
 * The save / unsave toggle shown on a post. Its own component because it
 * carries a little state of its own - whether the post is already saved, which
 * it has to ask the server for - and because the list has a ceiling: when it
 * is full the server refuses, and the button says so in a tooltip rather than
 * flipping to a state that did not take.
 */
function FavoriteButton(props: FavoriteButtonProps) {
  const { postId } = props;
  const { api } = useAPI();
  const { t } = useLanguage();
  // null while the initial state is still being fetched, so the button does
  // not offer an action it might have to take back.
  const [ favorite, setFavorite ] = useState<boolean | null>(null);
  const [ busy, setBusy ] = useState(false);
  const [ notice, setNotice ] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFavorite(null);
    void api.isFavorite(postId)
      .then((value) => { if (!cancelled) setFavorite(value); })
      .catch(() => { if (!cancelled) setFavorite(false); });
    return () => { cancelled = true; };
  }, [ api, postId ]);

  useEffect(() => () => {
    if (noticeTimer.current) {
      clearTimeout(noticeTimer.current);
    }
  }, []);

  const flashNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) {
      clearTimeout(noticeTimer.current);
    }
    noticeTimer.current = setTimeout(() => setNotice(null), 4000);
  }, []);

  const toggle = useCallback(async () => {
    if (favorite === null || busy) {
      return;
    }
    setBusy(true);
    try {
      if (favorite) {
        await api.removeFavorite(postId);
        setFavorite(false);
      }
      else {
        await api.addFavorite(postId);
        setFavorite(true);
      }
    }
    catch (e) {
      flashNotice(e instanceof Error ? e.message : 'That did not work');
    }
    finally {
      setBusy(false);
    }
  }, [ api, busy, favorite, flashNotice, postId ]);

  const label = favorite ? t('fav_remove') : t('fav_add');

  return (
    <Tooltip title={notice || label} open={notice ? true : undefined}>
      <Button
        type="text"
        shape="circle"
        aria-label={label}
        aria-pressed={!!favorite}
        loading={busy}
        disabled={favorite === null}
        onClick={() => void toggle()}
        icon={
          <Icon
            name="star"
            outlined={!favorite}
            style={favorite ? { color: 'var(--bs-warning)' } : undefined}
          />
        }
      />
    </Tooltip>
  );
}

export default FavoriteButton;
