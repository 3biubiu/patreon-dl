import { Segmented } from "antd";
import { type PostListLayout } from "../../types/Settings";

interface PostLayoutSwitchProps {
  value: PostListLayout;
  onChange: (layout: PostListLayout) => void;
}

const LAYOUTS: { value: PostListLayout; icon: string; label: string; }[] = [
  { value: 'card', icon: 'view_agenda', label: 'Card view' },
  { value: 'grid', icon: 'grid_view', label: 'Grid view' },
  { value: 'list', icon: 'view_list', label: 'List view' }
];

function PostLayoutSwitch(props: PostLayoutSwitchProps) {
  const { value, onChange } = props;

  return (
    <Segmented
      aria-label="Post layout"
      value={value}
      onChange={(layout) => onChange(layout as PostListLayout)}
      options={LAYOUTS.map((layout) => ({
        value: layout.value,
        label: (
          <span
            className="material-icons"
            style={{ fontSize: '1.1rem', display: 'block' }}
            title={layout.label}
            aria-label={layout.label}
          >
            {layout.icon}
          </span>
        )
      }))}
    />
  );
}

export default PostLayoutSwitch;
