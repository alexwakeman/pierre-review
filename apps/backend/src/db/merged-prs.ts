import { and, desc, eq, gte, inArray, lt } from 'drizzle-orm';
import type { TimelinePr } from '@pierre-review/shared';
import { db, schema } from './client.js';
import { buildTimelinePrs, type BotScope } from './queries.js';
import { measuredTo, type ReportingWindow } from './reporting-window.js';

// REPORTS → "MERGED SO FAR" — every pull request MERGED in the workspace's reporting window, as
// the same `TimelinePr` rows Activity → Open PRs draws (`buildTimelinePrs`), so the SPA reuses the
// Open PRs cards and ticket stacks rather than forking them.
//
// Window: `[window.fromMs, min(window.toMs, now))` on `merged_at`, TWO-SIDED and HALF-OPEN — the
// same span the flow tiles' "Merged" figure and the reach card count (db/merged-reach.ts). The
// window is resolved by the caller through `getReportingWindow`; nothing here re-derives a cadence.
//
// Tenancy is in the query (`accountId` + the owned repo ids), not inherited from the caller, and
// `scope.repoIds = []` (an empty workspace) is an empty list, never a widening to the account.
//
// COST: one indexed scan over the window's merged PRs plus `buildTimelinePrs`' thread-count and
// triage folds over that page. Bounded by `MERGED_PRS_CAP`, newest merge first, so a capped list
// is the LATEST merges and `truncated` says so.

/** A payload guard, not a display limit: a real sprint rarely merges this many. */
export const MERGED_PRS_CAP = 1_000;

export interface MergedPrsResult {
  prs: TimelinePr[];
  truncated: boolean;
}

export async function getMergedPrsInWindow(
  accountId: number,
  scope: BotScope,
  nowMs: number,
  window: ReportingWindow,
): Promise<MergedPrsResult> {
  if (scope.repoIds.length === 0) return { prs: [], truncated: false };
  const { pullRequests, repos } = schema;

  const owned = await db
    .select({ id: repos.id })
    .from(repos)
    .where(and(eq(repos.accountId, accountId), inArray(repos.id, scope.repoIds)))
    .execute();
  if (owned.length === 0) return { prs: [], truncated: false };

  const fromMs = window.fromMs;
  const toMs = Math.max(fromMs, measuredTo(window, nowMs));

  const rows = await db
    .select()
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(
          pullRequests.repoId,
          owned.map((r) => r.id),
        ),
        eq(pullRequests.state, 'merged'),
        gte(pullRequests.mergedAt, new Date(fromMs)),
        lt(pullRequests.mergedAt, new Date(toMs)),
      ),
    )
    // One row over the cap, so exactly MERGED_PRS_CAP rows is not misreported as partial.
    .orderBy(desc(pullRequests.mergedAt), desc(pullRequests.id))
    .limit(MERGED_PRS_CAP + 1)
    .execute();

  const truncated = rows.length > MERGED_PRS_CAP;
  const page = truncated ? rows.slice(0, MERGED_PRS_CAP) : rows;
  const built = await buildTimelinePrs(page, accountId);
  // `buildTimelinePrs` keeps input order; re-assert newest merge first so the contract does not
  // lean on that.
  built.sort((a, b) => (b.mergedAt ?? '').localeCompare(a.mergedAt ?? '') || b.id - a.id);
  return { prs: built, truncated };
}
