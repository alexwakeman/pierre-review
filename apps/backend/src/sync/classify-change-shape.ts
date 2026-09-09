import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { blastSignalsFor } from '../db/blast-radius.js';
import { classifyChangeShape } from '../db/change-shape.js';
import { codeLocFor } from '../db/code-loc.js';
import { hubReadingFor, loadRepoCoupling } from '../db/file-coupling.js';
import { fetchPrFilesWithPatch } from '../github/mutations.js';
// The narrow {info, warn} the sync layer passes around — NOT FastifyBaseLogger, which the
// scheduler's logger does not satisfy. Same type `backfill-ci-history.ts` takes.
import type { BranchSyncLogger } from './branch-status.js';

// ============================================================================
// The TARGETED diff read behind blast radius's comments-only cap
// ============================================================================
//
// `db/change-shape.ts` can tell a comment-only change from a real one, but only from the PATCH —
// and a patch is a REST call per pull request. Running that on every synced pull request would
// be a per-PR GitHub call added to every walk, which is exactly the cost this whole feature was
// designed to avoid.
//
// So it is not run on every pull request. It is run on the ones where the answer COULD CHANGE
// THE LEVEL, and nowhere else.
//
// ---- WHO QUALIFIES, AND WHY IT IS A SHORT LIST -----------------------------
//
// The cap only ever turns HIGH into MEDIUM, so a pull request is a candidate only if it is
// currently HIGH. It narrows twice more from there:
//
//   1. HIGH *ONLY* BECAUSE OF A CONTRACT SURFACE. A pull request that is high on spread or
//      volume is high for reasons a comment-only reading does not touch — 40 files across 12
//      directories is a lot to read whatever the lines say.
//   2. SMALL. `MAX_CANDIDATE_LOC` / `MAX_CANDIDATE_FILES`. A 900-line change is not going to
//      turn out to be comments, and spending a call to confirm that is spending a call to learn
//      nothing.
//
// Measured on the real corpus: 363 of 1,566 open pull requests are HIGH, 53 are high on a
// surface ALONE, and 26 clear the size gate — **1.7%**. That is the budget this step spends.
//
// ---- THE THREE COST GUARDS -------------------------------------------------
//
//   · `PER_RUN_CAP` bounds one repo's work in one sync, so a repo that suddenly acquires 200
//     candidates does not spend 200 calls in one walk; the rest are picked up on later syncs.
//   · A pull request is classified ONCE PER HEAD SHA (`content_kind_sha`), so a re-sync of
//     unchanged work costs nothing.
//   · A FAILED fetch still writes a row — `content_kind: 'code'` against that sha — so a pull
//     request whose diff GitHub will not give us is not retried on every single walk. That is the
//     `ensureRoutingPrFiles` sentinel idiom, and `'code'` is the safe direction: it is what the
//     level already assumed.
//
// ⚠ STRICTLY NON-FATAL, like the branch snapshot and the co-change index. This refines one arm of
// one indicator; it must never be the reason a sync reports failure.

/** A candidate must be at most this many code lines for a comment-only reading to be plausible. */
const MAX_CANDIDATE_LOC = 50;

/** …and touch at most this many code files. */
const MAX_CANDIDATE_FILES = 3;

/** How many pull requests one repo may classify in a single sync. */
const PER_RUN_CAP = 25;

/**
 * Classify the change shape of this repo's qualifying open pull requests.
 *
 * Returns how many were classified (0 is the overwhelmingly common answer, and is not a failure).
 */
