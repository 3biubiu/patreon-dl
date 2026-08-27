import "../assets/styles/Sidebar.scss";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Avatar, Menu, Tooltip, type MenuProps } from "antd";
import {
  HistoryOutlined,
  HomeOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  SettingOutlined,
  StarOutlined,
  TeamOutlined,
  AudioOutlined
} from "@ant-design/icons";
import { type Campaign } from "../../../entities";
import { useAPI } from "../contexts/APIProvider";
import { Link, useLocation, useNavigate } from "react-router";
import { useGlobalModals } from "../contexts/GlobalModalsProvider";
import { useAuth } from "../contexts/AuthProvider";
import { useQuota } from "../contexts/QuotaProvider";
import { APP_NAME, getCampaignBaseUrl } from "../utils/Misc";
import { type QuotaCounter, type QuotaStatus } from "../../types/Quota";

interface SidebarProps {
  /**
   * Icon rail. Inside `Layout.Sider` the menu picks this up on its own; it is
   * still needed here to decide what the parts around the menu look like.
   */
  collapsed?: boolean;
  /** Called after a destination is picked, so the mobile drawer can close. */
  onNavigate?: () => void;
  /** Given only where collapsing applies, which is the desktop rail. */
  onToggleCollapse?: () => void;
}

const SETTINGS_KEY = 'settings';
const FAVORITES_KEY = '/favorites';
const HISTORY_KEY = '/history';
const USERS_KEY = '/users';
const TRANSCRIPTION_KEY = '/transcription';
const SIGN_OUT_KEY = 'sign-out';
const COLLAPSE_KEY = 'collapse';

function Sidebar(props: SidebarProps) {
  const { collapsed = false, onNavigate, onToggleCollapse } = props;
  const { api } = useAPI();
  const { showBrowseSettingsModal } = useGlobalModals();
  const { user, signOut } = useAuth();
  const { quota } = useQuota();
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
      { key: '/', icon: <HomeOutlined />, label: 'Home' },
      // Both belong to the account rather than to a role. Favorites sits above
      // History: it is the list the user built on purpose, not the trace
      // browsing left behind.
      { key: FAVORITES_KEY, icon: <StarOutlined />, label: 'Favorites' },
      { key: HISTORY_KEY, icon: <HistoryOutlined />, label: 'History' }
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
    return items;
  }, [campaignItems, collapsed]);

  // Its own menu, so it can sit at the foot of the panel rather than wherever
  // the campaign list happens to end.
  const footerItems = useMemo<MenuProps['items']>(() => {
    const items: NonNullable<MenuProps['items']> = [];
    // Hidden from everyone else. The server refuses these endpoints to
    // non-administrators regardless of what the menu shows.
    if (user?.role === 'admin') {
      items.push({ key: USERS_KEY, icon: <TeamOutlined />, label: 'Users' });
      items.push({ key: TRANSCRIPTION_KEY, icon: <AudioOutlined />, label: 'Transcription' });
    }
    items.push(
      { key: SETTINGS_KEY, icon: <SettingOutlined />, label: 'Settings' },
      { key: SIGN_OUT_KEY, icon: <LogoutOutlined />, label: 'Sign out' }
    );
    if (onToggleCollapse) {
      items.push({
        key: COLLAPSE_KEY,
        icon: collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />,
        label: collapsed ? 'Expand' : 'Collapse'
      });
    }
    return items;
  }, [user?.role, collapsed, onToggleCollapse]);

  // A campaign stays selected while any of its sub-pages is open.
  const selectedKeys = useMemo(() => {
    const path = location.pathname;
    const match = campaignItems.find(
      ({ key }) => path === key || path.startsWith(`${key}/`)
    );
    if (match) {
      return [ match.key ];
    }
    if (path === FAVORITES_KEY) {
      return [ FAVORITES_KEY ];
    }
    if (path === HISTORY_KEY) {
      return [ HISTORY_KEY ];
    }
    return path === '/' || path === '/creators' ? [ '/' ] : [];
  }, [location.pathname, campaignItems]);

  const handleClick = useCallback<NonNullable<MenuProps['onClick']>>(({ key }) => {
    if (key === COLLAPSE_KEY) {
      // Stays put rather than closing anything - there is nothing to navigate.
      onToggleCollapse?.();
      return;
    }
    if (key === SETTINGS_KEY) {
      showBrowseSettingsModal();
    }
    else if (key === SIGN_OUT_KEY) {
      void signOut();
    }
    else {
      void navigate(key);
    }
    if (onNavigate) {
      onNavigate();
    }
  }, [navigate, showBrowseSettingsModal, signOut, onToggleCollapse, onNavigate]);

  return (
    <div className={`sidebar ${collapsed ? 'sidebar--collapsed' : ''}`}>
      <div className="sidebar__brand">
        <Link
          to="/"
          className="sidebar__brand-link"
          onClick={onNavigate}
          aria-label={APP_NAME}
        >
          <span className="sidebar__logo" aria-hidden="true">B</span>
          {!collapsed ? <span className="sidebar__brand-text">{APP_NAME}</span> : null}
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
      { !collapsed ? <QuotaSummary quota={quota} /> : null }
      <div className="sidebar__footer">
        <Menu
          mode="inline"
          items={footerItems}
          selectedKeys={location.pathname === USERS_KEY ? [ USERS_KEY ] : []}
          onClick={handleClick}
        />
      </div>
    </div>
  );
};

/**
 * What is left of today's allowance.
 *
 * Shown only to accounts that actually have one - an administrator, or a user
 * whose limits are both lifted, gets nothing here rather than a row of
 * infinity signs. Hidden on the collapsed rail too: there is no room for a
 * number that has to be read to mean anything.
 */
function QuotaSummary(props: { quota: QuotaStatus | null; }) {
  const { quota } = props;
  if (!quota || !quota.limited) {
    return null;
  }
  const resetsAt = new Date(quota.resetsAt);
  const rows: { label: string; counter: QuotaCounter; }[] = [
    { label: 'Posts', counter: quota.posts },
    { label: 'Videos', counter: quota.videos }
  ];
  return (
    <Tooltip
      placement="right"
      title={`Resets at 08:00 Beijing time (${resetsAt.toLocaleString()}). Opening the same post or video again is free.`}
    >
      <div className="sidebar__quota">
        <div className="sidebar__quota-title">Today's allowance</div>
        {
          rows.map(({ label, counter }) => (
            <div key={label} className="sidebar__quota-row">
              <span className="sidebar__quota-label">{label}</span>
              <span
                className={
                  `sidebar__quota-value${counter.remaining === 0 ? ' sidebar__quota-value--spent' : ''}`
                }
              >
                {
                  counter.limit === null ?
                    'Unlimited' :
                    `${counter.remaining ?? 0} / ${counter.limit}`
                }
              </span>
            </div>
          ))
        }
      </div>
    </Tooltip>
  );
}

export default Sidebar;
