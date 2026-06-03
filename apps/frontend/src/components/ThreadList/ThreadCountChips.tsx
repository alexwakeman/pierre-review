import type { DerivedState, ThreadDetail } from '@pierre-review/shared';
import { DERIVED_STATE_META } from '../../lib/ui.js';

const ORDER: DerivedState[] = [
  'untouched',
  'replied_unresolved',
  'likely_addressed',
  'resolved',
];

export function rollupCounts(threads: ThreadDetail[]): Record<DerivedState, number> {
  const counts: Record<DerivedState, number> = {
    untouched: 0,
    replied_unresolved: 0,
    likely_addressed: 0,
    resolved: 0,
  };
  for (const t of threads) counts[t.derivedState] += 1;
  return counts;
}

// Rolled-up derived-state counts as coloured chips; zero counts hidden.
export function ThreadCountChips({
  counts,
}: {
  counts: Record<DerivedState, number>;
}): JSX.Element {
  const shown = ORDER.filter((s) => counts[s] > 0);
  return (
    <span className="inline-flex items-center gap-1.5">
      {shown.map((s) => {
        const meta = DERIVED_STATE_META[s];
        return (
          <span
            key={s}
            className="inline-flex items-center gap-0.5 text-[10px] font-semibold"
            style={{ color: meta.color }}
            title={`${meta.label}: ${counts[s]}`}
          >
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: meta.color }}
            />
            {counts[s]}
          </span>
        );
      })}
    </span>
  );
}
