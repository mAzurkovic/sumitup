import { RUN_REQUESTS, type PanelMessage, type PanelRequest, type PanelState, type StreamName, type WorkerErrorKind } from '@/lib/messages';
import type { ChatMessage } from '@/lib/providers/types';

export type Status =
  | 'needsKey'
  | 'newPage'
  | 'ready'
  | 'confirmLong'
  | 'waiting'
  | 'streaming'
  | 'complete'
  | 'incomplete'
  | 'noContent'
  | 'error';

export type Settings = Pick<PanelState, 'keyEnding' | 'modelId' | 'level' | 'scope'>;

export interface PanelError {
  kind: WorkerErrorKind;
  stream?: StreamName;
  /** The unanswered question, so Retry can ask it again. */
  question?: string;
}

export interface Summary {
  text: string;
  modelId?: string;
}

export interface Panel {
  status: Status;
  /** Undefined until the worker's first state arrives. */
  settings?: Settings;
  summary?: Summary;
  /** The summary a new request replaced. A failure brings it back, because a failure never removes text. */
  hidden?: { summary: Summary; status: 'complete' | 'incomplete' | 'error' };
  videoExcluded: boolean;
  confirmTokens?: number;
  error?: PanelError;
  chat: ChatMessage[];
  /** The chat answer while it streams in. */
  reply?: string;
  /** The panel asks for a summary with no click when it first opens, and right after a key is saved. */
  startPending: boolean;
  /** A popup failure opened the panel to fix it, so the model and key menu opens with no click. */
  openMenu?: boolean;
  /**
   * Requests sent whose run has not started yet. Until it starts, stream messages come from the run it replaces,
   * and the panel drops them.
   */
  unstarted: number;
}

export type PanelEvent = PanelMessage | { type: 'requested'; request: PanelRequest } | { type: 'cancel' } | { type: 'disconnected' };

export const initialPanel: Panel = { status: 'waiting', videoExcluded: false, chat: [], startPending: false, unstarted: 0 };

const cleared = {
  summary: undefined,
  hidden: undefined,
  error: undefined,
  confirmTokens: undefined,
  reply: undefined,
  openMenu: undefined,
} as const;

function needsKey(panel: Panel): Panel {
  return { ...panel, ...cleared, status: 'needsKey', chat: [], startPending: false };
}

function applyState(panel: Panel, { chat, videoExcluded, confirmTokens, summary, summaryModelId, failure, ...settings }: PanelState): Panel {
  const next = { ...panel, settings, videoExcluded };
  if (!settings.keyEnding) return needsKey(next);
  // A run is writing to the screen, or about to, so only the settings change, as after a model switch mid-stream.
  if (panel.status === 'streaming' || panel.reply !== undefined || panel.unstarted) return next;

  // A failure on screen stays until something replaces it, so a model switch or reconnect keeps its message.
  const restored = { ...next, chat };
  if (confirmTokens !== undefined) return { ...restored, ...cleared, status: 'confirmLong', confirmTokens };
  if (summary?.text) {
    const shown = { ...restored, error: undefined, summary: { text: summary.text, modelId: summaryModelId } };
    if (summary.status === 'refused') return { ...shown, status: 'error', error: { kind: 'refused' } };
    return { ...shown, status: summary.status };
  }
  if (failure) return { ...restored, ...cleared, status: 'error', error: { kind: failure }, startPending: false, openMenu: true };
  if (!panel.settings || panel.status === 'needsKey') return { ...restored, ...cleared, status: 'waiting', startPending: true };
  // Only "More" on the page changes the scope from outside, and the worker then starts that summary.
  if (settings.scope !== panel.settings.scope) return { ...restored, ...cleared, status: 'waiting' };
  return restored;
}

function applyChatError(panel: Panel, kind: WorkerErrorKind): Panel {
  const question = panel.chat.at(-1)?.text;
  // The worker keeps a turn only when some answer arrived.
  const chat: ChatMessage[] = panel.reply
    ? [...panel.chat, { role: 'assistant', text: panel.reply }]
    : panel.chat.slice(0, -1);
  return { ...panel, chat, reply: undefined, error: { kind, stream: 'chat', ...(!panel.reply && { question }) } };
}

