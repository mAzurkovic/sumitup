import type { ChatMessage } from '@/lib/providers/types';

export function ChatMessages({ chat, reply }: { chat: ChatMessage[]; reply?: string }) {
  const messages: ChatMessage[] = reply ? [...chat, { role: 'assistant', text: reply }] : chat;
  return messages.map(({ role, text }, index) => (
    <div key={index} className={`message ${role}`}>
      {text}
    </div>
  ));
}
