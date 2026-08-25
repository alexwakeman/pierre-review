import type { FastifyInstance } from 'fastify';
import type { MlEnrichmentStatus, PrMlLabelsResponse } from '@pierre-review/shared';
import {
  getMlBacklogForAccount,
  getPrMlLabels,
  type MlBacklog,
} from '../../db/ml-labels.js';
import { isSeverityApiConfigured } from '../../ml/severity-client.js';
import { getMlEnrichmentState } from '../../sync/ml-enrichment.js';
import { accountIdOf } from '../plugins/auth.js';

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

  // (GET /api/bot-severity — the standalone Bots-interface severity rollup — was REMOVED on the
  // C7 cut list: no SPA consumer since the merged Bots ROI table took its fold off
  // `getBotAnalytics`. `getBotSeverityRollup` itself stays in db/ml-labels.ts — its exclusion
  // semantics are the pinned reference the windowed twin declares itself VERBATIM-equal to.)

  // Live state of the background enrichment worker — what every sync surface polls so that
  // "sync complete" is not announced while the model is still scoring the text the walk just
  // fetched. See MlEnrichmentStatus in @pierre-review/shared for why the sync UI needs it.
  //
  // NO SCOPE PARAMETER, on purpose: the worker walks every workspace of the account, so a
  // workspace-scoped backlog would under-report exactly the work that is running.
  app.get(
    '/api/ml-status',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: {} } } },
    async (req): Promise<MlEnrichmentStatus> => {
      const accountId = accountIdOf(req);
      const enabled = isSeverityApiConfigured();
      const state = getMlEnrichmentState();
      // Skip the scan entirely when the feature is off: the client is polling only because it
      // cannot know that until it asks once, and the counts would be meaningless anyway.
      const backlog = enabled
        ? await cachedBacklog(accountId)
        : { pending: 0, unscorable: 0, labelled: 0 };
      const iso = (ms: number | null): string | null =>
        ms == null ? null : new Date(ms).toISOString();

      return {
        enabled,
        running: state.running,
        pending: backlog.pending,
        unscorable: backlog.unscorable,
        labelled: backlog.labelled,
        scoredThisRun: state.labelled,
        batchesThisRun: state.batches,
        failuresThisRun: state.failures,
        startedAt: iso(state.startedAt),
        finishedAt: iso(state.finishedAt),
        pausedUntil: iso(state.pausedUntil),
        serviceHealthy: state.serviceHealthy,
        markerFallback: state.markerFallback,
        generatedAt: new Date().toISOString(),
      };
    },
  );
}

// ---- Backlog cache ----
//
// This route is POLLED — every few seconds while a sync round is open — and its backlog is a
// bot-set resolve plus three indexed counts PER WORKSPACE. The counts move only when the worker
// writes (at most a batch every few seconds) or a sync lands, so serving a couple of seconds of
// staleness costs the reader nothing and stops N pollers from multiplying the scan. A rate-limit
// tier alone would not help: it caps requests, not the work each one does.
const BACKLOG_TTL_MS = 3_000;
const backlogCache = new Map<number, { at: number; value: Promise<MlBacklog> }>();

function cachedBacklog(accountId: number): Promise<MlBacklog> {
  const hit = backlogCache.get(accountId);
  if (hit && Date.now() - hit.at < BACKLOG_TTL_MS) return hit.value;
  // Cache the PROMISE, not the resolved value, so concurrent polls that arrive while the scan
  // is still running share it instead of each starting their own.
  const value = getMlBacklogForAccount(accountId).catch((err) => {
    // A failed scan must not be cached as a permanent zero, and must not reject every waiter
    // repeatedly: drop the entry so the next poll retries, and report an honest empty backlog.
    backlogCache.delete(accountId);
    throw err;
  });
  backlogCache.set(accountId, { at: Date.now(), value });
  // Bounded: process-wide across tenants in cloud, so evict anything past the window.
  if (backlogCache.size > 1_000) {
    const cutoff = Date.now() - BACKLOG_TTL_MS;
    for (const [id, entry] of backlogCache) if (entry.at < cutoff) backlogCache.delete(id);
  }
  return value;
}
