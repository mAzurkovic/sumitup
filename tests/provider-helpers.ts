import { vi } from 'vitest';
import type { ProviderErrorKind } from '../src/lib/providers/types';

export const STATUS_KINDS: [number, ProviderErrorKind][] = [
  [400, 'rejected'],
  [401, 'auth'],
  [402, 'rate'],
  [403, 'auth'],
  [404, 'modelGone'],
  [413, 'rejected'],
  [422, 'rejected'],
  [429, 'rate'],
  [500, 'unavailable'],
  [503, 'unavailable'],
  [529, 'unavailable'],
];

export const sseText = (events: object[]) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');

export function stubFetch(body: string | null, status = 200) {
  const fetchStub = vi.fn(async (_url: string, _init: RequestInit) => new Response(body, { status }));
  vi.stubGlobal('fetch', fetchStub);
  return fetchStub;
}

export function sentRequest(fetchStub: ReturnType<typeof stubFetch>) {
  const [url, init] = fetchStub.mock.calls[0]!;
  return {
    url,
    headers: init.headers as Record<string, string>,
    method: init.method,
    body: init.body ? JSON.parse(init.body as string) : undefined,
  };
}

/** Reads a stream to its end, keeping the text that arrived before any failure. */
export async function readAll(stream: AsyncIterable<string>) {
  const texts: string[] = [];
  try {
    for await (const text of stream) texts.push(text);
    return { texts, error: undefined };
  } catch (error) {
    return { texts, error: error as Error & { kind?: ProviderErrorKind } };
  }
}
