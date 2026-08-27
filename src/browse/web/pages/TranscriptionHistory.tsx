import "../assets/styles/TranscriptionHistory.scss";
import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Checkbox, Empty, Popconfirm, Progress, Space, Table, Tag, Tooltip } from "antd";
import { Link } from "react-router";
import { useAPI } from "../contexts/APIProvider";
import { useDocument } from "../contexts/DocumentProvider";
import { LoadingBlock } from "../components/Loading";
import Icon from "../components/Icon";
import { useMediaQuery, DESKTOP_QUERY } from "../utils/useMediaQuery";
import useTranslationAvailability from "../utils/useTranslationAvailability";
import { readTranslatePreference, writeTranslatePreference } from "../utils/translatePreference";
import {
  isActive,
  type TranscriptionRecord,
  type TranscriptionStage,
  type TranscriptionState
} from "../../types/Transcription";
import { isTranslationActive, type TranslationState } from "../../types/Translation";

/** How often the list refreshes while anything is still moving. */
const POLL_INTERVAL_MS = 2000;

const STATE_LABEL: Record<TranscriptionState, string> = {
  pending: 'Queued',
  running: 'Running',
  done: 'Done',
  error: 'Failed',
  cancelled: 'Cancelled'
};

const STATE_COLOR: Record<TranscriptionState, string> = {
  pending: 'default',
  running: 'processing',
  done: 'success',
  error: 'error',
  cancelled: 'warning'
};

const STAGE_LABEL: Record<TranscriptionStage, string> = {
  detecting: 'Finding speech',
  transcribing: 'Transcribing',
  writing: 'Writing subtitles'
};

const TRANSLATION_STATE_LABEL: Record<TranslationState, string> = {
  pending: 'Queued',
  running: 'Translating',
  done: 'Chinese',
  error: 'Failed',
  cancelled: 'Cancelled'
};

const TRANSLATION_STATE_COLOR: Record<TranslationState, string> = {
  pending: 'default',
  running: 'processing',
  done: 'success',
  error: 'error',
  cancelled: 'warning'
};

