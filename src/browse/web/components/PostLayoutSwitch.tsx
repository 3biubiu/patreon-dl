import { Button, ButtonGroup } from "react-bootstrap";
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
    <ButtonGroup className="ms-2" aria-label="Post layout">
      {
        LAYOUTS.map((layout) => (
          <Button
            key={`post-layout-${layout.value}`}
            variant={value === layout.value ? 'primary' : 'outline-primary'}
            active={value === layout.value}
            title={layout.label}
            aria-label={layout.label}
            aria-pressed={value === layout.value}
            onClick={() => onChange(layout.value)}
          >
            <span className="material-icons d-flex" style={{ fontSize: '1.1rem' }}>{layout.icon}</span>
          </Button>
        ))
      }
    </ButtonGroup>
  );
}

export default PostLayoutSwitch;
