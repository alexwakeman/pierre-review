import type { FastifyInstance } from 'fastify';
import type {
  AnnotationKind,
  AnnotationRunBody,
  AnnotationRunResponse,
  PrAnnotationsResponse,
} from '@pierre-review/shared';
import type { ProContext } from '../contract.js';
import type { LlmClient } from '../llm/seam.js';
import { loadPrCorpus } from './targets.js';
import {
  emptyResult,
  projectAnnotations,
  readPrAnnotationRows,
  runAnnotations,
} from './runner.js';

// The blast-radius IMPACT NOTE's two routes — the one kind left on the annotations platform. Both
// are account-scoped through the PR → accountId join inside loadPrCorpus (a foreign or unknown PR
// id → 404, never a 200 with someone else's note).
//
//   GET  /api/pro/prs/:id/annotations       — a PURE CACHED READ. No generation, no billing.
//   POST /api/pro/prs/:id/annotations/run   — the ONE billing path. Body `{kind: 'impact'}`.
//
// (The per-comment validity / addressed /
// simplify kinds and the "Check review" run are REMOVED; their stored rows are DORMANT and the read
// skips them.)

const KINDS: ReadonlySet<string> = new Set<AnnotationKind>(['impact']);

const ZERO_COUNTS: Record<AnnotationKind, number> = { impact: 0 };

function emptyResponse(prId: number): PrAnnotationsResponse {
  return {
    prId,
    annotations: [],
    counts: { ...ZERO_COUNTS },
    staleCount: 0,
    generatedAt: new Date().toISOString(),
  };
}

function parseId(raw: string): number | null {
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function registerAnnotationRoutes(
  app: FastifyInstance,
  ctx: ProContext,
  llm: LlmClient,
): void {
  // ---- cached read -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/api/pro/prs/:id/annotations',
    async (req, reply): Promise<PrAnnotationsResponse> => {
      const prId = parseId(req.params.id);
      if (prId == null) return reply.code(400).send(emptyResponse(0));
      const accountId = ctx.accountIdOf(req);

      const corpus = await loadPrCorpus(ctx, accountId, prId);
      if (corpus == null) return reply.code(404).send(emptyResponse(prId));

      const rows = await readPrAnnotationRows(ctx, accountId, prId, [...KINDS]);
      const { annotations, counts, staleCount } = projectAnnotations(corpus, rows);
      return reply.send({
        prId,
        annotations,
        counts,
        staleCount,
        generatedAt: new Date().toISOString(),
      });
    },
  );

  // ---- run (JSON) --------------------------------------------------------------------------
  app.post<{ Params: { id: string }; Body: Partial<AnnotationRunBody> }>(
    '/api/pro/prs/:id/annotations/run',
    async (req, reply): Promise<AnnotationRunResponse> => {
      const prId = parseId(req.params.id);
      const kind =
        typeof req.body?.kind === 'string' && KINDS.has(req.body.kind)
          ? (req.body.kind as AnnotationKind)
          : null;
      if (prId == null || kind == null) return reply.code(400).send(emptyResult());
      const accountId = ctx.accountIdOf(req);

      // A client that disconnects mid-run must not leave the billing call running.
      //
      // WATCH THE REPLY, NOT THE REQUEST. `req.raw`'s 'close' fires as soon as Fastify has finished
      // reading this POST's body, so a flag wired to it is permanently true. `reply.raw`'s 'close'
      // stays false while the client waits and fires when the client goes away.
      let aborted = false;
      reply.raw.on('close', () => {
        aborted = true;
      });

      const outcome = await runAnnotations(ctx, llm, accountId, prId, kind, {
        shouldStop: () => aborted,
      });
      if (outcome == null) return reply.code(404).send(emptyResult(kind));
      if ('gate' in outcome) {
        // The gate REASON reaches the button only through `message`.
        return reply
          .code(429)
          .header('Retry-After', '30')
          .send({
            ...emptyResult(kind),
            message:
              outcome.gate === 'in_flight'
                ? 'Another impact read is already running.'
                : 'Just ran — try again in a moment.',
          });
      }
      return reply.send(outcome.result);
    },
  );
}
