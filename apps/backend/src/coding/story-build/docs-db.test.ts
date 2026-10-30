// "IMPLEMENT STORY" → DOCS CONSIDERATION over the REAL core client (a scratch SQLite) and a scratch docs
// folder; the models are FAKES (docs.ts seams). Pinned:
//   1. POST …/docs: 404 for another account's session; 409 NotReady before a plan; `refused` with no
//      built doc (the session reads it); 202 → only GROUNDED items stored on the SESSION's row, ids D1…,
//      the defaults (suggestion ticked, superseded unticked, grounded none), the ledger feature, the cost;
//      `current` when weighed against this plan revision; `force` re-runs and starts the decisions afresh;
//      409 SessionBudgetSpent; a second click while one runs is `already_running`.
//   2. PUT …/docs/decisions: unknown and grounded ids dropped, the rest MERGED; frozen after Accept.
//   3. docsBlocksFor: the two fenced blocks (included / superseded), `pending`, frozen = Accept's.
//   4. NEVER STUCK: a failed read, a throwing implementation, an abort and a restart all end `failed`.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { StoryBuildCoverage, StoryBuildPlan } from '@pierre-review/shared';

const DB_PATH = `${process.env.DATABASE_URL ?? '/tmp/pierre-storybuild'}.storybuild-docs.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
delete process.env.LIMN_AI_DISABLED;

/* eslint-disable @typescript-eslint/no-explicit-any */
let app: FastifyInstance;
let db: any;
let schema: any;
let ctx: any;
let closeDb: (() => Promise<void> | void) | undefined;
let docsDir: string;
const ws: Record<number, number> = {};
let P: typeof import('./persist.js');
let D: typeof import('./docs.js');
let R: typeof import('./docs-runner.js');
let S: typeof import('./seams.js');
let agentPayload: any;
let agentArgs: any = null;
let agentCalls = 0;
let gate: Promise<void> | null = null;
const usage: any[] = [];
let n = 0;

const as = (acct: number) => ({ 'x-acct': String(acct) });
const good = { link: 'refunds/sections/01-refunds.md#refunds', quote: 'Refunds are paid within fourteen days' };
const audit = { link: 'refunds/sections/01-refunds.md', quote: 'Every refund is logged in the audit trail' };
const bad = { link: 'refunds/sections/01-refunds.md', quote: 'Refunds are paid within thirty days' };

const PAYLOAD = {
  summary: 'The plan follows the refund policy except for the deadline. The story sets a longer one on purpose.',
  items: [
    { kind: 'superseded', about: 'AC1', note: 'The story pays within 30 days; the policy says 14.', refs: [good] },
    { kind: 'suggestion', about: 'R1:step 1', note: 'The policy logs every refund.', suggestion: 'Write each refund to the audit trail.', refs: [audit] },
    { kind: 'grounded', about: 'story', note: 'Refunds need an approved request.', refs: [good] },
    { kind: 'grounded', about: 'AC2', note: 'Ungrounded: dropped.', refs: [bad] },
  ],
};

const PLAN: StoryBuildPlan = {
  revision: 1,
  summary: 'Add card refunds to the API. Show them in the web app.',
  repos: [{ ref: 'R1', repoId: 0, why: 'The refund endpoint lives here.', branchSlug: 'card-refunds', steps: [{ title: 'Add the refund endpoint', files: ['src/refunds.ts'], change: 'POST /refunds', refs: ['AC1'] }], tests: [] }],
  readOnlyRepos: [],
  criteria: [{ ref: 'AC1', how: 'planned', repo: 'R1', reason: null }],
  risks: [],
};
const COVERAGE: StoryBuildCoverage = {
  state: 'none',
  ticketReviewId: null,
  checkedAt: null,
  criteria: [
    { ref: 'AC1', text: 'Refunds are paid within 30 days', verdict: 'not_checked', coveredByPrIds: [] },
    { ref: 'AC2', text: 'The refund button is shown', verdict: 'not_checked', coveredByPrIds: [] },
  ],
  missing: [],
  existingPrs: [],
  note: null,
};

async function addBuiltDoc(acct: number, wsId: number): Promise<void> {
  const lib = join(docsDir, String(acct), String(wsId), 'library', 'refunds');
  mkdirSync(join(lib, 'sections'), { recursive: true });
  writeFileSync(join(lib, 'CONTENTS.md'), '# Refund policy\n- [Refunds](sections/01-refunds.md)\n');
  writeFileSync(join(lib, 'sections', '01-refunds.md'), '# Refunds\n\nRefunds are paid within fourteen days of approval. Every refund is logged in the audit trail.\n');
  await db
    .insert(schema.referenceDocs)
    .values({
      accountId: acct,
      workspaceId: wsId,
      slug: 'refunds',
      title: 'Refund policy',
      sourceKind: 'markdown',
      sourceName: 'refunds.md',
      status: 'ready',
      progress: 100,
      sectionCount: 1,
      sections: [{ path: 'refunds/sections/01-refunds.md', title: 'Refunds', summary: 'Refund timing', depth: 1, trail: [], headings: [], words: 16 }],
      builtAt: new Date(1_700_000_000_000),
    })
    .execute();
}

/** A session in `plan_ready` (what WP1's assess + plan leave behind). */
async function planReady(acct = 1, over: Record<string, unknown> = {}): Promise<number> {
  n += 1;
  const r = await P.insertStoryBuild(ctx, {
    accountId: acct,
    workspaceId: ws[acct]!,
    ident: `jira:https://acme.atlassian.net#ACME-${n}`,
    ticketKey: `ACME-${n}`,
    ticketTitle: 'Card refunds',
    wantDiagram: false,
    wantDocs: false,
    provider: 'claude',
    model: 'claude-opus-5-5',
  });
  await P.updateStoryBuild(ctx, acct, r.id, {
    status: 'plan_ready',
    phase: null,
    planJson: PLAN,
    planRevision: 1,
    coverageJson: COVERAGE,
    criteriaSource: 'derived',
    candidatesJson: [{ ref: 'R1', repoId: 0, fullName: 'acme/api', source: 'picked', baseRef: 'main', baseSha: 'abc', stackedOnPrId: null, stackedOnPrNumber: null, baseNote: null }],
    seedJson: { version: 1, story: { key: `ACME-${n}`, title: 'Card refunds', text: 'Customers get refunds by card within 30 days.', url: null }, criteria: [], comments: 'Dana Lee, 2026-03-04:\nCards only.', cards: [] },
    ...over,
  });
  return r.id;
}

