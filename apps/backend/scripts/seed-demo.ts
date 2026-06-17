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
// To (re)capture the landing screenshots from this data, run an ISOLATED stack
// against the demo DB so your real :4000/:5173 dev server is untouched, then drive
// scripts/capture-shots.mjs. NOTE: start the backend with `gh` OFF its PATH so
// ensureLocalAccount() can't overwrite the seeded "Morgan Diaz" identity with your
// real GitHub user (which empties the My Turn triage). Full recipe + the shot list
// in apps/landing/README.md ("Product screenshots"):
//   1. backend  : (gh off PATH) DATABASE_URL=/tmp/pierre-demo.sqlite PORT=4100 \
//                 DISABLE_SCHEDULER=true ENABLE_CLAUDE_REVIEW=true ANTHROPIC_API_KEY=dummy \
//                 node_modules/.bin/tsx src/index.ts   (from apps/backend)
//   2. frontend : BACKEND_PORT=4100 node_modules/.bin/vite --port 5273  (from apps/frontend)
//   3. capture  : node scripts/capture-shots.mjs       (all 10 shots → public/shots/)
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
    // displayName must be set (and lastLoginAt fresh) so ensureLocalAccount() treats
    // the row as "fresh" and SKIPS the `gh api user` refresh — otherwise a server
    // started against this demo DB overwrites Morgan with the host's real GitHub
    // identity and the My Turn triage (which targets users.id 1 = Morgan) goes empty.
    displayName: 'Morgan Diaz',
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
    // inboxWatch=true so the watched-repo activity Feed populates (and new open PRs
    // by others surface in the My Turn inbox). inboxWatchStartedAt well in the past
    // so all the recent curated activity falls inside the Feed's 14-day window.
    { id: WEB, accountId: 1, owner: 'acme', name: 'web-app', githubNodeId: 'R_web', defaultBranch: 'main', createdAt: day(40), inboxWatch: true, inboxWatchStartedAt: day(40) },
    { id: API, accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_api', defaultBranch: 'main', createdAt: day(40), inboxWatch: true, inboxWatchStartedAt: day(40) },
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

// ===========================================================================
// HISTORICAL ACTIVITY (weeks 3–12) — purely to populate the Insights/analytics
// charts (getRepoAnalytics, window = 84 days / 12 weeks). NONE of this touches
// the curated board: every PR below is MERGED/CLOSED with both openedAt AND its
// close instant strictly OLDER than 16 days ago, so the default 14-day timeline
// and the hero screenshots are unaffected. All ids are in a high, non-colliding
// range (PRs ≥ 200; reviews/threads/comments/commits/events ≥ 5000).
//
// Determinism: a fixed-seed mulberry32 PRNG (NO Math.random) so re-running the
// seeder produces byte-identical screenshots.
// ===========================================================================

// --- seeded PRNG (xmur3 seed → mulberry32) ---------------------------------
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}
function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seedFn = xmur3('pierre-review-demo-history-v1');
const rng = mulberry32(seedFn());
const rand = (): number => rng();
const randInt = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
// Right-skewed weighted choice over [value, weight] pairs.
const weighted = <T>(pairs: readonly (readonly [T, number])[]): T => {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [v, w] of pairs) {
    r -= w;
    if (r <= 0) return v;
  }
  return pairs[pairs.length - 1]![0];
};
const HOUR = 3_600_000;
const DAY_MS = 86_400_000;

// --- distributions ---------------------------------------------------------
// LOC size buckets, right-skewed: mostly S/M, some L, few XL, few XS. We pick a
// bucket, then a (additions, deletions, changedFiles) inside it.
type SizeBucket = 'XS' | 'S' | 'M' | 'L' | 'XL';
const SIZE_WEIGHTS: readonly (readonly [SizeBucket, number])[] = [
  ['XS', 6],
  ['S', 34],
  ['M', 38],
  ['L', 16],
  ['XL', 6],
];
const sizeFor = (b: SizeBucket): { additions: number; deletions: number; changedFiles: number } => {
  // loc = additions + deletions, kept inside the bucket's [lo, hi).
  const ranges: Record<SizeBucket, [number, number, number, number]> = {
    // [locLo, locHi, filesLo, filesHi]
    XS: [2, 9, 1, 2],
    S: [12, 49, 1, 5],
    M: [60, 199, 2, 12],
    L: [220, 499, 5, 22],
    XL: [520, 1400, 14, 60],
  };
  const [lo, hi, fLo, fHi] = ranges[b];
  const loc = randInt(lo, hi);
  // Skew toward additions but keep some deletions.
  const delFrac = 0.15 + rand() * 0.45;
  const deletions = Math.max(0, Math.min(loc - 1, Math.round(loc * delFrac)));
  const additions = loc - deletions;
  return { additions, deletions, changedFiles: randInt(fLo, fHi) };
};

