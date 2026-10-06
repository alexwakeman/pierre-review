import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import {
  AUTO_POST_DEFAULT_KINDS,
  AUTO_POST_DEFAULT_SCOPE,
  type AutoPostKinds,
  type AutoPostScope,
  type SetWorkspaceAutoReviewBody,
  type StoredAutoPostSettings,
  type WorkspaceAutoPostSettings,
  type WorkspaceAutoReviewResponse,
  type WorkspaceAutoReviewSettings,
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
//
// THE DAILY CAP rides the same route as a FOURTH column, `auto_review_daily_cap` (migration 0085 /
// pg 0072): how many auto runs this workspace may start per UTC day. OVERRIDES ONLY — NULL means
// the product default, `AUTO_REVIEW_DAILY_CAP`; `resolveAutoReviewDailyCap` is the ONE fold, read
// by the wire shape and the sweeper's roster alike. Bounded 1..500 at the route.
//
// AUTO-POSTING rides the same route as two more columns (migration 0087 / pg 0074):
// `auto_post_enabled` (NULL/false = OFF — for every workspace, existing and new, until someone
// switches it on: it writes to GitHub AS THE READER) and `auto_post_settings`, OVERRIDES ONLY
// ({ scope?, kinds? }; NULL = the product defaults), resolved through `resolveAutoPostSettings`.
// Stored independently of `auto_review_enabled`: it only ever acts on AUTO runs, so it does nothing
// while auto review is off, but switching auto review off and on keeps it.

/** Auto Claude reviews started per workspace per UTC day. Past it, PRs wait for the next day. */
export const AUTO_REVIEW_DAILY_CAP = 20;
/** The bounds a stored per-workspace cap must sit inside (the PUT 400s outside them). */
export const AUTO_REVIEW_DAILY_CAP_MIN = 1;
export const AUTO_REVIEW_DAILY_CAP_MAX = 500;

/** The stored override → the cap in force. NULL (or anything out of bounds) ⇒ the default. */
export function resolveAutoReviewDailyCap(stored: number | null | undefined): number {
  return typeof stored === 'number' &&
    Number.isInteger(stored) &&
    stored >= AUTO_REVIEW_DAILY_CAP_MIN &&
    stored <= AUTO_REVIEW_DAILY_CAP_MAX
    ? stored
    : AUTO_REVIEW_DAILY_CAP;
}

const AUTO_POST_KIND_KEYS = Object.keys(AUTO_POST_DEFAULT_KINDS) as Array<keyof AutoPostKinds>;
const isScope = (v: unknown): v is AutoPostScope => v === 'mine' || v === 'all';

/** The stored switch + overrides → the settings in force. Anything malformed reads as the default. */
export function resolveAutoPostSettings(
  enabled: boolean | null | undefined,
  stored: StoredAutoPostSettings | null | undefined,
): WorkspaceAutoPostSettings {
  const kinds = { ...AUTO_POST_DEFAULT_KINDS };
  const sk = stored?.kinds;
  if (sk != null && typeof sk === 'object') {
    for (const k of AUTO_POST_KIND_KEYS) if (typeof sk[k] === 'boolean') kinds[k] = sk[k] as boolean;
  }
  return {
    enabled: enabled === true,
    scope: isScope(stored?.scope) ? stored!.scope! : AUTO_POST_DEFAULT_SCOPE,
    kinds,
  };
}

/** The settings in force → what to store: only what differs from the product default (null = none). */
export function autoPostOverrides(s: Pick<WorkspaceAutoPostSettings, 'scope' | 'kinds'>): StoredAutoPostSettings | null {
  const out: StoredAutoPostSettings = {};
  if (s.scope !== AUTO_POST_DEFAULT_SCOPE) out.scope = s.scope;
  const kinds: Partial<AutoPostKinds> = {};
  for (const k of AUTO_POST_KIND_KEYS) if (s.kinds[k] !== AUTO_POST_DEFAULT_KINDS[k]) kinds[k] = s.kinds[k];
  if (Object.keys(kinds).length > 0) out.kinds = kinds;
  return Object.keys(out).length > 0 ? out : null;
}

const toMs = (v: Date | number | null | undefined): number | null =>
  v == null ? null : v instanceof Date ? v.getTime() : Number(v);

interface AutoRow {
  enabled: boolean | null;
  enabledAt: Date | number | null;
  autoFixEnabled: boolean | null;
  dailyCap: number | null;
  autoPostEnabled: boolean | null;
  autoPostSettings: StoredAutoPostSettings | null;
}

/** The stored row → the wire shape. Off ⇒ `enabledAt: null`. Auto fix: OFF unless explicitly switched on (0084). */
export function autoReviewOf(row: AutoRow | null): WorkspaceAutoReviewSettings {
  const enabled = row?.enabled === true;
  const atMs = enabled ? toMs(row?.enabledAt ?? null) : null;
  return {
    enabled,
    enabledAt: atMs == null ? null : new Date(atMs).toISOString(),
    dailyCap: resolveAutoReviewDailyCap(row?.dailyCap),
    autoFixEnabled: row?.autoFixEnabled === true,
    autoPost: resolveAutoPostSettings(row?.autoPostEnabled, row?.autoPostSettings),
  };
}

/**
 * The auto-post settings of the workspace holding this PR's repo, with that workspace's id — read
 * by auto-posting before it touches GitHub. A repo with no membership row (or an unknown PR) reads
 * null, i.e. OFF: this switch WRITES as the reader, so a workspace it cannot find never says yes.
 */
export async function readWorkspaceAutoPostForPr(
  ctx: AgentContext,
  accountId: number,
  prId: number,
): Promise<{ workspaceId: number; settings: WorkspaceAutoPostSettings } | null> {
  const { workspaces: w, workspaceRepos: wr, pullRequests: prs } = ctx.schema;
  const rows = (await ctx.db
    .select({ workspaceId: w.id, enabled: w.autoPostEnabled, stored: w.autoPostSettings })
    .from(prs)
    .innerJoin(wr, and(eq(wr.repoId, prs.repoId), eq(wr.accountId, accountId)))
    .innerJoin(w, and(eq(w.id, wr.workspaceId), eq(w.accountId, accountId)))
    .where(and(eq(prs.id, prId), eq(prs.accountId, accountId)))
    .limit(1)
    .execute()) as Array<{ workspaceId: number; enabled: boolean | null; stored: StoredAutoPostSettings | null }>;
  const r = rows[0];
  return r ? { workspaceId: r.workspaceId, settings: resolveAutoPostSettings(r.enabled, r.stored) } : null;
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
  return rows[0]?.on === true;
}

const autoCols = (w: AgentContext['schema'][string]) => ({
  enabled: w.autoReviewEnabled,
  enabledAt: w.autoReviewEnabledAt,
  autoFixEnabled: w.autoFixEnabled,
  dailyCap: w.autoReviewDailyCap,
  autoPostEnabled: w.autoPostEnabled,
  autoPostSettings: w.autoPostSettings,
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
 * `autoFixEnabled` / `dailyCap` is optional and a field left out keeps its stored value. A
 * `dailyCap` equal to the default is stored as NULL (overrides only). Switching auto review
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
  const { enabled, autoFixEnabled, dailyCap, autoPost } = change;
  const wasOn = existing.enabled === true && toMs(existing.enabledAt) != null;
  let review: Pick<AutoRow, 'enabled' | 'enabledAt'>;
  if (enabled === undefined || (enabled && wasOn)) review = existing;
  else if (!enabled) review = { enabled: false, enabledAt: null };
  // Whole seconds: SQLite stores this column in seconds, so an un-truncated stamp would make the
  // PUT's echo disagree with every later read by the milliseconds the column dropped.
  else review = { enabled: true, enabledAt: new Date(Math.floor(nowMs / 1000) * 1000) };
  const fix = autoFixEnabled ?? existing.autoFixEnabled !== false;
  const capOverride =
    dailyCap === undefined ? existing.dailyCap : dailyCap === AUTO_REVIEW_DAILY_CAP ? null : dailyCap;
  // Auto-posting: each field optional; a kind left out keeps its stored value.
  const postBefore = resolveAutoPostSettings(existing.autoPostEnabled, existing.autoPostSettings);
  const postAfter: WorkspaceAutoPostSettings = {
    enabled: autoPost?.enabled ?? postBefore.enabled,
    scope: autoPost?.scope ?? postBefore.scope,
    kinds: { ...postBefore.kinds },
  };
  for (const k of AUTO_POST_KIND_KEYS) {
    const v = autoPost?.kinds?.[k];
    if (typeof v === 'boolean') postAfter.kinds[k] = v;
  }
  const postOverrides = autoPostOverrides(postAfter);
  const next: AutoRow = {
    enabled: review.enabled,
    enabledAt: review.enabledAt,
    autoFixEnabled: fix,
    dailyCap: capOverride,
    autoPostEnabled: postAfter.enabled,
    autoPostSettings: postOverrides,
  };
  const set: Record<string, unknown> = {};
  if (review !== existing) {
    set.autoReviewEnabled = review.enabled;
    set.autoReviewEnabledAt = review.enabledAt;
  }
  if (autoFixEnabled !== undefined && autoFixEnabled !== (existing.autoFixEnabled !== false)) {
    set.autoFixEnabled = autoFixEnabled;
  }
  if (dailyCap !== undefined && capOverride !== existing.dailyCap) {
    set.autoReviewDailyCap = capOverride;
  }
  if (autoPost !== undefined) {
    if (postAfter.enabled !== (existing.autoPostEnabled === true)) set.autoPostEnabled = postAfter.enabled;
    if (JSON.stringify(postOverrides) !== JSON.stringify(existing.autoPostSettings ?? null)) {
      set.autoPostSettings = postOverrides;
    }
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

export interface AutoReviewRosterEntry {
  accountId: number;
  workspaceId: number;
  enabledAtMs: number;
  /** The cap in force for this workspace (the stored override, else the default). */
  dailyCap: number;
}

/**
 * Every workspace with auto review ON, across every account — the sweeper's roster. A row whose
 * `enabled_at` is missing is skipped: with no floor there is no safe answer to "which PRs are new".
 */
export async function listAutoReviewWorkspaces(
  ctx: AgentContext,
): Promise<AutoReviewRosterEntry[]> {
  const w = ctx.schema.workspaces;
  const rows = (await ctx.db
    .select({
      accountId: w.accountId,
      workspaceId: w.id,
      enabledAt: w.autoReviewEnabledAt,
      dailyCap: w.autoReviewDailyCap,
    })
    .from(w)
    .where(eq(w.autoReviewEnabled, true))
    .execute()) as Array<{
    accountId: number;
    workspaceId: number;
    enabledAt: Date | number | null;
    dailyCap: number | null;
  }>;
  const out: AutoReviewRosterEntry[] = [];
  for (const r of rows) {
    const ms = toMs(r.enabledAt);
    if (ms != null) {
      out.push({
        accountId: r.accountId,
        workspaceId: r.workspaceId,
        enabledAtMs: ms,
        dailyCap: resolveAutoReviewDailyCap(r.dailyCap),
      });
    }
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
          properties: {
            enabled: { type: 'boolean' },
            autoFixEnabled: { type: 'boolean' },
            // An integer 1..500; anything else (a fraction, a string, out of range) is a 400.
            dailyCap: {
              type: 'integer',
              minimum: AUTO_REVIEW_DAILY_CAP_MIN,
              maximum: AUTO_REVIEW_DAILY_CAP_MAX,
            },
            autoPost: {
              type: 'object',
              minProperties: 1,
              additionalProperties: false,
              properties: {
                enabled: { type: 'boolean' },
                scope: { type: 'string', enum: ['mine', 'all'] },
                kinds: {
                  type: 'object',
                  minProperties: 1,
                  additionalProperties: false,
                  properties: Object.fromEntries(AUTO_POST_KIND_KEYS.map((k) => [k, { type: 'boolean' }])),
                },
              },
            },
          },
        },
      },
      // ⚠ Fastify's validator COERCES types, so `true` would arrive as 1 and `"40"` as 40. The cap
      // must be a real JSON number: checked on the RAW body, before the schema coerces it.
      preValidation: async (req, reply) => {
        const raw = (req.body ?? {}) as Record<string, unknown>;
        // The same for the auto-post booleans: `"true"` or `1` must not read as a switch.
        const post = raw.autoPost as Record<string, unknown> | undefined;
        const kinds = post != null && typeof post === 'object' ? (post.kinds as Record<string, unknown> | undefined) : undefined;
        if (
          (post != null && typeof post === 'object' && 'enabled' in post && typeof post.enabled !== 'boolean') ||
          (kinds != null && typeof kinds === 'object' && Object.values(kinds).some((v) => typeof v !== 'boolean'))
        ) {
          reply.status(400);
          return reply.send({ error: 'BadRequest', message: 'autoPost switches must be true or false' });
        }
        if ('dailyCap' in raw && typeof raw.dailyCap !== 'number') {
          reply.status(400);
          return reply.send({
            error: 'BadRequest',
            message: `dailyCap must be a whole number from ${AUTO_REVIEW_DAILY_CAP_MIN} to ${AUTO_REVIEW_DAILY_CAP_MAX}`,
          });
        }
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
