// One-off repair for the lean-storage-window legacy rows: bot comments/reviews whose body was
// never persisted (`body IS NULL`), synced between the lean-storage commit (2026-06-07) and the
// restore of always-persisted bodies (2026-07-01). Those rows are invisible to BOTH the ML
// candidate query and the pending count — coverage reads 100% while badges are missing — and
// nothing repairs them on its own: incremental sync only re-walks PRs whose GitHub `updatedAt`
// moves, and these live on old, closed PRs.
//
//   pnpm ml:backfill-bodies
//
// Enumerates every PR still carrying bot-authored NULL-body targets (the same predicate as the
// `unscorable` count, bot set per each repo's OWN workspace — exactly what the worker uses),
// runs the normal hydration path per PR (~1 GraphQL call each, small concurrency) and writes
// the fetched bodies back over the NULLs. Idempotent: a re-run selects only what is still NULL.
//
// The labels themselves arrive LATER, via the enrichment worker's normal pull — so expect
// `pending` to JUMP by roughly the rows repaired here. That is the honest number: text that was
// silently unscorable becoming visible work. Needs a GitHub token (local: `gh auth token`).
import { closeDb, db, schema } from '../src/db/client.js';
import { runMigrations } from '../src/db/run-migrations.js';
import { eq, inArray } from 'drizzle-orm';
import {
  automatedReviewerUserIds,
  listWorkspaces,
  type BotScope,
} from '../src/db/queries.js';
import { getMlBacklogForAccount, listNullBodyBotPrIds } from '../src/db/ml-labels.js';
import { backfillPrNullBodies } from '../src/sync/hydrate-detail.js';

// Gentle on purpose: each PR is one PR_DETAIL_QUERY against the user's own token.
const CONCURRENCY = 3;

async function main(): Promise<void> {
  await runMigrations();

  const { accounts, pullRequests, repos } = schema;
  const accountRows = await db.select({ id: accounts.id }).from(accounts).execute();

  for (const { id: accountId } of accountRows) {
    const before = await getMlBacklogForAccount(accountId);

    // Worklist: distinct PRs with bot-authored NULL-body targets, bot set per workspace.
    const prIds = new Set<number>();
    for (const ws of await listWorkspaces(accountId)) {
      if (ws.repoIds.length === 0) continue;
      const scope: BotScope = { workspaceId: ws.id, repoIds: ws.repoIds };
      const automatedIds = await automatedReviewerUserIds(accountId, ws.id, 'all');
      if (automatedIds.length === 0) continue;
      for (const prId of await listNullBodyBotPrIds(accountId, scope, automatedIds)) {
        prIds.add(prId);
      }
    }
    if (prIds.size === 0) {
      console.log(`account ${accountId}: no NULL-body bot text — nothing to repair`);
      continue;
    }
    console.log(
      `account ${accountId}: ${prIds.size} PR(s) carry NULL-body bot text ` +
        `(pending ${before.pending}, unscorable ${before.unscorable})`,
    );

    const ids = [...prIds];
    const nameRows = await db
      .select({
        id: pullRequests.id,
        number: pullRequests.number,
        owner: repos.owner,
        name: repos.name,
      })
      .from(pullRequests)
      .innerJoin(repos, eq(repos.id, pullRequests.repoId))
      .where(inArray(pullRequests.id, ids))
      .execute();
    const nameById = new Map(
      nameRows.map((r: { id: number; number: number; owner: string; name: string }) => [
        r.id,
        `${r.owner}/${r.name}#${r.number}`,
      ]),
    );

    let done = 0;
    let repaired = 0;
    let failed = 0;
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const prId = ids[next++];
        if (prId === undefined) return;
        const label = nameById.get(prId) ?? `pr ${prId}`;
        try {
          const updated = await backfillPrNullBodies(prId, accountId);
          done += 1;
          if (updated === null) {
            failed += 1;
            console.warn(`  [${done}/${ids.length}] ${label}: fetch failed — skipped`);
          } else {
            repaired += updated;
            console.log(`  [${done}/${ids.length}] ${label}: +${updated} bodies`);
          }
        } catch (err) {
          done += 1;
          failed += 1;
          console.warn(
            `  [${done}/${ids.length}] ${label}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, ids.length) }, () => worker()),
    );

    const after = await getMlBacklogForAccount(accountId);
    console.log(
      `account ${accountId}: wrote ${repaired} bodies across ${done} PR(s)` +
        (failed > 0 ? ` (${failed} failure(s))` : ''),
    );
    console.log(`  before: pending ${before.pending} · unscorable ${before.unscorable}`);
    console.log(
      `  after:  pending ${after.pending} · unscorable ${after.unscorable} ` +
        '(labels arrive via the enrichment worker / `pnpm ml:enrich`)',
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
