import { and, eq } from 'drizzle-orm';
import { blastRadius, resolveBlastConfig } from '@pierre-review/shared';
import { db, schema } from './client.js';
import { blastSignalsFor } from './blast-radius.js';
import { codeLocFor } from './code-loc.js';
import { hubReadingFor, loadRepoCoupling } from './file-coupling.js';

// The one-PR blast-radius LEVEL read, for the auto-approve impact gate. Deliberately NOT in
// queries.ts: that file contains literal NUL bytes around offset 132k, so `rg`/`grep` silently
// under-report matches in it.
//
// ⚠ OWNERSHIP-SCOPED, and the scope is on the PR row itself (`pullRequests.accountId`), not a
// join to repos. A foreign or unknown id resolves to null, the same rule every id-addressed getter
// in this app follows.
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
