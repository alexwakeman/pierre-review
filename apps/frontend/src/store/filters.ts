import { create } from 'zustand';
import {
  EVENT_CATEGORY_BY_TYPE,
  PR_STATUSES,
  type DerivedState,
  type EventCategory,
  type EventType,
  type PrStatus,
} from '@gh-team-monitor/shared';

export type RangePreset = '7d' | '14d' | '30d' | '90d' | 'custom';

export type StripFilter = 'all' | 'my_turn' | 'needs_attention';

export const ALL_CATEGORIES: EventCategory[] = [
  'lifecycle',
  'reviews',
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

// PR statuses shown on a fresh load. Closed PRs are noise for most situational-
// awareness views, so they start hidden; the choice round-trips through the URL.
export const DEFAULT_PR_STATUSES: PrStatus[] = ALL_PR_STATUSES.filter(
  (s) => s !== 'closed',
);

const DAY_MS = 24 * 60 * 60 * 1000;
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
  derivedStates: DerivedState[]; // empty = no derived-state filtering

  // selection
  selectedPrId: number | null;
  selectedThreadId: number | null;

  // transient: a timeline → PR-detail deep link that opens the Activity tab and
  // scrolls to a specific entry (e.g. the commit popover's "View in Activity").
  // Matched against the loaded PR by `prId`; cleared by PrDetail after it scrolls.
  activityFocus: { prId: number; type: EventType; refId: number | null } | null;

  // transient: a timeline → PR-detail deep link that opens the Overview tab and
  // scrolls to + flashes a specific issue-level PR comment (the pr_comment
  // marker's "Open in detail pane"). Matched against the loaded PR by `prId`;
  // cleared by PrCommentsList once it scrolls.
  commentFocus: { prId: number; commentId: number } | null;

  // open PRs strip
  stripCollapsed: boolean;
  stripFilter: StripFilter;

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

  setRepoIds: (ids: number[] | null) => void;
  toggleRepo: (id: number) => void;
  setUserIds: (ids: number[] | null) => void;
  setExcludeBots: (v: boolean) => void;
  setExcludeStale: (v: boolean) => void;
  setPreset: (p: RangePreset) => void;
  setCustomRange: (from: string | null, to: string | null) => void;
  toggleCategory: (c: EventCategory) => void;
  togglePrStatus: (s: PrStatus) => void;
  toggleDerivedState: (s: DerivedState) => void;
  selectPr: (id: number | null) => void;
  selectThread: (prId: number | null, threadId: number | null) => void;
  clearSelection: () => void;
  // Open a PR from the strip / my-turn / a timeline event: select it AND ask
  // the timeline to scroll to it (optionally recentering on `focusAt`).
  openPrFocused: (id: number, threadId?: number | null, focusAt?: string | null) => void;
  // Show a specific activity entry on the timeline: keep its PR selected, recenter
  // on the event's instant, and glow the matching marker.
  showEventOnTimeline: (
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
  // Focus-mode signalling (the Timeline owns the actual overlay; see fields above).
  // setFocusActive: the Timeline reports whether a focus overlay is currently up.
  setFocusActive: (v: boolean) => void;
  // exitFocus: request the Timeline to leave focus mode and restore the previous
  // view. Bumps exitFocusSignal (edge-triggered) and clears focusActive. The
  // Timeline reacts by tearing down the overlay and re-centering / fade-glowing
  // the marker that opened it (that behaviour is NOT implemented here).
  exitFocus: () => void;
  // Ask SyncStatus to pop the sync-progress modal (used right after adding a repo
  // so the initial backfill's load time is visible). Bumps syncModalSignal.
  requestSyncModal: () => void;
  setStripCollapsed: (v: boolean) => void;
  setStripFilter: (f: StripFilter) => void;
  setSearchQuery: (q: string) => void;
  toggleFileGroup: (path: string, defaultExpanded: boolean) => void;
  toggleDiffHunk: (threadId: number) => void;
  // Reset every filter (repos, members, range, categories, PR statuses, derived
  // states, search, excludeBots) back to its fresh-load default, and clear any
  // selection / timeline-focus hint so the detail pane and overlay don't orphan.
  // Values mirror freshDefaults() exactly so useUrlState's diff-against-defaults
  // produces a clean (empty) query string.
  resetAllFilters: () => void;
  hydrate: (partial: Partial<FilterState>) => void;
}

function toggle<T>(arr: T[], value: T): T[] {
  return arr.includes(value) ? arr.filter((x) => x !== value) : [...arr, value];
}

// Every non-action piece of state. resetAllFilters() restores exactly these keys.
type FilterData = Omit<
  FilterState,
  {
    [K in keyof FilterState]: FilterState[K] extends (...args: never[]) => unknown
      ? K
      : never;
  }[keyof FilterState]
>;

// The fresh-load defaults for every (non-action) piece of state. Single source of
// truth used both for the initial store and resetAllFilters(); array defaults are
// rebuilt per call (freshDefaults) so callers never share a mutable reference.
// These values are what useUrlState diffs against, so a reset yields a clean URL.
function freshDefaults(): FilterData {
  return {
    repoIds: null,
    userIds: null,
    excludeBots: true,
    // Stale open PRs (no commit/comment/review in the active range) are clutter for
    // situational awareness, so they're HIDDEN on a fresh load. This is the baseline
    // the URL serializer diffs against; turning the filter off round-trips as stale=0.
    excludeStale: true,
    preset: '14d',
    customFrom: null,
    customTo: null,
    categories: [...DEFAULT_CATEGORIES],
    prStatuses: [...DEFAULT_PR_STATUSES],
    derivedStates: [],
    selectedPrId: null,
    selectedThreadId: null,
    activityFocus: null,
    commentFocus: null,
    stripCollapsed: true, // strip starts collapsed for more timeline room
    stripFilter: 'all',
    searchQuery: '',
    expandedFileGroups: [],
    collapsedFileGroups: [],
    expandedDiffHunks: [],
    timelineFocusPr: null,
    timelineFocusAt: null,
    timelineFocusEvent: null,
    timelineIsolate: false,
    timelineCenterAt: null,
    focusActive: false,
    exitFocusSignal: 0,
    rangeResetSignal: 0,
    syncModalSignal: 0,
  };
}

export const useFilters = create<FilterState>((set) => ({
  ...freshDefaults(),

  setRepoIds: (ids) => set({ repoIds: ids }),
  toggleRepo: (id) =>
    set((s) => ({ repoIds: toggle(s.repoIds ?? [], id) })),
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
  togglePrStatus: (st) => set((s) => ({ prStatuses: toggle(s.prStatuses, st) })),
  toggleDerivedState: (st) =>
    set((s) => ({ derivedStates: toggle(s.derivedStates, st) })),
  selectPr: (id) => set({ selectedPrId: id, selectedThreadId: null }),
  selectThread: (prId, threadId) =>
    set((s) => ({
      selectedPrId: prId ?? s.selectedPrId,
      selectedThreadId: threadId,
    })),
  clearSelection: () => set({ selectedPrId: null, selectedThreadId: null }),
  openPrFocused: (id, threadId = null, focusAt = null) =>
    set({
      selectedPrId: id,
      selectedThreadId: threadId,
      timelineFocusPr: id,
      timelineFocusAt: focusAt,
      timelineFocusEvent: null,
    }),
  showEventOnTimeline: (prId, focusAt, event) =>
    set({
      selectedPrId: prId,
      timelineFocusPr: prId,
      timelineFocusAt: focusAt,
      timelineFocusEvent: event,
      timelineIsolate: false,
    }),
  focusPrOnTimeline: (prId) =>
    set({
      selectedPrId: prId,
      timelineFocusPr: prId,
      timelineFocusAt: null,
      timelineFocusEvent: null,
      timelineIsolate: true,
    }),
  consumeTimelineFocus: () =>
    set({
      timelineFocusPr: null,
      timelineFocusAt: null,
      timelineFocusEvent: null,
      timelineIsolate: false,
    }),
  centerTimelineNow: () => set({ timelineCenterAt: Date.now() }),
  consumeTimelineCenter: () => set({ timelineCenterAt: null }),
  showActivityEntry: (prId, event) =>
    set({ selectedPrId: prId, selectedThreadId: null, activityFocus: { prId, ...event } }),
  consumeActivityFocus: () => set({ activityFocus: null }),
  showPrComment: (prId, commentId) =>
    set({ selectedPrId: prId, selectedThreadId: null, commentFocus: { prId, commentId } }),
  consumeCommentFocus: () => set({ commentFocus: null }),
  setFocusActive: (v) => set({ focusActive: v }),
  exitFocus: () =>
    set((s) => ({ focusActive: false, exitFocusSignal: s.exitFocusSignal + 1 })),
  requestSyncModal: () =>
    set((s) => ({ syncModalSignal: s.syncModalSignal + 1 })),
  setStripCollapsed: (v) => set({ stripCollapsed: v }),
  setStripFilter: (f) => set({ stripFilter: f }),
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
    // Also drop any active focus overlay so a "clear all" truly returns to the
    // baseline view (the Timeline reacts to the bumped exitFocusSignal).
    set((s) => ({ ...freshDefaults(), exitFocusSignal: s.exitFocusSignal + 1 })),
  hydrate: (partial) => set(partial),
}));

/** Resolve the active [from, to] window from the preset or custom range. */
export function resolveRange(s: FilterState): { from: Date; to: Date } {
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
 */
export function buildTimelineSearch(
  s: FilterState,
  includeMembers = true,
  includeStatuses = true,
  includeStaleFilter = true,
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
  params.set('excludeBots', String(s.excludeBots));
  if (includeStaleFilter && s.excludeStale) params.set('excludeStale', 'true');
  return params.toString();
}
