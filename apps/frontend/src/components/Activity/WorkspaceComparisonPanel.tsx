import { useMemo } from 'react';
import type { WorkspaceComparisonRow, WorkspaceMetrics } from '@pierre-review/shared';
import { useWorkspaceComparison } from '../../hooks/useWorkspaceComparison.js';
import { buildWorkspaceColorMap, workspaceColorFor } from '../../lib/workspaceColors.js';
import { fmtDuration, fmtNum } from '../charts/common.js';

// Cross-workspace comparison — the Activity rail's "Compare workspaces" entry. A compact
// metric×workspace matrix (workspaces as columns, flow metrics as rows) plus a 12-week throughput
// sparkline per workspace, highlighting the best/worst workspace per metric so a lead can spot
// throughput gaps and blockers at a glance.
//
// CORE/FREE, on every tier. It used to live as an Insights sub-tab behind the Pro insights
// capability, then as a Feed sub-tab gated on "2+ teams in scope". Both gates are gone: it is now a
// rail line of its own, shown whenever the account owns 2+ workspaces, and it reads
// `GET /api/workspace-metrics/compare`.
//
// ⚠ IT TAKES NO PROPS AND NO SCOPE, deliberately. Scope is exactly ONE workspace everywhere else in
// the app; this is the one surface that is ABOUT the others, so it always renders every workspace
// the account owns, Default included, independent of which one is selected. Its predecessor took
// the selected team ids and a scope string, which is precisely what made it vanish the moment fewer
// than two teams were ticked. The rail decides whether to mount it (`workspaces.length >= 2`); this
// component decides nothing about scope.
//
// ⚠ NO PRICE ROW, AND THERE MUST NEVER BE ONE. A bot's price is a per-workspace fact, so six
// workspaces each listing a $120 CodeRabbit is either six subscriptions or one seen six ways — and
// this screen cannot know which. Costs may be shown side by side; they may NEVER be totalled across
// workspaces. That is why no row below reads a cost.

// One matrix row: how to read + format a metric off a workspace's WorkspaceMetrics, and whether a
// LOWER value is better (drives the best/worst highlight — the "blocker" is the worst).
interface Row {
  label: string;
  note?: string;
  get: (m: WorkspaceMetrics) => number | null;
  fmt: (v: number) => string;
  betterIsLower: boolean;
}

const ROWS: Row[] = [
  { label: 'Merged', note: 'this sprint', get: (m) => m.merges.value, fmt: fmtNum, betterIsLower: false },
  { label: 'Lead time', note: 'open→merge', get: (m) => m.leadTimeHours.value, fmt: fmtDuration, betterIsLower: true },
  { label: '1st review', note: 'open→first review', get: (m) => m.timeToFirstReviewHours.value, fmt: fmtDuration, betterIsLower: true },
  { label: 'CI success', note: 'merged green', get: (m) => m.mergeCiSuccessPct.value, fmt: (v) => `${Math.round(v)}%`, betterIsLower: false },
  { label: 'CI recovery', note: 'red→green', get: (m) => m.ciRecoveryHours.value, fmt: fmtDuration, betterIsLower: true },
  { label: 'Open PRs', note: 'now', get: (m) => m.openPrs, fmt: fmtNum, betterIsLower: true },
];

