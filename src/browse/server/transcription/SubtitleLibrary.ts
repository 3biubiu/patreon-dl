import fs from 'fs';
import path from 'path';
import { srtToVTT } from './SubtitleBuilder.js';
import { type SubtitleFile } from '../../types/Transcription.js';

export { type SubtitleFile } from '../../types/Transcription.js';

const SUBTITLE_EXTENSIONS = [ '.srt', '.vtt' ];

/** `en`, `zh-Hans`, `pt-BR` - a tag, not somebody's "final_v2". */
const LANGUAGE_TAG = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i;

function toLabel(language: string | null, filename: string) {
  if (!language) {
    return filename;
  }
  try {
    const names = new Intl.DisplayNames([ 'en' ], { type: 'language' });
    return names.of(language) || language;
  }
  catch {
    return language;
  }
}

/**
 * The subtitles sitting next to `videoPath`.
 *
 * Read when a player opens rather than kept in an index, so that a file
 * dropped in by hand shows up without anything having to be told about it.
 * That is one directory read for one video, which is affordable - doing the
 * same for every tile in a library is not, and is why `TranscriptionIndex`
 * exists for the badge.
 *
 * Files named after the video win. Only when there are none does the whole
 * directory get offered, since a directory holding several videos would
 * otherwise show each of them everyone else's captions.
 */
export function listSubtitlesFor(videoPath: string): SubtitleFile[] {
  const dir = path.dirname(videoPath);
  const base = path.basename(videoPath, path.extname(videoPath));
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  }
  catch {
    return [];
  }

  const matched: SubtitleFile[] = [];
  const others: SubtitleFile[] = [];
  for (const entry of entries) {
    const ext = path.extname(entry).toLowerCase();
    if (!SUBTITLE_EXTENSIONS.includes(ext)) {
      continue;
    }
    const stem = path.basename(entry, ext);
    if (stem === base) {
      matched.push({ filename: entry, language: null, label: toLabel(null, entry) });
    }
    else if (stem.startsWith(`${base}.`)) {
      const suffix = stem.slice(base.length + 1);
      const language = LANGUAGE_TAG.test(suffix) ? suffix : null;
      matched.push({ filename: entry, language, label: toLabel(language, entry) });
    }
    else {
      others.push({ filename: entry, language: null, label: toLabel(null, entry) });
    }
  }
  const found = matched.length > 0 ? matched : others;
  return found.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Reads one of `listSubtitlesFor`'s results as WebVTT, or `null` if it is gone.
 *
 * `filename` arrives from the browser, so it is only honoured when it is one
 * of the names just listed - never joined onto the directory as given.
 */
export function readSubtitleAsVTT(videoPath: string, filename: string): string | null {
  const available = listSubtitlesFor(videoPath);
  const match = available.find((s) => s.filename === filename);
  if (!match) {
    return null;
  }
  const file = path.resolve(path.dirname(videoPath), match.filename);
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf-8');
  }
  catch {
    return null;
  }
  if (path.extname(match.filename).toLowerCase() === '.vtt') {
    return content;
  }
  return srtToVTT(content);
}
