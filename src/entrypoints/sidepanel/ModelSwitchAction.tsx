export function ModelSwitchAction({ modelName, onClick }: { modelName: string; onClick: () => void }) {
  return (
    <button type="button" className="button wide" onClick={onClick}>
      Summarize with {modelName}
    </button>
  );
}
