import type { ThreadDetail, User } from '@gh-team-monitor/shared';
import { useFilters } from '../../store/filters.js';
import { ThreadCard } from '../ThreadView/index.js';
import { ThreadCountChips, rollupCounts } from './ThreadCountChips.js';

// Newest thread first (by createdAt).
function sortThreads(threads: ThreadDetail[]): ThreadDetail[] {
  return [...threads].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function FileGroup({
  path,
  threads,
  usersById,
  prUrl,
  repoId,
  selectedThreadId,
  viewedSince,
  registerRef,
}: {
  path: string;
  threads: ThreadDetail[];
  usersById: Map<number, User>;
  prUrl: string;
  repoId?: number;
  selectedThreadId: number | null;
  viewedSince?: string | null;
  registerRef: (threadId: number, el: HTMLDivElement | null) => void;
}): JSX.Element {
  const counts = rollupCounts(threads);
  const hasUnresolved = threads.some((t) => t.derivedState !== 'resolved');
  const containsSelected =
    selectedThreadId != null && threads.some((t) => t.id === selectedThreadId);

  // Default: expand files with any non-resolved thread; collapse all-resolved.
  const defaultExpanded = hasUnresolved;
  const expandedFileGroups = useFilters((s) => s.expandedFileGroups);
  const collapsedFileGroups = useFilters((s) => s.collapsedFileGroups);
  const toggleFileGroup = useFilters((s) => s.toggleFileGroup);

  const userExpanded = defaultExpanded
    ? !collapsedFileGroups.includes(path)
    : expandedFileGroups.includes(path);
  const isExpanded = containsSelected || userExpanded;

  const segments = path.split('/');
  const fileName = segments.at(-1);
  const dir = segments.slice(0, -1).join('/');

  return (
    <div className="border-b border-gray-100 dark:border-gray-800">
      <button
        type="button"
        onClick={() => toggleFileGroup(path, defaultExpanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-900"
      >
        <span className="text-gray-400">{isExpanded ? '▾' : '▸'}</span>
        <code className="min-w-0 flex-1 truncate font-mono text-xs" title={path}>
          {dir && <span className="text-gray-400">{dir}/</span>}
          <span className="font-semibold">{fileName}</span>
        </code>
        <ThreadCountChips counts={counts} />
      </button>

      {isExpanded && (
        <div className="space-y-2 px-3 pb-3">
          {sortThreads(threads).map((t) => (
            <div key={t.id} ref={(el) => registerRef(t.id, el)}>
              <ThreadCard
                thread={t}
                usersById={usersById}
                prUrl={prUrl}
                repoId={repoId}
                selected={t.id === selectedThreadId}
                viewedSince={viewedSince}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
