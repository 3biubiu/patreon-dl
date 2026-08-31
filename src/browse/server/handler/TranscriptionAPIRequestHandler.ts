import { type Request, type Response } from 'express';
import fs from 'fs';
import path from 'path';
import { type Logger } from '../../../utils/logging/index.js';
import { type DBInstance } from '../../db/index.js';
import Basehandler from './BaseHandler.js';
import type TranscriptionQueue from '../transcription/TranscriptionQueue.js';
import type TranscriptionIndex from '../transcription/TranscriptionIndex.js';
import type VoiceActivityDetector from '../transcription/VoiceActivityDetector.js';
import type TranscriptionSettingsStore from '../transcription/TranscriptionSettingsStore.js';
import OpenRouterTranscriber, { DEFAULT_BASE_URL, DEFAULT_MODEL } from '../transcription/OpenRouterTranscriber.js';
import GeminiTranscriber, {
  DEFAULT_BASE_URL as GEMINI_DEFAULT_BASE_URL,
  DEFAULT_MODEL as GEMINI_DEFAULT_MODEL
} from '../transcription/GeminiTranscriber.js';
import VocabularyStore, { RECOMMENDED_TERMS } from '../transcription/VocabularyStore.js';
import { DEFAULTS as VAD_DEFAULTS } from '../transcription/VoiceActivityDetector.js';
import { VAD_RANGES } from '../transcription/TranscriptionSettingsStore.js';
import { listSubtitlesFor, readSubtitleAsVTT } from '../transcription/SubtitleLibrary.js';
import {
  type GeminiProviderSettings,
  type ProviderSettings,
  type TranscriptionProvider,
  type TranscriptionRecord,
  type TranscriptionSettings
} from '../../types/Transcription.js';

const PROVIDER_LABELS: Record<TranscriptionProvider, string> = {
  openrouter: 'OpenRouter',
  gemini: 'Gemini'
};

function readProvider(value: unknown): TranscriptionProvider | null {
  return value === 'openrouter' || value === 'gemini' ? value : null;
}

/** A trimmed string, or null for anything that is not usable text. */
function readText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

const VIDEO_EXTENSIONS = [
  '.mp4', '.m4v', '.mkv', '.webm', '.mov', '.avi', '.flv', '.wmv', '.mpg', '.mpeg', '.ts', '.m2ts', '.ogv'
];

function looksLikeVideo(filePath: string, mimeType?: string | null) {
  if (mimeType) {
    return mimeType.startsWith('video/');
  }
  return VIDEO_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}

/**
 * Transcription: starting jobs, reporting their progress, and serving the
 * subtitles that come out.
 *
 * Starting and cancelling are for administrators; reading is not, so that an
 * ordinary viewer's player can still list and load captions.
 */
export default class TranscriptionAPIRequestHandler extends Basehandler {
  name = 'TranscriptionAPIRequestHandler';

  #db: DBInstance;
  #dataDir: string;
  #queue: TranscriptionQueue;
  #index: TranscriptionIndex;
  #vad: VoiceActivityDetector;
  #settings: TranscriptionSettingsStore;
  #vocabulary: VocabularyStore;

  constructor(
    db: DBInstance,
    dataDir: string,
    index: TranscriptionIndex,
    queue: TranscriptionQueue,
    vad: VoiceActivityDetector,
    settings: TranscriptionSettingsStore,
    vocabulary: VocabularyStore,
    logger?: Logger | null
  ) {
    super(logger);
    this.#db = db;
    this.#dataDir = dataDir;
    this.#queue = queue;
    this.#index = index;
    this.#vad = vad;
    this.#settings = settings;
    this.#vocabulary = vocabulary;
  }

  /**
   * Resolves a media id to a playable video on disk, or `null`. Subtitles are
   * only ever read from beside a file the database already knows about, so a
   * media id can never be used to reach elsewhere on the filesystem.
   */
  #resolveVideo(id: string) {
    const downloaded = this.#db.getMediaByID(id);
    if (!downloaded?.path) {
      return null;
    }
    const file = path.resolve(this.#dataDir, downloaded.path);
    if (!fs.existsSync(file) || !looksLikeVideo(file, downloaded.mimeType)) {
      return null;
    }
    return file;
  }

