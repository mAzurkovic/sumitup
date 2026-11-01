import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { send, streamText } from '../src/lib/providers/sse';
import { ProviderError } from '../src/lib/providers/types';
import { readAll, sseText, stubFetch } from './provider-helpers';

interface TestEvent {
  text?: string;
  finished?: boolean;
}

const readEvent = (event: TestEvent) => event;

function streamFrom(url: string, signal = new AbortController().signal) {
  return streamText<TestEvent>(url, { signal }, readEvent);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('send', () => {
  it.each([
    [true, 'unavailable'],
    [false, 'offline'],
  ])('maps a fetch TypeError with onLine %s to %s', async (onLine, kind) => {
    vi.stubGlobal('navigator', { onLine });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(send('https://x.test', {})).rejects.toMatchObject({ kind });
  });

  it('passes an abort through unchanged', async () => {
    const abort = new DOMException('Aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abort));
    await expect(send('https://x.test', {})).rejects.toBe(abort);
  });

  it('lets the provider override the kind for an error body', async () => {
    stubFetch('special', 400);
    const classify = (status: number, body: string) => (status === 400 && body === 'special' ? 'auth' : undefined);
    await expect(send('https://x.test', {}, classify)).rejects.toMatchObject({ kind: 'auth' });
  });

  it('falls back to the status when the error body cannot be read', async () => {
    const body = new ReadableStream({
      start: (controller) => controller.error(new TypeError('dropped')),
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 503 })));
    await expect(send('https://x.test', {})).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('does not put the error body in the message, since it can echo the key', async () => {
    stubFetch('bad key sk-secret', 401);
    const error = await send('https://x.test', {}).catch((caught: ProviderError) => caught);
    expect((error as ProviderError).message).not.toContain('sk-secret');
    expect(error).toBeInstanceOf(ProviderError);
  });
});

describe('streamText parsing', () => {
  const chunked = (chunks: Uint8Array[]) =>
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              chunks.forEach((chunk) => controller.enqueue(chunk));
              controller.close();
            },
          }),
        ),
    );

  it('reads events split across every byte, including multibyte characters', async () => {
    const encoded = new TextEncoder().encode(sseText([{ text: 'héllo 猫' }, { text: ' 😀' }, { finished: true }]));
    vi.stubGlobal('fetch', chunked(Array.from(encoded, (byte) => Uint8Array.of(byte))));
    expect(await readAll(streamFrom('https://x.test'))).toEqual({ texts: ['héllo 猫', ' 😀'], error: undefined });
  });

  it('reads CRLF line endings split between chunks', async () => {
    const encoder = new TextEncoder();
    vi.stubGlobal(
      'fetch',
      chunked([
        encoder.encode('data: {"text":"a"}\r'),
        encoder.encode('\n\r\ndata: {"finished":true}\r\n\r\n'),
      ]),
    );
    expect((await readAll(streamFrom('https://x.test'))).texts).toEqual(['a']);
  });

  it('joins multi-line data and ignores event names and comments', async () => {
    stubFetch(': ping\n\nevent: delta\ndata: {"text":\ndata: "a"}\n\ndata: {"finished":true}\n\n');
    expect((await readAll(streamFrom('https://x.test'))).texts).toEqual(['a']);
  });

  it('stops at the finish event without reading on', async () => {
    stubFetch(sseText([{ text: 'before' }, { finished: true }, { text: 'after' }]));
    expect(await readAll(streamFrom('https://x.test'))).toEqual({ texts: ['before'], error: undefined });
  });

  it('ends as cut off when the stream finishes with no text', async () => {
    stubFetch(sseText([{}, { finished: true }]));
    expect(await readAll(streamFrom('https://x.test'))).toMatchObject({ texts: [], error: { kind: 'cutoff' } });
  });

  it('ends as cut off, keeping the text, when no finish event arrives', async () => {
    stubFetch(sseText([{ text: 'partial' }]));
    const { texts, error } = await readAll(streamFrom('https://x.test'));
    expect(texts).toEqual(['partial']);
    expect(error).toMatchObject({ kind: 'cutoff' });
  });

  it('ends as cut off on a malformed event', async () => {
    stubFetch(`${sseText([{ text: 'partial' }])}data: {oops\n\n`);
    const { texts, error } = await readAll(streamFrom('https://x.test'));
    expect(texts).toEqual(['partial']);
    expect(error).toMatchObject({ kind: 'cutoff' });
  });

  it('ends as cut off when the response has no body', async () => {
    stubFetch(null);
    expect((await readAll(streamFrom('https://x.test'))).error).toMatchObject({ kind: 'cutoff' });
  });

  it('throws what the provider reader throws', async () => {
    stubFetch(sseText([{ text: 'a' }]));
    const refused = new ProviderError('refused');
    const stream = streamText<TestEvent>(
      'https://x.test',
      { signal: new AbortController().signal },
      () => {
        throw refused;
      },
    );
    expect((await readAll(stream)).error).toBe(refused);
  });
});

