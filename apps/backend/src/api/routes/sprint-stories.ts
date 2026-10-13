import type { FastifyInstance } from 'fastify';
import {
  SPRINT_REPOS_PER_TICKET_MAX,
  type SprintGraphResponse,
  type SprintReposResponse,
  type SprintStatusesResponse,
  type SprintTicketDetailResponse,
} from '@pierre-review/shared';
import { config } from '../../config.js';
import { resolveWorkspaceScope } from '../../db/queries.js';
import { getSprintGraph, getSprintTicketDetail } from '../../db/sprint-graph.js';
import { resolveSprintStatusLayout, sprintLayoutFor } from '../../db/sprint-status-layout.js';
import { parseSprintStatusSettings, setSprintStatusSettings } from '../../db/sprint-status-settings.js';
import { suggestSprintRepos, suggestTicketOf } from '../../db/sprint-repo-suggest.js';
import { readSprintTicket } from '../../db/sprint-store.js';
import { setSprintRepos } from '../../db/sprint-ticket-repos.js';
import { accountIdOf } from '../plugins/auth.js';
import { reportsEntitled } from './insights.js';

// REPORTS → THIS SPRINT — the CORE routes (both modes; docs/API.md § This sprint). Nothing agentic
// lives here: "Check against code" is review/sprint-assess/routes.ts and "Ask Claude about this
// sprint" review/sprint-ask/routes.ts (local only). Nothing here, or anywhere, writes to a tracker.
// Pro with the rest of Reports: `reportsEntitled` false → 402 BEFORE any DB work. The workspace goes
// through `resolveWorkspaceScope`: absent / unknown / another tenant's id ⇒ the caller's Default,
// never a 404.
//
//   GET /api/sprint-graph?workspace=<id>                the graph (DB only; stamps the view, kicks a due read) → read
//   GET /api/sprint-graph/ticket?workspace=<id>&ident=  the drawer for one node (DB only)                    → read
//   PUT /api/sprint-stories/repos                       replace ONE ticket's accepted candidate repos        → read
//   PUT /api/sprint-stories/statuses                    replace the workspace's status stages and order      → read

const PRO_REQUIRED = { error: 'pro required' } as const;
const IDENT_MAX = 600;

type ErrorBody = { error: string; message?: string };

export async function sprintStoriesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/sprint-graph', async (req, reply): Promise<SprintGraphResponse | ErrorBody> => {
    if (!reportsEntitled(req)) {
      reply.status(402);
      return PRO_REQUIRED;
    }
    const q = req.query as { workspace?: string };
    const accountId = accountIdOf(req);
    const scope = await resolveWorkspaceScope(accountId, q.workspace);
    return getSprintGraph(accountId, scope.workspaceId, { aiEnabled: config.aiEnabled, now: Date.now() });
  });

  // The drawer: one node's brief, references, PRs (the ticket tab's fold), repos and assessment. An
  // ident that is not a node answers `found: false` — never a 404.
  app.get('/api/sprint-graph/ticket', async (req, reply): Promise<SprintTicketDetailResponse | ErrorBody> => {
    if (!reportsEntitled(req)) {
      reply.status(402);
      return PRO_REQUIRED;
    }
    const q = req.query as { workspace?: string; ident?: string };
    const ident = typeof q.ident === 'string' ? q.ident : '';
    if (ident === '' || ident.length > IDENT_MAX) {
      reply.status(400);
      return { error: 'bad_request', message: 'Send a ticket.' };
    }
    const accountId = accountIdOf(req);
    const scope = await resolveWorkspaceScope(accountId, q.workspace);
    // LAZY: tracker/runtime.ts opens the DB at import.
    const [{ trackerContext }, { ticketPrs }] = await Promise.all([import('../../tracker/runtime.js'), import('../../tracker/ticket-prs.js')]);
    return getSprintTicketDetail(accountId, scope.workspaceId, ident, {
      aiEnabled: config.aiEnabled,
      now: Date.now(),
      prsOf: (i) => ticketPrs(trackerContext(), accountId, scope.workspaceId, i),
    });
  });

  // The status layout override (shared `SprintStatusesUpdate`). ⚠ Status names belong to ONE
  // workspace's tracker, so an id that does not resolve to itself (unknown, another tenant's) is
  // refused rather than written onto the caller's Default.
  app.put('/api/sprint-stories/statuses', async (req, reply): Promise<SprintStatusesResponse | ErrorBody> => {
    if (!reportsEntitled(req)) {
      reply.status(402);
      return PRO_REQUIRED;
    }
    const body = (req.body ?? {}) as { workspaceId?: unknown; settings?: unknown };
    const settings = parseSprintStatusSettings(body.settings, true);
    if (typeof body.workspaceId !== 'number' || !Number.isSafeInteger(body.workspaceId) || settings == null) {
      reply.status(400);
      return { error: 'bad_request', message: 'Send a workspaceId and the status settings.' };
    }
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
