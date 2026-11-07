import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import type {
  AiFixChangeReport,
  AiFixChecks,
  AiFixReviewItem,
  AiFixSeed,
  AiFixStatus,
  AiFixStoredSeed,
  AiFixTrigger,
} from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';
import { claudeModelChoice, queuedRanOn, type AiRanOn } from '../../ai/provider.js';

// DB access for the ai_fixes table (plugin-owned). Writes go through ctx.db with the
// portable `.execute()` terminal; internal status transitions scope by id (the manager
// owns the row it created), while route reads scope by accountId (IDOR guarantee).

export interface AiFixRow {
  id: number;
  accountId: number;
  repoId: number;
  prId: number;
  sourceReviewId: number | null;
  baseSha: string;
  status: AiFixStatus;
  // What the BUILD ran (or is expected to run, before it starts): a Codex id on a Codex run.
  model: string;
  // 0128: who ran the build; NULL on older rows (read through `aiRunProvider`).
  provider?: string | null;
  // 0130: the effort the build used; NULL on older rows and before it starts.
  effort?: string | null;
  // 0128: what the latest planning pass ran on. NULL = never planned, or an older row.
  planProvider?: string | null;
  planModel?: string | null;
  planEffort?: string | null;
  seed: AiFixStoredSeed;
  prompt: string | null;
  summary: string | null;
  commitMessage: string | null;
  patch: string | null;
  filesChanged: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number | null;
  error: string | null;
  pushedBranch: string | null;
  pushedPrNumber: number | null;
  pushedPrUrl: string | null;
  pushedAt: Date | number | null;
  createdAt: Date | number | null;
  finishedAt: Date | number | null;
  // LEGACY JSON, written only by the removed comments seed (plugin migration 0024). Never read.
  commentTargets?: string | null;
  commentVerdicts?: string | null;
  // sqlite 0078 / pg 0065. NULL on older rows.
  trigger: string | null;
  reviewItems: string | null;
  changeReport: string | null;
  // sqlite 0113 / pg 0100 — plan mode. NULL on every row that never planned.
  plan?: string | null;
  planTranscript?: string | null;
  planStatus?: string | null;
  planRevision?: number | null;
  planSeed?: string | null;
  planCostUsd?: number | null;
  // 0148 — "Run tests": JSON AiFixChecks. NULL = no tests asked for.
  checks?: string | null;
  // 0177 — THE WORKSPACE SESSION (docs/SANDBOX.md § AI Fix sessions). NULL phase = the removed
  // shell-less fixer's row (history). `status` is derived from the phase (`aiFixStatusForPhase`).
  sessionPhase?: string | null;
  sandboxRef?: string | null;
  agentRef?: string | null;
  runtime?: string | null;
  sessionJson?: Record<string, unknown> | null;
  lastActiveAt?: Date | number | null;
  unattended?: boolean | null;
  workspaceId?: number | null;
}

/** The session columns a fix session writes (fix.ts). Scoped by account. */
export interface FixSessionPatch {
  sessionPhase?: string;
  status?: AiFixStatus;
  sessionJson?: Record<string, unknown>;
  sandboxRef?: string | null;
  agentRef?: string | null;
  runtime?: string | null;
  error?: string | null;
  lastActiveAt?: Date;
  finishedAt?: Date | null;
  unattended?: boolean;
  summary?: string | null;
  commitMessage?: string | null;
  patch?: string | null;
  filesChanged?: string;
  changeReport?: string;
  costUsd?: number | null;
  planCostUsd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  numTurns?: number | null;
}

export async function updateFixSession(ctx: AgentContext, accountId: number, id: number, patch: FixSessionPatch): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  const t = ctx.schema.aiFixes;
  await ctx.db.update(t).set(patch).where(and(eq(t.id, id), eq(t.accountId, accountId))).execute();
}

/** A stored "Run tests" record, or null (absent, or unparseable — this getter must never throw). */
export function parseChecks(raw: string | null | undefined): AiFixChecks | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<AiFixChecks>;
    if (!v || !Array.isArray(v.requested)) return null;
    return {
      requested: v.requested.filter((x): x is string => typeof x === 'string'),
      ran: v.ran === true,
      note: typeof v.note === 'string' ? v.note : null,
      sandbox: v.sandbox === 'seatbelt' || v.sandbox === 'bwrap' || v.sandbox === 'none' ? v.sandbox : null,
      install: Array.isArray(v.install) ? v.install : [],
      results: Array.isArray(v.results) ? v.results : [],
      hook: v.hook ?? null,
      hookAttempts: typeof v.hookAttempts === 'number' ? v.hookAttempts : 0,
      agentRuns: typeof v.agentRuns === 'number' ? v.agentRuns : 0,
    };
  } catch {
    return null;
  }
}