// First-review latency buckets (hours), spread so the latency dist + cycle-time
// breakdown + TTFR trend all populate. ~15% never reviewed (handled below).
const LATENCY_WEIGHTS: readonly (readonly [[number, number], number])[] = [
  [[0.2, 1], 10], // <1h
  [[1, 4], 22], // 1–4h
  [[4, 24], 30], // 4–24h
  [[24, 72], 24], // 1–3d
  [[72, 200], 14], // >3d
];

const reviewTitlesByRepo: Record<number, readonly string[]> = {
  [WEB]: [
    'Memoize the timeline lane packer',
    'Fix focus-mode scroll jitter on rebuild',
    'Debounce the repo-search picker',
    'Persist per-row collapse to localStorage',
    'Virtualize the open-PR strip',
    'Tidy the zebra-tint repo ranking',
    'Add keyboard shortcuts to the detail pane',
    'Cache PR detail in IndexedDB',
    'Show maintainer shield in PR context',
    'Cluster event markers at coarse zoom',
    'Improve dark-mode contrast on markers',
    'Handle empty timeline gracefully',
    'Reduce forced reflows in the sync modal',
    'Flatten the thread-list grouping',
    'Wire the Now action to recenter',
    'Trim the focus popover to one PR',
    'Fix off-by-one in lane assignment',
    'Add a custom date-range preset',
    'Round avatar fallbacks consistently',
    'Lazy-load the Insights charts',
  ],
  [API]: [
    'Batch per-row upserts in the sync loop',
    'Add an index on events(repo_id, occurred_at)',
    'Tighten the maintainer-merge inference',
    'Backfill baseRefName on old PRs',
    'Cancel in-flight syncs cleanly',
    'Add overlap window to incremental sync',
    'Cache commit changed-files permanently',
    'Hydrate detail on demand under lean mode',
    'Dedupe events on a composite key',
    'Skip idle accounts in the periodic sync',
    'Two-phase backfill for new repos',
    'Stream sync progress over SSE',
    'Guard against octokit query var clash',
    'Make body columns nullable for lean storage',
    'Add a health endpoint',
    'Fix rate-limit backoff jitter',
    'Scope every getter to accountId',
    'Persist diff size on the PR row',
    'Compute triage fields on read',
    'Add the substantive-review event filter',
  ],
};

interface HistPr {
  id: number;
  repoId: number;
  authorId: number;
  title: string;
  state: 'merged' | 'closed';
  openedAt: Date;
  closeAt: Date; // mergedAt or closedAt
  firstReviewAt: Date | null;
  lastCommitAt: Date;
  mergedById: number | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  longLived: boolean;
}

const HUMAN_AUTHORS = [1, 2, 3, 4, 5, 6] as const; // exclude dependabot from "normal" weighting
const REVIEWERS = [1, 2, 3, 4, 5, 6] as const;

