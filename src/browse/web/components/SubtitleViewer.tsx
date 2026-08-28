import "../assets/styles/SubtitleViewer.scss";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Drawer, Empty, Input, Segmented, Space } from "antd";
import { useAPI } from "../contexts/APIProvider";
import { LoadingBlock } from "./Loading";
import Icon from "./Icon";
import { useMediaQuery, DESKTOP_QUERY } from "../utils/useMediaQuery";
import { alignCues, formatCueTime, parseVTT, type CuePair } from "../utils/subtitleCues";
import { type SubtitleFile } from "../../types/Transcription";
import { TARGET_LANGUAGE } from "../../types/Translation";

/** Which language, or languages, the transcript is being read in. */
type ViewMode = 'both' | 'source' | 'target';

function isChinese(subtitle: SubtitleFile) {
  return subtitle.language === TARGET_LANGUAGE ||
    !!subtitle.language?.startsWith(`${TARGET_LANGUAGE}-`);
}

interface Loaded {
  /** Null when only one of the two languages is on disk. */
  source: SubtitleFile | null;
  target: SubtitleFile | null;
  pairs: CuePair[];
}

interface SubtitleViewerProps {
  open: boolean;
  /** The video being read; null until a row is opened. */
  mediaId: string | null;
  title: string;
  onClose: () => void;
}

/**
 * A video's transcript as text: the line the transcription produced, and under
 * it the Chinese the translation produced over the same seconds.
 *
 * The subtitle files are read through the same endpoints the player's caption
 * track uses - they are already there, and already scoped to the video's own
 * directory - and parsed here, since a `<track>` will play a file but never
 * hand its text back. Nothing is fetched until the drawer is opened for a
 * video, so the list behind it stays a list.
 */
function SubtitleViewer(props: SubtitleViewerProps) {
  const { open, mediaId, title, onClose } = props;
  const { api } = useAPI();
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const [ loaded, setLoaded ] = useState<Loaded | null>(null);
  const [ error, setError ] = useState<string | null>(null);
  const [ mode, setMode ] = useState<ViewMode>('both');
  const [ query, setQuery ] = useState('');
  const [ copied, setCopied ] = useState(false);

  useEffect(() => {
    if (!open || !mediaId) {
      return;
    }
    let cancelled = false;
    setLoaded(null);
    setError(null);
    setQuery('');
    setCopied(false);
    void (async () => {
      try {
        const subtitles = await api.getSubtitles(mediaId);
        const target = subtitles.find(isChinese) || null;
        // Whatever is left is the transcription's own file. It carries no
        // language suffix, so it is found by not being the Chinese one rather
        // than by its name.
        const source = subtitles.find((subtitle) => subtitle !== target) || null;
        const [ sourceText, targetText ] = await Promise.all([
          source ? api.getSubtitleText(mediaId, source.filename) : Promise.resolve(''),
          target ? api.getSubtitleText(mediaId, target.filename) : Promise.resolve('')
        ]);
        if (cancelled) {
          return;
        }
        setLoaded({ source, target, pairs: alignCues(parseVTT(sourceText), parseVTT(targetText)) });
        // Open on whichever languages there is something to show for, rather
        // than on an empty column.
        setMode(source && target ? 'both' : source ? 'source' : 'target');
      }
      catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Could not read the subtitles for this video');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [ api, mediaId, open ]);

  const rows = useMemo(() => {
    if (!loaded) {
      return [];
    }
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return loaded.pairs;
    }
    // Only what is on screen is searched: a hit in a language that is hidden
    // would show a line with nothing in it that matches.
    return loaded.pairs.filter((pair) => {
      const haystack =
        mode === 'source' ? pair.source :
          mode === 'target' ? pair.target :
            `${pair.source} ${pair.target}`;
      return haystack.toLowerCase().includes(needle);
    });
  }, [ loaded, mode, query ]);

  /** The transcript as it reads on screen, for pasting somewhere else. */
  const copy = useCallback(() => {
    const text = rows.map((pair) => {
      if (mode === 'source') {
        return pair.source;
      }
      if (mode === 'target') {
        return pair.target;
      }
      return [ pair.source, pair.target ].filter(Boolean).join('\n');
    }).filter(Boolean).join(mode === 'both' ? '\n\n' : '\n');
    void (async () => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
      catch {
        setError('The browser would not let the transcript be copied');
      }
    })();
  }, [ mode, rows ]);

  const renderBody = () => {
    if (error) {
      return <Alert type="error" title={error} showIcon />;
    }
    if (!loaded) {
      return <LoadingBlock />;
    }
    if (loaded.pairs.length === 0) {
      return <Empty description="There is no subtitle file beside this video any more." />;
    }
    return (
      <>
        <div className="subtitle-viewer__toolbar">
          {
            // Only worth offering when there are two languages to choose
            // between; with one, the toggle would have nothing to switch to.
            loaded.source && loaded.target ? (
              <Segmented
                value={mode}
                onChange={(value) => setMode(value as ViewMode)}
                options={[
                  { value: 'both', label: '双语' },
                  { value: 'source', label: 'EN' },
                  { value: 'target', label: '中文' }
                ]}
              />
            ) : null
          }
          <Input
            className="subtitle-viewer__search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            allowClear
            placeholder="Search this transcript"
            prefix={<Icon name="search" />}
          />
          <Button icon={<Icon name={copied ? 'check' : 'content_copy'} />} onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        {
          rows.length === 0 ?
            <Empty description="No line says that." />
            : (
              <ol className="subtitle-viewer__lines">
                {
                  rows.map((pair) => (
                    <li key={pair.key} className="subtitle-viewer__line">
                      <span className="subtitle-viewer__time">{formatCueTime(pair.start)}</span>
                      <div className="subtitle-viewer__text">
                        {
                          mode !== 'target' && pair.source ?
                            <p className="subtitle-viewer__source">{pair.source}</p>
                            : null
                        }
                        {
                          mode !== 'source' && pair.target ?
                            <p className="subtitle-viewer__target" lang="zh">{pair.target}</p>
                            : null
                        }
                      </div>
                    </li>
                  ))
                }
              </ol>
            )
        }
      </>
    );
  };

  return (
    <Drawer
      className="subtitle-viewer"
      title={<span className="subtitle-viewer__title">{title}</span>}
      placement="right"
      width={isDesktop ? 720 : '100%'}
      open={open}
      onClose={onClose}
      destroyOnHidden
    >
      <Space orientation="vertical" size="middle" style={{ display: 'flex' }}>
        {renderBody()}
      </Space>
    </Drawer>
  );
}

export default SubtitleViewer;
