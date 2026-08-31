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
 * Mappings past which the translation prompt stops carrying all of them. A
 * mapping costs far more room than a bare term - both sides, plus the arrow -
 * and the translation is billed per call with the list attached to every one.
 */
export const MAX_MAPPINGS = 200;

/** One term, and the Chinese it must become when the file is translated. */
export interface TermMapping {
  term: string;
  translation: string;
}

/** What `parse` reads out of the file: the terms, and which of them map. */
export interface ParsedVocabulary {
  terms: string[];
  mappings: TermMapping[];
}

/**
 * The domain terms the speech model is steered towards.
 *
 * A plain text file, one term or phrase per line, `#` for a comment. Plain
 * text because this is a list somebody maintains by hand while watching
 * transcripts come out wrong - a JSON array would mean escaping quotes in the
 * middle of that, and the terms most worth adding are exactly the ones with
 * awkward punctuation in them.
 *
 * A line may carry a translation after `=>`:
 *
 *     zenithal priming => 天顶喷涂
 *
 * The left side is still a biasing term for the transcription, and the whole
 * line becomes a rule the translation follows - the same file steers what the
 * model hears and what the translator calls it, so a term corrected in the
 * transcript is not then re-mangled in the Chinese. Lines without `=>` bias
 * the transcription and the polishing pass only.
 *
 * Re-read whenever the file's timestamp moves, so an edit takes effect on the
 * next clip without anything being restarted.
 */
export default class VocabularyStore {
  name = 'VocabularyStore';

  #filePath: string;
  #terms: string[];
  #mappings: TermMapping[];
  #mtimeMs: number | null;
  #logger?: Logger | null;

  constructor(filePath: string, logger?: Logger | null) {
    this.#filePath = filePath;
    this.#terms = [];
    this.#mappings = [];
    this.#mtimeMs = null;
    this.#logger = logger;
  }

  get filePath() {
    return this.#filePath;
  }

  /**
   * The terms as the provider should be given them: comments and blank lines
   * gone, duplicates gone, and no more than the ceiling allows. A line with a
   * translation contributes its left side.
   */
  getTerms(): string[] {
    this.#refresh();
    return this.#terms;
  }

  /**
   * The terms that carry a Chinese translation, for the translator to be
   * steered with. No ceiling from the provider applies here - only this
   * project's own sense of how much belongs in every call.
   */
  getMappings(): TermMapping[] {
    this.#refresh();
    return this.#mappings;
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
      this.#mappings = [];
      this.#mtimeMs = null;
      return;
    }
    if (mtimeMs === this.#mtimeMs) {
      return;
    }
    this.#mtimeMs = mtimeMs;
    const parsed = VocabularyStore.parse(this.getText(), (message) => this.log('warn', message));
    this.#terms = parsed.terms;
    this.#mappings = parsed.mappings;
    this.log('debug',
      `Loaded ${this.#terms.length} vocabulary terms (${this.#mappings.length} with translations) ` +
      `from "${this.#filePath}"`
    );
  }

  /**
   * One term per line, `#` comments, blanks and repeats dropped. A line of
   * the form `term => translation` counts once, by its term, and wins over a
   * plain line for the same term whichever order they appear in - it carries
   * everything the plain one does, and the translation besides.
   */
  static parse(text: string, warn?: (message: string) => void): ParsedVocabulary {
    const byKey = new Map<string, { term: string; translation: string | null }>();
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }
      // Case is kept - a brand name is worth biasing towards as it is written -
      // but a term repeated in two cases is still one term to the provider.
      const arrow = trimmed.indexOf('=>');
      const term = (arrow >= 0 ? trimmed.slice(0, arrow) : trimmed).trim();
      const translation = arrow >= 0 ? trimmed.slice(arrow + 2).trim() : null;
      if (!term || (arrow >= 0 && !translation)) {
        // An arrow with an empty half is a line somebody is halfway through
        // writing; biasing with a dangling term helps nobody.
        continue;
      }
      // A mapped line always wins over a plain one for the same term, in
      // either order: it carries everything the plain one does, and the
      // translation besides.
      const key = term.toLowerCase();
      const existing = byKey.get(key);
      if (!existing || translation !== null || existing.translation === null) {
        byKey.set(key, { term, translation });
      }
    }

    const entries = [ ...byKey.values() ];
    const terms = entries.map((entry) => entry.term);
    const mappings = entries
      .filter((entry) => entry.translation !== null)
      .map((entry) => ({ term: entry.term, translation: entry.translation as string }));

    if (terms.length > MAX_TERMS) {
      warn?.(
        `Vocabulary has ${terms.length} terms; only the first ${MAX_TERMS} are sent.`
      );
      return {
        terms: terms.slice(0, MAX_TERMS),
        mappings: mappings.slice(0, MAX_MAPPINGS)
      };
    }
    if (mappings.length > MAX_MAPPINGS) {
      warn?.(
        `Vocabulary has ${mappings.length} term translations; only the first ${MAX_MAPPINGS} ` +
        'are offered to the translator.'
      );
      return { terms, mappings: mappings.slice(0, MAX_MAPPINGS) };
    }
    if (terms.length > RECOMMENDED_TERMS) {
      warn?.(
        `Vocabulary has ${terms.length} terms. Biasing works best at up to ` +
        `${RECOMMENDED_TERMS}; past that, common words in the list start ` +
        `pulling the transcript towards themselves.`
      );
    }
    return { terms, mappings };
  }

  protected log(level: LogLevel, ...msg: any[]) {
    commonLog(this.#logger, level, this.name, ...msg);
  }
}
