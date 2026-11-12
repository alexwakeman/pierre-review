// EXTERNAL REPOS (docs/DATA-MODEL.md § External repos), on a THROWAWAY sqlite DB (the
// pending-mute.test.ts pattern).
//
// WHAT THIS PINS:
//   1. THE PROJECT-PR RULE (`isProjectPr`): an author who maintains a WATCHED repo, or an
//      ALLOWLISTED ticket key. The external repo's OWN mergers never count; a foreign ticket prefix
//      never counts; no allowlist ⇒ the ticket rule never fires.
//   2. THE SCOPE: `resolveWorkspaceScope` returns WATCHED members by default, every member with
//      `members: 'all'` (the build and fix paths), and the OPEN project PRs with `projectPrs`.
//   3. THE BOARDS: Open PRs lists the watched repo's PRs plus the project PRs, nothing else of the
//      external repo; the ACCOUNT-WIDE My Turn (notifications) drops a review request on an external
//      repo's other PR and keeps one on a project PR.
//   4. THE AUTOMATION GATE: false for an external repo's PR, true for a watched one; the per-PR
//      auto-post settings read every automatic switch OFF there.
//
// DATABASE_URL is set BEFORE importing config/client; every import below is dynamic.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isProjectPr } from './external-repos.js';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-external-repos-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let q: any;
let ext: any;

const DAY = 24 * 60 * 60 * 1000;
const now = Math.floor(Date.now() / 1000) * 1000;
const VIEWER = 'viewer-ext';

let teamRepo = 0;
let infraRepo = 0;
let workspaceId = 0;
const pr: Record<string, number> = {};

