import "../assets/styles/Users.scss";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Badge, Button, Form, Input, InputNumber, Modal, Popconfirm, Radio, Select, Space, Switch, Table, Tabs, Tag, Tooltip } from "antd";
import { CheckOutlined, CloseOutlined, DeleteOutlined, EditOutlined, HistoryOutlined, ReloadOutlined, SafetyCertificateOutlined, UnlockOutlined, UserAddOutlined } from "@ant-design/icons";
import { type FormInstance } from "antd";
import {
  DEFAULT_CAN_TRANSCRIBE_VIDEO,
  DEFAULT_CAN_TRANSLATE_PDF,
  DEFAULT_CAN_UPLOAD_TRANSCRIPTION,
  DEFAULT_CAN_VIEW_SUBTITLES,
  type AuthUser,
  type LoginLogEntry,
  type Registration,
  type UserRole
} from "../../types/Auth";
import { DEFAULT_USER_QUOTA, type UserQuota } from "../../types/Quota";
import {
  DAILY_TRANSCRIPTION_SECONDS,
  DAILY_TRANSCRIPTION_VIDEOS
} from "../../types/TranscriptionQuota";
import { describeLoginRegion, LOGIN_REGION_SEPARATOR } from "../../types/LoginRegion";
import { useAPI } from "../contexts/APIProvider";
import { useAuth } from "../contexts/AuthProvider";
import { useDocument } from "../contexts/DocumentProvider";
import { LoadingBlock } from "../components/Loading";
import { useLanguage } from "../contexts/LanguageProvider";

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

/**
 * Where an account may sign in from - the same mode-and-value split as the
 * creator restriction, for the same reason: an empty selection has to be able
 * to mean "nowhere" rather than "not set yet".
 */
type LoginRegionAccess = 'anywhere' | 'selected';

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
  loginRegionAccess: LoginRegionAccess;
  loginRegions: string[];
  canTranslatePdf: boolean;
  canUploadTranscription: boolean;
  canTranscribeVideo: boolean;
  canViewSubtitles: boolean;
}

/**
 * How much of the sign-in log is read to build the list of places to choose
 * from. The server keeps this many at most, so this is all of it.
 */
const LOGIN_REGION_FETCH_SIZE = 500;

/**
 * Every rule that would cover this place, from the country down.
 *
 * `中国/广东省/深圳` offers 中国, 中国/广东省 and 中国/广东省/深圳 - which is
 * what makes one list able to say "anywhere in China" and "Shenzhen only"
 * without asking the administrator to know how the rules are written.
 */
function loginRegionPrefixes(path: string): string[] {
  const parts = path.split(LOGIN_REGION_SEPARATOR);
  return parts.map((_, index) => parts.slice(0, index + 1).join(LOGIN_REGION_SEPARATOR));
}

/** The form's two fields for one limit, from the single value on the wire. */
function quotaFields(limit: number | null, fallback: number) {
  return {
    mode: (limit === null ? 'unlimited' : 'limited') as QuotaMode,
    value: limit === null ? fallback : limit
  };
}

