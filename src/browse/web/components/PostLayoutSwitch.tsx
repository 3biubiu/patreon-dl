import { Segmented } from "antd";
import { AppstoreOutlined, ProfileOutlined, UnorderedListOutlined } from "@ant-design/icons";
import { type PostListLayout } from "../../types/Settings";

interface PostLayoutSwitchProps {
  value: PostListLayout;
  onChange: (layout: PostListLayout) => void;
}

// antd's own icons rather than the Material font used elsewhere: a
// `.material-icons` span carries its own font-size and line-height, which do
// not line up inside a Segmented item and left the glyphs sitting off-centre.
const LAYOUTS: { value: PostListLayout; icon: React.ReactNode; label: string; }[] = [
  { value: 'card', icon: <ProfileOutlined />, label: 'Card view' },
  { value: 'grid', icon: <AppstoreOutlined />, label: 'Grid view' },
  { value: 'list', icon: <UnorderedListOutlined />, label: 'List view' }
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
          <span title={layout.label} aria-label={layout.label}>
            {layout.icon}
          </span>
        )
      }))}
    />
  );
}

export default PostLayoutSwitch;
