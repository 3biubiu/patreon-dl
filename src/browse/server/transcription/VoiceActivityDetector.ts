import { commonLog, type LogLevel } from '../../../utils/logging/Logger.js';
import type Logger from '../../../utils/logging/Logger.js';
import AudioExtractor, { SAMPLE_RATE } from './AudioExtractor.js';
import { ensureSileroModel } from './SileroModel.js';

/** A stretch of the source file that contains speech, in seconds. */
export interface SpeechInterval {
  start: number;
  end: number;
}

export interface VADOptions {
  /** Speech probability above which a frame counts as speech. */
  threshold?: number;
  /** Silence shorter than this does not end a speech run, in seconds. */
  minSilenceDuration?: number;
  /** Speech shorter than this is discarded, in seconds. */
  minSpeechDuration?: number;
  /** Longest run Silero will report before forcing a break, in seconds. */
  maxSpeechDuration?: number;
  /**
   * Each interval is widened by this much at both ends, in seconds.
   *
   * Silero reports where speech is confidently present, which clips the onset
   * of the first word and the tail of the last. Whisper needs those back.
   * (Silero's own Python wrapper does this as `speech_pad_ms`; sherpa-onnx
   * does not expose it, so it is applied here.)
   */
  speechPad?: number;
  /**
   * Intervals closer together than this are merged, in seconds.
   *
   * Silero's raw output pauses at every breath - 293 intervals for a
   * 54-minute video. Each interval becomes one upload, so they are merged
   * until only the long silences remain as boundaries. Those long silences
   * are also where Whisper invents captions, which is the point of the
   * exercise.
   */
  mergeGap?: number;
}

const DEFAULTS: Required<VADOptions> = {
  // The first four mirror the settings of the Python service this was
  // modelled on, which has run against this content for a long time.
  threshold: 0.5,
  minSilenceDuration: 0.5,
  minSpeechDuration: 0.25,
  maxSpeechDuration: 30,
  speechPad: 0.3,
  mergeGap: 30
};

/** Silero's frame size at 16 kHz. Not a free parameter. */
const WINDOW_SIZE = 512;
/** Ceiling for sherpa-onnx's internal buffer; must exceed maxSpeechDuration. */
const BUFFER_SECONDS = 90;

/**
 * Finds the parts of a video that contain speech, so that the silence in
 * between is never uploaded for transcription.
 *
 * Whisper fills silence with invented captions - "Thank you." stretched over
 * thirty seconds, or a description of the background music - and the video
 * this was built against is only 35% speech. Cutting the silence out removes
 * the input those captions are made from.
 *
 * Detection runs through sherpa-onnx rather than a hand-written port of
 * Silero's frame loop: the awkward parts (rolling model state, the hysteresis
 * around the threshold) are where a reimplementation quietly goes wrong, and a
 * detector that silently drops real speech is much worse than one that lets a
 * stray caption through.
 */
export default class VoiceActivityDetector {
  name = 'VoiceActivityDetector';

  #modelPath: string;
  #extractor: AudioExtractor;
  #logger?: Logger | null;

  constructor(modelPath: string, extractor: AudioExtractor, logger?: Logger | null) {
    this.#modelPath = modelPath;
    this.#extractor = extractor;
    this.#logger = logger;
  }

  /**
   * Why the detector cannot run, or `null` when it can.
   *
   * Deliberately cheap: this answers a status endpoint that the browser calls
   * on load, so it checks only what is already here. A missing model is not
   * reported - it is fetched when a job runs - because downloading it from
   * inside a status check would stall the page.
   */
  async getUnavailableReason(): Promise<string | null> {
    try {
      await this.#loadModule();
    }
    catch {
      return 'The "sherpa-onnx-node" package is not installed, so speech detection is ' +
        'unavailable. Install it with "npm install sherpa-onnx-node". Note that its ' +
        'binary is platform-specific: a node_modules copied from another OS will not work.';
    }
    return null;
  }

