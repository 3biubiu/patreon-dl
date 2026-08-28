import { Dropdown, type MenuProps } from "antd";
import Icon from "./Icon";

/** Where a control is being drawn, which is all that separates their looks. */
export type PlayerControlVariant = 'toolbar' | 'floating' | 'player';

export interface PlayerMenuItem {
  key: string;
  label: string;
}

interface PlayerMenuButtonProps {
  /** Material Icons name. */
  icon: string;
  /** What the control is, for the tooltip and screen readers. */
  label: string;
  /** Key of the item currently in effect. */
  value: string;
  items: PlayerMenuItem[];
  onSelect: (key: string) => void;
  /** Short text beside the icon - the chosen speed, say. */
  badge?: string;
  /**
   * `toolbar` matches lightgallery's own icon buttons; `floating` is the pill
   * used when the toolbar could not be found; `player` is the in-page player's
   * own control bar.
   */
  variant: PlayerControlVariant;
  /**
   * Where the popup is mounted. The in-page player hands it its own root, so
   * the menu is still there when that root is the fullscreen element - antd
   * would otherwise portal it to the end of the document, outside the only
   * element being shown.
   */
  getPopupContainer?: () => HTMLElement;
}

/**
 * One of the controls that sits over a playing video.
 *
 * The menu is an antd `Dropdown` rather than a native `<select>`: inside the
 * toolbar a native menu cannot be styled to match, and antd portals its popup
 * to the end of the document, so it cannot be clipped by the toolbar or hidden
 * behind the lightbox - which is the one thing a plain `<select>` gave for
 * free and had to be replaced carefully.
 */
function PlayerMenuButton(props: PlayerMenuButtonProps) {
  const { icon, label, value, items, onSelect, badge, variant, getPopupContainer } = props;

  const menu: MenuProps = {
    items: items.map((item) => ({ key: item.key, label: item.label })),
    selectable: true,
    selectedKeys: [ value ],
    onClick: ({ key }) => onSelect(key)
  };

  return (
    <Dropdown
      menu={menu}
      trigger={[ 'click' ]}
      placement={variant === 'player' ? 'top' : variant === 'toolbar' ? 'bottomRight' : 'bottomLeft'}
      getPopupContainer={getPopupContainer}
      // Clear of the lightbox (1050) and its toolbar (1082).
      styles={{ root: { zIndex: 1100 } }}
    >
      <button
        type="button"
        className={`player-menu player-menu--${variant}`}
        title={label}
        aria-label={label}
        // The lightbox closes on Escape and moves slides on arrow keys; a menu
        // being driven with the keyboard should not also be doing that.
        onKeyDown={(e) => e.stopPropagation()}
      >
        <Icon name={icon} />
        {badge ? <span className="player-menu__badge">{badge}</span> : null}
      </button>
    </Dropdown>
  );
}

export default PlayerMenuButton;
