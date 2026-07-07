// Cross-account IDOR isolation check (query-layer; no HTTP/OAuth needed).
//
// Seeds TWO accounts each owning a repo + PR + event, then asserts every
// account-scoped reader only returns the caller's data and every id-addressed
// getter returns null/false for another account's resources. This is the
// load-bearing multi-tenancy guarantee for cloud mode.
//
// Run against a throwaway sqlite DB (never your real one):
//   DATABASE_URL=/tmp/pierre-iso.sqlite DISABLE_SCHEDULER=true \
//     pnpm --filter @pierre-review/backend exec tsx scripts/verify-isolation.ts
import { rmSync } from 'node:fs';
import { config } from '../src/config.js';

if (!config.dbPath || config.dbPath.includes('pierre-review.sqlite')) {
  console.error(
    'Refusing to run: set DATABASE_URL to a throwaway path (not the real DB).',
  );
  process.exit(1);
}
// Delete any stale DB BEFORE importing client.ts — it opens the connection at
// module load, so importing it first would leave us deleting an open file.
for (const suffix of ['', '-shm', '-wal']) {
  rmSync(config.dbPath + suffix, { force: true });
}

const { runMigrations } = await import('../src/db/run-migrations.js');
const { closeDb, db, schema } = await import('../src/db/client.js');
const q = await import('../src/db/queries.js');
const { eq } = await import('drizzle-orm');

await runMigrations();

const now = new Date();
const { accounts, repos, pullRequests, events } = schema;

// account 1 is seeded by migration 0008 (placeholder local account); add #2.
await db
  .insert(accounts)
  .values({ id: 2, githubUserId: 'U_b', githubLogin: 'bob', isLocal: false })
  .execute();

async function seed(accountId: number, tag: string) {
  const [repo] = await db
    .insert(repos)
    .values({ accountId, owner: `org${tag}`, name: `repo${tag}`, githubNodeId: `R_${tag}` })
    .returning()
    .execute();
  const [pr] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: `PR_${tag}`,
      accountId,
      repoId: repo!.id,
      number: 1,
      title: `PR for ${tag}`,
      state: 'open',
      isDraft: false,
      openedAt: now,
      updatedAt: now,
    })
    .returning()
    .execute();
  await db
    .insert(events)
    .values({
      accountId,
      repoId: repo!.id,
      prId: pr!.id,
      type: 'pr_opened',
      occurredAt: now,
      dedupeKey: `pr_opened:PR_${tag}`,
    })
    .execute();
  return { repoId: repo!.id, prId: pr!.id, nodeId: `R_${tag}` };
}

const A = await seed(1, 'A');
const B = await seed(2, 'B');

const from = new Date(now.getTime() - 30 * 86_400_000);
const to = new Date(now.getTime() + 86_400_000);
const win = {
  from,
  to,
  repoIds: null,
  userIds: null,
  types: null,
  statuses: null,
  reviewStates: null,
  excludeBots: false,
  excludeStale: false,
};

