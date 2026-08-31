/**
 * Cleans up the transcript with a language model, after the captions are cut
 * and before the subtitle is written.
 *
 * Transcription is where most of what is wrong with a subtitle comes from -
 * misrecognised words, filler syllables, a proper noun the model had never
 * heard of - and none of it is fixable by cutting differently. This asks a
 * model to repair the text of each caption in place: fix the recognition
 * errors, drop the "um" and "呃", put the punctuation back, and pull stray
 * terms towards the domain vocabulary the transcription itself was steered
 * with.
 *
 * The timings are never at risk here, structurally: a caption goes in as one
 * numbered line and comes back as one numbered line, and the times are kept
 * from the input whatever the text does. A line the model rewrote beyond
 * recognition is kept as it was, because a caption that says something else
 * in the right place is worse than one with a typo in it. A batch that
 * cannot be repaired at all leaves its lines untouched - the transcription
 * is already paid for, and this pass only ever improves on it.
 */

import { fetch, type Response } from 'undici';
import { commonLog, type LogLevel } from '../../../utils/logging/Logger.js';
import type Logger from '../../../utils/logging/Logger.js';
import { createProxyAgentFor } from '../../../utils/Proxy.js';
import { type Segment } from './SubtitleBuilder.js';

export interface PolisherSettings {
  apiKey: string | null;
  model: string;
  /** Includes the API version, as the translator's does. */
  baseUrl: string;
  /** `null` sends the request directly, which is what an empty setting means. */
  proxyUrl: string | null;
  disableThinking: boolean;
}

/**
 * Lines per request. An hour of speech is about seven hundred captions once
 * cut, so this is six calls where the translation's batching would be five -
 * close enough that the two features cost about the same to run.
 */
const MAX_BATCH_LINES = 120;
/** The first answer plus two corrections. */
const MAX_STEPS = 3;
const REQUEST_TIMEOUT_MS = 180_000;

/**
 * Below this similarity a line comes back as it went in. Meant to catch a
 * rewrite - the model answering the prompt with something entirely its own -
 * while leaving ordinary corrections, which touch a word or two of a dozen,
 * far above it. Bigrams rather than characters compared in order, so a small
 * insertion or deletion in the middle does not read as a rewrite of
 * everything after it.
 */
const MIN_LINE_SIMILARITY = 0.5;

const SYSTEM_PROMPT = [
  'You are a subtitle correction expert. You are given numbered subtitle',
  'lines from a speech transcript. Repair each line while preserving its',
  'meaning, length and language.',
  '',
  'Rules:',
  '1. Fix misrecognised words and typos, using the reference terminology',
  '   where any is given and the context of the surrounding lines otherwise.',
  '2. Remove filler syllables and non-verbal sounds: um, uh, er, ah, 呃, 嗯,',
  '   嗯啊, *laughs*, (applause) and the like. Never remove real words.',
  '3. Repair punctuation and capitalisation: sentence-final punctuation where',
  '   a line clearly ends one, commas where a reader would pause, English',
  '   sentences capitalised, formulas in plain text (×, ÷, =, ²).',
  '4. One input line becomes one output line under the same key. Never merge,',
  '   split, reorder, translate or paraphrase lines.',
  '5. Keep the original language: Chinese stays Chinese, English stays',
  '   English.',
  '6. A line that needs no correction comes back unchanged, exactly as given.',
  '',
  'Output a JSON object mapping every input key to its corrected text, and',
  'nothing else - no explanation, no markdown fences.'
].join('\n');

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
}

/**
 * Bigram Dice similarity of two strings, 0 to 1. Case-sensitive on purpose:
 * a capitalisation fix is a small edit, and it should not be counted as half
 * the line changing.
 */
export function similarity(a: string, b: string) {
  const cleaned = (s: string) => s.replace(/\s+/g, ' ').trim();
  const left = cleaned(a);
  const right = cleaned(b);
  if (left === right) {
    return 1;
  }
  if (left.length < 2 || right.length < 2) {
    return left === right ? 1 : 0;
  }
  const grams = (s: string) => {
    const map = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const gram = s.slice(i, i + 2);
      map.set(gram, (map.get(gram) || 0) + 1);
    }
    return map;
  };
  const leftGrams = grams(left);
  const rightGrams = grams(right);
  let shared = 0;
  for (const [ gram, count ] of leftGrams) {
    shared += Math.min(count, rightGrams.get(gram) || 0);
  }
  return (2 * shared) / (left.length - 1 + right.length - 1);
}

/**
 * Parses the model's answer as a batch of numbered lines.
 *
 * Anything but an object whose keys are exactly the ones sent - same set, no
 * more, no fewer - is an error, with a message naming what is wrong: that is
 * the feedback a correction round-trip can actually use.
 */
export function parseBatch(
  answer: string,
  keys: string[]
): { lines: Map<string, string> } | { error: string } {
  let json: unknown;
  try {
    json = JSON.parse(answer);
  }
  catch {
    return { error: 'That was not JSON. Output a JSON object and nothing else.' };
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { error: 'That was not a JSON object. Output an object mapping keys to corrected lines.' };
  }
  const entries = Object.entries(json as Record<string, unknown>);
  const lines = new Map<string, string>();
  for (const [ key, value ] of entries) {
    if (typeof value !== 'string') {
      return { error: `The value for key "${key}" was not a string.` };
    }
    lines.set(key, value);
  }
  const missing = keys.filter((key) => !lines.has(key));
  if (missing.length > 0) {
    return {
      error: `These keys are missing from the answer: ${missing.join(', ')}. ` +
        'Return every line, including the ones that need no correction.'
    };
  }
  const extra = [ ...lines.keys() ].filter((key) => !keys.includes(key));
  if (extra.length > 0) {
    return {
      error: `These keys were not sent but appeared in the answer: ${extra.join(', ')}. ` +
        'Return exactly the keys you were given.'
    };
  }
  return { lines };
}

