import fs from 'fs';
import path from 'path';
import { commonLog, type LogLevel } from '../../../utils/logging/Logger.js';
import { type Logger } from '../../../utils/logging/index.js';
import { DEFAULT_PROXY_URL } from './GeminiTranslator.js';
import { isLLMProvider, type LLMProvider } from './LLMProtocol.js';
import { DEFAULT_SEGMENTER_OPTIONS, MAX_CJK_RANGE, MAX_LATIN_RANGE } from './SubtitleSegmenter.js';

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

/**
 * What belongs to one provider. Kept per provider so that switching back and
 * forth does not throw away the other one's key, model and base URL.
 */
interface ProviderProfile {
  /** Never leaves the server. */
  apiKey: string | null;
  model: string | null;
  baseUrl: string | null;
}

function emptyProfile(): ProviderProfile {
  return { apiKey: null, model: null, baseUrl: null };
}

function readProfile(raw: Partial<ProviderProfile> | undefined): ProviderProfile {
  return {
    apiKey: raw?.apiKey || null,
    model: raw?.model || null,
    baseUrl: raw?.baseUrl || null
  };
}

interface SettingsFile {
  /** Which wire protocol is in use - which of `profiles` is read. */
  provider: LLMProvider;
  profiles: Record<LLMProvider, ProviderProfile>;
  /**
   * Proxy for the Gemini requests. `null` means the default is in use; the
   * empty string means an administrator turned it off and wants to go direct,
   * which is why the two are not the same value here.
   */
  proxyUrl: string | null;
  /** The editable half of the prompt; `null` means the default is in use. */
  prompt: string | null;
  batchCharacters: number | null;
  batchLines: number | null;
  disableThinking: boolean;
  /**
   * Whether the Chinese file's lines are re-cut for readability. Costs nothing
   * - see `SubtitleSegmenter` - and only ever touches the translated file.
   */
  segmentation: boolean;
  /**
   * Whether the source transcript is re-cut by the model as it is
   * transcribed. Costs calls, unlike `segmentation`, and is what the
   * transcription's own subtitle is cut by when it is on.
   */
  sourceSegmentation: boolean;
  /**
   * Whether the transcript's text is repaired by the model after it is
   * transcribed - recognition errors, filler syllables, punctuation. Costs
   * calls, about the same as `sourceSegmentation`, and also changes the file
   * the transcription itself produces.
   */
  polish: boolean;
  maxLineCjk: number | null;
  maxLineLatin: number | null;
  /** Calls spent since this counter was last reset. */
  totalRequests: number;
}

