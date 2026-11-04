import type { WorkerErrorKind } from './messages';

export interface Failure {
  message: string;
  /** `retry` sends the request again. `menu` opens the model and key menu, with this link text. */
  action?: 'retry' | { menu: string };
}

export const FAILURES: Record<WorkerErrorKind, Failure> = {
  auth: { message: 'API key rejected', action: { menu: 'Check your key' } },
  rate: { message: 'Provider limit reached', action: 'retry' },
  unavailable: { message: 'Provider unavailable', action: 'retry' },
  offline: { message: 'No connection', action: 'retry' },
  // A cut-off stream with text keeps it as Incomplete, so this shows only when nothing arrived.
  cutoff: { message: 'Provider unavailable', action: 'retry' },
  modelGone: { message: 'Model unavailable', action: { menu: 'Choose another model' } },
  rejected: { message: 'Provider rejected the request', action: 'retry' },
  refused: { message: 'Provider declined this content', action: { menu: 'Choose another model' } },
  restricted: { message: "Sum it up can't read this page" },
  noContent: { message: 'Not enough text to summarize' },
  noKey: { message: 'Add an API key to start' },
};