/**
 * Polishes caption text with a language model, keeping every timing.
 */
export default class SubtitlePolisher {
  name = 'SubtitlePolisher';

  #getSettings: () => PolisherSettings;
  #logger?: Logger | null;

  constructor(getSettings: () => PolisherSettings, logger?: Logger | null) {
    this.#getSettings = getSettings;
    this.#logger = logger;
  }

  /** Whether there is a key to call with. Without one, polishing is skipped. */
  isConfigured() {
    return !!this.#getSettings().apiKey;
  }

  /**
   * Rewrites the text of `segments`, leaving every start and end alone.
   *
   * `terms` is the domain vocabulary - the same list the Gemini transcriber
   * is steered with - offered to the model as reference, where it can still
   * fix what biasing during the transcription itself could not.
   */
  async polish(
    segments: Segment[],
    terms: string[],
    signal?: AbortSignal
  ): Promise<Segment[]> {
    if (segments.length === 0 || !this.isConfigured()) {
      return segments;
    }

    const reference = terms.length > 0
      ? `\n\nReference terminology:\n<reference>${terms.slice(0, 100).join(', ')}</reference>`
      : '';

    let repaired = 0;
    let kept = 0;
    const texts: string[] = segments.map((segment) => segment.text);

    for (const batch of this.#batches(segments)) {
      if (signal?.aborted) {
        throw Error('Aborted');
      }
      const result = await this.#polishBatch(batch, reference, signal);
      for (let i = batch.from; i < batch.to; i++) {
        const text = result.get(String(i - batch.from));
        if (text !== undefined && text.trim() && text !== texts[i]) {
          texts[i] = text.trim();
          repaired++;
        }
        else {
          kept++;
        }
      }
    }

    this.log('info',
      `Polished ${segments.length} captions: ${repaired} changed, ${kept} kept as they were`
    );
    return segments.map((segment, i) => ({ ...segment, text: texts[i] }));
  }

  /** Index ranges of at most `MAX_BATCH_LINES` captions each. */
  #batches(segments: Segment[]) {
    const batches: { from: number; to: number; lines: string[] }[] = [];
    for (let i = 0; i < segments.length; i += MAX_BATCH_LINES) {
      const to = Math.min(i + MAX_BATCH_LINES, segments.length);
      batches.push({ from: i, to, lines: segments.slice(i, to).map((s) => s.text) });
    }
    return batches;
  }

  /**
   * One batch, with the correction loop.
   *
   * A failure at any step costs only the correction it was worth: the last
   * parseable answer is used line by line, and a line the model rewrote past
   * the similarity floor is kept as it was rather than trusted.
   */
  async #polishBatch(
    batch: { from: number; to: number; lines: string[] },
    reference: string,
    signal?: AbortSignal
  ): Promise<Map<string, string>> {
    const input: Record<string, string> = {};
    batch.lines.forEach((line, i) => {
      input[String(i)] = line;
    });

    const contents: { role: string; parts: { text: string }[] }[] = [
      { role: 'user', parts: [ { text: `Correct these subtitle lines:\n${JSON.stringify(input)}${reference}` } ] }
    ];
    let accepted: Map<string, string> | null = null;

    for (let step = 1; step <= MAX_STEPS; step++) {
      const answer = await this.#post(contents, signal);
      const parsed = parseBatch(answer, Object.keys(input));

      if ('error' in parsed) {
        if (step === MAX_STEPS) {
          break;
        }
        this.log('debug', `Polishing attempt ${step} came back malformed; asking again`);
        contents.push({ role: 'model', parts: [ { text: answer } ] });
        contents.push({ role: 'user', parts: [ { text:
          `${parsed.error}\nOutput the complete corrected JSON object.`
        } ] });
        continue;
      }

      // The similarity floor, applied per line: an over-rewritten line is
      // dropped to its original rather than failing the batch, because the
      // others around it are usually fine.
      const lines = new Map<string, string>();
      let overreach = 0;
      for (const [ key, text ] of parsed.lines) {
        if (similarity(input[key], text) >= MIN_LINE_SIMILARITY) {
          lines.set(key, text);
        }
        else {
          overreach++;
        }
      }
      accepted = lines;
      if (overreach === 0 || step === MAX_STEPS) {
        break;
      }
      this.log('debug', `Polishing attempt ${step} rewrote ${overreach} line(s) past the limit`);
      contents.push({ role: 'model', parts: [ { text: answer } ] });
      contents.push({ role: 'user', parts: [ { text:
        `${overreach} line(s) were rewritten too heavily - repair the words, do not ` +
        'rephrase. Output the complete corrected JSON object.'
      } ] });
    }

    return accepted || new Map();
  }

  async #post(
    contents: { role: string; parts: { text: string }[] }[],
    signal?: AbortSignal
  ): Promise<string> {
    // Read per call: an administrator can change the key or model between one
    // batch and the next.
    const { apiKey, model, baseUrl, proxyUrl, disableThinking } = this.#getSettings();
    if (!apiKey) {
      throw Error('No API key');
    }

    const body = {
      systemInstruction: { parts: [ { text: SYSTEM_PROMPT } ] },
      contents,
      generationConfig: {
        // Low, for the same reason the splitter's is: the freedom that helps
        // a translation read well only invites rewrites here.
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
      this.log('warn', `Ignoring the polishing proxy "${proxyUrl}":`, error);
      return undefined;
    }
  }

  protected log(level: LogLevel, ...msg: any[]) {
    commonLog(this.#logger, level, this.name, ...msg);
  }
}
