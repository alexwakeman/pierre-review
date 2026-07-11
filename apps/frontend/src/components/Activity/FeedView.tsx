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
import {
  useConsolidatedFeed,
  useFeedHasNew,
  useMarkFeedSeen,
} from '../../hooks/useConsolidatedFeed.js';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useThread, usePr } from '../../hooks/usePr.js';
import { useUsers } from '../../hooks/useTimeline.js';
import { useFilters } from '../../store/filters.js';
import { usePinnedTabs, type TabMeta } from '../../store/pinnedTabs.js';
import {
  botVendorMeta,
  buildQuotedReply,
  CI_META,
  dateTime,
  DERIVED_STATE_META,
  EVENT_META,
  MY_TURN_REASON_META,
  indexUsers,
  relativeTime,
  userLabel,
} from '../../lib/ui.js';
import { Avatar } from '../CommentCard.js';
import { MagnifierIcon } from '../Icons.js';
import { Markdown } from '../Markdown.js';
import { PrCommentComposer } from '../PrCommentComposer.js';
import { ThreadCard } from '../ThreadView/index.js';

// A coloured chip + label describing WHAT an item is (the event kind). The My-Turn reason is
// a separate pill (see MY_TURN_REASON_META); Claude runs get their own violet chip.
function itemGlyph(item: ConsolidatedFeedItem): { color: string; label: string } {
  if (item.kind === 'claude_review') return { color: '#8957e5', label: 'Claude Review' };
  // A submitted review is a first-class TYPED pill — the verdict is folded into the top
  // line ("Review: Approved" / "Review: Comment" / …), coloured by the verdict, instead
  // of a broad "Review" pill with the outcome in a footer.
  if (item.kind === 'review_submitted' && item.reviewState != null) {
    const m = REVIEW_STATE_META[item.reviewState];
    return { color: m.color, label: `Review: ${REVIEW_VERDICT_LABEL[item.reviewState]}` };
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

// Title-case verdict for the folded "Review: <verdict>" top pill.
const REVIEW_VERDICT_LABEL: Record<ReviewState, string> = {
  approved: 'Approved',
  changes_requested: 'Request Changes',
  commented: 'Comment',
  dismissed: 'Dismissed',
  pending: 'Pending',
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
// participate in, acted on by someone else) → a yellow border + "My Turn" badge + why-pill,
// plus optional client-side "My Turn only" / "Claude Reviews" filters. Clicking any item opens
// full PR detail tab (a Claude item lands on its Claude Review tab; a PR comment scrolls to
// the comment).

// The feed lives inside the Activity console's own `overflow-y-auto` pane (not the page
// viewport), so infinite-scroll must observe the sentinel against THAT scroll container —
// only then does the rootMargin prefetch fire before the true bottom (a viewport root is
// clipped by the pane and would only fire once the sentinel is actually visible). Walk up
// to the nearest scrollable ancestor; null falls back to the viewport for any other host.
function nearestScrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const oy = getComputedStyle(node).overflowY;
    if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && node.scrollHeight > node.clientHeight) {
      return node;
    }
  }
  return null;
}

