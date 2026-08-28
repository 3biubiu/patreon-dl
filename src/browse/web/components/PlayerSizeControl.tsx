import { Button, Dropdown, Segmented, Slider } from "antd";
import Icon from "./Icon";

/**
 * The frame the picture is drawn into, as a fraction of the viewport height.
 *
 * Height rather than width: the player always spans the column it sits in, so
 * width is not the viewer's to choose - how much of the screen the video is
 * allowed to take before they have to scroll past it, is.
 */
export type SizePresetKey = 'compact' | 'standard' | 'large';

export const SIZE_PRESETS: Record<SizePresetKey, { label: string; heightRatio: number }> = {
  compact: { label: 'Compact', heightRatio: 0.45 },
  standard: { label: 'Standard', heightRatio: 0.62 },
  large: { label: 'Large', heightRatio: 0.82 }
};

export const MIN_SIZE_PERCENT = 50;
export const MAX_SIZE_PERCENT = 200;
export const DEFAULT_SIZE_PERCENT = 100;

const PRESET_STORAGE_KEY = 'patreon-dl.playerSizePreset';
const PERCENT_STORAGE_KEY = 'patreon-dl.playerSizePercent';

function isPresetKey(value: string | null): value is SizePresetKey {
  return !!value && Object.prototype.hasOwnProperty.call(SIZE_PRESETS, value);
}

export function readStoredPreset(): SizePresetKey {
  try {
    const stored = window.localStorage.getItem(PRESET_STORAGE_KEY);
    return isPresetKey(stored) ? stored : 'standard';
  }
  catch (_error) {
    return 'standard';
  }
}

export function readStoredPercent(): number {
  try {
    const stored = Number(window.localStorage.getItem(PERCENT_STORAGE_KEY));
    if (!Number.isFinite(stored) || stored < MIN_SIZE_PERCENT || stored > MAX_SIZE_PERCENT) {
      return DEFAULT_SIZE_PERCENT;
    }
    return stored;
  }
  catch (_error) {
    return DEFAULT_SIZE_PERCENT;
  }
}

/** Not remembering a choice is not worth failing over, here or below. */
export function storePreset(preset: SizePresetKey) {
  try {
    window.localStorage.setItem(PRESET_STORAGE_KEY, preset);
  }
  catch (_error) { /* empty */ }
}

export function storePercent(percent: number) {
  try {
    window.localStorage.setItem(PERCENT_STORAGE_KEY, String(percent));
  }
  catch (_error) { /* empty */ }
}

interface PlayerSizeControlProps {
  preset: SizePresetKey;
  /** 50 - 200. Below 100 the frame shrinks; above it the picture is zoomed. */
  percent: number;
  onPresetChange: (preset: SizePresetKey) => void;
  onPercentChange: (percent: number) => void;
  onReset: () => void;
  /** True once the picture is larger than its frame and can be moved about. */
  pannable: boolean;
  getPopupContainer?: () => HTMLElement;
}

/**
 * How big the picture is, and how much of it is showing.
 *
 * Two settings behind one button because they are one question to the viewer.
 * The presets answer "how much of my screen should this take", the percentage
 * answers "closer" - and past 100% the two come apart: the frame stays where
 * the preset put it and the picture grows inside it, which is the only way to
 * crop the black bars off a letterboxed video without the player itself
 * growing to match.
 */
function PlayerSizeControl(props: PlayerSizeControlProps) {
  const { preset, percent, onPresetChange, onPercentChange, onReset, pannable, getPopupContainer } = props;

  const panel = (
    <div className="player-size" onKeyDown={(e) => e.stopPropagation()}>
      <div className="player-size__row">
        <span className="player-size__label">Frame</span>
        <Segmented
          size="small"
          value={preset}
          onChange={(value) => onPresetChange(value as SizePresetKey)}
          options={Object.entries(SIZE_PRESETS).map(([key, { label }]) => ({ value: key, label }))}
        />
      </div>
      <div className="player-size__row">
        <span className="player-size__label">Zoom</span>
        <span className="player-size__value">{percent}%</span>
      </div>
      <Slider
        min={MIN_SIZE_PERCENT}
        max={MAX_SIZE_PERCENT}
        step={5}
        value={percent}
        onChange={onPercentChange}
        marks={{ [MIN_SIZE_PERCENT]: '50%', [DEFAULT_SIZE_PERCENT]: '100%', [MAX_SIZE_PERCENT]: '200%' }}
        tooltip={{ open: false }}
      />
      <div className="player-size__footer">
        <span className="player-size__hint">
          {pannable ? 'Drag the picture to choose what shows.' : 'Above 100% the picture can be dragged.'}
        </span>
        <Button size="small" type="text" onClick={onReset}>Reset</Button>
      </div>
    </div>
  );

  return (
    <Dropdown
      trigger={[ 'click' ]}
      placement="top"
      popupRender={() => panel}
      getPopupContainer={getPopupContainer}
      styles={{ root: { zIndex: 1100 } }}
    >
      <button
        type="button"
        className="player-menu player-menu--player"
        title="Picture size"
        aria-label="Picture size"
        onKeyDown={(e) => e.stopPropagation()}
      >
        <Icon name="aspect_ratio" />
        {percent === DEFAULT_SIZE_PERCENT ? null : <span className="player-menu__badge">{percent}%</span>}
      </button>
    </Dropdown>
  );
}

export default PlayerSizeControl;
