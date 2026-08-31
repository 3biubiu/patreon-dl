/**
 * Re-cuts the source transcript into captions by asking a language model where
 * the sentences end.
 *
 * The rule-based cut in `CaptionAssembler` breaks on a pause, a full stop, or
 * a length ceiling, and those three signals are all a caption assembler has.
 * They are not enough for a speaker who runs three sentences together without
 * pausing, or who pauses in the middle of one. A model reading the words knows
 * the difference, and this asks it.
 *
 * Two things make this exact rather than approximate. The model is given the
 * transcript and asked only to insert `<br>` - it does not rewrite, retime, or
 * return anything else - and the answer is walked against the original
 * character by character, so a model that changed a word is caught and told
 * where. And every word is timed, so a break the model puts between two words
 * carries the second word's own start time. Nothing is interpolated.
 *
 * That last point is why this runs here and not on the translation. The
 * translated text has no timings of its own, so a break inside a translated
 * caption can only be estimated from character counts; a break here is read
 * off the word it lands on.
 */

import { fetch, type Response } from 'undici';
import { commonLog, type LogLevel } from '../../../utils/logging/Logger.js';
import type Logger from '../../../utils/logging/Logger.js';
import { createProxyAgentFor } from '../../../utils/Proxy.js';
import { alignWords, type Word } from './CaptionAssembler.js';
import { type Segment } from './SubtitleBuilder.js';

export interface SplitterSettings {
  apiKey: string | null;
  model: string;
  /** Includes the API version, as the translator's does. */
  baseUrl: string;
  /** `null` sends the request directly, which is what an empty setting means. */
  proxyUrl: string | null;
  disableThinking: boolean;
  /** Longest caption in characters, for Chinese, Japanese and Korean. */
  maxCjk: number;
  /** Longest caption in words, for everything written with spaces. */
  maxLatin: number;
}

/**
 * Words per request.
 *
 * Gemini AI Studio bills by the call, not by the token, so a chunk should be
 * as large as the model can answer rather than as small as is comfortable. An
 * hour of English is about nine thousand words, which is five calls at this
 * size - VideoCaptioner's five hundred would be eighteen, and it chunks that
 * small because it fans them out across a thread pool rather than to save
 * anything.
 *
 * What bounds this is not the price but the model's output ceiling, since the
 * answer is the chunk back verbatim plus a tag every dozen words: two thousand
 * words is roughly 2.7k tokens in and 3k out, which leaves room on any model
 * worth using. A correction resends the whole exchange, so the headroom is
 * worth more than the two or three calls a larger chunk would save.
 */
const MAX_CHUNK_WORDS = 2000;
/** The first answer plus two corrections. */
const MAX_STEPS = 3;
const REQUEST_TIMEOUT_MS = 180_000;
const BREAK = '<br>';

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/**
 * The tag, as a model actually writes it. `<br/>` and `<BR>` are the same
 * instruction followed correctly, and rejecting them would spend a correction
 * round-trip on nothing.
 */
const BREAK_TAG = /^<\s*br\s*\/?\s*>/i;

/** Length of the break tag at `at`, or 0 when there is not one. */
function breakAt(text: string, at: number) {
  const match = BREAK_TAG.exec(text.slice(at, at + 12));
  return match ? match[0].length : 0;
}
const WORD = /[\p{Letter}\p{Number}]+/gu;

