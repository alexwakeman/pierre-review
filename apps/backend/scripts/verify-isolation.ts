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
const { and, eq } = await import('drizzle-orm');

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

// Bulk-resolve bot threads (Phase 3 write path): a review-bot thread on A's PR is resolvable
// by A but INVISIBLE to B — getResolvableBotThreads scopes via the PR→account join.
const [botUser] = await db
  .insert(schema.users)
  .values({ githubLogin: 'coderabbitai', githubNodeId: 'U_cr', isBot: true })
  .returning()
  .execute();
await db
  .insert(schema.reviewThreads)
  .values({
    githubNodeId: 'RT_iso_A',
    prId: A.prId,
    path: 'x.ts',
    line: 1,
    isResolved: false,
    isOutdated: false,
    derivedState: 'likely_addressed',
    originalCommenterId: botUser!.id,
    createdAt: now,
  })
  .execute();
const rbtOwn = await q.getResolvableBotThreads(A.prId, 1);
check(
  'getResolvableBotThreads(A.pr, A) returns the addressed bot thread',
  rbtOwn.length === 1 && rbtOwn[0]!.threadNodeId === 'RT_iso_A',
);
const rbtCross = await q.getResolvableBotThreads(A.prId, 2);
check('getResolvableBotThreads(A.pr, B) leaks nothing (IDOR blocked)', rbtCross.length === 0);

// Scope-wide variant (item 3 "clear the stale-bot backlog"): getResolvableBotThreadsForScope
// generalizes the per-PR getter to the whole account / a repo set. Same PR→account ownership
// join, so A sees its seeded thread and B sees nothing even when handed A's repo ids. The
// threadIds=[] "resolve nothing" landmine is preserved across the scope variant too.
const scopeOwn = await q.getResolvableBotThreadsForScope(1, null);
check(
  'getResolvableBotThreadsForScope(A, null scope) includes A’s seeded bot thread',
  scopeOwn.threads.some((t) => t.threadNodeId === 'RT_iso_A') && scopeOwn.totalEligible >= 1,
);
const scopeCross = await q.getResolvableBotThreadsForScope(2, [A.repoId]);
check(
  'getResolvableBotThreadsForScope(B, A.repo) leaks nothing (IDOR blocked)',
  scopeCross.threads.length === 0 && scopeCross.totalEligible === 0,
);
const scopeEmptySel = await q.getResolvableBotThreadsForScope(1, null, []);
check(
  'getResolvableBotThreadsForScope(A, threadIds=[]) resolves nothing (landmine preserved)',
  scopeEmptySel.threads.length === 0 && scopeEmptySel.totalEligible === 0,
);

// ── Bot-Triage Platform: the bot object, at BOTH grains ─────────────────────────
// `repo_reviewers` (account, repo, author) holds the JUDGEMENT; `account_reviewers`
// (account, author) holds the IDENTITY + price. Both are account-scoped, both are reachable
// from the wire as WRITE surfaces, so both get directional checks here and again below.

// A manual per-repo judgement on account 1 for the bot reviewer (originator of RT_iso_A).
const ovA = await q.setRepoReviewerJudgement(1, botUser!.id, {
  repoId: A.repoId,
  automated: true,
});
check(
  'setRepoReviewerJudgement(A, A.repo, botUser) writes a manual judgement',
  ovA?.source === 'manual' && ovA?.automated === true,
);
// The IDENTITY is a SEPARATE write at a SEPARATE grain — and the judgement above must not have
// touched it (a per-repo write that set kind/label is the exact bug the split exists to kill).
const idA = await q.setReviewerIdentity(1, botUser!.id, {
  kind: 'coderabbit',
  label: 'CodeRabbit',
});
check(
  'setReviewerIdentity(A, botUser) writes the actor-grain identity',
  idA?.kind === 'coderabbit' && idA?.identitySource === 'manual',
);