let pass = 0;
let fail = 0;
const check = (label: string, cond: boolean): void => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${label}`);
  }
};

const tlA = await q.getTimeline({ accountId: 1, ...win });
const tlB = await q.getTimeline({ accountId: 2, ...win });
check("getTimeline(A) returns only A's PR", tlA.prs.length === 1 && tlA.prs[0]!.id === A.prId);
check("getTimeline(A) returns only A's events", tlA.events.every((e) => e.prId === A.prId));
check("getTimeline(B) returns only B's PR", tlB.prs.length === 1 && tlB.prs[0]!.id === B.prId);
check("getTimeline(A) excludes B's PR", !tlA.prs.some((p) => p.id === B.prId));

// pr-focus tab path: prIds returns exactly the requested PR (+ its events) for the owner,
// and leaks nothing when the id belongs to another account (the accountId scope still binds).
const tlAown = await q.getTimeline({ accountId: 1, ...win, prIds: [A.prId] });
check(
  'getTimeline(A, prIds=[A.pr]) returns exactly A.pr',
  tlAown.prs.length === 1 && tlAown.prs[0]!.id === A.prId,
);
const tlAcross = await q.getTimeline({ accountId: 1, ...win, prIds: [B.prId] });
check(
  'getTimeline(A, prIds=[B.pr]) leaks nothing (IDOR blocked)',
  tlAcross.prs.length === 0 && tlAcross.events.length === 0,
);

const opA = await q.getOpenPrs({ accountId: 1, repoIds: null, userIds: null });
check("getOpenPrs(A) returns only A's open PR", opA.length === 1 && opA[0]!.id === A.prId);
const opCross = await q.getOpenPrs({ accountId: 1, repoIds: [B.repoId], userIds: null });
check('getOpenPrs(A, repoIds=[B.repo]) leaks nothing', opCross.length === 0);

const reposA = await q.listRepos(1);
check("listRepos(A) returns only A's repo", reposA.length === 1 && reposA[0]!.id === A.repoId);
const nodesA = await q.getWatchedRepoNodeIds(1);
check("getWatchedRepoNodeIds(A) excludes B's node", nodesA.has(A.nodeId) && !nodesA.has(B.nodeId));

check('getPrDetail(A.pr, A) returns the PR', (await q.getPrDetail(A.prId, 1))?.id === A.prId);
check('getPrDetail(B.pr, A) returns null (IDOR blocked)', (await q.getPrDetail(B.prId, 1)) === null);

check(
  'getMentionCandidates(A.pr, A) returns candidates',
  Array.isArray(await q.getMentionCandidates(A.prId, 1)),
);
check(
  'getMentionCandidates(B.pr, A) returns null (IDOR blocked)',
  (await q.getMentionCandidates(B.prId, 1)) === null,
);

check('markPrViewed(A.pr, A) succeeds', (await q.markPrViewed(A.prId, 1)) === true);
check('markPrViewed(B.pr, A) returns false (IDOR blocked)', (await q.markPrViewed(B.prId, 1)) === false);

check(
  'getRepoAnalytics(A.repo, A) returns the repo',
  (await q.getRepoAnalytics(1, A.repoId))?.repoId === A.repoId,
);
check(
  'getRepoAnalytics(B.repo, A) returns null (IDOR blocked)',
  (await q.getRepoAnalytics(1, B.repoId)) === null,
);

const mergersA = await q.getMergers(1);
check("getMergers(A) excludes B's repo", !mergersA.some((m) => m.repoId === B.repoId));

// Activity Feed: watch both repos, then each account's feed must contain only its own
// watched-repo events (cross-account IDOR).
await db.update(repos).set({ inboxWatch: true }).where(eq(repos.id, A.repoId)).execute();
await db.update(repos).set({ inboxWatch: true }).where(eq(repos.id, B.repoId)).execute();
const feedA = await q.getFeed(1, { daysBefore: 14, watchedOnly: true });
check(
  "getFeed(A) returns only A's events",
  feedA.events.length === 1 && feedA.events[0]!.prId === A.prId,
);
check("getFeed(A) excludes B's events", !feedA.events.some((e) => e.repoId === B.repoId));

// Activity aggregate: each account's activity console must contain only its own repos.
const activityB = await q.getActivity(2, null);
check(
  "getActivity(B) returns only B's repo",
  activityB.repos.length === 1 && activityB.repos[0]!.repoId === B.repoId,
);
check(
  "getActivity(B) excludes A's repo",
  !activityB.repos.some((r) => r.repoId === A.repoId),
);
const activityCross = await q.getActivity(2, [A.repoId]);
check(
  "getActivity(B, repoIds=[A.repo]) leaks nothing",
  !activityCross.repos.some((r) => r.repoId === A.repoId),
);

// Consolidated Feed: A's stream must reference only A's repos/PRs (it composes
// getMyTurn + getFeed + the unresolved-threads reader, all accountId-scoped).
const cfA = await q.getConsolidatedFeed(1);
check(
  "getConsolidatedFeed(A) references only A's repos",
  !cfA.items.some((i) => i.repoId === B.repoId || i.prId === B.prId),
);

// Repo-scoped Claude reviews: B cannot read A's repo's reviews (IDOR blocked).
const crCross = await q.listClaudeReviewsByRepo(A.repoId, 2);
check('listClaudeReviewsByRepo(A.repo, B) leaks no PRs', crCross.prs.length === 0);

check('deleteRepo(B.repo, A) returns false (IDOR blocked)', (await q.deleteRepo(B.repoId, 1)) === false);
check("B's repo survives A's delete attempt", (await q.listRepos(2)).length === 1);

console.log(`\nISOLATION: ${pass} passed, ${fail} failed`);
await closeDb();
process.exit(fail === 0 ? 0 : 1);