// Place commit/review/event timestamps on a realistic work-hours pattern:
// busier Tue–Thu, 9–18 UTC, lighter weekends/nights. We nudge a base instant
// toward a "work moment" within a day or two of it.
const WORKDAY_WEIGHTS: readonly (readonly [number, number])[] = [
  [0, 2], // Sun
  [1, 7], // Mon
  [2, 10], // Tue
  [3, 11], // Wed
  [4, 9], // Thu
  [5, 6], // Fri
  [6, 2], // Sat
];
const WORKHOUR_WEIGHTS: readonly (readonly [number, number])[] = [
  [9, 8],
  [10, 12],
  [11, 11],
  [12, 7],
  [13, 9],
  [14, 12],
  [15, 11],
  [16, 9],
  [17, 6],
  [18, 4],
  [8, 3],
  [19, 2],
  [20, 1],
  [22, 1],
];
// Snap a Date to a nearby work-hours moment, staying within [floor, base].
const workMoment = (base: Date, floor: Date): Date => {
  const targetDow = weighted(WORKDAY_WEIGHTS);
  const targetHour = weighted(WORKHOUR_WEIGHTS);
  // Walk back up to 3 days from `base` to land on the chosen weekday.
  const b = new Date(base.getTime());
  for (let i = 0; i < 4; i++) {
    if (b.getUTCDay() === targetDow) break;
    b.setUTCDate(b.getUTCDate() - 1);
  }
  b.setUTCHours(targetHour, randInt(0, 59), randInt(0, 59), 0);
  let ms = b.getTime();
  if (ms > base.getTime()) {
    // Overshot: step back a whole day and re-snap the hour into the work band so
    // the fallback doesn't inherit `base`'s (uniform-random) clock hour.
    b.setUTCDate(b.getUTCDate() - 1);
    b.setUTCHours(weighted(WORKHOUR_WEIGHTS), randInt(0, 59), randInt(0, 59), 0);
    ms = b.getTime();
  }
  if (ms > base.getTime()) ms = base.getTime() - randInt(1, 6) * HOUR;
  if (ms < floor.getTime()) ms = floor.getTime() + randInt(1, 4) * HOUR;
  return new Date(ms);
};

// --- generate the historical PRs across weeks 3–12 (16d → 84d ago) ---------
const histPrs: HistPr[] = [];
let histPrId = 200;
const titleCursor: Record<number, number> = { [WEB]: 0, [API]: 0 };

// 10 weekly cohorts ending at ~16d ago and reaching back to ~86d ago. A gentle
// upward trend (older weeks slightly quieter) reads well on the throughput chart.
const COHORTS = 10;
for (let w = 0; w < COHORTS; w++) {
  // w=0 is the OLDEST cohort (~week 12), w=COHORTS-1 the most recent (~week 3).
  const weekEndDaysAgo = 16 + w * 7; // newest cohort opens ~16–23d ago (>16d close, see below)
  const weekStartDaysAgo = weekEndDaysAgo + 7;
  // Opened per week ramps from ~5 (oldest) to ~8 (most recent).
  const opensThisWeek = 5 + Math.round((w / (COHORTS - 1)) * 3) + (rand() < 0.4 ? 1 : 0);
  for (let k = 0; k < opensThisWeek; k++) {
    const repoId = rand() < 0.55 ? WEB : API;
    // ~12% dependabot PRs (bots), else a weighted human author.
    const isDep = rand() < 0.12;
    const authorId = isDep ? 7 : pick(HUMAN_AUTHORS);

    // openedAt somewhere inside this cohort's week.
    const openedDaysAgo = weekStartDaysAgo - rand() * 7;
    const openedAt = day(openedDaysAgo);

    // Lifetime: most close within a few days; a few long-lived (2–4 weeks) to
    // keep the backlog/stalled lines non-zero. Clamp so closeAt is STILL >16d ago.
    const longLived = rand() < 0.16;
    const lifeDays = longLived ? 14 + rand() * 14 : 0.4 + rand() * 6;
    let closeDaysAgo = openedDaysAgo - lifeDays;
    if (closeDaysAgo < 16.5) closeDaysAgo = 16.5 + rand() * 1.5; // never inside 16d
    const closeAt = day(closeDaysAgo);

    // ~85% merged, ~15% closed-unmerged.
    const merged = rand() < 0.85;
    const state: 'merged' | 'closed' = merged ? 'merged' : 'closed';
    const mergedById = merged ? pick(REVIEWERS.filter((u) => u !== authorId)) ?? 1 : null;

    // size
    const sz = sizeFor(weighted(SIZE_WEIGHTS));

    // first review: ~85% reviewed (dependabot less often). Latency from the dist,
    // but never after the close instant.
    const reviewed = (isDep ? rand() < 0.55 : rand() < 0.85);
    let firstReviewAt: Date | null = null;
    if (reviewed) {
      const [loH, hiH] = weighted(LATENCY_WEIGHTS);
      const lat = (loH + rand() * (hiH - loH)) * HOUR;
      let frMs = openedAt.getTime() + lat;
      // keep strictly before close (and at least a little before)
      const ceiling = closeAt.getTime() - HOUR;
      if (frMs > ceiling) frMs = openedAt.getTime() + Math.max(HOUR, (ceiling - openedAt.getTime()) * (0.3 + rand() * 0.5));
      if (frMs <= openedAt.getTime()) frMs = openedAt.getTime() + HOUR;
      firstReviewAt = new Date(frMs);
    }

    // lastCommitAt: long-lived PRs go stale (old last commit) to drive "stalled";
    // others commit up to near their close.
    let lastCommitAt: Date;
    if (longLived) {
      // last commit shortly after open → stale by week's end.
      lastCommitAt = new Date(openedAt.getTime() + (1 + rand() * 3) * DAY_MS);
    } else {
      lastCommitAt = new Date(
        openedAt.getTime() + Math.max(HOUR, (closeAt.getTime() - openedAt.getTime()) * (0.5 + rand() * 0.4)),
      );
    }

    histPrs.push({
      id: histPrId++,
      repoId,
      authorId,
      title:
        reviewTitlesByRepo[repoId]![titleCursor[repoId]!++ % reviewTitlesByRepo[repoId]!.length]!,
      state,
      openedAt,
      closeAt,
      firstReviewAt,
      lastCommitAt,
      mergedById,
      additions: sz.additions,
      deletions: sz.deletions,
      changedFiles: sz.changedFiles,
      longLived,
    });
  }
}

