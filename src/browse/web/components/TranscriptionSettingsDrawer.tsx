import "../assets/styles/TranscriptionSettingsDrawer.scss";
import { Drawer, Tabs } from "antd";
import { AudioOutlined, TranslationOutlined } from "@ant-design/icons";
import { useMediaQuery, DESKTOP_QUERY } from "../utils/useMediaQuery";
import TranscriptionSettingsPanel from "./settings/TranscriptionSettingsPanel";
import TranslationSettingsPanel from "./settings/TranslationSettingsPanel";

interface TranscriptionSettingsDrawerProps {
  open: boolean;
  onClose: () => void;
  /** Which config to show first - follows the list tab it was opened from. */
  defaultTab?: 'transcription' | 'translation';
}

/**
 * The transcription and translation settings, side by side in one drawer that
 * opens from the history page. These used to be two routes of their own; the
 * button on the list opens this instead, and a tab switches between the two
 * configs the same way the list switches between the two queues.
 *
 * The panels are mounted only while the drawer is open, so neither settings
 * request is made until someone actually asks to see them.
 */
function TranscriptionSettingsDrawer(props: TranscriptionSettingsDrawerProps) {
  const { open, onClose, defaultTab = 'transcription' } = props;
  const isDesktop = useMediaQuery(DESKTOP_QUERY);

  return (
    <Drawer
      title="Settings"
      placement="right"
      width={isDesktop ? 560 : '100%'}
      open={open}
      onClose={onClose}
    >
      {
        // Mounted only while open, so neither settings request fires until
        // someone actually opens the drawer.
        open ? (
          <Tabs
            className="transcription-settings-drawer__tabs"
            defaultActiveKey={defaultTab}
            items={[
              {
                key: 'transcription',
                icon: <AudioOutlined />,
                label: 'Transcription',
                children: <TranscriptionSettingsPanel />
              },
              {
                key: 'translation',
                icon: <TranslationOutlined />,
                label: 'Translation',
                children: <TranslationSettingsPanel />
              }
            ]}
          />
        ) : null
      }
    </Drawer>
  );
}

export default TranscriptionSettingsDrawer;
