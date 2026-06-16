import { create } from 'zustand';
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
  // "My Turn Focus Mode": when true, the timeline is isolated to the PRs in the
  // current "My Turn" inbox (awaiting your review / your PRs with new activity /
  // threads awaiting you) — the same set the My Turn panel shows, with the window
  // fitted to span them all. One of the two DISCRETE focus modes (the other is the
  // PR-isolation overlay, `focusActive`); they never overlap. Entered via the header
  // "My Turn" pill / `m` (enterMyTurnFocus → level 1, the To Do list) or by opening an
  // inbox entry (openMyTurnPr / openMyTurnClaudeReview → level 2, a PR's detail). Left
  // one level at a time by Back / Esc, or entirely via exitMyTurnFocus (the FilterBar
  // "My Turn focus" pill / the header "Feed" pill). A purely client-side filter (the
  // inbox is fetched separately via useMyTurn) so it never feeds buildTimelineSearch,
  // and a TRANSIENT mode — NOT mirrored to the URL or localStorage, so a fresh load is
  // always the full board + the default Feed panel.
  myTurnOnly: boolean;
  // While in My Turn Focus Mode, the fetched timeline range is widened back to this
  // instant (epoch ms) so inbox PRs whose activity predates the active date-range
  // filter are still loaded + visible — otherwise the isolated board is empty (the
  // lean /api/timeline payload has nothing for them). Computed by the Timeline from
  // the inbox PRs' earliest instant, clamped to ≥ 90 days ago (the backfill horizon).
  // null = no extension (inbox already within range, or not in My Turn Focus Mode).
  // Transient (like myTurnOnly) — never persisted/URL-synced; resolveRange folds it in.
  myTurnFromMs: number | null;

  // "Feed return": armed when the current selection was reached by clicking a Feed
  // entry (FeedSection → openFeedEventOnTimeline), so the browser Back button returns
  // straight to the Feed home — clearing the selection and tearing down any PR-isolation
  // Focus / popover the click entered. The Timeline reconciles it to a single {pierreFeed}
  // browser-history entry (mirroring the {pierreMyTurn} stack, one level) and the popstate
  // handler consumes it. Cleared by every navigation that LEAVES the feed-reached PR
  // (selecting a different PR, entering/leaving My Turn focus, clearing the selection);
  // PRESERVED while still exploring the SAME PR (a thread/Show/Focus within its detail).
  // Transient (like selection) — never persisted / URL-synced.
  feedReturn: boolean;

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

  // Insights panel (header button / `i`): transient UI flag, not URL-synced.
  insightsOpen: boolean;

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
  // when true, the pending timelineFocusPr is a request to ISOLATE that PR in a
  // sticky focus overlay (collapse to its contributors, show only its bar, fit the
  // window) rather than just centre it. Consumed alongside the other focus hints.
  timelineIsolate: boolean;
  // when true, after the timeline reveals the focused event it also OPENS that
  // event's marker popover (so the content is readable immediately) — and, if the
  // event is cross-person, enters PR Focus mode first. Set only by the Feed; reset
  // by every other navigation + on consume so it never leaks to a plain "Show".
  timelineFocusOpenPopover: boolean;
  // transient: request the timeline to recenter its window on a given instant
  // (epoch ms) keeping the current zoom width — drives the "Now" button. Store-
  // only (NOT URL-synced); cleared after the Timeline consumes it.
  timelineCenterAt: number | null;

  // Timeline focus-mode overlay (clicking a cross-user marker collapses every row
  // except the two involved contributors). The overlay itself — row collapse,
  // glows, viewport save/restore, re-center — is owned by the Timeline component;
  // these fields are the shared signal so BOTH the on-canvas "Exit focus" button
  // and the global keyboard hook (Escape) can drive it consistently.
  //
  // `focusActive`: the Timeline sets this true while a focus overlay is showing
  // and false when it tears one down. Other code reads it (e.g. Escape should
  // exit focus before clearing selection).
  focusActive: boolean;
  // `exitFocusSignal`: a monotonic counter the Timeline watches. Bumping it (via
  // exitFocus()) is an explicit, edge-triggered request to leave focus mode and
  // restore the previous view — a counter (not a boolean) so repeated requests
  // each fire, even if focusActive hasn't yet been observed as flipped.
  exitFocusSignal: number;
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
  // Open an inbox To Do entry → My Turn Focus Mode "level 2": isolate the board to the
  // WHOLE inbox (not just this PR) AND select the PR (its detail opens) + optionally glow
  // a thread's review_comment marker via `event`. The Timeline keeps every inbox PR bar
  // visible and just highlights/scrolls to this one (no single-PR zoom). Works whether or
  // not the user was already in focus (level 1): the Timeline reconciles the history so
  // Back returns to the To Do list, then to the Feed home.
  openMyTurnPr: (
    id: number,
    threadId?: number | null,
    focusAt?: string | null,
    event?: { type: EventType; refId: number | null } | null,
  ) => void;
  // Same, for a Claude-review inbox entry: enter focus + open the PR's Claude tab.
  openMyTurnClaudeReview: (prId: number) => void;
  // Set/clear the My Turn Focus Mode range extension (see myTurnFromMs). The Timeline
  // computes it from the inbox PRs once their data loads; a no-op write is skipped so
  // it doesn't churn the timeline query.
  setMyTurnFrom: (ms: number | null) => void;
  // Enter My Turn Focus Mode at "level 1" (the To Do list, no PR selected): isolate the
  // board to your inbox and show the My Turn panel. Driven by the header "My Turn" pill
  // and the `m` shortcut. Selecting a To Do afterwards (openMyTurnPr) drills to "level 2"
  // (its PR detail) while the board stays isolated to the WHOLE inbox. The Timeline owns
  // the two-level browser-history stack that lets Back step L2 → L1 → Feed home.
  enterMyTurnFocus: () => void;
  // Leave My Turn Focus Mode entirely → the Feed home: un-isolate the board (full
  // timeline) AND clear any selection + range extension, so the default Feed panel shows.
  // Driven by the FilterBar "My Turn focus" pill and the header "Feed" pill (a full exit;
  // the browser Back button / Esc step ONE level at a time instead — see the Timeline).
  exitMyTurnFocus: () => void;
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
  // Feed-item click: like showEventOnTimeline, but also opens the event's popover
  // (read the content inline) and, for a cross-person event, enters PR Focus first.
  openFeedEventOnTimeline: (
    prId: number,
    focusAt: string,
    event: { type: EventType; refId: number | null },
  ) => void;
  // Isolate a PR on the timeline (the "Focus" link): select it and ask the
  // Timeline for the sticky PR-isolation overlay. The overlay only exits via the
  // Exit-focus button / Escape; see the Timeline's timelineFocusPr consumer.
  focusPrOnTimeline: (prId: number) => void;
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
  // Focus-mode signalling (the Timeline owns the actual overlay; see fields above).
  // setFocusActive: the Timeline reports whether a focus overlay is currently up.
  setFocusActive: (v: boolean) => void;
  // exitFocus: request the Timeline to leave focus mode and restore the previous
  // view. Bumps exitFocusSignal (edge-triggered) and clears focusActive. The
  // Timeline reacts by tearing down the overlay and re-centering / fade-glowing
  // the marker that opened it (that behaviour is NOT implemented here).
  exitFocus: () => void;
  // Ask SyncStatus to pop the sync-progress modal (used right after adding a repo
  // so the initial backfill's load time is visible). Bumps syncModalSignal and
  // records the added repo id so the modal can scope to just that repo.
  requestSyncModal: (repoId: number) => void;
  bumpClaudeReviewKickoff: () => void;
  setStripCollapsed: (v: boolean) => void;
  setStripFilter: (f: StripFilter) => void;
  setInsightsOpen: (v: boolean) => void;
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
    // My Turn Focus Mode is a transient mode (not a persisted filter): a fresh load is
    // always the full board + the My Turn panel. Entered only via openMyTurnPr/…Review.
    myTurnOnly: false,
    myTurnFromMs: null,
    feedReturn: false,
    selectedPrId: null,
    selectedThreadId: null,
    selectedCommentId: null,
    activityFocus: null,
    commentFocus: null,
    claudeTabFocus: null,
    stripCollapsed: true, // strip starts collapsed for more timeline room
    insightsOpen: false,
    expandedFileGroups: [],
    collapsedFileGroups: [],
    expandedDiffHunks: [],
    timelineFocusPr: null,
    timelineFocusAt: null,
    timelineFocusEvent: null,
    timelineIsolate: false,
    timelineFocusOpenPopover: false,
    timelineCenterAt: null,
    focusActive: false,
    exitFocusSignal: 0,
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
  openMyTurnPr: (id, threadId = null, focusAt = null, event = null) =>
    set({
      myTurnOnly: true, // enter My Turn Focus Mode (isolate the board to the inbox)
      feedReturn: false, // My Turn owns its own {pierreMyTurn} back-stack
      selectedPrId: id,
      selectedThreadId: threadId,
      selectedCommentId: null,
      timelineFocusPr: id,
      timelineFocusAt: focusAt,
      timelineFocusEvent: event,
      timelineIsolate: false,
      timelineFocusOpenPopover: false,
    }),
  openMyTurnClaudeReview: (prId) =>
    set({
      myTurnOnly: true, // enter My Turn Focus Mode
      feedReturn: false, // My Turn owns its own {pierreMyTurn} back-stack
      selectedPrId: prId,
      selectedThreadId: null,
      selectedCommentId: null,
      claudeTabFocus: { prId },
    }),
  setMyTurnFrom: (ms) =>
    set((s) => (s.myTurnFromMs === ms ? {} : { myTurnFromMs: ms })),
  enterMyTurnFocus: () =>
    set({
      myTurnOnly: true, // isolate the board to the inbox
      feedReturn: false, // My Turn owns its own {pierreMyTurn} back-stack
      // Level 1: the To Do list, nothing selected. Clear any prior selection so the
      // My Turn panel (not a stale PR detail) shows. The Timeline's history reconcile
      // effect pushes the matching {pierreMyTurn} entry so Back can leave again.
      selectedPrId: null,
      selectedThreadId: null,
      selectedCommentId: null,
    }),
  exitMyTurnFocus: () =>
    // Full exit → the Feed home: un-isolate the board, drop the range extension, and
    // clear any selection so the default Feed panel shows. The Timeline's reconcile
    // effect unwinds every pushed {pierreMyTurn} history entry. (Harmless when not in
    // focus — it just normalises to the Feed home, e.g. the Feed pill deselecting a PR.)
    set({
      myTurnOnly: false,
      myTurnFromMs: null,
      feedReturn: false,
      selectedPrId: null,
      selectedThreadId: null,
      selectedCommentId: null,
    }),
  selectPr: (id) =>
    set((s) => ({
      selectedPrId: id,
      selectedThreadId: null,
      selectedCommentId: null,
      // Selecting a DIFFERENT PR leaves the feed-reached one → disarm the feed-return
      // slot. Re-selecting the SAME PR (e.g. a feed click's own popover, which selects
      // its event's PR) keeps it, so Back still returns to the Feed.
      ...(id !== s.selectedPrId ? { feedReturn: false } : {}),
    })),
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
      feedReturn: false,
    }),
  openPrFocused: (id, threadId = null, focusAt = null, event = null) =>
    set((s) => ({
      // Navigating to a DIFFERENT PR than the selected one (the open-PRs strip, the Done
      // tab, search) is a full-board move — leave My Turn Focus Mode so it isn't a stale,
      // marker-less bar on the isolated inbox board (the Timeline's history reconcile
      // unwinds the {pierreMyTurn} entries). Navigating to the ALREADY-selected PR (the
      // PrDetail "Show" link) keeps focus — it just re-centres the current PR. No-op when
      // not in focus.
      ...(s.myTurnOnly && id !== s.selectedPrId
        ? { myTurnOnly: false, myTurnFromMs: null }
        : {}),
      // Navigating to a DIFFERENT PR (strip / search / Done tab) leaves the feed-reached
      // one → disarm the feed-return slot; re-centring the ALREADY-selected PR (the
      // PrDetail "Show" link) keeps it.
      ...(id !== s.selectedPrId ? { feedReturn: false } : {}),
      selectedPrId: id,
      selectedThreadId: threadId,
      selectedCommentId: null,
      timelineFocusPr: id,
      timelineFocusAt: focusAt,
      timelineFocusEvent: event,
      // A plain navigate, never the sticky isolation overlay — guarantee the event/
      // centre branch runs even if a prior focus left timelineIsolate set.
      timelineIsolate: false,
      timelineFocusOpenPopover: false,
    })),
  showEventOnTimeline: (prId, focusAt, event) =>
    set({
      selectedPrId: prId,
      timelineFocusPr: prId,
      timelineFocusAt: focusAt,
      timelineFocusEvent: event,
      timelineIsolate: false,
      timelineFocusOpenPopover: false,
    }),
  openFeedEventOnTimeline: (prId, focusAt, event) =>
    set({
      selectedPrId: prId,
      // Arm the feed-return history slot so the browser Back button returns to the Feed
      // home (see feedReturn). The Timeline pushes the matching {pierreFeed} entry.
      feedReturn: true,
      timelineFocusPr: prId,
      timelineFocusAt: focusAt,
      timelineFocusEvent: event,
      timelineIsolate: false,
      // The one path that opts in: reveal the event's popover (and enter PR Focus if
      // it's cross-person). The Timeline consumer reads this in the show-event branch.
      timelineFocusOpenPopover: true,
    }),
  focusPrOnTimeline: (prId) =>
    set({
      selectedPrId: prId,
      timelineFocusPr: prId,
      timelineFocusAt: null,
      timelineFocusEvent: null,
      timelineIsolate: true,
      timelineFocusOpenPopover: false,
    }),
  consumeTimelineFocus: () =>
    set({
      timelineFocusPr: null,
      timelineFocusAt: null,
      timelineFocusEvent: null,
      timelineIsolate: false,
      timelineFocusOpenPopover: false,
    }),
  centerTimelineNow: () => set({ timelineCenterAt: Date.now() }),
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
    set((s) => ({
      selectedPrId: prId,
      selectedThreadId: null,
      selectedCommentId: null,
      claudeTabFocus: { prId },
      // The global Claude-review banner can open a DIFFERENT PR than the feed-reached one
      // → disarm the feed-return slot so Back doesn't wrongly snap to the Feed (same guard
      // as selectPr / openPrFocused). Re-opening the SAME PR keeps it.
      ...(prId !== s.selectedPrId ? { feedReturn: false } : {}),
    })),
  consumeClaudeTabFocus: () => set({ claudeTabFocus: null }),
  setFocusActive: (v) => set({ focusActive: v }),
  exitFocus: () =>
    set((s) => ({ focusActive: false, exitFocusSignal: s.exitFocusSignal + 1 })),
  requestSyncModal: (repoId: number) =>
    set((s) => ({ syncModalSignal: s.syncModalSignal + 1, syncModalRepoId: repoId })),
  bumpClaudeReviewKickoff: () =>
    set((s) => ({ claudeReviewKickoff: s.claudeReviewKickoff + 1 })),
  setStripCollapsed: (v) => set({ stripCollapsed: v }),
  setStripFilter: (f) => set({ stripFilter: f }),
  setInsightsOpen: (v) => set({ insightsOpen: v }),
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
  const base = resolveBaseRange(s);
  // In My Turn Focus Mode, widen `from` back to cover inbox PRs that predate the
  // active filter (myTurnFromMs, already clamped to the 90-day backfill horizon) so
  // the isolated board isn't empty. Never narrows the range — only extends it.
  if (s.myTurnOnly && s.myTurnFromMs != null && s.myTurnFromMs < base.from.getTime()) {
    return { from: new Date(s.myTurnFromMs), to: base.to };
  }
  return base;
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
): string {
  const { from, to } = resolveRange(s);
  const params = new URLSearchParams();
  params.set('from', floorMinute(from).toISOString());
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
  params.set('excludeBots', String(s.excludeBots));
  if (includeStaleFilter && s.excludeStale) params.set('excludeStale', 'true');
  return params.toString();
}
