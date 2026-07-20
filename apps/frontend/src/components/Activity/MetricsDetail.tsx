import { useEffect, useMemo, useState } from 'react';
import type { MetricPr, TeamMetricKey, User } from '@pierre-review/shared';
import { TEAM_METRIC_KEYS } from '@pierre-review/shared';
import { useTeamMetricsDetail } from '../../hooks/useTeamMetricsDetail.js';
import { useUsers } from '../../hooks/useTimeline.js';
import { useFilters, scopeToParam } from '../../store/filters.js';
import { usePinnedTabs, type PinnedPr } from '../../store/pinnedTabs.js';
import { CI_META, indexUsers, relativeTime } from '../../lib/ui.js';
import { fmtDuration } from '../charts/common.js';
import { Avatar } from '../CommentCard.js';
import { UserName } from '../UserName.js';
import { MetricRepoFilter } from './MetricRepoFilter.js';
import { SortHeader, type SortDir, type SortState, compare, nextSort } from './sortableTable.js';

// The flow-metric DRILL-DOWN — a persistent tab opened by clicking a metric tile in
// Insights. One sub-tab per metric, each listing the PRs behind that number (with the
// metric-specific figure) so a lead can see WHERE issues cluster. All data comes from a
// single lazy read (useTeamMetricsDetail); clicking any PR opens its detail tab.

const METRIC_META: Record<TeamMetricKey, { label: string; blurb: string }> = {
  open_prs: { label: 'Open PRs', blurb: 'All currently-open PRs · most-recently-updated first' },
  merges: { label: 'Merges', blurb: 'Merged this sprint · most-recently-updated first' },
  lead_time: { label: 'Lead time', blurb: 'Open → merge (merged + open) · longest first' },
  review_latency: { label: 'Review latency', blurb: 'Open → first review · longest first' },
  merge_ci: { label: 'Merge CI', blurb: 'Merged PRs · CI-failed-at-merge first' },
  ci_recovery: { label: 'CI recovery', blurb: 'Red → green · slowest first' },
  ci_red: { label: 'CI red now', blurb: 'Currently-failing branches · longest red first' },
};

// ── Sortable-table wiring (shared mechanics from ./sortableTable) ─────────────────────────
// The drill-down is a single table whose "value" + last columns are metric-specific, so the
// sort machinery switches on the active metric. Columns: pr | value | ci | diff | author |
// last (Reviewers/Merged by/Opened) | updated.
type SortCol = 'pr' | 'value' | 'ci' | 'diff' | 'author' | 'last' | 'updated';

// Natural first-click direction: text A→Z, time/size/duration lead with the most pressing end.
const DEFAULT_DIR: Record<SortCol, SortDir> = {
  pr: 'desc',
  value: 'desc',
  ci: 'asc',
  diff: 'desc',
  author: 'asc',
  last: 'desc',
  updated: 'desc',
};

// Per-tab default sort. Recency (updated desc) for the two tabs where "what moved lately" is
// the useful lens; the duration/CI tabs keep the metric magnitude as the sort (which IS the
// point of the tile — e.g. NOT recency for lead time), reproducing the backend order.
const DEFAULT_SORT: Record<TeamMetricKey, SortState<SortCol> | null> = {
  open_prs: { col: 'updated', dir: 'desc' },
  merges: { col: 'updated', dir: 'desc' },
  lead_time: { col: 'value', dir: 'desc' },
  review_latency: { col: 'value', dir: 'desc' },
  merge_ci: { col: 'value', dir: 'desc' },
  ci_recovery: { col: 'value', dir: 'desc' },
  ci_red: { col: 'value', dir: 'desc' },
};

// CI rollup → a sortable rank (failing first under 'asc'; null/no-checks last).
const CI_RANK: Record<string, number> = {
  failure: 0,
  error: 0,
  pending: 1,
  success: 2,
  expected: 3,
  unknown: 4,
};
function ciRank(ci: MetricPr['ciStatus']): number {
  return ci == null ? 5 : CI_RANK[ci] ?? 4;
}

