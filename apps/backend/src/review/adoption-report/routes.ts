import type { FastifyInstance } from 'fastify';
import { ADOPTION_COMMENTARY_SLIDES, type AdoptionCommentaryResponse, type AdoptionCommentarySlide } from '@pierre-review/shared';
import { config } from '../../config.js';
import { resolveWorkspaceScope } from '../../db/queries.js';
import type { AgentContext } from '../agent-context.js';
import { AiRuntimeMissingError } from '../../ai/runtime.js';
import { either, providerName } from '../../ai/prompt-tools.js';
import type { CompleteFn } from '../story-labels/manager.js';
import { writeAdoptionCommentary } from './commentary.js';

// POST /api/reports/ai-adoption/commentary {workspaceId, slide, generatedAt} → AdoptionCommentaryResponse
// (docs/AI-ADOPTION-REPORT.md § Routes; docs/CLAUDE-REVIEW.md § The adoption report's commentary).
//
// Registered ONLY through `registerAgenticRoutes` (and 404 under the kill switch). ONE one-shot
// completion per slide through the core cheap seam (`cheapComplete` → ai/provider.ts; the WRITING RULES
// are added at the provider door). The reader's click: no `automaticRunAllowed` (the SPA's
// `AiRunGate kind="complete"` handles the over-budget two-press). Cost recorded (`recordAiUsage`,
// feature 'adoption_report') on every completed call, accepted or refused.
//
// ⚠ NEVER TRUSTS THE CLIENT'S FIGURES: the report is read from the GET's memo by `generatedAt` (each
//   read renews its TTL). A miss NEVER recomputes — that would rerun the whole fold for every later
//   slide and write about figures the PDF may not show — it answers `{source: 'fallback', reason:
//   'stale'}` with no call, and the SPA uses the template. The model sees the slide's figure table only (no person, login, repo,
//   workspace name or "Prepared for").
// Rate tier: ai + ai_hourly (`tierFor`). A download makes at most eight calls.

let completeOverride: CompleteFn | null = null;
/** Tests inject a fake completion (never a real model call); null restores `cheapComplete`. */
export function setAdoptionCommentaryCompleteForTests(fn: CompleteFn | null): void {
  completeOverride = fn;
}

const SLIDES: ReadonlySet<string> = new Set(ADOPTION_COMMENTARY_SLIDES);

export function registerAdoptionReportRoutes(app: FastifyInstance, ctx: AgentContext): void {
  app.post(
    '/api/reports/ai-adoption/commentary',
    async (req, reply): Promise<AdoptionCommentaryResponse | { error: string; message?: string }> => {
      if (!config.aiEnabled) {
        reply.status(404);
        return { error: 'not_found' };
      }
      const body = (req.body ?? {}) as { workspaceId?: unknown; slide?: unknown; generatedAt?: unknown };
      if (
        typeof body.workspaceId !== 'number' ||
        !Number.isSafeInteger(body.workspaceId) ||
        typeof body.slide !== 'string' ||
        !SLIDES.has(body.slide) ||
        typeof body.generatedAt !== 'string' ||
        body.generatedAt.length > 40
      ) {
        reply.status(400);
        return { error: 'bad_request', message: 'Send a workspaceId, a slide and the report’s generatedAt.' };
      }
      const slide = body.slide as AdoptionCommentarySlide;
      const auth = ctx.llm.detectAuth('complete');
      if (auth.status !== 'ok') {
        reply.status(503);
        return { error: 'no_credential', message: either('No Claude login or API key found.', auth.message ?? 'Codex is not signed in.') };
      }
      const accountId = ctx.accountIdOf(req);
      const { workspaceId } = await resolveWorkspaceScope(accountId, body.workspaceId);
      const { adoptionReportFor } = await import('../../api/routes/adoption-report.js');
      const report = adoptionReportFor(accountId, workspaceId, body.generatedAt);
      if (report == null) return { slide, source: 'fallback', reason: 'stale' };
      try {
        const complete = completeOverride ?? (await import('../llm.js')).cheapComplete;
        return await writeAdoptionCommentary(report, slide, {
          complete,
          record: (u) =>
            ctx
              .recordAiUsage({ accountId, seam: 'summary', feature: 'adoption_report', ...u })
              .catch((err) => ctx.log.warn({ err }, 'adoption report commentary: usage record failed')),
          onRejected: (problems) => ctx.log.debug?.({ slide, problems }, 'adoption report commentary: text refused, template used'),
        });
      } catch (err) {
        if (err instanceof AiRuntimeMissingError) {
          reply.status(503);
          return { error: 'runtime', message: err.message };
        }
        ctx.log.warn({ accountId, slide, err: String(err).slice(0, 200) }, 'adoption report commentary: completion failed');
        reply.status(502);
        return { error: 'failed', message: `${providerName()} could not write this slide. The template wording is used.` };
      }
    },
  );
}
