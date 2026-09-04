import { type Request, type Response } from 'express';
import Basehandler from './BaseHandler.js';
import { type Logger } from '../../../utils/logging/index.js';
import type PdfTranslationStore from '../pdf/PdfTranslationStore.js';
import { type PdfTranslationServices } from '../pdf/Config.js';
import { DeepLKeyMissingError } from '../pdf/DeepLTranslator.js';
import {
  type DeepLKeyStatus,
  type PdfTranslationAvailability,
  type PdfTranslationRequest,
  type PdfTranslationResponse,
  type PdfTranslationSettings,
  type PdfTranslationSettingsUpdate
} from '../../types/PdfTranslation.js';

/** One page of a PDF is a handful of paragraphs; anything more is not a page. */
const MAX_BLOCKS = 400;
/** Roughly a dense A4 page of text, with room to spare. */
const MAX_TOTAL_CHARS = 60_000;

/**
 * Translates the text of one PDF page, for the reader.
 *
 * The text arrives from the browser rather than being extracted here: the
 * reader has already parsed the page with pdf.js in order to draw it, and the
 * blocks it sends are the ones it will lay the translation over. Re-parsing
 * the file server-side would produce a different grouping and so a translation
 * that does not line up with anything on screen.
 *
 * Cached by the hash of each block's text, so paging back is free.
 */
export default class PdfTranslationRequestHandler extends Basehandler {
  name = 'PdfTranslationRequestHandler';

  #services: PdfTranslationServices;
  #store: PdfTranslationStore;
  /** Set when a key came from the command line, which the form may not overwrite. */
  #deepLKeyFromConfig: boolean;
  #proxyFromConfig: boolean;

  constructor(
    services: PdfTranslationServices,
    deepLKeyFromConfig: boolean,
    proxyFromConfig: boolean,
    logger?: Logger | null
  ) {
    super(logger);
    this.#services = services;
    this.#store = services.store;
    this.#deepLKeyFromConfig = deepLKeyFromConfig;
    this.#proxyFromConfig = proxyFromConfig;
  }

  handleAvailabilityRequest(_req: Request, res: Response) {
    const { settings, deepL, translator } = this.#services;
    const body: PdfTranslationAvailability = {
      engine: settings.engine,
      // Google needs nothing to be usable; DeepL without a key translates
      // nothing, and the reader is better told that up front.
      available: settings.engine !== 'deepl' || deepL.configured,
      to: translator().targetLanguage
    };
    res.json(body);
  }

  handleGetSettingsRequest(_req: Request, res: Response) {
    const { settings, google, deepL } = this.#services;
    const body: PdfTranslationSettings = {
      engine: settings.engine,
      hasDeepLKey: deepL.configured,
      deepLKeyFromConfig: this.#deepLKeyFromConfig,
      targetLanguage: google.targetLanguage,
      proxyUrl: settings.proxyUrl ?? '',
      proxyFromConfig: this.#proxyFromConfig
    };
    res.json(body);
  }

