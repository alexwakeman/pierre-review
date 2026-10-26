import { and, desc, eq, gte, inArray, isNull } from 'drizzle-orm';
import type {
  ClaudeThreadAssessment,
  ThreadCheckRefusal,
  ThreadCheckRun,
  ThreadCheckStatus,
  ThreadCheckTrigger,
} from '@pierre-review/shared';
import { aiRunProvider } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import { claudeModelChoice, queuedRanOn, type AgentProviderId } from '../../ai/provider.js';

// CHECK THREADS — the persistence half: `claude_thread_checks` (migration 0122 / pg 0109) through
// ctx.db + ctx.schema, like ci-review/persist.ts. Every read predicates on accountId; an id-addressed
// getter answers null for another account's id (→ 404). The fold that overlays a check's judgements
// on the latest review's lives in ./thread-judgements.ts.

/* eslint-disable @typescript-eslint/no-explicit-any */
const t = (ctx: AgentContext): any => (ctx.schema as any).claudeThreadChecks;
/* eslint-enable @typescript-eslint/no-explicit-any */

const iso = (d: unknown): string | null =>
  d instanceof Date ? d.toISOString() : d == null ? null : new Date(d as string | number).toISOString();

export interface ThreadCheckRow {
  id: number;
  accountId: number;
  workspaceId: number;
  prId: number;
  repoId: number;
  headSha: string;
  trigger: ThreadCheckTrigger;
  status: ThreadCheckStatus;
  model: string;
  // 0128: who ran it; NULL on older rows (read through `aiRunProvider`).
  provider?: string | null;
  threadsSent: number | null;
  threadAssessments: ClaudeThreadAssessment[] | null;
  commentsThrough: Date | null;
  refused: string | null;
  error: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}

type Telemetry = {
  costUsd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  numTurns?: number | null;
  // The provider already wrote the run's ledger row (Codex; RunThreadCheckResult.usageRecorded).
  usageRecorded?: boolean;
};

export function threadCheckWire(r: ThreadCheckRow): ThreadCheckRun {
  return {
    id: r.id,
    prId: r.prId,
    headSha: r.headSha,
    trigger: r.trigger,
    status: r.status,
    model: r.model,
    provider: aiRunProvider(r.provider, r.model),
    refused: (r.refused as ThreadCheckRefusal | null) ?? null,
    error: r.error ?? null,
    threadsSent: r.threadsSent ?? null,
    costUsd: r.costUsd ?? null,
    createdAt: iso(r.createdAt) ?? new Date(0).toISOString(),
    startedAt: iso(r.startedAt),
    completedAt: iso(r.completedAt),
  };
}

export interface QueueThreadCheckArgs {
  accountId: number;
  workspaceId: number;
  prId: number;
  repoId: number;
  headSha: string;
  trigger: ThreadCheckTrigger;
  model: string;
  // The newest qualifying comment the run covers (auto: the sweeper's key; manual: the loader's).
  commentsThrough: Date | null;
  // The provider it will run on (the reader's pick for a check beside a manual review). Absent ⇒ default.
  provider?: AgentProviderId | null;
}

export async function insertQueuedThreadCheck(ctx: AgentContext, a: QueueThreadCheckArgs): Promise<number> {
  const ct = t(ctx);
  const rows = (await ctx.db
    .insert(ct)
    .values({
      accountId: a.accountId,
      workspaceId: a.workspaceId,
      prId: a.prId,
      repoId: a.repoId,
      headSha: a.headSha,
      trigger: a.trigger,
      status: 'queued',
      // Labelled by the provider it will run on; the run stamps what ran (`markThreadCheckRanOn`).
      ...queuedRanOn(claudeModelChoice(a.model), a.provider),
      commentsThrough: a.commentsThrough,
    })
    .returning({ id: ct.id })
    .execute()) as Array<{ id: number }>;
  return rows[0]!.id;
}

/** Stamp what the run ACTUALLY ran on (provider + model id), whatever its outcome. */
export async function markThreadCheckRanOn(
  ctx: AgentContext,
  accountId: number,
  id: number,
  ran: { provider: 'claude' | 'codex'; model: string },
): Promise<void> {
  const ct = t(ctx);
  await ctx.db
    .update(ct)
    .set({ provider: ran.provider, model: ran.model })
    .where(and(eq(ct.id, id), eq(ct.accountId, accountId)))
    .execute();
}

export async function markThreadCheckRunning(
  ctx: AgentContext,
  accountId: number,
  id: number,
  // `startedAt` is when the run read the current judgements to plan (the fold keys on it).
  p: { headSha: string; threadsSent: number; commentsThrough: Date | null; startedAt?: Date },
): Promise<void> {
  const ct = t(ctx);
  await ctx.db
    .update(ct)
    .set({
      status: 'running',
      headSha: p.headSha,
      threadsSent: p.threadsSent,
      ...(p.commentsThrough ? { commentsThrough: p.commentsThrough } : {}),
      startedAt: p.startedAt ?? new Date(),
    })
    .where(and(eq(ct.id, id), eq(ct.accountId, accountId)))
    .execute();
}

/** The server declined to run Claude: stored as `failed` with the reason (no model ran). */
export async function markThreadCheckRefused(
  ctx: AgentContext,
  accountId: number,
  id: number,
  reason: ThreadCheckRefusal,
): Promise<void> {
  const ct = t(ctx);
  await ctx.db
    .update(ct)
    .set({ status: 'failed', refused: reason, threadsSent: 0, completedAt: new Date() })
    .where(and(eq(ct.id, id), eq(ct.accountId, accountId)))
    .execute();
}

