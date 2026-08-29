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
const { and, eq, inArray } = await import('drizzle-orm');

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

// ── WORKSPACES MUST EXIST BEFORE ANYTHING SCOPED RUNS ───────────────────────────
// ⚠ THE SCRIPT INSERTS ITS ACCOUNTS DIRECTLY, AFTER MIGRATING AN EMPTY DB, so migration 0044's
// Default backfill (which walks the accounts that existed at migration time) never sees them and
// neither account gets a Default workspace. Without this call half the assertions below would be
// asserting over an account with NO workspace at all — every listing empty, every write a no-op,
// every negative check passing for the wrong reason. It is the single largest vacuity risk in
// this file.
const defaultA = await q.ensureDefaultWorkspace(1);
const defaultB = await q.ensureDefaultWorkspace(2);
// The membership repair is what puts the seeded repos INTO those workspaces (they were inserted
// straight into `repos`, bypassing upsertRepo's in-transaction membership insert). Every scoped
// read below resolves through it, so run it once up front rather than relying on a side effect.
await q.ensureRepoMemberships(1);
await q.ensureRepoMemberships(2);
// The scope object every bot getter now takes: `workspaceId` decides who counts as a bot,
// `repoIds` narrows which data is measured.
const scopeA = await q.resolveWorkspaceScope(1, defaultA);
const scopeB = await q.resolveWorkspaceScope(2, defaultB);

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

const tlA = await q.getTimeline({ accountId: 1, workspaceId: scopeA.workspaceId, ...win });
const tlB = await q.getTimeline({ accountId: 2, workspaceId: scopeB.workspaceId, ...win });
check("getTimeline(A) returns only A's PR", tlA.prs.length === 1 && tlA.prs[0]!.id === A.prId);
check("getTimeline(A) returns only A's events", tlA.events.every((e) => e.prId === A.prId));
check("getTimeline(B) returns only B's PR", tlB.prs.length === 1 && tlB.prs[0]!.id === B.prId);
check("getTimeline(A) excludes B's PR", !tlA.prs.some((p) => p.id === B.prId));

// pr-focus tab path: prIds returns exactly the requested PR (+ its events) for the owner,
// and leaks nothing when the id belongs to another account (the accountId scope still binds).
const tlAown = await q.getTimeline({
  accountId: 1,
  workspaceId: scopeA.workspaceId,
  ...win,
  prIds: [A.prId],
});
check(
  'getTimeline(A, prIds=[A.pr]) returns exactly A.pr',
  tlAown.prs.length === 1 && tlAown.prs[0]!.id === A.prId,
);
const tlAcross = await q.getTimeline({
  accountId: 1,
  workspaceId: scopeA.workspaceId,
  ...win,
  prIds: [B.prId],
});
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
const nodesA = await q.getAddedRepoNodeIds(1);
check("getAddedRepoNodeIds(A) excludes B's node", nodesA.has(A.nodeId) && !nodesA.has(B.nodeId));

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

// Activity Feed: each account's feed must contain only its own events (cross-account IDOR).
//
// This used to flip `inboxWatch: true` on BOTH repos first, because `getFeed` took a
// `watchedOnly` flag and would otherwise have returned nothing — which would have made the
// "excludes B's events" check pass VACUOUSLY, for the wrong reason. That axis is gone: every
// repo of an account is live, so both repos' events are in scope by construction and the only
// thing that can be excluding B's row here is the accountId predicate.
const feedA = await q.getFeed(1, { daysBefore: 14 });
check(
  "getFeed(A) returns only A's events",
  feedA.events.length === 1 && feedA.events[0]!.prId === A.prId,
);
check("getFeed(A) excludes B's events", !feedA.events.some((e) => e.repoId === B.repoId));

// Activity aggregate: each account's activity console must contain only its own repos.
const activityB = await q.getActivity(2, scopeB);
check(
  "getActivity(B) returns only B's repo",
  activityB.repos.length === 1 && activityB.repos[0]!.repoId === B.repoId,
);
check(
  "getActivity(B) excludes A's repo",
  !activityB.repos.some((r) => r.repoId === A.repoId),
);
// The transposed scope again: B's own workspace, narrowed to A's repo id off the wire.
const activityCross = await q.getActivity(2, { workspaceId: defaultB, repoIds: [A.repoId] });
check(
  "getActivity(B, repoIds=[A.repo]) leaks nothing",
  !activityCross.repos.some((r) => r.repoId === A.repoId),
);

// Consolidated Feed: A's stream must reference only A's repos/PRs (it composes
// getMyTurn + getFeed + the unresolved-threads reader, all accountId-scoped).
const cfA = await q.getConsolidatedFeed(1, { workspaceId: defaultA });
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
// generalizes the per-PR getter to a whole workspace. Same PR→account ownership join, so A sees
// its seeded thread and B sees nothing even when handed A's repo ids. The threadIds=[] "resolve
// nothing" landmine is preserved across the scope variant too.
const scopeOwn = await q.getResolvableBotThreadsForScope(1, scopeA);
check(
  'getResolvableBotThreadsForScope(A, A’s workspace) includes A’s seeded bot thread',
  scopeOwn.threads.some((t) => t.threadNodeId === 'RT_iso_A') && scopeOwn.totalEligible >= 1,
);
// The transposed scope: account B's OWN workspace, narrowed to A's repo id. `repoIds` arrives off
// the wire, so this is exactly the shape a hand-edited URL produces.
const scopeCross = await q.getResolvableBotThreadsForScope(2, {
  workspaceId: defaultB,
  repoIds: [A.repoId],
});
check(
  'getResolvableBotThreadsForScope(B, A.repo) leaks nothing (IDOR blocked)',
  scopeCross.threads.length === 0 && scopeCross.totalEligible === 0,
);
const scopeEmptySel = await q.getResolvableBotThreadsForScope(1, scopeA, []);
check(
  'getResolvableBotThreadsForScope(A, threadIds=[]) resolves nothing (landmine preserved)',
  scopeEmptySel.threads.length === 0 && scopeEmptySel.totalEligible === 0,
);

// ── THE BOT OBJECT: `workspace_reviewers`, ONE row per (account, workspace, actor) ───────────
// The 0042/0043 two-table split is GONE: judgement, vendor identity and price now share a row.
// That removes a table boundary which used to make "a judgement write cannot touch identity" a
// database fact, so everything below tests it as CODE DISCIPLINE instead — which is precisely why
// each pair is written out rather than assumed.
//
// `workspaceId` arrives in a REQUEST BODY, so it is a first-class attack surface: every write is
// probed in BOTH directions (a foreign workspace id, and a foreign actor).

// Read a stored row directly. Reading the RETURN VALUE of the write under test would prove only
// that the function returns what it says it wrote; the row scan is what proves what landed.
async function reviewerRow(
  accountId: number,
  workspaceId: number,
  userId: number,
): Promise<Record<string, unknown> | undefined> {
  const rows = await db.select().from(schema.workspaceReviewers).execute();
  return (rows as Record<string, unknown>[]).find(
    (r) =>
      r.accountId === accountId && r.workspaceId === workspaceId && r.authorUserId === userId,
  );
}

// A manual judgement on account 1 for the bot reviewer (originator of RT_iso_A).
const ovA = await q.setWorkspaceReviewer(1, botUser!.id, {
  workspaceId: defaultA,
  automated: true,
});
check(
  'setWorkspaceReviewer(A, A’s workspace, botUser) writes a manual judgement',
  ovA?.source === 'manual' && ovA?.automated === true,
);
// A judgement-only patch must NOT stamp the identity provenance flag. With one table this is the
// only thing left separating "not a bot here" from "un-name the vendor".
check(
  'the judgement write left identity provenance on auto',
  ovA?.identitySource === 'auto',
);
const idA = await q.setWorkspaceReviewer(1, botUser!.id, {
  workspaceId: defaultA,
  kind: 'coderabbit',
  label: 'CodeRabbit',
});
check(
  'setWorkspaceReviewer(A, kind/label) writes the identity and stamps identitySource manual',
  idA?.kind === 'coderabbit' && idA?.identitySource === 'manual',
);
check(
  'the identity write left the judgement provenance manual and automated true',
  idA?.source === 'manual' && idA?.automated === true,
);

// listDetectedReviewers is workspace-scoped: A sees the bot (it originated a thread), B doesn't.
const drA = await q.listDetectedReviewers(1, scopeA);
check(
  'listDetectedReviewers(A) includes A’s bot reviewer and echoes the resolved workspace',
  drA.reviewers.some((r: { userId: number }) => r.userId === botUser!.id) &&
    drA.workspaceId === defaultA,
);
const drB = await q.listDetectedReviewers(2, scopeB);
check(
  "listDetectedReviewers(B) excludes A's reviewer (IDOR blocked)",
  !drB.reviewers.some((r: { userId: number }) => r.userId === botUser!.id),
);
// …including when B explicitly NAMES A's repo id. `repoIds` arrives off the wire, so the scope is
// intersected with the WORKSPACE's membership. Without that intersection this is a straight
// cross-tenant read of another account's bot rows — and, because `author_user_id` points at the
// GLOBAL `users` table, of its contributors' logins, display names and avatars.
const drCross = await q.listDetectedReviewers(2, {
  workspaceId: defaultB,
  repoIds: [A.repoId],
});
check(
  'listDetectedReviewers(B, repoIds=[A.repo]) leaks nothing (IDOR blocked)',
  drCross.reviewers.length === 0 && drCross.repoIds.length === 0,
);
check(
  'listDetectedReviewers(A, repoIds=[A.repo]) DOES return A’s reviewer (the scan above is not vacuous)',
  (
    await q.listDetectedReviewers(1, { workspaceId: defaultA, repoIds: [A.repoId] })
  ).reviewers.some((r: { userId: number }) => r.userId === botUser!.id),
);

// ── THE TWO PROVENANCE FLAGS MUST NOT REACH EACH OTHER ──────────────────────────
// A "not a bot" must not null the vendor kind. That WAS the shipped bug behind the old two-table
// split, and the merged row can no longer prevent it with a constraint — only the narrowed `set:`
// object can, so it is asserted on the stored row.
await q.setWorkspaceReviewer(1, botUser!.id, { workspaceId: defaultA, automated: false });
const afterNotBot = await reviewerRow(1, defaultA, botUser!.id);
check(
  'a "not a bot" judgement leaves kind, label AND identitySource untouched',
  afterNotBot?.automated === false &&
    afterNotBot?.kind === 'coderabbit' &&
    afterNotBot?.label === 'CodeRabbit' &&
    afterNotBot?.identitySource === 'manual',
);
// …and the mirror: an identity edit must not restate the judgement.
await q.setWorkspaceReviewer(1, botUser!.id, {
  workspaceId: defaultA,
  label: 'CodeRabbit (renamed)',
});
const afterRename = await reviewerRow(1, defaultA, botUser!.id);
check(
  'an identity edit leaves automated/role/source untouched',
  afterRename?.automated === false &&
    afterRename?.source === 'manual' &&
    afterRename?.label === 'CodeRabbit (renamed)',
);
// Restore the automated verdict for the analytics checks below.
await q.setWorkspaceReviewer(1, botUser!.id, { workspaceId: defaultA, automated: true });

