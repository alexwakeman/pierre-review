// PUSH (push.ts) AND THE BUILD-SIDE ROUTES (routes-build.ts) over the REAL core client (a scratch SQLite,
// migrations applied) with a FAKE GitHub: `applyAndPushBranch` (git-ops.ts, the no-PR variant) is
// replaced by a recorder, and the tracker's manual link by a spy. Pinned:
//   • the new PR: title `KEY: title`, a DRAFT by default (a toggle opens it ready), the body (summary,
//     criteria covered, the ticket link, sibling PRs, "Closes" on a single-repository GitHub Issues build
//     only, the product footer), the protected refs, the stacked base;
//   • outcomes recorded on the row: pushed (status + PR), BRANCH_EXISTS (a sentence, no clobber), a
//     closed stacked PR refused before any push, no write permission refused, PR_NOT_OPENED keeps the
//     branch it pushed; the manual tracker link written once the PR syncs;
//   • Push all: every unpushed ready repository IN PLAN ORDER, each on its own, a later body linking
//     the earlier PR;
//   • the routes: tenancy 404s, `draft` parsing, the diff, the checks preview at the base (cached), the
//     retry lane (503 until the manager registers one).
import { rmSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GITHUB_TRACKER_ROOT, storyBuildPath, trackerTicketIdent, type StoryBuildPlan } from '@pierre-review/shared';

const DB_PATH = `${process.env.DATABASE_URL ?? '/tmp/pierre-storybuild'}.storybuild-push.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
const G = vi.hoisted(() => ({
  pushes: [] as any[],
  fail: null as null | { code: string; message: string; commitSha?: string },
  links: [] as any[],
  nextPr: 100,
}));

vi.mock('../git-ops.js', () => ({
  applyAndPushBranch: async (a: any) => {
    G.pushes.push(a);
    if (G.fail) {
      const e = new Error(G.fail.message) as any;
      e.code = G.fail.code;
      if (G.fail.commitSha) e.commitSha = G.fail.commitSha;
      throw e;
    }
    const n = G.nextPr++;
    // The PR synced: the push's after-sync step runs (the manual link).
    await a.afterSync?.(n);
    return { pushedBranch: a.branch, commitSha: `c${n}`, prNumber: n, prUrl: `https://github.com/${a.owner}/${a.name}/pull/${n}` };
  },
}));
vi.mock('../../tracker/manual-links.js', () => ({
  resolveTicketRefs: async (_ctx: unknown, accountId: number, prId: number, body: unknown) => {
    G.links.push({ accountId, prId, body });
    return { ok: true, body: { prId, provider: 'jira', results: [] } };
  },
}));
vi.mock('../../tracker/runtime.js', () => ({ trackerContext: () => ({}) }));
vi.mock('../../review/clone-manager.js', () => ({
  removeWorktreeLocked: async () => {},
  prepBranchWorktree: async () => {
    throw new Error('no checkout in this test');
  },
  scrubGitError: (e: unknown) => String(e),
}));

let db: any;
let schema: any;
let ctx: any;
let closeDb: (() => Promise<void> | void) | undefined;
let P: typeof import('./persist.js');
let push: typeof import('./push.js');
let seams: typeof import('./seams.js');
let routes: typeof import('./routes-build.js');
const repo: Record<number, { api: number; web: number }> = {};
const ws: Record<number, number> = {};
const IDENT = 'jira:https://acme.atlassian.net#ACME-214';
const fetched: any[] = [];

