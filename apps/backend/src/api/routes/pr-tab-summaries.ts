import type { FastifyInstance } from 'fastify';
import { PR_TAB_SUMMARIES_MAX, type PrTabSummariesBody, type PrTabSummariesResponse } from '@pierre-review/shared';
import { getPrTabSummaries } from '../../db/pr-tab-summaries.js';
import { accountIdOf } from '../plugins/auth.js';

// POST /api/prs/tab-summaries — the sidebar's open-tabs hover card (CORE, free). DB-only: three
// account-scoped reads, no GitHub call and no model, so it sits on the `read` tier (spelled out in
// rate-limit.ts). The SPA sends ONE batch for all its PR tabs, the first time a card opens, and
// shares the answer across every card (docs/FRONTEND.md § The tab hover card).
//
// A POST because the id list is a body; over `PR_TAB_SUMMARIES_MAX` ids it 400s rather than
// truncating (a shorter answer would read as "these PRs do not exist").
export async function prTabSummaryRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/prs/tab-summaries',
    {
      schema: {
        body: {
          type: 'object',
          required: ['prIds'],
          additionalProperties: false,
          properties: { prIds: { type: 'array', items: { type: 'integer', minimum: 1 } } },
        },
      },
    },
    async (req, reply): Promise<PrTabSummariesResponse | void> => {
      const { prIds } = req.body as PrTabSummariesBody;
      const unique = [...new Set(prIds)];
      if (unique.length > PR_TAB_SUMMARIES_MAX) {
        return reply
          .code(400)
          .send({ error: 'TooManyIds', message: `At most ${PR_TAB_SUMMARIES_MAX} pull requests per request; got ${unique.length}.` });
      }
      return { prs: await getPrTabSummaries(accountIdOf(req), unique) };
    },
  );
}