function Sparkline({ values }: { values: number[] }): JSX.Element {
  const w = 92;
  const h = 24;
  const pad = 2;
  const n = values.length;
  if (n === 0 || values.every((v) => v === 0)) {
    return <span className="text-[10px] text-gray-300 dark:text-gray-600">—</span>;
  }
  const max = Math.max(1, ...values);
  const pts = values
    .map((v, i) => {
      const x = n === 1 ? w / 2 : pad + (i / (n - 1)) * (w - 2 * pad);
      const y = h - pad - (v / max) * (h - 2 * pad);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <polyline
        points={pts}
        fill="none"
        stroke="#0ea5e9"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function WorkspaceComparisonPanel(): JSX.Element {
  // `enabled: true` — the panel only mounts when the rail line is the active entry, so being
  // rendered IS the signal. (The route is N × getWorkspaceMetrics and sits on the 60/min `search`
  // tier, which is why the hook takes the flag at all rather than firing on every Activity open.)
  const { data, isLoading, isError } = useWorkspaceComparison(true);

  const workspaces: WorkspaceComparisonRow[] = useMemo(
    () => data?.workspaces ?? [],
    [data?.workspaces],
  );

  // Colour map seeded from THIS response's own rows. The response covers every workspace the
  // account owns, in `listWorkspaces` order (Default first, then name asc), so it is already the
  // complete, stable roster this map needs — no second query, and no window in which a late-
  // arriving roster reshuffles the columns' hues. See lib/workspaceColors.ts.
  const colorMap = useMemo(
    () => buildWorkspaceColorMap(workspaces.map((w) => w.workspaceId)),
    [workspaces],
  );

  // Per-row best/worst workspace index (only when ≥2 workspaces have a value → a comparison
  // exists).
  const extremes = useMemo(() => {
    return ROWS.map((row) => {
      const vals = workspaces.map((w) => (w.metrics ? row.get(w.metrics) : null));
      const present = vals.filter((v): v is number => v != null);
      if (present.length < 2) return { best: -1, worst: -1 };
      const bestVal = row.betterIsLower ? Math.min(...present) : Math.max(...present);
      const worstVal = row.betterIsLower ? Math.max(...present) : Math.min(...present);
      // Highlight the first workspace hitting the extreme (ties → first).
      const best = vals.findIndex((v) => v === bestVal);
      const worst = bestVal === worstVal ? -1 : vals.findIndex((v) => v === worstVal);
      return { best, worst };
    });
  }, [workspaces]);

  if (isLoading) {
    return (
      <div className="space-y-2" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-10 animate-pulse rounded border border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/40"
          />
        ))}
      </div>
    );
  }
  if (isError) return <div className="text-sm text-red-500">Couldn’t load the comparison.</div>;

  if (workspaces.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-gray-700">
        Create a Workspace to compare — flow metrics show up here once the account has more than
        one.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* No <h3> repeating the rail label — the caption carries what the label can't: that this
          covers EVERY workspace, not the selected one. */}
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Flow metrics side by side across all {workspaces.length} workspaces — spot throughput gaps
        and blockers, and see where to rebalance. Best value in each row is green; the laggard is
        amber. Same trailing-2-week window as the flow-metric header.
      </p>

      <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
        <table className="w-full min-w-[32rem] border-collapse text-xs">
          <thead>
            <tr className="border-b border-gray-200 dark:border-gray-800">
              <th className="sticky left-0 bg-white px-3 py-2 text-left font-medium text-gray-500 dark:bg-gray-950 dark:text-gray-400">
                Metric
              </th>
              {workspaces.map((w) => (
                <th
                  key={w.workspaceId}
                  className="px-3 py-2 text-right font-semibold text-gray-700 dark:text-gray-200"
                >
                  {/* The colour dot is this column's identity across the matrix (header, and the
                      sparkline row below). Inline style, not a Tailwind class — the palette is a
                      JS value. */}
                  <div className="flex min-w-0 items-center justify-end gap-1.5">
                    <span
                      aria-hidden="true"
                      className="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{ background: workspaceColorFor(colorMap, w.workspaceId) }}
                    />
                    <span className="truncate">{w.workspaceName}</span>
                    {w.isDefault && (
                      <span
                        className="shrink-0 rounded bg-gray-100 px-1 text-[9px] font-normal uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400"
                        title="Where new repos land. It can be renamed but not deleted."
                      >
                        default
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] font-normal text-gray-400">
                    {w.repoCount} repo{w.repoCount === 1 ? '' : 's'}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row, ri) => (
              <tr key={row.label} className="border-b border-gray-100 last:border-0 dark:border-gray-900">
                <td className="sticky left-0 bg-white px-3 py-1.5 text-left dark:bg-gray-950">
                  <span className="font-medium text-gray-700 dark:text-gray-200">{row.label}</span>
                  {row.note && <span className="ml-1 text-[10px] text-gray-400">{row.note}</span>}
                </td>
                {workspaces.map((w, wi) => {
                  const v = w.metrics ? row.get(w.metrics) : null;
                  const isBest = extremes[ri]?.best === wi;
                  const isWorst = extremes[ri]?.worst === wi;
                  return (
                    <td
                      key={w.workspaceId}
                      className={`px-3 py-1.5 text-right tabular-nums ${
                        isBest
                          ? 'font-semibold text-emerald-600 dark:text-emerald-400'
                          : isWorst
                            ? 'font-semibold text-amber-600 dark:text-amber-400'
                            : 'text-gray-700 dark:text-gray-200'
                      }`}
                    >
                      {v != null ? row.fmt(v) : <span className="text-gray-300 dark:text-gray-600">—</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
            {/* Throughput sparkline row — the 12-week merged trend per workspace. */}
            <tr className="border-t border-gray-200 dark:border-gray-800">
              <td className="sticky left-0 bg-white px-3 py-2 text-left dark:bg-gray-950">
                <span className="font-medium text-gray-700 dark:text-gray-200">Throughput</span>
                <span className="ml-1 text-[10px] text-gray-400">12-wk merged</span>
              </td>
              {workspaces.map((w) => (
                <td key={w.workspaceId} className="px-3 py-2 text-right">
                  <div className="flex justify-end">
                    <Sparkline values={w.metrics?.throughput.merged ?? []} />
                  </div>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