const PLAN = (apiId: number, webId: number): StoryBuildPlan => ({
  revision: 1,
  summary: 'Add card refunds. Two repositories change.',
  repos: [
    { ref: 'R1', repoId: apiId, why: 'Endpoint.', branchSlug: 'refunds-api', steps: [{ title: 'Endpoint', files: ['a.ts'], change: 'Add.', refs: ['AC1'] }], tests: [] },
    { ref: 'R2', repoId: webId, why: 'Button.', branchSlug: 'refunds-web', steps: [{ title: 'Button', files: ['b.ts'], change: 'Add.', refs: ['AC2'] }], tests: [] },
  ],
  readOnlyRepos: [],
  criteria: [
    { ref: 'AC1', how: 'planned', repo: 'R1', reason: null },
    { ref: 'AC2', how: 'planned', repo: 'R2', reason: null },
  ],
  risks: [],
});

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  const { ensureDefaultWorkspace } = await import('../../db/queries.js');
  for (const acct of [1, 2]) {
    await db.insert(schema.accounts).values({ id: acct, githubUserId: `N${acct}`, githubLogin: `u${acct}`, isLocal: acct === 1 }).onConflictDoNothing().execute();
    ws[acct] = await ensureDefaultWorkspace(acct);
    const ids: number[] = [];
    for (const name of ['api', 'web']) {
      const [r] = await db
        .insert(schema.repos)
        .values({ accountId: acct, githubNodeId: `R${acct}${name}`, owner: 'acme', name, defaultBranch: 'main', viewerPermission: 'WRITE' })
        .returning()
        .execute();
      ids.push(r.id);
    }
    repo[acct] = { api: ids[0]!, web: ids[1]! };
  }
  ctx = {
    db,
    schema,
    log: { warn: () => {}, info: () => {}, error: () => {} },
    accountIdOf: (req: any) => Number(req.headers['x-account'] ?? 1),
    github: {
      fetchRepoFiles: async (_acct: number, a: any) => {
        fetched.push(a);
        return { 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) };
      },
    },
  };
  P = await import('./persist.js');
  push = await import('./push.js');
  seams = await import('./seams.js');
  routes = await import('./routes-build.js');
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

beforeEach(() => {
  G.pushes.length = 0;
  G.links.length = 0;
  G.fail = null;
});

/** A finished session with both repositories ready (fresh each time: the claim is per ticket). */
async function readySession(opts: { ident?: string; only?: 'api' | 'web'; stackedOnPrId?: number | null } = {}): Promise<{ id: number; api: number; web: number }> {
  const { api, web } = repo[1]!;
  // Close any open session for the ticket so the claim succeeds.
  for (const r of await P.listStoryBuildRowsFor(ctx, 1, ws[1]!, opts.ident ?? IDENT)) {
    if (r.status !== 'discarded') await P.updateStoryBuild(ctx, 1, r.id, { status: 'discarded' });
  }
  const started = await P.insertStoryBuild(ctx, {
    accountId: 1,
    workspaceId: ws[1]!,
    ident: opts.ident ?? IDENT,
    ticketKey: 'ACME-214',
    ticketTitle: 'Refunds by card',
    wantDiagram: false,
    wantDocs: false,
    provider: 'claude',
    model: 'claude-opus-5-5',
  });
  const id = started.id;
  await P.updateStoryBuild(ctx, 1, id, {
    status: 'ready',
    planJson: PLAN(api, web),
    planRevision: 1,
    acceptedRevision: 1,
    coverageJson: {
      state: 'none',
      ticketReviewId: null,
      checkedAt: null,
      criteria: [
        { ref: 'AC1', text: 'An API refunds a payment', verdict: 'not_checked', coveredByPrIds: [] },
        { ref: 'AC2', text: 'Support sees a refund button', verdict: 'not_checked', coveredByPrIds: [] },
      ],
      missing: [],
      existingPrs: [],
      note: null,
    },
    seedJson: { version: 1, story: { key: 'ACME-214', title: 'Refunds by card', text: 't', url: 'https://acme.atlassian.net/browse/ACME-214' }, criteria: [], comments: null, cards: [] },
  });
  const common = { accountId: 1, buildId: id, baseRef: 'main', baseSha: 'b'.repeat(40), stackedOnPrId: null, status: 'ready' as const };
  const apiRow = await P.upsertStoryBuildRepo(ctx, { ...common, repoId: api, ref: 'R1', buildOrder: 0, include: opts.only !== 'web', branch: 'acme-214-refunds-api', stackedOnPrId: opts.stackedOnPrId ?? null });
  const webRow = await P.upsertStoryBuildRepo(ctx, { ...common, repoId: web, ref: 'R2', buildOrder: 1, include: opts.only !== 'api', branch: 'acme-214-refunds-web' });
  await P.updateStoryBuildRepo(ctx, 1, apiRow, {
    patch: 'diff --git a/a.ts b/a.ts\n',
    summary: 'Added the refund endpoint.',
    commitMessage: 'feat: refund endpoint',
    changeReportJson: { changes: [{ path: 'a.ts', summary: 'x', refs: ['AC1'] }], unaddressed: [], notReported: [] },
    worktreePath: '/clones/acme__api/.worktrees/x-1-1',
  });
  await P.updateStoryBuildRepo(ctx, 1, webRow, { patch: 'diff --git a/b.ts b/b.ts\n', summary: 'Added the refund button.', commitMessage: 'feat: refund button' });
  return { id, api, web };
}

