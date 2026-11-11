// PUSHING A PLANNED STACK (push-stack.ts, routes-build.ts) over the REAL core client (a scratch SQLite,
// migrations applied) with REAL GIT standing in for GitHub: `applyAndPushBranch` (git-ops.ts) is replaced
// by the same steps on local repositories — a worktree of a local "clone cache" at the base commit, the
// stored patch applied, ONE commit, the tree checked against `expectTree`, a push to a LOCAL BARE
// repository ("GitHub"), a recorded PR. Pinned:
//   • Push all in plan order; PR 2's base is PR 1's pushed branch AT its pushed commit (the bare repo's
//     PR 2 commit has PR 1's pushed commit as its parent), each tree the verified tip's;
//   • titles `KEY (n/m): title`; the body: the Part list (this PR marked, earlier PRs linked), "Builds
//     on #n", Covers from the approved plan, the reader's decisions, model text defanged; draft by default;
//   • STACK_PREVIOUS_NOT_PUSHED, DEPENDS_ON_NOT_PUSHED, STACK_PREVIOUS_CLOSED, TREE_MISMATCH (nothing
//     pushed); Push all after a failure stops that repository, skips what depends on it, and goes on
//     with another repository;
//   • the first PR still stacks on the reader's own open PR and refuses one from a fork;
//   • the repository row becomes pushed once its every planned PR is; the routes: tenancy 404s, `prs`.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildPlanRevision } from '@pierre-review/shared';

const DB_PATH = `${process.env.DATABASE_URL ?? `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-storybuild`}.push-stack.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
const G = vi.hoisted(() => ({
  root: '',
  pushes: [] as any[],
  prs: [] as any[],
  failBranch: null as null | string,
  nextPr: 200,
  forks: new Set<number>(),
  links: [] as any[],
}));

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@a', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@a' };
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', maxBuffer: 64 << 20 }).trim();

vi.mock('../git-ops.js', () => ({
  // The real steps of `applyAndPushBranch` on local repositories (see the header).
  applyAndPushBranch: async (a: any) => {
    G.pushes.push(a);
    const { execFileSync: x } = await import('node:child_process');
    const { join: j } = await import('node:path');
    const { writeFileSync: w } = await import('node:fs');
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Uma', GIT_AUTHOR_EMAIL: 'u1@users.noreply.github.com', GIT_COMMITTER_NAME: 'Uma', GIT_COMMITTER_EMAIL: 'u1@users.noreply.github.com' };
    const g = (cwd: string, ...args: string[]): string => x('git', args, { cwd, env, encoding: 'utf8' }).trim();
    if (a.protect.includes(a.branch)) throw Object.assign(new Error('protected'), { code: 'PUSH_DENIED' });
    const cache = j(G.root, `cache-${a.name}`);
    const bare = j(G.root, `bare-${a.name}.git`);
    if (x('git', ['ls-remote', '--heads', bare, a.branch], { env, encoding: 'utf8' }).trim() !== '') throw Object.assign(new Error('exists'), { code: 'BRANCH_EXISTS' });
    const wt = j(G.root, `wt-${G.pushes.length}`);
    g(cache, 'worktree', 'add', '-q', '--detach', wt, a.baseSha);
    try {
      const patchFile = j(G.root, `p-${G.pushes.length}.patch`);
      w(patchFile, a.patch);
      try {
        g(wt, 'apply', '--3way', patchFile);
      } catch (e) {
        throw Object.assign(new Error(`patch did not apply cleanly: ${String(e)}`), { code: 'APPLY_FAILED' });
      }
      g(wt, 'add', '-A');
      g(wt, 'commit', '-q', '--no-verify', '-m', a.commitMessage);
      if (a.expectTree != null && g(wt, 'rev-parse', 'HEAD^{tree}') !== a.expectTree) {
        throw Object.assign(new Error("Limn's copy of the earlier pull request does not match. Push it again from Limn."), { code: 'TREE_MISMATCH' });
      }
      if (G.failBranch === `${a.name}:${a.branch}`) throw Object.assign(new Error('the push was refused'), { code: 'PUSH_DENIED' });
      const commitSha = g(wt, 'rev-parse', 'HEAD');
      g(wt, 'push', '-q', bare, `HEAD:refs/heads/${a.branch}`);
      const n = G.nextPr++;
      G.prs.push({ number: n, head: a.branch, base: a.prBase, title: a.title, body: a.body, draft: a.draft, repo: a.name });
      await a.afterSync?.(n);
      return { pushedBranch: a.branch, commitSha, prNumber: n, prUrl: `https://github.com/acme/${a.name}/pull/${n}` };
    } finally {
      g(cache, 'worktree', 'remove', '--force', wt);
    }
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
  repoCloneDir: () => '/nonexistent',
  withRepoLock: async (_k: string, fn: () => Promise<unknown>) => fn(),
}));