// A write naming ANOTHER tenant's WORKSPACE must 404 rather than land. The composite FK
// `(workspace_id, account_id) → workspaces(id, account_id)` would also reject it, but a constraint
// violation is a 500 — the query layer's own ownership check is what makes it a 404, and this pair
// is what proves the check exists rather than the FK carrying it.
check(
  'setWorkspaceReviewer(A, B’s workspace) returns null (foreign workspace → 404)',
  (await q.setWorkspaceReviewer(1, botUser!.id, {
    workspaceId: defaultB,
    automated: false,
  })) === null,
);
check(
  'setWorkspaceReviewer(B, A’s workspace) returns null (foreign workspace → 404)',
  (await q.setWorkspaceReviewer(2, botUser!.id, {
    workspaceId: defaultA,
    automated: false,
  })) === null,
);
check(
  "account 2's attempted write left account 1's judgement intact",
  (await reviewerRow(1, defaultA, botUser!.id))?.automated === true,
);
// Direct row scan: no workspace_reviewers row may exist under account 2 at all yet.
check(
  'no workspace_reviewers row was written for account 2',
  !((await db.select().from(schema.workspaceReviewers).execute()) as { accountId: number }[]).some(
    (r) => r.accountId === 2,
  ),
);

// ⚠ THE CROSS-ACCOUNT CHECKS ABOVE ARE COVERED SEVERAL TIMES OVER (the workspace-ownership check,
// the footprint gate, and the composite FK), which makes each one individually unfalsifiable — a
// mutation run removing any single guard still passes. The two SAME-ACCOUNT rules below are the
// ones nothing else can stand in for.
//
// 1. ANTI-FABRICATION. An actor with no review, thread or comment anywhere in the workspace must
//    not get a row. It matters because a row IS the bot object and the listing is row-driven — a
//    fabricated pair would render a stranger's login, display name and avatar (from the GLOBAL
//    `users` table) inside this account's settings.
const [ghostUser] = await db
  .insert(schema.users)
  .values({ githubLogin: 'never-touched-this-workspace', githubNodeId: 'U_ghost', isBot: false })
  .returning()
  .execute();
check(
  'setWorkspaceReviewer(A, an actor with NO footprint in the workspace) returns null',
  (await q.setWorkspaceReviewer(1, ghostUser!.id, {
    workspaceId: defaultA,
    automated: true,
  })) === null,
);
check(
  'no workspace_reviewers row was fabricated for that actor (the return value alone proves nothing)',
  (await reviewerRow(1, defaultA, ghostUser!.id)) === undefined,
);

// 2. MISMATCHED SCOPE — new under the workspace model, and a wider surface than before.
//    `listDetectedReviewers` is the ONE function that WRITES rows keyed to `workspaceId` off a
//    footprint derived from `repoIds`, so a transposed pair does not merely read the wrong repos:
//    it fabricates bot objects in a workspace the actor has never touched. A's second workspace is
//    EMPTY, so a row keyed to it can only have come from A.repoId leaking through the narrowing.
// ⚠ THE SECOND WORKSPACE MUST OWN A REPO OF ITS OWN, or this whole sub-block is VACUOUS. With an
// EMPTY second workspace, "the narrowing was bounded by the membership" and "the narrowing was
// ignored entirely" produce the SAME answer — the empty set — so a mutation dropping the
// intersection passes. MEASURED: it did. The other repo is what makes the two outcomes different
// ([] vs [otherRepo]).
const wsOtherA = await q.createWorkspace(1, 'Other A');
const [otherRepoA] = await db
  .insert(repos)
  .values({ accountId: 1, owner: 'orgA', name: 'repoA2', githubNodeId: 'R_A2' })
  .returning()
  .execute();
await q.assignReposToWorkspace(wsOtherA.id, 1, [otherRepoA!.id]);
const beforeMismatch = (
  (await db.select().from(schema.workspaceReviewers).execute()) as { workspaceId: number }[]
).length;
const mismatched = await q.listDetectedReviewers(1, {
  workspaceId: wsOtherA.id,
  repoIds: [A.repoId], // a repo of A's DEFAULT workspace, not of wsOtherA
});
check(
  'listDetectedReviewers(A, wsOther, repoIds=[a repo of another workspace]) returns nothing',
  mismatched.reviewers.length === 0 && mismatched.repoIds.length === 0,
);
check(
  'and it wrote NO row keyed to the other workspace (anti-fabrication under a transposed scope)',
  (await reviewerRow(1, wsOtherA.id, botUser!.id)) === undefined &&
    ((await db.select().from(schema.workspaceReviewers).execute()) as unknown[]).length ===
      beforeMismatch,
);
// The same transposition through the RESOLVER must bound itself the same way — that is where the
// intersection is contractual; the check above is the defence in depth behind it. The assertion is
// deliberately on BOTH sides: not merely "empty", but "empty AND not the workspace's own repo",
// which is what a dropped intersection would return.
const boundedScope = await q.resolveWorkspaceScope(1, wsOtherA.id, [A.repoId]);
check(
  'resolveWorkspaceScope(A, wsOther, narrow=[a repo of another workspace]) yields NO repos',
  boundedScope.workspaceId === wsOtherA.id &&
    boundedScope.repoIds.length === 0 &&
    !boundedScope.repoIds.includes(otherRepoA!.id),
);
// The positive control: the SAME resolver call with the workspace's OWN repo does return it, so
// the check above is not passing because narrowing always yields nothing.
const boundedOwn = await q.resolveWorkspaceScope(1, wsOtherA.id, [otherRepoA!.id]);
check(
  'resolveWorkspaceScope(A, wsOther, narrow=[its own repo]) DOES return it (positive control)',
  boundedOwn.repoIds.length === 1 && boundedOwn.repoIds[0] === otherRepoA!.id,
);

// ── THE RESETS ARE WRITES TOO ───────────────────────────────────────────────────
// DELETE /api/bot-reviewers/:userId/{judgement,identity}?workspaceId= are the way back to auto.
// Unscoped they would rewrite another tenant's row AND report success; `accountId` is in the
// predicate, so B matches nothing — and the row scan, not the return value, is what proves it.
check(
  'resetWorkspaceReviewerJudgement(B, A’s workspace) returns null (foreign workspace → 404)',
  (await q.resetWorkspaceReviewerJudgement(2, botUser!.id, defaultA)) === null,
);
check(
  "account 1's row SURVIVED account 2's reset attempt, still manual",
  (await reviewerRow(1, defaultA, botUser!.id))?.source === 'manual',
);
// ⚠ DIRTY THE ROW TO A NON-MANUAL, NON-DERIVED STATE BEFORE THE IDENTITY RESET, or the "left the
// judgement untouched" check below is vacuous twice over: a `source: 'manual'` row is skipped by
// the classifier anyway, and an identical rewrite is invisible because sqlite stores `updated_at`
// at one-second granularity.
await db
  .update(schema.workspaceReviewers)
  .set({ automated: false, role: 'quality_check', source: 'behavioral' })
  .where(
    and(
      eq(schema.workspaceReviewers.accountId, 1),
      eq(schema.workspaceReviewers.workspaceId, defaultA),
      eq(schema.workspaceReviewers.authorUserId, botUser!.id),
    ),
  )
  .execute();
check(
  'resetWorkspaceReviewerIdentity(B, A’s workspace) returns null (foreign workspace → 404)',
  (await q.resetWorkspaceReviewerIdentity(2, botUser!.id, defaultA)) === null,
);
// Positive control — and it must come back AUTO-DERIVED, not merely blanked: the reset re-runs the
// classifier identity-half-only in the same request, so the vendor's own label returns in place of
// the human's 'CodeRabbit (renamed)'. A clear-only reset would leave kind null forever and read as
// "delete the vendor".
const resetIdA = await q.resetWorkspaceReviewerIdentity(1, botUser!.id, defaultA);
check(
  'resetWorkspaceReviewerIdentity(A) re-derives the vendor and hands provenance back to auto',
  resetIdA?.identitySource === 'auto' &&
    resetIdA?.kind === 'coderabbit' &&
    resetIdA?.label === 'CodeRabbit',
);
// …and it touched NEITHER half of the judgement. The row must still carry the DIRTIED values
// above — a judgement re-derivation would have put them back to automated/review, which is exactly
// what makes this falsifiable.
const afterIdReset = await reviewerRow(1, defaultA, botUser!.id);
check(
  'the identity reset left the judgement columns untouched',
  afterIdReset?.automated === false &&
    afterIdReset?.role === 'quality_check' &&
    afterIdReset?.source === 'behavioral',
);
// The judgement reset is the mirror: it re-derives automated/role and must not disturb the
// identity it now shares a row with.
const resetJA = await q.resetWorkspaceReviewerJudgement(1, botUser!.id, defaultA);
check(
  'resetWorkspaceReviewerJudgement(A) re-derives the judgement from the vendor login',
  resetJA?.automated === true && resetJA?.source !== 'manual',
);
check(
  'a judgement reset leaves the vendor identity (kind AND label) intact',
  resetJA?.kind === 'coderabbit' && resetJA?.label === 'CodeRabbit',
);
// Restore the manual automated verdict for the analytics checks below.
await q.setWorkspaceReviewer(1, botUser!.id, { workspaceId: defaultA, automated: true });

// ── COST: THE ONE COLUMN NOTHING DERIVES ────────────────────────────────────────
// A price is money the user typed, so it takes the same ownership gate as everything else on the
// row AND one more rule the others do not have: it is PER WORKSPACE, so a write must name exactly
// one row and leave the same actor's rows in other workspaces byte-identical.
check(
  'setReviewerCost(B, A’s workspace) returns null (foreign workspace → 404)',
  (await q.setReviewerCost(2, botUser!.id, defaultA, 99)) === null,
);
check(
  'setReviewerCost(A, A’s workspace) succeeds (positive control)',
  (await q.setReviewerCost(1, botUser!.id, defaultA, 99)) !== null,
);
const costRows = (await db.select().from(schema.workspaceReviewers).execute()) as {
  accountId: number;
  workspaceId: number;
  authorUserId: number;
  monthlyCents: number | null;
}[];
check(
  'the price landed on A’s own row and nothing was written under account 2',
  costRows.some(
    (r) =>
      r.accountId === 1 &&
      r.workspaceId === defaultA &&
      r.authorUserId === botUser!.id &&
      r.monthlyCents === 9900,
  ) && !costRows.some((r) => r.accountId === 2),
);
// The int4 CLAMP. Unbounded, Postgres RAISES `integer out of range` (a 500) while SQLite's 64-bit
// integers accept the value happily — the same request succeeding locally and 500ing in cloud is
// the divergence class this is here to keep closed.
check(
  'setReviewerCost clamps to the int4 cents ceiling (no dialect divergence)',
  (await q.setReviewerCost(1, botUser!.id, defaultA, 99_999_999_999))?.costMonthlyUsd ===
    21474836.47,
);
check(
  'setReviewerCost(null) clears the price without deleting the row or its identity',
  (await q.setReviewerCost(1, botUser!.id, defaultA, null))?.costMonthlyUsd === null &&
    (await reviewerRow(1, defaultA, botUser!.id))?.kind === 'coderabbit',
);
// 0 is a REAL price ("we pay nothing"), not "unset" — a `||` anywhere on this path collapses it.
check(
  'setReviewerCost(0) stores a real zero, distinct from null',
  (await q.setReviewerCost(1, botUser!.id, defaultA, 0))?.costMonthlyUsd === 0,
);
// `cost_model` shares the price's writer and its ownership gate — a foreign workspace can set
// neither the number nor its reading rule.
check(
  'setReviewerCost(B, A’s workspace, per_seat) returns null (foreign workspace → 404)',
  (await q.setReviewerCost(2, botUser!.id, defaultA, 29, 'per_seat')) === null &&
    (await reviewerRow(1, defaultA, botUser!.id))?.costModel === 'flat',
);
check(
  'setReviewerCost(A, per_seat) stores the reading rule beside the unit',
  (await q.setReviewerCost(1, botUser!.id, defaultA, 29, 'per_seat'))?.costModel === 'per_seat',
);
check(
  'setReviewerCost(null) resets the reading rule to flat in the same write',
  (await q.setReviewerCost(1, botUser!.id, defaultA, null)) !== null &&
    (await reviewerRow(1, defaultA, botUser!.id))?.costModel === 'flat',
);
// Restore the pre-existing state for the checks below (a real zero, flat).
await q.setReviewerCost(1, botUser!.id, defaultA, 0);

