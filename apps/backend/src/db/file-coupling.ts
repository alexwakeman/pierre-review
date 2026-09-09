import { and, eq, inArray } from 'drizzle-orm';
import type { StoredPrFile } from '@pierre-review/shared';
import { db, schema } from './client.js';
import { isNonCodeFile } from './code-loc.js';
import { isTestFile, type HubReading } from './blast-radius.js';

// ============================================================================
// The per-repo CO-CHANGE index — blast radius's "cross-file dependency" arm
// ============================================================================
//
// "Which files does everything else in this repository change with?" A file that has historically
// landed in the same pull request as 77 other files is one whose consumers live outside any diff
// that touches it — which is the exact question blast radius asks and the one no size measure can
// answer.
//
// ⚠ WHY CO-CHANGE AND NOT AN IMPORT GRAPH. A real dependency graph needs file CONTENTS, i.e. a
// GitHub fetch per file per repo, and the Pending board may not fetch on mount. Co-change is a
// PROXY, computed entirely from `pull_requests.files` rows the sync already stored. It is
// deliberately conservative (see the three quality rules below) because a proxy that over-fires
// puts a false claim on screen.
//
// ---- THE FOUR RULES, EACH MEASURED ON THE REAL CORPUS -----------------------
//
// 1. TESTS ARE EXCLUDED FROM THE INDEX. A test file co-changes with its subject by construction —
//    that is what a test IS, not evidence of reach. Measured: one repo's top "hubs" were four
//    `*.test.js` files sitting above their own controllers. Blast radius counts tests apart
//    everywhere else; the index matches.
//
// 2. A PULL REQUEST TOUCHING MORE THAN `HUB_PR_FILE_CAP` FILES CONTRIBUTES NOTHING. A 100-file
//    pull request creates a 100-way clique in one stroke, which says the author did a big
//    refactor — not that those files are coupled. Without the cap one such PR can lift a hundred
//    unrelated paths over the bar.
//
// 3. A REPO BELOW `HUB_MIN_PRS` GETS NO ROW AT ALL, and every reader treats a missing row as "the
//    index has nothing to say" rather than "no hubs here". Measured: only 7 of 22 real
//    repositories clear it. A refusal is the honest answer for the other 15.
//
// 4. THE BAR IS max(THIS REPO'S p90, `HUB_MIN_DEGREE`) — RELATIVE **AND** ABSOLUTE, and this is
//    the rule that took the longest to get right. A p90 alone is exceeded by a tenth of paths BY
//    CONSTRUCTION, so a repository with no coupling whatsoever still publishes "hubs": measured, a
//    config repo produced 77 of them, which were eight per-environment copies of one service's
//    `.env` file. An absolute floor alone would be worse in the other direction — degree scales
//    are not comparable between a 2,800-path monorepo and a 130-path library. Together they took
//    that config repo to ZERO while leaving `redis.go` (73), `src/renderers/WebGLRenderer.js` (65)
//    and `crates/bevy_render/src/lib.rs` (70) standing.

/** A pull request touching more than this many code files contributes NO pairs. See rule 2. */
export const HUB_PR_FILE_CAP = 25;

/** A repo with fewer contributing merged pull requests than this gets no index row. See rule 3. */
export const HUB_MIN_PRS = 100;

/** The absolute half of the bar. See rule 4 — without it, every repo manufactures hubs. */
export const HUB_MIN_DEGREE = 60;

/** What one repo's index holds, in the shape the fold reads. */
export interface RepoCoupling {
  /** The degree a path had to reach to be in `hubs` — `max(p90, HUB_MIN_DEGREE)`. Travels to the
   *  client so the comparison on screen is auditable rather than a magic number. */
  hubBar: number;
  /** Merged pull requests that contributed, after the per-PR cap. */
  prCount: number;
  /** path → co-change degree, hubs only. A path that is absent is BELOW the bar. */
  hubs: Map<string, number>;
}

/** The code, non-test paths of one pull request, de-duplicated. The one place the index decides
 *  what a "file" is, so rules 1 and 2 cannot drift apart from the fold's own classification. */
function couplingPathsOf(files: StoredPrFile[] | null | undefined): string[] | null {
  if (files == null || files.length === 0) return null;
  const out = new Set<string>();
  for (const f of files) {
    if (typeof f?.path !== 'string') continue;
    if (isNonCodeFile(f.path)) continue;
    if (isTestFile(f.path)) continue; // rule 1
    out.add(f.path);
  }
  if (out.size === 0) return null;
  if (out.size > HUB_PR_FILE_CAP) return null; // rule 2
  return [...out];
}

/**
 * Rebuild one repository's co-change index from its MERGED pull requests.
 *
 * Idempotent and cheap: one indexed read of the repo's merged rows, an in-memory fold, and one
 * upsert (or one delete, when the repo has dropped below the coverage floor — a stale row saying
 * "these are the hubs" is worse than no row).
 *
 * Returns the row that was written, or null when the repo does not qualify.
 */
