import { and, count, eq, gt, inArray, isNull, ne } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { loadRepoCoupling } from '../../db/file-coupling.js';

// THE REVIEW PLAN'S STORED INPUTS (claude-review/worklist.ts): the repo's co-change hubs and how many
// earlier review findings each changed path has had. DB only, never GitHub, never a model. Any
// failure answers "unknown" (no hubs, no counts): the plan is advisory and never fails a review.

/** Earlier findings count over this window. */
export const PAST_FINDINGS_DAYS = 180;

export interface WorklistStoredInputs {
  hubs: Map<string, number> | null;
  pastFindings: Map<string, number> | null;
}

export async function worklistInputsFor(
  accountId: number,
  prId: number,
  paths: readonly string[],
): Promise<WorklistStoredInputs> {
  try {
    const { pullRequests: prs, claudeReviews: cr, claudeReviewFindings: crf } = schema;
    const pr = (
      await db
        .select({ repoId: prs.repoId })
        .from(prs)
        .where(and(eq(prs.id, prId), eq(prs.accountId, accountId)))
        .limit(1)
        .execute()
    )[0];
    if (!pr || paths.length === 0) return { hubs: null, pastFindings: null };
    const coupling = (await loadRepoCoupling(accountId, [pr.repoId])).get(pr.repoId);
    // Findings on OTHER pull requests in this repo (this PR's own earlier reviews would only echo
    // themselves), from full reviews (never a replies pass), over the window.
    const since = new Date(Date.now() - PAST_FINDINGS_DAYS * 86_400_000);
    const rows = await db
      .select({ path: crf.path, n: count() })
      .from(crf)
      .innerJoin(cr, eq(cr.id, crf.reviewId))
      .innerJoin(prs, eq(prs.id, cr.prId))
      .where(
        and(
          eq(cr.accountId, accountId),
          eq(prs.repoId, pr.repoId),
          ne(cr.prId, prId),
          eq(cr.status, 'succeeded'),
          isNull(cr.kind),
          gt(cr.createdAt, since),
          inArray(crf.path, [...paths]),
          ne(crf.severity, 'praise'),
        ),
      )
      .groupBy(crf.path)
      .execute();
    return {
      hubs: coupling?.hubs ?? null,
      pastFindings: new Map(rows.map((r) => [r.path, Number(r.n)])),
    };
  } catch {
    return { hubs: null, pastFindings: null };
  }
}