// ── SEAT COUNT: the read-time input to every per-seat price ─────────────────────
// `workspaceHumanSeatCount` reaches the GLOBAL `users` table through `pull_requests.author_id`,
// so its tenancy rests entirely on the accountId predicate + the `workspace_repos
// (repo_id, account_id)` join. A human PR author is seeded for A; B computing over A's workspace
// id must see ZERO — never A's headcount, and never a 404-shaped existence oracle.
const [seatHuman] = await db
  .insert(schema.users)
  .values({ githubLogin: 'seat-human', githubNodeId: 'U_seat', isBot: false })
  .returning()
  .execute();
await db
  .insert(schema.pullRequests)
  .values({
    githubNodeId: 'PR_seat_A',
    accountId: 1,
    repoId: A.repoId,
    number: 2,
    title: 'seat fixture',
    state: 'open',
    isDraft: false,
    authorId: seatHuman!.id,
    openedAt: now,
    updatedAt: now,
  })
  .execute();
check(
  'workspaceHumanSeatCount(A) counts A’s human PR author (positive control — not vacuous)',
  (await q.workspaceHumanSeatCount(1, defaultA)) === 1,
);
check(
  'workspaceHumanSeatCount(B, A’s workspace id) is 0 (foreign workspace yields nothing)',
  (await q.workspaceHumanSeatCount(2, defaultA)) === 0,
);
check(
  "workspaceHumanSeatCount(B, B's own workspace) does not count A's author",
  (await q.workspaceHumanSeatCount(2, defaultB)) === 0,
);
// The exclusion routes through the WORKSPACE verdict: botUser is automated in defaultA (restored
// above), so a PR it authors adds no seat.
await db
  .insert(schema.pullRequests)
  .values({
    githubNodeId: 'PR_seat_bot',
    accountId: 1,
    repoId: A.repoId,
    number: 3,
    title: 'bot-authored',
    state: 'open',
    isDraft: false,
    authorId: botUser!.id,
    openedAt: now,
    updatedAt: now,
  })
  .execute();
check(
  'workspaceHumanSeatCount(A) excludes the workspace-classified bot author',
  (await q.workspaceHumanSeatCount(1, defaultA)) === 1,
);

// ── WORKSPACE CRUD (CORE) ───────────────────────────────────────────────────────
// `workspaces` + `workspace_repos` are account-scoped; every getter/writer filters accountId and
// every id-addressed mutator verifies ownership → false/empty/'not_found' for a foreign workspace.
const wsA = await q.createWorkspace(1, 'Workspace A');
await q.assignReposToWorkspace(wsA.id, 1, [A.repoId]);
const wsB = await q.createWorkspace(2, 'Workspace B');
await q.assignReposToWorkspace(wsB.id, 2, [B.repoId]);

const listA = await q.listWorkspaces(1);
check(
  "listWorkspaces(A) returns A's own workspaces with the Default first",
  listA.length >= 2 && listA[0]!.isDefault === true && listA.some((w) => w.id === wsA.id),
);
check(
  "listWorkspaces(A) excludes B's workspaces",
  !listA.some((w) => w.id === wsB.id || w.id === defaultB),
);
check(
  "listWorkspaces(A) never surfaces B's repo in any membership",
  !listA.some((w) => w.repoIds.includes(B.repoId)),
);
check(
  'getWorkspaceRepoIds(wsA, A) returns A.repo',
  (await q.getWorkspaceRepoIds(wsA.id, 1)).length === 1,
);
check(
  'getWorkspaceRepoIds(wsA, B) leaks nothing (IDOR blocked)',
  (await q.getWorkspaceRepoIds(wsA.id, 2)).length === 0,
);

// B cannot rename / delete / assign into A's workspace.
check(
  'renameWorkspace(wsA, B) returns false (IDOR blocked)',
  (await q.renameWorkspace(wsA.id, 2, 'hacked')) === false,
);
check(
  "A's workspace name survives B's rename attempt",
  (await q.listWorkspaces(1)).find((w) => w.id === wsA.id)!.name === 'Workspace A',
);
await q.assignReposToWorkspace(wsA.id, 2, [B.repoId]);
check(
  "B's assign into A's workspace is a no-op",
  (await q.getWorkspaceRepoIds(wsA.id, 1)).length === 1 &&
    (await q.getWorkspaceRepoIds(wsA.id, 1))[0] === A.repoId,
);
// …and A naming B's REPO is a no-op too — the repo-ownership filter, not the FK, is what keeps
// this a silent drop rather than a 500.
await q.assignReposToWorkspace(wsA.id, 1, [B.repoId]);
check(
  "A's assign of B's repo is dropped (repo ownership filter)",
  !(await q.getWorkspaceRepoIds(wsA.id, 1)).includes(B.repoId) &&
    (await q.getWorkspaceRepoIds(wsB.id, 2)).includes(B.repoId),
);
check(
  "deleteWorkspace(wsA, B) returns 'not_found' (IDOR blocked)",
  (await q.deleteWorkspace(wsA.id, 2)) === 'not_found',
);
check(
  "A's workspace survives B's delete attempt",
  (await q.listWorkspaces(1)).some((w) => w.id === wsA.id),
);
// The Default is NOT deletable — a distinct state from "not yours", because the route must render
// a 409 rather than a 404.
check(
  "deleteWorkspace(A's default, A) returns 'is_default'",
  (await q.deleteWorkspace(defaultA, 1)) === 'is_default',
);

// THE MISMATCHED-SCOPE CASE. A stale bookmark, a shared URL, or a hand-edited `?workspace=` can
// name another tenant's id. It must resolve to the CALLER's own Default — never 404 (an existence
// oracle over another tenant's workspace ids) and never to B's repos.
const mismatchedScope = await q.resolveWorkspaceScope(1, defaultB);
check(
  "resolveWorkspaceScope(A, B's workspace id) resolves to A's OWN default",
  mismatchedScope.workspaceId === defaultA,
);
check(
  "resolveWorkspaceScope(A, B's workspace id) yields NONE of B's repos",
  !mismatchedScope.repoIds.includes(B.repoId),
);
const mismatchedScopeB = await q.resolveWorkspaceScope(2, wsA.id);
check(
  "resolveWorkspaceScope(B, A's workspace id) resolves to B's OWN default (blocked both ways)",
  mismatchedScopeB.workspaceId === defaultB && !mismatchedScopeB.repoIds.includes(A.repoId),
);
check(
  'resolveWorkspaceScope(A, garbage) also resolves to the default rather than throwing',
  (await q.resolveWorkspaceScope(1, 'not-a-number')).workspaceId === defaultA,
);
// The repo → workspace direction is ownership-bound too: a foreign repo yields null, never
// another tenant's workspace id.
check(
  'workspaceScopeForRepo(A, A.repo) resolves A’s own workspace',
  (await q.workspaceScopeForRepo(1, A.repoId))?.repoIds[0] === A.repoId,
);
check(
  'workspaceScopeForRepo(A, B.repo) returns null (IDOR blocked)',
  (await q.workspaceScopeForRepo(1, B.repoId)) === null,
);

// ── THE DELETE CASCADE MUST NOT EAT PRICES ──────────────────────────────────────
// `workspace_reviewers` cascades from `workspaces`, so a bare DELETE would destroy every manual
// judgement, every manual vendor name and every `monthly_cents` in the workspace — money the user
// typed — while the repos survive. deleteWorkspace re-homes both first. Seed a priced reviewer row
// in wsA (the actor has a footprint via A.repo, which is a member of wsA right now) and delete it.
await q.setWorkspaceReviewer(1, botUser!.id, { workspaceId: wsA.id, automated: true });
await q.setReviewerCost(1, botUser!.id, wsA.id, 42);
check(
  'the doomed workspace really holds a priced reviewer row (the check below is not vacuous)',
  (await reviewerRow(1, wsA.id, botUser!.id))?.monthlyCents === 4200,
);
// Default already holds a row for this actor, at price 0 — so this is also the COLLISION case, and
// the rule is that Default's existing row WINS and is left untouched.
check(
  "Default's own row for that actor is the collision foil",
  (await reviewerRow(1, defaultA, botUser!.id))?.monthlyCents === 0,
);
// ⚠ THE COLLISION CASE ALONE CANNOT PROVE THE RE-HOME HAPPENED. When Default already holds a row,
// "re-homed then skipped on conflict" and "never re-homed at all" leave identical state, so a
// mutation deleting the whole re-home loop passes. A SECOND actor, priced in wsA and ABSENT from
// Default, is the only thing that distinguishes them: after the delete its price must be sitting
// in Default. Without this, the money-loss failure mode §1.2 exists to close is untested.
const [bot2] = await db
  .insert(schema.users)
  .values({ githubLogin: 'greptileai', githubNodeId: 'U_gr', isBot: true })
  .returning()
  .execute();
await db
  .insert(schema.reviewThreads)
  .values({
    githubNodeId: 'RT_iso_A2',
    prId: A.prId,
    path: 'y.ts',
    line: 2,
    isResolved: false,
    isOutdated: false,
    derivedState: 'untouched',
    originalCommenterId: bot2!.id,
    createdAt: now,
  })
  .execute();
await q.setWorkspaceReviewer(1, bot2!.id, { workspaceId: wsA.id, automated: true, });
await q.setWorkspaceReviewer(1, bot2!.id, { workspaceId: wsA.id, label: 'Greptile (ours)' });
await q.setReviewerCost(1, bot2!.id, wsA.id, 7);
check(
  'the second actor is priced in wsA and ABSENT from Default (the re-home check is falsifiable)',
  (await reviewerRow(1, wsA.id, bot2!.id))?.monthlyCents === 700 &&
    (await reviewerRow(1, defaultA, bot2!.id)) === undefined,
);
check("deleteWorkspace(wsA, A) returns 'deleted'", (await q.deleteWorkspace(wsA.id, 1)) === 'deleted');
check(
  "wsA's repo was re-homed to Default rather than orphaned",
  (await q.getWorkspaceRepoIds(defaultA, 1)).includes(A.repoId),
);
check(
  "Default's pre-existing reviewer row survived the re-home unchanged (collision: Default wins)",
  (await reviewerRow(1, defaultA, botUser!.id))?.monthlyCents === 0,
);
check(
  "the NON-colliding actor's manual label AND price were re-homed into Default, not cascaded away",
  (await reviewerRow(1, defaultA, bot2!.id))?.monthlyCents === 700 &&
    (await reviewerRow(1, defaultA, bot2!.id))?.label === 'Greptile (ours)',
);
check(
  'no reviewer row is left keyed to the deleted workspace',
  (await reviewerRow(1, wsA.id, botUser!.id)) === undefined &&
    (await reviewerRow(1, wsA.id, bot2!.id)) === undefined,
);
check(
  'no membership row is left keyed to the deleted workspace',
  (await q.getWorkspaceRepoIds(wsA.id, 1)).length === 0,
);

