import "../assets/styles/Sidebar.scss";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Avatar, Menu, type MenuProps } from "antd";
import { HomeOutlined, SettingOutlined } from "@ant-design/icons";
import { type Campaign } from "../../../entities";
import { useAPI } from "../contexts/APIProvider";
import { Link, useLocation, useNavigate } from "react-router";
import { useGlobalModals } from "../contexts/GlobalModalsProvider";
import { APP_NAME, getCampaignBaseUrl } from "../utils/Misc";

interface SidebarProps {
  /**
   * Icon rail. Inside `Layout.Sider` the menu picks this up on its own; it is
   * still needed here to decide what the parts around the menu look like.
   */
  collapsed?: boolean;
  /** Called after a destination is picked, so the mobile drawer can close. */
  onNavigate?: () => void;
}

const SETTINGS_KEY = 'settings';

function Sidebar(props: SidebarProps) {
  const { collapsed = false, onNavigate } = props;
  const { api } = useAPI();
  const { showBrowseSettingsModal } = useGlobalModals();
  const navigate = useNavigate();
  const location = useLocation();
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);

  useEffect(() => {
    const abortController = new AbortController();
    void (async () => {
      const campaigns = (await api.getCampaignList({ sortBy: 'last_downloaded', itemsPerPage: 10 })).campaigns;
      if (!abortController.signal.aborted) {
        setCampaigns(campaigns);
      }
    })();

    return () => abortController.abort();
  }, [api]);

  const campaignItems = useMemo(() => {
    return (campaigns || []).map((campaign) => ({
      key: getCampaignBaseUrl(campaign),
      // On the rail this avatar is the whole entry, which is why it is the
      // menu item's icon rather than something inside its label.
      icon: (
        <Avatar
          shape="square"
          size={22}
          src={`/media/campaign:${campaign.id}:avatar`}
        >
          {campaign.name?.charAt(0) || '?'}
        </Avatar>
      ),
      label: campaign.name
    }));
  }, [campaigns]);

  const items = useMemo<MenuProps['items']>(() => {
    const items: NonNullable<MenuProps['items']> = [
      { key: '/', icon: <HomeOutlined />, label: 'Home' }
    ];
    if (campaignItems.length > 0) {
      // A group heading has nowhere to be read on the rail, so there the
      // campaigns are just separated off instead of titled.
      if (collapsed) {
        items.push({ type: 'divider' }, ...campaignItems);
      }
      else {
        items.push({
          type: 'group',
          key: 'recently-downloaded',
          label: 'Recently downloaded',
          children: campaignItems
        });
      }
    }
    items.push(
      { type: 'divider' },
      { key: SETTINGS_KEY, icon: <SettingOutlined />, label: 'Settings' }
    );
    return items;
  }, [campaignItems, collapsed]);

  // A campaign stays selected while any of its sub-pages is open.
  const selectedKeys = useMemo(() => {
    const path = location.pathname;
    const match = campaignItems.find(
      ({ key }) => path === key || path.startsWith(`${key}/`)
    );
    if (match) {
      return [ match.key ];
    }
    return path === '/' || path === '/creators' ? [ '/' ] : [];
  }, [location.pathname, campaignItems]);

  const handleClick = useCallback<NonNullable<MenuProps['onClick']>>(({ key }) => {
    if (key === SETTINGS_KEY) {
      showBrowseSettingsModal();
    }
    else {
      void navigate(key);
    }
    if (onNavigate) {
      onNavigate();
    }
  }, [navigate, showBrowseSettingsModal, onNavigate]);

  return (
    <div className={`sidebar ${collapsed ? 'sidebar--collapsed' : ''}`}>
      <div className="sidebar__brand">
        <Link to="/" onClick={onNavigate} aria-label={APP_NAME}>
          {collapsed ? <HomeOutlined /> : APP_NAME}
        </Link>
      </div>
      <div className="sidebar__menu">
        <Menu
          mode="inline"
          items={items}
          selectedKeys={selectedKeys}
          onClick={handleClick}
        />
      </div>
    </div>
  );
};

export default Sidebar;
