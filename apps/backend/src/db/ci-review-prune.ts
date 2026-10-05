import { inArray } from 'drizzle-orm';
import { schema, type Executor } from './client.js';

// THE CI-REVIEW HALF OF BOTH PR DELETE PATHS (deleteRepo in queries.ts, retention's
// deletePrSubtree). A CI review belongs to exactly one PR, so deleting the PR deletes its runs and
// their items. Children before parents, explicitly — the composite FKs cascade, but these paths run
// parent-last by hand on both dialects. Runs inside the caller's transaction.
export async function pruneCiReviewsForPrs(tx: Executor, prIds: readonly number[]): Promise<void> {
  if (prIds.length === 0) return;
  const runs = schema.ciReviews;
  const rows = await tx
    .select({ id: runs.id })
    .from(runs)
    .where(inArray(runs.prId, [...prIds]))
    .execute();
  const runIds = rows.map((r) => r.id);
  if (runIds.length > 0) {
    await tx.delete(schema.ciReviewItems).where(inArray(schema.ciReviewItems.ciReviewId, runIds)).execute();
  }
  await tx.delete(runs).where(inArray(runs.prId, [...prIds])).execute();
}