export function FeedView({ repoId }: { repoId?: number }): JSX.Element {
  const userIds = useFilters((s) => s.userIds);
  const excludeBots = useFilters((s) => s.excludeBots);
  const allowedBotIds = useFilters((s) => s.allowedBotIds);
  const feedMyTurnOnly = useFilters((s) => s.feedMyTurnOnly);
  const toggleFeedMyTurnOnly = useFilters((s) => s.toggleFeedMyTurnOnly);
  const feedClaudeOnly = useFilters((s) => s.feedClaudeOnly);
  const toggleFeedClaudeOnly = useFilters((s) => s.toggleFeedClaudeOnly);
  const feedBotLens = useFilters((s) => s.feedBotLens);
  const cycleFeedBotLens = useFilters((s) => s.cycleFeedBotLens);
  const showThreadInChanges = useFilters((s) => s.showThreadInChanges);
  const selectPr = useFilters((s) => s.selectPr);
  const showPrComment = useFilters((s) => s.showPrComment);
  const openClaudeReview = useFilters((s) => s.openClaudeReview);
  const focusEventInTab = useFilters((s) => s.focusEventInTab);
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const openPrFocusTab = usePinnedTabs((s) => s.openPrFocusTab);
  const { claudeReview: claudeReviewEnabled } = useProCapabilities();
  // The one-shot flash signal — set ONLY by a real browser Back (navigateBack), so an
  // ordinary return to Activity (e.g. clicking the Activity tab chip) never flashes.
  const flashTarget = usePinnedTabs((s) => s.activityFlashItemId);
  const clearFlash = usePinnedTabs((s) => s.clearActivityFlashItem);

  // A selected rail repo scopes the feed to just that repo; otherwise the cross-repo feed is
  // scoped to ALL watched repos (null → the backend resolves all-watched), IGNORING the
  // FilterBar repo-visibility selection — so the "new activity" banner only fires on watched
  // changes, never on unwatched repos. The bots toggle + allow-list still flow in.
  const effectiveRepoIds = repoId != null ? [repoId] : null;

  // Viewing the CROSS-REPO feed marks it seen server-side (once per mount), resetting the
  // "new My Turn since you were last here" count that drives the Welcome-back banner. A
  // per-repo feed (repoId set) doesn't touch the global marker.
  const markFeedSeen = useMarkFeedSeen();
  const markedSeenRef = useRef(false);
  useEffect(() => {
    if (repoId == null && !markedSeenRef.current) {
      markedSeenRef.current = true;
      markFeedSeen.mutate();
    }
  }, [repoId, markFeedSeen]);

  const { items, users, total, latestId, isLoading, hasMore, loadMore, isFetchingMore } =
    useConsolidatedFeed({
      repoIds: effectiveRepoIds,
      userIds,
      excludeBots,
      allowedBotIds,
    });

  // "New activity" detector: poll the server head for this exact scope and compare to what's
  // loaded, driving the manual refresh banner (below). Clicking it invalidates the feed → the
  // fresh page's items[0]/total catch up → the banner clears.
  const rootRef = useRef<HTMLDivElement>(null);
  const { hasNew, refresh: refreshFeed } = useFeedHasNew({
    repoIds: effectiveRepoIds,
    userIds,
    excludeBots,
    allowedBotIds,
    loadedLatestId: latestId,
    loadedTotal: total,
    feedSettled: !isLoading,
  });
  const onRefreshClick = (): void => {
    refreshFeed();
    nearestScrollParent(rootRef.current)?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const usersById = useMemo(() => indexUsers(users), [users]);
  const myTurnCount = items.filter((i) => i.isMyTurn).length;
  const claudeCount = items.filter((i) => i.kind === 'claude_review').length;
  // Bot lens: an actor is a "bot" for the lens if it's ANY bot (dependabot/CI/review bots),
  // so "Hide bots" gives the clean human-only view; the per-row vendor TAG is review-bot-only.
  const isBotActor = (i: ConsolidatedFeedItem): boolean =>
    i.actorId != null && (usersById.get(i.actorId)?.isBot ?? false);
  const botCount = items.filter(isBotActor).length;
  // "My Turn only" and "Claude Reviews only" are mutually-exclusive client-side filters (My
  // Turn is CORE / free, so it's always available). The bot lens composes ON TOP of them.
  const base = feedMyTurnOnly
    ? items.filter((i) => i.isMyTurn)
    : feedClaudeOnly
      ? items.filter((i) => i.kind === 'claude_review')
      : items;
  const visible =
    feedBotLens === 'hide'
      ? base.filter((i) => !isBotActor(i))
      : feedBotLens === 'only'
        ? base.filter(isBotActor)
        : base;

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

  // Infinite scroll: auto-load the next page as the user nears the bottom of the feed, in
  // every context (cross-repo Feed + each repo's own feed both render this component). A
  // sentinel row sits at the end of the list; an IntersectionObserver rooted on the feed's
  // scroll container fires ~a screenful early (rootMargin) so the next page is fetching
  // before the user hits the true bottom. `loadNextRef` holds the latest guard so the
  // observer callback stays stable (empty-dep effect) yet always sees fresh state.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const sentinelVisibleRef = useRef(false);
  const loadNextRef = useRef<() => void>(() => {});
  loadNextRef.current = () => {
    if (hasMore && !isFetchingMore && items.length > 0) void loadMore();
  };
  // Mount/unmount the observer with the sentinel (rendered only when there's more to load).
  const showSentinel = hasMore && items.length > 0;
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        sentinelVisibleRef.current = entries[0]?.isIntersecting ?? false;
        if (sentinelVisibleRef.current) loadNextRef.current();
      },
      // Root = the feed's own scroll pane; prefetch a screenful before the bottom.
      { root: nearestScrollParent(el), rootMargin: '0px 0px 600px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
    // showSentinel gates the sentinel's existence; re-run when it flips so the observer
    // attaches once the node mounts (the ref is null on the initial, list-empty render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSentinel]);
  // If a settled page leaves the sentinel STILL within range (tall viewport / short page),
  // keep pulling until it scrolls out or nothing remains — the observer alone won't re-fire
  // while `isIntersecting` stays true. The loadNext guard blocks re-entry while fetching.
  useEffect(() => {
    if (!isFetchingMore && sentinelVisibleRef.current) loadNextRef.current();
  }, [isFetchingMore, items.length, hasMore]);

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
    const meta = metaOf(item, prId);
    const opts = { fromActivity: true, returnItemId: item.id };
    // A Claude run lands on its Claude Review tab — openClaudeReview opens the pr-detail tab
    // itself (so it works from any overlay), so don't also open it here (avoids a double open).
    if (item.kind === 'claude_review') {
      openClaudeReview(meta, opts);
      return;
    }
    openPrDetailTab(meta, opts);
    if (item.threadId != null) showThreadInChanges(prId, item.threadId);
    else if (item.commentId != null) showPrComment(prId, item.commentId);
    else selectPr(prId);
  }

  // Open a specific affected thread inline on a commit item — jump straight to that thread.
  function openThread(item: ConsolidatedFeedItem, threadId: number): void {
    const prId = item.prId;
    if (prId == null) return;
    openPrDetailTab(metaOf(item, prId), { fromActivity: true, returnItemId: item.id });
    showThreadInChanges(prId, threadId);
  }

  // The magnifier → Focus Mode: ALWAYS open the PR's own isolated timeline tab and glow the
  // marker for THIS event (a review_comment's refId is its thread id, so also pre-select that
  // thread). Unlike the shared board (date/filter-scoped), the focus tab fetches its OWN ~90-day
  // window, so a PR that isn't on the current board still loads + highlights here — no "not on
  // the timeline" modal. (A PR older than that window still opens; the boot selects it so its
  // detail pane shows even when its bar can't be isolated.) Mirrors PrDetail's Focus link.
  function focus(item: ConsolidatedFeedItem): void {
    const prId = item.prId;
    if (prId == null) return;
    openPrFocusTab(metaOf(item, prId), { fromActivity: true, returnItemId: item.id });
    if (item.kind !== 'claude_review') {
      const refId = item.threadId ?? item.commentId ?? null;
      const threadId = item.kind === 'review_comment' ? item.threadId : null;
      focusEventInTab(prId, item.occurredAt, { type: item.kind as EventType, refId }, threadId);
    }
  }

  return (
    <div className="space-y-3" data-testid="feed-view" ref={rootRef}>
      {/* Feed-wide "new activity" banner — sticks to the top of the feed pane while there's
          newer server activity than what's loaded. Manual by design (never yanks content
          while you're reading); clicking it refreshes the feed + scrolls to the top. */}
      {hasNew && (
        <div className="sticky top-0 z-10">
          <button
            type="button"
            onClick={onRefreshClick}
            data-testid="feed-new-activity"
            className="flex w-full items-center justify-center gap-2 rounded-full border border-sky-400 bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-700 shadow-sm transition-colors hover:bg-sky-100 dark:border-sky-500/60 dark:bg-sky-950/50 dark:text-sky-300 dark:hover:bg-sky-900/60"
          >
            <span aria-hidden="true">↑</span> New activity — Refresh
          </button>
        </div>
      )}

      {/* The AI repo-summary (digest) collection now lives in the Insights panel — one home
          for every AI summary, with a single unified Refresh. It's no longer atop the Feed. */}

      {/* My Turn / Claude filter toggles + a "showing X of Y" hint. My Turn is CORE / free. */}
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
          title="Show only items that concern you (My Turn)"
        >
          <span aria-hidden="true">★</span> My Turn
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
        {/* Bot lens — Pierre as the calm layer above your review bot. Cycles all → hide → only. */}
        {botCount > 0 && (
          <button
            type="button"
            onClick={cycleFeedBotLens}
            aria-pressed={feedBotLens !== 'all'}
            className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
              feedBotLens !== 'all'
                ? 'border-sky-400 bg-sky-50 text-sky-700 dark:border-sky-500/60 dark:bg-sky-950/30 dark:text-sky-300'
                : 'border-gray-300 text-gray-500 hover:border-gray-400 dark:border-gray-700 dark:text-gray-400'
            }`}
            title="Tame the bot firehose: click to cycle all activity → hide bot noise → bot activity only"
          >
            <span aria-hidden="true">🤖</span>
            {feedBotLens === 'hide' ? 'Bots hidden' : feedBotLens === 'only' ? 'Bots only' : 'Bots'}
            {feedBotLens === 'all' && <span className="tabular-nums opacity-70">{botCount}</span>}
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
            : feedBotLens === 'only'
              ? 'No bot activity in this window.'
              : feedBotLens === 'hide'
                ? 'Only bot activity here — nothing from humans in this window.'
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
                onFocus={() => focus(item)}
              />
            );
          })}
        </ul>
      )}

      {/* Pagination: only the loaded pages are fetched + rendered. The sentinel below
          auto-loads the next page (by offset, never re-fetching earlier ones) as it nears
          the bottom; the button remains a manual fallback for when the observer can't fire. */}
      {showSentinel && (
        <div ref={sentinelRef} className="flex justify-center pt-1">
          {isFetchingMore ? (
            <span className="flex items-center gap-2 py-1.5 text-xs text-gray-400">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-gray-300 border-t-transparent dark:border-gray-600 dark:border-t-transparent" />
              Loading more…
            </span>
          ) : (
            <button
              type="button"
              onClick={() => void loadMore()}
              className="rounded-full border border-gray-300 px-4 py-1.5 text-xs font-medium text-gray-600 hover:border-gray-400 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:border-gray-500 dark:hover:bg-gray-800/50"
            >
              Load more
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// (FocusUnavailableModal was removed — Focus now always opens the PR's own isolated timeline
// tab, which fetches its own ~90-day window, so there's no "not on the timeline" dead-end.)

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

// The PR description for a "PR opened" card, fetched on demand only when the reader
// expands it (the body is lean-gated / hydrated, so we don't want to pull it for every
// opened PR up front).
function PrOpenedSummary({ prId }: { prId: number }): JSX.Element {
  const { data: pr, isLoading } = usePr(prId);
  if (isLoading) {
    return <div className="mt-1 px-1 text-xs text-gray-400">Loading summary…</div>;
  }
  const body = pr?.body?.trim();
  if (!body) {
    return <div className="mt-1 px-1 text-xs text-gray-400">No description.</div>;
  }
  return (
    <div className="mt-1 max-h-72 overflow-auto rounded bg-gray-50 px-2 py-1.5 text-sm dark:bg-gray-900/50">
      <Markdown>{body}</Markdown>
    </div>
  );
}

// Extra at-a-glance context on a "PR opened" card: CI rollup + changed-file count (both
// enriched into the feed item) and a collapsible PR description (lazy, see above).
function PrOpenedExtras({ item }: { item: ConsolidatedFeedItem }): JSX.Element {
  const [showSummary, setShowSummary] = useState(false);
  const ci = item.ciStatus != null && item.ciStatus !== 'unknown' ? CI_META[item.ciStatus] : null;
  const files = item.changedFilesCount;
  const prId = item.prId;
  return (
    <div className="mt-1.5 space-y-1.5">
      {(ci != null || files != null) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400">
          {ci != null && (
            <span className="inline-flex items-center gap-1 font-medium" style={{ color: ci.color }}>
              <span
                aria-hidden="true"
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: ci.color }}
              />
              {ci.label}
            </span>
          )}
          {files != null && (
            <span>
              {files} {files === 1 ? 'file' : 'files'} changed
            </span>
          )}
        </div>
      )}
      {prId != null && (
        // Stop propagation so reading/expanding the summary never opens the tab.
        <div onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={() => setShowSummary((s) => !s)}
            className="text-[11px] font-medium text-sky-600 hover:underline dark:text-sky-400"
          >
            {showSummary ? 'Hide summary' : 'Show summary'}
          </button>
          {showSummary && <PrOpenedSummary prId={prId} />}
        </div>
      )}
    </div>
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
  onFocus,
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
  onFocus: () => void;
}): JSX.Element {
  const glyph = itemGlyph(item);
  // My Turn is CORE / free — the backend flags isMyTurn for every tier.
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
  const claudeVerdict = item.claudeVerdict != null ? CLAUDE_VERDICT_META[item.claudeVerdict] : null;
  const affected = item.affectedThreads ?? [];
  const primaryReason = item.myTurnReasons[0];
  // Known AI review bot? Tag the row with its vendor so it reads "CodeRabbit flagged…".
  const botVendor = botVendorMeta(actorUser);

  // A review-thread card shows its FULL conversation inline (reply + resolve, with
  // the specific comment highlighted new); a PR-comment card can open a quote+@mention
  // reply.
  const isThreadCard = item.kind === 'review_comment' && item.threadId != null;
  const isPrCommentCard = item.kind === 'pr_comment' && item.prId != null;
  const isPrOpened = item.kind === 'pr_opened';
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
        {/* header: (Focus magnifier + event time on the left) then avatar + actor +
            action chip + (My Turn badge + why-pill) */}
        <div className="flex items-center gap-2">
          {item.prId != null && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onFocus();
              }}
              className="shrink-0 rounded p-0.5 text-blue-500 hover:text-blue-600"
              title="Focus — open this PR in its own isolated timeline tab"
              aria-label="Focus this PR in its own timeline tab"
            >
              <MagnifierIcon size={13} />
            </button>
          )}
          <span
            className="shrink-0 text-[11px] text-gray-400"
            title={dateTime(item.occurredAt)}
          >
            {relativeTime(item.occurredAt)}
          </span>
          <Avatar user={actorUser} size={20} />
          <span className="truncate font-medium text-gray-800 dark:text-gray-100">{actorName}</span>
          {botVendor && (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium"
              style={{ color: botVendor.color, background: `${botVendor.color}1a` }}
              title={`${botVendor.label} is an AI review bot — Pierre triages its output`}
            >
              <span aria-hidden>🤖</span>
              {botVendor.label}
            </span>
          )}
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
              My Turn
            </span>
          )}
          {isMyTurn && primaryReason != null && (
            <span
              className="shrink-0 rounded border border-yellow-300 px-1.5 py-0.5 text-[10px] font-medium text-yellow-700 dark:border-yellow-600/50 dark:text-yellow-300"
              title={item.myTurnReasons.map((r) => MY_TURN_REASON_META[r].title).join(' · ')}
            >
              {MY_TURN_REASON_META[primaryReason].label}
            </span>
          )}
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

        {/* PR-opened cards: CI + files-changed + a collapsible description (item 2). */}
        {isPrOpened && <PrOpenedExtras item={item} />}

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

        {/* Consolidated top-level PR comment(s) folded into this review (posted by the same
            person around the same time) — shown as "Also commented" instead of separate feed
            rows. Independent of the review body so a bare approval + comment still shows it. */}
        {item.mergedComments.length > 0 && (
          <div className="mt-1.5 space-y-1.5">
            {item.mergedComments.map((c) => (
              <div
                key={c.commentId}
                className="rounded bg-gray-50 px-2 py-1.5 text-sm dark:bg-gray-900/50"
              >
                <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                  Also commented
                </div>
                <div className="max-h-72 overflow-auto">
                  <Markdown>{c.content}</Markdown>
                </div>
              </div>
            ))}
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

        {/* merge-credit line — only the parts meaningful for this card. The review
            verdict now lives in the top pill (see itemGlyph), so it's no longer here. */}
        {(showMergedBy || showReviewers) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400">
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
