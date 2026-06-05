import type { FastifyInstance } from 'fastify';
import type { UpdateUserBody } from '@pierre-review/shared';
import { listUsers, setUserBot } from '../../db/queries.js';

const patchUserSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'integer' } },
  },
  body: {
    type: 'object',
    required: ['isBot'],
    additionalProperties: false,
    properties: { isBot: { type: 'boolean' } },
  },
};

export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/users', async () => listUsers());

  app.patch('/api/users/:id', { schema: patchUserSchema }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const { isBot } = req.body as UpdateUserBody;
    const updated = await setUserBot(id, isBot);
    if (!updated) {
      reply.status(404);
      return { error: 'NotFound', message: `User ${id} not found` };
    }
    return updated;
  });
}
