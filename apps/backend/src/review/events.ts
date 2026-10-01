import type { ClaudeReviewVerdict } from '@pierre-review/shared';

// A tiny typed in-process event bus. Claude Review's routes emit on it; review memory's capture
// (review/memory/capture.ts, subscribed once at boot by `startAgenticBackground`) turns each event
// into a review_learnings row. Both are core since apiVersion 22.
//
// Events carry IDENTITY + DELTA only — no repoId/path enrichment. A subscriber
// enriches by reading core tables via ctx.db (scoped by the event's accountId).

export type Verdict = ClaudeReviewVerdict;

export type ReviewEvent =
  | {
      type: 'finding.updated';
      accountId: number;
      findingId: number;
      change: { included?: boolean; editedBody?: string | null };
    }
  | {
      type: 'finding.posted';
      accountId: number;
      findingId: number;
      postedCommentKind: 'inline' | 'pr_comment';
    }
  | {
      type: 'review.draftUpdated';
      accountId: number;
      reviewId: number;
      change: { userBody?: string; userVerdict?: ClaudeReviewVerdict };
    }
  | {
      type: 'review.posted';
      accountId: number;
      reviewId: number;
      userVerdict: ClaudeReviewVerdict;
      inlineFindingIds: number[];
      prCommentFindingIds: number[];
    }
  | {
      type: 'review.requested';
      accountId: number;
      prId: number;
      model: string;
      requestedMode: string;
    };

export interface ReviewEventBus {
  on(listener: (e: ReviewEvent) => void): () => void;
  emit(e: ReviewEvent): void;
}

const listeners = new Set<(e: ReviewEvent) => void>();

export const reviewEvents: ReviewEventBus = {
  on(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  emit(e) {
    // A subscriber error must NEVER break the review route that emitted, so each
    // call is isolated; we deliberately swallow (log nothing) rather than throw.
    for (const listener of listeners) {
      try {
        listener(e);
      } catch {
        /* a subscriber failure must not surface to the emitter */
      }
    }
  },
};

// (The learnings-provider registry that lived here is gone: Claude Review's memory is core since
// apiVersion 22, so the manager calls review/memory/retrieval.ts `buildLearningsContext` directly.)
