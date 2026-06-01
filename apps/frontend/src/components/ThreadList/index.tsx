import { useEffect, useMemo, useRef } from 'react';
import type { ThreadDetail, User } from '@gh-team-monitor/shared';
import { FileGroup } from './FileGroup.js';

interface FileBucket {
  path: string;
  threads: ThreadDetail[];
  // The most-recent thread's createdAt in this file, for newest-first ordering.
  newest: string;
}

function groupByFile(threads: ThreadDetail[]): FileBucket[] {
  const byPath = new Map<string, ThreadDetail[]>();
  for (const t of threads) {
    const arr = byPath.get(t.path) ?? [];
    arr.push(t);
    byPath.set(t.path, arr);
  }
  const buckets: FileBucket[] = [...byPath.entries()].map(([path, ts]) => ({
    path,
    threads: ts,
    newest: ts.reduce((m, t) => (t.createdAt > m ? t.createdAt : m), ''),
  }));
  // Files with the most-recent thread first (newest activity rises to the top);
  // path as a stable tiebreak.
  buckets.sort((a, b) => b.newest.localeCompare(a.newest) || a.path.localeCompare(b.path));
  return buckets;
}

export function ThreadList({
  threads,
  usersById,
  prUrl,
  repoId,
  selectedThreadId,
  viewedSince,
}: {
  threads: ThreadDetail[];
  usersById: Map<number, User>;
  prUrl: string;
  repoId?: number;
  selectedThreadId: number | null;
  viewedSince?: string | null;
}): JSX.Element {
  const rowRefs = useRef(new Map<number, HTMLDivElement>());

  // Scroll to a thread selected from a timeline marker / popover.
  useEffect(() => {
    if (selectedThreadId == null) return;
    const el = rowRefs.current.get(selectedThreadId);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [selectedThreadId]);

  const buckets = useMemo(() => groupByFile(threads), [threads]);

  if (threads.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-sm text-gray-500">
        No review threads on this PR.
      </div>
    );
  }

  return (
    <div>
      {buckets.map((b) => (
        <FileGroup
          key={b.path}
          path={b.path}
          threads={b.threads}
          usersById={usersById}
          prUrl={prUrl}
          repoId={repoId}
          selectedThreadId={selectedThreadId}
          viewedSince={viewedSince}
          registerRef={(id, el) => {
            if (el) rowRefs.current.set(id, el);
            else rowRefs.current.delete(id);
          }}
        />
      ))}
    </div>
  );
}
