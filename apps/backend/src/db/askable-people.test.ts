// "SOMEONE ELSE" (db/askable-people.ts) on a THROWAWAY sqlite DB (the external-repos.test.ts pattern).
//
// WHAT THIS PINS:
//   1. THE POOL: who authored or merged a PR in the workspace's repos — never someone whose only PR
//      is in a repo outside it.
//   2. THE ORDER: merged here > merged in the workspace > active in 90 days > the rest > login.
//   3. WHO IS LEFT OUT: the reader, the PR's author, automation, anyone already requested.
//   4. 404: another account's PR reads null.
//
// DATABASE_URL is set BEFORE importing config/client; every import below is dynamic.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { askableTier, compareAskable } from './askable-people.js';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-askable-people-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let closeDb: (() => Promise<void>) | undefined;
let mod: typeof import('./askable-people.js');

const DAY = 24 * 60 * 60 * 1000;
const now = Math.floor(Date.now() / 1000) * 1000;
const VIEWER = 'viewer-askable';
let prId = 0;
let workspaceId = 0;
let otherWorkspaceId = 0;

describe('the order (pure)', () => {
  const base = { mergedHere: false, mergedInWorkspace: false, lastActiveMs: 0 };
  it('ranks merged here, merged in the workspace, recent, then the rest', () => {
    expect(askableTier({ ...base, mergedHere: true, mergedInWorkspace: true }, now)).toBe(0);
    expect(askableTier({ ...base, mergedInWorkspace: true }, now)).toBe(1);
    expect(askableTier({ ...base, lastActiveMs: now - 10 * DAY }, now)).toBe(2);
    expect(askableTier({ ...base, lastActiveMs: now - 200 * DAY }, now)).toBe(3);
  });
  it('breaks a tie by the newest activity, then the login', () => {
    const a = { ...base, lastActiveMs: now - 5 * DAY, login: 'zed' };
    const b = { ...base, lastActiveMs: now - 1 * DAY, login: 'amy' };
    expect(compareAskable(a, b, now)).toBeGreaterThan(0);
    expect(compareAskable({ ...a, lastActiveMs: b.lastActiveMs }, b, now)).toBeGreaterThan(0);
  });
});

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  closeDb = client.closeDb;
  await runMigrations();
  const q = await import('./queries.js');
  mod = await import('./askable-people.js');
  const { accounts, repos, pullRequests, reviewRequests, users, workspaces, workspaceRepos } = client.schema;
  const { eq } = await import('drizzle-orm');

  await db.update(accounts).set({ githubLogin: VIEWER }).where(eq(accounts.id, 1)).execute();
  const user = async (login: string, isBot = false): Promise<number> =>
    (await db.insert(users).values({ githubLogin: login, githubNodeId: `U_${login}`, isBot }).returning().execute())[0].id;
  const viewer = await user(VIEWER);
  const author = await user('author-ak');
  const mergerHere = await user('merger-here-ak');
  const mergerElsewhere = await user('merger-ws-ak');
  const recent = await user('recent-ak');
  const old = await user('old-ak');
  const asked = await user('asked-ak');
  const bot = await user('ci-helper-ak', true);
  const outsider = await user('outsider-ak');

  const repo = async (name: string): Promise<number> =>
    (
      await db
        .insert(repos)
        .values({ accountId: 1, owner: 'acme', name, githubNodeId: `R_ak_${name}`, defaultBranch: 'main', viewerPermission: 'WRITE', createdAt: new Date(now - 300 * DAY) })
        .returning()
        .execute()
    )[0].id;
  const here = await repo('here');
  const sibling = await repo('sibling');
  const foreign = await repo('foreign');

  let n = 1;
  const addPr = async (repoId: number, authorId: number, values: Record<string, unknown> = {}): Promise<number> =>
    (
      await db
        .insert(pullRequests)
        .values({
          githubNodeId: `PR_ak_${n}`,
          accountId: 1,
          repoId,
          number: n++,
          title: 'change',
          authorId,
          state: 'open',
          isDraft: false,
          openedAt: new Date(now - 2 * DAY),
          updatedAt: new Date(now - 2 * DAY),
          ...values,
        })
        .returning()
        .execute()
    )[0].id;
  const merged = (by: number, daysAgo: number) => ({
    state: 'merged',
    mergedById: by,
    mergedAt: new Date(now - daysAgo * DAY),
    openedAt: new Date(now - (daysAgo + 1) * DAY),
  });

  prId = await addPr(here, author);
  await addPr(here, old, merged(mergerHere, 250));
  await addPr(sibling, old, merged(mergerElsewhere, 5));
  await addPr(sibling, recent, { openedAt: new Date(now - 3 * DAY) });
  await addPr(sibling, old, { openedAt: new Date(now - 200 * DAY) });
  await addPr(here, asked);
  await addPr(here, bot);
  await addPr(here, viewer);
  await addPr(foreign, outsider);

  // `here` + `sibling` in the workspace under test; `foreign` in another one.
  workspaceId = (await q.resolveWorkspaceScope(1, null)).workspaceId;
  otherWorkspaceId = (
    await db.insert(workspaces).values({ accountId: 1, name: 'Elsewhere', isDefault: false }).returning().execute()
  )[0].id;
  await db.update(workspaceRepos).set({ workspaceId: otherWorkspaceId }).where(eq(workspaceRepos.repoId, foreign)).execute();

  await db.insert(reviewRequests).values({ prId, userId: asked }).execute();
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('the people on the database', () => {
  it('lists the workspace contributors best first, leaving out the reader, author, bots and the asked', async () => {
    const r = await mod.getAskablePeople(prId, 1, workspaceId, now);
    expect(r?.workspaceId).toBe(workspaceId);
    expect(r?.people.map((p) => p.githubLogin)).toEqual(['merger-here-ak', 'merger-ws-ak', 'recent-ak', 'old-ak']);
    expect(r?.people[0]).toMatchObject({ isMaintainer: true, mergedInWorkspace: true });
    expect(r?.people[1]).toMatchObject({ isMaintainer: false, mergedInWorkspace: true });
  });

  it('the other workspace lists its own people, plus the PR repo’s', async () => {
    const r = await mod.getAskablePeople(prId, 1, otherWorkspaceId, now);
    expect(r?.workspaceId).toBe(otherWorkspaceId);
    const logins = r?.people.map((p) => p.githubLogin) ?? [];
    expect(logins).toContain('outsider-ak');
    expect(logins).toContain('merger-here-ak');
    expect(logins).not.toContain('recent-ak');
  });

  it('another account’s PR reads null (404)', async () => {
    expect(await mod.getAskablePeople(prId, 2, null, now)).toBeNull();
  });
});