let db: any;
let schema: any;
let ctx: any;
let closeDb: (() => Promise<void> | void) | undefined;
let P: typeof import('./persist.js');
let PP: typeof import('./plan-persist.js');
let S: typeof import('./push-stack.js');
let routes: typeof import('./routes-build.js');
const repo: Record<number, { api: number; web: number }> = {};
const ws: Record<number, number> = {};
const IDENT = 'jira:https://acme.atlassian.net#ACME-214';
const KEY = 'ACME-214';
const BRANCH = 'limn/acme-214';
/** Per repository name: the base commit (in the cache and the bare repo). */
const BASE: Record<string, string> = {};
let ident = 0;

/** A local "GitHub" (bare) and a clone cache per repository, both at one base commit. */
function setUpRepos(): void {
  for (const name of ['api', 'web']) {
    const seed = join(G.root, `seed-${name}`);
    execFileSync('git', ['init', '-q', '-b', 'main', seed], { env: ENV });
    writeFileSync(join(seed, 'a.txt'), 'one\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-qm', 'base');
    BASE[name] = git(seed, 'rev-parse', 'HEAD');
    execFileSync('git', ['clone', '-q', '--bare', seed, join(G.root, `bare-${name}.git`)], { env: ENV });
    execFileSync('git', ['clone', '-q', join(G.root, `bare-${name}.git`), join(G.root, `cache-${name}`)], { env: ENV });
  }
}

/** What the sandbox would hand out: commits on top of the base, in a scratch clone; patches + trees. */
function stackOf(name: string, files: Array<Record<string, string>>): Array<{ patch: string; tree: string }> {
  const box = join(G.root, `box-${name}-${++ident}`);
  execFileSync('git', ['clone', '-q', join(G.root, `cache-${name}`), box], { env: ENV });
  const out: Array<{ patch: string; tree: string }> = [];
  let prev = BASE[name]!;
  for (const [i, f] of files.entries()) {
    for (const [p, t] of Object.entries(f)) writeFileSync(join(box, p), t);
    git(box, 'add', '-A');
    git(box, 'commit', '-qm', `part ${i + 1}`);
    const tip = git(box, 'rev-parse', 'HEAD');
    out.push({ patch: `${git(box, 'diff', '--binary', '--no-renames', prev, tip)}\n`, tree: git(box, 'rev-parse', `${tip}^{tree}`) });
    prev = tip;
  }
  return out;
}

beforeAll(async () => {
  G.root = mkdtempSync(join(tmpdir(), 'limn-push-stack-'));
  setUpRepos();
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
      fetchPrHeadInfo: async (_a: number, _o: string, _n: string, number: number) => ({ isFork: G.forks.has(number), headSha: 'h', headRef: 'r', headRepoFullName: 'acme/api', maintainerCanModify: false, baseRef: 'main' }),
    },
  };
  P = await import('./persist.js');
  PP = await import('./plan-persist.js');
  S = await import('./push-stack.js');
  routes = await import('./routes-build.js');
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  rmSync(G.root, { recursive: true, force: true });
});

