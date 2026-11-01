import type { Level } from './prompts';
import type { ChatMessage } from './providers/types';

export type Scope = 'page' | 'selection';

export interface Summary {
  text: string;
  status: 'complete' | 'incomplete' | 'refused';
}

export interface Source {
  kind: 'page' | 'transcript' | 'selection';
  text: string;
  videoExcluded: boolean;
}

export interface TabState {
  url: string;
  scope: Scope;
  selectionText?: string;
  summaries: Record<string, Summary>;
  chat: ChatMessage[];
  source?: Source;
  usedAt: number;
}

type TabChange = (tab: TabState | undefined) => Omit<TabState, 'usedAt'>;

const storageKey = (tabId: number) => `tab:${tabId}`;

export function summaryKey(url: string, scope: Scope, level: Level, modelId: string): string {
  return `${url}|${scope}|${level}|${modelId}`;
}

// Each write reads the state first, so writes run one at a time to keep them from losing each other's changes.
let lastWrite: Promise<unknown> = Promise.resolve();

function inOrder<T>(write: () => Promise<T>): Promise<T> {
  const result = lastWrite.then(write);
  lastWrite = result.catch(() => undefined);
  return result;
}

export async function readTab(tabId: number): Promise<TabState | undefined> {
  const key = storageKey(tabId);
  const stored = await browser.storage.session.get(key);
  return stored[key] as TabState | undefined;
}

/** Drops the source of the least recently used other tab. A later read extracts it again at no token cost. */
async function evictOldestSource(keptKey: string): Promise<boolean> {
  const stored = await browser.storage.session.get(null);
  const oldest = Object.entries(stored as Record<string, TabState>)
    .filter(([key, tab]) => key.startsWith('tab:') && key !== keptKey && tab.source)
    .sort(([, a], [, b]) => a.usedAt - b.usedAt)[0];
  if (!oldest) return false;
  const [key, { source: _source, ...tab }] = oldest;
  await browser.storage.session.set({ [key]: tab });
  return true;
}

async function writeTab(key: string, tab: TabState): Promise<void> {
  try {
    await browser.storage.session.set({ [key]: tab });
  } catch (error) {
    if (!/quota/i.test(String(error))) throw error;
    if (await evictOldestSource(key)) return writeTab(key, tab);
    if (!tab.source) throw error;
    const { source: _source, ...withoutSource } = tab;
    return writeTab(key, withoutSource);
  }
}

export function updateTab(tabId: number, change: TabChange): Promise<void> {
  return inOrder(async () => writeTab(storageKey(tabId), { ...change(await readTab(tabId)), usedAt: Date.now() }));
}

/** Deletes old selection summaries, because the cache key does not identify the selected text. */
export function startSelection(tabId: number, url: string, text: string): Promise<void> {
  return updateTab(tabId, (tab) => ({
    url,
    scope: 'selection',
    selectionText: text,
    summaries: Object.fromEntries(
      Object.entries(tab?.summaries ?? {}).filter(([key]) => !/\|selection\|[^|]+\|[^|]+$/.test(key)),
    ),
    chat: [],
    source: { kind: 'selection', text, videoExcluded: false },
  }));
}

export function removeTab(tabId: number): Promise<void> {
  return inOrder(() => browser.storage.session.remove(storageKey(tabId)));
}