beforeAll(async () => {
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
  docsDir = mkdtempSync(join(tmpdir(), 'limn-storybuild-docs-'));
  (await import('../../reference-docs/paths.js')).setDocsRootForTest(docsDir);
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  const q = await import('../../db/queries.js');
  for (const id of [1, 2]) {
    await db.insert(schema.accounts).values({ id, githubUserId: `U${id}`, githubLogin: `me${id}`, isLocal: id === 1 }).onConflictDoNothing().execute();
    ws[id] = await q.ensureDefaultWorkspace(id);
  }
  P = await import('./persist.js');
  D = await import('./docs.js');
  R = await import('./docs-runner.js');
  S = await import('./seams.js');
  D._setBuildDocsSeamsForTest({
    complete: async () => {
      throw new Error('the whole library fits: no shortlist call');
    },
    runAgent: async (args: any) => (agentCalls++, (agentArgs = args), await gate, { payload: agentPayload, lastRefusal: null, aborted: args.abortController.signal.aborted, costUsd: 0.2, inputTokens: 1000, outputTokens: 100, numTurns: 2 }),
  });
  ctx = {
    db,
    schema,
    log: { info() {}, warn() {}, error() {} },
    accountIdOf: (req: any) => Number(req.headers['x-acct'] ?? 1),
    llm: { detectAuth: () => ({ status: 'ok' }) },
    recordAiUsage: async (row: any) => {
      usage.push(row);
    },
  };
  const Fastify = (await import('fastify')).default;
  const { registerStoryBuildDocsRoutes } = await import('./routes-docs.js');
  app = Fastify({ logger: false });
  registerStoryBuildDocsRoutes(app, ctx);
  await app.ready();
});

afterAll(async () => {
  D?._setBuildDocsSeamsForTest(null);
  S?.setStoryBuildDepsForTests(null);
  await app?.close();
  await closeDb?.();
  rmSync(docsDir, { recursive: true, force: true });
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
});

beforeEach(() => {
  agentPayload = PAYLOAD;
  gate = null;
});

const post = (id: number, body: any = {}, acct = 1) => app.inject({ method: 'POST', url: `/api/story-builds/${id}/docs`, headers: as(acct), payload: body });
const put = (id: number, decisions: any, acct = 1) => app.inject({ method: 'PUT', url: `/api/story-builds/${id}/docs/decisions`, headers: as(acct), payload: { decisions } });
const row = (id: number, acct = 1) => P.getStoryBuildRow(ctx, acct, id);

describe('before any document is built', () => {
  it('404s another account, 409s a session with no plan, and refuses with no built doc', async () => {
    const id = await planReady();
    expect((await post(id, {}, 2)).statusCode).toBe(404);
    expect((await put(id, {}, 2)).statusCode).toBe(404);
    const early = await planReady(1, { status: 'assessing', planJson: null });
    expect((await post(early)).json()).toMatchObject({ error: 'NotReady' });
    // A POST with no body at all is a plain run (the SPA's button sends none).
    const r = await app.inject({ method: 'POST', url: `/api/story-builds/${id}/docs`, headers: as(1) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ outcome: 'refused', buildId: id, message: 'This workspace has no reference docs yet.' });
    expect(await row(id)).toMatchObject({ docsStatus: 'refused', docsError: 'This workspace has no reference docs yet.' });
  });
});

