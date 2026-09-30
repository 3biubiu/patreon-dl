import crypto from 'crypto';
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

/** Long enough for "SiliconFlow - DeepSeek V3", short enough for a dropdown. */
export const MAX_SOURCE_NAME_LENGTH = 40;

/**
 * Where requests go: a key, model, base URL and proxy that belong together.
 * Gemini has one; the OpenAI-compatible protocol may have several, since that
 * protocol is spoken by many services an administrator may switch between.
 */
interface ProviderProfile {
  /** Never leaves the server. */
  apiKey: string | null;
  model: string | null;
  baseUrl: string | null;
  /**
   * `null` means the default is in use; the empty string means an
   * administrator turned it off and wants to go direct, which is why the two
   * are not the same value here. Per source because a domestic service wants
   * no proxy and an overseas one usually does.
   */
  proxyUrl: string | null;
}

/** One named OpenAI-compatible service. */
interface OpenAISource extends ProviderProfile {
  id: string;
  name: string;
}

/** What the settings form is told about a source. Never the key itself. */
export interface ProfileDescription {
  source: 'file' | 'env' | null;
  model: string | null;
  baseUrl: string | null;
  /** Resolved: `null` means going direct. */
  proxyUrl: string | null;
}

function emptyProfile(): ProviderProfile {
  return { apiKey: null, model: null, baseUrl: null, proxyUrl: null };
}

function readProfile(raw: Partial<ProviderProfile> | undefined, proxyUrl: string | null): ProviderProfile {
  return {
    apiKey: raw?.apiKey || null,
    model: raw?.model || null,
    baseUrl: raw?.baseUrl || null,
    proxyUrl: raw?.proxyUrl !== undefined ? raw.proxyUrl : proxyUrl
  };
}

function newSourceId() {
  return crypto.randomBytes(6).toString('base64url');
}

interface SettingsFile {
  /** Which wire protocol is in use. */
  provider: LLMProvider;
  gemini: ProviderProfile;
  openaiSources: OpenAISource[];
  /** Which of `openaiSources` is read when `provider` is `openai`. */
  activeOpenAISourceId: string | null;
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

/**
 * The shapes older files were written in: one key, model and base URL at the
 * top level, then one profile per provider. Either way the proxy was shared.
 */
type LegacyFields = Partial<ProviderProfile> & {
  profiles?: Partial<Record<LLMProvider, Partial<ProviderProfile>>>;
};

function emptySettings(): SettingsFile {
  return {
    provider: 'gemini',
    gemini: emptyProfile(),
    openaiSources: [],
    activeOpenAISourceId: null,
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
}

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
          Partial<SettingsFile> & LegacyFields;
        // Absent in files written before OpenAI-compatible APIs were
        // supported, all of which were Gemini.
        const provider = isLLMProvider(parsed.provider) ? parsed.provider : 'gemini';
        // Shared by both providers before each source had its own.
        const legacyProxy = parsed.proxyUrl ?? null;

        let gemini: ProviderProfile;
        let openaiSources: OpenAISource[];
        let activeOpenAISourceId: string | null;
        if (Array.isArray(parsed.openaiSources)) {
          gemini = readProfile(parsed.gemini, null);
          openaiSources = parsed.openaiSources
            .filter((source) => source && typeof source.id === 'string')
            .map((source) => ({
              ...readProfile(source, null),
              id: source.id,
              name: source.name || 'OpenAI'
            }));
          activeOpenAISourceId =
            openaiSources.find((source) => source.id === parsed.activeOpenAISourceId)?.id ??
            openaiSources[0]?.id ?? null;
        }
        else {
          // One profile per provider, or before that one set of fields at the
          // top level belonging to whichever provider was in use.
          const legacy = parsed.profiles || { [provider]: parsed };
          gemini = readProfile(legacy.gemini, legacyProxy);
          const openai = readProfile(legacy.openai, legacyProxy);
          openaiSources = [];
          activeOpenAISourceId = null;
          if (openai.apiKey || openai.model || openai.baseUrl || provider === 'openai') {
            // A fixed id, so it stays the same across restarts until the file
            // is next written in the new shape.
            openaiSources.push({ ...openai, id: 'default', name: 'OpenAI' });
            activeOpenAISourceId = 'default';
          }
        }

        return new TranslationSettingsStore(filePath, {
          provider,
          gemini,
          openaiSources,
          activeOpenAISourceId,
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
    return new TranslationSettingsStore(filePath, emptySettings(), logger);
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

  #activeOpenAISource(): OpenAISource | null {
    return this.#data.openaiSources.find(
      (source) => source.id === this.#data.activeOpenAISourceId
    ) || null;
  }

  /**
   * The profile requests are sent with. `null` only when the OpenAI-compatible
   * protocol is in use with no source saved, which leaves the environment.
   */
  #activeProfile(): ProviderProfile | null {
    return this.#data.provider === 'openai' ? this.#activeOpenAISource() : this.#data.gemini;
  }

