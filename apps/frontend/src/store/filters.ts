import { create } from 'zustand';
import {
  EVENT_CATEGORY_BY_TYPE,
  type DerivedState,
  type EventCategory,
  type EventType,
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
  preset: RangePreset;
  customFrom: string | null; // ISO date (yyyy-mm-dd)
  customTo: string | null;
  categories: EventCategory[];
  derivedStates: DerivedState[]; // empty = no derived-state filtering

  // selection
  selectedPrId: number | null;
  selectedThreadId: number | null;

  // open PRs strip
  stripCollapsed: boolean;
  stripFilter: StripFilter;

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

  setRepoIds: (ids: number[] | null) => void;
  toggleRepo: (id: number) => void;
  setUserIds: (ids: number[] | null) => void;
  toggleUser: (id: number) => void;
  setExcludeBots: (v: boolean) => void;
  setPreset: (p: RangePreset) => void;
  setCustomRange: (from: string | null, to: string | null) => void;
  toggleCategory: (c: EventCategory) => void;
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
  consumeTimelineFocus: () => void;
  setStripCollapsed: (v: boolean) => void;
  setStripFilter: (f: StripFilter) => void;
  toggleFileGroup: (path: string, defaultExpanded: boolean) => void;
  toggleDiffHunk: (threadId: number) => void;
  hydrate: (partial: Partial<FilterState>) => void;
}

function toggle<T>(arr: T[], value: T): T[] {
  return arr.includes(value) ? arr.filter((x) => x !== value) : [...arr, value];
}

export const useFilters = create<FilterState>((set) => ({
  repoIds: null,
  userIds: null,
  excludeBots: true,
  preset: '14d',
  customFrom: null,
  customTo: null,
  categories: [...DEFAULT_CATEGORIES],
  derivedStates: [],
  selectedPrId: null,
  selectedThreadId: null,
  stripCollapsed: false,
  stripFilter: 'all',
  expandedFileGroups: [],
  collapsedFileGroups: [],
  expandedDiffHunks: [],
  timelineFocusPr: null,
  timelineFocusAt: null,
  timelineFocusEvent: null,

  setRepoIds: (ids) => set({ repoIds: ids }),
  toggleRepo: (id) =>
    set((s) => ({ repoIds: toggle(s.repoIds ?? [], id) })),
  setUserIds: (ids) => set({ userIds: ids }),
  toggleUser: (id) => set((s) => ({ userIds: toggle(s.userIds ?? [], id) })),
  setExcludeBots: (v) => set({ excludeBots: v }),
  setPreset: (p) => set({ preset: p }),
  setCustomRange: (from, to) =>
    set({ preset: 'custom', customFrom: from, customTo: to }),
  toggleCategory: (c) => set((s) => ({ categories: toggle(s.categories, c) })),
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
    }),
  consumeTimelineFocus: () =>
    set({ timelineFocusPr: null, timelineFocusAt: null, timelineFocusEvent: null }),
  setStripCollapsed: (v) => set({ stripCollapsed: v }),
  setStripFilter: (f) => set({ stripFilter: f }),
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
export function buildOpenPrsSearch(s: FilterState): string {
  const params = new URLSearchParams();
  if (s.repoIds && s.repoIds.length > 0) params.set('repoIds', s.repoIds.join(','));
  if (s.userIds && s.userIds.length > 0) params.set('userIds', s.userIds.join(','));
  return params.toString();
}

/** Build the /api/timeline query string from current filters. */
export function buildTimelineSearch(s: FilterState): string {
  const { from, to } = resolveRange(s);
  const params = new URLSearchParams();
  params.set('from', floorMinute(from).toISOString());
  params.set('to', floorMinute(to).toISOString());
  if (s.repoIds && s.repoIds.length > 0) params.set('repoIds', s.repoIds.join(','));
  if (s.userIds && s.userIds.length > 0) params.set('userIds', s.userIds.join(','));
  if (s.categories.length < ALL_CATEGORIES.length) {
    params.set('types', categoriesToTypes(s.categories).join(','));
  }
  params.set('excludeBots', String(s.excludeBots));
  return params.toString();
}
