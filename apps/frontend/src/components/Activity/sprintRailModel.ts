import { SPRINT_INNER_TABS, type SprintInnerTab } from '../../store/filters.js';

// The This Sprint rail line's sub-tabs, in strip order. FREE on every tier: no tab here is gated.
// Three independent views of the sprint on ONE lane board (components/LaneBoard.tsx), then the list
// of what has merged.
export const SPRINT_RAIL_TABS: ReadonlyArray<{ key: SprintInnerTab; label: string }> = [
  { key: 'paths', label: 'Critical path' },
  { key: 'themes', label: 'Theme' },
  { key: 'people', label: 'People' },
  { key: 'merged', label: 'Merged so far' },
];

/**
 * DERIVE the visible This Sprint tab; never write a correction back to the store (the rule
 * `effectiveInsightsTab` / `effectiveFeedTab` follow). A value outside the union — a hand-edited
 * `?sprintTab=`, or the retired `graph` — renders the Critical path view, the landing panel.
 */
export function effectiveSprintTab(raw: string | null | undefined): SprintInnerTab {
  return (SPRINT_INNER_TABS as readonly string[]).includes(raw ?? '') ? (raw as SprintInnerTab) : 'paths';
}
