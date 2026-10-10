import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  STORY_REPORT_MODEL,
  type StoryReportCandidate,
  type StoryReportErrorCode,
  type StoryReportPopulation,
  type StoryReportRange,
  type StoryReportRecord,
  type StoryReportRunRef,
  type StoryReportStatus,
  type StoryReportWindowChoice,
} from '@pierre-review/shared';
import { config } from '../../config.js';
import { db, schema } from '../../db/client.js';
import type { StoryInternals } from '../../db/stories.js';
import type { AgentContext } from '../agent-context.js';
import { pickReviewNonce } from '../claude-review/prompts.js';
import type { StoryReportAgentResult, StoryReportAgentRunner } from './agent.js';
import { storyUntrustedTexts } from './story-detail.js';
import { validateStoryReport } from './validate.js';

// THE STORY REPORT'S RUNS (docs/CLAUDE-REVIEW.md § Story report): the stored row, the ONE in-flight
// slot per ACCOUNT, the background run and the boot sweep.
//
//   • ONE RUN IN FLIGHT PER ACCOUNT (any workspace, any window). The POST handler claims the slot
//     SYNCHRONOUSLY, before its first `await` (`claimStoryReportSlot`), so two clicks cannot both
//     start a billed run; the slot is released on EVERY path — a refusal, a thrown lookup, the run's
//     own end.
//   • ⚠ IT DOES NOT SHARE `REVIEW_CONCURRENCY` (registerReviewSlotPeer). The run is short (the trial:
//     46 s, $0.02) and on Haiku, and the per-account slot already bounds it; parking it behind a
//     40-minute Opus review would make a cheap report wait on an expensive one for no saving.
//   • The row goes queued → running → succeeded | failed | cancelled. A cancel aborts the run and
//     writes 'cancelled' at once; the run's own terminal write is a compare-and-set on
//     queued/running, so a cancel that lands as the run finishes wins.
//   • Spend is recorded for every finished run that cost money (`recordAiUsage`, seam 'agent',
//     feature 'story_report') — local spend is the user's own money, still recorded.

type Ctx = Pick<AgentContext, 'log' | 'recordAiUsage' | 'llm'>;

interface Slot {
  id: number | null;
  abort: AbortController;
}
const slots = new Map<number, Slot>(); // accountId → the one in-flight run
const runs = new Map<number, Promise<void>>(); // report id → its background run (tests await it)

/** Claim the account's slot. SYNCHRONOUS — call before any await. false = already taken. */
export function claimStoryReportSlot(accountId: number): boolean {
  if (slots.has(accountId)) return false;
  slots.set(accountId, { id: null, abort: new AbortController() });
  return true;
}

export function releaseStoryReportSlot(accountId: number): void {
  slots.delete(accountId);
}

/** The run id holding the account's slot (null while the claim has no row yet, or none). */
export function storyReportSlotId(accountId: number): number | null {
  return slots.get(accountId)?.id ?? null;
}

let runnerOverride: StoryReportAgentRunner | null = null;
/** Tests inject a fake runner (never a real model call); null restores the SDK runner. */
export function setStoryReportRunnerForTests(fn: StoryReportAgentRunner | null): void {
  runnerOverride = fn;
}

/** The background run of `id`, for tests to await; undefined when none. */
export function storyReportRunPromise(id: number): Promise<void> | undefined {
  return runs.get(id);
}

type Row = typeof schema.storyReports.$inferSelect;

export function storyReportRecordOf(r: Row): StoryReportRecord {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    window: r.windowChoice as StoryReportWindowChoice,
    range: r.rangeJson as StoryReportRange,
    model: r.model,
    status: r.status as StoryReportStatus,
    picked: (r.pickedJson as StoryReportCandidate[]) ?? [],
    population: r.populationJson as StoryReportPopulation,
    report: r.status === 'succeeded' ? (r.reportJson ?? null) : null,
    dropped: r.droppedJson ?? null,
    error: (r.error as StoryReportErrorCode | null) ?? null,
    costUsd: r.costUsd ?? null,
    inputTokens: r.inputTokens ?? null,
    outputTokens: r.outputTokens ?? null,
    numTurns: r.numTurns ?? null,
    createdAt: r.createdAt.toISOString(),
    completedAt: r.completedAt != null ? r.completedAt.toISOString() : null,
  };
}

