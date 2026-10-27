import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { and, asc, desc, eq, gt, gte, inArray, isNull, ne, or } from 'drizzle-orm';
import {
  aiRunProvider,
  type AiProviderId,
  type ClaudeFollowUpItemRecord,
  type ClaudeRepliesCheckRun,
  type ClaudeRepliesCheckState,
  type ClaudeReviewFollowUpRecord,
  type ClaudeReviewModel,
  type ClaudeReviewTrigger,
  type RepliesCheckRefusal,
} from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import { cleanupCloneCache } from '../clone-manager.js';
import { prepareMemberWorktrees } from '../ticket-review/prepare.js';
import { getCiPrContext } from '../ci-review/persist.js';
import { followUpProvider, preflightFor } from '../../ai/run-choice.js';
import { activeProviderId } from '../../ai/provider-setting.js';
import { automaticRunAllowed } from '../budget-gate.js';
import { agenticRunReady } from './ai-ready.js';
import {
  AGENTIC_AI_ENABLED,
  REVIEW_APPLY_AUTH_ENV,
  pumpReviewLane,
  registerReviewSlotPeer,
  reviewHeldForPr,
  reviewLaneWaiting,
  reviewSlotFree,
} from './manager.js';
import {
  autoPostWireOf,
  insertQueuedReview,
  loadPriorReviewForFollowUp,
  loadSettledByReplyFindings,
  markReviewCancelled,
  markReviewCommentsSeen,
  markReviewFailed,
  markReviewRanOn,
  markReviewRunning,
  saveReviewSuccess,
} from './persist.js';
import { attachFindingThreads } from './finding-replies.js';
import type { PriorFindingForFollowUp } from './follow-up.js';
import type { AutoPostDeps } from './auto-post.js';
import type { AutoResolveDeps } from './auto-resolve.js';
import { pickReviewNonce } from './prompts.js';
import {
  REPLIES_PASS_CODE_CONTEXT_LINES,
  judgedThroughFor,
  newestJudgeableReplyMs,
  planRepliesPass,
  reconcileReplies,
  repliesPlanTexts,
  repliesSummary,
  unjudgedReplyFindings,
  type CodeAround,
} from './replies-pass.js';
import { buildRepliesPrompt, repliesSystemPrompt } from './replies-check-prompt.js';

// THE REPLIES PASS — the I/O half (docs/CLAUDE-REVIEW.md § The replies pass; the pure half is
// replies-pass.ts). A cheap run that judges ONLY people's replies on Limn's own posted findings, at
// the current head, without new commits.
//
// WHO STARTS IT: the auto-review sweeper (auto.ts — a same-head reply burst on Limn's own finding,
// settled 5 quiet minutes, at most REPLIES_PASS_AUTO_DAILY_CAP automatic passes per PR per rolling
// 24 h counted in the DB, the ONE automatic budget gate first), or a reader's "Check replies" on the
// AI Review tab. Never while a FULL review of the PR is queued or running (`reviewHeldForPr`: it
// judges the replies itself), never on a closed PR, never with nothing to judge (no row, no model).
//
// THE RUN: per thread, the PROVIDER of the run that OWNS the thread (the first inline-posted finding
// up the re-raise chain) when it can still run, else the default (`followUpProvider`); one agent run —
// one `claude_reviews` row, `kind = 'replies'` — per provider, one after the other in the ONE shared
// review slot (`registerReviewSlotPeer`). Standard depth, the Effort setting, read-only: Read / Glob /
// Grep in the PR's read-only worktree behind the path guard, Bash denied (replies-check-agent.ts).
//
// AFTER IT: an AUTO pass hands each row to auto resolve and auto pushback (their own switches and
// claimed records — at most ONE pushback per thread, ever), then the outcome re-check
// (replies-outcome.ts). A MANUAL pass writes nothing to GitHub: its rows hold drafts ("Post reply")
// and the outcome the replies point to (the newest row's `verdict`).

// The STANDARD depth (Check threads' model): Codex resolves the role to its own standard model.
export const REPLIES_CHECK_MODEL: ClaudeReviewModel = 'claude-sonnet-5';
const AUTO_MAX = 20;
const MANUAL_MAX = 50;
const ALL_RUNS = Number.MAX_SAFE_INTEGER;

