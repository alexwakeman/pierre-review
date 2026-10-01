import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import type {
  SetWorkspaceAutoReviewBody,
  WorkspaceAutoReviewResponse,
  WorkspaceAutoReviewSettings,
} from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import { dropAutoReviews } from './manager.js';

// AUTO CLAUDE REVIEW — THE PER-WORKSPACE SWITCH (CORE since migration 0074 / pg 0061; it lived on
// the plugin's `pro_workspace_settings` until Claude Review left the plugin, and plugin migration
// 0037 copied each workspace's value across). Two columns on `workspaces`:
//   auto_review_enabled     true = review each new human PR in this workspace. NULL/false = off.
//   auto_review_enabled_at  when it was last switched ON — the floor: only PRs OPENED at or after
//                           it are reviewed, so a first sync, a backfill or a new repo can never
//                           make an old PR look new.
//
// ⚠ OFF UNTIL SOMEONE SWITCHES IT ON. It runs the user's own Claude in the background on every new
// human PR, so it is never a default.
//
// ⚠ THE FLOOR MOVES ONLY ON AN OFF → ON FLIP. Re-sending `enabled: true` keeps the stored moment
// (or every PR opened in between would silently be skipped); switching off clears it, so the next
// switch-on starts from then. `setWorkspaceAutoReview` is the ONE writer.

/** Auto Claude reviews started per workspace per UTC day. Past it, PRs wait for the next day. */
export const AUTO_REVIEW_DAILY_CAP = 20;

const toMs = (v: Date | number | null | undefined): number | null =>
  v == null ? null : v instanceof Date ? v.getTime() : Number(v);

interface AutoRow {
  enabled: boolean | null;
  enabledAt: Date | number | null;
}

/** The stored pair → the wire shape. Off ⇒ `enabledAt: null`. */
export function autoReviewOf(row: AutoRow | null): WorkspaceAutoReviewSettings {
  const enabled = row?.enabled === true;
  const atMs = enabled ? toMs(row?.enabledAt ?? null) : null;
  return {
    enabled,
    enabledAt: atMs == null ? null : new Date(atMs).toISOString(),
    dailyCap: AUTO_REVIEW_DAILY_CAP,
  };
}

/** One workspace's switch, or null when the workspace is not this account's. */
export async function readWorkspaceAutoReview(
  ctx: AgentContext,
  accountId: number,
  workspaceId: number,
): Promise<WorkspaceAutoReviewSettings | null> {
  const w = ctx.schema.workspaces;
  const rows = (await ctx.db
    .select({ enabled: w.autoReviewEnabled, enabledAt: w.autoReviewEnabledAt })
    .from(w)
    .where(and(eq(w.id, workspaceId), eq(w.accountId, accountId)))
    .limit(1)
    .execute()) as AutoRow[];
  const row = rows[0];
  return row ? autoReviewOf(row) : null;
}

/**
 * The ONE writer. null when the workspace is not this account's (→ 404). Switching OFF also drops
 * this workspace's items still WAITING in the auto lane (no row yet, so nothing is lost) — they
 * are not reviewed, and not billed, after the switch. A run already started keeps its Stop.
 */
export async function setWorkspaceAutoReview(
  ctx: AgentContext,
  accountId: number,
  workspaceId: number,
  enabled: boolean,
  nowMs: number = Date.now(),
): Promise<WorkspaceAutoReviewSettings | null> {
  const w = ctx.schema.workspaces;
  const rows = (await ctx.db
    .select({ enabled: w.autoReviewEnabled, enabledAt: w.autoReviewEnabledAt })
    .from(w)
    .where(and(eq(w.id, workspaceId), eq(w.accountId, accountId)))
    .limit(1)
    .execute()) as AutoRow[];
  const existing = rows[0];
  if (!existing) return null;
  const wasOn = existing.enabled === true && toMs(existing.enabledAt) != null;
  let next: AutoRow;
  if (!enabled) next = { enabled: false, enabledAt: null };
  else if (wasOn) next = existing;
  // Whole seconds: SQLite stores this column in seconds, so an un-truncated stamp would make the
  // PUT's echo disagree with every later read by the milliseconds the column dropped.
  else next = { enabled: true, enabledAt: new Date(Math.floor(nowMs / 1000) * 1000) };
  if (next !== existing) {
    await ctx.db
      .update(w)
      .set({ autoReviewEnabled: next.enabled, autoReviewEnabledAt: next.enabledAt })
      .where(and(eq(w.id, workspaceId), eq(w.accountId, accountId)))
      .execute();
  }
  if (!enabled) dropAutoReviews((a, ws) => !(a === accountId && ws === workspaceId));
  return autoReviewOf(next);
}

/**
 * Every workspace with auto review ON, across every account — the sweeper's roster. A row whose
 * `enabled_at` is missing is skipped: with no floor there is no safe answer to "which PRs are new".
 */
export async function listAutoReviewWorkspaces(
  ctx: AgentContext,
): Promise<Array<{ accountId: number; workspaceId: number; enabledAtMs: number }>> {
  const w = ctx.schema.workspaces;
  const rows = (await ctx.db
    .select({ accountId: w.accountId, workspaceId: w.id, enabledAt: w.autoReviewEnabledAt })
    .from(w)
    .where(eq(w.autoReviewEnabled, true))
    .execute()) as Array<{ accountId: number; workspaceId: number; enabledAt: Date | number | null }>;
  const out: Array<{ accountId: number; workspaceId: number; enabledAtMs: number }> = [];
  for (const r of rows) {
    const ms = toMs(r.enabledAt);
    if (ms != null) out.push({ accountId: r.accountId, workspaceId: r.workspaceId, enabledAtMs: ms });
  }
  return out;
}

const idParam = {
  params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
};

/**
 * GET / PUT /api/workspaces/:id/auto-review. Registered only where Claude Review runs (local, the
 * agentic switch on) — in cloud both 404 like every other agentic route. DB-only.
 */
export function registerAutoReviewSettingsRoutes(app: FastifyInstance, ctx: AgentContext): void {
  app.get('/api/workspaces/:id/auto-review', { schema: idParam }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const autoReview = await readWorkspaceAutoReview(ctx, ctx.accountIdOf(req), id);
    if (!autoReview) {
      reply.status(404);
      return { error: 'NotFound', message: `Workspace ${id} not found` };
    }
    const resp: WorkspaceAutoReviewResponse = { workspaceId: id, autoReview };
    return resp;
  });

  app.put(
    '/api/workspaces/:id/auto-review',
    {
      schema: {
        ...idParam,
        // ⚠ `enabled` REQUIRED so an empty `{}` cannot read as a switch.
        body: {
          type: 'object',
          required: ['enabled'],
          additionalProperties: false,
          properties: { enabled: { type: 'boolean' } },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: number };
      const { enabled } = req.body as SetWorkspaceAutoReviewBody;
      const autoReview = await setWorkspaceAutoReview(ctx, ctx.accountIdOf(req), id, enabled);
      if (!autoReview) {
        reply.status(404);
        return { error: 'NotFound', message: `Workspace ${id} not found` };
      }
      const resp: WorkspaceAutoReviewResponse = { workspaceId: id, autoReview };
      return resp;
    },
  );
}
