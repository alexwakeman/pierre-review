import type { FastifyInstance } from 'fastify';
import type { InsightsResponse, RepoAnalytics } from '@pierre-review/shared';
import { getInsights, getRepoAnalytics } from '../../db/queries.js';
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
