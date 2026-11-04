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
}

export type PanelMessage =
  | { type: 'state'; state: PanelState }
  | { type: 'delta'; stream: StreamName; text: string }
  | { type: 'done'; stream: StreamName; status: 'complete' | 'incomplete' }
  | { type: 'error'; stream?: StreamName; kind: WorkerErrorKind }
  | { type: 'navigated' };

export type SelectionMessage =
  | { type: 'delta'; text: string }
  | { type: 'done'; status: 'complete' | 'incomplete' }
  | { type: 'error'; kind: WorkerErrorKind };
