// A REVIEW REQUEST ONLY LIMN ANSWERED (docs/BACKEND.md § My Turn, "Waiting on you").
//
// GitHub deletes a review request the moment a review is submitted under the requested login, and
// Limn posts its review under the reader's own account. So a Limn auto review silently removes the
// reader's `review_requests` row, and the "review request" card went with it, though the reader
// never looked. "Everything Limn does on my behalf is not me": the request still stands.
//
// The rule, per open PR, from stored history only:
//   1. the reader's NEWEST request event (`review_request_events`, a user request naming the reader)
//      is a 'requested' one — a later 'removed' means somebody withdrew it;
//   2. no `review_requests` row for the reader exists now (while one does, the ordinary card shows);
//   3. a Limn review POSTED FOR the reader (`reviews.limn_posted_by_user_id`) came at or after that
//      request — Limn is what discharged it; and
//   4. no review by the reader IN PERSON (`reviews.author_id`, not 'pending') came at or after it.
// A request that vanished with no Limn review behind it stays gone: something else removed it.
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from './client.js';

const { reviewRequestEvents, reviewRequests, reviews } = schema;

/** Per PR id: when the reader was asked, for each request only a Limn review answered. */
export async function limnDischargedReviewRequests(
  readerId: number,
  prIds: readonly number[],
): Promise<Map<number, Date>> {
  const out = new Map<number, Date>();
  if (prIds.length === 0) return out;
  const ids = [...new Set(prIds)];

  const newest = new Map<number, { kind: 'requested' | 'removed'; at: Date }>();
  for (const e of await db
    .select({ prId: reviewRequestEvents.prId, kind: reviewRequestEvents.kind, at: reviewRequestEvents.occurredAt })
    .from(reviewRequestEvents)
    .where(
      and(
        inArray(reviewRequestEvents.prId, ids),
        eq(reviewRequestEvents.reviewerKind, 'user'),
        eq(reviewRequestEvents.reviewerUserId, readerId),
      ),
    )
    .execute()) {
    const cur = newest.get(e.prId);
    // Same instant: a removal wins (the safe direction — under-notify).
    if (cur == null || e.at.getTime() > cur.at.getTime() || (e.at.getTime() === cur.at.getTime() && e.kind === 'removed')) {
      newest.set(e.prId, { kind: e.kind, at: e.at });
    }
  }
  const asked = [...newest].filter(([, e]) => e.kind === 'requested').map(([prId]) => prId);
  if (asked.length === 0) return out;

  const standing = new Set(
    (
      await db
        .select({ prId: reviewRequests.prId })
        .from(reviewRequests)
        .where(and(inArray(reviewRequests.prId, asked), eq(reviewRequests.userId, readerId)))
        .execute()
    ).map((r) => r.prId),
  );
  const open = asked.filter((id) => !standing.has(id));
  if (open.length === 0) return out;

  const rows = await db
    .select({
      prId: reviews.prId,
      authorId: reviews.authorId,
      postedFor: reviews.limnPostedByUserId,
      state: reviews.state,
      at: reviews.submittedAt,
    })
    .from(reviews)
    .where(inArray(reviews.prId, open))
    .execute();
  for (const prId of open) {
    const askedAt = newest.get(prId)!.at.getTime();
    const after = rows.filter((r) => r.prId === prId && r.at != null && r.at.getTime() >= askedAt && r.state !== 'pending');
    const inPerson = after.some((r) => r.authorId === readerId && r.postedFor == null);
    const byLimn = after.some((r) => r.postedFor === readerId);
    if (byLimn && !inPerson) out.set(prId, newest.get(prId)!.at);
  }
  return out;
}
