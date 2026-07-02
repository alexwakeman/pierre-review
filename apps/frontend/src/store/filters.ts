import { create } from 'zustand';
import { usePinnedTabs } from './pinnedTabs.js';
import {
  EVENT_CATEGORY_BY_TYPE,
  PR_STATUSES,
  REVIEW_FILTER_STATES,
  type DerivedState,
  type EventCategory,
  type EventType,
  type PrStatus,
  type ReviewState,
} from '@pierre-review/shared';

export type RangePreset = '7d' | '14d' | '30d' | '90d' | 'custom';

export type StripFilter = 'all' | 'my_turn' | 'needs_attention';

// The user-facing event-CATEGORY toggles (Events panel). Two categories are NOT
// here, by design:
//  • 'lifecycle' (PR opened/merged/closed/…) — its events draw no markers (they're
//    implicit in each PR bar), so the toggle was a no-op.
//  • 'reviews' (review_submitted) — replaced by the finer per-verdict toggles
//    (ALL_REVIEW_STATES: approved / changes_requested / commented / dismissed),
//    filtered server-side via the `reviewStates` param.
// Both still FLOW — categoriesToTypes always includes their event types — so
// contributor rows / activity-feed jumps are unaffected; the review verdict filter
// then narrows the review markers. Re-add either here to restore a coarse toggle.
export const ALL_CATEGORIES: EventCategory[] = [
  'review_comments',
  'pr_comments',
  'commits',
];

// Categories shown on a fresh load. Commits are noisy, so they start hidden —
// the user can toggle them on, and that choice round-trips through the URL (see
// useUrlState). This is the baseline the URL serializer diffs against.
export const DEFAULT_CATEGORIES: EventCategory[] = ALL_CATEGORIES.filter(
  (c) => c !== 'commits',
);

export const ALL_PR_STATUSES: PrStatus[] = PR_STATUSES;

// The review verdicts shown in the Events panel (approved / changes_requested /
// commented / dismissed). All four are shown on a fresh load — a review-verdict
// filter is opt-in, so the default selects everything and the URL stays clean.
export const ALL_REVIEW_STATES: ReviewState[] = REVIEW_FILTER_STATES;
export const DEFAULT_REVIEW_STATES: ReviewState[] = [...ALL_REVIEW_STATES];

// PR statuses shown on a fresh load. Closed PRs are noise for most situational-
// awareness views, so they start hidden; the choice round-trips through the URL.
export const DEFAULT_PR_STATUSES: PrStatus[] = ALL_PR_STATUSES.filter(
  (s) => s !== 'closed',
);

const DAY_MS = 24 * 60 * 60 * 1000;
// The backfill horizon — the furthest back the timeline holds any data, and the cap
// on the My Turn Focus Mode range extension (see myTurnFromMs / resolveRange).
export const MAX_RANGE_DAYS = 90;
const PRESET_DAYS: Record<Exclude<RangePreset, 'custom'>, number> = {
  '7d': 7,
  '14d': 14,
  '30d': 30,
  '90d': 90,
};

export interface FilterState {
  // null = "all" (no explicit selection yet)
  repoIds: number[] | null;
  userIds: number[] | null;
  excludeBots: boolean;
  // Bots to KEEP visible even when excludeBots is on — the per-repo "important bots"
  // allow-list (checked in the Members dropdown's Bots sections). A persisted filter:
  // round-trips through the URL (allowBots=…) and saved views, and only bites when
  // excludeBots is true. Empty → exclude every bot (the historical behaviour).
  allowedBotIds: number[];
  // Hide "stale" open PRs: open PRs with no commits/comments/reviews inside the
  // active range. A server-side timeline filter (drops the PRs and their events).
  excludeStale: boolean;
  preset: RangePreset;
  customFrom: string | null; // ISO date (yyyy-mm-dd)
  customTo: string | null;
  categories: EventCategory[];
  prStatuses: PrStatus[]; // which PR statuses are shown (empty = none)
  // Which review verdicts show as markers (review_submitted events). All four by
  // default; an empty set hides every review marker. Only affects review markers.
  reviewStates: ReviewState[];
  derivedStates: DerivedState[]; // empty = no derived-state filtering
  // Activity "Feed" scope toggle: when true, the consolidated Feed shows only "My Turn"
  // actionables. A TRANSIENT flag owned by the Activity lane (not a persisted filter, not
  // URL-synced) — present in freshDefaults() but NOT in FilterDefaults /
  // pickFilterBarState / sanitizePersistedFilters, so a fresh load starts false.
  feedMyTurnOnly: boolean;
  // Activity "Feed" scope toggle: when true, the consolidated Feed shows only Claude
  // Review items. Transient (like feedMyTurnOnly) — owned by the Activity lane, not a
  // persisted filter, not URL-synced. Mutually exclusive with feedMyTurnOnly.
  feedClaudeOnly: boolean;