// --- rows: pull_requests ---------------------------------------------------
const histPrRows = histPrs.map((p) => ({
  id: p.id,
  githubNodeId: `PR_${p.id}`,
  accountId: 1,
  repoId: p.repoId,
  number: p.id,
  title: p.title,
  body: `Demo PR — ${p.title}.`,
  authorId: p.authorId,
  mergedById: p.mergedById,
  baseRefName: 'main',
  state: p.state,
  isDraft: false,
  openedAt: p.openedAt,
  firstReviewAt: p.firstReviewAt,
  lastCommitAt: p.lastCommitAt,
  mergedAt: p.state === 'merged' ? p.closeAt : null,
  closedAt: p.closeAt,
  updatedAt: p.closeAt,
  headSha: `sha${p.id}headcommit`,
  ciStatus: 'success' as const,
  mergeable: 'mergeable' as const,
  mergeStateStatus: 'clean' as const,
  labels: null,
  checkRuns: null,
  additions: p.additions,
  deletions: p.deletions,
  changedFiles: p.changedFiles,
}));
await db.insert(schema.pullRequests).values(histPrRows).execute();

// --- rows: reviews / threads / comments / commits / events -----------------
let hReviewId = 5000;
let hThreadId = 5000;
let hCommentId = 5000;
let hCommitId = 5000;
let hEventId = 5000;

const histReviewRows: {
  id: number; githubNodeId: string; prId: number; authorId: number;
  state: 'approved' | 'changes_requested' | 'commented' | 'dismissed' | 'pending';
  body: string | null; databaseId: string; submittedAt: Date;
}[] = [];
const histThreadRows: {
  id: number; githubNodeId: string; prId: number; path: string; line: number;
  isResolved: boolean; isOutdated: boolean;
  derivedState: 'resolved' | 'likely_addressed' | 'replied_unresolved' | 'untouched';
  originalCommenterId: number; createdAt: Date;
}[] = [];
const histCommentRows: {
  id: number; githubNodeId: string; threadId: number; prId: number; authorId: number;
  body: string; excerpt: string; diffHunk: string; databaseId: string; createdAt: Date;
}[] = [];
const histCommitRows: {
  id: number; sha: string; prId: number; authorId: number; committerId: number; message: string; committedAt: Date;
}[] = [];
const histEventRows: {
  id: number; accountId: number; repoId: number; actorId: number | null; prId: number | null;
  type:
    | 'pr_opened' | 'pr_merged' | 'pr_closed' | 'pr_reopened' | 'pr_ready_for_review'
    | 'review_submitted' | 'review_comment' | 'pr_comment' | 'commit_pushed';
  occurredAt: Date; refTable: string | null; refId: number | null; dedupeKey: string;
}[] = [];

