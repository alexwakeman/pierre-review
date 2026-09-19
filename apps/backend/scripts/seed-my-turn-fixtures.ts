// MY TURN FIXTURES FOR A BROWSER CHECK — every card type, on a THROWAWAY COPY of the dev DB.
//
// WHY THIS EXISTS. The dev account is an observer: on the real data it has no open PR of its own, no
// review request, no thread reply and no mention on an open PR, so almost every My Turn type is
// invisible to a person clicking through the app. This writes one of each onto real PRs of one
// workspace, so Settings → My Turn can be exercised end to end: switch a type off and watch its
// card, its count and its brief line go; add own work and watch it MOVE out of its home tab.
//
// ⚠ IT REWRITES REAL ROWS (it makes the viewer the author of three PRs), so it REFUSES to run
// unless DATABASE_URL names a COPY — never the default dev database:
//
//   sqlite3 apps/backend/data/pierre-review.sqlite ".backup /tmp/pierre-myturn.sqlite"
//   cd apps/backend && DATABASE_URL=/tmp/pierre-myturn.sqlite \
//     ./node_modules/.bin/tsx scripts/seed-my-turn-fixtures.ts --workspace BNG
//   DATABASE_URL=/tmp/pierre-myturn.sqlite DISABLE_SCHEDULER=true PORT=4200 FRONTEND_PORT=5373 \
//     ./node_modules/.bin/tsx src/index.ts
//
// (`DISABLE_SCHEDULER=true` stops sync from rewriting the fixture rows.) Every inserted node id is
// prefixed `FIX_MT_`, and each fixture's PR link is printed.
import { config } from '../src/config.js';

if (!process.env.DATABASE_URL || /[/\\]data[/\\]pierre-review\.sqlite$/.test(config.dbPath)) {
  console.error(
    'Refusing to run: set DATABASE_URL to a throwaway COPY of the database, never the dev DB itself.',
  );
  process.exit(1);
}

const wsArg = process.argv.indexOf('--workspace');
const WORKSPACE = wsArg >= 0 ? process.argv[wsArg + 1] : undefined;
if (!WORKSPACE) {
  console.error('Usage: seed-my-turn-fixtures.ts --workspace <workspace name>');
  process.exit(1);
}

const { runMigrations } = await import('../src/db/run-migrations.js');
const { closeDb, db, schema } = await import('../src/db/client.js');
const { and, desc, eq, inArray } = await import('drizzle-orm');
const { globalAutomationUserIds } = await import('../src/db/automation-ids.js');
const { deriveMentionedPrs, syncAccountMentions } = await import('../src/db/pr-mentions.js');

await runMigrations();

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = Math.floor(Date.now() / 1000) * 1000;
const at = (msAgo: number) => new Date(now - msAgo);
const {
  accounts,
  users,
  repos,
  workspaces,
  workspaceRepos,
  pullRequests,
  reviewRequests,
  prComments,
  reviews,
  reviewThreads,
  reviewComments,
  commits,
  events,
} = schema;

// ── who "you" are, and where ────────────────────────────────────────────────────────────────
const [account] = await db.select().from(accounts).where(eq(accounts.id, 1)).execute();
const login = account?.githubLogin ?? '';
const [viewer] = login
  ? await db.select().from(users).where(eq(users.githubLogin, login)).execute()
  : [];
if (!viewer) {
  console.error(`No users row for the account's login (“${login}”) — nothing to seed as.`);
  process.exit(1);
}
const [ws] = await db
  .select()
  .from(workspaces)
  .where(and(eq(workspaces.accountId, 1), eq(workspaces.name, WORKSPACE)))
  .execute();
if (!ws) {
  console.error(`No workspace named “${WORKSPACE}” on account 1.`);
  process.exit(1);
}
const repoIds = (
  await db
    .select({ repoId: workspaceRepos.repoId })
    .from(workspaceRepos)
    .where(eq(workspaceRepos.workspaceId, ws.id))
    .execute()
).map((r) => r.repoId);
const repoRows = await db.select().from(repos).where(inArray(repos.id, repoIds)).execute();
const repoById = new Map(repoRows.map((r) => [r.id, r]));

