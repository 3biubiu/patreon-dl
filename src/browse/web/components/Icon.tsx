interface IconProps {
  name: string;
  /** Render with the outlined variant of the font instead of the filled one. */
  outlined?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Material Icons draws its glyphs through font ligatures, so the icon name sits
 * in the DOM as plain English text. Page translators rewrite it like any other
 * text - Google Translate on mobile turns "play_arrow" into "播放箭头" - and the
 * translated words get painted where the glyph should be, because there is no
 * ligature for them. `translate="no"` (plus the legacy `notranslate` class)
 * keeps translators away from the name.
 */
function Icon(props: IconProps) {
  const { name, outlined = false, className, style } = props;
  const classNames = [
    outlined ? 'material-icons-outlined' : 'material-icons',
    'notranslate',
    className
  ].filter(Boolean).join(' ');

  return (
    <span className={classNames} style={style} translate="no">
      {name}
    </span>
  );
}

export default Icon;
