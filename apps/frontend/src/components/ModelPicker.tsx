import type { ModelPickState } from '../lib/modelPick.js';

// THE PER-RUN MODEL MENU (lib/modelPick.ts): every ready provider's models, each labelled by what will
// run ("Claude Opus 5.5 (most thorough)", "Codex · GPT-6 Astra (most thorough)"). With one provider
// ready it is the menu it always was.
export function ModelPicker({
  state,
  onPick,
  disabled,
}: {
  state: ModelPickState;
  onPick: (value: string) => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <select
      value={state.chosen.value}
      onChange={(e) => onPick(e.target.value)}
      disabled={disabled}
      aria-label="Model"
      className="rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
    >
      {state.picks.map((p) => (
        <option key={p.value} value={p.value}>
          {p.label}
        </option>
      ))}
    </select>
  );
}
