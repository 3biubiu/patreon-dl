import { type UserQuota } from './Quota.js';

export type UserRole = 'admin' | 'user';

/**
 * A user as the browser is allowed to see them - no salt, no password hash.
 *
 * The permissions live here rather than anywhere else because the auth guard
 * resolves this object onto the request before any handler runs - by the time
 * something has to decide what may be served, who is asking is already known.
 */
export interface AuthUser {
  id: string;
  username: string;
  role: UserRole;
  createdAt: string;
  /**
   * The campaigns this user may see, by id.
   *
   * `null` means every campaign, including ones downloaded after the account
   * was made - the default, and what an account carries until someone narrows
   * it. An empty array is the opposite and is deliberately reachable: it means
   * no campaigns at all, not "unset".
   *
   * Always `null` for administrators. Restricting one would be a lie - they
   * can change their own permissions.
   */
  visibleCampaigns: string[] | null;
  /**
   * How much this user may read in a day, counted from 08:00 Beijing time.
   *
   * `null` on either field means that kind is not limited - which is what
   * every account that existed before limits carries, and what an
   * administrator always carries.
   */
  quota: UserQuota;
  /**
   * The places this account may sign in from - see `LoginRegion`.
   *
   * `null` means anywhere, which is the default and what every account that
   * existed before this carries. An empty array is the opposite and is
   * deliberately reachable, exactly as it is for {@link AuthUser.visibleCampaigns}:
   * it means nowhere, and an account pinned to nowhere cannot sign in.
   *
   * Always `null` for administrators. An administrator locked out by their own
   * region list could not lift it - the same reasoning that keeps them out of
   * the ban rule.
   */
  loginRegions: string[] | null;
  /**
   * Locked out entirely - no session survives it and no sign-in gets past it.
   * Put on by the sign-in anomaly rule, taken off only by an administrator.
   * Never `true` for an administrator.
   */
  banned: boolean;
  /** Why, shown to the administrator. `null` when not banned. */
  banReason: string | null;
}

export interface AuthSession {
  user: AuthUser | null;
}

/**
 * An application for an account, waiting on an administrator.
 *
 * Never an `AuthUser`, and deliberately not a user with a flag on it: an
 * applicant has no account at all until someone approves one, so there is
 * nothing for a session to name and nothing for a sign-in to find.
 */
export interface Registration {
  id: string;
  username: string;
  requestedAt: string;
}

export interface RegisterRequest {
  username: string;
  password: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface CreateUserRequest {
  username: string;
  password: string;
  role: UserRole;
  visibleCampaigns?: string[] | null;
  /**
   * Omit to start the account on the default allowance
   * (`DEFAULT_USER_QUOTA`); send a field as `null` to lift that limit.
   */
  quota?: Partial<UserQuota> | null;
  /**
   * Omit to start the account unrestricted; send `null` for the same thing
   * explicitly, or a list of regions to pin it.
   */
  loginRegions?: string[] | null;
}

export interface UpdateUserRequest {
  password?: string;
  role?: UserRole;
  /** Omit to leave as it is; `null` to lift the restriction entirely. */
  visibleCampaigns?: string[] | null;
  /** Omit a field to leave it as it is; send `null` to lift that limit. */
  quota?: Partial<UserQuota> | null;
  /** Omit to leave as it is; `null` to let the account sign in from anywhere. */
  loginRegions?: string[] | null;
}

/**
 * One sign-in attempt as the administrator's page sees it.
 *
 * Failures are kept alongside successes and look the same on the wire - an
 * account being guessed at from somewhere unfamiliar is the thing this log
 * exists to make visible, and it is only visible next to the successes.
 */
export interface LoginLogEntry {
  at: string;
  username: string;
  /** `null` for a failed attempt: no account was signed in to. */
  userId: string | null;
  ip: string;
  userAgent: string | null;
  success: boolean;
  /**
   * Where the address is, already joined for display - or `null` when it could
   * not be worked out, which is not the same as the sign-in being suspect.
   */
  location: string | null;
  /**
   * The same place written as a region rule - `中国/广东省/深圳` - or `null`
   * when it could not be worked out.
   *
   * Carried alongside {@link LoginLogEntry.location} rather than derived from
   * it, because that one drops a part repeated between the province and the
   * city and so cannot be taken back apart. It is what lets the user form
   * offer the places this server has actually seen, instead of asking an
   * administrator to type a province name exactly as the location service
   * happens to spell it.
   */
  regionPath: string | null;
  isp: string | null;
}
