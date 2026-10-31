// The sidebar's BLUE dot (`ActivityRepo.hasUnread` / `unreadPrs`) on a THROWAWAY sqlite DB.
//
// WHAT THIS PINS:
//   1. A PR you opened with NOTHING new since is not "new". `newSinceLastViewed` is a non-null
//      all-zero object for every open PR you have ever opened, and `hasUnread` used to test
//      `!= null` — the dot lit on every repo you had visited.
//   2. YOUR OWN ACTIONS ARE NOT NEW. A comment you post after opening the PR is later than the
//      `pr_views` stamp; it must not light the dot (nor `your_pr`'s new-activity counts).
//   3. Someone else's comment after your view IS new, and `unreadPrs` carries when you last opened it.
//   4. "Mark all seen" for the repo clears it.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-activity-unread-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let q: any;
let scope: any;

const DAY = 24 * 60 * 60 * 1000;
const now = Math.floor(Date.now() / 1000) * 1000;
const VIEWER_LOGIN = 'viewer-me';

let repoId = 0;
let viewerId = 0;
let aliceId = 0;
const prId: Record<string, number> = {};
let ev = 1;

async function addEvent(pr: string, actorId: number, type: string, at: number): Promise<void> {
  await db
    .insert(schema.events)
    .values({ accountId: 1, repoId, prId: prId[pr], actorId, type, occurredAt: new Date(at), dedupeKey: `u_${ev++}` })
    .execute();
}

async function view(pr: string, at: number): Promise<void> {
  await db
    .insert(schema.prViews)
    .values({ prId: prId[pr], lastViewedSha: null, lastViewedAt: new Date(at) })
    .onConflictDoUpdate({ target: schema.prViews.prId, set: { lastViewedAt: new Date(at) } })
    .execute();
}

async function repo(): Promise<any> {
  const res = await q.getActivity(1, scope, null);
  return res.repos.find((r: any) => r.repoId === repoId);
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
  await db.update(schema.accounts).set({ githubLogin: VIEWER_LOGIN }).where(eq(schema.accounts.id, 1)).execute();

  const user = async (login: string): Promise<number> => {
    const [u] = await db
      .insert(schema.users)
      .values({ githubLogin: login, githubNodeId: `U_${login}`, isBot: false })
      .returning()
      .execute();
    return u.id;
  };
  viewerId = await user(VIEWER_LOGIN);
  aliceId = await user('alice-dev');

  const [r] = await db
    .insert(schema.repos)
    .values({ accountId: 1, owner: 'acme', name: 'unread', githubNodeId: 'R_unread', createdAt: new Date(now - 30 * DAY) })
    .returning()
    .execute();
  repoId = r.id;
  let n = 1;
  for (const key of ['quiet', 'mine', 'theirs']) {
    const [p] = await db
      .insert(schema.pullRequests)
      .values({
        githubNodeId: `PR_unread_${key}`,
        accountId: 1,
        repoId,
        number: n++,
        title: key,
        state: 'open',
        authorId: aliceId,
        openedAt: new Date(now - 10 * DAY),
        updatedAt: new Date(now - DAY),
      })
      .returning()
      .execute();
    prId[key] = p.id;
    await addEvent(key, aliceId, 'pr_opened', now - 10 * DAY);
  }
  // quiet: viewed after everything.
  await view('quiet', now - 5 * DAY);
  // mine: viewed, then only the VIEWER commented and pushed.
  await view('mine', now - 5 * DAY);
  await addEvent('mine', viewerId, 'pr_comment', now - 4 * DAY);
  await addEvent('mine', viewerId, 'commit_pushed', now - 4 * DAY);
  // theirs: viewed, then alice commented twice.
  await view('theirs', now - 5 * DAY);
  await addEvent('theirs', aliceId, 'pr_comment', now - 3 * DAY);
  await addEvent('theirs', aliceId, 'review_comment', now - 2 * DAY);
  scope = await q.resolveWorkspaceScope(1, null);
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('getActivity — the blue dot', () => {
  it('counts only someone else’s activity since you last opened the PR', async () => {
    const r = await repo();
    expect(r).toBeDefined();
    const byKey = (k: string) => r.prs.find((p: any) => p.id === prId[k]);
    expect(byKey('quiet').newSinceLastViewed).toEqual({ commits: 0, comments: 0, reviews: 0 });
    expect(byKey('mine').newSinceLastViewed).toEqual({ commits: 0, comments: 0, reviews: 0 });
    expect(byKey('theirs').newSinceLastViewed).toEqual({ commits: 0, comments: 2, reviews: 0 });
    expect(r.hasUnread).toBe(true);
    expect(r.unreadPrs).toEqual([{ prId: prId.theirs, lastViewedAt: new Date(now - 5 * DAY).toISOString() }]);
  });

  it('the PR detail agrees: your own comment is not new to you', async () => {
    const detail = await q.getPrDetail(prId.mine, 1);
    expect(detail.newSinceLastViewed).toEqual({ commits: 0, comments: 0, reviews: 0 });
  });

  it('"Mark all seen" for the repo clears it', async () => {
    await q.markAllViewed(1, [repoId]);
    const r = await repo();
    expect(r.hasUnread).toBe(false);
    expect(r.unreadPrs).toEqual([]);
  });
});
