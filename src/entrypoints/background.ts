import type { Browser } from 'wxt/browser';
import { askChat } from '@/lib/chat';
import type {
  OpenPanelMessage,
  PanelMessage,
  PanelRequest,
  PanelState,
  SelectionMessage,
  SelectionRequest,
  WorkerErrorKind,
} from '@/lib/messages';
import { FAILURES } from '@/lib/failures';
import { defaultModel, MAX_OUTPUT, MODELS, type Model } from '@/lib/models';
import { popupPrompt, type Level } from '@/lib/prompts';
import { anthropic } from '@/lib/providers/anthropic';
import { ProviderError } from '@/lib/providers/types';
import {
  readTab,
  removeTab,
  startSelection,
  summaryKey,
  updateTab,
  type Scope,
  type Source,
  type TabState,
} from '@/lib/session';
import { isOverLimit, summarize } from '@/lib/summarize';
import { countWords, estimateTokens } from '@/lib/text';
import type { Extraction } from './extract';

type Port = Browser.runtime.Port;
type Post<T> = (message: T) => void;

interface Settings {
  provider: 'anthropic';
  modelByProvider: { anthropic?: string };
  level: Level;
}

const MIN_PAGE_WORDS = 200;
const SAVE_INTERVAL_MS = 500;
const KEEP_ALIVE_MS = 20_000;

const runs = new Map<string, { controller: AbortController; finished: Promise<void> }>();
const openPanels = new Map<number, Set<Post<PanelMessage>>>();

async function readKey(): Promise<string | undefined> {
  const { keys } = await browser.storage.local.get('keys');
  return (keys as { anthropic?: string } | undefined)?.anthropic;
}

async function readSettings(): Promise<Settings> {
  const { settings } = await browser.storage.local.get('settings');
  return (settings as Settings | undefined) ?? { provider: 'anthropic', modelByProvider: {}, level: 'short' };
}

function currentModel({ modelByProvider }: Settings): Model {
  return MODELS.find(({ id }) => id === modelByProvider.anthropic) ?? defaultModel('anthropic');
}

/** A fragment change is not a new page. */
const withoutFragment = (url: string) => url.split('#')[0]!;

/** Undefined when the tab is gone or its URL cannot be read. */
async function pageUrl(tabId: number): Promise<string | undefined> {
  const tab = await browser.tabs.get(tabId).catch(() => undefined);
  return tab?.url && withoutFragment(tab.url);
}

/** After a model switch the summary on screen stays there, with the model that wrote it. */
function shownSummary(tab: TabState | undefined, url: string, scope: Scope, level: Level, modelId: string) {
  const prefix = summaryKey(url, scope, level, '');
  const shownId = [modelId, tab?.shownModelId].find((id) => id && tab?.summaries[prefix + id]);
  return shownId ? { summary: tab!.summaries[prefix + shownId]!, summaryModelId: shownId } : undefined;
}

async function panelState(tabId: number, confirmTokens?: number): Promise<PanelState> {
  const [key, settings, url, tab] = await Promise.all([readKey(), readSettings(), pageUrl(tabId), readTab(tabId)]);
  const model = currentModel(settings);
  const current = tab && tab.url === url ? tab : undefined;
  const scope = current?.scope ?? 'page';
  const shown = url ? shownSummary(tab, url, scope, settings.level, model.id) : undefined;
  return {
    ...(key && { keyEnding: key.slice(-4) }),
    modelId: model.id,
    level: settings.level,
    scope,
    ...shown,
    chat: current?.chat ?? [],
    videoExcluded: current?.source?.videoExcluded ?? false,
    ...(confirmTokens !== undefined && { confirmTokens }),
    ...(current?.failure && { failure: current.failure }),
  };
}

const withoutSummary = ({ summary: _summary, summaryModelId: _summaryModelId, ...state }: PanelState): PanelState => state;

/**
 * Claims the slot at once, so Stop reaches a request still waiting for the earlier run to end.
 * The work starts only after that earlier run has saved its text.
 */
