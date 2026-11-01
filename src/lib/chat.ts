import { MAX_OUTPUT, type Model } from './models';
import { chatPrompt, NOT_COVERED_REPLY, type Prompt } from './prompts';
import type { ChatMessage, ProviderAdapter } from './providers/types';
import { estimateTokens, matchParts, splitParagraphs } from './text';

// Small parts, so keyword matching can pick out the relevant passages of a very long page.
const MATCH_PART_TOKENS = 2000;
const CONTENT_SHARE_OF_LIMIT = 0.8;

export interface ChatRequest {
  adapter: ProviderAdapter;
  key: string;
  model: Model;
  sourceText: string;
  history: ChatMessage[];
  question: string;
  signal: AbortSignal;
}

function promptTokens({ system, messages }: Prompt): number {
  return estimateTokens(system) + messages.reduce((total, { text }) => total + estimateTokens(text), 0);
}

function promptFits(content: string, question: string, model: Model): boolean {
  return promptTokens(chatPrompt(content, [], question)) <= model.inputLimit;
}

/** Empty when no part matches the question. */
function contentFor({ sourceText, question, model }: ChatRequest): string {
  if (promptFits(sourceText, question, model)) return sourceText;
  const budget = model.inputLimit * CONTENT_SHARE_OF_LIMIT;
  const parts = splitParagraphs(sourceText, Math.min(MATCH_PART_TOKENS, budget));
  return matchParts(parts, question, budget).join('\n\n');
}

/** Keeps the newest messages that fit. The kept history must start with a user message. */
function trimHistory(history: ChatMessage[], room: number): ChatMessage[] {
  let start = history.length;
  let used = 0;
  while (start > 0) {
    used += estimateTokens(history[start - 1]!.text);
    if (used > room) break;
    start--;
  }
  const firstUser = history.findIndex(({ role }, index) => index >= start && role === 'user');
  return firstUser < 0 ? [] : history.slice(firstUser);
}

export async function* askChat(request: ChatRequest): AsyncGenerator<string> {
  const { adapter, key, model, history, question, signal } = request;
  const content = contentFor(request);
  if (!content) {
    yield NOT_COVERED_REPLY;
    return;
  }
  const room = model.inputLimit - promptTokens(chatPrompt(content, [], question));
  const prompt = chatPrompt(content, trimHistory(history, room), question);
  yield* adapter.stream({ key, model, ...prompt, maxOutput: MAX_OUTPUT, signal });
}
