/**
 * Turns timed words into captions.
 *
 * Both providers are asked for word timestamps and neither is asked for
 * captions, so this is where captions come from - one rule for both, rather
 * than Gemini's words assembled here and Whisper's own segment list taken as
 * it came. Whisper's segments were the reason the two paths produced
 * differently-shaped subtitles from the same audio.
 *
 * Words are also the only thing precise enough to cut a caption anywhere
 * except where the provider already cut it. A caption knows only that its
 * twenty characters occupy four seconds; a word knows when it was said, so a
 * break inserted between two words carries an exact time rather than an
 * estimate interpolated from character counts.
 */

import { type Segment } from './SubtitleBuilder.js';

/** One word, as the provider timed it. */
export interface Word {
  text: string;
  start: number;
  end: number;
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * Where one caption ends and the next begins, given a list of words.
 *
 * The thresholds are deliberately close to what Whisper produces on its own,
 * since everything downstream - the translator's re-cutting, the seam mapping
 * - was built against segments of that size.
 */
const SPLIT_GAP_SECONDS = 0.6;
const MAX_SEGMENT_SECONDS = 8;
const MAX_SEGMENT_CHARS = 84;

/**
 * A pause meaningfully longer than this speaker's usual one is a boundary
 * too, whatever the clock says. Someone talking quickly leaves a hundredth of
 * a second between words and pauses for four; the fixed threshold above never
 * fires inside that, and the caption runs on past a break anyone listening
 * can hear. Measured against the recent gaps rather than a number chosen for
 * everybody.
 */
const GAP_WINDOW = 5;
const GAP_AVERAGE_FACTOR = 3;
/** Below this a pause is not trusted, however long it is next to the average. */
const MIN_RELATIVE_GAP_SECONDS = 0.25;

/**
 * Captions this short, separated from their neighbour by this little, are
 * fragments - a "yes" or a "嗯" in its own caption, on screen for half a
 * second. Reading a subtitle means looking away from the speaker, so a
 * fragment costs a glance for almost nothing; joined into its neighbour it
 * reads as part of the same breath, which a gap this small says it was.
 *
 * Word counts are per caption: characters for CJK, words for spaced
 * languages.
 */
const MERGE_RULES = [
  { maxGap: 0.2, maxUnits: 5 },
  { maxGap: 0.5, maxUnits: 3 }
];
/** CJK characters counted as one caption's worth of a fragment. */
const MERGE_UNITS_CJK = 8;

const SENTENCE_END = /[.!?。！？…]["'’”』」）)\]]*\s*$/u;

/**
 * Where each word sits in the transcript, or null when they cannot all be
 * found in order.
 *
 * Worth doing because it lets a caption's text be a slice of the transcript
 * rather than its words glued back together: the punctuation, spacing and
 * casing stay exactly as the model wrote them, and a language written without
 * spaces does not have any inserted.
 */
export function alignWords(text: string, words: Word[]): number[] | null {
  const starts: number[] = [];
  let cursor = 0;
  for (const word of words) {
    const at = text.indexOf(word.text, cursor);
    if (at < 0) {
      return null;
    }
    starts.push(at);
    cursor = at + word.text.length;
  }
  return starts;
}

/** Whether a caption is written without spaces between its words. */
function isMainlyCjk(text: string) {
  const letters = text.match(/\p{Letter}/gu) || [];
  if (letters.length === 0) {
    return false;
  }
  return letters.filter((c) => CJK.test(c)).length / letters.length > 0.5;
}

/** Words for spaced languages, characters for ones written without spaces. */
function countUnits(text: string) {
  return isMainlyCjk(text) ?
    (text.match(/\p{Letter}|\p{Number}/gu) || []).length
    : (text.match(/[\p{Letter}\p{Number}]+/gu) || []).length;
}

/** Two captions joined as one, with the space only where the writing has one. */
function joinTexts(left: string, right: string) {
  if (CJK.test(left.slice(-1)) && CJK.test(right.slice(0, 1))) {
    return left + right;
  }
  return `${left} ${right}`;
}

/**
 * Joins fragments into their neighbours: a caption short enough, close enough
 * to the one before it, becomes part of that one - unless what it would join
 * is a finished sentence, or the two together would be too long to hold on
 * screen.
 */
function mergeFragments(segments: Segment[]): Segment[] {
  const merged: Segment[] = [];
  for (const segment of segments) {
    const prev = merged[merged.length - 1];
    if (prev) {
      const gap = segment.start - prev.end;
      const units = countUnits(segment.text);
      const limit = isMainlyCjk(segment.text) ? MERGE_UNITS_CJK : undefined;
      const fragment = MERGE_RULES.some((rule) =>
        gap <= rule.maxGap && units <= (limit ?? rule.maxUnits)
      );
      const text = joinTexts(prev.text, segment.text);
      if (
        fragment &&
        !SENTENCE_END.test(prev.text) &&
        text.length <= MAX_SEGMENT_CHARS &&
        segment.end - prev.start <= MAX_SEGMENT_SECONDS
      ) {
        merged[merged.length - 1] = { start: prev.start, end: segment.end, text };
        continue;
      }
    }
    merged.push(segment);
  }

  // The first caption can only ever join forwards. Done after the loop, since
  // the caption it joins may itself have just grown.
  if (merged.length >= 2) {
    const [ first, second ] = merged;
    const gap = second.start - first.end;
    const units = countUnits(first.text);
    const limit = isMainlyCjk(first.text) ? MERGE_UNITS_CJK : undefined;
    const fragment = MERGE_RULES.some((rule) =>
      gap <= rule.maxGap && units <= (limit ?? rule.maxUnits)
    );
    const text = joinTexts(first.text, second.text);
    if (
      fragment &&
      !SENTENCE_END.test(first.text) &&
      text.length <= MAX_SEGMENT_CHARS &&
      second.end - first.start <= MAX_SEGMENT_SECONDS
    ) {
      merged.splice(0, 2, { start: first.start, end: second.end, text });
    }
  }
  return merged;
}

/** Groups timed words into captions. */
export function toSegments(text: string, words: Word[]): Segment[] {
  if (words.length === 0) {
    return [];
  }
  const starts = alignWords(text, words);

  /** The transcript from word `i` up to the start of word `j + 1`. */
  const sliceText = (i: number, j: number) => {
    if (!starts) {
      // Nothing to slice against, so the words are joined instead. A space
      // between them is wrong for Chinese, but a response that could not be
      // aligned is already an odd one - a readable caption beats none.
      return words.slice(i, j + 1).map((w) => w.text).join(' ').trim();
    }
    const from = starts[i];
    const to = j + 1 < starts.length ? starts[j + 1] : text.length;
    return text.slice(from, to).trim();
  };

  const segments: Segment[] = [];
  // The gaps inside the caption being built, as a running sample of this
  // speaker's pace. Only gaps shorter than the fixed threshold are counted:
  // one long enough to break on is a boundary, and boundaries are not what an
  // average of the pace should be made of.
  const recentGaps: number[] = [];
  let start = 0;
  for (let i = 0; i < words.length; i++) {
    const isLast = i === words.length - 1;
    const body = sliceText(start, i);
    const gapAfter = isLast ? Infinity : words[i + 1].start - words[i].end;
    if (!isLast && gapAfter < SPLIT_GAP_SECONDS) {
      recentGaps.push(gapAfter);
      if (recentGaps.length > GAP_WINDOW) {
        recentGaps.shift();
      }
    }
    const average = recentGaps.length >= 3 ?
      recentGaps.reduce((total, gap) => total + gap, 0) / recentGaps.length
      : null;
    const unusualPause = average !== null &&
      gapAfter >= Math.max(MIN_RELATIVE_GAP_SECONDS, average * GAP_AVERAGE_FACTOR);
    const duration = words[i].end - words[start].start;
    const shouldBreak =
      isLast ||
      SENTENCE_END.test(body) ||
      gapAfter >= SPLIT_GAP_SECONDS ||
      unusualPause ||
      duration >= MAX_SEGMENT_SECONDS ||
      body.length >= MAX_SEGMENT_CHARS;
    if (!shouldBreak) {
      continue;
    }
    if (body) {
      segments.push({ start: words[start].start, end: words[i].end, text: body });
    }
    start = i + 1;
    recentGaps.length = 0;
  }
  return mergeFragments(segments);
}
