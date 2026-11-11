// PUSH (push.ts) AND THE BUILD-SIDE ROUTES (routes-build.ts) over the REAL core client (a scratch SQLite,
// migrations applied) with a FAKE GitHub: `applyAndPushBranch` (git-ops.ts, the no-PR variant) is
// replaced by a recorder, and the tracker's manual link by a spy. Pinned:
//   • the new PR: title `KEY: title`, a DRAFT by default (a toggle opens it ready), the body (summary,
//     criteria covered, the ticket link, sibling PRs, "Closes" on a single-repository GitHub Issues build
//     only, the product footer), the protected refs, the stacked base;
//   • outcomes recorded on the row: pushed (status + PR), BRANCH_EXISTS (a sentence, no clobber), a
//     closed stacked PR refused before any push, a stacked PR from a FORK (read live) refused too, no write permission refused, PR_NOT_OPENED keeps the
//     branch it pushed; the manual tracker link written once the PR syncs;
//   • Push all: every unpushed ready repository IN PLAN ORDER, each on its own, a later body linking
//     the earlier PR;
//   • the routes: tenancy 404s, `draft` parsing, the diff, the checks preview at the base (cached), the
//     retry lane (503 until the manager registers one);
//   • THE RENAME after BRANCH_EXISTS: the code stored beside the sentence, `branch` on the single-item
//     route reaching the push (stored once it lands), refused on Push all and when not a name;
//   • THE AUTOMATIC PUSH (auto-push.ts): once, ready (draft:false), origin 'auto'; skipped when off or
//     switched off before the claim; a failure recorded, never retried; a concurrent manual press safe;
//     the tab's switch (`…/auto-push`) refused once pushed.
import { rmSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GITHUB_TRACKER_ROOT, storyBuildPath, trackerTicketIdent, type StoryBuildPlan } from '@pierre-review/shared';

const DB_PATH = `${process.env.DATABASE_URL ?? `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-storybuild`}.storybuild-push.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
const G = vi.hoisted(() => ({
  pushes: [] as any[],
  fail: null as null | { code: string; message: string; commitSha?: string },
  links: [] as any[],
  nextPr: 100,
  forks: new Set<number>(),
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
let routes: typeof import('./routes-build.js');
let auto: typeof import('./auto-push.js');
const repo: Record<number, { api: number; web: number }> = {};
const ws: Record<number, number> = {};
const IDENT = 'jira:https://acme.atlassian.net#ACME-214';

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
      // The stacked PR's head repository, read live at the press (a fork is refused).
      fetchPrHeadInfo: async (_acct: number, _owner: string, _name: string, number: number) => ({
        headSha: 'h',
        headRef: 'r',
        headRepoFullName: G.forks.has(number) ? 'someone/fork' : 'acme/api',
        isFork: G.forks.has(number),
        maintainerCanModify: false,
        baseRef: 'main',
      }),
    },
  };
  P = await import('./persist.js');
  push = await import('./push.js');
  routes = await import('./routes-build.js');
  auto = await import('./auto-push.js');
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

    // A PR from a FORK: its branch is not in this repository, so nothing is pushed.
    G.forks.add(31);
    const sf = await readySession({ stackedOnPrId: pr.id });
    const forked = await push.pushRepo(ctx, { accountId: 1, buildId: sf.id, repoId: api, draft: true });
    G.forks.delete(31);
    expect(forked).toMatchObject({ outcome: 'failed', code: 'STACK_FORK' });
    expect(forked.error).toContain('is from a fork');
    expect(G.pushes).toHaveLength(1);

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

describe('defangGithubText', () => {
  it('breaks a closing keyword before an issue reference and an @mention, and leaves the rest as written', () => {
    const out = push.defangGithubText('Fixes #12. Also closes other/repo#3, resolves https://github.com/a/b/issues/1. cc @someone');
    expect(out).not.toMatch(/\b(fixes|closes|resolves)\s/i);
    expect(out).not.toMatch(/@[a-z]/);
    expect(out.replace(/\u200b/g, '')).toBe('Fixes #12. Also closes other/repo#3, resolves https://github.com/a/b/issues/1. cc @someone');
    expect(push.defangGithubText('fix: handle refunds; it fixes the bug')).toBe('fix: handle refunds; it fixes the bug');
    expect(push.defangGithubText('bump @types/node', { mentions: false })).toBe('bump @types/node');
  });

  it('the PR body quotes the build summary and the criteria, never obeys them; the code-written Closes line stays live', () => {
    const body = push.storyBuildPrBody({
      summary: 'Done. Fixes #1 and pings @boss.',
      ticketKey: 'ACME-1',
      ticketTitle: 'T',
      ticketUrl: null,
      covers: [{ ref: 'AC1', text: 'closes acme/web#9' }],
      siblings: [],
      stackedOnPrNumber: null,
      closes: 'acme/web#4',
    });
    expect(body).not.toMatch(/Fixes #1/);
    expect(body).not.toMatch(/@boss/);
    expect(body).not.toMatch(/closes acme\/web#9/);
    expect(body).toContain('Closes acme/web#4');
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

describe('the patch routes', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = Fastify();
    routes.registerStoryBuildBuildRoutes(app, ctx);
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
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

  it('the removed checks preview and retry routes are not mounted', async () => {
    const s = await readySession();
    expect((await app.inject({ method: 'GET', url: `/api/story-builds/${s.id}/repos/${s.web}/checks`, headers: as(1) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/story-builds/${s.id}/repos/${s.web}/retry`, headers: as(1), payload: {} })).statusCode).toBe(404);
  });
});

