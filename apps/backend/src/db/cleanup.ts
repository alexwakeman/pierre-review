import { sqlite } from './client.js';

// One-time / idempotent maintenance run at startup.
//
// GitHub wraps inline-only reviews in an empty "commented" review, which the
// sync used to record as a `review_submitted` event. Those wrappers duplicate
// the inline `review_comment` markers on the timeline. New syncs no longer emit
// them (see sync/upsert.ts), but pre-existing rows linger because upserts only
// update. This removes them; it also catches reviews whose summary body was
// later cleared on GitHub. Cheap and safe to run every boot.
export function cleanupRedundantReviewEvents(): number {
  const res = sqlite
    .prepare(
      `DELETE FROM events
         WHERE type = 'review_submitted'
           AND ref_table = 'reviews'
           AND ref_id IN (
             SELECT id FROM reviews
               WHERE state = 'commented' AND (body IS NULL OR trim(body) = '')
           )`,
    )
    .run();
  return res.changes;
}