  // selection
  selectedPrId: number | null;
  selectedThreadId: number | null;
  // A specific issue-level PR comment selected from the timeline popover's "Open in
  // detail pane". Drives a PERMANENT amber highlight on that comment card (mirroring
  // selectedThreadId's thread highlight); cleared when another thread/comment/PR is
  // selected. Distinct from the transient `commentFocus` signal, which only scrolls
  // + flashes the card once.
  selectedCommentId: number | null;

  // transient: a timeline → PR-detail deep link that opens the Activity tab and
  // scrolls to a specific entry (e.g. the commit popover's "View in Activity").
  // Matched against the loaded PR by `prId`; cleared by PrDetail after it scrolls.
  activityFocus: { prId: number; type: EventType; refId: number | null } | null;

  // transient: a timeline → PR-detail deep link that opens the Overview tab and
  // scrolls to + flashes a specific issue-level PR comment (the pr_comment
  // marker's "Open in detail pane"). Matched against the loaded PR by `prId`;
  // cleared by PrCommentsList once it scrolls.
  commentFocus: { prId: number; commentId: number } | null;

  // transient: the Claude-review progress banner → open a PR's Claude Review tab.
  // Matched against the loaded PR by `prId`; cleared by PrDetail once it switches.
  claudeTabFocus: { prId: number } | null;

  // open PRs strip
  stripCollapsed: boolean;
  stripFilter: StripFilter;

  // Activity tab (the master-detail triage console). Which detail is shown:
  // 'feed' = the cross-repo consolidated Feed (the default landing detail), a number =
  // that single repo's console, null = nothing selected yet (treated as 'feed'). Client-
  // side narrow, no refetch. (The old 'all' briefing-feed pseudo-row was removed — it was
  // redundant with the Feed + per-repo entries.) Transient (mirrors myTurnOnly/
  // insightsOpen): in freshDefaults() but NOT in pickFilterBarState /
  // sanitizePersistedFilters. `?activityRepo=<id>` is the only URL mirror (see useUrlState);
  // the active TAB lives in the pinnedTabs store.
  activityRepoId: number | 'feed' | null;
  // Soft thread-state filter inside an Activity repo console: clicking a thread-state
  // segment narrows the PRs-by-author list to PRs carrying that derived state.
  // null = no filter. Transient, URL-silent.
  activityThreadFilter: DerivedState | null;

  // PR-title search box (App.tsx). Sticky: persists across input blur and PR
  // selection so re-focusing re-shows the same results. Store-only (NOT URL-synced
  // — transient per-session intent; keeps shared URLs clean). Client-side filter
  // over loaded timeline/open-PR data, so it never feeds buildTimelineSearch.
  searchQuery: string;

  // file groups + diff hunks (PR detail thread view)
  expandedFileGroups: string[]; // paths explicitly toggled by the user
  collapsedFileGroups: string[]; // paths explicitly collapsed by the user
  expandedDiffHunks: number[]; // thread ids with the full hunk shown

  // transient: request the timeline to scroll/focus a PR (cleared after use)
  timelineFocusPr: number | null;
  // optional instant to recenter on (e.g. a clicked event's time) so focusing a
  // long-running PR doesn't jump to its far-off midpoint
  timelineFocusAt: string | null;
  // optional specific event marker to glow once the timeline recenters, resolved
  // against the loaded timeline events by (type, refId). null = recenter only.
  timelineFocusEvent: { type: EventType; refId: number | null } | null;
  // transient: request the timeline to recenter its window on a given instant
  // (epoch ms) keeping the current zoom width — drives the "Now" button. Store-
  // only (NOT URL-synced); cleared after the Timeline consumes it.
  timelineCenterAt: number | null;

  // `rangeResetSignal`: a monotonic counter bumped on every range-preset click
  // (even re-selecting the already-active preset). The Timeline watches it to
  // re-apply the preset's window — so clicking "14d" again snaps the view back to
  // the last 14 days after you've panned/zoomed away. A counter (not derived from
  // `preset`) so a same-value re-click still fires.
  rangeResetSignal: number;
  // `syncModalSignal`: a monotonic counter bumped when a freshly-added repo should
  // surface the sync-progress modal (so the user sees the initial backfill is
  // underway and may take a while). SyncStatus watches it, opens the modal and
  // starts polling. Store-only / transient (NOT URL-synced).
  syncModalSignal: number;
  // The repo id carried by the latest `requestSyncModal` — the just-added repo, so
  // the add-flow modal can scope itself to ONLY that repo (a concurrent scheduled
  // sync of the OTHER repos would otherwise bounce their progress bars). Read
  // alongside syncModalSignal.
  syncModalRepoId: number | null;
  // `claudeReviewKickoff`: a monotonic counter bumped when the user starts a Claude
  // review, so the global progress banner knows a run is in flight and begins
  // polling (and stops once the active list drains). Store-only / transient.
  claudeReviewKickoff: number;