// listDetectedReviewers is account-scoped: A sees the bot (it originated a thread), B doesn't.
const drA = await q.listDetectedReviewers(1);
check(
  'listDetectedReviewers(A) includes A’s bot reviewer at both grains',
  drA.reviewers.some((r: { userId: number }) => r.userId === botUser!.id) &&
    drA.rows.some(
      (r: { userId: number; repoId: number }) =>
        r.userId === botUser!.id && r.repoId === A.repoId,
    ),
);
const drB = await q.listDetectedReviewers(2);
check(
  "listDetectedReviewers(B) excludes A's reviewer (IDOR blocked)",
  !drB.reviewers.some((r: { userId: number }) => r.userId === botUser!.id) &&
    !drB.rows.some((r: { userId: number }) => r.userId === botUser!.id),
);
// …including when B explicitly NAMES A's repo id. `repoIds` arrives off the wire, so the listing
// INTERSECTS it with the caller's own repos. Without that intersection this is a straight
// cross-tenant read of another account's bot rows — and, because `author_user_id` points at the
// GLOBAL `users` table, of its contributors' logins, display names and avatars.
const drCross = await q.listDetectedReviewers(2, [A.repoId]);
check(
  'listDetectedReviewers(B, repoIds=[A.repo]) leaks nothing (IDOR blocked)',
  drCross.rows.length === 0 && drCross.repoIds.length === 0,
);
check(
  'listDetectedReviewers(A, repoIds=[A.repo]) DOES return A’s row (the scan above is not vacuous)',
  (await q.listDetectedReviewers(1, [A.repoId])).rows.some(
    (r: { userId: number }) => r.userId === botUser!.id,
  ),
);

// ── THE TWO GRAINS MUST NOT REACH EACH OTHER (the whole point of the split) ──────
// A per-repo "not a bot" must not null the ACTOR's vendor kind. That was the shipped bug:
// CodeRabbit detected on three repos, a user clicks "Not a bot" on ONE, identity resolution
// picks that row up, and the vendor loses its brand colour and name on repos nobody touched.
await q.setRepoReviewerJudgement(1, botUser!.id, { repoId: A.repoId, automated: false });
check(
  'a per-repo "not a bot" leaves the ACTOR identity (kind/label) untouched',
  (await q.listDetectedReviewers(1)).reviewers.find(
    (r: { userId: number }) => r.userId === botUser!.id,
  )?.kind === 'coderabbit',
);
// …and the mirror: an identity edit must not restate any repo's judgement.
await q.setReviewerIdentity(1, botUser!.id, { label: 'CodeRabbit (renamed)' });
check(
  'an identity edit leaves the per-repo judgement untouched',
  (await q.listDetectedReviewers(1)).rows.find(
    (r: { userId: number; repoId: number }) =>
      r.userId === botUser!.id && r.repoId === A.repoId,
  )?.automated === false,
);
// Restore the automated verdict for the analytics checks below.
await q.setRepoReviewerJudgement(1, botUser!.id, { repoId: A.repoId, automated: true });

// A judgement write naming ANOTHER tenant's repo must 404 rather than land. The composite FK
// `(repo_id, account_id) → repos(id, account_id)` would also reject it, but a constraint
// violation is a 500 — the query layer's own ownership check is what makes it a 404, and this
// pair is what proves the check exists rather than the FK carrying it.
check(
  'setRepoReviewerJudgement(B, A.repo) returns null (foreign repo → 404)',
  (await q.setRepoReviewerJudgement(2, botUser!.id, {
    repoId: A.repoId,
    automated: false,
  })) === null,
);
const aStill = (await q.listDetectedReviewers(1)).rows.find(
  (r: { userId: number; repoId: number }) => r.userId === botUser!.id && r.repoId === A.repoId,
);
check(
  "account 2's attempted write leaves account 1's judgement intact",
  aStill?.automated === true,
);
// Direct row scan: no repo_reviewers row may exist under account 2 for A's repo.
check(
  'no repo_reviewers row was written for account 2 against A’s repo',
  !(await db.select().from(schema.repoReviewers).execute()).some(
    (r: { accountId: number; repoId: number }) => r.accountId === 2 && r.repoId === A.repoId,
  ),
);
// ⚠ THE CROSS-ACCOUNT CHECKS ABOVE ARE COVERED THREE TIMES OVER (the repo-ownership check, the
// footprint gate, and the composite FK), which makes each one individually unfalsifiable — a
// mutation run removing any single guard still passes. The ANTI-FABRICATION rule is the one this
// pair actually pins, and it is same-account, so no other guard can stand in for it: an actor
// with no review, thread or comment in a repo must not get a row there. It matters because a row
// IS the bot object and the listing is row-driven — a fabricated pair would render a stranger's
// login, display name and avatar (from the GLOBAL `users` table) inside this account's settings.
const [ghostUser] = await db
  .insert(schema.users)
  .values({ githubLogin: 'never-touched-this-repo', githubNodeId: 'U_ghost', isBot: false })
  .returning()
  .execute();
check(
  'setRepoReviewerJudgement(A, A.repo, an actor with NO footprint there) returns null',
  (await q.setRepoReviewerJudgement(1, ghostUser!.id, {
    repoId: A.repoId,
    automated: true,
  })) === null,
);
check(
  'no repo_reviewers row was fabricated for that actor',
  !(await db.select().from(schema.repoReviewers).execute()).some(
    (r: { authorUserId: number }) => r.authorUserId === ghostUser!.id,
  ),
);

