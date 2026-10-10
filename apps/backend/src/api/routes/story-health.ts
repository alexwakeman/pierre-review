import type { FastifyInstance } from 'fastify';
import type { StoryHealthResponse } from '@pierre-review/shared';
import { config } from '../../config.js';
import { accountIdOf } from '../plugins/auth.js';
import { resolveWorkspaceScope } from '../../db/queries.js';
import { getStoryHealth } from '../../db/story-health.js';
import { runningStoryLabelRun } from '../../review/story-labels/manager.js';
import { reportsEntitled } from './insights.js';

// GET /api/story-health?workspace=<id> — Reports → Stories → Story health (docs/API.md § Story
// health). CORE, registered in both modes. Pro with the rest of Reports (`periodReports`): 402 BEFORE
// any DB work, identical for every workspace (no oracle). The workspace goes through
// `resolveWorkspaceScope` (unknown / another tenant's → Default, never 404) and is echoed.
//
// `labels` is `config.aiEnabled`: false in cloud and under LIMN_AI_DISABLED, and then every model-made
// series is OMITTED (labels are written only by the local agentic run). Code series always render.
// DB-only, no GitHub, no tracker, no model — the `read` tier.

export async function storyHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/story-health', async (req, reply): Promise<StoryHealthResponse | { error: string }> => {
    if (!reportsEntitled(req)) {
      reply.status(402);
      return { error: 'pro required' };
    }
    const q = req.query as { workspace?: string };
    const accountId = accountIdOf(req);
    const scope = await resolveWorkspaceScope(accountId, q.workspace);
    return getStoryHealth(accountId, scope, Date.now(), {
      labels: config.aiEnabled,
      labelRun: config.aiEnabled ? runningStoryLabelRun(accountId) : null,
    });
  });
}