const SYSTEM_PROMPT = [
  'You are a subtitle segmenter. You are given a transcript of speech. Insert',
  `${BREAK} tags to mark where one subtitle caption should end and the next`,
  'should begin.',
  '',
  'Rules:',
  `1. Insert ${BREAK} at sentence boundaries, and inside a long sentence at the`,
  '   clause boundaries a reader would pause at - after a comma, a conjunction,',
  '   or a complete phrase.',
  '2. Length limits per caption: CJK languages ${maxCjk} characters or fewer;',
  '   languages written with spaces ${maxLatin} words or fewer.',
  '3. Every caption must be a complete unit of meaning. Do not leave a stray',
  '   fragment of one or two words unless it is a complete utterance on its own.',
  '4. THE TEXT ITSELF MUST NOT CHANGE. Do not add, remove, correct, reorder or',
  `   translate a single character. Do not fix spelling, grammar or punctuation.`,
  `   You may only insert ${BREAK}. The answer with every ${BREAK} removed must`,
  '   be byte-for-byte the text you were given.',
  '',
  `Output the text with ${BREAK} between captions and nothing else - no`,
  'explanation, no numbering, no code fences.',
  '',
  'Examples - note how the text is returned exactly as given, with tags',
  'inserted only where a caption should end:',
  '',
  'Input: "In this video I want to cover three things. First, how to set up the',
  'project. Second, how the build works. And third, common pitfalls. Alright,',
  'let\'s get started."',
  'Output: "In this video I want to cover three things.<br>First, how to set',
  'up the project.<br>Second, how the build works.<br>And third, common',
  'pitfalls.<br>Alright, let\'s get started."',
  '',
  'Input: "这个视频主要分为三个部分，第一部分讲环境的搭建，第二部分讲编译的流程，第三部分',
  '讲一些常见的问题和踩坑，好，那我们开始吧。"',
  'Output: "这个视频主要分为三个部分，<br>第一部分讲环境的搭建，<br>第二部分讲编译的流程，<br>第三部分',
  `讲一些常见的问题和踩坑，<br>好，那我们开始吧。"`,
  '',
  'Input: "The countdown is three, two, one, and we have liftoff."',
  'Output: "The countdown is three, two, one,<br>and we have liftoff." - the',
  'reveal that follows a buildup is where a reader looks away to read, so a',
  'caption break there keeps the punchline on screen as it happens.'
].join('\n');

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
}

/** The transcript the captions were cut from, and where each one sits in it. */
function joinSegments(segments: Segment[]) {
  const parts: string[] = [];
  const spans: { from: number; to: number }[] = [];
  let at = 0;
  for (const segment of segments) {
    const text = segment.text.trim();
    if (!text) {
      continue;
    }
    // A caption's text starts at its first word, so two of them run together
    // as "Right.So." without this. No space between two CJK characters, which
    // are written without one.
    if (parts.length > 0) {
      const left = parts[parts.length - 1].slice(-1);
      const right = text.slice(0, 1);
      if (!CJK.test(left) || !CJK.test(right)) {
        parts.push(' ');
        at += 1;
      }
    }
    parts.push(text);
    spans.push({ from: at, to: at + text.length });
    at += text.length;
  }
  return { text: parts.join(''), spans };
}

/** Whether the transcript is written without spaces between words. */
function isMainlyCjk(text: string) {
  const letters = text.match(/[\p{Letter}]/gu);
  if (!letters || letters.length === 0) {
    return false;
  }
  return letters.filter((c) => CJK.test(c)).length / letters.length > 0.5;
}

/** Characters for a CJK caption, words for one written with spaces. */
function countUnits(text: string, cjk: boolean) {
  if (cjk) {
    return (text.match(/[\p{Letter}\p{Number}]/gu) || []).length;
  }
  return (text.match(WORD) || []).length;
}

function context(text: string, at: number, width: number) {
  return text.slice(Math.max(0, at - width), Math.min(text.length, at + width));
}

/**
 * Where the answer put its breaks, as offsets into `source`, or what it
 * changed.
 *
 * Both strings are walked together: a `<br>` in the answer records a break,
 * matching characters advance both, and whitespace on either side is allowed
 * to differ, since a model that puts a newline where a space was has not
 * changed the transcript. Anything else is a rewrite, and the position it
 * happened at is exactly what the model needs to be told.
 */
