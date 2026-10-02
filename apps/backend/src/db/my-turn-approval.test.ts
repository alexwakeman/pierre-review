// AN APPROVAL ANSWERS A THREAD — the ball rule's thread sections ("Reply needed" on threads you
// opened, "Reply to you" on threads you commented in) on a THROWAWAY sqlite DB (the
// my-turn-ball.test.ts pattern).
//
// A reply on a thread, followed by YOUR approval of the PR, is done: you looked after the reply
// and approved without answering, which is the action. An approval BEFORE the reply does not
// count (the reply is newer), and a human reply AFTER the approval brings the thread back.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-my-turn-approval-test.sqlite';
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
// Whole seconds: sqlite stores these as unix-epoch INTEGERS.
const now = Math.floor(Date.now() / 1000) * 1000;
const REPO_ADDED = now - 30 * DAY;
const OPENED = REPO_ADDED + DAY;
const MY_COMMENT = OPENED + DAY;
const THEIR_REPLY = MY_COMMENT + HOUR;

const VIEWER_LOGIN = 'viewer-me';

let repoId = 0;
let viewerId = 0;
let aliceId = 0;
let prNumber = 1;
let tagN = 0;

async function seedPr(key: string): Promise<number> {
  const [pr] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: `PR_appr_${key}`,
      accountId: 1,
      repoId,
      number: prNumber++,
      title: `${key} fixture`,
      state: 'open',
      isDraft: false,
      authorId: aliceId,
      openedAt: new Date(OPENED),
      updatedAt: new Date(OPENED),
    })
    .returning()
    .execute();
  return pr.id;
}

async function addReview(prId: number, state: string, at: number): Promise<void> {
  await db
    .insert(schema.reviews)
    .values({
      githubNodeId: `RV_appr_${tagN++}`,
      prId,
      authorId: viewerId,
      state,
      submittedAt: new Date(at),
    })
    .execute();
}

/** A thread on `prId` opened by `openerId`, with one comment per [author, at] pair. */
async function seedThread(
  prId: number,
  path: string,
  openerId: number,
  comments: [number, number][],
): Promise<number> {
  const [thread] = await db
    .insert(schema.reviewThreads)
    .values({
      githubNodeId: `TH_appr_${path}`,
      prId,
      path,
      line: 1,
      isResolved: false,
      derivedState: 'replied_unresolved',
      originalCommenterId: openerId,
      createdAt: new Date(comments[0]![1]),
    })
    .returning()
    .execute();
  await addComments(thread.id, prId, comments);
  return thread.id;
}

async function addComments(threadId: number, prId: number, comments: [number, number][]) {
  for (const [authorId, at] of comments) {
    await db
      .insert(schema.reviewComments)
      .values({
        githubNodeId: `RC_appr_${tagN++}`,
        threadId,
        prId,
        authorId,
        body: 'a comment',
        excerpt: 'a comment',
        createdAt: new Date(at),
      })
      .execute();
  }
}

const paths = async (section: 'threadsAwaiting' | 'threadReplies'): Promise<string[]> => {
  const mt = await q.getMyTurn(1, scope);
  return (mt[section] as { path: string }[]).map((t) => t.path).sort();
};

