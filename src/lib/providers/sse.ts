import { ProviderError, type ProviderErrorKind } from './types';

const FIRST_TEXT_TIMEOUT_MS = 30_000;

/** Lets a provider name the kind for an error body the status alone cannot identify. */
export type ClassifyError = (status: number, body: string) => ProviderErrorKind | undefined;

export interface StreamStep {
  text?: string;
  finished?: boolean;
}

function kindForStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402 || status === 429) return 'rate';
  if (status === 404) return 'modelGone';
  return status >= 500 ? 'unavailable' : 'rejected';
}

export async function send(url: string, init: RequestInit, classify?: ClassifyError): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (error instanceof TypeError) throw new ProviderError(navigator.onLine ? 'unavailable' : 'offline');
    throw error;
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new ProviderError(classify?.(response.status, body) ?? kindForStatus(response.status), `HTTP ${response.status}`);
  }
  return response;
}

async function* readEvents(body: ReadableStream<BufferSource>): AsyncGenerator<string> {
  let buffer = '';
  let data: string[] = [];
  try {
    for await (const chunk of body.pipeThrough(new TextDecoderStream())) {
      const lines = (buffer + chunk).split(/\r?\n/);
      buffer = lines.pop()!;
      for (const line of lines) {
        if (line.startsWith('data:')) {
          data.push(line.slice(5).trimStart());
        } else if (line === '' && data.length > 0) {
          yield data.join('\n');
          data = [];
        }
      }
    }
  } catch (error) {
    // A dropped connection surfaces here as a TypeError, after the response has started.
    if (error instanceof TypeError) throw new ProviderError('cutoff');
    throw error;
  }
}

function parseEvent<E>(data: string): E {
  try {
    return JSON.parse(data) as E;
  } catch {
    throw new ProviderError('cutoff');
  }
}

/** Ends as `cutoff` unless `readEvent` reports a finish after some text. Never retries. */
export async function* streamText<E>(
  url: string,
  init: RequestInit & { signal: AbortSignal },
  readEvent: (event: E) => StreamStep,
  classify?: ClassifyError,
): AsyncGenerator<string> {
  const firstText = new AbortController();
  const timer = setTimeout(
    () => firstText.abort(new ProviderError('unavailable', 'No text within 30s')),
    FIRST_TEXT_TIMEOUT_MS,
  );
  try {
    const signal = AbortSignal.any([init.signal, firstText.signal]);
    const { body } = await send(url, { ...init, signal }, classify);
    if (!body) throw new ProviderError('cutoff');
    let hasText = false;
    for await (const data of readEvents(body)) {
      const { text, finished } = readEvent(parseEvent<E>(data));
      if (text) {
        hasText = true;
        clearTimeout(timer);
        yield text;
      }
      if (finished && hasText) return;
      if (finished) break;
    }
    throw new ProviderError('cutoff');
  } finally {
    clearTimeout(timer);
  }
}
