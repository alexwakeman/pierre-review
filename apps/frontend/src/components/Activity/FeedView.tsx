import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type {
  AutomatedReviewerKind,
  ClaudeReviewVerdict,
  ConsolidatedFeedItem,
  DerivedState,
  EventType,
  FeedAffectedThread,
  ReviewState,
  User,
  WorkspaceReviewer,
} from '@pierre-review/shared';
import {
  countHeadArrivals,
  useConsolidatedFeed,
  useFeedAutoInsert,
  useMarkFeedSeen,
} from '../../hooks/useConsolidatedFeed.js';
import { useDetectedReviewers, useSetWorkspaceReviewer } from '../../hooks/useBotTriage.js';
import { useBotColors } from '../../hooks/useBotColors.js';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useThread, usePr } from '../../hooks/usePr.js';
import { useUsers } from '../../hooks/useTimeline.js';
import { useFilters, type FeedBotLens } from '../../store/filters.js';
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
  safeExternalUrl,
  userLabel,
} from '../../lib/ui.js';
import { nearestScrollParent } from '../../lib/scrollParent.js';
import { Avatar } from '../CommentCard.js';
import { CommentAnnotations, ReviewCheckButton } from '../CommentAnnotations.js';
import { MagnifierIcon } from '../Icons.js';
import { Markdown } from '../Markdown.js';
import { PrCommentComposer } from '../PrCommentComposer.js';
import { StateBadge } from '../StateBadge.js';
import { ThreadCard } from '../ThreadView/index.js';
import { FeedOpenPrsPanel } from './FeedOpenPrsPanel.js';
import { UserName } from '../UserName.js';

// The two SYNTHESIZED CI kinds (`db/queries.ts` isCiFeedKind's client twin). One predicate so
// the count, the renderer and the click affordance can never cover different sets — missing one
// arm is silent.
function isCiFailureKind(kind: string): boolean {
  return kind === 'ci_failed' || kind === 'trunk_ci_failed';
}

