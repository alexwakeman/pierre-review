import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CLAUDE_REVIEW_MODEL,
  type CiReviewProgress,
  type CiReviewStatus,
  type CiReviewStreamEvent,
  type CiReviewTrigger,
  type ClaudeReviewModel,
} from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import { cleanupCloneCache } from '../clone-manager.js';
import {
  AGENTIC_AI_ENABLED,
  REVIEW_APPLY_AUTH_ENV,
  pumpReviewLane,
  registerReviewSlotPeer,
  reviewLaneWaiting,
  reviewSlotFree,
} from '../claude-review/manager.js';
import { pickReviewNonce } from '../claude-review/prompts.js';
import { fetchMemberDiffs, prepareMemberWorktrees } from '../ticket-review/prepare.js';
import {
  getCiPrContext,
  getCiReviewRow,
  getLatestSucceededCiReviewAtHead,
  insertQueuedCiReview,
  markCiReviewCancelled,
  markCiReviewFailed,
  markCiReviewRefused,
  markCiReviewRunning,
  reconcileOrphanedCiReviews,
  saveCiReviewSuccess,
} from './persist.js';
import { readCiInputs } from './prepare.js';
import { CI_REVIEW_SYSTEM_PROMPT, buildCiReviewPrompt, ciReviewUntrustedTexts } from './prompts.js';
import { reconcileCiReview, reconcileWithoutModel } from './reconcile.js';
import type { SubmitCiReviewPayload } from './schema.js';

// THE CI REVIEW QUEUE — one run per PR at a time, beside the PR review's queue
// (claude-review/manager.ts) and the ticket review's (ticket-review/manager.ts), and SEPARATE from
// both: its own rows, its own claim, its own lane, so a code review, a story check and a CI check
// can run on the same PR at once.
//
//   CLAIM    `${accountId}:${prId}` — at most one queued-or-running CI run per PR, claimed
//            SYNCHRONOUSLY before the first await, so two clicks (or a click and the sweeper) can
//            never start the same PR twice.
//   LANE     one FIFO. A manual item goes ahead of every automatic one; at most CI_AUTO_MAX
//            automatic items wait (the sweeper re-derives the rest next tick), at most CI_MANUAL_MAX
//            manual ones. An automatic item writes its row when it is QUEUED, so the per-workspace
//            daily cap (a row count) sees it at once.
//   SLOTS    the ONE shared REVIEW_CONCURRENCY (`reviewSlotFree`): PR reviews, ticket reviews and CI
//            reviews together. A CI item starts only when no PR-review CLICK is waiting; an automatic
//            CI item only when the PR-review lanes are empty. Each side pumps the others when a run
//            ends.
//
// THE PIPELINE (`runPipeline`): the PR's synced head → the head's checks and the failing jobs' logs,
// read live (prepare.ts; refusals are stored, no model runs) → running (the failing set it judges)
// → everything already explained at this head is carried (automatic runs only; nothing new to read
// ⇒ saved with no model) → the diff and a read-only worktree → the prompt (nonce-fenced) in a
// scratch working directory → the agent (agent.ts: Read/Glob/Grep behind the path guard, Bash
// denied) → the server reconcile (reconcile.ts) → persist. The `finally` removes the worktree and
// the scratch directory, then runs a deferred clone-cache eviction. An AUTOMATIC run that succeeded
// is then handed to ./auto-post.ts (one PR comment, when the workspace switched auto-posting on).
//
// In-memory state is a process singleton; the boot reconcile fails any run a restart orphaned.

const CI_AUTO_MAX = 20;
const CI_MANUAL_MAX = 50;

export interface CiJob {
  ctx: AgentContext;
  accountId: number;
  workspaceId: number;
  prId: number;
  runId: number;
  // The head the run was QUEUED for (its trigger key is that head's synced failing set).
  headSha: string;
  trigger: CiReviewTrigger;
  model: ClaudeReviewModel;
}

// `${accountId}:${prId}` → the run id holding it (-1 while its row is being written).
const claimed = new Map<string, number>();
const lane: CiJob[] = [];
const running = new Map<number, CiJob>();
const progressByRun = new Map<number, CiReviewProgress>();
const controllers = new Map<number, AbortController>();
const streamSubs = new Map<number, Set<(e: CiReviewStreamEvent) => void>>();