/* eslint-disable @typescript-eslint/no-explicit-any */
const sch = (ctx: AgentContext): any => ctx.schema as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

interface Group {
  provider: AiProviderId;
  reviewId: number;
  findingIds: number[];
}

interface Job {
  ctx: AgentContext;
  accountId: number;
  prId: number;
  trigger: ClaudeReviewTrigger;
  groups: Group[];
  // The sweeper's newest reply time (auto) — recorded as the rows' coverage with the replies judged.
  commentsThroughMs: number | null;
  // A reader's press of the sweep: the budget is not asked again.
  pressed: boolean;
}

const claimed = new Map<string, number>();
const lane: Job[] = [];
const running = new Map<string, Job>();
const controllers = new Map<string, AbortController>();
const phaseByKey = new Map<string, 'queued' | 'running'>();

const keyOf = (accountId: number, prId: number): string => `${accountId}:${prId}`;
const isAuto = (j: Job): boolean => j.trigger === 'auto';

registerReviewSlotPeer({ inFlight: () => running.size, pump: () => pump() });

// ---- planning (DB-only) ----

interface FullReviewMeta {
  id: number;
  headSha: string;
  createdAt: Date;
  commentsThrough: Date | null;
}

/** The latest succeeded FULL review that read code (the one the follow-up chain anchors on). */
async function latestFullReview(ctx: AgentContext, accountId: number, prId: number): Promise<FullReviewMeta | null> {
  const cr = sch(ctx).claudeReviews;
  const rows = (await ctx.db
    .select({ id: cr.id, headSha: cr.headSha, createdAt: cr.createdAt, commentsThrough: cr.commentsThrough })
    .from(cr)
    .where(
      and(
        eq(cr.prId, prId),
        eq(cr.accountId, accountId),
        eq(cr.status, 'succeeded'),
        isNull(cr.kind),
        or(isNull(cr.reviewMode), ne(cr.reviewMode, 'skip')),
      ),
    )
    .orderBy(desc(cr.id))
    .limit(1)
    .execute()) as FullReviewMeta[];
  return rows[0] ?? null;
}

interface PassRow {
  id: number;
  status: string;
  trigger: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  commentsThrough: Date | null;
  followUp: ClaudeReviewFollowUpRecord | null;
  verdict: string | null;
  error: string | null;
  autoPost: unknown;
}

/** The replies passes of this PR after a review id, oldest first (any status). */
async function passesAfter(ctx: AgentContext, accountId: number, prId: number, afterId: number): Promise<PassRow[]> {
  const cr = sch(ctx).claudeReviews;
  return (await ctx.db
    .select({
      id: cr.id,
      status: cr.status,
      trigger: cr.trigger,
      createdAt: cr.createdAt,
      finishedAt: cr.finishedAt,
      commentsThrough: cr.commentsThrough,
      followUp: cr.followUp,
      verdict: cr.verdict,
      error: cr.error,
      autoPost: cr.autoPost,
    })
    .from(cr)
    .where(and(eq(cr.prId, prId), eq(cr.accountId, accountId), eq(cr.kind, 'replies'), gt(cr.id, afterId)))
    .orderBy(asc(cr.id))
    .execute()) as PassRow[];
}

export interface PlannedReplies {
  full: FullReviewMeta;
  // The findings with a reply no run has judged yet, each with its thread.
  findings: PriorFindingForFollowUp[];
  // The newest judgeable reply among them (ms).
  newestReplyMs: number | null;
}

/**
 * What a pass would judge now: the findings the next full review would follow up (own + carried,
 * minus the settled), with their threads, whose newest judgeable reply is newer than their latest
 * judgement. A refusal when there is nothing to judge. DB-only. Exported for the tests and the GET.
 */
