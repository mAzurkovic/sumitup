import { useEffect, useRef, type ReactNode } from 'react';

/** One scroll area for the summary and the chat. A change of `newest` brings the last item into view. */
export function ScrollColumn({ newest, children }: { newest: number; children: ReactNode }) {
  const column = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (newest) column.current?.lastElementChild?.scrollIntoView({ block: 'end' });
  }, [newest]);
  return (
    <div className="scroll" ref={column}>
      {children}
    </div>
  );
}
