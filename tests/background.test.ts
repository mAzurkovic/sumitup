import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import background from '../src/entrypoints/background';
import { RUN_REQUESTS, type PanelRequest, type PanelState } from '../src/lib/messages';
import { readTab, startSelection, summaryKey, updateTab } from '../src/lib/session';
import { sseText } from './provider-helpers';

const TAB_ID = 7;
const PAGE_URL = 'https://example.com/article';
const KEY = 'sk-ant-secret-1234';
const PAGE_TEXT = Array.from({ length: 250 }, (_, i) => `word${i}`).join(' ');

const setOptions = vi.fn();
const setAccessLevel = vi.fn();
const executeScript = vi.fn();
const getPlatformInfo = vi.fn(async () => ({}));
const tabsGet = vi.fn();

const textDelta = (text: string) => ({ type: 'content_block_delta', delta: { type: 'text_delta', text } });
const stop = (stop_reason: string) => ({ type: 'message_delta', delta: { stop_reason } });

type Message = Record<string, unknown> & { type: string };

function fakeEvent<T extends unknown[]>() {
  const listeners: ((...args: T) => void)[] = [];
  return {
    addListener: (listener: (...args: T) => void) => listeners.push(listener),
    fire: (...args: T) => listeners.forEach((listener) => listener(...args)),
  };
}

let onConnect = fakeEvent<[never]>();
let onClicked = fakeEvent<[{ id?: number }]>();
let onMessage = fakeEvent<[unknown, { tab?: { id?: number; url?: string } }]>();
let onUpdated = fakeEvent<[number, { url?: string; status?: string }, { id: number; url?: string }]>();
const sidePanelOpen = vi.fn(async (_options: object) => undefined);

function connect(name: string, sender: object = {}) {
  const onMessage = fakeEvent<[unknown]>();
  const onDisconnect = fakeEvent<[]>();
  const messages: Message[] = [];
  const disconnect = vi.fn();
  onConnect.fire({
    name,
    sender,
    onMessage,
    onDisconnect,
    disconnect,
    postMessage: (message: Message) => messages.push(message),
  } as never);
  return {
    messages,
    disconnectedByWorker: disconnect,
    send: (message: object) => onMessage.fire(message),
    close: () => onDisconnect.fire(),
    next: (type: string, count = 1) =>
      vi.waitFor(() => {
        const found = messages.filter((message) => message.type === type);
        expect(found.length).toBeGreaterThanOrEqual(count);
        return found[count - 1]!;
      }),
  };
}

const openPanel = () => connect(`panel:${TAB_ID}`);
const openSelection = () => connect('selection', { tab: { id: TAB_ID } });
const texts = (messages: Message[]) => messages.filter(({ type }) => type === 'delta').map(({ text }) => text);
const stateOf = (message: Message) => message.state as PanelState;

/** Stands in for the provider, and answers each call with the next reply. */
function stubProvider(...replies: (string | Response)[]) {
  const calls: { url: string; body: { system: string; messages: { content: string }[] }; signal?: AbortSignal }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body as string) : undefined, signal: init.signal ?? undefined });
      const reply = replies.shift() ?? sseText([textDelta('Default'), stop('end_turn')]);
      return typeof reply === 'string' ? new Response(reply) : reply;
    }),
  );
  return calls;
}

/** A reply that stays open until the test ends it or the request is aborted. */
function heldReply() {
  const encoder = new TextEncoder();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        stream = controller;
      },
    }),
  );
  return {
    response,
    write: (...events: object[]) => stream.enqueue(encoder.encode(sseText(events))),
    end: () => stream.close(),
    abortOn: (signal: AbortSignal) =>
      signal.addEventListener('abort', () => stream.error(signal.reason), { once: true }),
  };
}

const extracted = (text = PAGE_TEXT, extra: object = {}) => [
  { result: { text, wordCount: text.split(' ').length, hasVideo: false, isPdf: false, ...extra } },
];

const saveStoredKey = () => fakeBrowser.storage.local.set({ keys: { anthropic: KEY } });
const shortKey = (url = PAGE_URL) => summaryKey(url, 'page', 'short', 'claude-haiku-5-5');

