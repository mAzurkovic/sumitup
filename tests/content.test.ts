// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import contentScript from '../src/entrypoints/content';
import type { SelectionMessage, SelectionRequest } from '../src/lib/messages';

const words = (count: number) => Array.from({ length: count }, (_, i) => `word${i}`).join(' ');

interface FakePort {
  sent: SelectionRequest[];
  receive: (message: SelectionMessage) => void;
  disconnect: ReturnType<typeof vi.fn>;
}

let ports: FakePort[] = [];
const connect = vi.fn((_info: { name: string }) => {
  const listeners: ((message: unknown) => void)[] = [];
  const port: FakePort = { sent: [], receive: (message) => listeners.forEach((listener) => listener(message)), disconnect: vi.fn() };
  ports.push(port);
  return {
    onMessage: { addListener: (listener: (message: unknown) => void) => listeners.push(listener) },
    postMessage: (request: SelectionRequest) => port.sent.push(request),
    disconnect: port.disconnect,
  };
});
const sendMessage = vi.fn(async (_message: unknown) => undefined);

let shadow: ShadowRoot;
let shadowMode: string;
const attachShadow = Element.prototype.attachShadow;
const rect = { top: 0, bottom: 0, left: 0 };
let popupHeight = 100;

const find = <T extends HTMLElement>(selector: string) => shadow.querySelector<T>(selector)!;
const trigger = () => find<HTMLButtonElement>('.trigger');
const popup = () => find('.popup');
const popupText = () => find('.text').textContent;
const popupStatus = () => find('.status');
const retry = () => find<HTMLButtonElement>('.retry');
const port = () => ports.at(-1)!;

function select(node: Node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  getSelection()!.removeAllRanges();
  getSelection()!.addRange(range);
}

/** Selects the text of a new paragraph and releases the mouse on it. */
function selectText(text: string, parent: HTMLElement = document.body) {
  const paragraph = document.createElement('p');
  paragraph.textContent = text;
  parent.append(paragraph);
  select(paragraph);
  paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  return paragraph;
}

function trustedClick(element: HTMLElement) {
  const event = new MouseEvent('click', { bubbles: true, composed: true });
  Object.defineProperty(event, 'isTrusted', { value: true });
  element.dispatchEvent(event);
}

function openPopup(text = words(25)) {
  selectText(text);
  trustedClick(trigger());
}

const press = (key: string) => document.dispatchEvent(new KeyboardEvent('keydown', { key }));

beforeAll(() => {
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init: ShadowRootInit) {
    shadowMode = init.mode;
    shadow = attachShadow.call(this, init);
    return shadow;
  });
  vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(() => ({ ...rect }) as DOMRect);
  // The button and the popup measure as this tall, since the test page has no layout.
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('popup') ? popupHeight : 30;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('popup') ? 320 : 110;
  });
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1000);
  vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(800);
  contentScript.main(undefined as never);
});

beforeEach(() => {
  vi.clearAllMocks();
  ports = [];
  Object.assign(rect, { top: 300, bottom: 320, left: 100 });
  popupHeight = 100;
  Object.assign(fakeBrowser.runtime, { connect, sendMessage });
});

afterEach(() => {
  press('Escape');
  getSelection()!.removeAllRanges();
  document.body.replaceChildren();
});

