import type { ModelPickState } from '../lib/modelPick.js';
import { Select } from './ui/index.js';

// THE PER-RUN MODEL MENU (lib/modelPick.ts): every ready provider's models, each labelled by what will
// run ("Claude Opus 5.5 (most thorough)", "Codex · GPT-6.1 Sol (most thorough)"). With one provider
// ready it is the menu it always was. The redesign's custom Select (accessible name "Model"; a
// bottom sheet on a phone) — scripts open it and click the option by its words, never
// `selectOption()`.
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
    <Select
      label="Model"
      value={state.chosen.value}
      onChange={onPick}
      disabled={disabled}
      options={state.picks.map((p) => ({ value: p.value, label: p.label }))}
      className="max-w-full"
    />
  );
}
