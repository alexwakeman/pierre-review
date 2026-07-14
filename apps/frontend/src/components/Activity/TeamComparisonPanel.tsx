import { useMemo } from 'react';
import type { TeamComparisonRow, TeamMetrics } from '@pierre-review/shared';
import { useTeamComparison } from '../../hooks/useTeamComparison.js';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { fmtDuration, fmtNum } from '../charts/common.js';

// Cross-team comparison (Insights "Compare" sub-tab; All-Teams scope only). A compact metric×team
// matrix — teams as columns, flow metrics as rows — plus a 12-week throughput sparkline per team.
// Reuses the per-team TeamMetrics the Insights header already computes (one row per team from
// /api/pro/insights/team-comparison). Highlights the best/worst team per metric so a lead can
// spot throughput gaps and blockers across teams at a glance. Gated on teamInsights.

// One matrix row: how to read + format a metric off a team's TeamMetrics, and whether a LOWER
// value is better (drives the best/worst highlight — the "blocker" is the worst).
interface Row {
  label: string;
  note?: string;
  get: (m: TeamMetrics) => number | null;
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

export function TeamComparisonPanel(): JSX.Element | null {
  const { teamInsights } = useProCapabilities();
  const { data, isLoading, isError } = useTeamComparison(teamInsights);

  const teams: TeamComparisonRow[] = useMemo(() => data?.teams ?? [], [data?.teams]);

  // Per-row best/worst team index (only when ≥2 teams have a value → a comparison exists).
  const extremes = useMemo(() => {
    return ROWS.map((row) => {
      const vals = teams.map((t) => (t.metrics ? row.get(t.metrics) : null));
      const present = vals.filter((v): v is number => v != null);
      if (present.length < 2) return { best: -1, worst: -1 };
      const bestVal = row.betterIsLower ? Math.min(...present) : Math.max(...present);
      const worstVal = row.betterIsLower ? Math.max(...present) : Math.min(...present);
      // Highlight the first team hitting the extreme (ties → first).
      const best = vals.findIndex((v) => v === bestVal);
      const worst = bestVal === worstVal ? -1 : vals.findIndex((v) => v === worstVal);
      return { best, worst };
    });
  }, [teams]);

  if (!teamInsights) return null;

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

  if (teams.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-gray-700">
        No teams yet — create teams (and assign repos) to compare their flow metrics here.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Compare teams</h3>
        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          Flow metrics side by side across every team — spot throughput gaps and blockers, and see
          where to rebalance. Best value in each row is green; the laggard is amber.
        </p>
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
        <table className="w-full min-w-[32rem] border-collapse text-xs">
          <thead>
            <tr className="border-b border-gray-200 dark:border-gray-800">
              <th className="sticky left-0 bg-white px-3 py-2 text-left font-medium text-gray-500 dark:bg-gray-950 dark:text-gray-400">
                Metric
              </th>
              {teams.map((t) => (
                <th key={t.teamId} className="px-3 py-2 text-right font-semibold text-gray-700 dark:text-gray-200">
                  <div className="truncate">{t.teamName}</div>
                  <div className="text-[10px] font-normal text-gray-400">
                    {t.repoCount} repo{t.repoCount === 1 ? '' : 's'}
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
                {teams.map((t, ti) => {
                  const v = t.metrics ? row.get(t.metrics) : null;
                  const isBest = extremes[ri]?.best === ti;
                  const isWorst = extremes[ri]?.worst === ti;
                  return (
                    <td
                      key={t.teamId}
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
            {/* Throughput sparkline row — the 12-week merged trend per team. */}
            <tr className="border-t border-gray-200 dark:border-gray-800">
              <td className="sticky left-0 bg-white px-3 py-2 text-left dark:bg-gray-950">
                <span className="font-medium text-gray-700 dark:text-gray-200">Throughput</span>
                <span className="ml-1 text-[10px] text-gray-400">12-wk merged</span>
              </td>
              {teams.map((t) => (
                <td key={t.teamId} className="px-3 py-2 text-right">
                  <div className="flex justify-end">
                    <Sparkline values={t.metrics?.throughput.merged ?? []} />
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
