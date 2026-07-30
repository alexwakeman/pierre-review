// Per-team identity colours — the visual marker that distinguishes teams in the Activity rail
// and keys the Compare-teams matrix columns back to those rail groups.
//
// Modelled directly on `buildBotColorMap` (lib/ui.ts): the map is built from the ACCOUNT-WIDE
// team roster and seeded from a stable sort, so a team resolves to the same hue on every surface
// and across reloads. Both properties are load-bearing —
//   • ACCOUNT-WIDE, never the selected subset: feed this the teams currently in scope and every
//     team's colour shifts the moment the selection changes, and two surfaces built from
//     different subsets disagree about which team is which.
//   • STABLE SEED: `useTeams()` returns `orderBy(asc(teams.name))`, which is stable across
//     reloads and independent of the scope, so callers pass that order through untouched.
//
// TWO REJECTED ALTERNATIVES, recorded so this isn't relitigated:
//   • The TIMELINE ZEBRA TINTS (`tl-repo-tint-0/1`, REPO_TINT_COUNT = 2) are two hues with
//     ADJACENCY semantics — "the next repo block must differ from the last", keyed off render
//     order parity — and their CSS custom properties are only consumed by `.vis-label`/
//     `.vis-group` selectors. They cannot express identity and cap out at two teams.
//   • BOT_PALETTE is deliberately ordered around review-bot BRAND collisions, and the Bots
//     console sits one rail row from these team groups. Sharing hues would read as a
//     relationship between a team and a bot that does not exist.
//
// This lives in its own module rather than lib/ui.ts purely to keep the change surface small;
// it is the same kind of shared UI metadata and can be folded in later.

// 8 mid-tone hues spread across the wheel, each legible on both light and dark surfaces (used
// as a small dot beside a team name, so contrast against the row background is what matters).
// Chosen to be distinguishable from BOT_PALETTE's leading entries (pink / lime / cyan), which
// are the hues the adjacent Bots console reaches for first.
export const TEAM_PALETTE: readonly string[] = [
  '#6366f1', // indigo
  '#f97316', // orange
  '#10b981', // emerald
  '#d946ef', // fuchsia
  '#0ea5e9', // sky
  '#eab308', // yellow
  '#f43f5e', // rose
  '#64748b', // slate
] as const;

// The colour for a team we can't place (roster still loading, or a stale id from a deleted
// team). Neutral gray — deliberately NOT a palette hue, so "unknown" never impersonates a team.
export const TEAM_FALLBACK_COLOR = '#9ca3af';

/**
 * Build a stable teamId → colour map for the account's WHOLE team roster.
 *
 * Pass `useTeams()`' ids in the order the hook returns them (name asc). Beyond
 * `TEAM_PALETTE.length` teams the hues repeat, which is acceptable: the dot is a grouping
 * marker beside a written team name, not the sole identifier.
 */
export function buildTeamColorMap(allTeamIds: number[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const id of allTeamIds) {
    // Index by MAP SIZE, not array position, so a duplicate id can't burn a palette slot and
    // shift every subsequent team's hue.
    if (!map.has(id)) map.set(id, TEAM_PALETTE[map.size % TEAM_PALETTE.length]!);
  }
  return map;
}

/** Resolve one team's colour, degrading to the neutral fallback for an unknown id. */
export function teamColorFor(map: Map<number, string>, teamId: number): string {
  return map.get(teamId) ?? TEAM_FALLBACK_COLOR;
}
