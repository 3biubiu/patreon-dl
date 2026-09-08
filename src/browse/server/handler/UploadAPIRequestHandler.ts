import { type Request, type Response } from 'express';
import fs from 'fs';
import path from 'path';
import contentDisposition from 'content-disposition';
import { type Logger } from '../../../utils/logging/index.js';
import Basehandler from './BaseHandler.js';
import type UploadStore from '../UploadStore.js';
import type TranscriptionQueue from '../transcription/TranscriptionQueue.js';
import type TranscriptionIndex from '../transcription/TranscriptionIndex.js';
import type TranscriptionSettingsStore from '../transcription/TranscriptionSettingsStore.js';
import type VoiceActivityDetector from '../transcription/VoiceActivityDetector.js';
import type TranslationQueue from '../translation/TranslationQueue.js';
import { listSubtitlesFor } from '../transcription/SubtitleLibrary.js';
import { type AuthenticatedRequest } from '../AuthGuard.js';
import { type UploadJob, type UploadJobView } from '../../types/Upload.js';
import { type SubtitleFile } from '../../types/Transcription.js';

/**
 * Most audio one upload may be.
 *
 * The browser sends 16 kHz mono Opus, which runs about 5 MB an hour, so this
 * is somewhere north of a hundred hours of talking - a ceiling against a bug
 * or a hostile client rather than against a long film. It is checked while the
 * bytes arrive as well as against the declared length, because a declared
 * length is only a claim.
 */
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

/** How many jobs one account may have on file. Its own uploads, not the queue. */
const MAX_JOBS_PER_USER = 50;

/**
 * The audio container the page sends, and the only extension written to disk.
 *
 * Not taken from the upload: what arrives names a video that was never sent,
 * and a filename off the wire is the last thing to build a path out of.
 */
const AUDIO_EXTENSION = '.ogg';

/** What the stored audio is called inside the job's own directory. */
const AUDIO_STEM = 'audio';

/**
 * A name safe to show in a list and to build a subtitle name from.
 *
 * The uploader's filename is kept for display, but everything about the path
 * on disk comes from the job id - so this is about what a page renders and
 * what a `Content-Disposition` says, not about where anything is written.
 */
function cleanTitle(value: unknown): string {
  if (typeof value !== 'string') {
    return 'Untitled';
  }
  // Path separators and control characters out; the rest is the user's own
  // filename, spaces and all, and worth keeping as they had it.
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\\/\u0000-\u001f]/g, ' ').trim();
  return cleaned.slice(0, 200) || 'Untitled';
}

/**
 * The language part of a downloaded subtitle's name: `zh`, not `zh-Hans`.
 *
 * The tag on disk is what the translator wrote and is worth keeping there -
 * it says exactly which Chinese it is. What people want in their downloads
 * folder is the short form, and it is what every player and every other tool
 * expects to see beside a video: `Talk.zh.srt`, `Talk.en.srt`.
 */
function shortLanguage(language: string | null): string | null {
  if (!language) {
    return null;
  }
  const primary = language.split('-')[0].toLowerCase();
  return primary || null;
}

/**
 * What one subtitle is called when it is saved.
 *
 * `<the video's name>.<language>.srt` - the video's, not the audio's: the file
 * on disk is `audio.zh-Hans.srt`, which says nothing about which video it
 * belongs to once it is sitting in a downloads folder next to nine others.
 *
 * `others` is the rest of the job's subtitles, and is only there to settle the
 * one case where shortening loses information: a job holding both `zh-Hans`
 * and `zh-Hant` cannot have them both saved as `.zh.srt`, so in that case both
 * keep the tag they were written with.
 */
function downloadNameFor(title: string, subtitle: SubtitleFile, others: SubtitleFile[]): string {
  const stem = title.replace(/\.[^.]+$/, '') || title;
  const extension = path.extname(subtitle.filename) || '.srt';
  const short = shortLanguage(subtitle.language);
  if (!short) {
    return `${stem}${extension}`;
  }
  const collides = others.some((other) =>
    other.filename !== subtitle.filename &&
    shortLanguage(other.language) === short
  );
  return `${stem}.${collides ? subtitle.language : short}${extension}`;
}

