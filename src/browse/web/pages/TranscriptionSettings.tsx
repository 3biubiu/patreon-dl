import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, Descriptions, Form, Input, Popconfirm, Space, Tag } from "antd";
import { useAPI } from "../contexts/APIProvider";
import { useDocument } from "../contexts/DocumentProvider";
import { LoadingBlock } from "../components/Loading";
import { type TranscriptionSettings as Settings } from "../../types/Transcription";

interface FormValues {
  apiKey: string;
  model: string;
  baseUrl: string;
}

function formatMoney(value: number | null | undefined) {
  return typeof value === 'number' ? `$${value.toFixed(4)}` : '—';
}

/**
 * Where the OpenRouter key is set. Administrators only - the route is hidden
 * from everyone else, and the server refuses these endpoints to them
 * regardless.
 *
 * The key is write-only by design: it is sent when it is set and never comes
 * back. What the form shows instead is the masked label OpenRouter reports for
 * it, which is enough to tell one key from another without the value ever
 * being in a page again.
 */
function TranscriptionSettings() {
  const { api } = useAPI();
  const { setTitle } = useDocument();
  const [ settings, setSettings ] = useState<Settings | null>(null);
  const [ error, setError ] = useState<string | null>(null);
  const [ saved, setSaved ] = useState(false);
  const [ submitting, setSubmitting ] = useState(false);
  const [ form ] = Form.useForm<FormValues>();

  useEffect(() => {
    setTitle('Transcription');
  }, [ setTitle ]);

  const refresh = useCallback(async () => {
    try {
      const result = await api.getTranscriptionSettings();
      setSettings(result);
      form.setFieldsValue({ apiKey: '', model: result.model, baseUrl: result.baseUrl });
    }
    catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load transcription settings');
    }
  }, [ api, form ]);

  useEffect(() => { void refresh(); }, [ refresh ]);

  const handleSubmit = useCallback(async (values: FormValues) => {
    setSubmitting(true);
    setError(null);
    setSaved(false);
    try {
      const params: { apiKey?: string; model?: string; baseUrl?: string } = {
        model: values.model,
        baseUrl: values.baseUrl
      };
      // Left blank means "leave the stored key alone", not "clear it" -
      // clearing is its own button, so an edit to the model cannot wipe the
      // key by omission.
      if (values.apiKey?.trim()) {
        params.apiKey = values.apiKey.trim();
      }
      const result = await api.saveTranscriptionSettings(params);
      setSettings(result);
      form.setFieldsValue({ apiKey: '' });
      setSaved(true);
    }
    catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save transcription settings');
    }
    finally {
      setSubmitting(false);
    }
  }, [ api, form ]);

  const handleClearKey = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    setSaved(false);
    try {
      setSettings(await api.saveTranscriptionSettings({ apiKey: '' }));
    }
    catch (e) {
      setError(e instanceof Error ? e.message : 'Could not clear the API key');
    }
    finally {
      setSubmitting(false);
    }
  }, [ api ]);

  if (!settings) {
    return error ? <Alert type="error" title={error} showIcon /> : <LoadingBlock />;
  }

  const fromEnvironment = settings.source === 'env';

  return (
    <Space orientation="vertical" size="middle" style={{ display: 'flex', maxWidth: '44rem' }}>
      <Card title="OpenRouter">
        <Descriptions column={1} size="small">
          <Descriptions.Item label="Status">
            {
              settings.configured ?
                <Tag color="green">Configured</Tag>
                : <Tag color="orange">No API key</Tag>
            }
            {
              fromEnvironment ?
                <Tag>From OPENROUTER_API_KEY</Tag>
                : null
            }
          </Descriptions.Item>
          {
            settings.key ? (
              <>
                <Descriptions.Item label="Key">{settings.key.label || '—'}</Descriptions.Item>
                <Descriptions.Item label="Spent">{formatMoney(settings.key.usage)}</Descriptions.Item>
                <Descriptions.Item label="Remaining">
                  {
                    settings.key.limit === null ?
                      'No limit set'
                      : formatMoney(settings.key.limitRemaining)
                  }
                </Descriptions.Item>
              </>
            ) : null
          }
        </Descriptions>
        {
          settings.keyError ? (
            <Alert
              type="warning"
              showIcon
              title="A key is configured, but it could not be checked just now"
              description={settings.keyError}
            />
          ) : null
        }
      </Card>

      {error ? <Alert type="error" title={error} showIcon closable={{ onClose: () => setError(null) }} /> : null}
      {saved ? <Alert type="success" title="Settings saved" showIcon closable={{ onClose: () => setSaved(false) }} /> : null}

      <Card title="Settings">
        <Form form={form} layout="vertical" onFinish={(v) => void handleSubmit(v)} disabled={submitting}>
          <Form.Item
            name="apiKey"
            label="API key"
            extra={
              settings.configured ?
                fromEnvironment ?
                  'A key is coming from the environment. Saving one here will take precedence over it.'
                  : 'A key is already saved. Leave this blank to keep it, or enter a new one to replace it.'
                : 'Create one at openrouter.ai. It is checked against OpenRouter before being saved.'
            }
          >
            <Input.Password
              autoComplete="off"
              // Deliberately not an example key: secret scanners match on the
              // prefix alone, and a placeholder that trips them turns every
              // commit of this file into a false alarm.
              placeholder={settings.configured ? settings.key?.label || 'Saved' : 'Paste your OpenRouter key'}
            />
          </Form.Item>

          <Form.Item
            name="model"
            label="Model"
            extra="Must be served by an OpenAI-compatible upstream - subtitles are built from segment timestamps, which OpenRouter only returns for those."
          >
            <Input placeholder="openai/whisper-large-v3-turbo" />
          </Form.Item>

          <Form.Item name="baseUrl" label="API base URL">
            <Input placeholder="https://openrouter.ai/api/v1" />
          </Form.Item>

          <Space>
            <Button type="primary" htmlType="submit" loading={submitting}>
              Save
            </Button>
            {
              settings.source === 'file' ? (
                <Popconfirm
                  title="Clear the saved API key?"
                  description="Transcription will stop working unless a key is set in the environment."
                  onConfirm={() => void handleClearKey()}
                >
                  <Button danger disabled={submitting}>Clear key</Button>
                </Popconfirm>
              ) : null
            }
          </Space>
        </Form>
      </Card>
    </Space>
  );
}

export default TranscriptionSettings;
