import { useMemo } from 'react';
import type { TimelinePr } from '@pierre-review/shared';
import { useUsers } from '../../hooks/useTimeline.js';
import { usePinnedTabs } from '../../store/pinnedTabs.js';
import {
  CI_META,
  REASON_META,
  indexUsers,
  mergeWarning,
  prNeedsAttention,
  relativeTime,
  userLabel,
} from '../../lib/ui.js';
import { Avatar } from '../CommentCard.js';
import { ThreadStateBar } from './ThreadStateBar.js';

// A compact, at-a-glance list of a repo's OPEN PRs (already member-filtered + reason-sorted
// by the server), shown ABOVE the repo's activity feed so you can gauge the repo's open
// work before reading the event stream. Each row → the full PR detail tab.
export function RepoOpenPrList({
  prs,
  repoFullName,
}: {
  prs: TimelinePr[];
  repoFullName: string;
}): JSX.Element | null {
  const { data: users } = useUsers();
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const usersById = useMemo(() => indexUsers(users), [users]);

  if (prs.length === 0) return null;

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800">
      <div className="border-b border-gray-200 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:border-gray-800 dark:text-gray-400">
        Open PRs · {prs.length}
      </div>
      <ul className="divide-y divide-gray-100 dark:divide-gray-800/70">
        {prs.map((pr) => {
          const ci = CI_META[pr.ciStatus];
          const author = pr.authorId != null ? usersById.get(pr.authorId) : undefined;
          const reason = REASON_META[pr.reasonTag];
          const warn = mergeWarning(pr.mergeable, pr.mergeStateStatus);
          const standing = pr.isApproved
            ? { label: 'approved', color: '#22c55e' }
            : pr.isChangesRequested
              ? { label: 'changes', color: '#ef4444' }
              : null;
          return (
            <li key={pr.id}>
              <button
                type="button"
                onClick={() =>
                  openPrDetailTab(
                    {
                      id: pr.id,
                      number: pr.number,
                      title: pr.title,
                      repoFullName,
                      authorLogin: null,
                      authorDisplayName: null,
                      authorAvatarUrl: null,
                    },
                    { fromActivity: true },
                  )
                }
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-gray-50 dark:hover:bg-gray-800/40"
              >
                {/* CI rollup dot (a hollow ring when there are no checks) */}
                <span
                  aria-hidden="true"
                  title={ci?.label ?? 'no checks'}
                  className="inline-block h-2 w-2 shrink-0 rounded-full"
                  style={
                    ci != null
                      ? { background: ci.color }
                      : { boxShadow: 'inset 0 0 0 1px #9ca3af' }
                  }
                />
                {/* Item 1: the same ⚠ the rail shows next to attention-needing repos, now
                    per-PR — flags the exact PRs driving that repo's attention count. */}
                {prNeedsAttention(pr) && (
                  <span
                    aria-hidden="true"
                    title="Needs attention (your turn · stalled · untouched threads · CI / conflicts)"
                    className="shrink-0 text-xs leading-none text-amber-500 dark:text-amber-400"
                  >
                    ⚠
                  </span>
                )}
                <Avatar user={author} size={16} />
                <span
                  className="min-w-0 max-w-[7rem] shrink-0 truncate text-gray-500 dark:text-gray-400"
                  title={userLabel(author, pr.authorId)}
                >
                  {userLabel(author, pr.authorId)}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-gray-400">#{pr.number}</span>{' '}
                  <span className="font-medium text-gray-700 dark:text-gray-200">{pr.title}</span>
                </span>

                {pr.isDraft && (
                  <span className="shrink-0 rounded bg-gray-500/15 px-1 text-[10px] font-medium text-gray-500 dark:text-gray-400">
                    draft
                  </span>
                )}
                {standing != null && (
                  <span
                    className="shrink-0 rounded px-1 text-[10px] font-semibold"
                    style={{ color: standing.color, background: standing.color + '1a' }}
                  >
                    {standing.label}
                  </span>
                )}
                {warn != null && (
                  <span className="shrink-0 rounded bg-orange-500/15 px-1 text-[10px] font-medium text-orange-600 dark:text-orange-400">
                    {warn}
                  </span>
                )}
                <ThreadStateBar counts={pr.threadCounts} compact />
                {reason.myTurn ? (
                  <span
                    className="hidden shrink-0 rounded px-1 text-[10px] font-medium sm:inline"
                    style={{ color: reason.color, background: reason.color + '1a' }}
                    title={userLabel(author, pr.authorId)}
                  >
                    {reason.label}
                  </span>
                ) : (
                  <span className="hidden shrink-0 text-[10px] text-gray-400 sm:inline">
                    {relativeTime(pr.updatedAt)}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