async function recordUsage(
  ctx: AgentContext,
  accountId: number,
  run: Pick<ThreadCheckRow, 'model' | 'prId' | 'repoId'> | null,
  tm: Telemetry,
): Promise<void> {
  if (tm.usageRecorded) return;
  if (run == null || tm.costUsd == null || !Number.isFinite(tm.costUsd) || tm.costUsd <= 0) return;
  await ctx
    .recordAiUsage({
      accountId,
      seam: 'agent',
      feature: 'thread_check',
      model: run.model,
      costUsd: tm.costUsd,
      inputTokens: tm.inputTokens ?? null,
      outputTokens: tm.outputTokens ?? null,
      prId: run.prId,
      repoId: run.repoId,
    })
    .catch(() => {});
}

export async function saveThreadCheckSuccess(
  ctx: AgentContext,
  accountId: number,
  id: number,
  data: Telemetry & { assessments: ClaudeThreadAssessment[] },
): Promise<void> {
  const ct = t(ctx);
  await ctx.db
    .update(ct)
    .set({
      status: 'succeeded',
      threadAssessments: data.assessments,
      costUsd: data.costUsd ?? null,
      inputTokens: data.inputTokens ?? null,
      outputTokens: data.outputTokens ?? null,
      numTurns: data.numTurns ?? null,
      completedAt: new Date(),
    })
    .where(and(eq(ct.id, id), eq(ct.accountId, accountId)))
    .execute();
  await recordUsage(ctx, accountId, await getThreadCheckRow(ctx, accountId, id), data);
}

export async function markThreadCheckFailed(
  ctx: AgentContext,
  accountId: number,
  id: number,
  error: string,
  tm: Telemetry = {},
): Promise<void> {
  const ct = t(ctx);
  await ctx.db
    .update(ct)
    .set({
      status: 'failed',
      error,
      costUsd: tm.costUsd ?? null,
      inputTokens: tm.inputTokens ?? null,
      outputTokens: tm.outputTokens ?? null,
      numTurns: tm.numTurns ?? null,
      completedAt: new Date(),
    })
    .where(and(eq(ct.id, id), eq(ct.accountId, accountId)))
    .execute();
  await recordUsage(ctx, accountId, await getThreadCheckRow(ctx, accountId, id), tm);
}

export async function markThreadCheckCancelled(
  ctx: AgentContext,
  accountId: number,
  id: number,
  tm: Telemetry = {},
): Promise<void> {
  const ct = t(ctx);
  await ctx.db
    .update(ct)
    .set({
      status: 'cancelled',
      completedAt: new Date(),
      ...(tm.costUsd != null ? { costUsd: tm.costUsd } : {}),
      ...(tm.inputTokens != null ? { inputTokens: tm.inputTokens } : {}),
      ...(tm.outputTokens != null ? { outputTokens: tm.outputTokens } : {}),
      ...(tm.numTurns != null ? { numTurns: tm.numTurns } : {}),
    })
    .where(and(eq(ct.id, id), eq(ct.accountId, accountId)))
    .execute();
  await recordUsage(ctx, accountId, await getThreadCheckRow(ctx, accountId, id), tm);
}

/** Boot: no job survives a restart, so queued/running rows are failed. Returns how many. */
export async function reconcileOrphanedThreadChecks(ctx: AgentContext): Promise<number> {
  const ct = t(ctx);
  const changed = (await ctx.db
    .update(ct)
    .set({ status: 'failed', error: 'interrupted by restart', completedAt: new Date() })
    .where(inArray(ct.status, ['queued', 'running']))
    .returning({ id: ct.id })
    .execute()) as Array<{ id: number }>;
  return changed.length;
}

export async function getThreadCheckRow(
  ctx: AgentContext,
  accountId: number,
  id: number,
): Promise<ThreadCheckRow | null> {
  const ct = t(ctx);
  const rows = (await ctx.db
    .select()
    .from(ct)
    .where(and(eq(ct.id, id), eq(ct.accountId, accountId)))
    .limit(1)
    .execute()) as ThreadCheckRow[];
  return rows[0] ?? null;
}

/** The PR's newest check (any status), this account only. */
export async function getLatestThreadCheck(
  ctx: AgentContext,
  accountId: number,
  prId: number,
): Promise<ThreadCheckRow | null> {
  const ct = t(ctx);
  const rows = (await ctx.db
    .select()
    .from(ct)
    .where(and(eq(ct.prId, prId), eq(ct.accountId, accountId)))
    .orderBy(desc(ct.id))
    .limit(1)
    .execute()) as ThreadCheckRow[];
  return rows[0] ?? null;
}

/**
 * Automatic checks a workspace started since `dayStartMs` — the THREAD_CHECK_DAILY_CAP counter. A
 * server refusal ran no model and is not counted; a queued or running row counts from the start.
 */
export async function countAutoThreadChecksSince(
  ctx: AgentContext,
  accountId: number,
  workspaceId: number,
  dayStartMs: number,
): Promise<number> {
  const ct = t(ctx);
  const rows = (await ctx.db
    .select({ id: ct.id })
    .from(ct)
    .where(
      and(
        eq(ct.accountId, accountId),
        eq(ct.workspaceId, workspaceId),
        eq(ct.trigger, 'auto'),
        isNull(ct.refused),
        gte(ct.createdAt, new Date(dayStartMs)),
      ),
    )
    .execute()) as Array<{ id: number }>;
  return rows.length;
}
