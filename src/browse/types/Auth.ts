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
}

export interface AuthSession {
  user: AuthUser | null;
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
}

export interface UpdateUserRequest {
  password?: string;
  role?: UserRole;
  /** Omit to leave as it is; `null` to lift the restriction entirely. */
  visibleCampaigns?: string[] | null;
}
