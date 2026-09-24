import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, Descriptions, Divider, Form, Input, InputNumber, Popconfirm, Radio, Space, Switch, Tag } from "antd";
import { useAPI } from "../../contexts/APIProvider";
import { LoadingBlock } from "../Loading";
import { useLanguage } from "../../contexts/LanguageProvider";
import { type TranslationSettings as Settings } from "../../../types/Translation";

interface FormValues {
  provider: Settings['provider'];
  apiKey: string;
  model: string;
  baseUrl: string;
  proxyUrl: string;
  batchCharacters: number;
  batchLines: number;
  disableThinking: boolean;
  segmentation: boolean;
  sourceSegmentation: boolean;
  polish: boolean;
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
  const provider = Form.useWatch('provider', form);
  const { t } = useLanguage();

  const apply = useCallback((result: Settings) => {
    setSettings(result);
    setPrompt(result.prompt);
    form.setFieldsValue({
      provider: result.provider,
      apiKey: '',
      model: result.model,
      baseUrl: result.baseUrl,
      proxyUrl: result.proxyUrl,
      batchCharacters: result.batchCharacters,
      batchLines: result.batchLines,
      disableThinking: result.disableThinking,
      segmentation: result.segmentation,
      sourceSegmentation: result.sourceSegmentation,
      polish: result.polish,
      maxLineCjk: result.maxLineCjk,
      maxLineLatin: result.maxLineLatin
    });
  }, [ form ]);

