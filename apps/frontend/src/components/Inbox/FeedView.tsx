import { useMemo } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type {
  ConsolidatedFeedItem,
  EventType,
  FeedAffectedThread,
  ReviewState,
  User,
} from '@pierre-review/shared';
import { useConsolidatedFeed } from '../../hooks/useConsolidatedFeed.js';
import { useFilters } from '../../store/filters.js';
import { usePinnedTabs, type TabMeta } from '../../store/pinnedTabs.js';
import {
  DERIVED_STATE_META,
  EVENT_META,
  REASON_META,
  indexUsers,
  relativeTime,
  userLabel,
} from '../../lib/ui.js';
import { Avatar } from '../CommentCard.js';
import { Markdown } from '../Markdown.js';
import { FeedDigestPanel } from './FeedDigestPanel.js';

// A coloured chip + label describing what an item is — reused vocabulary from lib/ui.ts
// (my-turn reason tags / event types) plus the my-turn "special" kinds.
function itemGlyph(item: ConsolidatedFeedItem): { color: string; label: string } {
  if (item.source === 'my_turn') {
    if (item.reasonTag != null) {
      const meta = REASON_META[item.reasonTag];
      return { color: meta.color, label: meta.label };
    }
    if (item.kind === 'claude_review') return { color: '#a78bfa', label: 'Claude review' };
    if (item.kind === 'watched_repo_pr') return { color: '#0ea5e9', label: 'New in watched repo' };
    if (item.kind === 'thread') return { color: '#f59e0b', label: 'Reply awaiting you' };
    return { color: '#3b82f6', label: 'Your turn' };
  }
  const meta = EVENT_META[item.kind as EventType];
  return { color: meta?.color ?? '#6b7280', label: meta?.label ?? item.kind };
}

// Local review-state presentation (label + colour) — kept local so we don't widen the
// shared lib/ui.ts. Mirrors the timeline's review verdict colours.
const REVIEW_STATE_META: Record<ReviewState, { label: string; color: string }> = {
  approved: { label: 'approved', color: '#22c55e' },
  changes_requested: { label: 'requested changes', color: '#ef4444' },
  commented: { label: 'commented', color: '#9ca3af' },
  dismissed: { label: 'dismissed', color: '#9ca3af' },
  pending: { label: 'pending', color: '#eab308' },
};

