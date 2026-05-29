import { useMemo } from 'react';
import { isMyTurnReason } from '@gh-team-monitor/shared';
import { useOpenPrs } from '../../hooks/useTriage.js';
import { useRepos, useUsers } from '../../hooks/useTimeline.js';
import { useFilters, type StripFilter } from '../../store/filters.js';
import { indexUsers } from '../../lib/ui.js';
import { PrCard } from './PrCard.js';

const FILTER_LABELS: Record<StripFilter, string> = {
  all: 'all open',
  my_turn: 'my turn',
  needs_attention: 'needs attention',
};

export function OpenPrsStrip(): JSX.Element | null {
  const { data, isLoading } = useOpenPrs();
  const { data: repos } = useRepos();
  const { data: users } = useUsers();

  const collapsed = useFilters((s) => s.stripCollapsed);
  const setCollapsed = useFilters((s) => s.setStripCollapsed);
  const filter = useFilters((s) => s.stripFilter);
  const setFilter = useFilters((s) => s.setStripFilter);

  const reposById = useMemo(() => {
    const m = new Map<number, string>();
    for (const r of repos ?? []) m.set(r.id, r.fullName);
    return m;
  }, [repos]);
  const usersById = useMemo(() => indexUsers(users), [users]);

  const all = data?.prs ?? [];
  const myTurnCount = all.filter((p) => isMyTurnReason(p.reasonTag)).length;
  const stalledCount = all.filter((p) => p.reasonTag === 'stalled').length;

  const shown = useMemo(() => {
    if (filter === 'my_turn') return all.filter((p) => isMyTurnReason(p.reasonTag));
    if (filter === 'needs_attention')
      return all.filter((p) => p.reasonTag !== 'in_progress');
    return all;
  }, [all, filter]);

  if (!isLoading && all.length === 0) return null;

  return (
    <div className="shrink-0 border-b border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/50">
      <div className="flex items-center gap-2 px-4 py-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
          Open PRs
        </span>
        {!collapsed && (
          <div className="flex items-center gap-1">
            {(Object.keys(FILTER_LABELS) as StripFilter[]).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`rounded-full px-2 py-0.5 text-[11px] ${
                  filter === f
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                {FILTER_LABELS[f]}
                {f === 'my_turn' && myTurnCount > 0 && ` (${myTurnCount})`}
              </button>
            ))}
          </div>
        )}
        {collapsed && (
          <span className="text-xs text-gray-500">
            {all.length} open · {myTurnCount} my turn · {stalledCount} stalled
          </span>
        )}
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          className="ml-auto rounded px-1.5 text-xs text-gray-400 hover:text-gray-600"
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? '▾' : '▴'}
        </button>
      </div>

      {!collapsed && (
        <div className="flex items-stretch gap-2 overflow-x-auto px-4 pb-2 pt-0.5">
          {shown.length === 0 ? (
            <div className="flex items-center text-xs text-gray-500">
              {filter === 'my_turn'
                ? 'Nothing needs you right now.'
                : 'No PRs match this filter.'}
            </div>
          ) : (
            shown.map((pr) => (
              <PrCard
                key={pr.id}
                pr={pr}
                repoFullName={reposById.get(pr.repoId) ?? `repo ${pr.repoId}`}
                usersById={usersById}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}
