/**
 * Re-cuts translated captions into readable subtitle lines.
 *
 * A translation comes back one line per original caption, because that is the
 * only way the timings stay attached to the words they belong to. But an
 * English caption of a dozen words becomes a good deal more than a dozen
 * Chinese characters, and the line that was a comfortable width in the source
 * is not one in the translation. This puts the translated text back into a
 * stream and cuts it where a Chinese caption ought to break.
 *
 * The rule is punctuation and pauses first, length second. A boundary the
 * speaker actually made - a full stop, a breath - is taken even when the line
 * it ends is short, and the length settings only decide between boundaries of
 * equal standing or step in where there is no punctuation at all. That is the
 * opposite priority to cutting every N characters, which is exactly what
 * produces captions that break mid-phrase.
 *
 * Nothing here calls anything. Both signals it works from - the punctuation in
 * the translated text, and the silence between one caption and the next - are
 * already in hand, so a whole file is re-cut for the price of reading it.
 */

import { type Segment } from '../transcription/SubtitleBuilder.js';

/**
 * One word, or one CJK character - the smallest thing a line can end on.
 *
 * `text` is the original slice including whatever punctuation and spacing
 * followed it, so joining a run of these gives back the transcript verbatim.
 */
export interface Unit {
  text: string;
  /** The word itself, without the punctuation or spacing `text` carries. */
  core: string;
  start: number;
  end: number;
  /**
   * Silence in front of this unit, in seconds. Real only where one caption
   * ends and the next begins - inside a caption there is no evidence of a
   * pause, so it is zero rather than guessed at.
   */
  gapBefore: number;
  /**
   * First unit of its source caption. Its `text` therefore has nothing in
   * front of it, and a join that pulls two captions onto one line has to put
   * the separator back.
   */
  startsSegment: boolean;
  /**
   * Whether a line may end here.
   *
   * False only in the middle of a CJK word. A unit is one Han character, so
   * without this every gap between two characters is a legal cut and a line
   * can end halfway through a word - which is how a translated caption came
   * to break "模型" across two lines.
   */
  breakable: boolean;
}

export interface SegmenterOptions {
  /** Longest line, in characters, for Chinese, Japanese and Korean. */
  maxCjk: number;
  /** Longest line, in words, for everything written with spaces. */
  maxLatin: number;
}

export const DEFAULT_SEGMENTER_OPTIONS: SegmenterOptions = {
  maxCjk: 20,
  maxLatin: 14
};

/** What a settings form is held to, so a typo cannot make lines unreadable. */
export const MAX_CJK_RANGE = { min: 8, max: 40 };
export const MAX_LATIN_RANGE = { min: 5, max: 30 };

/**
 * How much a boundary is worth. A full stop outranks everything the length
 * rules can say; a comma does not, which is why a line runs past a comma to
 * reach a better break but never past a full stop.
 */
const SENTENCE_SCORE = 100;
const CLAUSE_SCORE = 60;
const COMMA_SCORE = 35;
/** A pause at its longest is worth about as much as a clause break. */
const MAX_PAUSE_SCORE = 80;

/** Silence below this is segment noise rather than a pause anyone made. */
const MIN_PAUSE_SECONDS = 0.08;
/** Silence at or above this is worth the full pause score. */
const FULL_PAUSE_SECONDS = 1.2;
/**
 * Silence this long ends a line whatever else is going on. Someone stopped
 * talking; carrying the caption across it would hold a finished sentence on
 * screen through the gap and then run it into the next one.
 */
const FORCED_PAUSE_SECONDS = 1.6;

/**
 * Worst penalty for a line at the length ceiling, in boundary-score terms.
 *
 * Deliberately under `COMMA_SCORE`. At 90 the arithmetic quietly inverted the
 * rule this file opens with: a comma three characters past the comfortable
 * target lost to a bare cut at the target - 35 against 54 of penalty - and a
 * line ended mid-phrase with a comma in plain sight. Kept under 35, a comma
 * anywhere inside the window beats every cut that has nothing to say for
 * itself, and length goes back to deciding between boundaries of equal
 * standing, which is all it was ever meant to do.
 */
