import type { WorkspaceComparisonResponse, WorkspaceComparisonRow } from '@pierre-review/shared';
import { getWorkspaceMetrics, listWorkspaces } from './queries.js';

// Cross-WORKSPACE comparison (CORE/FREE) — one WorkspaceMetrics row per workspace the account
// owns, for the "Compare workspaces" rail line.
//
// WHY THIS LIVES IN ITS OWN MODULE, not db/queries.ts: it is pure composition over two reads
// that already exist (`listWorkspaces` + `getWorkspaceMetrics`) and adds no SQL of its own, so it
// has no business growing the 11k-line query layer.
//
// WHY IT REPLACED THE PRO ROUTE: this used to be `GET /api/pro/insights/team-comparison`, which
// (a) sat behind the /api/pro/* 402 entitlement gate and did not exist at all in OSS, and (b)
// ran N × `getTeamInsights` — the full insight-card + user-roster computation — while the panel
// reads nothing but `.metrics`. The read had to become core, and it uses `getWorkspaceMetrics`
// directly: same numbers, none of the card/roster work.
//
// ⚠ IT TAKES NO SCOPE, AND THAT IS THE POINT. Its predecessor parsed a `TeamScope` wire string and
// narrowed the matrix to the selected teams — which is what made the surface vanish the moment
// fewer than two teams were selected, a comparison hidden by the very selection it exists to place
// in context. A comparison covers EVERY workspace, Default included, independent of which one is
// active. Both file-local scope helpers (`parseTeamSetScope` + `selectTeams`, the second of the
// three parsers that existed) went with the scope union; there is nothing left to parse or select.
//
// ISOLATION IS BY CONSTRUCTION, not by a predicate written here: the only input is
// `listWorkspaces(accountId)`, and `getWorkspaceMetrics` additionally filters
// `pullRequests.accountId`. A foreign workspace id can reach neither — there is no id parameter at
// all — so there is no 404 oracle and nothing to leak.
//
// ⚠ NO COST APPEARS ON THIS SURFACE, AND NONE MAY BE ADDED AS A TOTAL. `monthly_cents` is a
// per-workspace fact (a bot is configured at the workspace level, price included), so six
// workspaces each listing a $120 CodeRabbit is either six subscriptions or one subscription seen
// six ways — and the app must not assert which. Within a workspace a total is a plain sum; ACROSS
// workspaces the only honest rendering is side by side, which is why `WorkspaceComparisonRow`
// carries flow metrics and no money.
//
// WINDOW — a real, visible behaviour change, deliberately taken and kept from the team-era module.
// The Pro route resolved the account's configured sprint window from the plugin-owned
// `pro_settings` (getComparisonWindow). Core cannot read a plugin table, so this passes
// `window: undefined` → `getWorkspaceMetrics`' legacy trailing-14d default, exactly like
// `getWorkspaceMetricsForScope` behind `GET /api/workspace-metrics`. Compare therefore AGREES with
// the free flow-metric header elsewhere in the app, and may differ from a Pro user's custom-window
// Insights header. Agreeing with the free header is the right trade; it is not an oversight.

/**
 * One `WorkspaceComparisonRow` per workspace the account owns, in `listWorkspaces` order (the
 * Default row first, then by name) so the matrix columns are stable across reloads and the
 * workspace users land in is the leftmost.
 *
 * COST: N × `getWorkspaceMetrics`, one per workspace — each pulls a 12-week PR window plus the
 * previous sprint slice. That multiplication by workspace count is why the route sits on the
 * `search` rate-limit tier rather than the blanket 600/min `read` bucket, why the SPA fires it only
 * while the Compare surface is actually open, and why this uses `listWorkspaces`' already-joined
 * `repoIds` instead of re-querying `workspace_repos` per workspace (which is what the Pro route
 * did).
 */
export async function getWorkspaceComparisonRows(
  accountId: number,
): Promise<WorkspaceComparisonRow[]> {
  const all = await listWorkspaces(accountId);
  if (all.length === 0) return [];
  const nowMs = Date.now();
  return Promise.all(
    all.map(async (w) => {
      // `w.repoIds` came from workspace_repos filtered by accountId, and getWorkspaceMetrics
      // additionally filters pullRequests.accountId — so ownership is enforced twice over, and a
      // workspace with no repos yields `metrics: null` (the shape the panel already renders as
      // "—"). An empty workspace is an ordinary state now, not an edge case: it is what a freshly
      // created one looks like until repos are moved in.
      const metrics = await getWorkspaceMetrics(accountId, w.repoIds, nowMs, undefined);
      return {
        workspaceId: w.id,
        workspaceName: w.name,
        isDefault: w.isDefault,
        repoCount: w.repoCount,
        metrics,
      };
    }),
  );
}

// The trailing-2-week default sprint the tiles compare against. A LOCAL COPY of queries.ts'
// private INSIGHT_SPRINT_DAYS, kept in lockstep by hand: getWorkspaceMetrics falls back to exactly
// this span when `window` is undefined, so the `sprint` echoed on the wire must describe the
// same slice or the panel's caption would contradict its own numbers.
const COMPARISON_SPRINT_DAYS = 14;

/**
 * The whole `GET /api/workspace-metrics/compare` payload. The route takes NO parameters — not even
 * `?workspace=` — because the comparison is over the whole roster (§0/D6). `enabled` is always true
 * from core (the field survives only because the Pro route shaped the response and the client
 * already ignores it); `sprint` is the resolved trailing-14d window the tiles were computed over.
 */
export async function getWorkspaceComparison(
  accountId: number,
): Promise<WorkspaceComparisonResponse> {
  const rows = await getWorkspaceComparisonRows(accountId);
  const now = Date.now();
  return {
    enabled: true,
    generatedAt: new Date(now).toISOString(),
    sprint: {
      from: new Date(now - COMPARISON_SPRINT_DAYS * 86_400_000).toISOString(),
      to: new Date(now).toISOString(),
    },
    workspaces: rows,
  };
}