describe('pushRepo', () => {
  it('opens a DRAFT PR titled KEY: title, with the body, protected refs, and the ticket linked by hand', async () => {
    const s = await readySession();
    const r = await push.pushRepo(ctx, { accountId: 1, buildId: s.id, repoId: s.api, draft: true });
    expect(r).toMatchObject({ outcome: 'pushed', prNumber: expect.any(Number), code: null, error: null });
    const call = G.pushes[0];
    expect(call).toMatchObject({
      owner: 'acme',
      name: 'api',
      branch: 'acme-214-refunds-api',
      prBase: 'main',
      baseRef: 'main',
      baseSha: 'b'.repeat(40),
      draft: true,
      title: 'ACME-214: Refunds by card',
      commitMessage: 'feat: refund endpoint',
    });
    expect(call.protect).toEqual(['main']);
    expect(call.body).toContain('Added the refund endpoint.');
    expect(call.body).toContain('**Story:** [ACME-214: Refunds by card](https://acme.atlassian.net/browse/ACME-214)');
    expect(call.body).toContain('- AC1: An API refunds a payment');
    expect(call.body).not.toContain('AC2');
    expect(call.body).not.toContain('Closes');
    expect(call.body).toContain('Built with Limn from ACME-214.');
    // Recorded on the row.
    const row = (await P.getStoryBuildRepoRow(ctx, 1, s.id, s.api))!;
    expect(row).toMatchObject({ status: 'pushed', pushedPrNumber: r.prNumber, pushedBranch: 'acme-214-refunds-api', pushError: null, prTitle: 'ACME-214: Refunds by card' });
    // The manual tracker link once the PR synced — only when the PR is a local row (here it is not yet).
    expect(G.links).toEqual([]);
    // A second press answers skipped, never a second push.
    const again = await push.pushRepo(ctx, { accountId: 1, buildId: s.id, repoId: s.api, draft: true });
    expect(again).toMatchObject({ outcome: 'skipped', code: 'ALREADY_PUSHED', prNumber: r.prNumber });
    expect(G.pushes).toHaveLength(1);
  });

  it('links the ticket by hand once the new PR is a local row', async () => {
    const s = await readySession();
    const n = G.nextPr;
    await db.insert(schema.pullRequests).values({ accountId: 1, repoId: s.web, githubNodeId: `PR${n}`, number: n, title: 'x', state: 'open', openedAt: new Date(), updatedAt: new Date() }).execute();
    const r = await push.pushRepo(ctx, { accountId: 1, buildId: s.id, repoId: s.web, draft: false });
    expect(r.outcome).toBe('pushed');
    expect(G.pushes[0].draft).toBe(false);
    expect(G.links).toEqual([{ accountId: 1, prId: expect.any(Number), body: { refs: ['ACME-214'], link: true } }]);
  });

  it('refuses BRANCH_EXISTS with a sentence and records it on the row', async () => {
    const s = await readySession();
    G.fail = { code: 'BRANCH_EXISTS', message: 'branch exists' };
    const r = await push.pushRepo(ctx, { accountId: 1, buildId: s.id, repoId: s.api, draft: true });
    expect(r).toMatchObject({ outcome: 'failed', code: 'BRANCH_EXISTS', error: 'A branch named acme-214-refunds-api already exists on acme/api. Pick another branch name.' });
    const row = (await P.getStoryBuildRepoRow(ctx, 1, s.id, s.api))!;
    expect(row).toMatchObject({ status: 'ready', pushError: r.error });
  });

  it('PR_NOT_OPENED keeps the branch it pushed, so nobody presses Push into BRANCH_EXISTS blind', async () => {
    const s = await readySession();
    G.fail = { code: 'PR_NOT_OPENED', message: 'The branch was pushed, but GitHub did not open the pull request.', commitSha: 'abc' };
    const r = await push.pushRepo(ctx, { accountId: 1, buildId: s.id, repoId: s.api, draft: true });
    expect(r).toMatchObject({ outcome: 'failed', code: 'PR_NOT_OPENED' });
    expect(await P.getStoryBuildRepoRow(ctx, 1, s.id, s.api)).toMatchObject({ status: 'ready', pushedBranch: 'acme-214-refunds-api', pushedCommitSha: 'abc' });
  });

  it('refuses without write permission, and while the build is still running', async () => {
    const s = await readySession();
    await db.update(schema.repos).set({ viewerPermission: 'READ' }).where((await import('drizzle-orm')).eq(schema.repos.id, s.api)).execute();
    try {
      const r = await push.pushRepo(ctx, { accountId: 1, buildId: s.id, repoId: s.api, draft: true });
      expect(r).toMatchObject({ outcome: 'failed', code: 'NO_PUSH_PERMISSION' });
    } finally {
      await db.update(schema.repos).set({ viewerPermission: 'WRITE' }).where((await import('drizzle-orm')).eq(schema.repos.id, s.api)).execute();
    }
    await P.updateStoryBuild(ctx, 1, s.id, { status: 'building' });
    expect(await push.pushRepo(ctx, { accountId: 1, buildId: s.id, repoId: s.api, draft: true })).toMatchObject({ outcome: 'failed', code: 'BUSY' });
    expect(G.pushes).toEqual([]);
  });

  it('a stacked repository targets the PR it stacks on, protects that branch, and refuses once that PR closed', async () => {
    const { api } = repo[1]!;
    const [pr] = await db
      .insert(schema.pullRequests)
      .values({ accountId: 1, repoId: api, githubNodeId: 'PRstack', number: 31, title: 'mine', state: 'open', headRefName: 'u1/refunds-base', openedAt: new Date(), updatedAt: new Date() })
      .returning()
      .execute();
    const s = await readySession({ stackedOnPrId: pr.id });
    await db.update(schema.storyBuildRepos).set({ baseRef: 'u1/refunds-base' }).where((await import('drizzle-orm')).eq(schema.storyBuildRepos.repoId, api)).execute();
    const r = await push.pushRepo(ctx, { accountId: 1, buildId: s.id, repoId: api, draft: true });
    expect(r.outcome).toBe('pushed');
    expect(G.pushes[0]).toMatchObject({ prBase: 'u1/refunds-base', baseRef: 'u1/refunds-base' });
    expect(G.pushes[0].protect).toEqual(['main', 'u1/refunds-base']);
    expect(G.pushes[0].body).toContain('Stacked on #31.');

    const s2 = await readySession({ stackedOnPrId: pr.id });
    await db.update(schema.pullRequests).set({ state: 'merged' }).where((await import('drizzle-orm')).eq(schema.pullRequests.id, pr.id)).execute();
    const refused = await push.pushRepo(ctx, { accountId: 1, buildId: s2.id, repoId: api, draft: true });
    expect(refused).toMatchObject({ outcome: 'failed', code: 'STACK_CLOSED' });
    expect(refused.error).toContain('Pull request #31, which this build stacks on, is no longer open.');
    expect(G.pushes).toHaveLength(1);
  });

  it('a single-repository GitHub Issues build closes its issue; a two-repository one does not', async () => {
    const ident = trackerTicketIdent('github', GITHUB_TRACKER_ROOT, 'acme/web#7');
    const one = await readySession({ ident, only: 'web' });
    await push.pushRepo(ctx, { accountId: 1, buildId: one.id, repoId: one.web, draft: true });
    expect(G.pushes[0].body).toContain('Closes acme/web#7');
    const two = await readySession({ ident });
    await push.pushRepo(ctx, { accountId: 1, buildId: two.id, repoId: two.web, draft: true });
    expect(G.pushes[1].body).not.toContain('Closes');
  });

  it('another account’s build is not found', async () => {
    const s = await readySession();
    expect(await push.pushRepo(ctx, { accountId: 2, buildId: s.id, repoId: s.api, draft: true })).toMatchObject({ outcome: 'failed', code: 'NotFound' });
  });
});