export async function planRepliesCheck(
  ctx: AgentContext,
  accountId: number,
  prId: number,
): Promise<PlannedReplies | { refused: RepliesCheckRefusal }> {
  const full = await latestFullReview(ctx, accountId, prId);
  if (!full) return { refused: 'no_review' };
  const settled = await loadSettledByReplyFindings(ctx, prId, accountId, ALL_RUNS);
  const prior = await loadPriorReviewForFollowUp(ctx, prId, accountId, ALL_RUNS, new Set(settled.map((f) => f.id)));
  if (!prior || prior.findings.length === 0) return { refused: 'nothing_to_check' };
  const attached = await attachFindingThreads(ctx, accountId, prId, prior.findings);
  const passes = (await passesAfter(ctx, accountId, prId, full.id)).filter((p) => p.status === 'succeeded');
  const judged = judgedThroughFor(
    { createdAtMs: full.createdAt.getTime(), commentsThroughMs: full.commentsThrough?.getTime() ?? null },
    passes.map((p) => ({
      createdAtMs: p.createdAt.getTime(),
      commentsThroughMs: p.commentsThrough?.getTime() ?? null,
      items: p.followUp?.items ?? [],
    })),
  );
  const findings = unjudgedReplyFindings(attached, judged);
  if (findings.length === 0) return { refused: 'nothing_to_check' };
  let newest: number | null = null;
  for (const f of findings) {
    const t = newestJudgeableReplyMs(f);
    if (t != null && (newest == null || t > newest)) newest = t;
  }
  return { full, findings, newestReplyMs: newest };
}

/** Each finding's thread OWNER's provider (the run that posted the comment), by finding id. */
async function ownerProviders(
  ctx: AgentContext,
  findings: readonly PriorFindingForFollowUp[],
): Promise<Map<number, AiProviderId>> {
  const ownerIds = [...new Set(findings.map((f) => f.thread?.threadFindingId).filter((x): x is number => x != null))];
  const out = new Map<number, AiProviderId>();
  if (ownerIds.length === 0) return out;
  const t = sch(ctx);
  const rows = (await ctx.db
    .select({ id: t.claudeReviewFindings.id, provider: t.claudeReviews.provider, model: t.claudeReviews.model })
    .from(t.claudeReviewFindings)
    .innerJoin(t.claudeReviews, eq(t.claudeReviews.id, t.claudeReviewFindings.reviewId))
    .where(inArray(t.claudeReviewFindings.id, ownerIds))
    .execute()) as Array<{ id: number; provider: string | null; model: string | null }>;
  const byOwner = new Map(rows.map((r) => [r.id, aiRunProvider(r.provider, r.model)]));
  for (const f of findings) {
    const owner = f.thread?.threadFindingId;
    const p = owner != null ? byOwner.get(owner) : undefined;
    if (p) out.set(f.id, p);
  }
  return out;
}

/** Threads grouped by the provider that runs them (the owner's when it can, else the default). Pure. */
export function groupByProvider(
  findings: readonly PriorFindingForFollowUp[],
  ownerOf: ReadonlyMap<number, AiProviderId>,
  runsOn: (owner: AiProviderId | null) => AiProviderId,
): Array<{ provider: AiProviderId; findingIds: number[] }> {
  const by = new Map<AiProviderId, number[]>();
  for (const f of findings) {
    const p = runsOn(ownerOf.get(f.id) ?? null);
    const list = by.get(p) ?? [];
    list.push(f.id);
    by.set(p, list);
  }
  // Claude first, then Codex: a stable order (the pass runs them one after the other).
  return (['claude', 'codex'] as const).filter((p) => by.has(p)).map((p) => ({ provider: p, findingIds: by.get(p)! }));
}

/** AUTOMATIC passes of this PR created at or after `sinceMs` (the per-PR cap's count; rows). */
export async function countAutoRepliesPassesSince(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  sinceMs: number,
): Promise<number> {
  const cr = sch(ctx).claudeReviews;
  const rows = (await ctx.db
    .select({ id: cr.id })
    .from(cr)
    .where(
      and(
        eq(cr.prId, prId),
        eq(cr.accountId, accountId),
        eq(cr.kind, 'replies'),
        eq(cr.trigger, 'auto'),
        gte(cr.createdAt, new Date(sinceMs)),
      ),
    )
    .execute()) as Array<{ id: number }>;
  return rows.length;
}

// ---- the door ----

export type StartRepliesCheckResult =
  | { outcome: 'queued'; reviewId: number; threads: number }
  | { outcome: 'already_running'; reviewId: number | null }
  | { outcome: 'refused'; reason: RepliesCheckRefusal }
  | { outcome: 'not_found' }
  | { outcome: 'not_open' }
  | { outcome: 'not_ready' }
  | { outcome: 'over_budget' }
  | { outcome: 'busy' }
  | { outcome: 'disabled' };

