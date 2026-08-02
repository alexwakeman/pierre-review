// Per-workspace identity colours — SERIES IDENTITY for the Compare-workspaces matrix, and
// nothing else.
//
// ⚠ ITS ONE CONSUMER IS `Activity/WorkspaceComparisonPanel`. This module used to colour two
// surfaces: the Activity rail's per-team group headers/row borders, and the comparison matrix's
// columns keyed back to them. The rail no longer groups — a repo belongs to EXACTLY ONE workspace
// and the scope is EXACTLY ONE workspace, so the rail is a flat repo list with no grouping headers,
// no colour dots and no "Other" bucket. What survives is the column dot in the comparison table,
// where several workspaces genuinely sit side by side in one view and need to be told apart at a
// glance. Everything that existed only to serve the rail grouping is gone with it.
//
// Modelled on `buildBotColorMap` (lib/ui.ts): the map is built once from a STABLE, COMPLETE roster
// so a workspace keeps its hue across reloads. The completeness property is what matters and it is
// now free — `WorkspaceComparisonResponse.workspaces` covers EVERY workspace the account owns,
// always (the route takes no scope; a selection cannot narrow a comparison whose whole purpose is
// to place the selected workspace against the others). So the panel seeds this from the response it
// is already rendering, rather than from a second query whose arrival order could shift every hue
// mid-render.
//
// ONE REJECTED ALTERNATIVE, recorded so it isn't relitigated: BOT_PALETTE is deliberately ordered
// around review-bot BRAND collisions, and the Bots console sits one rail line from Compare
// workspaces. Sharing hues would read as a relationship between a workspace and a bot that does not
// exist.
//
// This lives in its own module rather than lib/ui.ts purely to keep the change surface small; it is
// the same kind of shared UI metadata and can be folded in later.

// 8 mid-tone hues spread across the wheel, each legible on both light and dark surfaces (used as a
// small dot beside a workspace name, so contrast against the row background is what matters).
// Chosen to be distinguishable from BOT_PALETTE's leading entries (pink / lime / cyan), which are
// the hues the adjacent Bots console reaches for first.
export const WORKSPACE_PALETTE: readonly string[] = [
  '#6366f1', // indigo
  '#f97316', // orange
  '#10b981', // emerald
  '#d946ef', // fuchsia
  '#0ea5e9', // sky
  '#eab308', // yellow
  '#f43f5e', // rose
  '#64748b', // slate
] as const;

// The colour for a workspace we can't place (roster still loading, or a stale id from a deleted
// workspace). Neutral gray — deliberately NOT a palette hue, so "unknown" never impersonates a
// workspace.
export const WORKSPACE_FALLBACK_COLOR = '#9ca3af';

/**
 * Build a stable workspaceId → colour map for the account's WHOLE workspace roster.
 *
 * Pass the ids in the order the server returned them (`listWorkspaces` order: the Default row
 * first, then by name — stable across reloads and independent of the selection). Beyond
 * `WORKSPACE_PALETTE.length` workspaces the hues repeat, which is acceptable: the dot is a column
 * marker beside a written workspace name, not the sole identifier.
 */
export function buildWorkspaceColorMap(allWorkspaceIds: number[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const id of allWorkspaceIds) {
    // Index by MAP SIZE, not array position, so a duplicate id can't burn a palette slot and shift
    // every subsequent workspace's hue.
    if (!map.has(id)) map.set(id, WORKSPACE_PALETTE[map.size % WORKSPACE_PALETTE.length]!);
  }
  return map;
}

/** Resolve one workspace's colour, degrading to the neutral fallback for an unknown id. */
export function workspaceColorFor(map: Map<number, string>, workspaceId: number): string {
  return map.get(workspaceId) ?? WORKSPACE_FALLBACK_COLOR;
}
