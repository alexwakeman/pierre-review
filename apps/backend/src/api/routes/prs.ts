import type { FastifyInstance } from 'fastify';
import type { MarkViewedBody } from '@pierre-review/shared';
import { getPrDetail, markAllViewed, markPrViewed } from '../../db/queries.js';
import { hydratePrDetail } from '../../sync/hydrate-detail.js';
import { accountIdOf } from '../plugins/auth.js';

const idParamSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'integer' } },
  },
};

const markViewedSchema = {
  ...idParamSchema,
  body: {
    type: 'object',
    additionalProperties: false,
    properties: { sha: { type: 'string' } },
  },
};

const markAllViewedSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    properties: { repoIds: { type: 'array', items: { type: 'integer' } } },
  },
};

export async function prRoutes(app: FastifyInstance): Promise<void> {
  // Bulk "mark all seen": stamp every open PR (optionally scoped to repoIds) viewed
  // at its head, clearing all new-since badges at once. Static path — no :id — so it
  // doesn't collide with /api/prs/:id.
  app.post('/api/prs/mark-all-viewed', { schema: markAllViewedSchema }, async (req) => {
    const { repoIds } = (req.body ?? {}) as { repoIds?: number[] };
    const count = await markAllViewed(
      accountIdOf(req),
      repoIds && repoIds.length > 0 ? repoIds : null,
    );
    return { status: 'ok', count };
  });

  app.get('/api/prs/:id', { schema: idParamSchema }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const accountId = accountIdOf(req);
    const pr = await getPrDetail(id, accountId);
    if (!pr) {
      reply.status(404);
      return { error: 'NotFound', message: `PR ${id} not found` };
    }
    // Cloud lean mode: fill in bulky text from GitHub (no-op in local). The client
    // caches the result in IndexedDB keyed by updatedAt so unchanged PRs don't refetch.
    return hydratePrDetail(pr, accountId);
  });

  // Record that the local user has seen this PR up to `sha` (defaults to the
  // current head). Clears "new since last viewed" badges.
  app.post(
    '/api/prs/:id/mark-viewed',
    { schema: markViewedSchema },
    async (req, reply) => {
      const { id } = req.params as { id: number };
      const { sha } = (req.body ?? {}) as MarkViewedBody;
      const ok = await markPrViewed(id, accountIdOf(req), sha);
      if (!ok) {
        reply.status(404);
        return { error: 'NotFound', message: `PR ${id} not found` };
      }
      return { status: 'ok' };
    },
  );

  // Explicit "I've seen this" without opening — same effect as mark-viewed.
  app.post(
    '/api/prs/:id/dismiss',
    { schema: idParamSchema },
    async (req, reply) => {
      const { id } = req.params as { id: number };
      const ok = await markPrViewed(id, accountIdOf(req));
      if (!ok) {
        reply.status(404);
        return { error: 'NotFound', message: `PR ${id} not found` };
      }
      return { status: 'ok' };
    },
  );
}