export interface StartRepliesCheckArgs {
  accountId: number;
  prId: number;
  trigger: ClaudeReviewTrigger;
  // Auto: the sweeper's newest reply on a Limn finding (the burst it covers). Manual: absent.
  commentsThroughMs?: number | null;
  // The reader pressed the sweep: the spend budget is not asked again (the SPA's confirm ran).
  pressed?: boolean;
}

/**
 * Queue one PR's replies pass (the route's and the sweeper's ONE door). The claim is taken before any
 * await; nothing to judge, a full review in flight, a closed PR ⇒ refused with no row and no model.
 */
export async function startRepliesCheck(ctx: AgentContext, a: StartRepliesCheckArgs): Promise<StartRepliesCheckResult> {
  if (!AGENTIC_AI_ENABLED) return { outcome: 'disabled' };
  const key = keyOf(a.accountId, a.prId);
  const held = claimed.get(key);
  if (held != null) return { outcome: 'already_running', reviewId: held > 0 ? held : null };
  // ⚠ A FULL REVIEW of the PR is queued or running: it judges the replies itself.
  if (reviewHeldForPr(a.prId)) return { outcome: 'refused', reason: 'review_in_progress' };
  const auto = a.trigger === 'auto';
  if (lane.filter((j) => isAuto(j) === auto).length >= (auto ? AUTO_MAX : MANUAL_MAX)) return { outcome: 'busy' };
  claimed.set(key, -1); // reserve synchronously before any await
  try {
    const pr = await getCiPrContext(ctx, a.accountId, a.prId);
    if (!pr || !pr.headSha) {
      claimed.delete(key);
      return { outcome: 'not_found' };
    }
    if (pr.state !== 'open') {
      claimed.delete(key);
      return { outcome: 'not_open' };
    }
    if (auto) {
      // AI not set up: wait, never fail (ai-ready.ts). Over the spend budget: skipped, never queued.
      if (!agenticRunReady(ctx, 'thread_check')) {
        claimed.delete(key);
        return { outcome: 'not_ready' };
      }
      if (!a.pressed && !(await automaticRunAllowed(ctx, a.accountId, 'replies check'))) {
        claimed.delete(key);
        return { outcome: 'over_budget' };
      }
    }
    const planned = await planRepliesCheck(ctx, a.accountId, a.prId);
    if ('refused' in planned) {
      claimed.delete(key);
      return { outcome: 'refused', reason: planned.refused };
    }
    // A review started while we read: it will judge them.
    if (reviewHeldForPr(a.prId)) {
      claimed.delete(key);
      return { outcome: 'refused', reason: 'review_in_progress' };
    }
    const owners = await ownerProviders(ctx, planned.findings);
    const detect = preflightFor(ctx);
    // The OWNER's provider when it can still run the kind, else the default (`followUpProvider`).
    const groups = groupByProvider(planned.findings, owners, (owner) =>
      followUpProvider(owner ?? activeProviderId(), 'thread_check', detect),
    );
    const rows: Group[] = [];
    for (const g of groups) {
      const reviewId = await insertQueuedReview(
        ctx,
        a.prId,
        pr.headSha,
        REPLIES_CHECK_MODEL,
        a.accountId,
        [],
        a.trigger,
        g.provider,
        false,
        'replies',
      );
      rows.push({ provider: g.provider, reviewId, findingIds: g.findingIds });
    }
    const job: Job = {
      ctx,
      accountId: a.accountId,
      prId: a.prId,
      trigger: a.trigger,
      groups: rows,
      commentsThroughMs: a.commentsThroughMs ?? null,
      pressed: a.pressed === true,
    };
    claimed.set(key, rows[0]!.reviewId);
    phaseByKey.set(key, 'queued');
    const firstAuto = lane.findIndex(isAuto);
    if (!auto && firstAuto >= 0) lane.splice(firstAuto, 0, job);
    else lane.push(job);
    pump();
    return { outcome: 'queued', reviewId: rows[0]!.reviewId, threads: planned.findings.length };
  } catch (err) {
    claimed.delete(key);
    throw err;
  }
}

/** Is a pass of this PR queued or running here? */
export function repliesCheckHeld(accountId: number, prId: number): boolean {
  return claimed.has(keyOf(accountId, prId));
}

/** How many more automatic passes the lane takes right now. */
export function repliesCheckAutoRoom(): number {
  return Math.max(0, AUTO_MAX - lane.filter(isAuto).length);
}

