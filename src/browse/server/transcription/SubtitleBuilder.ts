/**
 * Turns Whisper segments into an SRT file, dropping the artefacts Whisper
 * emits when it is fed audio that has no speech in it.
 *
 * VAD removes the long silences before anything is uploaded, but it is not a
 * complete answer: Whisper still loops inside a speech interval, and Silero
 * lets music with vocals through. So this stays as a second pass.
 *
 * The rules here were derived from a 54-minute tutorial video transcribed in
 * full: of its 371 segments, 145 were artefacts - music markers, repeated
 * filler words, and short phrases stretched across half a minute.
 */

export interface Segment {
  start: number;
  end: number;
  text: string;
  /** Whisper's mean token log-probability. Absent on providers that omit it. */
  avgLogprob?: number | null;
}

/**
 * Whisper's stock renderings of "there is music here". Real speech does not
 * describe itself this way, so the text alone is enough to reject on.
 */
const MUSIC_MARKER = /^\W*(\*\s*)?((outro|intro|sad|soft|upbeat|gentle)\s+)?music\b|^\W*\[\s*music|♪/i;

/** Leftovers from the subtitled videos in Whisper's training data. */
const OUTRO_MARKER = /^\W*(thank you for watching|thanks for watching|subscribe|see you (in|next))/i;

/**
 * A phrase repeated this many times is Whisper looping, not someone talking.
 * The observed video had "you" 58 times and "thank you" 19 times, none of
 * which were spoken.
 */
const REPEAT_LIMIT = 3;
/** Only short phrases are judged by repetition; long ones repeat legitimately. */
const REPEAT_MAX_LENGTH = 30;
/** Characters per second below which a segment is text stretched over silence. */
const MIN_CHARS_PER_SECOND = 1.5;
/**
 * Stretched-looking segments are kept when Whisper was confident about them:
 * real speech with a generous end timestamp reads as slow, but scores well.
 */
const STRETCHED_MAX_LOGPROB = -0.5;

/** Case and punctuation carry no signal for the repetition test. */
function normalize(text: string) {
  return text
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number} ]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export type RejectReason = 'empty' | 'music' | 'outro' | 'repeated' | 'stretched';

/**
 * Returns why `segment` should be dropped, or `null` to keep it. `counts` maps
 * normalized text to how often it occurs across the whole transcript, so the
 * repetition rule can see beyond the segment in front of it.
 */
export function rejectReason(
  segment: Segment,
  counts: Map<string, number>
): RejectReason | null {
  const text = segment.text.trim();
  const key = normalize(text);
  if (!key) {
    return 'empty';
  }
  if (MUSIC_MARKER.test(text)) {
    return 'music';
  }
  if (OUTRO_MARKER.test(text)) {
    return 'outro';
  }
  if (key.length <= REPEAT_MAX_LENGTH && (counts.get(key) || 0) >= REPEAT_LIMIT) {
    return 'repeated';
  }
  const duration = Math.max(segment.end - segment.start, 0.01);
  const charsPerSecond = text.length / duration;
  const logprob = segment.avgLogprob;
  if (
    charsPerSecond < MIN_CHARS_PER_SECOND &&
    logprob !== null && logprob !== undefined && logprob < STRETCHED_MAX_LOGPROB
  ) {
    return 'stretched';
  }
  return null;
}

export interface FilterResult {
  kept: Segment[];
  rejected: { segment: Segment; reason: RejectReason }[];
}

/**
 * Drops the artefacts from a whole transcript. Must be given every segment at
 * once - the repetition rule counts across the entire video, so running this
 * per chunk would miss a phrase that only looks excessive in aggregate.
 */
export function filterHallucinations(segments: Segment[]): FilterResult {
  const counts = new Map<string, number>();
  for (const segment of segments) {
    const key = normalize(segment.text);
    if (key && key.length <= REPEAT_MAX_LENGTH) {
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const kept: Segment[] = [];
  const rejected: { segment: Segment; reason: RejectReason }[] = [];
  for (const segment of segments) {
    const reason = rejectReason(segment, counts);
    if (reason) {
      rejected.push({ segment, reason });
    }
    else {
      kept.push(segment);
    }
  }
  return { kept, rejected };
}

/** `HH:MM:SS,mmm` - hours are not wrapped at 24, as SRT expects. */
export function formatTimestamp(seconds: number) {
  const clamped = Math.max(0, seconds);
  const totalMs = Math.round(clamped * 1000);
  const ms = totalMs % 1000;
  const totalSeconds = (totalMs - ms) / 1000;
  const s = totalSeconds % 60;
  const totalMinutes = (totalSeconds - s) / 60;
  const m = totalMinutes % 60;
  const h = (totalMinutes - m) / 60;
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

/**
 * Renders segments as SRT. Segments are sorted and any overlap is trimmed:
 * chunks are transcribed independently, and a segment running past the start
 * of the next one makes players show two captions at once.
 */
export function buildSRT(segments: Segment[]) {
  const ordered = [ ...segments ].sort((a, b) => a.start - b.start);
  const lines: string[] = [];
  let index = 0;
  for (let i = 0; i < ordered.length; i++) {
    const segment = ordered[i];
    const text = segment.text.trim();
    if (!text) {
      continue;
    }
    const next = ordered[i + 1];
    const end = next && next.start < segment.end ? next.start : segment.end;
    if (end <= segment.start) {
      continue;
    }
    index++;
    lines.push(String(index));
    lines.push(`${formatTimestamp(segment.start)} --> ${formatTimestamp(end)}`);
    lines.push(text);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Converts SRT to WebVTT. `<track>` does not accept SRT, so the file kept on
 * disk is converted on the way out rather than stored twice.
 */
export function srtToVTT(srt: string) {
  const body = srt
    .replace(/\r\n/g, '\n')
    .replace(/^﻿/, '')
    // WebVTT separates the timestamp fields with a dot, not a comma.
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${body}`;
}