// ── Bot analytics, all taking a BotScope ────────────────────────────────────────
// `workspaceId` decides who counts as a bot, `repoIds` narrows what is measured. The single object
// is what stops a caller measuring one workspace's data through another's verdicts.
const scopeANow = await q.resolveWorkspaceScope(1, defaultA);
const anA = await q.getBotAnalytics(1, 'rolling_30', scopeANow);
check(
  'getBotAnalytics(A) surfaces the account-1 bot thread',
  anA.vendors.some((v) => v.kind === 'coderabbit'),
);
const anB = await q.getBotAnalytics(2, 'rolling_30', scopeB);
check('getBotAnalytics(B) surfaces no vendors (IDOR blocked)', anB.vendors.length === 0);
// The transposed scope: B's own workspace narrowed to A's repo.
const anCross = await q.getBotAnalytics(2, 'rolling_30', {
  workspaceId: defaultB,
  repoIds: [A.repoId],
});
check(
  'getBotAnalytics(B, repoIds=[A.repo]) leaks nothing (IDOR blocked)',
  anCross.vendors.length === 0,
);

// getBotVendorPrs (the per-REVIEWER drill-down) is account-scoped by the PR join: A's owner call
// surfaces its own bot's PR; the SAME userId under account B leaks nothing.
const vpA = await q.getBotVendorPrs(1, { userId: botUser!.id }, 'rolling_30', scopeANow);
check('getBotVendorPrs(A, botUser) surfaces A’s PR', vpA.prs.some((p) => p.prId === A.prId));
check('getBotVendorPrs(A, botUser) echoes the per-reviewer key', vpA.key === `u${botUser!.id}`);
const vpCross = await q.getBotVendorPrs(2, { userId: botUser!.id }, 'rolling_30', {
  workspaceId: defaultB,
  repoIds: [A.repoId],
});
check('getBotVendorPrs(B, A’s botUser) leaks nothing (IDOR blocked)', vpCross.prs.length === 0);

// getBotOnlyPrs (the caption's expandable list) is account-scoped: the owner call resolves its own
// repos and never contains another account's PR; a cross-account call passing the OTHER account's
// repo ids returns nothing (getBotOnlyReviewPrs binds pullRequests.accountId).
const boA = await q.getBotOnlyPrs(1, 'rolling_30', scopeANow);
check(
  "getBotOnlyPrs(A) returns a list, never B's PR",
  Array.isArray(boA.prs) && !boA.prs.some((p) => p.prId === B.prId),
);
const boCrossA = await q.getBotOnlyPrs(2, 'rolling_30', {
  workspaceId: defaultB,
  repoIds: [A.repoId],
});
check('getBotOnlyPrs(B, repoIds=[A.repo]) leaks nothing (IDOR blocked)', boCrossA.prs.length === 0);
const boCrossB = await q.getBotOnlyPrs(1, 'rolling_30', {
  workspaceId: defaultA,
  repoIds: [B.repoId],
});
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

