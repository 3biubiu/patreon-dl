import { type Request, type Response } from 'express';
import fs from 'fs';
import path from 'path';
import { type Logger } from '../../../utils/logging/index.js';
import { type DBInstance } from '../../db/index.js';
import Basehandler from './BaseHandler.js';
import type TranscriptionQueue from '../transcription/TranscriptionQueue.js';
import type TranscriptionIndex from '../transcription/TranscriptionIndex.js';
import type VoiceActivityDetector from '../transcription/VoiceActivityDetector.js';
import { describeIndexedSubtitle, listSubtitlesFor, readSubtitleAsVTT } from '../transcription/SubtitleLibrary.js';
import { type SubtitleFile } from '../../types/Transcription.js';

/** Keeps one request from turning into an unbounded pile of index lookups. */
const MAX_BATCH_IDS = 200;

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
  #queue: TranscriptionQueue | null;
  #index: TranscriptionIndex;
  #vad: VoiceActivityDetector | null;

  constructor(
    db: DBInstance,
    dataDir: string,
    index: TranscriptionIndex,
    queue: TranscriptionQueue | null,
    vad: VoiceActivityDetector | null,
    logger?: Logger | null
  ) {
    super(logger);
    this.#db = db;
    this.#dataDir = dataDir;
    this.#queue = queue;
    this.#index = index;
    this.#vad = vad;
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

  /** Whether transcription is configured at all, and why not when it is not. */
  async handleStatusRequest(_req: Request, res: Response) {
    if (!this.#queue || !this.#vad) {
      res.json({
        available: false,
        reason: 'Transcription is not configured. Set an OpenRouter API key to enable it.'
      });
      return;
    }
    const blocked = await this.#vad.getUnavailableReason();
    res.json(blocked ? { available: false, reason: blocked } : { available: true, reason: null });
  }

  async handleTranscribeRequest(req: Request, res: Response, id: string) {
    if (!this.#queue || !this.#vad) {
      res.status(503).json({ error: 'Transcription is not configured on this server' });
      return;
    }
    const blocked = await this.#vad.getUnavailableReason();
    if (blocked) {
      res.status(503).json({ error: blocked });
      return;
    }
    const video = this.#resolveVideo(id);
    if (!video) {
      res.status(404).json({ error: 'No video found for this media' });
      return;
    }
    const job = this.#queue.enqueue(id, video);
    this.log('info', `Transcription queued for media "${id}"`);
    res.json({ job });
  }

  handleCancelRequest(_req: Request, res: Response, id: string) {
    if (!this.#queue) {
      res.status(503).json({ error: 'Transcription is not configured on this server' });
      return;
    }
    const cancelled = this.#queue.cancel(id);
    res.json({ cancelled });
  }

  /**
   * Live progress when a job is running, falling back to what the index
   * remembers. The index is the only thing that survives a restart.
   */
  handleJobRequest(_req: Request, res: Response, id: string) {
    const job = this.#queue?.getJob(id) || null;
    const record = this.#index.get(id);
    res.json({ job, record });
  }

  handleListJobsRequest(_req: Request, res: Response) {
    res.json({
      jobs: this.#queue?.listJobs() || [],
      records: this.#index.list()
    });
  }

  /**
   * The captions to hand a player for each of `ids`, answered from the index
   * alone.
   *
   * A grid draws many tiles at once, and looking beside each of their videos
   * would be one directory read per tile - the cost this index exists to
   * avoid. The trade is that a subtitle dropped in by hand is not listed here;
   * `handleSubtitleListRequest` finds those, for one video at a time.
   */
  handleBatchSubtitleRequest(req: Request, res: Response) {
    const raw = typeof req.query.ids === 'string' ? req.query.ids : '';
    const ids = raw.split(',').map((id) => id.trim()).filter(Boolean).slice(0, MAX_BATCH_IDS);
    const subtitles: Record<string, SubtitleFile[]> = {};
    for (const id of ids) {
      const record = this.#index.get(id);
      if (record?.state === 'done' && record.subtitlePath) {
        subtitles[id] = [ describeIndexedSubtitle(record.subtitlePath, record.language) ];
      }
    }
    res.json({ subtitles });
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
