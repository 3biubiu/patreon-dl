import "../assets/styles/Uploads.scss";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert, Button, Checkbox, Empty, Popconfirm, Progress, Space, Table, Tag, Tooltip
} from "antd";
import {
  DeleteOutlined,
  DownloadOutlined,
  InboxOutlined,
  ReloadOutlined
} from "@ant-design/icons";
import { useAPI } from "../contexts/APIProvider";
import { useAuth } from "../contexts/AuthProvider";
import { useDocument } from "../contexts/DocumentProvider";
import { LoadingBlock } from "../components/Loading";
import { useMediaQuery, DESKTOP_QUERY } from "../utils/useMediaQuery";
import useTranslationAvailability from "../utils/useTranslationAvailability";
import { readTranslatePreference, writeTranslatePreference } from "../utils/translatePreference";
import { canExtractAudio, extractAudio, readDuration } from "../utils/extractAudio";
import { formatFileSize } from "../utils/Misc";
import {
  isActive,
  type TranscriptionState,
  type TranscriptionStage
} from "../../types/Transcription";
import { isTranslationActive, type TranslationState } from "../../types/Translation";
import { type UploadJobView } from "../../types/Upload";

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
  segmenting: 'Splitting sentences',
  polishing: 'Repairing text',
  writing: 'Writing subtitles'
};

const TRANSLATION_STATE_LABEL: Record<TranslationState, string> = {
  pending: 'Translation queued',
  running: 'Translating',
  done: 'Chinese',
  error: 'Translation failed',
  cancelled: 'Translation cancelled'
};

/** What the file picker offers. Anything ffmpeg can read is really accepted. */
const ACCEPTED = 'video/*,audio/*,.mkv,.ts,.m2ts,.flv,.avi';

type Phase = 'idle' | 'reading' | 'converting' | 'uploading';

const PHASE_LABEL: Record<Exclude<Phase, 'idle'>, string> = {
  reading: 'Reading the file',
  converting: 'Extracting audio in your browser',
  uploading: 'Uploading the audio'
};

function formatSeconds(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds)) {
    return null;
  }
  const whole = Math.round(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  return hours > 0 ?
    `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`;
}

/**
 * Upload a video, get subtitles back.
 *
 * The video never leaves the machine it is on. ffmpeg runs here, in
 * WebAssembly, and strips it to the 16 kHz mono audio the transcription
 * actually reads - which is what gets uploaded, and is a few megabytes where
 * the video was a few gigabytes. Everything after that is the pipeline the
 * library's own videos already go through: the same queue, the same speech
 * detection, the same optional pass into Chinese.
 *
 * What comes back is a file to download rather than captions on a player,
 * because there is nothing here to play - the server was never given the
 * video, only its sound.
 */
