import { and, eq } from 'drizzle-orm';
import { blastRadius, resolveBlastConfig, type BlastSignals } from '@pierre-review/shared';
import { db, schema } from './client.js';
import { blastSignalsFor } from './blast-radius.js';
import { codeLocFor } from './code-loc.js';
import { hubReadingFor, loadRepoCoupling } from './file-coupling.js';

// The one-PR blast-radius read, for the Pro `impact` annotation's grounding (ctx.queries
// .getBlastSignals). Deliberately NOT in queries.ts: that file contains literal NUL bytes around
// offset 132k, so `rg`/`grep` silently under-report matches in it, and a seam the plugin depends
// on should be greppable.
//
// ⚠ OWNERSHIP-SCOPED, and the scope is on the PR row itself (`pullRequests.accountId`), not a
// join to repos — an id from a request body reaching a foreign PR here would let a caller spend
// their own credits describing someone else's diff. A foreign or unknown id resolves to null and
// the caller 404s, the same rule every id-addressed getter in this app follows.
export async function getBlastSignalsForPr(
  accountId: number,
  prId: number,
): Promise<BlastSignals | null> {
  const { pullRequests } = schema;
  const rows = await db
    .select({
      repoId: pullRequests.repoId,
      files: pullRequests.files,
      additions: pullRequests.additions,
      deletions: pullRequests.deletions,
      changedFiles: pullRequests.changedFiles,
    })
    .from(pullRequests)
    .where(and(eq(pullRequests.accountId, accountId), eq(pullRequests.id, prId)))
    .limit(1)
    .execute();
  const pr = rows[0];
  if (!pr) return null;
  const coupling = await loadRepoCoupling(accountId, [pr.repoId]);
  // ⚠ null here is the SAME "we never measured this pull request" the chip renders nothing for.
  // The caller must skip rather than describe a diff nobody measured.
  return blastSignalsFor(pr, hubReadingFor(pr.files, coupling.get(pr.repoId)));
}

/**
 * The PR's blast-radius LEVEL as the account would see it on its chips — for the auto-approve
 * impact gate (review/claude-review/auto-post.ts). The SAME three inputs the SPA's chip reads
 * (`blastSignalsFor` + the hub reading, `codeLocFor`'s `codeLoc`/`codeLocIsLowerBound`, the change
 * shape) folded through the SAME shared `blastRadius()` + `resolveBlastConfig()` with the account's
 * stored config. ⚠ There is no second resolver: this calls the shared one.
 *
 * null = the resolver drew nothing (unmeasured, or a truncated list with no high arm) OR the PR is
 * not this account's. The caller decides what null means (auto-approve: held as if high).
 */
export async function getPrImpactLevel(
  accountId: number,
  prId: number,
): Promise<'high' | 'medium' | 'low' | null> {
  const { pullRequests, accounts } = schema;
  const rows = await db
    .select({
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
    .where(and(eq(pullRequests.accountId, accountId), eq(pullRequests.id, prId)))
    .limit(1)
    .execute();
  const pr = rows[0];
  if (!pr) return null;
  const acct = await db
    .select({ config: accounts.blastRadiusConfig })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1)
    .execute();
  const coupling = await loadRepoCoupling(accountId, [pr.repoId]);
  const { codeLoc, codeLocIsLowerBound } = codeLocFor(pr);
  const verdict = blastRadius(
    { blast: blastSignalsFor(pr, hubReadingFor(pr.files, coupling.get(pr.repoId))), codeLoc, codeLocIsLowerBound },
    resolveBlastConfig(acct[0]?.config ?? null),
  );
  return verdict?.level ?? null;
}
