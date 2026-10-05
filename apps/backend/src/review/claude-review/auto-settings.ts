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
//
// AUTO AI FIX rides the same route as a THIRD column, `auto_fix_enabled` (migration 0083 / pg
// 0070): may a succeeded auto review of the reader's OWN PR prepare a fix (never pushed)? ⚠ ON BY
// DEFAULT (NOT NULL DEFAULT true) — it ran unconditionally before the column existed. Stored
// independently of `auto_review_enabled` (switching auto review off and on keeps it), read by
// `maybeStartAutoFix` (coding/ai-fix/auto-fix.ts) through `readWorkspaceAutoFixForPr`.

/** Auto Claude reviews started per workspace per UTC day. Past it, PRs wait for the next day. */
export const AUTO_REVIEW_DAILY_CAP = 20;

const toMs = (v: Date | number | null | undefined): number | null =>
  v == null ? null : v instanceof Date ? v.getTime() : Number(v);

interface AutoRow {
  enabled: boolean | null;
  enabledAt: Date | number | null;
  autoFixEnabled: boolean | null;
}

/** The stored row → the wire shape. Off ⇒ `enabledAt: null`. Auto fix: only an explicit false is off. */
export function autoReviewOf(row: AutoRow | null): WorkspaceAutoReviewSettings {
  const enabled = row?.enabled === true;
  const atMs = enabled ? toMs(row?.enabledAt ?? null) : null;
  return {
    enabled,
    enabledAt: atMs == null ? null : new Date(atMs).toISOString(),
    dailyCap: AUTO_REVIEW_DAILY_CAP,
    autoFixEnabled: row?.autoFixEnabled !== false,
  };
}

/**
 * Is auto AI Fix on for the workspace holding this PR's repo? Read by `maybeStartAutoFix`. A repo
 * with no membership row (or an unknown PR) answers the column's default, ON — this switch only
 * ever turns the step OFF, it never gates a workspace it cannot find.
 */
export async function readWorkspaceAutoFixForPr(
  ctx: AgentContext,
  accountId: number,
  prId: number,
): Promise<boolean> {
  const { workspaces: w, workspaceRepos: wr, pullRequests: prs } = ctx.schema;
  const rows = (await ctx.db
    .select({ on: w.autoFixEnabled })
    .from(prs)
    .innerJoin(wr, and(eq(wr.repoId, prs.repoId), eq(wr.accountId, accountId)))
    .innerJoin(w, and(eq(w.id, wr.workspaceId), eq(w.accountId, accountId)))
    .where(and(eq(prs.id, prId), eq(prs.accountId, accountId)))
    .limit(1)
    .execute()) as Array<{ on: boolean | null }>;
  return rows[0]?.on !== false;
}

const autoCols = (w: AgentContext['schema'][string]) => ({
  enabled: w.autoReviewEnabled,
  enabledAt: w.autoReviewEnabledAt,
  autoFixEnabled: w.autoFixEnabled,
});

/** One workspace's switch, or null when the workspace is not this account's. */
export async function readWorkspaceAutoReview(
  ctx: AgentContext,
  accountId: number,
  workspaceId: number,
): Promise<WorkspaceAutoReviewSettings | null> {
  const w = ctx.schema.workspaces;
  const rows = (await ctx.db
    .select(autoCols(w))
    .from(w)
    .where(and(eq(w.id, workspaceId), eq(w.accountId, accountId)))
    .limit(1)
    .execute()) as AutoRow[];
  const row = rows[0];
  return row ? autoReviewOf(row) : null;
}

/**
 * The ONE writer. null when the workspace is not this account's (→ 404). Each of `enabled` /
 * `autoFixEnabled` is optional and a field left out keeps its stored value. Switching auto review
 * OFF also drops this workspace's items still WAITING in the auto lane (no row yet, so nothing is
 * lost) — they are not reviewed, and not billed, after the switch. A run already started keeps
 * its Stop. Switching auto fix off stops only FUTURE auto fixes; one already started keeps going.
 */
export async function setWorkspaceAutoReview(
  ctx: AgentContext,
  accountId: number,
  workspaceId: number,
  change: SetWorkspaceAutoReviewBody,
  nowMs: number = Date.now(),
): Promise<WorkspaceAutoReviewSettings | null> {
  const w = ctx.schema.workspaces;
  const rows = (await ctx.db
    .select(autoCols(w))
    .from(w)
    .where(and(eq(w.id, workspaceId), eq(w.accountId, accountId)))
    .limit(1)
    .execute()) as AutoRow[];
  const existing = rows[0];
  if (!existing) return null;
  const { enabled, autoFixEnabled } = change;
  const wasOn = existing.enabled === true && toMs(existing.enabledAt) != null;
  let review: Pick<AutoRow, 'enabled' | 'enabledAt'>;
  if (enabled === undefined || (enabled && wasOn)) review = existing;
  else if (!enabled) review = { enabled: false, enabledAt: null };
  // Whole seconds: SQLite stores this column in seconds, so an un-truncated stamp would make the
  // PUT's echo disagree with every later read by the milliseconds the column dropped.
  else review = { enabled: true, enabledAt: new Date(Math.floor(nowMs / 1000) * 1000) };
  const fix = autoFixEnabled ?? existing.autoFixEnabled !== false;
  const next: AutoRow = { enabled: review.enabled, enabledAt: review.enabledAt, autoFixEnabled: fix };
  const set: Record<string, unknown> = {};
  if (review !== existing) {
    set.autoReviewEnabled = review.enabled;
    set.autoReviewEnabledAt = review.enabledAt;
  }
  if (autoFixEnabled !== undefined && autoFixEnabled !== (existing.autoFixEnabled !== false)) {
    set.autoFixEnabled = autoFixEnabled;
  }
  if (Object.keys(set).length > 0) {
    await ctx.db
      .update(w)
      .set(set)
      .where(and(eq(w.id, workspaceId), eq(w.accountId, accountId)))
      .execute();
  }
  if (enabled === false) dropAutoReviews((a, ws) => !(a === accountId && ws === workspaceId));
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
        // ⚠ AT LEAST ONE FIELD, so an empty `{}` cannot read as a switch.
        body: {
          type: 'object',
          minProperties: 1,
          additionalProperties: false,
          properties: { enabled: { type: 'boolean' }, autoFixEnabled: { type: 'boolean' } },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: number };
      const body = req.body as SetWorkspaceAutoReviewBody;
      const autoReview = await setWorkspaceAutoReview(ctx, ctx.accountIdOf(req), id, body);
      if (!autoReview) {
        reply.status(404);
        return { error: 'NotFound', message: `Workspace ${id} not found` };
      }
      const resp: WorkspaceAutoReviewResponse = { workspaceId: id, autoReview };
      return resp;
    },
  );
}