export function locateBreaks(
  source: string,
  answer: string
): { offsets: number[] } | { error: string } {
  const offsets: number[] = [];
  const isSpace = (c: string) => /\s/.test(c);
  let i = 0;
  let j = 0;

  while (i < source.length && j < answer.length) {
    const tag = breakAt(answer, j);
    if (tag > 0) {
      if (i > 0) {
        offsets.push(i);
      }
      j += tag;
      continue;
    }
    if (source[i] === answer[j]) {
      i++;
      j++;
      continue;
    }
    // Whitespace is the one difference that carries no meaning, so it is
    // skipped on whichever side has it.
    if (isSpace(source[i])) {
      i++;
      continue;
    }
    if (isSpace(answer[j])) {
      j++;
      continue;
    }
    return {
      error:
        `The text was changed around "...${context(source, i, 25)}...". ` +
        `You wrote "...${context(answer, j, 25)}...". ` +
        'Put the original wording back - only <br> may be inserted.'
    };
  }

  while (j < answer.length) {
    const tag = breakAt(answer, j);
    if (tag > 0) {
      j += tag;
      continue;
    }
    if (!isSpace(answer[j])) {
      break;
    }
    j++;
  }
  while (i < source.length && isSpace(source[i])) {
    i++;
  }
  if (i < source.length) {
    return {
      error:
        `The answer stopped early, at "...${context(source, i, 25)}...". ` +
        'Return the whole text, from the first word to the last.'
    };
  }
  if (j < answer.length) {
    return {
      error:
        `The answer ran past the end of the text, adding "${answer.slice(j, j + 60)}". ` +
        'Return the text and nothing else.'
    };
  }
  return { offsets };
}

/** The captions `offsets` would produce that are longer than allowed. */
function tooLong(source: string, offsets: number[], maxCjk: number, maxLatin: number) {
  const cjk = isMainlyCjk(source);
  const limit = cjk ? maxCjk : maxLatin;
  const cuts = [ 0, ...offsets, source.length ];
  const over: string[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const piece = source.slice(cuts[i], cuts[i + 1]).trim();
    const units = countUnits(piece, cjk);
    if (units > limit) {
      const preview = piece.length > 50 ? `${piece.slice(0, 50)}...` : piece;
      over.push(
        `"${preview}" is ${units} ${cjk ? 'characters' : 'words'}, over the ${limit} limit`
      );
    }
  }
  return over;
}

/**
 * Cuts the transcript at `offsets`, taking each caption's times from the words
 * inside it.
 *
 * A stretch with no word in it - punctuation the model cut around, or a break
 * placed twice in the same gap - cannot be timed, so it is carried into the
 * caption that follows rather than dropped: the characters stay in the
 * subtitle, they simply do not get a caption of their own.
 */
function toSegments(
  transcript: string,
  starts: number[],
  words: Word[],
  offsets: number[]
): Segment[] {
  const cuts = [ ...new Set(offsets.filter((o) => o > 0 && o < transcript.length)) ]
    .sort((a, b) => a - b);
  const segments: Segment[] = [];
  let from = 0;
  let cursor = 0;

  for (const to of [ ...cuts, transcript.length ]) {
    const first = cursor;
    while (cursor < words.length && starts[cursor] < to) {
      cursor++;
    }
    const last = cursor - 1;
    if (last < first) {
      continue;
    }
    const text = transcript.slice(from, to).trim();
    if (text) {
      segments.push({ start: words[first].start, end: words[last].end, text });
    }
    from = to;
  }
  return segments;
}

/**
 * Splits the source transcript with a language model, falling back to the
 * captions it was given.
 *
 * A failure here is never fatal. The transcription is the expensive part and
 * it is already paid for, so a chunk the model would not segment keeps the
 * captions the rule-based assembler drew for it and the job finishes. Every
 * fallback is logged, because a subtitle that quietly came out worse is the
 * one nobody investigates.
 */
export default class SentenceSplitter {
  name = 'SentenceSplitter';

  #getSettings: () => SplitterSettings;
  #logger?: Logger | null;

  constructor(getSettings: () => SplitterSettings, logger?: Logger | null) {
    this.#getSettings = getSettings;
    this.#logger = logger;
  }