// ── Cross-WORKSPACE period axis (the Reports "By workspace" rows) ───────────────
// getPeriodMetricsForWorkspaces takes NO scope at all — it computes one period vector per
// workspace the caller owns (the deleted getWorkspaceComparisonRows' shape) — so the ONLY
// isolation surface is `listWorkspaces(accountId)` plus the accountId inside getPeriodMetrics.
// A leak would show as another tenant's workspace row, or as its PRs inside the caller's numbers.
// Landmine: B must already own a workspace WITH a repo, or the negative check passes on an empty
// account and is VACUOUS. wsB is seeded above — do not reorder.
const { getPeriodMetricsForWorkspaces } = await import('../src/db/period-metrics.js');
const axisWindow = { fromMs: Date.now() - 14 * 86_400_000, toMs: Date.now() };
const axisA = await getPeriodMetricsForWorkspaces(1, axisWindow);
const axisB = await getPeriodMetricsForWorkspaces(2, axisWindow);
check(
  "getPeriodMetricsForWorkspaces(A) returns A's own workspaces only",
  axisA.length > 0 && !axisA.some((r) => r.workspaceId === wsB.id || r.workspaceId === defaultB),
);
check(
  "getPeriodMetricsForWorkspaces(B) returns B's own workspaces only (blocked both ways)",
  axisB.length > 0 && !axisB.some((r) => r.workspaceId === defaultA),
);
check(
  "getPeriodMetricsForWorkspaces(B) counts only B's repos in its coverage",
  axisB.reduce((n, r) => n + r.coverage.totalRepos, 0) === 1,
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
const searchOwn = await searchPrs(1, {
  query: 'isolationsearchtoken',
  repoIds: scopeA.repoIds,
  limit: 50,
  offset: 0,
});
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
const { findPostedReviewComment, getPrSyncTarget } = await import(
  '../src/sync/resync-after-write.js'
);
const rcOwn = await findPostedReviewComment(A.prId, 1, 'nonexistent-db-id', 'RC_iso_A');
check(
  'findPostedReviewComment(A, A’s comment) finds it by node id',
  rcOwn != null && rcOwn.threadId === isoThread!.id,
);
const rcCross = await findPostedReviewComment(A.prId, 2, 'nonexistent-db-id', 'RC_iso_A');
check('findPostedReviewComment(B, A’s comment) returns null (IDOR blocked)', rcCross === null);

// ── The targeted-sync coordinate resolver (getPrSyncTarget) ─────────────────────
// Also outside db/queries.ts, so named here explicitly. It answers "which GitHub repo/PR
// does this local id point at" for the post-write resync AND the refresh route
// (POST /api/prs/:id/refresh), where its null IS the 404 — without the accountId
// predicate one tenant could aim a sync (and its token spend) at another's PR id.
const tgtOwn = await getPrSyncTarget(A.prId, 1);
check(
  'getPrSyncTarget(A, A’s PR) resolves its coordinates',
  tgtOwn != null && tgtOwn.repoId === A.repoId && tgtOwn.number === 1,
);
check(
  'getPrSyncTarget(B, A’s PR) returns null (IDOR blocked)',
  (await getPrSyncTarget(A.prId, 2)) === null,
);

// ── ML severity labels (db/ml-labels.ts) ───────────────────────────────────────
// Two id-addressed reads that live OUTSIDE db/queries.ts, so — like findPostedReviewComment
// above — this script cannot see them unless they are imported by name.
//
// The assertions are seeded to be NON-VACUOUS in BOTH directions: a real label row is written
// onto A's inline comment, so deleting the accountId predicate from either getter makes a check
// FAIL rather than quietly still returning nothing. Note `mcl_account_target` is unique per
// (account, target_kind, target_id) and target ids are per-tenant local pks, so B genuinely can
// carry a row naming the SAME target id — which is exactly the cross-account read to block.
const { getPrMlLabels, getBotSeverityRollup, getMlBacklogForAccount, upsertMlLabels } =
  await import('../src/db/ml-labels.js');
const [isoThreadB] = await db
  .insert(schema.reviewThreads)
  .values({
    githubNodeId: 'RT_iso_B',
    prId: B.prId,
    path: 'src/b.ts',
    line: 1,
    isResolved: false,
    derivedState: 'untouched',
    // setWorkspaceReviewer refuses an actor with no FOOTPRINT in the workspace, and a footprint
    // is counted off threads/reviews/PR-comments — a review COMMENT alone does not create one.
    originalCommenterId: contributor!.id,
    createdAt: now,
  })
  .returning({ id: schema.reviewThreads.id })
  .execute();
const isoRc = await db
  .select({ id: schema.reviewComments.id })
  .from(schema.reviewComments)
  .where(eq(schema.reviewComments.githubNodeId, 'RC_iso_A'))
  .limit(1)
  .execute();
await upsertMlLabels([
  {
    accountId: 1,
    repoId: A.repoId,
    prId: A.prId,
    targetKind: 'review_comment',
    targetId: isoRc[0]!.id,
    authorUserId: contributor!.id,
    severity: 'major',
    severityOrd: 2,
    severityProb: 0.9,
    // The vendor's own claim, stored beside ours — irrelevant to isolation, but the write
    // shape is exhaustive on purpose so a new column cannot be added without a decision here.
    vendorSeverity: 'critical',
    vendorSeverityConfidence: 'high',
    categories: ['security'],
    categoryProbs: { security: 0.9 },
    isSummary: false,
    backend: 'test',
    modelVersion: 'test',
    bodyHash: 'h',
    targetCreatedAt: now,
  },
]);
const mlOwn = await getPrMlLabels(A.prId, 1);
check(
  'getPrMlLabels(A.pr, A) returns the stored label',
  mlOwn != null && mlOwn.length === 1 && mlOwn[0]!.severity === 'major',
);
check('getPrMlLabels(A.pr, B) returns null (IDOR blocked)', (await getPrMlLabels(A.prId, 2)) === null);
check('getPrMlLabels(B.pr, A) returns null (IDOR blocked)', (await getPrMlLabels(B.prId, 1)) === null);

// The rollup is workspace-scoped, and a BotScope may only ever come from resolveWorkspaceScope —
// so the cross-account attempt is spelled the way a caller could actually spell it: B asking for
// A's repo id. resolveWorkspaceScope intersects with B's own membership, so the narrowing must
// come back empty and the rollup must count nothing.
// The rollup only counts actors the WORKSPACE calls bots — a stored label whose author is not
// (or is no longer) automated there is deliberately absent, so the fixture has to say so or the
// "own" assertion is vacuous for the wrong reason.
// Resolve through the repo, not through "the account's Default": earlier assertions in this
// file MOVE repos between workspaces, so Default is not reliably where the seeded repo lives by
// the time we get here — and a scope with no repos short-circuits the rollup, which would make
// both assertions below pass for the wrong reason.
const mlScopeA = (await q.workspaceScopeForRepo(1, A.repoId))!;
await q.setWorkspaceReviewer(1, contributor!.id, {
  workspaceId: mlScopeA.workspaceId,
  automated: true,
});
const rollupOwn = await getBotSeverityRollup(1, mlScopeA, true);
check(
  'getBotSeverityRollup(A) counts A’s label',
  rollupOwn.labelled === 1 && rollupOwn.totals.bySeverity.major === 1,
);
const rollupCross = await getBotSeverityRollup(
  2,
  await q.resolveWorkspaceScope(2, undefined, [A.repoId]),
  true,
);
check(
  'getBotSeverityRollup(B, repoIds=[A.repo]) leaks nothing (IDOR blocked)',
  rollupCross.repoIds.length === 0 && rollupCross.labelled === 0,
);
// ⚠ THE CHECK ABOVE IS VACUOUS ON ITS OWN, and that is worth spelling out because it looks
// like a real assertion: `resolveWorkspaceScope` intersects the requested narrowing with B's own
// membership, so the scope comes back EMPTY and the rollup short-circuits before it queries
// anything. Deleting the accountId predicate from the rollup leaves it green.
//
// This is the binding one. B gets its OWN label, on its OWN repo, authored by the SAME global
// user (users is a shared table, so one actor legitimately appears in both tenants). B's rollup
// must count exactly ONE — its own. Drop `accountId` (or `repoId`) from the scan and it counts
// two, and this fails.
const isoRcB = await db
  .insert(schema.reviewComments)
  .values({
    githubNodeId: 'RC_iso_B',
    threadId: isoThreadB!.id,
    prId: B.prId,
    authorId: contributor!.id,
    body: 'iso inline B',
    createdAt: now,
  })
  .returning({ id: schema.reviewComments.id })
  .execute();
const mlScopeB = (await q.workspaceScopeForRepo(2, B.repoId))!;
await q.setWorkspaceReviewer(2, contributor!.id, {
  workspaceId: mlScopeB.workspaceId,
  automated: true,
});
await upsertMlLabels([
  {
    accountId: 2,
    repoId: B.repoId,
    prId: B.prId,
    targetKind: 'review_comment',
    targetId: isoRcB[0]!.id,
    authorUserId: contributor!.id,
    severity: 'nit',
    severityOrd: 0,
    severityProb: 0.5,
    vendorSeverity: null,
    vendorSeverityConfidence: null,
    categories: ['nitpick'],
    categoryProbs: { nitpick: 0.5 },
    isSummary: false,
    backend: 'test',
    modelVersion: 'test',
    bodyHash: 'h',
    targetCreatedAt: now,
  },
]);
const rollupB = await getBotSeverityRollup(2, mlScopeB, true);
check(
  'getBotSeverityRollup(B) counts ONLY B’s label, not A’s (IDOR blocked)',
  rollupB.labelled === 1 && rollupB.totals.bySeverity.nit === 1 && rollupB.totals.bySeverity.major === 0,
);

// getBotVendorComments (the Comments drill-down) has the rollup's exact shape of exposure —
// outer rows off the caller's PR join, labels off the (accountId, kind, targetId) LEFT JOIN —
// and the same vacuity trap (a transposed scope short-circuits empty before querying). The
// binding pair is therefore the SAME global author labelled in BOTH tenants just above: each
// side must list exactly its own comment, carrying its own label inline, never the other's.
const { getBotVendorComments } = await import('../src/db/ml-labels.js');
const vcOwnA = await getBotVendorComments(1, { userId: contributor!.id }, 'rolling_30', mlScopeA);
check(
  "getBotVendorComments(A) lists A's comment with A's label inline, never B's row",
  vcOwnA.comments.some(
    (c) =>
      c.targetKind === 'review_comment' &&
      c.targetId === isoRc[0]!.id &&
      c.mlLabel?.severity === 'major',
  ) && !vcOwnA.comments.some((c) => c.targetKind === 'review_comment' && c.targetId === isoRcB[0]!.id),
);
const vcOwnB = await getBotVendorComments(2, { userId: contributor!.id }, 'rolling_30', mlScopeB);
check(
  "getBotVendorComments(B) lists ONLY B's comment and label, not A's (IDOR blocked)",
  vcOwnB.comments.some(
    (c) =>
      c.targetKind === 'review_comment' &&
      c.targetId === isoRcB[0]!.id &&
      c.mlLabel?.severity === 'nit',
  ) && !vcOwnB.comments.some((c) => c.mlLabel?.severity === 'major'),
);
const vcCross = await getBotVendorComments(
  2,
  { userId: contributor!.id },
  'rolling_30',
  await q.resolveWorkspaceScope(2, undefined, [A.repoId]),
);
check(
  'getBotVendorComments(B, repoIds=[A.repo]) leaks nothing (IDOR blocked)',
  vcCross.comments.length === 0,
);

// ── "What the bots are flagging" (getBotFlaggingComments / getBotOverlapClusters) ───────────
// The ML strip's drill-down. Two more readers OUTSIDE db/queries.ts — the second one in its own
// file (db/bot-overlap.ts) — so, like findPostedReviewComment above, this script cannot see them
// unless they are imported by name. They are the widest read surface on the Bots rail: one
// request re-runs the strip's whole windowed population scan and then hydrates a page of comment
// BODIES, PR titles and repo names, so a missing predicate hands over another tenant's review
// content, not just a count.
//
// ⚠ THE SCOPE OBJECTS BELOW ARE HAND-BUILT ON PURPOSE. `resolveWorkspaceScope` intersects the
// requested narrowing with the caller's own membership, so the "B asks for A's repo" spelling it
// produces comes back with `repoIds: []` and BOTH getters short-circuit before querying anything
// — green whether or not the accountId predicate exists (the same vacuity trap spelled out for
// getBotSeverityRollup above). Pairing B's own workspace id with A's repo id skips that
// intersection, which is the only shape in which the getters' OWN predicates are load-bearing.
// Both spellings are checked; only the second one is evidence.
const { getBotFlaggingComments } = await import('../src/db/ml-labels.js');
const { getBotOverlapClusters } = await import('../src/db/bot-overlap.js');
// No refinement: the whole selector population, which is the widest thing either getter returns.
const noRefine = { cell: null, disagree: null, authorUserIds: null };
const flagPage = { offset: 0, limit: 20 };

// The binding fixture is the one the rollup and the vendor-comments drill-down already use: the
// SAME global author labelled in BOTH tenants — `isoRc[0]` under A (severity `major`, the vendor
// declaring `critical`) and `isoRcB[0]` under B (severity `nit`, the vendor declaring NOTHING).
// Both fold to the `finding` bucket, so `{kind:'findings'}` is each side's whole population.
const flagA = await getBotFlaggingComments(
  1,
  { kind: 'findings' },
  noRefine,
  'rolling_30',
  mlScopeA,
  flagPage,
);
check(
  "getBotFlaggingComments(A) lists A's labelled comment and never B's",
  flagA.total === 1 &&
    flagA.items.length === 1 &&
    flagA.items[0]!.targetId === isoRc[0]!.id &&
    flagA.items[0]!.repoId === A.repoId &&
    !flagA.items.some((c) => c.targetId === isoRcB[0]!.id || c.repoId === B.repoId),
);
const flagB = await getBotFlaggingComments(
  2,
  { kind: 'findings' },
  noRefine,
  'rolling_30',
  mlScopeB,
  flagPage,
);
check(
  "getBotFlaggingComments(B) lists ONLY B's row, and its MATRIX describes only B's row",
  flagB.total === 1 &&
    flagB.items.length === 1 &&
    flagB.items[0]!.targetId === isoRcB[0]!.id &&
    flagB.items[0]!.mlLabel?.severity === 'nit' &&
    // The matrix is folded from the same population, so it is a second, independent readout of
    // the same leak: A's row is vendor-declared `critical` against our `major`, B's declares
    // nothing at all. One leaked row shows up here as declared/overCall 1 even if the list were
    // somehow filtered afterwards.
    flagB.matrix.total === 1 &&
    flagB.matrix.declared === 0 &&
    flagB.matrix.undeclared === 1 &&
    flagB.matrix.overCall === 0,
);
const flagCrossResolved = await getBotFlaggingComments(
  2,
  { kind: 'findings' },
  noRefine,
  'rolling_30',
  await q.resolveWorkspaceScope(2, undefined, [A.repoId]),
  flagPage,
);
check(
  'getBotFlaggingComments(B, resolveWorkspaceScope(narrow=[A.repo])) bounds the scope to nothing',
  flagCrossResolved.total === 0 && flagCrossResolved.items.length === 0,
);
// THE BINDING ONE. MEASURED: deleting `eq(mlCommentLabels.accountId, accountId)` from the
// population scan makes this report `total: 1` (A's `major` row) and fail.
const flagCross = await getBotFlaggingComments(
  2,
  { kind: 'findings' },
  noRefine,
  'rolling_30',
  { workspaceId: mlScopeB.workspaceId, repoIds: [A.repoId] },
  flagPage,
);
check(
  'getBotFlaggingComments(B, repoIds=[A.repo]) leaks nothing (IDOR blocked)',
  flagCross.total === 0 && flagCross.items.length === 0 && flagCross.matrix.total === 0,
);
// The bot refinement narrows the LIST — it must never become a second way to name a row. It is a
// LIST (the card-level "view all" states the exact bot set its total was summed over), so both the
// one-member and the multi-member spellings are checked here.
//
// Non-vacuous by construction: `contributor` is a GLOBAL user (the `users` table is shared) who
// authored a labelled comment in BOTH tenants, so B asking for that exact id is the closest a
// caller can get to naming A's row. It must still see exactly one — its own.
const flagByBot = await getBotFlaggingComments(
  2,
  { kind: 'findings' },
  { ...noRefine, authorUserIds: [contributor!.id] },
  'rolling_30',
  mlScopeB,
  flagPage,
);
check(
  'getBotFlaggingComments(B, refine.authorUserIds=[shared global user]) narrows to B’s row only',
  flagByBot.total === 1 &&
    flagByBot.filteredTotal === 1 &&
    flagByBot.items.length === 1 &&
    flagByBot.items[0]!.targetId === isoRcB[0]!.id &&
    !flagByBot.items.some((c) => c.targetId === isoRc[0]!.id || c.repoId === A.repoId),
);
// A SET containing a foreign bot alongside its own adds nothing: the extra id is still just a
// predicate over an already accountId-scoped scan, so widening the list cannot widen the tenancy.
const flagByBotSet = await getBotFlaggingComments(
  2,
  { kind: 'findings' },
  { ...noRefine, authorUserIds: [contributor!.id, botUser!.id, 999_999] },
  'rolling_30',
  mlScopeB,
  flagPage,
);
check(
  'getBotFlaggingComments(B, refine.authorUserIds=[own, foreign-only, unknown]) still lists only B’s row',
  flagByBotSet.filteredTotal === 1 &&
    flagByBotSet.items.length === 1 &&
    flagByBotSet.items[0]!.targetId === isoRcB[0]!.id &&
    !flagByBotSet.items.some((c) => c.targetId === isoRc[0]!.id || c.repoId === A.repoId),
);
// ⚠ AN EMPTY SET IS "NO BOTS", NEVER "EVERY BOT" — the `repoIds` rule on a different parameter.
// A gate spelled `authorUserIds?.length` would hand back the whole selector population under a
// caption promising a subset.
const flagByNoBot = await getBotFlaggingComments(
  2,
  { kind: 'findings' },
  { ...noRefine, authorUserIds: [] },
  'rolling_30',
  mlScopeB,
  flagPage,
);
check(
  'getBotFlaggingComments(B, refine.authorUserIds=[]) narrows to nothing, never to everything',
  flagByNoBot.total === 1 && flagByNoBot.filteredTotal === 0 && flagByNoBot.items.length === 0,
);

// ── Same-line overlap clusters ──────────────────────────────────────────────────────────────
// A cluster is ≥2 DISTINCT bots on one file within ±3 lines, so each tenant needs a real SECOND
// thread before there is anything to leak.
//
// ⚠ THE ACTORS ARE CHOSEN SO THE CROSS-TENANT PROBE IS FALSIFIABLE. A leaked thread set is
// filtered through the CALLER's `kindMap`/`roleMap` before it can form a cluster, so if A's
// cluster were built from an actor B's workspace does not call a bot (`greptileai` — not a vendor
// login, automated only via its stored row under account 1) the transposed check would pass with
// the accountId predicate deleted, for the wrong reason. `coderabbitai` is a vendor login
// (automated in EVERY workspace) and `contributor` carries a stored automated row in both
// tenants, so A's cluster survives B's classification and only `accountId` can exclude it.
await db
  .insert(schema.reviewThreads)
  .values([
    // A: joins RT_iso_A ('x.ts' line 1, coderabbitai) → one cluster, two distinct bots.
    {
      githubNodeId: 'RT_iso_ovl_A',
      prId: A.prId,
      path: 'x.ts',
      line: 2,
      isResolved: false,
      isOutdated: false,
      derivedState: 'untouched',
      originalCommenterId: contributor!.id,
      createdAt: now,
    },
    // B: joins RT_iso_B ('src/b.ts' line 1, contributor) → B's own single cluster.
    {
      githubNodeId: 'RT_iso_ovl_B',
      prId: B.prId,
      path: 'src/b.ts',
      line: 2,
      isResolved: false,
      isOutdated: false,
      derivedState: 'untouched',
      originalCommenterId: botUser!.id,
      createdAt: now,
    },
  ])
  .execute();
const ovlPage = { offset: 0, limit: 10 };
const ovlA = await getBotOverlapClusters(1, noRefine, 'rolling_30', mlScopeA, ovlPage);
check(
  "getBotOverlapClusters(A) returns A's own cluster and references none of B's PRs",
  ovlA.total === 1 &&
    ovlA.items.length === 1 &&
    ovlA.items[0]!.prId === A.prId &&
    ovlA.items[0]!.repoId === A.repoId &&
    ovlA.items[0]!.members.length === 2 &&
    !ovlA.items.some((c) => c.prId === B.prId || c.repoId === B.repoId),
);
const ovlB = await getBotOverlapClusters(2, noRefine, 'rolling_30', mlScopeB, ovlPage);
check(
  "getBotOverlapClusters(B) returns ONLY B's cluster, never A's (IDOR blocked)",
  ovlB.total === 1 &&
    ovlB.items.length === 1 &&
    ovlB.items[0]!.prId === B.prId &&
    ovlB.items[0]!.repoId === B.repoId &&
    !ovlB.items.some((c) => c.prId === A.prId || c.repoId === A.repoId),
);
const ovlCrossResolved = await getBotOverlapClusters(
  2,
  noRefine,
  'rolling_30',
  await q.resolveWorkspaceScope(2, undefined, [A.repoId]),
  ovlPage,
);
check(
  'getBotOverlapClusters(B, resolveWorkspaceScope(narrow=[A.repo])) bounds the scope to nothing',
  ovlCrossResolved.total === 0 && ovlCrossResolved.items.length === 0,
);
// THE BINDING ONE. MEASURED: deleting `eq(pullRequests.accountId, accountId)` from the thread
// scan makes this report `total: 1` — A's cluster, with A's repo full name and PR title — and
// fail.
const ovlCross = await getBotOverlapClusters(
  2,
  noRefine,
  'rolling_30',
  { workspaceId: mlScopeB.workspaceId, repoIds: [A.repoId] },
  ovlPage,
);
check(
  'getBotOverlapClusters(B, repoIds=[A.repo]) leaks nothing (IDOR blocked)',
  ovlCross.total === 0 && ovlCross.items.length === 0,
);
// The same refinement on the cluster arm. `contributor` is a member of BOTH tenants' clusters,
// so narrowing B to that shared global id keeps B's cluster and must not surface A's.
const ovlByBot = await getBotOverlapClusters(
  2,
  { ...noRefine, authorUserIds: [contributor!.id] },
  'rolling_30',
  mlScopeB,
  ovlPage,
);
check(
  'getBotOverlapClusters(B, refine.authorUserIds=[shared global user]) keeps only B’s cluster',
  ovlByBot.total === 1 &&
    ovlByBot.filteredTotal === 1 &&
    ovlByBot.items.length === 1 &&
    ovlByBot.items[0]!.prId === B.prId &&
    !ovlByBot.items.some((c) => c.prId === A.prId || c.repoId === A.repoId),
);
// The set spelling, again with an id that only names a member of A's cluster: a wider bot list
// still cannot widen the tenancy, and an EMPTY one means NO bots rather than all of them.
const ovlByBotSet = await getBotOverlapClusters(
  2,
  { ...noRefine, authorUserIds: [contributor!.id, 999_999] },
  'rolling_30',
  mlScopeB,
  ovlPage,
);
check(
  'getBotOverlapClusters(B, refine.authorUserIds=[own, unknown]) still keeps only B’s cluster',
  ovlByBotSet.filteredTotal === 1 &&
    ovlByBotSet.items.length === 1 &&
    ovlByBotSet.items[0]!.prId === B.prId &&
    !ovlByBotSet.items.some((c) => c.prId === A.prId || c.repoId === A.repoId),
);
const ovlByNoBot = await getBotOverlapClusters(
  2,
  { ...noRefine, authorUserIds: [] },
  'rolling_30',
  mlScopeB,
  ovlPage,
);
check(
  'getBotOverlapClusters(B, refine.authorUserIds=[]) narrows to nothing, never to everything',
  ovlByNoBot.total === 1 && ovlByNoBot.filteredTotal === 0 && ovlByNoBot.items.length === 0,
);

// getMlBacklogForAccount — the account-wide enrichment backlog behind GET /api/ml-status. It
// takes NO scope argument (the worker walks every workspace, so a workspace-scoped count would
// under-report the work actually running), which makes its ONE accountId predicate carry the
// whole isolation weight — worth a check for exactly that reason.
//
// Non-vacuous by construction: each tenant has written exactly one label by now, so a missing
// predicate reads as 2 rather than as an empty result that would pass either way.
const backlogA = await getMlBacklogForAccount(1);
const backlogB = await getMlBacklogForAccount(2);
check(
  'getMlBacklogForAccount(A) counts ONLY A’s labels (IDOR blocked)',
  backlogA.labelled === 1,
);
check(
  'getMlBacklogForAccount(B) counts ONLY B’s labels (IDOR blocked)',
  backlogB.labelled === 1,
);

// ── getBotVolume / getPrBotVolume / getBotVolumeScatter (db/bot-volume.ts) ──────────────────
// The bot-comment-volume family: one merged-PR scan plus three grouped comment counts, all
// account-scoped through `pullRequests.accountId`. Three getters, one base loader, so the check
// is per getter — a predicate dropped from the shared loader would fail all three at once, but a
// predicate dropped from one of the three grouped counts would only show up in a comment total.
//
// ⚠ NON-VACUITY IS THE WHOLE RISK HERE, TWICE OVER. The population is PRs MERGED IN THE WINDOW,
// and every PR this script seeded is `state: 'open'` with a null `mergedAt` — so without the two
// merged rows below, every assertion would be comparing empty to empty and would pass with the
// accountId predicate deleted. Each merged PR therefore carries ONE OF EACH of the three counted
// text kinds (review comment, PR comment, review body), so a leak reads as 3 rather than as a
// difference between two empty lists.
const { getBotVolume, getBotVolumeScatter, getPrBotVolume } = await import(
  '../src/db/bot-volume.js'
);
const volMerged = new Date(now.getTime() - 2 * 86_400_000);
async function seedMergedVolumePr(
  accountId: number,
  repoId: number,
  tag: string,
): Promise<number> {
  const [pr] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: `PR_vol_${tag}`,
      accountId,
      repoId,
      number: 9100,
      title: `volume fixture ${tag}`,
      state: 'merged',
      isDraft: false,
      openedAt: new Date(now.getTime() - 5 * 86_400_000),
      updatedAt: volMerged,
      mergedAt: volMerged,
      // A real observed size, so the PR lands in a bucket and the scatter has a point to leak.
      additions: 30,
      deletions: 10,
      changedFiles: 3,
    })
    .returning()
    .execute();
  const [thread] = await db
    .insert(schema.reviewThreads)
    .values({
      githubNodeId: `RT_vol_${tag}`,
      prId: pr!.id,
      path: 'src/vol.ts',
      line: 1,
      isResolved: false,
      isOutdated: false,
      derivedState: 'untouched',
      originalCommenterId: botUser!.id,
      createdAt: volMerged,
    })
    .returning()
    .execute();
  await db
    .insert(schema.reviewComments)
    .values({
      githubNodeId: `RC_vol_${tag}`,
      threadId: thread!.id,
      prId: pr!.id,
      authorId: botUser!.id,
      body: 'inline',
      createdAt: volMerged,
    })
    .execute();
  await db
    .insert(schema.prComments)
    .values({
      githubNodeId: `PC_vol_${tag}`,
      prId: pr!.id,
      authorId: botUser!.id,
      body: 'pr-level',
      createdAt: volMerged,
    })
    .execute();
  await db
    .insert(schema.reviews)
    .values({
      githubNodeId: `RV_vol_${tag}`,
      prId: pr!.id,
      authorId: botUser!.id,
      state: 'commented',
      body: 'review body',
      submittedAt: volMerged,
    })
    .execute();
  return pr!.id;
}
// `botUser` is `coderabbitai`, a KNOWN VENDOR LOGIN, so it is automated in BOTH accounts by the
// login seed alone — no workspace_reviewers row is needed on B, and B's side is therefore a real
// positive control rather than an empty one.
const volPrA = await seedMergedVolumePr(1, A.repoId, 'A');
const volPrB = await seedMergedVolumePr(2, B.repoId, 'B');
// Resolved through the REPO, not "the account's Default": assertions above move repos between
// workspaces, so Default is not reliably where the seeded repo lives by now — and an empty scope
// would short-circuit every getter, making both sides pass for the wrong reason.
const volScopeA = (await q.workspaceScopeForRepo(1, A.repoId))!;
const volScopeB = (await q.workspaceScopeForRepo(2, B.repoId))!;

