import type { FastifyInstance } from 'fastify';
import {
  sprintAssessModeOf,
  type SprintAssessErrorBody,
  type SprintAssessResponse,
  type SprintAssessmentResponse,
} from '@pierre-review/shared';
import { resolveWorkspaceScope } from '../../db/queries.js';
import { currentSprintBriefs, sprintBriefInput, sprintCriteriaOf } from '../../db/sprint-briefs.js';
import { readSprintTicket, sprintAssessmentRecordOf } from '../../db/sprint-store.js';
import { sprintTicketStage } from '../../db/sprint-stories.js';
import { acceptedSprintRepoDetails } from '../../db/sprint-ticket-repos.js';
import type { AgentContext } from '../agent-context.js';
import {
  cancelSprintAssessment,
  claimSprintAssessSlot,
  loadSprintAssessment,
  releaseSprintAssessSlot,
  runningSprintAssessmentId,
  sprintAssessmentCurrency,
  startSprintAssessment,
} from './manager.js';

// THE SPRINT ASSESSMENT'S ROUTES (docs/API.md § This sprint; docs/CLAUDE-REVIEW.md § Sprint
// assessment). Registered ONLY through `registerAgenticRoutes` — its explicit `isCloud` check is the
// cloud guarantee (these routes 404 there). Free like the rest of This Sprint — agentic, so never a
// Pro gate. The workspace goes through `resolveWorkspaceScope`: an unknown or another tenant's id
// degrades to the caller's Default, never a 404.
//
//   POST /api/sprint-stories/assess                {workspaceId, ident}   the ONLY path that runs the model → ai + ai_hourly
//   GET  /api/sprint-stories/assessments/:id       one run (the SPA polls while in flight)                → read
//   POST /api/sprint-stories/assessments/:id/cancel abort; spends nothing more                            → read

const IDENT_MAX = 600;

const parseId = (raw: unknown): number | null => {
  const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

export function registerSprintAssessRoutes(app: FastifyInstance, ctx: AgentContext): void {
  app.post(
    '/api/sprint-stories/assess',
    async (req, reply): Promise<SprintAssessResponse | SprintAssessErrorBody | { error: string }> => {
      const body = (req.body ?? {}) as { workspaceId?: unknown; ident?: unknown };
      if (
        typeof body.workspaceId !== 'number' ||
        !Number.isSafeInteger(body.workspaceId) ||
        typeof body.ident !== 'string' ||
        body.ident === '' ||
        body.ident.length > IDENT_MAX
      ) {
        reply.status(400);
        return { error: 'bad_request', message: 'Send a workspaceId and a ticket.' };
      }
      const ident = body.ident;
      const accountId = ctx.accountIdOf(req);
      // ⚠ THE SLOT IS CLAIMED HERE, BEFORE THE FIRST AWAIT — two clicks cannot both start a run.
      if (!claimSprintAssessSlot(accountId, ident)) {
        const runningId = await runningSprintAssessmentId(accountId, ident);
        reply.status(409);
        return {
          error: 'busy',
          message: 'This ticket is already being assessed.',
          ...(runningId != null ? { runningId } : {}),
        };
      }
      let handedOff = false;
      try {
        const scope = await resolveWorkspaceScope(accountId, body.workspaceId);
        const ticket = await readSprintTicket(accountId, scope.workspaceId, ident);
        if (ticket == null || !ticket.inSprint) {
          reply.status(404);
          return { error: 'no_ticket', message: 'This ticket is not in the sprint list.' };
        }
        const repos = (await acceptedSprintRepoDetails(accountId, scope.workspaceId, [ident])).get(ident) ?? [];
        if (repos.length === 0) {
          reply.status(422);
          return { error: 'no_repos', message: 'Choose at least one repo first.' };
        }
        // THE CRITERIA are the ticket's CURRENT BRIEF (itemised, derived from the description when the
        // ticket has none); with no current brief, the ticket's own as written. [] is allowed.
        const provider = ticket.provider as 'jira' | 'github' | 'linear';
        const brief = (
          await currentSprintBriefs(accountId, scope.workspaceId, [{ ident, input: sprintBriefInput(ticket, provider) }])
        ).get(ident);
        const criteria =
          brief != null && brief.criteria.length > 0
            ? brief.criteria.map((c) => c.text)
            : sprintCriteriaOf({ description: ticket.description ?? '', acceptanceCriteria: ticket.acceptanceCriteria ?? '' }, provider).items;
        const criteriaDerived = brief != null && brief.criteria.length > 0 && brief.criteriaDerived;
        // THE MODE IS THE SERVER'S: plan (not started / in progress) or verify (in review / done), from
        // the stored ticket's stage under the workspace's status layout.
        const mode = sprintAssessModeOf(await sprintTicketStage(accountId, scope.workspaceId, ticket));
        const record = await startSprintAssessment(ctx, {
          accountId,
          workspaceId: scope.workspaceId,
          ident,
          ticket,
          criteria,
          criteriaDerived,
          repos,
          mode,
        });
        handedOff = true;
        reply.status(202);
        return { assessment: record };
      } finally {
        if (!handedOff) releaseSprintAssessSlot(accountId, ident);
      }
    },
  );

  app.get(
    '/api/sprint-stories/assessments/:id',
    async (req, reply): Promise<SprintAssessmentResponse | { error: string }> => {
      const id = parseId((req.params as { id?: string }).id);
      const accountId = ctx.accountIdOf(req);
      const row = id != null ? await loadSprintAssessment(accountId, id) : null;
      if (row == null) {
        reply.status(404);
        return { error: 'not_found' };
      }
      return { assessment: sprintAssessmentRecordOf(row), currency: await sprintAssessmentCurrency(accountId, row) };
    },
  );

  app.post(
    '/api/sprint-stories/assessments/:id/cancel',
    async (req, reply): Promise<SprintAssessmentResponse | { error: string }> => {
      const id = parseId((req.params as { id?: string }).id);
      const accountId = ctx.accountIdOf(req);
      const row = id != null ? await cancelSprintAssessment(accountId, id) : null;
      if (row == null) {
        reply.status(404);
        return { error: 'not_found' };
      }
      return { assessment: sprintAssessmentRecordOf(row), currency: await sprintAssessmentCurrency(accountId, row) };
    },
  );
}
