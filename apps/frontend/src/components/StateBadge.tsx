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
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
      style={{ backgroundColor: `${meta.color}22`, color: meta.color }}
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

/** Compact coloured dots summarising thread counts by state. */
export function ThreadDots({
  counts,
}: {
  counts: Record<DerivedState, number>;
}): JSX.Element | null {
  const order: DerivedState[] = [
    'untouched',
    'replied_unresolved',
    'likely_addressed',
    'resolved',
  ];
  const shown = order.filter((s) => counts[s] > 0);
  if (shown.length === 0) return null;
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
