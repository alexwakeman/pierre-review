import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db, schema } from './client.js';
import { config } from '../config.js';

// One-time / idempotent maintenance run at startup.
//
// GitHub wraps inline-only reviews in an empty "commented" review, which the
// sync used to record as a `review_submitted` event. Those wrappers duplicate
// the inline `review_comment` markers on the timeline. New syncs no longer emit
// them (see sync/upsert.ts), but pre-existing rows linger because upserts only
// update. This removes them; it also catches reviews whose summary body was
// later cleared on GitHub. Cheap and safe to run every boot.
//
// Written as portable drizzle (no raw better-sqlite3 / db.execute) so it runs on
// both dialects; the count comes from `.returning().length` (dialect-neutral).
export async function cleanupRedundantReviewEvents(): Promise<number> {
  // In cloud "lean storage" mode (config.persistBodies false) reviews.body is
  // always null, so the body-emptiness signal this relies on is unavailable — and
  // unnecessary: persistPr already only emits review_submitted for *substantive*
  // reviews (it checks the in-memory GraphQL body, not the stored one), and cloud
  // starts empty, so there are no wrapper events to remove. Skipping here avoids
  // wrongly deleting markers for substantive "commented" reviews.
  if (!config.persistBodies) return 0;
  const { events, reviews } = schema;
  const emptyCommentedReviews = db
    .select({ id: reviews.id })
    .from(reviews)
    .where(
      and(
        eq(reviews.state, 'commented'),
        or(isNull(reviews.body), eq(sql`trim(${reviews.body})`, '')),
      ),
    );
  const deleted = await db
    .delete(events)
    .where(
      and(
        eq(events.type, 'review_submitted'),
        eq(events.refTable, 'reviews'),
        inArray(events.refId, emptyCommentedReviews),
      ),
    )
    .returning({ id: events.id })
    .execute();
  return deleted.length;
}
