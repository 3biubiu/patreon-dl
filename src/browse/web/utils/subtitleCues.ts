/**
 * Reading a subtitle file as text rather than as captions.
 *
 * The player hands its VTT straight to a `<track>` element and never looks
 * inside it. The transcript view does look inside: it puts the English the
 * transcription produced next to the Chinese the translation produced, so both
 * have to be parsed here and then lined up with each other.
 */

/** One caption line, with the seconds it covers. */
export interface Cue {
  start: number;
  end: number;
  text: string;
}

/** An English cue and whatever Chinese was said over the same seconds. */
export interface CuePair {
  key: number;
  start: number;
  end: number;
  source: string;
  target: string;
}

const TIMING = /^(\S+)\s+-->\s+(\S+)/;

/** `00:01:02.500` or `01:02.500`, in seconds. Anything else is `null`. */
function parseTimestamp(value: string): number | null {
  const parts = value.trim().replace(',', '.').split(':');
  if (parts.length < 2 || parts.length > 3) {
    return null;
  }
  const numbers = parts.map((part) => Number(part));
  if (numbers.some((n) => !Number.isFinite(n))) {
    return null;
  }
  const [ hours, minutes, seconds ] = numbers.length === 3 ? numbers : [ 0, ...numbers ];
  return (hours * 3600) + (minutes * 60) + seconds;
}

/**
 * Strips the markup a cue is allowed to carry - `<c>`, `<v Name>`, `<00:00:01.000>`
 * and the like - since none of it means anything outside a caption box.
 */
function cleanText(text: string) {
  return text.replace(/<[^>]*>/g, '').trim();
}

/**
 * The cues in a WebVTT file, in the order they play.
 *
 * The server serves every subtitle as VTT, whatever it is on disk, so this is
 * the only format worth handling. Blocks without a timing line - the header,
 * NOTE and STYLE blocks, a cue identifier on its own - are skipped rather than
 * treated as an error: a file that is half readable is still worth reading.
 */
export function parseVTT(text: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const timingIndex = lines.findIndex((line) => TIMING.test(line));
    if (timingIndex < 0) {
      continue;
    }
    const match = TIMING.exec(lines[timingIndex]);
    const start = match ? parseTimestamp(match[1]) : null;
    const end = match ? parseTimestamp(match[2]) : null;
    if (start === null || end === null) {
      continue;
    }
    const body = cleanText(lines.slice(timingIndex + 1).join('\n'));
    if (!body) {
      continue;
    }
    cues.push({ start, end: Math.max(end, start), text: body });
  }
  return cues;
}

/**
 * Lines the two languages up by the seconds they cover.
 *
 * Not by position: the translation re-cuts the lines it is given so the Chinese
 * reads as Chinese, so the two files rarely have the same number of cues and
 * pairing them by index would put the transcript out of step with itself a
 * minute in. Overlap in time is the one thing the two agree on.
 *
 * Both sides are in play order, so this walks them together rather than
 * searching the whole of one for every cue of the other.
 */
export function alignCues(source: Cue[], target: Cue[]): CuePair[] {
  if (source.length === 0) {
    return target.map((cue, index) => ({
      key: index,
      start: cue.start,
      end: cue.end,
      source: '',
      target: cue.text
    }));
  }
  const pairs: CuePair[] = [];
  let from = 0;
  source.forEach((cue, index) => {
    // Everything that finished before this cue began is behind us for good.
    while (from < target.length && target[from].end <= cue.start) {
      from++;
    }
    const matched: string[] = [];
    for (let i = from; i < target.length && target[i].start < cue.end; i++) {
      matched.push(target[i].text);
    }
    pairs.push({
      key: index,
      start: cue.start,
      end: cue.end,
      source: cue.text,
      target: matched.join(' ')
    });
  });
  return pairs;
}

/** `1:02:03` for anything past an hour, `02:03` below it. */
export function formatCueTime(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`;
}