  setRepoIds: (ids: number[] | null) => void;
  toggleRepo: (id: number) => void;
  // Make a repo visible WITHOUT clearing an active filter: a no-op when all repos
  // are already shown (repoIds == null) or the id is already in the visible set,
  // otherwise it appends. Used by the add-repo flow so a freshly-added repo isn't
  // hidden when a repo filter is active (the repos-list refetch reconciles).
  showRepo: (id: number) => void;
  setUserIds: (ids: number[] | null) => void;
  setExcludeBots: (v: boolean) => void;
  // Set/toggle the per-repo "allowed bots" list (bots kept visible under excludeBots).
  setAllowedBotIds: (ids: number[]) => void;
  toggleAllowedBot: (id: number) => void;
  setExcludeStale: (v: boolean) => void;
  setPreset: (p: RangePreset) => void;
  setCustomRange: (from: string | null, to: string | null) => void;
  toggleCategory: (c: EventCategory) => void;
  setCategories: (c: EventCategory[]) => void;
  togglePrStatus: (s: PrStatus) => void;
  setPrStatuses: (s: PrStatus[]) => void;
  toggleReviewState: (s: ReviewState) => void;
  setReviewStates: (s: ReviewState[]) => void;
  toggleDerivedState: (s: DerivedState) => void;
  setDerivedStates: (s: DerivedState[]) => void;
  // Toggle / set the Activity "Feed" My-Turn-only scope (see feedMyTurnOnly). Toggling
  // it on clears feedClaudeOnly (the two pills are mutually exclusive).
  toggleFeedMyTurnOnly: () => void;
  setFeedMyTurnOnly: (v: boolean) => void;
  // Toggle / set the Activity "Feed" Claude-Reviews-only scope (see feedClaudeOnly).
  // Toggling it on clears feedMyTurnOnly.
  toggleFeedClaudeOnly: () => void;
  setFeedClaudeOnly: (v: boolean) => void;
  selectPr: (id: number | null) => void;
  selectThread: (prId: number | null, threadId: number | null) => void;
  clearSelection: () => void;
  // Open a PR from the strip / my-turn / a timeline event: select it AND ask
  // the timeline to scroll to it (optionally recentering on `focusAt`). Pass `event`
  // to also glow a specific marker once the timeline recenters (e.g. a thread's
  // review_comment marker, resolved by (type, refId)) — like a "Show" link, but it
  // also records the thread/PR selection for the detail pane.
  openPrFocused: (
    id: number,
    threadId?: number | null,
    focusAt?: string | null,
    event?: { type: EventType; refId: number | null } | null,
  ) => void;
  // Show a specific activity entry on the timeline: keep its PR selected, recenter
  // on the event's instant, and glow the matching marker.
  showEventOnTimeline: (
    prId: number,
    focusAt: string,
    event: { type: EventType; refId: number | null },
  ) => void;
  // Highlight a specific event WITHIN a PR-focus tab (the thread/comment magnifier flow):
  // set the PR (and optional thread) selection + the timeline focus signals so the
  // just-opened isolate tab centres + glows the event's marker after it boots. Unlike
  // showEventOnTimeline it does NOT touch the active tab — the caller opens the pr-focus
  // tab first (openPrFocusTab), and this drives the isolate instance's focus consumer.
  focusEventInTab: (
    prId: number,
    focusAt: string,
    event: { type: EventType; refId: number | null },
    threadId?: number | null,
  ) => void;
  consumeTimelineFocus: () => void;
  // Recenter the timeline window on the current instant ("Now"); the Timeline
  // consumes the signal and clears it.
  centerTimelineNow: () => void;
  consumeTimelineCenter: () => void;
  // Open the selected PR's Activity tab scrolled to a specific entry (timeline
  // commit popover → PR Activity). PrDetail consumes it once it has scrolled.
  showActivityEntry: (
    prId: number,
    event: { type: EventType; refId: number | null },
  ) => void;
  consumeActivityFocus: () => void;
  // Open the selected PR's Overview tab scrolled to a specific issue-level PR
  // comment (timeline pr_comment popover → "Open in detail pane"). PrCommentsList
  // consumes it once it has scrolled to + flashed the card.
  showPrComment: (prId: number, commentId: number) => void;
  consumeCommentFocus: () => void;
  // Open a PR's Claude Review tab (the global progress banner → a running/finished
  // review). PrDetail consumes it once it has switched tabs.
  openClaudeReview: (prId: number) => void;
  consumeClaudeTabFocus: () => void;
  // Ask SyncStatus to pop the sync-progress modal (used right after adding a repo
  // so the initial backfill's load time is visible). Bumps syncModalSignal and
  // records the added repo id so the modal can scope to just that repo.
  requestSyncModal: (repoId: number) => void;
  bumpClaudeReviewKickoff: () => void;
  setStripCollapsed: (v: boolean) => void;
  setStripFilter: (f: StripFilter) => void;
  // Select an Activity detail target (a repo id, or 'feed' for the cross-repo consolidated
  // Feed).
  setActivityRepo: (id: number | 'feed') => void;
  // Set/clear the Activity repo console's soft thread-state filter (toggles off when
  // the same state is re-selected).
  setActivityThreadFilter: (s: DerivedState | null) => void;
  setSearchQuery: (q: string) => void;
  toggleFileGroup: (path: string, defaultExpanded: boolean) => void;
  toggleDiffHunk: (threadId: number) => void;
  // Reset every user-set FILTER (repos, members, range, categories, PR statuses,
  // derived states, search, excludeBots, excludeStale, strip filter) back to its
  // fresh-load default. Selection and focus state are deliberately left intact —
  // "Clear filters" only clears filters, it doesn't deselect the PR or exit focus.
  // The filter defaults mirror freshFilterDefaults() so useUrlState's diff-against-
  // defaults drops those params from the URL. (The FilterBar disables this while a
  // focus overlay is active, so it never runs mid-focus.)
  resetAllFilters: () => void;
  hydrate: (partial: Partial<FilterState>) => void;
}

