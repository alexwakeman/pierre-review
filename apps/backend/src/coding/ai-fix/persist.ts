import { and, desc, eq, isNotNull } from 'drizzle-orm';
import type {
  AiFixChangeReport,
  AiFixReviewItem,
  AiFixSeed,
  AiFixStatus,
  AiFixStoredSeed,
  AiFixTrigger,
} from '@pierre-review/shared';
import type { GenerateFixResult } from '../../pro/contract.js';
import type { AgentContext } from '../../review/agent-context.js';
import { normalizeChangeReport } from './review-seed.js';
import type { AiFixPlan, AiFixPlanMessage } from '@pierre-review/shared';
import type { FixSeed } from './prompts.js';
import { parsePlan, parseTranscript } from './plan.js';

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
  model: string;
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
    // PLAN MODE: the row opens as an open plan ('planned' / 'planning') holding its frozen seed.
    planSeed?: FixSeed | null;
  },
): Promise<number> {
  const t = ctx.schema.aiFixes;
  const items = input.reviewItems;
  const planSeed = input.planSeed;
  const rows = (await ctx.db
    .insert(t)
    .values({
      accountId: input.accountId,
      repoId: input.repoId,
      prId: input.prId,
      baseSha: input.baseSha,
      status: planSeed ? 'planned' : 'queued',
      model: input.model,
      seed: input.seed,
      sourceReviewId: input.sourceReviewId,
      prompt: input.prompt,
      trigger: input.trigger ?? 'manual',
      // Omitted (→ NULL) on a plain run: null means "this run had no review items".
      ...(items != null ? { reviewItems: JSON.stringify(items) } : {}),
      ...(planSeed
        ? {
            planStatus: 'planning',
            planRevision: 0,
            planSeed: JSON.stringify(planSeed),
            planTranscript: '[]',
          }
        : {}),
    })
    .returning({ id: t.id })
    .execute()) as Array<{ id: number }>;
  const id = rows[0]?.id;
  if (id == null) throw new Error('insertQueuedFix: no id returned');
  return id;
}

export async function markFixRunning(ctx: AgentContext, id: number): Promise<void> {
  const t = ctx.schema.aiFixes;
  await ctx.db.update(t).set({ status: 'running' }).where(eq(t.id, id)).execute();
}

export async function saveFixSuccess(
  ctx: AgentContext,
  id: number,
  data: GenerateFixResult,
  // The refs the run was SHOWN ([] for a plain run) — the set the agent's report is validated
  // against.
  sentRefs: readonly string[],
): Promise<void> {
  const t = ctx.schema.aiFixes;
  const report: AiFixChangeReport = normalizeChangeReport(data.report, sentRefs, data.filesChanged);
  await ctx.db
    .update(t)
    .set({
      status: 'succeeded',
      summary: data.summary,
      commitMessage: data.commitMessage,
      patch: data.patch,
      filesChanged: JSON.stringify(data.filesChanged),
      costUsd: data.costUsd,
      inputTokens: data.usage.inputTokens,
      outputTokens: data.usage.outputTokens,
      numTurns: data.numTurns,
      finishedAt: new Date(),
      changeReport: JSON.stringify(report),
    })
    .where(eq(t.id, id))
    .execute();
  // Record the agentic-fixer spend on the shared AI-usage ledger (agent seam). Reads
  // accountId/prId/model back off the row. Best-effort — the whole block (incl. the
  // read-back SELECT) is guarded so a ledger error never flips an already-succeeded fix.
  if (data.costUsd != null && Number.isFinite(data.costUsd) && data.costUsd > 0) {
    try {
      const row = (
        (await ctx.db
          .select({ accountId: t.accountId, prId: t.prId, model: t.model })
          .from(t)
          .where(eq(t.id, id))
          .limit(1)
          .execute()) as Array<{ accountId: number; prId: number; model: string }>
      )[0];
      if (row)
        await ctx.recordAiUsage({
          accountId: row.accountId,
          seam: 'agent',
          feature: 'ai_fix',
          model: row.model,
          costUsd: data.costUsd,
          inputTokens: data.usage.inputTokens,
          outputTokens: data.usage.outputTokens,
          prId: row.prId,
        });
    } catch {
      /* ledger write is best-effort — never break the fix save */
    }
  }
}