// ── THE RESETS ARE WRITES TOO, AND THEY DELETE ──────────────────────────────────
// DELETE /api/bot-reviewers/:userId/judgement?repoId= is the way back to auto for ONE repo row,
// and it is the most dangerous shape in this file: an unscoped DELETE would remove another
// tenant's judgement AND report success. `accountId` is in the predicate, so B matches no row —
// the row scan below is what proves that rather than the return value, which a swallowed write
// would also produce.
check(
  'resetRepoReviewerJudgement(B, A.repo) returns false (foreign row → 404)',
  (await q.resetRepoReviewerJudgement(2, botUser!.id, A.repoId)) === false,
);
check(
  "account 1's judgement row SURVIVED account 2's reset attempt",
  (await db.select().from(schema.repoReviewers).execute()).some(
    (r: { accountId: number; authorUserId: number; repoId: number }) =>
      r.accountId === 1 && r.authorUserId === botUser!.id && r.repoId === A.repoId,
  ),
);
// The positive control, and the anti-vacuity guard for the pair above: the OWNER's reset does
// delete the row.
check(
  'resetRepoReviewerJudgement(A, A.repo) returns true and removes the row',
  (await q.resetRepoReviewerJudgement(1, botUser!.id, A.repoId)) === true &&
    !(await db.select().from(schema.repoReviewers).execute()).some(
      (r: { accountId: number; authorUserId: number; repoId: number }) =>
        r.accountId === 1 && r.authorUserId === botUser!.id && r.repoId === A.repoId,
    ),
);
// …and a reset must not reach the ACTOR grain: the vendor identity written above is still there,
// LABEL INCLUDED (a mutation that nulled only the label slipped past a kind-only assertion).
check(
  'a judgement reset leaves the ACTOR identity (kind AND label) untouched',
  (await db.select().from(schema.accountReviewers).execute()).some(
    (r: {
      accountId: number;
      authorUserId: number;
      kind: string | null;
      label: string | null;
      identitySource: string;
    }) =>
      r.accountId === 1 &&
      r.authorUserId === botUser!.id &&
      r.kind === 'coderabbit' &&
      r.label === 'CodeRabbit (renamed)' &&
      r.identitySource === 'manual',
  ),
);
// Restore the manual automated verdict for the analytics checks below.
await q.setRepoReviewerJudgement(1, botUser!.id, { repoId: A.repoId, automated: true });

// getBotAnalytics is account-scoped: A surfaces the bot's thread; B surfaces nothing.
const anA = await q.getBotAnalytics(1, 'rolling_30');
check(
  'getBotAnalytics(A) surfaces the account-1 bot thread',
  anA.vendors.some((v) => v.kind === 'coderabbit'),
);
const anB = await q.getBotAnalytics(2, 'rolling_30');
check('getBotAnalytics(B) surfaces no vendors (IDOR blocked)', anB.vendors.length === 0);

// getBotVendorPrs (item 6 — the per-REVIEWER drill-down) is account-scoped by the PR join: A's
// owner call surfaces its own bot's PR; the SAME userId under account B leaks nothing (the
// vendor's threads/comments bind pullRequests.accountId, and botUser isn't automated for B).
const vpA = await q.getBotVendorPrs(1, { userId: botUser!.id }, 'rolling_30');
check('getBotVendorPrs(A, botUser) surfaces A’s PR', vpA.prs.some((p) => p.prId === A.prId));
check('getBotVendorPrs(A, botUser) echoes the per-reviewer key', vpA.key === `u${botUser!.id}`);
const vpCross = await q.getBotVendorPrs(2, { userId: botUser!.id }, 'rolling_30');
check('getBotVendorPrs(B, A’s botUser) leaks nothing (IDOR blocked)', vpCross.prs.length === 0);

// getBotOnlyPrs (the caption's expandable list) is account-scoped: the owner call resolves
// its own repos and never contains another account's PR; a cross-account call passing the
// OTHER account's repo ids returns nothing (getBotOnlyReviewPrs binds pullRequests.accountId).
const boA = await q.getBotOnlyPrs(1, 'rolling_30');
check(
  "getBotOnlyPrs(A) returns a list, never B's PR",
  Array.isArray(boA.prs) && !boA.prs.some((p) => p.prId === B.prId),
);
const boCrossA = await q.getBotOnlyPrs(2, 'rolling_30', [A.repoId]);
check('getBotOnlyPrs(B, repoIds=[A.repo]) leaks nothing (IDOR blocked)', boCrossA.prs.length === 0);
const boCrossB = await q.getBotOnlyPrs(1, 'rolling_30', [B.repoId]);
check('getBotOnlyPrs(A, repoIds=[B.repo]) leaks nothing (IDOR blocked)', boCrossB.prs.length === 0);

