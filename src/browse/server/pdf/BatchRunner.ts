import { commonLog } from '../../../utils/logging/Logger.js';

/**
 * The part of translating a page that has nothing to do with which service is
 * doing it: cutting the blocks into requests, retrying the failures worth
 * retrying, staying inside a time budget, and giving back whatever did arrive.
 *
 * Both engines are driven through here so that switching between them changes
 * where the text goes and nothing else - the same chunk sizes, the same
 * patience, the same behaviour when half a page fails.
 */

/**
 * Requests are cut by both count and total length, so one long block cannot
 * make an oversized body. Forty is also DeepL's documented ceiling for texts
 * in one call, and well inside what the Google endpoint accepts.
 */
const MAX_CHARS_PER_REQUEST = 3000;
const MAX_BLOCKS_PER_REQUEST = 40;

/** Long enough for a slow proxy, short enough not to hold a request open. */
const REQUEST_TIMEOUT_MS = 8_000;

/**
 * The whole of what one request may take, retries and all.
 *
 * There is usually a reverse proxy in front of this, and its patience is the
 * real limit: answer later than that and the reader gets the gateway's own
 * error page instead of anything this server said. The reader already asks for
 * a dozen blocks at a time so that a request is normally a second or two; this
 * is the ceiling for when it is not. When it runs out, whatever has been
 * translated is returned and the rest comes back as failures, which the reader
 * knows how to show.
 */
const PAGE_BUDGET_MS = 10_000;

/**
 * Attempts per chunk, for the failures a second attempt could survive: a
 * refused connection is not one of those, nor is a rejected key, but rate
 * limiting is, and so is a transient 5xx.
 */
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [ 600, 1800 ];
/** A breath between chunks, so a long page does not read as a flood. */
const CHUNK_GAP_MS = 120;

export class TranslationCancelledError extends Error {
  constructor() {
    super('Translation was cancelled');
    this.name = 'TranslationCancelledError';
  }
}

export interface TranslateResult {
  /** One per input, in order. `null` where nothing came back. */
  translations: (string | null)[];
  /** How many inputs came back with nothing. */
  failed: number;
  /** Why, when something did fail. Already readable. */
  error: string | null;
}

/** What every PDF translation engine looks like from the outside. */
export interface PdfTranslator {
  readonly name: string;
  readonly targetLanguage: string;
  translate(texts: string[], to?: string, signal?: AbortSignal): Promise<TranslateResult>;
}

export interface Failure {
  message: string;
  /** True for the kind of failure that a second attempt could survive. */
  retryable: boolean;
}

/**
 * What actually went wrong.
 *
 * undici reports every transport failure as "fetch failed" and puts the reason
 * - a refused connection, an unresolved host - in `cause`. That is walked here,
 * because "fetch failed" on its own has sent more than one person looking in
 * the wrong place.
 */
export function describeFailure(error: unknown, statusIsRetryable?: (status: number) => boolean): Failure {
  let status: number | null = null;
  let code: string | null = null;
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const err = current as {
      message?: string; code?: string; cause?: unknown;
      status?: number; response?: { status?: number };
    };
    if (err.message && !messages.includes(err.message)) {
      messages.push(err.message);
    }
    if (typeof err.code === 'string') {
      code = err.code;
    }
    const responseStatus = err.status ?? err.response?.status;
    if (typeof responseStatus === 'number') {
      status = responseStatus;
    }
    current = err.cause;
  }
  const message = [ messages.join(' - '), code, status ? `HTTP ${status}` : null ]
    .filter(Boolean).join(' ') || 'Unknown error';
  // A refused or unreachable host fails the same way every time; asking again
  // only makes the reader wait longer for the same answer.
  const hopeless = [ 'ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ERR_PROXY_CONNECTION_FAILED' ];
  if (code && hopeless.includes(code)) {
    return { message, retryable: false };
  }
  if (status !== null) {
    const retryable = statusIsRetryable ?
      statusIsRetryable(status) : (status === 429 || status >= 500);
    return { message, retryable };
  }
  return { message, retryable: true };
}

export function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new TranslationCancelledError());
    }, { once: true });
  });
}

