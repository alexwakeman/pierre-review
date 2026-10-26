import { and, desc, eq, gte, inArray, isNotNull, isNull, ne, notInArray, or } from 'drizzle-orm';
import type {
  DesignDiagram,
  SequenceDiagramKind,
  SequenceDiagramMember,
  SequenceDiagramRefusal,
  SequenceDiagramStatus,
  SequenceDiagramTrigger,
  SequenceDiagramView,
  StoredPrFile,
} from '@pierre-review/shared';
import { aiRunProvider } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import { claudeModelChoice, expectedRanOn } from '../../ai/provider.js';

// THE DESIGN DIAGRAMS' STORAGE (`sequence_diagrams`, migrations 0115+0118+0119 / pg 0102+0105+0106).
// Every read and write is scoped by accountId; an id from another account reads as null and writes
// nothing. Portable terminals only (`.execute()`, `.returning().execute()`).
//
// ⚠ ONLY DESIGN-ERA ROWS ARE READ. The table also holds the retired Mermaid diagrams (`source`, a
// Mermaid `diagram_type`). Every run queued now is stamped `diagram_type = DESIGN_DIAGRAM_TYPE` at
// INSERT, and a succeeded one carries `design`; the slot reads (`latestDiagram`,
// `latestSucceededDiagram`) take only stamped rows, and a succeeded row only with a design — so an
// old Mermaid row is "no diagram yet" and the next review (its fingerprint version moved) or a Redraw
// draws a design. `source` is kept (no column drops) and never written.

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
  // 0128: who ran it; NULL on older rows (read through `aiRunProvider`).
  provider?: string | null;
  title: string | null;
  caption: string | null;
  diagramType: string | null;
  source: string | null;
  design: DesignDiagram | null;
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

/** The `diagram_type` every design-era row carries from the moment it is queued. */
export const DESIGN_DIAGRAM_TYPE = 'design';

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

/**
 * Is automatic diagram drawing on for the workspace holding this PR's repo
 * (`workspaces.auto_diagrams_enabled`, migration 0126)? ON by default: only a stored false is off,
 * so a repo with no membership row (or an unknown PR) reads ON — the trigger's own checks decide.
 */
