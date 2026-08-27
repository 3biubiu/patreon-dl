import "../assets/styles/Users.scss";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Form, Input, Modal, Popconfirm, Radio, Select, Space, Table, Tag, Tooltip } from "antd";
import { DeleteOutlined, EditOutlined, UserAddOutlined } from "@ant-design/icons";
import { type FormInstance } from "antd";
import { type AuthUser, type UserRole } from "../../types/Auth";
import { useAPI } from "../contexts/APIProvider";
import { useAuth } from "../contexts/AuthProvider";
import { useDocument } from "../contexts/DocumentProvider";
import { LoadingBlock } from "../components/Loading";

/**
 * The permission is two fields in the form and one on the wire: "all" sends
 * `null`, "selected" sends the list. Splitting them keeps an empty selection
 * from reading as "not set yet" - it means no creators, and the form has to be
 * able to say so.
 */
type CampaignAccess = 'all' | 'selected';

interface UserFormValues {
  username: string;
  password: string;
  role: UserRole;
  campaignAccess: CampaignAccess;
  visibleCampaigns: string[];
}

const ROLE_OPTIONS = [
  { value: 'user', label: 'User' },
  { value: 'admin', label: 'Administrator' }
];

const CAMPAIGN_ACCESS_OPTIONS = [
  { value: 'all', label: 'All creators' },
  { value: 'selected', label: 'Only selected' }
];

/** Enough to hold every creator in one go for all but the largest libraries. */
const CAMPAIGN_FETCH_SIZE = 500;

/**
 * User management, reachable only by administrators - the route is hidden from
 * everyone else, and the server refuses these endpoints to them regardless.
 */
