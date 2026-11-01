import type { Model } from '../models';

export type ProviderErrorKind =
  | 'auth'
  | 'rate'
  | 'unavailable'
  | 'offline'
  | 'cutoff'
  | 'modelGone'
  | 'rejected'
  | 'refused';

export class ProviderError extends Error {
  override readonly name = 'ProviderError';

  constructor(
    readonly kind: ProviderErrorKind,
    message: string = kind,
  ) {
    super(message);
  }
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface StreamRequest {
  key: string;
  model: Model;
  system: string;
  messages: ChatMessage[];
  maxOutput: number;
  signal: AbortSignal;
}

export interface ProviderAdapter {
  validateKey(key: string): Promise<void>;
  stream(request: StreamRequest): AsyncIterable<string>;
}
