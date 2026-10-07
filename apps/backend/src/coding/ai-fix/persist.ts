import { and, desc, eq } from 'drizzle-orm';
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
      status: 'queued',
      model: input.model,
      seed: input.seed,
      sourceReviewId: input.sourceReviewId,
      prompt: input.prompt,
      trigger: input.trigger ?? 'manual',
      // Omitted (→ NULL) on a plain run: null means "this run had no review items".
      ...(items != null ? { reviewItems: JSON.stringify(items) } : {}),
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

// Heal rows left `queued`/`running` by a crash/restart (no live job can resume them).
export async function reconcileOrphanedFixes(ctx: AgentContext): Promise<number> {
  const t = ctx.schema.aiFixes;
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
  return rows.length + rows2.length;
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
