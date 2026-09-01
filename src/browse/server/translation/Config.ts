import path from 'path';
import { type Logger } from '../../../utils/logging/index.js';
import { commonLog } from '../../../utils/logging/Logger.js';
import type TranscriptionIndex from '../transcription/TranscriptionIndex.js';
import type TranscriptionQueue from '../transcription/TranscriptionQueue.js';
import type VocabularyStore from '../transcription/VocabularyStore.js';
import SentenceSplitter from '../transcription/SentenceSplitter.js';
import SubtitlePolisher from '../transcription/SubtitlePolisher.js';
import GeminiTranslator, { DEFAULT_BASE_URL, DEFAULT_MODEL } from './GeminiTranslator.js';
import TranslationQueue from './TranslationQueue.js';
import TranslationSettingsStore from './TranslationSettingsStore.js';

export interface TranslationConfig {
  /**
   * Gemini API key. Without one there is nothing to translate with, and the
   * feature stays switched off - transcription and existing subtitles are
   * unaffected.
   *
   * Falls back to the `GEMINI_API_KEY` environment variable, which is usually
   * where a key belongs rather than in a command line.
   */
  apiKey?: string | null;
  /** Translation model, from Gemini AI Studio. */
  model?: string | null;
  baseUrl?: string | null;
  /**
   * Proxy the Gemini requests go through. Gemini is not reachable everywhere,
   * so this defaults to a local proxy rather than to going direct - see
   * `DEFAULT_PROXY_URL`. An empty string turns it off.
   */
  proxyUrl?: string | null;
}

export interface TranslationServices {
  queue: TranslationQueue;
  settings: TranslationSettingsStore;
}

/**
 * Assembles the translation pieces and hangs them off the transcription ones.
 *
 * Built whether or not a key is present, exactly as transcription is: an
 * administrator can set one from the browser, and needing a restart to notice
 * would be a poor way to answer a settings form.
 */
export function createTranslationServices(
  dataDir: string,
  index: TranscriptionIndex,
  transcriptionQueue: TranscriptionQueue,
  config?: TranslationConfig | null,
  logger?: Logger | null,
  vocabulary?: VocabularyStore | null
): TranslationServices {
  const settings = TranslationSettingsStore.load(
    path.resolve(dataDir, '.patreon-dl', 'translation.json'),
    logger
  );

  const translator = new GeminiTranslator(
    () => ({
      apiKey: config?.apiKey || settings.getApiKey(),
      model: config?.model || settings.getModel() || DEFAULT_MODEL,
      baseUrl: config?.baseUrl || settings.getBaseUrl() || DEFAULT_BASE_URL,
      proxyUrl: config?.proxyUrl !== undefined ? config.proxyUrl || null : settings.getProxyUrl(),
      prompt: settings.getPrompt(),
      disableThinking: settings.getDisableThinking(),
      // The term translations from the transcription's vocabulary file: the
      // same list that steered what the model heard, offered to every call as
      // what those terms must become in Chinese. Pure-English terms (paint
      // names, brands) are included with an empty translation to signal
      // "keep in the original".
      vocabulary: vocabulary?.getTranslationTerms() || []
    }),
    logger
  );

  const queue = new TranslationQueue(dataDir, translator, index, settings, logger);

  // Runs during transcription rather than after it, and spends this key: the
  // sentences it looks for are the source language's, and the words it reads
  // the timings off only exist before the subtitle is written.
  transcriptionQueue.setSentenceSplitter(
    new SentenceSplitter(
      () => ({
        apiKey: config?.apiKey || settings.getApiKey(),
        model: config?.model || settings.getModel() || DEFAULT_MODEL,
        baseUrl: config?.baseUrl || settings.getBaseUrl() || DEFAULT_BASE_URL,
        proxyUrl: config?.proxyUrl !== undefined ?
          config.proxyUrl || null
          : settings.getProxyUrl(),
        disableThinking: settings.getDisableThinking(),
        // The same ceilings the translated file is re-cut to. They are limits
        // on how much text a caption may hold, which is a property of the
        // screen rather than of the language it is read in.
        maxCjk: settings.getMaxLineCjk(),
        maxLatin: settings.getMaxLineLatin()
      }),
      logger
    ),
    () => settings.getSourceSegmentation()
  );

  // The other pass that runs during transcription: the text itself, repaired
  // in place after the cutting. Spends this key like the splitter does, and
  // steers its corrections with the transcription's own vocabulary - the list
  // the Gemini transcriber is biased with, offered to the model again as
  // reference where biasing could not reach.
  transcriptionQueue.setPolisher(
    new SubtitlePolisher(
      () => ({
        apiKey: config?.apiKey || settings.getApiKey(),
        model: config?.model || settings.getModel() || DEFAULT_MODEL,
        baseUrl: config?.baseUrl || settings.getBaseUrl() || DEFAULT_BASE_URL,
        proxyUrl: config?.proxyUrl !== undefined ?
          config.proxyUrl || null
          : settings.getProxyUrl(),
        disableThinking: settings.getDisableThinking()
      }),
      logger
    ),
    () => settings.getPolish(),
    () => vocabulary?.getTerms() || []
  );

  // The other half of the checkbox on the transcribe confirmation: asking to
  // translate marks the record pending, and this is what turns that into a
  // queued job the moment there is a subtitle to translate.
  transcriptionQueue.setOnFinished((mediaId, succeeded) => {
    const record = index.get(mediaId);
    if (record?.translation?.state !== 'pending') {
      return;
    }
    if (!succeeded) {
      // Nothing was written, so there is nothing to translate and nothing to
      // wait for either. Left pending it would sit in the list forever.
      index.markTranslationCancelled(mediaId);
      return;
    }
    queue.enqueue(mediaId);
  });

  // A translation asked for just before a restart is still asked for.
  queue.resumePending();

  if (!settings.getApiKey() && !config?.apiKey) {
    commonLog(logger, 'debug', 'Translation',
      'No Gemini API key yet. An administrator can set one in the translation ' +
      'settings; transcription is unaffected.');
  }

  return { queue, settings };
}