// The consolidated Feed — a flat, chronological, social-style stream. Cross-repo when
// `repoId` is absent (scoped by the active FilterBar repos/members); scoped to a single
// repo when a rail repo is selected (`repoId` set). "My Turn" items get a yellow border
// and an always-on badge, plus an optional client-side "My Turn only" filter.
export function FeedView({ repoId }: { repoId?: number }): JSX.Element {
  const storeRepoIds = useFilters((s) => s.repoIds);
  const userIds = useFilters((s) => s.userIds);
  const excludeBots = useFilters((s) => s.excludeBots);
  const feedMyTurnOnly = useFilters((s) => s.feedMyTurnOnly);
  const toggleFeedMyTurnOnly = useFilters((s) => s.toggleFeedMyTurnOnly);
  const openClaudeReview = useFilters((s) => s.openClaudeReview);
  const selectThread = useFilters((s) => s.selectThread);
  const selectPr = useFilters((s) => s.selectPr);
  const openPrFocusTab = usePinnedTabs((s) => s.openPrFocusTab);

  // A selected rail repo scopes the feed to just that repo; otherwise follow the store's
  // active repo filter (a FilterBar change refetches via the query key). The bots toggle
  // flows in too, so hiding bots on the timeline also hides them here.
  const effectiveRepoIds = repoId != null ? [repoId] : storeRepoIds;
  const { items: loaded, users, hasMore, loadMore, isFetchingMore } = useConsolidatedFeed({
    repoIds: effectiveRepoIds,
    userIds,
    excludeBots,
  });

  const usersById = useMemo(() => indexUsers(users), [users]);
  // The feed has no "seen" concept anymore (the Done/acknowledge control was removed):
  // defensively drop any `acknowledged` copy so a handled item never lingers as a
  // full-prominence "My Turn" card (the backend no longer emits them).
  const items = loaded.filter((i) => !i.acknowledged);
  const myTurnCount = items.filter((i) => i.source === 'my_turn').length;
  const visible = feedMyTurnOnly ? items.filter((i) => i.source === 'my_turn') : items;

  const metaOf = (item: ConsolidatedFeedItem, prId: number): TabMeta => ({
    id: prId,
    number: item.prNumber ?? 0,
    title: item.prTitle ?? `#${item.prNumber ?? ''}`,
    repoFullName: item.repoFullName,
    authorLogin: null, // backfilled by PrDetail.syncMeta once the tab opens
    authorDisplayName: null,
    authorAvatarUrl: null,
  });

  // Open an item: tab management (activate a PR-focus tab + auto-push a Back-to-Inbox
  // history entry, since the Inbox is active at click time) is `openPrFocusTab`; it does
  // NOT drive selection, so we drive it ourselves (Claude tab / thread / PR).
  function open(item: ConsolidatedFeedItem): void {
    const prId = item.prId;
    if (prId == null) return;
    openPrFocusTab(metaOf(item, prId));
    if (item.kind === 'claude_review') openClaudeReview(prId);
    else if (item.threadId != null) selectThread(prId, item.threadId);
    else selectPr(prId);
  }

  // Open a specific affected review thread inline on a commit item — jump straight to that
  // addressed thread in the PR-focus tab rather than the PR's first thread.
  function openThread(item: ConsolidatedFeedItem, threadId: number): void {
    const prId = item.prId;
    if (prId == null) return;
    openPrFocusTab(metaOf(item, prId));
    selectThread(prId, threadId);
  }

  return (
    <div className="space-y-3">
      {/* The cross-repo Pro digest sits atop the cross-repo feed only (the per-repo Pro
          digest lives in RepoFeedHeader for the single-repo view). */}
      {repoId == null && <FeedDigestPanel />}

      {/* My Turn filter toggle + a "showing X of Y" hint. */}
      <div className="flex items-center gap-2 px-0.5">
        <button
          type="button"
          onClick={toggleFeedMyTurnOnly}
          aria-pressed={feedMyTurnOnly}
          className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
            feedMyTurnOnly
              ? 'border-yellow-400 bg-yellow-50 text-yellow-700 dark:border-yellow-500/60 dark:bg-yellow-950/30 dark:text-yellow-300'
              : 'border-gray-300 text-gray-500 hover:border-gray-400 dark:border-gray-700 dark:text-gray-400'
          }`}
          title="Show only items that need your attention (My Turn)"
        >
          <span aria-hidden="true">★</span> My Turn
          {myTurnCount > 0 && (
            <span className="tabular-nums opacity-70">{myTurnCount}</span>
          )}
        </button>
        {items.length > 0 && (
          <span className="text-[11px] text-gray-400">
            {visible.length} of {items.length}
          </span>
        )}
      </div>

      {items.length === 0 ? (
        <div className="flex h-32 items-center justify-center text-sm text-gray-400">
          Nothing to show yet — activity across your repos will appear here.
        </div>
      ) : visible.length === 0 ? (
        <div className="flex h-32 items-center justify-center text-sm text-gray-400">
          Nothing needs your attention right now.
        </div>
      ) : (
        <ul className="space-y-2">
          {visible.map((item) => {
            const actorUser =
              item.actorId != null ? usersById.get(item.actorId) : undefined;
            const mergedBy =
              item.mergedById != null ? usersById.get(item.mergedById) : undefined;
            const mergedByLabel =
              mergedBy != null || item.mergedById != null
                ? userLabel(mergedBy, item.mergedById)
                : null;
            const reviewerLabels = (item.reviewers ?? []).map((r) =>
              userLabel(usersById.get(r.userId), r.userId),
            );
            return (
              <FeedRow
                key={item.id}
                item={item}
                actorUser={actorUser}
                mergedByLabel={mergedByLabel}
                reviewerLabels={reviewerLabels}
                usersById={usersById}
                onOpen={() => open(item)}
                onOpenThread={(tid) => openThread(item, tid)}
              />
            );
          })}
        </ul>
      )}

      {/* Pagination: only the loaded pages are fetched + rendered; "Load more" pulls the
          next page by offset (never re-fetching earlier ones). */}
      {hasMore && items.length > 0 && (
        <div className="flex justify-center pt-1">
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={isFetchingMore}
            className="rounded-full border border-gray-300 px-4 py-1.5 text-xs font-medium text-gray-600 hover:border-gray-400 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:border-gray-500 dark:hover:bg-gray-800/50"
          >
            {isFetchingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}

// One review thread that a commit item likely addressed — a clickable row (opens that
// thread in the PR-focus tab) showing the file/line, the thread's new derived state, and
// a preview of what the reviewer originally asked.
function AffectedThreadRow({
  thread,
  author,
  onOpen,
}: {
  thread: FeedAffectedThread;
  author: User | undefined;
  onOpen: () => void;
}): JSX.Element {
  const meta = DERIVED_STATE_META[thread.derivedState];
  const file = thread.path.split('/').pop() ?? thread.path;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="group/th block w-full rounded border border-gray-200 bg-white/60 px-2 py-1 text-left hover:border-sky-300 dark:border-gray-800 dark:bg-gray-900/40 dark:hover:border-sky-700"
      >
        <span className="flex items-center gap-1.5 text-[11px]">
          <span
            aria-hidden="true"
            className="inline-block h-2 w-2 shrink-0 rounded-full"
            style={{ background: meta.color }}
          />
          <code className="truncate font-mono text-gray-600 group-hover/th:text-sky-600 dark:text-gray-300">
            {file}
            {thread.line != null ? `:${thread.line}` : ''}
          </code>
          <span className="shrink-0 text-gray-400">{meta.label.toLowerCase()}</span>
        </span>
        {thread.excerpt.trim() !== '' && (
          <span className="mt-0.5 block truncate text-xs italic text-gray-500 dark:text-gray-400">
            {author != null ? `${userLabel(author, thread.authorId)}: ` : ''}“{thread.excerpt}”
          </span>
        )}
      </button>
    </li>
  );
}

function FeedRow({
  item,
  actorUser,
  mergedByLabel,
  reviewerLabels,
  usersById,
  onOpen,
  onOpenThread,
}: {
  item: ConsolidatedFeedItem;
  actorUser: User | undefined;
  mergedByLabel: string | null;
  reviewerLabels: string[];
  usersById: Map<number, User>;
  onOpen: () => void;
  onOpenThread: (threadId: number) => void;
}): JSX.Element {
  const glyph = itemGlyph(item);
  const isMyTurn = item.source === 'my_turn';
  // Claude runs have no GitHub actor (actorId null) — render them as "Claude" with a
  // distinct badge rather than the generic 'unknown' user. A commit push whose author
  // didn't resolve to a GitHub login shows a neutral label instead of the bare 'unknown'.
  const isClaude = item.source === 'my_turn' && item.kind === 'claude_review';
  const actorName = isClaude
    ? 'Claude'
    : item.actorId == null && item.kind === 'commit_pushed'
      ? 'A contributor'
      : userLabel(actorUser, item.actorId);
  const prLabel =
    item.prNumber != null
      ? `#${item.prNumber}${item.prTitle != null ? ` ${item.prTitle}` : ''}`
      : '';
  const reviewMeta = item.reviewState != null ? REVIEW_STATE_META[item.reviewState] : null;
  const affected = item.affectedThreads ?? [];

  // Convenience: a click anywhere on the card opens it, but let markdown links / the PR
  // button win (they call their own handlers).
  const onCardClick = (e: ReactMouseEvent<HTMLElement>): void => {
    if ((e.target as HTMLElement).closest('a,button')) return;
    onOpen();
  };

  return (
    <li>
      <article
        onClick={onCardClick}
        className={`cursor-pointer rounded-md border p-2.5 text-sm transition-colors ${
          isMyTurn
            ? 'border-yellow-400 bg-yellow-50/40 dark:border-yellow-500/50 dark:bg-yellow-950/15'
            : 'border-gray-200 hover:border-sky-300 dark:border-gray-800 dark:hover:border-sky-700'
        }`}
      >
        {/* header: avatar + actor + action chip + (My Turn badge) + time */}
        <div className="flex items-center gap-2">
          {isClaude ? (
            <span
              aria-hidden="true"
              title="Claude"
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-violet-500/20 text-[11px] text-violet-600 dark:text-violet-300"
            >
              ✦
            </span>
          ) : (
            <Avatar user={actorUser} size={20} />
          )}
          <span className="truncate font-medium text-gray-800 dark:text-gray-100">
            {actorName}
          </span>
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium"
            style={{ color: glyph.color, background: glyph.color + '1a' }}
          >
            {glyph.label}
          </span>
          {isMyTurn && (
            <span className="shrink-0 rounded bg-yellow-400/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-yellow-700 dark:text-yellow-300">
              My Turn
            </span>
          )}
          <span className="ml-auto shrink-0 text-[11px] text-gray-400">
            {relativeTime(item.occurredAt)}
          </span>
        </div>

        {/* PR ref line — the keyboard-accessible open affordance */}
        <div className="mt-1 flex items-baseline gap-1.5 text-xs">
          <span className="shrink-0 text-gray-400">{item.repoFullName}</span>
          {prLabel !== '' && (
            <button
              type="button"
              onClick={onOpen}
              className="min-w-0 truncate font-medium text-gray-700 hover:text-sky-600 hover:underline dark:text-gray-200"
            >
              {prLabel}
            </button>
          )}
          {item.path != null && (
            <span className="shrink-0 text-gray-400">· {item.path.split('/').pop()}</span>
          )}
        </div>

        {/* FULL markdown body (no clamp) for comment-based items */}
        {item.content != null && item.content.trim() !== '' && (
          <div className="mt-1.5 rounded bg-gray-50 px-2 py-1.5 text-sm dark:bg-gray-900/50">
            <Markdown>{item.content}</Markdown>
          </div>
        )}

        {/* what changed: a commit push that addressed review threads → show them inline so
            the reader sees the actual change without opening the PR. */}
        {affected.length > 0 && (
          <div className="mt-1.5 space-y-1.5">
            {item.changeSummary != null && (
              <div className="text-[11px] font-medium text-gray-500 dark:text-gray-400">
                {item.changeSummary}
              </div>
            )}
            <ul className="space-y-1.5">
              {affected.map((t) => (
                <AffectedThreadRow
                  key={t.threadId}
                  thread={t}
                  author={t.authorId != null ? usersById.get(t.authorId) : undefined}
                  onOpen={() => onOpenThread(t.threadId)}
                />
              ))}
            </ul>
          </div>
        )}

        {/* review / merge credit line */}
        {(reviewMeta != null || mergedByLabel != null || reviewerLabels.length > 0) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400">
            {reviewMeta != null && (
              <span className="font-medium" style={{ color: reviewMeta.color }}>
                {reviewMeta.label}
              </span>
            )}
            {mergedByLabel != null && (
              <span>
                Merged by <span className="font-medium">{mergedByLabel}</span>
              </span>
            )}
            {reviewerLabels.length > 0 && (
              <span>
                Reviewed by{' '}
                <span className="font-medium">{reviewerLabels.join(', ')}</span>
              </span>
            )}
          </div>
        )}
      </article>
    </li>
  );
}