beforeEach(() => {
  fakeBrowser.reset();
  vi.clearAllMocks();
  onClicked = fakeEvent();
  onMessage = fakeEvent();
  onUpdated = fakeEvent();
  sidePanelOpen.mockImplementation(async () => undefined);
  Object.assign(fakeBrowser, { sidePanel: { setOptions, open: sidePanelOpen }, scripting: { executeScript } });
  Object.assign(fakeBrowser.action, { onClicked });
  Object.assign(fakeBrowser.storage.local, { setAccessLevel });
  onConnect = fakeEvent<[never]>();
  Object.assign(fakeBrowser.runtime, { getPlatformInfo, onConnect, onMessage });
  Object.assign(fakeBrowser.tabs, { get: tabsGet, onUpdated });
  tabsGet.mockResolvedValue({ id: TAB_ID, url: PAGE_URL });
  executeScript.mockResolvedValue(extracted());
  background.main();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('worker start', () => {
  it('leaves the panel off everywhere until a toolbar click turns it on for one tab', () => {
    expect(setOptions).not.toHaveBeenCalled();
  });

  it('closes key storage to content scripts', () => {
    expect(setAccessLevel).toHaveBeenCalledExactlyOnceWith({ accessLevel: 'TRUSTED_CONTEXTS' });
  });
});

describe('port access', () => {
  it('disconnects a content script that names its port as the panel', () => {
    const port = connect(`panel:${TAB_ID}`, { tab: { id: 99 } });
    expect(port.disconnectedByWorker).toHaveBeenCalledOnce();
    expect(port.messages).toEqual([]);
  });

  it.each(['panel:abc', 'panel:', 'other'])('disconnects a port named %s', (name) => {
    expect(connect(name).disconnectedByWorker).toHaveBeenCalledOnce();
  });

  it('disconnects a selection port with no tab', () => {
    expect(connect('selection').disconnectedByWorker).toHaveBeenCalledOnce();
  });
});

describe('panel state', () => {
  it('starts with the cheapest model, Short, and no key', async () => {
    const state = stateOf(await openPanel().next('state'));
    expect(state).toEqual({ modelId: 'claude-haiku-5-5', level: 'short', scope: 'page', chat: [], videoExcluded: false });
  });

  it('shows the stored summary and chat when the panel reopens, with no call', async () => {
    await saveStoredKey();
    const calls = stubProvider();
    const chat = [{ role: 'user' as const, text: 'Hi' }];
    await updateTab(TAB_ID, () => ({
      url: PAGE_URL,
      scope: 'page',
      chat,
      summaries: { [shortKey()]: { text: 'Partial', status: 'incomplete' } },
    }));
    const state = stateOf(await openPanel().next('state'));
    expect(state.summary).toEqual({ text: 'Partial', status: 'incomplete' });
    expect(state.chat).toEqual(chat);
    expect(calls).toEqual([]);
  });

  it('does not offer the stored chat of an earlier page', async () => {
    await updateTab(TAB_ID, () => ({
      url: 'https://example.com/old',
      scope: 'page',
      chat: [{ role: 'user', text: 'Hi' }],
      summaries: {},
    }));
    expect(stateOf(await openPanel().next('state')).chat).toEqual([]);
  });

  it('treats a URL that differs only by fragment as the same page', async () => {
    tabsGet.mockResolvedValue({ id: TAB_ID, url: `${PAGE_URL}#section` });
    await updateTab(TAB_ID, () => ({
      url: PAGE_URL,
      scope: 'page',
      chat: [],
      summaries: { [shortKey()]: { text: 'Kept', status: 'complete' } },
    }));
    expect(stateOf(await openPanel().next('state')).summary?.text).toBe('Kept');
  });

  it('still answers when the tab is gone', async () => {
    tabsGet.mockRejectedValue(new Error('No tab with id'));
    expect(stateOf(await openPanel().next('state')).summary).toBeUndefined();
  });

  it('remembers the model and makes no call when it changes', async () => {
    await saveStoredKey();
    const calls = stubProvider();
    const panel = openPanel();
    await panel.next('state');
    panel.send({ type: 'setModel', modelId: 'claude-opus-5-5' });
    expect(stateOf(await panel.next('state', 2)).modelId).toBe('claude-opus-5-5');
    expect(calls).toEqual([]);
    expect(stateOf(await openPanel().next('state')).modelId).toBe('claude-opus-5-5');
  });

  it('falls back to the default model when the stored one no longer exists', async () => {
    await fakeBrowser.storage.local.set({
      settings: { provider: 'anthropic', modelByProvider: { anthropic: 'retired' }, level: 'medium' },
    });
    expect(stateOf(await openPanel().next('state'))).toMatchObject({ modelId: 'claude-haiku-5-5', level: 'medium' });
  });
});

describe('saving a key', () => {
  it('checks the key, stores it, and tells the panel only its last 4 characters', async () => {
    const calls = stubProvider('{"data":[]}');
    const panel = openPanel();
    await panel.next('state');
    panel.send({ type: 'saveKey', key: `  ${KEY}\n` });
    const state = stateOf(await panel.next('state', 2));
    expect(state.keyEnding).toBe('1234');
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/models');
    expect(await fakeBrowser.storage.local.get('keys')).toEqual({ keys: { anthropic: KEY } });
    expect(JSON.stringify(panel.messages)).not.toContain('secret');
  });

  it.each([
    [401, 'auth'],
    [429, 'rate'],
    [500, 'unavailable'],
  ])('does not store a key refused with %i, and reports %s', async (status, kind) => {
    stubProvider(new Response('{}', { status }));
    const panel = openPanel();
    panel.send({ type: 'saveKey', key: KEY });
    expect(await panel.next('error')).toMatchObject({ kind });
    expect(await fakeBrowser.storage.local.get('keys')).toEqual({});
  });

  it.each([
    ['a bullet', 'sk-ant-abc•••xyz'],
    ['an ellipsis', 'sk-ant-abc…xyz'],
    ['an inner line break', 'sk-ant\nabc'],
    ['nothing', '   '],
  ])('rejects a key with %s as a bad key, with no call', async (_name, key) => {
    const calls = stubProvider();
    const panel = openPanel();
    panel.send({ type: 'saveKey', key });
    expect(await panel.next('error')).toMatchObject({ kind: 'auth' });
    expect(calls).toEqual([]);
    expect(await fakeBrowser.storage.local.get('keys')).toEqual({});
  });

  it('deletes a key and returns the panel to the no-key state', async () => {
    await saveStoredKey();
    const panel = openPanel();
    expect(stateOf(await panel.next('state')).keyEnding).toBe('1234');
    panel.send({ type: 'deleteKey' });
    expect(stateOf(await panel.next('state', 2)).keyEnding).toBeUndefined();
    expect(await fakeBrowser.storage.local.get('keys')).toEqual({ keys: {} });
  });
});

describe('page summary', () => {
  beforeEach(saveStoredKey);

  it('tells the panel about a left-out video before the first text, with no summary', async () => {
    stubProvider();
    executeScript.mockResolvedValue(extracted(PAGE_TEXT, { hasVideo: true }));
    const panel = openPanel();
    await panel.next('state');
    panel.send({ type: 'summarize' });
    const firstText = await panel.next('delta');
    const before = panel.messages.slice(0, panel.messages.indexOf(firstText));
    const reported = stateOf(before.filter(({ type }) => type === 'state').at(-1)!);
    expect(reported.videoExcluded).toBe(true);
    expect(reported.summary).toBeUndefined();
    expect(reported.summaryModelId).toBeUndefined();
  });

  it('streams the text and stores it as complete', async () => {
    const calls = stubProvider(sseText([textDelta('Hello'), textDelta(' there'), stop('end_turn')]));
    const panel = openPanel();
    panel.send({ type: 'summarize' });
    expect(await panel.next('done')).toEqual({ type: 'done', stream: 'summary', status: 'complete' });
    expect(texts(panel.messages)).toEqual(['Hello', ' there']);
    expect(calls[0]?.body.messages[0]?.content).toContain('word249');
    expect((await readTab(TAB_ID))?.summaries[shortKey()]).toEqual({ text: 'Hello there', status: 'complete' });
  });

  it('asks for a key when none is saved, with no call and no page read', async () => {
    await fakeBrowser.storage.local.remove('keys');
    const calls = stubProvider();
    const panel = openPanel();
    panel.send({ type: 'summarize' });
    expect(await panel.next('error')).toMatchObject({ kind: 'noKey' });
    expect(calls).toEqual([]);
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('injects the extractor into the tab', async () => {
    stubProvider();
    const panel = openPanel();
    panel.send({ type: 'summarize' });
    await panel.next('done');
    expect(executeScript).toHaveBeenCalledExactlyOnceWith({ target: { tabId: TAB_ID }, files: ['/extract.js'] });
  });

  it.each([
    ['injection fails', () => executeScript.mockRejectedValue(new Error('Cannot access a chrome:// URL'))],
    ['the page is a PDF', () => executeScript.mockResolvedValue(extracted('', { isPdf: true }))],
    ['the script returns nothing', () => executeScript.mockResolvedValue([{ result: null }])],
    ['the tab has no readable URL', () => tabsGet.mockResolvedValue({ id: TAB_ID })],
    ['the tab is gone', () => tabsGet.mockRejectedValue(new Error('No tab'))],
  ])('reports a restricted page when %s', async (_name, arrange) => {
    arrange();
    const calls = stubProvider();
    const panel = openPanel();
    panel.send({ type: 'summarize' });
    expect(await panel.next('error')).toMatchObject({ kind: 'restricted' });
    expect(calls).toEqual([]);
  });

  it('makes no call for a page under 200 words', async () => {
    executeScript.mockResolvedValue(extracted(Array(199).fill('word').join(' ')));
    const calls = stubProvider();
    const panel = openPanel();
    panel.send({ type: 'summarize' });
    expect(await panel.next('error')).toMatchObject({ kind: 'noContent' });
    expect(calls).toEqual([]);
  });

  it('summarizes a page of exactly 200 words', async () => {
    executeScript.mockResolvedValue(extracted(Array(200).fill('word').join(' ')));
    stubProvider();
    const panel = openPanel();
    panel.send({ type: 'summarize' });
    expect(await panel.next('done')).toMatchObject({ status: 'complete' });
  });

  it('shows a cached summary with no call and no page read', async () => {
    const calls = stubProvider();
    const panel = openPanel();
    panel.send({ type: 'summarize' });
    await panel.next('done');
    executeScript.mockClear();
    panel.send({ type: 'summarize' });
    await vi.waitFor(() => expect(panel.messages.filter(({ type }) => type === 'state').at(-1)).toMatchObject({ state: { summary: { status: 'complete' } } }));
    expect(calls).toHaveLength(1);
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('shows a stored refusal from the cache with no new call', async () => {
    const calls = stubProvider(sseText([stop('refusal')]));
    const panel = openPanel();
    panel.send({ type: 'summarize' });
    await panel.next('error');
    panel.send({ type: 'summarize' });
    await vi.waitFor(() => expect(panel.messages.at(-1)).toMatchObject({ state: { summary: { status: 'refused' } } }));
    expect(calls).toHaveLength(1);
  });

  it('uses one cache entry across fragment changes', async () => {
    const calls = stubProvider();
    const panel = openPanel();
    panel.send({ type: 'summarize' });
    await panel.next('done');
    tabsGet.mockResolvedValue({ id: TAB_ID, url: `${PAGE_URL}#part-2` });
    panel.send({ type: 'summarize' });
    await vi.waitFor(() => expect(panel.messages.at(-1)).toMatchObject({ type: 'state' }));
    expect(calls).toHaveLength(1);
    expect(Object.keys((await readTab(TAB_ID))!.summaries)).toEqual([shortKey()]);
  });

  it('calls again on retry, using the page text it already has', async () => {
    const calls = stubProvider();
    const panel = openPanel();
    panel.send({ type: 'summarize' });
    await panel.next('done');
    panel.send({ type: 'retry' });
    await panel.next('done', 2);
    expect(calls).toHaveLength(2);
    expect(executeScript).toHaveBeenCalledOnce();
  });

  it('generates at a new level, and uses the cache when it returns to an old one', async () => {
    const calls = stubProvider();
    const panel = openPanel();
    panel.send({ type: 'summarize' });
    await panel.next('done');
    panel.send({ type: 'setLevel', level: 'medium' });
    await panel.next('done', 2);
    expect(calls[1]?.body.system).toMatch(/grouped under short headings/);
    expect(stateOf(await openPanel().next('state')).level).toBe('medium');
    panel.send({ type: 'setLevel', level: 'short' });
    await vi.waitFor(() => expect(panel.messages.at(-1)).toMatchObject({ state: { level: 'short', summary: { status: 'complete' } } }));
    expect(calls).toHaveLength(2);
  });

  it('marks a page with video in the state', async () => {
    executeScript.mockResolvedValue(extracted(PAGE_TEXT, { hasVideo: true }));
    stubProvider();
    const panel = openPanel();
    panel.send({ type: 'summarize' });
    await panel.next('done');
    expect(stateOf(await openPanel().next('state')).videoExcluded).toBe(true);
  });

  describe('a page over the model limit', () => {
    const longPage = `${'word '.repeat(600_000)}\n\n${'word '.repeat(600_000)}`.trim();

    beforeEach(() => executeScript.mockResolvedValue(extracted(longPage)));

    it('asks to confirm with a token estimate, and makes no call', async () => {
      const calls = stubProvider();
      const panel = openPanel();
      await panel.next('state');
      panel.send({ type: 'summarize' });
      const state = stateOf(await panel.next('state', 2));
      expect(state.confirmTokens).toBe(Math.ceil(longPage.length / 2.5));
      expect(calls).toEqual([]);
    });

    it('splits and merges once confirmed', async () => {
      const calls = stubProvider();
      const panel = openPanel();
      panel.send({ type: 'summarize', confirmed: true });
      await panel.next('done');
      expect(calls.length).toBeGreaterThan(2);
      expect(calls.at(-1)?.body.system).toMatch(/Merge them/);
      expect(executeScript).toHaveBeenCalledOnce();
    });
  });

  it('clears chat and summarizes the page when a selection summary switches to the whole page', async () => {
    await startSelection(TAB_ID, PAGE_URL, 'Selected words.');
    await updateTab(TAB_ID, (tab) => ({ ...tab!, chat: [{ role: 'user', text: 'About the selection' }] }));
    const calls = stubProvider();
    const panel = openPanel();
    panel.send({ type: 'summarize', wholePage: true });
    await panel.next('done');
    const tab = await readTab(TAB_ID);
    expect(tab).toMatchObject({ scope: 'page', chat: [], source: { kind: 'page' } });
    expect(tab?.selectionText).toBeUndefined();
    expect(calls[0]?.body.messages[0]?.content).toContain('word249');
  });

  it('summarizes the selection when the tab is in selection scope, with no word minimum', async () => {
    await startSelection(TAB_ID, PAGE_URL, 'Just a few selected words.');
    const calls = stubProvider();
    const panel = openPanel();
    panel.send({ type: 'summarize' });
    await panel.next('done');
    expect(calls[0]?.body.messages[0]?.content).toContain('Just a few selected words.');
    expect(executeScript).not.toHaveBeenCalled();
    expect((await readTab(TAB_ID))?.summaries[summaryKey(PAGE_URL, 'selection', 'short', 'claude-haiku-5-5')]?.status).toBe('complete');
  });

  it('starts fresh on a new URL, keeping that tab\'s other summaries', async () => {
    const oldKey = shortKey('https://example.com/old');
    await updateTab(TAB_ID, () => ({
      url: 'https://example.com/old',
      scope: 'page',
      chat: [{ role: 'user', text: 'Old' }],
      source: { kind: 'page', text: 'Old page', videoExcluded: false },
      summaries: { [oldKey]: { text: 'Old', status: 'complete' } },
    }));
    const calls = stubProvider();
    const panel = openPanel();
    panel.send({ type: 'summarize' });
    await panel.next('done');
    const tab = await readTab(TAB_ID);
    expect(tab).toMatchObject({ url: PAGE_URL, chat: [] });
    expect(tab?.summaries[oldKey]?.text).toBe('Old');
    expect(calls[0]?.body.messages[0]?.content).toContain('word249');
  });

  it.each([
    ['refused', 'refused', 'refused'],
    ['max_tokens', 'cutoff', 'incomplete'],
  ])('keeps the text on a %s stop, reports %s, and stores it as %s', async (reason, kind, status) => {
    stubProvider(sseText([textDelta('Partial'), stop(reason === 'refused' ? 'refusal' : reason)]));
    const panel = openPanel();
    panel.send({ type: 'summarize' });
    expect(await panel.next('error')).toEqual({ type: 'error', stream: 'summary', kind });
    expect((await readTab(TAB_ID))?.summaries[shortKey()]).toEqual({ text: 'Partial', status });
  });

  it('stores a refusal with no text, so the panel can show it after reopening', async () => {
    stubProvider(sseText([stop('refusal')]));
    const panel = openPanel();
    panel.send({ type: 'summarize' });
    await panel.next('error');
    expect((await readTab(TAB_ID))?.summaries[shortKey()]).toEqual({ text: '', status: 'refused' });
  });

  it('stores nothing and makes one call when the provider fails before any text', async () => {
    const calls = stubProvider(new Response('{}', { status: 529 }));
    const panel = openPanel();
    panel.send({ type: 'summarize' });
    expect(await panel.next('error')).toMatchObject({ kind: 'unavailable' });
    expect(calls).toHaveLength(1);
    expect((await readTab(TAB_ID))?.summaries).toEqual({});
  });

  const runRequests: Record<string, PanelRequest> = {
    summarize: { type: 'summarize' },
    retry: { type: 'retry' },
    chat: { type: 'chat', text: 'Why?' },
    setLevel: { type: 'setLevel', level: 'medium' },
  };

  it.each([...RUN_REQUESTS])('answers a %s request with started before anything else', async (type) => {
    stubProvider();
    const panel = openPanel();
    await panel.next('state');
    panel.send(runRequests[type]!);
    await vi.waitFor(() => expect(panel.messages.length).toBeGreaterThan(1));
    expect(panel.messages[1]).toEqual({ type: 'started', requested: true });
    await panel.next('done');
  });

  it('tells the panel a requested run has started, before anything else from that run', async () => {
    stubProvider();
    const panel = openPanel();
    await panel.next('state');
    panel.send({ type: 'summarize' });
    await panel.next('done');
    expect(panel.messages.map(({ type }) => type)).toEqual(['state', 'started', 'state', 'delta', 'done']);
    expect(panel.messages[1]).toEqual({ type: 'started', requested: true });
  });

  describe('a run in progress', () => {
    async function startHeld() {
      const held = heldReply();
      const calls = stubProvider(held.response);
      const panel = openPanel();
      panel.send({ type: 'summarize' });
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      held.abortOn(calls[0]!.signal!);
      return { held, panel, calls };
    }

    it('saves the text as incomplete while it arrives, and at most every 500ms', async () => {
      let now = 10_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      const { held, panel } = await startHeld();
      const stored = () => readTab(TAB_ID).then((tab) => tab?.summaries[shortKey()]);

      held.write(textDelta('One'));
      await panel.next('delta');
      await vi.waitFor(async () => expect(await stored()).toEqual({ text: 'One', status: 'incomplete' }));

      held.write(textDelta(' two'));
      await panel.next('delta', 2);
      expect(await stored()).toEqual({ text: 'One', status: 'incomplete' });

      now = 10_500;
      held.write(textDelta(' three'));
      await panel.next('delta', 3);
      await vi.waitFor(async () => expect(await stored()).toEqual({ text: 'One two three', status: 'incomplete' }));

      held.write(stop('end_turn'));
      await panel.next('done');
      expect(await stored()).toEqual({ text: 'One two three', status: 'complete' });
    });

    it('keeps the worker alive during a run, and stops once it ends', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const { held, panel } = await startHeld();
      vi.advanceTimersByTime(20_000);
      expect(getPlatformInfo).toHaveBeenCalledOnce();
      held.write(textDelta('Done'), stop('end_turn'));
      await panel.next('done');
      vi.advanceTimersByTime(60_000);
      expect(getPlatformInfo).toHaveBeenCalledOnce();
    });

    it('stop ends the call, keeps the text as incomplete, and reports done', async () => {
      const { held, panel, calls } = await startHeld();
      held.write(textDelta('Partial'));
      await panel.next('delta');
      panel.send({ type: 'stop' });
      expect(await panel.next('done')).toEqual({ type: 'done', stream: 'summary', status: 'incomplete' });
      expect(calls[0]?.signal?.aborted).toBe(true);
      expect(panel.messages.some(({ type }) => type === 'error')).toBe(false);
      expect((await readTab(TAB_ID))?.summaries[shortKey()]).toEqual({ text: 'Partial', status: 'incomplete' });
    });

    it('stores nothing when stopped before any text', async () => {
      const { panel } = await startHeld();
      panel.send({ type: 'stop' });
      await panel.next('done');
      expect((await readTab(TAB_ID))?.summaries).toEqual({});
    });

    it('closing the panel ends the call, stores incomplete, and sends nothing more', async () => {
      const { held, panel, calls } = await startHeld();
      held.write(textDelta('Partial'));
      await panel.next('delta');
      const before = panel.messages.length;
      panel.close();
      await vi.waitFor(() => expect(calls[0]?.signal?.aborted).toBe(true));
      await vi.waitFor(async () =>
        expect((await readTab(TAB_ID))?.summaries[shortKey()]).toEqual({ text: 'Partial', status: 'incomplete' }),
      );
      expect(panel.messages).toHaveLength(before);
    });

    it('shows the partial text and makes no call when the panel reopens after closing', async () => {
      const { held, panel, calls } = await startHeld();
      held.write(textDelta('Partial'));
      await panel.next('delta');
      panel.close();
      await vi.waitFor(async () => expect((await readTab(TAB_ID))?.summaries[shortKey()]?.status).toBe('incomplete'));
      const state = stateOf(await openPanel().next('state'));
      expect(state.summary).toEqual({ text: 'Partial', status: 'incomplete' });
      expect(calls).toHaveLength(1);
    });

    it('a new request ends the run before it starts another', async () => {
      const { held, panel, calls } = await startHeld();
      held.write(textDelta('First'));
      await panel.next('delta');
      panel.send({ type: 'retry' });
      await panel.next('done', 2);
      expect(calls[0]?.signal?.aborted).toBe(true);
      expect(calls).toHaveLength(2);
      expect((await readTab(TAB_ID))?.summaries[shortKey()]).toEqual({ text: 'Default', status: 'complete' });
    });

    it('a change to a cached level ends the run, so its text cannot join the cached summary', async () => {
      const panel = openPanel();
      stubProvider(sseText([textDelta('Short text'), stop('end_turn')]));
      panel.send({ type: 'summarize' });
      await panel.next('done');
      const held = heldReply();
      const calls = stubProvider(held.response);
      panel.send({ type: 'setLevel', level: 'medium' });
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      held.abortOn(calls[0]!.signal!);
      panel.send({ type: 'setLevel', level: 'short' });
      await vi.waitFor(() => expect(calls[0]?.signal?.aborted).toBe(true));
      await vi.waitFor(() =>
        expect(panel.messages.at(-1)).toMatchObject({ state: { level: 'short', summary: { text: 'Short text' } } }),
      );
    });

    it('deleting the key ends the run that uses it', async () => {
      const { held, panel, calls } = await startHeld();
      held.write(textDelta('Partial'));
      await panel.next('delta');
      panel.send({ type: 'deleteKey' });
      await vi.waitFor(() => expect(calls[0]?.signal?.aborted).toBe(true));
      await vi.waitFor(async () => expect(await fakeBrowser.storage.local.get('keys')).toEqual({ keys: {} }));
    });

    it('deleting the key ends runs in other tabs and in the popup', async () => {
      const otherTab = heldReply();
      const popup = heldReply();
      const calls = stubProvider(otherTab.response, popup.response);
      tabsGet.mockImplementation(async (id: number) => ({ id, url: PAGE_URL }));
      const panel = openPanel();
      panel.send({ type: 'summarize' });
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      otherTab.abortOn(calls[0]!.signal!);
      const selection = openSelection();
      selection.send({ type: 'summarizeSelection', text: 'Selected words.' });
      await vi.waitFor(() => expect(calls).toHaveLength(2));
      popup.abortOn(calls[1]!.signal!);
      const otherPanel = connect(`panel:${TAB_ID + 1}`);
      otherPanel.send({ type: 'deleteKey' });
      await vi.waitFor(() => expect(calls.map(({ signal }) => signal?.aborted)).toEqual([true, true]));
    });

    it('stop with no run in progress does nothing', async () => {
      const panel = openPanel();
      await panel.next('state');
      panel.send({ type: 'stop' });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(panel.messages).toHaveLength(1);
    });

    it('closing a tab ends its run and deletes its data', async () => {
      const { held, panel, calls } = await startHeld();
      held.write(textDelta('Partial'));
      await panel.next('delta');
      await fakeBrowser.tabs.onRemoved.trigger(TAB_ID, { windowId: 1, isWindowClosing: false });
      expect(calls[0]?.signal?.aborted).toBe(true);
      await vi.waitFor(async () => expect(await readTab(TAB_ID)).toBeUndefined());
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(await readTab(TAB_ID)).toBeUndefined();
    });
  });

  describe('while the page is still being read', () => {
    function holdPageRead() {
      let finishRead!: (result: unknown) => void;
      executeScript.mockReturnValue(new Promise((resolve) => (finishRead = resolve)));
      return () => finishRead(extracted());
    }

    it.each([
      ['stop', (panel: ReturnType<typeof connect>) => panel.send({ type: 'stop' })],
      ['closing the panel', (panel: ReturnType<typeof connect>) => panel.close()],
    ])('%s prevents the call', async (_name, end) => {
      const finishRead = holdPageRead();
      const calls = stubProvider();
      const panel = openPanel();
      panel.send({ type: 'summarize' });
      await vi.waitFor(() => expect(executeScript).toHaveBeenCalledOnce());
      end(panel);
      finishRead();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(calls).toEqual([]);
      expect((await readTab(TAB_ID))?.summaries).toEqual({});
    });

    it('stop reports done, with no error', async () => {
      const finishRead = holdPageRead();
      stubProvider();
      const panel = openPanel();
      panel.send({ type: 'summarize' });
      await vi.waitFor(() => expect(executeScript).toHaveBeenCalledOnce());
      panel.send({ type: 'stop' });
      finishRead();
      expect(await panel.next('done')).toEqual({ type: 'done', stream: 'summary', status: 'incomplete' });
    });

    it.each([
      ['closing the panel', (panel: ReturnType<typeof connect>) => panel.close()],
      ['stop', (panel: ReturnType<typeof connect>) => panel.send({ type: 'stop' })],
    ])('%s also stops a request waiting behind the run', async (_name, end) => {
      const finishRead = holdPageRead();
      const calls = stubProvider();
      const panel = openPanel();
      panel.send({ type: 'summarize' });
      await vi.waitFor(() => expect(executeScript).toHaveBeenCalledOnce());
      panel.send({ type: 'retry' });
      end(panel);
      finishRead();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calls).toEqual([]);
      expect(panel.messages.some(({ type }) => type === 'delta')).toBe(false);
      expect(panel.messages.some(({ status }) => status === 'complete')).toBe(false);
      expect((await readTab(TAB_ID))?.summaries).toEqual({});
    });

    it('closing the panel right after a level change makes no call, and keeps the new level', async () => {
      const calls = stubProvider();
      const panel = openPanel();
      await panel.next('state');
      panel.send({ type: 'setLevel', level: 'medium' });
      panel.close();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calls).toEqual([]);
      expect(stateOf(await openPanel().next('state')).level).toBe('medium');
    });

    it.each(['a long page', 'a short page', 'an unreadable page'])(
      'stop answers with done, whatever the read of %s returns later',
      async (page) => {
        let finishRead!: (result: unknown) => void;
        executeScript.mockReturnValue(new Promise((resolve) => (finishRead = resolve)));
        stubProvider();
        const panel = openPanel();
        await panel.next('state');
        panel.send({ type: 'summarize' });
        await vi.waitFor(() => expect(executeScript).toHaveBeenCalledOnce());
        panel.send({ type: 'stop' });
        expect(await panel.next('done')).toEqual({ type: 'done', stream: 'summary', status: 'incomplete' });
        finishRead(
          page === 'a long page'
            ? extracted('word '.repeat(1_300_000).trim())
            : page === 'a short page'
              ? extracted('few words')
              : [{ result: null }],
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(panel.messages.filter(({ type }) => !['state', 'started', 'done'].includes(type))).toEqual([]);
        expect(panel.messages.filter(({ type }) => type === 'state')).toHaveLength(1);
      },
    );

    it('stop and key deletion do not wait for a page read that never ends', async () => {
      executeScript.mockReturnValue(new Promise(() => undefined));
      stubProvider();
      const panel = openPanel();
      await panel.next('state');
      panel.send({ type: 'summarize' });
      await vi.waitFor(() => expect(executeScript).toHaveBeenCalledOnce());
      panel.send({ type: 'stop' });
      expect(await panel.next('done')).toMatchObject({ status: 'incomplete' });
      panel.send({ type: 'summarize' });
      await vi.waitFor(() => expect(executeScript).toHaveBeenCalledTimes(2));
      panel.send({ type: 'deleteKey' });
      await vi.waitFor(async () => expect(await fakeBrowser.storage.local.get('keys')).toEqual({ keys: {} }));
    });

    it('chat is also stopped before its call', async () => {
      const finishRead = holdPageRead();
      const calls = stubProvider();
      const panel = openPanel();
      panel.send({ type: 'chat', text: 'Why?' });
      await vi.waitFor(() => expect(executeScript).toHaveBeenCalledOnce());
      panel.send({ type: 'stop' });
      finishRead();
      expect(await panel.next('done')).toEqual({ type: 'done', stream: 'chat', status: 'incomplete' });
      expect(calls).toEqual([]);
    });
  });

  describe('after a model switch', () => {
    async function summarizeThenSwitch() {
      stubProvider(sseText([textDelta('Haiku text'), stop('end_turn')]));
      const panel = openPanel();
      panel.send({ type: 'summarize' });
      await panel.next('done');
      panel.send({ type: 'setModel', modelId: 'claude-opus-5-5' });
      return panel;
    }

    it('sends no stored summary while a run is in progress, so the run keeps the screen', async () => {
      stubProvider(sseText([textDelta('Haiku text'), stop('end_turn')]));
      const panel = openPanel();
      panel.send({ type: 'summarize' });
      await panel.next('done');
      const held = heldReply();
      const calls = stubProvider(held.response);
      panel.send({ type: 'retry' });
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      panel.send({ type: 'setModel', modelId: 'claude-opus-5-5' });
      await switched(panel, 'claude-opus-5-5');
      const state = stateOf(panel.messages.at(-1)!);
      expect(state.summary).toBeUndefined();
      expect(state.summaryModelId).toBeUndefined();
      held.end();
    });

    it('keeps the summary on screen and names the model that wrote it', async () => {
      const panel = await summarizeThenSwitch();
      await vi.waitFor(() =>
        expect(panel.messages.at(-1)).toMatchObject({
          state: {
            modelId: 'claude-opus-5-5',
            summaryModelId: 'claude-haiku-5-5',
            summary: { text: 'Haiku text', status: 'complete' },
          },
        }),
      );
    });

    const switched = (panel: ReturnType<typeof connect>, modelId: string) =>
      vi.waitFor(() => expect(panel.messages.at(-1)).toMatchObject({ type: 'state', state: { modelId } }));

    it('shows the same summary when the panel reopens, with no call', async () => {
      const panel = await summarizeThenSwitch();
      await switched(panel, 'claude-opus-5-5');
      const calls = stubProvider();
      const state = stateOf(await openPanel().next('state'));
      expect(state).toMatchObject({ modelId: 'claude-opus-5-5', summaryModelId: 'claude-haiku-5-5' });
      expect(state.summary?.text).toBe('Haiku text');
      expect(calls).toEqual([]);
    });

    it('prefers the summary of the current model when both exist', async () => {
      const panel = await summarizeThenSwitch();
      await switched(panel, 'claude-opus-5-5');
      stubProvider(sseText([textDelta('Opus text'), stop('end_turn')]));
      panel.send({ type: 'summarize' });
      await panel.next('done', 2);
      panel.send({ type: 'setModel', modelId: 'claude-haiku-5-5' });
      await vi.waitFor(() =>
        expect(panel.messages.at(-1)).toMatchObject({
          state: { modelId: 'claude-haiku-5-5', summaryModelId: 'claude-haiku-5-5', summary: { text: 'Haiku text' } },
        }),
      );
    });

    it('keeps the summary that was on screen when switching on to a third model', async () => {
      const panel = await summarizeThenSwitch();
      await switched(panel, 'claude-opus-5-5');
      stubProvider(sseText([textDelta('Opus text'), stop('end_turn')]));
      panel.send({ type: 'summarize' });
      await panel.next('done', 2);
      panel.send({ type: 'setModel', modelId: 'claude-haiku-5-5' });
      await switched(panel, 'claude-haiku-5-5');
      panel.send({ type: 'setModel', modelId: 'claude-sonnet-5-5' });
      await vi.waitFor(() =>
        expect(panel.messages.at(-1)).toMatchObject({
          state: { modelId: 'claude-sonnet-5-5', summaryModelId: 'claude-haiku-5-5', summary: { text: 'Haiku text' } },
        }),
      );
      expect(stateOf(await openPanel().next('state')).summary?.text).toBe('Haiku text');
    });

    it('does not show a summary from another level', async () => {
      const panel = await summarizeThenSwitch();
      await vi.waitFor(() => expect(panel.messages.at(-1)).toMatchObject({ state: { modelId: 'claude-opus-5-5' } }));
      await fakeBrowser.storage.local.set({
        settings: { provider: 'anthropic', modelByProvider: { anthropic: 'claude-opus-5-5' }, level: 'eli5' },
      });
      expect(stateOf(await openPanel().next('state')).summary).toBeUndefined();
    });
  });

  it('switching to the whole page during a selection chat leaves the page source and no old chat', async () => {
    await startSelection(TAB_ID, PAGE_URL, 'Selected words.');
    const held = heldReply();
    const calls = stubProvider(held.response);
    const panel = openPanel();
    panel.send({ type: 'chat', text: 'About the selection?' });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    held.abortOn(calls[0]!.signal!);
    held.write(textDelta('Partial'));
    await vi.waitFor(() => expect(panel.messages).toContainEqual({ type: 'delta', stream: 'chat', text: 'Partial' }));
    panel.send({ type: 'summarize', wholePage: true });
    await panel.next('done', 2);
    expect(await readTab(TAB_ID)).toMatchObject({ scope: 'page', chat: [], source: { kind: 'page' } });
  });

  it('closing a tab with no run deletes its data', async () => {
    await updateTab(TAB_ID, () => ({ url: PAGE_URL, scope: 'page', chat: [], summaries: {} }));
    await fakeBrowser.tabs.onRemoved.trigger(TAB_ID, { windowId: 1, isWindowClosing: false });
    await vi.waitFor(async () => expect(await readTab(TAB_ID)).toBeUndefined());
  });

  it('ends the earlier runs when requests arrive together, so only the last one makes a call that stays open', async () => {
    const signals: AbortSignal[] = [];
    const lastReply = heldReply();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, { signal }: RequestInit) => {
        signals.push(signal!);
        signal!.throwIfAborted();
        if (signals.length === 2) return lastReply.response;
        return new Promise<Response>((_resolve, reject) => {
          signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
        });
      }),
    );
    const panel = openPanel();
    panel.send({ type: 'summarize' });
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    panel.send({ type: 'retry' });
    panel.send({ type: 'retry' });
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    expect(signals.map(({ aborted }) => aborted)).toEqual([true, false]);
    lastReply.write(textDelta('Last'), stop('end_turn'));
    await vi.waitFor(() => expect(panel.messages).toContainEqual({ type: 'done', stream: 'summary', status: 'complete' }));
    expect((await readTab(TAB_ID))?.summaries[shortKey()]).toEqual({ text: 'Last', status: 'complete' });
  });

  it.each([
    ['summary', { type: 'summarize' }],
    ['chat', { type: 'chat', text: 'Why?' }],
    ['key check', { type: 'saveKey', key: KEY }],
  ])('reports and logs an unexpected failure in the %s', async (_name, request) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected')));
    const panel = openPanel();
    panel.send(request);
    expect(await panel.next('error')).toEqual({ type: 'error', kind: 'unavailable' });
    expect(log).toHaveBeenCalledOnce();
  });

  it('reports a failure to read the state when the panel connects', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(fakeBrowser.storage.local, 'get').mockRejectedValue(new Error('Unexpected'));
    expect(await openPanel().next('error')).toEqual({ type: 'error', kind: 'unavailable' });
    expect(log).toHaveBeenCalledOnce();
  });

  it('reports a storage failure instead of hanging, and logs it', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stubProvider();
    const panel = openPanel();
    await panel.next('state');
    vi.spyOn(fakeBrowser.storage.session, 'set').mockRejectedValue(new Error('disk full'));
    panel.send({ type: 'summarize' });
    expect(await panel.next('error')).toMatchObject({ kind: 'unavailable' });
    expect(log).toHaveBeenCalledOnce();
  });
});