beforeEach(() => {
  G.pushes.length = 0;
  G.prs.length = 0;
  G.links.length = 0;
  G.failBranch = null;
  G.forks.clear();
});

type StackSpec = { key: string; repo: 'api' | 'web'; k: number; title: string; criteria: string[]; dependsOn: string[] };

/** An approved, built session: the plan (with two decided points), the planned PR rows filled from real commits. */
async function builtStack(specs: StackSpec[], o: { stackedOnPrId?: number | null; branchSuffix?: string } = {}): Promise<{ id: number; prs: Map<string, number> }> {
  const { api, web } = repo[1]!;
  const idOf = (r: 'api' | 'web'): number => (r === 'api' ? api : web);
  for (const r of await P.listStoryBuildRowsFor(ctx, 1, ws[1]!, IDENT)) if (r.status !== 'discarded') await P.updateStoryBuild(ctx, 1, r.id, { status: 'discarded' });
  const started = await P.insertStoryBuild(ctx, { accountId: 1, workspaceId: ws[1]!, ident: IDENT, ticketKey: KEY, ticketTitle: 'Refunds by card', wantDiagram: false, wantDocs: false, provider: 'claude', model: 'claude-sonnet-5' });
  const id = started.id;
  await P.updateStoryBuild(ctx, 1, id, {
    status: 'ready',
    sessionPhase: 'built',
    seedJson: { version: 1, story: { key: KEY, title: 'Refunds by card', text: 't', url: 'https://acme.atlassian.net/browse/ACME-214' }, criteria: [], comments: null, cards: [] },
  });
  const sfx = o.branchSuffix ?? `-${id}`;
  const branchOf = (s: StackSpec): string => `${BRANCH}${sfx}${s.k > 1 ? `-${s.k}` : ''}`;
  for (const [i, r] of (['api', 'web'] as const).entries()) {
    await P.upsertStoryBuildRepo(ctx, { accountId: 1, buildId: id, repoId: idOf(r), ref: `R${i + 1}`, buildOrder: i, include: true, status: 'ready', baseRef: 'main', baseSha: BASE[r]!, stackedOnPrId: r === 'api' ? (o.stackedOnPrId ?? null) : null, branch: `${BRANCH}${sfx}` });
  }
  const plan: Omit<BuildPlanRevision, 'revision' | 'createdAt' | 'source'> = {
    summary: 'Refund by card.',
    repos: [],
    criteria: [
      { ref: 'AC1', text: 'An API refunds a payment', status: 'planned', how: 'An endpoint.', prs: ['P1'], openPoints: [] },
      { ref: 'AC2', text: 'Refunds are logged', status: 'planned', how: 'A log line.', prs: ['P2'], openPoints: [] },
      { ref: 'AC3', text: 'Support sees a refund button', status: 'planned', how: 'A button.', prs: ['P3'], openPoints: [] },
    ],
    contentions: [
      { id: 'C1', fingerprint: 'f1', about: ['AC1'], storySays: 'x', problem: 'The story says refunds are instant; the code queues them.', proposal: 'Queue refunds, as the code does.', ifKept: 'Make them instant.', evidence: [] },
      { id: 'C2', fingerprint: 'f2', about: ['AC3'], storySays: 'y', problem: 'The button needs a role @support does not have.', proposal: 'Add the role.', ifKept: 'Keep the role as it is.', evidence: [] },
    ],
    stack: specs.map((s) => ({ key: s.key, repoId: idOf(s.repo), fullName: `acme/${s.repo}`, stackIndex: s.k, title: s.title, contains: 'Work.', criteria: s.criteria, dependsOn: s.dependsOn, branch: branchOf(s) })),
    stackReason: 'Smaller reviews.',
    ticketUpdate: null,
    dropped: { contentions: 0, evidence: 0, reasons: [] },
  };
  const row = await PP.insertPlanRevision(ctx, { accountId: 1, buildId: id, source: 'opening', plan, rawSha: `r${id}`, now: new Date() });
  await PP.setPlanDecision(ctx, 1, row.id, 'C1', { decision: 'agree', fingerprint: 'f1', at: 'now' });
  await PP.setPlanDecision(ctx, 1, row.id, 'C2', { decision: 'keep_story', fingerprint: 'f2', at: 'now' });
  expect(await PP.approvePlanRevision(ctx, { accountId: 1, buildId: id, plan: (await PP.latestPlanRow(ctx, 1, id))!, now: new Date() })).toBe(true);
  // The verified commits, as stack-verify.ts would store them.
  const prs = new Map<string, number>();
  const rows = await PP.listPlannedPrRows(ctx, 1, id);
  for (const r of ['api', 'web'] as const) {
    const mine = specs.filter((s) => s.repo === r).sort((a, b) => a.k - b.k);
    if (mine.length === 0) continue;
    const commits = stackOf(r, mine.map((s) => ({ [`${s.key.toLowerCase()}.txt`]: `${s.key} @someone fixes #3\n` })));
    for (const [i, s] of mine.entries()) {
      const pr = rows.find((x) => x.prKey === s.key)!;
      prs.set(s.key, pr.id);
      await PP.updateStoryBuildPr(ctx, 1, pr.id, { status: 'ready', patch: commits[i]!.patch, treeSha: commits[i]!.tree, commitMessage: `${s.key}: part`, summary: `Did ${s.key}. Thanks @someone, fixes #3.` });
    }
  }
  return { id, prs };
}

