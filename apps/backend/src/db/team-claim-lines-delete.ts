// The team-claim ledger's DELETE-PATH rule (migration 0138; docs/CLAUDE-REVIEW.md § Team claims →
// Releasing stale lines). When PRs leave Limn (deleteRepo, retention's deletePrSubtree), their ledger
// rows go — EXCEPT this machine's OPEN ones ('mine', 'claiming' / 'pending'): each stands for a line
// that may still be pending on GitHub, and the reconciler releases it from the row's own owner/name
// (it closes a row that has neither). The account erasure deletes every row regardless.
import { and, eq, inArray, not } from 'drizzle-orm';
import { schema } from './client.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function deleteSettledClaimLinesForPrs(tx: any, prIds: number[]): Promise<void> {
  if (prIds.length === 0) return;
  const tl = schema.teamClaimLines;
  await tx
    .delete(tl)
    .where(and(inArray(tl.prId, prIds), not(and(eq(tl.whose, 'mine'), inArray(tl.state, ['claiming', 'pending']))!)))
    .execute();
}
