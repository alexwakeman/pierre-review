import {
  CLAUDE_REVIEW_MAX_TICKETS,
  DEFAULT_CLAUDE_REVIEW_MODEL,
  type ActiveReview,
  type ClaudeReviewModel,
  type ClaudeReviewProgress,
  type ClaudeReviewStatusResponse,
  type ClaudeReviewStreamEvent,
  type ClaudeReviewTicket,
  type ClaudeReviewTrigger,
  type ClaudeTicketAssessment,
} from '@pierre-review/shared';
import type { CompareDiffResult } from '../../github/compare.js';
import { config } from '../../config.js';
import type { AgentContext } from '../agent-context.js';
import { getAgenticProviders } from '../plugin-providers.js';
import { agenticRunReady } from './ai-ready.js';
import { decideReviewMode } from './routing.js';
import { offeredSpecialists } from './specialists.js';
import {
  buildUserPrompt,
  pickReviewNonce,
  skipSummary,
  systemPromptForMode,
  untrustedTexts,
} from './prompts.js';
import {
  linkReraisedFindings,
  reconcileFollowUp,
  selectPriorFindings,
  SINCE_PATCH_CHARS,
  type FollowUpPlan,
} from './follow-up.js';
import { reconcileTicketAssessments, sameHeadTicketCarry, storyFindingsFrom } from './ticket.js';
import { planThreadReview, reconcileThreads, type ThreadPlan } from './threads.js';
import {
  planCiReview,
  reconcileCiFailures,
  selectCiFailures,
  type CiLogRead,
  type CiPlan,
} from './ci-failures.js';
import {
  getLatestClaudeReview,
  getLatestStoredTickets,
  getReviewPrContext,
  insertQueuedReview,
  isAutoReReviewSettled,
  loadPriorReviewForFollowUp,
  loadPriorRunForCarry,
  markReviewCommentsSeen,
  markReviewCancelled,
  markReviewFailed,
  markReviewRouted,
  reconcileOrphanedReviews,
  saveReviewSuccess,
  type ReviewPrContext,
} from './persist.js';

// The Claude Review queue/concurrency/SSE manager (CORE, free, local-only) — the analog of the
// AI-Fix manager. It owns the product pipeline (prepare → route → prompt → run → persist), calling
// `ctx.review.*` (built in review/agent-context.ts) for the security-sensitive steps. At most one
// review per PR; PRO_REVIEW_CONCURRENCY (historical name) bounds concurrent runs, extras wait FIFO.
// In-memory state is a process-singleton.

const envInt = (v: string | undefined, d: number): number => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const REVIEW_CONCURRENCY = envInt(process.env.PRO_REVIEW_CONCURRENCY, 4);
const REVIEW_MAX_QUEUED = envInt(process.env.PRO_REVIEW_MAX_QUEUED, 50);
// The AUTO lane's own queue cap (auto.ts). Separate from REVIEW_MAX_QUEUED so auto work can never
// fill the manual queue and make a person's click answer 'busy'. Auto items hold NO database row
// while they wait — the sweeper re-derives them from the DB each tick, so a restart loses nothing
// and a full lane just means "next tick".
const REVIEW_AUTO_MAX_QUEUED = envInt(process.env.PRO_REVIEW_AUTO_MAX_QUEUED, 20);
// Mutating process.env for the ambient-auth policy is only safe at concurrency 1.
const APPLY_AUTH_ENV = REVIEW_CONCURRENCY === 1;

// The ONE agentic switch (config.ts `aiEnabled`: local, and not LIMN_AI_DISABLED). The routes are
// not even registered where it is off; this is the second guard for any other caller.
export const AGENTIC_AI_ENABLED = config.aiEnabled;

interface QueueItem {
  ctx: AgentContext;
  accountId: number;
  reviewId: number;
  prId: number;
  model: ClaudeReviewModel;
  headSha: string;
  prCtx: ReviewPrContext;
  // The validated user stories (stored on the row at queue time); [] when none.
  tickets: ClaudeReviewTicket[];
  trigger: ClaudeReviewTrigger;
}

