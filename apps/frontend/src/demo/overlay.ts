// THE WRITE OVERLAY — what the reader changed in this demo session, kept in memory only.
// A reload starts from the recording again. Each write in ./routes.ts records its effect here,
// and the GET patches in ./routes.ts fold it back into the recorded answers.

import type { ArmedMergeRequest, CommentDetail, PrCommentDetail, ReviewDetail } from '@pierre-review/shared';

export interface ThreadPatch {
  isResolved?: boolean;
  derivedState?: string;
  addedComments: CommentDetail[];
}

export class DemoOverlay {
  /** Bodies stored by a settings write, served back by a GET of the same pathname. */
  readonly stored = new Map<string, unknown>();
  /** Field patches over a PR (`PrDetail`, and the matching rows of the PR lists). */
  readonly prFields = new Map<number, Record<string, unknown>>();
  readonly threads = new Map<number, ThreadPatch>();
  readonly addedReviews = new Map<number, ReviewDetail[]>();
  readonly addedComments = new Map<number, PrCommentDetail[]>();
  /** Auto-merge intents armed here, by PR id. A disarmed PR id maps to null. */
  readonly armed = new Map<number, ArmedMergeRequest | null>();
  /** PR ids the reader dismissed from My Turn (`kind:id`). */
  readonly dismissed = new Set<string>();
  /** Chat turns added here, keyed by conversation (`review:<id>:<findingId|general>`). */
  readonly chats = new Map<string, unknown[]>();
  /** Ticket statuses the reader set from the story view's picker, by ticket ident. */
  readonly ticketStatuses = new Map<string, { name: string; category: string | null }>();

  patchPr(prId: number, fields: Record<string, unknown>): void {
    this.prFields.set(prId, { ...(this.prFields.get(prId) ?? {}), ...fields });
  }

  thread(threadId: number): ThreadPatch {
    let t = this.threads.get(threadId);
    if (!t) {
      t = { addedComments: [] };
      this.threads.set(threadId, t);
    }
    return t;
  }

  addReview(prId: number, review: ReviewDetail): void {
    this.addedReviews.set(prId, [...(this.addedReviews.get(prId) ?? []), review]);
  }

  addComment(prId: number, comment: PrCommentDetail): void {
    this.addedComments.set(prId, [...(this.addedComments.get(prId) ?? []), comment]);
  }

  /** PR ids that left the open set here (merged or closed). */
  closedPrIds(): Set<number> {
    const out = new Set<number>();
    for (const [id, f] of this.prFields) if (f.state === 'merged' || f.state === 'closed') out.add(id);
    return out;
  }
}
