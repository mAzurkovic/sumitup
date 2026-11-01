import { describe, expect, it } from 'vitest';
import { MAX_OUTPUT, MODELS, defaultModel } from '../src/lib/models';

describe('model registry', () => {
  it('lists the 3 Claude models', () => {
    expect(MODELS.map((model) => model.id)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']);
  });

  it('marks exactly one default', () => {
    expect(MODELS.filter((model) => model.isDefault)).toHaveLength(1);
  });

  it('defaults to the cheapest model', () => {
    expect(defaultModel('anthropic').id).toBe('claude-haiku-5-5');
  });

  it('caps output at 4000 tokens, since thinking counts toward the limit', () => {
    expect(MAX_OUTPUT).toBe(4000);
  });

  it.each(MODELS.map((model) => model.id))('sets the input limit and lowest effort for %s', (id) => {
    expect(MODELS.find((model) => model.id === id)).toMatchObject({ inputLimit: 1_000_000, effort: 'low' });
  });

  it('offers the refusal fallback only on the models that have one', () => {
    expect(MODELS.filter((model) => model.refusalFallback).map((model) => model.id)).toEqual([
      'claude-sonnet-5-5',
      'claude-opus-5-5',
    ]);
  });
});
