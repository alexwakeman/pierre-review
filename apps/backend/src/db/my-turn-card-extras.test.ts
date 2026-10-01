// WHAT A MY TURN CARD SHOWS BESIDE ITS ONE-LINE DETAIL — on a THROWAWAY sqlite DB (the
// my-turn-ball.test.ts pattern).
//
//   1. "Pushed since" lists the commits — EXACTLY the population `humanCommitsAfter` counts (a bot
//      push, your own push and an unattributable commit are never listed), the newest
//      `PUSHED_COMMITS_SHOWN`, newest first. A null headline stays null ("not synced yet").
//   2. The reply-type cards carry the reply (`MyTurnCard.reply`): `thread` when somebody replied,
//      `thread_reply` and `comment_reply`. ⚠ NEVER a `likely_addressed` thread, whose stored
//      comment is the viewer's own.
//   3. Both are DISPLAY ONLY: `detail` does not change.
//   4. The headline backfill's worklist: open PRs with a headline-less commit, account + repo
//      scoped.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MY_TURN_REPLY_MAX_CHARS,
  PUSHED_COMMITS_SHOWN,
  type InsightCard,
  type MyTurnCard,
} from '@pierre-review/shared';

const DB_PATH = '/tmp/pierre-my-turn-card-extras-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let q: any;
let scope: any;

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const now = Math.floor(Date.now() / 1000) * 1000;
const REPO_ADDED = now - 30 * DAY;
const OPENED = REPO_ADDED + DAY;
const MY_ACTION = OPENED + DAY;

let repoId = 0;
let viewerId = 0;
let aliceId = 0;
let bobId = 0;
let botId = 0;
let prNumber = 1;
const prIdByKey = new Map<string, number>();
const LONG_REPLY = `${'word '.repeat(600)}end`;

async function seedPr(key: string, authorId = aliceId): Promise<number> {
  const [pr] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: `PR_extra_${key}`,
      accountId: 1,
      repoId,
      number: prNumber++,
      title: `${key} fixture`,
      state: 'open',
      isDraft: false,
      authorId,
      openedAt: new Date(OPENED),
      updatedAt: new Date(OPENED),
    })
    .returning()
    .execute();
  prIdByKey.set(key, pr.id);
  return pr.id;
}

async function addCommit(
  prId: number,
  authorId: number | null,
  at: number,
  tag: string,
  headline: string | null,
): Promise<void> {
  await db
    .insert(schema.commits)
    .values({ sha: `sha_${tag}`, prId, authorId, committedAt: new Date(at), messageHeadline: headline })
    .execute();
}

async function addThread(
  prId: number,
  tag: string,
  opener: number,
  state: string,
  comments: { authorId: number; body: string; at: number }[],
): Promise<void> {
  const [thread] = await db
    .insert(schema.reviewThreads)
    .values({
      githubNodeId: `TH_${tag}`,
      prId,
      path: `src/${tag}.ts`,
      line: 1,
      isResolved: false,
      derivedState: state,
      originalCommenterId: opener,
      createdAt: new Date(OPENED),
    })
    .returning()
    .execute();
  let n = 0;
  for (const c of comments) {
    await db
      .insert(schema.reviewComments)
      .values({
        githubNodeId: `RC_${tag}_${n++}`,
        threadId: thread.id,
        prId,
        authorId: c.authorId,
        body: c.body,
        excerpt: c.body.slice(0, 140),
        createdAt: new Date(c.at),
      })
      .execute();
  }
}