// getBotDedupClusters: A resolves its PR; B gets null (ownership → 404).
check(
  'getBotDedupClusters(A.pr, A) returns a response',
  (await q.getBotDedupClusters(A.prId, 1)) !== null,
);
check(
  'getBotDedupClusters(A.pr, B) returns null (IDOR blocked)',
  (await q.getBotDedupClusters(A.prId, 2)) === null,
);

// ── Teams (CORE): teams + team_repos are account-scoped; every getter/writer filters
// accountId, and id-addressed mutators verify ownership → false/empty for a foreign team ──
const teamA = await q.createTeam(1, 'Team A');
await q.assignReposToTeam(teamA.id, 1, [A.repoId]);
const teamB = await q.createTeam(2, 'Team B');
await q.assignReposToTeam(teamB.id, 2, [B.repoId]);

const listA = await q.listTeams(1);
check(
  "listTeams(A) returns only A's team, with A's repo",
  listA.length === 1 &&
    listA[0]!.id === teamA.id &&
    listA[0]!.repoIds.length === 1 &&
    listA[0]!.repoIds[0] === A.repoId,
);
check(
  "listTeams(A) excludes B's team",
  !(await q.listTeams(1)).some((t) => t.id === teamB.id),
);
check(
  'getTeamRepoIds(teamA, A) returns A.repo',
  (await q.getTeamRepoIds(teamA.id, 1)).length === 1,
);
check(
  'getTeamRepoIds(teamA, B) leaks nothing (IDOR blocked)',
  (await q.getTeamRepoIds(teamA.id, 2)).length === 0,
);

// B cannot rename / delete / assign into / remove from A's team.
check(
  'renameTeam(teamA, B) returns false (IDOR blocked)',
  (await q.renameTeam(teamA.id, 2, 'hacked')) === false,
);
check(
  "A's team name survives B's rename attempt",
  (await q.listTeams(1))[0]!.name === 'Team A',
);
await q.assignReposToTeam(teamA.id, 2, [B.repoId]);
await q.assignReposToTeam(teamA.id, 2, [A.repoId]);
check(
  "B's assign into A's team is a no-op",
  (await q.getTeamRepoIds(teamA.id, 1)).length === 1 &&
    (await q.getTeamRepoIds(teamA.id, 1))[0] === A.repoId,
);
check(
  'removeRepoFromTeam(teamA, A.repo, B) returns false (IDOR blocked)',
  (await q.removeRepoFromTeam(teamA.id, A.repoId, 2)) === false,
);
check(
  "A.repo survives B's remove attempt",
  (await q.getTeamRepoIds(teamA.id, 1)).length === 1,
);
check(
  'deleteTeam(teamA, B) returns false (IDOR blocked)',
  (await q.deleteTeam(teamA.id, 2)) === false,
);
check("A's team survives B's delete attempt", (await q.listTeams(1)).length === 1);

// resolveScopeRepoIds honours ownership: A resolves its team; B resolving A's team → [].
check(
  "resolveScopeRepoIds(A, '<teamA>') resolves A's repos",
  JSON.stringify(await q.resolveScopeRepoIds(1, String(teamA.id))) ===
    JSON.stringify([A.repoId]),
);
check(
  "resolveScopeRepoIds(B, '<teamA>') leaks nothing (IDOR blocked)",
  (await q.resolveScopeRepoIds(2, String(teamA.id)))!.length === 0,
);
// Multi-team set scope 'teams:<ids>' (the new resolver path) resolves the union of just those
// teams, ownership-scoped: A gets A's repos; B resolving a set that names A's team → [] (IDOR).
check(
  "resolveScopeRepoIds(A, 'teams:<teamA>') resolves A's repos (set path)",
  JSON.stringify(await q.resolveScopeRepoIds(1, `teams:${teamA.id}`)) ===
    JSON.stringify([A.repoId]),
);
check(
  "resolveScopeRepoIds(B, 'teams:<teamA>') leaks nothing (multi-team IDOR blocked)",
  (await q.resolveScopeRepoIds(2, `teams:${teamA.id}`))!.length === 0,
);
check("resolveScopeRepoIds(A, 'all') is null", (await q.resolveScopeRepoIds(1, 'all')) === null);
check(
  "resolveScopeRepoIds(A, 'none') excludes A's assigned repo",
  !(await q.resolveScopeRepoIds(1, 'none'))!.includes(A.repoId),
);
check(
  'getUnassignedRepoIds(A) is empty (A.repo is in a team)',
  (await q.getUnassignedRepoIds(1)).length === 0,
);
// 'teams' scope = the account's UNION of team repos, ownership-scoped (cross-team monitoring).
check(
  "resolveScopeRepoIds(A, 'teams') is A's team-repo union",
  JSON.stringify(await q.resolveScopeRepoIds(1, 'teams')) === JSON.stringify([A.repoId]),
);
check(
  "resolveScopeRepoIds(B, 'teams') is B's own union only (no A leak)",
  JSON.stringify(await q.resolveScopeRepoIds(2, 'teams')) === JSON.stringify([B.repoId]),
);

