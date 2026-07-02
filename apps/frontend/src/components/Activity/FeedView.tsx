import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type {
  ClaudeReviewVerdict,
  ConsolidatedFeedItem,
  EventType,
  FeedAffectedThread,
  ReviewState,
  User,
} from '@pierre-review/shared';
import { useConsolidatedFeed } from '../../hooks/useConsolidatedFeed.js';
import { useMe } from '../../hooks/useTriage.js';
import { useThread } from '../../hooks/usePr.js';
import { useUsers } from '../../hooks/useTimeline.js';
import { useFilters } from '../../store/filters.js';
import { usePinnedTabs, type TabMeta } from '../../store/pinnedTabs.js';
import {
  buildQuotedReply,
  DERIVED_STATE_META,
  EVENT_META,
  FYI_REASON_META,
  indexUsers,
  relativeTime,
  userLabel,
} from '../../lib/ui.js';
import { Avatar } from '../CommentCard.js';
import { Markdown } from '../Markdown.js';
import { PrCommentComposer } from '../PrCommentComposer.js';
import { ThreadCard } from '../ThreadView/index.js';
import { FeedDigestList } from './FeedDigestList.js';

// A coloured chip + label describing WHAT an item is (the event kind). The FYI reason is a
// separate pill (see FYI_REASON_META); Claude runs get their own violet chip.
function itemGlyph(item: ConsolidatedFeedItem): { color: string; label: string } {
  if (item.kind === 'claude_review') return { color: '#8957e5', label: 'Claude Review' };
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

// Claude verdict → a small badge on a Claude Review card.
const CLAUDE_VERDICT_META: Record<ClaudeReviewVerdict, { label: string; color: string }> = {
  APPROVE: { label: 'approve', color: '#22c55e' },
  REQUEST_CHANGES: { label: 'request changes', color: '#ef4444' },
  COMMENT: { label: 'comment', color: '#9ca3af' },
};

// The consolidated Feed — a flat, chronological, social-style stream of activity events.
// Cross-repo when `repoId` is absent (scoped by the active FilterBar repos/members); scoped
// to a single repo when a rail repo is selected. Each item is flagged `isMyTurn` (a PR you
// participate in, acted on by someone else) → a yellow border + "FYI" badge + why-pill, plus
// optional client-side "FYI only" / "Claude Reviews" filters. Clicking any item opens the
// full PR detail tab (a Claude item lands on its Claude Review tab; a PR comment scrolls to
// the comment).
export function FeedView({ repoId }: { repoId?: number }): JSX.Element {
  const storeRepoIds = useFilters((s) => s.repoIds);
  const userIds = useFilters((s) => s.userIds);
  const excludeBots = useFilters((s) => s.excludeBots);
  const allowedBotIds = useFilters((s) => s.allowedBotIds);
  const feedMyTurnOnly = useFilters((s) => s.feedMyTurnOnly);
  const toggleFeedMyTurnOnly = useFilters((s) => s.toggleFeedMyTurnOnly);
  const feedClaudeOnly = useFilters((s) => s.feedClaudeOnly);
  const toggleFeedClaudeOnly = useFilters((s) => s.toggleFeedClaudeOnly);
  const selectThread = useFilters((s) => s.selectThread);
  const selectPr = useFilters((s) => s.selectPr);
  const showPrComment = useFilters((s) => s.showPrComment);
  const openClaudeReview = useFilters((s) => s.openClaudeReview);
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const me = useMe();
  const claudeReviewEnabled = me.data?.claudeReviewEnabled ?? false;
  // The one-shot flash signal — set ONLY by a real browser Back (navigateBack), so an
  // ordinary return to Activity (e.g. clicking the Activity tab chip) never flashes.
  const flashTarget = usePinnedTabs((s) => s.activityFlashItemId);
  const clearFlash = usePinnedTabs((s) => s.clearActivityFlashItem);

  // A selected rail repo scopes the feed to just that repo; otherwise follow the store's
  // active repo filter (a FilterBar change refetches via the query key). The bots toggle +
  // allow-list flow in too, so the feed hides/keeps the same bots the timeline does.
  const effectiveRepoIds = repoId != null ? [repoId] : storeRepoIds;
  const { items, users, hasMore, loadMore, isFetchingMore } = useConsolidatedFeed({
    repoIds: effectiveRepoIds,
    userIds,
    excludeBots,
    allowedBotIds,
  });

  const usersById = useMemo(() => indexUsers(users), [users]);
  const myTurnCount = items.filter((i) => i.isMyTurn).length;
  const claudeCount = items.filter((i) => i.kind === 'claude_review').length;
  const visible = feedMyTurnOnly
    ? items.filter((i) => i.isMyTurn)
    : feedClaudeOnly
      ? items.filter((i) => i.kind === 'claude_review')
      : items;

  // Back-from-a-click highlight: when a browser Back returns us to the feed (navigateBack
  // set the one-shot flashTarget), scroll the exact row we clicked into view and flash it
  // once, then consume the signal. Only fires on a real Back.
  const rowRefs = useRef<Map<string, HTMLLIElement>>(new Map());
  const [flashId, setFlashId] = useState<string | null>(null);
  useEffect(() => {
    if (flashTarget == null) return;
    const id = flashTarget;
    const raf = requestAnimationFrame(() => {
      const el = rowRefs.current.get(id);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        setFlashId(id);
        window.setTimeout(() => setFlashId((c) => (c === id ? null : c)), 1800);
      }
      clearFlash();
    });
    return () => cancelAnimationFrame(raf);
  }, [flashTarget, clearFlash]);

  const metaOf = (item: ConsolidatedFeedItem, prId: number): TabMeta => ({
    id: prId,
    number: item.prNumber ?? 0,
    title: item.prTitle ?? `#${item.prNumber ?? ''}`,
    repoFullName: item.repoFullName,
    authorLogin: null, // backfilled by PrDetail.syncMeta once the tab opens
    authorDisplayName: null,
    authorAvatarUrl: null,
  });

  // Open an item → the full-height PR DETAIL tab (its Show/Focus drive the timeline).
  // `fromActivity` arms Back-to-Activity + stashes this row's id so Back scrolls it back into
  // view. We also drive the right in-detail deep link: a Claude run → its Claude Review tab;
  // a thread → that thread; a PR comment → scroll to + highlight the comment; else the PR.
  function open(item: ConsolidatedFeedItem): void {
    const prId = item.prId;
    if (prId == null) return;
    openPrDetailTab(metaOf(item, prId), { fromActivity: true, returnItemId: item.id });
    if (item.kind === 'claude_review') openClaudeReview(prId);
    else if (item.threadId != null) selectThread(prId, item.threadId);
    else if (item.commentId != null) showPrComment(prId, item.commentId);
    else selectPr(prId);
  }

  // Open a specific affected thread inline on a commit item — jump straight to that thread.
  function openThread(item: ConsolidatedFeedItem, threadId: number): void {
    const prId = item.prId;
    if (prId == null) return;
    openPrDetailTab(metaOf(item, prId), { fromActivity: true, returnItemId: item.id });
    selectThread(prId, threadId);
  }

  return (
    <div className="space-y-3">
      {/* The cross-repo Pro digest collection sits atop the cross-repo feed only (a single
          repo's digest lives in its RepoFeedHeader). */}
      {repoId == null && <FeedDigestList />}

      {/* FYI / Claude filter toggles + a "showing X of Y" hint. */}
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
          title="Show only items that concern you (FYI)"
        >
          <span aria-hidden="true">★</span> FYI
          {myTurnCount > 0 && <span className="tabular-nums opacity-70">{myTurnCount}</span>}
        </button>
        {claudeReviewEnabled && (
          <button
            type="button"
            onClick={toggleFeedClaudeOnly}
            aria-pressed={feedClaudeOnly}
            className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
              feedClaudeOnly
                ? 'border-violet-400 bg-violet-50 text-violet-700 dark:border-violet-500/60 dark:bg-violet-950/30 dark:text-violet-300'
                : 'border-gray-300 text-gray-500 hover:border-gray-400 dark:border-gray-700 dark:text-gray-400'
            }`}
            title="Show only Claude Reviews"
          >
            <span aria-hidden="true">✨</span> Claude Reviews
            {claudeCount > 0 && <span className="tabular-nums opacity-70">{claudeCount}</span>}
          </button>
        )}
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
          {feedClaudeOnly
            ? 'No Claude Reviews in this window.'
            : 'Nothing needs your attention right now.'}
        </div>
      ) : (
        <ul className="space-y-2">
          {visible.map((item) => {
            const actorUser = item.actorId != null ? usersById.get(item.actorId) : undefined;
            const mergedBy = item.mergedById != null ? usersById.get(item.mergedById) : undefined;
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
                flash={flashId === item.id}
                innerRef={(el) => {
                  if (el) rowRefs.current.set(item.id, el);
                  else rowRefs.current.delete(item.id);
                }}
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

// The full threaded conversation for a review-thread feed card, rendered inline
// (expand-in-place) exactly as the PR-detail Threads tab renders it — code anchor,
// every reply, and the inline Reply composer + Resolve button (ThreadCard). Fetched
// on demand by thread id; comment authors resolve from the global roster so every
// avatar/name renders even when the author isn't on the current feed page.
function InlineThread({ item }: { item: ConsolidatedFeedItem }): JSX.Element {
  const { data: thread, isLoading } = useThread(item.threadId);
  const { data: users } = useUsers();
  const usersById = useMemo(() => indexUsers(users), [users]);
  // The feed item carries the THREAD id but not the specific comment id, so resolve
  // the comment this card represents by matching its author + timestamp (mirrors the
  // timeline MarkerPopover). That one comment is highlighted "new"; the rest of the
  // conversation renders as plain context.
  const highlightCommentId = useMemo(() => {
    if (!thread || item.actorId == null) return null;
    const target = new Date(item.occurredAt).getTime();
    let best: { id: number; dist: number } | null = null;
    for (const c of thread.comments) {
      if (c.authorId !== item.actorId) continue;
      const dist = Math.abs(new Date(c.createdAt).getTime() - target);
      if (best == null || dist < best.dist) best = { id: c.id, dist };
    }
    return best?.id ?? null;
  }, [thread, item.actorId, item.occurredAt]);
  const prUrl =
    item.prNumber != null ? `https://github.com/${item.repoFullName}/pull/${item.prNumber}` : '';
  if (isLoading) {
    return <div className="px-1 py-2 text-xs text-gray-400">Loading conversation…</div>;
  }
  if (!thread) {
    return (
      <div className="px-1 py-2 text-xs text-gray-400">Couldn’t load this conversation.</div>
    );
  }
  return (
    <ThreadCard
      thread={thread}
      usersById={usersById}
      prUrl={prUrl}
      repoId={item.repoId}
      highlightCommentId={highlightCommentId}
    />
  );
}

// One review thread that a commit item likely addressed — a clickable row (opens that
// thread in the PR detail tab) showing the file/line, the thread's new derived state, and
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

// The collapsed height of a comment/summary body before "Show more" appears (item 2).
const BODY_COLLAPSED_MAX = 160;

function FeedRow({
  item,
  actorUser,
  mergedByLabel,
  reviewerLabels,
  usersById,
  flash,
  innerRef,
  onOpen,
  onOpenThread,
}: {
  item: ConsolidatedFeedItem;
  actorUser: User | undefined;
  mergedByLabel: string | null;
  reviewerLabels: string[];
  usersById: Map<number, User>;
  flash: boolean;
  innerRef: (el: HTMLLIElement | null) => void;
  onOpen: () => void;
  onOpenThread: (threadId: number) => void;
}): JSX.Element {
  const glyph = itemGlyph(item);
  const isMyTurn = item.isMyTurn;
  const isClaude = item.kind === 'claude_review';
  const isMerge = item.kind === 'pr_merged';
  // A commit push (or Claude run) whose actor didn't resolve to a GitHub login shows a
  // neutral label instead of the bare 'unknown'.
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
  const claudeVerdict = item.claudeVerdict != null ? CLAUDE_VERDICT_META[item.claudeVerdict] : null;
  const affected = item.affectedThreads ?? [];
  const primaryReason = item.myTurnReasons[0];

  // A review-thread card shows its FULL conversation inline (reply + resolve, with
  // the specific comment highlighted new); a PR-comment card can open a quote+@mention
  // reply.
  const isThreadCard = item.kind === 'review_comment' && item.threadId != null;
  const isPrCommentCard = item.kind === 'pr_comment' && item.prId != null;
  const [replyOpen, setReplyOpen] = useState(false);

  // Item 8 — only show credit that's meaningful for THIS card's context: "Merged by" +
  // "Reviewed by" belong on a merge card (and never re-attribute the merge to its own
  // actor); a comment / review card doesn't need them.
  const showMergedBy = isMerge && mergedByLabel != null && item.mergedById !== item.actorId;
  const showReviewers = isMerge && reviewerLabels.length > 0;

  // Item 2 — expandable body: measure whether the collapsed body overflows so a "Show more"
  // toggle only appears when there's more to see. A ResizeObserver on the UNCLAMPED inner
  // content re-measures when its rendered height changes — crucially after late <img> loads
  // (comment/review bodies are full of screenshots that contribute 0 height at first paint)
  // and on width reflow — so the toggle isn't missing while the clamp silently truncates.
  const bodyRef = useRef<HTMLDivElement>(null); // clamped wrapper
  const bodyInnerRef = useRef<HTMLDivElement>(null); // unclamped content
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const hasBody = item.content != null && item.content.trim() !== '';
  useEffect(() => {
    const outer = bodyRef.current;
    const inner = bodyInnerRef.current;
    if (!outer || !inner) return;
    const measure = (): void => {
      if (expanded) return; // expanded shows everything — nothing to clamp/measure
      setOverflows(outer.scrollHeight > outer.clientHeight + 4);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [item.content, expanded]);

  // Convenience: a click anywhere on the card opens it, but let markdown links / buttons win
  // (they call their own handlers).
  const onCardClick = (e: ReactMouseEvent<HTMLElement>): void => {
    if ((e.target as HTMLElement).closest('a,button')) return;
    onOpen();
  };

  return (
    <li ref={innerRef}>
      <article
        onClick={onCardClick}
        className={`cursor-pointer rounded-md border p-2.5 text-sm transition-colors ${
          flash
            ? 'border-sky-400 ring-2 ring-sky-400/60 dark:border-sky-500'
            : isMyTurn
              ? 'border-yellow-400 bg-yellow-50/40 dark:border-yellow-500/50 dark:bg-yellow-950/15'
              : isClaude
                ? 'border-violet-300 bg-violet-50/30 dark:border-violet-500/40 dark:bg-violet-950/10'
                : 'border-gray-200 hover:border-sky-300 dark:border-gray-800 dark:hover:border-sky-700'
        }`}
      >
        {/* header: avatar + actor + action chip + (FYI badge + why-pill) + time */}
        <div className="flex items-center gap-2">
          <Avatar user={actorUser} size={20} />
          <span className="truncate font-medium text-gray-800 dark:text-gray-100">{actorName}</span>
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium"
            style={{ color: glyph.color, background: glyph.color + '1a' }}
          >
            {glyph.label}
          </span>
          {claudeVerdict != null && (
            <span
              className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium"
              style={{ color: claudeVerdict.color, background: claudeVerdict.color + '1a' }}
            >
              {claudeVerdict.label}
            </span>
          )}
          {isMyTurn && (
            <span className="shrink-0 rounded bg-yellow-400/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-yellow-700 dark:text-yellow-300">
              FYI
            </span>
          )}
          {isMyTurn && primaryReason != null && (
            <span
              className="shrink-0 rounded border border-yellow-300 px-1.5 py-0.5 text-[10px] font-medium text-yellow-700 dark:border-yellow-600/50 dark:text-yellow-300"
              title={item.myTurnReasons.map((r) => FYI_REASON_META[r].title).join(' · ')}
            >
              {FYI_REASON_META[primaryReason].label}
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

        {/* markdown body (review / PR comment / Claude summary) — collapsed with a
            "Show more" toggle once it overflows. Review-thread cards SKIP this: they
            render the whole conversation inline below (with this comment highlighted),
            so a standalone preview would just duplicate it. */}
        {hasBody && !isThreadCard && (
          <div className="mt-1.5 rounded bg-gray-50 px-2 py-1.5 text-sm dark:bg-gray-900/50">
            <div
              ref={bodyRef}
              className={expanded ? '' : 'overflow-hidden'}
              style={expanded ? undefined : { maxHeight: BODY_COLLAPSED_MAX }}
            >
              <div ref={bodyInnerRef}>
                <Markdown>{item.content as string}</Markdown>
              </div>
            </div>
            {(overflows || expanded) && (
              <button
                type="button"
                onClick={() => setExpanded((e) => !e)}
                className="mt-1 text-[11px] font-medium text-sky-600 hover:underline dark:text-sky-400"
              >
                {expanded ? 'Show less' : 'Show more'}
              </button>
            )}
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

        {/* review verdict / merge-credit line — only the parts meaningful for this card. */}
        {(reviewMeta != null || showMergedBy || showReviewers) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400">
            {reviewMeta != null && (
              <span className="font-medium" style={{ color: reviewMeta.color }}>
                {reviewMeta.label}
              </span>
            )}
            {showMergedBy && (
              <span>
                Merged by <span className="font-medium">{mergedByLabel}</span>
              </span>
            )}
            {showReviewers && (
              <span>
                Reviewed by <span className="font-medium">{reviewerLabels.join(', ')}</span>
              </span>
            )}
          </div>
        )}

        {/* A review-thread card shows the full conversation inline (reply + resolve,
            exactly like the Threads tab), with the comment this card represents
            highlighted new. Stop propagation so interacting never opens the tab. */}
        {isThreadCard && (
          <div className="mt-1.5" onClick={(e) => e.stopPropagation()}>
            <InlineThread item={item} />
          </div>
        )}

        {/* A PR (issue-level) comment card can be replied to — a new comment
            prefilled with the original quoted + its author @mentioned. */}
        {isPrCommentCard && item.prId != null && (
          <div className="mt-1.5">
            {!replyOpen ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setReplyOpen(true);
                }}
                className="text-[11px] font-medium text-sky-600 hover:underline dark:text-sky-400"
              >
                Reply
              </button>
            ) : (
              <div onClick={(e) => e.stopPropagation()}>
                <PrCommentComposer
                  prId={item.prId}
                  initialBody={buildQuotedReply(item.content, actorUser?.githubLogin ?? null)}
                  autoFocus
                  onCancel={() => setReplyOpen(false)}
                  onDone={() => setReplyOpen(false)}
                />
              </div>
            )}
          </div>
        )}
      </article>
    </li>
  );
}
