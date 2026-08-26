import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { commonLog, type LogLevel } from '../../utils/logging/Logger.js';
import { type Logger } from '../../utils/logging/index.js';
import { type AuthUser, type UserRole } from '../types/Auth.js';

/**
 * A user as stored on disk. The hash and its salt never leave this module -
 * everything else is handed out as a plain `AuthUser`.
 */
interface StoredUser extends AuthUser {
  salt: string;
  passwordHash: string;
}

interface AuthFile {
  /**
   * Signs session cookies. Kept with the users rather than regenerated per
   * process, because a fresh secret on every restart would sign everyone out.
   */
  secret: string;
  users: StoredUser[];
}

const SCRYPT_KEY_LENGTH = 64;
const SALT_BYTES = 16;
const MIN_PASSWORD_LENGTH = 6;

function hashPassword(password: string, salt: string) {
  return crypto.scryptSync(password, salt, SCRYPT_KEY_LENGTH).toString('base64');
}

/**
 * Accounts for the browse server, kept in a JSON file of their own.
 *
 * Deliberately not in the content database: that one belongs to the
 * downloader, is guarded by a schema version that refuses anything it does not
 * recognise, and is throw-away - you can delete it and download everything
 * again. Credentials are none of those things.
 *
 * A handful of users needs no indexes and no queries, so the whole file is
 * held in memory and rewritten whole. Writes go through a temporary file and a
 * rename, because a process that dies midway through overwriting this file
 * would otherwise take every account with it.
 */
export default class AuthStore {
  name = 'AuthStore';

  #filePath: string;
  #data: AuthFile;
  #logger?: Logger | null;

  private constructor(filePath: string, data: AuthFile, logger?: Logger | null) {
    this.#filePath = filePath;
    this.#data = data;
    this.#logger = logger;
  }

  static load(filePath: string, logger?: Logger | null) {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw) as AuthFile;
      if (!data.secret || !Array.isArray(data.users)) {
        throw Error(`"${filePath}" is not a valid auth file`);
      }
      return new AuthStore(filePath, data, logger);
    }

    // First run. A generated password beats a well-known default, which would
    // be live the moment the server is reachable.
    const password = crypto.randomBytes(9).toString('base64url');
    const salt = crypto.randomBytes(SALT_BYTES).toString('base64');
    const store = new AuthStore(filePath, {
      secret: crypto.randomBytes(32).toString('base64'),
      users: [
        {
          id: crypto.randomUUID(),
          username: 'admin',
          role: 'admin',
          createdAt: new Date().toISOString(),
          salt,
          passwordHash: hashPassword(password, salt)
        }
      ]
    }, logger);
    store.#save();
    store.log('info',
      `Created "${filePath}" with an administrator account - ` +
      `username "admin", password "${password}". Change it after signing in.`
    );
    return store;
  }

  get secret() {
    return this.#data.secret;
  }

  listUsers(): AuthUser[] {
    return this.#data.users.map((user) => this.#toAuthUser(user));
  }

  getUser(id: string): AuthUser | null {
    const user = this.#data.users.find((u) => u.id === id);
    return user ? this.#toAuthUser(user) : null;
  }

  /**
   * Returns the user when the password matches, `null` otherwise. Callers must
   * not say which half was wrong.
   */
  verifyPassword(username: string, password: string): AuthUser | null {
    const user = this.#data.users.find(
      (u) => u.username.toLowerCase() === username.trim().toLowerCase()
    );
    if (!user) {
      return null;
    }
    const given = Buffer.from(hashPassword(password, user.salt));
    const expected = Buffer.from(user.passwordHash);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      return null;
    }
    return this.#toAuthUser(user);
  }

  createUser(params: { username: string; password: string; role: UserRole; }): AuthUser {
    const username = params.username.trim();
    if (!username) {
      throw Error('Username is required');
    }
    if (this.#data.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
      throw Error(`User "${username}" already exists`);
    }
    this.#assertPassword(params.password);
    const salt = crypto.randomBytes(SALT_BYTES).toString('base64');
    const user: StoredUser = {
      id: crypto.randomUUID(),
      username,
      role: params.role,
      createdAt: new Date().toISOString(),
      salt,
      passwordHash: hashPassword(params.password, salt)
    };
    this.#data.users.push(user);
    this.#save();
    return this.#toAuthUser(user);
  }

  updateUser(id: string, params: { password?: string; role?: UserRole; }): AuthUser {
    const user = this.#data.users.find((u) => u.id === id);
    if (!user) {
      throw Error('User not found');
    }
    if (params.role && params.role !== user.role) {
      // Locking everyone out of user management is not recoverable from the
      // UI, only by editing the file by hand.
      if (user.role === 'admin' && this.#countAdmins() === 1) {
        throw Error('The last administrator cannot be demoted');
      }
      user.role = params.role;
    }
    if (params.password !== undefined) {
      this.#assertPassword(params.password);
      user.salt = crypto.randomBytes(SALT_BYTES).toString('base64');
      user.passwordHash = hashPassword(params.password, user.salt);
    }
    this.#save();
    return this.#toAuthUser(user);
  }

  deleteUser(id: string) {
    const index = this.#data.users.findIndex((u) => u.id === id);
    if (index === -1) {
      throw Error('User not found');
    }
    if (this.#data.users[index].role === 'admin' && this.#countAdmins() === 1) {
      throw Error('The last administrator cannot be removed');
    }
    this.#data.users.splice(index, 1);
    this.#save();
  }

  log(level: LogLevel, ...msg: any[]) {
    commonLog(this.#logger, level, this.name, ...msg);
  }

  #countAdmins() {
    return this.#data.users.filter((u) => u.role === 'admin').length;
  }

  #assertPassword(password: string) {
    if (!password || password.length < MIN_PASSWORD_LENGTH) {
      throw Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
  }

  #toAuthUser(user: StoredUser): AuthUser {
    const { id, username, role, createdAt } = user;
    return { id, username, role, createdAt };
  }

  #save() {
    const dir = path.dirname(this.#filePath);
    fs.mkdirSync(dir, { recursive: true });
    // Same directory as the target, so the rename stays within one filesystem
    // and is therefore atomic.
    const tmpFilePath = `${this.#filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpFilePath, JSON.stringify(this.#data, null, 2), { mode: 0o600 });
    fs.renameSync(tmpFilePath, this.#filePath);
  }
}