function applyError(panel: Panel, kind: WorkerErrorKind, stream?: StreamName): Panel {
  if (kind === 'noKey') return needsKey(panel);
  if (panel.status === 'needsKey') return { ...panel, error: { kind } };
  if (stream === 'chat') return applyChatError(panel, kind);
  const settled = { ...panel, reply: undefined, confirmTokens: undefined, hidden: undefined };
  if (panel.status === 'waiting' && panel.hidden) return { ...settled, ...panel.hidden, error: { kind } };
  if (!panel.summary) {
    const status = kind === 'restricted' || kind === 'noContent' ? 'noContent' : 'error';
    return { ...settled, status, error: { kind } };
  }
  // A failure never removes text already on screen. Text cut off mid-stream is simply Incomplete.
  if (kind === 'cutoff' && panel.status === 'streaming') return { ...settled, status: 'incomplete', error: undefined };
  if (panel.status === 'streaming') return { ...settled, status: 'error', error: { kind } };
  return { ...settled, error: { kind } };
}

/** Waits for a new summary, keeping the one on screen out of sight in case the request fails. */
function wait(panel: Panel): Panel {
  const { summary, status } = panel;
  const shown = status === 'complete' || status === 'incomplete' || status === 'error';
  const hidden =
    summary && (shown || status === 'streaming')
      ? { summary, status: status === 'streaming' ? ('incomplete' as const) : status }
      : panel.hidden;
  return { ...panel, ...cleared, hidden, status: 'waiting', startPending: false };
}

function applyRequest(panel: Panel, request: PanelRequest): Panel {
  switch (request.type) {
    case 'summarize':
      // The selection summary does not describe the page, so it is not kept for a whole page request.
      if (request.wholePage) return { ...wait(panel), hidden: undefined, chat: [], settings: { ...panel.settings!, scope: 'page' } };
      return wait(panel);
    case 'retry':
      return wait(panel);
    case 'setLevel':
      return { ...wait(panel), settings: { ...panel.settings!, level: request.level } };
    case 'setModel':
      return { ...panel, settings: { ...panel.settings!, modelId: request.modelId } };
    case 'chat':
      return { ...panel, error: undefined, reply: '', chat: [...panel.chat, { role: 'user', text: request.text }] };
    case 'saveKey':
      return { ...panel, error: undefined };
    case 'stop':
    case 'deleteKey':
      return panel;
  }
}

export function reduce(panel: Panel, event: PanelEvent): Panel {
  if ('stream' in event && event.stream && panel.unstarted) return panel;
  switch (event.type) {
    case 'started':
      if (event.requested) return { ...panel, unstarted: panel.unstarted - 1 };
      // The worker replaced whatever ran, after "More" on the page. A run the panel asked for replaces it in turn.
      return panel.unstarted ? panel : wait(panel);
    case 'state':
      return applyState(panel, event.state);
    case 'delta':
      if (event.stream === 'chat') return { ...panel, reply: (panel.reply ?? '') + event.text };
      return {
        ...panel,
        status: 'streaming',
        error: undefined,
        hidden: undefined,
        summary:
          panel.status === 'streaming' && panel.summary
            ? { ...panel.summary, text: panel.summary.text + event.text }
            : { text: event.text, modelId: panel.settings?.modelId },
      };
    case 'done':
      if (event.stream === 'chat') {
        const chat: ChatMessage[] = panel.reply ? [...panel.chat, { role: 'assistant', text: panel.reply }] : panel.chat;
        return { ...panel, chat, reply: undefined };
      }
      if (event.status === 'complete') return { ...panel, status: 'complete' };
      // Stop before any text leaves nothing new to show, so the panel offers a fresh start.
      return panel.status === 'streaming' ? { ...panel, status: 'incomplete' } : { ...panel, ...cleared, status: 'ready' };
    case 'error':
      return applyError(panel, event.kind, event.stream);
    case 'navigated':
      // With no key there is nothing to summarize yet, so key setup stays.
      if (panel.status === 'needsKey') return panel;
      return {
        ...panel,
        ...cleared,
        status: 'newPage',
        chat: [],
        ...(panel.settings && { settings: { ...panel.settings, scope: 'page' } }),
      };
    case 'requested': {
      const next = applyRequest(panel, event.request);
      return RUN_REQUESTS.has(event.request.type) ? { ...next, unstarted: next.unstarted + 1 } : next;
    }
    case 'cancel':
      return { ...panel, status: 'ready', confirmTokens: undefined };
    case 'disconnected':
      // A restarted worker has dropped its run and the requests it had not started. The next state shows any saved text.
      if (panel.status === 'waiting' || panel.status === 'streaming') {
        return { ...panel, status: 'ready', summary: undefined, reply: undefined, unstarted: 0 };
      }
      return { ...panel, reply: undefined, unstarted: 0 };
  }
}

export const chatOpen = ({ status, reply }: Panel) => (status === 'complete' || status === 'incomplete') && reply === undefined;
