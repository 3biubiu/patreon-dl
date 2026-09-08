/**
 * Where speech detection actually runs.
 *
 * `sherpa-onnx-node`'s `acceptWaveform` is a synchronous native call, and it
 * is made once per 512 samples - about thirty times per second of audio, a
 * hundred thousand times for an hour-long video. On the main thread those
 * calls arrive back to back for as long as ffmpeg can decode (which is far
 * faster than realtime), and nothing else in the process gets a turn: every
 * page load, API call and video byte range waits behind them. That is what
 * made the site unusable while anything was being transcribed.
 *
 * So the whole loop lives here instead. The thread this blocks is one whose
 * only job is to be blocked; the event loop that answers requests is left
 * alone. Nothing about the detection itself changes - the same model, the same
 * frames, the same order - and the merging and padding of what comes out stays
 * with the caller, which is where the tuning lives.
 */

import { parentPort, workerData } from 'worker_threads';
import AudioExtractor, { SAMPLE_RATE } from './AudioExtractor.js';

/** What the caller hands over. See `VoiceActivityDetector.detect`. */
export interface VADWorkerInput {
  videoPath: string;
  ffmpegPath: string | null;
  modelPath: string;
  windowSize: number;
  bufferSeconds: number;
  threshold: number;
  minSilenceDuration: number;
  minSpeechDuration: number;
  maxSpeechDuration: number;
}

/** A stretch of the file, in seconds - the shape `TimeRange` has. */
interface RawRange {
  start: number;
  end: number;
}

export type VADWorkerMessage =
  { type: 'progress'; fraction: number } |
  { type: 'done'; raw: RawRange[]; samples: number } |
  { type: 'error'; message: string };

const input = workerData as VADWorkerInput;
const port = parentPort;

if (!port) {
  throw Error('VADWorker must be run as a worker thread');
}

/**
 * Cancellation. The parent asks rather than terminating, because terminating a
 * worker leaves its ffmpeg child running - aborting from inside is what kills
 * it. The parent terminates only if this does not take.
 */
const controller = new AbortController();
port.on('message', (message: { type?: string }) => {
  if (message?.type === 'abort') {
    controller.abort();
  }
});

async function run() {
  // Imported here rather than at the top so the platform-specific binary is
  // only required in the thread that uses it - and so a machine without it
  // fails with the same message it always did, on the first job rather than at
  // startup.
  const { Vad } = (await import('sherpa-onnx-node')).default;
  const extractor = new AudioExtractor(input.ffmpegPath, null);
  const duration = await extractor.probeDuration(input.videoPath);

  const vad = new Vad({
    sileroVad: {
      model: input.modelPath,
      threshold: input.threshold,
      minSilenceDuration: input.minSilenceDuration,
      minSpeechDuration: input.minSpeechDuration,
      windowSize: input.windowSize,
      maxSpeechDuration: input.maxSpeechDuration
    },
    sampleRate: SAMPLE_RATE,
    numThreads: 1,
    provider: 'cpu',
    debug: false
  }, input.bufferSeconds);

  const raw: RawRange[] = [];
  const drain = () => {
    while (!vad.isEmpty()) {
      const segment = vad.front();
      raw.push({
        start: segment.start / SAMPLE_RATE,
        end: (segment.start + segment.samples.length) / SAMPLE_RATE
      });
      vad.pop();
    }
  };

  let reported = -1;
  const samples = await extractor.streamPCM(
    input.videoPath,
    input.windowSize,
    (frame, offsetSamples) => {
      vad.acceptWaveform(frame);
      drain();
      if (duration) {
        // Whole percents only: this fires ~100 times a second otherwise, and
        // each one is now a message across a thread boundary.
        const percent = Math.floor((offsetSamples / SAMPLE_RATE / duration) * 100);
        if (percent > reported) {
          reported = percent;
          post({ type: 'progress', fraction: Math.min(1, percent / 100) });
        }
      }
    },
    controller.signal
  );
  vad.flush();
  drain();

  post({ type: 'done', raw, samples });
}

function post(message: VADWorkerMessage) {
  port?.postMessage(message);
}

run().catch((error: unknown) => {
  post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
});
