import { and, desc, eq, gte, inArray, isNull } from 'drizzle-orm';
import type {
  SequenceDiagramKind,
  SequenceDiagramMember,
  SequenceDiagramRefusal,
  SequenceDiagramStatus,
  SequenceDiagramTrigger,
  SequenceDiagramType,
  SequenceDiagramView,
  StoredPrFile,
} from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';

// THE SEQUENCE DIAGRAMS' STORAGE (`sequence_diagrams`, migration 0115 / pg 0102). Every read and
// write is scoped by accountId; an id from another account reads as null and writes nothing.
// Portable terminals only (`.execute()`, `.returning().execute()`, `onConflictDoUpdate`).

/* eslint-disable @typescript-eslint/no-explicit-any */
const t = (ctx: Pick<AgentContext, 'schema'>): any => (ctx.schema as any).sequenceDiagrams;
const s = (ctx: Pick<AgentContext, 'schema'>): any => ctx.schema as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

type Ctx = Pick<AgentContext, 'db' | 'schema'>;

export interface DiagramRow {
  id: number;
  accountId: number;
  kind: SequenceDiagramKind;
  subject: string;
  prId: number | null;
  ticketKey: string | null;
  fingerprint: string;
  headSha: string | null;
  members: SequenceDiagramMember[] | null;
  trigger: SequenceDiagramTrigger;
  status: SequenceDiagramStatus;
  model: string;
  title: string | null;
  caption: string | null;
  diagramType: string | null;
  source: string | null;
  refusal: string | null;
  error: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface Telemetry {
  costUsd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  numTurns?: number | null;
}

// ---- the PR the pipeline reads ----

export interface DiagramPrContext {
  prId: number;
  repoId: number;
  owner: string;
  name: string;
  number: number;
  title: string;
  state: string;
  headSha: string | null;
  files: StoredPrFile[] | null;
  additions: number;
  deletions: number;
  changedFiles: number;
}

export async function getDiagramPrContext(ctx: Ctx, accountId: number, prId: number): Promise<DiagramPrContext | null> {
  const { pullRequests: pr, repos } = s(ctx);
  const rows = (await ctx.db
    .select({
      prId: pr.id,
      repoId: pr.repoId,
      owner: repos.owner,
      name: repos.name,
      number: pr.number,
      title: pr.title,
      state: pr.state,
      headSha: pr.headSha,
      files: pr.files,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
    })
    .from(pr)
    .innerJoin(repos, and(eq(repos.id, pr.repoId), eq(repos.accountId, pr.accountId)))
    .where(and(eq(pr.id, prId), eq(pr.accountId, accountId)))
    .limit(1)
    .execute()) as DiagramPrContext[];
  return rows[0] ?? null;
}

/** The stored file lists of these PRs (this account only) — the story's "any code?" pre-check. */
export async function getPrFileStats(
  ctx: Ctx,
  accountId: number,
  prIds: readonly number[],
): Promise<Map<number, Pick<DiagramPrContext, 'files' | 'additions' | 'deletions' | 'changedFiles'>>> {
  const out = new Map<number, Pick<DiagramPrContext, 'files' | 'additions' | 'deletions' | 'changedFiles'>>();
  const ids = [...new Set(prIds)];
  if (ids.length === 0) return out;
  const pr = s(ctx).pullRequests;
  const rows = (await ctx.db
    .select({ id: pr.id, files: pr.files, additions: pr.additions, deletions: pr.deletions, changedFiles: pr.changedFiles })
    .from(pr)
    .where(and(eq(pr.accountId, accountId), inArray(pr.id, ids)))
    .execute()) as Array<{ id: number } & Pick<DiagramPrContext, 'files' | 'additions' | 'deletions' | 'changedFiles'>>;
  for (const r of rows) out.set(r.id, r);
  return out;
}

// ---- writes ----

export interface QueueDiagramArgs {
  accountId: number;
  kind: SequenceDiagramKind;
  subject: string;
  prId: number | null;
  ticketKey: string | null;
  fingerprint: string;
  headSha: string | null;
  members: SequenceDiagramMember[] | null;
  trigger: SequenceDiagramTrigger;
  model: string;
}

/**
 * Queue a diagram. ONE row per (account, kind, subject, fingerprint): a Redraw at the same
 * fingerprint REWRITES it (every output cleared), so "is it drawn at this head?" stays one lookup.
 */
export async function upsertQueuedDiagram(ctx: Ctx, a: QueueDiagramArgs): Promise<number> {
  const d = t(ctx);
  const now = new Date();
  const reset = {
    prId: a.prId,
    ticketKey: a.ticketKey,
    headSha: a.headSha,
    members: a.members,
    trigger: a.trigger,
    status: 'queued' as const,
    model: a.model,
    title: null,
    caption: null,
    diagramType: null,
    source: null,
    refusal: null,
    error: null,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    numTurns: null,
    createdAt: now,
    startedAt: null,
    completedAt: null,
  };
  const rows = (await ctx.db
    .insert(d)
    .values({ accountId: a.accountId, kind: a.kind, subject: a.subject, fingerprint: a.fingerprint, ...reset })
    .onConflictDoUpdate({ target: [d.accountId, d.kind, d.subject, d.fingerprint], set: reset })
    .returning({ id: d.id })
    .execute()) as Array<{ id: number }>;
  return rows[0]!.id;
}

async function update(ctx: Ctx, accountId: number, id: number, set: Record<string, unknown>): Promise<void> {
  const d = t(ctx);
  await ctx.db
    .update(d)
    .set(set)
    .where(and(eq(d.id, id), eq(d.accountId, accountId)))
    .execute();
}

const tel = (x: Telemetry = {}) => ({
  costUsd: x.costUsd ?? null,
  inputTokens: x.inputTokens ?? null,
  outputTokens: x.outputTokens ?? null,
  numTurns: x.numTurns ?? null,
});

export async function markDiagramRunning(
  ctx: Ctx,
  accountId: number,
  id: number,
  patch: { headSha?: string | null; members?: SequenceDiagramMember[] | null } = {},
): Promise<void> {
  await update(ctx, accountId, id, { status: 'running', startedAt: new Date(), ...patch });
}

export async function markDiagramRefused(
  ctx: Ctx,
  accountId: number,
  id: number,
  refusal: SequenceDiagramRefusal,
  t0: Telemetry = {},
): Promise<void> {
  await update(ctx, accountId, id, { status: 'refused', refusal, completedAt: new Date(), ...tel(t0) });
}

export async function markDiagramFailed(
  ctx: Ctx,
  accountId: number,
  id: number,
  error: string,
  t0: Telemetry = {},
  refusal: SequenceDiagramRefusal | null = null,
): Promise<void> {
  await update(ctx, accountId, id, {
    status: 'failed',
    error: error.slice(0, 500),
    refusal,
    completedAt: new Date(),
    ...tel(t0),
  });
}

export async function markDiagramCancelled(ctx: Ctx, accountId: number, id: number, t0: Telemetry = {}): Promise<void> {
  await update(ctx, accountId, id, { status: 'cancelled', completedAt: new Date(), ...tel(t0) });
}

export async function saveDiagramSuccess(
  ctx: Ctx,
  accountId: number,
  id: number,
  d: { title: string | null; caption: string | null; diagramType: SequenceDiagramType; source: string },
  t0: Telemetry,
): Promise<void> {
  await update(ctx, accountId, id, {
    status: 'succeeded',
    title: d.title,
    caption: d.caption,
    diagramType: d.diagramType,
    source: d.source,
    completedAt: new Date(),
    ...tel(t0),
  });
}

/** The run's spend into the AI-usage ledger — success, failure and cancel alike (it was billed). */
export async function recordDiagramUsage(
  ctx: Pick<AgentContext, 'recordAiUsage'>,
  a: { accountId: number; model: string; prId: number | null },
  t0: Telemetry,
): Promise<void> {
  if (t0.costUsd == null || !Number.isFinite(t0.costUsd) || t0.costUsd <= 0) return;
  await ctx
    .recordAiUsage({
      accountId: a.accountId,
      seam: 'agent',
      feature: 'sequence_diagram',
      model: a.model,
      costUsd: t0.costUsd,
      inputTokens: t0.inputTokens ?? null,
      outputTokens: t0.outputTokens ?? null,
      prId: a.prId,
    })
    .catch(() => {});
}

/** A restart orphaned these: fail them (a click redraws). */
export async function reconcileOrphanedDiagrams(ctx: Ctx): Promise<number> {
  const d = t(ctx);
  const changed = (await ctx.db
    .update(d)
    .set({ status: 'failed', error: 'Interrupted by a restart.', completedAt: new Date() })
    .where(inArray(d.status, ['queued', 'running']))
    .returning({ id: d.id })
    .execute()) as Array<{ id: number }>;
  return changed.length;
}

// ---- reads ----

export async function getDiagramRow(ctx: Ctx, accountId: number, id: number): Promise<DiagramRow | null> {
  const d = t(ctx);
  const rows = (await ctx.db
    .select()
    .from(d)
    .where(and(eq(d.id, id), eq(d.accountId, accountId)))
    .limit(1)
    .execute()) as DiagramRow[];
  return rows[0] ?? null;
}

/** Is there a row at exactly this fingerprint (any status)? */
export async function diagramExistsAt(
  ctx: Ctx,
  accountId: number,
  kind: SequenceDiagramKind,
  subject: string,
  fingerprint: string,
): Promise<boolean> {
  const d = t(ctx);
  const rows = (await ctx.db
    .select({ id: d.id })
    .from(d)
    .where(and(eq(d.accountId, accountId), eq(d.kind, kind), eq(d.subject, subject), eq(d.fingerprint, fingerprint)))
    .limit(1)
    .execute()) as Array<{ id: number }>;
  return rows.length > 0;
}

/** The newest row of one subject (any status), or null. */
export async function latestDiagram(
  ctx: Ctx,
  accountId: number,
  kind: SequenceDiagramKind,
  subject: string,
): Promise<DiagramRow | null> {
  const d = t(ctx);
  const rows = (await ctx.db
    .select()
    .from(d)
    .where(and(eq(d.accountId, accountId), eq(d.kind, kind), eq(d.subject, subject)))
    .orderBy(desc(d.createdAt), desc(d.id))
    .limit(1)
    .execute()) as DiagramRow[];
  return rows[0] ?? null;
}

/**
 * The newest SUCCEEDED row of one subject, or null — shown under a newer run that refused or failed,
 * so a failed redraw never hides the last good diagram.
 */
export async function latestSucceededDiagram(
  ctx: Ctx,
  accountId: number,
  kind: SequenceDiagramKind,
  subject: string,
): Promise<DiagramRow | null> {
  const d = t(ctx);
  const rows = (await ctx.db
    .select()
    .from(d)
    .where(and(eq(d.accountId, accountId), eq(d.kind, kind), eq(d.subject, subject), eq(d.status, 'succeeded')))
    .orderBy(desc(d.createdAt), desc(d.id))
    .limit(1)
    .execute()) as DiagramRow[];
  return rows[0] ?? null;
}

/** Diagrams a finished review queued since `dayStartMs` (refusals cost nothing and do not count). */
export async function countReviewDiagramsSince(ctx: Ctx, accountId: number, dayStartMs: number): Promise<number> {
  const d = t(ctx);
  const rows = (await ctx.db
    .select({ id: d.id })
    .from(d)
    .where(
      and(
        eq(d.accountId, accountId),
        eq(d.trigger, 'review'),
        isNull(d.refusal),
        gte(d.createdAt, new Date(dayStartMs)),
      ),
    )
    .execute()) as Array<{ id: number }>;
  return rows.length;
}

// ---- the wire ----

export function toDiagramView(row: DiagramRow, current: boolean): SequenceDiagramView {
  const iso = (v: Date | number | null): string | null =>
    v == null ? null : (v instanceof Date ? v : new Date(v)).toISOString();
  return {
    id: row.id,
    kind: row.kind,
    prId: row.kind === 'pr' ? row.prId : null,
    ticketIdent: row.kind === 'story' ? row.subject : null,
    ticketKey: row.ticketKey,
    status: row.status,
    trigger: row.trigger,
    title: row.title,
    caption: row.caption,
    diagramType: (row.diagramType as SequenceDiagramType | null) ?? null,
    source: row.status === 'succeeded' ? row.source : null,
    headSha: row.headSha,
    members: row.members ?? [],
    refusal: (row.refusal as SequenceDiagramRefusal | null) ?? null,
    error: row.error,
    current,
    createdAt: iso(row.createdAt)!,
    completedAt: iso(row.completedAt),
    costUsd: row.costUsd,
  };
}
