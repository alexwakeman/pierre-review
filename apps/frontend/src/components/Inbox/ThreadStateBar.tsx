import { DERIVED_STATES, type DerivedState, type ThreadStateCounts } from '@pierre-review/shared';
import { DERIVED_STATE_META } from '../../lib/ui.js';

// The canonical segment order (untouched · replied · likely · resolved) — matches
// DERIVED_STATES and the inline `🧵 a·b·c·d` glyph used on PR rows.
const ORDER: DerivedState[] = DERIVED_STATES;

function total(counts: ThreadStateCounts): number {
  return ORDER.reduce((sum, s) => sum + counts[s], 0);
}

// A 4-segment proportional bar of a repo's (or PR's) review-thread states, coloured
// from DERIVED_STATE_META — the one shared thread-state vocabulary. Two densities:
//  • compact: a thin, non-interactive mini-bar for the left rail.
//  • full: a taller bar with clickable segments (soft thread-state filter) and a
//    legend of counts beneath.
export function ThreadStateBar({
  counts,
  compact = false,
  activeState = null,
  onSegmentClick,
  className = '',
}: {
  counts: ThreadStateCounts;
  compact?: boolean;
  activeState?: DerivedState | null;
  onSegmentClick?: (state: DerivedState) => void;
  className?: string;
}): JSX.Element {
  const sum = total(counts);

  if (compact) {
    return (
      <span
        className={`inline-flex h-1.5 w-16 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700 ${className}`}
        aria-hidden="true"
      >
        {sum > 0 &&
          ORDER.map((s) =>
            counts[s] > 0 ? (
              <span
                key={s}
                style={{
                  width: `${(counts[s] / sum) * 100}%`,
                  background: DERIVED_STATE_META[s].color,
                }}
              />
            ) : null,
          )}
      </span>
    );
  }

  return (
    <div className={className}>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
        {sum === 0 ? null : (
          ORDER.map((s) => {
            if (counts[s] === 0) return null;
            const meta = DERIVED_STATE_META[s];
            const seg = (
              <span
                key={s}
                title={`${meta.label}: ${counts[s]}`}
                style={{
                  width: `${(counts[s] / sum) * 100}%`,
                  background: meta.color,
                  opacity: activeState == null || activeState === s ? 1 : 0.35,
                }}
                className="block h-full"
              />
            );
            if (!onSegmentClick) return seg;
            return (
              <button
                key={s}
                type="button"
                onClick={() => onSegmentClick(s)}
                title={`${meta.label}: ${counts[s]} — click to filter`}
                style={{
                  width: `${(counts[s] / sum) * 100}%`,
                  background: meta.color,
                  opacity: activeState == null || activeState === s ? 1 : 0.35,
                }}
                className="block h-full transition-opacity hover:opacity-100"
                aria-pressed={activeState === s}
              />
            );
          })
        )}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
        {ORDER.map((s) => {
          const meta = DERIVED_STATE_META[s];
          const isActive = activeState === s;
          const dim = activeState != null && !isActive;
          const content = (
            <>
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: meta.color }}
              />
              <span className="tabular-nums">{counts[s]}</span>
              <span>{meta.label.toLowerCase()}</span>
            </>
          );
          const cls = `flex items-center gap-1 text-[10px] ${
            dim ? 'text-gray-400 opacity-60' : 'text-gray-600 dark:text-gray-300'
          }`;
          return onSegmentClick ? (
            <button
              key={s}
              type="button"
              onClick={() => onSegmentClick(s)}
              className={`${cls} hover:underline`}
              aria-pressed={isActive}
              title={meta.description}
            >
              {content}
            </button>
          ) : (
            <span key={s} className={cls} title={meta.description}>
              {content}
            </span>
          );
        })}
        <span className="ml-auto text-[10px] tabular-nums text-gray-400">{sum}</span>
      </div>
    </div>
  );
}