// getTeamComparison selects TEAMS, not repo ids, so it does NOT go through resolveScopeRepoIds
// above — it owns its own scope parser and its own `listTeams(accountId)` filter. That makes it a
// separate ownership surface that the checks above do not cover, and it is CORE/free (reachable
// from the Feed's "Compare teams" tab by every tier), so it gets its own pair here.
// Landmine: teamB must already exist, or the negative check passes on an empty account and is
// VACUOUS. It is seeded at the top of this block — do not reorder.
const { getTeamComparisonRows } = await import('../src/db/team-comparison.js');
check(
  "getTeamComparisonRows(A, 'teams:<teamA>') returns A's own team",
  (await getTeamComparisonRows(1, `teams:${teamA.id}`)).length === 1,
);
check(
  "getTeamComparisonRows(B, 'teams:<teamA>') leaks nothing (IDOR blocked)",
  (await getTeamComparisonRows(2, `teams:${teamA.id}`)).length === 0,
);
check(
  "getTeamComparisonRows(B, 'all') returns only B's own teams",
  (await getTeamComparisonRows(2, 'all')).every((r) => r.teamId === teamB.id),
);

// ── The ACTOR grain: `account_reviewers` (migration 0043) ───────────────────────
// This table is keyed (account_id, author_user_id) ONLY. It has no repo column, so it carries
// NO structural tenancy at all — unlike `repo_reviewers`, whose composite FK
// `(repo_id, account_id) → repos(id, account_id)` rejects a cross-account row in the database
// itself. Everything that stops one tenant writing (or reading back) another's reviewer identity
// and PRICE is the query layer, and this block is the only thing checking it.
//
// THE GATE IS "does this actor have a repo_reviewers row in THIS account". It is not a formality:
// `author_user_id` points at the GLOBAL `users` table, so an ungated identity write plus a read
// back through the listing would be a cross-tenant profile lookup — the same shape
// `listUsers(accountId)` and the counts-only `/api/users/:id/stats` exist to prevent. It is also
// what keeps the data reachable: the listing is row-driven, so an identity keyed to an actor with
// no rows could never be displayed, edited or cleared.
//
// MUTATION-CHECK (per the standing note that a new isolation check can be VACUOUS): every
// negative below would also pass if the write silently did nothing, so each is paired with a
// POSITIVE control — the same call from the OWNING account must succeed — plus a direct row scan
// proving nothing landed under the other tenant's id.
//
// `soloUser` is an actor account 2 has NEVER synced. Account 2 owns a repo, so it passes every
// account-level check; the only thing standing between it and an identity row for a stranger is
// the repo-row gate.
const [soloUser] = await db
  .insert(schema.users)
  .values({ githubLogin: 'stranger-bot', githubNodeId: 'U_stranger', isBot: true })
  .returning()
  .execute();

check(
  'setReviewerIdentity(B, A’s botUser) returns null (no repo row in B → 404)',
  (await q.setReviewerIdentity(2, botUser!.id, { kind: 'greptile' })) === null,
);
check(
  'setReviewerIdentity(B, an actor B never synced) returns null (no repo row → 404)',
  (await q.setReviewerIdentity(2, soloUser!.id, { kind: 'greptile' })) === null,
);
check(
  'setReviewerIdentity(A, A’s botUser) succeeds (positive control — the 404s are about the gate)',
  (await q.setReviewerIdentity(1, botUser!.id, { kind: 'coderabbit' })) !== null,
);
check(
  'no account_reviewers row was written under account 2',
  !(await db.select().from(schema.accountReviewers).execute()).some(
    (r: { accountId: number }) => r.accountId === 2,
  ),
);
check(
  'A’s own identity row WAS written (the scan above is not vacuous)',
  (await db.select().from(schema.accountReviewers).execute()).some(
    (r: { accountId: number; authorUserId: number }) =>
      r.accountId === 1 && r.authorUserId === botUser!.id,
  ),
);