function startRun(slot: string, work: (signal: AbortSignal) => Promise<void>): Promise<void> {
  const previous = runs.get(slot);
  previous?.controller.abort();
  const controller = new AbortController();
  // An extension API call resets the idle timer, and part summaries can run past 30s with no message.
  const keepAlive = setInterval(() => browser.runtime.getPlatformInfo(), KEEP_ALIVE_MS);
  const finished = (previous?.finished ?? Promise.resolve())
    .then(() => work(controller.signal))
    .finally(() => {
      clearInterval(keepAlive);
      if (runs.get(slot)?.controller === controller) runs.delete(slot);
    });
  runs.set(slot, { controller, finished: finished.catch(() => undefined) });
  return finished;
}

/** A page read cannot be cancelled, so a stopped run stops waiting for it instead. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
    ),
  ]);
}

/**
 * A panel run tells the panel when it begins. Everything an earlier run in the slot posted comes before that,
 * so the panel can tell late text from a replaced run apart from the new run's text.
 */
function startPanelRun(
  post: Post<PanelMessage>,
  tabId: number,
  requested: boolean,
  work: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  return startRun(`panel:${tabId}`, (signal) => {
    post({ type: 'started', requested });
    return work(signal);
  });
}

async function stopRun(slot: string): Promise<void> {
  const run = runs.get(slot);
  run?.controller.abort();
  await run?.finished;
}

/** Undefined when Chrome blocks the page or it is a PDF. */
async function extractPage(tabId: number): Promise<Extraction | undefined> {
  const injected = await browser.scripting
    .executeScript({ target: { tabId }, files: ['/extract.js'] })
    .catch(() => undefined);
  const extraction = injected?.[0]?.result as Extraction | null | undefined;
  return extraction && !extraction.isPdf ? extraction : undefined;
}

/** Evicted text comes back here at no token cost. Undefined when the page cannot be read. */
async function readSource(tabId: number, tab: TabState): Promise<Source | undefined> {
  if (tab.source) return tab.source;
  if (tab.selectionText !== undefined) return { kind: 'selection', text: tab.selectionText, videoExcluded: false };
  const extraction = await extractPage(tabId);
  return extraction && { kind: 'page', text: extraction.text, videoExcluded: extraction.hasVideo };
}

/** Chat belongs to one page and one scope, so a change of either clears it. Summaries stay until the tab closes. */
async function tabForPage(tabId: number, url: string, wholePage: boolean): Promise<TabState> {
  await updateTab(tabId, (tab) => {
    const scope = wholePage || tab?.url !== url ? 'page' : tab.scope;
    if (tab?.url === url && tab.scope === scope) return tab;
    return { url, scope, summaries: tab?.summaries ?? {}, chat: [] };
  });
  return (await readTab(tabId))!;
}

function kindOf(error: unknown) {
  if (error instanceof ProviderError) return error.kind;
  throw error;
}

