import fs from 'fs';
import path from 'path';
import { commonLog, type LogLevel } from '../../../utils/logging/Logger.js';
import { type Logger } from '../../../utils/logging/index.js';

/**
 * Terms past which a provider stops accepting any more.
 * @see https://ai.google.dev/gemini-api/docs/transcribe
 */
export const MAX_TERMS = 1000;
/** Past this the documented advice is that biasing starts to work against itself. */
export const RECOMMENDED_TERMS = 100;

/**
 * The domain terms the speech model is steered towards.
 *
 * A plain text file, one term or phrase per line, `#` for a comment. Plain
 * text because this is a list somebody maintains by hand while watching
 * transcripts come out wrong - a JSON array would mean escaping quotes in the
 * middle of that, and the terms most worth adding are exactly the ones with
 * awkward punctuation in them.
 *
 * Re-read whenever the file's timestamp moves, so an edit takes effect on the
 * next clip without anything being restarted.
 */
export default class VocabularyStore {
  name = 'VocabularyStore';

  #filePath: string;
  #terms: string[];
  #mtimeMs: number | null;
  #logger?: Logger | null;

  constructor(filePath: string, logger?: Logger | null) {
    this.#filePath = filePath;
    this.#terms = [];
    this.#mtimeMs = null;
    this.#logger = logger;
  }

  get filePath() {
    return this.#filePath;
  }

  /**
   * The terms as the provider should be given them: comments and blank lines
   * gone, duplicates gone, and no more than the ceiling allows.
   */
  getTerms(): string[] {
    this.#refresh();
    return this.#terms;
  }

  /** The file as it stands, for an editor to show. Empty when there is none. */
  getText(): string {
    try {
      return fs.readFileSync(this.#filePath, 'utf-8');
    }
    catch {
      return '';
    }
  }

  /** Replaces the file wholesale. The text is stored as given, comments and all. */
  setText(text: string) {
    const dir = path.dirname(this.#filePath);
    fs.mkdirSync(dir, { recursive: true });
    // Through a temporary file in the same directory, so a process that dies
    // mid-write cannot leave a half-written list behind.
    const tmpFilePath = `${this.#filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpFilePath, text.endsWith('\n') || !text ? text : `${text}\n`, 'utf-8');
    fs.renameSync(tmpFilePath, this.#filePath);
    this.#mtimeMs = null;
    this.#refresh();
  }

  #refresh() {
    let mtimeMs: number | null;
    try {
      mtimeMs = fs.statSync(this.#filePath).mtimeMs;
    }
    catch {
      // No file is a valid state: the feature simply adds no bias.
      this.#terms = [];
      this.#mtimeMs = null;
      return;
    }
    if (mtimeMs === this.#mtimeMs) {
      return;
    }
    this.#mtimeMs = mtimeMs;
    this.#terms = VocabularyStore.parse(this.getText(), (message) => this.log('warn', message));
    this.log('debug', `Loaded ${this.#terms.length} vocabulary terms from "${this.#filePath}"`);
  }

  /** One term per line, `#` comments, blanks and repeats dropped. */
  static parse(text: string, warn?: (message: string) => void): string[] {
    const seen = new Set<string>();
    const terms: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }
      // Case is kept - a brand name is worth biasing towards as it is written -
      // but a term repeated in two cases is still one term to the provider.
      const key = trimmed.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      terms.push(trimmed);
    }
    if (terms.length > MAX_TERMS) {
      warn?.(
        `Vocabulary has ${terms.length} terms; only the first ${MAX_TERMS} are sent.`
      );
      return terms.slice(0, MAX_TERMS);
    }
    if (terms.length > RECOMMENDED_TERMS) {
      warn?.(
        `Vocabulary has ${terms.length} terms. Biasing works best at up to ` +
        `${RECOMMENDED_TERMS}; past that, common words in the list start ` +
        `pulling the transcript towards themselves.`
      );
    }
    return terms;
  }

  protected log(level: LogLevel, ...msg: any[]) {
    commonLog(this.#logger, level, this.name, ...msg);
  }
}