const THREE: StackSpec[] = [
  { key: 'P1', repo: 'api', k: 1, title: 'Refund endpoint', criteria: ['AC1'], dependsOn: [] },
  { key: 'P2', repo: 'api', k: 2, title: 'Log refunds', criteria: ['AC2'], dependsOn: ['P1'] },
  { key: 'P3', repo: 'web', k: 1, title: 'Refund button', criteria: ['AC3'], dependsOn: ['P1'] },
];

describe('Push all of a stack', () => {
  it('pushes in plan order; PR 2 is stacked on PR 1 at its pushed commit; the bodies tell the stack', async () => {
    const s = await builtStack(THREE);
    const out = (await S.pushPlannedStack(ctx, { accountId: 1, buildId: s.id, draft: true }))!;
    expect(out.map((r) => [r.key, r.outcome])).toEqual([
      ['P1', 'pushed'],
      ['P2', 'pushed'],
      ['P3', 'pushed'],
    ]);
    const [p1, p2, p3] = G.pushes;
    expect(p1).toMatchObject({ branch: `${BRANCH}-${s.id}`, prBase: 'main', baseSha: BASE.api, draft: true });
    // PR 2: based on PR 1's pushed branch at PR 1's pushed commit.
    const p1Row = (await PP.getStoryBuildPrRow(ctx, 1, s.id, s.prs.get('P1')!))!;
    expect(p2).toMatchObject({ branch: `${BRANCH}-${s.id}-2`, prBase: `${BRANCH}-${s.id}`, baseRef: `${BRANCH}-${s.id}`, baseSha: p1Row.pushedCommitSha });
    expect(p2.protect).toEqual(expect.arrayContaining(['main', `${BRANCH}-${s.id}`]));
    expect(p3).toMatchObject({ prBase: 'main', baseSha: BASE.web });
    // On "GitHub" (the bare repo): PR 2's commit sits on PR 1's, each with the verified tree.
    const bare = join(G.root, 'bare-api.git');
    expect(git(bare, 'rev-parse', `refs/heads/${BRANCH}-${s.id}-2^`)).toBe(p1Row.pushedCommitSha);
    expect(git(bare, 'rev-parse', `refs/heads/${BRANCH}-${s.id}-2^{tree}`)).toBe((await PP.getStoryBuildPrRow(ctx, 1, s.id, s.prs.get('P2')!))!.treeSha);
    // Titles and bodies.
    expect(G.prs.map((p) => p.title)).toEqual(['ACME-214 (1/3): Refund endpoint', 'ACME-214 (2/3): Log refunds', 'ACME-214 (3/3): Refund button']);
    const body2: string = G.prs[1].body;
    expect(body2).toContain('**Part 2 of 3:**');
    expect(body2).toContain(`1. [acme/api — Refund endpoint](https://github.com/acme/api/pull/${G.prs[0].number}) (#${G.prs[0].number})`);
    expect(body2).toContain('2. acme/api — Log refunds (this pull request)');
    expect(body2).toContain('3. acme/web — Refund button');
    expect(body2).toContain(`Builds on #${G.prs[0].number}.`);
    expect(body2).toContain('**Covers:**\n- AC2: Refunds are logged');
    expect(G.prs[0].body).toContain('**Decisions on the story:**\n- Changed from the story: Queue refunds, as the code does.');
    expect(G.prs[2].body).toContain('- Kept the story: The button needs a role @​support does not have.');
    expect(G.prs[0].body).not.toContain('Kept the story');
    // Model text is defanged on GitHub.
    expect(body2).toContain('Thanks @​someone, f​ixes #3.');
    // Rows and the repository rows.
    const rows = await PP.listPlannedPrRows(ctx, 1, s.id);
    expect(rows.map((r) => r.status)).toEqual(['pushed', 'pushed', 'pushed']);
    expect((await P.listStoryBuildRepoRows(ctx, 1, s.id)).map((r) => r.status)).toEqual(['pushed', 'pushed']);
    // Each PR is linked to the ticket by hand once it syncs (the link itself is push-db.test.ts's).
    expect(G.pushes.every((p) => typeof p.afterSync === 'function')).toBe(true);
    // Again: nothing left.
    const again = (await S.pushPlannedStack(ctx, { accountId: 1, buildId: s.id, draft: true }))!;
    expect(again.every((r) => r.code === 'ALREADY_PUSHED')).toBe(true);
    expect(G.pushes).toHaveLength(3);
  });

  it('a failure stops its repository and what depends on it; another repository goes on', async () => {
    const specs: StackSpec[] = [THREE[0]!, THREE[1]!, { ...THREE[2]!, dependsOn: [] }];
    const s = await builtStack(specs);
    G.failBranch = `api:${BRANCH}-${s.id}`;
    const out = (await S.pushPlannedStack(ctx, { accountId: 1, buildId: s.id, draft: true }))!;
    expect(out.map((r) => [r.key, r.outcome, r.code])).toEqual([
      ['P1', 'failed', 'PUSH_DENIED'],
      ['P2', 'skipped', 'STACK_BELOW_FAILED'],
      ['P3', 'pushed', null],
    ]);
    // Push all again: P1 is retried (the failure kept its patch), P2 follows it.
    G.failBranch = null;
    const again = (await S.pushPlannedStack(ctx, { accountId: 1, buildId: s.id, draft: true }))!;
    expect(again.map((r) => [r.key, r.outcome])).toEqual([
      ['P1', 'pushed'],
      ['P2', 'pushed'],
      ['P3', 'skipped'],
    ]);
  });

  it('a PR depending on a failed one in another repository is skipped', async () => {
    const s = await builtStack(THREE);
    G.failBranch = `api:${BRANCH}-${s.id}`;
    const out = (await S.pushPlannedStack(ctx, { accountId: 1, buildId: s.id, draft: true }))!;
    expect(out.find((r) => r.key === 'P3')).toMatchObject({ outcome: 'skipped', code: 'DEPENDS_ON_NOT_PUSHED' });
  });
});