export async function insertQueuedFix(
  ctx: AgentContext,
  input: {
    accountId: number;
    repoId: number;
    prId: number;
    baseSha: string;
    model: string;
    seed: AiFixSeed;
    sourceReviewId: number | null;
    prompt: string;
    // Omitted ⇒ 'manual'.
    trigger?: AiFixTrigger;
    // seed === 'review': the items, stored BEFORE the agent runs so the row always knows what it
    // was asked to do (a run that fails or is cancelled still shows its list).
    reviewItems?: AiFixReviewItem[] | null;
    // The provider the job goes to (the manager's, picked once). Absent ⇒ the default provider.
    provider?: 'claude' | 'codex';
    // THE WORKSPACE SESSION (0177): the row opens `booting` (status derived: running).
    session?: { workspaceId: number; unattended: boolean; effort: string } | null;
  },
): Promise<number> {
  const t = ctx.schema.aiFixes;
  const items = input.reviewItems;
  const rows = (await ctx.db
    .insert(t)
    .values({
      accountId: input.accountId,
      repoId: input.repoId,
      prId: input.prId,
      baseSha: input.baseSha,
      status: input.session ? 'running' : 'queued',
      // Labelled by the provider it is expected to run on; the session stamps its own (`markFixRanOn`).
      // `input.model` is the Claude model ASKED for; `requestModelOf` maps back.
      ...queuedRanOn(claudeModelChoice(input.model), input.provider),
      seed: input.seed,
      sourceReviewId: input.sourceReviewId,
      prompt: input.prompt,
      trigger: input.trigger ?? 'manual',
      // Omitted (→ NULL) on a plain run: null means "this run had no review items".
      ...(items != null ? { reviewItems: JSON.stringify(items) } : {}),
      ...(input.session
        ? {
            sessionPhase: 'booting',
            workspaceId: input.session.workspaceId,
            unattended: input.session.unattended,
            effort: input.session.effort,
            lastActiveAt: new Date(),
          }
        : {}),
    })
    .returning({ id: t.id })
    .execute()) as Array<{ id: number }>;
  const id = rows[0]?.id;
  if (id == null) throw new Error('insertQueuedFix: no id returned');
  return id;
}

/** Stamp what the BUILD runs on (provider + model id), as it starts. */
export async function markFixRanOn(ctx: AgentContext, id: number, ran: AiRanOn): Promise<void> {
  const t = ctx.schema.aiFixes;
  await ctx.db
    .update(t)
    .set({ provider: ran.provider, model: ran.model, ...(ran.effort ? { effort: ran.effort } : {}) })
    .where(eq(t.id, id))
    .execute();
}

export async function markFixPushed(
  ctx: AgentContext,
  id: number,
  input: { pushedBranch: string; pushedPrNumber?: number; pushedPrUrl?: string },
): Promise<void> {
  const t = ctx.schema.aiFixes;
  await ctx.db
    .update(t)
    .set({
      pushedBranch: input.pushedBranch,
      pushedPrNumber: input.pushedPrNumber ?? null,
      pushedPrUrl: input.pushedPrUrl ?? null,
      pushedAt: new Date(),
      // A push that lands clears an earlier AUTOMATIC push's failure (`markFixPushFailed`).
      error: null,
    })
    .where(eq(t.id, id))
    .execute();
}

/**
 * An AUTOMATIC push of a succeeded fix failed (auto-push.ts): the reason goes on the row's `error`
 * (a succeeded row has none of its own), so the AI Fix tab can say so. Never retried — the reader
 * can still press Push.
 */
export async function markFixPushFailed(ctx: AgentContext, id: number, message: string): Promise<void> {
  const t = ctx.schema.aiFixes;
  await ctx.db
    .update(t)
    .set({ error: `Automatic push failed: ${message}`.slice(0, 1_000) })
    .where(and(eq(t.id, id), eq(t.status, 'succeeded')))
    .execute();
}

export async function getFixById(
  ctx: AgentContext,
  accountId: number,
  id: number,
): Promise<AiFixRow | null> {
  const t = ctx.schema.aiFixes;
  const rows = (await ctx.db
    .select()
    .from(t)
    .where(and(eq(t.id, id), eq(t.accountId, accountId)))
    .limit(1)
    .execute()) as AiFixRow[];
  return rows[0] ?? null;
}

