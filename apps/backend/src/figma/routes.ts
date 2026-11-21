import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import type { FigmaConnectionCheck, WorkspaceFigmaSettings, WorkspaceFigmaUpdate } from '@pierre-review/shared';
import type { AgentContext } from '../review/agent-context.js';
import type { JiraTransport } from '../tracker/jira/fetch.js';
import { figmaClient, figmaErrorMessage, FigmaError } from './client.js';
import { readWorkspaceFigma, readWorkspaceFigmaToken, writeWorkspaceFigma, type FigmaDb } from './settings.js';

// FIGMA'S HTTP SURFACE (docs/IMPLEMENT-UI-PLAN.md § 3; contracts in docs/API.md). Rate-limit tiers by exact
// path in api/plugins/rate-limit.ts `tierFor`.
//
//   GET  /api/workspaces/:id/figma         the setting (404 if not yours). Never the token.
//   PUT  /api/workspaces/:id/figma         { token } or { clearToken: true }.
//   POST /api/workspaces/:id/figma/check   "Test token": ONE `GET /v1/me` with the SAVED token.

export interface FigmaRouteCtx extends FigmaDb {
  accountIdOf: (req: FastifyRequest) => number;
  log: AgentContext['log'];
  transport?: JiraTransport;
}

const idParam = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } } as const;
// ⚠ EVERY KEY LISTED (removeAdditional strips an unlisted one silently).
const putBody = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    token: { type: 'string', minLength: 1, maxLength: 4096, pattern: '^\\S+$' },
    clearToken: { type: 'boolean' },
  },
} as const;

const notFound = (reply: FastifyReply, id: number): FastifyReply => reply.code(404).send({ error: 'NotFound', message: `Workspace ${id} not found` });

async function ownedWorkspace(c: FigmaDb, accountId: number, id: number): Promise<number | null> {
  const w = c.schema.workspaces;
  const rows = (await c.db.select({ id: w.id }).from(w).where(and(eq(w.id, id), eq(w.accountId, accountId))).limit(1).execute()) as Array<{ id: number }>;
  return rows[0]?.id ?? null;
}

export function registerFigmaRoutes(app: FastifyInstance, ctx: FigmaRouteCtx): void {
  app.get<{ Params: { id: number } }>('/api/workspaces/:id/figma', { schema: { params: idParam } }, async (req, reply): Promise<WorkspaceFigmaSettings | FastifyReply> => {
    const accountId = ctx.accountIdOf(req);
    const ws = await ownedWorkspace(ctx, accountId, req.params.id);
    if (ws == null) return notFound(reply, req.params.id);
    return readWorkspaceFigma(ctx, accountId, ws);
  });

  app.put<{ Params: { id: number }; Body: WorkspaceFigmaUpdate }>('/api/workspaces/:id/figma', { schema: { params: idParam, body: putBody } }, async (req, reply): Promise<WorkspaceFigmaSettings | FastifyReply> => {
    const accountId = ctx.accountIdOf(req);
    const ws = await ownedWorkspace(ctx, accountId, req.params.id);
    if (ws == null) return notFound(reply, req.params.id);
    const res = await writeWorkspaceFigma(ctx, accountId, ws, req.body ?? {});
    if (!res.ok) return reply.code(400).send({ error: 'InvalidFigmaSettings', message: res.message });
    return res.settings;
  });

  app.post<{ Params: { id: number } }>('/api/workspaces/:id/figma/check', { schema: { params: idParam } }, async (req, reply): Promise<FigmaConnectionCheck | FastifyReply> => {
    const accountId = ctx.accountIdOf(req);
    const ws = await ownedWorkspace(ctx, accountId, req.params.id);
    if (ws == null) return notFound(reply, req.params.id);
    const answer = (ok: boolean, message: string): FigmaConnectionCheck => ({ workspaceId: ws, ok, message });
    const token = await readWorkspaceFigmaToken(ctx, accountId, ws);
    if (token.state === 'none') return answer(false, 'Save a token first.');
    if (token.state === 'unreadable') return answer(false, 'The saved token cannot be read on this computer. Save it again.');
    try {
      const me = (await figmaClient(token.token, ctx.transport).get('/v1/me')) as { handle?: unknown };
      return answer(true, typeof me?.handle === 'string' && me.handle.trim() !== '' ? `The token works, as ${me.handle.trim().slice(0, 80)}.` : 'The token works.');
    } catch (err) {
      ctx.log.warn({ accountId, workspaceId: ws, code: err instanceof FigmaError ? err.code : 'unknown' }, 'figma check failed');
      return answer(false, figmaErrorMessage(err));
    }
  });
}