/** One PR's live pass (account-checked), or null. */
export function liveRepliesCheck(accountId: number, prId: number): 'queued' | 'running' | null {
  const k = keyOf(accountId, prId);
  if (!claimed.has(k)) return null;
  return phaseByKey.get(k) ?? 'queued';
}

/** Cancel this account's queued or running pass of a PR. False when there is none. */
export function requestRepliesCheckCancel(accountId: number, prId: number): boolean {
  const k = keyOf(accountId, prId);
  const live = running.get(k);
  if (live) {
    controllers.get(k)?.abort();
    return true;
  }
  const idx = lane.findIndex((j) => j.accountId === accountId && j.prId === prId);
  if (idx < 0) return false;
  const job = lane.splice(idx, 1)[0]!;
  claimed.delete(k);
  phaseByKey.delete(k);
  for (const g of job.groups) void markReviewCancelled(job.ctx, g.reviewId).catch(() => {});
  return true;
}

function pump(): void {
  for (;;) {
    if (lane.length === 0 || !reviewSlotFree()) return;
    const waiting = reviewLaneWaiting();
    if (waiting.manual) return;
    const idx = lane.findIndex((j) => !isAuto(j));
    if (idx >= 0) {
      launch(lane.splice(idx, 1)[0]!);
      continue;
    }
    if (waiting.auto) return;
    launch(lane.shift()!);
  }
}

function launch(job: Job): void {
  const k = keyOf(job.accountId, job.prId);
  running.set(k, job);
  phaseByKey.set(k, 'running');
  const controller = new AbortController();
  controllers.set(k, controller);
  void runJob(job, controller)
    .catch((err) => {
      job.ctx.log.error({ err }, `replies check pr ${job.prId} failed: ${err instanceof Error ? err.message : String(err)}`);
    })
    .finally(() => {
      running.delete(k);
      controllers.delete(k);
      phaseByKey.delete(k);
      claimed.delete(k);
      pump();
      pumpReviewLane();
    });
}

/**
 * The code around a finding's line at the current head, read from the read-only checkout. Never
 * leaves the checkout (a path that resolves outside it reads nothing). null when it cannot be read.
 */
export function codeAround(worktree: string, path: string, line: number | null): CodeAround | null {
  if (line == null || line < 1) return null;
  try {
    const root = realpathSync(worktree);
    const full = realpathSync(resolve(root, path));
    if (full !== root && !full.startsWith(root + sep)) return null;
    const lines = readFileSync(full, 'utf8').split('\n');
    const from = Math.max(1, line - REPLIES_PASS_CODE_CONTEXT_LINES);
    const to = Math.min(lines.length, line + REPLIES_PASS_CODE_CONTEXT_LINES);
    if (from > lines.length) return null;
    return { startLine: from, text: lines.slice(from - 1, to).map((l, i) => `${from + i}: ${l}`).join('\n') };
  } catch {
    return null;
  }
}