function toggle<T>(arr: T[], value: T): T[] {
  return arr.includes(value) ? arr.filter((x) => x !== value) : [...arr, value];
}

// Every non-action piece of state. freshDefaults() restores exactly these keys.
type FilterData = Omit<
  FilterState,
  {
    [K in keyof FilterState]: FilterState[K] extends (...args: never[]) => unknown
      ? K
      : never;
  }[keyof FilterState]
>;

// The user-set FILTERS — exactly what "Clear all" (resetAllFilters) resets.
// Selection, focus, transient signals and detail-view state are NOT here: Clear
// all leaves them alone. These values are what useUrlState diffs against, so a
// reset drops the filter params from the URL.
type FilterDefaults = Pick<
  FilterState,
  | 'repoIds'
  | 'userIds'
  | 'excludeBots'
  | 'allowedBotIds'
  | 'excludeStale'
  | 'preset'
  | 'customFrom'
  | 'customTo'
  | 'categories'
  | 'prStatuses'
  | 'reviewStates'
  | 'derivedStates'
  | 'searchQuery'
  | 'stripFilter'
>;

// Single source of truth for the filter defaults; array defaults are rebuilt per
// call so callers never share a mutable reference.
function freshFilterDefaults(): FilterDefaults {
  return {
    repoIds: null,
    userIds: null,
    // Bots are SHOWN on a fresh load (default OFF); the user can hide them via the
    // Members dropdown, and that non-default choice round-trips as bots=1 (see
    // useUrlState). This is the baseline the URL serializer diffs against.
    excludeBots: false,
    // No bots allow-listed on a fresh load — round-trips as allowBots=… when non-empty.
    allowedBotIds: [],
    // Stale open PRs (no commit/comment/review in the active range) are clutter for
    // situational awareness, so they're HIDDEN on a fresh load. This is the baseline
    // the URL serializer diffs against; turning the filter off round-trips as stale=0.
    excludeStale: true,
    preset: '14d',
    customFrom: null,
    customTo: null,
    categories: [...DEFAULT_CATEGORIES],
    prStatuses: [...DEFAULT_PR_STATUSES],
    reviewStates: [...DEFAULT_REVIEW_STATES],
    derivedStates: [],
    searchQuery: '',
    stripFilter: 'all',
  };
}

