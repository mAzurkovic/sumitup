export type Provider = 'anthropic';

export interface Model {
  id: string;
  provider: Provider;
  isDefault: boolean;
  inputLimit: number;
  /** The provider's lowest setting, spelled as its API expects. */
  effort: 'low';
  refusalFallback?: boolean;
}

/** Thinking counts toward this limit, and lower values stopped models before any text. */
export const MAX_OUTPUT = 4000;

export const MODELS: readonly Model[] = [
  { id: 'claude-haiku-5-5', provider: 'anthropic', isDefault: true, inputLimit: 1_000_000, effort: 'low' },
  { id: 'claude-sonnet-5-5', provider: 'anthropic', isDefault: false, inputLimit: 1_000_000, effort: 'low', refusalFallback: true },
  { id: 'claude-opus-5-5', provider: 'anthropic', isDefault: false, inputLimit: 1_000_000, effort: 'low', refusalFallback: true },
];

export function defaultModel(provider: Provider): Model {
  return MODELS.find((model) => model.provider === provider && model.isDefault)!;
}
