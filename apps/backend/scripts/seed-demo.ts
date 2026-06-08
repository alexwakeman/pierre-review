// Demo data seeder — populates a THROWAWAY sqlite DB with a small, fictional
// team's activity (acme/web-app + acme/api) for the README / landing-page
// screenshots. No real GitHub data, no PII. Dates are relative to "now" so the
// default 14-day timeline window always shows a full board.
//
// The local account (id 1) is pinned to "Morgan Diaz" so the My Turn triage
// panel resolves: two PRs awaiting Morgan's review and two #113 threads Morgan
// opened that someone else replied to. PR #113 also carries review threads (for
// the PR-detail shot) and a finished Claude Review run (for the Claude shot).
//
// Run against a throwaway DB (NEVER the real one):
//   pnpm --filter @pierre-review/backend seed:demo
//   (≡ DATABASE_URL=/tmp/pierre-demo.sqlite DISABLE_SCHEDULER=true tsx scripts/seed-demo.ts)
//
// To (re)capture the README / landing screenshots from this data, run an ISOLATED
// stack against the demo DB so your real :4000/:5173 dev server is untouched:
//   1. backend  : DATABASE_URL=/tmp/pierre-demo.sqlite PORT=4100 DISABLE_SCHEDULER=true \
//                 ENABLE_CLAUDE_REVIEW=true ANTHROPIC_API_KEY=dummy \
//                 pnpm --filter @pierre-review/backend exec tsx src/index.ts
//   2. frontend : BACKEND_PORT=4100 pnpm --filter @pierre-review/frontend exec vite --port 5273
//   3. capture  : drive http://localhost:5273/app/ (timeline) and …/app/?pr=113
//                 (PR-detail → Threads tab, then Claude Review tab) with a headless
//                 browser at viewport 1600×1000 @2x → 3200×2000 PNGs in
//                 apps/landing/public/shots/{timeline,pr-detail,claude-review}.png
import { rmSync } from 'node:fs';
import { config } from '../src/config.js';

if (!config.dbPath || config.dbPath.includes('pierre-review.sqlite')) {
  console.error(
    'Refusing to run: set DATABASE_URL to a throwaway path (not the real DB).',
  );
  process.exit(1);
}
// Delete any stale DB BEFORE importing client.ts (it opens the connection at
// module load, so importing first would leave us deleting an open file).
for (const suffix of ['', '-shm', '-wal']) {
  rmSync(config.dbPath + suffix, { force: true });
}

const { runMigrations } = await import('../src/db/run-migrations.js');
const { closeDb, db, schema } = await import('../src/db/client.js');
const { eq } = await import('drizzle-orm');

await runMigrations();

const now = new Date();
const day = (n: number): Date => new Date(now.getTime() - n * 86_400_000);
const min = (n: number): Date => new Date(now.getTime() - n * 60_000);

// ---- account (id 1 = "me" = Morgan Diaz) -----------------------------------
const ME = 1; // users.id for Morgan Diaz
await db
  .update(schema.accounts)
  .set({
    githubUserId: 'U_demo_morgan',
    githubLogin: 'morgan-diaz',
    avatarUrl: null,
    isLocal: true,
    lastLoginAt: now,
  })
  .where(eq(schema.accounts.id, 1))
  .execute();

// ---- users (global) --------------------------------------------------------
await db
  .insert(schema.users)
  .values([
    { id: 1, githubLogin: 'morgan-diaz', githubNodeId: 'U_morgan', displayName: 'Morgan Diaz', isBot: false },
    { id: 2, githubLogin: 'priya-nair', githubNodeId: 'U_priya', displayName: 'Priya Nair', isBot: false },
    { id: 3, githubLogin: 'lena-fischer', githubNodeId: 'U_lena', displayName: 'Lena Fischer', isBot: false },
    { id: 4, githubLogin: 'tom-becker', githubNodeId: 'U_tom', displayName: 'Tom Becker', isBot: false },
    { id: 5, githubLogin: 'sam-carter', githubNodeId: 'U_sam', displayName: 'Sam Carter', isBot: false },
    { id: 6, githubLogin: 'wei-zhang', githubNodeId: 'U_wei', displayName: 'Wei Zhang', isBot: false },
    { id: 7, githubLogin: 'dependabot', githubNodeId: 'U_dep', displayName: 'dependabot', isBot: true },
  ])
  .execute();

