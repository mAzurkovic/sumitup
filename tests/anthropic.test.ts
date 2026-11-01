import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODELS } from '../src/lib/models';
import { anthropic } from '../src/lib/providers/anthropic';
import { readAll, sentRequest, sseText, STATUS_KINDS, stubFetch } from './provider-helpers';

const model = (id: string) => MODELS.find((candidate) => candidate.id === id)!;

function start(id = 'claude-haiku-5-5') {
  return anthropic.stream({
    key: 'test-key',
    model: model(id),
    system: 'Be brief.',
    messages: [
      { role: 'user', text: 'Hi' },
      { role: 'assistant', text: 'Hello' },
      { role: 'user', text: 'More' },
    ],
    maxOutput: 4000,
    signal: new AbortController().signal,
  });
}

const textDelta = (text: string) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
const stop = (stop_reason: string) => ({ type: 'message_delta', delta: { stop_reason }, usage: {} });

afterEach(() => vi.unstubAllGlobals());

describe('anthropic stream', () => {
  it('sends the browser header, low effort, and the conversation', async () => {
    const fetchStub = stubFetch(sseText([stop('end_turn')]));
    await readAll(start());
    const { url, headers, body, method } = sentRequest(fetchStub);
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(method).toBe('POST');
    expect(headers).toMatchObject({
      'x-api-key': 'test-key',
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json',
    });
    expect(headers['anthropic-version']).toEqual(expect.any(String));
    expect(body).toEqual({
      model: 'claude-haiku-5-5',
      max_tokens: 4000,
      stream: true,
      system: 'Be brief.',
      output_config: { effort: 'low' },
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello' },
        { role: 'user', content: 'More' },
      ],
    });
  });

  it('asks for no refusal fallback on the model that has none', async () => {
    const fetchStub = stubFetch(sseText([stop('end_turn')]));
    await readAll(start('claude-haiku-5-5'));
    const { headers, body } = sentRequest(fetchStub);
    expect(headers).not.toHaveProperty('anthropic-beta');
    expect(body).not.toHaveProperty('fallbacks');
  });

  it.each(['claude-sonnet-5-5', 'claude-opus-5-5'])('asks for the refusal fallback on %s', async (id) => {
    const fetchStub = stubFetch(sseText([stop('end_turn')]));
    await readAll(start(id));
    const { headers, body } = sentRequest(fetchStub);
    expect(headers['anthropic-beta']).toBe('server-side-fallback-2026-07-01');
    expect(body.fallbacks).toBe('default');
  });

  it('yields only text deltas', async () => {
    stubFetch(
      sseText([
        { type: 'message_start', message: { model: 'claude-haiku-5-5' } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'x' } },
        { type: 'content_block_stop', index: 0 },
        textDelta('Hello'),
        textDelta(' there'),
        stop('end_turn'),
        { type: 'message_stop' },
      ]),
    );
    expect(await readAll(start())).toEqual({ texts: ['Hello', ' there'], error: undefined });
  });

  it('continues on the same stream across a fallback switch', async () => {
    stubFetch(
      sseText([
        textDelta('Before '),
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'fallback', from: {}, to: {} } },
        { type: 'content_block_stop', index: 1 },
        textDelta('after'),
        stop('end_turn'),
      ]),
    );
    expect(await readAll(start('claude-sonnet-5-5'))).toEqual({ texts: ['Before ', 'after'], error: undefined });
  });

  it('ends as refused, keeping the text, on a refusal stop', async () => {
    stubFetch(sseText([textDelta('Partial'), stop('refusal')]));
    const { texts, error } = await readAll(start());
    expect(texts).toEqual(['Partial']);
    expect(error).toMatchObject({ kind: 'refused' });
  });

  it('ends as cut off, keeping the text, on a max_tokens stop', async () => {
    stubFetch(sseText([textDelta('Partial'), stop('max_tokens')]));
    const { texts, error } = await readAll(start());
    expect(texts).toEqual(['Partial']);
    expect(error).toMatchObject({ kind: 'cutoff' });
  });

  it('ends as cut off with no text when max_tokens stops during thinking', async () => {
    stubFetch(sseText([stop('max_tokens')]));
    expect(await readAll(start())).toMatchObject({ texts: [], error: { kind: 'cutoff' } });
  });

  it('ends as cut off on a normal finish with no text', async () => {
    stubFetch(sseText([stop('end_turn')]));
    expect(await readAll(start())).toMatchObject({ texts: [], error: { kind: 'cutoff' } });
  });

  it.each(['model_context_window_exceeded', 'pause_turn', 'some_future_reason'])(
    'ends as cut off, keeping the text, on the %s stop',
    async (reason) => {
      stubFetch(sseText([textDelta('Partial'), stop(reason)]));
      const { texts, error } = await readAll(start());
      expect(texts).toEqual(['Partial']);
      expect(error).toMatchObject({ kind: 'cutoff' });
    },
  );

  it.each(['end_turn', 'stop_sequence'])('finishes normally on the %s stop', async (reason) => {
    stubFetch(sseText([textDelta('Done'), stop(reason)]));
    expect(await readAll(start())).toEqual({ texts: ['Done'], error: undefined });
  });

  it.each([
    ['a null stop reason', { type: 'message_delta', delta: { stop_reason: null } }],
    ['no delta', { type: 'message_delta' }],
  ])('keeps reading after a message_delta with %s', async (_name, event) => {
    stubFetch(sseText([textDelta('A'), event, textDelta('B'), stop('end_turn')]));
    expect(await readAll(start())).toEqual({ texts: ['A', 'B'], error: undefined });
  });

  it('ends as cut off when the stream ends with no finish event', async () => {
    stubFetch(sseText([textDelta('Partial')]));
    expect((await readAll(start())).error).toMatchObject({ kind: 'cutoff' });
  });

  it('ends as cut off on an error event in the stream', async () => {
    stubFetch(sseText([textDelta('Partial'), { type: 'error', error: { type: 'overloaded_error' } }]));
    const { texts, error } = await readAll(start());
    expect(texts).toEqual(['Partial']);
    expect(error).toMatchObject({ kind: 'cutoff' });
  });

  it.each(STATUS_KINDS)('maps status %i to %s', async (status, kind) => {
    stubFetch('{}', status);
    expect((await readAll(start())).error).toMatchObject({ kind });
  });

  it('maps the credit balance error to rate', async () => {
    stubFetch(
      '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}',
      400,
    );
    expect((await readAll(start())).error).toMatchObject({ kind: 'rate' });
  });
});

describe('anthropic validateKey', () => {
  it('lists models, which costs no tokens', async () => {
    const fetchStub = stubFetch('{"data":[]}');
    await expect(anthropic.validateKey('test-key')).resolves.toBeUndefined();
    const { url, headers, method } = sentRequest(fetchStub);
    expect(url).toBe('https://api.anthropic.com/v1/models');
    expect(method).toBeUndefined();
    expect(headers).toMatchObject({ 'x-api-key': 'test-key', 'anthropic-dangerous-direct-browser-access': 'true' });
  });

  it('rejects a bad key as auth', async () => {
    stubFetch('{}', 401);
    await expect(anthropic.validateKey('bad')).rejects.toMatchObject({ kind: 'auth' });
  });

  it('maps no credit to rate', async () => {
    stubFetch('Your credit balance is too low', 400);
    await expect(anthropic.validateKey('k')).rejects.toMatchObject({ kind: 'rate' });
  });
});