describe('selection button', () => {
  it('stays off the page until text is selected', () => {
    expect(document.querySelector('sum-it-up')).toBeNull();
  });

  it('appears for 20 selected words, in a closed shadow root at the page root', () => {
    selectText(words(20));
    expect(trigger().hidden).toBe(false);
    expect(trigger().textContent).toBe('Sum it up!');
    expect(shadowMode).toBe('closed');
    expect(document.documentElement.lastElementChild?.tagName).toBe('SUM-IT-UP');
  });

  it('does not appear for 19 words', () => {
    selectText(words(19));
    expect(trigger().hidden).toBe(true);
  });

  it('hides when a later selection is too short', () => {
    selectText(words(25));
    selectText(words(3));
    expect(trigger().hidden).toBe(true);
  });

  it('does not appear for a click with no selection', () => {
    selectText(words(25));
    getSelection()!.removeAllRanges();
    document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(trigger().hidden).toBe(true);
  });

  it('does not appear for text in an input field', () => {
    const field = document.createElement('textarea');
    document.body.append(field);
    field.focus();
    selectText(words(25));
    expect(trigger().hidden).toBe(true);
  });

  it('does not appear for text in an editable area', () => {
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    document.body.append(editor);
    editor.focus();
    selectText(words(25), editor);
    expect(trigger().hidden).toBe(true);
  });

  it('sits above the selection when there is room', () => {
    Object.assign(rect, { top: 300, bottom: 320, left: 100 });
    selectText(words(25));
    expect(trigger().classList.contains('above')).toBe(true);
    expect([trigger().style.top, trigger().style.left]).toEqual(['292px', '100px']);
  });

  it('sits above the selection when exactly its height fits', () => {
    Object.assign(rect, { top: 38, bottom: 58, left: 100 });
    selectText(words(25));
    expect(trigger().classList.contains('above')).toBe(true);
  });

  it('sits below the selection when its height does not fit above, and inside the left edge', () => {
    Object.assign(rect, { top: 10, bottom: 30, left: -50 });
    selectText(words(25));
    expect(trigger().classList.contains('above')).toBe(false);
    expect([trigger().style.top, trigger().style.left]).toEqual(['38px', '8px']);
  });

  it('stays inside the right edge for a selection near it', () => {
    Object.assign(rect, { top: 300, bottom: 320, left: 950 });
    selectText(words(25));
    expect(trigger().style.left).toBe(`${1000 - 110 - 8}px`);
  });

  it('appears for text on the page while some other element has focus', () => {
    const link = document.createElement('a');
    link.href = '#';
    document.body.append(link);
    link.focus();
    selectText(words(25));
    expect(trigger().hidden).toBe(false);
  });

  it('makes no call for a click from a page script', () => {
    selectText(words(25));
    trigger().click();
    expect(connect).not.toHaveBeenCalled();
    expect(popup().hidden).toBe(true);
  });
});

