import fs from 'fs';
import path from 'path';
import { commonLog, type LogLevel } from '../../../utils/logging/Logger.js';
import { type Logger } from '../../../utils/logging/index.js';

interface SettingsFile {
  /** OpenRouter API key. Never leaves the server. */
  apiKey: string | null;
  model: string | null;
  baseUrl: string | null;
}

const EMPTY: SettingsFile = { apiKey: null, model: null, baseUrl: null };

/**
 * The transcription API key and the settings that go with it, in a file of
 * their own beside the accounts.
 *
 * Not in the browse settings, which are kept in the content database and
 * served to any signed-in user - a bearer credential cannot live somewhere
 * every viewer can read. Not in `auth.json` either: that file holds password
 * hashes, and mixing a credential that is usable as-is into it makes one
 * leak strictly worse than the other.
 *
 * Written with the same care as the accounts file - owner-only, and through a
 * temporary file and a rename so a process that dies mid-write cannot leave a
 * half-written key behind.
 */
export default class TranscriptionSettingsStore {
  name = 'TranscriptionSettingsStore';

  #filePath: string;
  #data: SettingsFile;
  #logger?: Logger | null;

  private constructor(filePath: string, data: SettingsFile, logger?: Logger | null) {
    this.#filePath = filePath;
    this.#data = data;
    this.#logger = logger;
  }

  static load(filePath: string, logger?: Logger | null) {
    if (fs.existsSync(filePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<SettingsFile>;
        return new TranscriptionSettingsStore(filePath, {
          apiKey: parsed.apiKey || null,
          model: parsed.model || null,
          baseUrl: parsed.baseUrl || null
        }, logger);
      }
      catch (error) {
        commonLog(logger, 'warn', 'TranscriptionSettingsStore',
          `Could not read "${filePath}":`, error);
      }
    }
    return new TranscriptionSettingsStore(filePath, { ...EMPTY }, logger);
  }

  /**
   * The key in use, preferring what an administrator saved over the
   * environment. The environment remains the way to configure a deployment
   * that has no one to click anything.
   */
  getApiKey(): string | null {
    return this.#data.apiKey || process.env.OPENROUTER_API_KEY || null;
  }

  /** Where the key in use came from, so the browser can say so. */
  getApiKeySource(): 'file' | 'env' | null {
    if (this.#data.apiKey) {
      return 'file';
    }
    return process.env.OPENROUTER_API_KEY ? 'env' : null;
  }

  getModel(): string | null {
    return this.#data.model || process.env.OPENROUTER_MODEL || null;
  }

  getBaseUrl(): string | null {
    return this.#data.baseUrl || process.env.OPENROUTER_BASE_URL || null;
  }

  /** Passing `null` for `apiKey` clears it and falls back to the environment. */
  update(params: { apiKey?: string | null; model?: string | null; baseUrl?: string | null }) {
    if (params.apiKey !== undefined) {
      this.#data.apiKey = params.apiKey || null;
    }
    if (params.model !== undefined) {
      this.#data.model = params.model || null;
    }
    if (params.baseUrl !== undefined) {
      this.#data.baseUrl = params.baseUrl || null;
    }
    this.#save();
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

  protected log(level: LogLevel, ...msg: any[]) {
    commonLog(this.#logger, level, this.name, ...msg);
  }
}
