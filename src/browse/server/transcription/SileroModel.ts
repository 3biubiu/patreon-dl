import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { commonLog } from '../../../utils/logging/Logger.js';
import { type Logger } from '../../../utils/logging/index.js';

/**
 * Pinned to a tag rather than a branch. The file at `master` happens to match
 * this one today, but it is a moving target - `v6.0` already carries different
 * weights - and a voice detector that silently changes behaviour between
 * deployments is not something to leave to chance.
 */
const MODEL_URL =
  'https://raw.githubusercontent.com/snakers4/silero-vad/v6.2.1/src/silero_vad/data/silero_vad.onnx';
const MODEL_SHA256 = '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3';
const MODEL_BYTES = 2327524;
/** Well above the real size, and only there to stop a redirect to something huge. */
const MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024;

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
 * anything. Nothing is lost by fetching it: transcription already needs the
 * network to reach OpenRouter at all.
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

async function download(filePath: string, logger?: Logger | null, signal?: AbortSignal) {
  commonLog(logger, 'info', 'Transcription',
    `Speech detection model not found, downloading it to "${filePath}" (${(MODEL_BYTES / 1048576).toFixed(1)} MB)`);

  let response: Response;
  try {
    response = await fetch(MODEL_URL, { signal });
  }
  catch (error) {
    throw Error(
      `Could not download the speech detection model: ` +
      `${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!response.ok) {
    throw Error(`Could not download the speech detection model: HTTP ${response.status}`);
  }

  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > MAX_DOWNLOAD_BYTES) {
    throw Error('The downloaded speech detection model was implausibly large; refusing it');
  }
  const digest = sha256(body);
  if (digest !== MODEL_SHA256) {
    // Refuse rather than run: whatever this is, it is not the model these
    // detection settings were chosen against.
    throw Error(
      `The downloaded speech detection model did not match its expected checksum ` +
      `(got ${digest.slice(0, 16)}…, expected ${MODEL_SHA256.slice(0, 16)}…). ` +
      `Nothing was written. Place a trusted silero_vad.onnx at "${filePath}" instead.`
    );
  }

  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  // Written beside the target and renamed, so a download cut off part way
  // cannot leave a truncated file that later looks present and valid.
  const tmpFilePath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpFilePath, body);
  fs.renameSync(tmpFilePath, filePath);
  commonLog(logger, 'info', 'Transcription', 'Speech detection model ready');
}

export { MODEL_URL, MODEL_SHA256 };