describe('pushAllRepos', () => {
  it('pushes every unpushed ready repository IN PLAN ORDER; a later body links the earlier PR', async () => {
    const s = await readySession();
    const results = await push.pushAllRepos(ctx, { accountId: 1, buildId: s.id, draft: true });
    expect(results!.map((r) => [r.repoId, r.outcome])).toEqual([
      [s.api, 'pushed'],
      [s.web, 'pushed'],
    ]);
    expect(G.pushes.map((p) => p.name)).toEqual(['api', 'web']);
    expect(G.pushes[1].body).toContain(`[acme/api#${results![0]!.prNumber}](https://github.com/acme/api/pull/${results![0]!.prNumber})`);
    // Nothing left: a second Push all pushes nothing.
    expect(await push.pushAllRepos(ctx, { accountId: 1, buildId: s.id, draft: true })).toEqual([]);
  });

  it('each repository succeeds or fails on its own', async () => {
    const s = await readySession();
    let n = 0;
    const results = await push.pushAllRepos(ctx, {
      accountId: 1,
      buildId: s.id,
      draft: true,
      push: async (c, a) => (n++ === 0 ? { repoId: a.repoId, outcome: 'failed', prNumber: null, prUrl: null, code: 'PUSH_DENIED', error: 'no' } : push.pushRepo(c, a)),
    });
    expect(results!.map((r) => r.outcome)).toEqual(['failed', 'pushed']);
  });
});

