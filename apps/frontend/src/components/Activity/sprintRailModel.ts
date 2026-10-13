import type { SprintInnerTab } from '../../store/filters.js';

// The This Sprint rail line's sub-tabs, in strip order. FREE on every tier: no tab here is gated.
export const SPRINT_RAIL_TABS: ReadonlyArray<{ key: SprintInnerTab; label: string }> = [
  { key: 'graph', label: 'Sprint graph' },
  { key: 'merged', label: 'Merged so far' },
];

/**
 * DERIVE the visible This Sprint tab; never write a correction back to the store (the rule
 * `effectiveInsightsTab` / `effectiveFeedTab` follow). A value outside the union — a hand-edited
 * `?sprintTab=` or a member removed in a later build — renders the graph, the landing panel.
 */
export function effectiveSprintTab(raw: string | null | undefined): SprintInnerTab {
  return raw === 'merged' ? 'merged' : 'graph';
}