describe('one planned PR', () => {
  it('refuses PR 2 before PR 1, and a cross-repository dependency not pushed', async () => {
    const s = await builtStack(THREE);
    expect(await S.pushPlannedPr(ctx, { accountId: 1, buildId: s.id, prId: s.prs.get('P2')!, draft: true })).toMatchObject({
      outcome: 'failed',
      code: 'STACK_PREVIOUS_NOT_PUSHED',
      error: 'Push P1 (Refund endpoint) first.',
    });
    expect(await S.pushPlannedPr(ctx, { accountId: 1, buildId: s.id, prId: s.prs.get('P3')!, draft: true })).toMatchObject({
      outcome: 'failed',
      code: 'DEPENDS_ON_NOT_PUSHED',
      error: "Push acme/api's P1 (Refund endpoint) first.",
    });
    expect(G.pushes).toHaveLength(0);
  });

  it('TREE_MISMATCH: a tree that is not the verified one is refused before the push', async () => {
    const s = await builtStack(THREE.slice(0, 1));
    await PP.updateStoryBuildPr(ctx, 1, s.prs.get('P1')!, { treeSha: '0'.repeat(40) });
    const r = await S.pushPlannedPr(ctx, { accountId: 1, buildId: s.id, prId: s.prs.get('P1')!, draft: true });
    expect(r).toMatchObject({ outcome: 'failed', code: 'TREE_MISMATCH' });
    expect(execFileSync('git', ['ls-remote', '--heads', join(G.root, 'bare-api.git'), `${BRANCH}-${s.id}`], { env: ENV, encoding: 'utf8' }).trim()).toBe('');
    expect((await PP.getStoryBuildPrRow(ctx, 1, s.id, s.prs.get('P1')!))!.pushError).toMatch(/does not match/);
  });

  it('PR 1 merged before PR 2 is pushed: STACK_PREVIOUS_CLOSED', async () => {
    const s = await builtStack(THREE.slice(0, 2));
    const first = await S.pushPlannedPr(ctx, { accountId: 1, buildId: s.id, prId: s.prs.get('P1')!, draft: true });
    expect(first.outcome).toBe('pushed');
    await db.insert(schema.pullRequests).values({ accountId: 1, repoId: repo[1]!.api, githubNodeId: `PRm${s.id}`, number: first.prNumber, title: 'x', state: 'merged', openedAt: new Date(), updatedAt: new Date() }).execute();
    const r = await S.pushPlannedPr(ctx, { accountId: 1, buildId: s.id, prId: s.prs.get('P2')!, draft: true });
    expect(r).toMatchObject({ outcome: 'failed', code: 'STACK_PREVIOUS_CLOSED' });
    expect(r.error).toContain(`Pull request #${first.prNumber} (P1) is merged`);
  });

  it('a one-PR plan keeps today\'s title', async () => {
    const s = await builtStack(THREE.slice(0, 1));
    await S.pushPlannedPr(ctx, { accountId: 1, buildId: s.id, prId: s.prs.get('P1')!, draft: false });
    expect(G.prs[0]).toMatchObject({ title: 'ACME-214: Refunds by card', draft: false });
    expect(G.prs[0].body).not.toContain('**Part');
  });

  it('the first PR still stacks on the reader\'s own open PR, and refuses one from a fork', async () => {
    const [mine] = await db
      .insert(schema.pullRequests)
      .values({ accountId: 1, repoId: repo[1]!.api, githubNodeId: 'PRmine', number: 31, title: 'mine', state: 'open', headRefName: 'main', openedAt: new Date(), updatedAt: new Date() })
      .returning()
      .execute();
    const s = await builtStack(THREE.slice(0, 2), { stackedOnPrId: mine.id });
    const r = await S.pushPlannedPr(ctx, { accountId: 1, buildId: s.id, prId: s.prs.get('P1')!, draft: true });
    expect(r.outcome).toBe('pushed');
    expect(G.prs[0].body).toContain('Stacked on #31.');
    G.forks.add(31);
    const s2 = await builtStack(THREE.slice(0, 1), { stackedOnPrId: mine.id });
    expect(await S.pushPlannedPr(ctx, { accountId: 1, buildId: s2.id, prId: s2.prs.get('P1')!, draft: true })).toMatchObject({ outcome: 'failed', code: 'STACK_FORK' });
  });
});

