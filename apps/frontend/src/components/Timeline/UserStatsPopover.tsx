import { useEffect, useRef } from 'react';
import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
} from '@floating-ui/react';
import type { User } from '@pierre-review/shared';
import { userLabel } from '../../lib/ui.js';
import type { UserStats } from './userRow.js';

// A small labelled-table popover for a contributor's timeline metrics. The row label
// carries a compact glyph summary that's quick to skim but easy to misread; this
// restates the SAME five numbers with text labels so they're unambiguous. Anchored to
// the row's stats-toggle button (re-resolved live by its data-stats-gid each animation
// frame, mirroring MarkerPopover) so it rides vis rebuilds + scrolls; portaled to
// <body> so it escapes the timeline's overflow clip; dismisses on outside click / Esc.
export function UserStatsPopover({
  gid,
  uid,
  user,
  stats,
  x,
  y,
  onDismiss,
}: {
  gid: string;
  uid: number;
  user: User | undefined;
  stats: UserStats;
  x: number;
  y: number;
  onDismiss: () => void;
}): JSX.Element {
  const { refs, floatingStyles, context, isPositioned } = useFloating({
    open: true,
    onOpenChange: (o) => {
      if (!o) onDismiss();
    },
    strategy: 'fixed',
    placement: 'right-start',
    middleware: [
      offset(8),
      flip({ fallbackPlacements: ['left-start', 'bottom-start'] }),
      shift({ padding: 8 }),
    ],
    whileElementsMounted: (ref, float, update) =>
      autoUpdate(ref, float, update, { animationFrame: true }),
  });
  // Dismiss on outside click, but NOT on a click of a stats-toggle button: the toggle
  // has its own handler that closes an already-open popover, and outsidePress fires on
  // pointerdown (the popover anchors to a VIRTUAL reference, so floating-ui can't tell
  // the toggle is "inside"). Without this exclusion the pointerdown closes it and the
  // following click re-opens it — the toggle-to-close affordance would never work.
  const dismiss = useDismiss(context, {
    outsidePress: (e) =>
      !(e.target as HTMLElement | null)?.closest?.('[data-stats-gid]'),
  });
  const { getFloatingProps } = useInteractions([dismiss]);

  // Hold the last rect resolved from the live toggle so the popover keeps its spot
  // when the anchor briefly vanishes mid-rebuild (or scrolls off-screen). Cleared when
  // the anchored row changes.
  const lastRectRef = useRef<DOMRect | null>(null);
  useEffect(() => {
    lastRectRef.current = null;
  }, [gid]);

  useEffect(() => {
    const clickPoint = (): DOMRect =>
      ({ x, y, top: y, left: x, right: x, bottom: y, width: 0, height: 0 }) as DOMRect;
    refs.setReference({
      getBoundingClientRect: () => {
        // gids are `repo:<n>:user:<n>` — only digits/colons, safe inside a quoted
        // attribute selector. Re-querying each frame is what rides the rebuild.
        const el = document.querySelector(`[data-stats-gid="${gid}"]`);
        if (el) {
          const r = el.getBoundingClientRect();
          lastRectRef.current = r;
          return r;
        }
        return lastRectRef.current ?? clickPoint();
      },
    });
  }, [refs, gid, x, y]);

  const name = userLabel(user, uid);
  const totalPrs = stats.prsOpen + stats.prsMerged + stats.prsClosed;
  const rows: { label: string; value: number; dot?: string }[] = [
    { label: 'Comments', value: stats.comments },
    { label: 'Reviews given', value: stats.reviews },
    { label: 'PRs open', value: stats.prsOpen, dot: '#3b82f6' },
    { label: 'PRs merged', value: stats.prsMerged, dot: '#22c55e' },
    { label: 'PRs closed', value: stats.prsClosed, dot: '#9ca3af' },
  ];

  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        style={{
          ...floatingStyles,
          visibility: isPositioned ? 'visible' : 'hidden',
        }}
        {...getFloatingProps()}
        data-testid="user-stats-popover"
        className="z-50 w-56 rounded-lg border border-gray-200 bg-white p-3 shadow-xl dark:border-gray-700 dark:bg-gray-900"
      >
        <div
          className="mb-1 truncate text-sm font-semibold text-gray-800 dark:text-gray-100"
          title={name}
        >
          {name}
        </div>
        <div className="mb-2 text-[10px] uppercase tracking-wide text-gray-400">
          In this window
        </div>
        <table className="w-full text-xs">
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.label}
                className="border-t border-gray-100 first:border-0 dark:border-gray-800"
              >
                <td className="py-1 pr-2 text-gray-500 dark:text-gray-400">
                  <span className="inline-flex items-center gap-1.5">
                    {r.dot && (
                      <span
                        className="inline-block h-2 w-2 rounded-full"
                        style={{ backgroundColor: r.dot }}
                      />
                    )}
                    {r.label}
                  </span>
                </td>
                <td className="py-1 text-right font-medium tabular-nums text-gray-800 dark:text-gray-100">
                  {r.value}
                </td>
              </tr>
            ))}
            <tr className="border-t border-gray-200 dark:border-gray-700">
              <td className="py-1 pr-2 text-gray-500 dark:text-gray-400">PRs authored</td>
              <td className="py-1 text-right font-medium tabular-nums text-gray-800 dark:text-gray-100">
                {totalPrs}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </FloatingPortal>
  );
}