const EMPTY: SettingsFile = {
  provider: 'gemini',
  profiles: { gemini: emptyProfile(), openai: emptyProfile() },
  proxyUrl: null,
  prompt: null,
  batchCharacters: null,
  batchLines: null,
  disableThinking: false,
  segmentation: true,
  sourceSegmentation: true,
  polish: false,
  maxLineCjk: null,
  maxLineLatin: null,
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
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as
          Partial<SettingsFile> & Partial<ProviderProfile>;
        // Absent in files written before OpenAI-compatible APIs were
        // supported, all of which were Gemini.
        const provider = isLLMProvider(parsed.provider) ? parsed.provider : 'gemini';
        const profiles = {
          gemini: readProfile(parsed.profiles?.gemini),
          openai: readProfile(parsed.profiles?.openai)
        };
        // Files written before profiles held one key, model and base URL at
        // the top level, all belonging to whichever provider was in use.
        if (!parsed.profiles) {
          profiles[provider] = readProfile(parsed);
        }
        return new TranslationSettingsStore(filePath, {
          provider,
          profiles,
          proxyUrl: parsed.proxyUrl ?? null,
          prompt: parsed.prompt || null,
          batchCharacters: parsed.batchCharacters || null,
          batchLines: parsed.batchLines || null,
          disableThinking: !!parsed.disableThinking,
          // Absent in files written before this existed, and on by default.
          segmentation: parsed.segmentation ?? true,
          sourceSegmentation: parsed.sourceSegmentation ?? true,
          // Off by default: unlike the segmentation toggles this rewrites
          // what was said, and an administrator should choose that.
          polish: parsed.polish ?? false,
          maxLineCjk: parsed.maxLineCjk || null,
          maxLineLatin: parsed.maxLineLatin || null,
          totalRequests: parsed.totalRequests || 0
        }, logger);
      }
      catch (error) {
        commonLog(logger, 'warn', 'TranslationSettingsStore',
          `Could not read "${filePath}":`, error);
      }
    }
    return new TranslationSettingsStore(filePath, {
      ...EMPTY,
      // Fresh objects: the profiles are edited in place.
      profiles: { gemini: emptyProfile(), openai: emptyProfile() }
    }, logger);
  }

  getProvider(): LLMProvider {
    return this.#data.provider;
  }

  /** The environment variables that stand in for the saved values of `provider`. */
  #env(provider: LLMProvider) {
    return provider === 'openai' ?
      {
        apiKey: process.env.OPENAI_API_KEY,
        model: process.env.OPENAI_MODEL,
        baseUrl: process.env.OPENAI_BASE_URL
      }
      : {
        apiKey: process.env.GEMINI_API_KEY,
        model: process.env.GEMINI_MODEL,
        baseUrl: process.env.GEMINI_BASE_URL
      };
  }

  /**
   * The key in use, preferring what an administrator saved over the
   * environment. The environment remains the way to configure a deployment
   * that has no one to click anything.
   *
   * These read the provider in use unless another is named - the settings form
   * names one to show what switching to it would bring back.
   */
  getApiKey(provider = this.#data.provider): string | null {
    return this.#data.profiles[provider].apiKey || this.#env(provider).apiKey || null;
  }

  /** Where the key came from, so the browser can say so. */
  getApiKeySource(provider = this.#data.provider): 'file' | 'env' | null {
    if (this.#data.profiles[provider].apiKey) {
      return 'file';
    }
    return this.#env(provider).apiKey ? 'env' : null;
  }

  getModel(provider = this.#data.provider): string | null {
    return this.#data.profiles[provider].model || this.#env(provider).model || null;
  }

  getBaseUrl(provider = this.#data.provider): string | null {
    return this.#data.profiles[provider].baseUrl || this.#env(provider).baseUrl || null;
  }

  /**
   * The proxy the Gemini requests go through, or `null` to go direct.
   *
   * Unset means the built-in default, which is a local proxy: Gemini is not
   * reachable from everywhere. An administrator who saves an empty value gets
   * `''` stored, which is honoured as "no proxy" rather than falling back to
   * the default again.
   */
  getProxyUrl(): string | null {
    if (this.#data.proxyUrl !== null) {
      return this.#data.proxyUrl || null;
    }
    if (process.env.GEMINI_PROXY_URL !== undefined) {
      return process.env.GEMINI_PROXY_URL || null;
    }
    return DEFAULT_PROXY_URL;
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

  getSegmentation(): boolean {
    return this.#data.segmentation;
  }

  getSourceSegmentation(): boolean {
    return this.#data.sourceSegmentation;
  }

  getPolish(): boolean {
    return this.#data.polish;
  }

  getMaxLineCjk(): number {
    return this.#data.maxLineCjk || DEFAULT_SEGMENTER_OPTIONS.maxCjk;
  }

  getMaxLineLatin(): number {
    return this.#data.maxLineLatin || DEFAULT_SEGMENTER_OPTIONS.maxLatin;
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
   *
   * `apiKey`, `model` and `baseUrl` are written to the profile of the provider
   * in use once `provider` has been applied. The other provider's are left as
   * they were, ready for a switch back.
   */
  update(params: {
    provider?: LLMProvider;
    apiKey?: string | null;
    model?: string | null;
    baseUrl?: string | null;
    proxyUrl?: string | null;
    prompt?: string | null;
    batchCharacters?: number | null;
    batchLines?: number | null;
    disableThinking?: boolean;
    segmentation?: boolean;
    sourceSegmentation?: boolean;
    polish?: boolean;
    maxLineCjk?: number | null;
    maxLineLatin?: number | null;
  }) {
    if (params.provider !== undefined) {
      this.#data.provider = params.provider;
    }
    const profile = this.#data.profiles[this.#data.provider];
    if (params.apiKey !== undefined) {
      profile.apiKey = params.apiKey || null;
    }
    if (params.model !== undefined) {
      profile.model = params.model || null;
    }
    if (params.baseUrl !== undefined) {
      profile.baseUrl = params.baseUrl || null;
    }
    if (params.proxyUrl !== undefined) {
      // Kept verbatim, empty string included - see `getProxyUrl`.
      this.#data.proxyUrl = params.proxyUrl;
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
    if (params.segmentation !== undefined) {
      this.#data.segmentation = params.segmentation;
    }
    if (params.sourceSegmentation !== undefined) {
      this.#data.sourceSegmentation = params.sourceSegmentation;
    }
    if (params.polish !== undefined) {
      this.#data.polish = params.polish;
    }
    if (params.maxLineCjk !== undefined) {
      this.#data.maxLineCjk = params.maxLineCjk === null ?
        null
        : clamp(params.maxLineCjk, MAX_CJK_RANGE);
    }
    if (params.maxLineLatin !== undefined) {
      this.#data.maxLineLatin = params.maxLineLatin === null ?
        null
        : clamp(params.maxLineLatin, MAX_LATIN_RANGE);
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
