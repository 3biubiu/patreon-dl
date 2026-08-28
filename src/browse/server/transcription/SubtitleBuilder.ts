/**
 * Turns transcriber segments into an SRT file.
 *
 * Nothing here judges what was said. An earlier version dropped segments it
 * read as artefacts - music markers, repeated filler, text stretched thinly
 * over its own duration - and every one of those rules had a way of throwing
 * out real speech with them: a short answer repeated through a conversation,
 * a line delivered slowly, a lyric that was actually sung. Cutting the
 * silence before the upload is what removes the input those artefacts are
 * made from; a second opinion on the way out only added another thing to
 * reason about when a line went missing. What comes back gets written.
 */

export interface Segment {
  start: number;
  end: number;
  text: string;
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
 * Renders segments as SRT.
 *
 * Segments are sorted, and one running past the start of the next has its end
 * pulled back: clips are transcribed independently, and two captions on
 * screen at once is a broken file rather than a stylistic choice. This
 * shortens how long a caption is held. It never changes what one says, and it
 * never removes one.
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
    .replace(/^\uFEFF/, '')
    // WebVTT separates the timestamp fields with a dot, not a comma.
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${body}`;
}
