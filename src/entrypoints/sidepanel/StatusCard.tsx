import { FAILURES } from '@/lib/failures';
import type { WorkerErrorKind } from '@/lib/messages';
import { MODEL_MENU_ID } from './ModelMenu';

export type StatusView =
  | { kind: 'waiting'; onStop: () => void }
  | { kind: 'start'; newPage: boolean; onStart: () => void }
  | { kind: 'confirmLong'; tokens: number; onContinue: () => void; onCancel: () => void }
  | { kind: 'failure'; failure: WorkerErrorKind; banner: boolean; onRetry: () => void };

/** A rough figure reads as one, so the estimate is rounded to the nearest thousand. */
const roughTokens = (tokens: number) => (Math.round(tokens / 1000) * 1000).toLocaleString('en-US');

export function StatusCard({ view }: { view: StatusView }) {
  switch (view.kind) {
    case 'waiting':
      return (
        <div className="status" role="status">
          <span className="spinner" aria-hidden="true" />
          Summarizing
          <button type="button" className="button soft" onClick={view.onStop}>
            Stop
          </button>
        </div>
      );
    case 'start':
      return (
        <div className="status">
          {view.newPage ? 'New page. Sum it up?' : 'Sum it up?'}
          <button type="button" className="button" onClick={view.onStart}>
            Sum it up
          </button>
        </div>
      );
    case 'confirmLong':
      return (
        <div className="status">
          This page is long. Summarizing uses about {roughTokens(view.tokens)} tokens on your key.
          <div className="row">
            <button type="button" className="button" onClick={view.onContinue}>
              Continue
            </button>
            <button type="button" className="button soft" onClick={view.onCancel}>
              Cancel
            </button>
          </div>
        </div>
      );
    case 'failure': {
      const { message, action } = FAILURES[view.failure];
      return (
        <div className={view.banner ? 'status banner' : 'status'} role="alert">
          <span className={action ? 'failure' : undefined}>{message}</span>
          {action === 'retry' && (
            <button type="button" className="button" onClick={view.onRetry}>
              Retry
            </button>
          )}
          {typeof action === 'object' && (
            <button type="button" className="link" popoverTarget={MODEL_MENU_ID}>
              {action.menu}
            </button>
          )}
        </div>
      );
    }
  }
}