let evCounter = 0;
const pushEvent = (
  repoId: number, actorId: number | null, prId: number, type: typeof histEventRows[number]['type'],
  occurredAt: Date, refTable: string | null = null, refId: number | null = null,
): void => {
  const id = hEventId++;
  histEventRows.push({
    id, accountId: 1, repoId, actorId, prId, type, occurredAt, refTable, refId,
    dedupeKey: `${type}:${prId}:${evCounter++}`,
  });
};

// Verdict mix: mostly approved, regular changes_requested, some commented, rare
// dismissed. (getRepoAnalytics counts approved/changes_requested/commented/dismissed.)
const VERDICTS: readonly (readonly ['approved' | 'changes_requested' | 'commented' | 'dismissed', number])[] = [
  ['approved', 58],
  ['changes_requested', 22],
  ['commented', 16],
  ['dismissed', 4],
];

// Thread derived-state mix: more resolved/likely than untouched.
const THREAD_STATE_WEIGHTS: readonly (readonly [
  'resolved' | 'likely_addressed' | 'replied_unresolved' | 'untouched', number,
])[] = [
  ['resolved', 40],
  ['likely_addressed', 28],
  ['replied_unresolved', 20],
  ['untouched', 12],
];

const THREAD_PATHS = [
  'src/index.ts', 'src/app.ts', 'src/db/queries.ts', 'src/sync/upsert.ts',
  'src/sync/sync-repo.ts', 'src/api/routes/timeline.ts', 'src/lib/ui.ts',
  'src/components/Timeline/lanes.ts', 'README.md', 'src/config.ts',
] as const;

