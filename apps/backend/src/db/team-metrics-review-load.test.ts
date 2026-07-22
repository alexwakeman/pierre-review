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

async function mergedPr(n: number, mergedDaysAgo: number, firstReviewDaysAgo?: number): Promise<number> {
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
      openedAt: new Date(now - (mergedDaysAgo + 4) * DAY),
      firstReviewAt: firstReviewDaysAgo != null ? new Date(now - firstReviewDaysAgo * DAY) : null,
      mergedAt,
      updatedAt: mergedAt,
    })
    .returning()
    .execute();
  return pr.id;
}

async function addReview(prId: number, authorId: number, state = 'commented'): Promise<void> {
  const { reviews } = schema;
  await db
    .insert(reviews)
    .values({
      githubNodeId: `RV_rl${prId}_${authorId}_${threadSeq++}`,
      prId,
      authorId,
      state,
      submittedAt: new Date(now - DAY),
    })
    .execute();
}

async function addCommit(prId: number, committedDaysAgo: number): Promise<void> {
  const { commits } = schema;
  await db
    .insert(commits)
    .values({
      sha: `sha_rl${prId}_${threadSeq++}`,
      prId,
      committedAt: new Date(now - committedDaysAgo * DAY),
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

  // Bucket 11: M1 (human 3 = 1 review + 2 inline, bot 3 inline; the review is CHANGES-REQUESTED)
  // + M2 (human 1 review, bot 2 = 1 review + 1 issue comment). → human (3+1)/2 = 2, bot (3+2)/2 =
  // 2.5; both human-reviewed; changes-requested rate 1/2 = 50%.
  const m1 = await mergedPr(1, 5);
  await addReview(m1, alice, 'changes_requested');
  await addInlineComment(m1, alice);
  await addInlineComment(m1, alice);
  await addInlineComment(m1, bot);
  await addInlineComment(m1, bot);
  await addInlineComment(m1, bot);
  const m2 = await mergedPr(2, 4);
  await addReview(m2, alice);
  await addReview(m2, bot);
  await addIssueComment(m2, bot);

  // Bucket 7: M3 merged with ZERO review touches → a real 0 load, coverage = unreviewed.
  await mergedPr(3, 30);

  // Bucket 5: M4 — only a BOT touched it (coverage = bot-only).
  const m4 = await mergedPr(4, 45);
  await addInlineComment(m4, bot);

  // Bucket 3: M5 — reviewed (firstReviewAt set 62d ago), 4 commits, 1 pushed AFTER review →
  // rework ratio 25%. (M1/M2 have no firstReviewAt, so they don't contribute a rework ratio.)
  const m5 = await mergedPr(5, 60, 62);
  await addReview(m5, alice);
  await addCommit(m5, 62.5); // before first review
  await addCommit(m5, 62.4); // before
  await addCommit(m5, 62.3); // before
  await addCommit(m5, 61); // after first review
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

describe('getTeamMetrics — self-review depth (changes-requested / coverage / rework)', () => {
  it('changes-requested rate = % of merged PRs with a changes-requested review', async () => {
    const m = await q.getTeamMetrics(1, [repoId], now, undefined);
    expect(m.changesRequestedTrend[11]).toBe(50); // M1 CR of 2 merges
    expect(m.changesRequestedTrend[7]).toBe(0); // M3, no CR
    expect(m.changesRequestedTrend[0]).toBeNull(); // no merges
  });

  it('review coverage classifies each merged PR human / bot-only / unreviewed', async () => {
    const m = await q.getTeamMetrics(1, [repoId], now, undefined);
    expect(m.reviewCoverage.human[11]).toBe(2); // M1, M2
    expect(m.reviewCoverage.botOnly[11]).toBe(0);
    expect(m.reviewCoverage.unreviewed[11]).toBe(0);
    expect(m.reviewCoverage.unreviewed[7]).toBe(1); // M3 shipped unreviewed
    expect(m.reviewCoverage.botOnly[5]).toBe(1); // M4 only a bot looked
  });

  it('rework ratio = median % of a reviewed PR’s commits pushed after first review', async () => {
    const m = await q.getTeamMetrics(1, [repoId], now, undefined);
    expect(m.reworkTrend[3]).toBe(25); // M5: 1 of 4 commits after review
    expect(m.reworkTrend[11]).toBeNull(); // M1/M2 never had firstReviewAt → excluded
  });
});