  /** Whether there is a key to call with. Without one, splitting is skipped. */
  isConfigured() {
    return !!this.#getSettings().apiKey;
  }

  async split(segments: Segment[], words: Word[], signal?: AbortSignal): Promise<Segment[]> {
    if (segments.length === 0 || words.length === 0 || !this.isConfigured()) {
      return segments;
    }
    const { text: transcript, spans } = joinSegments(segments);
    const starts = alignWords(transcript, words);
    if (!starts) {
      // The words could not all be found in the transcript in order, so a
      // break offset cannot be turned into a time. Nothing here is safe.
      this.log('warn',
        'The timed words do not line up with the transcript, so the captions are ' +
        'left as the assembler cut them'
      );
      return segments;
    }

    const { maxCjk, maxLatin } = this.#getSettings();
    const chunks = this.#chunk(transcript, starts, words);
    const offsets: number[] = [];
    let failed = 0;

    for (const chunk of chunks) {
      if (signal?.aborted) {
        throw Error('Aborted');
      }
      const source = transcript.slice(chunk.from, chunk.to);
      try {
        const found = await this.#ask(source, maxCjk, maxLatin, signal);
        offsets.push(...found.map((offset) => offset + chunk.from));
      }
      catch (error) {
        if (signal?.aborted) {
          throw error;
        }
        failed++;
        this.log('warn',
          `Could not segment the stretch at ${chunk.from}-${chunk.to} ` +
          `(${error instanceof Error ? error.message : String(error)}); ` +
          'keeping the original captions for it'
        );
        // The boundaries the assembler drew inside this stretch, so the
        // fallback is the captions that were already there rather than one
        // caption several hundred words long.
        for (const span of spans) {
          if (span.to > chunk.from && span.to < chunk.to) {
            offsets.push(span.to);
          }
        }
      }
    }

    const result = toSegments(transcript, starts, words, offsets);
    this.log('info',
      `Segmented ${segments.length} captions into ${result.length} across ` +
      `${chunks.length} request(s)` +
      (failed > 0 ? `, ${failed} of which fell back to the original cut` : '')
    );
    return result.length > 0 ? result : segments;
  }

