import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { commonLog } from '../../../utils/logging/Logger.js';
import { type Logger } from '../../../utils/logging/index.js';

/**
 * Where the model is fetched from, in order.
 *
 * Pinned to a tag rather than a branch: the file at `master` happens to match
 * this one today, but it is a moving target - `v6.0` already carries different
 * weights - and a voice detector that silently changes behaviour between
 * deployments is not something to leave to chance.
 *
 * jsDelivr comes first because raw.githubusercontent.com is unreliable from
 * some networks, which is exactly where this used to fail.
 */
const MODEL_SOURCES = [
  'https://cdn.jsdelivr.net/gh/snakers4/silero-vad@v6.2.1/src/silero_vad/data/silero_vad.onnx',
  'https://raw.githubusercontent.com/snakers4/silero-vad/v6.2.1/src/silero_vad/data/silero_vad.onnx'
];
const MODEL_SHA256 = '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3';
const MODEL_BYTES = 2327524;
/** Well above the real size, and only there to stop a redirect to something huge. */
const MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024;
/** A stalled connection should move on to the next source, not hang the job. */
const SOURCE_TIMEOUT_MS = 60_000;

/** Shared so two callers arriving together fetch once, not twice. */
let inFlight: Promise<void> | null = null;

function sha256(buffer: Buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Makes sure the Silero model is on disk, fetching it once if it is not.
 *
 * An existing file is left alone and never checked against the pinned hash:
 * putting a different model there is a legitimate thing to do, and second
 * guessing it would take that away. The hash is enforced on what gets
 * downloaded, which is the part nobody chose.
 *
 * Downloading rather than shipping the file keeps it out of the published
 * package, where it would be dead weight for everyone who never transcribes
 * anything - but a download can fail, so the error says exactly how to supply
 * the file by hand instead.
 */
export async function ensureSileroModel(
  filePath: string,
  logger?: Logger | null,
  signal?: AbortSignal
): Promise<void> {
  if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
    return;
  }
  if (inFlight) {
    return inFlight;
  }
  inFlight = download(filePath, logger, signal).finally(() => { inFlight = null; });
  return inFlight;
}

/** Fetches and verifies one source, or throws with why it did not work. */
async function fetchFrom(url: string, signal?: AbortSignal): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw Error(`HTTP ${response.status}`);
    }
    // Inside the same try as the request: a connection dropped part way
    // through the body fails here, not at the fetch, and undici reports that
    // as a bare "terminated" with nothing to say where it came from.
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > MAX_DOWNLOAD_BYTES) {
      throw Error('the response was implausibly large');
    }
    const digest = sha256(body);
    if (digest !== MODEL_SHA256) {
      throw Error(`checksum mismatch (got ${digest.slice(0, 16)}…)`);
    }
    return body;
  }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function download(filePath: string, logger?: Logger | null, signal?: AbortSignal) {
  commonLog(logger, 'info', 'Transcription',
    `Speech detection model not found, downloading it to "${filePath}" ` +
    `(${(MODEL_BYTES / 1048576).toFixed(1)} MB)`);

  const failures: string[] = [];
  for (const url of MODEL_SOURCES) {
    if (signal?.aborted) {
      throw Error('Aborted');
    }
    try {
      const body = await fetchFrom(url, signal);
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      // Written beside the target and renamed, so a download cut off part way
      // cannot leave a truncated file that later looks present and valid.
      const tmpFilePath = `${filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpFilePath, body);
      fs.renameSync(tmpFilePath, filePath);
      commonLog(logger, 'info', 'Transcription', 'Speech detection model ready');
      return;
    }
    catch (error) {
      if (signal?.aborted) {
        throw Error('Aborted');
      }
      const reason = error instanceof Error ? error.message : String(error);
      failures.push(`${new URL(url).host}: ${reason}`);
      commonLog(logger, 'debug', 'Transcription', `Model source failed - ${reason}`);
    }
  }

  throw Error(
    `Could not download the speech detection model (${failures.join('; ')}). ` +
    `Copy silero_vad.onnx to "${filePath}" instead - it ships with the Python ` +
    `"silero-vad" package, or can be downloaded on another machine from ` +
    MODEL_SOURCES[0]
  );
}

export { MODEL_SOURCES, MODEL_SHA256 };
