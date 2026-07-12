// Layered reviewer classifier + behavioral signals, on a THROWAWAY sqlite DB. Seeds
// users (and, for the behavioral compute, PRs/commits/reviews/threads/comments) then
// exercises the resolution order (manual > vendor > github_type > fingerprint >
// behavioral(medium) > human) plus the persistence + manual-never-overwritten guarantee.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-reviewer-classify-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let classifyReviewer: any;
let computeBehavioralSignals: any;
let fingerprintReview: any;

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;

// user id by login, populated in beforeAll.
const uid: Record<string, number> = {};

async function addUser(
  login: string,
  opts: { isBot?: boolean; githubType?: string | null } = {},
): Promise<number> {
  const [row] = await db
    .insert(schema.users)
    .values({
      githubLogin: login,
      githubNodeId: `U_${login}`,
      isBot: opts.isBot ?? false,
      githubType: opts.githubType ?? null,
    })
    .returning()
    .execute();
  uid[login] = row.id;
  return row.id;
}

function userArg(login: string, opts: { isBot?: boolean; githubType?: string | null } = {}) {
  return {
    id: uid[login]!,
    githubLogin: login,
    githubType: opts.githubType ?? null,
    isBot: opts.isBot ?? false,
  };
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../db/run-migrations.js');
  const client = await import('../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  ({ classifyReviewer } = await import('./reviewer-classify.js'));
  ({ computeBehavioralSignals } = await import('./reviewer-behavior.js'));
  ({ fingerprintReview } = await import('./review-fingerprint.js'));
  await runMigrations();

  // account 1 exists (migration 0008); add a second account for the isolation check.
  await db
    .insert(schema.accounts)
    .values({ id: 2, githubUserId: 'GH_2', githubLogin: 'acct2', isLocal: false })
    .execute();

  await addUser('coderabbitai', { isBot: true });
  await addUser('qodo-ai', { isBot: true }); // manual-override subject
  await addUser('claude-bot-type', { isBot: true, githubType: 'Bot' });
  await addUser('branded-bot-type', { isBot: true, githubType: 'Bot' });
  await addUser('pierre-poster', { githubType: 'User' });
  await addUser('acme-ci'); // matches the -ci service-account pattern
  await addUser('jordan-lee'); // a fast, thorough human
  await addUser('sam-rivers'); // no evidence at all
  await addUser('robo-reviewer'); // behavioral-compute subject
});

afterAll(() => closeDb?.());

describe('classifyReviewer resolution order', () => {
  it('2. known vendor login → vendor kind, high, vendor_login (+ persisted)', async () => {
    const c = await classifyReviewer(1, userArg('coderabbitai', { isBot: true }), {});
    expect(c.automated).toBe(true);
    expect(c.kind).toBe('coderabbit');
    expect(c.confidence).toBe('high');
    expect(c.source).toBe('vendor_login');
    // persisted to the classification store (small test DB → a full scan is fine)
    const persisted = (
      await db.select().from(schema.botReviewClassification).execute()
    ).find((r: any) => r.authorUserId === uid['coderabbitai']! && r.accountId === 1);
    expect(persisted).toBeDefined();
    expect(persisted.source).toBe('vendor_login');
  });

  it("3. githubType==='Bot' with no marker → in_house, high, github_type", async () => {
    const c = await classifyReviewer(
      1,
      userArg('claude-bot-type', { isBot: true, githubType: 'Bot' }),
      { fingerprint: { marked: false, tool: null, markers: [] } },
    );
    expect(c.automated).toBe(true);
    expect(c.kind).toBe('in_house');
    expect(c.source).toBe('github_type');
    expect(c.confidence).toBe('high');
  });

  it('3. githubType Bot + a branded fingerprint → the vendor kind wins the label', async () => {
    const fp = fingerprintReview('Summary by CodeRabbit', []);
    const c = await classifyReviewer(
      1,
      userArg('branded-bot-type', { isBot: true, githubType: 'Bot' }),
      { fingerprint: fp },
    );
    expect(c.kind).toBe('coderabbit');
    expect(c.source).toBe('github_type');
  });

  it("4. branded fingerprint (Pierre) on a plain User → pierre, high, fingerprint", async () => {
    const fp = fingerprintReview('LGTM\n\n<!-- pierre:claude-review v=1 -->', []);
    const c = await classifyReviewer(1, userArg('pierre-poster', { githubType: 'User' }), {
      fingerprint: fp,
    });
    expect(c.automated).toBe(true);
    expect(c.kind).toBe('pierre');
    expect(c.source).toBe('fingerprint');
    expect(c.label).toBe('Pierre · Claude');
  });

  it('5. behavioral band → MEDIUM in_house, source behavioral (never auto-badges to high)', async () => {
    const c = await classifyReviewer(1, userArg('acme-ci'), {
      behavioral: {
        reviews: 5,
        medianPushToReviewMins: 0.5,
        reviewsPerPr: 1,
        replyRate: 0,
        commentsPerReview: 4,
      },
    });
    expect(c.automated).toBe(true);
    expect(c.kind).toBe('in_house');
    expect(c.confidence).toBe('medium'); // MEDIUM — no tiebreak requested
    expect(c.source).toBe('behavioral');
    expect(c.label).toBe('acme-ci'); // allowlist match → the login is the label
  });

  it('otherwise → human (strong): behavioral evidence that does not trip → automated:false, high', async () => {
    const c = await classifyReviewer(1, userArg('jordan-lee'), {
      behavioral: {
        reviews: 5,
        medianPushToReviewMins: 120,
        reviewsPerPr: 3,
        replyRate: 0.8,
        commentsPerReview: 1,
      },
    });
    expect(c.automated).toBe(false);
    expect(c.kind).toBeNull();
    expect(c.confidence).toBe('high');
  });

  it('otherwise → human (weak): no evidence → automated:false, low', async () => {
    const c = await classifyReviewer(1, userArg('sam-rivers'), {});
    expect(c.automated).toBe(false);
    expect(c.confidence).toBe('low');
  });
});

