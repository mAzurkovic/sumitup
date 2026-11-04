import type { FormEvent } from 'react';
import { FAILURES } from '@/lib/failures';
import type { WorkerErrorKind } from '@/lib/messages';
import { KEY_NOTICE } from './ModelMenu';

const KEY_PAGE = 'https://console.anthropic.com/settings/keys';

export function KeySetup({ error, onSave }: { error?: WorkerErrorKind; onSave: (key: string) => void }) {
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSave(new FormData(event.currentTarget).get('key') as string);
  };
  return (
    <form className="setup" onSubmit={save}>
      <label className="setup">
        <span className="label">API key</span>
        <input className="field" name="key" type="password" placeholder="Paste your key" autoComplete="off" required />
      </label>
      {error && (
        <p className="failure" role="alert">
          {FAILURES[error].message}
        </p>
      )}
      <a className="link" href={KEY_PAGE} target="_blank" rel="noreferrer">
        Get a key from Anthropic
      </a>
      <button type="submit" className="button wide">
        Save
      </button>
      <p className="note">{KEY_NOTICE}</p>
    </form>
  );
}