const OVER_PENALTY = 30;
/** Worst penalty for a very short line. Mild - short lines are often right. */
const UNDER_PENALTY = 20;

/** A comfortable line, as a fraction of the longest allowed. */
const TARGET_RATIO = 0.75;
/** Below this fraction of the target, only a full stop may end a line. */
const MIN_RATIO = 0.4;
/** No line ends below this many units, whatever ends it. */
const FLOOR_UNITS = 2;

/**
 * One word, or one CJK character. Trailing punctuation and spaces are not
 * matched here - they are picked up as part of the preceding unit's `text`, so
 * that a boundary can be judged by what was written at it.
 */
const UNIT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{Letter}\p{Number}]+(?:[''’][\p{Letter}]+)*/gu;

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Brackets and quotes close after the mark that matters, so they come off first. */
const TRAILING_WRAPPERS = /[)\]}>"'’”〉》」』】）\s]+$/u;

const SENTENCE_END = /[.!?。！？…]$/u;
const CLAUSE_END = /[;:；：—–]$/u;
const COMMA_END = /[,，、]$/u;

/**
 * Characters per phoneme, used to share a segment's duration out among its
 * words. A rough estimate is enough: it only decides where inside one Whisper
 * segment a cut lands, and the segment's own start and end stay exact.
 */
const CHARS_PER_PHONEME = 4;

/**
 * Which language's word rules to segment by.
 *
 * Only ever asked about text that is mainly CJK, so the question is which of
 * the three - and kana or hangul present settle it. Chinese is the default
 * because it is the one with no script of its own to be recognised by.
 */
function wordLocale(text: string) {
  if (/[p{Script=Hangul}]/u.test(text)) {
    return 'ko';
  }
  if (/[p{Script=Hiragana}p{Script=Katakana}]/u.test(text)) {
    return 'ja';
  }
  return 'zh';
}

/**
 * The offsets in `text` at which a word ends, as ICU's dictionary sees it.
 *
 * This is the whole of what stops a line breaking inside a word: a unit may
 * end a line only where a word does. An environment without `Intl.Segmenter`,
 * or one whose ICU cannot segment the language, returns null and every unit
 * stays breakable - the behaviour this had before, which is wrong in the same
 * way rather than newly broken.
 */
function wordEnds(text: string, locale: string): Set<number> | null {
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') {
    return null;
  }
  try {
    const segmenter = new Intl.Segmenter(locale, { granularity: 'word' });
    const ends = new Set<number>();
    for (const { segment, index } of segmenter.segment(text)) {
      ends.add(index + segment.length);
    }
    return ends;
  }
  catch (_error) {
    return null;
  }
}

/** Whether the transcript is written without spaces between words. */
export function isMainlyCjk(text: string) {
  const letters = text.match(/[\p{Letter}]/gu);
  if (!letters || letters.length === 0) {
    return false;
  }
  const cjk = letters.filter((c) => CJK.test(c)).length;
  return cjk / letters.length > 0.5;
}

/**
 * Breaks segments into units, sharing each segment's duration among its words
 * in proportion to their estimated phonemes.
 *
 * Segments are assumed to be in order; the gap in front of each one is carried
 * onto its first unit, which is the only place a real pause is known.
 */