async function runJob(job: Job, controller: AbortController): Promise<void> {
  const { ctx, accountId, prId } = job;
  const pr = await getCiPrContext(ctx, accountId, prId);
  const fail = async (msg: string) => {
    for (const g of job.groups) await markReviewFailed(ctx, g.reviewId, msg).catch(() => {});
  };
  if (!pr || !pr.headSha || pr.state !== 'open') {
    await fail(pr && pr.state !== 'open' ? 'The pull request is no longer open.' : 'The pull request or its head commit is not known.');
    return;
  }
  const headSha = pr.headSha;
  // A full review may have started while this waited: it judges the replies itself.
  if (reviewHeldForPr(prId)) {
    for (const g of job.groups) await markReviewCancelled(ctx, g.reviewId).catch(() => {});
    return;
  }
  const member = { prId, owner: pr.owner, name: pr.name, number: pr.number, headSha };
  let cleanupWorktree: (() => Promise<void>) | null = null;
  let scratch: string | null = null;
  const succeeded: Array<{ reviewId: number; items: ClaudeFollowUpItemRecord[] }> = [];
  try {
    let worktreePath: string | null = null;
    try {
      const wt = await prepareMemberWorktrees([member]);
      cleanupWorktree = wt.cleanup;
      worktreePath = wt.byPr.get(prId)?.path ?? null;
    } catch {
      worktreePath = null;
    }
    scratch = mkdtempSync(join(tmpdir(), 'pierre-replies-check-'));
    for (const g of job.groups) {
      if (controller.signal.aborted) {
        await markReviewCancelled(ctx, g.reviewId).catch(() => {});
        continue;
      }
      // Re-plan at run time (a reply may have landed while it waited); keep this group's threads.
      const planned = await planRepliesCheck(ctx, accountId, prId);
      const want = new Set(g.findingIds);
      const findings = 'refused' in planned ? [] : planned.findings.filter((f) => want.has(f.id));
      if ('refused' in planned || findings.length === 0) {
        await markReviewFailed(ctx, g.reviewId, 'Nothing left to check: the replies were judged meanwhile.');
        continue;
      }
      await markReviewRunning(ctx, g.reviewId);
      const code = new Map<number, CodeAround>();
      if (worktreePath) {
        for (const f of findings) {
          const c = codeAround(worktreePath, f.path, f.line);
          if (c) code.set(f.id, c);
        }
      }
      const plan = planRepliesPass(findings, headSha, code);
      const nonce = pickReviewNonce([pr.title, ...repliesPlanTexts(plan)]);
      const prompt = buildRepliesPrompt({
        repoFullName: `${pr.owner}/${pr.name}`,
        number: pr.number,
        title: pr.title,
        headSha,
        worktreePath,
        plan,
        nonce,
        provider: g.provider,
      });
      const { runRepliesCheckAgent } = await import('./replies-check-agent.js');
      const res = await runRepliesCheckAgent({
        model: REPLIES_CHECK_MODEL,
        cwd: scratch,
        worktrees: worktreePath ? [worktreePath] : [],
        systemPrompt: repliesSystemPrompt(g.provider),
        prompt,
        applyAuthEnv: REVIEW_APPLY_AUTH_ENV,
        abortController: controller,
        usage: { accountId, prId, repoId: pr.repoId ?? null },
        provider: g.provider,
      });
      if (res.ranOn) await markReviewRanOn(ctx, g.reviewId, res.ranOn);
      const telemetry = {
        costUsd: res.costUsd,
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        numTurns: res.numTurns,
      };
      if (res.aborted) {
        await markReviewCancelled(ctx, g.reviewId);
        continue;
      }
      if (!res.submitted) {
        await markReviewFailed(ctx, g.reviewId, res.failureReason ?? 'The replies check failed.', telemetry);
        continue;
      }
      const items = reconcileReplies(plan, res.replies ?? []);
      // Coverage for the sweeper: the newest reply this run judged (and the burst it was started for).
      const newestSent = Math.max(0, ...plan.sent.map((s) => newestJudgeableReplyMs(s.finding) ?? 0));
      const through = Math.max(newestSent, job.commentsThroughMs ?? 0);
      if (through > 0) await markReviewCommentsSeen(ctx, g.reviewId, new Date(through));
      await saveReviewSuccess(ctx, g.reviewId, {
        scope: worktreePath ? 'worktree' : 'diff_only',
        summary: repliesSummary(items),
        verdict: 'COMMENT',
        ...telemetry,
        ...(res.usageRecorded ? { usageRecorded: true } : {}),
        excludedFiles: [],
        findings: [],
        followUp: {
          priorReviewId: 'refused' in planned ? 0 : planned.full.id,
          priorHeadSha: 'refused' in planned ? headSha : planned.full.headSha,
          headMoved: 'refused' in planned ? false : planned.full.headSha !== headSha,
          changesSinceShown: false,
          items,
        },
        threadAssessments: null,
      });
      succeeded.push({ reviewId: g.reviewId, items });
    }
  } finally {
    await cleanupWorktree?.().catch(() => {});
    if (scratch) {
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch {
        /* advisory cleanup */
      }
    }
    setImmediate(() => {
      try {
        cleanupCloneCache();
      } catch {
        /* advisory cleanup */
      }
    });
  }
  if (succeeded.length === 0) return;
  await afterPass(ctx, job, succeeded);
}

/**
 * After a pass: the outcome the replies point to (stored as the newest row's verdict, manual and
 * auto alike), and — AUTO only — auto resolve, auto pushback and the outcome review. Never throws.
 */
