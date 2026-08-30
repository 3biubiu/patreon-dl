import "../assets/styles/Sidebar.scss";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Avatar, Menu, Select, Tooltip, type MenuProps } from "antd";
import {
  HistoryOutlined,
  HomeOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  SearchOutlined,
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
import { type CampaignListSortBy } from "../../types/Campaign";
import {
  readSidebarSort,
  writeSidebarSort,
  SIDEBAR_SORT_OPTIONS
} from "../utils/sidebarSortPreference";

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
const SEARCH_KEY = '/search';
const FAVORITES_KEY = '/favorites';
const HISTORY_KEY = '/history';
const USERS_KEY = '/users';
const TRANSCRIPTION_KEY = '/transcription';
const SIGN_OUT_KEY = 'sign-out';
const COLLAPSE_KEY = 'collapse';

/**
 * Enough to hold every creator in one request for all but the largest
 * libraries; a bigger one is fetched again at its real size. The panel lists
 * the whole library rather than a recent handful, so a second round trip in
 * the rare case is better than paging something you scroll.
 */
const CAMPAIGN_FETCH_SIZE = 500;

function Sidebar(props: SidebarProps) {
  const { collapsed = false, onNavigate, onToggleCollapse } = props;
  const { api } = useAPI();
  const { showBrowseSettingsModal } = useGlobalModals();
  const { user, signOut } = useAuth();
  const { quota } = useQuota();
  const navigate = useNavigate();
  const location = useLocation();
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [sortBy, setSortBy] = useState<CampaignListSortBy>(readSidebarSort);

  useEffect(() => {
    const abortController = new AbortController();
    void (async () => {
      let list = await api.getCampaignList({ sortBy, itemsPerPage: CAMPAIGN_FETCH_SIZE });
      if (list.total > list.campaigns.length && !abortController.signal.aborted) {
        list = await api.getCampaignList({ sortBy, itemsPerPage: list.total });
      }
      if (!abortController.signal.aborted) {
        setCampaigns(list.campaigns);
      }
    })();

    return () => abortController.abort();
  }, [api, sortBy]);

  const handleSortChange = useCallback((value: CampaignListSortBy) => {
    setSortBy(value);
    writeSidebarSort(value);
  }, []);

  const campaignItems = useMemo(() => {
    return (campaigns || []).map((campaign) => ({
      key: getCampaignBaseUrl(campaign),
      // On the rail this avatar is the whole entry, which is why it is the
      // menu item's icon rather than something inside its label.
      icon: (
        <Avatar
          shape="square"
          size={30}
          src={`/media/campaign:${campaign.id}:avatar`}
        >
          {campaign.name?.charAt(0) || '?'}
        </Avatar>
      ),
      label: campaign.name
    }));
  }, [campaigns]);

  // Stays put at the top of the panel. The creator list below it is what
  // scrolls, so these three are always one click away however long it gets.
  const items = useMemo<MenuProps['items']>(() => ([
    { key: '/', icon: <HomeOutlined />, label: 'Home' },
    // Directly under Home: it searches the whole library, so it belongs with
    // the destination that shows the whole library rather than down among the
    // lists that belong to the account.
    { key: SEARCH_KEY, icon: <SearchOutlined />, label: 'Search' },
    // Both belong to the account rather than to a role. Favorites sits above
    // History: it is the list the user built on purpose, not the trace
    // browsing left behind.
    { key: FAVORITES_KEY, icon: <StarOutlined />, label: 'Favorites' },
    { key: HISTORY_KEY, icon: <HistoryOutlined />, label: 'History' }
  ]), []);

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
    if (path === SEARCH_KEY) {
      return [ SEARCH_KEY ];
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
      <div className="sidebar__nav">
        <Menu
          mode="inline"
          items={items}
          selectedKeys={selectedKeys}
          onClick={handleClick}
        />
      </div>
      {
        campaignItems.length > 0 ? (
          <div className="sidebar__campaigns">
            {
              // The heading has nowhere to be read on the collapsed rail, so
              // there the list is only separated off from the nav above it.
              collapsed ? (
                <div className="sidebar__campaigns-rule" />
              ) : (
                <div className="sidebar__campaigns-header">
                  <span className="sidebar__campaigns-title">
                    Creators
                    <span className="sidebar__campaigns-count">{campaignItems.length}</span>
                  </span>
                  <Tooltip placement="right" title="Order">
                    <Select<CampaignListSortBy>
                      className="sidebar__campaigns-sort"
                      size="small"
                      variant="borderless"
                      aria-label="Order creators by"
                      value={sortBy}
                      onChange={handleSortChange}
                      options={SIDEBAR_SORT_OPTIONS}
                      // The panel is narrower than the longest label, so the
                      // menu is allowed to be wider than the control.
                      popupMatchSelectWidth={false}
                      placement="bottomRight"
                    />
                  </Tooltip>
                </div>
              )
            }
            {/* The whole library, not a recent handful - so this is the part
                that scrolls when it outgrows the panel. */}
            <div className="sidebar__campaigns-list">
              <Menu
                mode="inline"
                items={campaignItems}
                selectedKeys={selectedKeys}
                onClick={handleClick}
              />
            </div>
          </div>
        ) : (
          // Nothing to scroll yet, but the footer still belongs at the foot.
          <div className="sidebar__spacer" />
        )
      }
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
