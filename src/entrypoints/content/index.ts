import type { Browser } from 'wxt/browser';
import { FAILURES } from '@/lib/failures';
import type { OpenPanelMessage, SelectionMessage, SelectionRequest, WorkerErrorKind } from '@/lib/messages';
import theme from '@/lib/theme.css?inline';
import { countWords } from '@/lib/text';
import style from './style.css?inline';

const MIN_WORDS = 20;
const GAP = 8;

const MARK =
  '<svg viewBox="0 0 64 64" width="14" height="14" aria-hidden="true"><g fill="#fff"><rect x="13" y="10" width="38" height="7" rx="3.5"/><rect x="20" y="22" width="24" height="7" rx="3.5"/><rect x="26.5" y="34" width="11" height="7" rx="3.5"/></g><circle cx="32" cy="51" r="5.5" fill="#86efac"/></svg>';

const TEMPLATE = `<style>${theme}${style}</style>
<button class="trigger" type="button" hidden>${MARK}Sum it up!</button>
<div class="popup" role="dialog" aria-label="Sum it up!" hidden>
  <p class="text" aria-live="polite"></p>
  <p class="status"></p>
  <div class="actions"><button class="retry" type="button">Retry</button><button class="more" type="button">More</button></div>
</div>`;

/** Selecting text in a field or an editable area focuses it. */
function inEditableArea(): boolean {
  const active = document.activeElement;
  return (
    active instanceof HTMLInputElement ||
    active instanceof HTMLTextAreaElement ||
    (active instanceof HTMLElement && active.isContentEditable)
  );
}

/**
 * Places a shown element at the selection in page coordinates, so it scrolls with the text.
 * It goes above when its height fits there, and grows upward from there as text streams in.
 * Below, it stays inside the window, over the selection if the selection reaches the bottom.
 */
function place(element: HTMLElement, rect: DOMRect) {
  const { clientWidth, clientHeight } = document.documentElement;
  const above = rect.top >= element.offsetHeight + GAP;
  element.classList.toggle('above', above);
  const rightmost = clientWidth - element.offsetWidth - GAP;
  const lowest = clientHeight - element.offsetHeight - GAP;
  element.style.left = `${Math.max(GAP, Math.min(rect.left, rightmost)) + scrollX}px`;
  element.style.top = `${(above ? rect.top - GAP : Math.max(GAP, Math.min(rect.bottom + GAP, lowest))) + scrollY}px`;
}

function mountSelectionUi() {
  const host = document.createElement('sum-it-up');
  // Closed, so page scripts cannot read the popup's text or press its buttons.
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = TEMPLATE;
  const find = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const trigger = find<HTMLButtonElement>('.trigger');
  const popup = find('.popup');
  const text = find('.text');
  const status = find('.status');
  const retry = find<HTMLButtonElement>('.retry');
  const more = find<HTMLButtonElement>('.more');

  let selected = '';
  /** A failure the model and key menu can fix. The panel opens on it, with no new request. */
  let menuFailure: WorkerErrorKind | undefined;
  let selectedRect: DOMRect | undefined;
  let port: Browser.runtime.Port | undefined;

  const closePopup = () => {
    port?.disconnect();
    port = undefined;
    popup.hidden = true;
  };

  const openPanel = () => {
    const message: OpenPanelMessage = { type: 'openPanel', text: selected, ...(menuFailure && { failure: menuFailure }) };
    void browser.runtime.sendMessage(message);
    closePopup();
  };

  const showFailure = (message: SelectionMessage & { type: 'error' }) => {
    if (message.kind === 'noKey') return openPanel();
    const failure = FAILURES[message.kind];
    if (message.kind === 'cutoff' && text.textContent) {
      status.innerHTML = '<span class="tag">Incomplete</span>';
    } else {
      status.textContent = failure.message;
      status.classList.add('failure');
    }
    retry.hidden = failure.action !== 'retry';
    // The model and key menu is in the panel, so the button that opens the panel names what to do there.
    if (typeof failure.action === 'object') {
      menuFailure = message.kind;
      more.textContent = failure.action.menu;
    }
  };

  const ask = () => {
    port?.disconnect();
    text.textContent = '';
    status.textContent = 'Summarizing';
    status.classList.remove('failure');
    retry.hidden = true;
    menuFailure = undefined;
    more.textContent = 'More';
    port = browser.runtime.connect({ name: 'selection' });
    port.onMessage.addListener((raw) => {
      const message = raw as SelectionMessage;
      if (message.type === 'delta') {
        status.textContent = '';
        // Model output goes in as text only, never as markup.
        text.textContent += message.text;
      } else if (message.type === 'done') {
        status.textContent = '';
      } else {
        showFailure(message);
      }
      // The popup grows with its text, so it moves below the selection once it no longer fits above.
      if (!popup.hidden) place(popup, selectedRect!);
    });
    const request: SelectionRequest = { type: 'summarizeSelection', text: selected };
    port.postMessage(request);
  };

  // Only a real click counts, so a page script cannot spend the user's tokens.
  const onTrustedClick = (button: HTMLElement, action: () => void) =>
    button.addEventListener('click', (event) => {
      if (event.isTrusted) action();
    });

  onTrustedClick(trigger, () => {
    trigger.hidden = true;
    popup.hidden = false;
    ask();
    place(popup, selectedRect!);
  });
  onTrustedClick(retry, ask);
  onTrustedClick(more, openPanel);

  const isOutside = (event: Event) => !event.composedPath().includes(host);

  document.addEventListener('mouseup', (event) => {
    if (!isOutside(event)) return;
    trigger.hidden = true;
    const selection = getSelection();
    if (!selection?.rangeCount || selection.isCollapsed || inEditableArea()) return;
    const words = selection.toString().trim();
    if (countWords(words) < MIN_WORDS) return;
    selected = words;
    selectedRect = selection.getRangeAt(0).getBoundingClientRect();
    if (!host.isConnected) document.documentElement.append(host);
    trigger.hidden = false;
    place(trigger, selectedRect);
  });
  document.addEventListener(
    'mousedown',
    (event) => {
      if (!isOutside(event)) return;
      trigger.hidden = true;
      closePopup();
    },
    true,
  );
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    trigger.hidden = true;
    closePopup();
  });
}

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  allFrames: false,
  main: mountSelectionUi,
});