const t = () => schema.storyReports;

/** One run by id — this account's only (another account's id → null → 404). */
export async function loadStoryReport(accountId: number, id: number): Promise<Row | null> {
  const rows = await db
    .select()
    .from(t())
    .where(and(eq(t().accountId, accountId), eq(t().id, id)))
    .limit(1)
    .execute();
  return rows[0] ?? null;
}

/** The latest run of any status and the latest SUCCEEDED run for (account, workspace, window). */
export async function latestStoryReports(
  accountId: number,
  workspaceId: number,
  choice: StoryReportWindowChoice,
): Promise<{ latest: Row | null; report: Row | null }> {
  const where = and(eq(t().accountId, accountId), eq(t().workspaceId, workspaceId), eq(t().windowChoice, choice));
  const [latest] = await db.select().from(t()).where(where).orderBy(desc(t().createdAt), desc(t().id)).limit(1).execute();
  const [report] = await db
    .select()
    .from(t())
    .where(and(where, eq(t().status, 'succeeded')))
    .orderBy(desc(t().createdAt), desc(t().id))
    .limit(1)
    .execute();
  return { latest: latest ?? null, report: report ?? null };
}

/** The account's in-flight run (any workspace / window), or null. */
export async function runningStoryReport(accountId: number): Promise<StoryReportRunRef | null> {
  const [r] = await db
    .select({ id: t().id, workspaceId: t().workspaceId, windowChoice: t().windowChoice, status: t().status })
    .from(t())
    .where(and(eq(t().accountId, accountId), inArray(t().status, ['queued', 'running'])))
    .orderBy(desc(t().createdAt), desc(t().id))
    .limit(1)
    .execute();
  return r
    ? { id: r.id, workspaceId: r.workspaceId, window: r.windowChoice as StoryReportWindowChoice, status: r.status as 'queued' | 'running' }
    : null;
}

export interface StartStoryReportArgs {
  accountId: number;
  workspaceId: number;
  choice: StoryReportWindowChoice;
  range: StoryReportRange;
  candidates: StoryReportCandidate[];
  population: StoryReportPopulation;
  internalsByKey: Map<string, StoryInternals>;
  fingerprint: string;
}

/**
 * Insert the queued row and launch the run in the background. The caller MUST hold the account's
 * slot (`claimStoryReportSlot`); from here the run owns it and releases it when it ends. If the
 * insert throws, the caller still owns the slot and releases it.
 */
export async function startStoryReport(ctx: Ctx, a: StartStoryReportArgs): Promise<StoryReportRecord> {
  const slot = slots.get(a.accountId);
  if (slot == null) throw new Error('story report: start without a claimed slot');
  const [row] = (await db
    .insert(t())
    .values({
      accountId: a.accountId,
      workspaceId: a.workspaceId,
      windowChoice: a.choice,
      fromAt: new Date(a.range.from),
      toAt: new Date(a.range.to),
      rangeJson: a.range,
      model: STORY_REPORT_MODEL,
      status: 'queued',
      fingerprint: a.fingerprint,
      pickedJson: a.candidates,
      populationJson: a.population,
      createdAt: new Date(),
    })
    .returning()
    .execute()) as Row[];
  slot.id = row!.id;
  const p = runStoryReport(ctx, row!.id, a, slot.abort).finally(() => {
    runs.delete(row!.id);
    if (slots.get(a.accountId) === slot) slots.delete(a.accountId);
  });
  runs.set(row!.id, p);
  return storyReportRecordOf(row!);
}

/** Map an agent result with no usable report to its error code. */
export function storyReportFailureOf(res: StoryReportAgentResult): StoryReportErrorCode {
  if (res.runtimeMissing) return 'runtime';
  if (res.error != null) return 'failed';
  if (res.subtype === 'error_max_turns') return 'max_turns';
  if (res.subtype === 'error_max_budget_usd') return 'budget_exceeded';
  return 'no_report';
}

const windowLabelOf = (range: StoryReportRange): string =>
  range.reporting != null && range.reporting.mode === 'sprint'
    ? 'sprint so far'
    : `last ${range.reporting?.days ?? range.days} days`;