for (const p of histPrs) {
  // ----- reviews: 1–3 per PR, by distinct reviewers (never the author) -----
  const reviewerPool = REVIEWERS.filter((u) => u !== p.authorId);
  const nReviews = p.firstReviewAt ? randInt(1, 3) : (rand() < 0.25 ? 1 : 0);
  const usedReviewers = new Set<number>();
  for (let i = 0; i < nReviews && usedReviewers.size < reviewerPool.length; i++) {
    let reviewer = pick(reviewerPool);
    let guard = 0;
    while (usedReviewers.has(reviewer) && guard++ < 8) reviewer = pick(reviewerPool);
    usedReviewers.add(reviewer);
    const verdict = weighted(VERDICTS);
    // submittedAt: from firstReviewAt onward, before close, inside the window.
    const base = (p.firstReviewAt ?? p.openedAt).getTime();
    const span = Math.max(HOUR, p.closeAt.getTime() - base);
    let subMs = base + (i === 0 ? 0 : rand() * span);
    if (subMs > p.closeAt.getTime()) subMs = p.closeAt.getTime() - randInt(1, 4) * HOUR;
    const submittedAt = workMoment(new Date(subMs), p.openedAt);
    const rid = hReviewId++;
    histReviewRows.push({
      id: rid, githubNodeId: `RV_${rid}`, prId: p.id, authorId: reviewer,
      state: verdict, body: null, databaseId: `${2_500_000 + rid}`, submittedAt,
    });
    pushEvent(p.repoId, reviewer, p.id, 'review_submitted', submittedAt, 'reviews', rid);
  }

  // ----- review threads: 0–4 per PR -----
  const nThreads = weighted([
    [0, 14],
    [1, 30],
    [2, 28],
    [3, 18],
    [4, 10],
  ] as const);
  for (let i = 0; i < nThreads; i++) {
    const tid = hThreadId++;
    const derivedState = weighted(THREAD_STATE_WEIGHTS);
    const opener = pick(reviewerPool);
    // createdAt within the open window (after open, before close), in the chart window.
    const span = Math.max(HOUR, p.closeAt.getTime() - p.openedAt.getTime());
    const createdAt = workMoment(
      new Date(p.openedAt.getTime() + (0.2 + rand() * 0.6) * span),
      p.openedAt,
    );
    histThreadRows.push({
      id: tid, githubNodeId: `RT_${tid}`, prId: p.id, path: pick(THREAD_PATHS),
      line: randInt(8, 320), isResolved: derivedState === 'resolved', isOutdated: rand() < 0.1,
      derivedState, originalCommenterId: opener, createdAt,
    });
    // one comment per thread (charts don't need more, but it keeps events richer)
    const body = pick([
      'Could we simplify this branch?',
      'Is this covered by a test?',
      'nit: rename for clarity.',
      'This allocates on the hot path — worth caching?',
      'Edge case: what if the array is empty?',
      'Consider extracting a helper here.',
    ] as const);
    const cid = hCommentId++;
    histCommentRows.push({
      id: cid, githubNodeId: `RC_${cid}`, threadId: tid, prId: p.id, authorId: opener,
      body, excerpt: body, diffHunk: `@@ -10,3 +10,4 @@`, databaseId: `${1_500_000 + cid}`,
      createdAt,
    });
    pushEvent(p.repoId, opener, p.id, 'review_comment', createdAt, 'review_threads', tid);
  }

  // ----- commits: 1–4, spread across work-hours weekdays for the heatmap -----
  const nCommits = weighted([
    [1, 26],
    [2, 36],
    [3, 24],
    [4, 14],
  ] as const);
  for (let i = 0; i < nCommits; i++) {
    const cid = hCommitId++;
    // spread commits between open and lastCommit, then snap to a work moment.
    const lo = p.openedAt.getTime();
    const hi = Math.max(lo + HOUR, p.lastCommitAt.getTime());
    const frac = nCommits === 1 ? rand() : i / (nCommits - 1);
    const committedAt = workMoment(new Date(lo + frac * (hi - lo)), p.openedAt);
    histCommitRows.push({
      id: cid, sha: `sha${p.id}c${i}`, prId: p.id, authorId: p.authorId, committerId: p.authorId,
      message: i === 0 ? p.title : pick(['Address review feedback', 'Fix lint', 'Add tests', 'Tidy up']),
      committedAt,
    });
    pushEvent(p.repoId, p.authorId, p.id, 'commit_pushed', committedAt, 'commits', cid);
  }

  // ----- lifecycle events -----
  // The PR ROW keeps its exact open/close instants (the size/cycle/backlog charts
  // depend on them); the EVENTS for the heatmap are snapped to nearby work moments
  // so weekday×hour reads as a real work-hours pattern rather than uniform noise.
  // (openedAt floors at openedAt − a few days so the snapped opener stays sane.)
  const openedEvAt = workMoment(p.openedAt, new Date(p.openedAt.getTime() - 3 * DAY_MS));
  pushEvent(p.repoId, p.authorId, p.id, 'pr_opened', openedEvAt);
  const closeEvAt = workMoment(p.closeAt, new Date(p.closeAt.getTime() - 3 * DAY_MS));
  if (p.state === 'merged') {
    pushEvent(p.repoId, p.mergedById ?? p.authorId, p.id, 'pr_merged', closeEvAt);
  } else {
    pushEvent(p.repoId, p.authorId, p.id, 'pr_closed', closeEvAt);
  }
}

if (histReviewRows.length) await db.insert(schema.reviews).values(histReviewRows).execute();
if (histThreadRows.length) await db.insert(schema.reviewThreads).values(histThreadRows).execute();
if (histCommentRows.length) await db.insert(schema.reviewComments).values(histCommentRows).execute();
if (histCommitRows.length) await db.insert(schema.commits).values(histCommitRows).execute();
if (histEventRows.length) await db.insert(schema.events).values(histEventRows).execute();

console.log('Seeded demo data into', config.dbPath);
console.log('  repos: acme/web-app (1), acme/api (2)');
console.log('  me: Morgan Diaz (account 1 → users.id 1)');
console.log('  PR-detail / Claude shot: ?pr=113');
console.log('  open PRs:', prRows.filter((p) => p.state === 'open').map((p) => p.id).join(', '));
console.log(
  `  history: ${histPrs.length} PRs (ids ${histPrs[0]?.id}–${histPrs[histPrs.length - 1]?.id}),`,
  `${histReviewRows.length} reviews, ${histThreadRows.length} threads,`,
  `${histCommitRows.length} commits, ${histEventRows.length} events (weeks 3–12)`,
);

await closeDb();
