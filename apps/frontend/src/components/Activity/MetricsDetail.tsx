import { useEffect, useMemo, useState } from 'react';
import type { MetricPr, TeamMetricKey, User } from '@pierre-review/shared';
import { TEAM_METRIC_KEYS } from '@pierre-review/shared';
import { useTeamMetricsDetail } from '../../hooks/useTeamMetricsDetail.js';
import { useUsers } from '../../hooks/useTimeline.js';
import { useFilters } from '../../store/filters.js';
import { usePinnedTabs, type PinnedPr } from '../../store/pinnedTabs.js';
import { CI_META, indexUsers, relativeTime } from '../../lib/ui.js';
import { fmtDuration } from '../charts/common.js';
import { Avatar } from '../CommentCard.js';
import { UserName } from '../UserName.js';

// The flow-metric DRILL-DOWN — a persistent tab opened by clicking a metric tile in
// Insights. One sub-tab per metric, each listing the PRs behind that number (with the
// metric-specific figure) so a lead can see WHERE issues cluster. All data comes from a
// single lazy read (useTeamMetricsDetail); clicking any PR opens its detail tab.

const METRIC_META: Record<TeamMetricKey, { label: string; blurb: string }> = {
  merges: { label: 'Merges', blurb: 'Merged this sprint · grouped by repo' },
  lead_time: { label: 'Lead time', blurb: 'Open → merge (merged + open) · longest first' },
  review_latency: { label: 'Review latency', blurb: 'Open → first review · longest first' },
  merge_ci: { label: 'Merge CI', blurb: 'Merged PRs · CI-failed-at-merge first' },
  ci_recovery: { label: 'CI recovery', blurb: 'Red → green · slowest first' },
  ci_red: { label: 'CI red now', blurb: 'Currently-failing branches · longest red first' },
};

function listFor(
  detail: NonNullable<ReturnType<typeof useTeamMetricsDetail>['data']>['detail'],
  m: TeamMetricKey,
): MetricPr[] {
  if (!detail) return [];
  switch (m) {
    case 'merges':
      return detail.merges;
    case 'lead_time':
      return detail.leadTime;
    case 'review_latency':
      return detail.reviewLatency;
    case 'merge_ci':
      return detail.mergeCi;
    case 'ci_recovery':
      return detail.ciRecovery;
    case 'ci_red':
      return detail.ciRed;
  }
}

function CiCell({ ci }: { ci: MetricPr['ciStatus'] }): JSX.Element {
  const meta = ci ? CI_META[ci] : null;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400">
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={meta ? { background: meta.color } : { boxShadow: 'inset 0 0 0 1px #9ca3af' }}
        aria-hidden
      />
      {meta?.label ?? 'no checks'}
    </span>
  );
}

function DiffCell({ pr }: { pr: MetricPr }): JSX.Element {
  return (
    <span className="whitespace-nowrap text-[11px]">
      <span className="text-gray-400">{pr.changedFiles}f</span>{' '}
      <span className="font-mono text-green-600 dark:text-green-400">+{pr.additions}</span>{' '}
      <span className="font-mono text-red-500 dark:text-red-400">−{pr.deletions}</span>
    </span>
  );
}

function AuthorCell({
  id,
  usersById,
}: {
  id: number | null;
  usersById: Map<number, User>;
}): JSX.Element {
  const u = id != null ? usersById.get(id) : undefined;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-gray-600 dark:text-gray-300">
      <Avatar user={u} size={14} />
      <UserName user={u} fallbackId={id ?? 0} />
    </span>
  );
}

function Reviewers({
  ids,
  usersById,
}: {
  ids: number[];
  usersById: Map<number, User>;
}): JSX.Element {
  if (ids.length === 0) return <span className="text-[11px] italic text-gray-400">none</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {ids.map((id) => {
        const u = usersById.get(id);
        return (
          <span
            key={id}
            className="inline-flex items-center gap-1 rounded bg-gray-500/10 px-1 py-0.5 text-[10px]"
          >
            <Avatar user={u} size={11} />
            <UserName user={u} fallbackId={id} />
          </span>
        );
      })}
    </span>
  );
}

