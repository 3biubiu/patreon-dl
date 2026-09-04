import { type Request, type Response } from 'express';
import Basehandler from './BaseHandler.js';
import { type Logger } from '../../../utils/logging/index.js';
import type GoogleTranslator from '../pdf/GoogleTranslator.js';
import type PdfTranslationStore from '../pdf/PdfTranslationStore.js';
import {
  type PdfTranslationRequest,
  type PdfTranslationResponse
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

  #translator: GoogleTranslator;
  #store: PdfTranslationStore;

  constructor(
    translator: GoogleTranslator,
    store: PdfTranslationStore,
    logger?: Logger | null
  ) {
    super(logger);
    this.#translator = translator;
    this.#store = store;
  }

  handleAvailabilityRequest(_req: Request, res: Response) {
    res.json({ available: true, to: this.#translator.targetLanguage });
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
    const target = to || this.#translator.targetLanguage;

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
    const cachedCount = blocks.length - [ ...missing.values() ].reduce((n, at) => n + at.length, 0);

    if (missing.size > 0) {
      const texts = [ ...missing.keys() ];
      let fetched;
      try {
        fetched = await this.#translator.translate(texts, target);
      }
      catch (error) {
        this.log('warn', `Could not translate a page of "${mediaId}":`, error);
        res.status(502).json({
          error: error instanceof Error ? error.message : 'Translation failed'
        });
        return;
      }
      texts.forEach((text, i) => {
        const translated = fetched[i];
        if (translated === null) {
          return;
        }
        this.#store.set(mediaId, target, text, translated);
        for (const index of missing.get(text) || []) {
          translations[index] = translated;
        }
      });
    }

    this.log('debug',
      `Translated a page of "${mediaId}" into ${target} ` +
      `(${blocks.length} blocks, ${cachedCount} from the store)`
    );
    const body: PdfTranslationResponse = { translations, cached: cachedCount, to: target };
    res.json(body);
  }
}