function Uploads() {
  const { api } = useAPI();
  const { user } = useAuth();
  const { setTitle } = useDocument();
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const [ jobs, setJobs ] = useState<UploadJobView[] | null>(null);
  const [ error, setError ] = useState<string | null>(null);
  const [ notice, setNotice ] = useState<string | null>(null);
  const [ phase, setPhase ] = useState<Phase>('idle');
  const [ phaseFraction, setPhaseFraction ] = useState(0);
  const [ working, setWorking ] = useState<string | null>(null);
  const [ busyId, setBusyId ] = useState<string | null>(null);
  const [ anyActive, setAnyActive ] = useState(false);
  const [ translate, setTranslate ] = useState(readTranslatePreference);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const availability = useTranslationAvailability();
  const canTranslate = !!availability?.available;
  const isAdmin = user?.role === 'admin';

  useEffect(() => {
    setTitle('Upload');
  }, [ setTitle ]);

  const refresh = useCallback(async () => {
    try {
      const result = await api.listUploads();
      setJobs(result);
      setAnyActive(result.some(
        (job) => !!job.record && (isActive(job.record) || isTranslationActive(job.record.translation))
      ));
    }
    catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your uploads');
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

  // A conversion in flight holds an ffmpeg instance and a file handle; leaving
  // the page should not leave either running.
  useEffect(() => () => abortRef.current?.abort(), []);

  const submit = useCallback(async (file: File) => {
    if (!canExtractAudio()) {
      setError('This browser cannot convert video here - it has no WebAssembly support.');
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setNotice(null);
    setWorking(file.name);
    setPhase('reading');
    setPhaseFraction(0);
    try {
      const duration = await readDuration(file);
      if (controller.signal.aborted) {
        return;
      }
      setPhase('converting');
      const audio = await extractAudio(
        file,
        ({ fraction }) => setPhaseFraction(fraction),
        controller.signal
      );
      if (controller.signal.aborted) {
        return;
      }
      setPhase('uploading');
      setPhaseFraction(0);
      await api.uploadAudio(
        audio,
        { title: file.name, duration, translate: translate && canTranslate },
        (fraction) => setPhaseFraction(fraction),
        controller.signal
      );
      setNotice(
        `"${file.name}" is queued. Its audio came to ${formatFileSize(audio.size) || 'a few MB'} ` +
        `out of ${formatFileSize(file.size) || 'the original'}.`
      );
      await refresh();
    }
    catch (e) {
      if (!controller.signal.aborted) {
        setError(e instanceof Error ? e.message : 'That upload did not work');
      }
    }
    finally {
      abortRef.current = null;
      setPhase('idle');
      setWorking(null);
      setPhaseFraction(0);
    }
  }, [ api, translate, canTranslate, refresh ]);

  const remove = useCallback(async (job: UploadJobView) => {
    setBusyId(job.id);
    setError(null);
    try {
      await api.deleteUpload(job.id);
      await refresh();
    }
    catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work');
    }
    finally {
      setBusyId(null);
    }
  }, [ api, refresh ]);

  const busy = phase !== 'idle';

  const uploader = (
    <div className="uploads__panel">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED}
        className="uploads__input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Cleared so that picking the same file twice in a row still counts
          // as a change.
          e.target.value = '';
          if (file) {
            void submit(file);
          }
        }}
      />
      {
        busy ? (
          <div className="uploads__progress">
            <div className="uploads__progress-head">
              <span className="uploads__progress-title">{PHASE_LABEL[phase]}</span>
              <span className="uploads__progress-file">{working}</span>
            </div>
            <Progress
              percent={Math.round(phaseFraction * 100)}
              status="active"
              // The reading step has nothing to measure, so it shows no number
              // rather than a zero that looks stuck.
              format={phase === 'reading' ? () => '' : undefined}
            />
            <Button size="small" onClick={() => abortRef.current?.abort()}>
              Cancel
            </Button>
          </div>
        ) : (
          <button
            type="button"
            className="uploads__dropzone"
            onClick={() => inputRef.current?.click()}
          >
            <InboxOutlined className="uploads__dropzone-icon" />
            <span className="uploads__dropzone-title">Choose a video</span>
            <span className="uploads__dropzone-hint">
              The audio is extracted in your browser - only that is uploaded, not the video.
            </span>
          </button>
        )
      }
      <div className="uploads__options">
        <Tooltip
          title={
            canTranslate ? null :
              'Translation is not configured on this server, so only the original language is made.'
          }
        >
          <Checkbox
            checked={translate && canTranslate}
            disabled={!canTranslate || busy}
            onChange={(e) => {
              setTranslate(e.target.checked);
              writeTranslatePreference(e.target.checked);
            }}
          >
            Also translate into Chinese
          </Checkbox>
        </Tooltip>
      </div>
    </div>
  );

  if (!jobs) {
    return error ? <Alert type="error" title={error} showIcon /> : <LoadingBlock />;
  }

  const fileColumn = {
    title: 'Video',
    key: 'title',
    render: (_: unknown, job: UploadJobView) => (
      <div className="uploads__file">
        <span className="uploads__file-name">{job.title}</span>
        <span className="uploads__file-meta">
          {[
            formatSeconds(job.duration),
            `${formatFileSize(job.size) || ''} of audio`,
            // Whose it is only matters on the list that shows everybody's.
            isAdmin ? job.username : null
          ].filter(Boolean).join(' · ')}
        </span>
      </div>
    )
  };

  const stateColumn = {
    title: 'State',
    key: 'state',
    width: isDesktop ? 240 : 120,
    render: (_: unknown, job: UploadJobView) => {
      const record = job.record;
      if (!record) {
        return <Tag>Not queued</Tag>;
      }
      const translation = record.translation;
      return (
        <div className="uploads__state">
          <span>
            <Tag color={STATE_COLOR[record.state]} style={{ marginInlineEnd: 4 }}>
              {STATE_LABEL[record.state]}
            </Tag>
            {
              record.state === 'running' && record.stage ? (
                <span className="uploads__stage">{STAGE_LABEL[record.stage]}</span>
              ) : null
            }
          </span>
          {
            isActive(record) ? (
              <Progress percent={Math.round(record.percent)} size="small" status="active" />
            ) : null
          }
          {
            translation ? (
              <span className="uploads__translation">
                {TRANSLATION_STATE_LABEL[translation.state]}
                {
                  isTranslationActive(translation) ?
                    ` ${Math.round(translation.percent)}%`
                    : ''
                }
              </span>
            ) : null
          }
          {
            record.error ? (
              <Tooltip title={record.error}>
                <span className="uploads__error">{record.error}</span>
              </Tooltip>
            ) : null
          }
        </div>
      );
    }
  };

  const subtitleColumn = {
    title: 'Subtitles',
    key: 'subtitles',
    width: isDesktop ? 260 : 140,
    render: (_: unknown, job: UploadJobView) => {
      if (job.subtitles.length === 0) {
        return <span className="uploads__none">—</span>;
      }
      return (
        <Space size={4} wrap>
          {
            job.subtitles.map((subtitle) => (
              <Button
                key={subtitle.filename}
                size="small"
                icon={<DownloadOutlined />}
                href={api.uploadSubtitleURL(job.id, subtitle.filename)}
                // A plain link: the answer is an attachment, so the browser
                // saves it and leaves the page where it is.
                target="_self"
              >
                {subtitle.label}
              </Button>
            ))
          }
        </Space>
      );
    }
  };

  const actionsColumn = {
    title: '',
    key: 'actions',
    width: 60,
    render: (_: unknown, job: UploadJobView) => (
      <Popconfirm
        title="Delete this upload?"
        description="The audio and its subtitles are removed. This cannot be undone."
        okText="Delete"
        okButtonProps={{ danger: true }}
        onConfirm={() => { void remove(job); }}
      >
        <Button
          type="text"
          danger
          size="small"
          loading={busyId === job.id}
          icon={<DeleteOutlined />}
          aria-label={`Delete ${job.title}`}
        />
      </Popconfirm>
    )
  };

  return (
    <div className="uploads">
      <div className="uploads__head">
        <h1 className="uploads__title">Upload a video for subtitles</h1>
        <Button
          size="small"
          icon={<ReloadOutlined />}
          onClick={() => { void refresh(); }}
        >
          Refresh
        </Button>
      </div>
      {
        error ? (
          <Alert
            className="mb-3"
            type="error"
            title={error}
            showIcon
            closable={{ onClose: () => setError(null) }}
          />
        ) : null
      }
      {
        notice ? (
          <Alert
            className="mb-3"
            type="success"
            title={notice}
            showIcon
            closable={{ onClose: () => setNotice(null) }}
          />
        ) : null
      }
      {uploader}
      <Table<UploadJobView>
        className="uploads__table"
        rowKey="id"
        dataSource={jobs}
        pagination={false}
        size="middle"
        locale={{
          emptyText: <Empty description="Nothing uploaded yet" />
        }}
        columns={[ fileColumn, stateColumn, subtitleColumn, actionsColumn ]}
      />
    </div>
  );
}

export default Uploads;