  /**
   * Fills in `postId` / `contentType` from the media-to-content link, so the
   * history list can send a row back to the post the video is in. Done on the
   * way out rather than stored: the link belongs to the library, not to the
   * transcription, and a record outlives nothing by carrying a stale copy.
   */
  #withContentRef(record: TranscriptionRecord): TranscriptionRecord {
    const ref = this.#db.getMediaContentRef(record.mediaId);
    return { ...record, postId: ref?.contentId ?? null, contentType: ref?.contentType ?? null };
  }

  #withContentRefs(records: TranscriptionRecord[]): TranscriptionRecord[] {
    return records.map((record) => this.#withContentRef(record));
  }

  /** Why transcription cannot run, or `null` when it can. */
  async #getBlockedReason(): Promise<string | null> {
    if (!this.#settings.getActiveApiKey()) {
      const provider = PROVIDER_LABELS[this.#settings.getProvider()];
      return `No ${provider} API key is configured. An administrator can set one in ` +
        'the transcription settings, or switch to the other provider there.';
    }
    return await this.#vad.getUnavailableReason();
  }

  /** Whether transcription is configured at all, and why not when it is not. */
  async handleStatusRequest(_req: Request, res: Response) {
    const blocked = await this.#getBlockedReason();
    res.json(blocked ? { available: false, reason: blocked } : { available: true, reason: null });
  }

  /** One provider's half of the form: never a key, only what is known of it. */
  async #describeOpenRouter(): Promise<ProviderSettings> {
    const apiKey = this.#settings.getApiKey();
    const provider: ProviderSettings = {
      configured: !!apiKey,
      source: this.#settings.getApiKeySource(),
      model: this.#settings.getModel() || DEFAULT_MODEL,
      baseUrl: this.#settings.getBaseUrl() || DEFAULT_BASE_URL,
      key: null,
      keyError: null
    };
    if (apiKey) {
      try {
        provider.key = await OpenRouterTranscriber.describeKey(apiKey, provider.baseUrl);
      }
      catch (error) {
        // A key that cannot be checked right now is still configured; say so
        // rather than reporting it as absent.
        provider.keyError = error instanceof Error ? error.message : String(error);
      }
    }
    return provider;
  }

  async #describeGemini(): Promise<GeminiProviderSettings> {
    const apiKey = this.#settings.getGeminiApiKey();
    const proxyUrl = this.#settings.getGeminiProxyUrl();
    const provider: GeminiProviderSettings = {
      configured: !!apiKey,
      source: this.#settings.getGeminiApiKeySource(),
      model: this.#settings.getGeminiModel() || GEMINI_DEFAULT_MODEL,
      baseUrl: this.#settings.getGeminiBaseUrl() || GEMINI_DEFAULT_BASE_URL,
      proxyUrl: proxyUrl || '',
      // Gemini reports nothing about a key beyond whether it is accepted, so
      // there is no description to fill in - only an error when it is not.
      key: null,
      keyError: null
    };
    if (apiKey) {
      try {
        // Through the proxy the transcriptions will use, so that a key
        // reported as working here is one that will work there.
        await GeminiTranscriber.describeKey(apiKey, provider.baseUrl, proxyUrl);
      }
      catch (error) {
        provider.keyError = error instanceof Error ? error.message : String(error);
      }
    }
    return provider;
  }

  #describeVocabulary(provider: TranscriptionProvider) {
    const text = this.#vocabulary.getText();
    const { terms, mappings } = VocabularyStore.parse(text);
    return {
      path: this.#vocabulary.filePath,
      text,
      termCount: terms.length,
      mappingCount: mappings.length,
      warning: terms.length > RECOMMENDED_TERMS ?
        `${terms.length} terms. Biasing works best at up to ${RECOMMENDED_TERMS}; ` +
        'past that, ordinary words in the list start pulling the transcript ' +
        'towards themselves.'
        : null,
      // Whisper through OpenRouter takes no vocabulary. The list is shown as
      // idle rather than hidden, because hiding it would leave no way to see
      // that switching provider is what turns it on.
      supported: provider === 'gemini'
    };
  }

  /**
   * The settings as the browser may see them: never a key itself, only whether
   * one is set and whatever the provider says about it.
   */
  async handleGetSettingsRequest(_req: Request, res: Response) {
    const provider = this.#settings.getProvider();
    // Both are checked whichever is in use, so the form can show at a glance
    // which one is ready to switch to.
    const [ openrouter, gemini ] = await Promise.all([
      this.#describeOpenRouter(),
      this.#describeGemini()
    ]);
    const settings: TranscriptionSettings = {
      provider,
      configured: !!this.#settings.getActiveApiKey(),
      openrouter,
      gemini,
      vocabulary: this.#describeVocabulary(provider),
      vad: {
        values: this.#settings.getVADSettings(),
        defaults: {
          threshold: VAD_DEFAULTS.threshold,
          minSilenceDuration: VAD_DEFAULTS.minSilenceDuration,
          speechPad: VAD_DEFAULTS.speechPad,
          mergeGap: VAD_DEFAULTS.mergeGap
        },
        ranges: VAD_RANGES
      }
    };
    res.json({ settings });
  }

  /**
   * Saves the settings, checking any new key against its own provider so a
   * mistyped one is rejected here rather than at the first video.
   */
  async handleSaveSettingsRequest(req: Request, res: Response) {
    const body = (req.body || {}) as Record<string, unknown>;
    const patch: Parameters<TranscriptionSettingsStore['update']>[0] = {};

    if (body.provider !== undefined) {
      const provider = readProvider(body.provider);
      if (!provider) {
        res.status(400).json({ error: 'Unknown transcription provider' });
        return;
      }
      patch.provider = provider;
    }
    if (body.model !== undefined) {
      patch.model = readText(body.model);
    }
    if (body.baseUrl !== undefined) {
      patch.baseUrl = readText(body.baseUrl);
    }
    if (body.geminiModel !== undefined) {
      patch.geminiModel = readText(body.geminiModel);
    }
    if (body.geminiBaseUrl !== undefined) {
      patch.geminiBaseUrl = readText(body.geminiBaseUrl);
    }
    if (body.geminiProxyUrl !== undefined) {
      // Stored verbatim rather than through `readText`: an empty value here is
      // a decision - "go direct" - and must not read as "unset", which would
      // put the default proxy back.
      patch.geminiProxyUrl = typeof body.geminiProxyUrl === 'string' ?
        body.geminiProxyUrl.trim()
        : null;
    }

    if (body.apiKey !== undefined) {
      const apiKey = readText(body.apiKey);
      if (!apiKey) {
        // An empty value clears the saved key and falls back to the
        // environment, which is the only way to undo this from the browser.
        patch.apiKey = null;
      }
      else {
        const baseUrl = patch.baseUrl || this.#settings.getBaseUrl() || DEFAULT_BASE_URL;
        try {
          await OpenRouterTranscriber.describeKey(apiKey, baseUrl);
        }
        catch (error) {
          res.status(400).json({
            error: error instanceof Error ?
              error.message
              : 'Could not verify this OpenRouter API key'
          });
          return;
        }
        patch.apiKey = apiKey;
      }
    }

    if (body.geminiApiKey !== undefined) {
      const apiKey = readText(body.geminiApiKey);
      if (!apiKey) {
        patch.geminiApiKey = null;
      }
      else {
        const baseUrl = patch.geminiBaseUrl ||
          this.#settings.getGeminiBaseUrl() ||
          GEMINI_DEFAULT_BASE_URL;
        // The proxy being saved alongside, not the one saved before it: a key
        // and the proxy it has to be reached through are commonly set together.
        const proxyUrl = patch.geminiProxyUrl !== undefined ?
          patch.geminiProxyUrl || null
          : this.#settings.getGeminiProxyUrl();
        try {
          await GeminiTranscriber.describeKey(apiKey, baseUrl, proxyUrl);
        }
        catch (error) {
          res.status(400).json({
            error: error instanceof Error ?
              error.message
              : 'Could not verify this Gemini API key'
          });
          return;
        }
        patch.geminiApiKey = apiKey;
      }
    }

    // The vocabulary is a file rather than a settings field, so it is written
    // on its own. After the keys have been checked, so a form rejected for a
    // bad key does not leave the list changed behind it.
    if (typeof body.vocabulary === 'string') {
      try {
        this.#vocabulary.setText(body.vocabulary);
      }
      catch (error) {
        res.status(500).json({
          error: `Could not write the vocabulary file: ${
            error instanceof Error ? error.message : String(error)}`
        });
        return;
      }
    }

    // The detector overrides: a missing field means "leave it as it is", so
    // the form can save the credentials without touching them.
    if (typeof body.vad === 'object' && body.vad !== null) {
      const vad = body.vad as Record<string, unknown>;
      const read = (field: string) =>
        field in vad ?
          (Number.isFinite(Number(vad[field])) ? Number(vad[field]) : null)
          : undefined;
      patch.vad = {
        threshold: read('threshold'),
        minSilenceDuration: read('minSilenceDuration'),
        speechPad: read('speechPad'),
        mergeGap: read('mergeGap')
      };
    }

    this.#settings.update(patch);
    // Never log a key, and never echo one back - the response is the same
    // masked view as a plain read.
    this.log('info', 'Transcription settings updated');
    await this.handleGetSettingsRequest(req, res);
  }

  async handleTranscribeRequest(req: Request, res: Response, id: string) {
    const blocked = await this.#getBlockedReason();
    if (blocked) {
      res.status(503).json({ error: blocked });
      return;
    }
    const video = this.#resolveVideo(id);
    if (!video) {
      res.status(404).json({ error: 'No video found for this media' });
      return;
    }
    const record = this.#queue.enqueue(id, video);
    this.log('info', `Transcription queued for media "${id}"`);
    res.json({ record: this.#withContentRef(record) });
  }

  handleCancelRequest(_req: Request, res: Response, id: string) {
    const cancelled = this.#queue.cancel(id);
    res.json({ cancelled });
  }

  /** Stops the running job and empties the queue behind it. */
  handleCancelAllRequest(_req: Request, res: Response) {
    const stopped = this.#queue.cancelAll();
    this.log('info', `Stopped ${stopped} transcription(s) on request`);
    res.json({ stopped, records: this.#withContentRefs(this.#index.list()) });
  }

  /** One video's transcription, at whatever stage it has reached. */
  handleJobRequest(_req: Request, res: Response, id: string) {
    const record = this.#index.get(id);
    res.json({ record: record ? this.#withContentRef(record) : null });
  }

  /** The whole history, newest request first. */
  handleListJobsRequest(_req: Request, res: Response) {
    res.json({ records: this.#withContentRefs(this.#index.list()) });
  }

  /**
   * Drops every record that is no longer moving, leaving anything queued or
   * running alone. Only the history is cleared - subtitle files already
   * written stay where they are.
   */
  handleClearHistoryRequest(_req: Request, res: Response) {
    const removed = this.#index.clearFinished();
    res.json({ removed, records: this.#withContentRefs(this.#index.list()) });
  }

  /** Forgets one record, so its video looks untranscribed again. */
  handleForgetRequest(_req: Request, res: Response, id: string) {
    res.json({ removed: this.#index.remove(id) });
  }

  /**
   * The subtitles available for a video. Read from its directory on each
   * request, so a file added or removed by hand is picked up without anything
   * needing to be re-indexed.
   */
  handleSubtitleListRequest(_req: Request, res: Response, id: string) {
    const video = this.#resolveVideo(id);
    if (!video) {
      // Not an error: a player asks this for anything it opens, and most
      // things have no subtitles.
      res.json({ subtitles: [] });
      return;
    }
    res.json({ subtitles: listSubtitlesFor(video) });
  }

  /** Serves one subtitle as WebVTT, which is all `<track>` will accept. */
  handleSubtitleRequest(req: Request, res: Response, id: string, filename: string) {
    const video = this.#resolveVideo(id);
    if (!video) {
      res.status(404).send('Not found');
      return;
    }
    const vtt = readSubtitleAsVTT(video, filename);
    if (vtt === null) {
      res.status(404).send('Not found');
      return;
    }
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    // Captions change only when re-transcribed, and the player re-requests
    // them on every open.
    res.setHeader('Cache-Control', 'no-cache');
    res.send(vtt);
  }
}