// A coloured chip + label describing WHAT an item is (the event kind). The My-Turn reason is
// a separate pill (see MY_TURN_REASON_META); Claude runs get their own AI-signal chip.
function itemGlyph(item: ConsolidatedFeedItem): { color: string; label: string; className?: string } {
  // The one glyph whose colour must flip per theme — a hex can't (the chip below
  // derives its wash by appending '1a'), so this kind carries classes instead.
  if (item.kind === 'claude_review')
    return { color: '', label: 'Claude Review', className: 'bg-ai-signal/10 text-ai-signal' };
  // CI failures — one card per failed check run. "detected", not "failed at": both sources
  // timestamp OUR observation, which can lag the real failure by up to the sync floor.
  if (item.kind === 'ci_failed') return { color: '#ef4444', label: 'CI failed' };
  if (item.kind === 'trunk_ci_failed') return { color: '#ef4444', label: 'Trunk CI failed' };
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

// An automated-reviewer tag for a feed row's actor: a known VENDOR bot (by login) OR a
// workspace-classified automated reviewer (in-house AI / Pierre — surfaced via the detected-
// reviewers listing, since those aren't login-derivable). `userId` is the actor
// id so the inline "not a bot?" override can target it. Null → the actor is a human.
type AutomatedTag = { userId: number | null; kind: AutomatedReviewerKind; label: string; color: string };

// The per-bot colour resolver for the ACTIVE WORKSPACE (see useBotColors) — so an in-house bot
// keeps the SAME distinct colour in the feed as in the Bots ROI console / per-repo Bots tab.
type BotColorFn = (bot: { login?: string | null; kind: AutomatedReviewerKind }) => string;

// ⚠ THE VENDOR NAME AND COLOUR COME FROM THE ACTIVE WORKSPACE'S ROW, and there is exactly one per
// actor, so the same bot cannot render under two names in one scroll. (It could when identity was
// replicated across per-repo rows; the workspace row is now the single answer — and it is
// per-workspace, so the same login may legitimately be named differently in another Workspace.)
function automatedTagFor(
  actorUser: User | undefined,
  identityByUserId: Map<number, WorkspaceReviewer>,
  botColor: BotColorFn,
): AutomatedTag | null {
  // Known review-bot vendor (CodeRabbit/Copilot/…) by login — the v1 path, still first.
  const loginVendor = botVendorMeta(actorUser);
  if (loginVendor) {
    return {
      userId: actorUser?.id ?? null,
      kind: loginVendor.kind,
      label: loginVendor.label,
      color: botColor({ login: actorUser?.githubLogin, kind: loginVendor.kind }),
    };
  }
  // Otherwise, a workspace-classified automated reviewer (in-house AI / Pierre) — widened
  // from the login-only path so those tags surface in the feed too.
  if (actorUser) {
    // `kind != null` IS the test: the row carries a vendor kind only while the actor has a vendor
    // identity in THIS workspace. The feed spans the workspace's repos and the judgement is keyed
    // to the workspace, so this one row is the whole answer — there is no per-repo row to pick.
    const id = identityByUserId.get(actorUser.id);
    if (id && id.kind != null) {
      return {
        userId: actorUser.id,
        kind: id.kind,
        label: id.label,
        color: botColor({ login: actorUser.githubLogin, kind: id.kind }),
      };
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

// Windowing overscan (px) rendered past each edge of the visible viewport so a fast scroll
// (or an expand-in-place row growing) never blanks, and a just-interacted row stays mounted.
const FEED_OVERSCAN = 800;
// Height estimate for a not-yet-measured row before the running average kicks in.
const FEED_EST_ROW = 160;
// How close to the top of the feed still counts as "reading the top of it" — both for deciding
// whether an arriving batch needs scroll compensation and for crediting cohorts as seen. Roughly
// half a card: far enough to survive a stray wheel nudge, near enough that the newest rows are
// unambiguously on screen.
const FEED_AT_TOP_PX = 80;

// The feed's scroll container is either its own overflow pane (the Activity console) or the
// document, and only the pane exposes a writable `scrollTop`. Two helpers so the compensation
// path can't quietly no-op on the document case.
//
// ⚠ THIS IS NOT THE TIMELINE'S GATED SCROLL. `setVisScrollTop` / `intentionalScrollRef` guard the
// vis-timeline board's virtualized viewport; this is a plain DOM pane and must NOT be routed
// through them.
function feedScrollTop(el: HTMLElement): number {
  return el === document.documentElement || el === document.body ? window.scrollY : el.scrollTop;
}
function feedScrollBy(el: HTMLElement, dy: number): void {
  if (el === document.documentElement || el === document.body) window.scrollBy(0, dy);
  else el.scrollTop += dy;
}

// The review-thread DERIVED-state pills (every feed view). Order mirrors the timeline
// legend: needs-attention → in-progress → done.
const BOT_STATE_ORDER: DerivedState[] = [
  'untouched',
  'replied_unresolved',
  'likely_addressed',
  'resolved',
];

export function FeedView({
  repoId,
  botsMode = false,
  userIds = null,
}: {
  repoId?: number;
  // The Bots pane's bot-only feed: hard-filters to automated-reviewer activity and swaps the
  // normal pill row for review-thread derived-state pills (Untouched / Replied / Likely
  // addressed / Resolved). Also drops the open-PRs panel + the cross-repo "seen" marker.
  botsMode?: boolean;
  // Scope the feed to specific ACTORS (the per-contributor activity tab). Like botsMode this
  // is an Activity-native scope, filtered server-side before the cap — NOT the Timeline's
  // Members filter, which the feed still never sends. Also drops the open-PRs panel + the
  // cross-repo "seen" marker (a person's feed isn't "the feed" being caught up on).
  userIds?: number[] | null;
}): JSX.Element {
  const workspaceId = useFilters((s) => s.workspaceId);
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
  const feedNeedsReview = useFilters((s) => s.feedNeedsReview);
  const toggleFeedNeedsReview = useFilters((s) => s.toggleFeedNeedsReview);
  const feedShowCommits = useFilters((s) => s.feedShowCommits);
  const toggleFeedShowCommits = useFilters((s) => s.toggleFeedShowCommits);
  const feedCiLens = useFilters((s) => s.feedCiLens);
  const cycleFeedCiLens = useFilters((s) => s.cycleFeedCiLens);
  const feedIsolatedPrId = useFilters((s) => s.feedIsolatedPrId);
  // The cross-repo feed's transient "New" markers (see FeedNewCohorts in store/filters.ts).
  const feedNewCohorts = useFilters((s) => s.feedNewCohorts);
  const pushFeedNewCohort = useFilters((s) => s.pushFeedNewCohort);
  const markFeedNewCohortsSeen = useFilters((s) => s.markFeedNewCohortsSeen);
  const selectThread = useFilters((s) => s.selectThread);
  const selectPr = useFilters((s) => s.selectPr);
  const showPrComment = useFilters((s) => s.showPrComment);
  const openClaudeReview = useFilters((s) => s.openClaudeReview);
  const focusEventInTab = useFilters((s) => s.focusEventInTab);
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const openPrFocusTab = usePinnedTabs((s) => s.openPrFocusTab);
  const { claudeReview: claudeReviewEnabled } = useProCapabilities();

  // Detected reviewers for the ACTIVE WORKSPACE (CORE / free) → the actor→row map that lets
  // in-house AI / Pierre actors carry a vendor tag (login-based vendors don't need it).
  //
  // ⚠ THE WORKSPACE ARGUMENT IS NOT OPTIONAL AND MUST BE THE ACTIVE ONE. Identity is a
  // per-workspace fact on the `workspace_reviewers` row, so an unscoped call is answered from the
  // account's DEFAULT workspace and every bot on screen would be painted — or un-named — from a
  // workspace the user is not looking at. Unnarrowed by repo on purpose: within a workspace a bot
  // must be the same colour on every surface, and this is the same cache entry useBotColors reads.
  const { data: detectedReviewers } = useDetectedReviewers(workspaceId);
  // Per-bot colour resolver for the same workspace (shares the listing cache above — no extra
  // fetch). Gives in-house bots a distinct, consistent colour in the feed pills + row tags.
  const botColor = useBotColors(workspaceId);
  const judgement = useSetWorkspaceReviewer();
  const { mutate: judgementMutate } = judgement;
  const identityByUserId = useMemo(() => {
    const m = new Map<number, WorkspaceReviewer>();
    for (const r of detectedReviewers?.reviewers ?? []) {
      if (r.kind != null) m.set(r.userId, r);
    }
    return m;
  }, [detectedReviewers]);
  // EVERY stored reviewer row for the workspace (not just the vendor-identity subset above) —
  // the client half of the UNION bot definition. `automated` adds an actor to the bot set; a
  // manual "this is a human" removes it even where the global users.isBot flag disagrees.
  const reviewerByUserId = useMemo(() => {
    const m = new Map<number, WorkspaceReviewer>();
    for (const r of detectedReviewers?.reviewers ?? []) m.set(r.userId, r);
    return m;
  }, [detectedReviewers]);
  // The union verdict for ONE actor — mirrors the server's hiddenBotUserIds so the lens, the
  // pill counts and the server-side exclusion agree on who is a bot. `user` may come from the
  // feed response OR the account roster, whichever the caller holds; the workspace's stored
  // row wins in BOTH directions.
  const isUnionBot = useCallback(
    (userId: number, user: User | undefined): boolean => {
      const r = reviewerByUserId.get(userId);
      if (r != null) {
        if (r.automated) return true;
        // A manual "this is a human" beats the global isBot flag.
        if (r.isManualOverride) return false;
      }
      return user?.isBot ?? false;
    },
    [reviewerByUserId],
  );
  const overridePendingUserId = judgement.isPending
    ? judgement.variables?.userId ?? null
    : null;
  // Stable across renders so a memoised row's props don't churn.
  //
  // ⚠ "not a bot?" IS A WORKSPACE-WIDE JUDGEMENT — one row, keyed (account, workspace, actor) —
  // so ONE CLICK STOPS TREATING THIS REVIEWER AS AUTOMATED IN EVERY REPO OF THE WORKSPACE. The
  // old per-repo version could honestly promise "your other repos are unaffected"; this cannot,
  // and on the highest-traffic surface in the app a silent write with that blast radius is a trap.
  // Hence the confirm below and the button's rewritten title — both are the safety mechanism, not
  // decoration. It writes NO kind/label (the two provenance flags are stamped independently), so
  // the vendor tag survives: the row simply stops being automated in this Workspace, and the same
  // actor's rows in other Workspaces are untouched and may still call it a bot.
  const markNotBot = useCallback(
    (userId: number, label: string): void => {
      if (workspaceId == null) return;
      const ok = window.confirm(
        `Stop treating ${label} as an automated reviewer in this Workspace?\n\n` +
          'This applies to every repo in the Workspace — not just this PR’s repo. ' +
          'It keeps the vendor name, and you can undo it from Bots › Settings.',
      );
      if (!ok) return;
      judgementMutate({ userId, body: { workspaceId, automated: false } });
    },
    [judgementMutate, workspaceId],
  );
  // The one-shot flash signal — promoted from the pending return target by
  // `applyUrlTab({ fromPop: true })`, i.e. ONLY by a popped URL that lands on Activity, so an
  // ordinary return to Activity (e.g. clicking the Activity tab chip) never flashes.
  const flashTarget = usePinnedTabs((s) => s.activityFlashItemId);
  const clearFlash = usePinnedTabs((s) => s.clearActivityFlashItem);

  // A selected rail repo scopes the feed to just that repo; otherwise the feed covers the WHOLE
  // active workspace (`null` → the server expands it to the workspace's membership).
  //
  // ⚠ IT NO LONGER FOLLOWS `filters.repoIds`, AND THAT IS THE POINT. The FilterBar's repo picker
  // is a TIMELINE-board filter and is not mounted while Activity is the active tab, so a feed
  // scoped by it would be silently short with no visible control to widen it again — the picker's
  // effect would outlive the only screen that shows it. Narrowing the feed is the RAIL's job: the
  // `repoId` prop above IS that narrowing, and it comes with an obvious, reversible control.
  const effectiveRepoIds = repoId != null ? [repoId] : null;

  // Single-PR isolation applies to BOTH the cross-repo feed (the repo-grouped "open PRs"
  // panel) and a per-repo console (its RepoOpenPrList rows) — clicking a PR in either filters
  // the feed to that PR. `setActivityRepo` clears it when switching rails, so it never leaks
  // across repos.
  // Scopes the feed query to a single PR when set. The "Showing only #N" banner itself renders
  // in the surrounding panel (FeedIsolationBanner — under the repo/bots summary header), not
  // here; when isolated, this view also drops its own cross-repo Open-PRs panel (below).
  const isolatedPrId = feedIsolatedPrId;

  // THE ONE PREDICATE that says "this mount is *the* feed". FeedView has five mounts sharing one
  // FeedRow — the cross-repo feed, the unresolved-repo fallback, the per-repo console, the Bots
  // pane's bot-only feed and a person's activity tab — and three behaviours are cross-repo-only:
  // the server "seen" marker below, the auto-insert of newly-arrived items, and the "New" card
  // marker that goes with it. The narrowed views are things someone opened on purpose; keeping
  // them live (and telling them what's new) would be answering a question they didn't ask.
  const isCrossRepoFeed = repoId == null && !botsMode && userIds == null;

  // Viewing the CROSS-REPO feed marks it seen server-side (once per mount), resetting the
  // "new My Turn since you were last here" count `/api/me` computes. A per-repo feed (repoId
  // set) doesn't touch the global marker.
  //
  // ⚠ THIS IS THE *SERVER* SEEN MARKER (accounts.feedLastSeenAt) AND IT IS NOT THE CARD MARKER.
  // It is account-level; the per-card "New" chip is a transient client cohort
  // (store/filters.ts). Removing the old "New activity — Refresh" button must not take this
  // with it — nothing else bumps feedLastSeenAt.
  //
  // ⚠ …AND IT NOW HAS NO READER AT ALL. `WelcomeBackBanner` used to render the count this
  // marker gated (`MeResponse.newFeedItems`); it counts standing `my_turn` CARDS per workspace
  // instead (a population that doesn't reset when you glance at a feed), so `/api/me` no longer
  // carries `feedLastSeenAt`/`newFeedItems` and the read path is gone. THE COLUMN IS NOW
  // WRITE-ONLY, and this write is deliberately kept: a marker that stopped being written could
  // not be given a reader again without a backfill, and "when did they last look at the feed"
  // is not recoverable after the fact. Drop the write only together with the column.
  const markFeedSeen = useMarkFeedSeen();
  const markedSeenRef = useRef(false);
  useEffect(() => {
    // botsMode and a userIds scope are both narrowed views — neither may reset the cross-repo
    // My-Turn "seen" marker (you haven't caught up on the feed by reading one person's).
    if (isCrossRepoFeed && !markedSeenRef.current) {
      markedSeenRef.current = true;
      markFeedSeen.mutate();
    }
  }, [isCrossRepoFeed, markFeedSeen]);

  // Bots pane: the feed window follows the analytics window selector (shared store field),
  // using the SAME window→days mapping as getBotAnalytics (rolling_7=7, rolling_30=30, else —
  // incl. sprint — 14). Null outside botsMode so normal feeds keep their default window.
  const botAnalyticsWindow = useFilters((s) => s.botAnalyticsWindow);
  const botWindowDays = botsMode
    ? botAnalyticsWindow === 'rolling_7'
      ? 7
      : botAnalyticsWindow === 'rolling_30'
        ? 30
        : 14
    : null;

  // Per-contributor exemption: a BOT contributor's own activity tab must not be emptied by
  // the hidden-by-default lens, so when EVERY viewed actor is a bot under the union
  // definition the EFFECTIVE lens is 'all'. Derived for the render only — never written back
  // to the store (the standing sub-tab landmine: a corrective set() would permanently forget
  // the user's choice). The check reads the account roster + the workspace reviewer rows, NOT
  // the feed response — the lens now drives the request itself (excludeBots below), so a
  // response-derived check would ask an already-emptied feed whether its subject is a bot.
  const { data: roster } = useUsers();
  const rosterById = useMemo(() => indexUsers(roster ?? []), [roster]);
  const lensInert = useMemo(
    () =>
      userIds != null &&
      userIds.length > 0 &&
      userIds.every((id) => isUnionBot(id, rosterById.get(id))),
    [userIds, isUnionBot, rosterById],
  );
  const effectiveBotLens: FeedBotLens = lensInert ? 'all' : feedBotLens;

  // Members + the header exclude-bots toggle/allow-list are TIMELINE-only filters — the feed
  // never sends them (userIds → null, allowedBotIds omitted). Bot filtering here is
  // Activity-native: the feedBotLens pills — whose 'hide' now rides the server's excludeBots
  // param (union bot definition, excluded BEFORE the page cap so a bot-heavy window fills
  // with human rows) while 'only' stays a client-side view — and botsMode (server-side).
  // useConsolidatedFeed and useFeedAutoInsert below MUST share identical scope inputs — the
  // auto-insert path SPLICES the head's rows into this query's cache entry, so a divergent
  // scope would prepend rows this request would never have returned.
  const {
    items,
    users,
    total,
    uncappedTotal,
    counts,
    isLoading,
    isPlaceholderData,
    hasMore,
    loadMore,
    isFetchingMore,
  } = useConsolidatedFeed({
      // The active WORKSPACE decides which logins count as automated reviewers (the botsOnly
      // path) AND which repos `repoIds: null` expands to — `repoIds` alone can express neither.
      workspaceId,
      repoIds: effectiveRepoIds,
      userIds,
      prId: isolatedPrId,
      // Lens 'hide' is SERVER-side: bots (union definition) excluded before the page cap.
      // 'only'/'all' fetch everything; 'only' narrows client-side. Off in botsMode (the
      // server forces it off under botsOnly anyway).
      excludeBots: !botsMode && effectiveBotLens === 'hide',
      // Bot pane: the backend filters to automated reviewers IN SQL (before the cap), so the
      // feed spans the full window of bot activity instead of a bot-slice of a capped page.
      botsOnly: botsMode,
      botWindowDays,
      // Opt-in "show individual commits" — surfaces plain commit-push runs (not just the ones
      // that addressed a thread). Inert in botsMode (the bot feed skips commits anyway).
      includeAllCommits: !botsMode && feedShowCommits,
      // Opt-in "show CI failures" — one row per failed check run, on PR heads AND on the
      // default branch. Inert in botsMode (a red build is not review-bot activity, and the
      // server ignores it there anyway).
      includeCiFailures: !botsMode && feedCiLens !== 'off',
    });

  const rootRef = useRef<HTMLDivElement>(null);

  const usersById = useMemo(() => indexUsers(users), [users]);
  // Bot lens: an actor is a "bot" for the lens if it's ANY bot under the UNION definition —
  // the global users.isBot flag (dependabot/CI) ∪ the workspace's automated-reviewer verdict
  // (classified in-house bots like deepsource), with a manual "human" override un-botting in
  // both directions — so "Hide bots" gives the clean human-only view and the pills/counts/lens
  // agree with the server's exclusion. The per-row vendor TAG is review-bot-only.
  const isBotActor = useCallback(
    (i: ConsolidatedFeedItem): boolean =>
      i.actorId != null && isUnionBot(i.actorId, usersById.get(i.actorId)),
    [isUnionBot, usersById],
  );
  // Pill badge counts come from the SERVER facets (whole loadable stream), falling back to the
  // loaded-page derivation only for a stale IndexedDB response predating `counts`.
  const myTurnCount = useMemo(
    () => counts?.myTurn ?? items.filter((i) => i.isMyTurn).length,
    [counts, items],
  );
  const claudeCount = useMemo(
    () => counts?.claude ?? items.filter((i) => i.kind === 'claude_review').length,
    [counts, items],
  );
  const botCount = useMemo(
    () => counts?.bots ?? items.filter(isBotActor).length,
    [counts, items, isBotActor],
  );
  // Event-category matcher for the Comments / PR-events pills. Both off = no category filter.
  // When either is on, keep only items in the enabled categories (commit, Claude and CI-failure
  // rows, which are in neither category, drop out while a category pill is active — deliberate:
  // adding a kind here would silently change what those two existing pills mean).
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
    () =>
      counts?.comments ??
      items.filter((i) => i.kind === 'review_comment' || i.kind === 'pr_comment').length,
    [counts, items],
  );
  // PR-events pill badge — the server `prEvents` facet already ships (computeFeedCounts) but was
  // never read, so the pill showed no count. Kinds kept in sync with catMatch's isPrEvent above.
  const prEventsCount = useMemo(
    () =>
      counts?.prEvents ??
      items.filter(
        (i) =>
          i.kind === 'pr_opened' ||
          i.kind === 'pr_merged' ||
          i.kind === 'pr_closed' ||
          i.kind === 'pr_reopened' ||
          i.kind === 'pr_ready_for_review' ||
          i.kind === 'review_submitted',
      ).length,
    [counts, items],
  );
  // "Needs review" matcher — a pr_opened / pr_ready_for_review card whose PR STILL awaits a
  // first review (the server-computed live snapshot). MUST mirror computeFeedCounts's
  // awaitingReview facet exactly, or the badge and the filtered list disagree.
  const matchesNeedsReview = useCallback(
    (i: ConsolidatedFeedItem): boolean =>
      (i.kind === 'pr_opened' || i.kind === 'pr_ready_for_review') &&
      i.prAwaitingReview === true,
    [],
  );
  // Needs-review pill badge — the server `awaitingReview` facet with a loaded-page fallback
  // (a stale IndexedDB-persisted response predates the field). Both sides count DISTINCT PRs,
  // not events — a draft-first PR carries both kinds in the window.
  const needsReviewCount = useMemo(
    () =>
      counts?.awaitingReview ??
      new Set(items.filter(matchesNeedsReview).map((i) => i.prId)).size,
    [counts, items, matchesNeedsReview],
  );
  // Commits pill badge — how many commit-push items are currently in the stream (the
  // thread-addressing runs by default; every push run once "show commits" is on).
  const commitsCount = useMemo(
    () => counts?.commits ?? items.filter((i) => i.kind === 'commit_pushed').length,
    [counts, items],
  );
  // CI-failures pill badge. `counts.ciFailures` is undefined on a stale IndexedDB-persisted
  // response predating the facet, so the page-derived fallback still has to exist.
  const ciFailuresCount = useMemo(
    () => counts?.ciFailures ?? items.filter((i) => isCiFailureKind(i.kind)).length,
    [counts, items],
  );
  // Review-thread DERIVED-state filter (a Set of selected states; empty = all) — a pill row
  // on EVERY feed view, not just the Bots pane. Local (not a store filter). Only
  // thread-bearing items carry a derivedState; a non-thread item (a PR open/merge, a plain
  // comment, a Claude run) drops out whenever any state pill is active.
  const [botStateFilter, setBotStateFilter] = useState<Set<DerivedState>>(() => new Set());
  const toggleBotState = useCallback(
    (s: DerivedState): void => {
      setBotStateFilter((prev) => {
        const next = new Set(prev);
        if (next.has(s)) next.delete(s);
        else next.add(s);
        return next;
      });
      // Mutually exclusive with the Needs-review pill: state pills keep only review_comment
      // items (the only kind carrying derivedState) while Needs-review keeps only
      // pr_opened/ready cards — ANDed they are empty for EVERY dataset, a dead end where both
      // badges promise items the combination can never show.
      if (feedNeedsReview) toggleFeedNeedsReview();
    },
    [feedNeedsReview, toggleFeedNeedsReview],
  );
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
    type Vendor = { actorId: number; label: string; color: string; count: number };
    if (!botsMode) return [] as Vendor[];
    const resolve = (aid: number, count: number): Vendor => {
      const u = usersById.get(aid);
      const tag = automatedTagFor(u, identityByUserId, botColor);
      const label = tag?.label?.trim() ? tag.label : userLabel(u, aid);
      return { actorId: aid, label, color: tag?.color ?? '#6b7280', count };
    };
    // Prefer the server facet (whole loadable stream): the counts + actor set span beyond the
    // loaded page, and the backend ships every byBotActor actor in `users` so labels resolve.
    // Skip an actor we can't label (defensive — shouldn't happen given the backfill).
    if (counts?.byBotActor) {
      const out: Vendor[] = [];
      for (const [key, count] of Object.entries(counts.byBotActor)) {
        const aid = Number(key);
        if (!usersById.has(aid)) continue;
        out.push(resolve(aid, count));
      }
      return out.sort((a, b) => b.count - a.count);
    }
    // Stale-cache fallback: derive from the loaded page (original items-based path).
    const m = new Map<number, Vendor>();
    for (const i of items) {
      const aid = i.actorId;
      if (aid == null) continue;
      const existing = m.get(aid);
      if (existing) {
        existing.count += 1;
        continue;
      }
      m.set(aid, resolve(aid, 1));
    }
    return [...m.values()].sort((a, b) => b.count - a.count);
  }, [botsMode, counts, items, usersById, identityByUserId, botColor]);
  // Per-state counts for the pill badges — independent of the active pills. byThreadState
  // populates server-side for every feed view (thread-bearing items only), so the same row
  // works in and out of botsMode.
  const botStateCounts = useMemo(() => {
    const m = new Map<DerivedState, number>();
    // Prefer the server facet (whole loadable stream); fall back to the loaded page on a stale
    // cache. byThreadState is a DerivedState-keyed object; rehydrate into the consumer's Map.
    if (counts?.byThreadState) {
      for (const [state, n] of Object.entries(counts.byThreadState)) {
        m.set(state as DerivedState, n);
      }
      return m;
    }
    for (const i of items) {
      if (i.derivedState == null) continue;
      m.set(i.derivedState, (m.get(i.derivedState) ?? 0) + 1);
    }
    return m;
  }, [counts, items]);

  // "My Turn only" and "Claude Reviews only" are mutually-exclusive client-side filters (My
  // Turn is CORE / free, so it's always available). The category pills + the bot lens compose
  // ON TOP of them. In botsMode the stream is hard-filtered to bot activity + the derived-state
  // pills instead (the store lens/category/my-turn filters don't apply).
  //
  // ⚠ FACTORED OUT OF THE `visible` MEMO ON PURPOSE, so the auto-insert path can ask the SAME
  // question of a batch that is about to be prepended: how many of these rows actually reach the
  // rendered list? Every step below is a pure per-item predicate, so narrowing an arriving PREFIX
  // on its own gives the same answer as narrowing the whole list and taking its prefix — which is
  // what lets the window shift be exact instead of an estimate (see countHeadArrivals).
  const applyFeedPills = useCallback((list: ConsolidatedFeedItem[]): ConsolidatedFeedItem[] => {
    if (botsMode) {
      // Backend already restricted to automated reviewers; the vendor + state pills compose here
      // (vendor ∧ state — an empty set for a dimension means "all" for that dimension).
      let base = list;
      if (botVendorFilter.size > 0)
        base = base.filter((i) => i.actorId != null && botVendorFilter.has(i.actorId));
      if (botStateFilter.size > 0)
        base = base.filter((i) => i.derivedState != null && botStateFilter.has(i.derivedState));
      // The Needs-review pill lives in the SHARED row below the botsMode early return, so it
      // must be applied here too — not just in the main chain.
      if (feedNeedsReview) base = base.filter(matchesNeedsReview);
      return base;
    }
    const base = feedMyTurnOnly
      ? list.filter((i) => i.isMyTurn)
      : feedClaudeOnly
        ? list.filter((i) => i.kind === 'claude_review')
        : feedCiLens === 'only'
          ? list.filter((i) => isCiFailureKind(i.kind))
          : list;
    // The category pills are SKIPPED under the CI lens' 'only' state. CI rows belong to neither
    // category (that exclusion is deliberate — see catMatch), so composing the two could only
    // ever yield an empty feed, and an empty feed is exactly the "this pill is broken" reading
    // this lens exists to remove.
    const byCat =
      (feedCatComments || feedCatPrEvents) && feedCiLens !== 'only' ? base.filter(catMatch) : base;
    // 'hide' is applied server-side too (excludeBots on the request); the client pass here
    // keeps placeholder pages from the previous key (which still hold bots) consistent while
    // the re-keyed fetch is in flight, and covers any client/server divergence.
    const byLens =
      effectiveBotLens === 'hide'
        ? byCat.filter((i) => !isBotActor(i))
        : effectiveBotLens === 'only'
          ? byCat.filter(isBotActor)
          : byCat;
    // Same rule as botsMode: any active state pill hides items without a derivedState
    // (opens/merges/plain comments/Claude rows carry none).
    const byState =
      botStateFilter.size > 0
        ? byLens.filter((i) => i.derivedState != null && botStateFilter.has(i.derivedState))
        : byLens;
    return feedNeedsReview ? byState.filter(matchesNeedsReview) : byState;
  }, [botsMode, botStateFilter, botVendorFilter, feedMyTurnOnly, feedClaudeOnly, feedCiLens, effectiveBotLens, feedCatComments, feedCatPrEvents, catMatch, isBotActor, feedNeedsReview, matchesNeedsReview]);
  const visible = useMemo(() => applyFeedPills(items), [applyFeedPills, items]);

  // Honest count line: loaded-of-TOTAL (the server's post-cap stream length), never
  // visible-of-loaded — the initial page must not read "50 of 50" when the stream holds
  // more. Active pills prepend the shown count; a server cap (uncappedTotal > total)
  // appends a terse disclosure.
  const countLabel = useMemo(() => {
    const base =
      visible.length !== items.length
        ? `${visible.length} shown · ${items.length} loaded of ${total}`
        : `${items.length} of ${total} loaded`;
    const capped =
      uncappedTotal != null && uncappedTotal > total
        ? ` · ${total} most recent of ${uncappedTotal} in window`
        : '';
    return base + capped;
  }, [visible.length, items.length, total, uncappedTotal]);

  // ── Vertical, variable-height windowing ─────────────────────────────────────────────
  // The feed accumulates unbounded across "Load more" pages, so rendering every card put
  // thousands of nodes in the DOM (every scroll/refetch re-laid them all out). Windowing,
  // VERTICAL + variable-height: measure each row's real height via
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
  // Initial window kept small on purpose: the post-paint rAF `recompute` (below) immediately
  // widens it to the true viewport + FEED_OVERSCAN. A large initial `end` only makes the FIRST
  // synchronous paint mount — and then discard, one frame later — markdown/highlight-heavy cards
  // it never needed, which is the dominant cost of opening the Activity feed / Bots feed. ~12
  // covers a console pane's visible rows; a taller pane fills in on the next frame.
  const [win, setWin] = useState({ start: 0, end: 12, top: 0, bottom: 0 });
  // The live window, readable from the auto-insert callbacks below (which run outside render).
  const winRef = useRef(win);
  winRef.current = win;
  // "The reader is at the top" → credit every live cohort as seen. Held in a ref because the
  // scroll effect below is declared BEFORE the feed's scopeKey exists, and a dep array is
  // evaluated during render (a direct reference would be a temporal-dead-zone throw, not a
  // lint nag). Reassigned every render, so it always closes over the current scope.
  const markSeenRef = useRef<() => void>(() => {});
  // THE READING ANCHOR — the topmost MOUNTED row and where it sits in the viewport, refreshed
  // every time layout settles (the rAF `recompute` below, which runs on scroll/resize/row-growth)
  // and again immediately before the head poll writes. `null` means "do not compensate": either
  // the reader is at the top of the feed (arriving in view is the whole point of dropping the
  // Refresh button) or no row is mounted.
  //
  // ⚠ THIS REF IS WHAT MAKES ONE COMPENSATION MECHANISM COVER BOTH ARRIVAL PATHS. The head poll
  // can hand us a synchronous pre-write moment (`onBeforeInsert`); `SyncStatus.invalidateData()`
  // CANNOT — it sweeps the `['consolidated-feed']` prefix on every sync round and React Query
  // refetches EVERY loaded page, replacing the list with no warning at all. Measuring
  // continuously means the compensation below never has to know which writer ran.
  const anchorRef = useRef<{ id: string; top: number; scrollHeight: number } | null>(null);
  // Compensation OWED: the anchor as measured BEFORE a prepend committed, paid in the layout pass
  // that follows the window shift (the shift moves the anchor again, so a delta read before it
  // would compensate for a layout that is already gone).
  const pendingScrollFixRef = useRef<{
    // The anchor row and its viewport position before the insert — the exact measurement.
    anchorId: string;
    anchorTop: number;
    // Fallback when the anchor unmounts (a batch bigger than the window shifts it out of the
    // slice): the container's total height, whose growth is the height added above.
    scrollHeight: number;
  } | null>(null);
  const captureAnchor = useCallback((): void => {
    const scrollEl = scrollElRef.current;
    if (!scrollEl || feedScrollTop(scrollEl) <= FEED_AT_TOP_PX) {
      // At the head of the feed the new cards SHOULD arrive in view — that is the whole point of
      // dropping the button. Compensation is deliberately skipped there.
      anchorRef.current = null;
      return;
    }
    const rows = visibleRef.current;
    const w = winRef.current;
    for (let i = Math.max(0, w.start); i < Math.min(w.end, rows.length); i++) {
      const el = rowRefs.current.get(rows[i]!.id);
      if (el) {
        anchorRef.current = {
          id: rows[i]!.id,
          top: el.getBoundingClientRect().top,
          scrollHeight: scrollEl.scrollHeight,
        };
        return;
      }
    }
    anchorRef.current = null;
  }, []);

  const recompute = useCallback((): void => {
    rafRef.current = null;
    const scrollEl = scrollElRef.current;
    const listEl = listRef.current;
    if (!scrollEl || !listEl) return;
    // Layout has settled — refresh the anchor while it still describes the list on screen. This
    // is the ONLY pre-commit measurement the sync-round refetch path ever gets.
    captureAnchor();
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
  }, [captureAnchor]);

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
    // The scroll handler also owns the "seen" half of the New-marker contract: SEEN = COHORT +
    // SCROLL POSITION. Sitting at the top of the feed is what credits the cohorts up there as
    // read — there is no per-card observer, by design.
    const onScroll = (): void => {
      if (feedScrollTop(scrollEl) <= FEED_AT_TOP_PX) markSeenRef.current();
      // Refresh the reading anchor HERE, not only in the rAF recompute: a refetch can commit in
      // the same frame as a scroll event, and compensating against a pre-scroll anchor would undo
      // the reader's own scroll. Two rect reads, no writes in between — no forced reflow.
      captureAnchor();
      scheduleRecompute();
    };
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
  }, [scheduleRecompute, captureAnchor, hasItems]);

  // Recompute whenever the visible set changes (filter toggles / new pages).
  useEffect(() => {
    scheduleRecompute();
  }, [visible, scheduleRecompute]);

  // ── Auto-insert + scroll anchoring ──────────────────────────────────────────────────────────
  // New activity is SPLICED INTO the stream as it arrives (the old "↑ New activity — Refresh"
  // banner is gone). The price of that is the one thing a manual button never had to solve:
  //
  //   ⚠ A PREPEND MUST NOT MOVE CONTENT UNDER THE READER'S EYES. `recompute` derives the
  //     viewport position from live rects (`rel`), which a prepend does NOT change — so the same
  //     pixel offset silently resolves to rows N further back, and everything on screen slides
  //     down by the height of what landed.
  //
  // ⚠ AND THERE ARE TWO WRITERS, NOT ONE. The head poll splices (and can announce itself);
  // `SyncStatus.invalidateData()` sweeps the `['consolidated-feed']` prefix on EVERY sync round,
  // which refetches every loaded page of the active infinite query and replaces the list with no
  // callback at all. So compensation is driven by the COMMITTED LIST, not by a writer's callback
  // (the same reason the "New" cohorts are minted by diffing) — see the layout effect below.
  const estRowHeight = useCallback((): number => {
    const heights = heightsRef.current;
    if (heights.size === 0) return FEED_EST_ROW;
    let sum = 0;
    for (const v of heights.values()) sum += v;
    return sum / heights.size;
  }, []);

  // The head poll is about to splice rows into the loaded pages. All this owes is the FRESHEST
  // possible anchor: a batch can land without an intervening scroll event, so the last rAF
  // `recompute` may predate the reader's current position, and this is the final moment the DOM
  // still shows the pre-insert list. The shift + the scroll fix happen in the layout effect.
  const onBeforeInsert = useCallback((): void => {
    captureAnchor();
  }, [captureAnchor]);

  const { scopeKey } = useFeedAutoInsert({
    // MUST match the loaded feed's scope exactly — this writes into that query's cache entry.
    workspaceId,
    repoIds: effectiveRepoIds,
    userIds,
    prId: isolatedPrId,
    excludeBots: !botsMode && effectiveBotLens === 'hide',
    botsOnly: botsMode,
    botWindowDays,
    includeAllCommits: !botsMode && feedShowCommits,
    includeCiFailures: !botsMode && feedCiLens !== 'off',
    enabled: isCrossRepoFeed,
    onBeforeInsert,
  });
  markSeenRef.current = (): void => {
    if (isCrossRepoFeed) markFeedNewCohortsSeen(scopeKey);
  };

  // WHERE THE "NEW" COHORTS ARE MINTED — by diffing the item list, NOT inside the auto-insert.
  //
  // ⚠ AUTO-INSERT IS NOT THE ONLY WAY ROWS REACH THE FEED. `SyncStatus` is mounted in the header
  // on every screen and its `invalidateData()` sweeps the `['consolidated-feed']` prefix on every
  // sync round — which for an active infinite query refetches EVERY loaded page and replaces the
  // list. Minting markers in `onInserted` would leave them missing for the arrivals a reader is
  // most likely to receive, and which path won the race would decide whether a card said "New".
  //
  // ⚠ ONLY THE HEAD PREFIX COUNTS. "Load more" appends 50 OLDER rows the reader deliberately
  // asked for; flagging those as new would light up the entire page they just pulled. So the
  // cohort is the run of ids ABOVE the first already-known one — the same contiguity rule the
  // merge uses — and everything else merely joins the known set.
  //
  // ⚠ A PLACEHOLDER LIST IS NOT THIS SCOPE'S LIST. `placeholderData: (prev) => prev` keeps the
  // PREVIOUS query key's rows on screen while a re-keyed fetch is in flight, and `scopeKey` flips
  // in that same render — so seeding the baseline from them makes the real response's extra head
  // rows look like arrivals. Every WIDENING re-key (bot lens 'hide'→'only'/'all', Commits off→on,
  // CI failures 'off'→'feed'/'only') would then mint a "New" cohort on rows that were merely
  // hidden a moment ago. The baseline must be the first SETTLED list for the scope.
  const knownItemIdsRef = useRef<{ scopeKey: string; ids: Set<string> } | null>(null);
  useEffect(() => {
    if (!isCrossRepoFeed || items.length === 0 || isPlaceholderData) return;
    const known = knownItemIdsRef.current;
    if (known == null || known.scopeKey !== scopeKey) {
      // First settled list for this scope IS the baseline. A freshly-opened feed is all equally
      // new, so marking any of it would just be decoration on the whole screen.
      knownItemIdsRef.current = { scopeKey, ids: new Set(items.map((i) => i.id)) };
      return;
    }
    // `cut < 0` (the two lists share NOTHING — a very long absence, or a server-side window
    // roll) deliberately marks nothing: "every card is new" is not an answer worth a chip on
    // every row, and we cannot tell which of them the reader had already read.
    const cut = items.findIndex((i) => known.ids.has(i.id));
    const fresh = cut > 0 ? items.slice(0, cut).map((i) => i.id) : [];
    for (const i of items) known.ids.add(i.id);
    if (fresh.length === 0) return;
    const scrollEl = scrollElRef.current;
    // ONE arrival = ONE cohort — including the big one collected while the tab was backgrounded
    // (the head poll is visibility-gated, so a whole absence lands as a single refetch).
    pushFeedNewCohort(
      scopeKey,
      fresh,
      scrollEl == null || feedScrollTop(scrollEl) <= FEED_AT_TOP_PX,
    );
  }, [items, isCrossRepoFeed, scopeKey, pushFeedNewCohort, isPlaceholderData]);

  // ── THE ONE SCROLL-COMPENSATION PATH, before paint ──────────────────────────────────────────
  // Driven by the COMMITTED item list rather than by whoever wrote it, because only one of the
  // two writers can announce itself (see the block above `onBeforeInsert`): the head poll splices
  // and calls `onBeforeInsert`, while the sync round's `invalidateData()` refetch replaces the
  // whole list with no hook to hang a measurement on. Diffing the list covers both.
  //
  // TWO PASSES, IN THIS ORDER, and both run before the browser paints (a `useLayoutEffect`
  // setState is flushed synchronously):
  //   1. items changed + the head grew → remember the PRE-insert anchor and shift `win`.
  //   2. re-entered by that `win` change → re-measure the anchor and add the delta to scrollTop.
  // The shift MOVES the anchor, so measuring before it would compensate for a layout that is
  // already gone — hence the hand-off ref rather than one pass.
  const prevFeedRef = useRef<{
    scopeKey: string;
    items: ConsolidatedFeedItem[];
    placeholder: boolean;
  } | null>(null);
  useLayoutEffect(() => {
    // Pass 2 — the window shift has committed; pay what was measured before it.
    const owed = pendingScrollFixRef.current;
    if (owed != null) {
      pendingScrollFixRef.current = null;
      const scrollEl = scrollElRef.current;
      if (scrollEl) {
        const anchorEl = rowRefs.current.get(owed.anchorId);
        // The anchor is exact. If a batch larger than the mounted window shifted it out of the
        // slice, fall back to the container's height growth — right whenever everything that
        // landed is above the reader, which for a head prepend it is.
        const delta = anchorEl
          ? anchorEl.getBoundingClientRect().top - owed.anchorTop
          : scrollEl.scrollHeight - owed.scrollHeight;
        if (Math.abs(delta) > 0.5) feedScrollBy(scrollEl, delta);
        scheduleRecompute();
      }
    }
    // Pass 1 — did the head of the list grow under the reader?
    const prev = prevFeedRef.current;
    prevFeedRef.current = { scopeKey, items, placeholder: isPlaceholderData };
    // Gated to the cross-repo feed with the rest of the feature: the narrowed mounts (per-repo
    // console, the Bots pane, a person's activity tab) are views someone opened on purpose.
    if (!isCrossRepoFeed || prev == null || prev.items === items) return;
    // A re-key is not an arrival, and `placeholderData` shows the PREVIOUS key's rows while the
    // new one loads — neither end of that swap describes the same stream, so nothing may be
    // compensated across it.
    if (prev.scopeKey !== scopeKey || prev.placeholder || isPlaceholderData) return;
    // ⚠ SHIFT BY THE ROWS THAT ACTUALLY REACH `visible`, NOT THE RAW ARRIVAL COUNT. The window
    // indexes `visible`, which the client-side pills (My Turn, Claude-only, CI lens 'only',
    // category, bot lens 'only', thread state, needs-review) narrow. Shifting by the raw count
    // slides the window PAST the anchor: the anchor unmounts, the carried-over `bottom` then
    // double-reserves the rows the window slid past, and the `scrollHeight` fallback yanks the
    // pane by the estimated height of rows that were never rendered — once per poll.
    const added = countHeadArrivals(prev.items, items, applyFeedPills);
    if (added === 0) return; // nothing the reader can see changed
    const anchor = anchorRef.current;
    // No anchor = the reader is at the top of the feed (or nothing is mounted): the new cards
    // SHOULD arrive in view there, and shifting the window would scroll them straight back out.
    if (anchor == null) return;
    pendingScrollFixRef.current = {
      anchorId: anchor.id,
      anchorTop: anchor.top,
      scrollHeight: anchor.scrollHeight,
    };
    // `bottom` is carried over deliberately: `end` moves by exactly the number of rows that
    // entered `visible`, so the rows below the window — and the height reserved for them — are
    // unchanged. Estimate error in `top` is harmless: the same estimate feeds the spacer and the
    // anchor sits below it, so pass 2's measured delta is exact regardless.
    const est = estRowHeight();
    setWin((w) => ({
      start: w.start + added,
      end: w.end + added,
      top: w.top + added * est,
      bottom: w.bottom,
    }));
  }, [
    items,
    win,
    scopeKey,
    isCrossRepoFeed,
    isPlaceholderData,
    applyFeedPills,
    estRowHeight,
    scheduleRecompute,
  ]);

  // The ids currently wearing a "New" marker, flattened from the live cohorts. DERIVED for the
  // render only — never written back (a defensive recompute-and-store would permanently forget a
  // legitimate cohort). Null when there is nothing to mark, so rows get a constant `false`.
  const newItemIds = useMemo((): ReadonlySet<string> | null => {
    if (!isCrossRepoFeed || feedNewCohorts.scopeKey !== scopeKey) return null;
    const out = new Set<string>();
    for (const c of feedNewCohorts.cohorts) for (const id of c.ids) out.add(id);
    return out.size > 0 ? out : null;
  }, [isCrossRepoFeed, feedNewCohorts, scopeKey]);

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

  // Back-from-a-click highlight: when a browser Back returns us to the feed (the popstate
  // handler's `applyUrlTab({ fromPop: true })` promoted the pending return target into the
  // one-shot flashTarget), pin the target into the window, scroll it into view, and flash it
  // once, then consume the signal. Only fires on a real Back. A bounded rAF retry waits for the
  // window to expand + mount the row before scrolling.
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
      // Synthesized kinds are excluded: `focusEventInTab` takes an EventType and matches a
      // TIMELINE MARKER by it, and neither 'claude_review' nor the CI kinds is one — the
      // `as EventType` cast would be a lie that silently asks the timeline to glow a marker
      // that cannot exist. The focus tab itself still opens, which is the useful half.
      if (item.kind !== 'claude_review' && !isCiFailureKind(item.kind)) {
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
      {/* THERE IS NO "New activity — Refresh" BANNER. Newly-arrived items are spliced into the
          stream where they belong (useFeedAutoInsert) and wear a "New" chip until the reader has
          seen them, so nothing is withheld behind a click and nothing sticky sits over the feed.
          (The single-PR "Showing only #N" filter banner lives in the surrounding panel, under its
          summary header — see FeedIsolationBanner.) */}

      {/* The AI repo-summary (digest) collection now lives in the Insights panel — one home
          for every AI summary, with a single unified Refresh. It's no longer atop the Feed. */}

      {/* Cross-repo only: a collapsible panel of the Workspace's open PRs grouped by REPO;
          clicking a PR opens its detail tab. Not in the Bots pane (a pure activity stream). */}
      {repoId == null && !botsMode && userIds == null && isolatedPrId == null && (
        <FeedOpenPrsPanel />
      )}

      {/* Filter pills, two rows. Row 1 branches: the Bots pane gets a per-VENDOR row (one per
          distinct bot, so the in-house bots isolate separately) replacing the normal
          My-Turn/Claude/category/bot-lens pills. Row 2 — the review-thread derived-STATE
          pills — is SHARED by every feed view. Toggling multiple within a row ORs them; the
          rows AND together. */}
      <div className="space-y-2 px-0.5">
        {botsMode ? (
          botVendors.length > 0 && (
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
          )
        ) : (
      <>
      {/* My Turn / Claude filter toggles. My Turn is CORE / free. */}
      <div className="flex flex-wrap items-center gap-2">
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
                ? 'border-ai-signal/50 bg-ai-signal/10 text-ai-signal hover:border-ai-signal'
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
          {prEventsCount > 0 && <span className="tabular-nums opacity-70">{prEventsCount}</span>}
        </button>
        {/* Commits — opt-in (off by default). On: every commit-push run surfaces; off: only the
            pushes that addressed a review thread. A fetch toggle (the server can't be asked for
            plain commits after the fact), not part of the category OR-filter above. */}
        <button
          type="button"
          onClick={toggleFeedShowCommits}
          aria-pressed={feedShowCommits}
          className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
            feedShowCommits
              ? 'border-amber-400 bg-amber-50 text-amber-700 dark:border-amber-500/60 dark:bg-amber-950/30 dark:text-amber-300'
              : 'border-gray-300 text-gray-500 hover:border-gray-400 dark:border-gray-700 dark:text-gray-400'
          }`}
          title="Show individual commit pushes in the feed (off by default) — on surfaces every push run, off keeps only pushes that addressed a review thread"
        >
          <span aria-hidden="true">◆</span> Commits
          {commitsCount > 0 && <span className="tabular-nums opacity-70">{commitsCount}</span>}
        </button>
        {/* CI failures — a THREE-state lens cycling off → feed → only → off, and the one feed
            control that PERSISTS with the filter bar. One card per failed check run, on PR heads
            AND on the default branch.

            'off' IS THE DEFAULT (see FeedCiLens for the two flips this default has had): one
            card per failed check per head is too noisy to be a new user's first impression. The
            pill still renders unconditionally, so the feature is one visible click away — that
            is what makes an off-by-default acceptable here, where an invisible one was not.

            Why three states rather than the include-toggle this shipped as: CI rows are placed
            chronologically, so in a high-traffic workspace the newest one can sit ~23 rows below
            the fold while the pill's count reads 34 — visually identical to a dead control,
            while the SAME code looks perfect in a quiet workspace (index 0). 'only' is the state
            that makes the pill's effect legible regardless of how busy the scope is.

            The fetch half ('off' vs the rest) is server-side and threaded into the query key;
            'only' is a client-side narrowing, like the category pills. */}
        <button
          type="button"
          onClick={cycleFeedCiLens}
          aria-pressed={feedCiLens !== 'off'}
          className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
            feedCiLens === 'only'
              ? 'border-red-500 bg-red-500 text-white dark:border-red-500 dark:bg-red-600 dark:text-white'
              : feedCiLens === 'feed'
                ? 'border-red-400 bg-red-50 text-red-700 dark:border-red-500/60 dark:bg-red-950/30 dark:text-red-300'
                : // The RESTING state now, not a negated one — so no line-through, which read as
                  // "this control is disabled" rather than "click to switch it on".
                  'border-gray-300 text-gray-500 hover:border-gray-400 dark:border-gray-700 dark:text-gray-400'
          }`}
          title={
            feedCiLens === 'feed'
              ? 'CI failures are shown in the feed — click to show ONLY CI failures. One card per failed check run, on pull-request heads and on the default branch. Times are when Limn DETECTED the failure, which can lag the build.'
              : feedCiLens === 'only'
                ? 'Showing ONLY CI failures — click to hide them again'
                : 'CI failures are hidden — click to show them in the feed, then again for CI failures only. One card per failed check run, on pull-request heads and on the default branch.'
          }
        >
          <span aria-hidden="true">⚠</span>
          {feedCiLens === 'only' ? 'CI failures only' : 'CI failures'}
          {ciFailuresCount > 0 && feedCiLens !== 'off' && (
            <span className="tabular-nums opacity-70">{ciFailuresCount}</span>
          )}
        </button>
        {/* Bot lens — Pierre as the calm layer above your review bot. Cycles all → hide → only.
            MUST also render whenever the lens is non-'all': under the server-side 'hide' the
            counts facet is computed over the already-excluded stream, so botCount reads 0
            exactly when hiding is working — and this pill is the only way back to 'all'.
            Hidden when the lens is inert (a bot contributor's own tab renders at an effective
            'all'), where cycling the store lens would visibly do nothing. */}
        {!lensInert && (botCount > 0 || feedBotLens !== 'all') && (
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
      </div>
      </>
        )}
        {/* Review-thread derived-STATE pills + the honest count line — every feed view. */}
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
          {/* PR-level pill — its own labelled group so it doesn't read as a fifth thread
              state. Matches only pr_opened/ready cards whose PR still awaits a first review
              (a live snapshot — the same card can stop matching tomorrow). */}
          <span className="ml-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
            PR
          </span>
          <button
            type="button"
            onClick={() => {
              // Turning this on clears the (provably disjoint) state pills — see toggleBotState.
              if (!feedNeedsReview && botStateFilter.size > 0) setBotStateFilter(new Set());
              toggleFeedNeedsReview();
            }}
            aria-pressed={feedNeedsReview}
            className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
              feedNeedsReview
                ? 'border-indigo-400 bg-indigo-50 text-indigo-700 dark:border-indigo-500/60 dark:bg-indigo-950/30 dark:text-indigo-300'
                : 'border-gray-300 text-gray-500 hover:border-gray-400 dark:border-gray-700 dark:text-gray-400'
            }`}
            title="PRs still awaiting a first review — shows their opened / marked-ready cards · last 14 days"
          >
            Needs review
            {needsReviewCount > 0 && (
              <span className="tabular-nums opacity-70">{needsReviewCount}</span>
            )}
          </button>
          {items.length > 0 && (
            <span className="text-[11px] text-gray-400">{countLabel}</span>
          )}
        </div>
      </div>

      {items.length === 0 ? (
        <div className="flex h-32 items-center justify-center text-sm text-gray-400">
          {botsMode
            ? 'No bot activity yet — automated-reviewer activity across your repos will appear here.'
            : 'Nothing to show yet — activity across your repos will appear here.'}
        </div>
      ) : visible.length === 0 && isPlaceholderData ? (
        // Placeholder pages belong to the PREVIOUS query key. The one transition where that
        // matters here: lens hide→only re-keys the query (excludeBots leaves the search), and
        // the carried-over 'hide' pages contain zero bot rows BY CONSTRUCTION — so until the
        // new fetch lands, "No bot activity in this window" would be a fabricated claim in a
        // window possibly full of it. Say nothing verdict-shaped while the data is borrowed.
        <div className="flex h-32 items-center justify-center text-sm text-gray-400">
          Loading…
        </div>
      ) : visible.length === 0 ? (
        <div className="flex h-32 items-center justify-center text-sm text-gray-400">
          {botsMode
            ? feedNeedsReview
              ? 'No PRs awaiting a first review in this window.'
              : botStateFilter.size > 0
                ? 'No bot activity matches these state filters.'
                : 'No bot activity in this window.'
            : feedNeedsReview
            ? 'No PRs awaiting a first review in this window.'
            : botStateFilter.size > 0
            ? 'Nothing matches these state filters.'
            : feedClaudeOnly
            ? 'No Claude Reviews in this window.'
            : effectiveBotLens === 'only'
              ? 'No bot activity in this window.'
              : effectiveBotLens === 'hide'
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
              identityByUserId={identityByUserId}
              botColor={botColor}
              overridePendingUserId={overridePendingUserId}
              onNotBot={markNotBot}
              isNew={newItemIds?.has(item.id) ?? false}
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
  identityByUserId: Map<number, WorkspaceReviewer>;
  botColor: BotColorFn;
  overridePendingUserId: number | null;
  // (userId, label) — the judgement is keyed to the active WORKSPACE, not to this card's repo, so
  // the row passes the vendor's display name for the confirm copy instead of a repo id.
  onNotBot: (userId: number, label: string) => void;
  // This row arrived while the reader had the feed open, in a cohort they haven't seen yet.
  // Cross-repo feed only — the four narrowed mounts never auto-insert, so it is always false
  // there. ⚠ It renders as a CHIP beside the timestamp, never a border: the card's border is a
  // strict flash → My Turn → Claude → default ladder, and a fifth branch would silently outrank
  // (or be outranked by) a yellow My-Turn card depending on where it was inserted.
  isNew: boolean;
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
  identityByUserId,
  botColor,
  overridePendingUserId,
  onNotBot,
  isNew,
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
    () => automatedTagFor(actorUser, identityByUserId, botColor),
    [actorUser, identityByUserId, botColor],
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
      : // A CI observation has no actor at all — without this it would render the bare
        // 'unknown' fallback, which reads as a data bug rather than "this wasn't a person".
        isCiFailureKind(item.kind)
        ? 'CI'
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
  // A default-branch CI failure is a fact about trunk, but the server names the PR that LANDED
  // the broken commit whenever the sha resolves to one (branch_commits.pr_number) — so the card
  // opens that PR like any other. When it doesn't resolve (a direct push, an unobserved
  // association, an untracked PR) there is genuinely nothing to open: rather than ship a card
  // that visibly does nothing when clicked, it stops LOOKING clickable. Either way it keeps the
  // commit link — that is where a trunk run's checks live — via safeExternalUrl (data-derived).
  const isTrunkCi = item.kind === 'trunk_ci_failed';
  const trunkCommitUrl = isTrunkCi ? safeExternalUrl(item.githubUrl) : undefined;
  const trunkHasNoPr = isTrunkCi && item.prId == null;

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
    // No PR resolved behind this trunk card — see isTrunkCi. Its commit link is the affordance.
    if (trunkHasNoPr) return;
    onOpen(item);
  };

  return (
    <li ref={innerRef} className="pb-2">
      <article
        onClick={onCardClick}
        className={`${trunkHasNoPr ? 'cursor-default' : 'cursor-pointer'} rounded-md border p-2.5 text-sm transition-colors ${
          flash
            ? 'border-sky-400 ring-2 ring-sky-400/60 dark:border-sky-500'
            : isMyTurn
              ? 'border-yellow-400 bg-yellow-50/40 dark:border-yellow-500/50 dark:bg-yellow-950/15'
              : isClaude
                ? 'border-ai-border bg-ai-surface'
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
          {/* Arrived while you had the feed open. Clears once you've been to the top of the
              feed AND more activity has landed behind it — see FeedNewCohorts. */}
          {isNew && (
            <span
              className="shrink-0 rounded-full bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-600 dark:text-sky-300"
              title="Arrived since you last looked at the top of the feed"
            >
              New
            </span>
          )}
          <span
            className="shrink-0 text-[11px] text-gray-400"
            title={dateTime(item.occurredAt)}
          >
            {relativeTime(item.occurredAt)}
          </span>
          <Avatar user={actorUser} size={20} />
          {/* A real actor's name opens the user popover (stats + activity tab); the synthetic
              labels ('Claude', 'A contributor') have no user behind them and stay plain text. */}
          {actorUser != null && !isClaude ? (
            <span className="truncate font-medium text-gray-800 dark:text-gray-100">
              <UserName
                user={actorUser}
                fallbackId={item.actorId}
                repoId={item.repoId ?? undefined}
              />
            </span>
          ) : (
            <span className="truncate font-medium text-gray-800 dark:text-gray-100">
              {actorName}
            </span>
          )}
          {automatedTag && (
            <span className="group/bot inline-flex shrink-0 items-center gap-1">
              <span
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium"
                style={{ color: automatedTag.color, background: `${automatedTag.color}1a` }}
                title={`${automatedTag.label} — an automated reviewer Limn triages`}
              >
                <span aria-hidden>🤖</span>
                {automatedTag.label}
              </span>
              {automatedTag.userId != null && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (automatedTag.userId != null)
                      onNotBot(automatedTag.userId, automatedTag.label);
                  }}
                  disabled={overridePending}
                  className="text-[9px] text-gray-400 underline underline-offset-2 opacity-0 transition-opacity hover:text-gray-600 disabled:opacity-40 group-hover/bot:opacity-100 dark:hover:text-gray-200"
                  title="Not a bot? Stop treating this reviewer as automated ACROSS THIS WHOLE WORKSPACE — every repo in it, not just this PR's. It keeps its vendor name, other Workspaces are unaffected, and you'll be asked to confirm."
                >
                  {overridePending ? 'saving…' : 'not a bot?'}
                </button>
              )}
            </span>
          )}
          <span
            className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${glyph.className ?? ''}`}
            style={glyph.className ? undefined : { color: glyph.color, background: glyph.color + '1a' }}
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
          {/* On a trunk card the PR is not what failed — it is what PUT the broken commit on
              trunk — so it is labelled. "landed by" only when the PR actually merged:
              pickAssociatedPrNumber falls back to an OPEN associated PR when that is the only
              candidate, and claiming that one landed anything would be a plain lie. */}
          {isTrunkCi && prLabel !== '' && (
            <span className="shrink-0 text-gray-400">
              · {item.prState === 'merged' ? 'landed by' : 'from'}
            </span>
          )}
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
          {/* Always on a trunk card — the commit page is where a trunk run's checks live, and
              when no PR resolved it is the card's ONLY affordance. Data-derived href, so it
              goes through safeExternalUrl — React happily renders a `javascript:` URL. */}
          {trunkCommitUrl != null && (
            <a
              href={trunkCommitUrl}
              target="_blank"
              rel="noreferrer noopener"
              onClick={(e) => e.stopPropagation()}
              className="shrink-0 font-medium text-sky-600 hover:underline dark:text-sky-400"
            >
              commit {(item.ciHeadSha ?? '').slice(0, 7)} ↗
            </a>
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

        {/* what changed: a commit push → the "pushed N commits" summary (always, so a plain
            push under "show commits" isn't a bare card), and when it addressed review threads,
            those threads inline so the reader sees the change without opening the PR. */}
        {(item.changeSummary != null || affected.length > 0) && (
          <div className="mt-1.5 space-y-1.5">
            {item.changeSummary != null && (
              <div className="text-[11px] font-medium text-gray-500 dark:text-gray-400">
                {item.changeSummary}
              </div>
            )}
            {affected.length > 0 && (
              <AffectedThreadsList
                affected={affected}
                usersById={usersById}
                onOpenThread={(tid) => onOpenThread(item, tid)}
              />
            )}
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
            prefilled with the original quoted + its author @mentioned — and (Pro, prSummary)
            "Check review"-ed inline, same target as PrDetail's per-comment mount. Both AI
            pieces read the ONE shared per-PR annotations index (no per-card requests), and
            the outcome span next to the button MUST stay visible — it carries the one-run
            429 message, without which a second click mid-run looks like it did nothing. */}
        {isPrCommentCard && item.prId != null && (
          <div className="mt-1.5">
            {!replyOpen ? (
              <div className="flex items-center gap-3">
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
                {item.commentId != null && (
                  <ReviewCheckButton
                    prId={item.prId}
                    target={{ targetKind: 'pr_comment', targetId: item.commentId }}
                  />
                )}
              </div>
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
            {/* Stored judgements for this comment, under the body they judge (renders nothing
                and requests nothing when the comment has none). The card is a clickable
                region, so interacting with a panel must not open the tab. */}
            {item.commentId != null && (
              <div className="cursor-default" onClick={(e) => e.stopPropagation()}>
                <CommentAnnotations
                  prId={item.prId}
                  targetKind="pr_comment"
                  targetId={item.commentId}
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
    // ⚠ THE COMPARATOR IS AN ALLOW-LIST. A prop missing from it does not re-render the row when
    // it flips — `isNew` would appear or clear only when something unrelated happened to change.
    a.isNew === b.isNew &&
    a.flash === b.flash &&
    a.expanded === b.expanded &&
    a.replyOpen === b.replyOpen &&
    a.overridePendingUserId === b.overridePendingUserId &&
    a.usersById === b.usersById &&
    a.identityByUserId === b.identityByUserId &&
    a.botColor === b.botColor &&
    a.onOpen === b.onOpen &&
    a.onOpenThread === b.onOpenThread &&
    a.onFocus === b.onFocus &&
    a.onNotBot === b.onNotBot &&
    a.onToggleExpanded === b.onToggleExpanded &&
    a.onSetReplyOpen === b.onSetReplyOpen &&
    a.innerRef === b.innerRef,
);
