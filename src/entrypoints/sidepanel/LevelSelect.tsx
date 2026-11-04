import type { Level } from '@/lib/prompts';

const LEVELS: [Level, string][] = [
  ['short', 'Short'],
  ['medium', 'Medium'],
  ['in-depth', 'In-depth'],
  ['eli5', 'ELI5'],
];

export function LevelSelect({ level, onChange }: { level: Level; onChange: (level: Level) => void }) {
  return (
    <label className="control level">
      <span className="label">Detail level</span>
      <select value={level} onChange={(event) => onChange(event.target.value as Level)}>
        {LEVELS.map(([value, name]) => (
          <option key={value} value={value}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}
