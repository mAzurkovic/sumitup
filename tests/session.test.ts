import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { readTab, removeTab, startSelection, summaryKey, updateTab, type TabState } from '../src/lib/session';

const URL_A = 'https://example.com/a';

const newTab = (overrides: Partial<TabState> = {}) => ({
  url: URL_A,
  scope: 'page' as const,
  summaries: {},
  chat: [],
  ...overrides,
});

const pageSource = (text: string) => ({ kind: 'page' as const, text, videoExcluded: false });

async function saveAt(time: number, tabId: number, overrides: Partial<TabState>) {
  vi.setSystemTime(time);
  await updateTab(tabId, () => newTab(overrides));
}

/** Chrome rejects a write once the area would pass its quota, so this does the same at a test size. */
function limitSessionStorage(maxBytes: number) {
  const area = fakeBrowser.storage.session;
  const set = area.set.bind(area);
  return vi.spyOn(area, 'set').mockImplementation(async (items) => {
    const merged = { ...(await area.get(null)), ...items };
    if (JSON.stringify(merged).length > maxBytes) {
      throw new Error('Session storage quota bytes exceeded. Values were not stored.');
    }
    await set(items);
  });
}

beforeEach(() => {
  fakeBrowser.reset();
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('summaryKey', () => {
  it('joins URL, scope, level, and model', () => {
    expect(summaryKey(URL_A, 'page', 'short', 'claude-haiku-5-5')).toBe(
      'https://example.com/a|page|short|claude-haiku-5-5',
    );
  });

  it('gives a different key when any part differs', () => {
    const keys = [
      summaryKey(URL_A, 'page', 'short', 'm'),
      summaryKey('https://example.com/b', 'page', 'short', 'm'),
      summaryKey(URL_A, 'selection', 'short', 'm'),
      summaryKey(URL_A, 'page', 'medium', 'm'),
      summaryKey(URL_A, 'page', 'short', 'n'),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('tab state', () => {
  it('has no state for a tab that was never saved', async () => {
    expect(await readTab(1)).toBeUndefined();
  });

  it('stores state under a per-tab key in session storage only', async () => {
    await updateTab(7, () => newTab());
    expect(Object.keys(await fakeBrowser.storage.session.get(null))).toEqual(['tab:7']);
    expect(await fakeBrowser.storage.local.get(null)).toEqual({});
  });

  it('gives the current state to each change', async () => {
    await updateTab(1, () => newTab({ chat: [{ role: 'user', text: 'Hi' }] }));
    await updateTab(1, (tab) => ({ ...tab!, chat: [...tab!.chat, { role: 'assistant', text: 'Hello' }] }));
    expect((await readTab(1))?.chat).toEqual([
      { role: 'user', text: 'Hi' },
      { role: 'assistant', text: 'Hello' },
    ]);
  });

  it('applies changes made at the same time, one after another', async () => {
    await updateTab(1, () => newTab());
    await Promise.all(
      ['a', 'b', 'c'].map((key) =>
        updateTab(1, (tab) => ({ ...tab!, summaries: { ...tab!.summaries, [key]: { text: key, status: 'complete' } } })),
      ),
    );
    expect(Object.keys((await readTab(1))!.summaries).sort()).toEqual(['a', 'b', 'c']);
  });

  it('keeps working after a failed write', async () => {
    vi.spyOn(fakeBrowser.storage.session, 'set').mockRejectedValueOnce(new Error('disk full'));
    await expect(updateTab(1, () => newTab())).rejects.toThrow('disk full');
    await updateTab(1, () => newTab());
    expect(await readTab(1)).toBeDefined();
  });

  it.each(['complete', 'incomplete', 'refused'] as const)('reads a stored %s summary back unchanged', async (status) => {
    const key = summaryKey(URL_A, 'page', 'short', 'm');
    await updateTab(1, () => newTab({ summaries: { [key]: { text: 'Partial', status } } }));
    expect((await readTab(1))?.summaries[key]).toEqual({ text: 'Partial', status });
  });
});

describe('startSelection', () => {
  const pageKey = summaryKey(URL_A, 'page', 'short', 'm');
  const selectionKey = summaryKey(URL_A, 'selection', 'short', 'm');
  const otherLevelKey = summaryKey(URL_A, 'selection', 'medium', 'm');
  const done = { text: 'x', status: 'complete' as const };

  it('deletes selection summaries, because their key does not identify the selected text', async () => {
    await updateTab(1, () =>
      newTab({ summaries: { [pageKey]: done, [selectionKey]: done, [otherLevelKey]: done } }),
    );
    await startSelection(1, URL_A, 'New selection');
    expect(Object.keys((await readTab(1))!.summaries)).toEqual([pageKey]);
  });

  it('keeps a page summary whose URL contains the word selection', async () => {
    const trickyKey = summaryKey('https://example.com/?a=|selection|x', 'page', 'short', 'm');
    await updateTab(1, () => newTab({ summaries: { [trickyKey]: done } }));
    await startSelection(1, URL_A, 'New selection');
    expect(Object.keys((await readTab(1))!.summaries)).toEqual([trickyKey]);
  });

  it('sets the scope and source to the selection and clears chat', async () => {
    await updateTab(1, () => newTab({ chat: [{ role: 'user', text: 'Old' }], source: pageSource('Page') }));
    await startSelection(1, URL_A, 'New selection');
    expect(await readTab(1)).toMatchObject({
      url: URL_A,
      scope: 'selection',
      selectionText: 'New selection',
      chat: [],
      source: { kind: 'selection', text: 'New selection', videoExcluded: false },
    });
  });

  it('works on a tab with no state yet', async () => {
    await startSelection(1, URL_A, 'First');
    expect(await readTab(1)).toMatchObject({ scope: 'selection', summaries: {}, chat: [] });
  });
});

describe('removeTab', () => {
  it('deletes only that tab', async () => {
    await updateTab(1, () => newTab());
    await updateTab(2, () => newTab());
    await removeTab(1);
    expect(await readTab(1)).toBeUndefined();
    expect(await readTab(2)).toBeDefined();
  });

  it('waits for a write in progress, so the write cannot bring the tab back', async () => {
    const writing = updateTab(1, () => newTab());
    await removeTab(1);
    await writing;
    expect(await readTab(1)).toBeUndefined();
  });
});

describe('eviction when session storage is full', () => {
  const summary = { key: { text: 'Kept', status: 'complete' as const } };
  const chat = [{ role: 'user' as const, text: 'Kept' }];
  const big = 'x'.repeat(1000);

  it('drops the source of the least recently used tab and keeps its summaries and chat', async () => {
    await saveAt(2000, 2, { source: pageSource(big), summaries: summary, chat });
    await saveAt(1000, 1, { source: pageSource(big), summaries: summary, chat });
    await saveAt(3000, 3, { source: pageSource(big) });
    limitSessionStorage(3800);

    await saveAt(4000, 4, { source: pageSource(big) });

    const oldest = await readTab(1);
    expect(oldest?.source).toBeUndefined();
    expect(oldest).toMatchObject({ summaries: summary, chat });
    expect((await readTab(2))?.source?.text).toBe(big);
    expect((await readTab(3))?.source?.text).toBe(big);
    expect((await readTab(4))?.source?.text).toBe(big);
  });

  it('counts a later write as use, so the order follows the most recent write', async () => {
    await saveAt(1000, 1, { source: pageSource(big) });
    await saveAt(2000, 2, { source: pageSource(big) });
    vi.setSystemTime(3000);
    await updateTab(1, (tab) => ({ ...tab!, chat }));
    limitSessionStorage(2500);

    await saveAt(4000, 3, { source: pageSource(big) });

    expect((await readTab(1))?.source?.text).toBe(big);
    expect((await readTab(2))?.source).toBeUndefined();
  });

  it('drops as many sources as the write needs', async () => {
    await saveAt(1000, 1, { source: pageSource(big) });
    await saveAt(2000, 2, { source: pageSource(big) });
    limitSessionStorage(1500);

    await saveAt(3000, 3, { source: pageSource(big) });

    expect((await readTab(1))?.source).toBeUndefined();
    expect((await readTab(2))?.source).toBeUndefined();
    expect((await readTab(3))?.source?.text).toBe(big);
  });

  it('drops the source of the tab being saved last, and keeps its summaries', async () => {
    limitSessionStorage(500);
    await saveAt(1000, 1, { source: pageSource(big), summaries: summary });
    expect(await readTab(1)).toMatchObject({ summaries: summary });
    expect((await readTab(1))?.source).toBeUndefined();
  });

  it('fails when the state is too large even with no source', async () => {
    limitSessionStorage(50);
    await expect(saveAt(1000, 1, { source: pageSource(big), summaries: summary, chat })).rejects.toThrow(/quota/i);
  });

  it('does not evict on any other storage error', async () => {
    await saveAt(1000, 1, { source: pageSource(big) });
    vi.spyOn(fakeBrowser.storage.session, 'set').mockRejectedValueOnce(new Error('disk full'));
    await expect(saveAt(2000, 2, { source: pageSource(big) })).rejects.toThrow('disk full');
    expect((await readTab(1))?.source?.text).toBe(big);
  });

  it('leaves other session entries alone', async () => {
    await fakeBrowser.storage.session.set({ other: { source: big, usedAt: 1 } });
    limitSessionStorage(500);
    await expect(saveAt(1000, 1, { source: pageSource(big) })).rejects.toThrow(/quota/i);
    expect(await fakeBrowser.storage.session.get('other')).toEqual({ other: { source: big, usedAt: 1 } });
  });
});