describe('chat', () => {
  beforeEach(saveStoredKey);

  async function panelWithSummary(...replies: string[]) {
    const calls = stubProvider(sseText([textDelta('Summary'), stop('end_turn')]), ...replies);
    const panel = openPanel();
    panel.send({ type: 'summarize' });
    await panel.next('done');
    return { calls, panel };
  }

  it('answers from the page, streams on the chat stream, and stores both messages', async () => {
    const { calls, panel } = await panelWithSummary(sseText([textDelta('Answer'), stop('end_turn')]));
    panel.send({ type: 'chat', text: 'Why?' });
    expect(await panel.next('done', 2)).toEqual({ type: 'done', stream: 'chat', status: 'complete' });
    expect(panel.messages).toContainEqual({ type: 'delta', stream: 'chat', text: 'Answer' });
    expect(calls[1]?.body.system).toContain('word249');
    expect((await readTab(TAB_ID))?.chat).toEqual([
      { role: 'user', text: 'Why?' },
      { role: 'assistant', text: 'Answer' },
    ]);
  });

  it('sends earlier messages with the next question', async () => {
    const { calls, panel } = await panelWithSummary();
    panel.send({ type: 'chat', text: 'First?' });
    await panel.next('done', 2);
    panel.send({ type: 'chat', text: 'Second?' });
    await panel.next('done', 3);
    expect(calls[2]?.body.messages.map(({ content }) => content)).toEqual(['First?', 'Default', 'Second?']);
  });

  it('reads the page again at no token cost when the stored text was evicted', async () => {
    const { calls, panel } = await panelWithSummary();
    await updateTab(TAB_ID, ({ source: _source, ...tab } = {} as never) => tab);
    executeScript.mockClear();
    panel.send({ type: 'chat', text: 'Why?' });
    await panel.next('done', 2);
    expect(executeScript).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(2);
  });

  it('rebuilds an evicted selection from the selected text, not the page', async () => {
    await startSelection(TAB_ID, PAGE_URL, 'Selected words here.');
    await updateTab(TAB_ID, ({ source: _source, ...tab } = {} as never) => tab);
    const calls = stubProvider();
    const panel = openPanel();
    panel.send({ type: 'chat', text: 'Why?' });
    await panel.next('done');
    expect(calls[0]?.body.system).toContain('Selected words here.');
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('asks for a key when none is saved', async () => {
    await fakeBrowser.storage.local.remove('keys');
    const panel = openPanel();
    panel.send({ type: 'chat', text: 'Why?' });
    expect(await panel.next('error')).toEqual({ type: 'error', stream: 'chat', kind: 'noKey' });
  });

  it('reports a restricted page when the tab URL cannot be read', async () => {
    tabsGet.mockResolvedValue({ id: TAB_ID });
    const panel = openPanel();
    panel.send({ type: 'chat', text: 'Why?' });
    expect(await panel.next('error')).toEqual({ type: 'error', stream: 'chat', kind: 'restricted' });
  });

  it('reports a restricted page when it cannot read the content', async () => {
    executeScript.mockRejectedValue(new Error('Cannot access'));
    const panel = openPanel();
    panel.send({ type: 'chat', text: 'Why?' });
    expect(await panel.next('error')).toEqual({ type: 'error', stream: 'chat', kind: 'restricted' });
  });

  it('reports a failure and stores nothing', async () => {
    const { panel } = await panelWithSummary();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 429 })));
    panel.send({ type: 'chat', text: 'Why?' });
    expect(await panel.next('error')).toEqual({ type: 'error', stream: 'chat', kind: 'rate' });
    expect((await readTab(TAB_ID))?.chat).toEqual([]);
  });

  it('keeps a partial answer when the provider cuts it off', async () => {
    const { panel } = await panelWithSummary(sseText([textDelta('Half an answer'), stop('max_tokens')]));
    panel.send({ type: 'chat', text: 'Why?' });
    expect(await panel.next('error')).toEqual({ type: 'error', stream: 'chat', kind: 'cutoff' });
    expect((await readTab(TAB_ID))?.chat).toEqual([
      { role: 'user', text: 'Why?' },
      { role: 'assistant', text: 'Half an answer' },
    ]);
  });

  it('keeps a partial answer when stopped', async () => {
    const { panel } = await panelWithSummary();
    const held = heldReply();
    const fetchStub = vi.fn(async (_url: string, init: RequestInit) => {
      held.abortOn(init.signal!);
      return held.response;
    });
    vi.stubGlobal('fetch', fetchStub);
    panel.send({ type: 'chat', text: 'Why?' });
    await vi.waitFor(() => expect(fetchStub).toHaveBeenCalledOnce());
    held.write(textDelta('Partial'));
    await vi.waitFor(() => expect(panel.messages).toContainEqual({ type: 'delta', stream: 'chat', text: 'Partial' }));
    panel.send({ type: 'stop' });
    expect(await panel.next('done', 2)).toEqual({ type: 'done', stream: 'chat', status: 'incomplete' });
    expect((await readTab(TAB_ID))?.chat).toEqual([
      { role: 'user', text: 'Why?' },
      { role: 'assistant', text: 'Partial' },
    ]);
  });

  it('stores nothing when stopped before any answer', async () => {
    const { panel } = await panelWithSummary();
    const held = heldReply();
    const fetchStub = vi.fn(async (_url: string, init: RequestInit) => {
      held.abortOn(init.signal!);
      return held.response;
    });
    vi.stubGlobal('fetch', fetchStub);
    panel.send({ type: 'chat', text: 'Why?' });
    await vi.waitFor(() => expect(fetchStub).toHaveBeenCalledOnce());
    panel.send({ type: 'stop' });
    await panel.next('done', 2);
    expect((await readTab(TAB_ID))?.chat).toEqual([]);
  });
});