describe('the routes', () => {
  it('PR diff and push: the owner gets the PR; another account gets 404; Push all answers `prs`', async () => {
    const s = await builtStack(THREE.slice(0, 2));
    const app = Fastify({ logger: false });
    routes.registerStoryBuildBuildRoutes(app, ctx);
    await app.ready();
    const p1 = s.prs.get('P1')!;
    const diff = await app.inject({ method: 'GET', url: `/api/story-builds/${s.id}/prs/${p1}/diff` });
    expect(diff.statusCode).toBe(200);
    expect(diff.json()).toMatchObject({ prId: p1, key: 'P1', repoId: repo[1]!.api });
    expect(diff.json().patch).toContain('+P1');
    for (const [method, url] of [
      ['GET', `/api/story-builds/${s.id}/prs/${p1}/diff`],
      ['POST', `/api/story-builds/${s.id}/prs/${p1}/push`],
    ] as const) {
      expect((await app.inject({ method, url, headers: { 'x-account': '2' }, ...(method === 'POST' ? { payload: {} } : {}) })).statusCode).toBe(404);
    }
    const one = await app.inject({ method: 'POST', url: `/api/story-builds/${s.id}/prs/${p1}/push`, payload: {} });
    expect(one.json().prs[0]).toMatchObject({ key: 'P1', outcome: 'pushed' });
    const all = await app.inject({ method: 'POST', url: `/api/story-builds/${s.id}/push`, payload: { draft: true } });
    expect(all.json().prs.map((r: any) => [r.key, r.outcome])).toEqual([
      ['P1', 'skipped'],
      ['P2', 'pushed'],
    ]);
    expect(all.json().results).toEqual([expect.objectContaining({ repoId: repo[1]!.api, outcome: 'pushed' })]);
    await app.close();
  });
});