// The metric-specific "value" cell for a row (and its column header text).
function valueHeader(m: TeamMetricKey): string {
  switch (m) {
    case 'merges':
    case 'lead_time':
      return 'Lead time';
    case 'review_latency':
      return 'Latency';
    case 'merge_ci':
      return 'CI @ merge';
    case 'ci_recovery':
      return 'Recovery';
    case 'ci_red':
      return 'Red for';
  }
}

function ValueCell({ m, pr }: { m: TeamMetricKey; pr: MetricPr }): JSX.Element {
  const dur = (h: number | null): string => (h == null ? '—' : fmtDuration(h));
  switch (m) {
    case 'merges':
    case 'lead_time':
      return <span className="font-medium">{dur(pr.leadTimeHours)}</span>;
    case 'review_latency':
      return <span className="font-medium">{dur(pr.reviewLatencyHours)}</span>;
    case 'ci_recovery':
      return <span className="font-medium text-orange-600 dark:text-orange-400">{dur(pr.recoveryHours)}</span>;
    case 'ci_red':
      return <span className="font-medium text-red-500 dark:text-red-400">{dur(pr.redAgeHours)}</span>;
    case 'merge_ci': {
      const red = pr.ciStatus === 'failure' || pr.ciStatus === 'error';
      return (
        <span className={`font-medium ${red ? 'text-red-500 dark:text-red-400' : 'text-gray-500'}`}>
          {pr.ciStatus ?? '—'}
        </span>
      );
    }
  }
}

function Row({
  m,
  pr,
  usersById,
  onOpen,
}: {
  m: TeamMetricKey;
  pr: MetricPr;
  usersById: Map<number, User>;
  onOpen: (pr: MetricPr) => void;
}): JSX.Element {
  const showReviewers = m === 'review_latency';
  const showMergedBy = m === 'merges' || m === 'merge_ci';
  return (
    <tr className="border-t border-gray-100 align-top hover:bg-gray-50/70 dark:border-gray-800/60 dark:hover:bg-gray-900/40">
      <td className="py-1.5 pr-3">
        <button
          type="button"
          onClick={() => onOpen(pr)}
          className="max-w-md truncate text-left text-sm font-medium text-gray-800 hover:underline dark:text-gray-100"
          title="Open this PR"
        >
          <span className="text-gray-400">
            {pr.repoFullName} #{pr.prNumber}
          </span>{' '}
          {pr.prTitle}
        </button>
      </td>
      <td className="py-1.5 pr-3">
        <ValueCell m={m} pr={pr} />
      </td>
      <td className="py-1.5 pr-3">
        <CiCell ci={pr.ciStatus} />
      </td>
      <td className="py-1.5 pr-3">
        <DiffCell pr={pr} />
      </td>
      <td className="py-1.5 pr-3">
        <AuthorCell id={pr.authorId} usersById={usersById} />
      </td>
      <td className="py-1.5 pr-3 text-[11px] text-gray-500 dark:text-gray-400">
        {showReviewers ? (
          <Reviewers ids={pr.reviewerIds} usersById={usersById} />
        ) : showMergedBy ? (
          <AuthorCell id={pr.mergedById} usersById={usersById} />
        ) : (
          relativeTime(pr.openedAt)
        )}
      </td>
    </tr>
  );
}

