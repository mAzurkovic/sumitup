// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { App } from '../src/entrypoints/sidepanel/App';
import { Markdown } from '../src/entrypoints/sidepanel/Markdown';
import { RUN_REQUESTS, type PanelMessage, type PanelRequest, type PanelState, type WorkerErrorKind } from '../src/lib/messages';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const TAB_ID = 7;

interface FakePort {
  name: string;
  sent: PanelRequest[];
  receive: (message: PanelMessage) => Promise<void>;
  drop: () => Promise<void>;
  disconnect: ReturnType<typeof vi.fn>;
}

let ports: FakePort[] = [];
const connect = vi.fn(({ name }: { name: string }) => {
  const messageListeners: ((message: unknown) => void)[] = [];
  const disconnectListeners: (() => void)[] = [];
  let unstarted = 0;
  const port: FakePort = {
    name,
    sent: [],
    // As the worker does, each requested run starts before anything else reaches the panel.
    receive: (message) =>
      act(async () => {
        const started: PanelMessage[] = Array.from({ length: unstarted }, () => ({ type: 'started', requested: true }));
        unstarted = 0;
        [...started, message].forEach((each) => messageListeners.forEach((listener) => listener(each)));
      }),
    drop: () => act(async () => disconnectListeners.forEach((listener) => listener())),
    disconnect: vi.fn(),
  };
  ports.push(port);
  return {
    name,
    onMessage: { addListener: (listener: (message: unknown) => void) => messageListeners.push(listener) },
    onDisconnect: { addListener: (listener: () => void) => disconnectListeners.push(listener) },
    postMessage: (request: PanelRequest) => {
      port.sent.push(request);
      if (RUN_REQUESTS.has(request.type)) unstarted++;
    },
    disconnect: port.disconnect,
  };
});
const sidePanelClose = vi.fn(async () => undefined);
const scrollIntoView = vi.fn();

let root: Root;
let container: HTMLElement;

const port = () => ports.at(-1)!;
const sent = () => port().sent;

const workerState = (state: Partial<PanelState> = {}): PanelMessage => ({
  type: 'state',
  state: { keyEnding: '1234', modelId: 'claude-haiku-5-5', level: 'short', scope: 'page', chat: [], videoExcluded: false, ...state },
});
const delta = (text: string, stream: 'summary' | 'chat' = 'summary'): PanelMessage => ({ type: 'delta', stream, text });
const done = (status: 'complete' | 'incomplete', stream: 'summary' | 'chat' = 'summary'): PanelMessage => ({ type: 'done', stream, status });
const failed = (kind: WorkerErrorKind, stream?: 'summary' | 'chat'): PanelMessage => ({ type: 'error', kind, ...(stream && { stream }) });

async function render(node = <App tabId={TAB_ID} />) {
  await act(() => root.render(node));
}

/** Opens the panel with a saved key, so it asks for a summary. */
async function openWaiting(state: Partial<PanelState> = {}) {
  await render();
  await port().receive(workerState(state));
}

async function openComplete(text = '- Plants make sugar.', state: Partial<PanelState> = {}) {
  await openWaiting(state);
  await port().receive(delta(text));
  await port().receive(done('complete'));
}

const text = () => container.textContent ?? '';
const query = <T extends Element = HTMLElement>(selector: string) => container.querySelector<T>(selector);
const button = (name: string) =>
  [...container.querySelectorAll('button')].find((element) => element.textContent?.trim() === name || element.getAttribute('aria-label') === name);
const chatBox = () => query<HTMLInputElement>('input[name="question"]')!;

async function click(name: string) {
  const target = button(name);
  expect(target, `button ${name}`).toBeDefined();
  await act(() => target!.click());
}

async function submit(input: HTMLInputElement, value: string) {
  input.value = value;
  await act(() => input.form!.requestSubmit());
}

async function choose(select: HTMLSelectElement, value: string) {
  select.value = value;
  await act(() => select.dispatchEvent(new Event('change', { bubbles: true })));
}

