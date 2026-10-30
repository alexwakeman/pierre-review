// "IMPLEMENT STORY" — THE SESSION (WP1) over the REAL core client (a scratch SQLite) and real routes. The
// model, git and the WP2/WP3 halves are FAKES (the manager's seams + `setStoryBuildDepsForTests`). Pinned:
//   1. start: 400 on a manual ident and on a ticket with no story; 202 `started` then 200 `already_open`
//      (ONE open session per ticket); the assess pipeline lands `plan_ready` with the plan, the candidates'
//      bases, the repository rows (planned, build order, proposed branch), the design, the spend + ledger;
//   2. the plan agent's inputs: read-only roots (scratch + checkouts), gap refs from the fold, the provider;
//   3. chat re-plan: the reader's message + the reply in the transcript, revision + 1, STEERING fenced in the
//      prompt; refused at the revision cap and below the plan budget; a failed re-plan KEEPS the plan;
//   4. accept: 409 PlanMoved on a stale revision, 400 on a bad branch; the build runs IN PLAN ORDER, a later
//      repository given the earlier one, docs decisions FROZEN, no second build ledger row (buildRepo's own);
//   5. tenancy: another account's session id is 404 on EVERY route; `?workspace=` of another account
//      falls back to the caller's Default; the SSE of a session with nothing running ends at once;
//   6. cancel mid-plan ⇒ cancelled; discard refuses while running, frees the ticket after;
//   7. "Check against docs" at Start asks WP3's docs queue after the first plan (no built docs ⇒ refused);
//   8. the restart reconcile: nothing stays "running".
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const DB_PATH = `${process.env.DATABASE_URL ?? `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-storybuild`}.storybuild-routes.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
delete process.env.LIMN_AI_DISABLED;

const IDENT = 'jira:https://acme.atlassian.net#ACME-214';
const IDENT2 = 'jira:https://acme.atlassian.net#ACME-215';

/* eslint-disable @typescript-eslint/no-explicit-any */
let app: FastifyInstance;
let db: any;
let schema: any;
let ctx: any;
let closeDb: (() => Promise<void> | void) | undefined;
let M: typeof import('./manager.js');
let P: typeof import('./persist.js');
let seams: typeof import('./seams.js');
const ws: Record<number, number> = {};
const repoIds: Record<number, number[]> = {};
const usage: any[] = [];
const scratchDirs: string[] = [];
let story: { title: string | null; description: string; acceptanceCriteria: string } | null;
let planAnswer: (args: any) => any;
const agentCalls: any[] = [];
const buildCalls: any[] = [];
let docsCalls = 0;
let gate: Promise<void> | null = null;
let release: (() => void) | null = null;
let SEAMS: import('./manager.js').StoryBuildManagerSeams;

const as = (acct: number) => ({ 'x-acct': String(acct) });

const goodPlan = (repoA: string, repoB: string, extra: Record<string, unknown> = {}) => ({
  summary: 'The API gains a refund endpoint. The web app calls it.',
  repos: [
    { ref: repoB, why: 'The endpoint lives here.', branchSlug: 'refund-endpoint', steps: [{ title: 'Add POST /refunds', files: ['src/refunds.ts'], change: 'Add it.', refs: ['AC1'] }], tests: [] },
    { ref: repoA, why: 'The button lives here.', branchSlug: 'refund-button', steps: [{ title: 'Button', files: ['web/Order.tsx'], change: 'Call it.', refs: ['AC2'] }], tests: [] },
  ],
  readOnlyRepos: [],
  criteria: [
    { ref: 'AC1', how: 'planned', repo: repoB },
    { ref: 'AC2', how: 'planned', repo: repoA },
  ],
  risks: [],
  reply: 'Moved the endpoint behind a flag.',
  design: {
    title: 'Refunds',
    caption: 'A refund flows from the page to the API.',
    acts: [{ id: 'ask', title: 'Ask' }],
    layers: ['ui', 'api'],
    cells: [
      { id: 'btn', act: 'ask', layer: 'ui', label: 'Refund button', pattern: 'Command', change: 'new', pr: repoA, files: ['web/Order.tsx'] },
      { id: 'ep', act: 'ask', layer: 'api', label: 'Refund endpoint', pattern: null, change: 'new', pr: repoB, files: ['src/refunds.ts'] },
    ],
    arrows: [{ from: 'btn', to: 'ep', label: 'POST' }],
  },
  ...extra,
});

beforeAll(async () => {
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  const q = await import('../../db/queries.js');
  for (const acct of [1, 2]) {
    await db.insert(schema.accounts).values({ id: acct, githubUserId: `N${acct}`, githubLogin: `u${acct}`, isLocal: acct === 1 }).onConflictDoNothing().execute();
    ws[acct] = await q.ensureDefaultWorkspace(acct);
    repoIds[acct] = [];
    for (const name of ['web', 'api']) {
      const [r] = await db
        .insert(schema.repos)
        .values({ accountId: acct, githubNodeId: `R${acct}${name}`, owner: 'acme', name: `${name}${acct}`, defaultBranch: 'main' })
        .returning()
        .execute();
      repoIds[acct]!.push(r.id);
    }
    await q.resolveWorkspaceScope(acct, null); // memberships
  }
  M = await import('./manager.js');
  P = await import('./persist.js');
  seams = await import('./seams.js');
  SEAMS = {
    inputs: {
      story: {
        latestTicketReview: async () => null,
        ticketReviewTicket: async () => null,
        trackerStory: async () => story,
        trackerComments: async () => [],
        sprintStory: async () =>
          ({
            workspaceId: 1,
            ident: IDENT,
            found: true,
            ticket: null,
            briefState: 'current',
            brief: { summary: 's', criteria: [{ n: 1, text: 'Refund by card' }, { n: 2, text: 'A refund button' }], criteriaDerived: false, references: [], createdAt: '2026-10-01T00:00:00Z' },
            story: null,
          }) as any,
      },
      ticketPrIds: async () => [],
      ticketPrs: async () => [],
      cards: async () => [],
      url: async () => 'https://acme.atlassian.net/browse/ACME-214',
    },
    checkOut: async (a) => ({
      checkouts: a.candidates.map((c) => {
        const d = mkdtempSync(join(tmpdir(), 'sb-co-'));
        scratchDirs.push(d);
        return { candidate: c, path: d, sha: `sha-${c.repoId}`, error: null };
      }),
      cleanup: async () => {},
    }),
    runPlanAgent: async (args) => {
      agentCalls.push(args);
      if (gate) await gate;
      if (args.abortController.signal.aborted) return { plan: null, designDropped: false, lastRefusal: null, aborted: true, costUsd: 0.1, inputTokens: 1, outputTokens: 1, numTurns: 1, model: 'claude-opus-5-5', ledgerByProvider: false };
      return { plan: planAnswer(args), designDropped: false, lastRefusal: null, aborted: false, costUsd: 0.5, inputTokens: 1000, outputTokens: 100, numTurns: 7, model: 'claude-opus-5-5', ledgerByProvider: false };
    },
    library: async () => null,
  };
  M._setStoryBuildSeamsForTest(SEAMS);
  seams.setStoryBuildDepsForTests({
    buildRepo: async (_ctx, a) => {
      buildCalls.push({ repoId: a.repo.repoId, ref: a.repo.ref, earlier: a.earlier.map((e) => e.repo.repoId), branch: a.repo.branch, checks: a.repo.checksWantedJson, docs: a.docs, frozen: a.build.acceptedDocsJson });
      a.onProgress({ phase: 'building' });
      return {
        ok: true,
        error: null,
        worktreePath: `/tmp/wt-${a.repo.repoId}`,
        patch: `diff --git a/${a.repo.ref} b/${a.repo.ref}`,
        filesChanged: ['x.ts'],
        summary: 'Built.',
        commitMessage: 'Build it',
        changeReport: null,
        checks: null,
        provider: 'claude',
        model: 'claude-opus-5-5',
        effort: 'medium',
        costUsd: 1.25,
        inputTokens: 10,
        outputTokens: 5,
        numTurns: 3,
      };
    },
    runBuildDocs: async () => {
      docsCalls += 1;
      throw new Error('Checking a story build against the docs is not available in this version of Limn yet.');
    },
  });
  ctx = {
    db,
    schema,
    log: { info() {}, warn() {}, error() {} },
    accountIdOf: (req: any) => Number(req.headers['x-acct'] ?? 1),
    llm: { detectAuth: () => ({ status: 'ok' }), detectProviderAuth: () => ({ status: 'ok' }) },
    recordAiUsage: async (row: any) => {
      usage.push(row);
    },
  };
  const Fastify = (await import('fastify')).default;
  const { registerStoryBuildRoutes } = await import('./routes.js');
  app = Fastify({ logger: false });
  registerStoryBuildRoutes(app, ctx);
  await app.ready();
});

afterAll(async () => {
  M?._setStoryBuildSeamsForTest(null);
  seams?.setStoryBuildDepsForTests(null);
  await app?.close();
  await closeDb?.();
  for (const d of scratchDirs) rmSync(d, { recursive: true, force: true });
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
});

beforeEach(() => {
  story = { title: 'Refund by card', description: 'Customers can refund a paid order.', acceptanceCriteria: '' };
  planAnswer = () => goodPlan('R1', 'R2');
  gate = null;
});

const post = (url: string, payload: any, acct = 1) => app.inject({ method: 'POST', url, headers: as(acct), payload });
const get = (url: string, acct = 1) => app.inject({ method: 'GET', url, headers: as(acct) });
const start = (ident = IDENT, acct = 1, extra: any = {}) => post('/api/story-builds', { workspaceId: ws[acct], ident, diagram: true, docs: false, ...extra }, acct);

describe('start → plan_ready', () => {
  let id = 0;

  it('400s a manual ident', async () => {
    expect((await start('manual:12:abcdef01')).statusCode).toBe(400);
  });

  it('starts ONE session per ticket', async () => {
    const r = await start();
    expect(r.statusCode).toBe(202);
    expect(r.json().outcome).toBe('started');
    id = r.json().buildId;
    const again = await start();
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ outcome: 'already_open', buildId: id });
    await M._storyBuildIdleForTest();
  });

  it('lands plan_ready with the plan, the bases, the rows, the design and the spend', async () => {
    const b = (await get(`/api/story-builds/${id}`)).json();
    expect(b).toMatchObject({ status: 'plan_ready', planRevision: 1, ticketKey: 'ACME-214', ticketTitle: 'Refund by card', wantDiagram: true, error: null, phase: null });
    expect(b.coverage).toMatchObject({ state: 'none', criteria: [{ ref: 'AC1' }, { ref: 'AC2' }] });
    expect(b.candidates.map((c: any) => [c.ref, c.fullName, c.baseSha])).toEqual([
      ['R1', 'acme/api1', `sha-${repoIds[1]![1]}`],
      ['R2', 'acme/web1', `sha-${repoIds[1]![0]}`],
    ]);
    expect(b.plan.repos.map((r: any) => r.ref)).toEqual(['R2', 'R1']);
    expect(b.repos.map((r: any) => [r.ref, r.status, r.order, r.branch])).toEqual([
      ['R2', 'planned', 0, 'limn/acme-214-refund-endpoint'],
      ['R1', 'planned', 1, 'limn/acme-214-refund-button'],
    ]);
    expect(b.design.cells.map((c: any) => c.pr)).toEqual(['R1', 'R2']);
    expect(b.planCostUsd).toBe(0.5);
    expect(b.provider).toBe('claude');
    expect(JSON.stringify(b)).not.toContain('Customers can refund'); // the seed never reaches the wire
    expect(usage).toEqual([expect.objectContaining({ feature: 'story_plan', costUsd: 0.5, seam: 'agent' })]);
  });

  it('ran the agent read-only on the checkouts, with the gaps from the fold', async () => {
    const a = agentCalls[0];
    expect(a.readRoots[0]).toBe(a.cwd);
    expect(a.readRoots).toHaveLength(3);
    expect(a.context).toMatchObject({ gapRefs: ['AC1', 'AC2'], wantDiagram: true });
    expect(a.provider).toBe('claude');
    expect(a.model).toBe('claude-opus-5-5');
    expect(a.usageRecord).toEqual({ accountId: 1, seam: 'agent', feature: 'story_plan' });
    expect(a.prompt).toMatch(/---BEGIN GAPS TO CLOSE \S+---\nAC1 \(not checked yet\): Refund by card/);
  });

  it('lists the ticket: the latest session', async () => {
    const r = (await get(`/api/story-builds?workspace=${ws[1]}&ident=${encodeURIComponent(IDENT)}`)).json();
    expect(r).toMatchObject({ workspaceId: ws[1], build: { id }, earlier: [] });
  });

  it('re-plans on a chat message: steering fenced, the reply kept, revision + 1', async () => {
    const r = await post(`/api/story-builds/${id}/plan/message`, { text: 'Put the endpoint behind a flag.' });
    expect(r.statusCode).toBe(202);
    await M._storyBuildIdleForTest();
    const b = (await get(`/api/story-builds/${id}`)).json();
    expect(b.planRevision).toBe(2);
    expect(b.transcript.map((m: any) => [m.role, m.text])).toEqual([
      ['reader', 'Put the endpoint behind a flag.'],
      ['claude', 'Moved the endpoint behind a flag.'],
    ]);
    expect(agentCalls.at(-1).prompt).toMatch(/---BEGIN STEERING FROM THE PERSON RUNNING THIS BUILD \S+---\nPut the endpoint behind a flag\./);
    expect(agentCalls.at(-1).prompt).toMatch(/---BEGIN PREVIOUS PLAN/);
    expect(b.planCostUsd).toBe(1);
  });

  it('a failed re-plan keeps the plan', async () => {
    planAnswer = () => null;
    expect((await post(`/api/story-builds/${id}/plan/message`, { text: 'Try again.' })).statusCode).toBe(202);
    await M._storyBuildIdleForTest();
    const b = (await get(`/api/story-builds/${id}`)).json();
    expect(b).toMatchObject({ status: 'plan_ready', planRevision: 2 });
    expect(b.error).toMatch(/did not hand in a new plan; this is the previous one/);
  });

  it('refuses at the revision cap and below the plan budget', async () => {
    await P.updateStoryBuild(ctx, 1, id, { planRevision: 13 });
    expect((await post(`/api/story-builds/${id}/plan/message`, { text: 'x' })).json().error).toBe('PlanRevisionCap');
    await P.updateStoryBuild(ctx, 1, id, { planRevision: 2, planCostUsd: 3.9 });
    expect((await post(`/api/story-builds/${id}/plan/message`, { text: 'x' })).json().error).toBe('PlanBudgetSpent');
    await P.updateStoryBuild(ctx, 1, id, { planCostUsd: 1.5 });
    expect((await post(`/api/story-builds/${id}/plan/message`, { text: '   ' })).statusCode).toBe(400);
  });

  it("another account's id is 404 everywhere; its workspace falls back to the caller's", async () => {
    for (const [method, url, payload] of [
      ['GET', `/api/story-builds/${id}`, undefined],
      ['GET', `/api/story-builds/${id}/stream`, undefined],
      ['POST', `/api/story-builds/${id}/plan/message`, { text: 'x' }],
      ['POST', `/api/story-builds/${id}/accept`, { planRevision: 2, repos: [] }],
      ['POST', `/api/story-builds/${id}/cancel`, {}],
      ['POST', `/api/story-builds/${id}/discard`, {}],
    ] as const) {
      const r = await app.inject({ method, url, headers: as(2), ...(payload ? { payload } : {}) });
      expect(r.statusCode, `${method} ${url}`).toBe(404);
    }
    const list = (await get(`/api/story-builds?workspace=${ws[1]}&ident=${encodeURIComponent(IDENT)}`, 2)).json();
    expect(list).toEqual({ workspaceId: ws[2], build: null, earlier: [] });
    expect((await P.getStoryBuildRow(ctx, 1, id))?.status).toBe('plan_ready');
  });

  it('the stream of a session with nothing running ends at once', async () => {
    const r = await get(`/api/story-builds/${id}/stream`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/event-stream/);
    expect(r.body).toBe('');
  });

  it('accept: PlanMoved on a stale revision, 400 on a bad branch', async () => {
    const [web, api] = repoIds[1]!;
    expect((await post(`/api/story-builds/${id}/accept`, { planRevision: 1, repos: [] })).json().error).toBe('PlanMoved');
    const bad = await post(`/api/story-builds/${id}/accept`, { planRevision: 2, repos: [{ repoId: api, include: true, branch: 'a..b', checks: [] }] });
    expect(bad.statusCode).toBe(400);
    const none = await post(`/api/story-builds/${id}/accept`, {
      planRevision: 2,
      repos: [
        { repoId: api, include: false, branch: 'x', checks: [] },
        { repoId: web, include: false, branch: 'y', checks: [] },
      ],
    });
    expect(none.json().message).toBe('Include at least one repository.');
  });

  it('accept builds IN PLAN ORDER, a later repository given the earlier one; docs frozen; spend recorded', async () => {
    const [web, api] = repoIds[1]!;
    await P.updateStoryBuild(ctx, 1, id, {
      docsJson: { summary: 's', nothingGrounded: false, planRevision: 2, items: [{ id: 'D1', kind: 'suggestion', about: 'AC1', note: 'n', suggestion: 'x', refs: [] }] },
    });
    const r = await post(`/api/story-builds/${id}/accept`, {
      planRevision: 2,
      repos: [
        { repoId: api, include: true, branch: 'limn/refunds-api', checks: ['test'] },
        { repoId: web, include: true, branch: 'limn/refunds-web', checks: [] },
      ],
    });
    expect(r.statusCode).toBe(202);
    await M._storyBuildIdleForTest();
    expect(buildCalls.map((c) => [c.repoId, c.earlier, c.branch, c.checks])).toEqual([
      // R2 (acme/web1) is first in the plan, R1 (acme/api1) second.
      [web, [], 'limn/refunds-web', []],
      [api, [web], 'limn/refunds-api', ['test']],
    ]);
    expect(buildCalls[0].frozen).toEqual({ D1: 'include' });
    const b = (await get(`/api/story-builds/${id}`)).json();
    expect(b).toMatchObject({ status: 'ready', acceptedRevision: 2, acceptedDocs: { D1: 'include' }, pushedAll: false });
    expect(b.repos.map((x: any) => [x.status, x.hasPatch, x.costUsd])).toEqual([
      ['ready', true, 1.25],
      ['ready', true, 1.25],
    ]);
    expect(b.totalCostUsd).toBe(1.5 + 2.5);
    // ⚠ The build's ledger row is `buildRepo`'s own (WP2): the manager writes none, so a fake writes none.
    expect(usage.filter((u) => u.feature === 'story_build')).toHaveLength(0);
    expect(JSON.stringify(b)).not.toContain('diff --git');
    // Nothing more to accept or re-plan.
    expect((await post(`/api/story-builds/${id}/plan/message`, { text: 'x' })).json().error).toBe('NotReady');
  });

  it('retry re-builds one repository (the WP2 route calls this)', async () => {
    const [web] = repoIds[1]!;
    const n = buildCalls.length;
    expect(await M.retryStoryBuildRepo(ctx, { accountId: 2, buildId: id, repoId: web! })).toEqual({ status: 'not_found' });
    expect(await M.retryStoryBuildRepo(ctx, { accountId: 1, buildId: id, repoId: web! })).toEqual({ status: 'queued', id });
    await M._storyBuildIdleForTest();
    expect(buildCalls.length).toBe(n + 1);
    expect((await get(`/api/story-builds/${id}`)).json().status).toBe('ready');
  });

  it('discard closes it and frees the ticket', async () => {
    expect((await post(`/api/story-builds/${id}/discard`, {})).json()).toEqual({ status: 'discarded' });
    const again = await start();
    expect(again.statusCode).toBe(202);
    expect(again.json().buildId).not.toBe(id);
    await M._storyBuildIdleForTest();
    const list = (await get(`/api/story-builds?workspace=${ws[1]}&ident=${encodeURIComponent(IDENT)}`)).json();
    expect(list.earlier.map((e: any) => [e.id, e.status])).toEqual([[id, 'discarded']]);
  });
});

describe('cancel, docs, refusals', () => {
  it('a ticket with no story is NoStory, with no row', async () => {
    story = { title: null, description: '', acceptanceCriteria: '' };
    const noBrief = 'jira:https://acme.atlassian.net#ACME-999';
    // The brief seam answers criteria for every ident; an empty brief needs its own story seam.
    M._setStoryBuildSeamsForTest({ ...SEAMS, inputs: { ...SEAMS.inputs!, story: { ...SEAMS.inputs!.story!, sprintStory: async () => null } } });
    const r = await start(noBrief);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('NoStory');
    expect(await P.listStoryBuildRowsFor(ctx, 1, ws[1]!, noBrief)).toEqual([]);
    M._setStoryBuildSeamsForTest(SEAMS);
  });

  it('cancel mid-plan ⇒ cancelled; discard refuses while running', async () => {
    gate = new Promise((r) => (release = r));
    const r = await start(IDENT2);
    const id = r.json().buildId;
    for (let i = 0; i < 200 && agentCalls.at(-1)?.abortController == null; i += 1) await new Promise((x) => setTimeout(x, 5));
    expect((await post(`/api/story-builds/${id}/discard`, {})).statusCode).toBe(409);
    expect((await post(`/api/story-builds/${id}/cancel`, {})).json()).toEqual({ status: 'cancelling' });
    release!();
    await M._storyBuildIdleForTest();
    expect((await get(`/api/story-builds/${id}`)).json().status).toBe('cancelled');
    expect((await post(`/api/story-builds/${id}/cancel`, {})).json()).toEqual({ status: 'idle' });
  });

  it('"Check against docs" at Start asks the docs queue after the first plan (no built docs ⇒ refused)', async () => {
    const r = await start(IDENT2, 1, { docs: true });
    expect(r.statusCode).toBe(202);
    await M._storyBuildIdleForTest();
    for (let i = 0; i < 100; i += 1) {
      if ((await P.getStoryBuildRow(ctx, 1, r.json().buildId))?.docsStatus === 'refused') break;
      await new Promise((x) => setTimeout(x, 10));
    }
    const b = (await get(`/api/story-builds/${r.json().buildId}`)).json();
    // The workspace has no built docs: refused before any run (the e2e flow test drives a real run).
    expect(docsCalls).toBe(0);
    expect(b).toMatchObject({ status: 'plan_ready', docsStatus: 'refused' });
  });
});

describe('the restart reconcile', () => {
  it('leaves nothing running', async () => {
    const mk = async (ident: string, status: string, extra: any = {}) => {
      const c = await P.insertStoryBuild(ctx, { accountId: 2, workspaceId: ws[2]!, ident, ticketKey: 'X-1', ticketTitle: null, wantDiagram: false, wantDocs: false, provider: 'claude', model: 'claude-opus-5-5' });
      await P.updateStoryBuild(ctx, 2, c.id, { status: status as any, ...extra });
      return c.id;
    };
    const plan = { revision: 1, summary: 's', repos: [], readOnlyRepos: [], criteria: [], risks: [] };
    const a = await mk('jira:https://acme.atlassian.net#R-1', 'assessing');
    const b = await mk('jira:https://acme.atlassian.net#R-2', 'planning', { planJson: plan, planRevision: 1 });
    const c = await mk('jira:https://acme.atlassian.net#R-3', 'building');
    const base = { accountId: 2, buildId: c, include: true, baseRef: 'main', baseSha: 's', stackedOnPrId: null, branch: 'b' };
    const r1 = await P.upsertStoryBuildRepo(ctx, { ...base, repoId: repoIds[2]![0]!, ref: 'R1', buildOrder: 0, status: 'building' });
    await P.updateStoryBuildRepo(ctx, 2, r1, { patch: 'diff' });
    await P.upsertStoryBuildRepo(ctx, { ...base, repoId: repoIds[2]![1]!, ref: 'R2', buildOrder: 1, status: 'queued' });
    const d = await mk('jira:https://acme.atlassian.net#R-4', 'plan_ready', { planJson: plan, docsStatus: 'running' });
    expect(await M.reconcileStoryBuildsOnStartup(ctx)).toBe(4);
    const row = async (x: number) => (await P.getStoryBuildRow(ctx, 2, x))!;
    expect((await row(a)).status).toBe('failed');
    expect(await row(b)).toMatchObject({ status: 'plan_ready', error: 'Stopped when Limn restarted.' });
    expect((await row(c)).status).toBe('ready');
    expect((await P.listStoryBuildRepoRows(ctx, 2, c)).map((r) => r.status)).toEqual(['ready', 'cancelled']);
    expect((await row(d)).docsStatus).toBe('failed');
  });
});

describe('the repository shortlist (DB)', () => {
  it('asks the fast model once more for an unreadable answer, keeps only workspace repos, records the spend', async () => {
    const { pickCandidates } = await import('./candidates.js');
    const ids: number[] = [];
    for (const name of ['billing', 'infra']) {
      const [r] = await db.insert(schema.repos).values({ accountId: 1, githubNodeId: `R1x${name}`, owner: 'acme', name, defaultBranch: 'main' }).returning().execute();
      ids.push(r.id);
    }
    const answers = ['not json', '{"repos": ["acme/billing", "evil/elsewhere", "acme/web1"]}'];
    const prompts: string[] = [];
    const before = usage.length;
    const fake = {
      ...ctx,
      llm: {
        ...ctx.llm,
        complete: async (o: any) => {
          prompts.push(o.prompt);
          return { text: answers.shift()!, usage: { inputTokens: 100, outputTokens: 10 } };
        },
      },
    };
    const res = await pickCandidates(fake, {
      accountId: 1,
      workspaceId: ws[1]!,
      memberRepoIds: [...repoIds[1]!, ...ids],
      story: { key: 'ACME-214', title: 'Refunds', text: 'Refund by card' },
      prs: [],
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toMatch(/---BEGIN REPOSITORIES \S+---\n- acme\/api1/);
    expect(res.candidates.map((c) => [c.ref, c.fullName, c.source, c.baseRef, c.baseSha])).toEqual([
      ['R1', 'acme/billing', 'picked', 'main', ''],
      ['R2', 'acme/web1', 'picked', 'main', ''],
    ]);
    expect(usage.slice(before).map((u) => u.feature)).toEqual(['story_build_repos', 'story_build_repos']);
    expect(res.costUsd).toBeGreaterThan(0);
  });

  it('a shortlist CODEX answered is recorded as Codex (its model, its own US$), never at Claude rates', async () => {
    const { pickCandidates } = await import('./candidates.js');
    const ids: number[] = [];
    for (const name of ['ledger', 'mailer', 'search']) {
      const [r] = await db.insert(schema.repos).values({ accountId: 1, githubNodeId: `R1y${name}`, owner: 'acme', name, defaultBranch: 'main' }).returning().execute();
      ids.push(r.id);
    }
    const before = usage.length;
    const fake = {
      ...ctx,
      llm: {
        ...ctx.llm,
        complete: async () => ({
          text: '{"repos": ["acme/ledger"]}',
          usage: { inputTokens: 5_000, outputTokens: 50 },
          provider: 'codex' as const,
          model: 'gpt-6-luna',
          costUsd: 0,
        }),
      },
    };
    const res = await pickCandidates(fake, { accountId: 1, workspaceId: ws[1]!, memberRepoIds: ids, story: { key: 'ACME-215', title: 'Ledger', text: 'Ledger' }, prs: [] });
    expect(res.candidates.map((c) => c.fullName)).toEqual(['acme/ledger']);
    expect(usage.slice(before)).toEqual([
      expect.objectContaining({ feature: 'story_build_repos', provider: 'codex', model: 'gpt-6-luna', costUsd: 0, inputTokens: 5_000, outputTokens: 50 }),
    ]);
    expect(res.costUsd).toBe(0);
  });
});

describe('the coverage wait lends the review slot back', () => {
  it('holds no review slot while it waits on the ticket check, and plans after', async () => {
    const ident = 'jira:https://acme.atlassian.net#ACME-299';
    const held: number[] = [];
    M._setStoryBuildSeamsForTest({
      ...SEAMS,
      inputs: {
        ...SEAMS.inputs!,
        ticketPrIds: async () => [1],
        ticketPrs: async () => [{ prId: 1, repoId: repoIds[1]![0]!, number: 7, title: 'Earlier', headSha: 'abc', state: 'merged', headRefName: 'x', byReader: false }],
      },
      coverage: {
        checkState: async () => {
          held.push(M._storyPlanSlotsHeldForTest());
          return { latest: null, runningRunId: null };
        },
        liveTicketHash: async () => null,
        isCurrent: async () => false,
        startCheck: async () => ({ outcome: 'busy' }),
        runStatus: async () => null,
        sleep: async () => {},
      },
    });
    try {
      const r = await start(ident);
      expect(r.statusCode).toBe(202);
      await M._storyBuildIdleForTest();
      expect(held).toEqual([0]);
      const b = (await get(`/api/story-builds/${r.json().buildId}`)).json();
      expect(b.status).toBe('plan_ready');
      expect(b.coverage.state).toBe('failed');
      expect(M._storyPlanSlotsHeldForTest()).toBe(0);
    } finally {
      M._setStoryBuildSeamsForTest(SEAMS);
    }
  });
});
