// AI FIX'S REVIEW LOOP ROWS GO WITH THEIR FIX (migration 0207). `ai_fix_loop_*.fix_id` is soft (ai_fixes has
// no (id, account_id) unique to point a composite FK at), so the two PR-keyed delete paths — deleteRepo
// (queries.ts) and retention's deletePrSubtree — call this BEFORE they delete the PRs' `ai_fixes` rows. The
// account erasure deletes these tables by account (erase-account.ts). Findings first (they point at runs).
import { inArray } from 'drizzle-orm';
import * as schema from './schema.sqlite.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function pruneAiFixLoopForPrs(tx: any, prIds: readonly number[]): Promise<void> {
  if (prIds.length === 0) return;
  const fixIds = ((await tx.select({ id: schema.aiFixes.id }).from(schema.aiFixes).where(inArray(schema.aiFixes.prId, [...prIds])).execute()) as Array<{ id: number }>).map((r) => r.id);
  if (fixIds.length === 0) return;
  await tx.delete(schema.aiFixLoopFindings).where(inArray(schema.aiFixLoopFindings.fixId, fixIds)).execute();
  await tx.delete(schema.aiFixLoopReviews).where(inArray(schema.aiFixLoopReviews.fixId, fixIds)).execute();
  await tx.delete(schema.aiFixLoopStoryChecks).where(inArray(schema.aiFixLoopStoryChecks.fixId, fixIds)).execute();
  await tx.delete(schema.aiFixLoopAcResponses).where(inArray(schema.aiFixLoopAcResponses.fixId, fixIds)).execute();
}
/* eslint-enable @typescript-eslint/no-explicit-any */