describe('the rename after BRANCH_EXISTS', () => {
  it('stores the code beside the sentence; a push with a new name lands there and records it', async () => {
    const s = await readySession();
    G.fail = { code: 'BRANCH_EXISTS', message: 'branch exists' };
    await push.pushRepo(ctx, { accountId: 1, buildId: s.id, repoId: s.api, draft: true });
    expect(await P.getStoryBuildRepoRow(ctx, 1, s.id, s.api)).toMatchObject({ status: 'ready', pushErrorCode: 'BRANCH_EXISTS', branch: 'acme-214-refunds-api' });
    G.fail = null;
    const r = await push.pushRepo(ctx, { accountId: 1, buildId: s.id, repoId: s.api, draft: true, branch: 'acme-214-refunds-api-v2' });
    expect(r).toMatchObject({ outcome: 'pushed', code: null });
    expect(G.pushes.map((p) => p.branch)).toEqual(['acme-214-refunds-api', 'acme-214-refunds-api-v2']);
    // The same protected list as ever: the new name is judged by assertPushTarget like any other.
    expect(G.pushes[1].protect).toEqual(['main']);
    expect(G.pushes[1].limnRun.origin).toBe('reader_pressed');
    expect(await P.getStoryBuildRepoRow(ctx, 1, s.id, s.api)).toMatchObject({
      status: 'pushed',
      branch: 'acme-214-refunds-api-v2',
      pushedBranch: 'acme-214-refunds-api-v2',
      pushError: null,
      pushErrorCode: null,
    });
    const wire = P.toStoryBuild((await P.getStoryBuildRow(ctx, 1, s.id))!, await P.listStoryBuildRepoRows(ctx, 1, s.id), { repoNames: new Map(), sessionBudgetUsd: 1 } as any);
    expect(wire.repos.find((x) => x.repoId === s.api)).toMatchObject({ branch: 'acme-214-refunds-api-v2', pushErrorCode: null });
    expect(wire).toMatchObject({ autoPush: false, autoPushAt: null, autoPushError: null });
  });

  it('a rename the host refuses (PUSH_DENIED) keeps the stored BRANCH_EXISTS, so the field stays', async () => {
    const s = await readySession();
    G.fail = { code: 'BRANCH_EXISTS', message: 'exists' };
    await push.pushRepo(ctx, { accountId: 1, buildId: s.id, repoId: s.api, draft: true });
    G.fail = { code: 'PUSH_DENIED', message: 'Limn never pushes to main.' };
    const r = await push.pushRepo(ctx, { accountId: 1, buildId: s.id, repoId: s.api, draft: true, branch: 'main' });
    expect(r).toMatchObject({ outcome: 'failed', code: 'PUSH_DENIED' });
    expect(G.pushes[1].branch).toBe('main');
    expect(await P.getStoryBuildRepoRow(ctx, 1, s.id, s.api)).toMatchObject({
      branch: 'acme-214-refunds-api',
      pushErrorCode: 'BRANCH_EXISTS',
      pushError: 'Limn never pushes to main.',
    });
  });

  it('a rename git refuses is answered before any lookup or push, and never recorded', async () => {
    const s = await readySession();
    const before = await P.getStoryBuildRepoRow(ctx, 1, s.id, s.api);
    const r = await push.pushRepo(ctx, { accountId: 1, buildId: s.id, repoId: s.api, draft: true, branch: 'bad..name' });
    expect(r).toMatchObject({ outcome: 'failed', code: 'PUSH_DENIED' });
    expect(G.pushes).toHaveLength(0);
    const after = await P.getStoryBuildRepoRow(ctx, 1, s.id, s.api);
    expect(after).toMatchObject({ pushError: before!.pushError ?? null, pushErrorCode: before!.pushErrorCode ?? null });
  });

  it('the routes: `branch` reaches the one-repository push; a non-name is 400; Push all refuses it', async () => {
    const app = Fastify();
    routes.registerStoryBuildBuildRoutes(app, ctx);
    await app.ready();
    try {
      const s = await readySession();
      const url = storyBuildPath('repoPush', { id: s.id, repoId: s.api });
      for (const branch of [42, '', '   ', 'x'.repeat(121)]) {
        expect((await app.inject({ method: 'POST', url, headers: { 'x-account': '1' }, payload: { branch } })).statusCode, String(branch)).toBe(400);
      }
      const all = await app.inject({ method: 'POST', url: storyBuildPath('pushAll', { id: s.id }), headers: { 'x-account': '1' }, payload: { branch: 'x' } });
      expect(all.statusCode).toBe(400);
      expect(G.pushes).toEqual([]);
      const ok = await app.inject({ method: 'POST', url, headers: { 'x-account': '1' }, payload: { branch: '  limn/acme-214-v2 ' } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().results[0]).toMatchObject({ outcome: 'pushed' });
      expect(G.pushes[0].branch).toBe('limn/acme-214-v2');
      // Another account: 404 before anything.
      expect((await app.inject({ method: 'POST', url, headers: { 'x-account': '2' }, payload: { branch: 'y' } })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe('the automatic push', () => {
  const on = async (id: number) => P.updateStoryBuild(ctx, 1, id, { autoPush: true });

  it('pushes every ready repository ONCE, ready for review (draft:false), as an automatic run', async () => {
    const s = await readySession();
    await on(s.id);
    const d = await auto.maybeAutoPushBuild(ctx, { accountId: 1, buildId: s.id });
    expect(d).toEqual({ status: 'pushed', opened: 2 });
    expect(G.pushes.map((p) => [p.name, p.draft, p.limnRun.origin])).toEqual([
      ['api', false, 'auto'],
      ['web', false, 'auto'],
    ]);
    const row = (await P.getStoryBuildRow(ctx, 1, s.id))!;
    expect(row.autoPushClaimedAt).toBeInstanceOf(Date);
    expect(row.autoPushError).toBeNull();
    // Never twice: a later build turn (or anything else) finds the claim.
    expect(await auto.maybeAutoPushBuild(ctx, { accountId: 1, buildId: s.id })).toEqual({ status: 'skipped', reason: 'claimed' });
    expect(G.pushes).toHaveLength(2);
  });

  it('does nothing while the option is off, and nothing when it is switched off before the claim', async () => {
    const s = await readySession();
    expect(await auto.maybeAutoPushBuild(ctx, { accountId: 1, buildId: s.id })).toEqual({ status: 'skipped', reason: 'off' });
    await on(s.id);
    // The reader unticks it between the gate's read and the claim: the claim re-checks it.
    const d = await auto.maybeAutoPushBuild(ctx, { accountId: 1, buildId: s.id }, {
      isPlannedBuild: async () => {
        await auto.setStoryBuildAutoPush(ctx, 1, s.id, false);
        return false;
      },
      pushAll: async () => {
        throw new Error('must not push');
      },
      pushStack: async () => {
        throw new Error('must not push');
      },
    });
    expect(d).toEqual({ status: 'skipped', reason: 'off' });
    expect(G.pushes).toEqual([]);
    expect((await P.getStoryBuildRow(ctx, 1, s.id))!.autoPushClaimedAt).toBeNull();
  });

  it('waits for a settled build, and leaves nothing to do after a person pushed', async () => {
    const s = await readySession();
    await on(s.id);
    await P.updateStoryBuild(ctx, 1, s.id, { status: 'building' });
    expect(await auto.maybeAutoPushBuild(ctx, { accountId: 1, buildId: s.id })).toEqual({ status: 'skipped', reason: 'not_ready' });
    await P.updateStoryBuild(ctx, 1, s.id, { status: 'ready' });
    await push.pushAllRepos(ctx, { accountId: 1, buildId: s.id, draft: true });
    expect(await auto.maybeAutoPushBuild(ctx, { accountId: 1, buildId: s.id })).toEqual({ status: 'skipped', reason: 'nothing' });
    expect(G.pushes.map((p) => p.limnRun.origin)).toEqual(['reader_pressed', 'reader_pressed']);
    expect((await P.getStoryBuildRow(ctx, 1, s.id))!.autoPushClaimedAt).toBeNull();
  });

  it('a failure (BRANCH_EXISTS) is recorded on the build and the repository, and never retried', async () => {
    const s = await readySession({ only: 'api' });
    await on(s.id);
    G.fail = { code: 'BRANCH_EXISTS', message: 'branch exists' };
    const d = await auto.maybeAutoPushBuild(ctx, { accountId: 1, buildId: s.id });
    const sentence = 'A branch named acme-214-refunds-api already exists on acme/api. Pick another branch name.';
    expect(d).toEqual({ status: 'failed', message: sentence });
    expect((await P.getStoryBuildRow(ctx, 1, s.id))!.autoPushError).toBe(sentence);
    expect(await P.getStoryBuildRepoRow(ctx, 1, s.id, s.api)).toMatchObject({ status: 'ready', pushError: sentence, pushErrorCode: 'BRANCH_EXISTS' });
    G.fail = null;
    expect(await auto.maybeAutoPushBuild(ctx, { accountId: 1, buildId: s.id })).toEqual({ status: 'skipped', reason: 'claimed' });
    expect(G.pushes).toHaveLength(1);
    // The reader recovers by hand with a new name (Part A).
    expect(await push.pushRepo(ctx, { accountId: 1, buildId: s.id, repoId: s.api, draft: false, branch: 'acme-214-refunds-api-v2' })).toMatchObject({ outcome: 'pushed' });
  });

  it('a thrown push after the claim is recorded, never thrown', async () => {
    const s = await readySession();
    await on(s.id);
    const d = await auto.maybeAutoPushBuild(ctx, { accountId: 1, buildId: s.id }, {
      isPlannedBuild: async () => false,
      pushAll: async () => {
        throw new Error('the network went away');
      },
      pushStack: async () => [],
    });
    expect(d).toEqual({ status: 'failed', message: 'the network went away' });
    expect((await P.getStoryBuildRow(ctx, 1, s.id))!.autoPushError).toBe('the network went away');
  });

  it('a concurrent manual press is safe: one PR per repository, and no failure', async () => {
    const s = await readySession();
    await on(s.id);
    const [d, manual] = await Promise.all([
      auto.maybeAutoPushBuild(ctx, { accountId: 1, buildId: s.id }),
      push.pushAllRepos(ctx, { accountId: 1, buildId: s.id, draft: true }),
    ]);
    expect(G.pushes.map((p) => p.name).sort()).toEqual(['api', 'web']);
    expect(manual!.every((r) => r.outcome !== 'failed')).toBe(true);
    // Either the automatic push pushed something, or the press held every item and that is said.
    const err = (await P.getStoryBuildRow(ctx, 1, s.id))!.autoPushError;
    if (d.status === 'pushed') expect(err).toBeNull();
    else expect(err).toBe(auto.AUTO_PUSH_TAKEN_OVER);
    const rows = await P.listStoryBuildRepoRows(ctx, 1, s.id);
    expect(rows.map((r) => r.status)).toEqual(['pushed', 'pushed']);
  });

  it('nothing pushed because the press held every item: recorded, so the tab leaves "Pushing…"', async () => {
    const s = await readySession();
    await on(s.id);
    const d = await auto.maybeAutoPushBuild(ctx, { accountId: 1, buildId: s.id }, {
      isPlannedBuild: async () => false,
      pushAll: async () => [{ outcome: 'skipped', code: 'PUSH_IN_PROGRESS', error: 'This repository is being pushed.' }],
      pushStack: async () => [],
    });
    expect(d).toEqual({ status: 'failed', message: auto.AUTO_PUSH_TAKEN_OVER });
    expect((await P.getStoryBuildRow(ctx, 1, s.id))!.autoPushError).toBe(auto.AUTO_PUSH_TAKEN_OVER);
  });

  it('is held in-process from the first tick (a message cannot start a turn), and released after', async () => {
    const s = await readySession();
    await on(s.id);
    const p = auto.maybeAutoPushBuild(ctx, { accountId: 1, buildId: s.id });
    expect(auto.isStoryBuildAutoPushing(s.id)).toBe(true);
    // A second call while it runs is not a second push.
    expect(await auto.maybeAutoPushBuild(ctx, { accountId: 1, buildId: s.id })).toEqual({ status: 'skipped', reason: 'claimed' });
    await p;
    expect(auto.isStoryBuildAutoPushing(s.id)).toBe(false);
    expect(G.pushes).toHaveLength(2);
  });

  it('the claim fails when a turn started (status no longer ready), so the one push is not burned', async () => {
    const s = await readySession();
    await on(s.id);
    const d = await auto.maybeAutoPushBuild(ctx, { accountId: 1, buildId: s.id }, {
      isPlannedBuild: async () => {
        await P.updateStoryBuild(ctx, 1, s.id, { status: 'building' });
        return false;
      },
      pushAll: async () => {
        throw new Error('must not push');
      },
      pushStack: async () => [],
    });
    expect(d).toEqual({ status: 'skipped', reason: 'not_ready' });
    expect((await P.getStoryBuildRow(ctx, 1, s.id))!.autoPushClaimedAt).toBeNull();
  });

  it('boot: a claim a restart cut off is recorded (never a push); a pushed or answered one is left alone', async () => {
    const cut = await readySession({ only: 'api' });
    await on(cut.id);
    expect(await auto.claimStoryBuildAutoPush(ctx, 1, cut.id)).toBe(true);
    expect(await auto.reconcileStoryAutoPushOnStartup(ctx)).toBe(1);
    expect((await P.getStoryBuildRow(ctx, 1, cut.id))!.autoPushError).toBe(auto.AUTO_PUSH_INTERRUPTED);
    expect(G.pushes).toEqual([]);
    expect(await auto.reconcileStoryAutoPushOnStartup(ctx)).toBe(0);
  });

  it('the switch (`…/auto-push`): on and off until the build pushed, then 409; 400 / 404 otherwise', async () => {
    const app = Fastify();
    routes.registerStoryBuildBuildRoutes(app, ctx);
    await app.ready();
    try {
      const s = await readySession();
      const url = storyBuildPath('autoPush', { id: s.id });
      const h = { 'x-account': '1' };
      expect((await app.inject({ method: 'POST', url, headers: h, payload: { on: 'yes' } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url, headers: h, payload: {} })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url, headers: { 'x-account': '2' }, payload: { on: true } })).statusCode).toBe(404);
      const r = await app.inject({ method: 'POST', url, headers: h, payload: { on: true } });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ autoPush: true });
      expect((await P.getStoryBuildRow(ctx, 1, s.id))!.autoPush).toBe(true);
      expect((await app.inject({ method: 'POST', url, headers: h, payload: { on: false } })).json()).toEqual({ autoPush: false });
      await push.pushRepo(ctx, { accountId: 1, buildId: s.id, repoId: s.api, draft: true });
      const late = await app.inject({ method: 'POST', url, headers: h, payload: { on: true } });
      expect(late.statusCode).toBe(409);
      expect(late.json().error).toBe('NotReady');
    } finally {
      await app.close();
    }
  });
});
