import {
  aiRunProvider,
  CLAUDE_REVIEW_MAX_TICKETS,
  DEFAULT_CLAUDE_REVIEW_MODEL,
  TICKET_REVIEW_PEER_MAX_FOR_PR_REVIEW,
  type ActiveReview,
  type ClaudeReviewModel,
  type ClaudeReviewProgress,
  type ClaudeReviewStatusResponse,
  type ClaudeReviewStreamEvent,
  type ClaudeReviewTrigger,
  type ReferenceDocCitation,
  type ReviewDocReference,
  type ReviewPeerRead,
} from '@pierre-review/shared';
import type { ReviewRunPeer, RunReviewResult } from '../../platform/contract.js';
import { relatedRepoCompanions } from './related-repos.js';
import type { CompareDiffResult } from '../../github/compare.js';
import { config } from '../../config.js';
import type { AgentContext } from '../agent-context.js';
import { getTicketSource } from '../../tracker/ticket-source.js';
import { agenticRunReady } from './ai-ready.js';
import { automaticRunAllowed } from '../budget-gate.js';
import { decideReviewMode } from './routing.js';
import { offeredSpecialists } from './specialists.js';
import {
  buildUserPrompt,
  peerRef,
  pickReviewNonce,
  skipSummary,
  sonarHasContent,
  systemPromptForMode,
  untrustedTexts,
  type PromptPairInput,
  type PromptPeer,
} from './prompts.js';
import { dropPairRepeats, pairInputOf, pairProvidersReady, readAutoReviewProvidersForPr } from './pair.js';
import { preflightFor } from '../../ai/run-choice.js';
import {
  linkReraisedFindings,
  reconcileFollowUp,
  dropAcceptedReraises,
  isResolvedWithReplies,
  selectPriorFindings,
  SINCE_PATCH_CHARS,
  type FollowUpPlan,
} from './follow-up.js';
import { planThreadReview, reconcileThreads, type ThreadPlan } from './threads.js';
import { currentThreadAssessmentsForPrs, priorAssessmentsForProvider } from './thread-judgements.js';
import { activeProviderId } from '../../ai/provider-setting.js';
import type { AgentProviderId } from '../../ai/provider.js';
import { dropSettledReraises, similarTitles } from './settled-by-reply.js';
import { attachFindingThreads } from './finding-replies.js';
import {
  getClaudeReviewById,
  getLatestClaudeReview,
  getReviewPeerContexts,
  getReviewPrContext,
  insertQueuedReview,
  markReviewRanOn,
  markReviewPeersRead,
  isAutoReReviewSettled,
  isAutoRetryStillDue,
  loadPriorReviewForFollowUp,
  loadSettledByReplyFindings,
  loadUnjudgedReplyFindings,
  loadPriorRunForCarry,
  markReviewCommentsSeen,
  markReviewCancelled,
  markReviewFailed,
  markReviewRouted,
  reconcileOrphanedReviews,
  saveReviewSuccess,
  type ReviewPrContext,
} from './persist.js';
import { emitClaudeReviewCompleted } from '../../platform/event-hooks.js';
import type { AutoPostOutcome } from './auto-post.js';
import {
  claimBeforeAutoRun,
  finishTeamClaim,
  postedReviewUrl,
  saveTeamClaimRecord,
  startTeamClaimRenew,
  stopTeamClaimRenew,
  type TeamClaimHandle,
} from './team-claim.js';
import { ensureSonarSnapshot } from '../../sonar/snapshot.js';

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
  // THE RUN'S PROVIDER, decided ONCE at queue time: a manual run's per-run choice, or the default
  // provider (Settings → AI) for an automatic one. Every provider-dependent step of the job — the
  // queued row's label, the follow-up chain, the thread carry, the run itself — reads THIS.
  provider: AgentProviderId;
  headSha: string;
  prCtx: ReviewPrContext;
  trigger: ClaudeReviewTrigger;
  // A FROM-SCRATCH run (`GenerateReviewBody.fresh`, manual only): it reads NO earlier review — no
  // follow-up chain, no settled list, no carried thread judgements. Never set on an auto run.
  fresh?: boolean;
  // TEAM CLAIMS (team-claim.ts): the GitHub status line this AUTO run holds (or why it has none).
  // Renewed while the run goes; its final line is posted when the run ends. Never on a manual run.
  teamClaim?: TeamClaimHandle;
  // ONE HALF OF A CLAUDE + CODEX PAIR (pair.ts; docs/CLAUDE-REVIEW.md § Claude + Codex). Absent on an
  // ordinary run.
  pair?: PairState;
  // Set when the run ends: did it succeed? (The pair's second half reads the first's.)
  succeeded?: boolean;
  // Set when the run (or its whole pair) ends: the auto-post it started, if any. The team claim's
  // final line waits for it (the comment count and the posted review's link).
  autoPosted?: Promise<AutoPostOutcome | null>;
}

// The pair as one half carries it. The providers are resolved ONCE, when the pair starts.
interface PairState {
  role: 'first' | 'second';
  // The FIRST half's run id (`claude_reviews.pair_id`).
  pairId: number;
  // First half: who runs the second (decided at the pair's start).
  secondProvider?: AgentProviderId;
  // Second half: did the first succeed, and what it raised (the prompt input + the code dedupe).
  firstSucceeded?: boolean;
  input?: PromptPairInput | null;
  firstFindings?: ReadonlyArray<{ path: string; line: number | null; title: string }>;
  // Queued by a reader's press (auto): the spend budget is not asked again before the second half.
  pressed?: boolean;
  // Second half of an AUTO pair: the FIRST half's run, whose team-claim line (if any) is still held
  // and is finished when the pair ends.
  first?: QueueItem;
}

/** Does this run hand over to a second half when it ends? */
const pairContinues = (item: QueueItem): boolean =>
  item.pair?.role === 'first' && item.pair.secondProvider != null;

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
  // A RETRY of this failed AUTO run at the PR's current head (auto.ts, the start rule's retry
  // branch). The lane re-checks it is still the latest row at the head (`isAutoRetryStillDue`) — for
  // a `pressed` item, the latest AUTO row there, with no AUTO success (manual rows ignored).
  retryOfReviewId?: number | null;
  // Queued by the READER's press ("Run auto reviews now" / "Retry"): the spend budget is not asked
  // again at start — the press was the reader's choice (the SPA's over-budget confirm already ran).
  pressed?: boolean;
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
// A pair between its halves: the first ended, the second's row is being written. Holds the slot and
// the PR's claim, so nothing slips in between the two.
const startingPair = new Map<number, QueueItem>();
const inFlight = (): number =>
  runningItems.size + startingAuto.size + startingPair.size + slotPeers.reduce((n, p) => n + p.inFlight(), 0);

