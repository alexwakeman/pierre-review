import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type {
  AutomatedReviewerKind,
  ClaudeReviewVerdict,
  ConsolidatedFeedItem,
  DerivedState,
  EventType,
  FeedAffectedThread,
  ReviewerClassification,
  ReviewState,
  User,
} from '@pierre-review/shared';
import {
  useConsolidatedFeed,
  useFeedHasNew,
  useMarkFeedSeen,
} from '../../hooks/useConsolidatedFeed.js';
import { useDetectedReviewers, useReviewerOverride } from '../../hooks/useBotTriage.js';
import { useProCapabilities, useOpenPrs } from '../../hooks/useTriage.js';
import { useThread, usePr } from '../../hooks/usePr.js';
import { useUsers } from '../../hooks/useTimeline.js';
import { useFilters } from '../../store/filters.js';
import { usePinnedTabs, type TabMeta } from '../../store/pinnedTabs.js';
import {
  automatedReviewerMeta,
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
import { StateBadge } from '../StateBadge.js';
import { ThreadCard } from '../ThreadView/index.js';
import { FeedOpenPrsPanel } from './FeedOpenPrsPanel.js';

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

// An automated-reviewer tag for a feed row's actor: a known VENDOR bot (by login) OR an
// account-classified automated reviewer (in-house AI / Pierre — surfaced via the detected-
// reviewers classification map, since those aren't login-derivable). `userId` is the actor
// id so the inline "not a bot?" override can target it. Null → the actor is a human.
type AutomatedTag = { userId: number | null; kind: AutomatedReviewerKind; label: string; color: string };

function automatedTagFor(
  actorUser: User | undefined,
  classificationByUserId: Map<number, ReviewerClassification>,
): AutomatedTag | null {
  // Known review-bot vendor (CodeRabbit/Copilot/…) by login — the v1 path, still first.
  const loginVendor = botVendorMeta(actorUser);
  if (loginVendor) {
    return {
      userId: actorUser?.id ?? null,
      kind: loginVendor.kind,
      label: loginVendor.label,
      color: loginVendor.color,
    };
  }
  // Otherwise, an account-classified automated reviewer (in-house AI / Pierre) — widened
  // from the login-only path so those tags surface in the feed too.
  if (actorUser) {
    const c = classificationByUserId.get(actorUser.id);
    if (c && c.automated && c.kind != null) {
      return { userId: actorUser.id, kind: c.kind, label: c.label, color: automatedReviewerMeta(c.kind).color };
    }
  }
  return null;
}

// A stable TabMeta for a feed item — pure (closes over nothing) so the open/openThread/focus
// handlers below can stay referentially stable across renders (memoised rows need this).
function metaOf(item: ConsolidatedFeedItem, prId: number): TabMeta {
  return {
    id: prId,
    number: item.prNumber ?? 0,
    title: item.prTitle ?? `#${item.prNumber ?? ''}`,
    repoFullName: item.repoFullName,
    authorLogin: null, // backfilled by PrDetail.syncMeta once the tab opens
    authorDisplayName: null,
    authorAvatarUrl: null,
  };
}

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

// Windowing overscan (px) rendered past each edge of the visible viewport so a fast scroll
// (or an expand-in-place row growing) never blanks, and a just-interacted row stays mounted.
const FEED_OVERSCAN = 800;
// Height estimate for a not-yet-measured row before the running average kicks in.
const FEED_EST_ROW = 160;

// The DERIVED-state pills shown in `botsMode` (the Bots pane's bot-only feed). Order mirrors
// the timeline legend: needs-attention → in-progress → done.
const BOT_STATE_ORDER: DerivedState[] = [
  'untouched',
  'replied_unresolved',
  'likely_addressed',
  'resolved',
];

export function FeedView({
  repoId,
  botsMode = false,
}: {
  repoId?: number;
  // The Bots pane's bot-only feed: hard-filters to automated-reviewer activity and swaps the
  // normal pill row for review-thread derived-state pills (Untouched / Replied / Likely
  // addressed / Resolved). Also drops the open-PRs panel + the cross-repo "seen" marker.
  botsMode?: boolean;
}): JSX.Element {
  const userIds = useFilters((s) => s.userIds);
  const excludeBots = useFilters((s) => s.excludeBots);
  const allowedBotIds = useFilters((s) => s.allowedBotIds);
  const repoIdsFilter = useFilters((s) => s.repoIds);
  const feedMyTurnOnly = useFilters((s) => s.feedMyTurnOnly);
  const toggleFeedMyTurnOnly = useFilters((s) => s.toggleFeedMyTurnOnly);
  const feedClaudeOnly = useFilters((s) => s.feedClaudeOnly);
  const toggleFeedClaudeOnly = useFilters((s) => s.toggleFeedClaudeOnly);
  const feedBotLens = useFilters((s) => s.feedBotLens);
  const cycleFeedBotLens = useFilters((s) => s.cycleFeedBotLens);
  const feedCatComments = useFilters((s) => s.feedCatComments);
  const feedCatPrEvents = useFilters((s) => s.feedCatPrEvents);
  const toggleFeedCatComments = useFilters((s) => s.toggleFeedCatComments);
  const toggleFeedCatPrEvents = useFilters((s) => s.toggleFeedCatPrEvents);
  const feedIsolatedPrId = useFilters((s) => s.feedIsolatedPrId);
  const setFeedIsolatedPrId = useFilters((s) => s.setFeedIsolatedPrId);
  const selectThread = useFilters((s) => s.selectThread);
  const selectPr = useFilters((s) => s.selectPr);
  const showPrComment = useFilters((s) => s.showPrComment);
  const openClaudeReview = useFilters((s) => s.openClaudeReview);
  const focusEventInTab = useFilters((s) => s.focusEventInTab);
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const openPrFocusTab = usePinnedTabs((s) => s.openPrFocusTab);
  const { claudeReview: claudeReviewEnabled } = useProCapabilities();

  // Detected-reviewer classifications (CORE / free) → the actor→kind map that lets in-house
  // AI / Pierre actors carry a vendor tag (login-based vendors don't need it). The inline
  // "not a bot?" override reclassifies an actor as human (automated:false); on success the
  // detected-reviewers query invalidates and the tag drops.
  const { data: detectedReviewers } = useDetectedReviewers();
  const reviewerOverride = useReviewerOverride();
  const { mutate: overrideMutate } = reviewerOverride;
  const classificationByUserId = useMemo(() => {
    const m = new Map<number, ReviewerClassification>();
    for (const r of detectedReviewers?.reviewers ?? []) {
      if (r.classification.automated && r.classification.kind != null) m.set(r.userId, r.classification);
    }
    return m;
  }, [detectedReviewers]);
  const overridePendingUserId = reviewerOverride.isPending
    ? reviewerOverride.variables?.userId ?? null
    : null;
  // Stable across renders so a memoised row's props don't churn.
  const markNotBot = useCallback(
    (userId: number): void => {
      overrideMutate({ userId, body: { automated: false } });
    },
    [overrideMutate],
  );
  // The one-shot flash signal — set ONLY by a real browser Back (navigateBack), so an
  // ordinary return to Activity (e.g. clicking the Activity tab chip) never flashes.
  const flashTarget = usePinnedTabs((s) => s.activityFlashItemId);
  const clearFlash = usePinnedTabs((s) => s.clearActivityFlashItem);

  // A selected rail repo scopes the feed to just that repo; otherwise the cross-repo feed
  // FOLLOWS the FilterBar repo selection (which the team-scope picker drives): a `repoIds`
  // of null → the backend resolves all-watched, a concrete list → just those repos. The bots
  // toggle + allow-list still flow in.
  const effectiveRepoIds = repoId != null ? [repoId] : repoIdsFilter;

  // Single-PR isolation applies to BOTH the cross-repo feed (the team-grouped "open PRs"
  // panel) and a per-repo console (its RepoOpenPrList rows) — clicking a PR in either filters
  // the feed to that PR. `setActivityRepo` clears it when switching rails, so it never leaks
  // across repos.
  const isolatedPrId = feedIsolatedPrId;
  // Resolve the isolated PR (shared open-PRs cache) for the active-filter banner's label.
  const { data: openPrsData } = useOpenPrs();
  const isolatedPr =
    isolatedPrId != null
      ? (openPrsData?.prs.find((p) => p.id === isolatedPrId) ?? null)
      : null;

  // Viewing the CROSS-REPO feed marks it seen server-side (once per mount), resetting the
  // "new My Turn since you were last here" count that drives the Welcome-back banner. A
  // per-repo feed (repoId set) doesn't touch the global marker.
  const markFeedSeen = useMarkFeedSeen();
  const markedSeenRef = useRef(false);
  useEffect(() => {
    // botsMode is a scoped bot-only view — it must NOT reset the cross-repo My-Turn "seen" marker.
    if (repoId == null && !botsMode && !markedSeenRef.current) {
      markedSeenRef.current = true;
      markFeedSeen.mutate();
    }
  }, [repoId, botsMode, markFeedSeen]);

  // The Bots pane is a bot-ONLY view, so the backend must NOT drop bot activity — force
  // excludeBots off there regardless of the FilterBar's exclude-bots toggle (otherwise the bot
  // feed would come back empty whenever a member filter has bots excluded). It also drops the
  // MEMBER (userIds) filter: that filters by actor, and bots aren't human members, so a narrowed
  // member selection would otherwise empty the bot feed. The repo scope still applies.
  const effectiveExcludeBots = botsMode ? false : excludeBots;
  const effectiveUserIds = botsMode ? null : userIds;
  const { items, users, total, latestId, isLoading, hasMore, loadMore, isFetchingMore } =
    useConsolidatedFeed({
      repoIds: effectiveRepoIds,
      userIds: effectiveUserIds,
      excludeBots: effectiveExcludeBots,
      allowedBotIds,
      prId: isolatedPrId,
      // Bot pane: the backend filters to automated reviewers IN SQL (before the cap), so the
      // feed spans the full window of bot activity instead of a bot-slice of a capped page.
      botsOnly: botsMode,
    });

  // "New activity" detector: poll the server head for this exact scope and compare to what's
  // loaded, driving the manual refresh banner (below). Clicking it invalidates the feed → the
  // fresh page's items[0]/total catch up → the banner clears.
  const rootRef = useRef<HTMLDivElement>(null);
  const { hasNew, refresh: refreshFeed } = useFeedHasNew({
    repoIds: effectiveRepoIds,
    userIds: effectiveUserIds,
    excludeBots: effectiveExcludeBots,
    allowedBotIds,
    prId: isolatedPrId,
    botsOnly: botsMode,
    loadedLatestId: latestId,
    loadedTotal: total,
    feedSettled: !isLoading,
  });
  const onRefreshClick = (): void => {
    refreshFeed();
    nearestScrollParent(rootRef.current)?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const usersById = useMemo(() => indexUsers(users), [users]);
  // Bot lens: an actor is a "bot" for the lens if it's ANY bot (dependabot/CI/review bots),
  // so "Hide bots" gives the clean human-only view; the per-row vendor TAG is review-bot-only.
  const isBotActor = useCallback(
    (i: ConsolidatedFeedItem): boolean =>
      i.actorId != null && (usersById.get(i.actorId)?.isBot ?? false),
    [usersById],
  );
  const myTurnCount = useMemo(() => items.filter((i) => i.isMyTurn).length, [items]);
  const claudeCount = useMemo(
    () => items.filter((i) => i.kind === 'claude_review').length,
    [items],
  );
  const botCount = useMemo(() => items.filter(isBotActor).length, [items, isBotActor]);
  // Event-category matcher for the Comments / PR-events pills. Both off = no category filter.
  // When either is on, keep only items in the enabled categories (commit + Claude rows, which
  // are in neither category, drop out while a category pill is active).
  const catMatch = useCallback(
    (i: ConsolidatedFeedItem): boolean => {
      if (!feedCatComments && !feedCatPrEvents) return true;
      const isComment = i.kind === 'review_comment' || i.kind === 'pr_comment';
      const isPrEvent =
        i.kind === 'pr_opened' ||
        i.kind === 'pr_merged' ||
        i.kind === 'pr_closed' ||
        i.kind === 'pr_reopened' ||
        i.kind === 'pr_ready_for_review' ||
        i.kind === 'review_submitted';
      return (feedCatComments && isComment) || (feedCatPrEvents && isPrEvent);
    },
    [feedCatComments, feedCatPrEvents],
  );
  const commentCount = useMemo(
    () => items.filter((i) => i.kind === 'review_comment' || i.kind === 'pr_comment').length,
    [items],
  );
  // Bots pane: a review-thread DERIVED-state filter (a Set of selected states; empty = all).
  // Local (not a store filter) — it only exists in the bot-only feed. Only thread-bearing bot
  // items carry a derivedState; a non-thread bot item (a bot PR comment / review submit) drops
  // out whenever any state pill is active.
  const [botStateFilter, setBotStateFilter] = useState<Set<DerivedState>>(() => new Set());
  const toggleBotState = useCallback((s: DerivedState): void => {
    setBotStateFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }, []);
  // Bots pane: a per-VENDOR filter — a Set of actor ids (each distinct bot is one pill, so the
  // in-house bots deepsource / github-actions / … isolate separately, not lumped as "in_house").
  // Composes with the state pills (vendor ∧ state). Local, botsMode-only.
  const [botVendorFilter, setBotVendorFilter] = useState<Set<number>>(() => new Set());
  const toggleBotVendor = useCallback((actorId: number): void => {
    setBotVendorFilter((prev) => {
      const next = new Set(prev);
      if (next.has(actorId)) next.delete(actorId);
      else next.add(actorId);
      return next;
    });
  }, []);
  // The distinct bots present in the (already bot-only) feed → one pill each, labelled by the
  // automated-reviewer tag (classification label / vendor name), most-active first.
  const botVendors = useMemo(() => {
    if (!botsMode) return [] as { actorId: number; label: string; color: string; count: number }[];
    const m = new Map<number, { actorId: number; label: string; color: string; count: number }>();
    for (const i of items) {
      const aid = i.actorId;
      if (aid == null) continue;
      const existing = m.get(aid);
      if (existing) {
        existing.count += 1;
        continue;
      }
      const u = usersById.get(aid);
      const tag = automatedTagFor(u, classificationByUserId);
      const label = tag?.label?.trim() ? tag.label : userLabel(u, aid);
      m.set(aid, { actorId: aid, label, color: tag?.color ?? '#6b7280', count: 1 });
    }
    return [...m.values()].sort((a, b) => b.count - a.count);
  }, [botsMode, items, usersById, classificationByUserId]);
  // Per-state counts across the (already bot-only) items, for the pill badges — independent of
  // the active pills. The backend filtered to automated reviewers, so every item counts.
  const botStateCounts = useMemo(() => {
    const m = new Map<DerivedState, number>();
    if (!botsMode) return m;
    for (const i of items) {
      if (i.derivedState == null) continue;
      m.set(i.derivedState, (m.get(i.derivedState) ?? 0) + 1);
    }
    return m;
  }, [botsMode, items]);

  // "My Turn only" and "Claude Reviews only" are mutually-exclusive client-side filters (My
  // Turn is CORE / free, so it's always available). The category pills + the bot lens compose
  // ON TOP of them. In botsMode the stream is hard-filtered to bot activity + the derived-state
  // pills instead (the store lens/category/my-turn filters don't apply).
  const visible = useMemo(() => {
    if (botsMode) {
      // Backend already restricted to automated reviewers; the vendor + state pills compose here
      // (vendor ∧ state — an empty set for a dimension means "all" for that dimension).
      let base = items;
      if (botVendorFilter.size > 0)
        base = base.filter((i) => i.actorId != null && botVendorFilter.has(i.actorId));
      if (botStateFilter.size > 0)
        base = base.filter((i) => i.derivedState != null && botStateFilter.has(i.derivedState));
      return base;
    }
    const base = feedMyTurnOnly
      ? items.filter((i) => i.isMyTurn)
      : feedClaudeOnly
        ? items.filter((i) => i.kind === 'claude_review')
        : items;
    const byCat = feedCatComments || feedCatPrEvents ? base.filter(catMatch) : base;
    return feedBotLens === 'hide'
      ? byCat.filter((i) => !isBotActor(i))
      : feedBotLens === 'only'
        ? byCat.filter(isBotActor)
        : byCat;
  }, [botsMode, botStateFilter, botVendorFilter, items, feedMyTurnOnly, feedClaudeOnly, feedBotLens, feedCatComments, feedCatPrEvents, catMatch, isBotActor]);

  // ── Vertical, variable-height windowing ─────────────────────────────────────────────
  // The feed accumulates unbounded across "Load more" pages, so rendering every card put
  // thousands of nodes in the DOM (every scroll/refetch re-laid them all out). Mirror the
  // OpenPrsStrip pattern but VERTICAL + variable-height: measure each row's real height via
  // a ResizeObserver into a Map<id, px>, estimate unmeasured rows with the running average,
  // compute the in-view index range from the scroll container + an overscan buffer, and
  // render only that slice with a top/bottom spacer <li> reserving the hidden rows' height.
  const listRef = useRef<HTMLUListElement>(null);
  const scrollElRef = useRef<HTMLElement | null>(null);
  const heightsRef = useRef<Map<string, number>>(new Map()); // id → measured px (kept across unmount)
  const rowRefs = useRef<Map<string, HTMLLIElement>>(new Map()); // id → mounted <li> (flash target)
  const innerRefCbs = useRef<Map<string, (el: HTMLLIElement | null) => void>>(new Map());
  const elToId = useRef<Map<Element, string>>(new Map());
  const rowRoRef = useRef<ResizeObserver | null>(null);
  const forceIncludeRef = useRef<string | null>(null); // an id the flash pins into the window
  const rafRef = useRef<number | null>(null);
  const visibleRef = useRef<ConsolidatedFeedItem[]>(visible);
  visibleRef.current = visible;
  const [win, setWin] = useState({ start: 0, end: 30, top: 0, bottom: 0 });

  const recompute = useCallback((): void => {
    rafRef.current = null;
    const scrollEl = scrollElRef.current;
    const listEl = listRef.current;
    if (!scrollEl || !listEl) return;
    const rows = visibleRef.current;
    const n = rows.length;
    if (n === 0) {
      setWin((w) =>
        w.start === 0 && w.end === 0 && w.top === 0 && w.bottom === 0
          ? w
          : { start: 0, end: 0, top: 0, bottom: 0 },
      );
      return;
    }
    const heights = heightsRef.current;
    let hsum = 0;
    for (const v of heights.values()) hsum += v;
    const est = heights.size > 0 ? hsum / heights.size : FEED_EST_ROW;
    const hOf = (i: number): number => heights.get(rows[i]!.id) ?? est;

    // Position of the viewport's top in list-content coordinates (offset 0 = first row's top).
    // Derived purely from live rects (no scrollTop math) so it works whether the scroller is
    // an overflow pane or the document, and it self-corrects for spacer estimate error since
    // listEl.rect reflects the ACTUAL rendered spacers.
    const isDoc =
      scrollEl === document.scrollingElement ||
      scrollEl === document.documentElement ||
      scrollEl === document.body;
    const viewportTop = isDoc ? 0 : scrollEl.getBoundingClientRect().top;
    const viewportH = isDoc ? window.innerHeight : scrollEl.clientHeight;
    const rel = viewportTop - listEl.getBoundingClientRect().top;
    const top0 = rel - FEED_OVERSCAN;
    const bottom0 = rel + viewportH + FEED_OVERSCAN;

    let start = 0;
    let end = n;
    let offset = 0;
    let found = false;
    for (let i = 0; i < n; i++) {
      const h = hOf(i);
      if (!found && offset + h >= top0) {
        start = i;
        found = true;
      }
      if (found && offset > bottom0) {
        end = i;
        break;
      }
      offset += h;
    }
    if (!found) start = n;

    // Keep a flashed/forced item mounted (Back-to-feed can target a far-down row) so its
    // scrollIntoView + flash can find the element.
    const force = forceIncludeRef.current;
    if (force != null) {
      const fi = rows.findIndex((it) => it.id === force);
      if (fi >= 0) {
        if (fi < start) start = fi;
        if (fi >= end) end = fi + 1;
      }
    }

    let top = 0;
    let bottom = 0;
    for (let i = 0; i < start; i++) top += hOf(i);
    for (let i = end; i < n; i++) bottom += hOf(i);
    setWin((w) =>
      w.start === start && w.end === end && w.top === top && w.bottom === bottom
        ? w
        : { start, end, top, bottom },
    );
  }, []);

  const scheduleRecompute = useCallback((): void => {
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(recompute);
  }, [recompute]);

  // Per-row ResizeObserver: measured heights feed the window + spacer sizes, and remeasure
  // when a row grows (expand-in-place, late <img> loads). Observe any rows already mounted
  // (their ref callbacks fire during commit, before this effect runs).
  useEffect(() => {
    const ro = new ResizeObserver((entries) => {
      let changed = false;
      for (const e of entries) {
        const id = elToId.current.get(e.target);
        if (id == null) continue;
        const h = (e.target as HTMLElement).offsetHeight;
        const prev = heightsRef.current.get(id);
        if (prev == null || Math.abs(prev - h) > 0.5) {
          heightsRef.current.set(id, h);
          changed = true;
        }
      }
      if (changed) scheduleRecompute();
    });
    rowRoRef.current = ro;
    for (const [id, el] of rowRefs.current) {
      elToId.current.set(el, id);
      ro.observe(el);
    }
    return () => {
      ro.disconnect();
      rowRoRef.current = null;
      elToId.current.clear();
    };
  }, [scheduleRecompute]);

  // Attach to the feed's scroll container (re-resolved once content mounts and the pane
  // becomes scrollable) + recompute on scroll/resize.
  const hasItems = visible.length > 0;
  useEffect(() => {
    const scrollEl =
      nearestScrollParent(rootRef.current) ??
      (document.scrollingElement as HTMLElement | null) ??
      document.documentElement;
    scrollElRef.current = scrollEl;
    const isDoc =
      scrollEl === document.scrollingElement ||
      scrollEl === document.documentElement ||
      scrollEl === document.body;
    const onScroll = (): void => scheduleRecompute();
    const scrollTarget: EventTarget = isDoc ? window : scrollEl;
    scrollTarget.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    const ro = new ResizeObserver(onScroll);
    ro.observe(scrollEl);
    scheduleRecompute();
    return () => {
      scrollTarget.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      ro.disconnect();
    };
  }, [scheduleRecompute, hasItems]);

  // Recompute whenever the visible set changes (filter toggles / new pages).
  useEffect(() => {
    scheduleRecompute();
  }, [visible, scheduleRecompute]);

  // A stable-per-id ref callback (memoised in a Map) so a memoised row's `innerRef` prop
  // never changes identity. Registers the <li> for flash targeting + row-height measurement.
  const getInnerRef = useCallback((id: string): ((el: HTMLLIElement | null) => void) => {
    let cb = innerRefCbs.current.get(id);
    if (!cb) {
      cb = (el: HTMLLIElement | null): void => {
        const prev = rowRefs.current.get(id);
        if (prev && prev !== el) {
          rowRoRef.current?.unobserve(prev);
          elToId.current.delete(prev);
        }
        if (el) {
          rowRefs.current.set(id, el);
          elToId.current.set(el, id);
          rowRoRef.current?.observe(el);
        } else {
          rowRefs.current.delete(id);
        }
      };
      innerRefCbs.current.set(id, cb);
    }
    return cb;
  }, []);

  // Expand-in-place state is LIFTED to the parent (keyed by item id) so it survives a row
  // scrolling out of the window and unmounting — otherwise windowing would silently collapse
  // an expanded body / close an open reply the moment it left the overscan zone.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [replyOpenIds, setReplyOpenIds] = useState<Set<string>>(() => new Set());
  const toggleExpanded = useCallback((id: string): void => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const setReplyOpen = useCallback((id: string, open: boolean): void => {
    setReplyOpenIds((prev) => {
      if (open === prev.has(id)) return prev;
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  // Back-from-a-click highlight: when a browser Back returns us to the feed (navigateBack
  // set the one-shot flashTarget), pin the target into the window, scroll it into view, and
  // flash it once, then consume the signal. Only fires on a real Back. A bounded rAF retry
  // waits for the window to expand + mount the row before scrolling.
  const [flashId, setFlashId] = useState<string | null>(null);
  useEffect(() => {
    if (flashTarget == null) return;
    const id = flashTarget;
    forceIncludeRef.current = id;
    scheduleRecompute();
    let tries = 0;
    let raf = 0;
    const release = (): void => {
      forceIncludeRef.current = null;
      scheduleRecompute();
    };
    const tryScroll = (): void => {
      const el = rowRefs.current.get(id);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        setFlashId(id);
        window.setTimeout(() => {
          setFlashId((c) => (c === id ? null : c));
          release();
        }, 1800);
        clearFlash();
      } else if (tries < 12) {
        tries += 1;
        raf = requestAnimationFrame(tryScroll);
      } else {
        release();
        clearFlash();
      }
    };
    raf = requestAnimationFrame(tryScroll);
    return () => cancelAnimationFrame(raf);
  }, [flashTarget, clearFlash, scheduleRecompute]);

  // Infinite scroll: auto-load the next page as the user nears the bottom of the feed, in
  // every context (cross-repo Feed + each repo's own feed both render this component). A
  // sentinel row sits after the list (below the bottom spacer, which reserves the full
  // hidden-row height so the sentinel is at the TRUE bottom); an IntersectionObserver rooted
  // on the feed's scroll container fires ~a screenful early (rootMargin) so the next page is
  // fetching before the user hits the true bottom. `loadNextRef` holds the latest guard so
  // the observer callback stays stable (empty-dep effect) yet always sees fresh state.
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

  // Open an item → the full-height PR DETAIL tab (its Show/Focus drive the timeline).
  // `fromActivity` arms Back-to-Activity + stashes this row's id so Back scrolls it back into
  // view. We also drive the right in-detail deep link: a Claude run → its Claude Review tab;
  // a thread → that thread's Threads-tab card; a PR comment → scroll to + highlight the
  // comment; else the PR. Stable (store actions are stable) so memoised rows don't churn.
  const open = useCallback(
    (item: ConsolidatedFeedItem): void => {
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
      if (item.threadId != null) selectThread(prId, item.threadId);
      else if (item.commentId != null) showPrComment(prId, item.commentId);
      else selectPr(prId);
    },
    [openClaudeReview, openPrDetailTab, selectThread, showPrComment, selectPr],
  );

  // Open a specific affected thread inline on a commit item — jump straight to that thread's
  // Threads-tab card.
  const openThread = useCallback(
    (item: ConsolidatedFeedItem, threadId: number): void => {
      const prId = item.prId;
      if (prId == null) return;
      openPrDetailTab(metaOf(item, prId), { fromActivity: true, returnItemId: item.id });
      selectThread(prId, threadId);
    },
    [openPrDetailTab, selectThread],
  );

  // The magnifier → Focus Mode: ALWAYS open the PR's own isolated timeline tab and glow the
  // marker for THIS event (a review_comment's refId is its thread id, so also pre-select that
  // thread). Unlike the shared board (date/filter-scoped), the focus tab fetches its OWN ~90-day
  // window, so a PR that isn't on the current board still loads + highlights here — no "not on
  // the timeline" modal. (A PR older than that window still opens; the boot selects it so its
  // detail pane shows even when its bar can't be isolated.) Mirrors PrDetail's Focus link.
  const focus = useCallback(
    (item: ConsolidatedFeedItem): void => {
      const prId = item.prId;
      if (prId == null) return;
      openPrFocusTab(metaOf(item, prId), { fromActivity: true, returnItemId: item.id });
      if (item.kind !== 'claude_review') {
        const refId = item.threadId ?? item.commentId ?? null;
        const threadId = item.kind === 'review_comment' ? item.threadId : null;
        focusEventInTab(prId, item.occurredAt, { type: item.kind as EventType, refId }, threadId);
      }
    },
    [openPrFocusTab, focusEventInTab],
  );

  const slice = visible.slice(win.start, win.end);

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

      {/* Cross-repo only: a collapsible panel of open PRs grouped by team; clicking a PR
          isolates the feed to that PR (below). Not in the Bots pane (a pure activity stream). */}
      {repoId == null && !botsMode && <FeedOpenPrsPanel />}

      {/* Active single-PR filter — always visible while isolating (even with the panel
          collapsed), with a one-click Clear. */}
      {isolatedPrId != null && (
        <div className="flex items-center gap-2 rounded-md border border-sky-300 bg-sky-50 px-3 py-1.5 text-xs text-sky-800 dark:border-sky-500/50 dark:bg-sky-950/40 dark:text-sky-200">
          <span aria-hidden="true">☰</span>
          <span className="min-w-0 flex-1 truncate">
            Showing only{' '}
            {isolatedPr != null ? (
              <>
                <span className="font-mono">#{isolatedPr.number}</span> {isolatedPr.title}
              </>
            ) : (
              'the selected PR'
            )}
          </span>
          <button
            type="button"
            onClick={() => setFeedIsolatedPrId(null)}
            className="shrink-0 rounded border border-sky-400 px-2 py-0.5 font-medium hover:bg-sky-100 dark:border-sky-500/60 dark:hover:bg-sky-900/40"
          >
            Clear
          </button>
        </div>
      )}

      {/* Bots pane: two independent, composable pill rows — VENDOR (one per distinct bot, so the
          in-house bots isolate separately) and STATE (review-thread derived state). Toggling
          multiple within a row ORs them; the two rows AND together (vendor ∧ state). These
          replace the normal My-Turn/Claude/category/bot-lens pills. */}
      {botsMode ? (
        <div className="space-y-2 px-0.5">
          {botVendors.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                Vendor
              </span>
              {botVendors.map((v) => {
                const on = botVendorFilter.has(v.actorId);
                return (
                  <button
                    key={v.actorId}
                    type="button"
                    onClick={() => toggleBotVendor(v.actorId)}
                    aria-pressed={on}
                    className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                      on
                        ? 'border-sky-400 bg-sky-50 text-sky-700 dark:border-sky-500/60 dark:bg-sky-950/30 dark:text-sky-300'
                        : 'border-gray-300 text-gray-500 hover:border-gray-400 dark:border-gray-700 dark:text-gray-400'
                    }`}
                    title={`Show only ${v.label}`}
                  >
                    <span aria-hidden="true">🤖</span>
                    <span
                      aria-hidden="true"
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ background: v.color }}
                    />
                    {v.label}
                    <span className="tabular-nums opacity-70">{v.count}</span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
              State
            </span>
            {BOT_STATE_ORDER.map((st) => {
              const meta = DERIVED_STATE_META[st];
              const on = botStateFilter.has(st);
              const count = botStateCounts.get(st) ?? 0;
              return (
                <button
                  key={st}
                  type="button"
                  onClick={() => toggleBotState(st)}
                  aria-pressed={on}
                  className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                    on
                      ? 'border-sky-400 bg-sky-50 text-sky-700 dark:border-sky-500/60 dark:bg-sky-950/30 dark:text-sky-300'
                      : 'border-gray-300 text-gray-500 hover:border-gray-400 dark:border-gray-700 dark:text-gray-400'
                  }`}
                  title={meta.description}
                >
                  <span
                    aria-hidden="true"
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ background: meta.color }}
                  />
                  {meta.label}
                  {count > 0 && <span className="tabular-nums opacity-70">{count}</span>}
                </button>
              );
            })}
            {items.length > 0 && (
              <span className="text-[11px] text-gray-400">
                {visible.length} of {items.length}
              </span>
            )}
          </div>
        </div>
      ) : (
      <>
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
        {/* Event-category pills: narrow the stream to comment activity and/or PR events.
            Independent toggles (both off = everything). Compose with the bot lens. */}
        <button
          type="button"
          onClick={toggleFeedCatComments}
          aria-pressed={feedCatComments}
          className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
            feedCatComments
              ? 'border-teal-400 bg-teal-50 text-teal-700 dark:border-teal-500/60 dark:bg-teal-950/30 dark:text-teal-300'
              : 'border-gray-300 text-gray-500 hover:border-gray-400 dark:border-gray-700 dark:text-gray-400'
          }`}
          title="Show comment activity (review threads + PR comments)"
        >
          <span aria-hidden="true">💬</span> Comments
          {commentCount > 0 && <span className="tabular-nums opacity-70">{commentCount}</span>}
        </button>
        <button
          type="button"
          onClick={toggleFeedCatPrEvents}
          aria-pressed={feedCatPrEvents}
          className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
            feedCatPrEvents
              ? 'border-indigo-400 bg-indigo-50 text-indigo-700 dark:border-indigo-500/60 dark:bg-indigo-950/30 dark:text-indigo-300'
              : 'border-gray-300 text-gray-500 hover:border-gray-400 dark:border-gray-700 dark:text-gray-400'
          }`}
          title="Show PR events (opens, merges, closes, reopens, ready-for-review, reviews)"
        >
          <span aria-hidden="true">⑃</span> PR events
        </button>
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
      </>
      )}

      {items.length === 0 ? (
        <div className="flex h-32 items-center justify-center text-sm text-gray-400">
          {botsMode
            ? 'No bot activity yet — automated-reviewer activity across your repos will appear here.'
            : 'Nothing to show yet — activity across your repos will appear here.'}
        </div>
      ) : visible.length === 0 ? (
        <div className="flex h-32 items-center justify-center text-sm text-gray-400">
          {botsMode
            ? botStateFilter.size > 0
              ? 'No bot activity matches these state filters.'
              : 'No bot activity in this window.'
            : feedClaudeOnly
            ? 'No Claude Reviews in this window.'
            : feedBotLens === 'only'
              ? 'No bot activity in this window.'
              : feedBotLens === 'hide'
                ? 'Only bot activity here — nothing from humans in this window.'
                : 'Nothing needs your attention right now.'}
        </div>
      ) : (
        // Windowed list: only the in-view slice (+overscan) is mounted; the spacer <li>s
        // reserve the hidden rows' summed height so the scrollbar geometry is unchanged. Each
        // FeedRow's <li> carries its own bottom padding (pb-2) so the measured offsetHeight —
        // and therefore the spacer sizes — includes the inter-row gap (no `space-y-2` here).
        <ul ref={listRef}>
          {win.top > 0 && <li aria-hidden style={{ height: win.top }} />}
          {slice.map((item) => (
            <FeedRow
              key={item.id}
              item={item}
              usersById={usersById}
              classificationByUserId={classificationByUserId}
              overridePendingUserId={overridePendingUserId}
              onNotBot={markNotBot}
              flash={flashId === item.id}
              expanded={expandedIds.has(item.id)}
              onToggleExpanded={toggleExpanded}
              replyOpen={replyOpenIds.has(item.id)}
              onSetReplyOpen={setReplyOpen}
              innerRef={getInnerRef(item.id)}
              onOpen={open}
              onOpenThread={openThread}
              onFocus={focus}
            />
          ))}
          {win.bottom > 0 && <li aria-hidden style={{ height: win.bottom }} />}
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
  // A resolved thread needs no attention — start collapsed to a one-line summary and let
  // the reader expand the full conversation on demand (keeps the feed scannable).
  const [expanded, setExpanded] = useState(false);
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
  // A resolved thread renders collapsed to a one-line summary that TOGGLES the full
  // conversation on click (both expand and collapse). The header row is the only
  // clickable affordance; the expanded conversation sits in a cursor-default wrapper so
  // its (non-interactive) content doesn't inherit the feed card's pointer cursor.
  if (thread.derivedState === 'resolved') {
    const file = thread.path.split('/').pop() ?? thread.path;
    const count = thread.comments.length;
    return (
      <div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="group/rt flex w-full cursor-pointer items-center gap-1.5 rounded border border-gray-200 bg-white/60 px-2 py-1 text-left text-[11px] hover:border-sky-300 dark:border-gray-800 dark:bg-gray-900/40 dark:hover:border-sky-700"
        >
          {/* The Resolved pill, anchored top-LEFT, stays visible while the thread is
              collapsed — the reader knows it's resolved without expanding. Same pill the
              expanded ThreadCard shows, so collapsed and expanded read uniformly. */}
          <span className="shrink-0">
            <StateBadge state={thread.derivedState} />
          </span>
          <code className="truncate font-mono text-gray-600 group-hover/rt:text-sky-600 dark:text-gray-300">
            {file}
            {thread.line != null ? `:${thread.line}` : ''}
          </code>
          <span className="shrink-0 text-gray-400">
            {count === 1 ? '1 comment' : `${count} comments`}
          </span>
          <span
            className={`ml-auto shrink-0 text-sky-600 dark:text-sky-400 ${
              expanded ? '' : 'opacity-0 group-hover/rt:opacity-100'
            }`}
          >
            {expanded ? 'Hide' : 'Show'}
          </span>
        </button>
        {expanded && (
          <div className="mt-1.5 cursor-default">
            <ThreadCard
              thread={thread}
              usersById={usersById}
              prUrl={prUrl}
              repoId={item.repoId}
              highlightCommentId={highlightCommentId}
            />
          </div>
        )}
      </div>
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

// A PR-comment card whose STORED body is null (legacy lean-era rows never re-synced) renders
// blank from item.content. Hydrate it on demand from the PR detail (the same fetch PR detail
// uses — cached + deduped per PR, so a single-PR isolated feed does ONE fetch for all its
// comments), matching by comment id. Falls back to a muted note if truly unavailable.
function PrCommentBody({ prId, commentId }: { prId: number; commentId: number }): JSX.Element {
  const { data: pr, isLoading } = usePr(prId);
  if (isLoading) {
    return <span className="text-xs text-gray-400">Loading comment…</span>;
  }
  const body = pr?.comments.find((c) => c.id === commentId)?.body?.trim();
  if (!body) {
    return (
      <span className="text-xs italic text-gray-400">
        Comment body unavailable — open the PR to view.
      </span>
    );
  }
  return <Markdown>{body}</Markdown>;
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

// The threads a commit push addressed. Already-RESOLVED threads need no attention, so
// they're collapsed behind a "Show N resolved" disclosure by default — the reader sees
// the still-open ones first, and can reveal the resolved ones on demand.
function AffectedThreadsList({
  affected,
  usersById,
  onOpenThread,
}: {
  affected: FeedAffectedThread[];
  usersById: Map<number, User>;
  onOpenThread: (threadId: number) => void;
}): JSX.Element {
  const [showResolved, setShowResolved] = useState(false);
  const open = affected.filter((t) => t.derivedState !== 'resolved');
  const resolved = affected.filter((t) => t.derivedState === 'resolved');
  const row = (t: FeedAffectedThread): JSX.Element => (
    <AffectedThreadRow
      key={t.threadId}
      thread={t}
      author={t.authorId != null ? usersById.get(t.authorId) : undefined}
      onOpen={() => onOpenThread(t.threadId)}
    />
  );
  return (
    <ul className="space-y-1.5">
      {open.map(row)}
      {resolved.length > 0 && (
        <li>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setShowResolved((v) => !v);
            }}
            className="text-[11px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
          >
            {showResolved ? 'Hide' : 'Show'} {resolved.length} resolved{' '}
            {resolved.length === 1 ? 'thread' : 'threads'}
          </button>
        </li>
      )}
      {showResolved && resolved.map(row)}
    </ul>
  );
}

// The collapsed height of a comment/summary body before "Show more" appears (item 2).
const BODY_COLLAPSED_MAX = 160;

type FeedRowProps = {
  item: ConsolidatedFeedItem;
  usersById: Map<number, User>;
  classificationByUserId: Map<number, ReviewerClassification>;
  overridePendingUserId: number | null;
  onNotBot: (userId: number) => void;
  flash: boolean;
  expanded: boolean;
  onToggleExpanded: (id: string) => void;
  replyOpen: boolean;
  onSetReplyOpen: (id: string, open: boolean) => void;
  innerRef: (el: HTMLLIElement | null) => void;
  onOpen: (item: ConsolidatedFeedItem) => void;
  onOpenThread: (item: ConsolidatedFeedItem, threadId: number) => void;
  onFocus: (item: ConsolidatedFeedItem) => void;
};

function FeedRowImpl({
  item,
  usersById,
  classificationByUserId,
  overridePendingUserId,
  onNotBot,
  flash,
  expanded,
  onToggleExpanded,
  replyOpen,
  onSetReplyOpen,
  innerRef,
  onOpen,
  onOpenThread,
  onFocus,
}: FeedRowProps): JSX.Element {
  const glyph = itemGlyph(item);
  // Derived, memoised per row so props into this memoised component stay stable.
  const actorUser = item.actorId != null ? usersById.get(item.actorId) : undefined;
  const automatedTag = useMemo(
    () => automatedTagFor(actorUser, classificationByUserId),
    [actorUser, classificationByUserId],
  );
  const overridePending =
    automatedTag?.userId != null && overridePendingUserId === automatedTag.userId;
  const mergedBy = item.mergedById != null ? usersById.get(item.mergedById) : undefined;
  const mergedByLabel =
    mergedBy != null || item.mergedById != null ? userLabel(mergedBy, item.mergedById) : null;
  const reviewerLabels = useMemo(
    () => (item.reviewers ?? []).map((r) => userLabel(usersById.get(r.userId), r.userId)),
    [item.reviewers, usersById],
  );

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

  // A review-thread card shows its FULL conversation inline (reply + resolve, with
  // the specific comment highlighted new); a PR-comment card can open a quote+@mention
  // reply.
  const isThreadCard = item.kind === 'review_comment' && item.threadId != null;
  const isPrCommentCard = item.kind === 'pr_comment' && item.prId != null;
  const isPrOpened = item.kind === 'pr_opened';

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
    onOpen(item);
  };

  return (
    <li ref={innerRef} className="pb-2">
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
                onFocus(item);
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
          {automatedTag && (
            <span className="group/bot inline-flex shrink-0 items-center gap-1">
              <span
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium"
                style={{ color: automatedTag.color, background: `${automatedTag.color}1a` }}
                title={`${automatedTag.label} — an automated reviewer Pierre triages`}
              >
                <span aria-hidden>🤖</span>
                {automatedTag.label}
              </span>
              {automatedTag.userId != null && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (automatedTag.userId != null) onNotBot(automatedTag.userId);
                  }}
                  disabled={overridePending}
                  className="text-[9px] text-gray-400 underline underline-offset-2 opacity-0 transition-opacity hover:text-gray-600 disabled:opacity-40 group-hover/bot:opacity-100 dark:hover:text-gray-200"
                  title="Not a bot? Reclassify this reviewer as human"
                >
                  {overridePending ? 'saving…' : 'not a bot?'}
                </button>
              )}
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
              onClick={() => onOpen(item)}
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
                onClick={() => onToggleExpanded(item.id)}
                className="mt-1 text-[11px] font-medium text-sky-600 hover:underline dark:text-sky-400"
              >
                {expanded ? 'Show less' : 'Show more'}
              </button>
            )}
          </div>
        )}

        {/* A PR-comment card whose stored body is null (legacy data): hydrate + render it on
            demand so the card isn't blank (common in the single-PR isolated feed, which shows
            full history). Only for issue-level PR comments with a comment id. */}
        {isPrCommentCard && !hasBody && item.commentId != null && item.prId != null && (
          <div className="mt-1.5 rounded bg-gray-50 px-2 py-1.5 text-sm dark:bg-gray-900/50">
            <PrCommentBody prId={item.prId} commentId={item.commentId} />
          </div>
        )}

        {/* Consolidated top-level PR comment(s) folded into this card (posted by the same
            person around the same time as this review / close / merge) — shown as "Also
            commented" instead of separate feed rows. Independent of the card's own body, so a
            bare approval + comment or a "Comment and close" still shows it. */}
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
            <AffectedThreadsList
              affected={affected}
              usersById={usersById}
              onOpenThread={(tid) => onOpenThread(item, tid)}
            />
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
            highlighted new. Stop propagation so interacting never opens the tab, and
            reset the cursor so the thread body doesn't inherit the card's pointer. */}
        {isThreadCard && (
          <div className="mt-1.5 cursor-default" onClick={(e) => e.stopPropagation()}>
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
                  onSetReplyOpen(item.id, true);
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
                  onCancel={() => onSetReplyOpen(item.id, false)}
                  onDone={() => onSetReplyOpen(item.id, false)}
                />
              </div>
            )}
          </div>
        )}
      </article>
    </li>
  );
}

// Memoised so a scroll-driven parent re-render (window range / spacer height changing) skips
// every row whose render inputs are unchanged. All props are stable references now (item is
// query-stable; the handlers are useCallback; innerRef is a per-id cached callback), so the
// comparator is a shallow equality over exactly the inputs that affect a row's output: item
// identity, the flash + controlled expand/reply flags, the pending-override id, the shared
// user/classification maps, and the stable callback identities.
const FeedRow = memo(
  FeedRowImpl,
  (a, b) =>
    a.item === b.item &&
    a.flash === b.flash &&
    a.expanded === b.expanded &&
    a.replyOpen === b.replyOpen &&
    a.overridePendingUserId === b.overridePendingUserId &&
    a.usersById === b.usersById &&
    a.classificationByUserId === b.classificationByUserId &&
    a.onOpen === b.onOpen &&
    a.onOpenThread === b.onOpenThread &&
    a.onFocus === b.onFocus &&
    a.onNotBot === b.onNotBot &&
    a.onToggleExpanded === b.onToggleExpanded &&
    a.onSetReplyOpen === b.onSetReplyOpen &&
    a.innerRef === b.innerRef,
);