export async function runChangeShapeClassification(args: {
  owner: string;
  name: string;
  repoId: number;
  accountId: number;
  token: string;
  log: BranchSyncLogger;
  shouldCancel?: () => boolean;
}): Promise<number> {
  const { pullRequests } = schema;
  const { owner, name, repoId, accountId, token, log } = args;

  const rows = await db
    .select({
      id: pullRequests.id,
      number: pullRequests.number,
      headSha: pullRequests.headSha,
      files: pullRequests.files,
      additions: pullRequests.additions,
      deletions: pullRequests.deletions,
      changedFiles: pullRequests.changedFiles,
      contentKind: pullRequests.contentKind,
      contentKindSha: pullRequests.contentKindSha,
    })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        eq(pullRequests.repoId, repoId),
        eq(pullRequests.state, 'open'),
      ),
    )
    .execute();

  // The hub reading is part of what makes a pull request high, so the candidate test needs it —
  // otherwise a hub-driven high would be mistaken for a surface-only one and fetched for nothing.
  const coupling = (await loadRepoCoupling(accountId, [repoId])).get(repoId);

  const candidates: { id: number; number: number; headSha: string }[] = [];
  for (const p of rows) {
    // ⚠ ONCE PER HEAD SHA. A PR already classified at its current head is done; one classified at
    // an OLDER head is re-read, because the verdict described code that may no longer be there.
    if (p.headSha == null) continue;
    if (p.contentKindSha === p.headSha) continue;

    const signals = blastSignalsFor(p, hubReadingFor(p.files, coupling));
    if (signals == null) continue;
    const { codeLoc } = codeLocFor(p);
    if (codeLoc == null || codeLoc > MAX_CANDIDATE_LOC) continue;
    if (signals.codeFiles === 0 || signals.codeFiles > MAX_CANDIDATE_FILES) continue;

    // ⚠ SURFACE-DRIVEN HIGH ONLY. Deliberately re-derived here from the SIGNALS rather than
    // imported from the SPA's resolver, which is where the level actually lives: this is a
    // FETCH-BUDGET test, not a level. It is intentionally a superset — being slightly too eager
    // costs one call, and being too narrow silently leaves the flagged pull request uncapped.
    // ⚠ `ci`/`deps` are excluded because they are not high arms; see BlastSurface in shared.
    const hasHighSurface = signals.surfaces.some((s) => s !== 'ci' && s !== 'deps');
    if (!hasHighSurface) continue;

    candidates.push({ id: p.id, number: p.number, headSha: p.headSha });
    if (candidates.length >= PER_RUN_CAP) break;
  }

  if (candidates.length === 0) return 0;

  let done = 0;
  for (const c of candidates) {
    if (args.shouldCancel?.()) break;
    // ⚠ 'code' IS THE FAILURE VALUE, not null. It is what the level already assumed, and writing
    // it against this sha is what stops a pull request whose diff GitHub will not serve from
    // being retried on every walk forever.
    let kind: 'comments' | 'formatting' | 'code' = 'code';
    try {
      const { files } = await fetchPrFilesWithPatch(token, owner, name, c.number, 100);
      kind =
        classifyChangeShape(files.map((f) => ({ path: f.filename, patch: f.patch }))) ?? 'code';
    } catch (err) {
      log.warn(
        `change-shape ${owner}/${name}#${c.number} failed (non-fatal): ${err instanceof Error ? err.message : err}`,
      );
    }
    await db
      .update(pullRequests)
      .set({ contentKind: kind, contentKindSha: c.headSha })
      .where(and(eq(pullRequests.id, c.id), eq(pullRequests.accountId, accountId)))
      .execute();
    done += 1;
  }

  if (done > 0) log.info(`change-shape ${owner}/${name}: classified ${done} pull request(s)`);
  return done;
}

/** Clear stored classifications for a set of pull requests — used by nothing yet, but the
 *  counterpart a future "re-read everything" would need. Kept beside the writer so the two
 *  cannot drift about which columns constitute the verdict. */
export async function clearChangeShape(accountId: number, prIds: number[]): Promise<void> {
  if (prIds.length === 0) return;
  const { pullRequests } = schema;
  await db
    .update(pullRequests)
    .set({ contentKind: null, contentKindSha: null })
    .where(and(eq(pullRequests.accountId, accountId), inArray(pullRequests.id, prIds)))
    .execute();
}