const volA = await getBotVolume(1, 'rolling_30', volScopeA);
const volB = await getBotVolume(2, 'rolling_30', volScopeB);
check(
  'getBotVolume(A) counts A’s merged PR and all three of its bot text kinds',
  volA.totals.prs === 1 && volA.totals.comments === 3 && volA.bots.length === 1,
);
check(
  'getBotVolume(B) counts ONLY B’s (positive control — same bot login, own data)',
  volB.totals.prs === 1 && volB.totals.comments === 3,
);
// The transposed scope: B's own workspace narrowed to A's repo. Hand-built on purpose —
// resolveWorkspaceScope would intersect it away, so this is the strictly stronger check that the
// getter's own accountId predicate holds even when handed a repo id it does not own.
const volCross = await getBotVolume(1, 'rolling_30', {
  workspaceId: volScopeA.workspaceId,
  repoIds: [B.repoId],
});
check(
  'getBotVolume(A, repoIds=[B.repo]) leaks nothing (IDOR blocked)',
  volCross.totals.prs === 0 && volCross.totals.comments === 0 && volCross.bots.length === 0,
);
const volCrossB = await getBotVolume(2, 'rolling_30', {
  workspaceId: volScopeB.workspaceId,
  repoIds: [A.repoId],
});
check(
  'getBotVolume(B, repoIds=[A.repo]) leaks nothing (IDOR blocked, both directions)',
  volCrossB.totals.prs === 0 && volCrossB.totals.comments === 0,
);
// ...and through the resolver, spelled the way a caller actually could: B asking for A's repo id.
const volCrossResolved = await getBotVolume(
  2,
  'rolling_30',
  await q.resolveWorkspaceScope(2, undefined, [A.repoId]),
);
check(
  'getBotVolume(B, resolveWorkspaceScope(narrow=[A.repo])) yields an empty scope, not A’s data',
  volCrossResolved.totals.prs === 0,
);

const volPrsA = await getPrBotVolume(1, 'rolling_30', volScopeA, { authorUserIds: null }, {
  offset: 0,
  limit: 10,
  sort: 'comments',
});
check(
  'getPrBotVolume(A) returns A’s merged PR and never B’s',
  volPrsA.filteredTotal === 1 &&
    volPrsA.items.length === 1 &&
    volPrsA.items[0]!.prId === volPrA &&
    !volPrsA.items.some((i) => i.prId === volPrB || i.repoId === B.repoId),
);
const volPrsCross = await getPrBotVolume(1, 'rolling_30', {
  workspaceId: volScopeA.workspaceId,
  repoIds: [B.repoId],
}, { authorUserIds: null }, { offset: 0, limit: 10, sort: 'ratio' });
check(
  'getPrBotVolume(A, repoIds=[B.repo]) leaks nothing under EITHER sort (IDOR blocked)',
  volPrsCross.total === 0 && volPrsCross.filteredTotal === 0 && volPrsCross.items.length === 0,
);
// A refinement naming a bot that only exists through the OTHER tenant's data still cannot widen
// tenancy, and an EMPTY list means NO bots rather than all of them.
const volPrsNoBot = await getPrBotVolume(1, 'rolling_30', volScopeA, { authorUserIds: [] }, {
  offset: 0,
  limit: 10,
  sort: 'comments',
});
check(
  'getPrBotVolume(A, refine.authorUserIds=[]) narrows to nothing, never to everything',
  volPrsNoBot.total === 1 && volPrsNoBot.filteredTotal === 0 && volPrsNoBot.items.length === 0,
);