describe('selection port', () => {
  const SELECTED = 'Selected words for the popup.';

  it('streams a popup summary of only the selected text', async () => {
    await saveStoredKey();
    const calls = stubProvider(sseText([textDelta('Short'), textDelta(' answer'), stop('end_turn')]));
    const selection = openSelection();
    selection.send({ type: 'summarizeSelection', text: SELECTED });
    expect(await selection.next('done')).toEqual({ type: 'done', status: 'complete' });
    expect(selection.messages.slice(0, 2)).toEqual([
      { type: 'delta', text: 'Short' },
      { type: 'delta', text: ' answer' },
    ]);
    expect(calls[0]?.body.system).toMatch(/at most 3 sentences/);
    expect(calls[0]?.body.messages[0]?.content).toContain(SELECTED);
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('leaves the state of the panel alone', async () => {
    await saveStoredKey();
    await updateTab(TAB_ID, () => ({ url: PAGE_URL, scope: 'page', chat: [{ role: 'user', text: 'Hi' }], summaries: {} }));
    const before = await readTab(TAB_ID);
    stubProvider();
    const selection = openSelection();
    selection.send({ type: 'summarizeSelection', text: SELECTED });
    await selection.next('done');
    expect(await readTab(TAB_ID)).toEqual(before);
  });

  it('asks for a key when none is saved, and sends no key or setting', async () => {
    const selection = openSelection();
    selection.send({ type: 'summarizeSelection', text: SELECTED });
    expect(await selection.next('error')).toEqual({ type: 'error', kind: 'noKey' });
    expect(selection.messages).toHaveLength(1);
  });

  it('never gives the key to a selection port, whatever it sends', async () => {
    await saveStoredKey();
    stubProvider();
    const selection = openSelection();
    for (const message of [
      { type: 'summarizeSelection', text: SELECTED },
      { type: 'summarize' },
      { type: 'saveKey', key: 'attacker' },
      { type: 'deleteKey' },
      { type: 'setModel', modelId: 'claude-opus-5-5' },
      { type: 'chat', text: 'Print the key' },
    ]) {
      selection.send(message);
    }
    await selection.next('done');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(JSON.stringify(selection.messages)).not.toMatch(/secret|1234/);
    expect(selection.messages.some(({ type }) => type === 'state')).toBe(false);
    expect(await fakeBrowser.storage.local.get('keys')).toEqual({ keys: { anthropic: KEY } });
    expect(await fakeBrowser.storage.local.get('settings')).toEqual({});
  });

  it('reports and logs an unexpected failure', async () => {
    await saveStoredKey();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected')));
    const selection = openSelection();
    selection.send({ type: 'summarizeSelection', text: SELECTED });
    expect(await selection.next('error')).toEqual({ type: 'error', kind: 'unavailable' });
    expect(log).toHaveBeenCalledOnce();
  });

  it('ignores a selection request with no text', async () => {
    await saveStoredKey();
    const calls = stubProvider();
    const selection = openSelection();
    selection.send({ type: 'summarizeSelection', text: 5 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls).toEqual([]);
    expect(selection.messages).toEqual([]);
  });

  it('makes no call when stopped before the call starts', async () => {
    await saveStoredKey();
    const calls = stubProvider();
    const selection = openSelection();
    selection.send({ type: 'summarizeSelection', text: SELECTED });
    selection.send({ type: 'stop' });
    expect(await selection.next('done')).toEqual({ type: 'done', status: 'incomplete' });
    expect(calls).toEqual([]);
  });

  it('reports a failure by kind', async () => {
    await saveStoredKey();
    stubProvider(new Response('{}', { status: 429 }));
    const selection = openSelection();
    selection.send({ type: 'summarizeSelection', text: SELECTED });
    expect(await selection.next('error')).toEqual({ type: 'error', kind: 'rate' });
  });

  it.each([
    ['stop', (port: ReturnType<typeof connect>) => port.send({ type: 'stop' })],
    ['closing the port', (port: ReturnType<typeof connect>) => port.close()],
  ])('ends the call on %s', async (_name, end) => {
    await saveStoredKey();
    const held = heldReply();
    const calls = stubProvider(held.response);
    const selection = openSelection();
    selection.send({ type: 'summarizeSelection', text: SELECTED });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    held.abortOn(calls[0]!.signal!);
    held.write(textDelta('Partial'));
    await selection.next('delta');
    end(selection);
    await vi.waitFor(() => expect(calls[0]?.signal?.aborted).toBe(true));
  });

  it('uses the tab from the sender, so one tab cannot stop another', async () => {
    await saveStoredKey();
    const held = heldReply();
    const calls = stubProvider(held.response);
    const selection = openSelection();
    selection.send({ type: 'summarizeSelection', text: SELECTED });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    held.abortOn(calls[0]!.signal!);
    const other = connect('selection', { tab: { id: TAB_ID + 1 } });
    other.send({ type: 'stop', tabId: TAB_ID });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls[0]?.signal?.aborted).toBe(false);
    held.write(textDelta('Done'), stop('end_turn'));
    await selection.next('done');
  });
});

describe('toolbar click', () => {
  it('enables the panel on that tab only and opens it, before any wait', () => {
    onClicked.fire({ id: TAB_ID });
    expect(setOptions).toHaveBeenLastCalledWith({ tabId: TAB_ID, path: `sidepanel.html?tabId=${TAB_ID}`, enabled: true });
    expect(sidePanelOpen).toHaveBeenCalledExactlyOnceWith({ tabId: TAB_ID });
  });

  it('does not open a panel for a tab with no id', () => {
    setOptions.mockClear();
    onClicked.fire({});
    expect(setOptions).not.toHaveBeenCalled();
    expect(sidePanelOpen).not.toHaveBeenCalled();
  });

  it('logs a panel that fails to open', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    sidePanelOpen.mockRejectedValue(new Error('No active side panel'));
    onClicked.fire({ id: TAB_ID });
    await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());
  });
});

