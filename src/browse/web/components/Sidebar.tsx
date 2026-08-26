import "../assets/styles/Sidebar.scss";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, OverlayTrigger, Stack, Tooltip } from "react-bootstrap";
import { type Campaign } from "../../../entities";
import { useAPI } from "../contexts/APIProvider";
import { Link } from "react-router";
import { useGlobalModals } from "../contexts/GlobalModalsProvider";
import { useSidebar } from "../contexts/SidebarProvider";
import CustomScrollbars from "./CustomScrollbars";
import MediaImage from "./MediaImage";
import { APP_NAME, getCampaignBaseUrl } from "../utils/Misc";

interface SidebarProps {
  closeButton?: boolean;
  onClose?: () => void;
  /**
   * Whether the sidebar can be reduced to an icon rail. Off inside the mobile
   * offcanvas, which is dismissed rather than collapsed.
   */
  collapsible?: boolean;
}

/**
 * Wraps an entry in a tooltip carrying its label, which is the only way to
 * read it once the sidebar is down to icons.
 */
function CollapsedLabel(props: { label: string; enabled: boolean; children: React.ReactElement }) {
  const { label, enabled, children } = props;
  if (!enabled) {
    return children;
  }
  return (
    <OverlayTrigger placement="right" overlay={<Tooltip>{label}</Tooltip>}>
      {children}
    </OverlayTrigger>
  );
}

function Sidebar(props: SidebarProps) {
  const { closeButton = false, onClose, collapsible = false } = props;
  const { api } = useAPI();
  const { showBrowseSettingsModal } = useGlobalModals();
  const { collapsed: collapsedSetting, toggleCollapsed } = useSidebar();
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  // The offcanvas always shows the full sidebar: there is no room to spare on
  // a rail the visitor has to open in the first place.
  const collapsed = collapsible && collapsedSetting;

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

  const handleLinkClick = useCallback(() => {
    if (onClose) {
      onClose();
    }
  }, [onClose]);

  const handleSettingsLinkClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (onClose) {
      onClose();
    }
    showBrowseSettingsModal();
  }, [onClose, showBrowseSettingsModal]);

  const campaignLinks = useMemo(() => {
    if (!campaigns || campaigns.length === 0) {
      return null;
    }
    const links = campaigns.map((campaign) => (
      <CollapsedLabel
        key={`sidebar-campaign-${campaign.id}`}
        label={campaign.name || ''}
        enabled={collapsed}
      >
        <Link
          to={getCampaignBaseUrl(campaign)}
          className="sidebar__link"
          onClick={handleLinkClick}
          title={collapsed ? undefined : campaign.name || undefined}
        >
          <MediaImage
            className="sidebar__link-icon"
            mediaId={`campaign:${campaign.id}:avatar`}
          />
          <span className="sidebar__link-text">{campaign.name}</span>
        </Link>
      </CollapsedLabel>
    ));
    return (
      <Stack className="sidebar__section mt-4 mb-5" gap={3}>
        <h6 className="sidebar__section-title">Recently downloaded</h6>
        {links}
      </Stack>
    )
  }, [campaigns, collapsed, handleLinkClick]);

  return (
    <Card className={`sidebar p-0 ${collapsed ? 'sidebar--collapsed' : ''}`}>
      <Stack className="overflow-hidden">
        <Stack
          // On the rail the two controls cannot sit side by side, so they
          // stack instead of the name being dropped along with its link home.
          direction={collapsed ? 'vertical' : 'horizontal'}
          className="sidebar__header justify-content-between p-3"
          gap={collapsed ? 2 : 0}
        >
          <div className="sidebar__brand fs-5 fw-bold">
            {
              collapsed ? (
                <CollapsedLabel label={APP_NAME} enabled>
                  <Link
                    to="/"
                    className="sidebar__brand-home"
                    onClick={handleLinkClick}
                    aria-label={APP_NAME}
                  >
                    <span className="material-icons">home</span>
                  </Link>
                </CollapsedLabel>
              ) : (
                <Link
                  to="/"
                  onClick={handleLinkClick}
                >
                  {APP_NAME}
                </Link>
              )
            }
          </div>
          {
            collapsible ? (
              <CollapsedLabel label="Expand sidebar" enabled={collapsed}>
                <button
                  type="button"
                  className="sidebar__toggle"
                  onClick={toggleCollapsed}
                  aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                  aria-expanded={!collapsed}
                >
                  <span className="material-icons">
                    {collapsed ? 'chevron_right' : 'chevron_left'}
                  </span>
                </button>
              </CollapsedLabel>
            ) : null
          }
          {
            closeButton ? (
              <button className="btn-close" onClick={onClose ? () => onClose() : undefined}></button>
            ) : null
          }
        </Stack>
        <CustomScrollbars
          viewClassName="sidebar__main"
        >
          <Stack className="flex-fill">
            {campaignLinks}
            <Stack className="sidebar__section justify-content-end pb-3" gap={3}>
              <CollapsedLabel label="Settings" enabled={collapsed}>
                <a
                  href="#"
                  className="sidebar__link"
                  onClick={handleSettingsLinkClick}
                >
                  <span className="material-icons sidebar__link-icon">settings</span>
                  <span className="sidebar__link-text">Settings</span>
                </a>
              </CollapsedLabel>
            </Stack>
          </Stack>
        </CustomScrollbars>
      </Stack>
    </Card>
  );
};

export default Sidebar;
