import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Form, Input, Modal, Radio, Space, Tag } from "antd";
import { useAPI } from "../../contexts/APIProvider";
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
        setError(e instanceof Error ? e.message : 'Could not load the settings');
      }
    })();
  }, [ api, apply, open ]);

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
      setNotice('Saved.');
      onSaved?.(result);
    }
    catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the settings');
    }
    finally {
      setSaving(false);
    }
    // `settings` is read for the flags that say what may be written at all.
  }, [ api, apply, form, onSaved, settings ]);

  /** Checks the key in the box, or the stored one when the box is empty. */
  const check = useCallback(async () => {
    setChecking(true);
    setError(null);
    setNotice(null);
    try {
      const typed = form.getFieldValue('deepLApiKey') as string;
      const status = await api.checkDeepLKey(typed || undefined);
      if (!status.ok) {
        setError(status.error || 'DeepL would not accept that key');
        return;
      }
      const used = status.characterCount ?? null;
      const limit = status.characterLimit ?? null;
      setNotice(
        `The key works (${status.plan === 'free' ? 'free' : 'pro'} plan)` +
        (used !== null && limit !== null ?
          ` - ${used.toLocaleString()} of ${limit.toLocaleString()} characters used.` : '.')
      );
    }
    catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach DeepL');
    }
    finally {
      setChecking(false);
    }
  }, [ api, form ]);

  return (
    <Modal
      open={open}
      title="PDF translation"
      okText="Save"
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
              label="Engine"
              extra="Only the PDF reader uses this. Subtitle translation is a separate setting and is unaffected."
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
                  <span>DeepL API key</span>
                  {
                    settings.hasDeepLKey ?
                      <Tag color="green">set</Tag> : <Tag>not set</Tag>
                  }
                  {settings.deepLKeyFromConfig ? <Tag color="blue">from the command line</Tag> : null}
                </Space>
              }
              extra={
                settings.deepLKeyFromConfig ?
                  'Set when the server was started, so it cannot be changed here.'
                  : 'Stored on the server and never sent back. Leave blank to keep the current one; a free key ends in ":fx".'
              }
            >
              <Input.Password
                placeholder={settings.hasDeepLKey ? '••••••••  (unchanged)' : 'Paste a DeepL key'}
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
                Test the DeepL key
              </Button>
            </Form.Item>

            <Form.Item
              label="Image translation (Baidu)"
              extra={
                settings.baiduFromConfig ?
                  'Set when the server was started, so it cannot be changed here.'
                  : 'For translating a page as a picture - a scan, a comic, a diagram - which the engines above cannot help with. Sign up at fanyi-api.baidu.com and enable 图片翻译; the reader shows the two image buttons to anyone allowed to translate, and says so there when this is not set.'
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
                    placeholder={settings.hasBaiduSecretKey ? '••••••••  (unchanged)' : 'Secret key'}
                    disabled={settings.baiduFromConfig}
                    autoComplete="off"
                  />
                </Form.Item>
              </Space.Compact>
            </Form.Item>

            <Form.Item className="mb-3">
              {
                settings.hasBaiduSecretKey ?
                  <Tag color="green">image translation is set up</Tag> :
                  <Tag>image translation is not set up</Tag>
              }
              {settings.baiduFromConfig ? <Tag color="blue">from the command line</Tag> : null}
            </Form.Item>

            <Form.Item
              name="targetLanguage"
              label="Translate into"
              extra='A language code - "zh-CN", "en", "ja". DeepL and Baidu are each given the code they expect for the same language. Changing it discards the page images translated into the old one.'
            >
              <Input placeholder="zh-CN" />
            </Form.Item>

            <Form.Item
              name="proxyUrl"
              label="Proxy"
              extra={
                settings.proxyFromConfig ?
                  'Set when the server was started, so it cannot be changed here.'
                  : 'Used by whichever engine is selected, and by the image translation. Leave blank to connect directly.'
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
                  title="DeepL is selected but has no key - nothing will be translated until one is set."
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
