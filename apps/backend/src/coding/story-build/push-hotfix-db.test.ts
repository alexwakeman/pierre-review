// HOTFIX BUILDS over the REAL core client (a scratch SQLite, migrations applied) with a FAKE GitHub (the
// push-hotfix.ts seam). docs/STORY-BUILD.md § Hotfix builds; docs/RELEASES.md acceptance 25, 28, 29, 31.
// Pinned:
//   • the bases from the synced tags (`getHotfixBases`, the route `GET /api/story-builds/hotfix-bases`);
//   • Push: `hotfix/<tag>` made at the release commit when missing, PR 1 `<KEY>` into it and PR 2 `<KEY>-main`
//     into the default branch, both `<KEY>: <title>`, draft by default, each body linking the other (PR 1's by
//     ONE edit), every write the reader's; a moved branch is targeted as it is and its open PRs recorded;
//   • a second press writes nothing; a read-only repository is never pushed; no write permission refused;
//   • the review loop refused for a hotfix build (`…/loop/settings {on: true}`, `…/auto-push {on: true}`);
//   • `?target=main` reads the main fix.
import { rmSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { storyBuildPath } from '@pierre-review/shared';

const DB_PATH = `${process.env.DATABASE_URL ?? `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-storybuild`}.storybuild-hotfix.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

vi.mock('../../tracker/manual-links.js', () => ({ resolveTicketRefs: async () => ({ ok: true }) }));
vi.mock('../../tracker/runtime.js', () => ({ trackerContext: () => ({}) }));

/* eslint-disable @typescript-eslint/no-explicit-any */
const G = {
  pushes: [] as any[],
  creates: [] as any[],
  bodies: [] as any[],
  branches: new Map<string, string>(),
  onBase: [] as Array<{ number: number; title: string; url: string | null }>,
  canPush: true,
  nextPr: 40,
};

let db: any;
let schema: any;
let ctx: any;
let closeDb: (() => Promise<void> | void) | undefined;
let P: typeof import('./persist.js');
let H: typeof import('./push-hotfix.js');
let push: typeof import('./push.js');
let app: FastifyInstance;
let wsId = 0;
const repo = { api: 0, worker: 0 };
const REL = 'b'.repeat(40);
const MAIN = 'c'.repeat(40);
const IDENT = 'jira:https://acme.atlassian.net#PLAT-290';

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  const { ensureDefaultWorkspace, ensureRepoMemberships } = await import('../../db/queries.js');
  for (const acct of [1, 2]) await db.insert(schema.accounts).values({ id: acct, githubUserId: `N${acct}`, githubLogin: `u${acct}`, isLocal: acct === 1 }).onConflictDoNothing().execute();
  wsId = await ensureDefaultWorkspace(1);
  await ensureDefaultWorkspace(2);
  for (const name of ['api', 'worker'] as const) {
    const [r] = await db
      .insert(schema.repos)
      .values({ accountId: 1, githubNodeId: `R${name}`, owner: 'acme', name, defaultBranch: 'main', viewerPermission: 'WRITE' })
      .returning()
      .execute();
    repo[name] = r.id;
  }
  await ensureRepoMemberships?.(1).catch(() => {});
  const now = new Date('2026-11-14T10:00:00Z');
  await db
    .insert(schema.repoTags)
    .values([
      { accountId: 1, repoId: repo.api, name: 'v2.4.0', sha: REL, committedAt: new Date('2026-11-11T10:00:00Z'), onDefaultBranch: true, firstSeenAt: now, lastSeenAt: now },
      { accountId: 1, repoId: repo.api, name: 'v2.4.0-rc', sha: REL, committedAt: new Date('2026-11-12T10:00:00Z'), onDefaultBranch: true, firstSeenAt: now, lastSeenAt: now },
      { accountId: 1, repoId: repo.worker, name: 'v0.1.0', sha: 'e'.repeat(40), committedAt: new Date('2026-11-01T10:00:00Z'), onDefaultBranch: true, firstSeenAt: now, lastSeenAt: now },
    ])
    .execute();
  const { setReleaseSettings } = await import('../../db/release-settings.js');
  await setReleaseSettings(1, wsId, { releaseSuffix: '-rc', hotfixSuffix: '-hotfix' });
  ctx = { db, schema, log: { warn: () => {}, info: () => {}, error: () => {} }, accountIdOf: (req: any) => Number(req.headers['x-account'] ?? 1), github: {} };
  P = await import('./persist.js');
  H = await import('./push-hotfix.js');
  push = await import('./push.js');
  H.setHotfixPushDepsForTests({
    canPush: async () => G.canPush,
    token: async () => 'tok',
    branchSha: async (_t, _o, _n, branch) => G.branches.get(branch) ?? null,
    createBranch: async (_t, a) => {
      G.creates.push(a);
      if (G.branches.has(a.branch)) return { outcome: 'exists' };
      G.branches.set(a.branch, a.sha);
      return { outcome: 'created' };
    },
    openPrsOnBase: async () => G.onBase,
    pushAndOpen: async (a) => {
      G.pushes.push(a);
      const n = G.nextPr++;
      return { pushedBranch: a.branch, commitSha: `c${n}`, prNumber: n, prUrl: `https://github.com/${a.owner}/${a.name}/pull/${n}` };
    },
    updateBody: async (_t, _o, _n, number, body) => {
      G.bodies.push({ number, body });
      return { ok: true };
    },
    now: () => new Date('2026-11-15T09:00:00Z'),
  });
  const routes = await import('./routes-build.js');
  app = Fastify();
  routes.registerStoryBuildBuildRoutes(app, ctx);
  await app.ready();
});

