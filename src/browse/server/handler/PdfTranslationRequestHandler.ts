import { type Request, type Response } from 'express';
import Basehandler from './BaseHandler.js';
import { type Logger } from '../../../utils/logging/index.js';
import type PdfTranslationStore from '../pdf/PdfTranslationStore.js';
import { type PdfTranslationServices } from '../pdf/Config.js';
import { DeepLKeyMissingError } from '../pdf/DeepLTranslator.js';
import {
  BaiduNotConfiguredError,
  UnusableImageError,
  imageContentType
} from '../pdf/BaiduImageTranslator.js';
import {
  type DeepLKeyStatus,
  type PdfTranslationAvailability,
  type PdfTranslationRequest,
  type PdfTranslationResponse,
  type PdfTranslationSettings,
  type PdfTranslationSettingsUpdate
} from '../../types/PdfTranslation.js';

class TooLargeError extends Error {
  constructor() {
    super('That page image is too large to translate');
    this.name = 'TooLargeError';
  }
}

/** One page of a PDF is a handful of paragraphs; anything more is not a page. */
const MAX_BLOCKS = 400;
/** Roughly a dense A4 page of text, with room to spare. */
const MAX_TOTAL_CHARS = 60_000;

/**
 * A page drawn as a picture, at the size the reader sends it: a couple of
 * thousand pixels of JPEG. Baidu refuses anything over four megabytes and so
 * does this, a little earlier and with a better sentence.
 */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** No document has this many pages; anything past it is a malformed request. */
