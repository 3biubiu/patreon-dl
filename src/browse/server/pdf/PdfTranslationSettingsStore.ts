import fs from 'fs';
import path from 'path';
import { commonLog } from '../../../utils/logging/Logger.js';
import type Logger from '../../../utils/logging/Logger.js';
import { type PdfTranslationEngine } from '../../types/PdfTranslation.js';

/**
 * Which engine the PDF reader translates with, and what it needs to do it.
 *
 * Its own file and its own store, kept away from the Gemini settings the
 * subtitles use. The two features share a word and nothing else, and putting
 * their keys in one place would be the first step towards their behaviour
 * getting tangled.
 */

const FILE_VERSION = 1;

interface StoredSettings {
  v: number;
  engine: PdfTranslationEngine;
  deepLApiKey: string | null;
  targetLanguage: string | null;
  /** `null` means "not set, use the default"; `''` means "go direct". */
  proxyUrl: string | null;
}

const EMPTY: StoredSettings = {
  v: FILE_VERSION,
  engine: 'google',
  deepLApiKey: null,
  targetLanguage: null,
  proxyUrl: null
};

export interface PdfTranslationSettingsUpdate {
  engine?: PdfTranslationEngine;
  /** Omit to leave as it is; `''` to forget the key entirely. */
  deepLApiKey?: string;
  targetLanguage?: string;
  proxyUrl?: string;
}

export default class PdfTranslationSettingsStore {
  name = 'PdfTranslationSettingsStore';

  #filePath: string;
  #logger?: Logger | null;
  #data: StoredSettings;

  private constructor(filePath: string, data: StoredSettings, logger?: Logger | null) {
    this.#filePath = filePath;
    this.#data = data;
    this.#logger = logger;
  }

  static load(filePath: string, logger?: Logger | null) {
    let data = { ...EMPTY };
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<StoredSettings>;
      if (parsed && typeof parsed === 'object') {
        data = {
          ...EMPTY,
          ...parsed,
          // An older or hand-edited file must not be able to name an engine
          // that does not exist.
          engine: parsed.engine === 'deepl' ? 'deepl' : 'google'
        };
      }
    }
    catch (_error) {
      // No file yet is the normal case, and an unreadable one is treated the
      // same way: the defaults, which leave the feature on Google.
    }
    return new PdfTranslationSettingsStore(filePath, data, logger);
  }

  get engine() {
    return this.#data.engine;
  }

  get deepLApiKey() {
    return this.#data.deepLApiKey;
  }

  get targetLanguage() {
    return this.#data.targetLanguage;
  }

  get proxyUrl() {
    return this.#data.proxyUrl;
  }

  update(update: PdfTranslationSettingsUpdate) {
    if (update.engine) {
      this.#data.engine = update.engine === 'deepl' ? 'deepl' : 'google';
    }
    if (update.deepLApiKey !== undefined) {
      // A blank key is how it is cleared, and is stored as absent rather than
      // as an empty string that would read as "configured".
      this.#data.deepLApiKey = update.deepLApiKey.trim() || null;
    }
    if (update.targetLanguage !== undefined) {
      this.#data.targetLanguage = update.targetLanguage.trim() || null;
    }
    if (update.proxyUrl !== undefined) {
      // Deliberately kept distinct from `null`: an empty string is a decision
      // to go direct, absence is "whatever the default is".
      this.#data.proxyUrl = update.proxyUrl.trim();
    }
    this.#save();
  }

  #save() {
    try {
      fs.mkdirSync(path.dirname(this.#filePath), { recursive: true });
      fs.writeFileSync(this.#filePath, JSON.stringify(this.#data, null, 2), 'utf-8');
    }
    catch (error) {
      commonLog(this.#logger, 'error', this.name,
        `Could not save the PDF translation settings to "${this.#filePath}":`, error);
    }
  }
}
