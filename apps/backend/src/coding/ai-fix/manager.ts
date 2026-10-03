import { and, desc, eq } from 'drizzle-orm';
import type {
  AiFixProgress,
  AiFixReviewItem,
  AiFixSeed,
  AiFixStatus,
  AiFixStatusResponse,
  AiFixStreamEvent,
  AiFixTrigger,
  ClaudeReview,
} from '@pierre-review/shared';
import type { CodingProgress } from '../../pro/contract.js';
import type { AgentContext } from '../../review/agent-context.js';
import { getFixPrContext } from './pr-context.js';
import { getClaudeReviewById } from '../../review/claude-review/persist.js';
import { pickReviewNonce } from '../../review/claude-review/prompts.js';
import { buildReviewSeed, type ReviewSeed } from './review-seed.js';
import { buildFixSystemPrompt, buildFixUserPrompt, type FixSeed } from './prompts.js';
import {
  insertQueuedFix,
  markFixCancelled,
  markFixFailed,
  markFixRunning,
  reconcileOrphanedFixes,
  saveFixSuccess,
} from './persist.js';

// In-memory job manager for AI Fix's agentic fixer (CORE, free, local-only — it left the plugin
// with Claude Review; the PR summary and the CI-failure analysis stayed Pro). A SINGLE global slot (concurrency 1) carries every
// fix-generate run in the process, so no two ever run concurrently (a write run is costly,
// and running one at a time means the agent never needs to mutate process.env for auth, so
// it can't race a Claude Review). One job per PR (the `claimed` guard). Pushing a finished
// fix is NOT a job: POST …/push is synchronous and never takes the slot.

const MAX_CONCURRENT = 1;
const MAX_QUEUED = 20;

// ---- the single-slot scheduler ----
const running = new Set<number>(); // prIds with a fix run in flight
const claimed = new Set<number>(); // prIds claimed (queued OR running)
interface PendingJob {
  prId: number;
  run: () => Promise<void>;
}
const pending: PendingJob[] = [];

function enqueue(prId: number, run: () => Promise<void>): boolean {
  if (running.size < MAX_CONCURRENT) {
    void execRun(prId, run);
    return true; // started immediately
  }
  pending.push({ prId, run });
  return false; // queued
}

async function execRun(prId: number, run: () => Promise<void>): Promise<void> {
  running.add(prId);
  try {
    await run();
  } catch {
    /* every job body handles its own errors; this is only a backstop */
  } finally {
    running.delete(prId);
    pump();
  }
}

function pump(): void {
  while (running.size < MAX_CONCURRENT && pending.length > 0) {
    const next = pending.shift();
    if (!next) break;
    void execRun(next.prId, next.run);
  }
}

// ---- fix-generate state ----
const fixIdByPr = new Map<number, number>();
const progressByFix = new Map<number, AiFixProgress>();
const controllers = new Map<number, AbortController>(); // fixId → controller
const fixStreamSubs = new Map<number, Set<(e: AiFixStreamEvent) => void>>();

export function subscribeFixStream(
  prId: number,
  cb: (e: AiFixStreamEvent) => void,
): () => void {
  let set = fixStreamSubs.get(prId);
  if (!set) {
    set = new Set();
    fixStreamSubs.set(prId, set);
  }
  set.add(cb);
  return () => {
    const s = fixStreamSubs.get(prId);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) fixStreamSubs.delete(prId);
  };
}

function emitFixStream(prId: number, e: AiFixStreamEvent): void {
  const set = fixStreamSubs.get(prId);
  if (!set) return;
  for (const cb of set) {
    try {
      cb(e);
    } catch {
      /* a broken subscriber must not break the run */
    }
  }
}