describe('a docs run', () => {
  let id = 0;
  beforeAll(async () => {
    await addBuiltDoc(1, ws[1]!);
    id = await planReady();
  });

  it('POST 202 stores only grounded items on the session, with the defaults, cost and ledger', async () => {
    const r = await post(id);
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ outcome: 'started', buildId: id, message: null });
    await R._storyBuildDocsIdleForTest();
    const b = (await row(id))!;
    expect(b).toMatchObject({ docsStatus: 'ready', docsError: null, wantDocs: true, phase: null, docsDecisionsJson: null });
    expect(b.docsCostUsd).toBeCloseTo(0.2);
    expect(b.docsJson!.planRevision).toBe(1);
    expect(b.docsJson!.items.map((i) => [i.id, i.kind, i.about])).toEqual([
      ['D1', 'superseded', 'AC1'],
      ['D2', 'suggestion', 'R1:step 1'],
      ['D3', 'grounded', 'story'],
    ]);
    const wire = P.toStoryBuild(b, [], { repoNames: new Map(), sessionBudgetUsd: 30 });
    expect(wire.docsDecisions).toEqual({ D1: 'ignore', D2: 'include' });
    expect(wire.docsError).toBeNull();
    // The read: the build mode's prompt (fenced plan, the abouts), confined to the shortlisted document.
    expect(agentArgs.build.abouts).toEqual(['story', 'AC1', 'AC2', 'R1:step 1']);
    expect(agentArgs.prompt).toMatch(/---BEGIN PLAN [0-9a-f]+---/);
    expect(agentArgs.prompt).toMatch(/---BEGIN TICKET COMMENTS [0-9a-f]+---\nDana Lee/);
    expect(agentArgs.systemPrompt).toMatch(/# The story is the spec/);
    expect(agentArgs.roots).toEqual([join(docsDir, '1', String(ws[1]), 'library', 'refunds')]);
    expect(agentArgs.provider).toBe('claude');
    expect(agentArgs.budgetUsd).toBeCloseTo(30);
    expect(agentArgs.usageRecord).toMatchObject({ feature: 'story_build_docs' });
    expect(usage.map((u) => u.feature)).toEqual(['story_build_docs']);
  });

  it('a second POST is `current`; force re-runs and starts the decisions afresh', async () => {
    const calls = agentCalls;
    expect((await post(id)).json()).toEqual({ outcome: 'current', buildId: id, message: null });
    expect(agentCalls).toBe(calls);
    expect((await put(id, { D1: 'include' })).statusCode).toBe(200);
    expect((await post(id, { force: true })).statusCode).toBe(202);
    await R._storyBuildDocsIdleForTest();
    expect(agentCalls).toBe(calls + 1);
    const b = (await row(id))!;
    expect(b.docsDecisionsJson).toBeNull();
    expect(b.docsCostUsd).toBeCloseTo(0.4);
  });

  it('PUT decisions: unknown and grounded ids dropped, the rest merged; frozen after Accept', async () => {
    const r1 = await put(id, { D1: 'include', D3: 'include', D9: 'include' });
    expect(r1.json()).toEqual({ decisions: { D1: 'include', D2: 'include' } });
    const r2 = await put(id, { D2: 'ignore' });
    expect(r2.json()).toEqual({ decisions: { D1: 'include', D2: 'ignore' } });
    expect((await row(id))!.docsDecisionsJson).toEqual({ D1: 'include', D2: 'ignore' });
    expect((await put(id, { D1: 'maybe' })).statusCode).toBe(400);
    const frozen = await planReady(1, { status: 'building', acceptedRevision: 1, docsJson: (await row(id))!.docsJson });
    expect((await put(frozen, { D1: 'include' })).json()).toMatchObject({ error: 'NotReady' });
    expect((await post(frozen)).json()).toMatchObject({ error: 'NotReady', message: 'The plan is accepted: the docs points are frozen.' });
  });

  it('docsBlocksFor: included and superseded blocks, fenced; pending; the build reads Accept’s decisions', async () => {
    await put(id, { D1: 'ignore', D2: 'include' });
    const b = (await row(id))!;
    const blocks = D.docsBlocksFor(b, { nonce: 'n0nce', frozen: false });
    expect(blocks.included).toMatch(/---BEGIN DOCS POINTS THE READER INCLUDED n0nce---\nD2 · about R1:step 1 · suggestion\nThe policy logs every refund\.\nAdd: Write each refund to the audit trail\.\nSource: refunds\/sections\/01-refunds\.md — "Every refund is logged in the audit trail"\n---END DOCS POINTS THE READER INCLUDED n0nce---$/);
    expect(blocks.superseded).toMatch(/^Points where this story changes what the team's docs say\. The story wins/);
    expect(blocks.superseded).toContain('---BEGIN DOCS THE STORY SUPERSEDES (acknowledged) n0nce---\nD1 · about AC1 · the docs differ from the story');
    expect(blocks.included + blocks.superseded).not.toContain('D3');
    // No plan pass has taken these decisions: the included suggestion is pending.
    expect(blocks.pending).toBe(1);
    expect(D.storyBuildDocsUntrustedTexts(b, { frozen: false }).join('\n')).toContain('Write each refund to the audit trail.');
    // A plan pass stores the docs stamped with its decisions: nothing pending until the reader changes one.
    await P.updateStoryBuild(ctx, 1, id, { docsJson: D.plannedDocsFor(b)! });
    const planned = (await row(id))!;
    expect(D.docsBlocksFor(planned, { nonce: 'x', frozen: false }).pending).toBe(0);
    await put(id, { D1: 'include' });
    expect(D.docsBlocksFor((await row(id))!, { nonce: 'x', frozen: false }).pending).toBe(1);
    // The build reads the decisions frozen at Accept, whatever is stored since.
    const atAccept = { ...(await row(id))!, acceptedDocsJson: { D1: 'ignore' as const, D2: 'ignore' as const } };
    const built = D.docsBlocksFor(atAccept, { nonce: 'x', frozen: true });
    expect(built.included).toBe('');
    expect(built.superseded).toContain('D1 · about AC1');
    expect(built.pending).toBe(0);
    expect(D.docsBlocksFor({ ...b, docsJson: null }, { nonce: 'x', frozen: false })).toEqual({ included: '', superseded: '', pending: 0 });
  });

  it('409 SessionBudgetSpent when the session has spent its budget', async () => {
    const poor = await planReady(1, { planCostUsd: 29.9 });
    expect((await post(poor)).json()).toMatchObject({ error: 'SessionBudgetSpent' });
  });

  it('a second click while one runs is already_running; an abort ends it `failed` "Stopped."', async () => {
    const other = await planReady();
    let open!: () => void;
    gate = new Promise<void>((r) => (open = r));
    expect((await post(other)).statusCode).toBe(202);
    expect((await post(other)).json()).toEqual({ outcome: 'already_running', buildId: other, message: null });
    expect(R.storyBuildDocsHeld(other)).toBe(true);
    for (let i = 0; i < 100 && agentArgs?.usageRecord == null; i += 1) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 30));
    expect(R.abortStoryBuildDocs(other)).toBe(true);
    open();
    await R._storyBuildDocsIdleForTest();
    expect(await row(other)).toMatchObject({ docsStatus: 'failed', docsError: 'Stopped.' });
    expect(R.storyBuildDocsHeld(other)).toBe(false);
  });
});