beforeEach(() => {
  fakeBrowser.reset();
  vi.clearAllMocks();
  ports = [];
  Object.assign(fakeBrowser.runtime, { connect });
  Object.assign(fakeBrowser, { sidePanel: { close: sidePanelClose } });
  Element.prototype.scrollIntoView = scrollIntoView;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

describe('connection', () => {
  it('connects on the port of its own tab', async () => {
    await render();
    expect(connect).toHaveBeenCalledExactlyOnceWith({ name: `panel:${TAB_ID}` });
  });

  it('shows nothing until the worker answers', async () => {
    await render();
    expect(container.innerHTML).toBe('');
  });

  it('connects again when the worker drops the port', async () => {
    await openWaiting();
    await port().drop();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(port().name).toBe(`panel:${TAB_ID}`);
  });

  it('closes the port when the panel goes away', async () => {
    await render();
    const first = port();
    await act(() => root.unmount());
    expect(first.disconnect).toHaveBeenCalledOnce();
    root = createRoot(container);
  });

  it('makes no request of its own after reconnecting mid-run', async () => {
    await openWaiting();
    await port().drop();
    await port().receive(workerState());
    expect(sent()).toEqual([]);
    expect(button('Sum it up')).toBeDefined();
  });
});

describe('key setup', () => {
  const openNoKey = async () => {
    await render();
    await port().receive(workerState({ keyEnding: undefined }));
  };

  it('shows the key field, key page link, notice, and Save, with no other setup', async () => {
    await openNoKey();
    expect(text()).toContain('Add an API key to start');
    expect(query('input[type="password"]')?.getAttribute('placeholder')).toBe('Paste your key');
    const link = query<HTMLAnchorElement>('a')!;
    expect([link.textContent, link.href, link.target]).toEqual([
      'Get a key from Anthropic',
      'https://console.anthropic.com/settings/keys',
      '_blank',
    ]);
    expect(text()).toContain('Page content is sent to the provider you select. Your key stays on this device.');
    expect(button('Save')).toBeDefined();
    expect(query('select')).toBeNull();
  });

  it('sends the key and starts the summary once it is accepted', async () => {
    await openNoKey();
    await submit(query<HTMLInputElement>('input[name="key"]')!, 'sk-ant-new');
    expect(sent()).toEqual([{ type: 'saveKey', key: 'sk-ant-new' }]);
    await port().receive(workerState({ keyEnding: '-new' }));
    expect(sent().at(-1)).toEqual({ type: 'summarize' });
    expect(text()).toContain('Summarizing');
  });

  it('shows why a key was rejected', async () => {
    await openNoKey();
    await port().receive(failed('auth'));
    expect(query('[role="alert"]')?.textContent).toBe('API key rejected');
  });

  it('keeps chat closed', async () => {
    await openNoKey();
    expect(chatBox().disabled).toBe(true);
    expect(chatBox().placeholder).toBe('Chat opens after the summary');
  });

  it('returns to key setup when the key is deleted', async () => {
    await openComplete();
    await click('Delete');
    expect(sent().at(-1)).toEqual({ type: 'deleteKey' });
    await port().receive(workerState({ keyEnding: undefined }));
    expect(text()).toContain('Add an API key to start');
  });
});

describe('header', () => {
  it('shows the wordmark and the page summary heading', async () => {
    await openComplete();
    expect(query('.brand')?.textContent).toBe('Sum it up!');
    expect(query('h1')?.textContent).toBe('Page summary');
  });

  it('closes the panel from the chevron', async () => {
    await openComplete();
    await click('Close panel');
    expect(sidePanelClose).toHaveBeenCalledExactlyOnceWith({ tabId: TAB_ID });
  });

  it('closes the panel from key setup too', async () => {
    await render();
    await port().receive(workerState({ keyEnding: undefined }));
    await click('Close panel');
    expect(sidePanelClose).toHaveBeenCalledOnce();
  });
});

describe('detail level', () => {
  it('offers the 4 levels in order under its label', async () => {
    await openComplete();
    const label = query('label.level')!;
    expect(label.querySelector('.label')?.textContent).toBe('Detail level');
    expect([...label.querySelectorAll('option')].map((option) => option.textContent)).toEqual(['Short', 'Medium', 'In-depth', 'ELI5']);
  });

  it('asks for the new level and waits', async () => {
    await openComplete();
    await choose(query<HTMLSelectElement>('label.level select')!, 'medium');
    expect(sent().at(-1)).toEqual({ type: 'setLevel', level: 'medium' });
    expect(text()).toContain('Summarizing');
  });
});

describe('model menu', () => {
  it('shows the model on a pill that opens the menu', async () => {
    await openComplete();
    const pill = query('.pill')!;
    expect(pill.textContent).toBe('Claude Haiku 5.5');
    expect(pill.getAttribute('popovertarget')).toBe('model-menu');
    expect(query('#model-menu')?.getAttribute('popover')).toBe('auto');
  });

  it('lists the models with the current one checked and the default marked, and the key masked to its last 4 characters', async () => {
    await openComplete();
    const menu = query('#model-menu')!;
    const models = [...menu.querySelectorAll('[role="menuitemradio"]')];
    expect(models.map((model) => [model.textContent, model.getAttribute('aria-checked')])).toEqual([
      ['Claude Haiku 5.5default', 'true'],
      ['Claude Sonnet 5.5', 'false'],
      ['Claude Opus 5.5', 'false'],
    ]);
    expect(models.map((model) => [model.getAttribute('popovertarget'), model.getAttribute('popovertargetaction')])).toEqual(
      Array(3).fill(['model-menu', 'hide']),
    );
    expect(menu.querySelector('[aria-label="Saved API key"]')?.textContent).toBe('••••••••1234');
    expect(menu.textContent).not.toContain('sk-');
  });

  it('names the model button with its label and the current model', async () => {
    await openComplete();
    const pill = query('.pill')!;
    const name = pill
      .getAttribute('aria-labelledby')!
      .split(' ')
      .map((id) => container.querySelector(`#${id}`)?.textContent)
      .join(' ');
    expect(name).toBe('Model Claude Haiku 5.5');
  });

  it('offers to summarize with the new model and keeps the summary', async () => {
    await openComplete();
    await click('Claude Sonnet 5.5');
    expect(sent().at(-1)).toEqual({ type: 'setModel', modelId: 'claude-sonnet-5-5' });
    await port().receive(
      workerState({ modelId: 'claude-sonnet-5-5', summary: { text: '- Plants make sugar.', status: 'complete' }, summaryModelId: 'claude-haiku-5-5' }),
    );
    expect(text()).toContain('Plants make sugar.');
    await click('Summarize with Claude Sonnet 5.5');
    expect(sent().at(-1)).toEqual({ type: 'summarize' });
  });

  it('offers no model switch while the summary streams', async () => {
    await openWaiting();
    await port().receive(delta('- Plants'));
    await click('Claude Opus 5.5');
    expect(button('Summarize with Claude Opus 5.5')).toBeUndefined();
  });
});

describe('summary', () => {
  it('asks for a summary when it opens with nothing stored, and shows Summarizing with Stop', async () => {
    await openWaiting();
    expect(sent()).toEqual([{ type: 'summarize' }]);
    expect(query('[role="status"]')?.textContent).toContain('Summarizing');
    expect(query('.spinner')).not.toBeNull();
    await click('Stop');
    expect(sent().at(-1)).toEqual({ type: 'stop' });
  });

  it('streams text with Stop, then completes and opens chat', async () => {
    await openWaiting();
    await port().receive(delta('- Plants'));
    await port().receive(delta(' make sugar.'));
    expect(query('li')?.textContent).toBe('Plants make sugar.');
    expect(chatBox().disabled).toBe(true);
    await click('Stop');
    expect(sent().at(-1)).toEqual({ type: 'stop' });
    await port().receive(done('complete'));
    expect(button('Stop')).toBeUndefined();
    expect(chatBox().disabled).toBe(false);
    expect(chatBox().placeholder).toBe('Ask about this page');
    expect(query('hr.divider')).not.toBeNull();
  });

  it('labels stopped text Incomplete with Retry, and keeps chat open', async () => {
    await openWaiting();
    await port().receive(delta('- Part'));
    await port().receive(done('incomplete'));
    expect(query('.tag')?.textContent).toBe('Incomplete');
    expect(chatBox().disabled).toBe(false);
    await click('Retry');
    expect(sent().at(-1)).toEqual({ type: 'retry' });
  });

  it('restores the stored summary and chat on reopen with no request', async () => {
    await render();
    const chat = [
      { role: 'user' as const, text: 'Why?' },
      { role: 'assistant' as const, text: 'Light.' },
    ];
    await port().receive(workerState({ summary: { text: '- Kept', status: 'complete' }, chat }));
    expect(sent()).toEqual([]);
    expect(text()).toContain('Kept');
    expect([...container.querySelectorAll('.message')].map((message) => message.textContent)).toEqual(['Why?', 'Light.']);
  });

  it('shows no Retry when reopened on a stored refusal', async () => {
    await render();
    await port().receive(workerState({ summary: { text: '- Some text', status: 'refused' } }));
    expect(text()).toContain('Some text');
    expect(text()).toContain('Provider declined this content');
    expect(button('Retry')).toBeUndefined();
    expect(button('Choose another model')?.getAttribute('popovertarget')).toBe('model-menu');
    expect(chatBox().disabled).toBe(true);
  });

  it('tags a summary that leaves out the video while it streams', async () => {
    await openWaiting();
    await port().receive(workerState({ videoExcluded: true }));
    expect(text()).toContain('Summarizing');
    await port().receive(delta('- Text'));
    expect(query('.tag')?.textContent).toBe('Video not included in this summary');
  });
});

describe('long page', () => {
  it('asks first with the rough token count, and continues on Continue', async () => {
    await openWaiting();
    await port().receive(workerState({ confirmTokens: 48_213 }));
    expect(text()).toContain('This page is long. Summarizing uses about 48,000 tokens on your key.');
    expect(chatBox().disabled).toBe(true);
    await click('Continue');
    expect(sent().at(-1)).toEqual({ type: 'summarize', confirmed: true });
  });

  it('offers Sum it up on Cancel with no request', async () => {
    await openWaiting();
    await port().receive(workerState({ confirmTokens: 1_200_000 }));
    await click('Cancel');
    expect(sent()).toEqual([{ type: 'summarize' }]);
    expect(text()).toContain('Sum it up?');
    await click('Sum it up');
    expect(sent().at(-1)).toEqual({ type: 'summarize' });
  });
});

describe('failures', () => {
  it.each([
    ['rate', 'Provider limit reached'],
    ['unavailable', 'Provider unavailable'],
    ['offline', 'No connection'],
    ['cutoff', 'Provider unavailable'],
    ['rejected', 'Provider rejected the request'],
  ] as const)('shows %s as "%s" with Retry', async (kind, message) => {
    await openWaiting();
    await port().receive(failed(kind, 'summary'));
    expect(query('[role="alert"]')?.textContent).toContain(message);
    await click('Retry');
    expect(sent().at(-1)).toEqual({ type: 'retry' });
  });

  it.each([
    ['auth', 'API key rejected', 'Check your key'],
    ['modelGone', 'Model unavailable', 'Choose another model'],
    ['refused', 'Provider declined this content', 'Choose another model'],
  ] as const)('shows %s as "%s" with a link to the menu', async (kind, message, link) => {
    await openWaiting();
    await port().receive(failed(kind, 'summary'));
    expect(query('[role="alert"]')?.textContent).toContain(message);
    expect(button(link)?.getAttribute('popovertarget')).toBe('model-menu');
    expect(button('Retry')).toBeUndefined();
  });

  it.each([
    ['restricted', "Sum it up can't read this page"],
    ['noContent', 'Not enough text to summarize'],
  ] as const)('shows %s as "%s" with no action', async (kind, message) => {
    await openWaiting();
    await port().receive(failed(kind, 'summary'));
    expect(query('[role="alert"]')?.textContent).toBe(message);
    expect(query('[role="alert"] button')).toBeNull();
  });

  it('opens the model and key menu with no click when it opens on a popup failure', async () => {
    // The test DOM has no popover API.
    const showPopover = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'showPopover', { value: showPopover, configurable: true });
    onTestFinished(() => {
      delete (HTMLElement.prototype as Partial<HTMLElement>).showPopover;
    });
    await openWaiting({ scope: 'selection', failure: 'refused' });
    expect(query('[role="alert"]')?.textContent).toContain('Provider declined this content');
    expect(showPopover).toHaveBeenCalledOnce();
    expect(showPopover.mock.contexts[0]).toBe(query('#model-menu'));
    expect(sent()).toEqual([]);
  });

  it('keeps the failure on screen after another model is chosen', async () => {
    await openWaiting();
    await port().receive(failed('modelGone', 'summary'));
    await click('Claude Sonnet 5.5');
    await port().receive(workerState({ modelId: 'claude-sonnet-5-5' }));
    expect(query('[role="alert"]')?.textContent).toContain('Model unavailable');
    expect(query('.pill')?.textContent).toBe('Claude Sonnet 5.5');
  });

  it('keeps the summary and shows the failure above it when a chat answer fails, then asks again on Retry', async () => {
    await openComplete();
    await submit(chatBox(), 'Why?');
    await port().receive(failed('rate', 'chat'));
    expect(text()).toContain('Plants make sugar.');
    expect(query('.banner')?.textContent).toContain('Provider limit reached');
    await click('Retry');
    expect(sent().at(-1)).toEqual({ type: 'chat', text: 'Why?' });
  });

  it('keeps the summary and chat on screen when a level change fails', async () => {
    await openComplete();
    await submit(chatBox(), 'Why?');
    await port().receive(delta('Light.', 'chat'));
    await port().receive(done('complete', 'chat'));
    await choose(query<HTMLSelectElement>('label.level select')!, 'medium');
    expect(text()).not.toContain('Plants make sugar.');
    await port().receive(failed('rate', 'summary'));
    expect(text()).toContain('Plants make sugar.');
    expect(text()).toContain('Light.');
    expect(query('.banner')?.textContent).toContain('Provider limit reached');
  });

  it('keeps refused text on screen', async () => {
    await openWaiting();
    await port().receive(delta('- Started'));
    await port().receive(failed('refused', 'summary'));
    expect(text()).toContain('Started');
    expect(query('.banner')?.textContent).toContain('Provider declined this content');
  });
});

describe('navigation', () => {
  it('clears the summary and chat and offers Sum it up for the new page', async () => {
    await openComplete();
    await port().receive({ type: 'navigated' });
    expect(text()).toContain('New page. Sum it up?');
    expect(text()).not.toContain('Plants');
    expect(chatBox().disabled).toBe(true);
    await click('Sum it up');
    expect(sent().at(-1)).toEqual({ type: 'summarize' });
  });
  it('keeps key setup when the page changes', async () => {
    await render();
    await port().receive(workerState({ keyEnding: undefined }));
    await port().receive({ type: 'navigated' });
    expect(text()).toContain('Add an API key to start');
    expect(query('input[name="key"]')).not.toBeNull();
  });
});

describe('selection', () => {
  it('names the selection and offers the whole page', async () => {
    await openComplete('- Selected', { scope: 'selection' });
    expect(query('h1')?.textContent).toBe('Selected text summary');
    expect(chatBox().placeholder).toBe('Ask about this selection');
    await click('Summarize whole page');
    expect(sent().at(-1)).toEqual({ type: 'summarize', wholePage: true });
    expect(query('h1')?.textContent).toBe('Page summary');
  });

  it('offers no scope link on a page summary', async () => {
    await openComplete();
    expect(button('Summarize whole page')).toBeUndefined();
  });
});

describe('chat', () => {
  it('sends a question, shows it, clears the box, and streams the answer', async () => {
    await openComplete();
    await submit(chatBox(), '  Why green?  ');
    expect(sent().at(-1)).toEqual({ type: 'chat', text: 'Why green?' });
    expect(chatBox().value).toBe('');
    expect(chatBox().disabled).toBe(true);
    await port().receive(delta('Chlorophyll', 'chat'));
    expect([...container.querySelectorAll('.message')].map((message) => message.className)).toEqual(['message user', 'message assistant']);
    await port().receive(done('complete', 'chat'));
    expect(container.querySelector('.message.assistant')?.textContent).toBe('Chlorophyll');
    expect(chatBox().disabled).toBe(false);
  });

  it('sends no empty question', async () => {
    await openComplete();
    await submit(chatBox(), '   ');
    expect(sent()).toEqual([{ type: 'summarize' }]);
  });

  it('scrolls each new message into view', async () => {
    await openComplete();
    expect(scrollIntoView).not.toHaveBeenCalled();
    await submit(chatBox(), 'Why?');
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(container.querySelector('.scroll')?.lastElementChild);
    await port().receive(delta('A', 'chat'));
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it('keeps the box at the bottom of the panel in every view', async () => {
    await openWaiting();
    expect(query('main')?.lastElementChild?.contains(chatBox())).toBe(true);
    await port().receive(failed('noContent', 'summary'));
    expect(query('main')?.lastElementChild?.contains(chatBox())).toBe(true);
  });
});

describe('summary text', () => {
  const renderText = async (markdown: string) => {
    await render(<Markdown text={markdown} />);
    return container;
  };

  it('renders bullets, headings, and bold', async () => {
    const output = await renderText('## Light\n- **Chlorophyll** absorbs red\n* Water splits\n\nPlain line');
    expect(output.innerHTML).toBe(
      '<h4>Light</h4><ul><li><strong>Chlorophyll</strong> absorbs red</li><li>Water splits</li></ul><p>Plain line</p>',
    );
  });

  it('keeps a bold marker that has not closed yet as text', async () => {
    expect((await renderText('- **Chloro')).innerHTML).toBe('<ul><li>**Chloro</li></ul>');
  });

  it('renders HTML, images, and links in the output as plain text', async () => {
    const output = await renderText('<img src="https://x.test/a.png" onerror="alert(1)">\n- <script>alert(1)</script>\n![pic](https://x.test/b.png) [site](https://x.test)');
    expect(output.querySelector('img, script, a, iframe')).toBeNull();
    expect(output.textContent).toContain('<script>alert(1)</script>');
    expect(output.textContent).toContain('[site](https://x.test)');
  });
});