describe('the rename after BRANCH_EXISTS (a stack)', () => {
  it('PR 1 pushed under a new name: the code is stored, PR 2 stacks on the renamed branch', async () => {
    const s = await builtStack(THREE.slice(0, 2));
    const bare = join(G.root, 'bare-api.git');
    // An earlier session already pushed PR 1's branch.
    git(bare, 'update-ref', `refs/heads/${BRANCH}-${s.id}`, BASE.api!);
    const p1 = s.prs.get('P1')!;
    const refused = await S.pushPlannedPr(ctx, { accountId: 1, buildId: s.id, prId: p1, draft: true });
    expect(refused).toMatchObject({ outcome: 'failed', code: 'BRANCH_EXISTS', error: `A branch named ${BRANCH}-${s.id} already exists on acme/api. Pick another branch name.` });
    expect(await PP.getStoryBuildPrRow(ctx, 1, s.id, p1)).toMatchObject({ status: 'ready', pushErrorCode: 'BRANCH_EXISTS' });
    // A sibling's planned branch is protected: never the rename.
    expect(await S.pushPlannedPr(ctx, { accountId: 1, buildId: s.id, prId: p1, draft: true, branch: `${BRANCH}-${s.id}-2` })).toMatchObject({ outcome: 'failed', code: 'PUSH_DENIED' });
    const renamed = `${BRANCH}-${s.id}-v2`;
    const ok = await S.pushPlannedPr(ctx, { accountId: 1, buildId: s.id, prId: p1, draft: true, branch: renamed });
    expect(ok.outcome).toBe('pushed');
    expect(await PP.getStoryBuildPrRow(ctx, 1, s.id, p1)).toMatchObject({ status: 'pushed', branch: renamed, pushedBranch: renamed, pushError: null, pushErrorCode: null });
    const p2 = await S.pushPlannedPr(ctx, { accountId: 1, buildId: s.id, prId: s.prs.get('P2')!, draft: true });
    expect(p2.outcome).toBe('pushed');
    expect(G.pushes.at(-1)).toMatchObject({ branch: `${BRANCH}-${s.id}-2`, prBase: renamed, baseRef: renamed });
    expect(git(bare, 'rev-parse', `refs/heads/${BRANCH}-${s.id}-2^`)).toBe(git(bare, 'rev-parse', `refs/heads/${renamed}`));
  });

  it('the routes: `branch` on one PR reaches the push; a planned build\'s per-repository push refuses it', async () => {
    const s = await builtStack(THREE.slice(0, 1));
    const app = Fastify({ logger: false });
    routes.registerStoryBuildBuildRoutes(app, ctx);
    await app.ready();
    try {
      const repoPush = await app.inject({ method: 'POST', url: `/api/story-builds/${s.id}/repos/${repo[1]!.api}/push`, payload: { branch: 'x' } });
      expect(repoPush.statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: `/api/story-builds/${s.id}/prs/${s.prs.get('P1')!}/push`, payload: { branch: 7 } })).statusCode).toBe(400);
      const one = await app.inject({ method: 'POST', url: `/api/story-builds/${s.id}/prs/${s.prs.get('P1')!}/push`, payload: { branch: `${BRANCH}-${s.id}-v2` } });
      expect(one.json().prs[0]).toMatchObject({ outcome: 'pushed' });
      expect(G.pushes[0].branch).toBe(`${BRANCH}-${s.id}-v2`);
    } finally {
      await app.close();
    }
  });
});