function chunk(texts: { i: number; t: string }[]) {
  const result: { i: number; t: string }[][] = [];
  let current: { i: number; t: string }[] = [];
  let chars = 0;
  for (const entry of texts) {
    if (current.length > 0 &&
      (current.length >= MAX_BLOCKS_PER_REQUEST || chars + entry.t.length > MAX_CHARS_PER_REQUEST)) {
      result.push(current);
      current = [];
      chars = 0;
    }
    current.push(entry);
    chars += entry.t.length;
  }
  if (current.length > 0) {
    result.push(current);
  }
  return result;
}

export interface RunBatchesOptions {
  texts: string[];
  /**
   * Sends one chunk and returns one entry per input, `null` where the service
   * gave nothing back. Anything thrown is passed through `describeFailure`.
   */
  send: (batch: string[], signal: AbortSignal) => Promise<(string | null)[]>;
  /** Names the service in an error message, e.g. "DeepL through http://...". */
  describeEngine: string;
  /** Decides which HTTP statuses are worth a second attempt, if not the default. */
  statusIsRetryable?: (status: number) => boolean;
  logName: string;
  logger?: Parameters<typeof commonLog>[0];
  signal?: AbortSignal;
}

export async function runBatches(options: RunBatchesOptions): Promise<TranslateResult> {
  const { texts, send, describeEngine, statusIsRetryable, logName, logger, signal } = options;
  const log = (level: Parameters<typeof commonLog>[1], ...msg: any[]) =>
    commonLog(logger, level, logName, ...msg);

  const translations: (string | null)[] = texts.map(() => null);
  const pending = texts
    .map((t, i) => ({ i, t }))
    .filter((entry) => entry.t.trim().length > 0);
  if (pending.length === 0) {
    return { translations, failed: 0, error: null };
  }

  const batches = chunk(pending);
  const deadline = Date.now() + PAGE_BUDGET_MS;
  let failed = 0;
  let error: string | null = null;

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    if (signal?.aborted) {
      throw new TranslationCancelledError();
    }
    const batch = batches[batchIndex];
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      // Out of time. The rest of the page is reported as failed rather than
      // kept waiting on, so the answer arrives before the gateway gives up.
      failed += batch.length;
      error = error || 'Translation took too long and was cut short';
      log('warn', `Ran out of time with ${batches.length - batchIndex} chunk(s) to go`);
      continue;
    }
    if (batchIndex > 0) {
      await delay(Math.min(CHUNK_GAP_MS, remaining), signal);
    }
    let sent: (string | null)[] | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Its own timeout, so one wedged batch does not spend the whole budget,
      // and still cancelled by the caller's signal.
      const timeout = AbortSignal.timeout(
        Math.max(1000, Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()))
      );
      const batchSignal = signal ? AbortSignal.any([ signal, timeout ]) : timeout;
      try {
        sent = await send(batch.map((entry) => entry.t), batchSignal);
        break;
      }
      catch (thrown) {
        if (signal?.aborted) {
          throw new TranslationCancelledError();
        }
        const failure = describeFailure(thrown, statusIsRetryable);
        error = `Could not reach ${describeEngine}: ${failure.message}`;
        const backoff = RETRY_BACKOFF_MS[attempt - 1] ?? RETRY_BACKOFF_MS.at(-1)!;
        // No point starting an attempt there is no time left to finish.
        const outOfTime = Date.now() + backoff >= deadline;
        if (!failure.retryable || attempt === MAX_ATTEMPTS || outOfTime) {
          log('warn', `Giving up on a batch after ${attempt} attempt(s): ${failure.message}`);
          break;
        }
        log('debug', `Retrying a batch (attempt ${attempt} of ${MAX_ATTEMPTS}): ${failure.message}`);
        await delay(backoff, signal);
      }
    }

    // One chunk failing is not the page failing. What did come back is kept
    // and returned, and the caller stores it - so a retry of the same page
    // only asks for the part that is still missing.
    if (!sent) {
      failed += batch.length;
      continue;
    }
    sent.forEach((text, index) => {
      if (typeof text === 'string' && text.length > 0) {
        translations[batch[index].i] = text;
      }
      else {
        failed++;
      }
    });
  }
  return { translations, failed, error };
}
