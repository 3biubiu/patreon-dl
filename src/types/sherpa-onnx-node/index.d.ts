/**
 * sherpa-onnx-node ships JSDoc typedefs but no declaration file. Only the
 * voice activity detection surface is declared here - the package also covers
 * recognition, synthesis and diarization, none of which is used.
 *
 * Durations are in seconds, unlike Silero's own Python API which takes
 * milliseconds.
 */
declare module "sherpa-onnx-node" {
  export interface SileroVadModelConfig {
    /** Path to silero_vad.onnx. */
    model?: string;
    /** Speech probability above which a frame counts as speech. */
    threshold?: number;
    minSilenceDuration?: number;
    minSpeechDuration?: number;
    /** Silero's frame size; 512 at 16 kHz. */
    windowSize?: number;
    maxSpeechDuration?: number;
  }

  export interface VadConfig {
    sileroVad?: SileroVadModelConfig;
    sampleRate?: number;
    numThreads?: number;
    provider?: string;
    debug?: boolean | number;
  }

  export interface SpeechSegment {
    /** Start of the segment, as a sample index into the accepted waveform. */
    start: number;
    samples: Float32Array;
  }

  export class Vad {
    constructor(config: VadConfig, bufferSizeInSeconds: number);
    acceptWaveform(samples: Float32Array): void;
    isEmpty(): boolean;
    isDetected(): boolean;
    front(enableExternalBuffer?: boolean): SpeechSegment;
    pop(): void;
    clear(): void;
    reset(): void;
    flush(): void;
  }

  export class CircularBuffer {
    constructor(capacity: number);
    push(samples: Float32Array): void;
    get(startIndex: number, n: number, enableExternalBuffer?: boolean): Float32Array;
    pop(n: number): void;
    size(): number;
    head(): number;
    reset(): void;
  }

  /**
   * The package is CommonJS and Node's named-export detection does not pick
   * these up, so an `import()` of it delivers them here rather than as named
   * exports.
   */
  const sherpa: {
    Vad: typeof Vad;
    CircularBuffer: typeof CircularBuffer;
  };
  export default sherpa;
}
