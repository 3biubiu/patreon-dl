import { useCallback, useEffect } from "react";
import { useBrowseSettings } from "../contexts/BrowseSettingsProvider";
import { useLanguage } from "../contexts/LanguageProvider";
import { type AppLanguage } from "../i18n/translations";
import { Col, Form, Modal, Row } from "react-bootstrap";

interface BrowseSettingsModalProps {
  show?: boolean;
  onClose: () => void;
}

function BrowseSettingsModal(props: BrowseSettingsModalProps) {
  const { show, onClose } = props;
  const { settings, options, updateSettings, refreshSettings } = useBrowseSettings();
  const { language, setLanguage, t } = useLanguage();

  useEffect(() => {
    if (!show) {
      return;
    }
    refreshSettings();
  },[show, refreshSettings]);

  const handleSelectChange = useCallback((
    e: React.ChangeEvent<HTMLSelectElement>,
  ) => {
    const key = e.target.dataset.setting;
    const valueType = e.target.dataset.type;
    if (!key) {
      return;
    }
    const value = valueType === 'number' ? Number(e.target.value) : e.target.value;
    if (typeof value === 'number' && isNaN(value)) {
      return;
    }
    const setting = {[key]: value};
    updateSettings(setting);
  }, [updateSettings]);

  const handleLanguageChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setLanguage(e.target.value as AppLanguage);
  }, [setLanguage]);

  if (!settings || !options) {
    return null;
  }

  return (
    <Modal
      show={show}
      onHide={onClose}
      centered
      scrollable
    >
      <Modal.Header closeButton />

      <Modal.Body>
        <Form>
          <Form.Group as={Row} className="mb-3">
            <Form.Label column sm={5}>
              {t('settings_language')}
            </Form.Label>
            <Col sm={7}>
              <Form.Select
                value={language}
                onChange={handleLanguageChange}
              >
                <option value="en">{t('option_english')}</option>
                <option value="zh">{t('option_chinese')}</option>
              </Form.Select>
            </Col>
          </Form.Group>

          <Form.Group as={Row} className="mb-3">
            <Form.Label column sm={5}>
              {t('settings_list_per_page')}
            </Form.Label>
            <Col sm={7}>
              {
                <Form.Select
                  data-setting="listItemsPerPage"
                  data-type="number"
                  value={settings.listItemsPerPage}
                  onChange={handleSelectChange}
                >
                  {
                    options.listItemsPerPage.map((value) => (
                      <option key={`listItemsPerPage-${value}`} value={value}>{value}</option>
                    ))
                  }
                </Form.Select>
              }
            </Col>
          </Form.Group>

          <Form.Group as={Row} className="mb-3">
            <Form.Label column sm={5}>
              {t('settings_gallery_per_page')}
            </Form.Label>
            <Col sm={7}>
              {
                <Form.Select
                  data-setting="galleryItemsPerPage"
                  data-type="number"
                  value={settings.galleryItemsPerPage}
                  onChange={handleSelectChange}
                >
                  {
                    options.galleryItemsPerPage.map((value) => (
                      <option key={`galleryItemsPerPage-${value}`} value={value}>{value}</option>
                    ))
                  }
                </Form.Select>
              }
            </Col>
          </Form.Group>

          <Form.Group as={Row} className="mb-3">
            <Form.Label column sm={5}>
              {t('settings_max_width')}
            </Form.Label>
            <Col sm={7}>
              {
                <Form.Select
                  data-setting="maxContentWidth"
                  data-type="string"
                  value={settings.maxContentWidth}
                  onChange={handleSelectChange}
                >
                  {
                    options.maxContentWidth.map((value) => (
                      <option key={`maxContentWidth-${value}`} value={value}>{value}</option>
                    ))
                  }
                </Form.Select>
              }
            </Col>
          </Form.Group>
        </Form>
      </Modal.Body>
    </Modal>
  )
}

export default BrowseSettingsModal;