// The metric-specific "value" column, mapped to a numeric magnitude so it sorts sensibly.
function valueSort(m: TeamMetricKey, pr: MetricPr): number {
  switch (m) {
    case 'open_prs':
    case 'merges':
    case 'lead_time':
      return pr.leadTimeHours ?? -1;
    case 'review_latency':
      return pr.reviewLatencyHours ?? -1;
    case 'ci_recovery':
      return pr.recoveryHours ?? -1;
    case 'ci_red':
      return pr.redAgeHours ?? -1;
    case 'merge_ci':
      // "redness" — red highest so a desc sort surfaces CI-failed-at-merge first (backend order).
      return pr.ciStatus === 'failure' || pr.ciStatus === 'error' ? 2 : pr.ciStatus === 'pending' ? 1 : 0;
  }
}

// The contextual last column (Reviewers / Merged by / Opened) → a sortable value.
function lastColSort(m: TeamMetricKey, pr: MetricPr, usersById: Map<number, User>): number | string {
  if (m === 'review_latency') return pr.reviewerIds.length;
  if (m === 'merges' || m === 'merge_ci') {
    const u = pr.mergedById != null ? usersById.get(pr.mergedById) : undefined;
    return (u?.githubLogin ?? String(pr.mergedById ?? '')).toLowerCase();
  }
  return pr.openedAt; // ISO-8601 → chronological string sort
}

// The per-column sort value. Numeric columns MUST return a number (never the formatted
// DiffCell string), or compare() localeCompares lexicographically and '100' < '20'.
function sortValue(
  pr: MetricPr,
  m: TeamMetricKey,
  col: SortCol,
  usersById: Map<number, User>,
): number | string {
  switch (col) {
    case 'pr':
      return pr.prNumber;
    case 'value':
      return valueSort(m, pr);
    case 'ci':
      return ciRank(pr.ciStatus);
    case 'diff':
      return pr.additions + pr.deletions; // numeric LoC — the diff-count sort fix
    case 'author': {
      const u = pr.authorId != null ? usersById.get(pr.authorId) : undefined;
      return (u?.githubLogin ?? String(pr.authorId ?? '')).toLowerCase();
    }
    case 'updated':
      return pr.updatedAt;
    case 'last':
      return lastColSort(m, pr, usersById);
  }
}

function listFor(
  detail: NonNullable<ReturnType<typeof useTeamMetricsDetail>['data']>['detail'],
  m: TeamMetricKey,
): MetricPr[] {
  if (!detail) return [];
  switch (m) {
    case 'open_prs':
      return detail.openPrs;
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
    case 'open_prs':
      return 'Open for';
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
    case 'open_prs':
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
        {/* Two lines per PR: the repo/number pointer, then the title — easier to scan than
            one long truncated line. */}
        <button
          type="button"
          onClick={() => onOpen(pr)}
          className="block max-w-md text-left hover:underline"
          title={`${pr.repoFullName} #${pr.prNumber} — ${pr.prTitle}`}
        >
          <span className="block truncate font-mono text-[11px] text-gray-400">
            {pr.repoFullName} #{pr.prNumber}
          </span>
          <span className="block truncate text-sm font-medium text-gray-800 dark:text-gray-100">
            {pr.prTitle}
          </span>
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
      <td className="py-1.5 pr-3 text-[11px] text-gray-500 dark:text-gray-400">
        {relativeTime(pr.updatedAt)}
      </td>
    </tr>
  );
}

