import type { TeamComparisonResponse, TeamComparisonRow } from '@pierre-review/shared';
import { getTeamMetrics, listTeams } from './queries.js';

// Cross-team comparison (CORE/FREE) — one TeamMetrics row per team IN SCOPE, for the Feed's
// "Compare teams" sub-tab.
//
// WHY THIS LIVES IN ITS OWN MODULE, not db/queries.ts: it is pure composition over two reads
// that already exist (`listTeams` + `getTeamMetrics`) and adds no SQL of its own, so it has no
// business growing the 7k-line query layer.
//
// WHY IT REPLACED THE PRO ROUTE: this used to be `GET /api/pro/insights/team-comparison`, which
// (a) sat behind the /api/pro/* 402 entitlement gate and did not exist at all in OSS, and (b)
// ran N × `getTeamInsights` — the full insight-card + user-roster computation — while the panel
// reads nothing but `.metrics`. The panel now sits beside the free DORA header in the Feed, so
// the read had to become core, and it uses `getTeamMetrics` directly: same numbers, none of the
// card/roster work.
//
// WINDOW — a real, visible behaviour change, deliberately taken. The Pro route resolved the
// account's configured sprint window from the plugin-owned `pro_settings` (getComparisonWindow).
// Core cannot read a plugin table, so this passes `window: undefined` → getTeamMetrics' legacy
// trailing-14d default, exactly like `getTeamMetricsForScope` behind `GET /api/team-metrics`.
// Compare therefore AGREES with the free flow-metric header directly above it, and may differ
// from a Pro user's custom-window Insights header. Agreeing with the panel it now sits next to
// is the right trade; it is not an oversight.

/**
 * Parse a multi-team scope wire string `teams:<ids>` → the team-id list (deduped, sorted), or
 * null when the token isn't a team set.
 *
 * LANDMINE — this MIRRORS the private `parseTeamSetScope` in db/queries.ts (which is not
 * exported). The two must stay in lockstep: they parse the SAME canonical string the client's
 * `scopeToParam` emits. Kept as a local copy rather than widening queries.ts' export surface for
 * one caller; if a third consumer appears, promote it there instead of adding a third copy.
 */
function parseTeamSetScope(scope: string): number[] | null {
  if (!scope.startsWith('teams:')) return null;
  const ids = scope
    .slice('teams:'.length)
    .split(',')
    .map((x) => Number.parseInt(x, 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  return ids.length ? [...new Set(ids)].sort((a, b) => a - b) : null;
}

/**
 * The teams a scope selects, out of the account's OWN teams.
 *
 * ISOLATION: the input is always `listTeams(accountId)`'s output, so this can only ever narrow
 * an already account-scoped list. A scope naming another tenant's team id matches nothing and
 * returns no row — there is no code path by which a foreign team id reaches a query.
 *
 * Scope semantics mirror `resolveScopeRepoIds` so the client can send the same
 * `scopeToParam(teamScope)` string it sends every other scoped route:
 *   • absent / 'all' / 'none' → every team (a comparison across the account; also the sane
 *     answer for a bare URL hit). 'none' means "repos in no team", which has no team row of its
 *     own — comparing nothing would be a blank panel, so it degrades to the full set.
 *   • 'teams'                 → every team (the All-Teams sentinel)
 *   • 'teams:<ids>'           → just those teams (the explicit multi-select — the case the old
 *                               All-Teams-only gate silently dropped)
 *   • '<teamId>'              → that one team
 */
function selectTeams<T extends { id: number }>(all: T[], scope: string | undefined): T[] {
  if (!scope || scope === 'all' || scope === 'none' || scope === 'teams') return all;
  const set = parseTeamSetScope(scope);
  if (set) {
    const want = new Set(set);
    return all.filter((t) => want.has(t.id));
  }
  const teamId = Number(scope);
  if (!Number.isInteger(teamId) || teamId <= 0) return [];
  return all.filter((t) => t.id === teamId);
}

/**
 * One `TeamComparisonRow` per team in scope, in `listTeams` order (name asc) so the matrix
 * columns are stable across reloads.
 *
 * COST: N × `getTeamMetrics`, one per team in scope — each pulls a 12-week PR window plus the
 * previous sprint slice. That is why the SPA gates the query on the Compare tab actually being
 * the active Feed sub-tab rather than firing it on every Feed open, and why this uses
 * `listTeams`' already-joined `repoIds` instead of re-querying `team_repos` per team (which is
 * what the Pro route did).
 */
export async function getTeamComparisonRows(
  accountId: number,
  scope?: string,
): Promise<TeamComparisonRow[]> {
  const teams = await listTeams(accountId);
  const inScope = selectTeams(teams, scope);
  if (inScope.length === 0) return [];
  const nowMs = Date.now();
  return Promise.all(
    inScope.map(async (t) => {
      // `t.repoIds` came from team_repos filtered by accountId, and getTeamMetrics additionally
      // filters pullRequests.accountId — so ownership is enforced twice over, and a team with no
      // repos yields `metrics: null` (the shape the panel already renders as "—").
      const metrics = await getTeamMetrics(accountId, t.repoIds, nowMs, undefined);
      return {
        teamId: t.id,
        teamName: t.name,
        repoCount: t.repoIds.length,
        metrics,
      };
    }),
  );
}

// The trailing-2-week default sprint the tiles compare against. A LOCAL COPY of queries.ts'
// private INSIGHT_SPRINT_DAYS, kept in lockstep by hand: getTeamMetrics falls back to exactly
// this span when `window` is undefined, so the `sprint` echoed on the wire must describe the
// same slice or the panel's caption would contradict its own numbers.
const COMPARISON_SPRINT_DAYS = 14;

/**
 * The whole `GET /api/team-metrics/compare` payload. `enabled` is always true from core (the
 * field survives only because the Pro route shaped the response and the client already ignores
 * it); `sprint` is the resolved trailing-14d window the tiles were computed over.
 */
export async function getTeamComparison(
  accountId: number,
  scope?: string,
): Promise<TeamComparisonResponse> {
  const teams = await getTeamComparisonRows(accountId, scope);
  const now = Date.now();
  return {
    enabled: true,
    generatedAt: new Date(now).toISOString(),
    sprint: {
      from: new Date(now - COMPARISON_SPRINT_DAYS * 86_400_000).toISOString(),
      to: new Date(now).toISOString(),
    },
    teams,
  };
}
