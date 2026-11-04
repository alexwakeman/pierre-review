// "N COMMITS SINCE YOU …" — the expanded list on a Pushed since My Turn card
// (db/my-turn-pushed-since.ts), on a THROWAWAY sqlite DB (the my-turn-ball.test.ts pattern).
//
// What this pins:
//   1. The list and the card's count are ONE population: every human commit by someone else
//      strictly after your last action — a bot push and a commit from before you acted are in
//      neither. The list is NOT cut at the card's `PUSHED_COMMITS_SHOWN`.
//   2. The anchor is your last ACTION (here an approval), reported as such — never a view.
//   3. A bound, when it bites, keeps `total` honest ("and N more" = total − listed).
//   4. A PR outside the workspace's repos, or unknown, answers null (→ 404).
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PUSHED_COMMITS_SHOWN } from '@pierre-review/shared';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-my-turn-pushed-since-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let q: any;
let mod: typeof import('./my-turn-pushed-since.js');

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const now = Math.floor(Date.now() / 1000) * 1000;
const REPO_ADDED = now - 30 * DAY;
const OPENED = REPO_ADDED + DAY;
const MY_ACTION = OPENED + DAY;
const HUMAN_AFTER = 8;

let repoId = 0;
let otherRepoId = 0;
let prId = 0;
let otherPrId = 0;
let workspaceId = 0;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  q = await import('./queries.js');
  mod = await import('./my-turn-pushed-since.js');
  const { accounts, repos, users, pullRequests, reviews, commits } = schema;
  const { eq } = await import('drizzle-orm');

  await db.update(accounts).set({ githubLogin: 'viewer-me' }).where(eq(accounts.id, 1)).execute();
  const insertUser = async (login: string, isBot = false): Promise<number> => {
    const [u] = await db
      .insert(users)
      .values({ githubLogin: login, githubNodeId: `U_${login}`, isBot })
      .returning()
      .execute();
    return u.id;
  };
  const viewerId = await insertUser('viewer-me');
  const aliceId = await insertUser('alice-dev');
  const botId = await insertUser('dependabot', true);

  const insertRepo = async (name: string): Promise<number> => {
    const [r] = await db
      .insert(repos)
      .values({ accountId: 1, owner: 'acme', name, githubNodeId: `R_${name}`, createdAt: new Date(REPO_ADDED) })
      .returning()
      .execute();
    return r.id;
  };
  repoId = await insertRepo('api');
  otherRepoId = await insertRepo('web');

  const insertPr = async (repo: number, n: number): Promise<number> => {
    const [pr] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: `PR_ps_${n}`,
        accountId: 1,
        repoId: repo,
        number: n,
        title: `fixture ${n}`,
        state: 'open',
        isDraft: false,
        authorId: aliceId,
        openedAt: new Date(OPENED),
        updatedAt: new Date(OPENED),
      })
      .returning()
      .execute();
    return pr.id;
  };
  prId = await insertPr(repoId, 1);
  otherPrId = await insertPr(otherRepoId, 2);

  const commit = (pr: number, authorId: number, at: number, tag: string, headline: string | null) =>
    db
      .insert(commits)
      .values({ sha: `sha_${tag}_0000000`, prId: pr, authorId, committedAt: new Date(at), messageHeadline: headline })
      .execute();

  // Before you acted: counted nowhere.
  await commit(prId, aliceId, MY_ACTION - HOUR, 'before', 'Old work');
  await db
    .insert(reviews)
    .values({ githubNodeId: 'RV_mine', prId, authorId: viewerId, state: 'approved', submittedAt: new Date(MY_ACTION) })
    .execute();
  // After: eight human commits (more than the card's inline five), and a bot push that never counts.
  for (let i = 1; i <= HUMAN_AFTER; i++) {
    await commit(prId, aliceId, MY_ACTION + i * HOUR, `h${i}`, i === 3 ? null : `Change ${i}`);
  }
  await commit(prId, botId, MY_ACTION + 20 * HOUR, 'bot', 'Bump deps');

  const scope = await q.resolveWorkspaceScope(1, undefined);
  workspaceId = scope.workspaceId;
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('the expanded Pushed since list', () => {
  it('lists every counted commit, newest first, and agrees with the card’s count', async () => {
    expect(HUMAN_AFTER).toBeGreaterThan(PUSHED_COMMITS_SHOWN);
    const mt = await q.getMyTurn(1);
    const row = mt.pushedSince.find((r: any) => r.prId === prId);
    expect(row?.ball?.humanCommitsAfter).toBe(HUMAN_AFTER);

    const res = await mod.getPushedSinceCommits(1, prId, workspaceId, [repoId, otherRepoId]);
    expect(res).not.toBeNull();
    expect(res!.total).toBe(HUMAN_AFTER);
    expect(res!.commits).toHaveLength(HUMAN_AFTER);
    expect(res!.commits.map((c) => c.sha.split('_')[1])).toEqual(['h8', 'h7', 'h6', 'h5', 'h4', 'h3', 'h2', 'h1']);
    // The bot push and the commit from before you acted are in neither the count nor the list.
    expect(res!.commits.some((c) => c.sha.includes('bot') || c.sha.includes('before'))).toBe(false);
    // A headline not synced yet travels as null, never an empty string.
    expect(res!.commits.find((c) => c.sha.includes('h3'))!.headline).toBeNull();
    expect(res!.yourLastAction).toBe('approved');
    expect(res!.anchorAt).toBe(new Date(MY_ACTION).toISOString());
    expect(res!.workspaceId).toBe(workspaceId);
  });

  it('keeps the total honest when the bound bites', async () => {
    const res = await mod.getPushedSinceCommits(1, prId, workspaceId, [repoId], 3);
    expect(res!.total).toBe(HUMAN_AFTER);
    expect(res!.commits.map((c) => c.sha.split('_')[1])).toEqual(['h8', 'h7', 'h6']);
  });

  it('answers an empty list on a PR you never acted on', async () => {
    const res = await mod.getPushedSinceCommits(1, otherPrId, workspaceId, [otherRepoId]);
    expect(res).toMatchObject({ total: 0, commits: [], yourLastAction: null, anchorAt: null });
  });

  it('refuses a PR outside the workspace’s repos, or another account’s', async () => {
    expect(await mod.getPushedSinceCommits(1, prId, workspaceId, [otherRepoId])).toBeNull();
    expect(await mod.getPushedSinceCommits(1, prId, workspaceId, [])).toBeNull();
    expect(await mod.getPushedSinceCommits(2, prId, workspaceId, [repoId])).toBeNull();
    expect(await mod.getPushedSinceCommits(1, 999_999, workspaceId, [repoId])).toBeNull();
  });
});
