import { inArray } from 'drizzle-orm';
import { schema, type Executor } from './client.js';

// THE TICKET-REVIEW HALF OF BOTH PR DELETE PATHS (deleteRepo in queries.ts, retention's
// deletePrSubtree). A ticket review spans PRs in several repos, so deleting a PR must not take the
// whole run with it — only that PR's member rows. Then:
//   • a run left with NO members is deleted with its items — it describes nothing any more. That
//     includes a run refused before it had members, which only its starting PR anchors;
//   • an item whose owner was a deleted PR keeps its history but loses the owner (`owner_pr_id`
//     null), so a Post can never target a PR that is gone.
// Children before parents, explicitly — the composite FKs cascade, but these paths run parent-last
// by hand on both dialects. Runs inside the caller's transaction.
export async function pruneTicketReviewsForPrs(tx: Executor, prIds: readonly number[]): Promise<void> {
  if (prIds.length === 0) return;
  const ids = [...prIds];
  const m = schema.ticketReviewMembers;
  const tr = schema.ticketReviews;
  const items = schema.ticketReviewItems;
  const touched = (await tx
    .select({ id: m.ticketReviewId })
    .from(m)
    .where(inArray(m.prId, ids))
    .execute()) as Array<{ id: number }>;
  // A run refused before it had members (too many PRs, no ticket) is anchored only by the PR that
  // started it.
  const started = (await tx
    .select({ id: tr.id })
    .from(tr)
    .where(inArray(tr.originPrId, ids))
    .execute()) as Array<{ id: number }>;
  await tx.delete(m).where(inArray(m.prId, ids)).execute();
  await tx.update(items).set({ ownerPrId: null }).where(inArray(items.ownerPrId, ids)).execute();
  const runIds = [...new Set([...touched, ...started].map((r) => r.id))];
  if (runIds.length === 0) return;
  const stillHeld = (await tx
    .select({ id: m.ticketReviewId })
    .from(m)
    .where(inArray(m.ticketReviewId, runIds))
    .execute()) as Array<{ id: number }>;
  const held = [...new Set(stillHeld.map((r) => r.id))];
  const empty = runIds.filter((id) => !held.includes(id));
  if (empty.length === 0) return;
  await tx.delete(items).where(inArray(items.ticketReviewId, empty)).execute();
  await tx.delete(tr).where(inArray(tr.id, empty)).execute();
}
