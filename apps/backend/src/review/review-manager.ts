import type {
  ActiveReview,
  ClaudeReviewModel,
  ClaudeReviewProgress,
  ClaudeReviewStatusResponse,
} from '@pierre-review/shared';
import type { Logger } from '../sync/sync-repo.js';
import { config } from '../config.js';
import { getLatestClaudeReview, getReviewPrContext } from '../db/queries.js';
import { runReview } from './agent.js';
import { insertQueuedReview, reconcileOrphanedReviews } from './persist.js';

// In-memory state (analogous to sync/sync-manager.ts). At most one review per PR;
// a global gate (config.reviewConcurrency) bounds concurrent reviews overall.
const running = new Set<number>(); // prIds with a review in flight
const reviewIdByPr = new Map<number, number>();
const progressByReview = new Map<number, ClaudeReviewProgress>();
const controllers = new Map<number, AbortController>();

export type StartReviewResult =
  | { ok: true; reviewId: number }
  | {
      ok: false;
      reason: 'disabled' | 'already_running' | 'busy' | 'not_found' | 'no_head';
    };

export function startReview(
  prId: number,
  model: ClaudeReviewModel,
  log: Logger,
): StartReviewResult {
  if (!config.claudeReviewEnabled) return { ok: false, reason: 'disabled' };
  if (running.has(prId)) return { ok: false, reason: 'already_running' };
  if (running.size >= config.reviewConcurrency) {
    return { ok: false, reason: 'busy' };
  }
  const ctx = getReviewPrContext(prId);
  if (!ctx) return { ok: false, reason: 'not_found' };
  if (!ctx.headSha) return { ok: false, reason: 'no_head' };
  const headSha = ctx.headSha;

  const reviewId = insertQueuedReview(prId, headSha, model);
  running.add(prId);
  reviewIdByPr.set(prId, reviewId);
  const controller = new AbortController();
  controllers.set(reviewId, controller);
  progressByReview.set(reviewId, { phase: 'cloning' });

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
    headSha,
    model,
    abortController: controller,
    onProgress: (p) => progressByReview.set(reviewId, p),
  })
    .catch((err) => {
      log.error(
        `claude review pr ${prId} failed: ${
          err instanceof Error ? err.message : err
        }`,
      );
    })
    .finally(() => {
      running.delete(prId);
      reviewIdByPr.delete(prId);
      controllers.delete(reviewId);
      progressByReview.delete(reviewId);
    });

  return { ok: true, reviewId };
}

export function isReviewRunning(prId: number): boolean {
  return running.has(prId);
}

export function requestReviewCancel(prId: number): boolean {
  const reviewId = reviewIdByPr.get(prId);
  if (reviewId == null) return false;
  controllers.get(reviewId)?.abort();
  return true;
}

// Live status when a review is in flight; otherwise the latest persisted run's
// status (or 'idle' if the PR was never reviewed).
export function getReviewStatus(prId: number): ClaudeReviewStatusResponse {
  const reviewId = reviewIdByPr.get(prId);
  if (reviewId != null && running.has(prId)) {
    return {
      status: 'running',
      reviewId,
      progress: progressByReview.get(reviewId) ?? null,
    };
  }
  const latest = getLatestClaudeReview(prId);
  if (!latest) return { status: 'idle', reviewId: null, progress: null };
  return { status: latest.status, reviewId: latest.id, progress: null };
}

// All reviews currently in flight (for the global progress banner), joined with
// their PR coordinates.
export function listActiveReviews(): ActiveReview[] {
  const out: ActiveReview[] = [];
  for (const prId of running) {
    const reviewId = reviewIdByPr.get(prId);
    if (reviewId == null) continue;
    const ctx = getReviewPrContext(prId);
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
  return out;
}

// Heal runs left 'running'/'queued' by a crash (our status is persisted).
export function reconcileReviewsOnStartup(log: Logger): void {
  const n = reconcileOrphanedReviews();
  if (n > 0) log.info(`reconciled ${n} orphaned claude review(s) -> failed`);
}