// An AUTO request waiting for a slot. Deliberately NOT a QueueItem: it has no row yet, so nothing
// about it is stored until it launches (see REVIEW_AUTO_MAX_QUEUED).
interface AutoItem {
  ctx: AgentContext;
  accountId: number;
  prId: number;
  // The workspace whose switch queued it, so switching that workspace off drops it
  // (`dropAutoReviews`). Absent only for a caller that names none (tests).
  workspaceId?: number;
  // A RE-REVIEW triggered by new review comments on an unchanged head: the newest such comment's
  // time. The settle re-check (`isAutoReReviewSettled`) needs it; null/absent for a first review or
  // a moved head.
  commentsAtMs?: number | null;
}

const claimed = new Set<number>(); // prIds running OR pending — the re-trigger guard
const pending: QueueItem[] = [];
// THE AUTO LANE. Drained only when the manual queue is empty, so a click always goes first. Its
// prIds are NOT in `claimed`, but a manual start on one is REFUSED (`auto_in_progress`): while an
// auto review is queued or running, the PR's manual Review is locked until it ends.
const autoPending: AutoItem[] = [];
// Auto items between "slot taken" and "launched" (the async prep), by prId. Counted
// against the ONE shared REVIEW_CONCURRENCY so the lane cannot overshoot it while its row is being
// written. Still "queued" as far as the lock is concerned.
const startingAuto = new Map<number, AutoItem>();
const inFlight = (): number => runningItems.size + startingAuto.size;

/**
 * May a Claude Review CHAT turn mutate process.env for the auth policy right now? Only under the
 * review's own rule (concurrency 1) AND while no review run is in flight — the chat is a second
 * agent in the same process, and two runs restoring one global env would race (chat.ts).
 */
export function chatMayApplyAuthEnv(): boolean {
  return APPLY_AUTH_ENV && inFlight() === 0;
}
const runningItems = new Map<number, QueueItem>(); // prId → item (running)
const reviewIdByPr = new Map<number, number>();
const progressByReview = new Map<number, ClaudeReviewProgress>();
const controllers = new Map<number, AbortController>();
const streamSubs = new Map<number, Set<(e: ClaudeReviewStreamEvent) => void>>();

function emitReviewStream(prId: number, e: ClaudeReviewStreamEvent): void {
  const subs = streamSubs.get(prId);
  if (!subs) return;
  for (const cb of subs) {
    try {
      cb(e);
    } catch {
      /* a broken subscriber must never break the run */
    }
  }
}

export function subscribeReviewStream(
  prId: number,
  cb: (e: ClaudeReviewStreamEvent) => void,
): () => void {
  let set = streamSubs.get(prId);
  if (!set) {
    set = new Set();
    streamSubs.set(prId, set);
  }
  set.add(cb);
  return () => {
    const s = streamSubs.get(prId);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) streamSubs.delete(prId);
  };
}

export type StartReviewResult =
  | { ok: true; reviewId: number; queued: boolean }
  | {
      ok: false;
      reason: 'disabled' | 'already_running' | 'busy' | 'not_found' | 'no_head' | 'credits_exhausted';
    }
  // An auto review holds this PR (waiting in the auto lane, or running): manual start is locked
  // until it ends. The route answers 409 AutoReviewInProgress.
  | { ok: false; reason: 'auto_in_progress'; auto: AutoReviewHold };

/** Whether an AUTO review holds `prId` for this account right now: waiting in the lane (or mid-start,
 *  no row yet) = 'queued'; launched = 'running'; otherwise null. Account-checked, so another
 *  tenant's PR id answers null. */
export type AutoReviewHold = 'queued' | 'running';
export function autoReviewHold(prId: number, accountId: number): AutoReviewHold | null {
  const run = runningItems.get(prId);
  if (run) return run.trigger === 'auto' && run.accountId === accountId ? 'running' : null;
  if (startingAuto.get(prId)?.accountId === accountId) return 'queued';
  if (autoPending.some((a) => a.prId === prId && a.accountId === accountId)) return 'queued';
  return null;
}