export type StartFixResult =
  | { status: 'queued'; fixId: number }
  | { status: 'already_running' }
  | { status: 'busy' }
  | { status: 'not_found' }
  | { status: 'no_auth'; message?: string }
  | { status: 'credits_exhausted' }
  | { status: 'no_head' }
  // seed === 'review': the named review is missing, another PR's / account's, or not succeeded.
  | { status: 'review_unavailable' }
  // seed === 'review': the review has nothing to fix (no non-praise finding, no open earlier
  // finding, no thread needing a fix, no story gap, no fixable CI failure). A refusal, not an
  // empty run — a fixer with no task would burn a paid agent turn and report on nothing.
  | { status: 'nothing_to_fix' }
  // seed === 'plain' with a blank instruction.
  | { status: 'no_instruction' };

export interface StartFixInput {
  accountId: number;
  prId: number;
  model: string;
  seed: AiFixSeed;
  // seed === 'review': the Claude review to fix from. The seed is built from the STORED run.
  sourceReviewId?: number | null;
  // seed === 'plain': the reader's instruction.
  instruction?: string;
  // Who started it. Omitted ⇒ 'manual'.
  trigger?: AiFixTrigger;
}

/**
 * Load the review a 'review' seed names and render its items. null when the review is missing,
 * not this account's, not THIS PR's, or did not succeed. Never throws.
 */
export async function loadReviewSeed(
  ctx: AgentContext,
  input: { accountId: number; prId: number; reviewId: number | null | undefined },
): Promise<{ review: ClaudeReview; seed: ReviewSeed } | null> {
  if (input.reviewId == null) return null;
  try {
    const review = await getClaudeReviewById(ctx, input.reviewId, input.accountId);
    if (!review || review.prId !== input.prId || review.status !== 'succeeded') return null;
    return { review, seed: buildReviewSeed(review, { nonce: pickReviewNonce }) };
  } catch (err) {
    ctx.log.warn({ err }, 'ai-fix: loading the review seed failed');
    return null;
  }
}

/**
 * Start a fix seeded from a Claude review — the ONE entry the auto-review agent calls (it passes
 * `trigger: 'auto'`); the manual "Fix from review" route goes through the same path. Same queue,
 * slot, worktree and guards as every fix; nothing is pushed until a person presses Push.
 */
export function startReviewFix(
  ctx: AgentContext,
  input: {
    accountId: number;
    prId: number;
    reviewId: number;
    model: string;
    trigger: AiFixTrigger;
  },
): Promise<StartFixResult> {
  return startFix(ctx, {
    accountId: input.accountId,
    prId: input.prId,
    model: input.model,
    seed: 'review',
    sourceReviewId: input.reviewId,
    trigger: input.trigger,
  });
}