describe('manual override wins + is never overwritten by auto', () => {
  it('1. a source=manual "human" row beats the vendor-login signal', async () => {
    // qodo-ai is a KNOWN vendor login, but a manual override says "this is a human".
    await db
      .insert(schema.botReviewClassification)
      .values({
        accountId: 1,
        authorUserId: uid['qodo-ai']!,
        automated: false,
        kind: null,
        label: 'A human',
        confidence: 'high',
        source: 'manual',
        reasonsJson: ['user marked as human'],
        updatedAt: new Date(),
      })
      .execute();
    const c = await classifyReviewer(1, userArg('qodo-ai', { isBot: true }), {});
    expect(c.automated).toBe(false);
    expect(c.source).toBe('manual');
    expect(c.label).toBe('A human');
    // and the stored row is untouched (still manual, still automated=false)
    const row = (
      await db.select().from(schema.botReviewClassification).execute()
    ).find((r: any) => r.authorUserId === uid['qodo-ai']! && r.accountId === 1);
    expect(row.source).toBe('manual');
    expect(row.automated).toBe(false);
  });
});

describe('computeBehavioralSignals', () => {
  beforeAll(async () => {
    const now = Date.now();
    const [repo] = await db
      .insert(schema.repos)
      .values({ accountId: 1, owner: 'acme', name: 'svc', githubNodeId: 'R_beh' })
      .returning()
      .execute();
    const U = uid['robo-reviewer']!;

    // 3 PRs: each gets one commit and a review by U ~1 min later (sub-2-min latency).
    const prIds: number[] = [];
    for (let i = 0; i < 3; i++) {
      const openedAt = new Date(now - (10 + i) * DAY);
      const [pr] = await db
        .insert(schema.pullRequests)
        .values({
          githubNodeId: `PR_beh_${i}`,
          accountId: 1,
          repoId: repo.id,
          number: 100 + i,
          title: `beh ${i}`,
          state: 'open',
          isDraft: false,
          openedAt,
          updatedAt: openedAt,
        })
        .returning()
        .execute();
      prIds.push(pr.id);
      const commitAt = new Date(now - (5 + i) * DAY);
      await db
        .insert(schema.commits)
        .values({ sha: `sha_${i}`, prId: pr.id, committedAt: commitAt })
        .execute();
      await db
        .insert(schema.reviews)
        .values({
          githubNodeId: `RV_beh_${i}`,
          prId: pr.id,
          authorId: U,
          state: 'commented',
          submittedAt: new Date(commitAt.getTime() + 1 * MIN),
        })
        .execute();
    }

    // 9 threads on PR0, each ORIGINATED by U with exactly ONE comment by U → replyRate 0,
    // and 9 comments / 3 reviews → commentsPerReview 3.
    const pr0 = prIds[0]!;
    for (let i = 0; i < 9; i++) {
      const [th] = await db
        .insert(schema.reviewThreads)
        .values({
          githubNodeId: `TH_beh_${i}`,
          prId: pr0,
          path: 'src/x.ts',
          line: i + 1,
          isResolved: false,
          isOutdated: false,
          derivedState: 'untouched',
          originalCommenterId: U,
          createdAt: new Date(now - 5 * DAY),
        })
        .returning()
        .execute();
      await db
        .insert(schema.reviewComments)
        .values({
          githubNodeId: `RC_beh_${i}`,
          threadId: th.id,
          prId: pr0,
          authorId: U,
          body: `⚠️ Potential issue ${i}`,
          createdAt: new Date(now - 5 * DAY),
        })
        .execute();
    }

    // Account-2 noise for the same user id — must NOT leak into account-1 signals.
    const [repo2] = await db
      .insert(schema.repos)
      .values({ accountId: 2, owner: 'acme', name: 'svc2', githubNodeId: 'R_beh2' })
      .returning()
      .execute();
    const [pr2] = await db
      .insert(schema.pullRequests)
      .values({
        githubNodeId: 'PR_beh_a2',
        accountId: 2,
        repoId: repo2.id,
        number: 1,
        title: 'a2',
        state: 'open',
        isDraft: false,
        openedAt: new Date(now - DAY),
        updatedAt: new Date(now - DAY),
      })
      .returning()
      .execute();
    await db
      .insert(schema.reviews)
      .values({
        githubNodeId: 'RV_beh_a2',
        prId: pr2.id,
        authorId: U,
        state: 'commented',
        submittedAt: new Date(now - DAY),
      })
      .execute();
  });

  it('derives per-account distributions from real synced rows (account-scoped)', async () => {
    const sig = await computeBehavioralSignals(1, uid['robo-reviewer']!);
    expect(sig.reviews).toBe(3); // account-2's review is excluded
    expect(sig.reviewsPerPr).toBe(1);
    expect(sig.commentsPerReview).toBe(3);
    expect(sig.replyRate).toBe(0);
    expect(sig.medianPushToReviewMins).not.toBeNull();
    expect(sig.medianPushToReviewMins!).toBeLessThan(2);
  });

  it('feeds classifyReviewer → this reviewer lands in the MEDIUM automated band', async () => {
    const sig = await computeBehavioralSignals(1, uid['robo-reviewer']!);
    const c = await classifyReviewer(1, userArg('robo-reviewer'), { behavioral: sig });
    expect(c.automated).toBe(true);
    expect(c.confidence).toBe('medium');
    expect(c.source).toBe('behavioral');
  });
});