describe('the automatic push of a stack', () => {
  it('pushes every planned PR once, ready for review, as an automatic run', async () => {
    const s = await builtStack(THREE);
    await P.updateStoryBuild(ctx, 1, s.id, { autoPush: true });
    const { maybeAutoPushBuild } = await import('./auto-push.js');
    expect(await maybeAutoPushBuild(ctx, { accountId: 1, buildId: s.id })).toEqual({ status: 'pushed', opened: 3 });
    expect(G.pushes.map((p) => [p.branch, p.draft, p.limnRun.origin])).toEqual([
      [`${BRANCH}-${s.id}`, false, 'auto'],
      [`${BRANCH}-${s.id}-2`, false, 'auto'],
      [`${BRANCH}-${s.id}`, false, 'auto'],
    ]);
    expect(await maybeAutoPushBuild(ctx, { accountId: 1, buildId: s.id })).toEqual({ status: 'skipped', reason: 'claimed' });
    expect(G.pushes).toHaveLength(3);
  });

  it('a failure stops its repository; the build records one sentence and the item its code', async () => {
    const s = await builtStack(THREE.slice(0, 2));
    git(join(G.root, 'bare-api.git'), 'update-ref', `refs/heads/${BRANCH}-${s.id}`, BASE.api!);
    await P.updateStoryBuild(ctx, 1, s.id, { autoPush: true });
    const { maybeAutoPushBuild } = await import('./auto-push.js');
    const d = await maybeAutoPushBuild(ctx, { accountId: 1, buildId: s.id });
    expect(d).toEqual({ status: 'failed', message: `A branch named ${BRANCH}-${s.id} already exists on acme/api. Pick another branch name.` });
    expect((await P.getStoryBuildRow(ctx, 1, s.id))!.autoPushError).toBe(d.status === 'failed' ? d.message : null);
    expect(await PP.getStoryBuildPrRow(ctx, 1, s.id, s.prs.get('P1')!)).toMatchObject({ pushErrorCode: 'BRANCH_EXISTS' });
    expect(G.pushes).toHaveLength(1);
  });
});