export async function startReview(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  model: ClaudeReviewModel,
  // TRAILING optional: the route's `checkClaudeReviewTickets` result (already normalised).
  tickets: ClaudeReviewTicket[] = [],
): Promise<StartReviewResult> {
  if (!AGENTIC_AI_ENABLED) return { ok: false, reason: 'disabled' };
  // Hard agentic cap: refuse a run once the account's monthly agent credit allowance is spent
  // (metered per calendar month; local accounts are unmetered → never blocked).
  if ((await ctx.aiCredits.check(accountId)).agentBlocked)
    return { ok: false, reason: 'credits_exhausted' };
  // ⚠ Checked AFTER the credits await and BEFORE `claimed`: a running auto run is also in
  // `claimed`, and must answer the auto lock, not 'already_running'.
  const hold = autoReviewHold(prId, accountId);
  if (hold) return { ok: false, reason: 'auto_in_progress', auto: hold };
  if (claimed.has(prId)) return { ok: false, reason: 'already_running' };
  if (pending.length >= REVIEW_MAX_QUEUED) return { ok: false, reason: 'busy' };
  claimed.add(prId); // reserve synchronously before any await

  let reviewId: number;
  let prCtx: ReviewPrContext | null;
  try {
    prCtx = await getReviewPrContext(ctx, prId, accountId);
    if (!prCtx) {
      claimed.delete(prId);
      return { ok: false, reason: 'not_found' };
    }
    if (!prCtx.headSha) {
      claimed.delete(prId);
      return { ok: false, reason: 'no_head' };
    }
    reviewId = await insertQueuedReview(ctx, prId, prCtx.headSha, model, accountId, tickets, 'manual');
  } catch (err) {
    claimed.delete(prId);
    throw err;
  }

  const item: QueueItem = {
    ctx,
    accountId,
    reviewId,
    prId,
    model,
    headSha: prCtx.headSha,
    prCtx,
    tickets,
    trigger: 'manual',
  };
  reviewIdByPr.set(prId, reviewId);
  if (inFlight() < REVIEW_CONCURRENCY) {
    launch(item);
    return { ok: true, reviewId, queued: false };
  }
  pending.push(item);
  return { ok: true, reviewId, queued: true };
}

export type EnqueueAutoResult = 'queued' | 'already' | 'full' | 'disabled';

/**
 * Put ONE PR on the auto lane (the sweeper's only door into the queue). Synchronous and
 * storage-free: the row is written when a slot opens (`startAutoItem`). Same model and budget as a
 * manual run (the model is the manual default; the budget is core's per-review ceiling).
 */
export function enqueueAutoReview(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  workspaceId?: number,
  // TRAILING: set for a re-review triggered by new review comments (see AutoItem).
  commentsAtMs: number | null = null,
): EnqueueAutoResult {
  if (!AGENTIC_AI_ENABLED) return 'disabled';
  if (claimed.has(prId) || autoPending.some((a) => a.prId === prId)) return 'already';
  if (autoPending.length >= REVIEW_AUTO_MAX_QUEUED) return 'full';
  autoPending.push({ ctx, accountId, prId, workspaceId, commentsAtMs });
  pump();
  return 'queued';
}

/**
 * Drop WAITING auto items (no row yet, so nothing is lost) whose workspace no longer has auto
 * review on. `keep(accountId, workspaceId)` answers whether a workspace is still on. Switching a
 * workspace off must stop it: without this, up to a full lane of already-queued PRs would still be
 * reviewed — and billed — after the switch. A run already started (row written) is left alone; it
 * has the ordinary Stop. Returns how many were dropped.
 */
export function dropAutoReviews(keep: (accountId: number, workspaceId: number) => boolean): number {
  let dropped = 0;
  for (let i = autoPending.length - 1; i >= 0; i -= 1) {
    const a = autoPending[i]!;
    if (a.workspaceId == null || keep(a.accountId, a.workspaceId)) continue;
    autoPending.splice(i, 1);
    dropped += 1;
  }
  return dropped;
}

/** How many more PRs the auto lane will take right now. */
export function autoLaneRoom(): number {
  return Math.max(0, REVIEW_AUTO_MAX_QUEUED - autoPending.length);
}

/** PRs the auto lane holds that have NO row yet — waiting, or mid-start. The sweeper counts
 *  these against the daily cap, since `autoToday` (rows) cannot see them. */
export function autoPendingPrIds(): Set<number> {
  return new Set([...autoPending.map((a) => a.prId), ...startingAuto.keys()]);
}

/** Test seam: the lane's contents, in launch order. */
export function _autoLaneForTest(): Array<{ accountId: number; prId: number }> {
  return autoPending.map((a) => ({ accountId: a.accountId, prId: a.prId }));
}