let lateReplyThread = 0;
let lateReplyPr = 0;

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

  // Migration 0008 seeds account 1 with an EMPTY github_login — getMyTurn would short-circuit.
  await db
    .update(schema.accounts)
    .set({ githubLogin: VIEWER_LOGIN })
    .where(eq(schema.accounts.id, 1))
    .execute();
  const insertUser = async (login: string): Promise<number> => {
    const [u] = await db
      .insert(schema.users)
      .values({ githubLogin: login, githubNodeId: `U_${login}` })
      .returning()
      .execute();
    return u.id;
  };
  viewerId = await insertUser(VIEWER_LOGIN);
  aliceId = await insertUser('alice-dev');
  const [repo] = await db
    .insert(schema.repos)
    .values({
      accountId: 1,
      owner: 'acme',
      name: 'api',
      githubNodeId: 'R_appr',
      createdAt: new Date(REPO_ADDED),
    })
    .returning()
    .execute();
  repoId = repo.id;

  // Threads YOU opened ("Reply needed").
  await seedThread(await seedPr('own-no-approval'), 'own-no-approval.ts', viewerId, [
    [viewerId, MY_COMMENT],
    [aliceId, THEIR_REPLY],
  ]);
  {
    const id = await seedPr('own-approved-after');
    await seedThread(id, 'own-approved-after.ts', viewerId, [
      [viewerId, MY_COMMENT],
      [aliceId, THEIR_REPLY],
    ]);
    await addReview(id, 'approved', THEIR_REPLY + HOUR);
  }
  {
    const id = await seedPr('own-approved-before');
    await seedThread(id, 'own-approved-before.ts', viewerId, [
      [viewerId, MY_COMMENT],
      [aliceId, THEIR_REPLY],
    ]);
    await addReview(id, 'approved', MY_COMMENT);
  }
  {
    // Only an APPROVAL is a verdict; a bare comment review after the reply is not.
    const id = await seedPr('own-commented-after');
    await seedThread(id, 'own-commented-after.ts', viewerId, [
      [viewerId, MY_COMMENT],
      [aliceId, THEIR_REPLY],
    ]);
    await addReview(id, 'commented', THEIR_REPLY + HOUR);
  }
  {
    // Approved after the reply — then a NEW human reply after the approval (added in a test).
    lateReplyPr = await seedPr('own-late-reply');
    lateReplyThread = await seedThread(lateReplyPr, 'own-late-reply.ts', viewerId, [
      [viewerId, MY_COMMENT],
      [aliceId, THEIR_REPLY],
    ]);
    await addReview(lateReplyPr, 'approved', THEIR_REPLY + HOUR);
  }

  // Threads SOMEBODY ELSE opened that you commented in ("Reply to you").
  await seedThread(await seedPr('other-no-approval'), 'other-no-approval.ts', aliceId, [
    [aliceId, OPENED],
    [viewerId, MY_COMMENT],
    [aliceId, THEIR_REPLY],
  ]);
  {
    const id = await seedPr('other-approved-after');
    await seedThread(id, 'other-approved-after.ts', aliceId, [
      [aliceId, OPENED],
      [viewerId, MY_COMMENT],
      [aliceId, THEIR_REPLY],
    ]);
    await addReview(id, 'approved', THEIR_REPLY + HOUR);
  }

  scope = await q.resolveWorkspaceScope(1, null);
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('an approval answers a thread', () => {
  it('drops "Reply needed" when you approved after the reply', async () => {
    const got = await paths('threadsAwaiting');
    expect(got).toContain('own-no-approval.ts');
    expect(got).not.toContain('own-approved-after.ts');
  });

  it('keeps it when the approval came BEFORE the reply', async () => {
    expect(await paths('threadsAwaiting')).toContain('own-approved-before.ts');
  });

  it('keeps it when the later review is only a comment, not an approval', async () => {
    expect(await paths('threadsAwaiting')).toContain('own-commented-after.ts');
  });

  it('applies to "Reply to you" on somebody else\'s thread too', async () => {
    const got = await paths('threadReplies');
    expect(got).toContain('other-no-approval.ts');
    expect(got).not.toContain('other-approved-after.ts');
  });

  it('brings the thread back when a person replies after the approval', async () => {
    expect(await paths('threadsAwaiting')).not.toContain('own-late-reply.ts');
    await addComments(lateReplyThread, lateReplyPr, [[aliceId, THEIR_REPLY + 2 * HOUR]]);
    expect(await paths('threadsAwaiting')).toContain('own-late-reply.ts');
  });

  it('moves the board total with the list — the seeds are filtered, not the cards', async () => {
    const insights = await q.getWorkspaceInsights(1, undefined, scope);
    const threadCards = insights.cards.filter(
      (c: any) => c.kind === 'my_turn' && (c.reason === 'thread' || c.reason === 'thread_reply'),
    );
    // own-no-approval, own-approved-before, own-commented-after, own-late-reply, other-no-approval.
    expect(threadCards).toHaveLength(5);
  });

  it('leaves a "check the fix" card alone: an approval after YOUR comment is not after the fix', async () => {
    // You comment, approve ("LGTM once the nit is fixed"), then a commit touches the file.
    const id = await seedPr('own-addressed-after-approval');
    const threadId = await seedThread(id, 'own-addressed-after-approval.ts', viewerId, [
      [viewerId, MY_COMMENT],
    ]);
    await addReview(id, 'approved', MY_COMMENT + HOUR);
    const { eq } = await import('drizzle-orm');
    await db
      .update(schema.reviewThreads)
      .set({ derivedState: 'likely_addressed' })
      .where(eq(schema.reviewThreads.id, threadId))
      .execute();
    expect(await paths('threadsAwaiting')).toContain('own-addressed-after-approval.ts');
  });
});