// The filter-bar subset of the current state, for persisting to localStorage so a
// fresh tab (no URL params) restores the user's last filters. EXACTLY the fields
// the URL also encodes — selection / focus / transient state is deliberately left
// out. Mirrors freshFilterDefaults() / FilterDefaults so persistence and the URL
// serializer stay in lockstep. See hooks/useUrlState.
export function pickFilterBarState(s: FilterState): FilterDefaults {
  return {
    repoIds: s.repoIds,
    userIds: s.userIds,
    excludeBots: s.excludeBots,
    allowedBotIds: s.allowedBotIds,
    excludeStale: s.excludeStale,
    preset: s.preset,
    customFrom: s.customFrom,
    customTo: s.customTo,
    categories: s.categories,
    prStatuses: s.prStatuses,
    reviewStates: s.reviewStates,
    derivedStates: s.derivedStates,
    searchQuery: s.searchQuery,
    stripFilter: s.stripFilter,
  };
}

// Restore an UNTRUSTED persisted blob (old localStorage / a saved view) down to the
// known persisted filter-bar keys, dropping everything else. Critically this drops a
// LEGACY persisted `myTurnOnly` — older builds persisted it as a filter, but it's now
// a TRANSIENT focus mode, so blindly re-hydrating it would silently re-enter My Turn
// Focus Mode on load / on applying an old view (a fresh load must be the full board).
// New writes never include such keys (pickFilterBarState), but blobs written by an
// older build can. Whitelisting against freshFilterDefaults() also future-proofs this.
export function sanitizePersistedFilters(
  raw: Partial<FilterState>,
): Partial<FilterDefaults> {
  const allowed = freshFilterDefaults();
  const out: Partial<FilterDefaults> = {};
  for (const key of Object.keys(allowed) as (keyof FilterDefaults)[]) {
    if (key in raw && raw[key] !== undefined) {
      (out as Record<string, unknown>)[key] = raw[key];
    }
  }
  return out;
}

// Order-insensitive set equality. Two nullable arrays are equal iff both null or the
// same elements regardless of order (null = "all"/unset, distinct from an empty []).
function setEqual<T>(a: readonly T[] | null, b: readonly T[] | null): boolean {
  if (a == null || b == null) return a === b;
  if (a.length !== b.length) return false;
  const set = new Set<T>(a);
  return b.every((v) => set.has(v));
}

// Whether a saved view's snapshot (any persisted blob) matches the CURRENT filter
// bar — the basis for the "active view" label. Normalizes the saved state through
// sanitize + defaults so an older/partial blob compares against the same field set,
// and treats the array filters as order-insensitive SETS (repoIds/userIds as
// nullable number sets). Self-correcting: any manual filter edit stops matching, so
// the label clears.
export function savedViewMatchesCurrent(
  savedState: Partial<FilterState>,
  current: FilterDefaults,
): boolean {
  const a: FilterDefaults = {
    ...freshFilterDefaults(),
    ...sanitizePersistedFilters(savedState),
  };
  return (
    setEqual(a.repoIds, current.repoIds) &&
    setEqual(a.userIds, current.userIds) &&
    a.excludeBots === current.excludeBots &&
    setEqual(a.allowedBotIds, current.allowedBotIds) &&
    a.excludeStale === current.excludeStale &&
    a.preset === current.preset &&
    // customFrom/customTo only affect the board when preset === 'custom'; a non-custom
    // preset ignores any lingering dates (they aren't cleared on preset change). Gate
    // the comparison on preset so two identical-rendering states still match — mirrors
    // the URL serializer (useUrlState only emits the dates when preset === 'custom').
    (a.preset !== 'custom' ||
      (a.customFrom === current.customFrom && a.customTo === current.customTo)) &&
    setEqual(a.categories, current.categories) &&
    setEqual(a.prStatuses, current.prStatuses) &&
    setEqual(a.reviewStates, current.reviewStates) &&
    setEqual(a.derivedStates, current.derivedStates) &&
    a.searchQuery === current.searchQuery &&
    a.stripFilter === current.stripFilter
  );
}

// The fresh-load defaults for every (non-action) piece of state: the filters above
// plus selection, transient signals and detail-view state. Used for the initial
// store. (resetAllFilters resets only the filter subset.)
function freshDefaults(): FilterData {
  return {
    ...freshFilterDefaults(),
    // Transient Activity "Feed" scope toggles (not persisted filters): fresh load = false.
    feedMyTurnOnly: false,
    feedClaudeOnly: false,
    selectedPrId: null,
    selectedThreadId: null,
    selectedCommentId: null,
    activityFocus: null,
    commentFocus: null,
    claudeTabFocus: null,
    stripCollapsed: true, // strip starts collapsed for more timeline room
    // Activity detail state — transient (like myTurnOnly / insightsOpen). A fresh open
    // lands on the cross-repo consolidated Feed (the relevance-ranked state of play)
    // with no thread-state filter.
    activityRepoId: 'feed',
    activityThreadFilter: null,
    expandedFileGroups: [],
    collapsedFileGroups: [],
    expandedDiffHunks: [],
    timelineFocusPr: null,
    timelineFocusAt: null,
    timelineFocusEvent: null,
    timelineCenterAt: null,
    rangeResetSignal: 0,
    syncModalSignal: 0,
    syncModalRepoId: null,
    claudeReviewKickoff: 0,
  };
}

