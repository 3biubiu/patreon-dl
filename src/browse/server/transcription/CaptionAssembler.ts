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
  let start = 0;
  for (let i = 0; i < words.length; i++) {
    const isLast = i === words.length - 1;
    const body = sliceText(start, i);
    const gapAfter = isLast ? Infinity : words[i + 1].start - words[i].end;
    const duration = words[i].end - words[start].start;
    const shouldBreak =
      isLast ||
      SENTENCE_END.test(body) ||
      gapAfter >= SPLIT_GAP_SECONDS ||
      duration >= MAX_SEGMENT_SECONDS ||
      body.length >= MAX_SEGMENT_CHARS;
    if (!shouldBreak) {
      continue;
    }
    if (body) {
      segments.push({ start: words[start].start, end: words[i].end, text: body });
    }
    start = i + 1;
  }
  return segments;
}