const volScA = await getBotVolumeScatter(1, 'rolling_30', volScopeA);
check(
  'getBotVolumeScatter(A) plots A’s merged PR only',
  volScA.points.length === 1 &&
    volScA.points[0]!.prId === volPrA &&
    volScA.points[0]!.botComments === 3 &&
    !volScA.points.some((p) => p.repoId === B.repoId),
);
const volScCross = await getBotVolumeScatter(1, 'rolling_30', {
  workspaceId: volScopeA.workspaceId,
  repoIds: [B.repoId],
});
check(
  'getBotVolumeScatter(A, repoIds=[B.repo]) plots nothing (IDOR blocked)',
  volScCross.points.length === 0 && volScCross.sizedPrs === 0,
);

// ── getPersonPeriod (db/person-period.ts — the 1:1-prep vector, P4.2) ───────────────────────
// `users` is GLOBAL, so the leak shape here is subtler than a repo id: the SAME human exists in
// both tenants, and the fold must admit them per workspace (activity probe) and count per scope.
// Seeded so every negative has a paired POSITIVE in the same check — the vacuity lesson.
{
  const { getPersonPeriod } = await import('../src/db/person-period.js');
  const { users } = schema;
  const [human] = await db
    .insert(users)
    .values({ githubLogin: 'iso-human', githubNodeId: 'U_iso_human', isBot: false })
    .returning()
    .execute();
  const mkAuthored = async (accountId: number, repoId: number, tag: string) =>
    db
      .insert(pullRequests)
      .values({
        githubNodeId: `PR_pp_${tag}`,
        accountId,
        repoId,
        number: 900 + accountId,
        title: `person ${tag}`,
        state: 'merged',
        isDraft: false,
        authorId: human!.id,
        openedAt: new Date(now.getTime() - 3 * 86_400_000),
        mergedAt: new Date(now.getTime() - 2 * 86_400_000),
        updatedAt: now,
      })
      .execute();
  const winPP = { fromMs: now.getTime() - 30 * 86_400_000, toMs: now.getTime() + 86_400_000 };

  // Only B has seen this human act → A's workspace must not admit them (no oracle, no leak)…
  // (B.repoId lives in wsB by this point — the workspace-move checks above put it there — so
  // the positive half reads through THAT workspace, not B's now-empty Default.)
  await mkAuthored(2, B.repoId, 'isoB');
  const ppForeign = await getPersonPeriod(1, defaultA, human!.id, winPP);
  const ppB = await getPersonPeriod(2, wsB.id, human!.id, winPP);
  check(
    'getPersonPeriod(A) refuses a human who only ever acted in B — while B sees them',
    ppForeign === null &&
      ppB !== null &&
      ppB.metrics.find((m) => m.key === 'merged_prs_authored')?.value === 1,
  );
  // …and once they act in A too, A counts ONLY A's rows (B's merge never crosses the tenant).
  await mkAuthored(1, A.repoId, 'isoA');
  const ppA = await getPersonPeriod(1, defaultA, human!.id, winPP);
  check(
    "getPersonPeriod(A) counts A's rows only — the same human's B-side merge never leaks in",
    ppA !== null && ppA.metrics.find((m) => m.key === 'merged_prs_authored')?.value === 1,
  );
  // A bot is refused even where it acted (the lane rule): reuse B's known-vendor reviewer if
  // present; a fresh vendor-login user is simpler and self-contained.
  const [bot] = await db
    .insert(users)
    .values({ githubLogin: 'coderabbitai[bot]', githubNodeId: 'U_iso_bot_pp', isBot: true })
    .returning()
    .execute();
  await db
    .insert(pullRequests)
    .values({
      githubNodeId: 'PR_pp_bot',
      accountId: 1,
      repoId: A.repoId,
      number: 950,
      title: 'bot pr',
      state: 'open',
      isDraft: false,
      authorId: bot!.id,
      openedAt: now,
      updatedAt: now,
    })
    .execute();
  check(
    'getPersonPeriod(A) refuses an automation-lane actor outright (prep, not scoring — and never a bot)',
    (await getPersonPeriod(1, defaultA, bot!.id, winPP)) === null,
  );

  // ── The EVIDENCE arm (`{ evidence: true }`) ─────────────────────────────────────────────
  // The vector checks above never reach it, and it is a second, ROW-LEVEL read surface: PR ids,
  // comment bodies, thread excerpts and commit path areas. Two of its tables are GLOBAL
  // (`commitFiles`, `users`), reached only through tenant-proven rows — exactly the shape that
  // looks fine until someone drops a join. Seeded so BOTH tenants hold a decoy row of every
  // family, so a missing predicate leaks something rather than finding nothing.
  const mkEvidence = async (prNodeId: string, tag: string) => {
    const [pr] = await db
      .select({ id: pullRequests.id })
      .from(pullRequests)
      .where(eq(pullRequests.githubNodeId, prNodeId))
      .limit(1)
      .execute();
    const [thread] = await db
      .insert(schema.reviewThreads)
      .values({
        githubNodeId: `RT_pp_${tag}`,
        prId: pr!.id,
        path: `${tag}-side/file.ts`,
        line: 1,
        isResolved: false,
        isOutdated: false,
        derivedState: 'untouched',
        originalCommenterId: human!.id,
        createdAt: new Date(now.getTime() - 86_400_000),
      })
      .returning()
      .execute();
    await db
      .insert(schema.reviewComments)
      .values({
        githubNodeId: `RC_pp_${tag}`,
        threadId: thread!.id,
        prId: pr!.id,
        authorId: human!.id,
        body: `person-evidence-${tag}`,
        createdAt: new Date(now.getTime() - 86_400_000),
      })
      .execute();
    // A commit + its GLOBAL content-addressed file list, under a tenant-distinct path bucket.
    await db
      .insert(schema.commits)
      .values({
        sha: `sha_pp_${tag}`,
        prId: pr!.id,
        authorId: human!.id,
        committedAt: new Date(now.getTime() - 2 * 86_400_000),
      })
      .execute();
    await db
      .insert(schema.commitFiles)
      .values({ sha: `sha_pp_${tag}`, paths: [`${tag}-side/file.ts`] })
      .execute();
  };
  await mkEvidence('PR_pp_isoA', 'a');
  await mkEvidence('PR_pp_isoB', 'b');

  const evA = (await getPersonPeriod(1, defaultA, human!.id, winPP, { evidence: true }))?.evidence;
  const evB = (await getPersonPeriod(2, wsB.id, human!.id, winPP, { evidence: true }))?.evidence;
  const prIdsOf = (e: typeof evA): number[] => [
    ...new Set(
      Object.values(e?.prs ?? {})
        .flatMap((g) => (g?.rows ?? []).map((r) => r.prId))
        .filter((id): id is number => id != null),
    ),
  ];
  const [prA] = await db
    .select({ id: pullRequests.id })
    .from(pullRequests)
    .where(eq(pullRequests.githubNodeId, 'PR_pp_isoA'))
    .limit(1)
    .execute();
  const [prB] = await db
    .select({ id: pullRequests.id })
    .from(pullRequests)
    .where(eq(pullRequests.githubNodeId, 'PR_pp_isoB'))
    .limit(1)
    .execute();
  check(
    "getPersonPeriod(A, evidence) names only A's PRs — B's authored PR is not a receipt row",
    evA != null &&
      evB != null &&
      prIdsOf(evA).includes(prA!.id) &&
      !prIdsOf(evA).includes(prB!.id) &&
      prIdsOf(evB).includes(prB!.id) &&
      !prIdsOf(evB).includes(prA!.id),
  );
  check(
    "getPersonPeriod(A, evidence) returns only A's comment bodies + thread excerpts",
    evA != null &&
      evB != null &&
      evA.comments.rows.some((c) => c.body === 'person-evidence-a') &&
      !evA.comments.rows.some((c) => c.body === 'person-evidence-b') &&
      !evA.threads.rows.some((t) => t.excerpt.includes('person-evidence-b')) &&
      evB.comments.rows.some((c) => c.body === 'person-evidence-b') &&
      !evB.comments.rows.some((c) => c.body === 'person-evidence-a'),
  );
  check(
    'getPersonPeriod(A, evidence) folds path areas from A-side commits only (commitFiles is GLOBAL)',
    evA != null &&
      evB != null &&
      evA.pathAreas.some((p) => p.bucket.startsWith('a-side')) &&
      !evA.pathAreas.some((p) => p.bucket.startsWith('b-side')) &&
      evB.pathAreas.some((p) => p.bucket.startsWith('b-side')) &&
      !evB.pathAreas.some((p) => p.bucket.startsWith('a-side')),
  );
}

// ── getAutomationOutput (db/automation-output.ts — the authoring-automation vector) ──────────
// The bot-shaped twin of the person fold above, and it carries the SAME two leak shapes: `users`
// is GLOBAL (so the same automation login exists in both tenants) and the evidence arm is a
// second, row-level surface over PR titles. Seeded so every negative has a paired POSITIVE — the
// vacuity lesson: a check that passes because the fold found nothing anywhere proves nothing.
{
  const { getAutomationOutput } = await import('../src/db/automation-output.js');
  const { users } = schema;
  const [dep] = await db
    .insert(users)
    .values({ githubLogin: 'dependabot[bot]', githubNodeId: 'U_iso_dep', isBot: true })
    .returning()
    .execute();
  const winAO = { fromMs: now.getTime() - 30 * 86_400_000, toMs: now.getTime() + 86_400_000 };
  // ⚠ This fold takes a BotScope, not a bare workspace id (the person fold's shape) — and a
  // BotScope is only ever CONSTRUCTED by resolveWorkspaceScope, whose contract is that its
  // repoIds are already a subset of that workspace's membership. Building one by hand here would
  // test a scope the production path can never produce.
  const scopeA = await q.resolveWorkspaceScope(1, String(defaultA), null);
  const scopeB = await q.resolveWorkspaceScope(2, String(wsB.id), null);
  const mkBotPr = async (accountId: number, repoId: number, tag: string, n: number) =>
    db
      .insert(pullRequests)
      .values({
        githubNodeId: `PR_ao_${tag}`,
        accountId,
        repoId,
        number: n,
        title: `bump ${tag}`,
        state: 'merged',
        isDraft: false,
        authorId: dep!.id,
        openedAt: new Date(now.getTime() - 3 * 86_400_000),
        mergedAt: new Date(now.getTime() - 2 * 86_400_000),
        updatedAt: now,
        additions: 4,
        deletions: 2,
      })
      .execute();

  // Only B has seen this automation author → A must not admit it, while B does.
  await mkBotPr(2, B.repoId, 'isoB', 960);
  const aoForeign = await getAutomationOutput(1, scopeA, dep!.id, winAO);
  const aoB = await getAutomationOutput(2, scopeB, dep!.id, winAO);
  check(
    'getAutomationOutput(A) refuses an automation that only ever authored in B — while B sees it',
    aoForeign === null &&
      aoB !== null &&
      aoB.metrics.find((m) => m.key === 'prs_merged')?.value === 1,
  );

  // …and once it authors in A too, A counts ONLY A's rows.
  await mkBotPr(1, A.repoId, 'isoA', 961);
  const aoA = await getAutomationOutput(1, scopeA, dep!.id, winAO);
  check(
    "getAutomationOutput(A) counts A's rows only — the same automation's B-side merge never leaks in",
    aoA !== null && aoA.metrics.find((m) => m.key === 'prs_merged')?.value === 1,
  );

  // The evidence arm: PR titles are the row-level surface. A's receipts must name A's PR and
  // never B's, and vice versa — the paired positive on both sides.
  const evAoA = (await getAutomationOutput(1, scopeA, dep!.id, winAO, { evidence: true }))
    ?.evidence;
  const evAoB = (await getAutomationOutput(2, scopeB, dep!.id, winAO, { evidence: true }))?.evidence;
  check(
    'getAutomationOutput(evidence) names each tenant\'s own authored PRs only',
    evAoA != null &&
      evAoB != null &&
      evAoA.merged.some((r) => r.title === 'bump isoA') &&
      !evAoA.merged.some((r) => r.title === 'bump isoB') &&
      evAoB.merged.some((r) => r.title === 'bump isoB') &&
      !evAoB.merged.some((r) => r.title === 'bump isoA'),
  );

  // The mirror-image lane rule, proven against a real human who HAS authored in A (so the null
  // cannot be "no rows"): the person fold admits them, this one refuses them.
  const [humanRow] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.githubLogin, 'iso-human'))
    .limit(1)
    .execute();
  check(
    'getAutomationOutput(A) refuses a HUMAN outright — the mirror image of the person fold',
    humanRow != null && (await getAutomationOutput(1, scopeA, humanRow.id, winAO)) === null,
  );
}