async function runSummary(
  post: Post<PanelMessage>,
  tabId: number,
  request: { retry?: boolean; confirmed?: boolean; wholePage?: boolean },
  signal: AbortSignal,
): Promise<void> {
  const step = <T>(work: Promise<T>) => untilAborted(work, signal);
  let text = '';
  // Set before the first provider call, and only text or a refusal from that call reaches it.
  let save!: (status: 'complete' | 'incomplete' | 'refused') => Promise<void>;
  try {
    const key = await step(readKey());
    if (!key) return post({ type: 'error', stream: 'summary', kind: 'noKey' });
    const url = await step(pageUrl(tabId));
    if (!url) return post({ type: 'error', stream: 'summary', kind: 'restricted' });

    const settings = await step(readSettings());
    const model = currentModel(settings);
    const tab = await step(tabForPage(tabId, url, request.wholePage ?? false));
    if (tab.failure) {
      await step(
        updateTab(tabId, (current) => {
          const { failure: _failure, ...rest } = current!;
          return rest;
        }),
      );
    }
    const cacheKey = summaryKey(url, tab.scope, settings.level, model.id);
    if (!request.retry && tab.summaries[cacheKey]) {
      return post({ type: 'state', state: await step(panelState(tabId)) });
    }

    const source = await step(readSource(tabId, tab));
    if (!source) return post({ type: 'error', stream: 'summary', kind: 'restricted' });
    if (source.kind === 'page' && countWords(source.text) < MIN_PAGE_WORDS) {
      return post({ type: 'error', stream: 'summary', kind: 'noContent' });
    }
    await step(updateTab(tabId, (current) => ({ ...current!, source })));
    if (isOverLimit(source.text, model) && !request.confirmed) {
      return post({ type: 'state', state: await step(panelState(tabId, estimateTokens(source.text))) });
    }

    // Tells the panel what this source holds, such as a left-out video, with no summary to replace its spinner.
    post({ type: 'state', state: withoutSummary(await step(panelState(tabId))) });

    save = (status) =>
      updateTab(tabId, (current) => ({
        ...current!,
        shownModelId: model.id,
        summaries: { ...current!.summaries, [cacheKey]: { text, status } },
      }));
    let savedAt = 0;
    for await (const delta of summarize({ adapter: anthropic, key, model, level: settings.level, text: source.text, signal })) {
      text += delta;
      post({ type: 'delta', stream: 'summary', text: delta });
      if (Date.now() - savedAt >= SAVE_INTERVAL_MS) {
        savedAt = Date.now();
        await save('incomplete');
      }
    }
    await save('complete');
    post({ type: 'done', stream: 'summary', status: 'complete' });
  } catch (error) {
    if (signal.aborted) {
      if (text) await save('incomplete');
      return post({ type: 'done', stream: 'summary', status: 'incomplete' });
    }
    const kind = kindOf(error);
    if (kind === 'refused') await save('refused');
    else if (text) await save('incomplete');
    post({ type: 'error', stream: 'summary', kind });
  }
}

async function runChat(post: Post<PanelMessage>, tabId: number, question: string, signal: AbortSignal): Promise<void> {
  const step = <T>(work: Promise<T>) => untilAborted(work, signal);
  const fail = (kind: 'noKey' | 'restricted') => post({ type: 'error', stream: 'chat', kind });
  let answer = '';
  const saveTurn = () =>
    updateTab(tabId, (current) => ({
      ...current!,
      chat: [...current!.chat, { role: 'user', text: question }, { role: 'assistant', text: answer }],
    }));
  try {
    const key = await step(readKey());
    if (!key) return fail('noKey');
    const url = await step(pageUrl(tabId));
    if (!url) return fail('restricted');

    const model = currentModel(await step(readSettings()));
    const tab = await step(tabForPage(tabId, url, false));
    const source = await step(readSource(tabId, tab));
    if (!source) return fail('restricted');
    await step(updateTab(tabId, (current) => ({ ...current!, source })));

    const stream = askChat({ adapter: anthropic, key, model, sourceText: source.text, history: tab.chat, question, signal });
    for await (const delta of stream) {
      answer += delta;
      post({ type: 'delta', stream: 'chat', text: delta });
    }
    await saveTurn();
    post({ type: 'done', stream: 'chat', status: 'complete' });
  } catch (error) {
    if (signal.aborted) {
      if (answer) await saveTurn();
      return post({ type: 'done', stream: 'chat', status: 'incomplete' });
    }
    const kind = kindOf(error);
    if (answer) await saveTurn();
    post({ type: 'error', stream: 'chat', kind });
  }
}

async function saveKey(post: Post<PanelMessage>, tabId: number, pasted: string): Promise<void> {
  const key = pasted.trim();
  try {
    // A character a header cannot carry would otherwise fail as a network error.
    new Headers({ 'x-api-key': key });
    if (!key) throw new TypeError('Empty key');
  } catch {
    return post({ type: 'error', kind: 'auth' });
  }
  try {
    await anthropic.validateKey(key);
  } catch (error) {
    return post({ type: 'error', kind: kindOf(error) });
  }
  await browser.storage.local.set({ keys: { anthropic: key } });
  post({ type: 'state', state: await panelState(tabId) });
}

async function changeSettings(change: Partial<Settings>): Promise<void> {
  await browser.storage.local.set({ settings: { ...(await readSettings()), ...change } });
}

