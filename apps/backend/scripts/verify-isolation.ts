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

// ── Cross-WORKSPACE comparison ──────────────────────────────────────────────────
// getWorkspaceComparison takes NO scope at all — it compares the caller's whole roster — so the
// ONLY isolation surface is `listWorkspaces(accountId)` plus the accountId inside each metric read.
// A leak would show as another tenant's workspace row, or as its PRs inside the caller's numbers.
// Landmine: B must already own a workspace WITH a repo, or the negative check passes on an empty
// account and is VACUOUS. wsB is seeded above — do not reorder.
const { getWorkspaceComparisonRows } = await import('../src/db/workspace-comparison.js');
const cmpA = await getWorkspaceComparisonRows(1);
const cmpB = await getWorkspaceComparisonRows(2);
check(
  "getWorkspaceComparisonRows(A) returns A's own workspaces only",
  cmpA.length > 0 && !cmpA.some((r) => r.workspaceId === wsB.id || r.workspaceId === defaultB),
);
check(
  "getWorkspaceComparisonRows(B) returns B's own workspaces only (blocked both ways)",
  cmpB.length > 0 && !cmpB.some((r) => r.workspaceId === defaultA),
);
check(
  "getWorkspaceComparisonRows(B) counts only B's repos",
  cmpB.reduce((n, r) => n + r.repoCount, 0) === 1,
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

console.log(`\nISOLATION: ${pass} passed, ${fail} failed`);
await closeDb();
process.exit(fail === 0 ? 0 : 1);
