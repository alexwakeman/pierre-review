import type { DerivedState } from '@pierre-review/shared';
import { DERIVED_STATE_META } from '../lib/ui.js';

export function StateBadge({
  state,
  count,
}: {
  state: DerivedState;
  count?: number;
}): JSX.Element {
  const meta = DERIVED_STATE_META[state];
  return (
    // Icon + words, no filled pill (docs/redesign/DESIGN.md § Colour): the state's hue rides the
    // DOT only; the word is grey, except Resolved — the one state that is "done" (ready ink).
    <span
      className={`inline-flex items-center gap-1 py-0.5 text-meta font-medium ${
        state === 'resolved' ? 'text-ui-success' : 'text-ui-mute'
      }`}
      title={meta.description}
    >
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ backgroundColor: meta.color }}
      />
      {meta.label}
      {count !== undefined && <span className="opacity-70">· {count}</span>}
    </span>
  );
}