export function toUnits(segments: Segment[]): Unit[] {
  const units: Unit[] = [];
  let previousEnd: number | null = null;
  const locale = wordLocale(segments.map((segment) => segment.text).join(''));

  for (let k = 0; k < segments.length; k++) {
    const segment = segments[k];
    const text = segment.text;
    const matches = [ ...text.matchAll(UNIT) ];
    if (matches.length === 0) {
      continue;
    }
    // Per segment, because a unit's offsets are into its own segment's text.
    // The one boundary this cannot see - the join between two segments - is
    // checked separately below, on the two texts put together.
    const ends = wordEnds(text, locale);
    const duration = Math.max(segment.end - segment.start, 0);
    const phonemes = matches.map((m) => Math.ceil(m[0].length / CHARS_PER_PHONEME));
    const totalPhonemes = phonemes.reduce((total, p) => total + p, 0) || 1;
    const perPhoneme = duration / totalPhonemes;

    let cursor = segment.start;
    for (let i = 0; i < matches.length; i++) {
      const match = matches[i];
      const from = match.index ?? 0;
      // Up to the next word, so the punctuation and spacing between them
      // belong to the unit they follow.
      const to = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
      const end = i === matches.length - 1 ?
        segment.end
        : Math.min(cursor + perPhoneme * phonemes[i], segment.end);
      // Only CJK is held to the dictionary. The unit pattern already matches
      // a spaced language a whole word at a time, so applying it there could
      // only take away breaks that are legitimate.
      let breakable = !ends || !CJK.test(match[0]) || ends.has(from + match[0].length);
      if (i === matches.length - 1) {
        // A segment's last unit was breakable unconditionally - its offset is
        // the end of its own text, which a per-segment dictionary always calls
        // a word end. But the translator writes one caption at a time, and a
        // word it split across two captions - "惊" ending one, "艳成果"
        // opening the next - is invisible to a check that never reads past the
        // join. So when CJK meets CJK at the join, the two texts are read as
        // one and the join is only a break if a word ends there.
        const nextText = segments[k + 1]?.text ?? '';
        if (CJK.test(text.slice(-1)) && CJK.test(nextText.charAt(0))) {
          const pair = wordEnds(text + nextText, locale);
          breakable = !pair || pair.has(text.length);
        }
      }
      units.push({
        text: text.slice(from, to),
        core: match[0],
        start: cursor,
        end,
        gapBefore: i === 0 && previousEnd !== null ?
          Math.max(0, segment.start - previousEnd)
          : 0,
        startsSegment: i === 0,
        breakable
      });
      cursor = end;
    }
    previousEnd = segment.end;
  }
  return units;
}

/** What the punctuation at the end of `text` says about breaking there. */
export function punctuationScore(text: string) {
  const trimmed = text.replace(TRAILING_WRAPPERS, '');
  if (SENTENCE_END.test(trimmed)) {
    return SENTENCE_SCORE;
  }
  if (CLAUSE_END.test(trimmed)) {
    return CLAUSE_SCORE;
  }
  if (COMMA_END.test(trimmed)) {
    return COMMA_SCORE;
  }
  return 0;
}

/** What a silence of `seconds` says about breaking there. */
export function pauseScore(seconds: number) {
  if (seconds <= MIN_PAUSE_SECONDS) {
    return 0;
  }
  const share = Math.min(seconds, FULL_PAUSE_SECONDS) / FULL_PAUSE_SECONDS;
  return share * MAX_PAUSE_SCORE;
}

/**
 * A stretch that had to be cut on length alone: long enough to need a break,
 * with no punctuation and no pause anywhere inside it.
 *
 * Reported for the log rather than acted on. It is the one case a language
 * model would judge better, and on translated Chinese - which comes back
 * punctuated - it is rare enough not to be worth a billed call per file.
 */
export interface HardRun {
  /** Index of the first unit, into the array `segment` was given. */
  start: number;
  /** One past the last. */
  end: number;
}

export interface SegmentResult {
  segments: Segment[];
  hardRuns: HardRun[];
}

/**
 * Cost of ending a line where no word ends.
 *
 * Payable rather than illegal, so that the one stretch with no word end at
 * all - a single word longer than the whole line allowance - still gets cut
 * somewhere. Large enough that it is never paid while any legal split exists.
 */
const UNBREAKABLE_PENALTY = 1000;

