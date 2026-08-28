import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, Descriptions, Form, Input, Popconfirm, Radio, Space, Tag } from "antd";
import { useAPI } from "../../contexts/APIProvider";
import { LoadingBlock } from "../Loading";
import {
  type ProviderSettings,
  type TranscriptionProvider,
  type TranscriptionSettings as Settings
} from "../../../types/Transcription";

interface FormValues {
  provider: TranscriptionProvider;
  apiKey: string;
  model: string;
  baseUrl: string;
  geminiApiKey: string;
  geminiModel: string;
  geminiBaseUrl: string;
  geminiProxyUrl: string;
  vocabulary: string;
}

function formatMoney(value: number | null | undefined) {
  return typeof value === 'number' ? `$${value.toFixed(4)}` : '—';
}

/**
 * Whether a provider is ready, and whatever it says about its key.
 *
 * The same block for both, because "which one can I switch to" is the question
 * this form exists to answer and it should not need reading two different
 * layouts to work out.
 */
function ProviderStatus(props: {
  provider: ProviderSettings;
  envVar: string;
  active: boolean;
}) {
  const { provider, envVar, active } = props;
  return (
    <>
      <Descriptions column={1} size="small">
        <Descriptions.Item label="Status">
          <Space size={4} wrap>
            {
              provider.configured ?
                <Tag color="green">Configured</Tag>
                : <Tag color="orange">No API key</Tag>
            }
            {provider.source === 'env' ? <Tag>From {envVar}</Tag> : null}
            {active ? <Tag color="blue">In use</Tag> : null}
          </Space>
        </Descriptions.Item>
        {
          provider.key ? (
            <>
              <Descriptions.Item label="Key">{provider.key.label || '—'}</Descriptions.Item>
              <Descriptions.Item label="Spent">{formatMoney(provider.key.usage)}</Descriptions.Item>
              <Descriptions.Item label="Remaining">
                {
                  provider.key.limit === null ?
                    'No limit set'
                    : formatMoney(provider.key.limitRemaining)
                }
              </Descriptions.Item>
            </>
          ) : null
        }
      </Descriptions>
      {
        provider.keyError ? (
          <Alert
            type="warning"
            showIcon
            title="A key is configured, but it could not be checked just now"
            description={provider.keyError}
          />
        ) : null
      }
    </>
  );
}

/**
 * Which service transcribes, the credentials for each, and the domain terms
 * one of them can be steered with.
 *
 * Both providers are configured here whichever is in use, because switching is
 * a deliberate act: nothing falls back on its own when a key runs out of
 * quota, so the way to keep going is to come here, change the provider and run
 * the job again. Holding both sets of credentials is what makes that a
 * dropdown rather than a hunt for a key.
 *
 * A key is write-only by design: it is sent when it is set and never comes
 * back. What the form shows instead is whatever the provider says about it -
 * a masked label and a balance from OpenRouter, and from Gemini only that it
 * was accepted.
 */
