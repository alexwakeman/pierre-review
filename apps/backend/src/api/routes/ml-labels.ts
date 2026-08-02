import type { FastifyInstance } from 'fastify';
import type { BotSeverityResponse, PrMlLabelsResponse } from '@pierre-review/shared';
import { getBotSeverityRollup, getPrMlLabels } from '../../db/ml-labels.js';
import { resolveWorkspaceScope } from '../../db/queries.js';
import { isSeverityApiConfigured } from '../../ml/severity-client.js';
import { accountIdOf } from '../plugins/auth.js';

// `repoIds` → the `narrow` argument of `resolveWorkspaceScope`, never a scope in its own right.
// Positive integers only (the stricter of the two parser variants in this directory).
function parseIntList(raw: string | undefined): number[] | null {
  if (!raw) return null;
  const ids = raw
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  return ids.length > 0 ? ids : null;
}

// ML severity/category labels on BOT-authored text (CORE, FREE TIER — not a Pro capability, so
// deliberately NOT under /api/pro/, which is 402'd for free cloud accounts and auto-tiered as
// AI for any mutating verb).
//
// BOTH ROUTES ARE PURE DB READS. Nothing here calls the model, spends money or touches GitHub —
// generation is the background worker's job (sync/ml-enrichment.ts). That is why they are
// registered UNCONDITIONALLY, even where no severity-api is configured: they answer honestly
// (an empty label set / `enabled:false`) instead of 404ing, so a deployment that later gains
// the service needs no client change, and the SPA's own gate is `MeResponse.mlSeverity`.
export async function mlLabelRoutes(app: FastifyInstance): Promise<void> {
  // Every ML label on one PR — THE per-PR index. One request serves every badge on the page
  // (a 60-thread PR must not become 60 requests), so the client caches it with
  // `staleTime: Infinity` and each card looks itself up by (targetKind, targetId).
  //
  // A target with no label is simply absent from the array: "no label" and "not enriched yet"
  // are the same thing to a badge, and both mean render nothing.
  app.get(
    '/api/prs/:id/ml-labels',
    {
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'integer' } },
          required: ['id'],
        },
      },
    },
    async (req, reply): Promise<PrMlLabelsResponse | { error: string; message: string }> => {
      const { id } = req.params as { id: number };
      // Ownership lives in the getter, which returns null for a foreign PR (the repo-wide rule
      // for id-addressed reads).
      const labels = await getPrMlLabels(id, accountIdOf(req));
      if (labels === null) {
        reply.status(404);
        return { error: 'NotFound', message: `PR ${id} not found` };
      }
      return { prId: id, labels, generatedAt: new Date().toISOString() };
    },
  );

  // The Bots-interface severity rollup for one workspace.
  //
  // `?workspace=` follows the read contract exactly: absent / unparseable / unknown / another
  // tenant's id all resolve to this account's DEFAULT workspace rather than 404ing (a 404 there
  // would be an existence oracle over another tenant's ids). Hence `{ type: 'string' }` in the
  // schema — an ajv `integer` would 400 on garbage, contradicting that contract.
  app.get(
    '/api/bot-severity',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            workspace: { type: 'string' },
            repoIds: { type: 'string' },
          },
        },
      },
    },
    async (req): Promise<BotSeverityResponse> => {
      const q = req.query as { workspace?: string; repoIds?: string };
      const accountId = accountIdOf(req);
      const scope = await resolveWorkspaceScope(
        accountId,
        q.workspace,
        parseIntList(q.repoIds),
      );
      return getBotSeverityRollup(accountId, scope, isSeverityApiConfigured());
    },
  );
}
