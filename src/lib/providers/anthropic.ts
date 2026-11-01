import { send, streamText, type ClassifyError, type StreamStep } from './sse';
import { ProviderError, type ProviderAdapter } from './types';

const BASE_URL = 'https://api.anthropic.com/v1';

interface AnthropicEvent {
  type: string;
  delta?: { type?: string; text?: string; stop_reason?: string | null };
}

const headers = (key: string) => ({
  'x-api-key': key,
  'anthropic-version': '2026-10-21',
  'anthropic-dangerous-direct-browser-access': 'true',
});

// Anthropic reports no credit as a plain 400.
const classify: ClassifyError = (status, body) =>
  status === 400 && body.includes('credit balance') ? 'rate' : undefined;

function readEvent({ type, delta }: AnthropicEvent): StreamStep {
  if (type === 'content_block_delta' && delta?.type === 'text_delta') return { text: delta.text };
  const stopReason = type === 'message_delta' ? delta?.stop_reason : undefined;
  if (!stopReason) return {};
  if (stopReason === 'refusal') throw new ProviderError('refused');
  if (stopReason === 'end_turn' || stopReason === 'stop_sequence') return { finished: true };
  throw new ProviderError('cutoff');
}

export const anthropic: ProviderAdapter = {
  async validateKey(key) {
    await send(`${BASE_URL}/models`, { headers: headers(key) }, classify);
  },

  stream({ key, model, system, messages, maxOutput, signal }) {
    return streamText<AnthropicEvent>(
      `${BASE_URL}/messages`,
      {
        method: 'POST',
        signal,
        headers: {
          ...headers(key),
          'content-type': 'application/json',
          ...(model.refusalFallback && { 'anthropic-beta': 'server-side-fallback-2026-07-01' }),
        },
        body: JSON.stringify({
          model: model.id,
          max_tokens: maxOutput,
          stream: true,
          system,
          output_config: { effort: model.effort },
          messages: messages.map(({ role, text }) => ({ role, content: text })),
          ...(model.refusalFallback && { fallbacks: 'default' }),
        }),
      },
      readEvent,
      classify,
    );
  },
};