function formatTime(value: string | null) {
  if (!value) {
    return '—';
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function formatDuration(record: TranscriptionRecord) {
  if (!record.startedAt) {
    return '—';
  }
  const end = record.completedAt ? new Date(record.completedAt) : new Date();
  const seconds = Math.round((end.getTime() - new Date(record.startedAt).getTime()) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '—';
  }
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * The video's poster, or a stand-in of the same size.
 *
 * The server generates a frame for videos that never had a thumbnail
 * downloaded, and caches it - but it can still come back empty, and a broken
 * image icon in every row would be worse than none.
 */
function VideoThumbnail(props: { mediaId: string }) {
  const [ failed, setFailed ] = useState(false);
  useEffect(() => setFailed(false), [ props.mediaId ]);

  if (failed) {
    return (
      <span className="transcription-history__thumbnail transcription-history__thumbnail-placeholder">
        <Icon name="movie" outlined />
      </span>
    );
  }
  return (
    <img
      className="transcription-history__thumbnail"
      src={`/media/${props.mediaId}?t=1`}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

/**
 * Every transcription that has been asked for and what became of it.
 *
 * The server writes each step to its index as it happens, so this is a plain
 * read of that file rather than anything this page has to keep in sync. It
 * polls only while something is still moving.
 */
function TranscriptionHistory() {
  const { api } = useAPI();
  const { setTitle } = useDocument();
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const [ records, setRecords ] = useState<TranscriptionRecord[] | null>(null);
  const [ error, setError ] = useState<string | null>(null);
  const [ busyId, setBusyId ] = useState<string | null>(null);
  const [ anyActive, setAnyActive ] = useState(false);
  const [ translate, setTranslate ] = useState(readTranslatePreference);
  const availability = useTranslationAvailability();
  const canTranslate = !!availability?.available;

  useEffect(() => {
    setTitle('Transcription');
  }, [ setTitle ]);

  const refresh = useCallback(async () => {
    try {
      const result = await api.listTranscriptions();
      setRecords(result);
      // A translation outlives the transcription it followed, so the list has
      // to keep refreshing for it as well.
      setAnyActive(result.some((record) => isActive(record) || isTranslationActive(record.translation)));
    }
    catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the transcription history');
    }
  }, [ api ]);

  useEffect(() => { void refresh(); }, [ refresh ]);

  useEffect(() => {
    if (!anyActive) {
      return;
    }
    const timer = setInterval(() => { void refresh(); }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [ anyActive, refresh ]);

  const run = useCallback(async (mediaId: string, action: () => Promise<unknown>) => {
    setBusyId(mediaId);
    setError(null);
    try {
      await action();
      await refresh();
    }
    catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work');
    }
    finally {
      setBusyId(null);
    }
  }, [ refresh ]);

  if (!records) {
    return error ? <Alert type="error" title={error} showIcon /> : <LoadingBlock />;
  }

  const videoColumn = {
    title: 'Video',
    key: 'video',
    render: (_: unknown, record: TranscriptionRecord) => (
      <div className="transcription-history__video">
        <VideoThumbnail mediaId={record.mediaId} />
        <Tooltip title={record.videoPath}>
          <span className="transcription-history__name">{record.videoName}</span>
        </Tooltip>
      </div>
    )
  };

  const stateColumn = {
    title: isDesktop ? 'State' : 'Progress',
    key: 'state',
    width: isDesktop ? 220 : 110,
    render: (_: unknown, record: TranscriptionRecord) => (
      <div className="transcription-history__state">
        <span>
          <Tag color={STATE_COLOR[record.state]} style={{ marginInlineEnd: 4 }}>
            {STATE_LABEL[record.state]}
          </Tag>
          {
            isDesktop && record.state === 'running' && record.stage ?
              <span className="transcription-history__stage">{STAGE_LABEL[record.stage]}</span>
              : null
          }
        </span>
        {
          record.state === 'running' ?
            <Progress percent={record.percent} size="small" />
            : null
        }
        {
          record.state === 'error' && record.error ?
            <Tooltip title={record.error}>
              <span className="transcription-history__error">{record.error}</span>
            </Tooltip>
            : null
        }
      </div>
    )
  };

  const languageColumn = {
    title: 'Lang',
    dataIndex: 'language',
    key: 'language',
    width: isDesktop ? 100 : 60,
    render: (language: string | null) => language || '—'
  };

  /**
   * What the AI translation of this transcription is doing.
   *
   * Finished ones show the number of Gemini calls they took rather than a
   * price: Gemini AI Studio bills by the call, so that is the number worth
   * watching, and the one the batch size in the settings moves.
   */
  const translationColumn = {
    title: 'Translation',
    key: 'translation',
    width: 170,
    render: (_: unknown, record: TranscriptionRecord) => {
      const translation = record.translation;
      if (!translation) {
        return '—';
      }
      return (
        <div className="transcription-history__state">
          <Tag color={TRANSLATION_STATE_COLOR[translation.state]}>
            {TRANSLATION_STATE_LABEL[translation.state]}
          </Tag>
          {
            translation.state === 'running' ?
              <Progress percent={translation.percent} size="small" />
              : null
          }
          {
            translation.state === 'done' ?
              <span className="transcription-history__stage">
                {translation.requests} call{translation.requests === 1 ? '' : 's'}
                {translation.cached > 0 ? ` + ${translation.cached} cached` : ''}
              </span>
              : null
          }
          {
            translation.state === 'error' && translation.error ?
              <Tooltip title={translation.error}>
                <span className="transcription-history__error">{translation.error}</span>
              </Tooltip>
              : null
          }
        </div>
      );
    }
  };

  /** The box that says to translate as well, shared by both confirmations. */
  const translateCheckbox = canTranslate ? (
    <Checkbox
      checked={translate}
      onChange={(e) => {
        setTranslate(e.target.checked);
        writeTranslatePreference(e.target.checked);
      }}
      style={{ marginBlockStart: 8 }}
    >
      Also translate to Chinese
    </Checkbox>
  ) : null;

  const actionsColumn = {
    title: '',
    key: 'actions',
    width: isDesktop ? 250 : 108,
    render: (_: unknown, record: TranscriptionRecord) => {
      const busy = busyId === record.mediaId;
      const translating = isTranslationActive(record.translation);
      if (isActive(record) || translating) {
        // One button for both: a record can be transcribing with a translation
        // already asked for behind it, and cancelling one of the two while
        // leaving the other queued is not a thing anyone means to do.
        return (
          <Popconfirm
            title={isActive(record) ? 'Cancel this transcription?' : 'Cancel this translation?'}
            description="Progress so far is discarded."
            okText="Cancel it"
            cancelText="Never mind"
            okButtonProps={{ danger: true }}
            onConfirm={() => void run(record.mediaId, async () => {
              await api.cancelTranslation(record.mediaId);
              if (isActive(record)) {
                await api.cancelTranscription(record.mediaId);
              }
            })}
          >
            {
              isDesktop ?
                <Button size="small" danger loading={busy}>Cancel</Button>
                : <Button size="small" danger loading={busy} icon={<Icon name="close" />} aria-label="Cancel" />
            }
          </Popconfirm>
        );
      }
      return (
        <div className="transcription-history__actions">
          <Popconfirm
            title="Transcribe again?"
            description={
              <>
                <div>
                  {
                    record.state === 'done' ?
                      'The existing subtitle file is replaced.'
                      : 'It runs in the background and costs roughly $0.01 per hour of video.'
                  }
                </div>
                {translateCheckbox}
              </>
            }
            okText="Transcribe"
            cancelText="Never mind"
            onConfirm={() => void run(record.mediaId, async () => {
              await api.startTranscription(record.mediaId);
              if (canTranslate && translate) {
                await api.startTranslation(record.mediaId);
              }
            })}
          >
            {
              isDesktop ?
                <Button size="small" loading={busy}>Retry</Button>
                : <Button size="small" loading={busy} icon={<Icon name="refresh" />} aria-label="Retry" />
            }
          </Popconfirm>
          {
            // The second way in: translating a transcription that is already
            // finished, without transcribing it again.
            canTranslate && record.state === 'done' ? (
              <Popconfirm
                title={record.translation?.state === 'done' ? 'Translate again?' : 'Translate to Chinese?'}
                description={
                  record.translation?.state === 'done' ?
                    'The existing Chinese subtitle file is replaced.'
                    : 'The subtitles are translated in the background and written beside the video.'
                }
                okText="Translate"
                cancelText="Never mind"
                onConfirm={() => void run(record.mediaId, () => api.startTranslation(record.mediaId))}
              >
                {
                  isDesktop ?
                    <Button size="small" loading={busy}>Translate</Button>
                    : <Button size="small" loading={busy} icon={<Icon name="translate" />} aria-label="Translate" />
                }
              </Popconfirm>
            ) : null
          }
          <Popconfirm
            title="Forget this record?"
            description="The subtitle file it produced stays on disk."
            okText="Forget"
            cancelText="Never mind"
            onConfirm={() => void run(record.mediaId, () => api.forgetTranscription(record.mediaId))}
          >
            {
              isDesktop ?
                <Button size="small" type="text" loading={busy}>Forget</Button>
                : <Button size="small" type="text" loading={busy} icon={<Icon name="delete_outline" />} aria-label="Forget" />
            }
          </Popconfirm>
        </div>
      );
    }
  };

  // A phone keeps the four that say what this is and what it is doing. The
  // rest are for reading afterwards, and are what would push the table past
  // the screen and put a scrollbar under it.
  const columns = isDesktop ? [
    videoColumn,
    stateColumn,
    translationColumn,
    languageColumn,
    {
      title: 'Cost',
      dataIndex: 'cost',
      key: 'cost',
      width: 90,
      render: (cost: number | null) => typeof cost === 'number' ? `$${cost.toFixed(4)}` : '—'
    },
    {
      title: 'Took',
      key: 'took',
      width: 80,
      render: (_: unknown, record: TranscriptionRecord) => formatDuration(record)
    },
    {
      title: 'Requested',
      dataIndex: 'requestedAt',
      key: 'requestedAt',
      width: 160,
      render: (value: string) => formatTime(value)
    },
    actionsColumn
  ] : [
    videoColumn,
    languageColumn,
    stateColumn,
    actionsColumn
  ];

  const active = records.filter(isActive).length;
  const translatingCount = records.filter((record) => isTranslationActive(record.translation)).length;
  // Nothing that is still moving, on either queue, counts as finished - the
  // button below offers to clear these, and the server keeps the rest.
  const finished = records.filter((record) =>
    !isActive(record) && !isTranslationActive(record.translation)
  ).length;

  return (
    <Space
      orientation="vertical"
      size="middle"
      className="transcription-history"
      style={{ display: 'flex' }}
    >
      {
        error ?
          <Alert type="error" title={error} showIcon closable={{ onClose: () => setError(null) }} />
          : null
      }

      <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
        <Space wrap>
          <Link to="/transcription/settings">
            <Button>Settings</Button>
          </Link>
          <Link to="/transcription/translation">
            <Button>Translation</Button>
          </Link>
        </Space>
        <Space wrap>
          {
            active + translatingCount > 0 ? (
              <Popconfirm
                title={`Stop ${active + translatingCount} job${active + translatingCount > 1 ? 's' : ''}?`}
                description="The running ones are aborted and the rest are taken off the queue. Progress so far is discarded."
                okText="Stop all"
                cancelText="Never mind"
                okButtonProps={{ danger: true }}
                onConfirm={() => void run('', async () => {
                  // Translations first, so a transcription stopping does not
                  // hand over to one that is about to be cancelled anyway.
                  await api.stopAllTranslations();
                  setRecords(await api.stopAllTranscriptions());
                })}
              >
                <Button danger>Stop all ({active + translatingCount})</Button>
              </Popconfirm>
            ) : null
          }
          {
            finished > 0 ? (
              <Popconfirm
                title="Clear finished records?"
                description="Anything queued or running is kept. Subtitle files stay on disk."
                okText="Clear"
                cancelText="Never mind"
                onConfirm={() => void run('', async () => { setRecords(await api.clearTranscriptionHistory()); })}
              >
                <Button>Clear finished ({finished})</Button>
              </Popconfirm>
            ) : null
          }
        </Space>
      </Space>

      {
        records.length === 0 ?
          <Empty description="Nothing has been transcribed yet. Use the CC button on a video." />
          : (
            <Table
              rowKey="mediaId"
              size="small"
              columns={columns}
              dataSource={records}
              pagination={{ pageSize: 20, hideOnSinglePage: true }}
              // No horizontal scroll: the column set is trimmed to fit instead,
              // which is the point of dropping columns on a phone.
              tableLayout="fixed"
            />
          )
      }
    </Space>
  );
}

export default TranscriptionHistory;
