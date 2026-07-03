import type {
  ActiveReview,
  ClaudeReviewModel,
  ClaudeReviewProgress,
  ClaudeReviewStatusResponse,
  ClaudeReviewStreamEvent,
  RequestedReviewMode,
} from '@pierre-review/shared';
import type { Logger } from '../sync/sync-repo.js';
import { config } from '../config.js';
import { LOCAL_ACCOUNT_ID } from '../auth/account.js';
import { getLatestClaudeReview, getReviewPrContext } from '../db/queries.js';
import { getLearningsProvider } from './events.js';
import { runReview } from './agent.js';
import {
  insertQueuedReview,
  markReviewCancelled,
  reconcileOrphanedReviews,
} from './persist.js';

type PrCtx = NonNullable<Awaited<ReturnType<typeof getReviewPrContext>>>;

interface QueueItem {
  reviewId: number;
  prId: number;
  model: ClaudeReviewModel;
  requestedMode: RequestedReviewMode;
  headSha: string;
  ctx: PrCtx;
  log: Logger;
  // Optional learnings context from a registered @pierre/pro provider; undefined
  // in OSS mode (no provider) ⇒ the review prompt is byte-identical to today.
  priorReviewContext?: string;
}

// In-memory state (analogous to sync/sync-manager.ts). At most one review per PR.
// `config.reviewConcurrency` bounds concurrent RUNNING reviews; extras wait in a
// FIFO `pending` queue and launch as slots free (so the user can bulk-trigger).
const running = new Set<number>(); // prIds with a review actively running
const pending: QueueItem[] = []; // FIFO of queued reviews waiting for a slot
const claimed = new Set<number>(); // prIds either running OR pending — the sync guard
const reviewIdByPr = new Map<number, number>();
const progressByReview = new Map<number, ClaudeReviewProgress>();
const controllers = new Map<number, AbortController>();

// SSE fan-out (keyed by prId): the live-progress stream endpoint subscribes here,
// so each phase/activity/usage change is PUSHED to connected clients in real time
// instead of being polled. Empty in the common case (no open stream). See
// subscribeReviewStream + GET /api/prs/:id/claude-review/stream.
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

// Subscribe to a PR's live review stream. Returns an unsubscribe fn. The manager
// emits 'progress' events across the queued→running lifecycle and one terminal
// 'done' (with the persisted final status) when the run settles.
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
    };

export async function startReview(
  prId: number,
  model: ClaudeReviewModel,
  requestedMode: RequestedReviewMode,
  log: Logger,
): Promise<StartReviewResult> {
  if (!config.claudeReviewEnabled) return { ok: false, reason: 'disabled' };
  // `claimed` covers BOTH running and queued, so a re-trigger of an in-flight or
  // already-queued PR is rejected without a TOCTOU double-start.
  if (claimed.has(prId)) return { ok: false, reason: 'already_running' };
  // Runaway guard for bulk triggering: cap the queue depth.
  if (pending.length >= config.reviewMaxQueued) return { ok: false, reason: 'busy' };
  // Reserve SYNCHRONOUSLY before any await; roll back on early-bail / insert failure.
  claimed.add(prId);

  let reviewId: number;
  let ctx: PrCtx | null;
  try {
    ctx = await getReviewPrContext(prId, LOCAL_ACCOUNT_ID);
    if (!ctx) {
      claimed.delete(prId);
      return { ok: false, reason: 'not_found' };
    }
    if (!ctx.headSha) {
      claimed.delete(prId);
      return { ok: false, reason: 'no_head' };
    }
    reviewId = await insertQueuedReview(prId, ctx.headSha, model, LOCAL_ACCOUNT_ID);
  } catch (err) {
    claimed.delete(prId);
    throw err;
  }

  // Optional injection seam: a registered @pierre/pro learnings provider renders a
  // "reviewer preferences" block for this PR. Optional-chaining short-circuits to
  // undefined when no provider is registered (OSS mode) WITHOUT calling .catch, so
  // the run is unchanged; a provider error degrades to undefined too.
  const priorReviewContext = await getLearningsProvider()
    ?.buildContext({ accountId: LOCAL_ACCOUNT_ID, prId, headSha: ctx.headSha })
    .catch(() => undefined);

  const item: QueueItem = {
    reviewId,
    prId,
    model,
    requestedMode,
    headSha: ctx.headSha,
    ctx,
    log,
    priorReviewContext,
  };
  reviewIdByPr.set(prId, reviewId);
  if (running.size < config.reviewConcurrency) {
    launch(item);
    return { ok: true, reviewId, queued: false };
  }
  // No slot — leave it queued (the row's persisted status is already 'queued'); it
  // launches from pump() when a running review finishes.
  pending.push(item);
  return { ok: true, reviewId, queued: true };
}

