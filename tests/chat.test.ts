import { afterEach, describe, expect, it, vi } from 'vitest';
import { askChat } from '../src/lib/chat';
import { MODELS, type Model } from '../src/lib/models';
import { chatPrompt, NOT_COVERED_REPLY } from '../src/lib/prompts';
import { anthropic } from '../src/lib/providers/anthropic';
import type { ChatMessage } from '../src/lib/providers/types';
import { estimateTokens } from '../src/lib/text';
import { readAll, sseText } from './provider-helpers';

const textDelta = (text: string) => ({ type: 'content_block_delta', delta: { type: 'text_delta', text } });
const finish = { type: 'message_delta', delta: { stop_reason: 'end_turn' } };

interface SentBody {
  system: string;
  max_tokens: number;
  messages: { role: string; content: string }[];
}

function stubProvider(...texts: string[]) {
  const bodies: SentBody[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return new Response(sseText([...texts.map(textDelta), finish]));
    }),
  );
  return bodies;
}

const model = (inputLimit: number): Model => ({ ...MODELS[0]!, inputLimit });

function ask(sourceText: string, question: string, inputLimit = 1_000_000, history: ChatMessage[] = []) {
  return askChat({
    adapter: anthropic,
    key: 'k',
    model: model(inputLimit),
    sourceText,
    history,
    question,
    signal: new AbortController().signal,
  });
}

const filler = (word: string, count: number) => Array.from({ length: count }, () => word).join(' ');

afterEach(() => vi.unstubAllGlobals());

describe('content within the limit', () => {
  it('sends the full content, the history, and the question, and streams the answer', async () => {
    const bodies = stubProvider('It ', 'melts.');
    const history: ChatMessage[] = [
      { role: 'user', text: 'First?' },
      { role: 'assistant', text: 'Answer.' },
    ];
    expect(await readAll(ask('Glaciers melt in summer.', 'What melts?', 1_000_000, history))).toEqual({
      texts: ['It ', 'melts.'],
      error: undefined,
    });
    const [body] = bodies;
    expect(body?.system).toContain('Glaciers melt in summer.');
    expect(body?.system).toContain(NOT_COVERED_REPLY);
    expect(body?.max_tokens).toBe(4000);
    expect(body?.messages).toEqual([
      { role: 'user', content: 'First?' },
      { role: 'assistant', content: 'Answer.' },
      { role: 'user', content: 'What melts?' },
    ]);
  });

  it('asks the provider even when the question shares no word with the content', async () => {
    const bodies = stubProvider('This page does not cover that.');
    await readAll(ask('Glaciers melt in summer.', 'Who won the match?'));
    expect(bodies).toHaveLength(1);
  });

  it('passes a failure on with no retry', async () => {
    const fetchStub = vi.fn(async () => new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', fetchStub);
    expect((await readAll(ask('Page.', 'Why?'))).error).toMatchObject({ kind: 'auth' });
    expect(fetchStub).toHaveBeenCalledOnce();
  });
});

describe('content over the limit', () => {
  const glaciers = `Glaciers carve valleys over time. ${filler('ice', 150)}`;
  const markets = `Markets opened higher this morning. ${filler('ice', 150)}`;
  const longPage = `${glaciers}\n\n${markets}`;
  const limit = 500;

  const promptSize = (content: string, question: string) => {
    const { system, messages } = chatPrompt(content, [], question);
    return estimateTokens(system) + estimateTokens(messages[0]!.text);
  };

  it('has a page over the limit and paragraphs under it', () => {
    expect(promptSize(longPage, 'q?')).toBeGreaterThan(limit);
    expect(promptSize(glaciers, 'q?')).toBeLessThan(limit);
  });

  it('sends only the parts that match the question', async () => {
    const bodies = stubProvider('They carve valleys.');
    await readAll(ask(longPage, 'What do glaciers carve?', limit));
    expect(bodies[0]?.system).toContain('Glaciers carve valleys');
    expect(bodies[0]?.system).not.toContain('Markets opened');
  });

  it('returns the fixed reply with zero calls when nothing matches', async () => {
    const fetchStub = vi.fn();
    vi.stubGlobal('fetch', fetchStub);
    expect(await readAll(ask(longPage, 'quantum physics?', limit))).toEqual({
      texts: [NOT_COVERED_REPLY],
      error: undefined,
    });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('stays within the limit with the matched parts', async () => {
    const paragraphs = Array.from({ length: 30 }, (_, i) => `topic${i} glaciers ${filler('ice', 20)}`).join('\n\n');
    const largeLimit = 1000;
    expect(promptSize(paragraphs, 'glaciers?')).toBeGreaterThan(largeLimit);
    const bodies = stubProvider('Answer.');
    await readAll(ask(paragraphs, 'glaciers?', largeLimit));
    const sentCharacters = bodies[0]!.system.length + bodies[0]!.messages[0]!.content.length;
    expect(sentCharacters / 2.5).toBeLessThanOrEqual(largeLimit);
  });

  it('counts the prompt and question, so content just under the limit still fits', async () => {
    const largeLimit = 1000;
    const page = `glaciers ${filler('ice', 560)}`;
    expect(estimateTokens(page)).toBeLessThan(largeLimit);
    expect(promptSize(page, 'glaciers?')).toBeGreaterThan(largeLimit);
    const bodies = stubProvider('Answer.');
    await readAll(ask(page, 'glaciers?', largeLimit));
    const sentCharacters = bodies[0]!.system.length + bodies[0]!.messages[0]!.content.length;
    expect(sentCharacters / 2.5).toBeLessThanOrEqual(largeLimit);
  });
});

describe('history trimming', () => {
  const turn = (i: number): ChatMessage[] => [
    { role: 'user', text: `question${i} ${filler('q', 20)}` },
    { role: 'assistant', text: `answer${i} ${filler('a', 20)}` },
  ];
  const history = [...turn(1), ...turn(2), ...turn(3)];
  const sentHistory = (body: SentBody | undefined) => body!.messages.slice(0, -1).map(({ content }) => content);

  // Each message is 20 tokens, so each turn is 40.
  const { system } = chatPrompt('Page text.', [], 'Next?');
  const base = estimateTokens(system) + estimateTokens('Next?');
  const fitsAll = base + 120;
  const fitsOneTurn = base + 45;

  it('keeps all history when it fits', async () => {
    const bodies = stubProvider('Answer.');
    await readAll(ask('Page text.', 'Next?', fitsAll, history));
    expect(sentHistory(bodies[0])).toHaveLength(6);
  });

  it('drops the oldest messages first and keeps the newest', async () => {
    const bodies = stubProvider('Answer.');
    await readAll(ask('Page text.', 'Next?', fitsOneTurn, history));
    const sent = sentHistory(bodies[0]);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatch(/^question3/);
    expect(sent[1]).toMatch(/^answer3/);
  });

  it('always starts the conversation with a user message', async () => {
    for (let limit = base; limit <= fitsAll; limit += 5) {
      const bodies = stubProvider('Answer.');
      await readAll(ask('Page text.', 'Next?', limit, history));
      expect(bodies[0]?.messages[0]?.role).toBe('user');
    }
  });

  it('sends only the question when no history fits', async () => {
    const bodies = stubProvider('Answer.');
    await readAll(ask('Page text.', 'Next?', base + 5, history));
    expect(bodies[0]?.messages).toEqual([{ role: 'user', content: 'Next?' }]);
  });

  it('never changes the history it was given', async () => {
    stubProvider('Answer.');
    const copy = structuredClone(history);
    await readAll(ask('Page text.', 'Next?', fitsOneTurn, history));
    expect(history).toEqual(copy);
  });
});
