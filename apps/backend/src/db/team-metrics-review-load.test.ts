// getTeamMetrics review-load-per-PR (human vs bot) trend, on a THROWAWAY sqlite DB. Seeds merged
// PRs in KNOWN merge weeks with a KNOWN mix of human/bot review touches (reviews + inline + issue
// comments), then locks the per-week reviewLoad math — the cross-repo Feed chart showing whether
// human scrutiny keeps pace with bots per shipped PR.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-team-metrics-review-load-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let q: any;

const DAY = 24 * 60 * 60 * 1000;
// nowMs is passed INTO getTeamMetrics, so the bucket math is fully deterministic off this value
// (no test→call clock drift). bucket = floor((84 − mergedDaysAgo) / 7): 5→11, 4→11, 30→7.
const now = Math.floor(Date.now() / 1000) * 1000;
let repoId = 0;
let alice = 0;
let bot = 0;
let threadSeq = 0;

async function mergedPr(n: number, mergedDaysAgo: number): Promise<number> {
  const { pullRequests } = schema;
  const mergedAt = new Date(now - mergedDaysAgo * DAY);
  const [pr] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: `PR_rl${n}`,
      accountId: 1,
      repoId,
      number: n,
      title: `review-load fixture ${n}`,
      state: 'merged',
      isDraft: false,
      openedAt: new Date(now - (mergedDaysAgo + 1) * DAY),
      mergedAt,
      updatedAt: mergedAt,
    })
    .returning()
    .execute();
  return pr.id;
}

async function addReview(prId: number, authorId: number): Promise<void> {
  const { reviews } = schema;
  await db
    .insert(reviews)
    .values({
      githubNodeId: `RV_rl${prId}_${authorId}_${threadSeq++}`,
      prId,
      authorId,
      state: 'commented',
      submittedAt: new Date(now - DAY),
    })
    .execute();
}

async function addInlineComment(prId: number, authorId: number): Promise<void> {
  const { reviewThreads, reviewComments } = schema;
  const [thread] = await db
    .insert(reviewThreads)
    .values({
      githubNodeId: `T_rl${threadSeq++}`,
      prId,
      path: 'src/a.ts',
      line: 1,
      isResolved: false,
      isOutdated: false,
      derivedState: 'untouched',
      originalCommenterId: authorId,
      createdAt: new Date(now - DAY),
    })
    .returning()
    .execute();
  await db
    .insert(reviewComments)
    .values({
      githubNodeId: `RC_rl${threadSeq++}`,
      threadId: thread.id,
      prId,
      authorId,
      excerpt: 'nit',
      createdAt: new Date(now - DAY),
    })
    .execute();
}

async function addIssueComment(prId: number, authorId: number): Promise<void> {
  const { prComments } = schema;
  await db
    .insert(prComments)
    .values({
      githubNodeId: `PC_rl${threadSeq++}`,
      prId,
      authorId,
      createdAt: new Date(now - DAY),
    })
    .execute();
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  q = await import('./queries.js');
  await runMigrations();

  const { repos, users } = schema;
  const [repo] = await db
    .insert(repos)
    .values({ accountId: 1, owner: 'acme', name: 'rl', githubNodeId: 'R_rl', inboxWatch: true })
    .returning()
    .execute();
  repoId = repo.id;
  const [a] = await db
    .insert(users)
    .values({ githubLogin: 'alice', githubNodeId: 'U_rl_a', isBot: false })
    .returning()
    .execute();
  alice = a.id;
  const [b] = await db
    .insert(users)
    .values({ githubLogin: 'coderabbitai', githubNodeId: 'U_rl_b', isBot: true })
    .returning()
    .execute();
  bot = b.id;

  // Bucket 11: M1 (human 3 = 1 review + 2 inline, bot 3 inline) + M2 (human 1 review, bot 2 =
  // 1 review + 1 issue comment). → human (3+1)/2 = 2, bot (3+2)/2 = 2.5.
  const m1 = await mergedPr(1, 5);
  await addReview(m1, alice);
  await addInlineComment(m1, alice);
  await addInlineComment(m1, alice);
  await addInlineComment(m1, bot);
  await addInlineComment(m1, bot);
  await addInlineComment(m1, bot);
  const m2 = await mergedPr(2, 4);
  await addReview(m2, alice);
  await addReview(m2, bot);
  await addIssueComment(m2, bot);

  // Bucket 7: M3 merged with ZERO review touches → a real 0 load (shipped unreviewed).
  await mergedPr(3, 30);
});

afterAll(() => closeDb?.());

describe('getTeamMetrics — review load per merged PR (human vs bot)', () => {
  it('averages human/bot review touches over the PRs merged that week', async () => {
    const m = await q.getTeamMetrics(1, [repoId], now, undefined);
    expect(m).not.toBeNull();
    expect(m.reviewLoad).toBeDefined();
    // Bucket 11: 2 merges, human load 2, bot load 2.5.
    expect(m.throughput.merged[11]).toBe(2);
    expect(m.reviewLoad.human[11]).toBe(2);
    expect(m.reviewLoad.bot[11]).toBe(2.5);
    // Bucket 7: 1 merge, no review touches → a genuine 0 (not null).
    expect(m.throughput.merged[7]).toBe(1);
    expect(m.reviewLoad.human[7]).toBe(0);
    expect(m.reviewLoad.bot[7]).toBe(0);
  });

  it('reports null load (not 0) for a week with no merges', async () => {
    const m = await q.getTeamMetrics(1, [repoId], now, undefined);
    expect(m.throughput.merged[0]).toBe(0);
    expect(m.reviewLoad.human[0]).toBeNull();
    expect(m.reviewLoad.bot[0]).toBeNull();
  });
});
