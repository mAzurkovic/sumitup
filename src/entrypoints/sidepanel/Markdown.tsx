import type { ReactNode } from 'react';

type Block = { kind: 'heading' | 'paragraph'; text: string } | { kind: 'list'; items: string[] };

const BULLET = /^\s*[-*•]\s+/;
const HEADING = /^\s*#{1,6}\s+/;

function blocks(text: string): Block[] {
  const result: Block[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const last = result.at(-1);
    if (BULLET.test(line)) {
      const item = line.replace(BULLET, '');
      if (last?.kind === 'list') last.items.push(item);
      else result.push({ kind: 'list', items: [item] });
    } else if (HEADING.test(line)) {
      result.push({ kind: 'heading', text: line.replace(HEADING, '') });
    } else {
      result.push({ kind: 'paragraph', text: line });
    }
  }
  return result;
}

/** Bold is the only inline style. Everything else, links and HTML included, stays literal text. */
function inline(text: string): ReactNode[] {
  return text.split(/\*\*(.+?)\*\*/).map((part, index) => (index % 2 ? <strong key={index}>{part}</strong> : part));
}

/** Renders model output as React text nodes only, so it cannot run scripts or load remote content. */
export function Markdown({ text }: { text: string }) {
  return blocks(text).map((block, index) => {
    if (block.kind === 'list') {
      return (
        <ul key={index}>
          {block.items.map((item, itemIndex) => (
            <li key={itemIndex}>{inline(item)}</li>
          ))}
        </ul>
      );
    }
    return block.kind === 'heading' ? <h4 key={index}>{inline(block.text)}</h4> : <p key={index}>{inline(block.text)}</p>;
  });
}