async function afterPass(
  ctx: AgentContext,
  job: Job,
  succeeded: Array<{ reviewId: number; items: ClaudeFollowUpItemRecord[] }>,
): Promise<void> {
  const { accountId, prId } = job;
  const last = succeeded[succeeded.length - 1]!;
  try {
    if (job.trigger === 'auto') {
      // The existing writers, on their own switches and claimed records (at most ONE pushback per
      // thread, ever). Each reads the row's follow-up items exactly as it reads a review's.
      const { maybeAutoResolveFindings } = await import('./auto-resolve.js');
      const { maybeAutoPushback } = await import('./auto-pushback.js');
      for (const r of succeeded) {
        await maybeAutoResolveFindings(ctx, { accountId, prId, reviewId: r.reviewId }, autoDeps.post, autoDeps.resolve);
        await maybeAutoPushback(ctx, { accountId, prId, reviewId: r.reviewId }, autoDeps.post, autoDeps.resolve);
      }
    }
    const { computeRepliesOutcome, maybePostRepliesOutcome } = await import('./replies-outcome.js');
    const outcome = await computeRepliesOutcome(
      ctx,
      accountId,
      prId,
      succeeded.flatMap((r) => r.items),
    );
    if (outcome.wanted != null && outcome.wanted !== 'COMMENT') {
      const cr = sch(ctx).claudeReviews;
      await ctx.db.update(cr).set({ verdict: outcome.wanted }).where(eq(cr.id, last.reviewId)).execute();
    }
    if (job.trigger === 'auto') {
      await maybePostRepliesOutcome(ctx, { accountId, prId, reviewId: last.reviewId, outcome }, autoDeps.post);
    }
  } catch (err) {
    ctx.log.warn(`replies check pr ${prId}: after the pass: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---- the tab's state (GET /api/prs/:id/claude-review) ----

function runWire(r: PassRow): ClaudeRepliesCheckRun {
  const items = r.followUp?.items ?? [];
  return {
    reviewId: r.id,
    status: r.status as ClaudeRepliesCheckRun['status'],
    trigger: r.trigger === 'auto' ? 'auto' : 'manual',
    createdAt: r.createdAt.toISOString(),
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    error: r.error ?? null,
    accepted: items.filter((i) => i.status === 'reply_accepted').length,
    disputed: items.filter((i) => i.status === 'reply_disputed').length,
    notChecked: items.filter((i) => i.status === 'not_checked').length,
    verdict: (r.verdict as ClaudeRepliesCheckRun['verdict']) ?? null,
    autoPost: autoPostWireOf(r.autoPost),
  };
}

/** The AI Review tab's replies state. DB-only (plus the in-memory live phase). Never throws. */
export async function repliesCheckState(ctx: AgentContext, accountId: number, prId: number): Promise<ClaudeRepliesCheckState | null> {
  try {
    const full = await latestFullReview(ctx, accountId, prId);
    if (!full) return null;
    const [planned, passes] = await Promise.all([
      planRepliesCheck(ctx, accountId, prId),
      passesAfter(ctx, accountId, prId, full.id),
    ]);
    const newest = passes[passes.length - 1] ?? null;
    return {
      unjudged: 'refused' in planned ? 0 : planned.findings.length,
      live: liveRepliesCheck(accountId, prId),
      latest: newest ? runWire(newest) : null,
    };
  } catch (err) {
    ctx.log.warn(`replies check state pr ${prId}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// The GitHub-facing deps of an AUTO pass's writes (tests replace them; nothing else does).
let autoDeps: { post?: AutoPostDeps; resolve?: AutoResolveDeps } = {};
/** Test seam: fake GitHub for auto resolve, auto pushback and the outcome review. */
export function _setRepliesAutoDepsForTest(d: { post?: AutoPostDeps; resolve?: AutoResolveDeps } | null): void {
  autoDeps = d ?? {};
}

/** Test seam. */
export function _resetRepliesChecksForTest(): void {
  claimed.clear();
  lane.length = 0;
  running.clear();
  controllers.clear();
  phaseByKey.clear();
}

/** Test seam: the lane, in launch order. */
export function _repliesLaneForTest(): Array<{ accountId: number; prId: number; trigger: ClaudeReviewTrigger; providers: AiProviderId[] }> {
  return lane.map((j) => ({ accountId: j.accountId, prId: j.prId, trigger: j.trigger, providers: j.groups.map((g) => g.provider) }));
}
