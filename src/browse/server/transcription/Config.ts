import path from 'path';
import { type Logger } from '../../../utils/logging/index.js';
import { commonLog } from '../../../utils/logging/Logger.js';
import AudioExtractor from './AudioExtractor.js';
import VoiceActivityDetector, { type VADOptions } from './VoiceActivityDetector.js';
import OpenRouterTranscriber, { DEFAULT_BASE_URL, DEFAULT_MODEL } from './OpenRouterTranscriber.js';
import TranscriptionIndex from './TranscriptionIndex.js';
import TranscriptionQueue from './TranscriptionQueue.js';

export interface TranscriptionConfig {
  /**
   * OpenRouter API key. Without one there is nothing to transcribe with, and
   * the feature stays switched off - existing subtitles are still served.
   *
   * Falls back to the `OPENROUTER_API_KEY` environment variable, which is
   * usually where a key belongs rather than in a command line.
   */
  apiKey?: string | null;
  /**
   * Transcription model. Must be served by an OpenAI-compatible upstream:
   * OpenRouter only returns the timestamps subtitles are built from for those.
   */
  model?: string | null;
  baseUrl?: string | null;
  /**
   * Path to `silero_vad.onnx`. Defaults to the data directory's `.patreon-dl`
   * folder.
   */
  vadModelPath?: string | null;
  vad?: VADOptions;
}

export interface TranscriptionServices {
  index: TranscriptionIndex;
  /** `null` when the feature is not configured; the index still works. */
  queue: TranscriptionQueue | null;
  vad: VoiceActivityDetector | null;
}

/**
 * Assembles the transcription pieces, or as many of them as the configuration
 * allows.
 *
 * The index is always built: it is what tells the browser which videos have
 * captions, and that stays true on a server that cannot make any more.
 */
export function createTranscriptionServices(
  dataDir: string,
  config?: TranscriptionConfig | null,
  pathToFFmpeg?: string | null,
  logger?: Logger | null
): TranscriptionServices {
  const index = TranscriptionIndex.load(
    path.resolve(dataDir, '.patreon-dl', 'transcriptions.json'),
    logger
  );

  // Every setting falls back to an environment variable, so a deployment can
  // be configured without a command line - which is where an API key belongs
  // anyway, since command lines end up in shell history and process listings.
  const apiKey = config?.apiKey || process.env.OPENROUTER_API_KEY || null;
  if (!apiKey) {
    commonLog(logger, 'debug', 'Transcription',
      'No OpenRouter API key, so transcription is disabled. Existing subtitles are still served.');
    return { index, queue: null, vad: null };
  }

  const extractor = new AudioExtractor(pathToFFmpeg, logger);
  const vad = new VoiceActivityDetector(
    config?.vadModelPath ||
      process.env.PATREON_DL_VAD_MODEL ||
      path.resolve(dataDir, '.patreon-dl', 'silero_vad.onnx'),
    extractor,
    logger
  );
  const transcriber = new OpenRouterTranscriber(
    apiKey,
    config?.model || process.env.OPENROUTER_MODEL || DEFAULT_MODEL,
    config?.baseUrl || process.env.OPENROUTER_BASE_URL || DEFAULT_BASE_URL,
    logger
  );
  const queue = new TranscriptionQueue(
    dataDir, extractor, vad, transcriber, index, config?.vad, logger
  );
  return { index, queue, vad };
}
