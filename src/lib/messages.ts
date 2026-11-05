import type { Level } from './prompts';
import type { ChatMessage, ProviderErrorKind } from './providers/types';
import type { Scope, Summary } from './session';

export type PanelRequest =
  | { type: 'summarize'; confirmed?: boolean; wholePage?: boolean }
  | { type: 'retry' }
  | { type: 'stop' }
  | { type: 'chat'; text: string }
  | { type: 'setLevel'; level: Level }
  | { type: 'setModel'; modelId: string }
  | { type: 'saveKey'; key: string }
  | { type: 'deleteKey' };

/** The requests that start a run, each answered first with `started`. */
export const RUN_REQUESTS: ReadonlySet<PanelRequest['type']> = new Set(['summarize', 'retry', 'chat', 'setLevel']);

export type SelectionRequest = { type: 'summarizeSelection'; text: string } | { type: 'stop' };

export type WorkerErrorKind = ProviderErrorKind | 'noKey' | 'restricted' | 'noContent';

export type StreamName = 'summary' | 'chat';

export interface PanelState {
  keyEnding?: string;
  modelId: string;
  level: Level;
  scope: Scope;
  summary?: Summary;
  summaryModelId?: string;
  chat: ChatMessage[];
  videoExcluded: boolean;
  confirmTokens?: number;
  /** A popup failure the panel opened to fix, shown with its menu link until the next summary. */
  failure?: WorkerErrorKind;
}

export type PanelMessage =
  /** A run begins. `requested` is false for a run the worker starts itself, after "More" on the page. */
  | { type: 'started'; requested: boolean }
  | { type: 'state'; state: PanelState }
  | { type: 'delta'; stream: StreamName; text: string }
  | { type: 'done'; stream: StreamName; status: 'complete' | 'incomplete' }
  | { type: 'error'; stream?: StreamName; kind: WorkerErrorKind }
  | { type: 'navigated' };

export type SelectionMessage =
  | { type: 'delta'; text: string }
  | { type: 'done'; status: 'complete' | 'incomplete' }
  | { type: 'error'; kind: WorkerErrorKind };

/** From the content script, for "More", for a popup with no key, and for a popup failure fixed in the menu. */
export interface OpenPanelMessage {
  type: 'openPanel';
  text: string;
  /** The panel opens on this failure instead of asking the provider again. */
  failure?: WorkerErrorKind;
}
