import type { FastifyInstance } from 'fastify';
import type { SprintRefreshResponse, TrackerProvider } from '@pierre-review/shared';
import { resolveRequestWorkspaceId, type TrackerContext } from '../context.js';
import { sprintReadErrorMessage } from './read.js';

// POST /api/sprint-stories/refresh {workspaceId} — "read this workspace's sprint list again now".
// Core, both modes, FREE on every tier (This Sprint left Reports; no `periodReports` 402). The
// workspace resolves the `?workspace=` way — an unknown or another tenant's id falls to the caller's
// Default, never a 404. It stamps the demand
// gate, marks the list due and kicks the read (fire-and-forget); it never waits on the tracker.
// Rate-limit tier: the integrator's table (spec §6) — it can start a tracker read.

export function registerSprintReadRoutes(app: FastifyInstance, ctx: TrackerContext): void {
  app.post('/api/sprint-stories/refresh', async (req, reply): Promise<SprintRefreshResponse | { error: string; message?: string }> => {
    const body = (req.body ?? {}) as { workspaceId?: unknown };
    if (body.workspaceId != null && (typeof body.workspaceId !== 'number' || !Number.isSafeInteger(body.workspaceId))) {
      reply.status(400);
      return { error: 'bad_request', message: 'Send a workspaceId.' };
    }
    const accountId = ctx.accountIdOf(req);
    const workspaceId = await resolveRequestWorkspaceId(ctx, accountId, body.workspaceId as number | undefined);
    // LAZY: db/sprint-store opens the core database at import; this module must not.
    const store = await import('../../db/sprint-store.js');
    await store.noteSprintViewed(accountId, workspaceId);
    await store.markSprintReadDue(accountId, workspaceId);
    store.kickSprintRead(accountId, workspaceId);
    const row = await store.readSprintRead(accountId, workspaceId);
    reply.status(202);
    return {
      workspaceId,
      read: store.sprintReadStateOf(row, (code) => sprintReadErrorMessage((row?.provider as TrackerProvider | null) ?? null, code)),
    };
  });
}
