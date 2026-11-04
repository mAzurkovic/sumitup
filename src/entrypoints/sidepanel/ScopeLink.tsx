export function ScopeLink({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="link" onClick={onClick}>
      Summarize whole page
    </button>
  );
}