async function handlePanelRequest(post: Post<PanelMessage>, tabId: number, request: PanelRequest): Promise<void> {
  const slot = `panel:${tabId}`;
  const run = (work: (signal: AbortSignal) => Promise<void>) => startPanelRun(post, tabId, true, work);
  switch (request.type) {
    case 'summarize':
      return run((signal) => runSummary(post, tabId, request, signal));
    case 'retry':
      return run((signal) => runSummary(post, tabId, { retry: true, confirmed: true }, signal));
    case 'stop':
      return stopRun(slot);
    case 'chat':
      return run((signal) => runChat(post, tabId, request.text, signal));
    case 'setLevel':
      // The new level is kept even when the summary for it is stopped before it starts.
      return run(async (signal) => {
        await changeSettings({ level: request.level });
        await runSummary(post, tabId, {}, signal);
      });
    case 'setModel': {
      const { summaryModelId } = await panelState(tabId);
      if (summaryModelId) await updateTab(tabId, (tab) => ({ ...tab!, shownModelId: summaryModelId }));
      const settings = await readSettings();
      await changeSettings({ modelByProvider: { ...settings.modelByProvider, anthropic: request.modelId } });
      const state = await panelState(tabId);
      // A run in progress decides what the screen shows, so a stored summary must not end its wait.
      return post({ type: 'state', state: runs.has(slot) ? withoutSummary(state) : state });
    }
    case 'saveKey':
      return saveKey(post, tabId, request.key);
    case 'deleteKey':
      await Promise.all([...runs.keys()].map(stopRun));
      await browser.storage.local.set({ keys: {} });
      return post({ type: 'state', state: await panelState(tabId) });
  }
}

/** Posting to a closed port throws, and a run can outlive its port by a moment. */
function poster<T>(port: Port): Post<T> {
  let open = true;
  port.onDisconnect.addListener(() => {
    open = false;
  });
  return (message) => {
    if (open) port.postMessage(message);
  };
}

function reportUnexpected(post: Post<{ type: 'error'; kind: 'unavailable' }>, error: unknown) {
  console.error(error);
  post({ type: 'error', kind: 'unavailable' });
}

function connectPanel(port: Port) {
  const tabId = Number(/^panel:(\d+)$/.exec(port.name)?.[1]);
  // Only an extension page has no sender tab. A content script must not reach the key handlers.
  if (Number.isNaN(tabId) || port.sender?.tab) return port.disconnect();

  const post = poster<PanelMessage>(port);
  const panels = openPanels.get(tabId) ?? new Set();
  openPanels.set(tabId, panels.add(post));
  port.onDisconnect.addListener(() => {
    panels.delete(post);
    void stopRun(`panel:${tabId}`);
  });
  port.onMessage.addListener((request) => {
    handlePanelRequest(post, tabId, request as PanelRequest).catch((error) => reportUnexpected(post, error));
  });
  recordPage(tabId)
    .then(() => panelState(tabId))
    .then(
      (state) => post({ type: 'state', state }),
      (error) => reportUnexpected(post, error),
    );
}

/** Navigation compares against the stored URL, so the panel stores the page it opens on, with no URL for one it cannot read. */
async function recordPage(tabId: number): Promise<void> {
  await tabForPage(tabId, (await pageUrl(tabId)) ?? '', false);
}

/** A new page keeps the tab's summaries for later, but its chat and content belong to the old page. */
async function followNavigation(tabId: number, url: string): Promise<void> {
  const stored = await readTab(tabId);
  // Pages it cannot read all have no URL, so one load of them is never the same page as the last.
  if (!stored || (url && stored.url === url)) return;
  await stopRun(`panel:${tabId}`);
  await updateTab(tabId, (tab) => ({ url, scope: 'page', summaries: tab!.summaries, chat: [] }));
  openPanels.get(tabId)?.forEach((post) => post({ type: 'navigated' }));
}

async function followTab(tabId: number, change: Browser.tabs.OnUpdatedInfo): Promise<void> {
  if (change.url) return followNavigation(tabId, withoutFragment(change.url));
  // Chrome leaves out the address of a page the extension cannot read, such as chrome://, so a load with none is a new page.
  if (change.status === 'loading' && !(await pageUrl(tabId))) return followNavigation(tabId, '');
}

/** Chrome allows open() only inside the user's click, so neither call may wait for anything first. */
function openPanelOn(tabId: number) {
  browser.sidePanel.setOptions({ tabId, path: `sidepanel.html?tabId=${tabId}`, enabled: true });
  browser.sidePanel.open({ tabId }).catch(console.error);
}

