import type { FastifyInstance } from 'fastify';
import {
  STORY_LABEL_RUN_CAP,
  type StoryLabelRunErrorBody,
  type StoryLabelRunResponse,
} from '@pierre-review/shared';
import { config } from '../../config.js';
import { resolveWorkspaceScope } from '../../db/queries.js';
import { loadStoryHealthInputs } from '../../db/story-health.js';
import { storiesToLabel } from '../../db/story-health-fold.js';
import type { AgentContext } from '../agent-context.js';
import {
  cancelStoryLabelRun,
  claimStoryLabelRun,
  releaseStoryLabelRun,
  startStoryLabelRun,
  storyLabelRunOf,
  storyLabelRunningId,
} from './manager.js';

// THE STORY LABEL RUN'S ROUTES (docs/API.md § Story labels; docs/CLAUDE-REVIEW.md § Story labels). The
// paths keep the retired Story health prefix. Registered ONLY through `registerAgenticRoutes` — its
// explicit `isCloud` check is the cloud guarantee (these 404 there). The body's workspace goes through
// `resolveWorkspaceScope`: an unknown or another tenant's id falls to the caller's Default, never 404.
//
//   POST /api/story-health/label {workspaceId}  label up to STORY_LABEL_RUN_CAP stories → ai + ai_hourly
//   GET  /api/story-health/label                 the account's run (or its last one)    → read
//   POST /api/story-health/label/cancel          stop starting calls; spends nothing    → read

export function registerStoryLabelRoutes(app: FastifyInstance, ctx: AgentContext): void {
  app.post(
    '/api/story-health/label',
    async (req, reply): Promise<StoryLabelRunResponse | StoryLabelRunErrorBody | { error: string }> => {
      const body = (req.body ?? {}) as { workspaceId?: unknown };
      if (typeof body.workspaceId !== 'number' || !Number.isSafeInteger(body.workspaceId)) {
        reply.status(400);
        return { error: 'bad_request', message: 'Send a workspaceId.' };
      }
      const accountId = ctx.accountIdOf(req);
      // ⚠ CLAIMED HERE, BEFORE THE FIRST AWAIT — two POSTs cannot both start a billed run.
      if (!claimStoryLabelRun(accountId)) {
        const runningId = storyLabelRunningId(accountId);
        reply.status(409);
        return {
          error: 'busy',
          message: 'Stories are already being labelled.',
          ...(runningId != null ? { runningId } : {}),
        };
      }
      let handedOff = false;
      try {
        const scope = await resolveWorkspaceScope(accountId, body.workspaceId);
        const inputs = await loadStoryHealthInputs(accountId, scope, Date.now());
        if (!inputs.trackerOn) {
          reply.status(400);
          return { error: 'no_tracker', message: 'This workspace has no issue tracker.' };
        }
        const todo = storiesToLabel(inputs.stories, inputs.weeks)
          .slice(0, STORY_LABEL_RUN_CAP)
          .flatMap((s) => (s.input != null ? [{ ident: s.ident, input: s.input }] : []));
        if (todo.length === 0) {
          reply.status(422);
          return { error: 'nothing_to_label', message: 'Every story with criteria is already labelled.' };
        }
        const run = startStoryLabelRun(ctx, {
          accountId,
          workspaceId: scope.workspaceId,
          stories: todo,
          budgetUsd: config.storyLabelBudgetUsd,
        });
        handedOff = true;
        reply.status(202);
        return { run };
      } finally {
        if (!handedOff) releaseStoryLabelRun(accountId);
      }
    },
  );

  app.get('/api/story-health/label', async (req): Promise<StoryLabelRunResponse> => {
    return { run: storyLabelRunOf(ctx.accountIdOf(req)) };
  });

  app.post('/api/story-health/label/cancel', async (req): Promise<StoryLabelRunResponse> => {
    return { run: cancelStoryLabelRun(ctx.accountIdOf(req)) };
  });
}
