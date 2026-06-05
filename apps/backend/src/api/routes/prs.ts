import type { FastifyInstance } from 'fastify';
import type { MarkViewedBody } from '@pierre-review/shared';
import { getPrDetail, markPrViewed } from '../../db/queries.js';
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

export async function prRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/prs/:id', { schema: idParamSchema }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const pr = await getPrDetail(id, accountIdOf(req));
    if (!pr) {
      reply.status(404);
      return { error: 'NotFound', message: `PR ${id} not found` };
    }
    return pr;
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