// ── THE IDENTITY RESET TAKES THE SAME GATE ──────────────────────────────────────
// DELETE /api/bot-reviewers/:userId/identity hands `kind`/`label` back to detection ACCOUNT-WIDE.
// Ungated it would be a write against a row keyed to an actor the caller has never synced — and,
// since `author_user_id` points at the GLOBAL `users` table, a read back of a stranger's profile.
// Snapshot BEFORE the rejected attempts — comparing two reads taken after them would assert
// nothing at all.
const idRowsBeforeReset = JSON.stringify(
  await db.select().from(schema.accountReviewers).execute(),
);
check(
  'resetReviewerIdentity(B, A’s botUser) returns null (no repo row in B → 404)',
  (await q.resetReviewerIdentity(2, botUser!.id)) === null,
);
check(
  'resetReviewerIdentity(B, an actor B never synced) returns null (no repo row → 404)',
  (await q.resetReviewerIdentity(2, soloUser!.id)) === null,
);
check(
  "account 2's reset attempts changed NO account_reviewers row",
  idRowsBeforeReset ===
    JSON.stringify(await db.select().from(schema.accountReviewers).execute()),
);
// ⚠ DIRTY A'S REPO ROW TO A NON-MANUAL, NON-DERIVED STATE FIRST, or the "left the judgement
// untouched" check below is vacuous twice over: a `source: 'manual'` row is skipped by the
// classifier anyway, and an identical rewrite is invisible because sqlite stores `updated_at` at
// one-second granularity. MEASURED: a mutation handing the re-derivation the actor's real repo
// ids (i.e. the identity reset reaching into the judgement grain) survived until this existed.
await db
  .update(schema.repoReviewers)
  .set({ automated: false, role: 'quality_check', source: 'behavioral' })
  .where(
    and(
      eq(schema.repoReviewers.accountId, 1),
      eq(schema.repoReviewers.authorUserId, botUser!.id),
      eq(schema.repoReviewers.repoId, A.repoId),
    ),
  )
  .execute();

// Positive control — and it must come back AUTO-DERIVED, not merely blanked: the classifier is
// re-run identity-only (empty repo list) inside the reset, so the vendor's own label returns in
// place of the human's 'CodeRabbit (renamed)'.
const resetA = await q.resetReviewerIdentity(1, botUser!.id);
check(
  'resetReviewerIdentity(A, A’s botUser) re-derives the vendor and hands provenance back to auto',
  resetA?.identitySource === 'auto' &&
    resetA?.kind === 'coderabbit' &&
    resetA?.label === 'CodeRabbit',
);
// …and it touched NO repo row (the re-derivation runs with an empty repo list by construction).
// The row must still carry the DIRTIED values above — a re-derivation would have put them back to
// automated/review/github_type, which is exactly what makes this check falsifiable.
check(
  'the identity reset left A’s per-repo judgement untouched',
  (await db.select().from(schema.repoReviewers).execute()).some(
    (r: {
      accountId: number;
      authorUserId: number;
      repoId: number;
      automated: boolean;
      role: string;
      source: string;
    }) =>
      r.accountId === 1 &&
      r.authorUserId === botUser!.id &&
      r.repoId === A.repoId &&
      r.automated === false &&
      r.role === 'quality_check' &&
      r.source === 'behavioral',
  ),
);
// Restore the automated verdict — later checks in this file read the bot roster.
await q.setRepoReviewerJudgement(1, botUser!.id, { repoId: A.repoId, automated: true });