function launch(item: QueueItem): void {
  const { reviewId, prId, ctx } = item;
  running.add(prId);
  reviewIdByPr.set(prId, reviewId);
  const controller = new AbortController();
  controllers.set(reviewId, controller);
  // The diff is fetched (and the mode decided) before any clone, so the first real
  // phase is always 'fetching_diff' — not 'cloning' (which a diff-only run skips).
  const initial: ClaudeReviewProgress = { phase: 'fetching_diff' };
  progressByReview.set(reviewId, initial);
  emitReviewStream(prId, {
    type: 'progress',
    status: 'running',
    reviewId,
    progress: initial,
  });

  void runReview({
    reviewId,
    prId,
    owner: ctx.owner,
    name: ctx.name,
    repoFullName: ctx.repoFullName,
    prNumber: ctx.number,
    title: ctx.title,
    body: ctx.body,
    baseRefName: ctx.baseRefName,
    headSha: item.headSha,
    model: item.model,
    requestedMode: item.requestedMode,
    priorReviewContext: item.priorReviewContext,
    abortController: controller,
    onProgress: (p) => {
      progressByReview.set(reviewId, p);
      emitReviewStream(prId, {
        type: 'progress',
        status: 'running',
        reviewId,
        progress: p,
      });
    },
  })
    .catch((err) => {
      item.log.error(
        `claude review pr ${prId} failed: ${err instanceof Error ? err.message : err}`,
      );
    })
    .finally(() => {
      running.delete(prId);
      reviewIdByPr.delete(prId);
      controllers.delete(reviewId);
      progressByReview.delete(reviewId);
      claimed.delete(prId);
      // Push a terminal event to any open stream with the PERSISTED final status
      // (succeeded / failed / cancelled), then start the next queued review.
      void getLatestClaudeReview(prId, LOCAL_ACCOUNT_ID)
        .then((latest) =>
          emitReviewStream(prId, {
            type: 'done',
            status: latest?.status ?? 'failed',
            reviewId,
          }),
        )
        .catch(() =>
          emitReviewStream(prId, { type: 'done', status: 'failed', reviewId }),
        );
      pump(); // a slot freed — start the next queued review
    });
}

// Start as many queued reviews as there are free slots (FIFO).
function pump(): void {
  while (running.size < config.reviewConcurrency && pending.length > 0) {
    launch(pending.shift()!);
  }
}

export function isReviewRunning(prId: number): boolean {
  return running.has(prId);
}

export function requestReviewCancel(prId: number): boolean {
  // Running → abort the SDK run (runReview's finally cleans up + pumps the queue).
  const reviewId = reviewIdByPr.get(prId);
  if (running.has(prId) && reviewId != null) {
    controllers.get(reviewId)?.abort();
    return true;
  }
  // Queued (not yet started) → drop it from the queue and mark the row cancelled.
  const idx = pending.findIndex((p) => p.prId === prId);
  if (idx >= 0) {
    const item = pending.splice(idx, 1)[0]!;
    claimed.delete(prId);
    reviewIdByPr.delete(prId);
    void markReviewCancelled(item.reviewId).catch(() => {});
    return true;
  }
  return false;
}

// Live status when a review is in flight; otherwise the latest persisted run's
// status (or 'idle' if the PR was never reviewed).
export async function getReviewStatus(
  prId: number,
): Promise<ClaudeReviewStatusResponse> {
  const reviewId = reviewIdByPr.get(prId);
  if (reviewId != null && running.has(prId)) {
    return {
      status: 'running',
      reviewId,
      progress: progressByReview.get(reviewId) ?? null,
    };
  }
  const queued = pending.find((p) => p.prId === prId);
  if (queued) return { status: 'queued', reviewId: queued.reviewId, progress: null };
  const latest = await getLatestClaudeReview(prId, LOCAL_ACCOUNT_ID);
  if (!latest) return { status: 'idle', reviewId: null, progress: null };
  return { status: latest.status, reviewId: latest.id, progress: null };
}

// All reviews currently in flight OR queued (for the global progress banner),
// joined with their PR coordinates.
export async function listActiveReviews(): Promise<ActiveReview[]> {
  const out: ActiveReview[] = [];
  for (const prId of running) {
    const reviewId = reviewIdByPr.get(prId);
    if (reviewId == null) continue;
    const ctx = await getReviewPrContext(prId, LOCAL_ACCOUNT_ID);
    if (!ctx) continue;
    out.push({
      reviewId,
      prId,
      repoFullName: ctx.repoFullName,
      prNumber: ctx.number,
      prTitle: ctx.title,
      status: 'running',
      phase: progressByReview.get(reviewId)?.phase ?? null,
    });
  }
  // Queued items use their stored ctx (no extra fetch); the banner shows them too.
  for (const item of pending) {
    out.push({
      reviewId: item.reviewId,
      prId: item.prId,
      repoFullName: item.ctx.repoFullName,
      prNumber: item.ctx.number,
      prTitle: item.ctx.title,
      status: 'queued',
      phase: null,
    });
  }
  return out;
}

// Heal runs left 'running'/'queued' by a crash (our status is persisted).
export async function reconcileReviewsOnStartup(log: Logger): Promise<void> {
  const n = await reconcileOrphanedReviews();
  if (n > 0) log.info(`reconciled ${n} orphaned claude review(s) -> failed`);
}