function TranscriptionSettingsPanel() {
  const { api } = useAPI();
  const [ settings, setSettings ] = useState<Settings | null>(null);
  const [ error, setError ] = useState<string | null>(null);
  const [ saved, setSaved ] = useState(false);
  const [ submitting, setSubmitting ] = useState(false);
  const [ form ] = Form.useForm<FormValues>();
  const provider = Form.useWatch('provider', form);

  const fill = useCallback((result: Settings) => {
    setSettings(result);
    form.setFieldsValue({
      provider: result.provider,
      apiKey: '',
      model: result.openrouter.model,
      baseUrl: result.openrouter.baseUrl,
      geminiApiKey: '',
      geminiModel: result.gemini.model,
      geminiBaseUrl: result.gemini.baseUrl,
      geminiProxyUrl: result.gemini.proxyUrl,
      vocabulary: result.vocabulary.text
    });
  }, [ form ]);

  const refresh = useCallback(async () => {
    try {
      fill(await api.getTranscriptionSettings());
    }
    catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load transcription settings');
    }
  }, [ api, fill ]);

  useEffect(() => { void refresh(); }, [ refresh ]);

  const handleSubmit = useCallback(async (values: FormValues) => {
    setSubmitting(true);
    setError(null);
    setSaved(false);
    try {
      const params: Parameters<typeof api.saveTranscriptionSettings>[0] = {
        provider: values.provider,
        model: values.model,
        baseUrl: values.baseUrl,
        geminiModel: values.geminiModel,
        geminiBaseUrl: values.geminiBaseUrl,
        // Sent even when blank: blank is "go direct", which has to be
        // distinguishable from "not mentioned".
        geminiProxyUrl: values.geminiProxyUrl ?? '',
        vocabulary: values.vocabulary ?? ''
      };
      // Left blank means "leave the stored key alone", not "clear it" -
      // clearing is its own button, so an edit to the model cannot wipe a key
      // by omission.
      if (values.apiKey?.trim()) {
        params.apiKey = values.apiKey.trim();
      }
      if (values.geminiApiKey?.trim()) {
        params.geminiApiKey = values.geminiApiKey.trim();
      }
      fill(await api.saveTranscriptionSettings(params));
      setSaved(true);
    }
    catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save transcription settings');
    }
    finally {
      setSubmitting(false);
    }
  }, [ api, fill ]);

  const handleClearKey = useCallback(async (which: TranscriptionProvider) => {
    setSubmitting(true);
    setError(null);
    setSaved(false);
    try {
      fill(await api.saveTranscriptionSettings(
        which === 'gemini' ? { geminiApiKey: '' } : { apiKey: '' }
      ));
    }
    catch (e) {
      setError(e instanceof Error ? e.message : 'Could not clear the API key');
    }
    finally {
      setSubmitting(false);
    }
  }, [ api, fill ]);

  if (!settings) {
    return error ? <Alert type="error" title={error} showIcon /> : <LoadingBlock />;
  }

  // What was picked in the form rather than what is saved, so the vocabulary
  // note answers the choice being made rather than the one before it.
  const chosen = provider || settings.provider;
  const vocabularyActive = chosen === 'gemini';

  return (
    <Space orientation="vertical" size="middle" style={{ display: 'flex' }}>
      {error ? <Alert type="error" title={error} showIcon closable={{ onClose: () => setError(null) }} /> : null}
      {saved ? <Alert type="success" title="Settings saved" showIcon closable={{ onClose: () => setSaved(false) }} /> : null}

      <Form form={form} layout="vertical" onFinish={(v) => void handleSubmit(v)} disabled={submitting}>
        <Space orientation="vertical" size="middle" style={{ display: 'flex' }}>
          <Card title="Provider">
            <Form.Item
              name="provider"
              label="Transcribe with"
              extra={
                'Nothing switches on its own. When the provider in use runs out of quota ' +
                'the job fails and says so - change it here and run the job again.'
              }
            >
              <Radio.Group>
                <Space orientation="vertical" size={4}>
                  <Radio value="openrouter">
                    OpenRouter — Whisper and other OpenAI-compatible models
                  </Radio>
                  <Radio value="gemini">
                    Gemini — accepts a custom vocabulary, and costs more per minute
                  </Radio>
                </Space>
              </Radio.Group>
            </Form.Item>
          </Card>

          <Card title="OpenRouter">
            <ProviderStatus
              provider={settings.openrouter}
              envVar="OPENROUTER_API_KEY"
              active={settings.provider === 'openrouter'}
            />
            <Form.Item
              name="apiKey"
              label="API key"
              extra={
                settings.openrouter.configured ?
                  settings.openrouter.source === 'env' ?
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
                placeholder={
                  settings.openrouter.configured ?
                    settings.openrouter.key?.label || 'Saved'
                    : 'Paste your OpenRouter key'
                }
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

            {
              settings.openrouter.source === 'file' ? (
                <Popconfirm
                  title="Clear the saved OpenRouter key?"
                  description="Transcription through OpenRouter will stop working unless a key is set in the environment."
                  onConfirm={() => void handleClearKey('openrouter')}
                >
                  <Button danger disabled={submitting}>Clear OpenRouter key</Button>
                </Popconfirm>
              ) : null
            }
          </Card>

          <Card title="Gemini">
            <ProviderStatus
              provider={settings.gemini}
              envVar="GEMINI_API_KEY"
              active={settings.provider === 'gemini'}
            />
            <Form.Item
              name="geminiApiKey"
              label="API key"
              extra={
                settings.gemini.configured ?
                  settings.gemini.source === 'env' ?
                    'A key is coming from the environment. Saving one here will take precedence over it.'
                    : 'A key is already saved. Leave this blank to keep it, or enter a new one to replace it.'
                  : 'Create one in Google AI Studio. It is checked against Gemini before being saved.'
              }
            >
              <Input.Password
                autoComplete="off"
                placeholder={settings.gemini.configured ? 'Saved' : 'Paste your Gemini key'}
              />
            </Form.Item>

            <Form.Item
              name="geminiModel"
              label="Model"
              extra="Word timestamps are required to build subtitles, which caps a request at 30 minutes of speech and rules out smart transcription."
            >
              <Input placeholder="gemini-3.5-transcribe" />
            </Form.Item>

            <Form.Item name="geminiBaseUrl" label="API base URL">
              <Input placeholder="https://generativelanguage.googleapis.com" />
            </Form.Item>

            <Form.Item
              name="geminiProxyUrl"
              label="Proxy"
              extra={
                'Gemini is not reachable everywhere, so a local proxy is assumed unless ' +
                'this is cleared. Clear it to connect directly. HTTP and SOCKS are both ' +
                'accepted, and the key check above goes through it too, so a key that ' +
                'verifies here is one that will work on a job.'
              }
            >
              <Input placeholder="http://127.0.0.1:17890" allowClear />
            </Form.Item>

            {
              settings.gemini.source === 'file' ? (
                <Popconfirm
                  title="Clear the saved Gemini key?"
                  description="Transcription through Gemini will stop working unless a key is set in the environment."
                  onConfirm={() => void handleClearKey('gemini')}
                >
                  <Button danger disabled={submitting}>Clear Gemini key</Button>
                </Popconfirm>
              ) : null
            }
          </Card>

          <Card title="Vocabulary">
            {
              !vocabularyActive ? (
                <Alert
                  type="info"
                  showIcon
                  title="Only Gemini uses this list"
                  description="It is kept either way, and takes effect when Gemini is the provider."
                />
              ) : null
            }
            {
              settings.vocabulary.warning ? (
                <Alert type="warning" showIcon title={settings.vocabulary.warning} />
              ) : null
            }
            <Form.Item
              name="vocabulary"
              label={`Domain terms (${settings.vocabulary.termCount} in use)`}
              extra={
                `One term or phrase per line; lines starting with # are comments. ` +
                `Only distinct jargon, brand names and proper nouns - everyday words ` +
                `pull the transcript towards themselves. The same file can be edited ` +
                `directly at ${settings.vocabulary.path}, and is re-read for each clip.`
              }
            >
              <Input.TextArea
                autoSize={{ minRows: 6, maxRows: 20 }}
                spellCheck={false}
                placeholder={'non-metallic metal\nzenithal priming\nCobalt Violet Grey'}
              />
            </Form.Item>
          </Card>

          <Button type="primary" htmlType="submit" loading={submitting}>
            Save
          </Button>
        </Space>
      </Form>
    </Space>
  );
}

export default TranscriptionSettingsPanel;