export async function startFix(
  ctx: AgentContext,
  input: StartFixInput,
): Promise<StartFixResult> {
  const { accountId, prId } = input;

  const auth = ctx.llm.detectAuth();
  if (auth.status !== 'ok') return { status: 'no_auth', message: auth.message };

  // Hard agentic cap: refuse a run once the account's monthly agent credit allowance is spent
  // (metered per calendar month; local accounts are unmetered → never blocked).
  if ((await ctx.aiCredits.check(accountId)).agentBlocked) return { status: 'credits_exhausted' };

  const instruction = (input.instruction ?? '').trim();
  if (input.seed === 'plain' && instruction === '') return { status: 'no_instruction' };

  if (claimed.has(prId)) return { status: 'already_running' };
  if (pending.length >= MAX_QUEUED) return { status: 'busy' };

  // Reserve the PR SYNCHRONOUSLY, in the same tick as the check above and BEFORE any await, so
  // two concurrent starts (a manual click and `maybeStartAutoFix`) can't both pass the guard.
  // ⚠ EVERY bail path below this line releases the claim, or this PR's fixer wedges for the
  // process's lifetime.
  claimed.add(prId);
  try {
    const pr = await getFixPrContext(ctx, accountId, prId);
    if (!pr) {
      claimed.delete(prId);
      return { status: 'not_found' };
    }

    // The review seed is resolved BEFORE GitHub is asked anything: a review with nothing to fix
    // must not spend two GitHub calls on its way to a refusal.
    //
    // ⚠ The rendered prompt is FROZEN HERE, at launch, and the run may start later (one global
    // slot). That is intended: the stored items must describe what the agent was actually given.
    let reviewItems: AiFixReviewItem[] | null = null;
    let sentRefs: string[] = [];
    let seed: FixSeed;
    if (input.seed === 'review') {
      const loaded = await loadReviewSeed(ctx, {
        accountId,
        prId,
        reviewId: input.sourceReviewId,
      });
      if (!loaded) {
        claimed.delete(prId);
        return { status: 'review_unavailable' };
      }
      if (loaded.seed.sentRefs.length === 0) {
        claimed.delete(prId);
        return { status: 'nothing_to_fix' };
      }
      reviewItems = loaded.seed.items;
      sentRefs = loaded.seed.sentRefs;
      seed = { kind: 'review', text: loaded.seed.text };
    } else {
      seed = { kind: 'plain', text: instruction };
    }

    const headInfo = await ctx.github.fetchPrHeadInfo(
      accountId,
      pr.owner,
      pr.name,
      pr.number,
    );
    const baseSha = headInfo.headSha;
    if (!baseSha) {
      claimed.delete(prId);
      return { status: 'no_head' };
    }

    const diff = await ctx.github
      .fetchPrDiff(accountId, pr.owner, pr.name, pr.number)
      .catch(() => '');

    const systemPrompt = buildFixSystemPrompt();
    const prompt = buildFixUserPrompt({ pr, diff, seed });
    const trigger: AiFixTrigger = input.trigger ?? 'manual';

    const fixId = await insertQueuedFix(ctx, {
      accountId,
      repoId: pr.repoId,
      prId,
      baseSha,
      model: input.model,
      seed: input.seed,
      sourceReviewId: input.seed === 'review' ? (input.sourceReviewId ?? null) : null,
      prompt,
      trigger,
      reviewItems,
    });
    fixIdByPr.set(prId, fixId);

    const job: FixJob = {
      fixId,
      accountId,
      prId,
      owner: pr.owner,
      name: pr.name,
      prNumber: pr.number,
      baseSha,
      model: input.model,
      systemPrompt,
      prompt,
      sentRefs,
    };

    const immediate = enqueue(prId, () => launchFix(ctx, job));
    if (!immediate) {
      emitFixStream(prId, {
        type: 'progress',
        status: 'queued',
        fixId,
        progress: { phase: 'fetching_diff' },
      });
    }
    return { status: 'queued', fixId };
  } catch (err) {
    claimed.delete(prId);
    fixIdByPr.delete(prId);
    ctx.log.warn({ err }, 'ai-fix startFix failed');
    return { status: 'not_found' };
  }
}

interface FixJob {
  fixId: number;
  accountId: number;
  prId: number;
  owner: string;
  name: string;
  prNumber: number;
  baseSha: string;
  model: string;
  systemPrompt: string;
  prompt: string;
  // The refs the agent was SHOWN — what its report is validated against at save time.
  sentRefs: readonly string[];
}

