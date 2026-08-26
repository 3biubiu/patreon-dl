export type UserRole = 'admin' | 'user';

/**
 * A user as the browser is allowed to see them - no salt, no password hash.
 *
 * Content permissions (who may download, which campaigns are visible) are not
 * here yet. When they arrive they go on this type, and the places that need to
 * check them already have the user to hand: the auth guard resolves it onto
 * the request before any handler runs.
 */
export interface AuthUser {
  id: string;
  username: string;
  role: UserRole;
  createdAt: string;
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
}

export interface UpdateUserRequest {
  password?: string;
  role?: UserRole;
}
