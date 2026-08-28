import path from 'path';
import { type Logger } from '../../../utils/logging/index.js';
import { commonLog } from '../../../utils/logging/Logger.js';
import { type TranscriptionProvider } from '../../types/Transcription.js';
import AudioExtractor from './AudioExtractor.js';
import VoiceActivityDetector, { type VADOptions } from './VoiceActivityDetector.js';
import OpenRouterTranscriber, { DEFAULT_BASE_URL, DEFAULT_MODEL } from './OpenRouterTranscriber.js';
import GeminiTranscriber, {
  DEFAULT_BASE_URL as GEMINI_DEFAULT_BASE_URL,
  DEFAULT_MODEL as GEMINI_DEFAULT_MODEL
} from './GeminiTranscriber.js';
import { type Transcriber } from './Transcriber.js';
import TranscriptionIndex from './TranscriptionIndex.js';
import TranscriptionQueue from './TranscriptionQueue.js';
import TranscriptionSettingsStore from './TranscriptionSettingsStore.js';
import VocabularyStore from './VocabularyStore.js';

export interface TranscriptionConfig {
  /** Which provider transcribes. An administrator can change it from the browser. */
  provider?: TranscriptionProvider | null;
  /**
   * OpenRouter API key. Without one - and without a Gemini key, if that is the
   * provider - there is nothing to transcribe with, and the feature stays
   * switched off. Existing subtitles are still served.
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
  /** Gemini API key, falling back to `GEMINI_API_KEY`. */
  geminiApiKey?: string | null;
  geminiModel?: string | null;
  geminiBaseUrl?: string | null;
  /**
   * Proxy the Gemini requests go through. Gemini is not reachable everywhere,
   * so an unset value means the built-in default rather than going direct -
   * see `TranscriptionSettingsStore.getGeminiProxyUrl`.
   */
  geminiProxyUrl?: string | null;
  /**
   * Path to `silero_vad.onnx`. Defaults to the data directory's `.patreon-dl`
   * folder.
   */
  vadModelPath?: string | null;
  /**
   * Path to the domain vocabulary. Defaults to the data directory's
   * `.patreon-dl` folder.
   */
  vocabularyPath?: string | null;
  vad?: VADOptions;
}

export interface TranscriptionServices {
  index: TranscriptionIndex;
  queue: TranscriptionQueue;
  vad: VoiceActivityDetector;
  settings: TranscriptionSettingsStore;
  vocabulary: VocabularyStore;
}

/**
 * Whichever provider the settings currently name.
 *
 * A lookup, not a chain. When the provider in use fails - out of quota, key
 * rejected - the job fails with it and says which one gave up. Falling through
 * to the other would move the work to a different price and a different
 * transcript quality without anyone having decided to, so switching is
 * something somebody does in the settings and then re-runs the job.
 *
 * Resolved per call rather than at startup, so a switch takes effect on the
 * next clip instead of at the next restart.
 */
class SelectedTranscriber implements Transcriber {
  #choose: () => Transcriber;

  constructor(choose: () => Transcriber) {
    this.#choose = choose;
  }

  get name() {
    return this.#choose().name;
  }

  get model() {
    return this.#choose().model;
  }

  get audioFormat() {
    return this.#choose().audioFormat;
  }

  transcribe(
    audioPath: string,
    language: string | null | undefined,
    signal?: AbortSignal
  ) {
    return this.#choose().transcribe(audioPath, language, signal);
  }
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

  const vocabulary = new VocabularyStore(
    config?.vocabularyPath ||
      process.env.PATREON_DL_TRANSCRIBE_VOCABULARY ||
      path.resolve(dataDir, '.patreon-dl', 'transcription-vocabulary.txt'),
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
  // restart - to notice would be a poor way to answer a settings form. Both
  // providers likewise: which one is asked is decided per clip.
  const openRouter = new OpenRouterTranscriber(
    () => ({
      apiKey: config?.apiKey || settings.getApiKey(),
      model: config?.model || settings.getModel() || DEFAULT_MODEL,
      baseUrl: config?.baseUrl || settings.getBaseUrl() || DEFAULT_BASE_URL
    }),
    logger
  );
  const gemini = new GeminiTranscriber(
    () => ({
      apiKey: config?.geminiApiKey || settings.getGeminiApiKey(),
      model: config?.geminiModel || settings.getGeminiModel() || GEMINI_DEFAULT_MODEL,
      baseUrl: config?.geminiBaseUrl || settings.getGeminiBaseUrl() || GEMINI_DEFAULT_BASE_URL,
      proxyUrl: config?.geminiProxyUrl !== undefined ?
        config.geminiProxyUrl || null
        : settings.getGeminiProxyUrl(),
      // Read here rather than held, so an edit to the file is picked up by the
      // next clip without the server being told about it.
      vocabulary: vocabulary.getTerms()
    }),
    logger
  );
  const transcriber = new SelectedTranscriber(() => {
    const provider = config?.provider || settings.getProvider();
    return provider === 'gemini' ? gemini : openRouter;
  });

  const queue = new TranscriptionQueue(
    dataDir, extractor, vad, transcriber, index, config?.vad, logger
  );
  // A request made just before a restart is still a request. Ones that were
  // already under way are not resumed - the index has marked those failed.
  queue.resumePending();
  if (!settings.getActiveApiKey() && !config?.apiKey && !config?.geminiApiKey) {
    commonLog(logger, 'debug', 'Transcription',
      `No API key for the ${settings.getProvider()} provider yet. An administrator ` +
      'can set one in the transcription settings; existing subtitles are served ' +
      'either way.');
  }
  return { index, queue, vad, settings, vocabulary };
}
