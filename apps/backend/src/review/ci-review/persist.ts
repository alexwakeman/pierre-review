import { and, desc, eq, gte, inArray, isNull } from 'drizzle-orm';
import type {
  CiAutoPostRecord,
  CiAutoPostWire,
  ClaudeCiFailure,
  ClaudeCiFailureCategory,
  ClaudeCiNotCheckedReason,
  ClaudeReviewCiState,
  CiReview,
  CiReviewItem,
  CiReviewRefusal,
  CiReviewStatus,
  CiReviewTrigger,
} from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import {
  asRefusal,
  countItems,
  failingKey as keyOf,
  normaliseFailingNames,
  type CiStateInputs,
  type SyncedCi,
} from './currency.js';

// THE CI REVIEW PERSISTENCE LAYER — reads and writes `ci_reviews` and `ci_review_items`
// (schema.sqlite.ts § CI review) through ctx.db + ctx.schema, like ticket-review/persist.ts. Every
// read predicates on accountId; an id-addressed getter answers null for another account's id
// (→ 404). The currency fold itself is pure and lives in ./currency.ts; this module only loads its
// inputs — including the SYNCED half (the PR's head and the failing names sync/upsert.ts logged in
// `ci_status_events`), so a states read never calls GitHub.

/* eslint-disable @typescript-eslint/no-explicit-any */
function tables(ctx: AgentContext): { cr: any; cri: any; prs: any; repos: any; wr: any; cse: any } {
  const s = ctx.schema as any;
  return {
    cr: s.ciReviews,
    cri: s.ciReviewItems,
    prs: s.pullRequests,
    repos: s.repos,
    wr: s.workspaceRepos,
    cse: s.ciStatusEvents,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const iso = (d: unknown): string | null =>
  d instanceof Date ? d.toISOString() : d == null ? null : new Date(d as string | number).toISOString();
const asDate = (d: unknown): Date | null =>
  d instanceof Date ? d : d == null ? null : new Date(d as string | number);

// ---- row shapes ----

export interface CiReviewRow {
  id: number;
  accountId: number;
  workspaceId: number;
  prId: number;
  repoId: number;
  headSha: string;
  failingKey: string | null;
  triggerKey: string | null;
  failingChecks: string[] | null;
  trigger: CiReviewTrigger;
  status: CiReviewStatus;
  model: string;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number | null;
  error: string | null;
  refused: string | null;
  ciState: ClaudeReviewCiState | null;
  summary: string | null;
  autoPost: CiAutoPostRecord | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}

export interface CiItemRow {
  id: number;
  ciReviewId: number;
  accountId: number;
  ref: string | null;
  checkName: string;
  jobId: number | null;
  step: string | null;
  url: string | null;
  sent: boolean;
  carried: boolean;
  status: 'diagnosed' | 'not_checked';
  notCheckedReason: string | null;
  cause: string | null;
  explanation: string | null;
  category: string | null;
  fixableInPr: boolean | null;
  path: string | null;
  line: number | null;
  suggestion: string | null;
  relatedFiles: Array<{ path: string; line: number | null }> | null;
  confidence: number | null;
  assessedAtHead: string;
  createdAt: Date;
}

// ---- the PR ----

export interface CiPrContext {
  prId: number;
  repoId: number;
  owner: string;
  name: string;
  number: number;
  title: string;
  state: string;
  headSha: string | null;
  workspaceId: number | null;
}

/** The PR a run is about, this account only; null otherwise. */
export async function getCiPrContext(ctx: AgentContext, accountId: number, prId: number): Promise<CiPrContext | null> {
  const { prs, repos, wr } = tables(ctx);
  const rows = (await ctx.db
    .select({
      prId: prs.id,
      repoId: prs.repoId,
      owner: repos.owner,
      name: repos.name,
      number: prs.number,
      title: prs.title,
      state: prs.state,
      headSha: prs.headSha,
    })
    .from(prs)
    .innerJoin(repos, eq(repos.id, prs.repoId))
    .where(and(eq(prs.id, prId), eq(prs.accountId, accountId)))
    .limit(1)
    .execute()) as Array<Omit<CiPrContext, 'workspaceId'>>;
  const r = rows[0];
  if (!r) return null;
  const ws = (await ctx.db
    .select({ workspaceId: wr.workspaceId })
    .from(wr)
    .where(and(eq(wr.repoId, r.repoId), eq(wr.accountId, accountId)))
    .limit(1)
    .execute()) as Array<{ workspaceId: number }>;
  return { ...r, workspaceId: ws[0]?.workspaceId ?? null };
}

// ---- writes ----

export interface QueueCiReviewArgs {
  accountId: number;
  workspaceId: number;
  prId: number;
  repoId: number;
  headSha: string;
  // The synced failing set that started an automatic run; null for a click.
  triggerKey: string | null;
  trigger: CiReviewTrigger;
  model: string;
}

/** Insert a queued run. */
export async function insertQueuedCiReview(ctx: AgentContext, a: QueueCiReviewArgs): Promise<number> {
  const { cr } = tables(ctx);
  const rows = (await ctx.db
    .insert(cr)
    .values({
      accountId: a.accountId,
      workspaceId: a.workspaceId,
      prId: a.prId,
      repoId: a.repoId,
      headSha: a.headSha,
      triggerKey: a.triggerKey,
      trigger: a.trigger,
      status: 'queued',
      model: a.model,
    })
    .returning({ id: cr.id })
    .execute()) as Array<{ id: number }>;
  return rows[0]!.id;
}

/** The run read the head's checks: store the head, the failing set it judges and the CI state. */
export async function markCiReviewRunning(
  ctx: AgentContext,
  accountId: number,
  id: number,
  // `clearTrigger`: the head moved after the run was queued, so the synced set that queued it was
  // another commit's — keeping it would let this run "cover" that set at the new head.
  p: { headSha: string; failingChecks: readonly string[]; ciState: ClaudeReviewCiState; clearTrigger?: boolean },
): Promise<void> {
  const { cr } = tables(ctx);
  const names = normaliseFailingNames(p.failingChecks);
  await ctx.db
    .update(cr)
    .set({
      status: 'running',
      headSha: p.headSha,
      ...(p.clearTrigger ? { triggerKey: null } : {}),
      failingChecks: names,
      failingKey: keyOf(names),
      ciState: p.ciState,
      startedAt: new Date(),
    })
    .where(and(eq(cr.id, id), eq(cr.accountId, accountId)))
    .execute();
}

/**
 * The server declined to run Claude. Stored as `failed` with the reason (never the model's). The
 * failing set is kept when known, so the sweeper does not try the same inputs again.
 *
 * ⚠ A `no_failures` refusal judged NOTHING, so it never covers the synced set that queued it: its
 * trigger key is cleared (a check re-running when the live read happened fails again under the
 * same name — that must still be explained). currency.ts `ciReviewDue` keeps it from re-queuing
 * every tick until the sync observes the failure again.
 */
export async function markCiReviewRefused(
  ctx: AgentContext,
  accountId: number,
  id: number,
  r: {
    reason: CiReviewRefusal;
    headSha?: string;
    failingChecks?: readonly string[];
    ciState?: ClaudeReviewCiState | null;
    clearTrigger?: boolean;
  },
): Promise<void> {
  const { cr } = tables(ctx);
  const names = r.failingChecks ? normaliseFailingNames(r.failingChecks) : null;
  await ctx.db
    .update(cr)
    .set({
      status: 'failed',
      refused: r.reason,
      ...(r.clearTrigger || r.reason === 'no_failures' ? { triggerKey: null } : {}),
      ...(r.headSha ? { headSha: r.headSha } : {}),
      ...(names ? { failingChecks: names, failingKey: keyOf(names) } : {}),
      ...(r.ciState !== undefined ? { ciState: r.ciState } : {}),
      completedAt: new Date(),
    })
    .where(and(eq(cr.id, id), eq(cr.accountId, accountId)))
    .execute();
}

/** One item as stored. The ClaudeCiFailure shape plus where to fix it. */
export interface CiItemWrite extends ClaudeCiFailure {
  path: string | null;
  line: number | null;
  suggestion: string | null;
}

type Telemetry = { costUsd?: number | null; inputTokens?: number | null; outputTokens?: number | null; numTurns?: number | null };

/** Store a succeeded run: the summary, then one item per failing check, in one transaction. */
export async function saveCiReviewSuccess(
  ctx: AgentContext,
  accountId: number,
  id: number,
  data: Telemetry & { summary: string | null; items: readonly CiItemWrite[] },
): Promise<void> {
  const { cr, cri } = tables(ctx);
  const run = await getCiReviewRow(ctx, accountId, id);
  if (run == null) return;
  await ctx.runTransaction(async (tx) => {
    await tx
      .update(cr)
      .set({
        status: 'succeeded',
        summary: data.summary,
        costUsd: data.costUsd ?? null,
        inputTokens: data.inputTokens ?? null,
        outputTokens: data.outputTokens ?? null,
        numTurns: data.numTurns ?? null,
        completedAt: new Date(),
      })
      .where(and(eq(cr.id, id), eq(cr.accountId, accountId)))
      .execute();
    for (const it of data.items) {
      await tx
        .insert(cri)
        .values({
          ciReviewId: id,
          accountId,
          ref: it.ref,
          checkName: it.checkName,
          jobId: it.jobId,
          step: it.step,
          url: it.url,
          sent: it.sent,
          carried: it.carried,
          status: it.status,
          notCheckedReason: it.notCheckedReason,
          cause: it.cause,
          explanation: it.explanation,
          category: it.category,
          fixableInPr: it.fixableInPr,
          path: it.path,
          line: it.line,
          suggestion: it.suggestion,
          relatedFiles: it.relatedFiles,
          confidence: it.confidence ?? null,
          assessedAtHead: it.assessedAtHead,
        })
        .execute();
    }
  });
  await recordCiReviewUsage(ctx, accountId, run, data);
}

/** The run's spend into the AI-usage ledger — on success, failure and cancel alike (it was billed). */
async function recordCiReviewUsage(
  ctx: AgentContext,
  accountId: number,
  run: Pick<CiReviewRow, 'model' | 'prId' | 'repoId'> | null,
  t: Telemetry,
): Promise<void> {
  if (run == null || t.costUsd == null || !Number.isFinite(t.costUsd) || t.costUsd <= 0) return;
  await ctx
    .recordAiUsage({
      accountId,
      seam: 'agent',
      feature: 'ci_review',
      model: run.model,
      costUsd: t.costUsd,
      inputTokens: t.inputTokens ?? null,
      outputTokens: t.outputTokens ?? null,
      prId: run.prId,
    })
    .catch(() => {});
}

/**
 * A run that failed. `retryable` (a thrown error — network, git or database) CLEARS both keys: the
 * sweeper skips a newer attempt on identical inputs, which is right for a run that finished without
 * an answer and wrong for one that never got that far.
 */
export async function markCiReviewFailed(
  ctx: AgentContext,
  accountId: number,
  id: number,
  error: string,
  telemetry: Telemetry = {},
  opts: { retryable?: boolean } = {},
): Promise<void> {
  const { cr } = tables(ctx);
  await ctx.db
    .update(cr)
    .set({
      status: 'failed',
      error,
      costUsd: telemetry.costUsd ?? null,
      inputTokens: telemetry.inputTokens ?? null,
      outputTokens: telemetry.outputTokens ?? null,
      numTurns: telemetry.numTurns ?? null,
      completedAt: new Date(),
      ...(opts.retryable ? { failingKey: null, triggerKey: null } : {}),
    })
    .where(and(eq(cr.id, id), eq(cr.accountId, accountId)))
    .execute();
  await recordCiReviewUsage(ctx, accountId, await getCiReviewRow(ctx, accountId, id), telemetry);
}

export async function markCiReviewCancelled(
  ctx: AgentContext,
  accountId: number,
  id: number,
  telemetry: Telemetry = {},
): Promise<void> {
  const { cr } = tables(ctx);
  await ctx.db
    .update(cr)
    .set({
      status: 'cancelled',
      completedAt: new Date(),
      ...(telemetry.costUsd != null ? { costUsd: telemetry.costUsd } : {}),
      ...(telemetry.inputTokens != null ? { inputTokens: telemetry.inputTokens } : {}),
      ...(telemetry.outputTokens != null ? { outputTokens: telemetry.outputTokens } : {}),
      ...(telemetry.numTurns != null ? { numTurns: telemetry.numTurns } : {}),
    })
    .where(and(eq(cr.id, id), eq(cr.accountId, accountId)))
    .execute();
  await recordCiReviewUsage(ctx, accountId, await getCiReviewRow(ctx, accountId, id), telemetry);
}

/**
 * Boot: no job survives a restart, so queued/running rows are failed, with both keys CLEARED — a
 * restart says nothing about the inputs. Returns how many.
 */
export async function reconcileOrphanedCiReviews(ctx: AgentContext): Promise<number> {
  const { cr } = tables(ctx);
  const changed = (await ctx.db
    .update(cr)
    .set({ status: 'failed', error: 'interrupted by restart', failingKey: null, triggerKey: null, completedAt: new Date() })
    .where(inArray(cr.status, ['queued', 'running']))
    .returning({ id: cr.id })
    .execute()) as Array<{ id: number }>;
  return changed.length;
}

// ---- reads ----

export async function getCiReviewRow(ctx: AgentContext, accountId: number, id: number): Promise<CiReviewRow | null> {
  const { cr } = tables(ctx);
  const rows = (await ctx.db
    .select()
    .from(cr)
    .where(and(eq(cr.id, id), eq(cr.accountId, accountId)))
    .limit(1)
    .execute()) as CiReviewRow[];
  return rows[0] ?? null;
}

async function readItems(ctx: AgentContext, accountId: number, runIds: readonly number[]): Promise<CiItemRow[]> {
  if (runIds.length === 0) return [];
  const { cri } = tables(ctx);
  const rows = (await ctx.db
    .select()
    .from(cri)
    .where(and(eq(cri.accountId, accountId), inArray(cri.ciReviewId, [...new Set(runIds)])))
    .execute()) as CiItemRow[];
  return rows.sort((a, b) => a.id - b.id);
}

export function toItem(r: CiItemRow): CiReviewItem {
  return {
    id: r.id,
    ciReviewId: r.ciReviewId,
    ref: r.ref,
    checkName: r.checkName,
    jobId: r.jobId == null ? null : Number(r.jobId),
    step: r.step,
    url: r.url,
    sent: !!r.sent,
    carried: !!r.carried,
    status: r.status,
    notCheckedReason: (r.notCheckedReason as ClaudeCiNotCheckedReason | null) ?? null,
    cause: r.cause,
    explanation: r.explanation,
    category: (r.category as ClaudeCiFailureCategory | null) ?? null,
    fixableInPr: r.fixableInPr == null ? null : !!r.fixableInPr,
    relatedFiles: Array.isArray(r.relatedFiles) ? r.relatedFiles : [],
    assessedAtHead: r.assessedAtHead,
    confidence: r.confidence == null ? null : Number(r.confidence),
    path: r.path,
    line: r.line,
    suggestion: r.suggestion,
  };
}

function toWire(r: CiReviewRow, items: readonly CiItemRow[]): CiReview {
  const wireItems = items.map(toItem);
  return {
    id: r.id,
    prId: r.prId,
    workspaceId: r.workspaceId,
    headSha: r.headSha,
    failingChecks: Array.isArray(r.failingChecks) ? r.failingChecks : [],
    trigger: r.trigger,
    status: r.status,
    model: r.model,
    costUsd: r.costUsd,
    error: r.error,
    refused: asRefusal(r.refused),
    createdAt: iso(r.createdAt) ?? new Date(0).toISOString(),
    startedAt: iso(r.startedAt),
    completedAt: iso(r.completedAt),
    ciState: r.ciState ?? null,
    summary: r.summary,
    items: wireItems,
    counts: r.status === 'succeeded' ? countItems(wireItems) : null,
    autoPost: autoPostWire(r.autoPost),
  };
}

/** The stored CI auto-post record → its wire half (no ids). */
export function autoPostWire(rec: CiAutoPostRecord | null | undefined): CiAutoPostWire | null {
  if (rec == null) return null;
  return {
    status: rec.status,
    at: rec.at,
    reason: rec.reason ?? null,
    error: rec.error ?? null,
    postedCount: rec.status === 'posted' ? (rec.itemIds ?? []).length : 0,
  };
}

async function hydrate(ctx: AgentContext, accountId: number, rows: readonly CiReviewRow[]): Promise<CiReview[]> {
  if (rows.length === 0) return [];
  const items = await readItems(ctx, accountId, rows.map((r) => r.id));
  return rows.map((r) => toWire(r, items.filter((i) => i.ciReviewId === r.id)));
}

/** One run in full; null when it is not this account's (→ 404). */
export async function getCiReviewById(ctx: AgentContext, accountId: number, id: number): Promise<CiReview | null> {
  const row = await getCiReviewRow(ctx, accountId, id);
  if (row == null) return null;
  return (await hydrate(ctx, accountId, [row]))[0] ?? null;
}

/** Newest row per PR (optionally of the given statuses), one query. */
async function latestRowsByPr(
  ctx: AgentContext,
  accountId: number,
  prIds: readonly number[],
  statuses: readonly CiReviewStatus[] | null,
): Promise<Map<number, CiReviewRow>> {
  const out = new Map<number, CiReviewRow>();
  const uniq = [...new Set(prIds)];
  if (uniq.length === 0) return out;
  const { cr } = tables(ctx);
  const preds = [eq(cr.accountId, accountId), inArray(cr.prId, uniq)];
  if (statuses != null) preds.push(inArray(cr.status, [...statuses]));
  const rows = (await ctx.db
    .select()
    .from(cr)
    .where(and(...preds))
    .orderBy(desc(cr.id))
    .execute()) as CiReviewRow[];
  for (const r of rows) if (!out.has(r.prId)) out.set(r.prId, r);
  return out;
}

/** The newest run of a PR (any status), in full; null when never run. */
export async function getLatestCiReviewForPr(ctx: AgentContext, accountId: number, prId: number): Promise<CiReview | null> {
  const row = (await latestRowsByPr(ctx, accountId, [prId], null)).get(prId);
  return row ? ((await hydrate(ctx, accountId, [row]))[0] ?? null) : null;
}

/** Batched: the latest succeeded run (+ its counts), the in-flight run and the newest attempt, per PR. */
export async function getCiStateInputs(
  ctx: AgentContext,
  accountId: number,
  prIds: readonly number[],
): Promise<Map<number, CiStateInputs>> {
  const out = new Map<number, CiStateInputs>();
  const [succeeded, live, any] = await Promise.all([
    latestRowsByPr(ctx, accountId, prIds, ['succeeded']),
    latestRowsByPr(ctx, accountId, prIds, ['queued', 'running']),
    latestRowsByPr(ctx, accountId, prIds, null),
  ]);
  const items = await readItems(ctx, accountId, [...succeeded.values()].map((r) => r.id));
  for (const prId of new Set(prIds)) {
    const s = succeeded.get(prId);
    const run = live.get(prId);
    const a = any.get(prId);
    out.set(prId, {
      latest:
        s != null
          ? {
              id: s.id,
              headSha: s.headSha,
              failingKey: s.failingKey,
              triggerKey: s.triggerKey,
              counts: countItems(items.filter((i) => i.ciReviewId === s.id).map((i) => ({ status: i.status, fixableInPr: i.fixableInPr == null ? null : !!i.fixableInPr }))),
              completedAt: asDate(s.completedAt),
            }
          : null,
      runningRunId: run?.id ?? null,
      latestAttempt:
        a != null
          ? {
              id: a.id,
              headSha: a.headSha,
              failingKey: a.failingKey,
              triggerKey: a.triggerKey,
              status: a.status,
              refused: a.refused,
              completedAt: asDate(a.completedAt),
            }
          : null,
    });
  }
  return out;
}

const RED = new Set(['failure', 'error']);

/**
 * The SYNCED CI of each PR, this account only: its head, and — when its rollup is red — the failing
 * names of the NEWEST `ci_status_events` row at that head (db/failing-checks.ts explains why only
 * that row speaks). No GitHub call. A PR not found is absent from the map.
 */
export async function readSyncedCi(
  ctx: AgentContext,
  accountId: number,
  prIds: readonly number[],
): Promise<Map<number, SyncedCi & { observedAtMs: number | null }>> {
  const out = new Map<number, SyncedCi & { observedAtMs: number | null }>();
  const uniq = [...new Set(prIds)];
  if (uniq.length === 0) return out;
  const { prs, cse } = tables(ctx);
  const rows = (await ctx.db
    .select({ id: prs.id, headSha: prs.headSha, ciStatus: prs.ciStatus })
    .from(prs)
    .where(and(eq(prs.accountId, accountId), inArray(prs.id, uniq)))
    .execute()) as Array<{ id: number; headSha: string | null; ciStatus: string | null }>;
  const red = rows.filter((r) => r.headSha != null && RED.has(r.ciStatus ?? ''));
  const events =
    red.length === 0
      ? []
      : ((await ctx.db
          .select({
            id: cse.id,
            prId: cse.prId,
            headSha: cse.headSha,
            status: cse.status,
            failingChecks: cse.failingChecks,
            observedAt: cse.observedAt,
          })
          .from(cse)
          .where(
            and(
              eq(cse.accountId, accountId),
              inArray(cse.prId, red.map((r) => r.id)),
              inArray(cse.headSha, [...new Set(red.map((r) => r.headSha!))]),
            ),
          )
          .execute()) as Array<{ id: number; prId: number; headSha: string; status: string; failingChecks: string[] | null; observedAt: Date }>);
  const headOf = new Map(red.map((r) => [r.id, r.headSha!]));
  const newest = new Map<number, (typeof events)[number]>();
  for (const e of events) {
    if (headOf.get(e.prId) !== e.headSha) continue;
    const cur = newest.get(e.prId);
    const t = new Date(e.observedAt).getTime();
    const ct = cur ? new Date(cur.observedAt).getTime() : -1;
    if (cur == null || t > ct || (t === ct && e.id > cur.id)) newest.set(e.prId, e);
  }
  for (const r of rows) {
    const e = newest.get(r.id);
    const names = e && RED.has(e.status) ? normaliseFailingNames(e.failingChecks ?? []) : [];
    out.set(r.id, {
      headSha: r.headSha,
      failingChecks: names,
      failingKey: keyOf(names),
      passing: r.ciStatus === 'success',
      observedAtMs: e ? new Date(e.observedAt).getTime() : null,
    });
  }
  return out;
}

/**
 * The newest SUCCEEDED run of a PR AT THIS HEAD, with its items — the carry-forward of the next run
 * and AI Fix's CI half. null when none.
 */
export async function getLatestSucceededCiReviewAtHead(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  headSha: string,
): Promise<CiReview | null> {
  const { cr } = tables(ctx);
  const rows = (await ctx.db
    .select()
    .from(cr)
    .where(and(eq(cr.accountId, accountId), eq(cr.prId, prId), eq(cr.headSha, headSha), eq(cr.status, 'succeeded')))
    .orderBy(desc(cr.id))
    .limit(1)
    .execute()) as CiReviewRow[];
  return (await hydrate(ctx, accountId, rows))[0] ?? null;
}

/**
 * AI Fix's CI half: the explained failures a change to THIS PR would fix, from the latest succeeded
 * CI review AT THE PR'S SYNCED HEAD. [] when the head moved since, or there is none.
 */
export async function getFixableCiItemsForPr(
  ctx: AgentContext,
  accountId: number,
  prId: number,
): Promise<CiReviewItem[]> {
  const pr = await getCiPrContext(ctx, accountId, prId);
  if (!pr?.headSha) return [];
  const run = await getLatestSucceededCiReviewAtHead(ctx, accountId, prId, pr.headSha);
  return (run?.items ?? []).filter((i) => i.status === 'diagnosed' && i.fixableInPr === true);
}

/**
 * Automatic CI reviews a workspace started since `dayStartMs` — the CI_REVIEW_DAILY_CAP counter.
 * ⚠ A server refusal (no_logs, logs_unavailable, no_failures…) ran no model and is NOT counted, or a
 * workspace whose CI is outside GitHub Actions would spend the cap on runs that do nothing. A queued
 * or running row has `refused` null, so a run counts from the moment it is queued.
 */
export async function countAutoCiReviewsSince(
  ctx: AgentContext,
  accountId: number,
  workspaceId: number,
  dayStartMs: number,
): Promise<number> {
  const { cr } = tables(ctx);
  const rows = (await ctx.db
    .select({ id: cr.id })
    .from(cr)
    .where(
      and(
        eq(cr.accountId, accountId),
        eq(cr.workspaceId, workspaceId),
        eq(cr.trigger, 'auto'),
        isNull(cr.refused),
        gte(cr.createdAt, new Date(dayStartMs)),
      ),
    )
    .execute()) as Array<{ id: number }>;
  return rows.length;
}
