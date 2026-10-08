import { and, asc, eq, gte, inArray, lt } from 'drizzle-orm';
import type { WorkspaceMergedReach, WorkspaceReachPr } from '@pierre-review/shared';
import { db, schema } from './client.js';
import { blastSignalsFor } from './blast-radius.js';
import { codeLocFor } from './code-loc.js';
import { hubReadingFor, loadRepoCoupling } from './file-coupling.js';
import type { BotScope } from './queries.js';
import { measuredTo, type ReportingWindow } from './reporting-window.js';

// REACH BY REPOSITORY — the pull requests MERGED in the workspace's reporting window, each with
// the blast-radius SIGNALS the SPA's one `blastRadius()` resolver reads.
//
// ⚠ SIGNALS, NEVER A LEVEL. The open-PR rows carry `blast` + `codeLoc` + `codeLocIsLowerBound` and
// the SPA decides the level at render time, so the Settings sensitivity dial repaints with no cache
// invalidation. These rows carry exactly the same three fields from exactly the same folds
// (`codeLocFor`, `blastSignalsFor` + the co-change hub reading) — a per-repo `{low, medium, high}`
// here would be the product's first server-decided level.
//
// ⚠ `blast: null` IS "NOT MEASURED", never "low", and the card does not draw it.
//
// Window: `[window.fromMs, min(window.toMs, now))` on `merged_at`, two-sided and half-open, the
// same span the tiles' "Merged" figure counts. Tenancy is in the query (`accountId` + the owned
// repo ids), not inherited from the caller.
//
// COST: one indexed scan over the window's merged PRs (the `files` column is the bulky one and it
// never leaves this function) plus one co-change lookup. Bounded by `MERGED_REACH_CAP`.

/** A pathological-payload guard, not a display limit: no real sprint merges this many. When it
 *  bites, `truncated` says so and the card states that the list is partial. */
export const MERGED_REACH_CAP = 3_000;

export async function getWorkspaceMergedReach(
  accountId: number,
  scope: BotScope,
  nowMs: number,
  window: ReportingWindow,
): Promise<WorkspaceMergedReach | null> {
  // `[]` is "this workspace is empty", never a widening to the whole account.
  if (scope.repoIds.length === 0) return null;
  const { pullRequests, repos } = schema;

  const owned = await db
    .select({ id: repos.id })
    .from(repos)
    .where(and(eq(repos.accountId, accountId), inArray(repos.id, scope.repoIds)))
    .execute();
  if (owned.length === 0) return null;
  const ownedIds = owned.map((r) => r.id);

  const fromMs = window.fromMs;
  const toMs = Math.max(fromMs, measuredTo(window, nowMs));

  const fetched = await db
    .select({
      id: pullRequests.id,
      repoId: pullRequests.repoId,
      files: pullRequests.files,
      additions: pullRequests.additions,
      deletions: pullRequests.deletions,
      changedFiles: pullRequests.changedFiles,
      // All three or none — `blastSignalsFor` compares them (the comments-only cap's staleness test).
      contentKind: pullRequests.contentKind,
      contentKindSha: pullRequests.contentKindSha,
      headSha: pullRequests.headSha,
    })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(pullRequests.repoId, ownedIds),
        eq(pullRequests.state, 'merged'),
        gte(pullRequests.mergedAt, new Date(fromMs)),
        lt(pullRequests.mergedAt, new Date(toMs)),
      ),
    )
    // Ordered, so a capped list is the window's EARLIEST merges (what the card says), and one row
    // over the cap, so exactly MERGED_REACH_CAP rows is not misreported as partial.
    .orderBy(asc(pullRequests.mergedAt), asc(pullRequests.id))
    .limit(MERGED_REACH_CAP + 1)
    .execute();
  const truncated = fetched.length > MERGED_REACH_CAP;
  const rows = truncated ? fetched.slice(0, MERGED_REACH_CAP) : fetched;

  // ⚠ A repo absent from the map has NO hub reading — never an empty one.
  const coupling = await loadRepoCoupling(accountId, [...new Set(rows.map((r) => r.repoId))]);
  const prs: WorkspaceReachPr[] = rows.map((r) => {
    const { codeLoc, codeLocIsLowerBound } = codeLocFor(r);
    return {
      id: r.id,
      repoId: r.repoId,
      codeLoc,
      codeLocIsLowerBound,
      blast: blastSignalsFor(r, hubReadingFor(r.files, coupling.get(r.repoId))),
    };
  });

  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    prs,
    truncated,
  };
}