export async function rebuildRepoCoupling(
  accountId: number,
  repoId: number,
): Promise<RepoCoupling | null> {
  const { pullRequests, repoFileCoupling } = schema;

  const rows = await db
    .select({ files: pullRequests.files })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        eq(pullRequests.repoId, repoId),
        eq(pullRequests.state, 'merged'),
      ),
    )
    .execute();

  // path -> the set of OTHER paths seen in the same pull request.
  const degree = new Map<string, Set<string>>();
  let prCount = 0;
  for (const row of rows) {
    const paths = couplingPathsOf(row.files);
    if (paths == null) continue;
    prCount += 1;
    for (const p of paths) {
      let s = degree.get(p);
      if (!s) {
        s = new Set();
        degree.set(p, s);
      }
      for (const q of paths) if (q !== p) s.add(q);
    }
  }

  const clear = async (): Promise<null> => {
    await db
      .delete(repoFileCoupling)
      .where(
        and(eq(repoFileCoupling.accountId, accountId), eq(repoFileCoupling.repoId, repoId)),
      )
      .execute();
    return null;
  };

  if (prCount < HUB_MIN_PRS || degree.size === 0) return clear(); // rule 3

  const degrees = [...degree.values()].map((s) => s.size).sort((a, b) => a - b);
  const p90 = degrees[Math.floor((degrees.length - 1) * 0.9)] ?? 0;
  const hubBar = Math.max(p90, HUB_MIN_DEGREE); // rule 4

  const hubs: Record<string, number> = {};
  for (const [path, s] of degree) if (s.size >= hubBar) hubs[path] = s.size;
  // A repo that clears the coverage floor but has no path over the bar is a repo with no hubs.
  // ⚠ Storing an EMPTY map would be a positive claim ("we looked, there are none") that every
  // reader would then have to distinguish from a missing row for no benefit — nothing renders
  // "not a hub". One silent state.
  if (Object.keys(hubs).length === 0) return clear();

  const values = { accountId, repoId, hubBar, prCount, hubs, builtAt: new Date() };
  await db
    .insert(repoFileCoupling)
    .values(values)
    // ⚠ The conflict target is the table's ONE unique index, `(account_id, repo_id)`. If that
    // index ever changes, this must change with it — a stale target type-checks perfectly and
    // raises at RUNTIME, in both dialects, only when a row is actually written.
    .onConflictDoUpdate({
      target: [repoFileCoupling.accountId, repoFileCoupling.repoId],
      set: { hubBar, prCount, hubs, builtAt: new Date() },
    })
    .execute();

  return { hubBar, prCount, hubs: new Map(Object.entries(hubs)) };
}

/**
 * Load the index for a set of repos, in one query.
 *
 * ⚠ A REPO ABSENT FROM THE RESULT HAS NO READING — never an empty one. Every caller must pass
 * `undefined`/null through to the fold rather than substituting a zero, which would read as
 * "measured, not a hub" for the 15 of 22 repositories that have no index at all.
 */
export async function loadRepoCoupling(
  accountId: number,
  repoIds: number[],
): Promise<Map<number, RepoCoupling>> {
  const out = new Map<number, RepoCoupling>();
  if (repoIds.length === 0) return out;
  const { repoFileCoupling } = schema;
  const rows = await db
    .select({
      repoId: repoFileCoupling.repoId,
      hubBar: repoFileCoupling.hubBar,
      prCount: repoFileCoupling.prCount,
      hubs: repoFileCoupling.hubs,
    })
    .from(repoFileCoupling)
    .where(
      and(
        eq(repoFileCoupling.accountId, accountId),
        inArray(repoFileCoupling.repoId, repoIds),
      ),
    )
    .execute();
  for (const r of rows) {
    out.set(r.repoId, {
      hubBar: r.hubBar,
      prCount: r.prCount,
      hubs: new Map(Object.entries(r.hubs ?? {})),
    });
  }
  return out;
}

/**
 * The hub reading for ONE pull request: the highest-degree hub among its files, if any.
 *
 * ⚠ RETURNS null RATHER THAN A ZERO in every "we cannot say" case — no index for the repo, or no
 * touched file is a hub. Those two ARE deliberately one state: nothing in the product ever says
 * "this is not a hub", so distinguishing them would be a distinction no screen can show. What
 * matters is that neither is reported as a measured zero.
 */
export function hubReadingFor(
  files: StoredPrFile[] | null | undefined,
  coupling: RepoCoupling | undefined,
): HubReading | null {
  if (coupling == null || files == null) return null;
  let best: HubReading | null = null;
  for (const f of files) {
    if (typeof f?.path !== 'string') continue;
    const degree = coupling.hubs.get(f.path);
    if (degree == null) continue;
    if (best == null || degree > best.degree) {
      best = { degree, bar: coupling.hubBar, path: f.path };
    }
  }
  return best;
}
