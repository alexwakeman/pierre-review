import { useFilters } from '../../store/filters.js';
import { isFixedView, usePinnedTabs, type Tab } from '../../store/pinnedTabs.js';
import { useShell } from '../../store/shell.js';

// THE SHELL'S NAVIGATION, as data (docs/redesign/DESIGN.md § 1, "One sidebar, one header").
//
// The sidebar, the phone's bottom bar, the `g`-then-letter keys and ⌘K all go through `goTo`, which
// calls the SAME store actions the old top tab row and the Activity rail called — so the URL, Back
// and every deep link (`?view=`, `?activityRepo=attention`, `'insights'` …) keep their meaning. The
// shell adds no URL key of its own.
//
// Two axes stay two axes: `pinnedTabs.activeTab` picks Activity / This Sprint / Timeline / a
// dynamic tab, and `filters.activityRepoId` picks the Activity destination inside it. The sidebar
// shows them as one list; this file is where that flattening lives.

export type DestinationId =
  | 'attention'
  | 'open-prs'
  | 'sprint'
  | 'timeline'
  | 'docs'
  | 'feed'
  | 'insights'
  | 'bots';

export type NavGroup = 'primary' | 'library' | 'insights';

export interface Destination {
  id: DestinationId;
  /** The sidebar's words. Store values stay `'attention'` for Pending and `'insights'` for Reports. */
  label: string;
  /** What it is, in one sentence (the item's tooltip). */
  title: string;
  group: NavGroup;
  /** The letter after `g` that goes here. */
  goKey: string;
  /** Shown only where agentic AI runs (`me.ai.enabled`); a deep link still lands. */
  aiOnly?: boolean;
}

/** Sidebar order, top to bottom. The four primaries are also the phone's bottom bar. */
export const DESTINATIONS: readonly Destination[] = [
  { id: 'attention', label: 'Pending', title: 'Everything waiting on you or your workspace, ranked most actionable first', group: 'primary', goKey: 'p' },
  { id: 'open-prs', label: 'Open pull requests', title: 'Every open pull request in this workspace', group: 'primary', goKey: 'o' },
  { id: 'sprint', label: 'This Sprint', title: "The tracker's current sprint: themes, critical path, people and what merged", group: 'primary', goKey: 's' },
  { id: 'timeline', label: 'Timeline', title: 'The activity board: every pull request over time', group: 'primary', goKey: 't' },
  { id: 'docs', label: 'Docs', title: 'Reference documents for this workspace, and a chat that answers from them', group: 'library', goKey: 'd', aiOnly: true },
  { id: 'feed', label: 'Feed', title: 'One chronological stream across every repo in this workspace', group: 'library', goKey: 'f' },
  { id: 'insights', label: 'Reports', title: 'Flow metrics and period reports for this workspace', group: 'insights', goKey: 'r' },
  { id: 'bots', label: 'Bots Monitoring', title: "Measure and triage this workspace's review bots", group: 'insights', goKey: 'b' },
];

export const GROUP_LABEL: Record<NavGroup, string | null> = {
  primary: null,
  library: 'Library',
  insights: 'Insights',
};

/** The bottom bar's short words (a phone has ~78px per item). */
export const SHORT_LABEL: Partial<Record<DestinationId, string>> = {
  'open-prs': 'Open PRs',
  sprint: 'Sprint',
};

export function destination(id: DestinationId): Destination {
  const d = DESTINATIONS.find((x) => x.id === id);
  if (d == null) throw new Error(`Unknown destination ${id}`);
  return d;
}

/** A sidebar location: a destination, a repo's console (its id), or null for a dynamic tab. */
export type Location = DestinationId | number | null;

/**
 * Where the reader is, read from the two stores. Pure, so the sidebar's highlight and the key layer
 * agree by construction (test/shellNav.test.ts). A stale dynamic-tab key falls back to the board,
 * exactly as App.tsx renders it.
 */
export function currentLocation(
  activeTab: string,
  tabs: readonly Pick<Tab, 'key'>[],
  activityRepoId: number | DestinationId | null,
): Location {
  if (activeTab === 'timeline') return 'timeline';
  if (activeTab === 'sprint') return 'sprint';
  if (activeTab === 'activity') {
    if (typeof activityRepoId === 'number') return activityRepoId;
    return activityRepoId ?? 'open-prs';
  }
  if (!isFixedView(activeTab) && !tabs.some((t) => t.key === activeTab)) return 'timeline';
  return null;
}

/** Go to a destination or a repo console — the click of the old tab row / rail, nothing more. */
export function goTo(to: DestinationId | number): void {
  const tabs = usePinnedTabs.getState();
  if (to === 'timeline') tabs.showTimeline();
  else if (to === 'sprint') tabs.showSprint();
  else {
    // Switch the rail value FIRST, then bring Activity forward (filters.ts § ORDERING).
    useFilters.getState().setActivityRepo(to);
    tabs.showActivity();
  }
  // Picking somewhere closes the phone drawer; at desktop width it was never open.
  useShell.getState().setDrawerOpen(false);
}

/** `g` then a letter. */
export const GO_KEYS: Readonly<Record<string, DestinationId>> = Object.fromEntries(
  DESTINATIONS.map((d) => [d.goKey, d.id]),
) as Record<string, DestinationId>;

/** How long a `g` waits for its letter. */
export const GO_CHORD_MS = 1200;

/**
 * The `g`-chord state machine, pure. `armedAt` is when `g` was pressed (null = not armed).
 * Returns what to do and the new armed time.
 */
export function resolveGoChord(
  armedAt: number | null,
  key: string,
  now: number,
): { go: DestinationId | null; armedAt: number | null; handled: boolean } {
  const armed = armedAt != null && now - armedAt <= GO_CHORD_MS;
  if (armed) {
    const dest = GO_KEYS[key.toLowerCase()] ?? null;
    // Any second key ends the chord; only a known letter goes somewhere.
    return { go: dest, armedAt: null, handled: dest != null };
  }
  if (key === 'g') return { go: null, armedAt: now, handled: true };
  return { go: null, armedAt: null, handled: false };
}
