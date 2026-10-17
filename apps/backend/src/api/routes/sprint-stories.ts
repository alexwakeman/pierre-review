import type { FastifyInstance } from 'fastify';
import { type SprintGraphResponse, type SprintStatusesResponse, type TicketStoryResponse } from '@pierre-review/shared';
import { config } from '../../config.js';
import { resolveWorkspaceScope } from '../../db/queries.js';
import { getSprintGraph, getTicketStory } from '../../db/sprint-graph.js';
import { resolveSprintStatusLayout, sprintLayoutFor } from '../../db/sprint-status-layout.js';
import { parseSprintStatusSettingsStrict, setSprintStatusSettings } from '../../db/sprint-status-settings.js';
import { accountIdOf } from '../plugins/auth.js';

// THIS SPRINT (its own Activity rail line) — the CORE routes (both modes; docs/API.md § This sprint).
// Nothing agentic lives here: "Ask Claude about this sprint" is review/sprint-ask/routes.ts (local
// only). Nothing here, or anywhere, writes to a
// tracker. FREE on every tier — no `periodReports` 402 (it left Reports). The workspace goes
// through `resolveWorkspaceScope`: absent / unknown / another tenant's id ⇒ the caller's Default,
// never a 404.
//
//   GET /api/sprint-graph?workspace=<id>                the graph (DB only; stamps the view, kicks a due read) → read
//   GET /api/ticket-story?workspace=<id>&ident=         the story view: one ticket's sprint text + brief     → read
//   PUT /api/sprint-stories/statuses                    replace the workspace's status buckets               → read

const IDENT_MAX = 600;

type ErrorBody = { error: string; message?: string };

export async function sprintStoriesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/sprint-graph', async (req): Promise<SprintGraphResponse> => {
    const q = req.query as { workspace?: string };
    const accountId = accountIdOf(req);
    const scope = await resolveWorkspaceScope(accountId, q.workspace);
    // A builder pass needs a credential too; without one `pathsStatus` would promise paths for ever.
    const pathsCanRun = config.aiEnabled && (await import('../../review/auth.js')).detectClaudeAuth().status === 'ok';
    return getSprintGraph(accountId, scope.workspaceId, { aiEnabled: config.aiEnabled, now: Date.now(), pathsCanRun });
  });

  // The STORY VIEW's lean read: one ticket's stored sprint text and its CURRENT brief (no graph fold,
  // no PRs — those are GET /api/ticket-prs). Not one Limn holds → `found: false`, never a 404.
  app.get('/api/ticket-story', async (req, reply): Promise<TicketStoryResponse | ErrorBody> => {
    const q = req.query as { workspace?: string; ident?: string };
    const ident = typeof q.ident === 'string' ? q.ident : '';
    if (ident === '' || ident.length > IDENT_MAX) {
      reply.status(400);
      return { error: 'bad_request', message: 'Send a ticket.' };
    }
    const accountId = accountIdOf(req);
    const scope = await resolveWorkspaceScope(accountId, q.workspace);
    return getTicketStory(accountId, scope.workspaceId, ident, { aiEnabled: config.aiEnabled });
  });

  // The status buckets override (shared `SprintStatusesUpdate`). ⚠ Status names belong to ONE
  // workspace's tracker, so an id that does not resolve to itself (unknown, another tenant's) is
  // refused rather than written onto the caller's Default.
  app.put('/api/sprint-stories/statuses', async (req, reply): Promise<SprintStatusesResponse | ErrorBody> => {
    const body = (req.body ?? {}) as { workspaceId?: unknown; settings?: unknown };
    if (typeof body.workspaceId !== 'number' || !Number.isSafeInteger(body.workspaceId)) {
      reply.status(400);
      return { error: 'bad_request', message: 'Send a workspaceId and the status settings.' };
    }
    // The problem in plain words (shared `sprintBucketsProblem`) is the message the editor shows.
    const parsed = parseSprintStatusSettingsStrict(body.settings);
    if (!parsed.ok) {
      reply.status(400);
      return { error: 'bad_request', message: parsed.message };
    }
    const settings = parsed.settings;
    const accountId = accountIdOf(req);
    const scope = await resolveWorkspaceScope(accountId, String(body.workspaceId));
    if (scope.workspaceId !== body.workspaceId) {
      reply.status(400);
      return { error: 'bad_workspace', message: 'This workspace was not found.' };
    }
    await setSprintStatusSettings(accountId, scope.workspaceId, settings);
    // Never read yet: the layout is the settings over nothing (no site to name statuses on).
    const statusLayout =
      (await sprintLayoutFor(accountId, scope.workspaceId)) ??
      resolveSprintStatusLayout({ autoOrder: null, settings, tickets: [], evidence: new Map() });
    return { workspaceId: scope.workspaceId, settings: statusLayout.settings, statusLayout };
  });
}
