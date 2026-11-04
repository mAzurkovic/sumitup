import { Markdown } from './Markdown';

interface SummaryCardProps {
  text: string;
  streaming: boolean;
  incomplete: boolean;
  videoExcluded: boolean;
  onStop: () => void;
  onRetry: () => void;
}

export function SummaryCard({ text, streaming, incomplete, videoExcluded, onStop, onRetry }: SummaryCardProps) {
  return (
    <section className="summary" aria-live="polite" aria-busy={streaming}>
      {videoExcluded && <span className="tag">Video not included in this summary</span>}
      {incomplete && <span className="tag">Incomplete</span>}
      <Markdown text={text} />
      {streaming && (
        <button type="button" className="button soft" onClick={onStop}>
          Stop
        </button>
      )}
      {incomplete && (
        <button type="button" className="button" onClick={onRetry}>
          Retry
        </button>
      )}
    </section>
  );
}