describe('opening the panel from the page', () => {
  const SELECTED = 'The selected words about light reactions.';
  // Earlier tests leave panels open on the shared tab, so these use a tab with none.
  const LONE_TAB = 30;
  const fromPage = (message: unknown, tab: { id?: number; url?: string } = { id: LONE_TAB, url: `${PAGE_URL}#part` }) =>
    onMessage.fire(message, { tab });

  it('enables and opens the panel on that tab before any wait', () => {
    fromPage({ type: 'openPanel', text: SELECTED });
    expect(setOptions).toHaveBeenCalledExactlyOnceWith({ tabId: LONE_TAB, path: `sidepanel.html?tabId=${LONE_TAB}`, enabled: true });
    expect(sidePanelOpen).toHaveBeenCalledExactlyOnceWith({ tabId: LONE_TAB });
  });

  it('starts a selection for the page, without its fragment', async () => {
    fromPage({ type: 'openPanel', text: SELECTED });
    await vi.waitFor(async () =>
      expect(await readTab(LONE_TAB)).toMatchObject({ url: PAGE_URL, scope: 'selection', selectionText: SELECTED, chat: [] }),
    );
  });

  it('lets the panel that opens summarize the selection when it asks', async () => {
    await saveStoredKey();
    const calls = stubProvider();
    fromPage({ type: 'openPanel', text: SELECTED });
    await vi.waitFor(async () => expect((await readTab(LONE_TAB))?.scope).toBe('selection'));
    expect(calls).toEqual([]);

    const panel = connect(`panel:${LONE_TAB}`);
    const state = stateOf(await panel.next('state'));
    expect(state).toMatchObject({ scope: 'selection', chat: [] });
    expect(state.summary).toBeUndefined();
    panel.send({ type: 'summarize' });
    await panel.next('done');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.messages[0]!.content).toContain(SELECTED);
    expect(calls[0]!.body.messages[0]!.content).not.toContain(PAGE_TEXT);
    panel.close();
  });

  it('switches a panel already open to the selection and summarizes it', async () => {
    await saveStoredKey();
    const calls = stubProvider();
    const panel = openPanel();
    await panel.next('state');
    fromPage({ type: 'openPanel', text: SELECTED }, { id: TAB_ID, url: PAGE_URL });
    expect(await panel.next('started')).toEqual({ type: 'started', requested: false });
    expect(stateOf(await panel.next('state', 2))).toMatchObject({ scope: 'selection', chat: [] });
    expect(panel.messages.findIndex(({ type }) => type === 'started')).toBe(1);
    expect(await panel.next('done')).toMatchObject({ stream: 'summary', status: 'complete' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.messages[0]!.content).toContain(SELECTED);
  });

  it('reports an unexpected failure of that summary to the open panel, so it does not wait forever', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await saveStoredKey();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected')));
    const panel = openPanel();
    await panel.next('state');
    fromPage({ type: 'openPanel', text: SELECTED }, { id: TAB_ID, url: PAGE_URL });
    expect(await panel.next('error')).toEqual({ type: 'error', kind: 'unavailable' });
    expect(log).toHaveBeenCalledOnce();
    panel.close();
  });

  describe('for a popup failure the menu can fix', () => {
    const fixable = (failure: unknown, tab = { id: TAB_ID, url: PAGE_URL }) =>
      fromPage({ type: 'openPanel', text: SELECTED, failure }, tab);

    it('opens a panel already open on the failure and the selection, with no call', async () => {
      await saveStoredKey();
      const calls = stubProvider();
      const panel = openPanel();
      await panel.next('state');
      fixable('refused');
      const state = stateOf(await panel.next('state', 2));
      expect(state).toMatchObject({ scope: 'selection', failure: 'refused', chat: [] });
      expect(state.summary).toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(calls).toEqual([]);
      expect(panel.messages.some(({ type }) => type === 'started')).toBe(false);
    });

    it('ends a run in the open panel first', async () => {
      await saveStoredKey();
      const held = heldReply();
      const calls = stubProvider(held.response);
      const panel = openPanel();
      panel.send({ type: 'summarize' });
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      held.abortOn(calls[0]!.signal!);
      fixable('auth');
      await vi.waitFor(() => expect(panel.messages.at(-1)).toMatchObject({ type: 'state', state: { failure: 'auth' } }));
      expect(calls[0]!.signal!.aborted).toBe(true);
    });

    it('gives the failure to a panel that opens later, until the next summary', async () => {
      await saveStoredKey();
      const calls = stubProvider();
      fixable('modelGone', { id: LONE_TAB, url: PAGE_URL });
      await vi.waitFor(async () => expect((await readTab(LONE_TAB))?.failure).toBe('modelGone'));
      const panel = connect(`panel:${LONE_TAB}`);
      expect(stateOf(await panel.next('state')).failure).toBe('modelGone');
      panel.send({ type: 'summarize' });
      await panel.next('done');
      expect(calls).toHaveLength(1);
      expect((await readTab(LONE_TAB))?.failure).toBeUndefined();
      expect(stateOf(await connect(`panel:${LONE_TAB}`).next('state')).failure).toBeUndefined();
      panel.close();
    });

    it.each([
      ['a failure Retry fixes', 'rate'],
      ['an unknown failure', 'whatever'],
      ['a name from the object prototype', 'constructor'],
    ])('summarizes as usual for %s', async (_name, failure) => {
      await saveStoredKey();
      const calls = stubProvider();
      const panel = openPanel();
      await panel.next('state');
      fixable(failure);
      await panel.next('done');
      expect(calls).toHaveLength(1);
      expect((await readTab(TAB_ID))?.failure).toBeUndefined();
    });
  });

  it('logs a selection that cannot be stored', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(fakeBrowser.storage.session, 'set').mockRejectedValue(new Error('Storage is broken'));
    fromPage({ type: 'openPanel', text: SELECTED });
    await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());
  });

  it.each([
    ['another message', { type: 'other', text: SELECTED }, { id: LONE_TAB, url: PAGE_URL }],
    ['no text', { type: 'openPanel' }, { id: LONE_TAB, url: PAGE_URL }],
    ['no message', undefined, { id: LONE_TAB, url: PAGE_URL }],
    ['no tab id', { type: 'openPanel', text: SELECTED }, { url: PAGE_URL }],
    ['no tab URL', { type: 'openPanel', text: SELECTED }, { id: LONE_TAB }],
  ])('ignores %s', async (_name, message, tab) => {
    fromPage(message, tab);
    expect(sidePanelOpen).not.toHaveBeenCalled();
    expect(await readTab(LONE_TAB)).toBeUndefined();
  });
});