describe('isProjectPr (pure)', () => {
  const rule = {
    maintainers: new Set([1, 2]),
    allowKeys: new Set(['ENG']),
    watchedRepoNames: new Set(['acme/team']),
  };
  it('a maintainer of a watched repo makes it a project PR', () => {
    expect(isProjectPr({ ownerId: 2, ticketKeys: [] }, rule)).toBe(true);
  });
  it('an allowlisted ticket key makes it a project PR; a foreign prefix does not', () => {
    expect(isProjectPr({ ownerId: 9, ticketKeys: ['ENG-12'] }, rule)).toBe(true);
    expect(isProjectPr({ ownerId: 9, ticketKeys: ['PLAT-9'] }, rule)).toBe(false);
    expect(isProjectPr({ ownerId: null, ticketKeys: [] }, rule)).toBe(false);
  });
  it('no allowlist: the ticket rule never fires', () => {
    expect(isProjectPr({ ownerId: 9, ticketKeys: ['ENG-12'] }, { ...rule, allowKeys: new Set() })).toBe(false);
  });
  it('a GitHub Issues key counts only for an issue in a WATCHED repo', () => {
    expect(isProjectPr({ ownerId: 9, ticketKeys: ['acme/team#4'] }, rule)).toBe(true);
    expect(isProjectPr({ ownerId: 9, ticketKeys: ['acme/infra#4'] }, rule)).toBe(false);
  });
});

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  q = await import('./queries.js');
  ext = await import('./external-repos.js');
  const { accounts, repos, pullRequests, reviewRequests, users, workspaceTrackers, trackerTickets } = schema;
  const { eq } = await import('drizzle-orm');

  await db.update(accounts).set({ githubLogin: VIEWER }).where(eq(accounts.id, 1)).execute();

  const user = async (login: string): Promise<number> =>
    (await db.insert(users).values({ githubLogin: login, githubNodeId: `U_${login}`, isBot: false }).returning().execute())[0].id;
  const viewerId = await user(VIEWER);
  const alice = await user('alice-ext'); // merges in the WATCHED repo → a maintainer
  const platform = await user('platform-ext'); // merges only in the EXTERNAL repo → not one
  const bob = await user('bob-ext');

  const repo = async (name: string): Promise<number> =>
    (
      await db
        .insert(repos)
        .values({ accountId: 1, owner: 'acme', name, githubNodeId: `R_ext_${name}`, defaultBranch: 'main', viewerPermission: 'WRITE', createdAt: new Date(now - 30 * DAY) })
        .returning()
        .execute()
    )[0].id;
  teamRepo = await repo('team');
  infraRepo = await repo('infra');

  let n = 1;
  const addPr = async (key: string, repoId: number, authorId: number, values: Record<string, unknown> = {}): Promise<number> => {
    const id = (
      await db
        .insert(pullRequests)
        .values({
          githubNodeId: `PR_ext_${key}`,
          accountId: 1,
          repoId,
          number: n++,
          title: `${key} change`,
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
    pr[key] = id;
    return id;
  };
  const merged = (by: number) => ({ state: 'merged', mergedById: by, baseRefName: 'main', mergedAt: new Date(now - 10 * DAY) });
  await addPr('team-merged', teamRepo, alice, merged(alice));
  await addPr('infra-merged', infraRepo, platform, merged(platform));
  await addPr('team-open', teamRepo, bob);
  await addPr('infra-alice', infraRepo, alice);
  await addPr('infra-viewer', infraRepo, viewerId);
  await addPr('infra-eng', infraRepo, platform);
  await addPr('infra-plat', infraRepo, platform);
  await addPr('infra-plain', infraRepo, platform);

  // Every repo lands in Default (the membership repair), which is the workspace under test.
  workspaceId = (await q.resolveWorkspaceScope(1, null)).workspaceId;
  expect(await q.setWorkspaceRepoMode(1, workspaceId, infraRepo, 'external')).toBe(true);

  await db.insert(workspaceTrackers).values({ accountId: 1, workspaceId, provider: 'jira', baseUrl: 'https://acme.atlassian.net', projectKeys: 'ENG' }).execute();
  const ticket = (prId: number, issueKey: string) => ({
    accountId: 1,
    workspaceId,
    prId,
    provider: 'jira',
    issueKey,
    detectedFrom: 'title',
    detectOrder: 0,
    apiRoot: 'https://acme.atlassian.net',
    url: `https://acme.atlassian.net/browse/${issueKey}`,
    state: 'ok',
    checkedAt: new Date(now),
    nextCheckAt: new Date(now + DAY),
  });
  await db.insert(trackerTickets).values([ticket(pr['infra-eng']!, 'ENG-12'), ticket(pr['infra-plat']!, 'PLAT-9')]).execute();

  // Review requests of the viewer: one on a PROJECT PR, one on an external repo's OTHER PR.
  await db.insert(reviewRequests).values([{ prId: pr['infra-eng']!, userId: viewerId }, { prId: pr['infra-plain']!, userId: viewerId }]).execute();
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('external repos on the database', () => {
  it('lists the external member on the workspace', async () => {
    const ws = (await q.listWorkspaces(1)).find((w: any) => w.id === workspaceId);
    expect(ws.externalRepoIds).toEqual([infraRepo]);
    expect(ws.repoIds.sort()).toEqual([teamRepo, infraRepo].sort());
  });

  it('maintainers come from WATCHED repos only, plus the reader', async () => {
    const m: Set<number> = await ext.workspaceMaintainerIds(1, workspaceId);
    const ids = await db.select().from(schema.users).execute();
    const byLogin = new Map<string, number>(ids.map((u: any) => [u.githubLogin as string, u.id as number]));
    expect(m.has(byLogin.get('alice-ext')!)).toBe(true);
    expect(m.has(byLogin.get(VIEWER)!)).toBe(true);
    expect(m.has(byLogin.get('platform-ext')!)).toBe(false);
  });

  it('resolves watched members by default, every member for the build paths, and the project PRs', async () => {
    expect((await q.resolveWorkspaceScope(1, workspaceId)).repoIds).toEqual([teamRepo]);
    expect((await q.resolveWorkspaceScope(1, workspaceId, null, { members: 'all' })).repoIds.sort()).toEqual([teamRepo, infraRepo].sort());
    const scope = await q.resolveWorkspaceScope(1, workspaceId, null, { projectPrs: true });
    expect(scope.repoIds).toEqual([teamRepo]);
    expect([...scope.projectPrIds].sort()).toEqual([pr['infra-alice'], pr['infra-viewer'], pr['infra-eng']].sort());
  });

  it('Open PRs lists the watched PRs plus the project PRs only', async () => {
    const scope = await q.resolveWorkspaceScope(1, workspaceId, null, { projectPrs: true });
    const open = await q.getOpenPrs({ accountId: 1, repoIds: scope.repoIds, userIds: null, projectPrIds: scope.projectPrIds });
    expect(open.map((p: any) => p.id).sort()).toEqual(
      [pr['team-open'], pr['infra-alice'], pr['infra-viewer'], pr['infra-eng']].sort(),
    );
  });

  it('the account-wide My Turn keeps a request on a project PR and drops one on another external PR', async () => {
    const mt = await q.getMyTurn(1);
    const ids = mt.awaitingReview.map((i: any) => i.prId);
    expect(ids).toContain(pr['infra-eng']);
    expect(ids).not.toContain(pr['infra-plain']);
  });

  it('the automation gate refuses an external repo and allows a watched one', async () => {
    expect(await ext.automationAllowedForPr(1, pr['infra-alice'])).toBe(false);
    expect(await ext.automationAllowedForRepo(1, infraRepo)).toBe(false);
    expect(await ext.automationAllowedForPr(1, pr['team-open'])).toBe(true);
  });

  it('reads every automatic write switch OFF for an external PR', async () => {
    const { readWorkspaceAutoPostForPr, readWorkspaceAutoFixSettingsForPr } = await import('../review/claude-review/auto-settings.js');
    const ctx = { db, schema } as any;
    const onExternal = await readWorkspaceAutoPostForPr(ctx, 1, pr['infra-viewer']!);
    expect(onExternal?.settings.enabled).toBe(false);
    expect(onExternal?.settings.autoVerdict).toBe(false);
    expect(onExternal?.settings.resolveOwnPrs).toBe(false);
    expect(onExternal?.autoReviewOn).toBe(false);
    const onWatched = await readWorkspaceAutoPostForPr(ctx, 1, pr['team-open']!);
    expect(onWatched?.settings.enabled).toBe(true);
    expect((await readWorkspaceAutoFixSettingsForPr(ctx, 1, pr['infra-viewer']!))?.enabled).toBe(false);
  });

  it('a move keeps the mode; setting it back to watched restores the repo everywhere', async () => {
    expect(await q.setWorkspaceRepoMode(1, workspaceId, infraRepo, 'watched')).toBe(true);
    expect((await q.resolveWorkspaceScope(1, workspaceId)).repoIds.sort()).toEqual([teamRepo, infraRepo].sort());
    expect(await ext.automationAllowedForRepo(1, infraRepo)).toBe(true);
    // A repo that is not a member of the named workspace: false (the route answers 404).
    expect(await q.setWorkspaceRepoMode(1, workspaceId + 999, infraRepo, 'external')).toBe(false);
    await q.setWorkspaceRepoMode(1, workspaceId, infraRepo, 'external');
  });
});