describe('the build-side routes', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = Fastify();
    routes.registerStoryBuildBuildRoutes(app, ctx);
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    seams.registerStoryBuildLane(null);
  });
  const as = (acct: number) => ({ 'x-account': String(acct) });

  it('the diff: the stored patch, 404 for another account', async () => {
    const s = await readySession();
    const ok = await app.inject({ method: 'GET', url: storyBuildPath('repoDiff', { id: s.id, repoId: s.api }), headers: as(1) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ repoId: s.api, baseSha: 'b'.repeat(40), patch: 'diff --git a/a.ts b/a.ts\n', filesChanged: [] });
    expect((await app.inject({ method: 'GET', url: storyBuildPath('repoDiff', { id: s.id, repoId: s.api }), headers: as(2) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: storyBuildPath('repoDiff', { id: s.id, repoId: 99999 }), headers: as(1) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/story-builds/x/repos/1/diff', headers: as(1) })).statusCode).toBe(404);
  });

  it('the checks preview reads the manifest files at the BASE commit, once per ten minutes', async () => {
    routes.clearStoryBuildChecksCache();
    fetched.length = 0;
    const s = await readySession();
    const url = storyBuildPath('repoChecks', { id: s.id, repoId: s.web });
    const a = await app.inject({ method: 'GET', url, headers: as(1) });
    expect(a.statusCode).toBe(200);
    expect(a.json().checks.map((c: any) => c.name)).toContain('test');
    await app.inject({ method: 'GET', url, headers: as(1) });
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toMatchObject({ owner: 'acme', name: 'web', ref: 'b'.repeat(40) });
    expect((await app.inject({ method: 'GET', url, headers: as(2) })).statusCode).toBe(404);
  });

  it('push: draft by default, `draft:false` opens it ready, anything else is refused; another account is 404', async () => {
    const s = await readySession();
    const bad = await app.inject({ method: 'POST', url: storyBuildPath('repoPush', { id: s.id, repoId: s.api }), headers: as(1), payload: { draft: 'yes' } });
    expect(bad.statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: storyBuildPath('repoPush', { id: s.id, repoId: s.api }), headers: as(2), payload: {} })).statusCode).toBe(404);
    const ok = await app.inject({ method: 'POST', url: storyBuildPath('repoPush', { id: s.id, repoId: s.api }), headers: as(1), payload: {} });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().results[0]).toMatchObject({ repoId: s.api, outcome: 'pushed' });
    expect(G.pushes[0].draft).toBe(true);
    const all = await app.inject({ method: 'POST', url: storyBuildPath('pushAll', { id: s.id }), headers: as(1), payload: { draft: false } });
    expect(all.json().results.map((r: any) => r.repoId)).toEqual([s.web]);
    expect(G.pushes[1].draft).toBe(false);
    expect((await app.inject({ method: 'POST', url: storyBuildPath('pushAll', { id: s.id }), headers: as(2), payload: {} })).statusCode).toBe(404);
  });

  it('retry goes through the manager’s lane: 503 until one is registered, then its answer', async () => {
    const s = await readySession();
    const url = storyBuildPath('repoRetry', { id: s.id, repoId: s.web });
    expect((await app.inject({ method: 'POST', url, headers: as(1), payload: {} })).statusCode).toBe(503);
    const calls: any[] = [];
    seams.registerStoryBuildLane({
      retryRepo: async (_c, a) => {
        calls.push(a);
        return a.repoId === s.web ? { ok: true } : { ok: false, status: 409, error: 'Busy', message: 'A build is running.' };
      },
    });
    expect((await app.inject({ method: 'POST', url, headers: as(1), payload: {} })).statusCode).toBe(202);
    expect(calls).toEqual([{ accountId: 1, buildId: s.id, repoId: s.web }]);
    const busy = await app.inject({ method: 'POST', url: storyBuildPath('repoRetry', { id: s.id, repoId: s.api }), headers: as(1), payload: {} });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toEqual({ error: 'Busy', message: 'A build is running.' });
    expect((await app.inject({ method: 'POST', url, headers: as(2), payload: {} })).statusCode).toBe(404);
  });
});