/**
 * The break positions - exclusive end indices - that maximise the summed
 * score of every line in `units[from, to)`, each line scored as its end
 * boundary's strength minus its length's penalty.
 *
 * The same trade the greedy loop used to make, settled for the whole stretch
 * at once instead of one line at a time. That difference is backtracking: a
 * greedy cut takes the strongest boundary its own window can see and moves
 * on, and when the window after it holds no punctuation, the line it left
 * behind ends on nothing. The right answer was often already visible - end
 * the first line early, at the short clause and its comma, so the punctuation
 * sitting just past the window falls within the next line's reach - but only
 * a search that scores whole segmentations can prefer it, because the cheap
 * first line only pays off on the line after it.
 */
function bestBreaks(
  units: Unit[],
  from: number,
  to: number,
  max: number,
  min: number,
  strengthAfter: (i: number) => number,
  penalty: (length: number) => number
): number[] {
  const size = to - from;
  const best = new Array<number>(size + 1).fill(-Infinity);
  const cameFrom = new Array<number>(size + 1).fill(-1);
  best[0] = 0;

  for (let j = 1; j <= size; j++) {
    const isTail = j === size;
    const strength = strengthAfter(from + j - 1);
    const wordCost = !isTail && !units[from + j - 1].breakable ? UNBREAKABLE_PENALTY : 0;
    for (let length = 1; length <= Math.min(max, j); length++) {
      if (best[j - length] === -Infinity) {
        continue;
      }
      // Below the comfortable minimum only a finished sentence may end a
      // line; below the floor nothing may. The stretch's own tail is exempt:
      // it ends where it ends.
      if (!isTail) {
        if (length < FLOOR_UNITS) {
          continue;
        }
        if (length < min && strength < SENTENCE_SCORE) {
          continue;
        }
      }
      const score = best[j - length] + strength - penalty(length) - wordCost;
      if (score > best[j]) {
        best[j] = score;
        cameFrom[j] = j - length;
      }
    }
  }

  if (best[size] === -Infinity) {
    // No legal segmentation at all, which the guards above make practically
    // impossible. Even chops keep the caller moving rather than looping.
    const breaks: number[] = [];
    for (let j = max; j < size; j += max) {
      breaks.push(from + j);
    }
    breaks.push(to);
    return breaks;
  }
  const breaks: number[] = [];
  for (let j = size; j > 0; j = cameFrom[j]) {
    breaks.push(from + j);
  }
  return breaks.reverse();
}

/**
 * Cuts `units` into lines.
 *
 * Forced pauses are cut first and are not the optimiser's to trade away:
 * someone stopped talking, and no score on the far side of that silence
 * justifies holding a caption across it. Between forced pauses, the breaks
 * are chosen for the whole stretch at once - see `bestBreaks`.
 */
export function segmentUnits(
  units: Unit[],
  options: SegmenterOptions
): SegmentResult {
  if (units.length === 0) {
    return { segments: [], hardRuns: [] };
  }

  const cjk = isMainlyCjk(units.map((u) => u.core).join(''));
  const max = Math.max(2, cjk ? options.maxCjk : options.maxLatin);
  const target = Math.max(1, Math.round(max * TARGET_RATIO));
  const min = Math.max(FLOOR_UNITS, Math.round(target * MIN_RATIO));

  /** The case for ending a line after unit `i`. */
  const strengthAfter = (i: number) => {
    if (i >= units.length - 1) {
      return SENTENCE_SCORE;
    }
    return punctuationScore(units[i].text) + pauseScore(units[i + 1].gapBefore);
  };

  /** How far a line of `length` units is from a comfortable one. */
  const penalty = (length: number) => {
    if (length > target) {
      return ((length - target) / Math.max(max - target, 1)) * OVER_PENALTY;
    }
    return ((target - length) / target) * UNDER_PENALTY;
  };

  const lines: Unit[][] = [];
  const hardRuns: HardRun[] = [];

  let from = 0;
  for (let to = 1; to <= units.length; to++) {
    if (to < units.length && units[to].gapBefore < FORCED_PAUSE_SECONDS) {
      continue;
    }
    let start = from;
    for (const end of bestBreaks(units, from, to, max, min, strengthAfter, penalty)) {
      // Cut on length alone, with no boundary anywhere in it - the one case a
      // language model could do better. Reported so a caller may offer to,
      // and joined to the run before it when they touch, since one long
      // unpunctuated stretch is one question, not one per line it was chopped
      // into.
      let sawBoundary = false;
      for (let i = start; i < end; i++) {
        if (strengthAfter(i) > 0) {
          sawBoundary = true;
          break;
        }
      }
      if (!sawBoundary && end < units.length) {
        const previous = hardRuns[hardRuns.length - 1];
        if (previous && previous.end === start) {
          previous.end = end;
        }
        else {
          hardRuns.push({ start, end });
        }
      }
      lines.push(units.slice(start, end));
      start = end;
    }
    from = to;
  }

  return { segments: mergeStrays(lines, max, min), hardRuns };
}