  /** Character ranges of about `MAX_CHUNK_WORDS` words each. */
  #chunk(transcript: string, starts: number[], words: Word[]) {
    const chunks: { from: number; to: number }[] = [];
    for (let i = 0; i < words.length; i += MAX_CHUNK_WORDS) {
      const next = i + MAX_CHUNK_WORDS;
      chunks.push({
        from: i === 0 ? 0 : starts[i],
        to: next < words.length ? starts[next] : transcript.length
      });
    }
    return chunks;
  }

  /**
   * One chunk, with the correction loop.
   *
   * An answer that changed the text is sent back with the position it changed
   * it at, which is the feedback that actually works: told only that it
   * altered something, a model tends to return the same answer again.
   *
   * A last answer that is intact but has captions over the length limit is
   * taken rather than thrown away. Long is a fault a reader forgives; a
   * rewritten transcript is not.
   */
  async #ask(
    source: string,
    maxCjk: number,
    maxLatin: number,
    signal?: AbortSignal
  ): Promise<number[]> {
    const contents: { role: string; parts: { text: string }[] }[] = [
      { role: 'user', parts: [ { text: `Segment this transcript:\n\n${source}` } ] }
    ];
    let intact: number[] | null = null;

    for (let step = 1; step <= MAX_STEPS; step++) {
      const answer = await this.#post(contents, maxCjk, maxLatin, signal);
      const found = locateBreaks(source, answer);

      if ('error' in found) {
        if (step === MAX_STEPS) {
          throw Error(found.error);
        }
        this.log('debug', `Segmentation attempt ${step} changed the text; asking again`);
        contents.push({ role: 'model', parts: [ { text: answer } ] });
        contents.push({ role: 'user', parts: [ { text:
          `${found.error}\nOutput the complete corrected text with all ${BREAK} tags.`
        } ] });
        continue;
      }

      intact = found.offsets;
      const over = tooLong(source, found.offsets, maxCjk, maxLatin);
      if (over.length === 0) {
        return found.offsets;
      }
      if (step === MAX_STEPS) {
        break;
      }
      this.log('debug', `Segmentation attempt ${step} left ${over.length} caption(s) too long`);
      contents.push({ role: 'model', parts: [ { text: answer } ] });
      contents.push({ role: 'user', parts: [ { text:
        `These captions are too long:\n${over.map((o) => `- ${o}`).join('\n')}\n` +
        `Split them further with ${BREAK}, then output the COMPLETE text with ` +
        'ALL captions, not only the ones you fixed.'
      } ] });
    }

    if (!intact) {
      throw Error('The model never returned the transcript unchanged');
    }
    return intact;
  }

  async #post(
    contents: { role: string; parts: { text: string }[] }[],
    maxCjk: number,
    maxLatin: number,
    signal?: AbortSignal
  ): Promise<string> {
    // Read per call: an administrator can change the key or model between one
    // chunk and the next.
    const { apiKey, model, baseUrl, proxyUrl, disableThinking } = this.#getSettings();
    if (!apiKey) {
      throw Error('No API key');
    }
    const system = SYSTEM_PROMPT
      .replace('${maxCjk}', String(maxCjk))
      .replace('${maxLatin}', String(maxLatin));

    const body = {
      systemInstruction: { parts: [ { text: system } ] },
      contents,
      generationConfig: {
        // Near zero: there is one right answer here, and the freedom that
        // helps a translation read well only invites a rewrite.
        temperature: 0.1,
        ...(disableThinking ? { thinkingConfig: { thinkingBudget: 0 } } : {})
      }
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    let response: Response;
    try {
      response = await fetch(
        `${baseUrl}/models/${encodeURIComponent(model.replace(/^models\//, ''))}:generateContent`,
        {
          method: 'POST',
          headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          dispatcher: this.#dispatcher(proxyUrl),
          signal: controller.signal
        }
      );
    }
    catch (error) {
      if (signal?.aborted) {
        throw Error('Aborted');
      }
      const cause = error instanceof Error && error.cause instanceof Error ?
        ` (${error.cause.message})`
        : '';
      throw Error(
        `Request failed${proxyUrl ? ` through ${proxyUrl}` : ''}: ` +
        `${error instanceof Error ? error.message : String(error)}${cause}`
      );
    }
    finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    const text = await response.text();
    if (!response.ok) {
      throw Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    }

    let json: GeminiResponse;
    try {
      json = JSON.parse(text);
    }
    catch {
      throw Error(`Response was not JSON: ${text.slice(0, 200)}`);
    }
    if (json.promptFeedback?.blockReason) {
      throw Error(`Refused (${json.promptFeedback.blockReason})`);
    }
    const candidate = json.candidates?.[0];
    const answer = (candidate?.content?.parts || []).map((p) => p.text || '').join('');
    if (!answer.trim()) {
      throw Error(`Nothing came back (${candidate?.finishReason || 'no candidates'})`);
    }
    return answer.trim().replace(/^```(?:\w+)?\s*/i, '').replace(/```\s*$/, '');
  }

  /**
   * The undici dispatcher for `proxyUrl`, or `undefined` to go direct. A bad
   * URL is reported and the call goes direct, which produces the clearer of
   * the two errors.
   */
  #dispatcher(proxyUrl: string | null) {
    if (!proxyUrl) {
      return undefined;
    }
    try {
      return createProxyAgentFor({ url: proxyUrl })?.agent;
    }
    catch (error) {
      this.log('warn', `Ignoring the segmentation proxy "${proxyUrl}":`, error);
      return undefined;
    }
  }

  protected log(level: LogLevel, ...msg: any[]) {
    commonLog(this.#logger, level, this.name, ...msg);
  }
}
