import "../assets/styles/TranscriptionHistory.scss";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Checkbox, Empty, Popconfirm, Progress, Space, Table, Tabs, Tag, Tooltip } from "antd";
import { Link } from "react-router";
import { useAPI } from "../contexts/APIProvider";
import { useDocument } from "../contexts/DocumentProvider";
import { LoadingBlock } from "../components/Loading";
import {
  AudioOutlined,
  CloseOutlined,
  DeleteOutlined,
  FileTextOutlined,
  ReloadOutlined,
  SettingOutlined,
  TranslationOutlined,
  VideoCameraOutlined
} from "@ant-design/icons";
import TranscriptionSettingsDrawer from "../components/TranscriptionSettingsDrawer";
import SubtitleViewer from "../components/SubtitleViewer";
import { useMediaQuery, DESKTOP_QUERY } from "../utils/useMediaQuery";
import useTranslationAvailability from "../utils/useTranslationAvailability";
import { readTranslatePreference, writeTranslatePreference } from "../utils/translatePreference";
import { useLanguage } from "../contexts/LanguageProvider";
import {
  isActive,
  type TranscriptionRecord,
  type TranscriptionStage,
  type TranscriptionState
} from "../../types/Transcription";
import { isTranslationActive, type TranslationState } from "../../types/Translation";

/** How often the list refreshes while anything is still moving. */
const POLL_INTERVAL_MS = 2000;

type ListTab = 'transcription' | 'translation' | 'subtitles';