describe('never stuck', () => {
  it('a read with no answer is `failed` with a sentence', async () => {
    const id = await planReady();
    agentPayload = null;
    expect((await post(id)).statusCode).toBe(202);
    await R._storyBuildDocsIdleForTest();
    expect(await row(id)).toMatchObject({ docsStatus: 'failed', docsError: 'Claude did not finish weighing the docs. Run it again.' });
  });

  it('nothing grounded is stored as such, the summary hidden', async () => {
    const id = await planReady();
    agentPayload = { ...PAYLOAD, items: [{ kind: 'grounded', about: 'story', note: 'x', refs: [bad] }] };
    await post(id);
    await R._storyBuildDocsIdleForTest();
    expect((await row(id))!.docsJson).toEqual({ summary: '', items: [], nothingGrounded: true, planRevision: 1 });
  });

  it('a throwing implementation ends `failed`, never `running`', async () => {
    S.setStoryBuildDepsForTests({
      runBuildDocs: async () => {
        throw new Error('boom');
      },
    });
    try {
      const id = await planReady();
      expect((await post(id)).statusCode).toBe(202);
      await R._storyBuildDocsIdleForTest();
      expect(await row(id)).toMatchObject({ docsStatus: 'failed', docsError: 'Weighing the docs failed. Run it again.' });
    } finally {
      S.setStoryBuildDepsForTests(null);
    }
  });

  it('a restart fails every docs run left `running`', async () => {
    const id = await planReady(1, { docsStatus: 'running' });
    expect(await R.reconcileStoryBuildDocsOnStartup(ctx)).toBeGreaterThanOrEqual(1);
    expect(await row(id)).toMatchObject({ docsStatus: 'failed', docsError: 'Stopped when Limn restarted.' });
  });
});
