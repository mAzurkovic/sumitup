import { MAX_OUTPUT, type Model } from './models';
import { mergePrompt, partPrompt, summaryPrompt, type Level } from './prompts';
import type { ProviderAdapter } from './providers/types';
import { estimateTokens, splitParagraphs } from './text';

const PART_SHARE_OF_LIMIT = 0.8;
const PARTS_AT_A_TIME = 3;

export interface SummarizeRequest {
  adapter: ProviderAdapter;
  key: string;
  model: Model;
  level: Level;
  text: string;
  signal: AbortSignal;
}

export function isOverLimit(text: string, model: Model): boolean {
  return estimateTokens(text) > model.inputLimit;
}

/** One failed part fails the run, so the failure also stops the parts still running. */
async function summarizeParts({ adapter, key, model, text, signal }: SummarizeRequest): Promise<string[]> {
  const parts = splitParagraphs(text, model.inputLimit * PART_SHARE_OF_LIMIT);
  const failed = new AbortController();
  const anyStop = AbortSignal.any([signal, failed.signal]);
  const summaries: string[] = [];
  let next = 0;

  async function runParts() {
    while (next < parts.length) {
      const index = next++;
      const prompt = partPrompt(parts[index]!);
      let summary = '';
      for await (const delta of adapter.stream({ key, model, ...prompt, maxOutput: MAX_OUTPUT, signal: anyStop })) {
        summary += delta;
      }
      summaries[index] = summary;
    }
  }

  try {
    await Promise.all(Array.from({ length: PARTS_AT_A_TIME }, runParts));
  } catch (error) {
    failed.abort();
    throw error;
  }
  return summaries;
}

/** Above the limit, the caller asks the user to confirm first. Text arrives only from the final call. */
export async function* summarize(request: SummarizeRequest): AsyncGenerator<string> {
  const { adapter, key, model, level, text, signal } = request;
  const prompt = isOverLimit(text, model)
    ? mergePrompt(level, await summarizeParts(request))
    : summaryPrompt(level, text);
  yield* adapter.stream({ key, model, ...prompt, maxOutput: MAX_OUTPUT, signal });
}