/** How a limit reads in the table. */
function describeLimit(limit: number | null) {
  const { t } = useLanguage();
  return limit === null ? t('quota_unlimited') : t('per_day', { value: limit });
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
  /** The second dialog, where everything this account may and may not do lives. */
  const [ permissionsOpen, setPermissionsOpen ] = useState(false);
  const [ signInsFor, setSignInsFor ] = useState<AuthUser | null>(null);
  const [ loginLog, setLoginLog ] = useState<LoginLogEntry[] | null>(null);
  const [ loginLogError, setLoginLogError ] = useState<string | null>(null);
  const [ loginLogLoading, setLoginLogLoading ] = useState(false);
  /** The places to choose from, read out of the sign-in log. `null` until asked for. */
  const [ knownRegions, setKnownRegions ] = useState<string[] | null>(null);
  const [ form ] = Form.useForm<UserFormValues>();
  const { t } = useLanguage();

  const roleOptions = useMemo(() => [
    { value: 'user', label: t('role_user') },
    { value: 'admin', label: t('role_admin') }
  ], [t]);

  useEffect(() => {
    setTitle(t('users_heading'));
  }, [setTitle, t]);

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
      setError(e instanceof Error ? e.message : t('could_not_load_users'));
    }
  }, [api, t]);

  const handleApprove = useCallback(async (registration: Registration) => {
    setAnswering(registration.id);
    try {
      await api.approveRegistration(registration.id);
      await refresh();
    }
    catch (e) {
      setError(e instanceof Error ? e.message : t('could_not_approve'));
    }
    finally {
      setAnswering(null);
    }
  }, [api, refresh, t]);

  const handleReject = useCallback(async (registration: Registration) => {
    setAnswering(registration.id);
    try {
      await api.rejectRegistration(registration.id);
      await refresh();
    }
    catch (e) {
      setError(e instanceof Error ? e.message : t('could_not_reject'));
    }
    finally {
      setAnswering(null);
    }
  }, [api, refresh, t]);

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
      setLoginLogError(e instanceof Error ? e.message : t('could_not_load_signins'));
    }
    finally {
      setLoginLogLoading(false);
    }
  }, [api, t]);

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
        // Only the id and the name are kept below, so the per-creator totals
        // are not worth the four table aggregates they cost.
        let list = await api.getCampaignList({
          itemsPerPage: CAMPAIGN_FETCH_SIZE, withCounts: false
        });
        if (list.total > list.campaigns.length) {
          list = await api.getCampaignList({
            itemsPerPage: list.total, withCounts: false
          });
        }
        if (!cancelled) {
          setCampaigns(list.campaigns.map(({ id, name }) => ({ id, name })));
        }
      }
      catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : t('could_not_load_creators'));
          setCampaigns([]);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [api, t]);

  /**
   * The places this server has actually seen anybody sign in from, which is
   * what the region restriction is chosen out of. There is no list of every
   * city in the world here on purpose: the rules are matched against whatever
   * the location service answers, so the only names guaranteed to match are
   * ones it has already given us.
   *
   * Asked for when the editor is opened rather than with the page, for the
   * reason the sign-in panel is - see `refreshLoginLog`. Once, and then kept:
   * reopening the form should not mean another round of lookups.
   */
  useEffect(() => {
    if (!editing || knownRegions !== null) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const entries = await api.listLoginLog(LOGIN_REGION_FETCH_SIZE);
        if (!cancelled) {
          const paths = new Set<string>();
          for (const entry of entries) {
            if (entry.regionPath) {
              for (const prefix of loginRegionPrefixes(entry.regionPath)) {
                paths.add(prefix);
              }
            }
          }
          setKnownRegions([ ...paths ].sort());
        }
      }
      catch {
        // Not an error worth showing: the field still works, it just has
        // nothing to suggest, and an administrator can type a place instead.
        if (!cancelled) {
          setKnownRegions([]);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [api, editing, knownRegions]);

  const loginRegionOptions = useMemo(
    () => (knownRegions || []).map((path) => ({
      value: path,
      label: describeLoginRegion(path)
    })),
    [knownRegions]
  );

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
    // Always on the account itself, never on whichever dialog was last open.
    setPermissionsOpen(false);
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
      videoQuota: videos.value,
      loginRegionAccess:
        target === 'new' ? 'anywhere' : (target.loginRegions ? 'selected' : 'anywhere'),
      loginRegions: target === 'new' ? [] : (target.loginRegions || []),
      canTranslatePdf:
        target === 'new' ? DEFAULT_CAN_TRANSLATE_PDF : target.canTranslatePdf,
      canUploadTranscription:
        target === 'new' ? DEFAULT_CAN_UPLOAD_TRANSCRIPTION : target.canUploadTranscription,
      canTranscribeVideo:
        target === 'new' ? DEFAULT_CAN_TRANSCRIBE_VIDEO : target.canTranscribeVideo,
      canViewSubtitles:
        target === 'new' ? DEFAULT_CAN_VIEW_SUBTITLES : target.canViewSubtitles
    });
  }, [form]);

  /**
   * Closes the permissions dialog, but not over a limit that is not a number:
   * those boxes are in there, and a form that quietly turned an empty one into
   * zero would be the strictest setting arrived at by accident.
   */
  const closePermissions = useCallback(() => {
    void form.validateFields([ 'postQuota', 'videoQuota' ])
      .then(() => setPermissionsOpen(false))
      // Nothing to report here - the field itself says what is wrong, and it
      // is on screen.
      .catch(() => undefined);
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
    // And the same again for where the account may sign in from: an
    // administrator is never pinned to a region, so a selection the form was
    // showing is not carried along with a promotion.
    const loginRegions =
      values.role === 'admin' || values.loginRegionAccess === 'anywhere' ?
        null : (values.loginRegions || []);
    // An administrator always has it, so a promotion hands it over rather than
    // carrying a denial the server would ignore anyway.
    const canTranslatePdf = values.role === 'admin' || values.canTranslatePdf === true;
    // And the same for uploading, for the same reason.
    const canUploadTranscription =
      values.role === 'admin' || values.canUploadTranscription === true;
    // And for asking the library to transcribe something, again for the same
    // reason - an administrator has it whatever the switch was left on.
    const canTranscribeVideo =
      values.role === 'admin' || values.canTranscribeVideo === true;
    const canViewSubtitles =
      values.role === 'admin' || values.canViewSubtitles === true;
    try {
      if (editing === 'new') {
        await api.createUser({
          username: values.username,
          password: values.password,
          role: values.role,
          visibleCampaigns,
          quota,
          loginRegions,
          canTranslatePdf,
          canUploadTranscription,
          canTranscribeVideo,
          canViewSubtitles
        });
      }
      else {
        // An empty password box means "leave it alone" rather than "set it to
        // nothing", which is why it is not simply passed through.
        await api.updateUser(editing.id, {
          role: values.role,
          password: values.password || undefined,
          visibleCampaigns,
          quota,
          loginRegions,
          canTranslatePdf,
          canUploadTranscription,
          canTranscribeVideo,
          canViewSubtitles
        });
      }
      setEditing(null);
      setPermissionsOpen(false);
      await refresh();
    }
    catch (e) {
      setError(e instanceof Error ? e.message : t('could_not_save_user'));
    }
    finally {
      setSubmitting(false);
    }
  }, [api, editing, refresh, t]);

  const handleDelete = useCallback(async (target: AuthUser) => {
    try {
      await api.deleteUser(target.id);
      await refresh();
    }
    catch (e) {
      setError(e instanceof Error ? e.message : t('could_not_remove_user'));
    }
  }, [api, refresh, t]);

  const handleUnban = useCallback(async (target: AuthUser) => {
    try {
      await api.unbanUser(target.id);
      await refresh();
    }
    catch (e) {
      setError(e instanceof Error ? e.message : t('could_not_lift_ban'));
    }
  }, [api, refresh, t]);

  if (!users) {
    return <LoadingBlock className="mt-5" minHeight="60vh" />;
  }

  return (
    <div className="users">
      <div className="users__header">
        <h2 className="m-0">{t('users_heading')}</h2>
        <Button
          type="primary"
          icon={<UserAddOutlined />}
          onClick={() => openEditor('new')}
        >
          {t('add_user')}
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
            label: t('users_heading'),
            children: (
              <Table<AuthUser>
                className="users__table"
                rowKey="id"
                dataSource={users}
                pagination={false}
                columns={[
                  {
                    title: t('login_username'),
                    dataIndex: 'username',
                    render: (username: string, user) => (
                      <Space size={8}>
                        <span>{username}</span>
                        {user.id === currentUser?.id ? <Tag>{t('tag_you')}</Tag> : null}
                        {
                          // The reason - which sign-ins tripped the rule - is
                          // a hover away rather than a column, since almost
                          // every row has nothing to say.
                          user.banned ? (
                            <Tooltip title={user.banReason || undefined}>
                              <Tag color="red">{t('banned')}</Tag>
                            </Tooltip>
                          ) : null
                        }
                      </Space>
                    )
                  },
                  {
                    title: t('role'),
                    dataIndex: 'role',
                    render: (role: UserRole) => (
                      <Tag color={role === 'admin' ? 'green' : undefined}>
                        {role === 'admin' ? t('role_admin') : t('role_user')}
                      </Tag>
                    )
                  },
                  {
                    title: t('nav_creators'),
                    dataIndex: 'visibleCampaigns',
                    render: (visibleCampaigns: string[] | null) => {
                      if (!visibleCampaigns) {
                        return <Tag>{t('access_all')}</Tag>;
                      }
                      if (visibleCampaigns.length === 0) {
                        return <Tag color="red">{t('access_none')}</Tag>;
                      }
                      const names = describeScope(visibleCampaigns);
                      return (
                        <Tooltip title={names.join(', ')}>
                          <Tag color="blue">
                            {names.length === 1 ? names[0] : t('creators_count', { count: names.length })}
                          </Tag>
                        </Tooltip>
                      );
                    }
                  },
                  {
                    title: t('daily_limit'),
                    key: 'quota',
                    render: (_, user) => {
                      if (user.role === 'admin') {
                        return <Tag>{t('quota_unlimited')}</Tag>;
                      }
                      const { posts, videos } = user.quota;
                      if (posts === null && videos === null) {
                        return <Tag>{t('quota_unlimited')}</Tag>;
                      }
                      return (
                        <Tooltip title={t('quota_posts_videos', { posts: describeLimit(posts), videos: describeLimit(videos) })}>
                          <Space size={4}>
                            <Tag color={posts === null ? undefined : 'blue'}>
                              {t('posts_limit', { limit: describeLimit(posts) })}
                            </Tag>
                            <Tag color={videos === null ? undefined : 'blue'}>
                              {t('videos_limit', { limit: describeLimit(videos) })}
                            </Tag>
                          </Space>
                        </Tooltip>
                      );
                    }
                  },
                  {
                    title: t('signin_region'),
                    dataIndex: 'loginRegions',
                    render: (loginRegions: string[] | null) => {
                      if (!loginRegions) {
                        return <Tag>{t('access_anywhere')}</Tag>;
                      }
                      if (loginRegions.length === 0) {
                        return <Tag color="red">{t('access_nowhere')}</Tag>;
                      }
                      const names = loginRegions.map(describeLoginRegion);
                      return (
                        <Tooltip title={names.join(', ')}>
                          <Tag color="blue">
                            {names.length === 1 ? names[0] : t('regions_count', { count: names.length })}
                          </Tag>
                        </Tooltip>
                      );
                    }
                  },
                  {
                    title: t('pdf_translation'),
                    dataIndex: 'canTranslatePdf',
                    render: (canTranslatePdf: boolean) => (
                      canTranslatePdf ? <Tag color="blue">{t('tag_on')}</Tag> : <Tag>{t('tag_off')}</Tag>
                    )
                  },
                  {
                    title: t('uploads_column'),
                    dataIndex: 'canUploadTranscription',
                    render: (canUploadTranscription: boolean) => (
                      canUploadTranscription ? <Tag color="blue">{t('tag_on')}</Tag> : <Tag>{t('tag_off')}</Tag>
                    )
                  },
                  {
                    title: t('transcribe_column'),
                    dataIndex: 'canTranscribeVideo',
                    render: (canTranscribeVideo: boolean) => (
                      canTranscribeVideo ? <Tag color="blue">{t('tag_on')}</Tag> : <Tag>{t('tag_off')}</Tag>
                    )
                  },
                  {
                    title: t('subtitles'),
                    dataIndex: 'canViewSubtitles',
                    render: (canViewSubtitles: boolean) => (
                      canViewSubtitles ? <Tag color="blue">{t('tag_on')}</Tag> : <Tag>{t('tag_off')}</Tag>
                    )
                  },
                  {
                    title: t('added'),
                    dataIndex: 'createdAt',
                    render: (createdAt: string) => new Date(createdAt).toLocaleDateString()
                  },
                  {
                    title: '',
                    key: 'actions',
                    align: 'right',
                    render: (_, user) => (
                      <Space size={4} wrap>
                        {
                          user.banned ? (
                            <Popconfirm
                              title={t('lift_ban_confirm', { name: user.username })}
                              description={user.banReason || undefined}
                              okText={t('unban')}
                              onConfirm={() => void handleUnban(user)}
                            >
                              <Tooltip title={t('lift_ban_tooltip')}>
                                <Button
                                  type="text"
                                  size="small"
                                  icon={<UnlockOutlined />}
                                  aria-label={t('lift_ban_aria', { name: user.username })}
                                />
                              </Tooltip>
                            </Popconfirm>
                          ) : null
                        }
                        <Tooltip title={t('recent_signins')}>
                          <Button
                            type="text"
                            size="small"
                            icon={<HistoryOutlined />}
                            aria-label={t('recent_signins_for', { name: user.username })}
                            onClick={() => openSignIns(user)}
                          />
                        </Tooltip>
                        <Button
                          type="text"
                          size="small"
                          icon={<EditOutlined />}
                          aria-label={t('edit_aria', { name: user.username })}
                          onClick={() => openEditor(user)}
                        />
                        <Popconfirm
                          title={t('remove_confirm', { name: user.username })}
                          okText={t('remove')}
                          okButtonProps={{ danger: true }}
                          onConfirm={() => void handleDelete(user)}
                        >
                          <Button
                            type="text"
                            size="small"
                            danger
                            icon={<DeleteOutlined />}
                            aria-label={t('remove_aria', { name: user.username })}
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
                {t('pending_applications')}
              </Badge>
            ),
            children: (
              <Table<Registration>
                className="users__table"
                rowKey="id"
                dataSource={registrations || []}
                loading={registrations === null}
                pagination={false}
                locale={{ emptyText: t('no_applications_waiting') }}
                columns={[
                  {
                    title: t('login_username'),
                    dataIndex: 'username'
                  },
                  {
                    title: t('applied'),
                    dataIndex: 'requestedAt',
                    render: (requestedAt: string) => describeLoginTime(requestedAt)
                  },
                  {
                    title: '',
                    key: 'actions',
                    align: 'right',
                    render: (_, registration) => (
                      <Space size={4} wrap>
                        <Popconfirm
                          title={t('approve_confirm', { name: registration.username })}
                          description={t('approve_desc')}
                          okText={t('approve')}
                          onConfirm={() => void handleApprove(registration)}
                        >
                          <Button
                            type="text"
                            size="small"
                            icon={<CheckOutlined />}
                            loading={answering === registration.id}
                            aria-label={t('approve_aria', { name: registration.username })}
                          >
                            {t('approve')}
                          </Button>
                        </Popconfirm>
                        <Popconfirm
                          title={t('reject_confirm', { name: registration.username })}
                          description={t('reject_desc')}
                          okText={t('reject')}
                          okButtonProps={{ danger: true }}
                          onConfirm={() => void handleReject(registration)}
                        >
                          <Button
                            type="text"
                            size="small"
                            danger
                            icon={<CloseOutlined />}
                            loading={answering === registration.id}
                            aria-label={t('reject_aria', { name: registration.username })}
                          >
                            {t('reject')}
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
        title={editing === 'new' ? t('add_user') : t('edit_user', { name: editing ? editing.username : '' })}
        okText={t('save')}
        confirmLoading={submitting}
        onCancel={() => {
          setEditing(null);
          setPermissionsOpen(false);
        }}
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
            label={t('login_username')}
            rules={editing === 'new' ? [ { required: true, message: t('enter_a_username') } ] : []}
          >
            {/* The username is what the session and the file key on, so it is
                shown for context but not editable. */}
            <Input disabled={editing !== 'new'} />
          </Form.Item>
          <Form.Item
            name="password"
            label={editing === 'new' ? t('login_password') : t('new_password')}
            extra={editing === 'new' ? undefined : t('leave_blank_keep_password')}
            rules={editing === 'new' ? [ { required: true, message: t('login_enter_password') } ] : []}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="role" label={t('role')}>
            <Select options={roleOptions} />
          </Form.Item>
          {/* Everything this account may and may not do is one dialog further
              in. The account itself - who it is and how it signs in - is what
              is being edited most of the time, and it was being read past four
              blocks of permissions to get to. */}
          <Form.Item label={t('permissions')} className="mb-0">
            <Space orientation="vertical" size={8} className="users__permissions">
              <PermissionsSummary form={form} />
              <Button
                icon={<SafetyCertificateOutlined />}
                onClick={() => setPermissionsOpen(true)}
              >
                {t('more_permissions')}
              </Button>
            </Space>
          </Form.Item>
          {/* Inside the form on purpose: the fields below are the same form's
              fields, saved by the Save button on the dialog behind this one,
              not by closing this one. */}
          <Modal
            open={permissionsOpen}
            title={t('permissions')}
            width={620}
            onCancel={() => setPermissionsOpen(false)}
            footer={[
              <Button key="done" type="primary" onClick={() => closePermissions()}>
                {t('done')}
              </Button>
            ]}
          >
            <p className="text-body-secondary">
              {t('permissions_kept_note')}
            </p>
            <PermissionFields
              form={form}
              campaignOptions={campaignOptions}
              campaignsLoading={campaigns === null}
              regionOptions={loginRegionOptions}
              regionsLoading={knownRegions === null}
            />
          </Modal>
        </Form>
      </Modal>
      <Modal
        open={!!signInsFor}
        title={t('recent_signins_title', { name: signInsFor ? signInsFor.username : '' })}
        width={760}
        onCancel={() => setSignInsFor(null)}
        footer={[
          <Button
            key="refresh"
            icon={<ReloadOutlined />}
            loading={loginLogLoading}
            onClick={() => signInsFor && void refreshLoginLog(signInsFor)}
          >
            {t('refresh')}
          </Button>,
          <Button key="close" type="primary" onClick={() => setSignInsFor(null)}>
            {t('close')}
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
          className="users__login-log users__table"
          rowKey={(entry, index) => `${entry.at}-${index ?? 0}`}
          dataSource={loginLog || []}
          loading={loginLog === null && loginLogLoading}
          pagination={false}
          size="small"
          locale={{ emptyText: t('no_signins_recorded') }}
          columns={[
            {
              title: t('col_when'),
              dataIndex: 'at',
              render: (at: string) => describeLoginTime(at)
            },
            {
              title: 'IP',
              dataIndex: 'ip'
            },
            {
              title: t('col_location'),
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
              title: t('col_client'),
              dataIndex: 'userAgent',
              // A user agent string would take the whole row if it could, and
              // the columns beside it are the ones being read. It gets no more
              // than its share and is elided; the whole of it is a hover away.
              ellipsis: true,
              render: (userAgent: string | null) => (
                <Tooltip title={userAgent || undefined}>
                  <span className="users__user-agent">{userAgent || '—'}</span>
                </Tooltip>
              )
            },
            {
              title: t('col_result'),
              key: 'result',
              align: 'right',
              render: (_, entry) => (
                entry.success ? <Tag color="green">{t('signed_in')}</Tag> : (
                  <Tooltip title={t('password_mismatch_tooltip')}>
                    <Tag color="red">{t('failed')}</Tag>
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
 * Everything an account may and may not do, in one dialog.
 *
 * Together rather than spread down the user form because they are read
 * together: what somebody wants to know when they open this is what this
 * account can do, and that was four separate answers in four places.
 *
 * An administrator has none of it - which is one alert here rather than the
 * same explanation repeated by each block, so the components below can assume
 * an ordinary user.
 */
function PermissionFields(props: {
  form: FormInstance<UserFormValues>;
  campaignOptions: { value: string; label: string; }[];
  campaignsLoading: boolean;
  regionOptions: { value: string; label: string; }[];
  regionsLoading: boolean;
}) {
  const { form, campaignOptions, campaignsLoading, regionOptions, regionsLoading } = props;
  const role = Form.useWatch('role', form);
  const { t } = useLanguage();

  if (role === 'admin') {
    return (
      <Alert
        type="info"
        showIcon
        title={t('admins_not_restricted_title')}
        description={t('admins_not_restricted_desc')}
      />
    );
  }

  return (
    <>
      <CampaignAccessFields
        form={form}
        options={campaignOptions}
        loading={campaignsLoading}
      />
      <QuotaFields form={form} />
      <LoginRegionFields
        form={form}
        options={regionOptions}
        loading={regionsLoading}
      />
      <PdfTranslationField form={form} />
      <UploadTranscriptionField form={form} />
      <TranscribeVideoField form={form} />
      <ViewSubtitlesField form={form} />
    </>
  );
}

/**
 * What the permissions come to, on the dialog that does not show them.
 *
 * Without this the button would be a door with nothing written on it, and the
 * only way to see whether an account was restricted at all would be to open
 * it - which is exactly the reading the user table already does with tags.
 */
function PermissionsSummary(props: { form: FormInstance<UserFormValues>; }) {
  const { form } = props;
  const role = Form.useWatch('role', form);
  const campaignAccess = Form.useWatch('campaignAccess', form);
  const visibleCampaigns = Form.useWatch('visibleCampaigns', form);
  const postQuotaMode = Form.useWatch('postQuotaMode', form);
  const postQuota = Form.useWatch('postQuota', form);
  const videoQuotaMode = Form.useWatch('videoQuotaMode', form);
  const videoQuota = Form.useWatch('videoQuota', form);
  const loginRegionAccess = Form.useWatch('loginRegionAccess', form);
  const loginRegions = Form.useWatch('loginRegions', form);
  const canTranslatePdf = Form.useWatch('canTranslatePdf', form);
  const canUploadTranscription = Form.useWatch('canUploadTranscription', form);
  const canTranscribeVideo = Form.useWatch('canTranscribeVideo', form);
  const canViewSubtitles = Form.useWatch('canViewSubtitles', form);
  const { t } = useLanguage();

  if (role === 'admin') {
    return <Tag color="green">{t('unrestricted')}</Tag>;
  }

  const campaignCount = (visibleCampaigns || []).length;
  const regionCount = (loginRegions || []).length;
  // "None" and "Nowhere" are the settings worth catching at a glance: both are
  // reachable, both are meant, and both look like a mistake if they are not.
  const campaigns = campaignAccess === 'all' ?
    { text: t('access_all_creators'), color: undefined } :
    campaignCount === 0 ? { text: t('no_creators'), color: 'red' } :
      { text: t('creators_count', { count: campaignCount }), color: 'blue' };
  const regions = loginRegionAccess === 'anywhere' ?
    { text: t('signs_in_anywhere'), color: undefined } :
    regionCount === 0 ? { text: t('signs_in_nowhere'), color: 'red' } :
      { text: t('regions_count', { count: regionCount }), color: 'blue' };

  return (
    <Space size={4} wrap>
      <Tag color={campaigns.color}>{campaigns.text}</Tag>
      <Tag color={postQuotaMode === 'limited' ? 'blue' : undefined}>
        {postQuotaMode === 'limited' ? t('posts_per_day_value', { value: postQuota ?? 0 }) : t('posts_unlimited')}
      </Tag>
      <Tag color={videoQuotaMode === 'limited' ? 'blue' : undefined}>
        {videoQuotaMode === 'limited' ? t('videos_per_day_value', { value: videoQuota ?? 0 }) : t('videos_unlimited')}
      </Tag>
      <Tag color={regions.color}>{regions.text}</Tag>
      <Tag color={canTranslatePdf ? 'blue' : undefined}>
        {canTranslatePdf ? t('pdf_translation_on') : t('pdf_translation_off')}
      </Tag>
      <Tag color={canUploadTranscription ? 'blue' : undefined}>
        {canUploadTranscription ? t('uploads_on') : t('uploads_off')}
      </Tag>
      <Tag color={canTranscribeVideo ? 'blue' : undefined}>
        {canTranscribeVideo ? t('transcribe_on') : t('transcribe_off')}
      </Tag>
      <Tag color={canViewSubtitles ? 'blue' : undefined}>
        {canViewSubtitles ? t('subtitles_on') : t('subtitles_off')}
      </Tag>
    </Space>
  );
}

/**
 * Whether the PDF reader offers this account its translation.
 *
 * A switch rather than the mode-and-value pairs beside it because there is no
 * value to give: it is on or it is off, and the reader shows or hides its two
 * translation buttons accordingly.
 */
function PdfTranslationField(props: { form: FormInstance<UserFormValues>; }) {
  const { form } = props;
  const canTranslatePdf = Form.useWatch('canTranslatePdf', form);
  const { t } = useLanguage();

  return (
    <Form.Item
      name="canTranslatePdf"
      label={t('pdf_translation')}
      valuePropName="checked"
      extra={
        canTranslatePdf ?
          t('pdf_reader_offers') :
          t('pdf_reader_hides')
      }
    >
      <Switch checkedChildren={t('tag_on')} unCheckedChildren={t('tag_off')} />
    </Form.Item>
  );
}

/**
 * Whether this account may upload a video of its own to be transcribed.
 *
 * A switch for the same reason the one above is: there is nothing to give it
 * but a yes or a no. What it costs is why it is off by default - an upload is
 * work the server does and API credit it spends, on a file nobody here chose.
 */
function UploadTranscriptionField(props: { form: FormInstance<UserFormValues>; }) {
  const { form } = props;
  const canUploadTranscription = Form.useWatch('canUploadTranscription', form);
  const { t } = useLanguage();

  return (
    <Form.Item
      name="canUploadTranscription"
      label={t('video_uploads')}
      valuePropName="checked"
      extra={
        canUploadTranscription ?
          t('upload_on_desc') :
          t('upload_off_desc')
      }
    >
      <Switch checkedChildren={t('tag_on')} unCheckedChildren={t('tag_off')} />
    </Form.Item>
  );
}

/**
 * Whether this account may ask for a video in the library to be transcribed.
 *
 * A switch like the two above, and like them there is nothing to type in
 * beside it: what the account may spend in a day is fixed - see
 * `TranscriptionQuota` - rather than another pair of boxes on a form that
 * already has several. What it buys is one button in the corner of a video
 * tile; the transcription page stays an administrator's.
 */
function TranscribeVideoField(props: { form: FormInstance<UserFormValues>; }) {
  const { form } = props;
  const canTranscribeVideo = Form.useWatch('canTranscribeVideo', form);
  const { t } = useLanguage();

  return (
    <Form.Item
      name="canTranscribeVideo"
      label={t('transcribe_videos')}
      valuePropName="checked"
      extra={
        canTranscribeVideo ?
          t('transcribe_on_desc', {
            videos: DAILY_TRANSCRIPTION_VIDEOS,
            hours: DAILY_TRANSCRIPTION_SECONDS / 3600
          }) :
          t('transcribe_off_desc')
      }
    >
      <Switch checkedChildren={t('tag_on')} unCheckedChildren={t('tag_off')} />
    </Form.Item>
  );
}

/**
 * Whether the videos this account watches come with subtitles.
 *
 * The one permission here that costs nothing to grant - the captions are
 * already written, and serving a file that is sitting there is not metered.
 * It is a switch anyway, because who gets to read them is still a decision,
 * and it is the switch above that decides who gets to make them.
 */
function ViewSubtitlesField(props: { form: FormInstance<UserFormValues>; }) {
  const { form } = props;
  const canViewSubtitles = Form.useWatch('canViewSubtitles', form);
  const { t } = useLanguage();

  return (
    <Form.Item
      name="canViewSubtitles"
      label={t('subtitles')}
      valuePropName="checked"
      extra={
        canViewSubtitles ?
          t('view_subtitles_on_desc') :
          t('view_subtitles_off_desc')
      }
    >
      <Switch checkedChildren={t('tag_on')} unCheckedChildren={t('tag_off')} />
    </Form.Item>
  );
}

/**
 * The creator restriction.
 *
 * Its own component so that watching the access mode re-renders this and not
 * the whole page - the user table behind these dialogs is not cheap.
 */
function CampaignAccessFields(props: {
  form: FormInstance<UserFormValues>;
  options: { value: string; label: string; }[];
  loading: boolean;
}) {
  const { form, options, loading } = props;
  const access = Form.useWatch('campaignAccess', form);
  const { t } = useLanguage();

  const accessOptions = [
    { value: 'all', label: t('access_all_creators') },
    { value: 'selected', label: t('access_only_selected') }
  ];

  return (
    <>
      <Form.Item name="campaignAccess" label={t('nav_creators')}>
        <Radio.Group options={accessOptions} optionType="button" />
      </Form.Item>
      {
        access === 'selected' ? (
          <Form.Item
            name="visibleCampaigns"
            extra={t('selected_creators_extra')}
          >
            <Select
              mode="multiple"
              allowClear
              loading={loading}
              options={options}
              showSearch={{ optionFilterProp: 'label' }}
              placeholder={t('choose_creators_placeholder')}
            />
          </Form.Item>
        ) : null
      }
    </>
  );
}

/**
 * The daily allowance.
 *
 * Two limits, each either lifted or a number. Its own component for the same
 * reason the creator fields are: watching the two modes should re-render this
 * and not the user table behind the dialog.
 */
function QuotaFields(props: { form: FormInstance<UserFormValues>; }) {
  const { form } = props;
  const { t } = useLanguage();

  return (
    <>
      <QuotaField
        form={form}
        label={t('posts_per_day')}
        modeName="postQuotaMode"
        valueName="postQuota"
        extra={t('posts_per_day_extra')}
      />
      <QuotaField
        form={form}
        label={t('videos_per_day')}
        modeName="videoQuotaMode"
        valueName="videoQuota"
        extra={t('videos_per_day_extra')}
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
  const { t } = useLanguage();

  const modeOptions = [
    { value: 'unlimited', label: t('quota_unlimited') },
    { value: 'limited', label: t('quota_mode_limit') }
  ];

  return (
    <Form.Item label={label} extra={extra} className="mb-3">
      <Space align="start">
        <Form.Item name={modeName} noStyle>
          <Radio.Group options={modeOptions} optionType="button" />
        </Form.Item>
        {
          mode === 'limited' ? (
            <Form.Item
              name={valueName}
              noStyle
              rules={[ { required: true, message: t('enter_a_number') } ]}
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

/**
 * Where the account may sign in from.
 *
 * A `tags` select rather than a plain multiple one: the options are the places
 * this server has seen before, which is the useful list and never the complete
 * one - somebody setting up an account for a colleague in a city nobody has
 * signed in from yet has to be able to write it down.
 *
 * Its own component for the reason the other permission blocks are: this
 * watches the mode, and re-rendering the user table for it would be paying for
 * the whole page to answer a radio button.
 */
function LoginRegionFields(props: {
  form: FormInstance<UserFormValues>;
  options: { value: string; label: string; }[];
  loading: boolean;
}) {
  const { form, options, loading } = props;
  const access = Form.useWatch('loginRegionAccess', form);
  const regions = Form.useWatch('loginRegions', form);
  const { t } = useLanguage();

  const accessOptions = [
    { value: 'anywhere', label: t('access_anywhere') },
    { value: 'selected', label: t('access_only_selected') }
  ];

  return (
    <>
      <Form.Item name="loginRegionAccess" label={t('signin_region')}>
        <Radio.Group options={accessOptions} optionType="button" />
      </Form.Item>
      {
        access === 'selected' ? (
          <>
            <Form.Item
              name="loginRegions"
              extra={t('login_regions_extra')}
            >
              <Select
                mode="tags"
                allowClear
                loading={loading}
                options={options}
                tokenSeparators={[ ',' ]}
                showSearch={{ optionFilterProp: 'label' }}
                placeholder={t('choose_regions_placeholder')}
              />
            </Form.Item>
            {
              regions && regions.length === 0 ? (
                <Alert
                  className="mb-3"
                  type="warning"
                  showIcon
                  title={t('cannot_signin_alert')}
                  description={t('cannot_signin_desc')}
                />
              ) : null
            }
          </>
        ) : null
      }
    </>
  );
}

export default Users;