export const useFilters = create<FilterState>((set, get) => ({
  ...freshDefaults(),

  setRepoIds: (ids) => set({ repoIds: ids }),
  toggleRepo: (id) =>
    set((s) => ({ repoIds: toggle(s.repoIds ?? [], id) })),
  showRepo: (id) => {
    const { repoIds } = get();
    if (repoIds == null || repoIds.includes(id)) return; // already visible
    set({ repoIds: [...repoIds, id] });
  },
  setUserIds: (ids) => set({ userIds: ids }),
  setExcludeBots: (v) => set({ excludeBots: v }),
  setAllowedBotIds: (ids) => set({ allowedBotIds: ids }),
  toggleAllowedBot: (id) => set((s) => ({ allowedBotIds: toggle(s.allowedBotIds, id) })),
  setExcludeStale: (v) => set({ excludeStale: v }),
  setPreset: (p) =>
    // Bump rangeResetSignal so the Timeline re-applies the window even when the
    // preset is unchanged (re-clicking the active preset resets the view).
    set((s) => ({ preset: p, rangeResetSignal: s.rangeResetSignal + 1 })),
  setCustomRange: (from, to) =>
    set({ preset: 'custom', customFrom: from, customTo: to }),
  toggleCategory: (c) => set((s) => ({ categories: toggle(s.categories, c) })),
  setCategories: (c) => set({ categories: c }),
  togglePrStatus: (st) => set((s) => ({ prStatuses: toggle(s.prStatuses, st) })),
  setPrStatuses: (s) => set({ prStatuses: s }),
  toggleReviewState: (st) =>
    set((s) => ({ reviewStates: toggle(s.reviewStates, st) })),
  setReviewStates: (st) => set({ reviewStates: st }),
  toggleDerivedState: (st) =>
    set((s) => ({ derivedStates: toggle(s.derivedStates, st) })),
  setDerivedStates: (st) => set({ derivedStates: st }),
  toggleFeedMyTurnOnly: () =>
    set((s) => ({ feedMyTurnOnly: !s.feedMyTurnOnly, feedClaudeOnly: false })),
  setFeedMyTurnOnly: (v) =>
    set(v ? { feedMyTurnOnly: true, feedClaudeOnly: false } : { feedMyTurnOnly: false }),
  toggleFeedClaudeOnly: () =>
    set((s) => ({ feedClaudeOnly: !s.feedClaudeOnly, feedMyTurnOnly: false })),
  setFeedClaudeOnly: (v) =>
    set(v ? { feedClaudeOnly: true, feedMyTurnOnly: false } : { feedClaudeOnly: false }),
  selectPr: (id) =>
    set({
      selectedPrId: id,
      selectedThreadId: null,
      selectedCommentId: null,
    }),
  selectThread: (prId, threadId) =>
    set((s) => ({
      selectedPrId: prId ?? s.selectedPrId,
      selectedThreadId: threadId,
      selectedCommentId: null,
    })),
  clearSelection: () =>
    set({
      selectedPrId: null,
      selectedThreadId: null,
      selectedCommentId: null,
    }),
  openPrFocused: (id, threadId = null, focusAt = null, event = null) => {
    // Any timeline navigation leaves an open focus/PR tab so the move is visible on the
    // shared board (no-op when the board is already showing — the common case). When the
    // move is launched FROM an Activity-opened detail tab (the repurposed PR-title "Show"),
    // this pushes a back-step so browser Back returns to that detail tab first.
    usePinnedTabs.getState().showBoardFromDetail();
    set({
      selectedPrId: id,
      selectedThreadId: threadId,
      selectedCommentId: null,
      timelineFocusPr: id,
      timelineFocusAt: focusAt,
      timelineFocusEvent: event,
    });
  },
  showEventOnTimeline: (prId, focusAt, event) => {
    usePinnedTabs.getState().showBoardFromDetail();
    set({
      selectedPrId: prId,
      timelineFocusPr: prId,
      timelineFocusAt: focusAt,
      timelineFocusEvent: event,
    });
  },
  focusEventInTab: (prId, focusAt, event, threadId = null) =>
    set({
      selectedPrId: prId,
      selectedThreadId: threadId,
      selectedCommentId: null,
      timelineFocusPr: prId,
      timelineFocusAt: focusAt,
      timelineFocusEvent: event,
    }),
  consumeTimelineFocus: () =>
    set({
      timelineFocusPr: null,
      timelineFocusAt: null,
      timelineFocusEvent: null,
    }),
  centerTimelineNow: () => {
    usePinnedTabs.getState().showTimeline();
    set({ timelineCenterAt: Date.now() });
  },
  consumeTimelineCenter: () => set({ timelineCenterAt: null }),
  showActivityEntry: (prId, event) =>
    set({
      selectedPrId: prId,
      selectedThreadId: null,
      selectedCommentId: null,
      activityFocus: { prId, ...event },
    }),
  consumeActivityFocus: () => set({ activityFocus: null }),
  // Select the comment (permanent amber highlight) AND fire the transient scroll/
  // flash signal — the highlight persists, the flash plays once.
  showPrComment: (prId, commentId) =>
    set({
      selectedPrId: prId,
      selectedThreadId: null,
      selectedCommentId: commentId,
      commentFocus: { prId, commentId },
    }),
  consumeCommentFocus: () => set({ commentFocus: null }),
  openClaudeReview: (prId) =>
    set({
      selectedPrId: prId,
      selectedThreadId: null,
      selectedCommentId: null,
      claudeTabFocus: { prId },
    }),
  consumeClaudeTabFocus: () => set({ claudeTabFocus: null }),
  requestSyncModal: (repoId: number) =>
    set((s) => ({ syncModalSignal: s.syncModalSignal + 1, syncModalRepoId: repoId })),
  bumpClaudeReviewKickoff: () =>
    set((s) => ({ claudeReviewKickoff: s.claudeReviewKickoff + 1 })),
  setStripCollapsed: (v) => set({ stripCollapsed: v }),
  setStripFilter: (f) => set({ stripFilter: f }),
  // Selecting a different repo console drops any lingering thread-state filter so a
  // narrow from one repo doesn't carry over to the next.
  setActivityRepo: (id) =>
    set((s) => (s.activityRepoId === id ? {} : { activityRepoId: id, activityThreadFilter: null })),
  setActivityThreadFilter: (st) =>
    set((s) => ({ activityThreadFilter: s.activityThreadFilter === st ? null : st })),
  setSearchQuery: (q) => set({ searchQuery: q }),
  toggleFileGroup: (path, defaultExpanded) =>
    set((s) => {
      // Track explicit user intent against the default so re-renders are stable.
      const isExpanded = defaultExpanded
        ? !s.collapsedFileGroups.includes(path)
        : s.expandedFileGroups.includes(path);
      if (defaultExpanded) {
        return {
          collapsedFileGroups: isExpanded
            ? [...s.collapsedFileGroups, path]
            : s.collapsedFileGroups.filter((p) => p !== path),
        };
      }
      return {
        expandedFileGroups: isExpanded
          ? s.expandedFileGroups.filter((p) => p !== path)
          : [...s.expandedFileGroups, path],
      };
    }),
  toggleDiffHunk: (threadId) =>
    set((s) => ({ expandedDiffHunks: toggle(s.expandedDiffHunks, threadId) })),
  resetAllFilters: () =>
    // Reset only the user-set filters (selection / focus state is preserved);
    // bumping rangeResetSignal snaps the window back to the default range. The
    // FilterBar disables this control during focus, so it never runs mid-focus.
    set((s) => ({ ...freshFilterDefaults(), rangeResetSignal: s.rangeResetSignal + 1 })),
  hydrate: (partial) => set(partial),
}));

