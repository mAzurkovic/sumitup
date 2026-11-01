import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODELS, type Model } from '../src/lib/models';
import { anthropic } from '../src/lib/providers/anthropic';
import { isOverLimit, summarize } from '../src/lib/summarize';
import { estimateTokens } from '../src/lib/text';
import { readAll, sseText } from './provider-helpers';

const textDelta = (text: string) => ({ type: 'content_block_delta', delta: { type: 'text_delta', text } });
const finish = { type: 'message_delta', delta: { stop_reason: 'end_turn' } };

// A limit of 100 tokens splits at 80 tokens, which is 200 characters.
const smallModel: Model = { ...MODELS[0]!, inputLimit: 100 };

const longPage = (paragraphs: number) =>
  Array.from({ length: paragraphs }, (_, i) => `PART${i} ${'word '.repeat(30).trim()}`).join('\n\n');

interface SentRequest {
  system: string;
  content: string;
  body: Record<string, unknown>;
}

/** Stands in for the provider. Each reply comes from `respond`, given the request that was sent. */
function stubProvider(respond: (request: SentRequest) => Response | Promise<Response>) {
  const requests: SentRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const request = { system: body.system, content: body.messages[0].content, body };
      requests.push(request);
      return respond(request);
    }),
  );
  return requests;
}

const reply = (...texts: string[]) => new Response(sseText([...texts.map(textDelta), finish]));
const isMerge = ({ system }: SentRequest) => system.includes('Merge them');
const partNumber = ({ content }: SentRequest) => content.match(/PART(\d+)/)?.[1];

const run = (text: string, model: Model = MODELS[0]!, signal = new AbortController().signal) =>
  summarize({ adapter: anthropic, key: 'k', model, level: 'medium', text, signal });

afterEach(() => vi.unstubAllGlobals());

describe('isOverLimit', () => {
  it.each([
    [250, false],
    [251, true],
  ])('with a limit of 100 tokens, %i characters over is %s', (length, expected) => {
    expect(isOverLimit('x'.repeat(length), smallModel)).toBe(expected);
  });
});

describe('content within the limit', () => {
  it('makes one call at the selected level and streams its text', async () => {
    const requests = stubProvider(() => reply('Hello', ' there'));
    expect(await readAll(run('Short page.'))).toEqual({ texts: ['Hello', ' there'], error: undefined });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.system).toMatch(/grouped under short headings/);
    expect(requests[0]?.content).toContain('Short page.');
    expect(requests[0]?.body.max_tokens).toBe(4000);
  });

  it('passes a failure on with no retry', async () => {
    const requests = stubProvider(() => new Response('{}', { status: 529 }));
    expect((await readAll(run('Short page.'))).error).toMatchObject({ kind: 'unavailable' });
    expect(requests).toHaveLength(1);
  });
});

describe('content over the limit', () => {
  it('summarizes every part, then merges them all in one streamed call at the selected level', async () => {
    const page = longPage(10);
    const requests = stubProvider((request) =>
      isMerge(request) ? reply('Merged', ' summary') : reply(`Summary of PART${partNumber(request)}`),
    );

    expect(await readAll(run(page, smallModel))).toEqual({ texts: ['Merged', ' summary'], error: undefined });

    const merges = requests.filter(isMerge);
    const parts = requests.filter((request) => !isMerge(request));
    expect(merges).toHaveLength(1);
    expect(requests.at(-1)).toBe(merges[0]);
    for (let i = 0; i < 10; i++) {
      expect(parts.some(({ content }) => content.includes(`PART${i} `))).toBe(true);
      expect(merges[0]?.content).toContain(`Summary of PART${i}`);
    }
    expect(merges[0]?.system).toMatch(/grouped under short headings/);
  });

  it('keeps the part summaries in page order in the merge, whatever order they finish', async () => {
    const page = longPage(6);
    const requests = stubProvider(async (request) => {
      if (isMerge(request)) return reply('Merged');
      const number = Number(partNumber(request));
      await new Promise((resolve) => setTimeout(resolve, (6 - number) * 3));
      return reply(`Summary of PART${number}`);
    });

    await readAll(run(page, smallModel));

    const merged = requests.find(isMerge)!.content;
    const positions = requests
      .filter((request) => !isMerge(request))
      .map((request) => partNumber(request))
      .sort()
      .map((number) => merged.indexOf(`Summary of PART${number}`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('sends every part within 80% of the limit', async () => {
    const requests = stubProvider((request) => (isMerge(request) ? reply('Merged') : reply('Part summary')));
    await readAll(run(longPage(10), smallModel));
    for (const { content } of requests.filter((request) => !isMerge(request))) {
      const text = content.replace('<content>\n', '').replace('\n</content>', '');
      expect(estimateTokens(text)).toBeLessThanOrEqual(80);
    }
  });

  it('runs at most 3 parts at a time', async () => {
    let running = 0;
    let most = 0;
    stubProvider(async (request) => {
      if (isMerge(request)) return reply('Merged');
      running++;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 2));
      running--;
      return reply('Part summary');
    });
    await readAll(run(longPage(12), smallModel));
    expect(most).toBe(3);
  });

  it('fails the whole run with no merge and no retry when one part fails', async () => {
    const requests = stubProvider((request) =>
      partNumber(request) === '1' ? new Response('{}', { status: 429 }) : reply('Part summary'),
    );
    const { texts, error } = await readAll(run(longPage(4), smallModel));
    expect(texts).toEqual([]);
    expect(error).toMatchObject({ kind: 'rate' });
    expect(requests.filter(isMerge)).toEqual([]);
    expect(requests.filter((request) => partNumber(request) === '1')).toHaveLength(1);
  });

  it('stops the other parts when one part fails', async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const content: string = JSON.parse(init.body as string).messages[0].content;
        signals.push(init.signal!);
        if (content.includes('PART0 ')) return new Response('{}', { status: 500 });
        return new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
        });
      }),
    );
    const { error } = await readAll(run(longPage(9), smallModel));
    expect(error).toMatchObject({ kind: 'unavailable' });
    expect(signals.length).toBeLessThanOrEqual(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it('stops the part calls when the caller aborts, and makes no merge', async () => {
    const controller = new AbortController();
    const requests = stubProvider(
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          void request;
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason));
          controller.abort();
        }),
    );
    const { error } = await readAll(run(longPage(4), smallModel, controller.signal));
    expect(error).toMatchObject({ name: 'AbortError' });
    expect(requests.filter(isMerge)).toEqual([]);
  });

  it('keeps the partial merge text when the caller aborts during the merge', async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    stubProvider((request) => {
      if (!isMerge(request)) return reply('Part summary');
      return new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(encoder.encode(sseText([textDelta('Partial merge')])));
            controller.signal.addEventListener('abort', () => stream.error(controller.signal.reason));
          },
        }),
      );
    });

    const texts: string[] = [];
    const reading = (async () => {
      for await (const text of run(longPage(4), smallModel, controller.signal)) {
        texts.push(text);
        controller.abort();
      }
    })();

    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    expect(texts).toEqual(['Partial merge']);
  });
});
