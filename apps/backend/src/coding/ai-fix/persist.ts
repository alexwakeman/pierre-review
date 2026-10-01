import { and, desc, eq } from 'drizzle-orm';
import type {
  AiFixCommentTarget,
  AiFixCommentVerdict,
  AiFixSeed,
  AiFixStatus,
} from '@pierre-review/shared';
import type { GenerateFixResult } from '../../pro/contract.js';
import type { AgentContext } from '../../review/agent-context.js';
import { mapCommentVerdicts, type ResolvedCommentTarget } from './comment-seed.js';

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
  seed: AiFixSeed;
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
  // JSON, comments-seeded runs only (migration 0024) — see parseCommentTargets/…Verdicts.
  commentTargets: string | null;
  commentVerdicts: string | null;
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
    // seed === 'comments': the resolved targets, stored BEFORE the agent runs so the row always
    // knows what it was asked to do (a run that fails or is cancelled still shows its list).
    commentTargets?: AiFixCommentTarget[] | null;
  },
): Promise<number> {
  const t = ctx.schema.aiFixes;
  const targets = input.commentTargets;
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
      // Omitted (→ NULL) rather than written as `[]` on every other seed: null means "this run had
      // no comment list", which is what `rowToAiFix` reports to the client.
      ...(targets != null && targets.length > 0
        ? { commentTargets: JSON.stringify(targets) }
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
  // seed === 'comments': the targets this run was given, so the agent's `ref`-keyed self-report
  // can be mapped back onto real comments (and every unreported target turned into an explicit
  // needs_human row). Absent on every other seed, which leaves the column NULL.
  commentTargets?: ResolvedCommentTarget[],
  // The refs `buildCommentSeedText` cut for prompt budget. Passed through so an unreported target
  // we NEVER SHOWED the agent says so, instead of blaming the agent for our own truncation.
  droppedRefs?: readonly string[],
): Promise<void> {
  const t = ctx.schema.aiFixes;
  const verdicts: AiFixCommentVerdict[] | null =
    commentTargets == null
      ? null
      : mapCommentVerdicts(commentTargets, data.commentVerdicts, droppedRefs ?? []);
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
      // Only ever written for a comments run; a non-comments run must not overwrite the column
      // with a literal null it never owned.
      ...(verdicts != null ? { commentVerdicts: JSON.stringify(verdicts) } : {}),
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
    })
    .where(eq(t.id, id))
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
 * The comments-seed JSON columns, parsed DEFENSIVELY.
 *
 * NULL (never `[]`) for a non-comments run, and null again for anything unparseable: these two
 * columns are read by `GET /api/pro/prs/:id/ai-fix`, which is what loads the whole AI Analysis and
 * Fix tab, so a throw here would take the tab down over a malformed blob rather than degrading to
 * "this run has no comment report". Same reason `parseFilesChanged` swallows — but the null/[]
 * distinction matters here, because `[]` is a real state on a comments run (see the shared
 * `AiFix.commentVerdicts` contract) and must not be manufactured from a parse failure.
 */
export function parseCommentTargets(json: string | null): AiFixCommentTarget[] | null {
  const v = parseJsonArray(json);
  return v == null ? null : (v as AiFixCommentTarget[]);
}

export function parseCommentVerdicts(json: string | null): AiFixCommentVerdict[] | null {
  const v = parseJsonArray(json);
  return v == null ? null : (v as AiFixCommentVerdict[]);
}

function parseJsonArray(json: string | null): unknown[] | null {
  if (json == null || json === '') return null;
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
