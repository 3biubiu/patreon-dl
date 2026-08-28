import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, Descriptions, Divider, Form, Input, InputNumber, Popconfirm, Space, Switch, Tag } from "antd";
import { useAPI } from "../../contexts/APIProvider";
import { LoadingBlock } from "../Loading";
import { type TranslationSettings as Settings } from "../../../types/Translation";

interface FormValues {
  apiKey: string;
  model: string;
  baseUrl: string;
  proxyUrl: string;
  batchCharacters: number;
  batchLines: number;
  disableThinking: boolean;
  segmentation: boolean;
  maxLineCjk: number;
  maxLineLatin: number;
}

/**
 * An hour of speech, roughly: about nine thousand words, and about seven
 * hundred captions once it has been cut into subtitle lines.
 *
 * Only used to turn the batch settings into a number of calls a reader can
 * judge. It is an order of magnitude, not a quote.
 */
const CHARACTERS_PER_HOUR = 45000;
const LINES_PER_HOUR = 700;

function callsPerHour(batchCharacters: number, batchLines: number) {
  return Math.max(
    Math.ceil(CHARACTERS_PER_HOUR / Math.max(batchCharacters, 1)),
    Math.ceil(LINES_PER_HOUR / Math.max(batchLines, 1))
  );
}

/**
 * The Gemini key, the batch size and the translation prompt. Lifted out of what
 * used to be its own page so it can sit in a tab of the settings drawer beside
 * the transcription one - the behaviour is unchanged from that page.
 *
 * The key is write-only by design, as the transcription key is: it is sent
 * when it is set and never comes back. What returns is whether one is
 * configured and what Gemini said when it was checked.
 */