describe('popup', () => {
  it('opens on a real click and asks for a summary of the selected text only', () => {
    const selected = words(25);
    openPopup(selected);
    expect(trigger().hidden).toBe(true);
    expect(popup().hidden).toBe(false);
    expect(connect).toHaveBeenCalledExactlyOnceWith({ name: 'selection' });
    expect(port().sent).toEqual([{ type: 'summarizeSelection', text: selected }]);
    expect(popupStatus().textContent).toBe('Summarizing');
  });

  it('opens below the selection when its height does not fit above', () => {
    Object.assign(rect, { top: 107, bottom: 127, left: 100 });
    openPopup();
    expect(popup().classList.contains('above')).toBe(false);
    expect(popup().style.top).toBe('135px');
  });

  it('opens above the selection when its height fits', () => {
    Object.assign(rect, { top: 184, bottom: 220, left: 100 });
    openPopup();
    expect(popup().classList.contains('above')).toBe(true);
    expect(popup().style.top).toBe('176px');
  });

  it('moves below the selection once its text no longer fits above', () => {
    Object.assign(rect, { top: 184, bottom: 220, left: 100 });
    openPopup();
    popupHeight = 150;
    port().receive({ type: 'delta', text: 'First sentence.' });
    expect(popup().classList.contains('above')).toBe(true);
    popupHeight = 190;
    port().receive({ type: 'delta', text: ' Second and third sentences.' });
    expect(popup().classList.contains('above')).toBe(false);
    expect(popup().style.top).toBe('228px');
  });

  it('does not place a popup that a failure closed', () => {
    openPopup();
    const top = popup().style.top;
    popupHeight = 400;
    port().receive({ type: 'error', kind: 'noKey' });
    expect(popup().style.top).toBe(top);
  });

  it('shows streamed text as text, never as markup', () => {
    openPopup();
    port().receive({ type: 'delta', text: '<img src="x" onerror="alert(1)">' });
    port().receive({ type: 'delta', text: ' done.' });
    expect(popupText()).toBe('<img src="x" onerror="alert(1)"> done.');
    expect(shadow.querySelector('.text img')).toBeNull();
    expect(popupStatus().textContent).toBe('');
  });

  it('clears the status when the summary finishes', () => {
    openPopup();
    port().receive({ type: 'done', status: 'complete' });
    expect(popupStatus().textContent).toBe('');
  });

  it('opens the panel for key setup when no key is saved', () => {
    const selected = words(25);
    openPopup(selected);
    port().receive({ type: 'error', kind: 'noKey' });
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({ type: 'openPanel', text: selected });
    expect(popup().hidden).toBe(true);
    expect(port().disconnect).toHaveBeenCalledOnce();
  });

  it('shows a failure with Retry, and asks again on a real click', () => {
    openPopup();
    const first = port();
    first.receive({ type: 'error', kind: 'rate' });
    expect(popupStatus().textContent).toBe('Provider limit reached');
    expect(popupStatus().classList.contains('failure')).toBe(true);
    expect(retry().hidden).toBe(false);
    retry().click();
    expect(connect).toHaveBeenCalledOnce();
    trustedClick(retry());
    expect(first.disconnect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(port().sent).toEqual(first.sent);
    expect(popupStatus().textContent).toBe('Summarizing');
    expect(popupStatus().classList.contains('failure')).toBe(false);
    expect(retry().hidden).toBe(true);
  });

  it('shows a failure with no Retry when retrying cannot help', () => {
    openPopup();
    port().receive({ type: 'error', kind: 'noContent' });
    expect(popupStatus().textContent).toBe('Not enough text to summarize');
    expect(retry().hidden).toBe(true);
    expect(find('.more').textContent).toBe('More');
  });

  it.each([
    ['auth', 'API key rejected', 'Check your key'],
    ['modelGone', 'Model unavailable', 'Choose another model'],
    ['refused', 'Provider declined this content', 'Choose another model'],
  ] as const)('shows a %s failure with a button that opens the panel on it, with no new request', (kind, message, action) => {
    const selected = words(25);
    openPopup(selected);
    port().receive({ type: 'error', kind });
    expect(popupStatus().textContent).toBe(message);
    expect(retry().hidden).toBe(true);
    expect(find('.more').textContent).toBe(action);
    trustedClick(find('.more'));
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({ type: 'openPanel', text: selected, failure: kind });
  });

  it('opens the panel for a new summary on "More" after a failure that Retry fixed', () => {
    const selected = words(25);
    openPopup(selected);
    port().receive({ type: 'error', kind: 'auth' });
    press('Escape');
    openPopup(selected);
    trustedClick(find('.more'));
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({ type: 'openPanel', text: selected });
  });

  it('stays inside the bottom edge for a selection that reaches it', () => {
    Object.assign(rect, { top: 10, bottom: 790, left: 100 });
    openPopup();
    expect(popup().classList.contains('above')).toBe(false);
    expect(popup().style.top).toBe(`${800 - 100 - 8}px`);
  });

  it('stays inside the top edge when the window is shorter than the popup', () => {
    Object.assign(rect, { top: 10, bottom: 30, left: 100 });
    popupHeight = 900;
    openPopup();
    expect(popup().style.top).toBe('8px');
  });

  it('names the panel button "More" again when the popup asks again', () => {
    openPopup();
    port().receive({ type: 'error', kind: 'auth' });
    press('Escape');
    openPopup();
    expect(find('.more').textContent).toBe('More');
  });

  it('stays inside the right edge when it opens near it', () => {
    Object.assign(rect, { top: 300, bottom: 320, left: 900 });
    openPopup();
    expect(popup().style.left).toBe(`${1000 - 320 - 8}px`);
  });

  it('keeps cut-off text, labeled Incomplete, with Retry', () => {
    openPopup();
    port().receive({ type: 'delta', text: 'Partial' });
    port().receive({ type: 'error', kind: 'cutoff' });
    expect(popupText()).toBe('Partial');
    expect(popupStatus().querySelector('.tag')?.textContent).toBe('Incomplete');
    expect(retry().hidden).toBe(false);
  });

  it('opens the panel with the selection on "More", and stops the popup summary', () => {
    const selected = words(25);
    openPopup(selected);
    find('.more').click();
    expect(sendMessage).not.toHaveBeenCalled();
    trustedClick(find('.more'));
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({ type: 'openPanel', text: selected });
    expect(popup().hidden).toBe(true);
    expect(port().disconnect).toHaveBeenCalledOnce();
  });

  it('closes on Esc and stops its summary', () => {
    openPopup();
    press('Enter');
    expect(popup().hidden).toBe(false);
    press('Escape');
    expect(popup().hidden).toBe(true);
    expect(port().disconnect).toHaveBeenCalledOnce();
  });

  it('closes on a click outside it', () => {
    openPopup();
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(popup().hidden).toBe(true);
    expect(port().disconnect).toHaveBeenCalledOnce();
  });

  it('stays open for a click inside it', () => {
    openPopup();
    find('.text').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
    find('.text').dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }));
    expect(popup().hidden).toBe(false);
    expect(port().disconnect).not.toHaveBeenCalled();
  });

  it('hides the button on Esc too', () => {
    selectText(words(25));
    press('Escape');
    expect(trigger().hidden).toBe(true);
  });
});