const STATE_COLOR: Record<TranscriptionState, string> = {
  pending: 'default',
  running: 'processing',
  done: 'success',
  error: 'error',
  cancelled: 'warning'
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
 * A tab's name with how many rows are behind it.
 *
 * The count is a pill rather than "(12)" in the label, so that it reads as a
 * quantity at a glance and does not shift the name about as it changes - the
 * same treatment the Applications tab gets on the Users page. A tab with
 * nothing in it shows no pill at all rather than a zero.
 */
function TabLabel(props: { text: string; count: number; }) {
  const { text, count } = props;
  return (
    <span className="transcription-history__tab-label">
      {text}
      {count > 0 ? <span className="transcription-history__tab-count">{count}</span> : null}
    </span>
  );
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
        <VideoCameraOutlined />
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
 * Thumbnail plus the file name. The name links back to the post (or product)
 * the video is in when the server could tie the two together; otherwise it is
 * plain text, because a link that goes nowhere is worse than none.
 */
function VideoCell(props: { record: TranscriptionRecord }) {
  const { record } = props;
  const target = record.postId ?
    record.contentType === 'product' ?
      `/products/${record.postId}`
      : `/posts/${record.postId}`
    : null;
  return (
    <div className="transcription-history__video">
      <VideoThumbnail mediaId={record.mediaId} />
      <Tooltip title={record.videoPath}>
        {
          target ?
            <Link to={target} className="transcription-history__name transcription-history__name--link">
              {record.videoName}
            </Link>
            : <span className="transcription-history__name">{record.videoName}</span>
        }
      </Tooltip>
    </div>
  );
}

/**
 * Every transcription that has been asked for and what became of it, and
 * beside it every translation that has followed one.
 *
 * The server writes each step to its index as it happens, so this is a plain
 * read of that file rather than anything this page has to keep in sync. It
 * polls only while something is still moving. The two queues get a tab each -
 * they run independently, and a translation outlives the transcription it
 * came from - but there is still one list of records underneath, so a video
 * only ever shows up once per tab. A third tab drops the queues altogether and
 * lists what came out of them, for reading rather than for watching.
 */
function TranscriptionHistory() {
  const { api } = useAPI();
  const { setTitle } = useDocument();
  const { t } = useLanguage();
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const [ records, setRecords ] = useState<TranscriptionRecord[] | null>(null);
  const [ error, setError ] = useState<string | null>(null);
  const [ busyId, setBusyId ] = useState<string | null>(null);
  const [ anyActive, setAnyActive ] = useState(false);
  const [ translate, setTranslate ] = useState(readTranslatePreference);
  const [ tab, setTab ] = useState<ListTab>('transcription');
  const [ viewing, setViewing ] = useState<TranscriptionRecord | null>(null);
  const [ settingsOpen, setSettingsOpen ] = useState(false);
  const availability = useTranslationAvailability();
  const canTranslate = !!availability?.available;

  const stateLabel = useMemo<Record<TranscriptionState, string>>(() => ({
    pending: t('state_pending'),
    running: t('state_running'),
    done: t('state_done'),
    error: t('state_error'),
    cancelled: t('state_cancelled')
  }), [t]);

  const stageLabel = useMemo<Record<TranscriptionStage, string>>(() => ({
    detecting: t('stage_detecting'),
    transcribing: t('stage_transcribing'),
    segmenting: t('stage_segmenting'),
    polishing: t('stage_polishing'),
    writing: t('stage_writing')
  }), [t]);

  const translationStateLabel = useMemo<Record<TranslationState, string>>(() => ({
    pending: t('state_pending'),
    running: t('trans_state_translating'),
    done: t('trans_state_chinese'),
    error: t('state_error'),
    cancelled: t('state_cancelled')
  }), [t]);

  useEffect(() => {
    setTitle(t('nav_transcription'));
  }, [setTitle, t]);

  const refresh = useCallback(async () => {
    try {
      const result = await api.listTranscriptions();
      setRecords(result);
      // A translation outlives the transcription it followed, so the list has
      // to keep refreshing for it as well.
      setAnyActive(result.some((record) => isActive(record) || isTranslationActive(record.translation)));
    }
    catch (e) {
      setError(e instanceof Error ? e.message : t('could_not_load_transcription_history'));
    }
  }, [ api, t ]);

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
      setError(e instanceof Error ? e.message : t('that_did_not_work'));
    }
    finally {
      setBusyId(null);
    }
  }, [ refresh, t ]);

  if (!records) {
    return error ? <Alert type="error" title={error} showIcon /> : <LoadingBlock />;
  }

  const videoColumn = {
    title: t('col_video'),
    key: 'video',
    render: (_: unknown, record: TranscriptionRecord) => <VideoCell record={record} />
  };

  const stateColumn = {
    title: isDesktop ? t('col_state') : t('col_progress'),
    key: 'state',
    width: isDesktop ? 220 : 110,
    render: (_: unknown, record: TranscriptionRecord) => (
      <div className="transcription-history__state">
        <span>
          <Tag color={STATE_COLOR[record.state]} style={{ marginInlineEnd: 4 }}>
            {stateLabel[record.state]}
          </Tag>
          {
            isDesktop && record.state === 'running' && record.stage ?
              <span className="transcription-history__stage">{stageLabel[record.stage]}</span>
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
    title: t('col_lang'),
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
  const translationStateColumn = {
    title: t('col_state'),
    key: 'translation-state',
    width: isDesktop ? 220 : 130,
    render: (_: unknown, record: TranscriptionRecord) => {
      const translation = record.translation;
      if (!translation) {
        return '—';
      }
      return (
        <div className="transcription-history__state">
          <Tag color={TRANSLATION_STATE_COLOR[translation.state]}>
            {translationStateLabel[translation.state]}
          </Tag>
          {
            translation.state === 'running' ?
              <Progress percent={translation.percent} size="small" />
              : null
          }
          {
            translation.state === 'done' ?
              <span className="transcription-history__stage">
                {t('calls_count', { count: translation.requests })}
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

  /** The box that says to translate as well, shown on the transcribe-again confirmation. */
  const translateCheckbox = canTranslate ? (
    <Checkbox
      checked={translate}
      onChange={(e) => {
        setTranslate(e.target.checked);
        writeTranslatePreference(e.target.checked);
      }}
      style={{ marginBlockStart: 8 }}
    >
      {t('also_translate_to_chinese')}
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
            title={isActive(record) ? t('cancel_transcription_confirm') : t('cancel_translation_confirm')}
            description={t('progress_discarded_desc')}
            okText={t('cancel_it')}
            cancelText={t('never_mind')}
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
                <Button size="small" danger loading={busy}>{t('cancel')}</Button>
                : <Button size="small" danger loading={busy} icon={<CloseOutlined />} aria-label={t('cancel')} />
            }
          </Popconfirm>
        );
      }
      return (
        <div className="transcription-history__actions">
          <Popconfirm
            title={t('transcribe_again_confirm')}
            description={
              <>
                <div>
                  {
                    record.state === 'done' ?
                      t('replaced_subtitle_desc')
                      : t('rerun_background_cost_desc')
                  }
                </div>
                {translateCheckbox}
              </>
            }
            okText={t('transcribe')}
            cancelText={t('never_mind')}
            onConfirm={() => void run(record.mediaId, async () => {
              await api.startTranscription(record.mediaId);
              if (canTranslate && translate) {
                await api.startTranslation(record.mediaId);
              }
            })}
          >
            {
              isDesktop ?
                <Button size="small" loading={busy}>{t('retry')}</Button>
                : <Button size="small" loading={busy} icon={<ReloadOutlined />} aria-label={t('retry')} />
            }
          </Popconfirm>
          {
            // The second way in: translating a transcription that is already
            // finished, without transcribing it again.
            //
            // Shown whether or not a key is configured yet, so that a
            // transcription without a translation always says how to get one.
            // Without a key the server answers with what is missing, which is
            // more use than a button that is simply not there.
            record.state === 'done' ? (
              <Popconfirm
                title={record.translation?.state === 'done' ? t('translate_again_confirm') : t('translate_to_chinese_confirm')}
                description={
                  record.translation?.state === 'done' ?
                    t('replaced_chinese_subtitle_desc')
                    : t('translate_background_desc')
                }
                okText={t('translate_button')}
                cancelText={t('never_mind')}
                onConfirm={() => void run(record.mediaId, () => api.startTranslation(record.mediaId))}
              >
                {
                  isDesktop ?
                    <Button size="small" loading={busy}>{t('translate_button')}</Button>
                    : <Button size="small" loading={busy} icon={<TranslationOutlined />} aria-label={t('translate_button')} />
                }
              </Popconfirm>
            ) : null
          }
          <Popconfirm
            title={t('forget_record_confirm')}
            description={t('forget_record_desc')}
            okText={t('forget')}
            cancelText={t('never_mind')}
            onConfirm={() => void run(record.mediaId, () => api.forgetTranscription(record.mediaId))}
          >
            {
              isDesktop ?
                <Button size="small" type="text" loading={busy}>{t('forget')}</Button>
                : <Button size="small" type="text" loading={busy} icon={<DeleteOutlined />} aria-label={t('forget')} />
            }
          </Popconfirm>
        </div>
      );
    }
  };

  /** The translation tab's own actions: cancel while it runs, retry once it can. */
  const translationActionsColumn = {
    title: '',
    key: 'translation-actions',
    width: isDesktop ? 160 : 96,
    render: (_: unknown, record: TranscriptionRecord) => {
      const busy = busyId === record.mediaId;
      if (isTranslationActive(record.translation)) {
        return (
          <Popconfirm
            title={t('cancel_translation_confirm')}
            description={t('progress_discarded_desc')}
            okText={t('cancel_it')}
            cancelText={t('never_mind')}
            okButtonProps={{ danger: true }}
            onConfirm={() => void run(record.mediaId, () => api.cancelTranslation(record.mediaId))}
          >
            {
              isDesktop ?
                <Button size="small" danger loading={busy}>{t('cancel')}</Button>
                : <Button size="small" danger loading={busy} icon={<CloseOutlined />} aria-label={t('cancel')} />
            }
          </Popconfirm>
        );
      }
      if (record.state === 'done') {
        return (
          <Popconfirm
            title={record.translation?.state === 'done' ? t('translate_again_confirm') : t('translate_to_chinese_confirm')}
            description={
              record.translation?.state === 'done' ?
                t('replaced_chinese_subtitle_desc')
                : t('translate_background_desc')
            }
            okText={t('translate_button')}
            cancelText={t('never_mind')}
            onConfirm={() => void run(record.mediaId, () => api.startTranslation(record.mediaId))}
          >
            {
              isDesktop ?
                <Button size="small" loading={busy}>{t('retry')}</Button>
                : <Button size="small" loading={busy} icon={<ReloadOutlined />} aria-label={t('retry')} />
            }
          </Popconfirm>
        );
      }
      return null;
    }
  };

  // A phone keeps the ones that say what this is and what it is doing. The
  // rest are for reading afterwards, and are what would push the table past
  // the screen and put a scrollbar under it.
  const transcriptionColumns = isDesktop ? [
    videoColumn,
    stateColumn,
    languageColumn,
    {
      title: t('col_cost'),
      dataIndex: 'cost',
      key: 'cost',
      width: 90,
      render: (cost: number | null) => typeof cost === 'number' ? `$${cost.toFixed(4)}` : '—'
    },
    {
      title: t('col_took'),
      key: 'took',
      width: 80,
      render: (_: unknown, record: TranscriptionRecord) => formatDuration(record)
    },
    {
      title: t('col_requested'),
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

  const translationRecords = records.filter((record) => !!record.translation);

  const translationColumns = isDesktop ? [
    videoColumn,
    translationStateColumn,
    {
      title: t('col_requested'),
      key: 'translation-requested',
      width: 160,
      render: (_: unknown, record: TranscriptionRecord) =>
        formatTime(record.translation?.requestedAt ?? null)
    },
    translationActionsColumn
  ] : [
    videoColumn,
    translationStateColumn,
    translationActionsColumn
  ];

  /**
   * What there is to read for a video: the transcription's own captions, and
   * the Chinese translation once one has been made. Both are shown even while
   * something else about the record is still running, since a finished file
   * does not become unreadable because a retry was asked for.
   */
  const subtitleLanguagesColumn = {
    title: t('subtitles'),
    key: 'subtitle-languages',
    width: isDesktop ? 200 : 110,
    render: (_: unknown, record: TranscriptionRecord) => (
      <Space size={4} wrap>
        {
          record.subtitlePath ?
            <Tag color="blue">{(record.language || 'en').toUpperCase()}</Tag>
            : null
        }
        {
          record.translation?.subtitlePath ?
            <Tag color="green">中文</Tag>
            : null
        }
      </Space>
    )
  };

  const subtitleActionsColumn = {
    title: '',
    key: 'subtitle-actions',
    width: isDesktop ? 100 : 56,
    render: (_: unknown, record: TranscriptionRecord) => (
      isDesktop ?
        <Button size="small" onClick={() => setViewing(record)}>{t('read')}</Button>
        : <Button size="small" icon={<FileTextOutlined />} aria-label={t('read')} onClick={() => setViewing(record)} />
    )
  };

  // Only the videos that have a file to read. A record that failed, or is
  // still detecting speech, has nothing behind it yet.
  const subtitleRecords = records.filter((record) =>
    !!record.subtitlePath || !!record.translation?.subtitlePath
  );

  const subtitleColumns = [
    videoColumn,
    subtitleLanguagesColumn,
    subtitleActionsColumn
  ];

  const active = records.filter(isActive).length;
  const translatingCount = records.filter((record) => isTranslationActive(record.translation)).length;
  // Nothing that is still moving, on either queue, counts as finished - the
  // button offers to clear these, and the server keeps the rest.
  const finished = records.filter((record) =>
    !isActive(record) && !isTranslationActive(record.translation)
  ).length;

  const settingsButton = (
    <Button icon={<SettingOutlined />} onClick={() => setSettingsOpen(true)}>
      {t('nav_settings')}
    </Button>
  );

  const transcriptionActions = (
    <Space wrap>
      {settingsButton}
      {
        active > 0 ? (
          <Popconfirm
            title={t('stop_jobs_confirm', { count: active })}
            description={t('stop_jobs_desc')}
            okText={t('stop_all')}
            cancelText={t('never_mind')}
            okButtonProps={{ danger: true }}
            onConfirm={() => void run('', async () => { setRecords(await api.stopAllTranscriptions()); })}
          >
            <Button danger>{t('stop_all_count', { count: active })}</Button>
          </Popconfirm>
        ) : null
      }
      {
        finished > 0 ? (
          <Popconfirm
            title={t('clear_finished_records')}
            description={t('clear_finished_desc')}
            okText={t('clear')}
            cancelText={t('never_mind')}
            onConfirm={() => void run('', async () => { setRecords(await api.clearTranscriptionHistory()); })}
          >
            <Button>{t('clear_finished_count', { count: finished })}</Button>
          </Popconfirm>
        ) : null
      }
    </Space>
  );

  const translationActions = (
    <Space wrap>
      {settingsButton}
      {
        translatingCount > 0 ? (
          <Popconfirm
            title={t('stop_translations_confirm', { count: translatingCount })}
            description={t('stop_jobs_desc')}
            okText={t('stop_all')}
            cancelText={t('never_mind')}
            okButtonProps={{ danger: true }}
            onConfirm={() => void run('', async () => {
              await api.stopAllTranslations();
              await refresh();
            })}
          >
            <Button danger>{t('stop_all_count', { count: translatingCount })}</Button>
          </Popconfirm>
        ) : null
      }
    </Space>
  );

  const subtitlesPane = subtitleRecords.length === 0 ? (
    <Empty description={t('subtitles_history_empty')} />
  ) : (
    <Table
      rowKey="mediaId"
      size="small"
      columns={subtitleColumns}
      dataSource={subtitleRecords}
      pagination={{ pageSize: 20, hideOnSinglePage: true }}
      tableLayout="fixed"
      // The whole row opens the transcript, so the button is a signpost rather
      // than the only way in.
      onRow={(record) => ({
        onClick: () => setViewing(record),
        style: { cursor: 'pointer' }
      })}
    />
  );

  const transcriptionPane = records.length === 0 ? (
    <Empty description={t('transcription_history_empty')} />
  ) : (
    <Table
      rowKey="mediaId"
      size="small"
      columns={transcriptionColumns}
      dataSource={records}
      pagination={{ pageSize: 20, hideOnSinglePage: true }}
      // No horizontal scroll: the column set is trimmed to fit instead, which
      // is the point of dropping columns on a phone.
      tableLayout="fixed"
    />
  );

  const translationPane = translationRecords.length === 0 ? (
    <Empty description={t('translation_history_empty')} />
  ) : (
    <Table
      rowKey="mediaId"
      size="small"
      columns={translationColumns}
      dataSource={translationRecords}
      pagination={{ pageSize: 20, hideOnSinglePage: true }}
      tableLayout="fixed"
    />
  );

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

      <Tabs
        className="transcription-history__tabs"
        activeKey={tab}
        onChange={(key) => setTab(key as ListTab)}
        tabBarExtraContent={{
          right:
            tab === 'transcription' ? transcriptionActions :
              tab === 'translation' ? translationActions :
                settingsButton
        }}
        items={[
          {
            key: 'transcription',
            icon: <AudioOutlined />,
            label: <TabLabel text={t('nav_transcription')} count={records.length} />,
            children: transcriptionPane
          },
          {
            key: 'translation',
            icon: <TranslationOutlined />,
            label: <TabLabel text={t('history_tab_translation')} count={translationRecords.length} />,
            children: translationPane
          },
          {
            key: 'subtitles',
            icon: <FileTextOutlined />,
            label: <TabLabel text={t('subtitles')} count={subtitleRecords.length} />,
            children: subtitlesPane
          }
        ]}
      />

      <TranscriptionSettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        defaultTab={tab === 'translation' ? 'translation' : 'transcription'}
      />

      <SubtitleViewer
        open={!!viewing}
        mediaId={viewing?.mediaId ?? null}
        title={viewing?.videoName ?? ''}
        onClose={() => setViewing(null)}
      />
    </Space>
  );
}

export default TranscriptionHistory;