function Table({
  m,
  rows,
  usersById,
  onOpen,
  sort,
  onSort,
}: {
  m: TeamMetricKey;
  rows: MetricPr[];
  usersById: Map<number, User>;
  onOpen: (pr: MetricPr) => void;
  sort: SortState<SortCol> | null;
  onSort: (col: SortCol) => void;
}): JSX.Element {
  const lastCol = m === 'review_latency' ? 'Reviewers' : m === 'merges' || m === 'merge_ci' ? 'Merged by' : 'Opened';
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] border-collapse text-sm">
        <thead>
          <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-gray-400">
            <SortHeader col="pr" label="Pull request" sort={sort} onSort={onSort} />
            <SortHeader col="value" label={valueHeader(m)} sort={sort} onSort={onSort} />
            <SortHeader col="ci" label="CI" sort={sort} onSort={onSort} />
            <SortHeader col="diff" label="Diff" sort={sort} onSort={onSort} title="Diff size (added + deleted lines)" />
            <SortHeader col="author" label="Author" sort={sort} onSort={onSort} />
            <SortHeader col="last" label={lastCol} sort={sort} onSort={onSort} />
            <SortHeader col="updated" label="Updated" sort={sort} onSort={onSort} title="GitHub last-activity time" />
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
  // Match the scoped tile that opened this drill-down — scope is in the query key so a scope
  // change refetches.
  const scope = scopeToParam(useFilters((s) => s.teamScope));
  const { data, isLoading, isError, refetch, isFetching } = useTeamMetricsDetail(true, scope);
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

  // Sort is PER-TAB (each metric keeps its own column + direction), seeded from DEFAULT_SORT —
  // recency for open_prs/merges, metric magnitude for the duration/CI tabs. Header clicks toggle.
  const [sortByTab, setSortByTab] = useState<Record<TeamMetricKey, SortState<SortCol> | null>>(
    () => ({ ...DEFAULT_SORT }),
  );
  const sort = sortByTab[active];
  const onSort = (col: SortCol): void =>
    setSortByTab((prev) => ({ ...prev, [active]: nextSort(prev[active], col, DEFAULT_DIR) }));

  const detail = data?.detail ?? null;

  // Per-metric-tab repo filter — each tab owns its own selection (null = all team repos),
  // so filtering CI-red doesn't disturb Merges. Independent across tabs, as requested.
  const [repoSel, setRepoSel] = useState<Partial<Record<TeamMetricKey, number[] | null>>>({});
  const activeSel = repoSel[active] ?? null;
  const setActiveSel = (sel: number[] | null): void =>
    setRepoSel((prev) => ({ ...prev, [active]: sel }));

  // The repos that appear anywhere in the drill-down — a STABLE option set for the dropdown
  // (switching tabs changes the per-tab selection, not the menu itself).
  const repoOptions = useMemo(() => {
    const byId = new Map<number, string>();
    if (detail)
      for (const k of TEAM_METRIC_KEYS)
        for (const r of listFor(detail, k)) byId.set(r.repoId, r.repoFullName);
    return [...byId.entries()]
      .map(([id, fullName]) => ({ id, fullName }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
  }, [detail]);

  // Flat list ordered by the metric, filtered to the selected repos (null = all, across repos),
  // then re-sorted by the active tab's column (null sort = the backend's metric order).
  const allRows = listFor(detail, active);
  const rows = useMemo(() => {
    const filtered = activeSel == null ? allRows : allRows.filter((r) => activeSel.includes(r.repoId));
    if (sort == null) return filtered;
    const mul = sort.dir === 'asc' ? 1 : -1;
    return [...filtered].sort(
      (a, b) =>
        mul * compare(sortValue(a, active, sort.col, usersById), sortValue(b, active, sort.col, usersById)) ||
        b.prNumber - a.prNumber, // stable final tiebreak
    );
  }, [allRows, activeSel, sort, active, usersById]);
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

  return (
    <div className="mx-auto max-w-[100rem] space-y-4 p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">Flow metrics</h2>
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

      <div className="flex flex-wrap items-center gap-2">
        <div className="text-[11px] text-gray-400">
          {METRIC_META[active].blurb} · click a column to sort
        </div>
        {rows.length !== allRows.length && (
          <span className="text-[11px] text-gray-400">
            · {rows.length} of {allRows.length}
          </span>
        )}
        <div className="ml-auto">
          <MetricRepoFilter repos={repoOptions} selected={activeSel} onChange={setActiveSel} />
        </div>
      </div>

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
          {allRows.length === 0
            ? 'Nothing to show for this metric in the current sprint. 🎉'
            : 'No PRs for the selected repos — adjust the repo filter.'}
        </div>
      ) : (
        <Table m={active} rows={rows} usersById={usersById} onOpen={openPr} sort={sort} onSort={onSort} />
      )}
    </div>
  );
}