  const refresh = useCallback(async () => {
    try {
      apply(await api.getTranslationSettings());
    }
    catch (e) {
      setError(e instanceof Error ? e.message : t('could_not_load_translation_settings'));
    }
  }, [ api, apply, t ]);

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
      setError(e instanceof Error ? e.message : t('could_not_save_translation_settings'));
    }
    finally {
      setSubmitting(false);
    }
  }, [ api, apply, t ]);

  const handleSubmit = useCallback(async (values: FormValues) => {
    const params: Parameters<typeof api.saveTranslationSettings>[0] = {
      provider: values.provider,
      model: values.model,
      baseUrl: values.baseUrl,
      proxyUrl: values.proxyUrl ?? '',
      batchCharacters: values.batchCharacters,
      batchLines: values.batchLines,
      disableThinking: values.disableThinking,
      segmentation: values.segmentation,
      sourceSegmentation: values.sourceSegmentation,
      polish: values.polish,
      maxLineCjk: values.maxLineCjk,
      maxLineLatin: values.maxLineLatin
    };
    // Left blank means "leave the stored key alone", not "clear it" - clearing
    // is its own button, so an edit to the model cannot wipe the key by
    // omission.
    if (values.apiKey?.trim()) {
      params.apiKey = values.apiKey.trim();
    }
    await save(params, t('settings_saved'));
  }, [ save, t ]);

  /**
   * Swaps the model and base URL for the new provider's defaults, unless they
   * were changed from the old provider's - a Gemini URL is never what an
   * OpenAI-compatible server wants, but a URL someone typed might be.
   */
  const handleProviderChange = (next: Settings['provider']) => {
    if (!settings) {
      return;
    }
    const previous = next === 'openai' ? 'gemini' : 'openai';
    const { model, baseUrl } = form.getFieldsValue([ 'model', 'baseUrl' ]);
    const defaults = settings.providerDefaults;
    if (!model || model === defaults[previous].model) {
      form.setFieldValue('model', defaults[next].model);
    }
    if (!baseUrl || baseUrl.replace(/\/+$/, '') === defaults[previous].baseUrl) {
      form.setFieldValue('baseUrl', defaults[next].baseUrl);
    }
  };

  if (!settings) {
    return error ? <Alert type="error" title={error} showIcon /> : <LoadingBlock />;
  }

  const currentProvider = provider ?? settings.provider;
  const switchingProvider = currentProvider !== settings.provider;
  const isOpenAI = currentProvider === 'openai';

  const fromEnvironment = settings.source === 'env';
  const estimate = callsPerHour(
    batchCharacters ?? settings.batchCharacters,
    batchLines ?? settings.batchLines
  );

  return (
    <Space orientation="vertical" size="middle" style={{ display: 'flex' }}>
      <Card title={t(settings.provider === 'openai' ? 'provider_openai' : 'provider_gemini')}>
        <Descriptions column={1} size="small">
          <Descriptions.Item label={t('status')}>
            {
              settings.configured ?
                <Tag color="green">{t('configured')}</Tag>
                : <Tag color="orange">{t('no_api_key')}</Tag>
            }
            {fromEnvironment ? <Tag>{t(settings.provider === 'openai' ? 'from_openai_env' : 'from_gemini_env')}</Tag> : null}
          </Descriptions.Item>
          <Descriptions.Item label={t('proxy')}>
            {settings.proxyUrl || t('none_connecting_straight_out')}
          </Descriptions.Item>
          {
            settings.key ? (
              <>
                <Descriptions.Item label={t('models_visible')}>{settings.key.modelCount}</Descriptions.Item>
                <Descriptions.Item label={settings.model}>
                  {
                    settings.key.modelFound ?
                      <Tag color="green">{t('available_to_key')}</Tag>
                      : <Tag color="orange">{t('not_in_list')}</Tag>
                  }
                </Descriptions.Item>
              </>
            ) : null
          }
          <Descriptions.Item label={t('calls_spent')}>
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
              {t('reset')}
            </Button>
          </Descriptions.Item>
        </Descriptions>
        {
          settings.keyError ? (
            <Alert
              type="warning"
              showIcon
              title={t('key_check_failed_title')}
              description={settings.keyError}
            />
          ) : null
        }
      </Card>

      {error ? <Alert type="error" title={error} showIcon closable={{ onClose: () => setError(null) }} /> : null}
      {saved ? <Alert type="success" title={saved} showIcon closable={{ onClose: () => setSaved(null) }} /> : null}

      <Card title={t('settings_panel')}>
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => void handleSubmit(v)}
          disabled={submitting}
        >
          <Form.Item
            name="provider"
            label={t('api_provider')}
            extra={t('api_provider_extra')}
          >
            <Radio.Group
              optionType="button"
              onChange={(e) => handleProviderChange(e.target.value)}
              options={[
                { value: 'gemini', label: t('provider_gemini') },
                { value: 'openai', label: t('provider_openai') }
              ]}
            />
          </Form.Item>

          <Form.Item
            name="apiKey"
            label={t('api_key')}
            extra={
              settings.configured && !switchingProvider ?
                fromEnvironment ?
                  t('env_key_precedence')
                  : t('saved_key_blank_to_keep')
                : t(isOpenAI ? 'openai_create_desc' : 'gemini_create_desc')
            }
          >
            <Input.Password
              autoComplete="off"
              placeholder={
                settings.configured && !switchingProvider ?
                  t('saved_placeholder')
                  : t(isOpenAI ? 'paste_openai_key' : 'paste_gemini_key')
              }
            />
          </Form.Item>

          <Form.Item
            name="model"
            label={t('model')}
            extra={t('model_extra_any')}
          >
            <Input placeholder={settings.providerDefaults[currentProvider].model} />
          </Form.Item>

          <Form.Item
            name="baseUrl"
            label={t('api_base_url')}
            extra={isOpenAI ? t('openai_base_url_extra') : undefined}
          >
            <Input placeholder={settings.providerDefaults[currentProvider].baseUrl} />
          </Form.Item>

          <Form.Item
            name="proxyUrl"
            label={t('proxy')}
            extra={t('proxy_extra', { proxy: settings.defaultProxyUrl })}
          >
            <Input placeholder={settings.defaultProxyUrl} allowClear />
          </Form.Item>

          <Form.Item
            name="batchCharacters"
            label={t('characters_per_call')}
            extra={t('characters_per_call_extra')}
          >
            <InputNumber min={500} max={40000} step={500} style={{ width: '12rem' }} />
          </Form.Item>

          <Form.Item
            name="batchLines"
            label={t('captions_per_call')}
            extra={t('captions_per_call_extra')}
          >
            <InputNumber min={10} max={1000} step={10} style={{ width: '12rem' }} />
          </Form.Item>

          <Alert
            type="info"
            showIcon
            title={t('calls_estimate_title', { count: estimate })}
            description={t('calls_estimate_desc')}
            style={{ marginBlockEnd: 24 }}
          />

          <Form.Item
            name="disableThinking"
            label={t('disable_thinking')}
            valuePropName="checked"
            extra={isOpenAI ? t('disable_thinking_gemini_only') : t('disable_thinking_extra')}
          >
            <Switch />
          </Form.Item>

          <Divider size="small" />

          <Form.Item
            name="sourceSegmentation"
            label={t('split_source_sentences')}
            valuePropName="checked"
            extra={t('split_source_extra')}
          >
            <Switch />
          </Form.Item>

          <Form.Item
            name="polish"
            label={t('repair_source_text')}
            valuePropName="checked"
            extra={t('repair_source_extra')}
          >
            <Switch />
          </Form.Item>

          <Divider size="small" />

          <Form.Item
            name="segmentation"
            label={t('recut_chinese_lines')}
            valuePropName="checked"
            extra={t('recut_chinese_extra')}
          >
            <Switch />
          </Form.Item>

          <Form.Item
            name="maxLineCjk"
            label={t('longest_chinese_line')}
            extra={t('longest_chinese_line_extra')}
          >
            <InputNumber min={8} max={40} style={{ width: '12rem' }} />
          </Form.Item>

          <Form.Item
            name="maxLineLatin"
            label={t('longest_spaced_line')}
            extra={t('longest_spaced_line_extra')}
          >
            <InputNumber min={5} max={30} style={{ width: '12rem' }} />
          </Form.Item>

          <Space>
            <Button type="primary" htmlType="submit" loading={submitting}>
              {t('save')}
            </Button>
            {
              settings.source === 'file' ? (
                <Popconfirm
                  title={t('clear_api_key_title')}
                  description={t('clear_api_key_desc')}
                  onConfirm={() => void save({ apiKey: '' }, t('api_key_cleared'))}
                >
                  <Button danger disabled={submitting}>{t('clear_key')}</Button>
                </Popconfirm>
              ) : null
            }
          </Space>
        </Form>
      </Card>

      <Card
        title={t('prompt')}
        extra={
          <Button
            size="small"
            disabled={submitting || prompt === settings.defaultPrompt}
            onClick={() => setPrompt(settings.defaultPrompt)}
          >
            {t('reset_to_default')}
          </Button>
        }
      >
        <p>
          {t('prompt_intro')}
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
            onClick={() => void save({ prompt }, t('prompt_saved'))}
          >
            {t('save_prompt')}
          </Button>
        </Space>
      </Card>
    </Space>
  );
}

export default TranslationSettingsPanel;
