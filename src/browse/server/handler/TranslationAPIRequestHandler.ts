import { type Request, type Response } from 'express';
import { type Logger } from '../../../utils/logging/index.js';
import Basehandler from './BaseHandler.js';
import type TranscriptionIndex from '../transcription/TranscriptionIndex.js';
import type TranslationQueue from '../translation/TranslationQueue.js';
import type TranslationSettingsStore from '../translation/TranslationSettingsStore.js';
import GeminiTranslator, { DEFAULT_BASE_URL, DEFAULT_MODEL, DEFAULT_PROXY_URL } from '../translation/GeminiTranslator.js';
import { DEFAULT_PROMPT } from '../translation/TranslationPrompt.js';
import { type TranslationSettings } from '../../types/Translation.js';

/**
 * AI translation: turning a transcription into Simplified Chinese subtitles,
 * and the settings that govern it.
 *
 * All of it is for administrators. Reading the file that comes out is not -
 * that goes through the subtitle endpoints, which serve it to any viewer whose
 * player asks, exactly as they serve the transcription it was made from.
 */
export default class TranslationAPIRequestHandler extends Basehandler {
  name = 'TranslationAPIRequestHandler';

  #index: TranscriptionIndex;
  #queue: TranslationQueue;
  #settings: TranslationSettingsStore;

  constructor(
    index: TranscriptionIndex,
    queue: TranslationQueue,
    settings: TranslationSettingsStore,
    logger?: Logger | null
  ) {
    super(logger);
    this.#index = index;
    this.#queue = queue;
    this.#settings = settings;
  }