// ── the PRs: open, non-draft, human, not yours, no dependency marker, newest first ────────────
const bots = await globalAutomationUserIds();
const open = (
  await db
    .select()
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.accountId, 1),
        inArray(pullRequests.repoId, repoIds),
        eq(pullRequests.state, 'open'),
        eq(pullRequests.isDraft, false),
      ),
    )
    .orderBy(desc(pullRequests.openedAt))
    .execute()
).filter(
  (p) =>
    p.authorId != null && p.authorId !== viewer.id && !bots.has(p.authorId) && p.dependencyVendor == null,
);
// Only "pushed since" needs a PR OPENED after its repo was added (it shares the New PRs admission
// rule); every other fixture's clock is the event it seeds, which is fresh.
const floored = open.filter(
  (p) => p.openedAt.getTime() >= (repoById.get(p.repoId)?.createdAt.getTime() ?? Infinity),
);
const E = floored[0];
const rest = open.filter((p) => p.id !== E?.id);
// SEVEN PRs, not eight: the thread reply is THREAD-grained, so it sits on the review-request PR
// beside that card (different jobs coexist — "one PR, one summons" binds only the PR-grained types).
if (E == null || rest.length < 6) {
  console.error(
    `Workspace “${WORKSPACE}” has ${open.length} suitable open PRs (${floored.length} opened after ` +
      'their repo was added); 7 are needed, one of them opened after its repo was added.',
  );
  process.exit(1);
}
const [A, B, D, F, G, H] = rest as [
  (typeof open)[number],
  (typeof open)[number],
  (typeof open)[number],
  (typeof open)[number],
  (typeof open)[number],
  (typeof open)[number],
];
const C = A;
const url = (p: (typeof open)[number]) => {
  const r = repoById.get(p.repoId)!;
  return `https://github.com/${r.owner}/${r.name}/pull/${p.number}`;
};
const printed: string[] = [];
const done = (what: string, p: (typeof open)[number]) => printed.push(`  ${what.padEnd(16)} ${url(p)}`);

// 1. review_request — a review requested of you.
await db.insert(reviewRequests).values({ prId: A.id, userId: viewer.id }).execute();
done('review_request', A);

// 2. mention — the author @-mentions you; the scanner itself stamps the row.
await db
  .insert(prComments)
  .values({
    prId: B.id,
    githubNodeId: 'FIX_MT_mention',
    authorId: B.authorId,
    body: `@${login} can you take a look?`,
    createdAt: at(2 * HOUR),
  })
  .execute();
await syncAccountMentions(1, login, await deriveMentionedPrs(1, login));
done('mention', B);

// 3. thread_reply — the author's thread, your reply, the author's answer.
const [threadC] = await db
  .insert(reviewThreads)
  .values({
    prId: C.id,
    githubNodeId: 'FIX_MT_thread_reply',
    path: 'README.md',
    isResolved: false,
    derivedState: 'replied_unresolved',
    originalCommenterId: C.authorId,
    createdAt: at(2 * DAY),
  })
  .returning()
  .execute();
for (const [tag, who, when, body] of [
  ['root', C.authorId, 2 * DAY, 'Should this section mention the new flag?'],
  ['mine', viewer.id, DAY, 'Yes — I think so.'],
  ['answer', C.authorId, 3 * HOUR, 'Done, can you have another look?'],
] as const) {
  await db
    .insert(reviewComments)
    .values({
      prId: C.id,
      threadId: threadC!.id,
      githubNodeId: `FIX_MT_thread_reply_${tag}`,
      authorId: who,
      body,
      createdAt: at(when),
    })
    .execute();
}
done('thread_reply', C);