const keyOf = (accountId: number, prId: number): string => `${accountId}:${prId}`;
const isAuto = (j: CiJob): boolean => j.trigger !== 'manual';

registerReviewSlotPeer({ inFlight: () => running.size, pump: () => pump() });

function emit(runId: number, e: CiReviewStreamEvent): void {
  const subs = streamSubs.get(runId);
  if (!subs) return;
  for (const cb of subs) {
    try {
      cb(e);
    } catch {
      /* a broken subscriber must never break the run */
    }
  }
}

export function subscribeCiReviewStream(runId: number, cb: (e: CiReviewStreamEvent) => void): () => void {
  let set = streamSubs.get(runId);
  if (!set) {
    set = new Set();
    streamSubs.set(runId, set);
  }
  set.add(cb);
  return () => {
    const cur = streamSubs.get(runId);
    if (!cur) return;
    cur.delete(cb);
    if (cur.size === 0) streamSubs.delete(runId);
  };
}

export interface StartCiArgs {
  accountId: number;
  workspaceId: number;
  prId: number;
  repoId: number;
  headSha: string;
  // The SYNCED failing set that started an automatic run; null for a click.
  triggerKey: string | null;
  trigger: CiReviewTrigger;
}

export type StartCiResult =
  | { outcome: 'queued'; runId: number }
  | { outcome: 'already_running'; runId: number | null }
  | { outcome: 'busy' }
  | { outcome: 'disabled' };

/**
 * Queue one PR's CI run (the route's and the sweeper's one door). The claim is taken before any
 * await; the row is written next; the run starts when a shared slot is free.
 */
export async function startCiReview(ctx: AgentContext, a: StartCiArgs): Promise<StartCiResult> {
  if (!AGENTIC_AI_ENABLED) return { outcome: 'disabled' };
  const key = keyOf(a.accountId, a.prId);
  const held = claimed.get(key);
  if (held != null) return { outcome: 'already_running', runId: held > 0 ? held : null };
  const auto = a.trigger !== 'manual';
  const waiting = lane.filter((j) => isAuto(j) === auto).length;
  if (waiting >= (auto ? CI_AUTO_MAX : CI_MANUAL_MAX)) return { outcome: 'busy' };
  claimed.set(key, -1); // reserve synchronously before any await

  let runId: number;
  try {
    runId = await insertQueuedCiReview(ctx, {
      accountId: a.accountId,
      workspaceId: a.workspaceId,
      prId: a.prId,
      repoId: a.repoId,
      headSha: a.headSha,
      triggerKey: a.triggerKey,
      trigger: a.trigger,
      model: DEFAULT_CLAUDE_REVIEW_MODEL,
    });
  } catch (err) {
    claimed.delete(key);
    throw err;
  }
  claimed.set(key, runId);
  const job: CiJob = {
    ctx,
    accountId: a.accountId,
    workspaceId: a.workspaceId,
    prId: a.prId,
    runId,
    headSha: a.headSha,
    trigger: a.trigger,
    model: DEFAULT_CLAUDE_REVIEW_MODEL,
  };
  // A manual item goes ahead of every automatic one; FIFO within each.
  const firstAuto = lane.findIndex(isAuto);
  if (!auto && firstAuto >= 0) lane.splice(firstAuto, 0, job);
  else lane.push(job);
  pump();
  return { outcome: 'queued', runId };
}

/** How many more automatic items the lane takes right now (the sweeper stops at 0). */
export function ciAutoLaneRoom(): number {
  return Math.max(0, CI_AUTO_MAX - lane.filter(isAuto).length);
}

/** Is a CI run of this PR queued or running in this process? */
export function ciReviewHeld(accountId: number, prId: number): boolean {
  return claimed.has(keyOf(accountId, prId));
}

// Fill free shared slots. A CI item yields to a waiting PR-review click; an automatic CI item yields
// to anything waiting in the PR-review lanes.
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

