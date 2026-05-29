import { useEffect, useMemo, useRef } from 'react';
import type { ThreadDetail, User } from '@gh-team-monitor/shared';
import { FileGroup } from './FileGroup.js';
import { rollupCounts } from './ThreadCountChips.js';

interface FileBucket {
  path: string;
  threads: ThreadDetail[];
  unresolved: number;
}

function groupByFile(threads: ThreadDetail[]): FileBucket[] {
  const byPath = new Map<string, ThreadDetail[]>();
  for (const t of threads) {
    const arr = byPath.get(t.path) ?? [];
    arr.push(t);
    byPath.set(t.path, arr);
  }
  const buckets: FileBucket[] = [...byPath.entries()].map(([path, ts]) => {
    const c = rollupCounts(ts);
    return {
      path,
      threads: ts,
      unresolved: c.untouched + c.replied_unresolved + c.likely_addressed,
    };
  });
  // Most-actionable files first: by non-resolved count desc, then path asc.
  buckets.sort((a, b) => {
    if (b.unresolved !== a.unresolved) return b.unresolved - a.unresolved;
    return a.path.localeCompare(b.path);
  });
  return buckets;
}

export function ThreadList({
  threads,
  usersById,
  prUrl,
  selectedThreadId,
  viewedSince,
}: {
  threads: ThreadDetail[];
  usersById: Map<number, User>;
  prUrl: string;
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
