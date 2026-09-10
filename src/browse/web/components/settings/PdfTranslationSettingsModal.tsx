import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Form, Input, Modal, Radio, Space, Tag } from "antd";
import { useAPI } from "../../contexts/APIProvider";
import { useLanguage } from "../../contexts/LanguageProvider";
import { LoadingBlock } from "../Loading";
import {
  type PdfTranslationEngine,
  type PdfTranslationSettings as Settings
} from "../../../types/PdfTranslation";

interface FormValues {
  engine: PdfTranslationEngine;
  deepLApiKey: string;
  baiduAppId: string;
  baiduSecretKey: string;
  targetLanguage: string;
  proxyUrl: string;
}

interface PdfTranslationSettingsModalProps {
  open: boolean;
  onClose: () => void;
  /** So the reader can retranslate the page it is on once the engine changes. */
  onSaved?: (settings: Settings) => void;
}

/**
 * Which engine the PDF reader translates with, and what it needs.
 *
 * Its own dialog rather than a tab in the transcription drawer: that drawer is
 * about videos, and these settings belong beside the thing they affect. It is
 * opened from the reader's own toolbar, and only an administrator sees the
 * button - the routes behind it are what actually refuse everyone else.
 *
 * The DeepL key is write-only, as the Gemini one is: it is sent when it is set
 * and never comes back. What returns is whether one is configured.
 */