function launch(job: CiJob): void {
  const { ctx, runId } = job;
  running.set(runId, job);
  const controller = new AbortController();
  controllers.set(runId, controller);
  const progress = (p: CiReviewProgress): void => {
    progressByRun.set(runId, p);
    emit(runId, { type: 'progress', status: 'running', ciReviewId: runId, progress: p });
  };
  progress({ phase: 'reading_logs' });

  void runPipeline(job, controller, progress)
    .then(() => {
      // CI AUTO-POSTING: an AUTOMATIC run may post its diagnosed causes as one PR comment when the
      // workspace switched auto-posting on (./auto-post.ts decides, reads the run's status itself,
      // never throws, never retries).
      if (!isAuto(job)) return;
      void import('./auto-post.js')
        .then((m) => m.maybeAutoPostCiReview(ctx, { accountId: job.accountId, prId: job.prId, runId }))
        .catch((err) => ctx.log.warn(`ci auto post ${runId}: ${err instanceof Error ? err.message : String(err)}`));
    })
    .catch(async (err) => {
      ctx.log.error({ err }, `ci review ${runId} failed: ${err instanceof Error ? err.message : String(err)}`);
      // A throw (network, git, database) says nothing about the inputs: retryable.
      await markCiReviewFailed(ctx, job.accountId, runId, err instanceof Error ? err.message : String(err), {}, {
        retryable: true,
      }).catch(() => {});
    })
    .finally(() => {
      running.delete(runId);
      controllers.delete(runId);
      progressByRun.delete(runId);
      claimed.delete(keyOf(job.accountId, job.prId));
      void getCiReviewRow(ctx, job.accountId, runId)
        .then((r) => emit(runId, { type: 'done', status: r?.status ?? 'failed', ciReviewId: runId, prId: job.prId }))
        .catch(() => emit(runId, { type: 'done', status: 'failed', ciReviewId: runId, prId: job.prId }));
      pump();
      pumpReviewLane();
    });
}

async function runPipeline(
  job: CiJob,
  controller: AbortController,
  progress: (p: CiReviewProgress) => void,
): Promise<void> {
  const { ctx, accountId, runId, prId } = job;

  // ---- the PR's synced head (it may have moved since the run was queued) ----
  const pr = await getCiPrContext(ctx, accountId, prId);
  if (!pr || !pr.headSha) {
    await markCiReviewFailed(ctx, accountId, runId, 'The pull request or its head commit is not known.');
    return;
  }
  const headSha = pr.headSha;
  // ⚠ The head moved while the run waited for a slot: its trigger key is the OLD head's synced set,
  // and keeping it would let whatever this run says about the new head "cover" that set there.
  const clearTrigger = headSha !== job.headSha;

  // ---- the checks and the failing jobs' logs (refusals are stored, no model runs) ----
  const prior =
    job.trigger === 'manual'
      ? null
      : await getLatestSucceededCiReviewAtHead(ctx, accountId, prId, headSha).catch(() => null);
  const inputs = await readCiInputs(ctx, {
    accountId,
    prId,
    owner: pr.owner,
    name: pr.name,
    headSha,
    prior: prior?.items ?? null,
  });
  if (!inputs.ok) {
    await markCiReviewRefused(ctx, accountId, runId, {
      reason: inputs.reason,
      headSha,
      ...(inputs.failingChecks ? { failingChecks: inputs.failingChecks } : {}),
      ciState: inputs.ciState,
      clearTrigger,
    });
    return;
  }
  const { plan, carriedExtras } = inputs;
  await markCiReviewRunning(ctx, accountId, runId, {
    headSha,
    failingChecks: inputs.failingChecks,
    ciState: inputs.ciState,
    clearTrigger,
  });

  // ---- nothing new to read: every failure is carried from the last run at this head ----
  if (plan.sent.length === 0) {
    progress({ phase: 'saving' });
    const { items } = reconcileWithoutModel(plan, carriedExtras);
    await saveCiReviewSuccess(ctx, accountId, runId, { summary: prior?.summary ?? null, numTurns: 0, items });
    return;
  }
  if (controller.signal.aborted) {
    await markCiReviewCancelled(ctx, accountId, runId);
    return;
  }

  const member = { prId, owner: pr.owner, name: pr.name, number: pr.number, headSha };
  let cleanupWorktree: (() => Promise<void>) | null = null;
  let scratch: string | null = null;
  try {
    const [diffs, worktrees] = await Promise.all([fetchMemberDiffs([member]), prepareMemberWorktrees([member])]);
    cleanupWorktree = worktrees.cleanup;
    const worktreePath = worktrees.byPr.get(prId)?.path ?? null;
    if (!worktreePath) {
      await markCiReviewRefused(ctx, accountId, runId, { reason: 'head_unreadable' });
      return;
    }
    if (controller.signal.aborted) {
      await markCiReviewCancelled(ctx, accountId, runId);
      return;
    }

    // ---- the prompt ----
    const diff = diffs.get(prId);
    const promptPr = {
      repoFullName: `${pr.owner}/${pr.name}`,
      number: pr.number,
      title: pr.title,
      headSha,
      worktreePath,
      changedFiles: diff?.changedFiles ?? [],
      diff: diff?.diff ?? null,
    };
    const nonce = pickReviewNonce(ciReviewUntrustedTexts(promptPr, plan));
    const prompt = buildCiReviewPrompt({ pr: promptPr, plan, nonce });
    scratch = mkdtempSync(join(tmpdir(), 'pierre-ci-review-'));

    // ---- the run ----
    progress({ phase: 'reviewing' });
    const { runCiReviewAgent } = await import('./agent.js');
    const res = await runCiReviewAgent({
      model: job.model,
      cwd: scratch,
      worktrees: [worktreePath],
      systemPrompt: CI_REVIEW_SYSTEM_PROMPT,
      prompt,
      applyAuthEnv: REVIEW_APPLY_AUTH_ENV,
      abortController: controller,
      onProgress: (p) => progress({ phase: 'reviewing', recentActivity: p.recentActivity, usage: p.usage }),
    });

    progress({ phase: 'saving' });
    const telemetry = {
      costUsd: res.costUsd,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      numTurns: res.numTurns,
    };
    if (res.aborted) {
      await markCiReviewCancelled(ctx, accountId, runId, telemetry);
      return;
    }
    if (!res.submitted) {
      await markCiReviewFailed(ctx, accountId, runId, res.failureReason ?? 'CI review failed', telemetry);
      return;
    }
    const { summary, items } = reconcileCiReview(plan, res.payload as SubmitCiReviewPayload | null, carriedExtras);
    await saveCiReviewSuccess(ctx, accountId, runId, { summary, ...telemetry, items });
  } finally {
    await cleanupWorktree?.().catch(() => {});
    if (scratch) {
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch {
        /* advisory cleanup — never surface */
      }
    }
    setImmediate(() => {
      try {
        cleanupCloneCache();
      } catch {
        /* advisory cleanup — never surface */
      }
    });
  }
}