/** Resolve the active [from, to] window from the preset or custom range. */
export function resolveRange(s: FilterState): { from: Date; to: Date } {
  return resolveBaseRange(s);
}

function resolveBaseRange(s: FilterState): { from: Date; to: Date } {
  if (s.preset === 'custom' && (s.customFrom || s.customTo)) {
    const to = s.customTo ? new Date(`${s.customTo}T23:59:59Z`) : new Date();
    const from = s.customFrom
      ? new Date(`${s.customFrom}T00:00:00Z`)
      : new Date(to.getTime() - 14 * DAY_MS);
    return { from, to };
  }
  const days = PRESET_DAYS[(s.preset === 'custom' ? '14d' : s.preset) as Exclude<RangePreset, 'custom'>];
  const to = new Date();
  return { from: new Date(to.getTime() - days * DAY_MS), to };
}

/** Map the selected coarse categories to concrete event types. */
export function categoriesToTypes(categories: EventCategory[]): EventType[] {
  const set = new Set(categories);
  // 'lifecycle' and 'reviews' have no coarse UI toggle (see ALL_CATEGORIES), but
  // their events must still flow: lifecycle keeps contributor rows + activity-feed
  // jumps; review_submitted is filtered by the separate per-verdict `reviewStates`
  // param, so it's always fetched here and narrowed there. Always include both.
  set.add('lifecycle');
  set.add('reviews');
  return (Object.keys(EVENT_CATEGORY_BY_TYPE) as EventType[]).filter((t) =>
    set.has(EVENT_CATEGORY_BY_TYPE[t]),
  );
}