function PdfTranslationSettingsModal(props: PdfTranslationSettingsModalProps) {
  const { open, onClose, onSaved } = props;
  const { api } = useAPI();
  const { t } = useLanguage();
  const [ settings, setSettings ] = useState<Settings | null>(null);
  const [ error, setError ] = useState<string | null>(null);
  const [ notice, setNotice ] = useState<string | null>(null);
  const [ saving, setSaving ] = useState(false);
  const [ checking, setChecking ] = useState(false);
  const [ form ] = Form.useForm<FormValues>();
  const engine = Form.useWatch('engine', form);
  const typedKey = Form.useWatch('deepLApiKey', form);

  const apply = useCallback((result: Settings) => {
    setSettings(result);
    form.setFieldsValue({
      engine: result.engine,
      deepLApiKey: '',
      baiduAppId: result.baiduAppId,
      baiduSecretKey: '',
      targetLanguage: result.targetLanguage,
      proxyUrl: result.proxyUrl
    });
  }, [ form ]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setError(null);
    setNotice(null);
    void (async () => {
      try {
        apply(await api.getPdfTranslationSettings());
      }
      catch (e) {
        setError(e instanceof Error ? e.message : t('pdf_set_could_not_load'));
      }
    })();
  }, [ api, apply, open, t ]);

  const save = useCallback(async () => {
    const values = form.getFieldsValue();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.savePdfTranslationSettings({
        engine: values.engine,
        // Left out when blank, so saving the form does not wipe a key that is
        // already set and deliberately never sent back to be re-submitted.
        deepLApiKey: values.deepLApiKey ? values.deepLApiKey : undefined,
        baiduAppId: settings?.baiduFromConfig ? undefined : values.baiduAppId ?? '',
        // Left out when blank for the same reason as the DeepL key above.
        baiduSecretKey: values.baiduSecretKey ? values.baiduSecretKey : undefined,
        targetLanguage: values.targetLanguage,
        proxyUrl: values.proxyUrl ?? ''
      });
      apply(result);
      setNotice(t('pdf_set_saved'));
      onSaved?.(result);
    }
    catch (e) {
      setError(e instanceof Error ? e.message : t('pdf_set_could_not_save'));
    }
    finally {
      setSaving(false);
    }
    // `settings` is read for the flags that say what may be written at all.
  }, [ api, apply, form, onSaved, settings, t ]);

  /** Checks the key in the box, or the stored one when the box is empty. */
  const check = useCallback(async () => {
    setChecking(true);
    setError(null);
    setNotice(null);
    try {
      const typed = form.getFieldValue('deepLApiKey') as string;
      const status = await api.checkDeepLKey(typed || undefined);
      if (!status.ok) {
        setError(status.error || t('pdf_set_deepl_rejected'));
        return;
      }
      const used = status.characterCount ?? null;
      const limit = status.characterLimit ?? null;
      setNotice(
        t(status.plan === 'free' ? 'pdf_set_key_works_free' : 'pdf_set_key_works_pro') +
        (used !== null && limit !== null ?
          t('pdf_set_chars_used', {
            used: used.toLocaleString(),
            limit: limit.toLocaleString()
          }) : '.')
      );
    }
    catch (e) {
      setError(e instanceof Error ? e.message : t('pdf_set_could_not_reach_deepl'));
    }
    finally {
      setChecking(false);
    }
  }, [ api, form, t ]);

  return (
    <Modal
      open={open}
      title={t('pdf_translation')}
      okText={t('save')}
      confirmLoading={saving}
      onOk={() => void save()}
      onCancel={onClose}
      width={520}
      centered
    >
      {
        !settings ? <LoadingBlock minHeight="12rem" /> : (
          <Form form={form} layout="vertical" className="mt-3">
            <Form.Item
              name="engine"
              label={t('engine')}
              extra={t('pdf_set_engine_extra')}
            >
              <Radio.Group
                options={[
                  { value: 'google', label: 'Google Translate' },
                  { value: 'deepl', label: 'DeepL' }
                ]}
                optionType="button"
              />
            </Form.Item>

            <Form.Item
              name="deepLApiKey"
              label={
                <Space size={8}>
                  <span>{t('deepl_api_key')}</span>
                  {
                    settings.hasDeepLKey ?
                      <Tag color="green">{t('pdf_tag_set')}</Tag> : <Tag>{t('pdf_tag_not_set')}</Tag>
                  }
                  {settings.deepLKeyFromConfig ? <Tag color="blue">{t('pdf_from_command_line')}</Tag> : null}
                </Space>
              }
              extra={
                settings.deepLKeyFromConfig ?
                  t('pdf_set_from_config_extra')
                  : t('pdf_set_deepl_key_extra')
              }
            >
              <Input.Password
                placeholder={settings.hasDeepLKey ? t('pdf_placeholder_unchanged') : t('deepl_key_paste')}
                disabled={settings.deepLKeyFromConfig}
                autoComplete="off"
              />
            </Form.Item>

            <Form.Item>
              <Button
                onClick={() => void check()}
                loading={checking}
                disabled={!settings.hasDeepLKey && !typedKey}
              >
                {t('pdf_test_deepl_key')}
              </Button>
            </Form.Item>

            <Form.Item
              label={t('pdf_image_translation_baidu')}
              extra={
                settings.baiduFromConfig ?
                  t('pdf_set_from_config_extra')
                  : t('pdf_set_baidu_extra')
              }
              className="mb-2"
            >
              <Space.Compact className="w-100">
                <Form.Item name="baiduAppId" noStyle>
                  <Input
                    placeholder="APP ID"
                    disabled={settings.baiduFromConfig}
                    autoComplete="off"
                  />
                </Form.Item>
                <Form.Item name="baiduSecretKey" noStyle>
                  <Input.Password
                    placeholder={settings.hasBaiduSecretKey ? t('pdf_placeholder_unchanged') : t('secret_key')}
                    disabled={settings.baiduFromConfig}
                    autoComplete="off"
                  />
                </Form.Item>
              </Space.Compact>
            </Form.Item>

            <Form.Item className="mb-3">
              {
                settings.hasBaiduSecretKey ?
                  <Tag color="green">{t('pdf_set_image_set_up')}</Tag> :
                  <Tag>{t('pdf_set_image_not_set_up')}</Tag>
              }
              {settings.baiduFromConfig ? <Tag color="blue">{t('pdf_from_command_line')}</Tag> : null}
            </Form.Item>

            <Form.Item
              name="targetLanguage"
              label={t('pdf_set_translate_into')}
              extra={t('pdf_set_translate_into_extra')}
            >
              <Input placeholder="zh-CN" />
            </Form.Item>

            <Form.Item
              name="proxyUrl"
              label={t('proxy')}
              extra={
                settings.proxyFromConfig ?
                  t('pdf_set_from_config_extra')
                  : t('pdf_set_proxy_extra')
              }
            >
              <Input placeholder="http://127.0.0.1:7890" disabled={settings.proxyFromConfig} />
            </Form.Item>

            {
              engine === 'deepl' && !settings.hasDeepLKey ? (
                <Alert
                  className="mb-3"
                  type="warning"
                  showIcon
                  title={t('pdf_set_deepl_no_key_warning')}
                />
              ) : null
            }
            {error ? <Alert className="mb-3" type="error" showIcon title={error} /> : null}
            {notice ? <Alert className="mb-3" type="success" showIcon title={notice} /> : null}
          </Form>
        )
      }
    </Modal>
  );
}

export default PdfTranslationSettingsModal;