  /**
   * Returns the speech intervals of `videoPath`, padded and merged.
   *
   * `onProgress` reports how much of the file has been scanned, 0 to 1.
   */
  async detect(
    videoPath: string,
    options?: VADOptions,
    onProgress?: (fraction: number) => void,
    signal?: AbortSignal
  ): Promise<SpeechInterval[]> {
    const opts = { ...DEFAULTS, ...options };
    const { Vad } = await this.#loadModule();
    // First run fetches the model; afterwards this is one `existsSync`.
    await ensureSileroModel(this.#modelPath, this.#logger, signal);
    const duration = await this.#extractor.probeDuration(videoPath);

    const vad = new Vad({
      sileroVad: {
        model: this.#modelPath,
        threshold: opts.threshold,
        minSilenceDuration: opts.minSilenceDuration,
        minSpeechDuration: opts.minSpeechDuration,
        windowSize: WINDOW_SIZE,
        maxSpeechDuration: opts.maxSpeechDuration
      },
      sampleRate: SAMPLE_RATE,
      numThreads: 1,
      provider: 'cpu',
      debug: false
    }, BUFFER_SECONDS);

    const raw: SpeechInterval[] = [];
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
    const started = Date.now();
    const samples = await this.#extractor.streamPCM(
      videoPath,
      WINDOW_SIZE,
      (frame, offsetSamples) => {
        vad.acceptWaveform(frame);
        drain();
        if (onProgress && duration) {
          // Whole percents only: this fires ~100 times a second otherwise.
          const percent = Math.floor((offsetSamples / SAMPLE_RATE / duration) * 100);
          if (percent > reported) {
            reported = percent;
            onProgress(Math.min(1, percent / 100));
          }
        }
      },
      signal
    );
    vad.flush();
    drain();

    const scanned = samples / SAMPLE_RATE;
    const intervals = this.#mergeAndPad(raw, scanned, opts);
    const speech = intervals.reduce((total, i) => total + (i.end - i.start), 0);
    this.log('debug',
      `VAD on "${videoPath}": ${raw.length} raw -> ${intervals.length} intervals, ` +
      `${speech.toFixed(0)}s of ${scanned.toFixed(0)}s speech ` +
      `(${((speech / (scanned || 1)) * 100).toFixed(0)}%) in ${((Date.now() - started) / 1000).toFixed(1)}s`
    );
    return intervals;
  }

  /**
   * Pads each interval, then merges any that end up within `mergeGap` of one
   * another. Padding first means two intervals separated by less than twice
   * the padding are joined rather than left overlapping.
   */
  #mergeAndPad(raw: SpeechInterval[], duration: number, opts: Required<VADOptions>) {
    const limit = duration || Number.POSITIVE_INFINITY;
    const padded = raw
      .map(({ start, end }) => ({
        start: Math.max(0, start - opts.speechPad),
        end: Math.min(limit, end + opts.speechPad)
      }))
      .filter((i) => i.end > i.start)
      .sort((a, b) => a.start - b.start);

    const merged: SpeechInterval[] = [];
    for (const interval of padded) {
      const last = merged[merged.length - 1];
      if (last && interval.start - last.end <= opts.mergeGap) {
        last.end = Math.max(last.end, interval.end);
      }
      else {
        merged.push({ ...interval });
      }
    }
    return merged;
  }

  async #loadModule() {
    // Imported lazily so that the platform-specific binary is only required
    // when transcription is actually used - the rest of the server has to keep
    // working without it, including on a machine where it was never installed.
    const mod = await import('sherpa-onnx-node');
    // The package is CommonJS, and Node's named-export detection does not see
    // past its re-exports, so everything arrives under `default`.
    return mod.default;
  }

  protected log(level: LogLevel, ...msg: any[]) {
    commonLog(this.#logger, level, this.name, ...msg);
  }
}
