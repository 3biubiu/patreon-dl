import fs from 'fs';
import path from 'path';
import { commonLog, type LogLevel } from '../../../utils/logging/Logger.js';
import { type Logger } from '../../../utils/logging/index.js';

/**
 * Source characters aimed at per call, and the ceiling on lines per call.
 *
 * These are the whole answer to Gemini's per-call billing. The reference
 * implementation this feature follows sends ten lines a call, which for an
 * hour of speech is around sixty calls before any retry; at these defaults the
 * same hour is five or six. They are deliberately conservative all the same -
 * a batch large enough to hit the model's output ceiling has to be repaired,
 * and a repair is another call. An administrator with a large-output model can
 * raise them and halve the count again.
 */
const DEFAULT_BATCH_CHARACTERS = 6000;
const DEFAULT_BATCH_LINES = 120;

/** Bounds a settings form is held to, so a typo cannot make a job pathological. */
export const BATCH_CHARACTERS_RANGE = { min: 500, max: 40000 };
export const BATCH_LINES_RANGE = { min: 10, max: 1000 };

interface SettingsFile {
  /** Gemini API key. Never leaves the server. */
  apiKey: string | null;
  model: string | null;
  baseUrl: string | null;
  /** The editable half of the prompt; `null` means the default is in use. */
  prompt: string | null;
  batchCharacters: number | null;
  batchLines: number | null;
  disableThinking: boolean;
  /** Calls spent since this counter was last reset. */
  totalRequests: number;
}

const EMPTY: SettingsFile = {
  apiKey: null,
  model: null,
  baseUrl: null,
  prompt: null,
  batchCharacters: null,
  batchLines: null,
  disableThinking: false,
  totalRequests: 0
};

function clamp(value: number, range: { min: number; max: number }) {
  return Math.max(range.min, Math.min(range.max, Math.round(value)));
}

/**
 * The Gemini API key and the settings that go with it, in a file of its own
 * beside the transcription settings.
 *
 * Kept apart from those for the same reason they are kept apart from the
 * browse settings: a bearer credential cannot live anywhere a viewer can read,
 * and two credentials in one file make one leak worth two.
 *
 * Written the same way - owner-only, and through a temporary file and a rename
 * so a process that dies mid-write cannot leave half a key behind.
 */
export default class TranslationSettingsStore {
  name = 'TranslationSettingsStore';

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
        return new TranslationSettingsStore(filePath, {
          apiKey: parsed.apiKey || null,
          model: parsed.model || null,
          baseUrl: parsed.baseUrl || null,
          prompt: parsed.prompt || null,
          batchCharacters: parsed.batchCharacters || null,
          batchLines: parsed.batchLines || null,
          disableThinking: !!parsed.disableThinking,
          totalRequests: parsed.totalRequests || 0
        }, logger);
      }
      catch (error) {
        commonLog(logger, 'warn', 'TranslationSettingsStore',
          `Could not read "${filePath}":`, error);
      }
    }
    return new TranslationSettingsStore(filePath, { ...EMPTY }, logger);
  }

  /**
   * The key in use, preferring what an administrator saved over the
   * environment. The environment remains the way to configure a deployment
   * that has no one to click anything.
   */
  getApiKey(): string | null {
    return this.#data.apiKey || process.env.GEMINI_API_KEY || null;
  }

  /** Where the key in use came from, so the browser can say so. */
  getApiKeySource(): 'file' | 'env' | null {
    if (this.#data.apiKey) {
      return 'file';
    }
    return process.env.GEMINI_API_KEY ? 'env' : null;
  }

  getModel(): string | null {
    return this.#data.model || process.env.GEMINI_MODEL || null;
  }

  getBaseUrl(): string | null {
    return this.#data.baseUrl || process.env.GEMINI_BASE_URL || null;
  }

  /** `null` when the default is in use, which is what the form shows as such. */
  getPrompt(): string | null {
    return this.#data.prompt;
  }

  getBatchCharacters(): number {
    return this.#data.batchCharacters || DEFAULT_BATCH_CHARACTERS;
  }

  getBatchLines(): number {
    return this.#data.batchLines || DEFAULT_BATCH_LINES;
  }

  getDisableThinking(): boolean {
    return this.#data.disableThinking;
  }

  getTotalRequests(): number {
    return this.#data.totalRequests;
  }

  /**
   * Adds to the running count of calls spent. Written straight through: the
   * whole point of the number is to survive a restart, and a job makes a
   * handful of these an hour rather than one a second.
   */
  addRequests(count: number) {
    if (count <= 0) {
      return;
    }
    this.#data.totalRequests += count;
    this.#save();
  }

  resetTotalRequests() {
    this.#data.totalRequests = 0;
    this.#save();
  }

  /**
   * Passing `null` for `apiKey` clears it and falls back to the environment;
   * passing `null` for `prompt` puts the default prompt back.
   */
  update(params: {
    apiKey?: string | null;
    model?: string | null;
    baseUrl?: string | null;
    prompt?: string | null;
    batchCharacters?: number | null;
    batchLines?: number | null;
    disableThinking?: boolean;
  }) {
    if (params.apiKey !== undefined) {
      this.#data.apiKey = params.apiKey || null;
    }
    if (params.model !== undefined) {
      this.#data.model = params.model || null;
    }
    if (params.baseUrl !== undefined) {
      this.#data.baseUrl = params.baseUrl || null;
    }
    if (params.prompt !== undefined) {
      this.#data.prompt = params.prompt || null;
    }
    if (params.batchCharacters !== undefined) {
      this.#data.batchCharacters = params.batchCharacters === null ?
        null
        : clamp(params.batchCharacters, BATCH_CHARACTERS_RANGE);
    }
    if (params.batchLines !== undefined) {
      this.#data.batchLines = params.batchLines === null ?
        null
        : clamp(params.batchLines, BATCH_LINES_RANGE);
    }
    if (params.disableThinking !== undefined) {
      this.#data.disableThinking = params.disableThinking;
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
