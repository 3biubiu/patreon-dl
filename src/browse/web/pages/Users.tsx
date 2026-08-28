import "../assets/styles/Users.scss";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Badge, Button, Form, Input, InputNumber, Modal, Popconfirm, Radio, Select, Space, Table, Tabs, Tag, Tooltip } from "antd";
import { CheckOutlined, CloseOutlined, DeleteOutlined, EditOutlined, HistoryOutlined, ReloadOutlined, UnlockOutlined, UserAddOutlined } from "@ant-design/icons";
import { type FormInstance } from "antd";
import { type AuthUser, type LoginLogEntry, type Registration, type UserRole } from "../../types/Auth";
import { DEFAULT_USER_QUOTA, type UserQuota } from "../../types/Quota";
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

/**
 * A daily limit is the same shape of choice as the creator restriction: a mode
 * and a value. Splitting them keeps "unlimited" from having to be spelled as
 * an empty box, and leaves zero free to mean what it says - nothing today.
 */
type QuotaMode = 'unlimited' | 'limited';

interface UserFormValues {
  username: string;
  password: string;
  role: UserRole;
  campaignAccess: CampaignAccess;
  visibleCampaigns: string[];
  postQuotaMode: QuotaMode;
  postQuota: number;
  videoQuotaMode: QuotaMode;
  videoQuota: number;
}

const ROLE_OPTIONS = [
  { value: 'user', label: 'User' },
  { value: 'admin', label: 'Administrator' }
];

const CAMPAIGN_ACCESS_OPTIONS = [
  { value: 'all', label: 'All creators' },
  { value: 'selected', label: 'Only selected' }
];

const QUOTA_MODE_OPTIONS = [
  { value: 'unlimited', label: 'Unlimited' },
  { value: 'limited', label: 'Limit to' }
];

/** The form's two fields for one limit, from the single value on the wire. */
function quotaFields(limit: number | null, fallback: number) {
  return {
    mode: (limit === null ? 'unlimited' : 'limited') as QuotaMode,
    value: limit === null ? fallback : limit
  };
}

/** How a limit reads in the table. */
function describeLimit(limit: number | null) {
  return limit === null ? 'Unlimited' : `${limit}/day`;
}

/** Enough to hold every creator in one go for all but the largest libraries. */
const CAMPAIGN_FETCH_SIZE = 500;

/**
 * How many sign-ins the panel shows. Deliberately short: this is a glance at
 * who has been in lately, not an audit tool, and the server keeps more than
 * this for anyone who needs to go further back.
 */
const LOGIN_LOG_SIZE = 10;

/**
 * The two halves of the page. Applications are a list of their own rather than
 * rows mixed into the users: an application is not an account, and the one
 * thing this page must never do is make the two look alike.
 */
type TabKey = 'users' | 'pending';

/** A sign-in time in full - the date alone would not say enough here. */
function describeLoginTime(at: string) {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString();
}

/**
 * User management, reachable only by administrators - the route is hidden from
 * everyone else, and the server refuses these endpoints to them regardless.
 */