const MAX_PAGE = 100_000;

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
  #baiduFromConfig: boolean;
  #proxyFromConfig: boolean;

  constructor(
    services: PdfTranslationServices,
    deepLKeyFromConfig: boolean,
    baiduFromConfig: boolean,
    proxyFromConfig: boolean,
    logger?: Logger | null
  ) {
    super(logger);
    this.#services = services;
    this.#store = services.store;
    this.#deepLKeyFromConfig = deepLKeyFromConfig;
    this.#baiduFromConfig = baiduFromConfig;
    this.#proxyFromConfig = proxyFromConfig;
  }

  handleAvailabilityRequest(_req: Request, res: Response) {
    const { settings, deepL, baiduImage, translator } = this.#services;
    const body: PdfTranslationAvailability = {
      engine: settings.engine,
      // Google needs nothing to be usable; DeepL without a key translates
      // nothing, and the reader is better told that up front.
      available: settings.engine !== 'deepl' || deepL.configured,
      imageAvailable: baiduImage.configured,
      to: translator().targetLanguage
    };
    res.json(body);
  }

  handleGetSettingsRequest(_req: Request, res: Response) {
    const { settings, google, deepL, baiduImage } = this.#services;
    const body: PdfTranslationSettings = {
      engine: settings.engine,
      hasDeepLKey: deepL.configured,
      deepLKeyFromConfig: this.#deepLKeyFromConfig,
      // An APP ID is an account name rather than a secret, so it comes back to
      // be shown; the key never does. `configured` is both halves together,
      // which is the only state that can sign anything.
      baiduAppId: settings.baiduAppId ?? '',
      hasBaiduSecretKey: baiduImage.configured,
      baiduFromConfig: this.#baiduFromConfig,
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
    const previousLanguage = this.#services.google.targetLanguage;
    this.#services.settings.update({
      engine: update.engine,
      // A key set on the command line wins, so accepting one here would only
      // store something that never gets used.
      deepLApiKey: this.#deepLKeyFromConfig ? undefined : update.deepLApiKey,
      baiduAppId: this.#baiduFromConfig ? undefined : update.baiduAppId,
      baiduSecretKey: this.#baiduFromConfig ? undefined : update.baiduSecretKey,
      targetLanguage: update.targetLanguage,
      proxyUrl: this.#proxyFromConfig ? undefined : update.proxyUrl
    });
    // Translated page images are pictures of a language, and the ones on disk
    // are pictures of the old one. The text store is keyed by target language
    // and needs no such sweep.
    if (this.#services.google.targetLanguage !== previousLanguage) {
      this.#services.imageStore.clear();
    }
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

  /**
   * Translates one page as a picture.
   *
   * The page arrives as the reader drew it - the canvas it is already showing,
   * as a JPEG - rather than being rendered again here. That is the same
   * reasoning as the text route above: what comes back has to line up with
   * what is on screen, and the only way to be sure of that is to send what is
   * on screen.
   *
   * The reply is the image itself rather than JSON carrying it: it is a few
   * hundred kilobytes, and base64 would be a third more of them for nothing.
   * A page with no text to translate answers 204, which the reader remembers
   * so that it neither asks again nor shows an error for a page that is simply
   * a photograph.
   */
  async handleTranslateImageRequest(req: Request, res: Response, mediaId: string) {
    const { baiduImage, imageStore, translator } = this.#services;
    const page = Number(req.query.page);
    if (!Number.isInteger(page) || page < 1 || page > MAX_PAGE) {
      res.status(400).json({ error: 'Expected a page number' });
      return;
    }
    if (!baiduImage.configured) {
      res.status(503).json({
        error: 'Image translation has not been set up - it needs a Baidu APP ID and secret key'
      });
      return;
    }
    const to = typeof req.query.to === 'string' && req.query.to ?
      req.query.to : translator().targetLanguage;

    // The page is read off the wire before the store is consulted, even though
    // a stored page makes the upload so much wasted bandwidth. Answering
    // while the browser is still sending resets the write half of a connection
    // it has not finished with, which arrives there as a failed request rather
    // than as the picture it was about to be given. The reader keeps its own
    // copy for as long as a document is open, so this is only paid on the way
    // back into one.
    let image: Buffer;
    try {
      image = await this.#readBody(req);
    }
    catch (error) {
      res.status(error instanceof TooLargeError ? 413 : 400).json({
        error: error instanceof Error ? error.message : 'Could not read the page image'
      });
      return;
    }
    if (!imageContentType(image)) {
      res.status(400).json({ error: 'Expected a JPEG or PNG page image' });
      return;
    }

    // On file already: a reader turning back through a chapter must not be
    // charged for it a second time.
    const cached = imageStore.get(mediaId, to, page);
    if (cached) {
      this.log('debug', `Page ${page} of "${mediaId}" came from the image store`);
      this.#sendPageImage(res, cached.image, cached.contentType, true);
      return;
    }

    // The same reasoning as the text route: a reader who has turned the page
    // is not waiting for this, and Baidu should not be paid for a page nobody
    // is reading. Watched on the response rather than the request - see the
    // note there for why.
    const abandoned = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) {
        abandoned.abort();
      }
    });

    try {
      const translated = await baiduImage.translateImage(image, to, null, abandoned.signal);
      // Remembered either way, the empty answer included: a page of
      // photographs has nothing to translate today and will have nothing
      // tomorrow either.
      imageStore.set(mediaId, to, page, translated ?
        { image: translated.image, contentType: translated.contentType } : null);
      if (!translated) {
        this.log('debug', `Baidu found no text on page ${page} of "${mediaId}"`);
        res.status(204).end();
        return;
      }
      this.log('info',
        `Translated page ${page} of "${mediaId}" as an image ` +
        `(${translated.from} to ${translated.to}, ${(translated.image.length / 1024).toFixed(0)} kB)`
      );
      this.#sendPageImage(res, translated.image, translated.contentType, false);
    }
    catch (error) {
      if (abandoned.signal.aborted) {
        this.log('debug', `Dropped a page image of "${mediaId}" - the reader moved on`);
        return;
      }
      const message = error instanceof Error ? error.message : 'Image translation failed';
      this.log('warn', `Could not translate page ${page} of "${mediaId}" as an image: ${message}`);
      if (res.headersSent) {
        return;
      }
      // A page Baidu would never accept is the request's fault; missing
      // credentials are the server's; anything else happened upstream.
      const status =
        error instanceof UnusableImageError ? 400 :
          error instanceof BaiduNotConfiguredError ? 503 : 502;
      res.status(status).json({ error: message });
    }
  }

  #sendPageImage(res: Response, image: Buffer, contentType: string, cached: boolean) {
    if (image.length === 0) {
      // The stored form of "there was nothing on this page to translate".
      res.status(204).end();
      return;
    }
    res.setHeader('Content-Type', contentType || 'image/jpeg');
    res.setHeader('Content-Length', String(image.length));
    // Read by the reader only for its logs; the image is not cached by the
    // browser, because the reader holds it for as long as the file is open.
    res.setHeader('X-Translation-Cached', cached ? '1' : '0');
    res.setHeader('Cache-Control', 'no-store');
    res.end(image);
  }

  /**
   * The page image, out of the request stream.
   *
   * Read here rather than by a body parser: `express.json` leaves a binary
   * body alone, and adding a parser for images would put a four megabyte
   * buffer in front of every route in the application to serve one.
   */
  #readBody(req: Request): Promise<Buffer> {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
      return Promise.reject(new TooLargeError());
    }
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const fail = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        req.destroy();
        reject(error);
      };
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_IMAGE_BYTES) {
          fail(new TooLargeError());
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (settled) {
          return;
        }
        settled = true;
        if (size === 0) {
          reject(new Error('The page image was empty'));
          return;
        }
        resolve(Buffer.concat(chunks));
      });
      req.on('error', () => fail(new Error('Could not read the page image')));
    });
  }
}