// Floor to the start of the minute so a relative "to = now" window yields a
// stable query string across renders (avoids refetch-on-every-render).
function floorMinute(d: Date): Date {
  return new Date(Math.floor(d.getTime() / 60000) * 60000);
}

/**
 * Build the /api/open-prs query string. Respects repo + member filters but
 * ignores the date range — open PRs are always open.
 */
export function buildOpenPrsSearch(s: FilterState, includeMembers = true): string {
  const params = new URLSearchParams();
  if (s.repoIds && s.repoIds.length > 0) params.set('repoIds', s.repoIds.join(','));
  if (includeMembers && s.userIds && s.userIds.length > 0)
    params.set('userIds', s.userIds.join(','));
  return params.toString();
}

/**
 * Build the /api/timeline query string from current filters. `includeMembers` /
 * `includeStatuses` default true; pass false for the PR-title search index,
 * which is a global "jump to any PR" tool and so must ignore the member AND PR-
 * status filters (you can still search a closed/draft PR that's hidden on the
 * timeline). When all statuses are selected the `statuses` param is omitted (=
 * no filter); a non-full selection — including empty (= show none) — is sent.
 * `includeStaleFilter` defaults true; the search index passes false so the global
 * "jump to any PR" tool still finds a PR the stale filter hides from the timeline.
 * `includeReviewStates` defaults true; the search index passes false so the review-
 * verdict filter never narrows the member-derivation feed (it only hides markers).
 */
export function buildTimelineSearch(
  s: FilterState,
  includeMembers = true,
  includeStatuses = true,
  includeStaleFilter = true,
  includeReviewStates = true,
  // Embedded-tab range override (epoch ms): when set AND earlier than the resolved
  // `from`, widens the fetched window back to it (e.g. a PR-focus / My-Turn tab needs
  // ~90 days so its subject/inbox PRs are present) WITHOUT touching the store or URL.
  // Floored to the minute like the base range so it yields a stable query string.
  fromOverrideMs?: number | null,
  // `includeBots` defaults true (honour excludeBots + the allow-list). The member/PR
  // search index passes false so it ALWAYS fetches bot activity — the Members dropdown's
  // per-repo Bots sections need every bot even while the board hides them.
  includeBots = true,
): string {
  const { from, to } = resolveRange(s);
  const effectiveFrom =
    fromOverrideMs != null && fromOverrideMs < from.getTime()
      ? new Date(fromOverrideMs)
      : from;
  const params = new URLSearchParams();
  params.set('from', floorMinute(effectiveFrom).toISOString());
  params.set('to', floorMinute(to).toISOString());
  if (s.repoIds && s.repoIds.length > 0) params.set('repoIds', s.repoIds.join(','));
  if (includeMembers && s.userIds && s.userIds.length > 0)
    params.set('userIds', s.userIds.join(','));
  if (s.categories.length < ALL_CATEGORIES.length) {
    params.set('types', categoriesToTypes(s.categories).join(','));
  }
  if (includeStatuses && s.prStatuses.length < ALL_PR_STATUSES.length) {
    params.set('statuses', s.prStatuses.join(','));
  }
  // Review-verdict filter: omit when all verdicts are selected (= no filter); send a
  // non-full selection — including empty (= hide all review markers) — like statuses.
  if (includeReviewStates && s.reviewStates.length < ALL_REVIEW_STATES.length) {
    params.set('reviewStates', s.reviewStates.join(','));
  }
  if (includeBots) {
    params.set('excludeBots', String(s.excludeBots));
    // The allow-list only bites under excludeBots; send it so the server keeps those
    // "important" bots visible even while hiding the rest.
    if (s.excludeBots && s.allowedBotIds.length > 0)
      params.set('allowBotIds', s.allowedBotIds.join(','));
  } else {
    // The search / member-derivation index always wants bots visible. Emit an explicit
    // `false` (rather than omitting the param) so its query string matches the board's in
    // the common excludeBots-OFF case → React Query serves both from one cache entry; the
    // strings only diverge (a second lean fetch) when the board is actually hiding bots.
    params.set('excludeBots', 'false');
  }
  if (includeStaleFilter && s.excludeStale) params.set('excludeStale', 'true');
  return params.toString();
}