/**
 * Folds a stray line back into its neighbour.
 *
 * The search above will end a line early for a full stop, which is usually
 * right and occasionally leaves a two-word caption flashing past. One is
 * merged back when there was no pause around it and the result still fits -
 * so "Right." said mid-sentence rejoins the sentence, while "Right." after a
 * beat of silence stays on its own.
 */
function mergeStrays(lines: Unit[][], max: number, min: number): Segment[] {
  const merged: Unit[][] = [];

  for (const line of lines) {
    const previous = merged[merged.length - 1];
    // Only lines the search would not have chosen for itself. Anything at or
    // above the minimum was picked on its merits, and folding two of those
    // together undoes the break that was the point of the exercise.
    const joinable =
      previous &&
      (previous.length < min || line.length < min) &&
      previous.length + line.length <= max &&
      pauseScore(line[0].gapBefore) === 0;
    if (joinable) {
      previous.push(...line);
      continue;
    }
    merged.push(line);
  }

  return merged.map((line) => ({
    start: line[0].start,
    end: line[line.length - 1].end,
    // The units carry the transcript's own spacing, so joining them and
    // tidying the edges is all that is needed - no words are re-spaced and
    // none are lost.
    text: joinUnits(line)
  }));
}

/**
 * A line's text, from the units' own slices.
 *
 * Runs of whitespace collapse to one space, and in a CJK transcript the space
 * between two CJK characters goes entirely - but only there. A Chinese
 * transcript still quotes product names and English terms, and stripping every
 * space would run those together.
 */
function joinUnits(line: Unit[]) {
  const parts: string[] = [];
  for (const unit of line) {
    // A caption's text starts at its first word, so two captions pulled onto
    // one line would otherwise run together as "Right.So." The space goes back
    // everywhere except between two CJK characters, which are written without
    // one - and only at the joins made here, so whatever spacing the text
    // itself chose around its English terms is left exactly as it came.
    if (unit.startsSegment && parts.length > 0) {
      const left = lastWordChar(parts[parts.length - 1]);
      const right = firstWordChar(unit.text);
      if (!left || !right || !CJK.test(left) || !CJK.test(right)) {
        parts.push(' ');
      }
    }
    parts.push(unit.text);
  }
  return parts.join('').replace(/\s+/g, ' ').trim();
}

/** The last letter or digit in `text` - the character a join butts up against. */
function lastWordChar(text: string) {
  return text.match(/[\p{Letter}\p{Number}](?=[^\p{Letter}\p{Number}]*$)/u)?.[0] ?? null;
}

function firstWordChar(text: string) {
  return text.match(/[\p{Letter}\p{Number}]/u)?.[0] ?? null;
}

/** Re-cuts a whole file. The entry point the translation queue uses. */
export function segmentTranscript(
  segments: Segment[],
  options: SegmenterOptions = DEFAULT_SEGMENTER_OPTIONS
): SegmentResult {
  return segmentUnits(toUnits(segments), options);
}