// ---- repos -----------------------------------------------------------------
const WEB = 1;
const API = 2;
await db
  .insert(schema.repos)
  .values([
    { id: WEB, accountId: 1, owner: 'acme', name: 'web-app', githubNodeId: 'R_web', defaultBranch: 'main', createdAt: day(40) },
    { id: API, accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_api', defaultBranch: 'main', createdAt: day(40) },
  ])
  .execute();
await db
  .insert(schema.syncState)
  .values([
    { repoId: WEB, lastFullSyncAt: day(7), lastIncrementalSyncAt: min(8), lastSyncStatus: 'ok' },
    { repoId: API, lastFullSyncAt: day(7), lastIncrementalSyncAt: min(8), lastSyncStatus: 'ok' },
  ])
  .execute();

// ---- pull requests ---------------------------------------------------------
// id == number for clarity (?pr=<id> opens the PR).
interface PrSeed {
  id: number;
  repoId: number;
  authorId: number;
  title: string;
  state: 'open' | 'merged' | 'closed';
  openedDaysAgo: number;
  closedDaysAgo?: number;
  mergedById?: number;
  ci?: 'success' | 'failure' | 'pending' | 'error';
  mergeable?: 'mergeable' | 'conflicting' | 'unknown';
  mss?: 'clean' | 'dirty' | 'blocked' | 'unstable';
  labels?: { name: string; color: string }[];
  checks?: { name: string; state: 'success' | 'failure' | 'pending' | 'neutral' | 'skipped' | 'error' | 'unknown'; url: string | null }[];
}

const PRS: PrSeed[] = [
  { id: 101, repoId: WEB, authorId: 4, title: 'Fix layout shift on the open-PR strip', state: 'open', openedDaysAgo: 6, ci: 'success', mergeable: 'mergeable', mss: 'clean', labels: [{ name: 'ui', color: '1f6feb' }], checks: [{ name: 'build', state: 'success', url: null }, { name: 'lint', state: 'success', url: null }, { name: 'e2e', state: 'success', url: null }] },
  { id: 102, repoId: WEB, authorId: 1, title: 'Extract the timeline lane packer', state: 'merged', openedDaysAgo: 8, closedDaysAgo: 3, mergedById: 4, labels: [{ name: 'refactor', color: 'a371f7' }] },
  { id: 110, repoId: WEB, authorId: 2, title: 'Persist detail-pane height to localStorage', state: 'merged', openedDaysAgo: 7, closedDaysAgo: 5, mergedById: 1 },
  { id: 112, repoId: WEB, authorId: 3, title: 'Keyboard nav for the open-PR strip', state: 'open', openedDaysAgo: 5, ci: 'pending', mergeable: 'mergeable', mss: 'blocked', labels: [{ name: 'a11y', color: '0e8a16' }], checks: [{ name: 'build', state: 'success', url: null }, { name: 'e2e', state: 'pending', url: null }] },
  { id: 103, repoId: WEB, authorId: 7, title: 'Bump vite from 5.4.2 to 5.4.8', state: 'merged', openedDaysAgo: 2, closedDaysAgo: 2, mergedById: 1, labels: [{ name: 'dependencies', color: '0366d6' }] },
  { id: 104, repoId: API, authorId: 6, title: 'Cache changed-file paths per commit', state: 'merged', openedDaysAgo: 6, closedDaysAgo: 4, mergedById: 1, labels: [{ name: 'perf', color: 'd93f0b' }] },
  { id: 105, repoId: API, authorId: 5, title: 'Add review-request webhook handler', state: 'open', openedDaysAgo: 4, ci: 'success', mergeable: 'conflicting', mss: 'dirty', checks: [{ name: 'build', state: 'success', url: null }, { name: 'test', state: 'success', url: null }] },
  { id: 106, repoId: API, authorId: 1, title: 'Backfill mergedBy on historical PRs', state: 'merged', openedDaysAgo: 5, closedDaysAgo: 2, mergedById: 5 },
  { id: 111, repoId: API, authorId: 5, title: 'Stream sync progress over SSE', state: 'open', openedDaysAgo: 5, ci: 'success', mergeable: 'mergeable', mss: 'clean', labels: [{ name: 'enhancement', color: 'a2eeef' }], checks: [{ name: 'build', state: 'success', url: null }, { name: 'test', state: 'success', url: null }, { name: 'typecheck', state: 'success', url: null }] },
  { id: 113, repoId: API, authorId: 2, title: 'Refactor the upsert transaction boundaries', state: 'open', openedDaysAgo: 3, ci: 'success', mergeable: 'mergeable', mss: 'clean', labels: [{ name: 'sync', color: 'fbca04' }, { name: 'needs-review', color: 'b60205' }], checks: [{ name: 'build', state: 'success', url: null }, { name: 'test', state: 'success', url: null }, { name: 'typecheck', state: 'success', url: null }] },
];

const prRows = PRS.map((p) => {
  const opened = day(p.openedDaysAgo);
  const closed = p.closedDaysAgo != null ? day(p.closedDaysAgo) : null;
  const lastCommit = p.state === 'merged' ? closed : day(Math.max(1, p.openedDaysAgo - 3));
  return {
    id: p.id,
    githubNodeId: `PR_${p.id}`,
    accountId: 1,
    repoId: p.repoId,
    number: p.id,
    title: p.title,
    body: `Demo PR — ${p.title}.`,
    authorId: p.authorId,
    mergedById: p.state === 'merged' ? (p.mergedById ?? p.authorId) : null,
    baseRefName: 'main',
    state: p.state,
    isDraft: false,
    openedAt: opened,
    firstReviewAt: p.state === 'open' ? day(Math.max(1, p.openedDaysAgo - 1)) : closed,
    lastCommitAt: lastCommit,
    mergedAt: p.state === 'merged' ? closed : null,
    closedAt: p.state === 'merged' ? closed : null,
    updatedAt: lastCommit ?? opened,
    headSha: `sha${p.id}headcommit`,
    ciStatus: p.ci ?? null,
    mergeable: p.mergeable ?? null,
    mergeStateStatus: p.mss ?? null,
    labels: p.labels ?? null,
    checkRuns: p.checks ?? null,
  };
});
await db.insert(schema.pullRequests).values(prRows).execute();

// ---- review requests (drive "awaiting your review") ------------------------
await db
  .insert(schema.reviewRequests)
  .values([
    { prId: 111, userId: ME }, // Sam's PR — awaiting Morgan
    { prId: 111, userId: 6 }, //  also Wei → "also requested 1"
    { prId: 112, userId: ME }, // Lena's PR — awaiting Morgan
    { prId: 112, userId: 4 }, //  also Tom → "also requested 1"
    { prId: 113, teamName: 'platform' }, // a team request, shown in detail
  ])
  .execute();

// ---- review threads + comments on #113 -------------------------------------
interface ThreadSeed {
  id: number;
  path: string;
  line: number;
  resolved: boolean;
  derived: 'resolved' | 'likely_addressed' | 'replied_unresolved' | 'untouched';
  opener: number;
  createdDaysAgo: number;
  comments: { author: number; body: string; daysAgo: number }[];
}

// daysAgo values are fractional so the files sort the way the shot wants:
// upsert.ts (the threads Morgan opened, surfaced in My Turn) newest → first.
const THREADS: ThreadSeed[] = [
  {
    id: 1, path: 'src/sync/upsert.ts', line: 88, resolved: false, derived: 'replied_unresolved', opener: ME, createdDaysAgo: 1.6,
    comments: [
      { author: ME, body: 'Can we batch these inserts? We do one INSERT per row inside the loop.', daysAgo: 1.6 },
      { author: 2, body: 'Batched in the latest push — now a single multi-row upsert.', daysAgo: 0.7 },
    ],
  },
  {
    id: 2, path: 'src/sync/upsert.ts', line: 142, resolved: false, derived: 'replied_unresolved', opener: ME, createdDaysAgo: 1.7,
    comments: [
      { author: ME, body: 'Should this run inside the same transaction as the PR upsert?', daysAgo: 1.7 },
      { author: 2, body: 'Good catch — moved it under runTransaction.', daysAgo: 0.6 },
    ],
  },
  {
    id: 4, path: 'src/db/queries.ts', line: 210, resolved: false, derived: 'untouched', opener: 5, createdDaysAgo: 2.4,
    comments: [
      { author: 5, body: 'Is the EXISTS subquery indexed? Could be slow on large event tables.', daysAgo: 2.4 },
    ],
  },
  {
    id: 5, path: 'src/db/queries.ts', line: 224, resolved: false, derived: 'likely_addressed', opener: 6, createdDaysAgo: 2.5,
    comments: [
      { author: 6, body: 'Consider batching these per-PR lookups into one query.', daysAgo: 2.5 },
    ],
  },
  {
    id: 3, path: 'src/sync/scheduler.ts', line: 40, resolved: true, derived: 'resolved', opener: 3, createdDaysAgo: 2.6,
    comments: [
      { author: 3, body: 'nit: pull this 5-minute interval into a named constant.', daysAgo: 2.6 },
      { author: 2, body: 'Done — extracted SYNC_INTERVAL_MS.', daysAgo: 2.1 },
    ],
  },
];

await db
  .insert(schema.reviewThreads)
  .values(
    THREADS.map((t) => ({
      id: t.id,
      githubNodeId: `RT_${t.id}`,
      prId: 113,
      path: t.path,
      line: t.line,
      isResolved: t.resolved,
      isOutdated: false,
      derivedState: t.derived,
      originalCommenterId: t.opener,
      createdAt: day(t.createdDaysAgo),
    })),
  )
  .execute();

let commentId = 1;
const reviewCommentRows = THREADS.flatMap((t) =>
  t.comments.map((c) => {
    const body = c.body;
    return {
      id: commentId,
      githubNodeId: `RC_${commentId++}`,
      threadId: t.id,
      prId: 113,
      authorId: c.author,
      body,
      excerpt: body.length > 160 ? `${body.slice(0, 159)}…` : body,
      diffHunk: `@@ -${t.line},3 +${t.line},4 @@`,
      databaseId: `${1_000_000 + t.id * 10 + 0}`,
      createdAt: day(c.daysAgo),
    };
  }),
);
await db.insert(schema.reviewComments).values(reviewCommentRows).execute();

// ---- reviews (approvers + review markers) ----------------------------------
interface ReviewSeed { id: number; prId: number; author: number; state: 'approved' | 'changes_requested' | 'commented'; daysAgo: number; body?: string }
const REVIEWS: ReviewSeed[] = [
  { id: 1, prId: 102, author: 4, state: 'approved', daysAgo: 3, body: 'LGTM — clean extraction.' },
  { id: 2, prId: 104, author: 1, state: 'approved', daysAgo: 4, body: 'Nice, the cache is a big win.' },
  { id: 3, prId: 106, author: 5, state: 'approved', daysAgo: 2, body: 'Approved.' },
  { id: 4, prId: 113, author: 5, state: 'commented', daysAgo: 1, body: 'A few questions inline.' },
  { id: 5, prId: 111, author: 6, state: 'commented', daysAgo: 2, body: 'Left some notes.' },
];
await db
  .insert(schema.reviews)
  .values(
    REVIEWS.map((r) => ({
      id: r.id,
      githubNodeId: `RV_${r.id}`,
      prId: r.prId,
      authorId: r.author,
      state: r.state,
      body: r.body ?? null,
      databaseId: `${2_000_000 + r.id}`,
      submittedAt: day(r.daysAgo),
    })),
  )
  .execute();

// ---- PR (issue-level) comments ---------------------------------------------
await db
  .insert(schema.prComments)
  .values([
    { id: 1, githubNodeId: 'PC_1', prId: 113, authorId: 4, body: 'Left a couple of thoughts on the transaction boundaries — otherwise looks great.', databaseId: '3000001', createdAt: day(1) },
    { id: 2, githubNodeId: 'PC_2', prId: 105, authorId: 1, body: 'Heads up: this conflicts with main after #106 landed.', databaseId: '3000002', createdAt: day(1) },
  ])
  .execute();

// ---- commits ---------------------------------------------------------------
let commitDbId = 1;
const commitRows: { id: number; sha: string; prId: number; authorId: number; committerId: number; message: string; committedAt: Date }[] = [];
for (const p of prRows) {
  const first = p.openedAt;
  const second = p.lastCommitAt ?? p.openedAt;
  commitRows.push({ id: commitDbId++, sha: `${p.headSha}-1`, prId: p.id, authorId: p.authorId!, committerId: p.authorId!, message: `${p.title}`, committedAt: first });
  if (second.getTime() !== first.getTime()) {
    commitRows.push({ id: commitDbId++, sha: `${p.headSha}-2`, prId: p.id, authorId: p.authorId!, committerId: p.authorId!, message: `Address review feedback`, committedAt: second });
  }
}
await db.insert(schema.commits).values(commitRows).execute();

// ---- events (the timeline feed) --------------------------------------------
let evId = 1;
const events: {
  id: number; accountId: number; repoId: number; actorId: number | null; prId: number | null;
  type: 'pr_opened' | 'pr_merged' | 'pr_closed' | 'review_submitted' | 'review_comment' | 'pr_comment' | 'commit_pushed';
  occurredAt: Date; refTable: string | null; refId: number | null; dedupeKey: string;
}[] = [];
const ev = (
  repoId: number, actorId: number | null, prId: number | null, type: typeof events[number]['type'],
  occurredAt: Date, refTable: string | null = null, refId: number | null = null,
): void => {
  const id = evId++;
  events.push({ id, accountId: 1, repoId, actorId, prId, type, occurredAt, refTable, refId, dedupeKey: `${type}:${prId}:${id}` });
};

for (const p of prRows) {
  ev(p.repoId, p.authorId, p.id, 'pr_opened', p.openedAt);
  if (p.state === 'merged' && p.mergedAt) ev(p.repoId, p.mergedById ?? p.authorId, p.id, 'pr_merged', p.mergedAt);
}
for (const c of commitRows) {
  const pr = prRows.find((p) => p.id === c.prId)!;
  ev(pr.repoId, c.authorId, c.prId, 'commit_pushed', c.committedAt, 'commits', c.id);
}
for (const r of REVIEWS) {
  const pr = prRows.find((p) => p.id === r.prId)!;
  ev(pr.repoId, r.author, r.prId, 'review_submitted', day(r.daysAgo), 'reviews', r.id);
}
for (const rc of reviewCommentRows) {
  ev(API, rc.authorId, 113, 'review_comment', rc.createdAt, 'review_threads', rc.threadId);
}
ev(API, 4, 113, 'pr_comment', day(1), 'pr_comments', 1);
ev(API, 1, 105, 'pr_comment', day(1), 'pr_comments', 2);
await db.insert(schema.events).values(events).execute();

// ---- Claude Review run + findings on #113 ----------------------------------
await db
  .insert(schema.claudeReviews)
  .values({
    id: 1,
    accountId: 1,
    prId: 113,
    headSha: 'sha113headcommit',
    status: 'succeeded',
    model: 'claude-sonnet-4-6',
    scope: 'diff_only',
    summary:
      'The transaction refactor is mostly solid. Two issues worth addressing before merge: the per-row inserts in `upsert.ts` should be batched, and a follow-up write escapes the transaction so a mid-run crash can half-persist a PR. The rest are nits and a question about indexing.',
    verdict: 'COMMENT',
    costUsd: 0.0842,
    inputTokens: 48213,
    outputTokens: 3104,
    numTurns: 6,
    excludedFiles: ['pnpm-lock.yaml'],
    createdAt: min(20),
    finishedAt: min(18),
  })
  .execute();

await db
  .insert(schema.claudeReviewFindings)
  .values([
    { id: 1, reviewId: 1, path: 'src/sync/upsert.ts', line: 88, side: 'RIGHT', severity: 'warning', title: 'Batch the per-row inserts', body: 'Each row triggers its own `INSERT` inside the loop, so a PR touching many files becomes N round-trips. Collapse into a single multi-row upsert.', diffHunk: '@@ -84,6 +84,9 @@ async function persistRows(rows) {\n   for (const row of rows) {\n+    await tx.insert(table).values(row)\n+      .onConflictDoUpdate({ target: table.nodeId, set: row })\n+      .execute();\n   }', anchored: true, included: true },
    { id: 2, reviewId: 1, path: 'src/sync/upsert.ts', line: 142, side: 'RIGHT', severity: 'blocker', title: 'Follow-up write escapes the transaction', body: '`saveReviewState()` runs *after* `runTransaction` returns, so a crash between the two leaves the PR persisted without its reviews. Move it inside the `tx` callback.', diffHunk: '@@ -138,7 +138,7 @@ await runTransaction(async (tx) => {\n   await persistPr(tx, pr);\n });\n-await saveReviewState(pr);\n+// should be inside the tx above', suggestion: 'await runTransaction(async (tx) => {\n  await persistPr(tx, pr);\n  await saveReviewState(tx, pr);\n});', anchored: true, included: true },
    { id: 3, reviewId: 1, path: 'src/db/queries.ts', line: 210, side: 'RIGHT', severity: 'nit', title: 'Name the magic interval', body: 'The literal `5 * 60 * 1000` appears here and in `scheduler.ts`. Extract a shared `SYNC_INTERVAL_MS` constant.', anchored: true, included: false },
    { id: 4, reviewId: 1, path: 'src/db/queries.ts', line: 224, side: 'RIGHT', severity: 'question', title: 'Is the correlated EXISTS indexed?', body: 'On large `events` tables this `EXISTS` could scan. Is `events(pr_id, actor_id)` covered by an index?', anchored: true, included: false },
    { id: 5, reviewId: 1, path: 'README.md', line: null, side: 'RIGHT', severity: 'praise', title: 'Good fixture coverage', body: 'Nice fixture-based tests for the new transaction path — they make the behaviour change easy to verify.', anchored: false, included: false },
  ])
  .execute();

console.log('Seeded demo data into', config.dbPath);
console.log('  repos: acme/web-app (1), acme/api (2)');
console.log('  me: Morgan Diaz (account 1 → users.id 1)');
console.log('  PR-detail / Claude shot: ?pr=113');
console.log('  open PRs:', prRows.filter((p) => p.state === 'open').map((p) => p.id).join(', '));

await closeDb();