async function cardsByKey(): Promise<Map<string, MyTurnCard>> {
  const insights = await q.getWorkspaceInsights(1, undefined, scope);
  const byPrId = new Map<number, MyTurnCard>();
  for (const c of insights.cards as InsightCard[]) {
    if (c.kind !== 'my_turn' || c.reason === 'trunk_red') continue;
    byPrId.set(c.prId, c);
  }
  const out = new Map<string, MyTurnCard>();
  for (const [key, prId] of prIdByKey) {
    const card = byPrId.get(prId);
    if (card) out.set(key, card);
  }
  return out;
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  q = await import('./queries.js');
  const { eq } = await import('drizzle-orm');
  await db
    .update(schema.accounts)
    .set({ githubLogin: 'viewer-me' })
    .where(eq(schema.accounts.id, 1))
    .execute();
  const insertUser = async (login: string, isBot = false): Promise<number> => {
    const [u] = await db
      .insert(schema.users)
      .values({ githubLogin: login, githubNodeId: `U_${login}`, isBot })
      .returning()
      .execute();
    return u.id;
  };
  viewerId = await insertUser('viewer-me');
  aliceId = await insertUser('alice-dev');
  bobId = await insertUser('bob-dev');
  botId = await insertUser('dependabot', true);
  const [repo] = await db
    .insert(schema.repos)
    .values({
      accountId: 1,
      owner: 'acme',
      name: 'api',
      githubNodeId: 'R_extra',
      createdAt: new Date(REPO_ADDED),
    })
    .returning()
    .execute();
  repoId = repo.id;

  // ── PUSHED SINCE: seven human commits after my review, plus every kind that must NOT list ──
  {
    const id = await seedPr('pushed');
    await db
      .insert(schema.reviews)
      .values({
        githubNodeId: 'RV_pushed',
        prId: id,
        authorId: viewerId,
        state: 'approved',
        submittedAt: new Date(MY_ACTION),
      })
      .execute();
    await addCommit(id, aliceId, MY_ACTION - HOUR, 'before', 'Before my review');
    for (let i = 1; i <= 7; i += 1) {
      await addCommit(
        id,
        i % 2 === 0 ? bobId : aliceId,
        MY_ACTION + i * HOUR,
        `h${i}`,
        i === 6 ? null : `Human commit ${i}`,
      );
    }
    // Newer than every human commit, so a list that forgot the filter would lead with them.
    await addCommit(id, botId, MY_ACTION + 20 * HOUR, 'bot', 'Bump lodash');
    await addCommit(id, null, MY_ACTION + 21 * HOUR, 'orphan', 'Unmapped author');
  }

  // ── S3a: my thread, Alice replied (long) ──
  {
    const id = await seedPr('thread-reply');
    await addThread(id, 'mine-replied', viewerId, 'replied_unresolved', [
      { authorId: viewerId, body: 'why this?', at: MY_ACTION },
      { authorId: aliceId, body: LONG_REPLY, at: MY_ACTION + HOUR },
    ]);
  }
  // ── S3b: my thread, likely_addressed, my comment last ──
  {
    const id = await seedPr('thread-addressed');
    await addThread(id, 'mine-addressed', viewerId, 'likely_addressed', [
      { authorId: viewerId, body: 'my own words', at: MY_ACTION },
    ]);
  }
  // ── S3d: Bob's thread, I commented, Alice answered ──
  {
    const id = await seedPr('other-thread');
    await addThread(id, 'others', bobId, 'replied_unresolved', [
      { authorId: bobId, body: 'opening', at: MY_ACTION - HOUR },
      { authorId: viewerId, body: 'my note', at: MY_ACTION },
      { authorId: aliceId, body: 'Fixed in **the next** push', at: MY_ACTION + HOUR },
    ]);
  }
  // ── S5: my PR comment, then Alice's ──
  {
    const id = await seedPr('comment-reply');
    for (const [tag, authorId, at, body] of [
      ['mine', viewerId, MY_ACTION, 'can you split this?'],
      ['alice', aliceId, MY_ACTION + HOUR, 'Split into #12 and #13'],
    ] as const) {
      await db
        .insert(schema.prComments)
        .values({ githubNodeId: `PC_${tag}`, prId: id, authorId, body, createdAt: new Date(at) })
        .execute();
    }
  }

  scope = await q.resolveWorkspaceScope(1, null);
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('"Pushed since" lists what was pushed', () => {
  it('lists the newest five of exactly the commits it counts, newest first', async () => {
    const card = (await cardsByKey()).get('pushed');
    expect(card?.reason).toBe('pushed_since');
    const ball = card!.ball!;
    // Seven human commits after my review; the bot push, the unmapped author and the commit
    // BEFORE my review are not counted, so they cannot be listed either.
    expect(ball.humanCommitsAfter).toBe(7);
    expect(ball.commits).toHaveLength(PUSHED_COMMITS_SHOWN);
    expect(ball.commits!.map((c) => c.sha)).toEqual(['sha_h7', 'sha_h6', 'sha_h5', 'sha_h4', 'sha_h3']);
    expect(ball.commits!.map((c) => c.headline)).toEqual([
      'Human commit 7',
      // Unknown stays unknown — never an empty line.
      null,
      'Human commit 5',
      'Human commit 4',
      'Human commit 3',
    ]);
    expect(ball.commits![0]!.authorId).toBe(aliceId);
    expect(ball.commits![1]!.authorId).toBe(bobId);
    // DISPLAY ONLY: the detail is unchanged.
    expect(card!.detail).toBe('You approved · @alice-dev pushed 7 commits since');
  });
});

describe('reply-type cards carry the reply', () => {
  it('a reply in your own thread, capped and flagged when long', async () => {
    const card = (await cardsByKey()).get('thread-reply');
    expect(card?.reason).toBe('thread');
    expect(card!.reply).toBeDefined();
    expect(card!.reply!.authorId).toBe(aliceId);
    expect(card!.reply!.truncated).toBe(true);
    expect(card!.reply!.body.length).toBeLessThanOrEqual(MY_TURN_REPLY_MAX_CHARS + 1);
    expect(card!.detail).toMatch(/^@alice-dev replied /);
  });

  it('never on a likely_addressed thread — that comment is your own', async () => {
    const card = (await cardsByKey()).get('thread-addressed');
    expect(card?.reason).toBe('thread');
    expect(card!.reply).toBeUndefined();
  });

  it('a reply to your comment in somebody else\'s thread', async () => {
    const card = (await cardsByKey()).get('other-thread');
    expect(card?.reason).toBe('thread_reply');
    expect(card!.reply).toMatchObject({
      authorId: aliceId,
      body: 'Fixed in **the next** push',
      truncated: false,
    });
  });

  it('a PR comment after yours', async () => {
    const card = (await cardsByKey()).get('comment-reply');
    expect(card?.reason).toBe('comment_reply');
    expect(card!.reply).toMatchObject({
      authorId: aliceId,
      body: 'Split into #12 and #13',
      truncated: false,
    });
  });
});

describe('capMyTurnReply', () => {
  it('keeps a short body, cuts a long one on a word boundary, and refuses a blank one', () => {
    expect(q.capMyTurnReply('  hi  ')).toEqual({ body: 'hi', truncated: false });
    expect(q.capMyTurnReply('   ')).toBeNull();
    expect(q.capMyTurnReply(null)).toBeNull();
    // The last space sits near the cap, so the cut backs off to it rather than splitting "eeee".
    expect(q.capMyTurnReply('aaaa bbbb cccc ddddd eeee', 22)).toEqual({
      body: 'aaaa bbbb cccc ddddd…',
      truncated: true,
    });
  });
});

describe('the commit-headline backfill worklist', () => {
  it('names open PRs with a headline-less commit, and nothing else', async () => {
    const { commitHeadlineBackfillWorklist, __commitHeadlineBackfillTesting } = await import(
      '../sync/backfill-commit-headlines.js'
    );
    __commitHeadlineBackfillTesting.resetAttempted();
    const list = await commitHeadlineBackfillWorklist(1, repoId);
    expect(list.map((r: { id: number }) => r.id)).toEqual([prIdByKey.get('pushed')]);
    // Another account sees nothing.
    expect(await commitHeadlineBackfillWorklist(2, repoId)).toEqual([]);
  });
});
