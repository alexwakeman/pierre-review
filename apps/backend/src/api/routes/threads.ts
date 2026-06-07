import type { FastifyInstance } from 'fastify';
import { getThreadDetail } from '../../db/queries.js';
import { hydrateThreadDetail } from '../../sync/hydrate-detail.js';
import { accountIdOf } from '../plugins/auth.js';

const idParamSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'integer' } },
  },
};

export async function threadRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/threads/:id', { schema: idParamSchema }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const accountId = accountIdOf(req);
    const thread = await getThreadDetail(id, accountId);
    if (!thread) {
      reply.status(404);
      return { error: 'NotFound', message: `Thread ${id} not found` };
    }
    return hydrateThreadDetail(thread, accountId);
  });
}
