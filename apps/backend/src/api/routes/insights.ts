import type { FastifyInstance } from 'fastify';
import type {
  AttentionCardsResponse,
  InsightsResponse,
  RepoAnalytics,
  TeamComparisonResponse,
  TeamMetricsDetailResponse,
  TeamMetricsResponse,
} from '@pierre-review/shared';
import {
  getInsights,
  getRepoAnalytics,
  getTeamInsights,
  getTeamMetricsDetail,
  getTeamMetricsForScope,
  resolveScopeRepoIds,
} from '../../db/queries.js';
import { getTeamComparison } from '../../db/team-comparison.js';
import { accountIdOf } from '../plugins/auth.js';

function parseIntList(raw: string | undefined): number[] | null {
  if (!raw) return null;
  const ids = raw
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
  return ids.length > 0 ? ids : null;
}

export async function insightsRoutes(app: FastifyInstance): Promise<void> {
  // Per-repo sprint/team stats for the Insights panel. Scoped to the account;
  // `repoIds` narrows to the active watched-repo selection.
  app.get('/api/insights', async (req): Promise<InsightsResponse> => {
    const q = req.query as { repoIds?: string };
    return getInsights({
      accountId: accountIdOf(req),
      repoIds: parseIntList(q.repoIds),
    });
  });

  // Team flow-metric header (DORA-ish tiles + trend charts) — CORE/free (moved out of the Pro
  // Insights pane into the Feed). `scope` ('all'|'none'|'teams'|'<teamId>') resolves to repo ids
  // like the rest of the app; null/'all' → the watched set.
  app.get('/api/team-metrics', async (req): Promise<TeamMetricsResponse> => {
    const q = req.query as { scope?: string };
    const accountId = accountIdOf(req);
    const scopeRepoIds = q.scope ? await resolveScopeRepoIds(accountId, q.scope) : null;
    return { metrics: await getTeamMetricsForScope(accountId, scopeRepoIds) };
  });

  // The PR lists behind each flow-metric tile (the tile drill-down) — also CORE/free now, so a
  // Feed tile opens the same drill-down for everyone. Mirrors the Pro route's `{enabled, detail}`
  // shape (enabled always true here).
  app.get('/api/team-metrics/detail', async (req): Promise<TeamMetricsDetailResponse> => {
    const q = req.query as { scope?: string };
    const accountId = accountIdOf(req);
    const scopeRepoIds = q.scope ? await resolveScopeRepoIds(accountId, q.scope) : null;
    const detail = await getTeamMetricsDetail(accountId, undefined, scopeRepoIds);
    return { enabled: true, detail };
  });

  // Cross-team comparison — CORE/FREE, deliberately in the /api/team-metrics family because the
  // panel now sits in the Feed beside the free DORA header and shares its (trailing-14d) window.
  // It MOVED here from the Pro plugin's `/api/pro/insights/team-comparison`, which was behind the
  // 402 entitlement gate, absent in OSS, and computed N × getTeamInsights to read `.metrics`.
  //
  // `scope` takes the same wire strings as its siblings ('all'|'none'|'teams'|'<teamId>'|
  // 'teams:<ids>') but selects TEAMS, not repo ids — so it does NOT go through
  // resolveScopeRepoIds. 'teams:<ids>' is the case that matters: it is what the client sends for
  // an explicit 2-of-5 multi-select, which the old All-Teams-only gate silently dropped.
  //
  // Isolation is by construction: getTeamComparison narrows `listTeams(accountId)`, so a foreign
  // team id in the scope string matches no row rather than 404-ing (no existence oracle either).
  //
  // Rate limit: the default 600/min `read` bucket via tierFor, like its two siblings — no GitHub
  // quota and no AI. Note it is the first route in the family whose cost multiplies by team
  // count, which is why the SPA only fires it while the Compare tab is active.
  app.get('/api/team-metrics/compare', async (req): Promise<TeamComparisonResponse> => {
    const q = req.query as { scope?: string };
    return getTeamComparison(accountIdOf(req), q.scope);
  });

  // The attention cards (stalled reviews / untouched threads / reviewer load / needs-a-reviewer) —
  // CORE/free (the same cards Pro Insights computes in core getTeamInsights), for the Feed "Needs
  // attention" tab. The bot cards are excluded (they live in the free Bots console). `scope`
  // resolves like the rest of the app; null/'all' → the watched set.
  app.get('/api/attention', async (req): Promise<AttentionCardsResponse> => {
    const q = req.query as { scope?: string };
    const accountId = accountIdOf(req);
    const scopeRepoIds = q.scope ? await resolveScopeRepoIds(accountId, q.scope) : null;
    const insights = await getTeamInsights(accountId, undefined, scopeRepoIds);
    const cards = insights.cards.filter(
      (c) => c.kind !== 'bot_signal' && c.kind !== 'bot_only_review',
    );
    return { cards, users: insights.users };
  });

  // Heavier per-repo analytics for the drill-down chart panel — loaded on demand.
  // Ownership-scoped: a repo not owned by the account 404s.
  app.get('/api/insights/:repoId/analytics', async (req, reply): Promise<RepoAnalytics> => {
    const { repoId } = req.params as { repoId: string };
    const id = Number.parseInt(repoId, 10);
    const data = Number.isFinite(id)
      ? await getRepoAnalytics(accountIdOf(req), id)
      : null;
    if (!data) return reply.code(404).send({ error: 'repo not found' }) as never;
    return data;
  });
}
