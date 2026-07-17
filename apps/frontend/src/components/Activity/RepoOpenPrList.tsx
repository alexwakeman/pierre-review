import { useMemo } from 'react';
import type { TimelinePr, User } from '@pierre-review/shared';
import { useUsers } from '../../hooks/useTimeline.js';
import { useFilters } from '../../store/filters.js';
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

// One open-PR row: CI dot · ⚠ needs-attention · #number title · author · draft / approval /
// merge chips · thread-state bar · my-turn reason or updated-time. Shared by the single-repo
// RepoOpenPrList and the Feed's team-grouped "open PRs" panel, so both read identically. The
// click action + selected highlight are injected (open a detail tab vs isolate the feed).
export function OpenPrRow({
  pr,
  author,
  onClick,
  selected = false,
}: {
  pr: TimelinePr;
  author: User | undefined;
  onClick: () => void;
  selected?: boolean;
}): JSX.Element {
  const ci = CI_META[pr.ciStatus];
  const reason = REASON_META[pr.reasonTag];
  const warn = mergeWarning(pr.mergeable, pr.mergeStateStatus);
  const standing = pr.isApproved
    ? { label: 'approved', color: '#22c55e' }
    : pr.isChangesRequested
      ? { label: 'changes', color: '#ef4444' }
      : null;
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        aria-pressed={selected}
        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${
          selected
            ? 'bg-sky-100 dark:bg-sky-900/40'
            : 'hover:bg-gray-50 dark:hover:bg-gray-800/40'
        }`}
      >
        {/* CI rollup dot (a hollow ring when there are no checks) */}
        <span
          aria-hidden="true"
          title={ci?.label ?? 'no checks'}
          className="inline-block h-2 w-2 shrink-0 rounded-full"
          style={ci != null ? { background: ci.color } : { boxShadow: 'inset 0 0 0 1px #9ca3af' }}
        />
        {/* Item 1: the same ⚠ the rail shows next to attention-needing repos, now per-PR —
            flags the exact PRs driving that repo's attention count. */}
        {prNeedsAttention(pr) && (
          <span
            aria-hidden="true"
            title="Needs attention (your turn · stalled · untouched threads · CI / conflicts)"
            className="shrink-0 text-xs leading-none text-amber-500 dark:text-amber-400"
          >
            ⚠
          </span>
        )}
        <span className="min-w-0 flex-1 truncate">
          <span className="text-gray-400">#{pr.number}</span>{' '}
          <span className="font-medium text-gray-700 dark:text-gray-200">{pr.title}</span>
        </span>
        {/* PR author — to the right of the title. */}
        <Avatar user={author} size={16} />
        <span
          className="max-w-[7rem] shrink-0 truncate text-gray-500 dark:text-gray-400"
          title={userLabel(author, pr.authorId)}
        >
          {userLabel(author, pr.authorId)}
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
}

// A compact, at-a-glance list of a repo's OPEN PRs (already member-filtered + reason-sorted
// by the server), shown ABOVE the repo's activity feed. Clicking a PR ISOLATES the repo's
// feed to that PR (toggle: click the selected one again to clear) — mirroring the cross-repo
// FeedOpenPrsPanel — so this list doubles as the repo feed's per-PR filter.
export function RepoOpenPrList({ prs }: { prs: TimelinePr[] }): JSX.Element | null {
  const { data: users } = useUsers();
  const isolatedPrId = useFilters((s) => s.feedIsolatedPrId);
  const setIsolatedPrId = useFilters((s) => s.setFeedIsolatedPrId);
  const usersById = useMemo(() => indexUsers(users), [users]);

  if (prs.length === 0) return null;

  // "Open PRs" counts NON-DRAFT opens, matching the rail's [N] stat (repo.stats.openPrs =
  // non-draft), and drafts are called out separately — so the header reconciles with the rail
  // instead of contradicting it (the list itself still shows every open PR, drafts included).
  const draftCount = prs.reduce((n, p) => n + (p.isDraft ? 1 : 0), 0);
  const openCount = prs.length - draftCount;

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800">
      <div className="flex items-center gap-1.5 border-b border-gray-200 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:border-gray-800 dark:text-gray-400">
        Open PRs · {openCount}
        {draftCount > 0 && (
          <span className="font-normal normal-case text-gray-400">
            · {draftCount} draft{draftCount === 1 ? '' : 's'}
          </span>
        )}
        <span className="ml-auto font-normal normal-case text-gray-400">
          click a PR to filter the feed
        </span>
      </div>
      <ul className="divide-y divide-gray-100 dark:divide-gray-800/70">
        {prs.map((pr) => (
          <OpenPrRow
            key={pr.id}
            pr={pr}
            author={pr.authorId != null ? usersById.get(pr.authorId) : undefined}
            selected={isolatedPrId === pr.id}
            onClick={() => setIsolatedPrId(isolatedPrId === pr.id ? null : pr.id)}
          />
        ))}
      </ul>
    </div>
  );
}
