import type { FormEvent } from 'react';
import type { Scope } from '@/lib/session';

export function ChatInput({ open, scope, onSend }: { open: boolean; scope: Scope; onSend: (text: string) => void }) {
  const send = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const text = (new FormData(form).get('question') as string).trim();
    if (!text) return;
    onSend(text);
    form.reset();
  };
  const placeholder = !open ? 'Chat opens after the summary' : scope === 'selection' ? 'Ask about this selection' : 'Ask about this page';
  return (
    <form onSubmit={send}>
      <input className="chat-input" name="question" aria-label="Chat" placeholder={placeholder} disabled={!open} autoComplete="off" />
    </form>
  );
}