export async function getLatestFix(
  ctx: AgentContext,
  accountId: number,
  prId: number,
): Promise<AiFixRow | null> {
  const t = ctx.schema.aiFixes;
  const rows = (await ctx.db
    .select()
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.prId, prId)))
    .orderBy(desc(t.id))
    .limit(1)
    .execute()) as AiFixRow[];
  return rows[0] ?? null;
}

export async function listFixHistory(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  limit = 20,
): Promise<AiFixRow[]> {
  const t = ctx.schema.aiFixes;
  return (await ctx.db
    .select()
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.prId, prId)))
    .orderBy(desc(t.id))
    .limit(limit)
    .execute()) as AiFixRow[];
}

// ---- PLAN MODE (docs/CLAUDE-REVIEW.md § AI Fix "Plan mode") ----
// Every write below is a COMPARE-AND-SET on the plan's state, so a discard that lands while a pass
// is finishing is never overwritten by that pass, and an approve can only take a plan that is ready.

/** "Discard plan": ends a ready (or failed-to-update) plan. Scoped by account. */
export async function markPlanDiscarded(ctx: AgentContext, accountId: number, id: number): Promise<boolean> {
  const t = ctx.schema.aiFixes;
  const rows = (await ctx.db
    .update(t)
    .set({ status: 'cancelled', planStatus: 'discarded', finishedAt: new Date() })
    .where(and(eq(t.id, id), eq(t.accountId, accountId), eq(t.status, 'planned'), eq(t.planStatus, 'plan_ready')))
    .returning({ id: t.id })
    .execute()) as Array<{ id: number }>;
  return rows.length > 0;
}

// Heal rows of the REMOVED shell-less fixer left `queued`/`running` by a crash/restart (no live job can
// resume them). ⚠ `session_phase IS NULL` only: a session row is settled by fix.ts's reconcile.
export async function reconcileOrphanedFixes(ctx: AgentContext): Promise<number> {
  const t = ctx.schema.aiFixes;
  // A planning pass cut off by the restart: a plan that already has a revision goes back to waiting
  // for the reader; one that never produced a plan has failed.
  const replans = (await ctx.db
    .update(t)
    .set({ planStatus: 'plan_ready', error: 'The plan was not updated: interrupted by a server restart' })
    .where(and(isNull(t.sessionPhase), eq(t.status, 'planned'), eq(t.planStatus, 'planning'), isNotNull(t.plan)))
    .returning({ id: t.id })
    .execute()) as Array<{ id: number }>;
  const firstPlans = (await ctx.db
    .update(t)
    .set({ status: 'failed', planStatus: 'failed', error: 'interrupted by a server restart', finishedAt: new Date() })
    .where(and(isNull(t.sessionPhase), eq(t.status, 'planned'), eq(t.planStatus, 'planning')))
    .returning({ id: t.id })
    .execute()) as Array<{ id: number }>;
  const planned = replans.length + firstPlans.length;
  const rows = (await ctx.db
    .update(t)
    .set({
      status: 'failed',
      error: 'interrupted by a server restart',
      finishedAt: new Date(),
    })
    .where(and(isNull(t.sessionPhase), eq(t.status, 'queued')))
    .returning({ id: t.id })
    .execute()) as Array<{ id: number }>;
  const rows2 = (await ctx.db
    .update(t)
    .set({
      status: 'failed',
      error: 'interrupted by a server restart',
      finishedAt: new Date(),
    })
    .where(and(isNull(t.sessionPhase), eq(t.status, 'running')))
    .returning({ id: t.id })
    .execute()) as Array<{ id: number }>;
  return rows.length + rows2.length + planned;
}

export function parseFilesChanged(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

/**
 * The report JSON columns, parsed DEFENSIVELY: null for NULL and for anything unparseable. These
 * are read by `GET /api/pro/prs/:id/ai-fix`, which loads the whole AI Fix tab, so a throw here
 * would take the tab down over a malformed blob rather than degrading to "no report".
 */
export function parseReviewItems(json: string | null | undefined): AiFixReviewItem[] | null {
  const v = parseJson(json);
  return Array.isArray(v) ? (v as AiFixReviewItem[]) : null;
}

export function parseChangeReport(json: string | null | undefined): AiFixChangeReport | null {
  const v = parseJson(json);
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Partial<AiFixChangeReport>;
  return {
    changes: Array.isArray(o.changes) ? o.changes : [],
    unaddressed: Array.isArray(o.unaddressed) ? o.unaddressed : [],
    notReported: Array.isArray(o.notReported) ? o.notReported : [],
  };
}

export function parseTrigger(v: string | null | undefined): AiFixTrigger {
  return v === 'auto' ? 'auto' : 'manual';
}

function parseJson(json: string | null | undefined): unknown {
  if (json == null || json === '') return null;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}
