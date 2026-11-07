import type { FastifyInstance } from 'fastify';
import type { PrPushSummariesResponse } from '@pierre-review/shared';
import { getPrPushSummaries } from '../../db/push-summaries.js';
import { accountIdOf } from '../plugins/auth.js';

// THE PUSH SUMMARIES of one PR (docs/API.md; docs/CLAUDE-REVIEW.md § Push summaries) — what each
// full Limn review said the pushes since the previous one changed. A PURE DB READ (no model, no
// GitHub), so it is registered unconditionally like the ML labels; the SPA's gate is `me.ai.enabled`.
export async function pushSummaryRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/prs/:id/push-summaries',
    {
      schema: {
        params: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
      },
    },
    async (req, reply): Promise<PrPushSummariesResponse | { error: string; message: string }> => {
      const { id } = req.params as { id: number };
      // Ownership lives in the getter: null for a foreign PR → 404.
      const summaries = await getPrPushSummaries(id, accountIdOf(req));
      if (summaries === null) {
        reply.status(404);
        return { error: 'NotFound', message: `PR ${id} not found` };
      }
      return { prId: id, summaries };
    },
  );
}
