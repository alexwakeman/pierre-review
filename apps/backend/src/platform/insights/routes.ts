import type { FastifyInstance } from 'fastify';
import type {
  RepoWorkspaceMetricsResponse,
  WorkspaceInsightsResponse,
  WorkspaceMetricsDetailResponse,
} from '@pierre-review/shared';
import type { BotScopeWire, ProContext } from '../contract.js';
import { getComparisonWindow } from '../settings/store.js';
import { resolveRequestScope } from './workspace-request.js';

function parseId(raw: string): number | null {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

// Workspace review-intelligence "Insights" (Pro; `workspaceInsights`). A thin, account-scoped
// presentation route over the host's `getWorkspaceInsights` — the heavy read logic lives in
// core (it composes existing tables: PRs, reviews, review threads, review requests,
// commits/commitFiles, mergers). No AI, no mutation. The client refetches on the sync
// cadence. Registered only when the plugin loads → the route is absent in pure OSS, so
// the capability flag on /api/me is what the SPA gates the rail entry on.
export function registerInsightsRoutes(app: FastifyInstance, ctx: ProContext): void {
  app.get<{ Querystring: { workspace?: string } }>('/api/pro/insights', async (req) => {
    const accountId = ctx.accountIdOf(req);
    // `?workspace=<id>` → the ONE scope: the workspace decides who counts as a bot (the
    // `bot_signal` / `bot_only_review` cards need that), `repoIds` narrows the data.
    //
    // ⚠ RESOLVED FIRST, because the comparison window now depends on it: the sprint CADENCE is a
    // per-workspace fact (`resolveSprintCadence`), so a window taken before the scope would be
    // some other team's fortnight under this team's heading.
    const scope = await resolveRequestScope(ctx, accountId, req.query.workspace);
    // The comparison window per the account's MODE (rolling_7/14 or sprint-position) over THIS
    // workspace's cadence; always resolves (rolling_14 default). Open PRs always count regardless.
    const window = await getComparisonWindow(ctx, accountId, scope.workspaceId);
    return (await ctx.queries.getWorkspaceInsights(
      accountId,
      window,
      scope,
    )) as WorkspaceInsightsResponse;
  });

  // The per-metric PR drill-down behind the 6 flow-metric tiles. Loaded on demand when a
  // tile is clicked (heavier than the always-loaded Insights). Account-scoped via ctx.
  // Pure flow metrics — no judgement grain — so it takes the repo list alone; `[]` (an empty
  // workspace) is a legal argument yielding the empty result.
  app.get<{ Querystring: { workspace?: string } }>(
    '/api/pro/insights/metrics-detail',
    async (req) => {
      const accountId = ctx.accountIdOf(req);
      // Scope first — the window's cadence is per-workspace. See the note on /api/pro/insights.
      const scope = await resolveRequestScope(ctx, accountId, req.query.workspace);
      const window = await getComparisonWindow(ctx, accountId, scope.workspaceId);
      const detail = await ctx.queries.getWorkspaceMetricsDetail(
        accountId,
        window,
        scope.repoIds,
      );
      return { enabled: true, detail } as WorkspaceMetricsDetailResponse;
    },
  );

  // The Insights flow-metric header (tiles + trend charts) for a SINGLE repo — powers the
  // per-repo console's Insights-style panel.
  //
  // ⚠ This handler holds a repoId and NOTHING ELSE, and `getWorkspaceInsights` needs a full scope
  // (the workspace supplies the bot-judgement grain). The plugin cannot compute a workspace from a
  // repo — `resolveWorkspaceRepoIds` goes the other way — so it asks the host through the
  // `workspaceScopeForRepo` seam, which returns `{workspaceId, repoIds:[repoId]}` and is
  // ownership-bound: a foreign or unknown repo yields null, never another tenant's workspace id.
  app.get<{ Params: { repoId: string } }>(
    '/api/pro/insights/repo/:repoId/metrics',
    async (req): Promise<RepoWorkspaceMetricsResponse> => {
      const accountId = ctx.accountIdOf(req);
      const repoId = parseId(req.params.repoId);
      if (repoId == null) return { enabled: true, metrics: null };
      const scope = (await ctx.queries.workspaceScopeForRepo(
        accountId,
        repoId,
      )) as BotScopeWire | null;
      if (scope == null) return { enabled: true, metrics: null };
      // The repo's OWN workspace supplies the cadence — `workspaceScopeForRepo` is ownership-bound,
      // so this is never another tenant's (or another team's) sprint.
      const window = await getComparisonWindow(ctx, accountId, scope.workspaceId);
      const insights = (await ctx.queries.getWorkspaceInsights(
        accountId,
        window,
        scope,
      )) as WorkspaceInsightsResponse;
      return { enabled: true, metrics: insights.metrics };
    },
  );

  // DELETED: `GET /api/pro/insights/team-comparison` (callerless, 402-gated), and later its core
  // successor `GET /api/workspace-metrics/compare` too (with the Compare rail entry, plan C4).
  // The Reports "By workspace" axis that followed was removed 2026-10-26 too: there is no
  // cross-workspace comparison. Do not reinstate any of them.
}

// Kept intentionally minimal for the sketch — parseId is exported so future per-repo /
// per-PR insight sub-routes can reuse it without re-deriving the pattern.
export { parseId };