// ── COST takes the SAME gate, and it is a separate route ────────────────────────
// A price is an actor-grain fact on the same row, but a different write. Gating one and not the
// other is exactly the kind of half-implementation this refactor exists to remove.
check(
  'setReviewerCost(B, A’s botUser) returns null (no repo row in B → 404)',
  (await q.setReviewerCost(2, botUser!.id, 99)) === null,
);
check(
  'setReviewerCost(A, A’s botUser) succeeds (positive control)',
  (await q.setReviewerCost(1, botUser!.id, 99)) !== null,
);
const costRows = await db.select().from(schema.accountReviewers).execute();
check(
  'the price landed on A’s own row and nothing was written under account 2',
  costRows.some(
    (r: { accountId: number; authorUserId: number; monthlyCents: number | null }) =>
      r.accountId === 1 && r.authorUserId === botUser!.id && r.monthlyCents === 9900,
  ) && !costRows.some((r: { accountId: number }) => r.accountId === 2),
);
// The int4 CLAMP. Unbounded, Postgres RAISES `integer out of range` (a 500) while SQLite's
// 64-bit integers accept the value happily — the same request succeeding locally and 500ing in
// cloud is the divergence class this is here to keep closed.
check(
  'setReviewerCost clamps to the int4 cents ceiling (no dialect divergence)',
  (await q.setReviewerCost(1, botUser!.id, 99_999_999_999))?.costMonthlyUsd === 21474836.47,
);
check(
  'setReviewerCost(null) clears the price without deleting the identity row',
  (await q.setReviewerCost(1, botUser!.id, null))?.costMonthlyUsd === null &&
    (await q.setReviewerCost(1, botUser!.id, null))?.kind === 'coderabbit',
);
// 0 is a REAL price ("we pay nothing"), not "unset" — a `||` anywhere on this path collapses it.
check(
  'setReviewerCost(0) stores a real zero, distinct from null',
  (await q.setReviewerCost(1, botUser!.id, 0))?.costMonthlyUsd === 0,
);

// Owner delete cascades team_repos (functional sanity, not IDOR). Note what is NOT here any
// more: deleting a team used to have to hand-delete its bot classification rows, because
// `bot_review_classification.team_id` carried no FK. A bot is a per-repo object now, so a team
// owns no bot state at all and there is nothing to clean up.
check('deleteTeam(teamA, A) returns true', (await q.deleteTeam(teamA.id, 1)) === true);
check(
  "teamA's membership is gone after delete (cascade)",
  (await q.getTeamRepoIds(teamA.id, 1)).length === 0,
);

// Cross-org benchmark contributions (Phase 0): the consent roster respects the opt-in flag +
// excludes local accounts, and WITHDRAWAL (delete) is account-scoped — it must never touch
// another tenant's contributions.
await db
  .update(accounts)
  .set({ benchmarkOptIn: true })
  .where(eq(accounts.id, 2))
  .execute();
const optedIds = await q.getBenchmarkOptedInAccountIds();
check('getBenchmarkOptedInAccountIds includes opted-in non-local (B)', optedIds.includes(2));
check('getBenchmarkOptedInAccountIds excludes non-opted (A)', !optedIds.includes(1));
await db
  .insert(schema.benchmarkContributions)
  .values([
    { accountId: 1, vendorKind: 'coderabbit', weekStart: now, orgSizeBucket: '1' },
    { accountId: 2, vendorKind: 'coderabbit', weekStart: now, orgSizeBucket: '1' },
  ])
  .execute();
await q.deleteBenchmarkContributions(1);
const remainingContrib = await db.select().from(schema.benchmarkContributions).execute();
check(
  "deleteBenchmarkContributions(A) leaves B's contributions untouched (IDOR blocked)",
  remainingContrib.length === 1 && remainingContrib[0]!.accountId === 2,
);

// ── Cross-team text search (search_index is accountId-denormalized) ─────────────
// Seed a search row for each account's PR sharing a common token; searchPrs must return only the
// caller's rows and leak nothing even when B is handed A's repo id.
const { searchPrs } = await import('../src/db/search.js');
await db
  .insert(schema.searchIndex)
  .values([
    { accountId: 1, repoId: A.repoId, prId: A.prId, kind: 'pr', refId: A.prId, body: 'isolationsearchtoken alpha payload', createdAt: now },
    { accountId: 2, repoId: B.repoId, prId: B.prId, kind: 'pr', refId: B.prId, body: 'isolationsearchtoken beta payload', createdAt: now },
  ])
  .execute();
const searchOwn = await searchPrs(1, { query: 'isolationsearchtoken', repoIds: null, limit: 50, offset: 0 });
check(
  'searchPrs(A) returns only A’s hits',
  searchOwn.total === 1 && searchOwn.hits.every((h) => h.repoId === A.repoId && h.prId === A.prId),
);
check('searchPrs(A) excludes B’s hits', !searchOwn.hits.some((h) => h.repoId === B.repoId));
const searchCross = await searchPrs(2, { query: 'isolationsearchtoken', repoIds: [A.repoId], limit: 50, offset: 0 });
check(
  'searchPrs(B, repoIds=[A.repo]) leaks nothing (IDOR blocked)',
  searchCross.total === 0 && searchCross.hits.length === 0,
);

