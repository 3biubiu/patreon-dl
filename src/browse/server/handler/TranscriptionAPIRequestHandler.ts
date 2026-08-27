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
import { listSubtitlesFor, readSubtitleAsVTT } from '../transcription/SubtitleLibrary.js';
import { type TranscriptionRecord, type TranscriptionSettings } from '../../types/Transcription.js';

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

  constructor(
    db: DBInstance,
    dataDir: string,
    index: TranscriptionIndex,
    queue: TranscriptionQueue,
    vad: VoiceActivityDetector,
    settings: TranscriptionSettingsStore,
    logger?: Logger | null
  ) {
    super(logger);
    this.#db = db;
    this.#dataDir = dataDir;
    this.#queue = queue;
    this.#index = index;
    this.#vad = vad;
    this.#settings = settings;
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
    if (!this.#settings.getApiKey()) {
      return 'No OpenRouter API key is configured. An administrator can set one in the ' +
        'transcription settings.';
    }
    return await this.#vad.getUnavailableReason();
  }

  /** Whether transcription is configured at all, and why not when it is not. */
  async handleStatusRequest(_req: Request, res: Response) {
    const blocked = await this.#getBlockedReason();
    res.json(blocked ? { available: false, reason: blocked } : { available: true, reason: null });
  }

  /**
   * The settings as the browser may see them: never the key itself, only
   * whether one is set and the masked label OpenRouter reports for it.
   */
  async handleGetSettingsRequest(_req: Request, res: Response) {
    const apiKey = this.#settings.getApiKey();
    const settings: TranscriptionSettings = {
      configured: !!apiKey,
      source: this.#settings.getApiKeySource(),
      model: this.#settings.getModel() || DEFAULT_MODEL,
      baseUrl: this.#settings.getBaseUrl() || DEFAULT_BASE_URL,
      key: null,
      keyError: null
    };
    if (apiKey) {
      try {
        settings.key = await OpenRouterTranscriber.describeKey(apiKey, settings.baseUrl);
      }
      catch (error) {
        // A key that cannot be checked right now is still configured; say so
        // rather than reporting it as absent.
        settings.keyError = error instanceof Error ? error.message : String(error);
      }
    }
    res.json({ settings });
  }

  /**
   * Saves the settings, after checking any new key against OpenRouter so a
   * mistyped one is rejected here rather than at the first video.
   */
  async handleSaveSettingsRequest(req: Request, res: Response) {
    const body = (req.body || {}) as { apiKey?: unknown; model?: unknown; baseUrl?: unknown };
    const patch: { apiKey?: string | null; model?: string | null; baseUrl?: string | null } = {};

    if (body.model !== undefined) {
      patch.model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null;
    }
    if (body.baseUrl !== undefined) {
      patch.baseUrl = typeof body.baseUrl === 'string' && body.baseUrl.trim() ? body.baseUrl.trim() : null;
    }

    if (body.apiKey !== undefined) {
      const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
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
            error: error instanceof Error ? error.message : 'Could not verify this API key'
          });
          return;
        }
        patch.apiKey = apiKey;
      }
    }

    this.#settings.update(patch);
    // Never log the key, and never echo it back - the response is the same
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