function Users() {
  const { api } = useAPI();
  const { user: currentUser } = useAuth();
  const { setTitle } = useDocument();
  const [ tab, setTab ] = useState<TabKey>('users');
  const [ users, setUsers ] = useState<AuthUser[] | null>(null);
  const [ registrations, setRegistrations ] = useState<Registration[] | null>(null);
  /** The application currently being answered, so its row can say so. */
  const [ answering, setAnswering ] = useState<string | null>(null);
  const [ campaigns, setCampaigns ] = useState<{ id: string; name: string; }[] | null>(null);
  const [ error, setError ] = useState<string | null>(null);
  const [ editing, setEditing ] = useState<AuthUser | 'new' | null>(null);
  const [ submitting, setSubmitting ] = useState(false);
  const [ signInsFor, setSignInsFor ] = useState<AuthUser | null>(null);
  const [ loginLog, setLoginLog ] = useState<LoginLogEntry[] | null>(null);
  const [ loginLogError, setLoginLogError ] = useState<string | null>(null);
  const [ loginLogLoading, setLoginLogLoading ] = useState(false);
  const [ form ] = Form.useForm<UserFormValues>();

  useEffect(() => {
    setTitle('Users');
  }, [setTitle]);

  /**
   * Both lists together: approving an application removes it from one and adds
   * an account to the other, and showing half of that would be worse than
   * showing neither.
   */
  const refresh = useCallback(async () => {
    try {
      const [ userList, registrationList ] = await Promise.all([
        api.listUsers(),
        api.listRegistrations()
      ]);
      setUsers(userList);
      setRegistrations(registrationList);
      setError(null);
    }
    catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load users');
    }
  }, [api]);

  const handleApprove = useCallback(async (registration: Registration) => {
    setAnswering(registration.id);
    try {
      await api.approveRegistration(registration.id);
      await refresh();
    }
    catch (e) {
      setError(e instanceof Error ? e.message : 'Could not approve the application');
    }
    finally {
      setAnswering(null);
    }
  }, [api, refresh]);

  const handleReject = useCallback(async (registration: Registration) => {
    setAnswering(registration.id);
    try {
      await api.rejectRegistration(registration.id);
      await refresh();
    }
    catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reject the application');
    }
    finally {
      setAnswering(null);
    }
  }, [api, refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Asked for only when somebody opens the panel, and never with the user
   * table: placing addresses the server has not seen before means asking a
   * lookup service, and that is not a wait to put in front of a page that is
   * mostly opened to add a user.
   */
  const refreshLoginLog = useCallback(async (user: AuthUser) => {
    setLoginLogLoading(true);
    try {
      setLoginLog(await api.listLoginLog(LOGIN_LOG_SIZE, user.id));
      setLoginLogError(null);
    }
    catch (e) {
      setLoginLogError(e instanceof Error ? e.message : 'Could not load sign-ins');
    }
    finally {
      setLoginLogLoading(false);
    }
  }, [api]);

  const openSignIns = useCallback((user: AuthUser) => {
    // Cleared rather than left showing the previous account's rows while the
    // new ones load - they look enough alike to be misread.
    setLoginLog(null);
    setLoginLogError(null);
    setSignInsFor(user);
    void refreshLoginLog(user);
  }, [refreshLoginLog]);

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
    // A new account opens on the defaults every new account gets, so the form
    // shows what would happen anyway rather than something the server would
    // then override.
    const posts = quotaFields(
      target === 'new' ? DEFAULT_USER_QUOTA.posts : target.quota.posts,
      DEFAULT_USER_QUOTA.posts ?? 0
    );
    const videos = quotaFields(
      target === 'new' ? DEFAULT_USER_QUOTA.videos : target.quota.videos,
      DEFAULT_USER_QUOTA.videos ?? 0
    );
    form.setFieldsValue({
      username: target === 'new' ? '' : target.username,
      password: '',
      role: target === 'new' ? 'user' : target.role,
      campaignAccess:
        target === 'new' ? 'all' : (target.visibleCampaigns ? 'selected' : 'all'),
      visibleCampaigns: target === 'new' ? [] : (target.visibleCampaigns || []),
      postQuotaMode: posts.mode,
      postQuota: posts.value,
      videoQuotaMode: videos.mode,
      videoQuota: videos.value
    });
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
    // Same for the allowance: an administrator is never limited, so the numbers
    // the form was last showing are not sent along with a promotion.
    const quota: UserQuota = values.role === 'admin' ?
      { posts: null, videos: null } : {
        posts: values.postQuotaMode === 'unlimited' ? null : (values.postQuota ?? 0),
        videos: values.videoQuotaMode === 'unlimited' ? null : (values.videoQuota ?? 0)
      };
    try {
      if (editing === 'new') {
        await api.createUser({
          username: values.username,
          password: values.password,
          role: values.role,
          visibleCampaigns,
          quota
        });
      }
      else {
        // An empty password box means "leave it alone" rather than "set it to
        // nothing", which is why it is not simply passed through.
        await api.updateUser(editing.id, {
          role: values.role,
          password: values.password || undefined,
          visibleCampaigns,
          quota
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

  const handleUnban = useCallback(async (target: AuthUser) => {
    try {
      await api.unbanUser(target.id);
      await refresh();
    }
    catch (e) {
      setError(e instanceof Error ? e.message : 'Could not lift the ban');
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
      <Tabs
        activeKey={tab}
        onChange={(key) => setTab(key as TabKey)}
        items={[
          {
            key: 'users',
            label: 'Users',
            children: (
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
                        {
                          // The reason - which sign-ins tripped the rule - is
                          // a hover away rather than a column, since almost
                          // every row has nothing to say.
                          user.banned ? (
                            <Tooltip title={user.banReason || undefined}>
                              <Tag color="red">Banned</Tag>
                            </Tooltip>
                          ) : null
                        }
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
                    title: 'Daily limit',
                    key: 'quota',
                    render: (_, user) => {
                      if (user.role === 'admin') {
                        return <Tag>Unlimited</Tag>;
                      }
                      const { posts, videos } = user.quota;
                      if (posts === null && videos === null) {
                        return <Tag>Unlimited</Tag>;
                      }
                      return (
                        <Tooltip title={`Posts: ${describeLimit(posts)} · Videos: ${describeLimit(videos)}`}>
                          <Space size={4}>
                            <Tag color={posts === null ? undefined : 'blue'}>
                              {`Posts ${describeLimit(posts)}`}
                            </Tag>
                            <Tag color={videos === null ? undefined : 'blue'}>
                              {`Videos ${describeLimit(videos)}`}
                            </Tag>
                          </Space>
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
                        {
                          user.banned ? (
                            <Popconfirm
                              title={`Lift the ban on ${user.username}?`}
                              description={user.banReason || undefined}
                              okText="Unban"
                              onConfirm={() => void handleUnban(user)}
                            >
                              <Tooltip title="Lift ban">
                                <Button
                                  type="text"
                                  size="small"
                                  icon={<UnlockOutlined />}
                                  aria-label={`Lift the ban on ${user.username}`}
                                />
                              </Tooltip>
                            </Popconfirm>
                          ) : null
                        }
                        <Tooltip title="Recent sign-ins">
                          <Button
                            type="text"
                            size="small"
                            icon={<HistoryOutlined />}
                            aria-label={`Recent sign-ins for ${user.username}`}
                            onClick={() => openSignIns(user)}
                          />
                        </Tooltip>
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
            )
          },
          {
            key: 'pending',
            // The count is the whole reason an administrator would look here,
            // so it goes on the tab rather than inside it. Nothing is shown
            // when there is nothing waiting.
            label: (
              <Badge count={registrations?.length || 0} size="small" offset={[ 10, -2 ]}>
                Applications
              </Badge>
            ),
            children: (
              <Table<Registration>
                rowKey="id"
                dataSource={registrations || []}
                loading={registrations === null}
                pagination={false}
                locale={{ emptyText: 'No applications waiting' }}
                columns={[
                  {
                    title: 'Username',
                    dataIndex: 'username'
                  },
                  {
                    title: 'Applied',
                    dataIndex: 'requestedAt',
                    render: (requestedAt: string) => describeLoginTime(requestedAt)
                  },
                  {
                    title: '',
                    key: 'actions',
                    align: 'right',
                    render: (_, registration) => (
                      <Space size={4}>
                        <Popconfirm
                          title={`Approve ${registration.username}?`}
                          description="The account is created as an ordinary user on the default daily limit. You can change that afterwards."
                          okText="Approve"
                          onConfirm={() => void handleApprove(registration)}
                        >
                          <Button
                            type="text"
                            size="small"
                            icon={<CheckOutlined />}
                            loading={answering === registration.id}
                            aria-label={`Approve ${registration.username}`}
                          >
                            Approve
                          </Button>
                        </Popconfirm>
                        <Popconfirm
                          title={`Reject ${registration.username}?`}
                          description="The application is discarded. No account is created, and they can apply again."
                          okText="Reject"
                          okButtonProps={{ danger: true }}
                          onConfirm={() => void handleReject(registration)}
                        >
                          <Button
                            type="text"
                            size="small"
                            danger
                            icon={<CloseOutlined />}
                            loading={answering === registration.id}
                            aria-label={`Reject ${registration.username}`}
                          >
                            Reject
                          </Button>
                        </Popconfirm>
                      </Space>
                    )
                  }
                ]}
              />
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
          <QuotaFields form={form} />
        </Form>
      </Modal>
      <Modal
        open={!!signInsFor}
        title={`Recent sign-ins${signInsFor ? ` - ${signInsFor.username}` : ''}`}
        width={760}
        onCancel={() => setSignInsFor(null)}
        footer={[
          <Button
            key="refresh"
            icon={<ReloadOutlined />}
            loading={loginLogLoading}
            onClick={() => signInsFor && void refreshLoginLog(signInsFor)}
          >
            Refresh
          </Button>,
          <Button key="close" type="primary" onClick={() => setSignInsFor(null)}>
            Close
          </Button>
        ]}
      >
        {
          loginLogError ? (
            <Alert className="mb-3" type="error" title={loginLogError} showIcon
              closable={{ onClose: () => setLoginLogError(null) }} />
          ) : null
        }
        <Table<LoginLogEntry>
          className="users__login-log"
          rowKey={(entry, index) => `${entry.at}-${index ?? 0}`}
          dataSource={loginLog || []}
          loading={loginLog === null && loginLogLoading}
          pagination={false}
          size="small"
          locale={{ emptyText: 'Nothing recorded for this account yet' }}
          columns={[
            {
              title: 'When',
              dataIndex: 'at',
              render: (at: string) => describeLoginTime(at)
            },
            {
              title: 'IP',
              dataIndex: 'ip'
            },
            {
              title: 'Location',
              dataIndex: 'location',
              render: (location: string | null, entry) => (
                // An address that could not be placed is left blank rather
                // than called unknown - the lookup may simply have been
                // unreachable, which says nothing about the sign-in itself.
                <Space size={4} wrap>
                  <span>{location || '—'}</span>
                  {entry.isp ? <Tag>{entry.isp}</Tag> : null}
                </Space>
              )
            },
            {
              title: 'Client',
              dataIndex: 'userAgent',
              ellipsis: true,
              render: (userAgent: string | null) => (
                <Tooltip title={userAgent || undefined}>
                  <span className="users__user-agent">{userAgent || '—'}</span>
                </Tooltip>
              )
            },
            {
              title: 'Result',
              key: 'result',
              align: 'right',
              render: (_, entry) => (
                entry.success ? <Tag color="green">Signed in</Tag> : (
                  <Tooltip title="The password did not match">
                    <Tag color="red">Failed</Tag>
                  </Tooltip>
                )
              )
            }
          ]}
        />
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

/**
 * The daily allowance, which only applies to ordinary users.
 *
 * Two limits, each either lifted or a number. Its own component for the same
 * reason the creator fields are: watching the role and the two modes should
 * re-render this and not the user table above it.
 */
function QuotaFields(props: { form: FormInstance<UserFormValues>; }) {
  const { form } = props;
  const role = Form.useWatch('role', form);

  if (role === 'admin') {
    return null;
  }

  return (
    <>
      <QuotaField
        form={form}
        label="Posts per day"
        modeName="postQuotaMode"
        valueName="postQuota"
        extra="Counted when a post is opened. Going back to one already opened today costs nothing. Resets at 08:00 Beijing time."
      />
      <QuotaField
        form={form}
        label="Videos per day"
        modeName="videoQuotaMode"
        valueName="videoQuota"
        extra="Counted when a video starts playing. Replaying one already watched today costs nothing."
      />
    </>
  );
}

function QuotaField(props: {
  form: FormInstance<UserFormValues>;
  label: string;
  modeName: 'postQuotaMode' | 'videoQuotaMode';
  valueName: 'postQuota' | 'videoQuota';
  extra: string;
}) {
  const { form, label, modeName, valueName, extra } = props;
  const mode = Form.useWatch(modeName, form);

  return (
    <Form.Item label={label} extra={extra} className="mb-3">
      <Space align="start">
        <Form.Item name={modeName} noStyle>
          <Radio.Group options={QUOTA_MODE_OPTIONS} optionType="button" />
        </Form.Item>
        {
          mode === 'limited' ? (
            <Form.Item
              name={valueName}
              noStyle
              rules={[ { required: true, message: 'Enter a number' } ]}
            >
              {/* Zero is allowed and means nothing today - a real setting, not
                  a way of saying "unlimited". */}
              <InputNumber min={0} step={1} precision={0} style={{ width: 100 }} />
            </Form.Item>
          ) : null
        }
      </Space>
    </Form.Item>
  );
}

export default Users;