// ---- THE ONE CONCURRENCY BUDGET, shared with the TICKET review (ticket-review/manager.ts) and the
// CI review (ci-review/manager.ts) ----
// REVIEW_CONCURRENCY bounds PR reviews, ticket reviews and CI reviews TOGETHER: all are agent runs on
// the same Claude credential and clone cache. Each peer lane registers its own in-flight count and
// pump here; each side claims a slot SYNCHRONOUSLY (before its first await) and, when a run ends,
// pumps the others too. PR-review manual items go first; the peer lanes read `reviewLaneWaiting`.
const slotPeers: Array<{ inFlight: () => number; pump: () => void }> = [];
export function registerReviewSlotPeer(peer: { inFlight: () => number; pump: () => void }): void {
  slotPeers.push(peer);
}
function pumpPeers(): void {
  for (const p of slotPeers) p.pump();
}
/** Is a shared review slot free right now (PR reviews + ticket reviews in flight)? */
export function reviewSlotFree(): boolean {
  return inFlight() < REVIEW_CONCURRENCY;
}
/** What the PR-review lanes hold that has not started yet. */
export function reviewLaneWaiting(): { manual: boolean; auto: boolean } {
  return { manual: pending.length > 0, auto: autoPending.length > 0 };
}
/**
 * Fill free slots from the PR-review lanes, then from every peer lane (a peer calls this when one of
 * its runs ends, so a slot it frees reaches the OTHER peers too).
 */
export function pumpReviewLane(): void {
  pump();
  pumpPeers();
}
/** May a run mutate process.env for the auth policy? Only at concurrency 1 (see APPLY_AUTH_ENV). */
export const REVIEW_APPLY_AUTH_ENV = APPLY_AUTH_ENV;

// An AUTO PR review just launched: the ticket review's sweeper wants to know, so a PR's tickets are
// checked alongside its first auto review (ticket-review/sweep.ts). Fire-and-forget, never thrown.
let autoLaunchHook: ((ctx: AgentContext, accountId: number, prId: number) => void) | null = null;
export function onAutoReviewLaunched(
  fn: ((ctx: AgentContext, accountId: number, prId: number) => void) | null,
): void {
  autoLaunchHook = fn;
}

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
      reason: 'disabled' | 'already_running' | 'busy' | 'not_found' | 'no_head';
    }
  // An auto review holds this PR (waiting in the auto lane, or running): manual start is locked
  // until it ends. The route answers 409 AutoReviewInProgress.
  | { ok: false; reason: 'auto_in_progress'; auto: AutoReviewHold };

/** Whether an AUTO review holds `prId` for this account right now: waiting in the lane (or mid-start,
 *  no row yet) = 'queued'; launched = 'running'; otherwise null. Account-checked, so another
 *  tenant's PR id answers null. */
