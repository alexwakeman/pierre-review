// MY TURN → "NEW AI REVIEWS BY YOUR LIMN": THE ONE SEEN WRITER (docs/BACKEND.md § My Turn).
//
// The reader had a finished run of their own Limn on screen in the PR's AI Review tab
// (`POST /api/prs/:id/claude-review/seen`, sent by the tab once per run while `seenAt` is null). The
// run — and, for a Claude + Codex pair, every half — is stamped only where `seen_at` is still NULL,
// so a repeat is a no-op and the stamp never moves. A stamped run is no longer a `claude_review` My
// Turn card (`getUnseenOwnAiReviews`). ⚠ This module opens NO database at import (it takes an
// executor): the review routes import it.
import { and, eq, isNull } from 'drizzle-orm';
import type { Executor } from './client.js';
import * as schema from './schema.sqlite.js';

const cr = schema.claudeReviews;

/**
 * Stamp one finished own run (and its pair) seen. Account- and PR-scoped. Returns how many rows it
 * stamped: 0 for a run that is not the account's, not this PR's, not a full review, not finished, or
 * already seen — the route answers 404 only for the first three (`null`).
 */
export async function markClaudeReviewSeen(
  exec: Executor,
  accountId: number,
  prId: number,
  reviewId: number,
  now: Date = new Date(),
): Promise<number | null> {
  const run = (
    await exec
      .select({ id: cr.id, pairId: cr.pairId, status: cr.status })
      .from(cr)
      .where(and(eq(cr.id, reviewId), eq(cr.accountId, accountId), eq(cr.prId, prId), isNull(cr.kind)))
      .limit(1)
      .execute()
  )[0];
  if (run == null) return null;
  if (run.status !== 'succeeded') return 0;
  const stamped = await exec
    .update(cr)
    .set({ seenAt: now })
    .where(
      and(
        eq(cr.accountId, accountId),
        eq(cr.prId, prId),
        isNull(cr.seenAt),
        run.pairId != null ? eq(cr.pairId, run.pairId) : eq(cr.id, run.id),
      ),
    )
    .returning({ id: cr.id })
    .execute();
  return stamped.length;
}
