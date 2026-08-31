import fs from 'fs';
import path from 'path';
import { commonLog, type LogLevel } from '../../../utils/logging/Logger.js';
import { type Logger } from '../../../utils/logging/index.js';
import { type TranscriptionProvider } from '../../types/Transcription.js';
import { DEFAULT_PROXY_URL } from './GeminiTranscriber.js';
import { type VADOptions } from './VoiceActivityDetector.js';

/**
 * The detector settings an administrator can override from the browser.
 * `null` throughout means the built-in defaults - see `VoiceActivityDetector`.
 */
export interface VADOverrides {
  /** Speech probability above which a frame counts as speech. */
  threshold: number | null;
  /** Silence shorter than this does not end a speech run, in seconds. */
  minSilenceDuration: number | null;
  /** Each interval is widened by this much at both ends, in seconds. */
  speechPad: number | null;
  /**
   * Silence up to this long is kept as part of the speech around it; anything
   * longer is cut out of the upload, in seconds.
   */
  mergeGap: number | null;
}

/** What the ranges a settings form is held to are, so a typo stays a typo. */
export const VAD_RANGES = {
  threshold: { min: 0.1, max: 0.9 },
  minSilenceDuration: { min: 0.2, max: 5 },
  speechPad: { min: 0, max: 1 },
  mergeGap: { min: 0, max: 30 }
};

interface SettingsFile {
  /** Which provider transcribes. Null means the default. */
  provider: TranscriptionProvider | null;
  /** OpenRouter API key. Never leaves the server. */
  apiKey: string | null;
  model: string | null;
  baseUrl: string | null;
  /** Gemini API key. Kept apart so switching provider does not lose the other. */
  geminiApiKey: string | null;
  geminiModel: string | null;
  geminiBaseUrl: string | null;
  /**
   * Proxy for the Gemini requests. `null` means the default is in use; the
   * empty string means an administrator deliberately turned it off.
   */
  geminiProxyUrl: string | null;
  /** Detector overrides. `null` for a field means the built-in default. */
  vad: VADOverrides;
}

const EMPTY: SettingsFile = {
  provider: null,
  apiKey: null,
  model: null,
  baseUrl: null,
  geminiApiKey: null,
  geminiModel: null,
  geminiBaseUrl: null,
  geminiProxyUrl: null,
  vad: { threshold: null, minSilenceDuration: null, speechPad: null, mergeGap: null }
};

export const DEFAULT_PROVIDER: TranscriptionProvider = 'openrouter';

function readProvider(value: unknown): TranscriptionProvider | null {
  return value === 'openrouter' || value === 'gemini' ? value : null;
}

/** One override field, clamped to its range and rounded to something sane. */
function readVadNumber(value: unknown, range: { min: number; max: number }) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) {
    return null;
  }
  return Math.round(
    Math.max(range.min, Math.min(range.max, number)) * 1000
  ) / 1000;
}

/** The saved overrides with anything unusable read back as "not set". */
function readVad(value: unknown): VADOverrides {
  const vad = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  return {
    threshold: readVadNumber(vad.threshold, VAD_RANGES.threshold),
    minSilenceDuration: readVadNumber(vad.minSilenceDuration, VAD_RANGES.minSilenceDuration),
    speechPad: readVadNumber(vad.speechPad, VAD_RANGES.speechPad),
    mergeGap: readVadNumber(vad.mergeGap, VAD_RANGES.mergeGap)
  };
}