// 4. comment_reply — your PR comment, then the author's.
await db
  .insert(prComments)
  .values([
    {
      prId: D.id,
      githubNodeId: 'FIX_MT_comment_mine',
      authorId: viewer.id,
      body: 'Is the migration safe to re-run?',
      createdAt: at(DAY),
    },
    {
      prId: D.id,
      githubNodeId: 'FIX_MT_comment_answer',
      authorId: D.authorId,
      body: 'It is — it checks the column first. Anything else?',
      createdAt: at(4 * HOUR),
    },
  ])
  .execute();
done('comment_reply', D);

// 5. pushed_since — your review, then the author pushes.
await db
  .insert(reviews)
  .values({
    prId: E.id,
    githubNodeId: 'FIX_MT_review_E',
    authorId: viewer.id,
    state: 'commented',
    submittedAt: at(3 * DAY),
  })
  .execute();
await db
  .insert(commits)
  .values({ sha: 'FIX_MT_sha_E', prId: E.id, authorId: E.authorId, committedAt: at(5 * HOUR) })
  .execute();
done('pushed_since', E);

// 6. own work — three PRs become yours (a throwaway copy), each with a fresh activity event.
const colleagueOfH = H.authorId!;
const own = async (p: (typeof open)[number], set: Record<string, unknown>) => {
  await db
    .update(pullRequests)
    .set({ authorId: viewer.id, ...set })
    .where(eq(pullRequests.id, p.id))
    .execute();
  await db
    .insert(events)
    .values({
      accountId: 1,
      repoId: p.repoId,
      prId: p.id,
      type: 'pr_opened',
      occurredAt: at(DAY),
      dedupeKey: `FIX_MT_event_${p.id}`,
    })
    .execute();
};
await own(F, { ciStatus: 'failure', mergeStateStatus: 'blocked', mergeable: 'mergeable' });
done('own_ci_red', F);
await own(G, { mergeStateStatus: 'dirty', mergeable: 'conflicting' });
done('own_conflicts', G);
await own(H, { ciStatus: 'success', mergeStateStatus: 'clean', mergeable: 'mergeable' });
await db
  .insert(reviews)
  .values({
    prId: H.id,
    githubNodeId: 'FIX_MT_approval_H',
    authorId: colleagueOfH,
    state: 'approved',
    submittedAt: at(6 * HOUR),
  })
  .execute();
done('own_ready', H);
// …and an unanswered thread on F by a colleague, older than the tab's one-day floor.
const [threadF] = await db
  .insert(reviewThreads)
  .values({
    prId: F.id,
    githubNodeId: 'FIX_MT_own_thread',
    path: 'src/index.ts',
    isResolved: false,
    derivedState: 'untouched',
    originalCommenterId: colleagueOfH,
    createdAt: at(30 * HOUR),
  })
  .returning()
  .execute();
await db
  .insert(reviewComments)
  .values({
    prId: F.id,
    threadId: threadF!.id,
    githubNodeId: 'FIX_MT_own_thread_root',
    authorId: colleagueOfH,
    body: 'This branch never closes the handle.',
    createdAt: at(30 * HOUR),
  })
  .execute();
done('own_thread', F);

// 7. trunk_red — a red default branch (DEFRA/bng-metric-backend when the workspace has it).
const trunk =
  repoRows.find((r) => r.owner === 'DEFRA' && r.name === 'bng-metric-backend') ?? repoRows[0]!;
await db
  .update(repos)
  .set({ defaultBranchCiStatus: 'failure', defaultBranchUpdatedAt: new Date(now) })
  .where(eq(repos.id, trunk.id))
  .execute();
printed.push(`  ${'trunk_red'.padEnd(16)} https://github.com/${trunk.owner}/${trunk.name}`);

console.log(`Seeded My Turn fixtures for @${login} in “${WORKSPACE}” (workspace ${ws.id}):`);
console.log(printed.join('\n'));
await closeDb();
