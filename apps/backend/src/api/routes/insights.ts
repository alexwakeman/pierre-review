import type { FastifyInstance } from 'fastify';
import type {
  AttentionCardsResponse,
  InsightsResponse,
  RepoAnalytics,
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