export type AutoReviewHold = 'queued' | 'running';
export function autoReviewHold(prId: number, accountId: number): AutoReviewHold | null {
  const run = runningItems.get(prId) ?? startingPair.get(prId);
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
  // The per-run choice (ai/run-choice.ts, validated by the route). Absent ⇒ the default provider.
  provider: AgentProviderId = activeProviderId(),
  // TRAILING: `fresh` ⇒ a from-scratch run (QueueItem.fresh). `pair` ⇒ a CLAUDE + CODEX PAIR: Claude
  // first, then Codex (`provider` is ignored); with only one of them able to review, just that one
  // runs (the route refuses a pair it cannot run). Absent ⇒ an ordinary run.
  opts: { fresh?: boolean; pair?: boolean } = {},
): Promise<StartReviewResult> {
  // ⚠ NO STORIES. A PR review judges code, tests and threads; a story is checked by the ticket
  // review (review/ticket-review/), a separate run with its own row, claim and lane.
  if (!AGENTIC_AI_ENABLED) return { ok: false, reason: 'disabled' };
  const fresh = opts.fresh === true;
  // ⚠ Checked BEFORE `claimed`: a running auto run is also in
  // `claimed`, and must answer the auto lock, not 'already_running'.
  const hold = autoReviewHold(prId, accountId);
  if (hold) return { ok: false, reason: 'auto_in_progress', auto: hold };
  if (claimed.has(prId)) return { ok: false, reason: 'already_running' };
  if (pending.length >= REVIEW_MAX_QUEUED) return { ok: false, reason: 'busy' };
  claimed.add(prId); // reserve synchronously before any await

  // THE PAIR'S PROVIDERS, resolved ONCE (pair.ts): both ⇒ a pair; one ⇒ that one alone.
  let pair: PairState | undefined;
  if (opts.pair) {
    const ready = pairProvidersReady(preflightFor(ctx));
    if (ready.length > 0) provider = ready[0]!;
    if (ready.length === 2) pair = { role: 'first', pairId: 0, secondProvider: ready[1]! };
  }

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
    reviewId = await insertQueuedReview(
      ctx,
      prId,
      prCtx.headSha,
      model,
      accountId,
      [],
      'manual',
      provider,
      fresh,
      pair ? { role: 'first' } : null,
    );
    if (pair) pair.pairId = reviewId;
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
    provider,
    headSha: prCtx.headSha,
    prCtx,
    trigger: 'manual',
    ...(fresh ? { fresh: true } : {}),
    ...(pair ? { pair } : {}),
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
  // TRAILING: a retry of a failed auto run, and/or a reader's press (see AutoItem).
  opts: { retryOfReviewId?: number | null; pressed?: boolean } = {},
): EnqueueAutoResult {
  if (!AGENTIC_AI_ENABLED) return 'disabled';
  if (claimed.has(prId) || autoPending.some((a) => a.prId === prId)) return 'already';
  if (autoPending.length >= REVIEW_AUTO_MAX_QUEUED) return 'full';
  autoPending.push({
    ctx,
    accountId,
    prId,
    workspaceId,
    commentsAtMs,
    ...(opts.retryOfReviewId != null ? { retryOfReviewId: opts.retryOfReviewId } : {}),
    ...(opts.pressed ? { pressed: true } : {}),
  });
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

// A slot opened and the manual queue is empty: write the auto run's row and launch it. Mirrors
// `startReview` step for step (claim → PR context → row → launch), with the
// trigger stamped 'auto'. Any refusal simply drops the item: the PR has no row, so the next tick
// finds it again if it still qualifies.
async function startAutoItem(a: AutoItem): Promise<void> {
  const { ctx, accountId, prId } = a;
  claimed.add(prId);
  let launched = false;
  // A claim posted before the row could be written is released ("free to claim") below.
  let teamClaim: TeamClaimHandle | null = null;
  try {
    // AI went away since the sweep (runtime removed, signed out): drop the item BEFORE its row
    // exists, or the PR's one automatic review is spent on a failure (ai-ready.ts).
    if (!agenticRunReady(ctx, 'review')) return;
    // THE CLAUDE SPEND BUDGET (ai/budget.ts): over it, drop the item before its row exists — the
    // sweeper re-derives it once the budget is under its limit again.
    // A READER'S PRESS is not asked again: they chose it (the SPA's over-budget confirm ran).
    if (!a.pressed && !(await automaticRunAllowed(ctx, accountId, 'auto review'))) return;
    const prCtx = await getReviewPrContext(ctx, prId, accountId);
    if (!prCtx?.headSha) return;
    // ONE RUN PER KEY: a person may have reviewed this head (and, for a comment-triggered
    // re-review, seen those comments) while the item waited. A RETRY goes ahead only while the
    // failed run it retries is still the latest row at this head.
    if (a.retryOfReviewId != null) {
      if (!(await isAutoRetryStillDue(ctx, prId, accountId, prCtx.headSha, a.retryOfReviewId, a.pressed === true))) return;
    } else if (await isAutoReReviewSettled(ctx, prId, accountId, prCtx.headSha, a.commentsAtMs ?? null)) return;
    const model = DEFAULT_CLAUDE_REVIEW_MODEL;
    // An AUTOMATIC run goes to the DEFAULT provider (Settings → AI), read now — unless the workspace
    // asks for Claude + Codex (`auto_review_providers = 'both'`): then a PAIR when both can review,
    // else the one that can.
    let provider: AgentProviderId = activeProviderId();
    let pair: PairState | undefined;
    if ((await readAutoReviewProvidersForPr(ctx, accountId, prId)) === 'both') {
      const ready = pairProvidersReady(preflightFor(ctx));
      if (ready.length > 0) provider = ready[0]!;
      if (ready.length === 2) {
        pair = { role: 'first', pairId: 0, secondProvider: ready[1]!, ...(a.pressed ? { pressed: true } : {}) };
      }
    }
    // TEAM CLAIMS ("Mark auto reviews on GitHub", team-claim.ts): a teammate's Limn already holds
    // this head for this provider ⇒ drop the item with NO row (a skip is not a failure: no retry
    // count, no daily-cap use; the tab shows it from memory). Otherwise claim it. Never throws.
    // A PAIR claims per half, each on its own provider's context: a first half skipped this way is
    // a half that never started, so the second provider runs alone (and claims its own context).
    const headSha = prCtx.headSha;
    const claimFor = (pv: AgentProviderId) =>
      claimBeforeAutoRun(
        ctx,
        { accountId, prId, owner: prCtx.owner, name: prCtx.name, number: prCtx.number, headSha, provider: pv },
        { pressed: a.pressed === true },
      );
    let claim = await claimFor(provider);
    if (claim.kind === 'skip' && pair?.secondProvider) {
      provider = pair.secondProvider;
      pair = undefined;
      claim = await claimFor(provider);
    }
    if (claim.kind === 'skip') return;
    teamClaim = claim.kind === 'run' ? claim.handle : null;
    // No stories: the PR's tickets are checked by the ticket review's own sweep, never here.
    const reviewId = await insertQueuedReview(
      ctx,
      prId,
      prCtx.headSha,
      model,
      accountId,
      [],
      'auto',
      provider,
      false,
      pair ? { role: 'first' } : null,
    );
    if (pair) pair.pairId = reviewId;
    if (teamClaim) await saveTeamClaimRecord(ctx, reviewId, teamClaim.record).catch(() => {});
    reviewIdByPr.set(prId, reviewId);
    startingAuto.delete(prId);
    launched = true;
    launch({
      ctx,
      accountId,
      reviewId,
      prId,
      model,
      provider,
      headSha: prCtx.headSha,
      prCtx,
      trigger: 'auto',
      ...(teamClaim ? { teamClaim } : {}),
      ...(pair ? { pair } : {}),
    });
    try {
      autoLaunchHook?.(ctx, accountId, prId);
    } catch {
      /* the ticket sweep's kick must never break the PR review */
    }
  } catch (err) {
    ctx.log.error(
      { err },
      `auto claude review pr ${prId} could not start: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    if (!launched) {
      if (teamClaim) void finishTeamClaim(ctx, teamClaim, null, { kind: 'unfinished' });
      startingAuto.delete(prId);
      claimed.delete(prId);
      pump();
      pumpPeers();
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
  // TEAM CLAIMS: renew the pending line while the run goes; the final line is posted in `finally`.
  if (item.teamClaim) startTeamClaimRenew(ctx, item.teamClaim);

  void runPipeline(item, controller, emit)
    .then((succeeded) => {
      item.succeeded = succeeded;
      // A pair's FIRST half hands over to its second; everything after a run waits for the pair's end.
      if (pairContinues(item)) return;
      item.autoPosted = runEnded(item, endOf(item, succeeded));
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
      item.succeeded = false;
      // A pair's second half failing this way still ends the pair: the first half's results stand.
      if (item.pair?.role === 'second') item.autoPosted = runEnded(item, endOf(item, false));
    })
    .finally(() => {
      // ⚠ A pair's first half keeps the PR's claim and its slot (`startingPair`, taken BEFORE the
      // pump) until the second half's row is written: nothing slips in between the two.
      const continues = pairContinues(item);
      // TEAM CLAIMS: the run's final line. A pair's first half keeps its line (still renewed) until
      // the pair ends: its count and link come from the pair's ONE post (`finishPairFirstClaim`).
      if (!continues) {
        finishItemClaim(item);
        if (item.pair?.role === 'second') finishPairFirstClaim(item.pair, item.autoPosted);
      }
      runningItems.delete(prId);
      reviewIdByPr.delete(prId);
      controllers.delete(reviewId);
      progressByReview.delete(reviewId);
      if (continues) startingPair.set(prId, item);
      else {
        claimed.delete(prId);
        emitDone(ctx, prId, item.accountId, reviewId);
      }
      pump();
      pumpPeers();
      if (continues) void startPairSecond(item);
    });
}

function emitDone(ctx: AgentContext, prId: number, accountId: number, reviewId: number): void {
  void getLatestClaudeReview(ctx, prId, accountId)
    .then((latest) => emitReviewStream(prId, { type: 'done', status: latest?.status ?? 'failed', reviewId }))
    .catch(() => emitReviewStream(prId, { type: 'done', status: 'failed', reviewId }));
}

/** What a run's end announces: the run the hooks act on, whether it succeeded, and (a pair whose two
 *  halves succeeded) the first half, so auto-posting sends ONE review for both. */
interface RunEnd {
  reviewId: number;
  succeeded: boolean;
  pairFirstReviewId?: number | null;
}

/**
 * The end of an ordinary run, or of a whole pair (called on the second half, or on a first half whose
 * second never started). A pair's end acts on the SECOND half when it succeeded (with the first
 * riding the one post), else on the first when that succeeded.
 */
function endOf(item: QueueItem, succeeded: boolean): RunEnd {
  const p = item.pair;
  if (p?.role !== 'second') return { reviewId: item.reviewId, succeeded };
  if (succeeded) return { reviewId: item.reviewId, succeeded, ...(p.firstSucceeded ? { pairFirstReviewId: p.pairId } : {}) };
  return p.firstSucceeded ? { reviewId: p.pairId, succeeded: true } : { reviewId: item.reviewId, succeeded: false };
}

/** After a run (or a whole pair): the Slack signal, diagrams and the auto hooks — ONCE per pair.
 *  Returns the auto-post it started (null when none), which the team claim's final line waits for. */
function runEnded(item: QueueItem, end: RunEnd): Promise<AutoPostOutcome | null> {
  let autoPosted: Promise<AutoPostOutcome | null> = Promise.resolve(null);
  const { ctx, prId } = item;
  const { reviewId, succeeded } = end;
  // EVENT HOOK (the Slack "Claude Review ran" signal). Announced for every SUCCEEDED run with
  // its trigger; the listener posts for AUTO runs only (platform/slack/signals.ts) — a run the
  // reader started never reaches Slack. Fire-and-forget, never thrown into the review. A pair
  // announces ONCE, at its end.
  if (succeeded) {
    emitClaudeReviewCompleted({
      accountId: item.accountId,
      prId,
      reviewId,
      trigger: item.trigger,
    });
  }
  // SEQUENCE DIAGRAMS (review/diagrams/): every SUCCEEDED run, manual OR auto, may queue the PR's
  // diagram and its stories' — a SEPARATE process in the shared slot pool. Fire-and-forget; the
  // trigger never throws and only queues, so it can neither block nor fail this review.
  if (succeeded) {
    void import('../diagrams/trigger.js')
      .then((m) =>
        m.maybeDrawDiagramsAfterReview(ctx, { accountId: item.accountId, prId, reviewTrigger: item.trigger }),
      )
      .catch((err) =>
        ctx.log.warn(`sequence diagrams pr ${prId}: ${err instanceof Error ? err.message : String(err)}`),
      );
  }
  // AUTO FIX: a SUCCEEDED auto run may start a review-seeded fix on the reader's OWN PR
  // (coding/ai-fix/auto-fix.ts decides; nothing is pushed). Fire-and-forget, never awaited and
  // never thrown into the review: a fix that fails to start costs the fix only.
  if (succeeded && item.trigger === 'auto') {
    // AUTO-POSTING: post the run's findings to GitHub when the workspace switched it on
    // (./auto-post.ts decides; it never throws and never retries). Independent of the fix. A pair
    // whose halves both succeeded posts ONE review for both (`pairFirstReviewId`).
    autoPosted = import('./auto-post.js')
      .then((m) =>
        m.maybeAutoPostReview(ctx, {
          accountId: item.accountId,
          prId,
          reviewId,
          ...(end.pairFirstReviewId != null ? { pairFirstReviewId: end.pairFirstReviewId } : {}),
        }),
      )
      .catch((err) => {
        ctx.log.warn(`auto post pr ${prId}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });
    // The head's SonarCloud issues as ONE PR comment, under the same switch (its own kind).
    void import('../../sonar/post.js')
      .then((m) => m.maybeAutoPostSonar(ctx, { accountId: item.accountId, prId, headSha: item.headSha }))
      .catch((err) =>
        ctx.log.warn(`sonar auto post pr ${prId}: ${err instanceof Error ? err.message : String(err)}`),
      );
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
  return autoPosted;
}

/** TEAM CLAIMS: stop renewing an ended run's line and post its final one (never throws). */
function finishItemClaim(item: QueueItem): void {
  const handle = item.teamClaim;
  if (!handle) return;
  item.teamClaim = undefined;
  stopTeamClaimRenew(handle);
  void finishAutoRunClaim(item.ctx, item, handle, item.succeeded === true, item.autoPosted ?? Promise.resolve(null));
}

/** TEAM CLAIMS, an auto PAIR's end: the first half's line, held since it ended, now gets its final
 *  line from the pair's ONE post. */
function finishPairFirstClaim(pair: PairState, autoPosted: Promise<AutoPostOutcome | null> | undefined): void {
  const first = pair.first;
  if (!first?.teamClaim) return;
  first.autoPosted = autoPosted ?? Promise.resolve(null);
  finishItemClaim(first);
}

/** The team claim's final line for an ended auto run (team-claim.ts steps 4-5). Never throws. A
 *  pair's ONE post holds both halves' findings: each half's line counts only its own. */
async function finishAutoRunClaim(
  ctx: AgentContext,
  item: QueueItem,
  handle: TeamClaimHandle,
  succeeded: boolean,
  autoPosted: Promise<AutoPostOutcome | null>,
): Promise<void> {
  try {
    if (!succeeded) {
      await finishTeamClaim(ctx, handle, item.reviewId, { kind: 'unfinished' });
      return;
    }
    const out = await autoPosted;
    const review = await getClaudeReviewById(ctx, item.reviewId, item.accountId);
    let comments: number | null = null;
    let reviewUrl: string | null = null;
    const posted = out?.kind === 'done' ? new Set(out.record.postedFindingIds) : null;
    const mine = posted && review ? review.findings.filter((f) => posted.has(f.id)).length : 0;
    if (out?.kind === 'done' && mine > 0) {
      comments = mine;
      reviewUrl = postedReviewUrl(item.prCtx.owner, item.prCtx.name, item.prCtx.number, out.record.githubReviewId);
    } else if (review && review.findings.filter((f) => f.severity !== 'praise').length === 0) {
      // Nothing to say at all reads "no comments"; anything kept local reads "kept in Limn".
      comments = 0;
    }
    await finishTeamClaim(ctx, handle, item.reviewId, { kind: 'succeeded', comments, reviewUrl });
  } catch (err) {
    ctx.log.warn(`team claim pr ${item.prId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * THE PAIR'S SECOND HALF, after its first ended (succeeded, failed or stopped): its own row (same
 * head, model depth and trigger; the provider the pair resolved at its start), the first half's
 * findings as its prompt input (only when the first succeeded with findings), then an ordinary
 * launch. An AUTO pair asks the spend budget again first (unless a reader's press queued it). If it
 * cannot start, the pair ends on its first half.
 */
async function startPairSecond(first: QueueItem): Promise<void> {
  const { ctx, accountId, prId } = first;
  const pair = first.pair!;
  const provider = pair.secondProvider!;
  let launched = false;
  let teamClaim: TeamClaimHandle | null = null;
  try {
    if (first.trigger === 'auto' && !pair.pressed && !(await automaticRunAllowed(ctx, accountId, 'auto review (second half)'))) {
      return;
    }
    // TEAM CLAIMS: an AUTO pair's second half claims its OWN provider's context. A teammate's Limn
    // holding it ⇒ this half never starts (no row), and the pair ends on its first half.
    if (first.trigger === 'auto') {
      const claim = await claimBeforeAutoRun(
        ctx,
        {
          accountId,
          prId,
          owner: first.prCtx.owner,
          name: first.prCtx.name,
          number: first.prCtx.number,
          headSha: first.headSha,
          provider,
        },
        { pressed: pair.pressed === true },
      );
      if (claim.kind === 'skip') return;
      teamClaim = claim.kind === 'run' ? claim.handle : null;
    }
    const firstReview = first.succeeded ? await getClaudeReviewById(ctx, first.reviewId, accountId) : null;
    const firstFindings = firstReview?.findings ?? [];
    const reviewId = await insertQueuedReview(
      ctx,
      prId,
      first.headSha,
      first.model,
      accountId,
      [],
      first.trigger,
      provider,
      first.fresh === true,
      { role: 'second', pairId: pair.pairId },
    );
    if (teamClaim) await saveTeamClaimRecord(ctx, reviewId, teamClaim.record).catch(() => {});
    startingPair.delete(prId);
    launched = true;
    launch({
      ctx,
      accountId,
      reviewId,
      prId,
      model: first.model,
      provider,
      headSha: first.headSha,
      prCtx: first.prCtx,
      trigger: first.trigger,
      ...(first.fresh ? { fresh: true } : {}),
      ...(teamClaim ? { teamClaim } : {}),
      pair: {
        role: 'second',
        pairId: pair.pairId,
        first,
        firstSucceeded: first.succeeded === true,
        input: firstFindings.length > 0 ? pairInputOf(first.provider, firstFindings) : null,
        firstFindings: firstFindings.map((f) => ({ path: f.path, line: f.line, title: f.title })),
      },
    });
  } catch (err) {
    ctx.log.error(
      { err },
      `claude review pr ${prId}: the pair's second review could not start: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    if (!launched) {
      // The pair ends on its first half.
      startingPair.delete(prId);
      claimed.delete(prId);
      emitDone(ctx, prId, accountId, first.reviewId);
      first.autoPosted = runEnded(first, { reviewId: first.reviewId, succeeded: first.succeeded === true });
      // TEAM CLAIMS: a claim this half posted before its row could be written is released, and the
      // first half's held line gets its final one.
      if (teamClaim) void finishTeamClaim(ctx, teamClaim, null, { kind: 'unfinished' });
      finishItemClaim(first);
      pump();
      pumpPeers();
    }
  }
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
    // ⚠ A MANUAL run still judges the threads. A skip run reads no code, so it carries no thread
    // block; a person who pressed Review expects the open threads judged, so Check threads (its own
    // process, claim and caps — it judges only what changed and refuses with no model when nothing
    // did) starts in its place. Auto runs are unchanged: their comment bursts already route there.
    if (item.trigger === 'manual' && item.pair?.role !== 'second') {
      void import('./thread-check.js')
        .then((m) => m.startThreadCheckBesideManualReview(ctx, item.accountId, item.prId, item.provider))
        .catch((err) =>
          ctx.log.warn(`thread check beside skip pr ${item.prId}: ${err instanceof Error ? err.message : String(err)}`),
        );
    }
    return true;
  }

  const mode = decision.mode; // 'diff_only' | 'worktree'

  // ---- follow-up on the previous review ----
  // A DB error here throws on purpose: it fails before any model spend and the error shows.
  // Earlier findings SETTLED BY A REPLY (settled-by-reply.ts): an earlier review ACCEPTED a
  // person's reply on the thread. They leave the follow-up, the prompt tells the model not to raise
  // them again, and a new finding repeating one is dropped below. ⚠ A thread merely RESOLVED after a
  // reply is no longer settled on sight: it is judged like an open one (follow-up.ts).
  // ⚠ A FROM-SCRATCH run (`item.fresh`) reads NONE of it: no settled list, no previous review, no
  // carried findings — it reviews as if it were the first run on the PR.
  const fresh = item.fresh === true;
  const settled = fresh ? [] : await loadSettledByReplyFindings(ctx, item.prId, item.accountId, reviewId);
  const settledIds = new Set(settled.map((f) => f.id));
  const prior = fresh
    ? null
    : await loadPriorReviewForFollowUp(ctx, item.prId, item.accountId, reviewId, settledIds, item.provider);
  // BACKWARD COMPATIBILITY: findings the RETIRED settle-on-sight rule took out of the chain were
  // never judged. Load them as carried items; only the ones whose thread is resolved WITH a
  // person's reply are kept (below), so they are judged once like any other.
  const unjudged = prior
    ? await loadUnjudgedReplyFindings(
        ctx,
        item.prId,
        item.accountId,
        reviewId,
        new Set([...settledIds, ...prior.findings.map((f) => f.id)]),
      )
    : [];
  // People's replies on the earlier findings' threads (finding-replies.ts): Claude may accept a
  // reasonable one or push back once. A failure costs the replies only (and the unjudged ones,
  // which need a resolved thread with a reply to be sent at all).
  if (prior && prior.findings.length + unjudged.length > 0) {
    const attached = await attachFindingThreads(ctx, item.accountId, item.prId, [...prior.findings, ...unjudged]);
    const own = new Set(prior.findings.map((f) => f.id));
    prior.findings = [
      ...attached.filter((f) => own.has(f.id)),
      ...attached.filter((f) => !own.has(f.id) && isResolvedWithReplies(f)),
    ];
  }
  const plan: FollowUpPlan | null =
    prior && prior.findings.length > 0 ? selectPriorFindings(prior, item.headSha) : null;
  // "What changed since that review" — ONE compare call (never throws; wrapped anyway), only
  // when the head actually moved. Nothing is stored; a failure (force-push, 404, rate limit)
  // degrades to judging against the full diff.
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

  // ---- what an earlier run already decided (threads; only new commits change them) ----
  // A from-scratch run judges every thread afresh: nothing carries or locks.
  const priorRun = fresh ? null : await loadPriorRunForCarry(ctx, item.prId, item.accountId, reviewId);

  // ---- the OTHER reviewers' open threads (people and review bots; never Limn's own) ----
  // A failure here costs the thread block only, never the review.
  let threadPlan: ThreadPlan | null = null;
  const loadThreads = ctx.queries.loadReviewThreads?.bind(ctx.queries);
  if (loadThreads) {
    try {
      const loaded = await loadThreads(item.accountId, item.prId);
      // The comment half of the auto re-review key: what this run saw (auto.ts).
      await markReviewCommentsSeen(ctx, reviewId, loaded.newestCommentAt);
      // The prior judgements are THE ONE FOLD (the previous review with any later Check threads run
      // over it), so a check's newer judgement carries and locks exactly like a review's.
      // ⚠ Only judgements THIS run's provider made carry or lock: a Codex run after a Claude one
      // (or the reverse) judges every thread afresh, so it never wears the other's verdicts.
      const provider = item.provider;
      const current = fresh
        ? undefined
        : (
            await currentThreadAssessmentsForPrs(ctx, item.accountId, [item.prId], { beforeReviewId: reviewId })
          ).get(item.prId);
      const priorRunSame =
        priorRun && aiRunProvider(priorRun.provider, priorRun.model) === provider ? priorRun.threadAssessments : null;
      threadPlan = planThreadReview(
        loaded.threads,
        item.headSha,
        current ? priorAssessmentsForProvider(current, provider) : priorRunSame,
      );
    } catch (err) {
      ctx.log.warn(
        `claude review pr ${item.prId}: review threads not loaded: ${err instanceof Error ? err.message : String(err)}`,
      );
      threadPlan = null;
    }
  }

  // ⚠ NO CI. Failing checks are explained by the CI review, its own process (review/ci-review/);
  // this run neither reads logs nor stores `ci_failures` (older rows keep theirs as history).

  // ---- other PRs on the same ticket (a DEEP review only; read-only, for cross-repo interactions) ----
  const peers = mode === 'worktree' ? await reviewPeersFor(item) : [];

  // ---- SonarCloud (docs/SONARCLOUD.md § Claude Review): the head's snapshot, read now or reused.
  // Only when the PR's workspace has SonarCloud set up; never throws — a failure is a stored, named
  // state the tab shows, and costs this block only. ----
  const sonarSnap = await ensureSonarSnapshot(ctx, item.accountId, item.prId, item.headSha, {
    log: { warn: (m) => ctx.log.warn(m) },
  });
  // Issues, or a gate that did not pass (its conditions and their files are evidence too).
  const sonar = sonarSnap?.state === 'ok' && sonarHasContent(sonarSnap) ? sonarSnap : null;

  // THE PAIR'S SECOND HALF is shown what the first raised (pair.ts), never the first half.
  const pairInput = item.pair?.role === 'second' ? (item.pair.input ?? null) : null;
  const nonce = pickReviewNonce(untrustedTexts(plan, since, threadPlan, peers, settled, sonar, pairInput));

  // ---- the workspace's reference library (docs/REFERENCE-DOCS.md § Use in reviews) ----
  // Only when its switch is on and something is built; null ⇒ prompt, tools and output unchanged.
  const docs = await reviewDocsForPr(item);

  // A deep review offers the lead its specialist sub-agents (specialists.ts); a diff-only one none.
  const specialists = mode === 'worktree' ? offeredSpecialists(prep.changedFiles) : [];
  const systemPrompt = systemPromptForMode(mode, specialists, docs?.dir ?? null);
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
    followUp: plan ? { plan, since } : null,
    threads: threadPlan,
    peers,
    settled,
    sonar,
    ...(pairInput != null ? { pair: pairInput } : {}),
    nonce,
  });

  const res = await ctx.review.runReview({
    owner: prCtx.owner,
    name: prCtx.name,
    prNumber: prCtx.number,
    headSha: item.headSha,
    model,
    // The job's provider (QueueItem.provider), so the run, its prompts' words and its label agree.
    provider: item.provider,
    mode,
    systemPrompt,
    prompt,
    strippedDiff: prep.strippedDiff,
    specialists,
    peers: peers.map(runPeerOf),
    ...(docs != null ? { docsDir: docs.dir } : {}),
    // Who to bill when the provider writes its own ledger row (Codex), and — for an AUTOMATIC review
    // on Codex, where Limn runs each specialist as its own run — the spend budget asked before each.
    usage: { accountId: item.accountId, prId: item.prId },
    ...(item.trigger === 'auto'
      ? { allowSpecialistStart: () => automaticRunAllowed(ctx, item.accountId, 'auto review specialist') }
      : {}),
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
  // What ran (provider + model id), whatever the outcome — before the row's status moves.
  if (res.ranOn) await markReviewRanOn(ctx, reviewId, res.ranOn);
  // What it read beside the PR (ticket peers, related repos) — the "Also read" line.
  const alsoRead = peersReadOf(peers, res.peersCheckedOut);
  if (alsoRead.length > 0) await markReviewPeersRead(ctx, reviewId, alsoRead);
  const telemetry = {
    costUsd: res.costUsd,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
    cacheReadTokens: res.cacheReadTokens,
    cacheCreationTokens: res.cacheCreationTokens,
    numTurns: res.numTurns,
    diffBytes: prep.diffBytes,
    diffCapped: prep.diffCapped,
    ...(res.usageRecorded ? { usageRecorded: true } : {}),
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
    // Server-side validation of the model's follow-up report: each ref once, unknown refs
    // dropped, anything unreported 'not_checked' — never an invented 'addressed'.
    const items = plan ? reconcileFollowUp(plan, res.followUp) : null;
    const linked =
      plan && items
        ? linkReraisedFindings(plan, items, res.findings, new Set(prep.changedFiles))
        : res.findings.map((f) => ({ ...f, priorFindingId: null }));
    // ⚠ ENFORCED IN CODE, not only asked of the model: a new finding repeating a settled one (same
    // path, similar title) is dropped. A finding linked to a still-open earlier one is kept.
    // …and a finding repeating one whose reply THIS run accepted (follow-up.ts).
    const { kept: notAccepted, dropped: droppedAccepted } = items
      ? dropAcceptedReraises(linked, items, similarTitles)
      : { kept: linked, dropped: [] };
    const { kept: notSettled, dropped: droppedSettled } = dropSettledReraises(notAccepted, settled);
    // ⚠ THE PAIR'S CODE DEDUPE (pair.ts): a second-half finding repeating one the first half raised
    // is dropped, whatever the prompt asked; the count is stored on this run (`pair_dropped`).
    const pairFirst = item.pair?.role === 'second' ? (item.pair.firstFindings ?? []) : null;
    const { kept: findings, dropped: droppedPair } = pairFirst
      ? dropPairRepeats(notSettled, pairFirst)
      : { kept: notSettled, dropped: [] };
    if (droppedPair.length > 0) {
      ctx.log.info(`claude review pr ${item.prId}: dropped ${droppedPair.length} finding(s) the pair's first review raised`);
    }
    const dropped = [...droppedAccepted, ...droppedSettled];
    if (dropped.length > 0) {
      ctx.log.info(
        `claude review pr ${item.prId}: dropped ${dropped.length} finding(s) repeating a comment settled by a reply`,
      );
    }
    const threadAssessments = threadPlan ? reconcileThreads(threadPlan, res.threads) : null;
    // The library passages + each finding's citations, CHECKED against the library (a bad link or a
    // quote not in its section is dropped). A docs run with nothing usable stores [] — "looked, found
    // nothing" — and a run without the library stores NULL.
    const checked = docs != null ? await checkReviewDocs(ctx, item, docs.workspaceId, res, findings) : null;
    await saveReviewSuccess(ctx, reviewId, {
      scope: res.scope,
      summary: res.summary,
      verdict: res.verdict,
      ...telemetry,
      excludedFiles: prep.excludedFiles,
      findings: checked != null ? checked.findings : findings,
      ...(checked != null ? { docReferences: checked.references } : {}),
      followUp:
        plan && items
          ? {
              priorReviewId: plan.priorReviewId,
              priorHeadSha: plan.priorHeadSha,
              headMoved: plan.headMoved,
              changesSinceShown: !!since?.ok && since.files.length > 0,
              items,
              // The previous review's own findings NOT followed up, each named with why.
              ...(prior?.leftOut && prior.leftOut.length > 0 ? { leftOut: prior.leftOut } : {}),
            }
          : null,
      threadAssessments,
      ...(pairFirst ? { pairDropped: droppedPair.length } : {}),
    });
    return true;
  }
  return false;
}

/**
 * The PR's workspace library for this run, or null (switch off, nothing built, no workspace, any
 * error — the library is optional context and never fails a review).
 */
async function reviewDocsForPr(
  item: Pick<QueueItem, 'ctx' | 'accountId' | 'prId'>,
): Promise<{ dir: string; workspaceId: number } | null> {
  try {
    const { workspaceOfPr } = await import('../ticket-review/prepare.js');
    const workspaceId = await workspaceOfPr(item.ctx, item.accountId, item.prId);
    if (workspaceId == null) return null;
    const { reviewDocsFor } = await import('../../reference-docs/context.js');
    const docs = await reviewDocsFor(item.accountId, workspaceId);
    return docs != null ? { dir: docs.dir, workspaceId } : null;
  } catch (err) {
    item.ctx.log.warn(
      `claude review pr ${item.prId}: reference docs not read: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** Check a docs run's references and each finding's `docRefs` against the library (review-refs.ts). */
async function checkReviewDocs<F extends { docRefs?: unknown }>(
  ctx: AgentContext,
  item: Pick<QueueItem, 'accountId' | 'prId'>,
  workspaceId: number,
  res: Pick<RunReviewResult, 'docReferences'>,
  findings: F[],
): Promise<{ references: ReviewDocReference[]; findings: Array<F & { docCitations: ReferenceDocCitation[] }> }> {
  try {
    const [{ loadLibrarySnapshot }, { validateDocReferences, validateDocCitations }] = await Promise.all([
      import('../../reference-docs/context.js'),
      import('../../reference-docs/review-refs.js'),
    ]);
    const lib = await loadLibrarySnapshot(item.accountId, workspaceId);
    const { references, dropped } = validateDocReferences(res.docReferences, lib);
    if (dropped > 0) ctx.log.info(`claude review pr ${item.prId}: dropped ${dropped} reference(s) that did not check out`);
    return {
      references,
      findings: findings.map((f) => ({ ...f, docCitations: validateDocCitations(f.docRefs, lib) })),
    };
  } catch (err) {
    ctx.log.warn(`claude review pr ${item.prId}: references not checked: ${err instanceof Error ? err.message : String(err)}`);
    return { references: [], findings: findings.map((f) => ({ ...f, docCitations: [] })) };
  }
}

/** A peer ready for the prompt (`PromptPeer`) and for its checkout. `headSha` is a PR's head; null
 *  for a branch peer (checked out at the branch's tip). */
export type ReviewPeer = PromptPeer & { owner: string; name: string; headSha: string | null };

/** The peer as the run checks it out (RunReviewArgs.peers). */
export function runPeerOf(p: ReviewPeer): ReviewRunPeer {
  const kind = p.kind ?? 'pr';
  if (kind === 'pr') return { ref: p.ref, owner: p.owner, name: p.name, prNumber: p.number ?? 0, headSha: p.headSha ?? '' };
  return { ref: p.ref, owner: p.owner, name: p.name, kind, branch: p.branch ?? null };
}

/** What a run read, for `claude_reviews.peers_read`: the peers whose refs were checked out. */
export function peersReadOf(peers: readonly ReviewPeer[], checkedOut: readonly string[] | undefined): ReviewPeerRead[] {
  const ok = new Set(checkedOut ?? []);
  return peers
    .filter((p) => ok.has(p.ref))
    .map((p) => {
      const kind = p.kind ?? 'pr';
      return {
        repoFullName: p.repoFullName,
        kind,
        source: p.source ?? 'ticket',
        number: kind === 'pr' ? p.number : null,
        branch: p.branch ?? null,
      };
    });
}

/**
 * EVERY peer of a deep review, refs assigned in prompt order, at most
 * TICKET_REVIEW_PEER_MAX_FOR_PR_REVIEW (one shared cap):
 *   1. each RELATED REPO's matching change — its PR on the same branch or ticket, or its same-named
 *      branch (related-repos.ts; the reader asked for exactly these, so they lead) — and, beside them,
 *      a ticket peer that sits IN a related repo: that PR IS the repo's companion change, so the repo
 *      is skipped by the related walk and its ticket peer moves up into this leading group;
 *   2. the OTHER PRs on this PR's tickets (`ticketPeersFor`), as before;
 *   3. a related repo's DEFAULT BRANCH, plain reference, only where nothing matched.
 * ⚠ Without the move in 1, a related repo's ticket peer could be cut by the cap AFTER the related walk
 * had already skipped that repo, so the review read nothing at all from it. The walk is told the cap
 * (`maxPeers`), so it spends no GitHub read on a change the cap would drop. Never throws. Exported for
 * tests.
 */
export async function reviewPeersFor(
  item: Pick<QueueItem, 'ctx' | 'accountId' | 'prId'>,
): Promise<ReviewPeer[]> {
  const { ctx, accountId, prId } = item;
  const ticket = await ticketPeersFor(item);
  const repoKey = (p: { owner: string; name: string }): string => `${p.owner}/${p.name}`.toLowerCase();
  const { peers: related, coveredRepoKeys } = await relatedRepoCompanions(ctx, accountId, prId, {
    skipRepoKeys: new Set(ticket.map(repoKey)),
    maxPeers: TICKET_REVIEW_PEER_MAX_FOR_PR_REVIEW,
  });
  const covered = new Set(coveredRepoKeys);
  const leadTicket = ticket.filter((p) => covered.has(repoKey(p)));
  const otherTicket = ticket.filter((p) => !covered.has(repoKey(p)));
  const asPeer = (r: (typeof related)[number]): Omit<ReviewPeer, 'ref'> =>
    r.pr
      ? {
          kind: 'pr',
          source: 'related_repo',
          match: r.match === 'same_branch' ? 'same_branch' : 'same_ticket',
          branch: r.branch,
          repoFullName: r.repoFullName,
          number: r.pr.number,
          title: r.pr.title,
          state: 'open',
          ticketKeys: r.ticketKeys,
          files: r.pr.files,
          owner: r.owner,
          name: r.name,
          headSha: r.pr.headSha,
        }
      : {
          kind: r.match === 'branch' ? 'branch' : 'default_branch',
          source: 'related_repo',
          match: null,
          branch: r.branch,
          repoFullName: r.repoFullName,
          number: null,
          title: '',
          state: null,
          ticketKeys: [],
          files: [],
          owner: r.owner,
          name: r.name,
          headSha: null,
        };
  const changes = related.filter((r) => r.match !== 'default_branch').map(asPeer);
  const references = related.filter((r) => r.match === 'default_branch').map(asPeer);
  return [...changes, ...leadTicket, ...otherTicket, ...references]
    .slice(0, TICKET_REVIEW_PEER_MAX_FOR_PR_REVIEW)
    .map((p, i) => ({ ...p, ref: peerRef(i) }));
}

/**
 * The OTHER PRs on this PR's tickets, for a deep review's "Related PRs" block — via the optional
 * Pro seam (`ticketsForPr` + `ticketMembers`; absent ⇒ none). Account-scoped and open-or-merged
 * (`getReviewPeerContexts`); members may sit in another workspace on the same Jira site. Ranked
 * open first, then the most tickets shared, then the newest; at most
 * TICKET_REVIEW_PEER_MAX_FOR_PR_REVIEW. Never throws: peer context is optional, so a failure costs
 * the block only. Refs are assigned by `reviewPeersFor`.
 */
async function ticketPeersFor(
  item: Pick<QueueItem, 'ctx' | 'accountId' | 'prId'>,
): Promise<Array<Omit<ReviewPeer, 'ref'>>> {
  const { ctx, accountId, prId } = item;
  const { ticketsForPr, ticketMembers } = getTicketSource();
  try {
    const tickets = (await ticketsForPr(accountId, prId)).slice(0, CLAUDE_REVIEW_MAX_TICKETS);
    const keysByPr = new Map<number, string[]>();
    for (const t of tickets) {
      const members = await ticketMembers(accountId, t.ident);
      const key = t.ticket.key?.trim() || null;
      for (const m of members) {
        if (m.prId === prId) continue;
        const keys = keysByPr.get(m.prId) ?? [];
        if (key && !keys.includes(key)) keys.push(key);
        keysByPr.set(m.prId, keys);
      }
    }
    if (keysByPr.size === 0) return [];
    const ctxs = await getReviewPeerContexts(ctx, accountId, [...keysByPr.keys()]);
    const shared = (id: number): number => keysByPr.get(id)?.length ?? 0;
    ctxs.sort(
      (a, b) =>
        Number(b.state === 'open') - Number(a.state === 'open') ||
        shared(b.prId) - shared(a.prId) ||
        b.prId - a.prId,
    );
    return ctxs.slice(0, TICKET_REVIEW_PEER_MAX_FOR_PR_REVIEW).map((p) => ({
      repoFullName: p.repoFullName,
      number: p.number,
      title: p.title,
      state: p.state,
      ticketKeys: keysByPr.get(p.prId) ?? [],
      files: p.files,
      owner: p.owner,
      name: p.name,
      headSha: p.headSha,
    }));
  } catch (err) {
    ctx.log.warn(
      `claude review pr ${prId}: related PRs not read: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
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
      ...(runningItem.pair ? { pair: { role: runningItem.pair.role, provider: runningItem.provider } } : {}),
    };
  }
  // A pair between its halves: still running (the second half's row is being written).
  const between = startingPair.get(prId);
  if (between?.accountId === accountId) {
    return {
      status: 'running',
      reviewId: between.reviewId,
      progress: null,
      trigger: between.trigger,
      ...(between.pair?.secondProvider ? { pair: { role: 'second' as const, provider: between.pair.secondProvider } } : {}),
    };
  }
  const queued = pending.find((p) => p.prId === prId && p.accountId === accountId);
  if (queued) {
    return {
      status: 'queued',
      reviewId: queued.reviewId,
      progress: null,
      trigger: 'manual',
      ...(queued.pair ? { pair: { role: queued.pair.role, provider: queued.provider } } : {}),
    };
  }
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