afterAll(async () => {
  H?.setHotfixPushDepsForTests(null);
  await app?.close();
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

beforeEach(() => {
  G.pushes.length = 0;
  G.creates.length = 0;
  G.bodies.length = 0;
  G.branches.clear();
  G.onBase = [];
  G.canPush = true;
});

/** A built hotfix session: api with a release fix and a main fix, worker read only. */
async function hotfixSession(o: { mainPatch?: string | null; port?: import('@pierre-review/shared').HotfixPortClaim | null } = {}): Promise<{ id: number; apiRow: number; workerRow: number }> {
  for (const r of await P.listStoryBuildRowsFor(ctx, 1, wsId, IDENT)) if (r.status !== 'discarded') await P.updateStoryBuild(ctx, 1, r.id, { status: 'discarded' });
  const started = await P.insertStoryBuild(ctx, {
    accountId: 1,
    workspaceId: wsId,
    ident: IDENT,
    ticketKey: 'PLAT-290',
    ticketTitle: 'Refund rounding',
    wantDiagram: false,
    wantDocs: false,
    provider: 'claude',
    model: 'claude-opus-5-5',
    hotfix: true,
  });
  const id = started.id;
  await P.updateStoryBuild(ctx, 1, id, {
    status: 'ready',
    seedJson: { version: 1, story: { key: 'PLAT-290', title: 'Refund rounding', text: 't', url: 'https://acme.atlassian.net/browse/PLAT-290' }, criteria: [], comments: null, cards: [] },
  });
  const apiRow = await P.upsertStoryBuildRepo(ctx, {
    accountId: 1,
    buildId: id,
    repoId: repo.api,
    ref: 'R1',
    buildOrder: 0,
    include: true,
    status: 'ready',
    baseRef: 'v2.4.0-rc',
    baseSha: REL,
    stackedOnPrId: null,
    branch: 'PLAT-290',
    hotfix: { tagName: 'v2.4.0-rc', readOnly: false, mainBaseRef: 'main', mainBaseSha: MAIN },
  });
  const workerRow = await P.upsertStoryBuildRepo(ctx, {
    accountId: 1,
    buildId: id,
    repoId: repo.worker,
    ref: 'R2',
    buildOrder: 1,
    include: true,
    status: 'skipped',
    baseRef: 'main',
    baseSha: 'e'.repeat(40),
    stackedOnPrId: null,
    branch: 'PLAT-290',
    hotfix: { tagName: null, readOnly: true, mainBaseRef: null, mainBaseSha: null },
  });
  const mainPatch = o.mainPatch === undefined ? 'diff --git a/m.ts b/m.ts\n' : o.mainPatch;
  await P.updateStoryBuildRepo(ctx, 1, apiRow, {
    patch: 'diff --git a/r.ts b/r.ts\n',
    commitMessage: 'fix: round refunds half up',
    summary: 'Rounds refunds half up.',
    ...(mainPatch ? { mainPatch, mainStatus: 'ready', mainCommitMessage: 'fix: round refunds half up (main)' } : { mainStatus: 'skipped' }),
    ...(o.port !== undefined ? { portReportJson: o.port } : {}),
  });
  return { id, apiRow, workerRow };
}

describe('the hotfix bases (acceptance 25)', () => {
  it('25: api starts at its latest release; worker has none and is read only', async () => {
    const { getHotfixBases } = await import('../../db/hotfix-bases.js');
    const r = await getHotfixBases(1, wsId, [repo.api, repo.worker]);
    expect(r.offered).toBe(true);
    expect(r.repos.find((x) => x.repoId === repo.api)).toMatchObject({ release: { tagName: 'v2.4.0-rc', sha: REL }, hotfixBranch: 'hotfix/v2.4.0-rc' });
    expect(r.repos.find((x) => x.repoId === repo.worker)).toMatchObject({ release: null });
  });

  it('another account reads nothing of these repositories', async () => {
    const { getHotfixBases } = await import('../../db/hotfix-bases.js');
    const r = await getHotfixBases(2, wsId, [repo.api]);
    expect(r.repos).toEqual([]);
    expect(r.offered).toBe(false);
  });
});

describe('push a hotfix repository (acceptance 28, 29, 31)', () => {
  it('28: makes hotfix/<tag> at the release commit and opens PR 1 into it and PR 2 into main, linking each other', async () => {
    const s = await hotfixSession();
    const r = await push.pushRepo(ctx, { accountId: 1, buildId: s.id, repoId: repo.api, draft: true });
    expect(r).toMatchObject({ outcome: 'pushed', code: null });
    expect(G.creates).toEqual([{ owner: 'acme', name: 'api', branch: 'hotfix/v2.4.0-rc', sha: REL }]);
    expect(G.pushes).toHaveLength(2);
    const [p1, p2] = G.pushes;
    expect(p1).toMatchObject({ branch: 'PLAT-290', prBase: 'hotfix/v2.4.0-rc', baseSha: REL, baseRef: 'hotfix/v2.4.0-rc', title: 'PLAT-290: Refund rounding', draft: true, patch: 'diff --git a/r.ts b/r.ts\n' });
    expect(p2).toMatchObject({ branch: 'PLAT-290-main', prBase: 'main', baseSha: MAIN, baseRef: 'main', title: 'PLAT-290: Refund rounding', draft: true, patch: 'diff --git a/m.ts b/m.ts\n' });
    expect(p1.protect).toEqual(expect.arrayContaining(['main', 'hotfix/v2.4.0-rc', 'PLAT-290-main']));
    // PR 2 links PR 1 from the start; PR 1 is edited ONCE to link PR 2.
    expect(p2.body).toContain(`[#${40}](https://github.com/acme/api/pull/40)`);
    expect(p1.body).toContain('follows in its own pull request');
    expect(G.bodies).toHaveLength(1);
    expect(G.bodies[0]).toMatchObject({ number: 40 });
    expect(G.bodies[0].body).toContain('[#41](https://github.com/acme/api/pull/41)');
    for (const b of [p1.body, p2.body, G.bodies[0].body]) expect(b).not.toMatch(/limn/i);
    const row = await P.getStoryBuildRepoRow(ctx, 1, s.id, repo.api);
    expect(row).toMatchObject({ status: 'pushed', pushedPrNumber: 40, mainPushedPrNumber: 41, mainStatus: 'pushed' });
    expect(row!.hotfixBranchJson).toMatchObject({ name: 'hotfix/v2.4.0-rc', releaseSha: REL, created: true, movedToSha: null, prs: [] });
  });

  it('31: after the PRs open a second press writes nothing', async () => {
    const s = await hotfixSession();
    await push.pushRepo(ctx, { accountId: 1, buildId: s.id, repoId: repo.api, draft: true });
    const writes = G.pushes.length + G.creates.length + G.bodies.length;
    const again = await push.pushRepo(ctx, { accountId: 1, buildId: s.id, repoId: repo.api, draft: true });
    expect(again).toMatchObject({ outcome: 'skipped', code: 'ALREADY_PUSHED' });
    expect(G.pushes.length + G.creates.length + G.bodies.length).toBe(writes);
  });

  it('29: a branch that moved past the release is targeted as it is, never made again, and its open PRs recorded', async () => {
    const s = await hotfixSession();
    G.branches.set('hotfix/v2.4.0-rc', 'f'.repeat(40));
    G.onBase = [{ number: 12, title: 'PLAT-201: Fix the totals', url: 'https://github.com/acme/api/pull/12' }];
    await push.pushRepo(ctx, { accountId: 1, buildId: s.id, repoId: repo.api, draft: false });
    expect(G.creates).toEqual([]);
    expect(G.pushes[0]).toMatchObject({ prBase: 'hotfix/v2.4.0-rc', baseSha: REL, draft: false });
    const row = await P.getStoryBuildRepoRow(ctx, 1, s.id, repo.api);
    expect(row!.hotfixBranchJson).toMatchObject({ created: false, movedToSha: 'f'.repeat(40), prs: [{ number: 12, title: 'PLAT-201: Fix the totals' }] });
    // The wire carries it for the tab's line.
    const wire = P.toStoryBuildRepo(row!, 'acme/api', null, true);
    expect(wire.hotfix?.branch?.prs[0]?.number).toBe(12);
  });

  it('29: a second hotfix off the same release, with the first PR still open (branch at the release), names that PR', async () => {
    const s = await hotfixSession();
    G.branches.set('hotfix/v2.4.0-rc', REL);
    G.onBase = [{ number: 50, title: 'PLAT-201: Fix the totals', url: 'https://github.com/acme/api/pull/50' }];
    await push.pushRepo(ctx, { accountId: 1, buildId: s.id, repoId: repo.api, draft: true });
    expect(G.creates).toEqual([]);
    const row = await P.getStoryBuildRepoRow(ctx, 1, s.id, repo.api);
    expect(row!.hotfixBranchJson).toMatchObject({ created: false, movedToSha: null, prs: [{ number: 50 }] });
  });

  it('only a release fix: one PR, no pair line, no body edit', async () => {
    const s = await hotfixSession({ mainPatch: null });
    await push.pushRepo(ctx, { accountId: 1, buildId: s.id, repoId: repo.api, draft: true });
    expect(G.pushes).toHaveLength(1);
    expect(G.pushes[0].body).not.toContain('**Hotfix:**');
    expect(G.bodies).toEqual([]);
    expect((await P.getStoryBuildRepoRow(ctx, 1, s.id, repo.api))!.status).toBe('pushed');
  });

  it('36: not_needed with main unchanged opens PR 1 only, its body says why; no -main branch', async () => {
    const s = await hotfixSession({ mainPatch: null, port: { outcome: 'not_needed', reason: 'The refund code was removed from main in src/refunds/ (see @alice, fixes #12).', evidence: ['src/refunds/'] } });
    await push.pushRepo(ctx, { accountId: 1, buildId: s.id, repoId: repo.api, draft: true });
    expect(G.pushes).toHaveLength(1);
    expect(G.pushes[0]).toMatchObject({ branch: 'PLAT-290', prBase: 'hotfix/v2.4.0-rc' });
    const body: string = G.pushes[0].body;
    expect(body).toContain('**Port:** Not applied to main: The refund code was removed from main in src/refunds/');
    // Untrusted text, defanged: no mention, no closing keyword.
    expect(body).toContain('@\u200balice');
    expect(body).toContain('f\u200bixes #12');
    expect(body).not.toContain('**Hotfix:**');
    expect(body).not.toMatch(/limn/i);
    expect(G.pushes.some((p: any) => p.branch === 'PLAT-290-main')).toBe(false);
    const row = await P.getStoryBuildRepoRow(ctx, 1, s.id, repo.api);
    expect(row!.status).toBe('pushed');
    expect(P.toStoryBuildRepo(row!, 'acme/api', null, true).hotfix?.port).toEqual({
      claim: { outcome: 'not_needed', reason: 'The refund code was removed from main in src/refunds/ (see @alice, fixes #12).', evidence: ['src/refunds/'] },
      flag: null,
      files: null,
    });
  });

  it('34/35: same and adapted — both PRs carry the one line, adapted with its reason', async () => {
    let s = await hotfixSession({ port: { outcome: 'same', reason: null, evidence: [] } });
    await push.pushRepo(ctx, { accountId: 1, buildId: s.id, repoId: repo.api, draft: true });
    expect(G.pushes).toHaveLength(2);
    for (const p of G.pushes) expect(p.body).toContain('**Port:** Applied to both.');
    expect(G.pushes[1].body).toContain('**Hotfix:** the same fix for the release');
    G.pushes.length = 0;
    G.bodies.length = 0;
    G.branches.clear();
    s = await hotfixSession({ port: { outcome: 'adapted', reason: 'Main computes refunds in src/money.ts, so the rounding moved there.', evidence: [] } });
    await push.pushRepo(ctx, { accountId: 1, buildId: s.id, repoId: repo.api, draft: true });
    expect(G.pushes).toHaveLength(2);
    for (const p of G.pushes) expect(p.body).toContain('**Port:** Applied to both, adapted for main: Main computes refunds in src/money.ts, so the rounding moved there.');
    expect(G.pushes[1].body).toContain('**Hotfix:** the fix for the release');
    expect(G.bodies[0].body).toContain('**Hotfix:** the fix for main is');
  });

  it('37: a claim the patches contradict is flagged on the wire, Push still opens what changed, and the claim is not sent', async () => {
    const s = await hotfixSession({ port: { outcome: 'not_needed', reason: 'Removed on main.', evidence: [] } });
    const before = await P.getStoryBuildRepoRow(ctx, 1, s.id, repo.api);
    expect(P.toStoryBuildRepo(before!, 'acme/api', null, true).hotfix?.port?.flag).toBe('not_needed_but_changed');
    await push.pushRepo(ctx, { accountId: 1, buildId: s.id, repoId: repo.api, draft: true });
    expect(G.pushes).toHaveLength(2);
    for (const p of G.pushes) expect(p.body).not.toContain('**Port:**');
  });

  it('no report: the wire says so (claim null), never inferred; the bodies carry no port line', async () => {
    const s = await hotfixSession();
    const row = await P.getStoryBuildRepoRow(ctx, 1, s.id, repo.api);
    expect(P.toStoryBuildRepo(row!, 'acme/api', null, true).hotfix?.port).toMatchObject({ claim: null, flag: null });
    await push.pushRepo(ctx, { accountId: 1, buildId: s.id, repoId: repo.api, draft: true });
    for (const p of G.pushes) expect(p.body).not.toContain('**Port:**');
  });

  it('a read-only repository is never pushed', async () => {
    const s = await hotfixSession();
    const r = await push.pushRepo(ctx, { accountId: 1, buildId: s.id, repoId: repo.worker, draft: true });
    expect(r).toMatchObject({ outcome: 'skipped', code: 'READ_ONLY' });
    expect(G.pushes).toEqual([]);
  });

  it('no push permission: refused before any write; a rename is refused', async () => {
    const s = await hotfixSession();
    G.canPush = false;
    expect(await push.pushRepo(ctx, { accountId: 1, buildId: s.id, repoId: repo.api, draft: true })).toMatchObject({ outcome: 'failed', code: 'NO_PUSH_PERMISSION' });
    G.canPush = true;
    expect(await push.pushRepo(ctx, { accountId: 1, buildId: s.id, repoId: repo.api, draft: true, branch: 'other' })).toMatchObject({ outcome: 'failed', code: 'PUSH_DENIED' });
    expect(G.pushes.length + G.creates.length).toBe(0);
  });
});

describe('the routes', () => {
  it('refuses the review loop for a hotfix build (loop settings and auto-push)', async () => {
    const s = await hotfixSession();
    const a = await app.inject({ method: 'POST', url: storyBuildPath('loopSettings', { id: s.id }), payload: { on: true } });
    expect(a.statusCode).toBe(409);
    expect(a.json()).toMatchObject({ error: 'HotfixNoLoop' });
    const b = await app.inject({ method: 'POST', url: storyBuildPath('autoPush', { id: s.id }), payload: { on: true } });
    expect(b.statusCode).toBe(409);
    expect(b.json()).toMatchObject({ error: 'HotfixNoLoop' });
    // Off stays allowed (nothing to refuse).
    const c = await app.inject({ method: 'POST', url: storyBuildPath('autoPush', { id: s.id }), payload: { on: false } });
    expect(c.statusCode).toBe(200);
  });

  it('?target=main reads the main fix; the release fix is the default', async () => {
    const s = await hotfixSession();
    const main = await app.inject({ method: 'GET', url: `${storyBuildPath('repoDiff', { id: s.id, repoId: repo.api })}?target=main` });
    expect(main.statusCode).toBe(200);
    expect(main.json()).toMatchObject({ target: 'main', baseSha: MAIN, patch: 'diff --git a/m.ts b/m.ts\n' });
    const rel = await app.inject({ method: 'GET', url: storyBuildPath('repoDiff', { id: s.id, repoId: repo.api }) });
    expect(rel.json()).toMatchObject({ target: 'release', baseSha: REL, patch: 'diff --git a/r.ts b/r.ts\n' });
    expect((await app.inject({ method: 'GET', url: `${storyBuildPath('repoDiff', { id: s.id, repoId: repo.worker })}?target=main` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `${storyBuildPath('repoDiff', { id: s.id, repoId: repo.api })}?target=x` })).statusCode).toBe(400);
  });

  it('GET hotfix-bases answers the workspace (unknown ⇒ Default, never 404)', async () => {
    const r = await app.inject({ method: 'GET', url: `${storyBuildPath('hotfixBases')}?workspace=nope` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ workspaceId: wsId, configured: true });
  });
});