  /**
   * The saved value, then the environment, then the built-in default - which
   * is a local proxy, since Gemini is not reachable from everywhere. A saved
   * empty string is honoured as "no proxy" rather than falling back again.
   */
  static #resolveProxy(saved: string | null): string | null {
    if (saved !== null) {
      return saved || null;
    }
    if (process.env.GEMINI_PROXY_URL !== undefined) {
      return process.env.GEMINI_PROXY_URL || null;
    }
    return DEFAULT_PROXY_URL;
  }

  #describe(provider: LLMProvider, profile: ProviderProfile | null): ProfileDescription {
    const env = this.#env(provider);
    return {
      source: profile?.apiKey ? 'file' : env.apiKey ? 'env' : null,
      model: profile?.model || env.model || null,
      baseUrl: profile?.baseUrl || env.baseUrl || null,
      proxyUrl: TranslationSettingsStore.#resolveProxy(profile?.proxyUrl ?? null)
    };
  }

  /**
   * The key in use, preferring what an administrator saved over the
   * environment. The environment remains the way to configure a deployment
   * that has no one to click anything.
   */
  getApiKey(): string | null {
    return this.#activeProfile()?.apiKey || this.#env(this.#data.provider).apiKey || null;
  }

  /** Where the key in use came from, so the browser can say so. */
  getApiKeySource(): 'file' | 'env' | null {
    return this.#describe(this.#data.provider, this.#activeProfile()).source;
  }

  getModel(): string | null {
    return this.#describe(this.#data.provider, this.#activeProfile()).model;
  }

  getBaseUrl(): string | null {
    return this.#describe(this.#data.provider, this.#activeProfile()).baseUrl;
  }

  /** The proxy the requests in use go through, or `null` to go direct. */
  getProxyUrl(): string | null {
    return TranslationSettingsStore.#resolveProxy(this.#activeProfile()?.proxyUrl ?? null);
  }

  getActiveOpenAISourceId(): string | null {
    return this.#data.activeOpenAISourceId;
  }

  /** Everything saved, for the form to switch between. Never a key. */
  describeProfiles() {
    return {
      gemini: this.#describe('gemini', this.#data.gemini),
      openai: this.#data.openaiSources.map((source) => ({
        id: source.id,
        name: source.name,
        ...this.#describe('openai', source)
      }))
    };
  }

  hasOpenAISource(id: string): boolean {
    return this.#data.openaiSources.some((source) => source.id === id);
  }

  /**
   * Forgets a source, key included. When it was the one in use the first one
   * left takes over, or the environment when none is.
   */
  deleteOpenAISource(id: string) {
    this.#data.openaiSources = this.#data.openaiSources.filter((source) => source.id !== id);
    if (this.#data.activeOpenAISourceId === id) {
      this.#data.activeOpenAISourceId = this.#data.openaiSources[0]?.id ?? null;
    }
    this.#save();
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
   * `apiKey`, `model`, `baseUrl` and `proxyUrl` are written to the profile in
   * use once `provider` and the source have been applied: Gemini's, or the
   * OpenAI-compatible source picked by `openaiSourceId` - or a new one named
   * `newOpenAISourceName`. Every other profile is left as it was, ready for a
   * switch back.
   */
  update(params: {
    provider?: LLMProvider;
    /** Must name a source that exists - the caller checks. */
    openaiSourceId?: string;
    newOpenAISourceName?: string;
    /** Renames the source in use. */
    sourceName?: string;
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
    if (params.newOpenAISourceName !== undefined) {
      const id = newSourceId();
      this.#data.openaiSources.push({ ...emptyProfile(), id, name: params.newOpenAISourceName });
      this.#data.activeOpenAISourceId = id;
    }
    else if (params.openaiSourceId !== undefined && this.hasOpenAISource(params.openaiSourceId)) {
      this.#data.activeOpenAISourceId = params.openaiSourceId;
    }

    let profile = this.#activeProfile();
    // Saving OpenAI-compatible settings with nothing to save them into makes
    // the first source rather than dropping them.
    if (!profile && this.#data.provider === 'openai') {
      const id = newSourceId();
      const source = { ...emptyProfile(), id, name: params.sourceName || 'OpenAI' };
      this.#data.openaiSources.push(source);
      this.#data.activeOpenAISourceId = id;
      profile = source;
    }
    if (params.sourceName && this.#data.provider === 'openai') {
      const source = this.#activeOpenAISource();
      if (source) {
        source.name = params.sourceName;
      }
    }
    if (profile) {
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
        // Kept verbatim, empty string included - see `#resolveProxy`.
        profile.proxyUrl = params.proxyUrl;
      }
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