async function finish(
  id: number,
  set: Partial<typeof schema.storyReports.$inferInsert>,
  cas: boolean,
): Promise<void> {
  await db
    .update(t())
    .set({ ...set, completedAt: new Date() })
    .where(cas ? and(eq(t().id, id), inArray(t().status, ['queued', 'running'])) : eq(t().id, id))
    .execute();
}

async function runStoryReport(ctx: Ctx, id: number, a: StartStoryReportArgs, abort: AbortController): Promise<void> {
  try {
    await db
      .update(t())
      .set({ status: 'running' })
      .where(and(eq(t().id, id), eq(t().status, 'queued')))
      .execute();
    if (abort.signal.aborted) return; // cancelled before it started; the cancel wrote the row
    if (ctx.llm.detectAuth().status !== 'ok') {
      await finish(id, { status: 'failed', error: 'auth' }, true);
      return;
    }
    const runner = runnerOverride ?? (await import('./agent.js')).runStoryReportAgent;
    // The credential ladder is applied to process.env only when no Claude Review run is in flight
    // (the review chat's rule): two runs mutating the env at once would restore each other's values.
    const { chatMayApplyAuthEnv } = await import('../claude-review/manager.js');
    const res = await runner({
      candidates: a.candidates,
      population: a.population,
      internalsByKey: a.internalsByKey,
      windowLabel: windowLabelOf(a.range),
      model: STORY_REPORT_MODEL,
      nonce: pickReviewNonce(storyUntrustedTexts(a.candidates, a.internalsByKey)),
      maxTurns: config.storyReportMaxTurns,
      maxBudgetUsd: config.storyReportBudgetUsd,
      applyAuthEnv: chatMayApplyAuthEnv(),
      abortController: abort,
    });
    const usage = {
      costUsd: res.costUsd,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      numTurns: res.numTurns,
    };
    if (res.costUsd != null && res.costUsd > 0) {
      await ctx
        .recordAiUsage({
          accountId: a.accountId,
          seam: 'agent',
          feature: 'story_report',
          model: STORY_REPORT_MODEL,
          costUsd: res.costUsd,
          inputTokens: res.inputTokens,
          outputTokens: res.outputTokens,
        })
        .catch((err) => ctx.log.warn({ err }, 'story report: usage record failed'));
    }
    if (res.aborted || abort.signal.aborted) {
      await finish(id, { status: 'cancelled', ...usage }, false);
      return;
    }
    if (res.error != null) ctx.log.warn({ reportId: id, err: res.error }, 'story report: run failed');
    if (res.submitted === undefined) {
      await finish(id, { status: 'failed', error: storyReportFailureOf(res), ...usage }, true);
      return;
    }
    const v = validateStoryReport(res.submitted, new Set(a.candidates.map((c) => c.key)));
    if (v.dropped.unknownTickets + v.dropped.items + v.dropped.overCap > 0) {
      ctx.log.info({ reportId: id, dropped: v.dropped }, 'story report: validation removed items');
    }
    if (!v.ok) {
      await finish(id, { status: 'failed', error: 'invalid_report', droppedJson: v.dropped, ...usage }, true);
      return;
    }
    await finish(id, { status: 'succeeded', reportJson: v.report, droppedJson: v.dropped, error: null, ...usage }, true);
  } catch (err) {
    ctx.log.warn({ err, reportId: id }, 'story report: run threw');
    await finish(id, { status: 'failed', error: 'failed' }, true).catch(() => {});
  }
}

/**
 * Cancel this account's run `id`. In flight → abort and write 'cancelled' now; already finished →
 * unchanged. Returns the row after, or null when it is not this account's.
 */
export async function cancelStoryReport(accountId: number, id: number): Promise<Row | null> {
  const row = await loadStoryReport(accountId, id);
  if (row == null) return null;
  if (row.status !== 'queued' && row.status !== 'running') return row;
  const slot = slots.get(accountId);
  if (slot?.id === id) slot.abort.abort();
  await finish(id, { status: 'cancelled' }, true);
  return loadStoryReport(accountId, id);
}

/** Boot sweep: a queued/running row from an earlier process can never finish — mark it interrupted. */
export async function reconcileStoryReportsOnStartup(): Promise<number> {
  const rows = await db
    .update(t())
    .set({ status: 'failed', error: 'interrupted', completedAt: new Date() })
    .where(inArray(t().status, ['queued', 'running']))
    .returning({ id: t().id })
    .execute();
  return rows.length;
}