function TranslationSettingsPanel() {
  const { api } = useAPI();
  const [ settings, setSettings ] = useState<Settings | null>(null);
  const [ prompt, setPrompt ] = useState('');
  const [ error, setError ] = useState<string | null>(null);
  const [ saved, setSaved ] = useState<string | null>(null);
  const [ submitting, setSubmitting ] = useState(false);
  const [ form ] = Form.useForm<FormValues>();
  const batchCharacters = Form.useWatch('batchCharacters', form);
  const batchLines = Form.useWatch('batchLines', form);

  const apply = useCallback((result: Settings) => {
    setSettings(result);
    setPrompt(result.prompt);
    form.setFieldsValue({
      apiKey: '',
      model: result.model,
      baseUrl: result.baseUrl,
      proxyUrl: result.proxyUrl,
      batchCharacters: result.batchCharacters,
      batchLines: result.batchLines,
      disableThinking: result.disableThinking,
      segmentation: result.segmentation,
      maxLineCjk: result.maxLineCjk,
      maxLineLatin: result.maxLineLatin
    });
  }, [ form ]);

  const refresh = useCallback(async () => {
    try {
      apply(await api.getTranslationSettings());
    }
    catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the translation settings');
    }
  }, [ api, apply ]);

  useEffect(() => { void refresh(); }, [ refresh ]);

  /** Every write goes through here, so the outcome is reported in one way. */
  const save = useCallback(async (
    params: Parameters<typeof api.saveTranslationSettings>[0],
    message: string
  ) => {
    setSubmitting(true);
    setError(null);
    setSaved(null);
    try {
      apply(await api.saveTranslationSettings(params));
      setSaved(message);
    }
    catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the translation settings');
    }
    finally {
      setSubmitting(false);
    }
  }, [ api, apply ]);

  const handleSubmit = useCallback(async (values: FormValues) => {
    const params: Parameters<typeof api.saveTranslationSettings>[0] = {
      model: values.model,
      baseUrl: values.baseUrl,
      proxyUrl: values.proxyUrl ?? '',
      batchCharacters: values.batchCharacters,
      batchLines: values.batchLines,
      disableThinking: values.disableThinking,
      segmentation: values.segmentation,
      maxLineCjk: values.maxLineCjk,
      maxLineLatin: values.maxLineLatin
    };
    // Left blank means "leave the stored key alone", not "clear it" - clearing
    // is its own button, so an edit to the model cannot wipe the key by
    // omission.
    if (values.apiKey?.trim()) {
      params.apiKey = values.apiKey.trim();
    }
    await save(params, 'Settings saved');
  }, [ save ]);

  if (!settings) {
    return error ? <Alert type="error" title={error} showIcon /> : <LoadingBlock />;
  }

  const fromEnvironment = settings.source === 'env';
  const estimate = callsPerHour(
    batchCharacters ?? settings.batchCharacters,
    batchLines ?? settings.batchLines
  );

  return (
    <Space orientation="vertical" size="middle" style={{ display: 'flex' }}>
      <Card title="Gemini">
        <Descriptions column={1} size="small">
          <Descriptions.Item label="Status">
            {
              settings.configured ?
                <Tag color="green">Configured</Tag>
                : <Tag color="orange">No API key</Tag>
            }
            {fromEnvironment ? <Tag>From GEMINI_API_KEY</Tag> : null}
          </Descriptions.Item>
          <Descriptions.Item label="Proxy">
            {settings.proxyUrl || 'None - connecting straight out'}
          </Descriptions.Item>
          {
            settings.key ? (
              <>
                <Descriptions.Item label="Models visible">{settings.key.modelCount}</Descriptions.Item>
                <Descriptions.Item label={settings.model}>
                  {
                    settings.key.modelFound ?
                      <Tag color="green">Available to this key</Tag>
                      : <Tag color="orange">Not in the list this key can see</Tag>
                  }
                </Descriptions.Item>
              </>
            ) : null
          }
          <Descriptions.Item label="Calls spent">
            {settings.totalRequests}
            <Button
              size="small"
              type="link"
              disabled={submitting || settings.totalRequests === 0}
              onClick={() => void (async () => {
                setSubmitting(true);
                try {
                  apply(await api.resetTranslationRequestCount());
                }
                finally {
                  setSubmitting(false);
                }
              })()}
            >
              Reset
            </Button>
          </Descriptions.Item>
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
      {saved ? <Alert type="success" title={saved} showIcon closable={{ onClose: () => setSaved(null) }} /> : null}

      <Card title="Settings">
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => void handleSubmit(v)}
          disabled={submitting}
        >
          <Form.Item
            name="apiKey"
            label="API key"
            extra={
              settings.configured ?
                fromEnvironment ?
                  'A key is coming from the environment. Saving one here will take precedence over it.'
                  : 'A key is already saved. Leave this blank to keep it, or enter a new one to replace it.'
                : 'Create one in Google AI Studio. It is checked against Gemini before being saved.'
            }
          >
            <Input.Password autoComplete="off" placeholder={settings.configured ? 'Saved' : 'Paste your Gemini key'} />
          </Form.Item>

          <Form.Item
            name="model"
            label="Model"
            extra="Any model your key can use. The status above says whether this one is among them."
          >
            <Input placeholder="gemini-3.5-flash-lite" />
          </Form.Item>

          <Form.Item name="baseUrl" label="API base URL">
            <Input placeholder="https://generativelanguage.googleapis.com/v1beta" />
          </Form.Item>

          <Form.Item
            name="proxyUrl"
            label="Proxy"
            extra={
              `Every Gemini request goes through this, key checks included. HTTP, HTTPS ` +
              `and SOCKS are all understood. Defaults to ${settings.defaultProxyUrl}; ` +
              `clear it to connect straight out.`
            }
          >
            <Input placeholder={settings.defaultProxyUrl} allowClear />
          </Form.Item>

          <Form.Item
            name="batchCharacters"
            label="Characters per call"
            extra="How much of the transcript goes into one call. Gemini AI Studio bills by the call, so this is the main lever on what a video costs - raise it to spend fewer, lower it if large batches come back truncated."
          >
            <InputNumber min={500} max={40000} step={500} style={{ width: '12rem' }} />
          </Form.Item>

          <Form.Item
            name="batchLines"
            label="Captions per call"
            extra="A ceiling for files of very short captions, where the character budget alone would put a thousand of them in one call."
          >
            <InputNumber min={10} max={1000} step={10} style={{ width: '12rem' }} />
          </Form.Item>

          <Alert
            type="info"
            showIcon
            title={`About ${estimate} call${estimate === 1 ? '' : 's'} per hour of video`}
            description="For an hour of ordinary speech, before any retry. Batches already translated are read from a cache and cost nothing, so a job that failed part way through and is retried only pays for the part that never finished."
            style={{ marginBlockEnd: 24 }}
          />

          <Form.Item
            name="disableThinking"
            label="Disable thinking"
            valuePropName="checked"
            extra="Sends a zero thinking budget with each call. Faster and cheaper on models that support it, but a model that does not know the setting rejects the request outright - leave it off unless you know this model takes it."
          >
            <Switch />
          </Form.Item>

          <Divider size="small" />

          <Form.Item
            name="segmentation"
            label="Re-cut the Chinese lines"
            valuePropName="checked"
            extra={
              'A translation comes back one line per original caption, and an English caption ' +
              'of a dozen words is a good deal more than a dozen Chinese characters. This puts ' +
              'the translated text back into a stream and breaks it where a Chinese caption ' +
              'should break - at full stops, commas and the pauses the speaker made, with the ' +
              'lengths below used only to choose between them. It runs on text already in ' +
              'hand and costs no calls. The subtitle the transcription wrote is never touched.'
            }
          >
            <Switch />
          </Form.Item>

          <Form.Item
            name="maxLineCjk"
            label="Longest Chinese line (characters)"
            extra="Characters. A soft limit: a full stop still ends a line early, and a line still runs past a comma to reach a better break."
          >
            <InputNumber min={8} max={40} style={{ width: '12rem' }} />
          </Form.Item>

          <Form.Item
            name="maxLineLatin"
            label="Longest line in a spaced language (words)"
            extra="Words. Used for a line that came back untranslated and kept its original, which is the one way English reaches this file."
          >
            <InputNumber min={5} max={30} style={{ width: '12rem' }} />
          </Form.Item>

          <Space>
            <Button type="primary" htmlType="submit" loading={submitting}>
              Save
            </Button>
            {
              settings.source === 'file' ? (
                <Popconfirm
                  title="Clear the saved API key?"
                  description="Translation will stop working unless a key is set in the environment."
                  onConfirm={() => void save({ apiKey: '' }, 'API key cleared')}
                >
                  <Button danger disabled={submitting}>Clear key</Button>
                </Popconfirm>
              ) : null
            }
          </Space>
        </Form>
      </Card>

      <Card
        title="Prompt"
        extra={
          <Button
            size="small"
            disabled={submitting || prompt === settings.defaultPrompt}
            onClick={() => setPrompt(settings.defaultPrompt)}
          >
            Reset to default
          </Button>
        }
      >
        <p>
          Your half of the prompt: tone, terminology, and what to leave in the original.
          The rest of it - one translation per caption, no merging, no splitting, JSON out -
          is fixed, because the timings belong to the original captions and a prompt that
          let the model regroup them would silently put the subtitles out of sync.
        </p>
        <Input.TextArea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={8}
          disabled={submitting}
        />
        <Space style={{ marginBlockStart: 16 }}>
          <Button
            type="primary"
            loading={submitting}
            disabled={prompt === settings.prompt}
            onClick={() => void save({ prompt }, 'Prompt saved')}
          >
            Save prompt
          </Button>
          <Popconfirm
            title="Clear the translation cache?"
            description="Batches already translated are re-translated, and paid for, the next time they come up. Worth doing after a change here if you want existing work redone."
            onConfirm={() => void (async () => {
              setSubmitting(true);
              setSaved(null);
              try {
                const removed = await api.clearTranslationCache();
                setSaved(`Cleared ${removed} cached batch${removed === 1 ? '' : 'es'}`);
              }
              catch (e) {
                setError(e instanceof Error ? e.message : 'Could not clear the cache');
              }
              finally {
                setSubmitting(false);
              }
            })()}
          >
            <Button disabled={submitting}>Clear cache</Button>
          </Popconfirm>
        </Space>
      </Card>
    </Space>
  );
}

export default TranslationSettingsPanel;