function Users() {
  const { api } = useAPI();
  const { user: currentUser } = useAuth();
  const { setTitle } = useDocument();
  const [ users, setUsers ] = useState<AuthUser[] | null>(null);
  const [ campaigns, setCampaigns ] = useState<{ id: string; name: string; }[] | null>(null);
  const [ error, setError ] = useState<string | null>(null);
  const [ editing, setEditing ] = useState<AuthUser | 'new' | null>(null);
  const [ submitting, setSubmitting ] = useState(false);
  const [ form ] = Form.useForm<UserFormValues>();

  useEffect(() => {
    setTitle('Users');
  }, [setTitle]);

  const refresh = useCallback(async () => {
    try {
      setUsers(await api.listUsers());
      setError(null);
    }
    catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load users');
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The creators to choose from. An administrator is unrestricted, so this is
  // the full list - which is also what makes it the right list to grant from.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        let list = await api.getCampaignList({ itemsPerPage: CAMPAIGN_FETCH_SIZE });
        if (list.total > list.campaigns.length) {
          list = await api.getCampaignList({ itemsPerPage: list.total });
        }
        if (!cancelled) {
          setCampaigns(list.campaigns.map(({ id, name }) => ({ id, name })));
        }
      }
      catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Could not load creators');
          setCampaigns([]);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [api]);

  const campaignOptions = useMemo(
    () => (campaigns || []).map(({ id, name }) => ({ value: id, label: name })),
    [campaigns]
  );

  const campaignNames = useMemo(
    () => new Map((campaigns || []).map(({ id, name }) => [ id, name ])),
    [campaigns]
  );

  // A campaign can be removed from the library while an account still names
  // it, so an id with no name left is shown as itself rather than dropped -
  // a permission that silently loses entries is worse than an ugly one.
  const describeScope = useCallback((ids: string[]) =>
    ids.map((id) => campaignNames.get(id) || id), [campaignNames]);

  const openEditor = useCallback((target: AuthUser | 'new') => {
    setError(null);
    setEditing(target);
    form.setFieldsValue(target === 'new' ?
      { username: '', password: '', role: 'user', campaignAccess: 'all', visibleCampaigns: [] }
      : {
        username: target.username,
        password: '',
        role: target.role,
        campaignAccess: target.visibleCampaigns ? 'selected' : 'all',
        visibleCampaigns: target.visibleCampaigns || []
      }
    );
  }, [form]);

  const handleSubmit = useCallback(async (values: UserFormValues) => {
    if (!editing) {
      return;
    }
    setSubmitting(true);
    // An administrator is unrestricted whatever the form last showed, so the
    // selection is not carried over when someone is promoted.
    const visibleCampaigns =
      values.role === 'admin' || values.campaignAccess === 'all' ?
        null : (values.visibleCampaigns || []);
    try {
      if (editing === 'new') {
        await api.createUser({
          username: values.username,
          password: values.password,
          role: values.role,
          visibleCampaigns
        });
      }
      else {
        // An empty password box means "leave it alone" rather than "set it to
        // nothing", which is why it is not simply passed through.
        await api.updateUser(editing.id, {
          role: values.role,
          password: values.password || undefined,
          visibleCampaigns
        });
      }
      setEditing(null);
      await refresh();
    }
    catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save user');
    }
    finally {
      setSubmitting(false);
    }
  }, [api, editing, refresh]);

  const handleDelete = useCallback(async (target: AuthUser) => {
    try {
      await api.deleteUser(target.id);
      await refresh();
    }
    catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove user');
    }
  }, [api, refresh]);

  if (!users) {
    return <LoadingBlock className="mt-5" minHeight="60vh" />;
  }

  return (
    <div className="users">
      <div className="users__header">
        <h2 className="m-0">Users</h2>
        <Button
          type="primary"
          icon={<UserAddOutlined />}
          onClick={() => openEditor('new')}
        >
          Add user
        </Button>
      </div>
      {
        error ? (
          <Alert className="mb-3" type="error" message={error} showIcon closable
            onClose={() => setError(null)} />
        ) : null
      }
      <Table<AuthUser>
        rowKey="id"
        dataSource={users}
        pagination={false}
        columns={[
          {
            title: 'Username',
            dataIndex: 'username',
            render: (username: string, user) => (
              <Space size={8}>
                <span>{username}</span>
                {user.id === currentUser?.id ? <Tag>you</Tag> : null}
              </Space>
            )
          },
          {
            title: 'Role',
            dataIndex: 'role',
            render: (role: UserRole) => (
              <Tag color={role === 'admin' ? 'green' : undefined}>
                {role === 'admin' ? 'Administrator' : 'User'}
              </Tag>
            )
          },
          {
            title: 'Creators',
            dataIndex: 'visibleCampaigns',
            render: (visibleCampaigns: string[] | null) => {
              if (!visibleCampaigns) {
                return <Tag>All</Tag>;
              }
              if (visibleCampaigns.length === 0) {
                return <Tag color="red">None</Tag>;
              }
              const names = describeScope(visibleCampaigns);
              return (
                <Tooltip title={names.join(', ')}>
                  <Tag color="blue">
                    {names.length === 1 ? names[0] : `${names.length} creators`}
                  </Tag>
                </Tooltip>
              );
            }
          },
          {
            title: 'Added',
            dataIndex: 'createdAt',
            render: (createdAt: string) => new Date(createdAt).toLocaleDateString()
          },
          {
            title: '',
            key: 'actions',
            align: 'right',
            render: (_, user) => (
              <Space size={4}>
                <Button
                  type="text"
                  size="small"
                  icon={<EditOutlined />}
                  aria-label={`Edit ${user.username}`}
                  onClick={() => openEditor(user)}
                />
                <Popconfirm
                  title={`Remove ${user.username}?`}
                  okText="Remove"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => void handleDelete(user)}
                >
                  <Button
                    type="text"
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    aria-label={`Remove ${user.username}`}
                    disabled={user.id === currentUser?.id}
                  />
                </Popconfirm>
              </Space>
            )
          }
        ]}
      />
      <Modal
        open={!!editing}
        title={editing === 'new' ? 'Add user' : `Edit ${editing ? editing.username : ''}`}
        okText="Save"
        confirmLoading={submitting}
        onCancel={() => setEditing(null)}
        onOk={() => form.submit()}
      >
        <Form<UserFormValues>
          form={form}
          layout="vertical"
          requiredMark={false}
          onFinish={(values) => void handleSubmit(values)}
        >
          <Form.Item
            name="username"
            label="Username"
            rules={editing === 'new' ? [ { required: true, message: 'Enter a username' } ] : []}
          >
            {/* The username is what the session and the file key on, so it is
                shown for context but not editable. */}
            <Input disabled={editing !== 'new'} />
          </Form.Item>
          <Form.Item
            name="password"
            label={editing === 'new' ? 'Password' : 'New password'}
            extra={editing === 'new' ? undefined : 'Leave blank to keep the current password'}
            rules={editing === 'new' ? [ { required: true, message: 'Enter a password' } ] : []}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="role" label="Role">
            <Select options={ROLE_OPTIONS} />
          </Form.Item>
          <CampaignAccessFields
            form={form}
            options={campaignOptions}
            loading={campaigns === null}
          />
        </Form>
      </Modal>
    </div>
  );
}

/**
 * The creator restriction, which only applies to ordinary users.
 *
 * Its own component so that watching the role and the access mode re-renders
 * this and not the whole page - the user table above it is not cheap.
 */
function CampaignAccessFields(props: {
  form: FormInstance<UserFormValues>;
  options: { value: string; label: string; }[];
  loading: boolean;
}) {
  const { form, options, loading } = props;
  const role = Form.useWatch('role', form);
  const access = Form.useWatch('campaignAccess', form);

  if (role === 'admin') {
    return (
      <Alert
        type="info"
        showIcon
        title="Administrators can see every creator"
        description={
          'Anyone who can edit permissions can lift their own, so a restriction ' +
          'here would not hold. Make the account a user to limit it.'
        }
      />
    );
  }

  return (
    <>
      <Form.Item name="campaignAccess" label="Creators">
        <Radio.Group options={CAMPAIGN_ACCESS_OPTIONS} optionType="button" />
      </Form.Item>
      {
        access === 'selected' ? (
          <Form.Item
            name="visibleCampaigns"
            extra="Everything belonging to the other creators is hidden and refused - their posts, media and files, not just their place in the list."
          >
            <Select
              mode="multiple"
              allowClear
              loading={loading}
              options={options}
              showSearch={{ optionFilterProp: 'label' }}
              placeholder="Choose the creators this user may see"
            />
          </Form.Item>
        ) : null
      }
    </>
  );
}

export default Users;
