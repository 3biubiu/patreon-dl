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
  }, [ api, apply, form, onSaved ]);

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
              name="targetLanguage"
              label="Translate into"
              extra='A language code - "zh-CN", "en", "ja". DeepL is given the code it expects for the same language.'
            >
              <Input placeholder="zh-CN" />
            </Form.Item>

            <Form.Item
              name="proxyUrl"
              label="Proxy"
              extra={
                settings.proxyFromConfig ?
                  'Set when the server was started, so it cannot be changed here.'
                  : 'Used by whichever engine is selected. Leave blank to connect directly.'
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
