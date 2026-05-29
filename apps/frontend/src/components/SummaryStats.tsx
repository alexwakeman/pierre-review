import { useMemo } from 'react';
import { useRepos, useTimeline } from '../hooks/useTimeline.js';

interface RepoStat {
  repoId: number;
  name: string;
  openPrs: number;
  stalled: number;
  untouched: number;
  replied: number;
}

// Empty-state stats shown when no PR is selected: a quick read on where
// attention is needed, by repo.
export function SummaryStats(): JSX.Element {
  const { data: timeline } = useTimeline();
  const { data: repos } = useRepos();

  const stats = useMemo<RepoStat[]>(() => {
    if (!timeline) return [];
    const byId = new Map<number, RepoStat>();
    const nameOf = (id: number) =>
      repos?.find((r) => r.id === id)?.fullName ?? `repo ${id}`;
    for (const pr of timeline.prs) {
      const s =
        byId.get(pr.repoId) ??
        {
          repoId: pr.repoId,
          name: nameOf(pr.repoId),
          openPrs: 0,
          stalled: 0,
          untouched: 0,
          replied: 0,
        };
      if (pr.state === 'open') s.openPrs += 1;
      if (pr.isStalled) s.stalled += 1;
      s.untouched += pr.threadCounts.untouched;
      s.replied += pr.threadCounts.replied_unresolved;
      byId.set(pr.repoId, s);
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [timeline, repos]);

  if (stats.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-gray-500">
        Select a PR or event on the timeline.
      </div>
    );
  }

  return (
    <div className="p-4">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
        In this window
      </h2>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-gray-400">
            <th className="py-1 pr-4 font-medium">Repo</th>
            <th className="py-1 pr-4 text-right font-medium">Open PRs</th>
            <th className="py-1 pr-4 text-right font-medium">Stalled</th>
            <th className="py-1 pr-4 text-right font-medium">Untouched</th>
            <th className="py-1 pr-4 text-right font-medium">Replied</th>
          </tr>
        </thead>
        <tbody>
          {stats.map((s) => (
            <tr key={s.repoId} className="border-t border-gray-100 dark:border-gray-800">
              <td className="py-1.5 pr-4 font-medium">{s.name}</td>
              <td className="py-1.5 pr-4 text-right tabular-nums">{s.openPrs}</td>
              <td
                className={`py-1.5 pr-4 text-right tabular-nums ${s.stalled > 0 ? 'font-semibold text-red-500' : ''}`}
              >
                {s.stalled}
              </td>
              <td
                className={`py-1.5 pr-4 text-right tabular-nums ${s.untouched > 0 ? 'font-semibold text-red-400' : ''}`}
              >
                {s.untouched}
              </td>
              <td
                className={`py-1.5 pr-4 text-right tabular-nums ${s.replied > 0 ? 'text-amber-500' : ''}`}
              >
                {s.replied}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