/**
 * The transcription credentials and the settings that go with them, in a file
 * of their own beside the accounts.
 *
 * Not in the browse settings, which are kept in the content database and
 * served to any signed-in user - a bearer credential cannot live somewhere
 * every viewer can read. Not in `auth.json` either: that file holds password
 * hashes, and mixing a credential that is usable as-is into it makes one leak
 * strictly worse than the other.
 *
 * Both providers' keys are held at once, and `provider` picks between them.
 * Keeping the unused one means switching back is a dropdown rather than
 * finding the key again - and there is deliberately no automatic switching
 * between them: a provider that has run out of quota fails the job and says
 * so, because the other one is a different price and that is not a decision to
 * make on someone's behalf.
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
          provider: readProvider(parsed.provider),
          apiKey: parsed.apiKey || null,
          model: parsed.model || null,
          baseUrl: parsed.baseUrl || null,
          geminiApiKey: parsed.geminiApiKey || null,
          geminiModel: parsed.geminiModel || null,
          geminiBaseUrl: parsed.geminiBaseUrl || null,
          geminiProxyUrl: parsed.geminiProxyUrl ?? null,
          vad: readVad(parsed.vad)
        }, logger);
      }
      catch (error) {
        commonLog(logger, 'warn', 'TranscriptionSettingsStore',
          `Could not read "${filePath}":`, error);
      }
    }
    return new TranscriptionSettingsStore(filePath, { ...EMPTY }, logger);
  }

  getProvider(): TranscriptionProvider {
    return this.#data.provider ||
      readProvider(process.env.PATREON_DL_TRANSCRIBE_PROVIDER) ||
      DEFAULT_PROVIDER;
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

  getGeminiApiKey(): string | null {
    return this.#data.geminiApiKey ||
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY ||
      null;
  }

  getGeminiApiKeySource(): 'file' | 'env' | null {
    if (this.#data.geminiApiKey) {
      return 'file';
    }
    return (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) ? 'env' : null;
  }

  getGeminiModel(): string | null {
    return this.#data.geminiModel || process.env.GEMINI_TRANSCRIBE_MODEL || null;
  }

  getGeminiBaseUrl(): string | null {
    return this.#data.geminiBaseUrl || process.env.GEMINI_BASE_URL || null;
  }

  /**
   * The proxy the Gemini requests go through, or `null` to go direct.
   *
   * Unset means the built-in default, which is a local proxy: Gemini is not
   * reachable from everywhere. An administrator who saves an empty value gets
   * `''` stored, which is honoured as "no proxy" rather than falling back to
   * the default again. Same rules, and the same environment variable, as the
   * translator - one proxy setting covers both.
   */
  getGeminiProxyUrl(): string | null {
    if (this.#data.geminiProxyUrl !== null) {
      return this.#data.geminiProxyUrl || null;
    }
    if (process.env.GEMINI_PROXY_URL !== undefined) {
      return process.env.GEMINI_PROXY_URL || null;
    }
    return DEFAULT_PROXY_URL;
  }

  /**
   * The key the provider in use needs. What "is transcription switched on"
   * comes down to, since a key for the other provider does not help.
   */
  getActiveApiKey(): string | null {
    return this.getProvider() === 'gemini' ? this.getGeminiApiKey() : this.getApiKey();
  }

  getActiveApiKeySource(): 'file' | 'env' | null {
    return this.getProvider() === 'gemini' ?
      this.getGeminiApiKeySource()
      : this.getApiKeySource();
  }

  /**
   * The detector settings in force: only what was set, so the caller decides
   * what the defaults are and how its own configuration merges with these.
   */
  getVADOverrides(): Partial<VADOptions> {
    const overrides: Partial<VADOptions> = {};
    const vad = this.#data.vad;
    if (vad.threshold !== null) {
      overrides.threshold = vad.threshold;
    }
    if (vad.minSilenceDuration !== null) {
      overrides.minSilenceDuration = vad.minSilenceDuration;
    }
    if (vad.speechPad !== null) {
      overrides.speechPad = vad.speechPad;
    }
    if (vad.mergeGap !== null) {
      overrides.mergeGap = vad.mergeGap;
    }
    return overrides;
  }

  /** The overrides exactly as saved, for the settings form to show. */
  getVADSettings(): VADOverrides {
    return { ...this.#data.vad };
  }

  /**
   * Passing `null` for a key clears it and falls back to the environment.
   * Passing `null` for a detector field puts its built-in default back.
   */
  update(params: {
    provider?: TranscriptionProvider | null;
    apiKey?: string | null;
    model?: string | null;
    baseUrl?: string | null;
    geminiApiKey?: string | null;
    geminiModel?: string | null;
    geminiBaseUrl?: string | null;
    geminiProxyUrl?: string | null;
    vad?: Partial<Record<keyof VADOverrides, number | null>>;
  }) {
    if (params.provider !== undefined) {
      this.#data.provider = readProvider(params.provider);
    }
    if (params.apiKey !== undefined) {
      this.#data.apiKey = params.apiKey || null;
    }
    if (params.model !== undefined) {
      this.#data.model = params.model || null;
    }
    if (params.baseUrl !== undefined) {
      this.#data.baseUrl = params.baseUrl || null;
    }
    if (params.geminiApiKey !== undefined) {
      this.#data.geminiApiKey = params.geminiApiKey || null;
    }
    if (params.geminiModel !== undefined) {
      this.#data.geminiModel = params.geminiModel || null;
    }
    if (params.geminiBaseUrl !== undefined) {
      this.#data.geminiBaseUrl = params.geminiBaseUrl || null;
    }
    if (params.geminiProxyUrl !== undefined) {
      // Kept verbatim, empty string included - see `getGeminiProxyUrl`.
      this.#data.geminiProxyUrl = params.geminiProxyUrl;
    }
    if (params.vad !== undefined) {
      this.#data.vad = {
        threshold: params.vad.threshold !== undefined ?
          readVadNumber(params.vad.threshold, VAD_RANGES.threshold)
          : this.#data.vad.threshold,
        minSilenceDuration: params.vad.minSilenceDuration !== undefined ?
          readVadNumber(params.vad.minSilenceDuration, VAD_RANGES.minSilenceDuration)
          : this.#data.vad.minSilenceDuration,
        speechPad: params.vad.speechPad !== undefined ?
          readVadNumber(params.vad.speechPad, VAD_RANGES.speechPad)
          : this.#data.vad.speechPad,
        mergeGap: params.vad.mergeGap !== undefined ?
          readVadNumber(params.vad.mergeGap, VAD_RANGES.mergeGap)
          : this.#data.vad.mergeGap
      };
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
