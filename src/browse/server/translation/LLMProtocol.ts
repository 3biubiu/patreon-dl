/**
 * The two wire protocols the translation key can speak: Gemini's own
 * `generateContent`, and the OpenAI-compatible `chat/completions` that most
 * other providers (and most self-hosted gateways) expose.
 *
 * Only the shape of the request and of the answer differ between the two. The
 * callers keep their own retry, error and parsing logic, and hand this module a
 * conversation in Gemini's shape - roles `user` and `model`, text in `parts` -
 * because that is what they already build.
 */

export type LLMProvider = 'gemini' | 'openai';

export const LLM_PROVIDERS: LLMProvider[] = [ 'gemini', 'openai' ];

export const PROVIDER_DEFAULTS: Record<LLMProvider, { baseUrl: string; model: string }> = {
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-3.5-flash-lite'
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini'
  }
};

export function isLLMProvider(value: unknown): value is LLMProvider {
  return typeof value === 'string' && (LLM_PROVIDERS as string[]).includes(value);
}

/** What the provider is called in a message an administrator reads. */
export function providerLabel(provider: LLMProvider) {
  return provider === 'openai' ? 'The OpenAI-compatible API' : 'Gemini';
}

export interface LLMMessage {
  role: string;
  parts: { text: string }[];
}

export interface LLMRequestParams {
  provider: LLMProvider;
  apiKey: string;
  model: string;
  /** Without a trailing slash. */
  baseUrl: string;
  system: string[];
  contents: LLMMessage[];
  temperature: number;
  disableThinking: boolean;
  /**
   * Gemini's response schema, when the answer must be JSON of that shape.
   * OpenAI-compatible servers disagree too much on structured output to send
   * one there; the prompt states the format and the callers already strip a
   * code fence around it.
   */
  responseSchema?: unknown;
}

export function buildLLMRequest(params: LLMRequestParams) {
  const { provider, apiKey, model, baseUrl, system, contents, temperature, disableThinking } = params;

  if (provider === 'openai') {
    const messages = [
      { role: 'system', content: system.join('\n\n') },
      ...contents.map((message) => ({
        role: message.role === 'model' ? 'assistant' : message.role,
        content: message.parts.map((part) => part.text).join('')
      }))
    ];
    return {
      url: `${baseUrl}/chat/completions`,
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      // `disableThinking` has no portable equivalent here: `reasoning_effort`
      // is rejected by servers and models that do not know it.
      body: { model, messages, temperature }
    };
  }

  const generationConfig: Record<string, unknown> = { temperature };
  if (params.responseSchema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = params.responseSchema;
  }
  if (disableThinking) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }
  return {
    url: `${baseUrl}/models/${encodeURIComponent(model.replace(/^models\//, ''))}:generateContent`,
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: {
      systemInstruction: { parts: system.map((text) => ({ text })) },
      contents,
      generationConfig
    }
  };
}

export interface LLMAnswer {
  /** The model's text, possibly empty. */
  answer: string;
  /** Normalised to Gemini's names: `MAX_TOKENS` for an answer cut off at the ceiling. */
  finishReason: string | null;
  /** Why the provider refused the request outright, if it did. */
  blockReason: string | null;
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
}

interface OpenAIResponse {
  choices?: {
    message?: { content?: string | null; refusal?: string | null };
    finish_reason?: string | null;
  }[];
}

export function readLLMAnswer(provider: LLMProvider, json: unknown): LLMAnswer {
  if (provider === 'openai') {
    const choice = (json as OpenAIResponse)?.choices?.[0];
    const reason = choice?.finish_reason || null;
    return {
      answer: choice?.message?.content || '',
      finishReason: reason === 'length' ? 'MAX_TOKENS' : reason || (choice ? null : 'no choices'),
      blockReason: choice?.message?.refusal || (reason === 'content_filter' ? 'content_filter' : null)
    };
  }
  const gemini = json as GeminiResponse;
  const candidate = gemini?.candidates?.[0];
  return {
    answer: (candidate?.content?.parts || []).map((p) => p.text || '').join(''),
    finishReason: candidate?.finishReason || (candidate ? null : 'no candidates'),
    blockReason: gemini?.promptFeedback?.blockReason || null
  };
}

/** Where a key's models are listed, and how to read the names out of the answer. */
export function buildModelListRequest(provider: LLMProvider, apiKey: string, baseUrl: string) {
  const base = baseUrl.replace(/\/+$/, '');
  return provider === 'openai' ?
    { url: `${base}/models`, headers: { 'Authorization': `Bearer ${apiKey}` } }
    : { url: `${base}/models?pageSize=1000`, headers: { 'x-goog-api-key': apiKey } };
}

export function readModelNames(provider: LLMProvider, json: unknown): string[] {
  if (provider === 'openai') {
    const data = (json as { data?: { id?: string }[] })?.data || [];
    return data.map((m) => m.id || '').filter(Boolean);
  }
  const models = (json as { models?: { name?: string }[] })?.models || [];
  // Names come back as `models/gemini-...`.
  return models.map((m) => (m.name || '').replace(/^models\//, '')).filter(Boolean);
}