async function launchFix(ctx: AgentContext, job: FixJob): Promise<void> {
  const controller = new AbortController();
  controllers.set(job.fixId, controller);

  const seed: AiFixProgress = { phase: 'cloning' };
  progressByFix.set(job.fixId, seed);
  emitFixStream(job.prId, {
    type: 'progress',
    status: 'running',
    fixId: job.fixId,
    progress: seed,
  });

  const onProgress = (p: CodingProgress): void => {
    const prog = p as AiFixProgress;
    progressByFix.set(job.fixId, prog);
    emitFixStream(job.prId, {
      type: 'progress',
      status: 'running',
      fixId: job.fixId,
      progress: prog,
    });
  };

  let finalStatus: AiFixStatus = 'failed';
  try {
    await markFixRunning(ctx, job.fixId);
    const result = await ctx.coding.generateFix({
      accountId: job.accountId,
      owner: job.owner,
      name: job.name,
      prNumber: job.prNumber,
      baseSha: job.baseSha,
      model: job.model,
      systemPrompt: job.systemPrompt,
      prompt: job.prompt,
      abortController: controller,
      onProgress,
    });

    if (result.aborted || controller.signal.aborted) {
      await markFixCancelled(ctx, job.fixId);
      finalStatus = 'cancelled';
    } else {
      emitFixStream(job.prId, {
        type: 'progress',
        status: 'running',
        fixId: job.fixId,
        progress: { phase: 'persisting' },
      });
      await saveFixSuccess(ctx, job.fixId, result, job.sentRefs);
      finalStatus = 'succeeded';
    }
  } catch (err) {
    if (controller.signal.aborted) {
      await markFixCancelled(ctx, job.fixId).catch(() => {});
      finalStatus = 'cancelled';
    } else {
      const m = err instanceof Error ? err.message : String(err);
      await markFixFailed(ctx, job.fixId, m).catch(() => {});
      finalStatus = 'failed';
      ctx.log.warn({ err }, 'ai-fix run failed');
    }
  } finally {
    claimed.delete(job.prId);
    controllers.delete(job.fixId);
    progressByFix.delete(job.fixId);
    fixIdByPr.delete(job.prId);
    emitFixStream(job.prId, {
      type: 'done',
      status: finalStatus,
      fixId: job.fixId,
    });
  }
}

export function requestFixCancel(ctx: AgentContext, prId: number): boolean {
  const fixId = fixIdByPr.get(prId);
  if (fixId != null && running.has(prId)) {
    controllers.get(fixId)?.abort();
    return true;
  }
  const idx = pending.findIndex((j) => j.prId === prId);
  if (idx >= 0 && fixId != null) {
    pending.splice(idx, 1);
    claimed.delete(prId);
    fixIdByPr.delete(prId);
    void markFixCancelled(ctx, fixId).catch(() => {});
    emitFixStream(prId, { type: 'done', status: 'cancelled', fixId });
    return true;
  }
  return false;
}

export function isFixRunning(prId: number): boolean {
  return claimed.has(prId);
}

export async function getFixStatus(
  ctx: AgentContext,
  accountId: number,
  prId: number,
): Promise<AiFixStatusResponse> {
  // The DB lookup goes FIRST, and it is what establishes ownership.
  //
  // `running` / `claimed` / `fixIdByPr` are process-global Sets and Maps keyed by prId alone,
  // with no notion of who owns the job. Reading them before this query meant a foreign PR with
  // a job in flight returned that job's fixId and live `progress` to whoever asked — another
  // tenant's phase and activity, from a repository the caller cannot see. Every started fix
  // inserts its row (with accountId) BEFORE it runs, so "no row for this account" is a reliable
  // "not yours", and the in-memory maps are consulted only to upgrade a row we already know
  // belongs to the caller into a live status.
  const t = ctx.schema.aiFixes;
  const rows = (await ctx.db
    .select({ id: t.id, status: t.status })
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.prId, prId)))
    .orderBy(desc(t.id))
    .limit(1)
    .execute()) as Array<{ id: number; status: AiFixStatus }>;
  const row = rows[0];
  if (!row) return { status: 'idle', fixId: null, progress: null };

  // Live in-memory state, but only for a fix id this account actually owns.
  const liveFixId = fixIdByPr.get(prId) ?? null;
  if (liveFixId === row.id) {
    if (running.has(prId)) {
      return {
        status: 'running',
        fixId: row.id,
        progress: progressByFix.get(row.id) ?? { phase: 'cloning' },
      };
    }
    if (claimed.has(prId)) {
      return { status: 'queued', fixId: row.id, progress: { phase: 'fetching_diff' } };
    }
  }
  return { status: row.status, fixId: row.id, progress: null };
}

export async function reconcileFixesOnStartup(ctx: AgentContext): Promise<void> {
  try {
    const n = await reconcileOrphanedFixes(ctx);
    if (n > 0) ctx.log.info({ n }, 'ai-fix: reconciled orphaned runs on startup');
  } catch (err) {
    ctx.log.warn({ err }, 'ai-fix: startup reconcile failed');
  }
}