// The auto run's user stories, from the optional Pro Jira provider (every detected ticket, up to
// the cap; an older plugin answers one). Never throws.
async function autoTicketsFor(accountId: number, prId: number): Promise<ClaudeReviewTicket[]> {
  const resolve = getAgenticProviders().resolveReviewTicket;
  if (!resolve) return [];
  try {
    const r = await resolve(accountId, prId);
    const list = r.tickets ?? (r.ticket ? [r.ticket] : []);
    return list.slice(0, CLAUDE_REVIEW_MAX_TICKETS);
  } catch {
    return [];
  }
}

// A slot opened and the manual queue is empty: write the auto run's row and launch it. Mirrors
// `startReview` step for step (credits → claim → PR context → row → launch), with the
// trigger stamped 'auto'. Any refusal simply drops the item: the PR has no row, so the next tick
// finds it again if it still qualifies.
async function startAutoItem(a: AutoItem): Promise<void> {
  const { ctx, accountId, prId } = a;
  claimed.add(prId);
  let launched = false;
  try {
    // AI went away since the sweep (runtime removed, signed out): drop the item BEFORE its row
    // exists, or the PR's one automatic review is spent on a failure (ai-ready.ts).
    if (!agenticRunReady(ctx)) return;
    if ((await ctx.aiCredits.check(accountId)).agentBlocked) return;
    const prCtx = await getReviewPrContext(ctx, prId, accountId);
    if (!prCtx?.headSha) return;
    // ONE RUN PER KEY: a person may have reviewed this head (and, for a comment-triggered
    // re-review, seen those comments) while the item waited.
    if (await isAutoReReviewSettled(ctx, prId, accountId, prCtx.headSha, a.commentsAtMs ?? null)) return;
    const model = DEFAULT_CLAUDE_REVIEW_MODEL;
    // A RE-REVIEW (the PR was reviewed before, at an older head) reuses the stories that review
    // carried — a reader may have typed them. Otherwise ⚠ TRY JIRA WHEN THE PLUGIN OFFERS IT: the
    // browser fills the stories for a click; nobody is here to, so the Pro Jira provider
    // (plugin-providers.ts) fetches the PR's detected tickets. Absent (no plugin, no tracker) or
    // failing, the review runs without a story. The item is already `claimed`, so these awaits
    // cannot double-start.
    const prior = await getLatestStoredTickets(ctx, prId, accountId);
    const tickets = prior.length > 0 ? prior : await autoTicketsFor(accountId, prId);
    const reviewId = await insertQueuedReview(
      ctx,
      prId,
      prCtx.headSha,
      model,
      accountId,
      tickets,
      'auto',
    );
    reviewIdByPr.set(prId, reviewId);
    startingAuto.delete(prId);
    launched = true;
    launch({
      ctx,
      accountId,
      reviewId,
      prId,
      model,
      headSha: prCtx.headSha,
      prCtx,
      tickets,
      trigger: 'auto',
    });
  } catch (err) {
    ctx.log.error(
      { err },
      `auto claude review pr ${prId} could not start: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    if (!launched) {
      startingAuto.delete(prId);
      claimed.delete(prId);
      pump();
    }
  }
}

function launch(item: QueueItem): void {
  const { ctx, prId, reviewId } = item;
  runningItems.set(prId, item);
  reviewIdByPr.set(prId, reviewId);
  const controller = new AbortController();
  controllers.set(reviewId, controller);

  const emit = (progress: ClaudeReviewProgress): void => {
    progressByReview.set(reviewId, progress);
    emitReviewStream(prId, { type: 'progress', status: 'running', reviewId, progress });
  };
  emit({ phase: 'fetching_diff' });

  void runPipeline(item, controller, emit)
    .then((succeeded) => {
      // AUTO FIX: a SUCCEEDED auto run may start a review-seeded fix on the reader's OWN PR
      // (coding/ai-fix/auto-fix.ts decides; nothing is pushed). Fire-and-forget, never awaited and
      // never thrown into the review: a fix that fails to start costs the fix only.
      if (succeeded && item.trigger === 'auto') {
        void import('../../coding/ai-fix/auto-fix.js')
          .then((m) =>
            m.maybeStartAutoFix(ctx, { accountId: item.accountId, prId, reviewId }),
          )
          .catch((err) =>
            ctx.log.warn(
              `auto fix pr ${prId}: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
      }
    })
    .catch(async (err) => {
      // Unexpected error in prepare/persist (runReview itself never throws). Record it.
      ctx.log.error(
        { err },
        `claude review pr ${prId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      await markReviewFailed(ctx, reviewId, err instanceof Error ? err.message : String(err)).catch(
        () => {},
      );
    })
    .finally(() => {
      runningItems.delete(prId);
      reviewIdByPr.delete(prId);
      controllers.delete(reviewId);
      progressByReview.delete(reviewId);
      claimed.delete(prId);
      void getLatestClaudeReview(ctx, prId, item.accountId)
        .then((latest) =>
          emitReviewStream(prId, { type: 'done', status: latest?.status ?? 'failed', reviewId }),
        )
        .catch(() => emitReviewStream(prId, { type: 'done', status: 'failed', reviewId }));
      pump();
    });
}

async function runPipeline(
  item: QueueItem,
  controller: AbortController,
  emit: (p: ClaudeReviewProgress) => void,
): Promise<boolean> {
  // Resolves true when the run was saved as SUCCEEDED (the auto-fix hook in `launch` reads it).
  const { ctx, reviewId, prCtx, model } = item;

  const prep = await ctx.review.prepareReview({
    owner: prCtx.owner,
    name: prCtx.name,
    prNumber: prCtx.number,
  });

  emit({ phase: 'deciding' });
  const decision = decideReviewMode(prep.fileMetrics);
  await markReviewRouted(ctx, reviewId, decision.mode, decision.reason);

  // 'skip' — nothing substantive to review. Synthesize a succeeded run, no agent turns.
  if (decision.mode === 'skip') {
    emit({ phase: 'persisting' });
    await saveReviewSuccess(ctx, reviewId, {
      scope: null,
      summary: skipSummary(decision.reason.changedFiles),
      verdict: 'COMMENT',
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
      numTurns: 0,
      diffBytes: prep.diffBytes,
      diffCapped: prep.diffCapped,
      excludedFiles: prep.excludedFiles,
      findings: [],
    });
    return true;
  }

  const mode = decision.mode; // 'diff_only' | 'worktree'

  // ---- follow-up on the previous review ----
  // A DB error here throws on purpose: it fails before any model spend and the error shows.
  const prior = await loadPriorReviewForFollowUp(ctx, item.prId, item.accountId, reviewId);
  const plan: FollowUpPlan | null =
    prior && prior.findings.length > 0 ? selectPriorFindings(prior, item.headSha) : null;
  // "What changed since that review" — ONE compare call (never throws; wrapped anyway, the
  // annotations/evidence.ts precedent), only when the head actually moved. Nothing is stored;
  // a failure (force-push, 404, rate limit) degrades to judging against the full diff.
  // ⚠ The path filter is CLIENT-side (github/compare.ts), so widening it costs nothing — and it
  // must include the earlier findings' own files: a push that REVERTS a flagged file drops it
  // out of the PR's changed files, and filtering on those alone would hide the revert and tell
  // the model the file did not change.
  let since: CompareDiffResult | null = null;
  if (plan?.headMoved) {
    try {
      since = await ctx.github.fetchCompareDiff(item.accountId, {
        owner: prCtx.owner,
        name: prCtx.name,
        baseSha: plan.priorHeadSha,
        headSha: item.headSha,
        paths: [...new Set([...prep.changedFiles, ...plan.sent.map((s) => s.finding.path)])],
        maxPatchChars: SINCE_PATCH_CHARS,
      });
    } catch {
      since = null;
    }
  }

  // ---- what an earlier run already decided AT THIS HEAD (only new commits change it) ----
  const priorRun = await loadPriorRunForCarry(ctx, item.prId, item.accountId, reviewId);
  const sameHeadPrior = priorRun && priorRun.headSha === item.headSha ? priorRun : null;
  const carriedTickets = sameHeadTicketCarry(item.tickets, sameHeadPrior);
  const allTicketsCarried = item.tickets.length > 0 && carriedTickets.every((a) => a != null);
  // Every story already assessed at this head ⇒ none is sent: nothing in the code could change it.
  const promptTickets = allTicketsCarried ? [] : item.tickets;

  // ---- the OTHER reviewers' open threads (people and review bots; never Limn's own) ----
  // A failure here costs the thread block only, never the review.
  let threadPlan: ThreadPlan | null = null;
  const loadThreads = ctx.queries.loadReviewThreads?.bind(ctx.queries);
  if (loadThreads) {
    try {
      const loaded = await loadThreads(item.accountId, item.prId);
      // The comment half of the auto re-review key: what this run saw (auto.ts).
      await markReviewCommentsSeen(ctx, reviewId, loaded.newestCommentAt);
      threadPlan = planThreadReview(loaded.threads, item.headSha, priorRun?.threadAssessments ?? null);
    } catch (err) {
      ctx.log.warn(
        `claude review pr ${item.prId}: review threads not loaded: ${err instanceof Error ? err.message : String(err)}`,
      );
      threadPlan = null;
    }
  }

  // ---- failed CI on the reviewed head (only when a check failed; never fatal) ----
  const ciPlan = await planCiForRun(item, prCtx, priorRun?.ciFailures ?? null);

  const nonce = pickReviewNonce(untrustedTexts(plan, promptTickets, since, threadPlan, ciPlan));

  // A deep review offers the lead its specialist sub-agents (specialists.ts); a diff-only one none.
  const specialists = mode === 'worktree' ? offeredSpecialists(prep.changedFiles) : [];
  const systemPrompt = systemPromptForMode(mode, specialists);
  const prompt = buildUserPrompt({
    repoFullName: prCtx.repoFullName,
    prNumber: prCtx.number,
    title: prCtx.title,
    body: prCtx.body,
    headSha: item.headSha,
    baseRef: prCtx.baseRefName,
    changedFiles: prep.changedFiles,
    excludedFiles: prep.excludedFiles,
    diff: prep.promptDiff,
    mode,
    omittedFiles: prep.omittedFiles,
    tickets: promptTickets,
    followUp: plan ? { plan, since } : null,
    threads: threadPlan,
    ci: ciPlan,
    nonce,
  });

  const res = await ctx.review.runReview({
    owner: prCtx.owner,
    name: prCtx.name,
    prNumber: prCtx.number,
    headSha: item.headSha,
    model,
    mode,
    systemPrompt,
    prompt,
    strippedDiff: prep.strippedDiff,
    specialists,
    applyAuthEnv: APPLY_AUTH_ENV,
    abortController: controller,
    onProgress: (p) =>
      emit({
        phase: p.phase,
        reviewMode: p.reviewMode,
        recentActivity: p.recentActivity,
        usage: p.usage,
      }),
  });

  emit({ phase: 'persisting' });
  const telemetry = {
    costUsd: res.costUsd,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
    cacheReadTokens: res.cacheReadTokens,
    cacheCreationTokens: res.cacheCreationTokens,
    numTurns: res.numTurns,
    diffBytes: prep.diffBytes,
    diffCapped: prep.diffCapped,
  };
  if (res.aborted) {
    await markReviewCancelled(ctx, reviewId);
    return false;
  } else if (!res.submitted) {
    await markReviewFailed(ctx, reviewId, res.failureReason ?? 'review failed', {
      ...telemetry,
      scope: res.scope,
      excludedFiles: prep.excludedFiles,
    });
  } else {
    // Server-side validation of the model's follow-up + ticket reports: each ref once, unknown
    // refs dropped, anything unreported 'not_checked' — never an invented 'addressed' / 'met'.
    const items = plan ? reconcileFollowUp(plan, res.followUp) : null;
    // One assessment per ticket, index-aligned with the stored `ticket` array; a story already
    // assessed at this head keeps that assessment.
    const ticketAssessment: ClaudeTicketAssessment[] | null =
      item.tickets.length === 0
        ? null
        : allTicketsCarried
          ? carriedTickets.filter((a): a is ClaudeTicketAssessment => a != null)
          : reconcileTicketAssessments(item.tickets, res.tickets, res.ticket).map(
              (a, i) => carriedTickets[i] ?? a,
            );
    // Every unmet / partly met criterion and every "Not done" item becomes a FINDING of this run
    // (deterministic, no model call), anchored against the same diff as the model's findings.
    // A carried assessment re-creates its findings here; one re-raising an earlier POSTED story
    // finding is linked to it (never a second row) by linkReraisedFindings.
    const storyFindings = ticketAssessment
      ? storyFindingsFrom(item.tickets, ticketAssessment, prep.strippedDiff)
      : [];
    const findings =
      plan && items
        ? linkReraisedFindings(plan, items, res.findings, new Set(prep.changedFiles), storyFindings)
        : [...res.findings, ...storyFindings].map((f) => ({ ...f, priorFindingId: null }));
    const threadAssessments = threadPlan ? reconcileThreads(threadPlan, res.threads) : null;
    // Each failing check exactly once: Claude's first report for its ref, a carried diagnosis, or
    // 'not_checked' with the server's reason — never an invented cause.
    const ciFailures = ciPlan ? reconcileCiFailures(ciPlan, res.ciFailures) : null;
    await saveReviewSuccess(ctx, reviewId, {
      scope: res.scope,
      summary: res.summary,
      verdict: res.verdict,
      ...telemetry,
      excludedFiles: prep.excludedFiles,
      findings,
      followUp:
        plan && items
          ? {
              priorReviewId: plan.priorReviewId,
              priorHeadSha: plan.priorHeadSha,
              headMoved: plan.headMoved,
              changesSinceShown: !!since?.ok && since.files.length > 0,
              items,
            }
          : null,
      ticketAssessment,
      threadAssessments,
      ciFailures,
    });
    return true;
  }
  return false;
}

/**
 * Read the reviewed head's checks and, for each FAILING GitHub Actions job not already diagnosed
 * at this head, one tail window of its log plus GitHub's failed-step record — at most
 * CI_FAILURES_MAX jobs, in parallel. null ⇒ the run does not look at CI (no `ctx.ci`, or the
 * checks could not be read); that is never fatal to the review. Exported for tests.
 */
export async function planCiForRun(
  item: Pick<QueueItem, 'ctx' | 'accountId' | 'prId' | 'headSha'>,
  prCtx: Pick<ReviewPrContext, 'owner' | 'name'>,
  prior: Parameters<typeof selectCiFailures>[3],
): Promise<CiPlan | null> {
  const { ctx } = item;
  const ci = ctx.ci;
  if (!ci) return null;
  try {
    const checks = await ci.readCommitChecks(item.accountId, {
      owner: prCtx.owner,
      name: prCtx.name,
      sha: item.headSha,
    });
    if (!checks.ok) {
      ctx.log.warn(`claude review pr ${item.prId}: CI checks not read (${checks.reason})`);
      return null;
    }
    const sel = selectCiFailures(checks.checks, checks.rollupState, item.headSha, prior);
    const reads: CiLogRead[] = await Promise.all(
      sel.toRead.map(async (check): Promise<CiLogRead> => {
        const jobId = check.jobId as number;
        const [log, step] = await Promise.all([
          ci
            .readJobLog(item.accountId, { owner: prCtx.owner, name: prCtx.name, jobId })
            .catch(() => null),
          ci
            .readFailedStep(item.accountId, { owner: prCtx.owner, name: prCtx.name, jobId })
            .catch(() => null),
        ]);
        return {
          check,
          step,
          log: log?.available ? { text: log.text, windowTruncated: (log.startByte ?? 0) > 0 } : null,
        };
      }),
    );
    return planCiReview(sel, reads);
  } catch (err) {
    ctx.log.warn(
      `claude review pr ${item.prId}: CI failures not read: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

// Fill free slots: EVERY manual item first, then the auto lane. One shared REVIEW_CONCURRENCY.
function pump(): void {
  while (inFlight() < REVIEW_CONCURRENCY && pending.length > 0) {
    launch(pending.shift()!);
  }
  while (inFlight() < REVIEW_CONCURRENCY && pending.length === 0 && autoPending.length > 0) {
    const a = autoPending.shift()!;
    if (claimed.has(a.prId)) continue; // a person started it meanwhile
    startingAuto.set(a.prId, a); // the slot is taken SYNCHRONOUSLY, before the prep's first await
    void startAutoItem(a);
  }
}

/**
 * Cancel the review for a PR. `accountId` is REQUIRED and enforced against the queue entry's
 * own owner: without it, one tenant could abort another tenant's in-flight (billed) agentic run
 * by guessing a PR id — a cross-tenant denial of service that also wasted the victim's spend.
 * A non-matching or unknown prId returns false, which the route turns into a 404 (identical to
 * "no such review", so it leaks nothing about whose PR it is).
 */
export function requestReviewCancel(prId: number, accountId: number): boolean {
  const reviewId = reviewIdByPr.get(prId);
  const runningItem = runningItems.get(prId);
  if (runningItem?.accountId === accountId && reviewId != null) {
    controllers.get(reviewId)?.abort();
    return true;
  }
  const idx = pending.findIndex((p) => p.prId === prId && p.accountId === accountId);
  if (idx >= 0) {
    const item = pending.splice(idx, 1)[0]!;
    claimed.delete(prId);
    reviewIdByPr.delete(prId);
    void markReviewCancelled(item.ctx, item.reviewId).catch(() => {});
    return true;
  }
  return false;
}

// The in-memory queue maps are keyed by prId ALONE and are process-global — shared by every
// tenant in cloud. `accountId` used to be consulted only in the DB fallback below, so a running
// review for ANOTHER account's PR was reported back verbatim: its reviewId, and its live
// `progress`, whose `recentActivity` is a rolling log of what the agent is doing right now —
// file paths and source snippets from a repository the caller cannot see. Worse, the SSE stream
// route only tears down when the snapshot stops saying 'running', so a foreign PR reported as
// running produced a SUSTAINED live feed of another tenant's private repo.
//
// Every in-memory branch now requires the entry's OWN accountId to match; a mismatch falls
// through to the account-scoped DB lookup, which correctly answers 'idle' for a PR the caller
// does not own. QueueItem has always carried accountId — it simply was not checked.
export async function getReviewStatus(
  ctx: AgentContext,
  accountId: number,
  prId: number,
): Promise<ClaudeReviewStatusResponse> {
  const reviewId = reviewIdByPr.get(prId);
  const runningItem = runningItems.get(prId);
  if (reviewId != null && runningItem?.accountId === accountId) {
    return {
      status: 'running',
      reviewId,
      progress: progressByReview.get(reviewId) ?? null,
      trigger: runningItem.trigger,
    };
  }
  const queued = pending.find((p) => p.prId === prId && p.accountId === accountId);
  if (queued) return { status: 'queued', reviewId: queued.reviewId, progress: null, trigger: 'manual' };
  // Waiting in the AUTO lane: no row yet, so no reviewId.
  if (autoReviewHold(prId, accountId) === 'queued') {
    return { status: 'queued', reviewId: null, progress: null, trigger: 'auto' };
  }
  const latest = await getLatestClaudeReview(ctx, prId, accountId);
  if (!latest) return { status: 'idle', reviewId: null, progress: null };
  return { status: latest.status, reviewId: latest.id, progress: null };
}

/**
 * The caller's own in-flight reviews. `accountId` is REQUIRED: this used to enumerate the whole
 * process-global queue, so `GET /api/claude-reviews/active` handed every tenant the repo full
 * name, PR number and PR title of every other tenant's running review.
 *
 * Includes the AUTO lane's waiting items (`status: 'queued'`, `trigger: 'auto'`, `reviewId: null` —
 * they have no row yet). Their PR coordinates are read per call; the lane is capped small.
 */
export async function listActiveReviews(accountId: number): Promise<ActiveReview[]> {
  const out: ActiveReview[] = [];
  for (const item of runningItems.values()) {
    if (item.accountId !== accountId) continue;
    out.push({
      reviewId: item.reviewId,
      prId: item.prId,
      repoFullName: item.prCtx.repoFullName,
      prNumber: item.prCtx.number,
      prTitle: item.prCtx.title,
      status: 'running',
      phase: progressByReview.get(item.reviewId)?.phase ?? null,
      trigger: item.trigger,
    });
  }
  for (const item of pending) {
    if (item.accountId !== accountId) continue;
    out.push({
      reviewId: item.reviewId,
      prId: item.prId,
      repoFullName: item.prCtx.repoFullName,
      prNumber: item.prCtx.number,
      prTitle: item.prCtx.title,
      status: 'queued',
      phase: null,
      trigger: item.trigger,
    });
  }
  const waiting = [...startingAuto.values(), ...autoPending].filter(
    (a) => a.accountId === accountId,
  );
  for (const a of waiting) {
    const prCtx = await getReviewPrContext(a.ctx, a.prId, accountId).catch(() => null);
    if (!prCtx) continue;
    out.push({
      reviewId: null,
      prId: a.prId,
      repoFullName: prCtx.repoFullName,
      prNumber: prCtx.number,
      prTitle: prCtx.title,
      status: 'queued',
      phase: null,
      trigger: 'auto',
    });
  }
  return out;
}

export async function reconcileReviewsOnStartup(ctx: AgentContext): Promise<void> {
  const n = await reconcileOrphanedReviews(ctx);
  if (n > 0) ctx.log.info(`reconciled ${n} orphaned claude review(s) -> failed`);
}