// ── Per-user contribution stats (getUserStats) ─────────────────────────────────
// `users` is a GLOBAL table, so the user id alone must grant nothing: every count binds
// pullRequests.accountId (PRs directly; reviews/comments through their parent PR). Seed a
// contributor who authored A's PR and reviewed it, then assert B asking about the SAME
// user id gets all zeros — the cross-account IDOR this route would otherwise open.
const [contributor] = await db
  .insert(schema.users)
  .values({ githubLogin: 'contrib-iso', githubNodeId: 'U_contrib', isBot: false })
  .returning()
  .execute();
await db
  .update(pullRequests)
  .set({ authorId: contributor!.id })
  .where(eq(pullRequests.id, A.prId))
  .execute();
await db
  .insert(schema.reviews)
  .values({
    githubNodeId: 'RV_iso_A',
    prId: A.prId,
    authorId: contributor!.id,
    state: 'approved',
    submittedAt: now,
  })
  .execute();
await db
  .insert(schema.prComments)
  .values({
    githubNodeId: 'PC_iso_A',
    prId: A.prId,
    authorId: contributor!.id,
    body: 'iso',
    createdAt: now,
  })
  .execute();
// An INLINE review comment too, not just the issue-level one. `comments` sums two sources,
// and reviewComments reaches its tenant the most indirectly of the four queries — without a
// row here, deleting its accountId predicate would leave this suite green (the cross-account
// assertion below would still see 0 because there was nothing to leak). Seeding it, and
// asserting comments === 2, is what actually binds that predicate.
const [isoThread] = await db
  .select({ id: schema.reviewThreads.id })
  .from(schema.reviewThreads)
  .where(eq(schema.reviewThreads.githubNodeId, 'RT_iso_A'))
  .limit(1)
  .execute();
await db
  .insert(schema.reviewComments)
  .values({
    githubNodeId: 'RC_iso_A',
    threadId: isoThread!.id,
    prId: A.prId,
    authorId: contributor!.id,
    body: 'iso inline',
    createdAt: now,
  })
  .execute();
const usOwn = await q.getUserStats(1, contributor!.id);
check(
  'getUserStats(A, contributor) counts A’s PR + review + both comment sources',
  usOwn.prsOpen === 1 && usOwn.reviewsGiven === 1 && usOwn.comments === 2,
);
const usCross = await q.getUserStats(2, contributor!.id);
check(
  'getUserStats(B, A’s contributor) returns all zeros (IDOR blocked)',
  usCross.prsOpen === 0 &&
    usCross.prsMerged === 0 &&
    usCross.prsDraft === 0 &&
    usCross.prsClosed === 0 &&
    usCross.reviewsGiven === 0 &&
    usCross.comments === 0,
);
const usCrossRepo = await q.getUserStats(2, contributor!.id, [A.repoId]);
check(
  'getUserStats(B, repoIds=[A.repo]) leaks nothing (IDOR blocked)',
  usCrossRepo.prsOpen === 0 && usCrossRepo.reviewsGiven === 0 && usCrossRepo.comments === 0,
);
check(
  'getUserStats(A, repoIds=[]) short-circuits to zeros',
  (await q.getUserStats(1, contributor!.id, [])).prsOpen === 0,
);

// ── The posted-review-comment confirmation read (findPostedReviewComment) ───────
// This one lives in `sync/resync-after-write.ts`, not `db/queries.ts`, because it is the tail of
// a WRITE route rather than a read surface — which is exactly why it has to be named here: this
// script is the project's IDOR guarantee and it only walks the query layer, so an id-addressed
// read that sits outside that file is invisible to it unless imported explicitly. It is
// id-addressed twice over (a prId AND a GitHub comment id), reaches its tenant the long way
// round (reviewComments → pullRequests → repos.accountId), and its answer is what the route
// reports back as "your comment is visible", so a missing predicate would let one account
// confirm — and learn the local thread id of — another account's inline comment.
//
// `RC_iso_A` was seeded above on A's PR, so both directions have something real to find.
const { findPostedReviewComment } = await import('../src/sync/resync-after-write.js');
const rcOwn = await findPostedReviewComment(A.prId, 1, 'nonexistent-db-id', 'RC_iso_A');
check(
  'findPostedReviewComment(A, A’s comment) finds it by node id',
  rcOwn != null && rcOwn.threadId === isoThread!.id,
);
const rcCross = await findPostedReviewComment(A.prId, 2, 'nonexistent-db-id', 'RC_iso_A');
check('findPostedReviewComment(B, A’s comment) returns null (IDOR blocked)', rcCross === null);

console.log(`\nISOLATION: ${pass} passed, ${fail} failed`);
await closeDb();
process.exit(fail === 0 ? 0 : 1);
