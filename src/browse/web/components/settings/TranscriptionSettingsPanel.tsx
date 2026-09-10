import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, Descriptions, Form, Input, InputNumber, Popconfirm, Radio, Space, Tag } from "antd";
import { useAPI } from "../../contexts/APIProvider";
import { LoadingBlock } from "../Loading";
import { useLanguage } from "../../contexts/LanguageProvider";
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
  /** Detector overrides. `null` is the built-in default, shown as a placeholder. */
  vadThreshold: number | null;
  vadMinSilenceDuration: number | null;
  vadSpeechPad: number | null;
  vadMergeGap: number | null;
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
  const { t } = useLanguage();
  return (
    <>
      <Descriptions column={1} size="small">
        <Descriptions.Item label={t('status')}>
          <Space size={4} wrap>
            {
              provider.configured ?
                <Tag color="green">{t('configured')}</Tag>
                : <Tag color="orange">{t('no_api_key')}</Tag>
            }
            {provider.source === 'env' ? <Tag>{t('from_env', { var: envVar })}</Tag> : null}
            {active ? <Tag color="blue">{t('in_use')}</Tag> : null}
          </Space>
        </Descriptions.Item>
        {
          provider.key ? (
            <>
              <Descriptions.Item label={t('api_key')}>{provider.key.label || '—'}</Descriptions.Item>
              <Descriptions.Item label={t('spent')}>{formatMoney(provider.key.usage)}</Descriptions.Item>
              <Descriptions.Item label={t('remaining')}>
                {
                  provider.key.limit === null ?
                    t('no_limit_set')
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
            title={t('key_check_failed_title')}
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
  const { t } = useLanguage();

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
      vocabulary: result.vocabulary.text,
      vadThreshold: result.vad.values.threshold,
      vadMinSilenceDuration: result.vad.values.minSilenceDuration,
      vadSpeechPad: result.vad.values.speechPad,
      vadMergeGap: result.vad.values.mergeGap
    });
  }, [ form ]);

  const refresh = useCallback(async () => {
    try {
      fill(await api.getTranscriptionSettings());
    }
    catch (e) {
      setError(e instanceof Error ? e.message : t('could_not_load_transcription_settings'));
    }
  }, [ api, fill, t ]);

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
        vocabulary: values.vocabulary ?? '',
        // Blank is "the default", which is worth saving rather than leaving
        // whatever was there.
        vad: {
          threshold: values.vadThreshold ?? null,
          minSilenceDuration: values.vadMinSilenceDuration ?? null,
          speechPad: values.vadSpeechPad ?? null,
          mergeGap: values.vadMergeGap ?? null
        }
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
      setError(e instanceof Error ? e.message : t('could_not_save_transcription_settings'));
    }
    finally {
      setSubmitting(false);
    }
  }, [ api, fill, t ]);

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
      setError(e instanceof Error ? e.message : t('could_not_clear_api_key'));
    }
    finally {
      setSubmitting(false);
    }
  }, [ api, fill, t ]);

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
      {saved ? <Alert type="success" title={t('settings_saved')} showIcon closable={{ onClose: () => setSaved(false) }} /> : null}

      <Form form={form} layout="vertical" onFinish={(v) => void handleSubmit(v)} disabled={submitting}>
        <Space orientation="vertical" size="middle" style={{ display: 'flex' }}>
          <Card title={t('provider')}>
            <Form.Item
              name="provider"
              label={t('transcribe_with')}
              extra={t('provider_switch_note')}
            >
              <Radio.Group>
                <Space orientation="vertical" size={4}>
                  <Radio value="openrouter">
                    {t('openrouter_option')}
                  </Radio>
                  <Radio value="gemini">
                    {t('gemini_option')}
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
              label={t('api_key')}
              extra={
                settings.openrouter.configured ?
                  settings.openrouter.source === 'env' ?
                    t('env_key_precedence')
                    : t('saved_key_blank_to_keep')
                  : t('openrouter_create_desc')
              }
            >
              <Input.Password
                autoComplete="off"
                // Deliberately not an example key: secret scanners match on the
                // prefix alone, and a placeholder that trips them turns every
                // commit of this file into a false alarm.
                placeholder={
                  settings.openrouter.configured ?
                    settings.openrouter.key?.label || t('saved_placeholder')
                    : t('paste_openrouter_key')
                }
              />
            </Form.Item>

            <Form.Item
              name="model"
              label={t('model')}
              extra={t('model_openrouter_extra')}
            >
              <Input placeholder="openai/whisper-large-v3-turbo" />
            </Form.Item>

            <Form.Item name="baseUrl" label={t('api_base_url')}>
              <Input placeholder="https://openrouter.ai/api/v1" />
            </Form.Item>

            {
              settings.openrouter.source === 'file' ? (
                <Popconfirm
                  title={t('clear_saved_openrouter_key_title')}
                  description={t('clear_openrouter_key_desc')}
                  onConfirm={() => void handleClearKey('openrouter')}
                >
                  <Button danger disabled={submitting}>{t('clear_openrouter_key')}</Button>
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
              label={t('api_key')}
              extra={
                settings.gemini.configured ?
                  settings.gemini.source === 'env' ?
                    t('env_key_precedence')
                    : t('saved_key_blank_to_keep')
                  : t('gemini_create_desc')
              }
            >
              <Input.Password
                autoComplete="off"
                placeholder={settings.gemini.configured ? t('saved_placeholder') : t('paste_gemini_key')}
              />
            </Form.Item>

            <Form.Item
              name="geminiModel"
              label={t('model')}
              extra={t('gemini_model_extra')}
            >
              <Input placeholder="gemini-3.5-transcribe" />
            </Form.Item>

            <Form.Item name="geminiBaseUrl" label={t('api_base_url')}>
              <Input placeholder="https://generativelanguage.googleapis.com" />
            </Form.Item>

            <Form.Item
              name="geminiProxyUrl"
              label={t('proxy')}
              extra={t('gemini_proxy_extra')}
            >
              <Input placeholder="http://127.0.0.1:17890" allowClear />
            </Form.Item>

            {
              settings.gemini.source === 'file' ? (
                <Popconfirm
                  title={t('clear_saved_gemini_key_title')}
                  description={t('clear_gemini_key_desc')}
                  onConfirm={() => void handleClearKey('gemini')}
                >
                  <Button danger disabled={submitting}>{t('clear_gemini_key')}</Button>
                </Popconfirm>
              ) : null
            }
          </Card>

          <Card title={t('vocabulary')}>
            {
              !vocabularyActive ? (
                <Alert
                  type="info"
                  showIcon
                  title={t('only_gemini_uses_this_title')}
                  description={t('only_gemini_uses_this_desc')}
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
              label={
                t('domain_terms_label', { count: settings.vocabulary.termCount }) +
                (settings.vocabulary.mappingCount > 0 ?
                  t('domain_terms_translated_suffix', { count: settings.vocabulary.mappingCount })
                  : '') +
                t('domain_terms_label_suffix')
              }
              extra={t('vocabulary_extra', { path: settings.vocabulary.path })}
            >
              <Input.TextArea
                autoSize={{ minRows: 6, maxRows: 20 }}
                spellCheck={false}
                placeholder={'non-metallic metal\nzenithal priming\nCobalt Violet Grey'}
              />
            </Form.Item>
          </Card>

          <Card
            title={t('voice_activity_detection')}
            extra={
              <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)' }}>
                {t('blank_means_default')}
              </span>
            }
          >
            <p style={{ marginTop: 0 }}>
              {t('vad_intro')}
            </p>
            <Form.Item
              name="vadThreshold"
              label={t('speech_threshold')}
              extra={t('speech_threshold_extra', { value: settings.vad.defaults.threshold })}
            >
              <InputNumber
                min={settings.vad.ranges.threshold.min}
                max={settings.vad.ranges.threshold.max}
                step={0.05}
                placeholder={String(settings.vad.defaults.threshold)}
                style={{ width: '12rem' }}
              />
            </Form.Item>
            <Form.Item
              name="vadMinSilenceDuration"
              label={t('min_silence_seconds')}
              extra={t('min_silence_extra', { value: settings.vad.defaults.minSilenceDuration })}
            >
              <InputNumber
                min={settings.vad.ranges.minSilenceDuration.min}
                max={settings.vad.ranges.minSilenceDuration.max}
                step={0.1}
                placeholder={String(settings.vad.defaults.minSilenceDuration)}
                style={{ width: '12rem' }}
              />
            </Form.Item>
            <Form.Item
              name="vadSpeechPad"
              label={t('padding_seconds')}
              extra={t('padding_extra', { value: settings.vad.defaults.speechPad })}
            >
              <InputNumber
                min={settings.vad.ranges.speechPad.min}
                max={settings.vad.ranges.speechPad.max}
                step={0.1}
                placeholder={String(settings.vad.defaults.speechPad)}
                style={{ width: '12rem' }}
              />
            </Form.Item>
            <Form.Item
              name="vadMergeGap"
              label={t('merge_silence_seconds')}
              extra={t('merge_silence_extra', { value: settings.vad.defaults.mergeGap })}
            >
              <InputNumber
                min={settings.vad.ranges.mergeGap.min}
                max={settings.vad.ranges.mergeGap.max}
                step={0.5}
                placeholder={String(settings.vad.defaults.mergeGap)}
                style={{ width: '12rem' }}
              />
            </Form.Item>
          </Card>

          <Button type="primary" htmlType="submit" loading={submitting}>
            {t('save')}
          </Button>
        </Space>
      </Form>
    </Space>
  );
}

export default TranscriptionSettingsPanel;