function openPanelFromToolbar(tab: Browser.tabs.Tab) {
  if (tab.id !== undefined) openPanelOn(tab.id);
}

/** A panel that opens now asks for the summary itself. One already open is told the scope changed, and gets it. */
async function summarizeInOpenPanels(tabId: number): Promise<void> {
  const panels = openPanels.get(tabId);
  if (!panels?.size) return;
  const post: Post<PanelMessage> = (message) => panels.forEach((panelPost) => panelPost(message));
  try {
    await startPanelRun(post, tabId, false, async (signal) => {
      post({ type: 'state', state: await panelState(tabId) });
      await runSummary(post, tabId, {}, signal);
    });
  } catch (error) {
    reportUnexpected(post, error);
  }
}

/** An open panel switches to the selection and shows the popup's failure, with no new request. */
async function showFailureInOpenPanels(tabId: number): Promise<void> {
  await stopRun(`panel:${tabId}`);
  const state = await panelState(tabId);
  openPanels.get(tabId)?.forEach((post) => post({ type: 'state', state }));
}

/** Only a failure fixed in the menu opens the panel on it. Anything else from the page is ignored. */
const menuFailure = (kind: unknown) =>
  typeof FAILURES[kind as WorkerErrorKind]?.action === 'object' ? (kind as WorkerErrorKind) : undefined;

function openPanelForSelection(message: unknown, sender: Browser.runtime.MessageSender) {
  const { type, text, failure: kind } = (message ?? {}) as Partial<OpenPanelMessage>;
  const tab = sender.tab;
  if (type !== 'openPanel' || typeof text !== 'string' || tab?.id === undefined || !tab.url) return;
  const tabId = tab.id;
  const failure = menuFailure(kind);
  openPanelOn(tabId);
  startSelection(tabId, withoutFragment(tab.url), text, failure)
    .then(() => (failure ? showFailureInOpenPanels(tabId) : summarizeInOpenPanels(tabId)))
    .catch(console.error);
}

async function runPopup(post: Post<SelectionMessage>, selection: string, signal: AbortSignal): Promise<void> {
  const step = <T>(work: Promise<T>) => untilAborted(work, signal);
  try {
    const key = await step(readKey());
    if (!key) return post({ type: 'error', kind: 'noKey' });
    const model = currentModel(await step(readSettings()));
    const prompt = popupPrompt(selection);
    for await (const text of anthropic.stream({ key, model, ...prompt, maxOutput: MAX_OUTPUT, signal })) {
      post({ type: 'delta', text });
    }
    post({ type: 'done', status: 'complete' });
  } catch (error) {
    if (signal.aborted) return post({ type: 'done', status: 'incomplete' });
    post({ type: 'error', kind: kindOf(error) });
  }
}

function connectSelection(port: Port) {
  const tabId = port.sender?.tab?.id;
  if (tabId === undefined) return port.disconnect();

  const slot = `selection:${tabId}`;
  const post = poster<SelectionMessage>(port);
  port.onDisconnect.addListener(() => void stopRun(slot));
  port.onMessage.addListener((request) => {
    const { type, text } = request as SelectionRequest & { text?: unknown };
    if (type === 'stop') void stopRun(slot);
    else if (type === 'summarizeSelection' && typeof text === 'string') {
      startRun(slot, (signal) => runPopup(post, text, signal)).catch((error) => reportUnexpected(post, error));
    }
  });
}

export default defineBackground(() => {
  browser.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  browser.runtime.onConnect.addListener((port) => {
    if (port.name === 'selection') connectSelection(port);
    else connectPanel(port);
  });
  browser.action.onClicked.addListener(openPanelFromToolbar);
  browser.runtime.onMessage.addListener((message, sender) => {
    openPanelForSelection(message, sender);
  });
  browser.tabs.onUpdated.addListener((tabId, change) => {
    followTab(tabId, change).catch(console.error);
  });
  browser.tabs.onRemoved.addListener(async (tabId) => {
    await Promise.all([stopRun(`panel:${tabId}`), stopRun(`selection:${tabId}`)]);
    await removeTab(tabId);
  });
});