describe('streamText over a real connection', () => {
  let server: Server;
  let url: string;
  let onRequest: (response: ServerResponse) => void;

  beforeEach(async () => {
    server = createServer((_request, response) => onRequest(response));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const responded = () =>
    new Promise<ServerResponse>((resolve) => {
      onRequest = resolve;
    });

  it('ends as cut off, keeping the text, when the connection drops mid-stream', async () => {
    const response = responded();
    const result = readAll(streamFrom(url));
    const res = await response;
    res.write(sseText([{ text: 'partial' }]));
    await vi.waitFor(() => expect(res.writableLength).toBe(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    res.destroy();
    const { texts, error } = await result;
    expect(texts).toEqual(['partial']);
    expect(error).toMatchObject({ kind: 'cutoff' });
  });

  it('ends as unavailable when 30s pass with no text, even if other events arrive', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const response = responded();
    const result = readAll(streamFrom(url));
    const res = await response;
    res.write(sseText([{}]));
    await vi.advanceTimersByTimeAsync(29_999);
    res.write(sseText([{}]));
    await vi.advanceTimersByTimeAsync(1);
    const { texts, error } = await result;
    expect(texts).toEqual([]);
    expect(error).toMatchObject({ kind: 'unavailable' });
  });

  it('ends as unavailable when the provider never answers for 30s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const response = responded();
    const result = readAll(streamFrom(url));
    await response;
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await result).error).toMatchObject({ kind: 'unavailable' });
  });

  it('allows a long stream once the first text has arrived', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const response = responded();
    const stream = streamFrom(url)[Symbol.asyncIterator]();
    const first = stream.next();
    const res = await response;
    res.write(sseText([{ text: 'first' }]));
    expect((await first).value).toBe('first');
    const second = stream.next();
    await vi.advanceTimersByTimeAsync(60_000);
    res.end(sseText([{ text: 'second' }, { finished: true }]));
    expect((await second).value).toBe('second');
    expect((await stream.next()).done).toBe(true);
  });

  it('stops with an AbortError, keeping the text, when the caller aborts mid-stream', async () => {
    const controller = new AbortController();
    const response = responded();
    const texts: string[] = [];
    const reading = (async () => {
      for await (const text of streamFrom(url, controller.signal)) {
        texts.push(text);
        controller.abort();
      }
    })();
    (await response).write(sseText([{ text: 'partial' }]));
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    expect(texts).toEqual(['partial']);
  });

  it('stops with an AbortError when the caller aborts before any response', async () => {
    const controller = new AbortController();
    const response = responded();
    const result = readAll(streamFrom(url, controller.signal));
    await response;
    controller.abort();
    expect((await result).error).toMatchObject({ name: 'AbortError' });
  });

  it('closes the connection when the reader stops early', async () => {
    const response = responded();
    const stream = streamFrom(url)[Symbol.asyncIterator]();
    const first = stream.next();
    const res = await response;
    res.write(sseText([{ text: 'first' }]));
    await first;
    const closed = new Promise((resolve) => res.once('close', resolve));
    await stream.return?.(undefined);
    await closed;
    expect(res.destroyed).toBe(true);
  });
});
