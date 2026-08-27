import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Empty, Popconfirm, Progress, Space, Table, Tag, Tooltip } from "antd";
import { Link } from "react-router";
import { useAPI } from "../contexts/APIProvider";
import { useDocument } from "../contexts/DocumentProvider";
import { LoadingBlock } from "../components/Loading";
import {
  isActive,
  type TranscriptionRecord,
  type TranscriptionStage,
  type TranscriptionState
} from "../../types/Transcription";

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
 * Every transcription that has been asked for and what became of it.
 *
 * The server writes each step to its index as it happens, so this is a plain
 * read of that file rather than anything this page has to keep in sync. It
 * polls only while something is still moving.
 */
function TranscriptionHistory() {
  const { api } = useAPI();
  const { setTitle } = useDocument();
  const [ records, setRecords ] = useState<TranscriptionRecord[] | null>(null);
  const [ error, setError ] = useState<string | null>(null);
  const [ busyId, setBusyId ] = useState<string | null>(null);
  // Read inside the polling effect, which must not restart on every tick.
  const anyActiveRef = useRef(false);
  const [ anyActive, setAnyActive ] = useState(false);

  useEffect(() => {
    setTitle('Transcription');
  }, [ setTitle ]);

  const refresh = useCallback(async () => {
    try {
      const result = await api.listTranscriptions();
      setRecords(result);
      const active = result.some(isActive);
      anyActiveRef.current = active;
      setAnyActive(active);
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

  const columns = [
    {
      title: 'Video',
      dataIndex: 'videoName',
      key: 'videoName',
      render: (_: unknown, record: TranscriptionRecord) => (
        <Tooltip title={record.videoPath}>
          <span>{record.videoName}</span>
        </Tooltip>
      )
    },
    {
      title: 'State',
      key: 'state',
      width: 220,
      render: (_: unknown, record: TranscriptionRecord) => (
        <Space orientation="vertical" size={4} style={{ display: 'flex' }}>
          <Space size={6}>
            <Tag color={STATE_COLOR[record.state]}>{STATE_LABEL[record.state]}</Tag>
            {
              record.state === 'running' && record.stage ?
                <span style={{ fontSize: '0.8em', opacity: 0.7 }}>{STAGE_LABEL[record.stage]}</span>
                : null
            }
          </Space>
          {
            record.state === 'running' ?
              <Progress percent={record.percent} size="small" />
              : null
          }
          {
            record.state === 'error' && record.error ?
              <span style={{ fontSize: '0.8em', color: 'var(--bs-danger)' }}>{record.error}</span>
              : null
          }
        </Space>
      )
    },
    {
      title: 'Language',
      dataIndex: 'language',
      key: 'language',
      width: 100,
      render: (language: string | null) => language || '—'
    },
    {
      title: 'Cost',
      dataIndex: 'cost',
      key: 'cost',
      width: 100,
      render: (cost: number | null) => typeof cost === 'number' ? `$${cost.toFixed(4)}` : '—'
    },
    {
      title: 'Took',
      key: 'took',
      width: 90,
      render: (_: unknown, record: TranscriptionRecord) => formatDuration(record)
    },
    {
      title: 'Requested',
      dataIndex: 'requestedAt',
      key: 'requestedAt',
      width: 180,
      render: (value: string) => formatTime(value)
    },
    {
      title: '',
      key: 'actions',
      width: 170,
      render: (_: unknown, record: TranscriptionRecord) => {
        const busy = busyId === record.mediaId;
        if (isActive(record)) {
          return (
            <Popconfirm
              title="Cancel this transcription?"
              description="Progress so far is discarded."
              okText="Cancel it"
              cancelText="Never mind"
              okButtonProps={{ danger: true }}
              onConfirm={() => void run(record.mediaId, () => api.cancelTranscription(record.mediaId))}
            >
              <Button size="small" danger loading={busy}>Cancel</Button>
            </Popconfirm>
          );
        }
        return (
          <Space size={6}>
            <Popconfirm
              title="Transcribe again?"
              description={
                record.state === 'done' ?
                  'The existing subtitle file is replaced.'
                  : 'It runs in the background and costs roughly $0.01 per hour of video.'
              }
              okText="Transcribe"
              cancelText="Never mind"
              onConfirm={() => void run(record.mediaId, () => api.startTranscription(record.mediaId))}
            >
              <Button size="small" loading={busy}>Retry</Button>
            </Popconfirm>
            <Popconfirm
              title="Forget this record?"
              description="The subtitle file it produced stays on disk."
              okText="Forget"
              cancelText="Never mind"
              onConfirm={() => void run(record.mediaId, () => api.forgetTranscription(record.mediaId))}
            >
              <Button size="small" type="text" loading={busy}>Forget</Button>
            </Popconfirm>
          </Space>
        );
      }
    }
  ];

  const active = records.filter(isActive).length;
  const finished = records.length - active;

  return (
    <Space orientation="vertical" size="middle" style={{ display: 'flex' }}>
      {
        error ?
          <Alert type="error" title={error} showIcon closable={{ onClose: () => setError(null) }} />
          : null
      }

      <Space style={{ justifyContent: 'space-between', width: '100%' }}>
        <Link to="/transcription/settings">
          <Button>Settings</Button>
        </Link>
        {
          active > 0 ? (
            <Popconfirm
              title={`Stop ${active} transcription${active > 1 ? 's' : ''}?`}
              description="The running one is aborted and the rest are taken off the queue. Progress so far is discarded."
              okText="Stop all"
              cancelText="Never mind"
              okButtonProps={{ danger: true }}
              onConfirm={() => void run('', async () => { setRecords(await api.stopAllTranscriptions()); })}
            >
              <Button danger>Stop all ({active})</Button>
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
              scroll={{ x: 'max-content' }}
            />
          )
      }
    </Space>
  );
}

export default TranscriptionHistory;