function Table({
  m,
  rows,
  usersById,
  onOpen,
}: {
  m: TeamMetricKey;
  rows: MetricPr[];
  usersById: Map<number, User>;
  onOpen: (pr: MetricPr) => void;
}): JSX.Element {
  const lastCol = m === 'review_latency' ? 'Reviewers' : m === 'merges' || m === 'merge_ci' ? 'Merged by' : 'Opened';
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] border-collapse text-sm">
        <thead>
          <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-gray-400">
            <th className="pb-1 pr-3 font-semibold">Pull request</th>
            <th className="pb-1 pr-3 font-semibold">{valueHeader(m)}</th>
            <th className="pb-1 pr-3 font-semibold">CI</th>
            <th className="pb-1 pr-3 font-semibold">Diff</th>
            <th className="pb-1 pr-3 font-semibold">Author</th>
            <th className="pb-1 pr-3 font-semibold">{lastCol}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((pr) => (
            <Row key={pr.prId} m={m} pr={pr} usersById={usersById} onOpen={onOpen} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MetricsDetail(): JSX.Element {
  const metricsFocus = useFilters((s) => s.metricsFocus);
  const consumeMetricsFocus = useFilters((s) => s.consumeMetricsFocus);
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const { data, isLoading, isError, refetch, isFetching } = useTeamMetricsDetail(true);
  const { data: users } = useUsers();
  const usersById = useMemo(() => indexUsers(users), [users]);

  const [active, setActive] = useState<TeamMetricKey>(metricsFocus ?? 'merges');
  // A clicked tile (even while the tab is already open) re-jumps to that metric's sub-tab.
  useEffect(() => {
    if (metricsFocus) {
      setActive(metricsFocus);
      consumeMetricsFocus();
    }
  }, [metricsFocus, consumeMetricsFocus]);

  const detail = data?.detail ?? null;
  const rows = listFor(detail, active);
  const openPr = (pr: MetricPr): void => {
    const u = pr.authorId != null ? usersById.get(pr.authorId) : undefined;
    const meta: PinnedPr = {
      id: pr.prId,
      number: pr.prNumber,
      title: pr.prTitle,
      repoFullName: pr.repoFullName,
      authorLogin: u?.githubLogin ?? null,
      authorDisplayName: u?.displayName ?? null,
      authorAvatarUrl: u?.avatarUrl ?? null,
    };
    openPrDetailTab(meta);
  };

  // Merges are grouped by repo (the "per repo" ask); every other metric is a flat table.
  const mergesByRepo = useMemo(() => {
    if (active !== 'merges') return [];
    const byRepo = new Map<string, MetricPr[]>();
    for (const r of rows) {
      const a = byRepo.get(r.repoFullName) ?? [];
      a.push(r);
      byRepo.set(r.repoFullName, a);
    }
    return [...byRepo.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [active, rows]);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">Flow metrics</h2>
        <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-300">
          Pro
        </span>
        {detail && (
          <span className="text-[11px] text-gray-400">
            sprint: last 2 weeks · where issues cluster
          </span>
        )}
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isFetching}
          className="ml-auto rounded border border-gray-300 px-1.5 py-0.5 text-[11px] font-medium hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500"
        >
          <span aria-hidden className={isFetching ? 'animate-spin' : ''}>
            ↻
          </span>{' '}
          Refresh
        </button>
      </div>

      {/* Sub-tab bar — one per metric. */}
      <div role="tablist" className="flex flex-wrap gap-1 border-b border-gray-200 dark:border-gray-800">
        {TEAM_METRIC_KEYS.map((m) => {
          const on = m === active;
          const n = listFor(detail, m).length;
          return (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setActive(m)}
              className={`-mb-px rounded-t-md border border-b-0 px-3 py-1.5 text-xs font-medium ${
                on
                  ? 'border-gray-300 bg-white text-violet-600 dark:border-gray-700 dark:bg-gray-950 dark:text-violet-300'
                  : 'border-transparent text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-900/60'
              }`}
            >
              {METRIC_META[m].label}
              {detail ? <span className="ml-1 text-gray-400">{n}</span> : null}
            </button>
          );
        })}
      </div>

      <div className="text-[11px] text-gray-400">{METRIC_META[active].blurb}</div>

      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-8 animate-pulse rounded bg-gray-100 dark:bg-gray-900/40"
            />
          ))}
        </div>
      ) : isError ? (
        <div className="text-sm text-red-500">Couldn’t load the metric detail.</div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-gray-700">
          Nothing to show for this metric in the current sprint. 🎉
        </div>
      ) : active === 'merges' ? (
        <div className="space-y-4">
          {mergesByRepo.map(([repo, repoRows]) => (
            <div key={repo}>
              <div className="mb-1 text-xs font-semibold text-gray-600 dark:text-gray-300">
                {repo} <span className="text-gray-400">· {repoRows.length} merged</span>
              </div>
              <Table m={active} rows={repoRows} usersById={usersById} onOpen={openPr} />
            </div>
          ))}
        </div>
      ) : (
        <Table m={active} rows={rows} usersById={usersById} onOpen={openPr} />
      )}
    </div>
  );
}
