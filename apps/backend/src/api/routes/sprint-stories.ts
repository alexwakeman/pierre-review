import type { FastifyInstance } from 'fastify';
import {
  SPRINT_REPOS_PER_TICKET_MAX,
  type SprintReposResponse,
  type SprintStoriesResponse,
} from '@pierre-review/shared';
import { config } from '../../config.js';
import { resolveWorkspaceScope } from '../../db/queries.js';
import { suggestSprintRepos, suggestTicketOf } from '../../db/sprint-repo-suggest.js';
import { readSprintTicket } from '../../db/sprint-store.js';
import { getSprintStories } from '../../db/sprint-stories.js';
import { setSprintRepos } from '../../db/sprint-ticket-repos.js';
import { accountIdOf } from '../plugins/auth.js';
import { reportsEntitled } from './insights.js';

// REPORTS → THIS SPRINT — the CORE read routes (both modes; docs/API.md § This sprint). Nothing
// agentic lives here: the assessment's routes are review/sprint-assess/routes.ts (local only) and the
// write-back's are tracker/write/routes.ts. Pro with the rest of Reports: `reportsEntitled` false →
// 402 BEFORE any DB work. The workspace goes through `resolveWorkspaceScope`: absent / unknown /
// another tenant's id ⇒ the caller's Default, never a 404.
//
//   GET /api/sprint-stories?workspace=<id>   the list (DB only; stamps the view, kicks a due read)  → read
//   PUT /api/sprint-stories/repos            replace ONE ticket's accepted candidate repos          → read

const PRO_REQUIRED = { error: 'pro required' } as const;
const IDENT_MAX = 600;

type ErrorBody = { error: string; message?: string };

export async function sprintStoriesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/sprint-stories', async (req, reply): Promise<SprintStoriesResponse | ErrorBody> => {
    if (!reportsEntitled(req)) {
      reply.status(402);
      return PRO_REQUIRED;
    }
    const q = req.query as { workspace?: string };
    const accountId = accountIdOf(req);
    const scope = await resolveWorkspaceScope(accountId, q.workspace);
    return getSprintStories(accountId, scope.workspaceId, { aiEnabled: config.aiEnabled, now: Date.now() });
  });

  app.put('/api/sprint-stories/repos', async (req, reply): Promise<SprintReposResponse | ErrorBody> => {
    if (!reportsEntitled(req)) {
      reply.status(402);
      return PRO_REQUIRED;
    }
    const body = (req.body ?? {}) as { workspaceId?: unknown; ident?: unknown; repoIds?: unknown };
    if (
      typeof body.workspaceId !== 'number' ||
      !Number.isSafeInteger(body.workspaceId) ||
      typeof body.ident !== 'string' ||
      body.ident === '' ||
      body.ident.length > IDENT_MAX ||
      !Array.isArray(body.repoIds) ||
      !body.repoIds.every((id) => typeof id === 'number' && Number.isSafeInteger(id) && id > 0)
    ) {
      reply.status(400);
      return { error: 'bad_request', message: 'Send a workspaceId, a ticket and a list of repo ids.' };
    }
    const repoIds = [...new Set(body.repoIds as number[])];
    if (repoIds.length > SPRINT_REPOS_PER_TICKET_MAX) {
      reply.status(400);
      return { error: 'too_many', message: `Choose at most ${SPRINT_REPOS_PER_TICKET_MAX} repos.` };
    }
    const ident = body.ident;
    const accountId = accountIdOf(req);
    const scope = await resolveWorkspaceScope(accountId, body.workspaceId);
    const ticket = await readSprintTicket(accountId, scope.workspaceId, ident);
    if (ticket == null) {
      reply.status(404);
      return { error: 'no_ticket', message: 'This ticket is not in the sprint list.' };
    }
    // 'suggested' = the id was one of the ticket's current suggestions (a one-click accept).
    // Computed with NO accepted exclusion, so a kept repo that was accepted from a suggestion stays
    // 'suggested' across a replace.
    const suggested = (await suggestSprintRepos(accountId, scope.workspaceId, [suggestTicketOf(ticket)], new Map())).get(ident) ?? [];
    const suggestedIds = new Set(suggested.map((s) => s.repoId));
    const res = await setSprintRepos(accountId, scope.workspaceId, ident, repoIds, (id) =>
      suggestedIds.has(id) ? 'suggested' : 'manual',
    );
    if (!res.ok) {
      reply.status(res.error === 'no_ticket' ? 404 : 400);
      return {
        error: res.error,
        message:
          res.error === 'bad_repo'
            ? 'Choose repos from this workspace.'
            : res.error === 'too_many'
              ? `Choose at most ${SPRINT_REPOS_PER_TICKET_MAX} repos.`
              : 'This ticket is not in the sprint list.',
      };
    }
    return { workspaceId: scope.workspaceId, ident, accepted: res.accepted };
  });
}
