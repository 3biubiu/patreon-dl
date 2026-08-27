import path from 'path';
import { type Logger } from '../../../utils/logging/index.js';
import { commonLog } from '../../../utils/logging/Logger.js';
import AudioExtractor from './AudioExtractor.js';
import VoiceActivityDetector, { type VADOptions } from './VoiceActivityDetector.js';
import OpenRouterTranscriber, { DEFAULT_BASE_URL, DEFAULT_MODEL } from './OpenRouterTranscriber.js';
import TranscriptionIndex from './TranscriptionIndex.js';
import TranscriptionQueue from './TranscriptionQueue.js';
import TranscriptionSettingsStore from './TranscriptionSettingsStore.js';

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
  queue: TranscriptionQueue;
  vad: VoiceActivityDetector;
  settings: TranscriptionSettingsStore;
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

  const settings = TranscriptionSettingsStore.load(
    path.resolve(dataDir, '.patreon-dl', 'transcription.json'),
    logger
  );

  const extractor = new AudioExtractor(pathToFFmpeg, logger);
  const vad = new VoiceActivityDetector(
    config?.vadModelPath ||
      process.env.PATREON_DL_VAD_MODEL ||
      path.resolve(dataDir, '.patreon-dl', 'silero_vad.onnx'),
    extractor,
    logger
  );
  // Everything is built whether or not a key is present. An administrator can
  // set one from the browser, and rebuilding the queue - or asking for a
  // restart - to notice would be a poor way to answer a settings form.
  const transcriber = new OpenRouterTranscriber(
    () => ({
      apiKey: config?.apiKey || settings.getApiKey(),
      model: config?.model || settings.getModel() || DEFAULT_MODEL,
      baseUrl: config?.baseUrl || settings.getBaseUrl() || DEFAULT_BASE_URL
    }),
    logger
  );
  const queue = new TranscriptionQueue(
    dataDir, extractor, vad, transcriber, index, config?.vad, logger
  );
  if (!settings.getApiKey() && !config?.apiKey) {
    commonLog(logger, 'debug', 'Transcription',
      'No OpenRouter API key yet. An administrator can set one in the transcription ' +
      'settings; existing subtitles are served either way.');
  }
  return { index, queue, vad, settings };
}