export async function diagramsSwitchedOnForPr(ctx: Ctx, accountId: number, prId: number): Promise<boolean> {
  const { workspaces: w, workspaceRepos: wr, pullRequests: pr } = s(ctx);
  const rows = (await ctx.db
    .select({ on: w.autoDiagramsEnabled })
    .from(pr)
    .innerJoin(wr, and(eq(wr.repoId, pr.repoId), eq(wr.accountId, accountId)))
    .innerJoin(w, and(eq(w.id, wr.workspaceId), eq(w.accountId, accountId)))
    .where(and(eq(pr.id, prId), eq(pr.accountId, accountId)))
    .limit(1)
    .execute()) as Array<{ on: boolean | null }>;
  return rows[0]?.on !== false;
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
 * Queue a diagram as a NEW row — one row per RUN. A Redraw at the same fingerprint never touches the
 * row holding the diagram it redraws, so the slot keeps showing that diagram while the run works and
 * after it fails, is cancelled or is cut off by a restart. "Is it drawn at this head?" stays one
 * lookup (any row at the fingerprint), and the slot reads the newest row and the newest SUCCEEDED row.
 */
export async function insertQueuedDiagram(ctx: Ctx, a: QueueDiagramArgs): Promise<number> {
  const d = t(ctx);
  const rows = (await ctx.db
    .insert(d)
    .values({
      accountId: a.accountId,
      kind: a.kind,
      subject: a.subject,
      fingerprint: a.fingerprint,
      prId: a.prId,
      ticketKey: a.ticketKey,
      headSha: a.headSha,
      members: a.members,
      trigger: a.trigger,
      diagramType: DESIGN_DIAGRAM_TYPE,
      status: 'queued',
      // Labelled by the provider it is expected to run on; the run stamps its own (`markDiagramRanOn`).
      ...expectedRanOn(claudeModelChoice(a.model)),
      createdAt: new Date(),
    })
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

/** Stamp what the run ACTUALLY ran on (provider + model id), whatever its outcome. */
export async function markDiagramRanOn(
  ctx: Ctx,
  accountId: number,
  id: number,
  ran: { provider: 'claude' | 'codex'; model: string },
): Promise<void> {
  await update(ctx, accountId, id, { provider: ran.provider, model: ran.model });
}

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
  d: { title: string | null; caption: string | null; design: DesignDiagram },
  t0: Telemetry,
): Promise<void> {
  await update(ctx, accountId, id, {
    status: 'succeeded',
    title: d.title,
    caption: d.caption,
    diagramType: DESIGN_DIAGRAM_TYPE,
    design: d.design,
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

/** The error a restart stamps on an orphaned run — NOT a judgement on the subject (see diagramExistsAt). */
export const INTERRUPTED_ERROR = 'Interrupted by a restart.';

/** A restart orphaned these: fail them (the next review, or a click, redraws). */
export async function reconcileOrphanedDiagrams(ctx: Ctx): Promise<number> {
  const d = t(ctx);
  const changed = (await ctx.db
    .update(d)
    .set({ status: 'failed', error: INTERRUPTED_ERROR, completedAt: new Date() })
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
    .where(
      and(
        eq(d.accountId, accountId),
        eq(d.kind, kind),
        eq(d.subject, subject),
        eq(d.fingerprint, fingerprint),
        // A run a RESTART killed never finished, so it says nothing about this fingerprint: the next
        // review draws again. Any other failure still counts (a click redraws it), so a run that
        // fails on its own is not re-billed on every review.
        or(ne(d.status, 'failed'), isNull(d.error), ne(d.error, INTERRUPTED_ERROR)),
      ),
    )
    .limit(1)
    .execute()) as Array<{ id: number }>;
  return rows.length > 0;
}

/** A design-era row: stamped at queue time, and a succeeded one carries its design. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const designEra = (d: any) =>
  and(eq(d.diagramType, DESIGN_DIAGRAM_TYPE), or(ne(d.status, 'succeeded'), isNotNull(d.design)));

/** The newest design-era row of one subject (any status), or null. */
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
    .where(and(eq(d.accountId, accountId), eq(d.kind, kind), eq(d.subject, subject), designEra(d)))
    .orderBy(desc(d.createdAt), desc(d.id))
    .limit(1)
    .execute()) as DiagramRow[];
  return rows[0] ?? null;
}

/**
 * The newest SUCCEEDED design of one subject, or null — shown under a newer run that refused or failed,
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
    .where(
      and(eq(d.accountId, accountId), eq(d.kind, kind), eq(d.subject, subject), eq(d.status, 'succeeded'), designEra(d)),
    )
    .orderBy(desc(d.createdAt), desc(d.id))
    .limit(1)
    .execute()) as DiagramRow[];
  return rows[0] ?? null;
}

// The refusals the SERVER decides before any model runs: free, so they do not use up the cap. Every
// other row counts — queued and running ones (they will spend), failures, and 'invalid_diagram', which
// is a billed run whose answer failed validation.
const FREE_REFUSALS: readonly SequenceDiagramRefusal[] = ['no_code', 'head_moved', 'unreadable', 'too_few_prs', 'too_many_prs'];

/** Diagrams a finished review queued since `dayStartMs` that ran (or will run) the model. */
export async function countReviewDiagramsSince(ctx: Ctx, accountId: number, dayStartMs: number): Promise<number> {
  const d = t(ctx);
  const rows = (await ctx.db
    .select({ id: d.id })
    .from(d)
    .where(
      and(
        eq(d.accountId, accountId),
        eq(d.trigger, 'review'),
        or(isNull(d.refusal), notInArray(d.refusal, [...FREE_REFUSALS])),
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
    design: row.status === 'succeeded' ? (row.design ?? null) : null,
    headSha: row.headSha,
    members: row.members ?? [],
    refusal: (row.refusal as SequenceDiagramRefusal | null) ?? null,
    error: row.error,
    current,
    createdAt: iso(row.createdAt)!,
    completedAt: iso(row.completedAt),
    costUsd: row.costUsd,
    model: row.model,
    provider: aiRunProvider(row.provider, row.model),
  };
}
