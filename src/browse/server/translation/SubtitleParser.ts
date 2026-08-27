/**
 * Reads an SRT file into its cues and writes one back out.
 *
 * Translation never touches timing. The timing line is carried through as the
 * string it arrived as, so a round trip through here cannot shift a caption by
 * a millisecond - only the text between the timings is replaced.
 */

export interface Cue {
  /** 1-based position in the file, and the key sent upstream. */
  index: number;
  /** The timing line exactly as it was, so nothing is lost re-rendering it. */
  timing: string;
  /** The caption, with its own line breaks kept. */
  text: string;
}

/**
 * One cue: a number, a timing line, then text up to the next cue or the end.
 *
 * The lookahead rather than a blank-line split is what lets a caption contain
 * a blank line of its own - rare, but a split would silently truncate it and
 * the missing half would only surface as a caption that stops mid-sentence.
 */
const CUE = new RegExp(
  String.raw`(?:^|\n)[^\S\n]*\d+[^\S\n]*\n` +
  String.raw`[^\S\n]*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}[^\S\n]*-->[^\S\n]*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}[^\n]*)\n` +
  String.raw`([\s\S]*?)` +
  String.raw`(?=\n[^\S\n]*\d+[^\S\n]*\n[^\S\n]*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}[^\S\n]*-->|\s*$)`,
  'g'
);

/**
 * The cues in `content`, renumbered from 1.
 *
 * Renumbering rather than trusting the file's own numbers: they are what the
 * translations come back keyed by, and a file with a repeated or missing
 * number would otherwise put two translations on one cue.
 */
export function parseSRT(content: string): Cue[] {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const cues: Cue[] = [];
  for (const match of normalized.matchAll(CUE)) {
    const text = match[2].trim();
    if (!text) {
      continue;
    }
    cues.push({ index: cues.length + 1, timing: match[1].trim(), text });
  }
  return cues;
}

/**
 * Renders cues as SRT, taking each one's text from `translations` and falling
 * back to the original.
 *
 * The fallback is deliberate: a line the model dropped is better shown in the
 * source language than shown as a gap, which a viewer reads as the speaker
 * having said nothing.
 */
export function buildTranslatedSRT(cues: Cue[], translations: Map<number, string>) {
  const lines: string[] = [];
  for (const cue of cues) {
    const translated = translations.get(cue.index)?.trim();
    lines.push(String(cue.index));
    lines.push(cue.timing);
    lines.push(translated || cue.text);
    lines.push('');
  }
  return lines.join('\n');
}