  /** Why translation cannot run, or `null` when it can. */
  #getBlockedReason(): string | null {
    if (!this.#settings.getApiKey()) {
      return 'No Gemini API key is configured. An administrator can set one in the ' +
        'translation settings.';
    }
    return null;
  }

  /** Whether translation is configured at all, and why not when it is not. */
  handleStatusRequest(_req: Request, res: Response) {
    const blocked = this.#getBlockedReason();
    res.json(blocked ? { available: false, reason: blocked } : { available: true, reason: null });
  }

  /**
   * The settings as the browser may see them: never the key itself, only
   * whether one is set and what Gemini says about it.
   */
  async handleGetSettingsRequest(_req: Request, res: Response) {
    const apiKey = this.#settings.getApiKey();
    const settings: TranslationSettings = {
      configured: !!apiKey,
      source: this.#settings.getApiKeySource(),
      model: this.#settings.getModel() || DEFAULT_MODEL,
      baseUrl: this.#settings.getBaseUrl() || DEFAULT_BASE_URL,
      proxyUrl: this.#settings.getProxyUrl() || '',
      defaultProxyUrl: DEFAULT_PROXY_URL,
      prompt: this.#settings.getPrompt() || DEFAULT_PROMPT,
      defaultPrompt: DEFAULT_PROMPT,
      batchCharacters: this.#settings.getBatchCharacters(),
      batchLines: this.#settings.getBatchLines(),
      disableThinking: this.#settings.getDisableThinking(),
      segmentation: this.#settings.getSegmentation(),
      sourceSegmentation: this.#settings.getSourceSegmentation(),
      polish: this.#settings.getPolish(),
      maxLineCjk: this.#settings.getMaxLineCjk(),
      maxLineLatin: this.#settings.getMaxLineLatin(),
      totalRequests: this.#settings.getTotalRequests(),
      key: null,
      keyError: null
    };
    if (apiKey) {
      try {
        settings.key = await GeminiTranslator.describeKey(
          apiKey, settings.baseUrl, settings.model, settings.proxyUrl || null
        );
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
   * Saves the settings, checking any new key against Gemini so a mistyped one
   * is rejected here rather than partway through a video - by which point the
   * calls it took to get there have already been spent.
   */
  async handleSaveSettingsRequest(req: Request, res: Response) {
    const body = (req.body || {}) as Record<string, unknown>;
    const patch: Parameters<TranslationSettingsStore['update']>[0] = {};

    if (body.model !== undefined) {
      patch.model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null;
    }
    if (body.baseUrl !== undefined) {
      patch.baseUrl = typeof body.baseUrl === 'string' && body.baseUrl.trim() ?
        body.baseUrl.trim()
        : null;
    }
    if (body.proxyUrl !== undefined) {
      // Stored verbatim, empty string included: that is how an administrator
      // says "no proxy" rather than "use the default".
      patch.proxyUrl = typeof body.proxyUrl === 'string' ? body.proxyUrl.trim() : '';
    }
    if (body.prompt !== undefined) {
      // Blank means "use the default", which is also what the reset button
      // sends - there is no such thing as an empty preferences block.
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
      patch.prompt = prompt && prompt !== DEFAULT_PROMPT ? prompt : null;
    }
    if (body.batchCharacters !== undefined) {
      const value = Number(body.batchCharacters);
      patch.batchCharacters = Number.isFinite(value) ? value : null;
    }
    if (body.batchLines !== undefined) {
      const value = Number(body.batchLines);
      patch.batchLines = Number.isFinite(value) ? value : null;
    }
    if (body.disableThinking !== undefined) {
      patch.disableThinking = !!body.disableThinking;
    }
    if (body.segmentation !== undefined) {
      patch.segmentation = !!body.segmentation;
    }
    if (body.sourceSegmentation !== undefined) {
      patch.sourceSegmentation = !!body.sourceSegmentation;
    }
    if (body.polish !== undefined) {
      patch.polish = !!body.polish;
    }
    if (body.maxLineCjk !== undefined) {
      const value = Number(body.maxLineCjk);
      patch.maxLineCjk = Number.isFinite(value) ? value : null;
    }
    if (body.maxLineLatin !== undefined) {
      const value = Number(body.maxLineLatin);
      patch.maxLineLatin = Number.isFinite(value) ? value : null;
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
        const model = patch.model || this.#settings.getModel() || DEFAULT_MODEL;
        // Through whatever proxy is being saved alongside, not the stored one:
        // the two arrive in the same request, and checking the key against the
        // old proxy would reject a key that is about to work.
        const proxyUrl = patch.proxyUrl !== undefined ?
          patch.proxyUrl || null
          : this.#settings.getProxyUrl();
        try {
          await GeminiTranslator.describeKey(apiKey, baseUrl, model, proxyUrl);
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
    this.log('info', 'Translation settings updated');
    await this.handleGetSettingsRequest(req, res);
  }

  /**
   * Queues a translation of one video's transcription.
   *
   * Accepted while the transcription is still under way: the record is marked
   * pending and the transcription queue hands it over when it has something to
   * translate. That is what the checkbox on the transcribe confirmation uses.
   */
  handleTranslateRequest(_req: Request, res: Response, id: string) {
    const blocked = this.#getBlockedReason();
    if (blocked) {
      res.status(503).json({ error: blocked });
      return;
    }
    const record = this.#index.get(id);
    if (!record) {
      res.status(404).json({ error: 'This video has not been transcribed' });
      return;
    }
    if (record.state !== 'done' && record.state !== 'pending' && record.state !== 'running') {
      res.status(409).json({
        error: 'There is no finished transcription to translate. Transcribe it first.'
      });
      return;
    }
    const updated = this.#queue.enqueue(id);
    this.log('info', `Translation queued for media "${id}"`);
    res.json({ record: updated });
  }

  handleCancelRequest(_req: Request, res: Response, id: string) {
    res.json({ cancelled: this.#queue.cancel(id) });
  }

  /** Stops the running translation and empties the queue behind it. */
  handleCancelAllRequest(_req: Request, res: Response) {
    const stopped = this.#queue.cancelAll();
    this.log('info', `Stopped ${stopped} translation(s) on request`);
    res.json({ stopped, records: this.#index.list() });
  }

  /** Puts the running count of calls spent back to zero. */
  handleResetRequestCountRequest(req: Request, res: Response) {
    this.#settings.resetTotalRequests();
    void this.handleGetSettingsRequest(req, res);
  }
}
