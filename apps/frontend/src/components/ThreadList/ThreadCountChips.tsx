import type { DerivedState, MlLabel, MlSeverity, ThreadDetail } from '@pierre-review/shared';
import { DERIVED_STATE_META, vendorInk } from '../../lib/ui.js';
import { mlLabelKey } from '../../hooks/useMlLabels.js';

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

/**
 * Every non-summary ML severity present in a thread — the ONE fold behind both the Threads tab's
 * severity pills and the per-PR BotTriageCard's nit split, so the two can never disagree. A
 * thread matches a severity when it CONTAINS a comment of it, not when its worst equals it
 * (filtering to "major" must surface the thread with one major among five nits).
 */
export function threadSeverities(
  t: ThreadDetail,
  mlIndex: Map<string, MlLabel> | undefined,
): Set<MlSeverity> {
  const out = new Set<MlSeverity>();
  if (!mlIndex) return out;
  for (const c of t.comments) {
    const l = mlIndex.get(mlLabelKey('review_comment', c.id));
    if (l && !l.isSummary) out.add(l.severity);
  }
  return out;
}

// Rolled-up derived-state counts as coloured chips; zero counts hidden, and nothing at all
// when every count is zero. `compact` drops the numbers (dots only, same per-state tooltips)
// for the Changes tree rail, where 4 × dot+number can't compete with the file name for
// 224px — presence + colour answers "which files still need attention"; the file header two
// inches right has the numbers. THE one renderer of this palette (the near-duplicate
// ThreadDots was deleted — two byte-identical renderers of one palette is drift waiting to
// happen).
export function ThreadCountChips({
  counts,
  compact = false,
}: {
  counts: Record<DerivedState, number>;
  compact?: boolean;
}): JSX.Element | null {
  const shown = ORDER.filter((s) => counts[s] > 0);
  if (shown.length === 0) return null;
  return (
    <span className={`inline-flex items-center ${compact ? 'gap-1' : 'gap-1.5'}`}>
      {shown.map((s) => {
        const meta = DERIVED_STATE_META[s];
        return compact ? (
          <span
            key={s}
            // Resolved is dimmed at dot grain: the rail's question is "which files still need
            // attention", and on a settled PR a full-saturation green on nearly every row
            // shouts as loudly as untouched's red while carrying zero signal. Same quiet-not-
            // hidden treatment as the inline pill; the tooltip keeps the count.
            className={`inline-block h-2 w-2 rounded-full ${s === 'resolved' ? 'opacity-40' : ''}`}
            style={{ backgroundColor: meta.color }}
            title={`${meta.label}: ${counts[s]}`}
          />
        ) : (
          <span
            key={s}
            className="inline-flex items-center gap-0.5 text-[10px] font-semibold"
            style={vendorInk(meta.color)}
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