  handleSaveSettingsRequest(req: Request, res: Response) {
    const update = (req.body || {}) as PdfTranslationSettingsUpdate;
    if (update.engine && update.engine !== 'google' && update.engine !== 'deepl') {
      res.status(400).json({ error: 'Unknown translation engine' });
      return;
    }
    this.#services.settings.update({
      engine: update.engine,
      // A key set on the command line wins, so accepting one here would only
      // store something that never gets used.
      deepLApiKey: this.#deepLKeyFromConfig ? undefined : update.deepLApiKey,
      targetLanguage: update.targetLanguage,
      proxyUrl: this.#proxyFromConfig ? undefined : update.proxyUrl
    });
    this.log('info', `PDF translation is now using ${this.#services.settings.engine}`);
    this.handleGetSettingsRequest(req, res);
  }

  /** Asks DeepL what the key is worth, so the form can say whether it works. */
  async handleCheckDeepLKeyRequest(req: Request, res: Response) {
    const { apiKey } = (req.body || {}) as { apiKey?: string };
    let body: DeepLKeyStatus;
    try {
      body = { ok: true, ...await this.#services.deepL.checkKey(apiKey) };
    }
    catch (error) {
      body = {
        ok: false,
        error: error instanceof DeepLKeyMissingError ? error.message
          : error instanceof Error ? error.message : 'Could not reach DeepL'
      };
    }
    res.json(body);
  }

  async handleTranslateRequest(req: Request, res: Response, mediaId: string) {
    const { blocks, to } = (req.body || {}) as PdfTranslationRequest;
    if (!Array.isArray(blocks) || blocks.some((block) => typeof block !== 'string')) {
      res.status(400).json({ error: 'Expected an array of text blocks' });
      return;
    }
    if (blocks.length > MAX_BLOCKS) {
      res.status(400).json({ error: 'Too many blocks for one page' });
      return;
    }
    const totalChars = blocks.reduce((total, block) => total + block.length, 0);
    if (totalChars > MAX_TOTAL_CHARS) {
      res.status(400).json({ error: 'Too much text for one page' });
      return;
    }
    const translator = this.#services.translator();
    const target = to || translator.targetLanguage;

    // What the store already has, and what is left to ask Google for. The
    // second list is de-duplicated by text: a page usually repeats something.
    const translations: (string | null)[] = [];
    const missing = new Map<string, number[]>();
    blocks.forEach((block, index) => {
      const cached = block.trim() ? this.#store.get(mediaId, target, block) : '';
      translations.push(cached ?? null);
      if (cached === undefined) {
        const at = missing.get(block);
        if (at) {
          at.push(index);
        }
        else {
          missing.set(block, [ index ]);
        }
      }
    });
    let failedCount = 0;
    const cachedCount = blocks.length - [ ...missing.values() ].reduce((n, at) => n + at.length, 0);

    if (missing.size > 0) {
      const texts = [ ...missing.keys() ];
      // A reader who has turned the page is not waiting for this any more, and
      // the engine should not be asked for the rest of a page nobody is
      // reading.
      //
      // Listened for on the response, not the request. A request stream closes
      // as soon as its body has been read - which is immediately, since the
      // body parser has already consumed it - so `req.on('close')` fires on
      // every request while the client is still perfectly happy. Watching that
      // instead aborted every translation the moment it started and then
      // returned without answering, which left the connection open until
      // whatever sits in front of this server gave up and produced a 502 of
      // its own. `res` closes when the response is finished or the connection
      // is actually gone, and `writableFinished` tells the two apart.
      const abandoned = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) {
          abandoned.abort();
        }
      });
      let fetched;
      try {
        fetched = await translator.translate(texts, target, abandoned.signal);
      }
      catch (error) {
        if (abandoned.signal.aborted) {
          this.log('debug', `Dropped a translation of "${mediaId}" - the reader moved on`);
          return;
        }
        this.log('warn', `Could not translate a page of "${mediaId}":`, error);
        res.status(502).json({
          error: error instanceof Error ? error.message : 'Translation failed'
        });
        return;
      }
      // Nothing at all got through: that is worth an error, because the page
      // is unreadable and the reason - a refused proxy, most likely - is
      // something only the message can convey.
      if (fetched.failed === texts.length) {
        this.log('warn', `Could not translate a page of "${mediaId}": ${fetched.error}`);
        res.status(502).json({ error: fetched.error || 'Translation failed' });
        return;
      }
      texts.forEach((text, i) => {
        const translated = fetched.translations[i];
        if (translated === null) {
          return;
        }
        // Stored as it comes, so a page that half failed is half free the
        // next time it is asked for.
        this.#store.set(mediaId, target, text, translated);
        for (const index of missing.get(text) || []) {
          translations[index] = translated;
        }
      });
      failedCount = fetched.failed;
    }

    this.log('debug',
      `Translated a page of "${mediaId}" into ${target} ` +
      `(${blocks.length} blocks, ${cachedCount} from the store` +
      `${failedCount > 0 ? `, ${failedCount} failed` : ''})`
    );
    const body: PdfTranslationResponse = {
      translations, cached: cachedCount, failed: failedCount, to: target
    };
    res.json(body);
  }
}
