import "../assets/styles/Users.scss";
import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag } from "antd";
import { DeleteOutlined, EditOutlined, UserAddOutlined } from "@ant-design/icons";
import { type AuthUser, type UserRole } from "../../types/Auth";
import { useAPI } from "../contexts/APIProvider";
import { useAuth } from "../contexts/AuthProvider";
import { useDocument } from "../contexts/DocumentProvider";
import { LoadingBlock } from "../components/Loading";

interface UserFormValues {
  username: string;
  password: string;
  role: UserRole;
}

const ROLE_OPTIONS = [
  { value: 'user', label: 'User' },
  { value: 'admin', label: 'Administrator' }
];

/**
 * User management, reachable only by administrators - the route is hidden from
 * everyone else, and the server refuses these endpoints to them regardless.
 */
function Users() {
  const { api } = useAPI();
  const { user: currentUser } = useAuth();
  const { setTitle } = useDocument();
  const [ users, setUsers ] = useState<AuthUser[] | null>(null);
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

  const openEditor = useCallback((target: AuthUser | 'new') => {
    setError(null);
    setEditing(target);
    form.setFieldsValue(target === 'new' ?
      { username: '', password: '', role: 'user' }
      : { username: target.username, password: '', role: target.role }
    );
  }, [form]);

  const handleSubmit = useCallback(async (values: UserFormValues) => {
    if (!editing) {
      return;
    }
    setSubmitting(true);
    try {
      if (editing === 'new') {
        await api.createUser(values);
      }
      else {
        // An empty password box means "leave it alone" rather than "set it to
        // nothing", which is why it is not simply passed through.
        await api.updateUser(editing.id, {
          role: values.role,
          password: values.password || undefined
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
        </Form>
      </Modal>
    </div>
  );
}

export default Users;