function readNumber(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Number.parseFloat(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Videos people upload to have captioned, and the captions that come back.
 *
 * The pipeline behind this is the same one the library's own videos go
 * through - the same queue, the same index, the same translation pass. All
 * that is different is where the audio came from and who is allowed to see the
 * result, which is what this handler is: an owner check in front of work that
 * already existed.
 *
 * The video itself is never uploaded. The page strips it to 16 kHz mono audio
 * in the browser first, which is all the transcription ever reads and a
 * fraction of the bytes - a two gigabyte film arrives as a few megabytes.
 */
export default class UploadAPIRequestHandler extends Basehandler {
  name = 'UploadAPIRequestHandler';

  #store: UploadStore;
  #queue: TranscriptionQueue;
  #index: TranscriptionIndex;
  #translationQueue: TranslationQueue;
  #settings: TranscriptionSettingsStore;
  #vad: VoiceActivityDetector;

  constructor(
    store: UploadStore,
    queue: TranscriptionQueue,
    index: TranscriptionIndex,
    translationQueue: TranslationQueue,
    settings: TranscriptionSettingsStore,
    vad: VoiceActivityDetector,
    logger?: Logger | null
  ) {
    super(logger);
    this.#store = store;
    this.#queue = queue;
    this.#index = index;
    this.#translationQueue = translationQueue;
    this.#settings = settings;
    this.#vad = vad;
  }

  /**
   * Takes one upload and queues it.
   *
   * The body is the audio itself rather than a multipart form: there is one
   * file and no fields, the fields it does need fit in the query string, and
   * streaming the body straight to disk means a long upload never sits in
   * memory. Everything on the query is a claim to be checked - the bytes on
   * disk are what the size is read from afterwards.
   */
  async handleUploadRequest(req: Request, res: Response) {
    const user = (req as AuthenticatedRequest).authUser;
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const blocked = await this.#getBlockedReason();
    if (blocked) {
      res.status(503).json({ error: blocked });
      return;
    }
    if (this.#store.countFor(user.id) >= MAX_JOBS_PER_USER) {
      res.status(409).json({
        error: `You have ${MAX_JOBS_PER_USER} uploads on file. Delete one before adding another.`
      });
      return;
    }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
      res.status(413).json({ error: 'That audio is too large to upload' });
      return;
    }

    const title = cleanTitle(req.query.title);
    const duration = readNumber(req.query.duration);
    const translate = req.query.translate === '1';
    const { id, mediaId, directory } = this.#store.reserve();
    const audioPath = path.resolve(directory, `${AUDIO_STEM}${AUDIO_EXTENSION}`);

    let size: number;
    try {
      size = await this.#receive(req, audioPath);
    }
    catch (error) {
      // Nothing has been recorded yet, so cleaning up is deleting the
      // directory that was reserved for it.
      fs.rmSync(directory, { recursive: true, force: true });
      const message = error instanceof Error ? error.message : 'Could not read the upload';
      this.log('warn', `Upload from "${user.username}" failed: ${message}`);
      if (!res.headersSent) {
        res.status(message.includes('too large') ? 413 : 400).json({ error: message });
      }
      return;
    }

    const job: UploadJob = {
      id,
      mediaId,
      userId: user.id,
      username: user.username,
      title,
      size,
      duration,
      createdAt: new Date().toISOString()
    };
    this.#store.add(job);
    this.#queue.enqueue(mediaId, audioPath, title);
    if (translate) {
      // Marks the translation pending; the transcription queue is what turns
      // that into a queued job once there is a subtitle to translate.
      this.#translationQueue.enqueue(mediaId);
    }
    this.log('info',
      `Queued upload "${title}" (${(size / 1024 / 1024).toFixed(1)} MB) from "${user.username}"` +
      (translate ? ', with translation' : '')
    );
    res.json({ job: this.#withRecord(job) });
  }

  /** The caller's own uploads; an administrator sees everybody's. */
  handleListRequest(req: Request, res: Response) {
    const user = (req as AuthenticatedRequest).authUser;
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const jobs = user.role === 'admin' ? this.#store.list() : this.#store.listFor(user.id);
    res.json({ jobs: jobs.map((job) => this.#withRecord(job)) });
  }

  /**
   * Stops a job if it is running, then deletes it and everything it produced.
   *
   * Both queues are told: a translation can be waiting on a transcription that
   * has not finished, and deleting the audio out from under either would leave
   * a job failing on a file that is no longer there.
   */
  handleDeleteRequest(req: Request, res: Response, id: string) {
    const job = this.#resolveOwned(req, res, id);
    if (!job) {
      return;
    }
    this.#translationQueue.cancel(job.mediaId);
    this.#queue.cancel(job.mediaId);
    this.#index.remove(job.mediaId);
    this.#store.remove(job.id);
    this.log('info', `Deleted upload "${job.title}" (${job.id})`);
    res.json({ removed: true });
  }

  /** What this job produced, which is empty until it finishes. */
  handleSubtitleListRequest(req: Request, res: Response, id: string) {
    const job = this.#resolveOwned(req, res, id);
    if (!job) {
      return;
    }
    res.json({ subtitles: this.#subtitlesFor(job) });
  }

  /**
   * Hands one subtitle over as a download.
   *
   * `filename` comes from the browser, so it is honoured only when it is one
   * of the names just listed for this job - never joined onto the directory as
   * given.
   */
  handleSubtitleDownloadRequest(req: Request, res: Response, id: string, filename: string) {
    const job = this.#resolveOwned(req, res, id);
    if (!job) {
      return;
    }
    const subtitles = this.#subtitlesFor(job);
    const match = subtitles.find((subtitle) => subtitle.filename === filename);
    if (!match) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const file = path.resolve(this.#store.directoryFor(job.id), match.filename);
    res.setHeader(
      'Content-Disposition',
      contentDisposition(downloadNameFor(job.title, match, subtitles))
    );
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    // `dotfiles: 'allow'` because every upload lives under the data
    // directory's own `.patreon-dl`, and express refuses a path with a dot
    // segment in it by default - with a 404 of its own, before this handler's
    // own checks have anything to say. The media route carries the same option
    // for the same reason.
    res.sendFile(file, { dotfiles: 'allow' }, (error?: Error) => {
      // The file was listed a moment ago, so this is a genuine surprise -
      // worth a line, and worth an answer rather than a hung request.
      if (error && !res.headersSent) {
        this.log('warn', `Could not send subtitle "${file}":`, error);
        res.status(404).json({ error: 'That subtitle is no longer there' });
      }
    });
  }

  /**
   * The job `id` names, once the caller is allowed to see it. Answers the
   * request itself when they are not, so callers can `return` on `null`.
   *
   * A job that is not yours is a 404 rather than a 403, the same way an
   * out-of-scope campaign is: confirming that somebody else's upload exists is
   * half of what the check is for.
   */
  #resolveOwned(req: Request, res: Response, id: string): UploadJob | null {
    const user = (req as AuthenticatedRequest).authUser;
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    }
    const job = this.#store.get(id);
    if (!job || (job.userId !== user.id && user.role !== 'admin')) {
      res.status(404).json({ error: 'Not found' });
      return null;
    }
    return job;
  }

  #subtitlesFor(job: UploadJob) {
    const audioPath = path.resolve(
      this.#store.directoryFor(job.id), `${AUDIO_STEM}${AUDIO_EXTENSION}`
    );
    return listSubtitlesFor(audioPath);
  }

  #withRecord(job: UploadJob): UploadJobView {
    return {
      ...job,
      record: this.#index.get(job.mediaId),
      subtitles: this.#subtitlesFor(job)
    };
  }

  /** Why an upload would be pointless right now, or `null` when it would not. */
  async #getBlockedReason(): Promise<string | null> {
    if (!this.#settings.getActiveApiKey()) {
      return 'Transcription is not configured on this server yet. ' +
        'An administrator has to set an API key first.';
    }
    return await this.#vad.getUnavailableReason();
  }

  /**
   * Streams the request body to `filePath` and resolves with what was written.
   *
   * The ceiling is enforced as the bytes arrive rather than from
   * `Content-Length` alone, which is a header a client writes and can lie in.
   */
  #receive(req: Request, filePath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(filePath);
      let written = 0;
      let settled = false;

      const fail = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        req.unpipe(out);
        out.destroy();
        reject(error);
      };

      req.on('data', (chunk: Buffer) => {
        written += chunk.length;
        if (written > MAX_UPLOAD_BYTES) {
          fail(Error('That audio is too large to upload'));
        }
      });
      req.on('error', fail);
      out.on('error', fail);
      out.on('finish', () => {
        if (settled) {
          return;
        }
        settled = true;
        if (written === 0) {
          reject(Error('The upload was empty'));
          return;
        }
        resolve(written);
      });
      req.pipe(out);
    });
  }
}