/**
 * One run's live status for the stream's snapshot. In-memory first (account-checked: the maps are
 * process-global), else the stored row; null when the run is not this account's.
 */
export async function getCiRunStatus(
  ctx: AgentContext,
  accountId: number,
  runId: number,
): Promise<{ status: CiReviewStatus; progress: CiReviewProgress | null; prId: number } | null> {
  const live = running.get(runId);
  if (live && live.accountId === accountId) {
    return { status: 'running', progress: progressByRun.get(runId) ?? null, prId: live.prId };
  }
  const queued = lane.find((j) => j.runId === runId && j.accountId === accountId);
  if (queued) return { status: 'queued', progress: { phase: 'queued' }, prId: queued.prId };
  const row = await getCiReviewRow(ctx, accountId, runId);
  if (!row) return null;
  return { status: row.status, progress: null, prId: row.prId };
}

/** Cancel a queued or running run of this account. Returns false when there is none. */
export function requestCiReviewCancel(accountId: number, runId: number): boolean {
  const live = running.get(runId);
  if (live && live.accountId === accountId) {
    controllers.get(runId)?.abort();
    return true;
  }
  const idx = lane.findIndex((j) => j.runId === runId && j.accountId === accountId);
  if (idx < 0) return false;
  const job = lane.splice(idx, 1)[0]!;
  claimed.delete(keyOf(job.accountId, job.prId));
  void markCiReviewCancelled(job.ctx, job.accountId, job.runId).catch(() => {});
  return true;
}

export async function reconcileCiReviewsOnStartup(ctx: AgentContext): Promise<void> {
  const n = await reconcileOrphanedCiReviews(ctx);
  if (n > 0) ctx.log.info(`reconciled ${n} orphaned CI review(s) -> failed`);
}

/** Test seam: the lane's contents, in launch order. */
export function _ciLaneForTest(): Array<{ accountId: number; prId: number; trigger: CiReviewTrigger }> {
  return lane.map((j) => ({ accountId: j.accountId, prId: j.prId, trigger: j.trigger }));
}
