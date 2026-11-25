// HUMAN REVIEW COVERAGE (docs/AI-ADOPTION-REPORT.md § The report): of the PRs merged in `[from, to)`
// (on `merged_at`), the share with at least one APPROVAL from a person before the merge. The AI
// adoption report's guardrail: AI involvement went up, did people still approve the work?
//
// An approval counts when ALL of:
//   • `reviews.state = 'approved'`;
//   • `submitted_at <= merged_at` (an approval after the merge did not gate it);
//   • not dismissed before the merge (`dismissed_at` NULL or later than `merged_at`);
//   • the review's `author_id` is in the `human` lane of `resolveActorLanes` for the workspace.
//
// ⚠ `author_id`, NEVER `trueAuthorId(reviews)`. An approval Ensemble posted for a reader is stored
// under the reader's `limn:<login>` bot, whose lane is `limn`: it is Ensemble's approval, not the
// person's, so it does not count. A bot's approval does not count. A manual "this is a person"
// judgement (Settings → Bots) wins, as it does everywhere the lanes are read.
// ⚠ A NULL author (a deleted GitHub account) is unattributable and does not count.
// DB only. Account-scoped: every PR id is gated on `pull_requests.account_id`.
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from './client.js';
import type { ActorLanes } from './actor-lanes.js';

const { pullRequests, reviews } = schema;

const ID_CHUNK = 500;

export interface MergedPrRef {
  id: number;
  mergedAtMs: number;
}

/**
 * The ids among `prs` (the account's merged PRs, with their merge time) that a PERSON approved
 * before the merge. Ids that are not the account's are never returned. DB only.
 */
export async function humanApprovedPrIds(
  accountId: number,
  prs: readonly MergedPrRef[],
  lanes: ActorLanes,
): Promise<Set<number>> {
  const out = new Set<number>();
  const mergedAt = new Map(prs.map((p) => [p.id, p.mergedAtMs] as const));
  const ids = [...mergedAt.keys()];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const rows = await db
      .select({
        prId: reviews.prId,
        authorId: reviews.authorId,
        submittedAt: reviews.submittedAt,
        dismissedAt: reviews.dismissedAt,
      })
      .from(reviews)
      .innerJoin(pullRequests, eq(pullRequests.id, reviews.prId))
      .where(and(eq(pullRequests.accountId, accountId), inArray(reviews.prId, chunk), eq(reviews.state, 'approved')))
      .execute();
    for (const r of rows) {
      if (out.has(r.prId)) continue;
      const merged = mergedAt.get(r.prId);
      if (merged == null || r.authorId == null) continue;
      if (r.submittedAt.getTime() > merged) continue;
      if (r.dismissedAt != null && r.dismissedAt.getTime() <= merged) continue;
      if (lanes.laneOf(r.authorId) !== 'human') continue;
      out.add(r.prId);
    }
  }
  return out;
}