// ── Bottlenecks (db/flow-findings.ts) ────────────────────────────────────────────────────────
//
// WHY THIS FOLD IS IN HERE. Its rows LEAVE THE TENANT: a finding carries PR titles, GitHub URLs
// and `actorIds` resolved into a `users` table — the same shape that made
// `getBenchmarkContributions` an ALLOW-list rather than a deny-list. It is also the newest kind of
// getter in the codebase (a multi-scan fold over six tables), and every one of those scans needs
// its own `accountId` predicate; a single omission reads as "the query returned rows" rather than
// as an error.
{
  const { getFlowFindings } = await import('../src/db/flow-findings.js');
  const WIN = 90;
  const H = 60 * 60 * 1000;

  // ── A PRODUCTIVE FIXTURE, seeded on BOTH tenants ─────────────────────────────────────────────
  // Enough for `single_reviewer_path` to fire: one directory, ≥8 PRs with a measured first human
  // review and ≥12 human reviews, one reviewer taking ≥60% of them, and a first-read wait far
  // enough above the workspace median to clear both the ratio and the absolute delta. Each tenant
  // gets its OWN copy under its own repo, so "A never sees B's rows" is a claim with something on
  // both sides of it.
  const seedFlow = async (
    accountId: number,
    repoId: number,
    tag: string,
    owner: { id: number },
    other: { id: number },
  ): Promise<void> => {
    for (let i = 0; i < 10; i++) {
      const openedAt = new Date(now.getTime() - (30 - i) * 24 * H);
      const [pr] = await db
        .insert(schema.pullRequests)
        .values({
          githubNodeId: `PR_flow_${tag}_${i}`,
          accountId,
          repoId,
          number: 900 + i,
          title: `${tag} flow fixture ${i}`,
          state: 'open',
          isDraft: false,
          authorId: other.id,
          openedAt,
          updatedAt: openedAt,
          additions: 120,
          deletions: 30,
          // ⚠ MUST equal files.length: the fold reads `changedFiles > files.length` as the sync's
          // 100-file truncation, and a mismatch here refuses single_reviewer_path outright.
          changedFiles: 1,
          files: [{ path: 'packages/api/handler.ts', additions: 120, deletions: 30 }],
        })
        .returning()
        .execute();
      // A SLOW first read (30h), and the concentrated reviewer takes 8 of 10.
      const reviewer = i < 8 ? owner : other;
      await db
        .insert(schema.reviews)
        .values({
          githubNodeId: `RV_flow_${tag}_${i}`,
          prId: pr!.id,
          authorId: reviewer.id,
          state: 'commented',
          submittedAt: new Date(openedAt.getTime() + 30 * H),
        })
        .execute();
      // ⚠ A SECOND review per PR. The bucket floor is TWO numbers — >=8 reviewed pull requests
      // AND >=12 human reviews — and ten PRs with one review each clears the first and misses the
      // second, which refuses the kind and leaves every assertion below vacuous.
      await db
        .insert(schema.reviews)
        .values({
          githubNodeId: `RV_flow2_${tag}_${i}`,
          prId: pr!.id,
          authorId: owner.id,
          state: 'commented',
          submittedAt: new Date(openedAt.getTime() + 34 * H),
        })
        .execute();
      await db
        .insert(schema.reviewThreads)
        .values({
          githubNodeId: `TH_flow_${tag}_${i}`,
          prId: pr!.id,
          path: 'packages/api/handler.ts',
          isResolved: false,
          isOutdated: false,
          derivedState: 'untouched',
          // NO `updatedAt` — `review_threads` has no such column (createdAt/resolvedAt only), and
          // the stray key was a compile error that broke `pnpm typecheck` for the whole backend.
          createdAt: openedAt,
        })
        .execute();
      // A FAST second directory drags the workspace median down, so the slow one stands out.
      const [fastPr] = await db
        .insert(schema.pullRequests)
        .values({
          githubNodeId: `PR_flowfast_${tag}_${i}`,
          accountId,
          repoId,
          number: 950 + i,
          title: `${tag} fast fixture ${i}`,
          state: 'open',
          isDraft: false,
          authorId: other.id,
          openedAt,
          updatedAt: openedAt,
          additions: 20,
          deletions: 5,
          changedFiles: 1,
          files: [{ path: 'docs/readme.md', additions: 20, deletions: 5 }],
        })
        .returning()
        .execute();
      await db
        .insert(schema.reviews)
        .values({
          githubNodeId: `RV_flowfast_${tag}_${i}`,
          prId: fastPr!.id,
          authorId: (i % 2 === 0 ? owner : other).id,
          state: 'commented',
          submittedAt: new Date(openedAt.getTime() + 1 * H),
        })
        .execute();
      await db
        .insert(schema.reviewThreads)
        .values({
          githubNodeId: `TH_flowfast_${tag}_${i}`,
          prId: fastPr!.id,
          path: 'docs/readme.md',
          isResolved: false,
          isOutdated: false,
          derivedState: 'untouched',
          // NO `updatedAt` — `review_threads` has no such column (createdAt/resolvedAt only), and
          // the stray key was a compile error that broke `pnpm typecheck` for the whole backend.
          createdAt: openedAt,
        })
        .execute();
    }
  };
  const [flowA1] = await db
    .insert(schema.users)
    .values({ githubLogin: 'flow-owner-a', githubNodeId: 'U_flow_a1', isBot: false })
    .returning()
    .execute();
  const [flowA2] = await db
    .insert(schema.users)
    .values({ githubLogin: 'flow-other-a', githubNodeId: 'U_flow_a2', isBot: false })
    .returning()
    .execute();
  const [flowB1] = await db
    .insert(schema.users)
    .values({ githubLogin: 'flow-owner-b', githubNodeId: 'U_flow_b1', isBot: false })
    .returning()
    .execute();
  const [flowB2] = await db
    .insert(schema.users)
    .values({ githubLogin: 'flow-other-b', githubNodeId: 'U_flow_b2', isBot: false })
    .returning()
    .execute();
  await seedFlow(1, A.repoId, 'a', flowA1!, flowA2!);
  await seedFlow(2, B.repoId, 'b', flowB1!, flowB2!);

  const aOut = await getFlowFindings(1, scopeA, WIN);
  const bOut = await getFlowFindings(2, scopeB, WIN);

  // ⚠ NON-VACUITY FIRST. Every assertion below is an `.every()` over findings/evidence/users, and
  // `[].every()` is `true` — so a fixture that produces NO findings turns this whole block into
  // six green lines that test nothing. That failure mode has already shipped here once (a
  // cross-repo check that was vacuous until the decoy repo got a red trunk), so the fixture's
  // productivity is asserted rather than assumed.
  const aEvidence = aOut.findings.flatMap((f) => f.evidence);
  check(
    'getFlowFindings FIXTURE IS PRODUCTIVE — findings, openable evidence AND a resolved actor',
    aOut.findings.length > 0 &&
      aEvidence.length > 0 &&
      aOut.findings.some((f) => f.actorIds.length > 0) &&
      aOut.users.length > 0,
  );

  check(
    'getFlowFindings echoes the scope it was handed, never another tenant workspace',
    aOut.workspaceId === scopeA.workspaceId && bOut.workspaceId === scopeB.workspaceId,
  );

  // Every evidence PR must belong to a repo in the caller's own workspace. `repoFullName` is the
  // cheap oracle: the fixture gives the two accounts disjoint repo names.
  const reposOf = async (accountId: number, scope: typeof scopeA): Promise<Set<string>> => {
    const rows = await db
      .select({ owner: schema.repos.owner, name: schema.repos.name })
      .from(schema.repos)
      .where(
        and(
          eq(schema.repos.accountId, accountId),
          scope.repoIds.length > 0
            ? inArray(schema.repos.id, scope.repoIds)
            : eq(schema.repos.id, -1),
        ),
      )
      .execute();
    return new Set(rows.map((r) => `${r.owner}/${r.name}`));
  };
  const ownA = await reposOf(1, scopeA);
  const ownB = await reposOf(2, scopeB);

  const evidenceRepos = (out: typeof aOut): string[] =>
    out.findings.flatMap((f) => f.evidence.map((e) => e.repoFullName));
  check(
    'getFlowFindings evidence names only repos inside the caller own workspace',
    evidenceRepos(aOut).every((r) => ownA.has(r)) && evidenceRepos(bOut).every((r) => ownB.has(r)),
  );

  // `users` is one of the two GLOBAL tables, so the resolution table is the leak that would not
  // look like one: an unscoped read there hands a tenant every login in the database.
  check(
    'getFlowFindings resolves ONLY the actors its own findings named — never the global users table',
    aOut.users.every((u) => aOut.findings.some((f) => f.actorIds.includes(u.id))) &&
      bOut.users.every((u) => bOut.findings.some((f) => f.actorIds.includes(u.id))),
  );

  // A repo-grained finding must carry a repoId the caller owns (null is legal — `size_latency` is
  // workspace-wide).
  const repoIdsOf = (out: typeof aOut): number[] =>
    out.findings.map((f) => f.repoId).filter((id): id is number => id != null);
  check(
    'getFlowFindings repoId on every finding is one of the caller own repos',
    repoIdsOf(aOut).every((id) => scopeA.repoIds.includes(id)) &&
      repoIdsOf(bOut).every((id) => scopeB.repoIds.includes(id)),
  );

  // The coverage line is a claim about the CALLER's workspace; counting another tenant's repos
  // into it would be a quiet cross-tenant disclosure in a footnote nobody audits.
  check(
    'getFlowFindings coverage counts the caller own repos only',
    aOut.coverage.reposInWorkspace === scopeA.repoIds.length &&
      bOut.coverage.reposInWorkspace === scopeB.repoIds.length,
  );

  // An EMPTY workspace must refuse, never widen to the account — the `[]`-is-a-real-answer rule.
  const emptyWs = await q.createWorkspace(1, 'iso-flow-empty');
  const emptyScope = await q.resolveWorkspaceScope(1, emptyWs.id);
  const emptyOut = await getFlowFindings(1, emptyScope, WIN);
  check(
    'getFlowFindings on an EMPTY workspace refuses rather than widening to the account',
    emptyOut.findings.length === 0 &&
      emptyOut.refusals.length === 4 &&
      emptyOut.coverage.prsScanned === 0,
  );
}

console.log(`\nISOLATION: ${pass} passed, ${fail} failed`);
await closeDb();
process.exit(fail === 0 ? 0 : 1);