describe('navigation', () => {
  const otherKey = shortKey('https://example.com/other');
  const done = { text: 'Summary', status: 'complete' as const };

  async function openWithSummary() {
    await updateTab(TAB_ID, () => ({
      url: PAGE_URL,
      scope: 'selection',
      selectionText: 'Selected',
      chat: [{ role: 'user', text: 'Hi' }],
      source: { kind: 'selection', text: 'Selected', videoExcluded: false },
      summaries: { [shortKey()]: done, [otherKey]: done },
    }));
    const panel = openPanel();
    await panel.next('state');
    return panel;
  }

  const navigate = (url: string, status?: string) =>
    onUpdated.fire(TAB_ID, { url, ...(status && { status }) }, { id: TAB_ID, url });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

  it.each([
    ['a new page', 'https://example.com/next'],
    ['a single-page app route', 'https://example.com/article/comments'],
    ['a new query', `${PAGE_URL}?page=2`],
  ])('treats %s as a new page: tells the panel and clears the chat, with no call', async (_name, url) => {
    const calls = stubProvider();
    const panel = await openWithSummary();
    navigate(url, 'loading');
    expect(await panel.next('navigated')).toEqual({ type: 'navigated' });
    const tab = await readTab(TAB_ID);
    expect(tab).toMatchObject({ url, scope: 'page', chat: [] });
    expect(tab?.source).toBeUndefined();
    expect(tab?.selectionText).toBeUndefined();
    expect(tab?.summaries).toEqual({ [shortKey()]: done, [otherKey]: done });
    expect(calls).toEqual([]);
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('ignores a change to the fragment only', async () => {
    const panel = await openWithSummary();
    const before = await readTab(TAB_ID);
    navigate(`${PAGE_URL}#section-2`);
    await settle();
    expect(panel.messages.some(({ type }) => type === 'navigated')).toBe(false);
    expect(await readTab(TAB_ID)).toEqual(before);
  });

  it('records the page when the panel connects, so a first fragment change is still ignored', async () => {
    tabsGet.mockResolvedValue({ id: TAB_ID, url: `${PAGE_URL}#top` });
    const panel = openPanel();
    await panel.next('state');
    await vi.waitFor(async () => expect((await readTab(TAB_ID))?.url).toBe(PAGE_URL));
    navigate(`${PAGE_URL}#section-2`);
    await settle();
    expect(panel.messages.some(({ type }) => type === 'navigated')).toBe(false);
  });

  it('records a page it cannot read with no URL, so leaving it is a new page', async () => {
    tabsGet.mockResolvedValue({ id: TAB_ID });
    const panel = openPanel();
    await panel.next('state');
    await vi.waitFor(async () => expect((await readTab(TAB_ID))?.url).toBe(''));
    tabsGet.mockResolvedValue({ id: TAB_ID, url: PAGE_URL });
    navigate(PAGE_URL, 'loading');
    await panel.next('navigated');
  });

  it('counts a load of one unreadable page after another as a new page', async () => {
    tabsGet.mockResolvedValue({ id: TAB_ID });
    const panel = openPanel();
    await panel.next('state');
    await vi.waitFor(async () => expect((await readTab(TAB_ID))?.url).toBe(''));
    onUpdated.fire(TAB_ID, { status: 'loading' }, { id: TAB_ID });
    await panel.next('navigated');
  });

  it('shows nothing when the panel is closed, but still clears the old chat', async () => {
    await openWithSummary().then((panel) => panel.close());
    navigate('https://example.com/next', 'loading');
    await vi.waitFor(async () => expect((await readTab(TAB_ID))?.url).toBe('https://example.com/next'));
    expect((await readTab(TAB_ID))?.chat).toEqual([]);
  });

  it('tells only the panel of the tab that changed', async () => {
    const panel = await openWithSummary();
    const other = connect(`panel:${TAB_ID + 1}`);
    await other.next('state');
    navigate('https://example.com/next', 'loading');
    await panel.next('navigated');
    await settle();
    expect(other.messages.some(({ type }) => type === 'navigated')).toBe(false);
  });

  it('ends a run in progress, so its text is not shown on the new page', async () => {
    await saveStoredKey();
    const held = heldReply();
    const calls = stubProvider(held.response);
    const panel = openPanel();
    panel.send({ type: 'summarize' });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    held.abortOn(calls[0]!.signal!);
    held.write(textDelta('Old page text'));
    await panel.next('delta');
    navigate('https://example.com/next', 'loading');
    await panel.next('navigated');
    expect(calls[0]?.signal?.aborted).toBe(true);
    const navigatedAt = panel.messages.findIndex(({ type }) => type === 'navigated');
    expect(panel.messages.slice(navigatedAt + 1).some(({ type }) => type === 'delta')).toBe(false);
  });

  it('treats a load of a page it cannot read, such as chrome://, as a new page, and the next readable page too', async () => {
    const panel = await openWithSummary();
    tabsGet.mockResolvedValue({ id: TAB_ID });
    onUpdated.fire(TAB_ID, { status: 'loading' }, { id: TAB_ID });
    await panel.next('navigated');
    expect((await readTab(TAB_ID))?.url).toBe('');
    onUpdated.fire(TAB_ID, { status: 'complete' }, { id: TAB_ID });
    await settle();
    expect(panel.messages.filter(({ type }) => type === 'navigated')).toHaveLength(1);
    navigate(PAGE_URL, 'loading');
    await panel.next('navigated', 2);
  });

  it('ignores a tab it has no record of', async () => {
    navigate('https://example.com/next', 'loading');
    await settle();
    expect(await readTab(TAB_ID)).toBeUndefined();
  });

  it('keeps the summaries, page text, and chat when the page reloads', async () => {
    const panel = await openWithSummary();
    const before = await readTab(TAB_ID);
    onUpdated.fire(TAB_ID, { status: 'loading' }, { id: TAB_ID, url: PAGE_URL });
    await settle();
    expect(await readTab(TAB_ID)).toEqual(before);
    expect(panel.messages.some(({ type }) => type === 'navigated')).toBe(false);
  });

  it('logs a failure to handle a tab change', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(fakeBrowser.storage.session, 'get').mockRejectedValue(new Error('Unexpected'));
    navigate('https://example.com/next', 'loading');
    await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());
  });
});