export async function markFixFailed(
  ctx: AgentContext,
  id: number,
  error: string,
): Promise<void> {
  const t = ctx.schema.aiFixes;
  await ctx.db
    .update(t)
    .set({ status: 'failed', error: error.slice(0, 4000), finishedAt: new Date() })
    .where(eq(t.id, id))
    .execute();
}

export async function markFixCancelled(ctx: AgentContext, id: number): Promise<void> {
  const t = ctx.schema.aiFixes;
  await ctx.db
    .update(t)
    .set({ status: 'cancelled', finishedAt: new Date() })
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

async function readPlanColumns(
  ctx: AgentContext,
  id: number,
): Promise<{ plan: string | null; planTranscript: string | null; planCostUsd: number | null; accountId: number; prId: number; model: string } | null> {
  const t = ctx.schema.aiFixes;
  const rows = (await ctx.db
    .select({
      plan: t.plan,
      planTranscript: t.planTranscript,
      planCostUsd: t.planCostUsd,
      accountId: t.accountId,
      prId: t.prId,
      model: t.model,
    })
    .from(t)
    .where(eq(t.id, id))
    .limit(1)
    .execute()) as Array<{ plan: string | null; planTranscript: string | null; planCostUsd: number | null; accountId: number; prId: number; model: string }>;
  return rows[0] ?? null;
}

function addCost(prev: number | null, cost: number | null): number | null {
  if (cost == null || !Number.isFinite(cost)) return prev;
  return (prev ?? 0) + cost;
}

/** Record one planning pass's spend on the AI-usage ledger. Best-effort, like the build's. */
async function recordPlanUsage(
  ctx: AgentContext,
  row: { accountId: number; prId: number; model: string },
  pass: { costUsd: number | null; usage: { inputTokens: number; outputTokens: number } },
): Promise<void> {
  if (pass.costUsd == null || !Number.isFinite(pass.costUsd) || pass.costUsd <= 0) return;
  try {
    await ctx.recordAiUsage({
      accountId: row.accountId,
      seam: 'agent',
      feature: 'ai_fix_plan',
      model: row.model,
      costUsd: pass.costUsd,
      inputTokens: pass.usage.inputTokens,
      outputTokens: pass.usage.outputTokens,
      prId: row.prId,
    });
  } catch {
    /* ledger write is best-effort — never break the plan save */
  }
}

/** A planning pass produced a plan: store it as the new revision and append Claude's reply. */
export async function savePlanSuccess(
  ctx: AgentContext,
  id: number,
  input: {
    plan: AiFixPlan;
    reply: string | null;
    costUsd: number | null;
    usage: { inputTokens: number; outputTokens: number };
  },
): Promise<boolean> {
  const t = ctx.schema.aiFixes;
  const cur = await readPlanColumns(ctx, id);
  if (!cur) return false;
  await recordPlanUsage(ctx, cur, input);
  const transcript = parseTranscript(cur.planTranscript);
  if (input.reply) {
    transcript.push({ role: 'claude', text: input.reply, revision: input.plan.revision, at: new Date().toISOString() });
  }
  const rows = (await ctx.db
    .update(t)
    .set({
      plan: JSON.stringify(input.plan),
      planRevision: input.plan.revision,
      planStatus: 'plan_ready',
      planTranscript: JSON.stringify(transcript),
      planCostUsd: addCost(cur.planCostUsd, input.costUsd),
      error: null,
    })
    .where(and(eq(t.id, id), eq(t.status, 'planned'), eq(t.planStatus, 'planning')))
    .returning({ id: t.id })
    .execute()) as Array<{ id: number }>;
  return rows.length > 0;
}

/**
 * A planning pass ended without a plan (failed, refused, or cancelled). A RE-PLAN keeps the plan it
 * already has (back to 'plan_ready', the reason on `error`); a FIRST pass ends the row ('failed', or
 * 'cancelled' + 'discarded' on a cancel).
 */
export async function markPlanPassEnded(
  ctx: AgentContext,
  id: number,
  outcome: { kind: 'failed'; message: string } | { kind: 'cancelled' },
  pass: { costUsd: number | null; usage: { inputTokens: number; outputTokens: number } } | null = null,
): Promise<void> {
  const t = ctx.schema.aiFixes;
  const cur = await readPlanColumns(ctx, id);
  if (!cur) return;
  if (pass) await recordPlanUsage(ctx, cur, pass);
  const cost = addCost(cur.planCostUsd, pass?.costUsd ?? null);
  const guard = and(eq(t.id, id), eq(t.status, 'planned'), eq(t.planStatus, 'planning'));
  if (parsePlan(cur.plan) != null) {
    await ctx.db
      .update(t)
      .set({
        planStatus: 'plan_ready',
        planCostUsd: cost,
        error: outcome.kind === 'failed' ? `The plan was not updated: ${outcome.message}`.slice(0, 1_000) : null,
      })
      .where(guard)
      .execute();
    return;
  }
  await ctx.db
    .update(t)
    .set(
      outcome.kind === 'failed'
        ? { status: 'failed', planStatus: 'failed', planCostUsd: cost, error: outcome.message.slice(0, 4000), finishedAt: new Date() }
        : { status: 'cancelled', planStatus: 'discarded', planCostUsd: cost, finishedAt: new Date() },
    )
    .where(guard)
    .execute();
}

/** Append the reader's steering message and reopen the plan for a pass. false ⇒ not a ready plan. */
export async function appendPlanMessage(
  ctx: AgentContext,
  id: number,
  message: AiFixPlanMessage,
): Promise<boolean> {
  const t = ctx.schema.aiFixes;
  const cur = await readPlanColumns(ctx, id);
  if (!cur) return false;
  const transcript = parseTranscript(cur.planTranscript);
  transcript.push(message);
  const rows = (await ctx.db
    .update(t)
    .set({ planTranscript: JSON.stringify(transcript), planStatus: 'planning', error: null })
    .where(and(eq(t.id, id), eq(t.status, 'planned'), eq(t.planStatus, 'plan_ready')))
    .returning({ id: t.id })
    .execute()) as Array<{ id: number }>;
  return rows.length > 0;
}

/** "Approve and build": the SAME row becomes a queued fix with the build's prompt. */
export async function markPlanApproved(
  ctx: AgentContext,
  id: number,
  input: { prompt: string; baseSha: string },
): Promise<boolean> {
  const t = ctx.schema.aiFixes;
  const rows = (await ctx.db
    .update(t)
    .set({ status: 'queued', planStatus: 'approved', prompt: input.prompt, baseSha: input.baseSha, error: null })
    .where(and(eq(t.id, id), eq(t.status, 'planned'), eq(t.planStatus, 'plan_ready')))
    .returning({ id: t.id })
    .execute()) as Array<{ id: number }>;
  return rows.length > 0;
}

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

// Heal rows left `queued`/`running` by a crash/restart (no live job can resume them).
export async function reconcileOrphanedFixes(ctx: AgentContext): Promise<number> {
  const t = ctx.schema.aiFixes;
  // A planning pass cut off by the restart: a plan that already has a revision goes back to waiting
  // for the reader; one that never produced a plan has failed.
  const replans = (await ctx.db
    .update(t)
    .set({ planStatus: 'plan_ready', error: 'The plan was not updated: interrupted by a server restart' })
    .where(and(eq(t.status, 'planned'), eq(t.planStatus, 'planning'), isNotNull(t.plan)))
    .returning({ id: t.id })
    .execute()) as Array<{ id: number }>;
  const firstPlans = (await ctx.db
    .update(t)
    .set({ status: 'failed', planStatus: 'failed', error: 'interrupted by a server restart', finishedAt: new Date() })
    .where(and(eq(t.status, 'planned'), eq(t.planStatus, 'planning')))
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
    .where(eq(t.status, 'queued'))
    .returning({ id: t.id })
    .execute()) as Array<{ id: number }>;
  const rows2 = (await ctx.db
    .update(t)
    .set({
      status: 'failed',
      error: 'interrupted by a server restart',
      finishedAt: new Date(),
    })
    .where(eq(t.status, 'running'))
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
