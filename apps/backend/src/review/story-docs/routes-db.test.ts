// CHECK A STORY AGAINST THE DOCS over the REAL core client (a scratch SQLite) and a scratch docs folder.
// The models are FAKES (the manager's seams). Pinned:
//   1. 400 on a manual / unparseable ident; `available: false` and the `no_docs` refusal with no built doc.
//   2. POST 202 → the run is stored with only GROUNDED points; GET shows it current; a library change
//      makes it "Out of date" ('library'); a later failed run keeps the last good result beside it.
//   3. `no_story` when there is nothing to read; the daily cap refuses with no row.
//   5. REUSE: a click with nothing changed answers `reused` with the good run — no row, no model call;
//      `force` runs anyway. A library that fits the inline budget skips the shortlist call.
//   4. Tenancy: another account's workspace id falls back to the caller's Default (no run seen); the
//      composite FK refuses a cross-account row; a restart fails orphaned runs.
//
//   DATABASE_URL=<scratch> pnpm --filter @pierre-review/backend test story-docs/routes-db
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

const DB_PATH = `${process.env.DATABASE_URL ?? '/tmp/pierre-storydocs'}.storydocs-db.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
delete process.env.LIMN_AI_DISABLED;

const IDENT = 'jira:https://acme.atlassian.net#ABC-1';

/* eslint-disable @typescript-eslint/no-explicit-any */
let app: FastifyInstance;
let db: any;
let schema: any;
let ctx: any;
let closeDb: (() => Promise<void> | void) | undefined;
let docsDir: string;
let wsA = 0;
let wsB = 0;
let manager: typeof import('./manager.js');
let persist: typeof import('./persist.js');
let story: { title: string | null; description: string; acceptanceCriteria: string } | null;
let agentPayload: any;
let withBrief = true;
let gate: Promise<void> | null = null;
const usage: any[] = [];
let completeCalls = 0;
let agentCalls = 0;
let agentArgs: any = null;

const as = (acct: number) => ({ 'x-acct': String(acct) });
const good = { link: 'refunds/sections/01-refunds.md#refunds', quote: 'Refunds are paid within fourteen days' };
const bad = { link: 'refunds/sections/01-refunds.md', quote: 'Refunds are paid within thirty days' };

const PAYLOAD = {
  overall: {
    verdict: 'mixed',
    summary: 'The story mostly matches the refund policy. It sets the wrong deadline.',
    actions: [
      { text: 'Change the deadline to 14 days.', refs: [good] },
      { text: 'Add the approval step.', refs: [bad] },
    ],
  },
  criteria: [
    { n: 1, verdict: 'diverges', note: 'The story says 30 days; the policy says 14.', refs: [good] },
    { n: 2, verdict: 'aligned', note: 'Ungrounded.', refs: [bad] },
  ],
};

async function addBuiltDoc(acct: number, ws: number, builtAt = new Date(1_700_000_000_000)): Promise<void> {
  const lib = join(docsDir, String(acct), String(ws), 'library', 'refunds');
  mkdirSync(join(lib, 'sections'), { recursive: true });
  writeFileSync(join(lib, 'CONTENTS.md'), '# Refund policy\n- [Refunds](sections/01-refunds.md)\n');
  writeFileSync(join(lib, 'sections', '01-refunds.md'), '# Refunds\n\nRefunds are paid within fourteen days of approval.\n');
  await db
    .insert(schema.referenceDocs)
    .values({
      accountId: acct,
      workspaceId: ws,
      slug: 'refunds',
      title: 'Refund policy',
      sourceKind: 'markdown',
      sourceName: 'refunds.md',
      status: 'ready',
      progress: 100,
      sectionCount: 1,
      sections: [{ path: 'refunds/sections/01-refunds.md', title: 'Refunds', summary: 'Refund timing', depth: 1, trail: [], headings: [], words: 8 }],
      builtAt,
    })
    .execute();
}

beforeAll(async () => {
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
  docsDir = mkdtempSync(join(tmpdir(), 'limn-storydocs-'));
  (await import('../../reference-docs/paths.js')).setDocsRootForTest(docsDir);
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  for (const id of [1, 2]) {
    await db.insert(schema.accounts).values({ id, githubUserId: `U${id}`, githubLogin: `me${id}`, isLocal: id === 1 }).onConflictDoNothing().execute();
  }
  const q = await import('../../db/queries.js');
  wsA = await q.ensureDefaultWorkspace(1);
  wsB = await q.ensureDefaultWorkspace(2);
  manager = await import('./manager.js');
  persist = await import('./persist.js');
  manager._setStoryDocsSeamsForTest({
    inputs: {
      latestTicketReview: async () => null,
      ticketReviewTicket: async () => null,
      trackerStory: async () => story,
      sprintStory: async () => ({
        workspaceId: 1,
        ident: IDENT,
        found: true,
        ticket: null,
        briefState: withBrief ? 'current' : 'none',
        brief: !withBrief ? null : { summary: 's', criteria: [{ n: 1, text: 'Refunds in 30 days' }, { n: 2, text: 'Needs approval' }], criteriaDerived: false, references: [], createdAt: '2026-10-01T00:00:00Z' },
        story: null,
      }) as any,
    },
    complete: async () => (completeCalls++, { text: '{"sections":[{"link":"refunds/sections/01-refunds.md","reason":"Refund timing"}]}', usage: { inputTokens: 100, outputTokens: 10 } }),
    runAgent: async (args: any) => (agentCalls++, (agentArgs = args), await gate, { payload: agentPayload, lastRefusal: null, aborted: false, costUsd: 0.2, inputTokens: 1000, outputTokens: 100, numTurns: 4 }),
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
  const { registerStoryDocsRoutes } = await import('./routes.js');
  app = Fastify({ logger: false });
  registerStoryDocsRoutes(app, ctx);
  await app.ready();
});

afterAll(async () => {
  manager?._setStoryDocsSeamsForTest(null);
  await app?.close();
  await closeDb?.();
  rmSync(docsDir, { recursive: true, force: true });
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
});

beforeEach(() => {
  story = { title: 'Refunds', description: 'Customers get refunds within 30 days.', acceptanceCriteria: '' };
  agentPayload = PAYLOAD;
  withBrief = true;
});

const get = (acct = 1, ident = IDENT, ws?: number) =>
  app.inject({ method: 'GET', url: `/api/docs/story-alignment?ident=${encodeURIComponent(ident)}${ws ? `&workspace=${ws}` : ''}`, headers: as(acct) });
const post = (acct = 1, body: any = { ident: IDENT }) => app.inject({ method: 'POST', url: '/api/docs/story-alignment', headers: as(acct), payload: body });

describe('before any document is built', () => {
  it('400s a manual or unparseable ident', async () => {
    expect((await get(1, 'manual:12:abcdef01')).statusCode).toBe(400);
    expect((await get(1, 'not-a-ticket')).statusCode).toBe(400);
    expect((await post(1, { ident: 'manual:12:abcdef01' })).statusCode).toBe(400);
  });

  it('is not available, and the POST refuses no_docs with no row', async () => {
    expect((await get()).json()).toEqual({ workspaceId: wsA, ident: IDENT, available: false, docCount: 0, run: null, lastSucceeded: null });
    const r = await post();
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ outcome: 'refused', runId: null, refusal: 'no_docs' });
    expect(await persist.latestStoryDocsRun(ctx, 1, wsA, IDENT)).toBeNull();
  });
});

describe('a check', () => {
  beforeAll(async () => {
    await addBuiltDoc(1, wsA);
  });

  it('POST 202 stores only grounded points; GET shows it current', async () => {
    const r = await post();
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ outcome: 'queued' });
    await manager._storyDocsIdleForTest();
    const body = (await get()).json();
    expect(body).toMatchObject({ available: true, docCount: 1, lastSucceeded: null });
    expect(body.run).toMatchObject({ status: 'succeeded', current: true, staleBecause: [], criteriaSource: 'brief', error: null });
    expect(body.run.criteria).toEqual([{ n: 1, text: 'Refunds in 30 days' }, { n: 2, text: 'Needs approval' }]);
    const result = body.run.result;
    expect(result.outcome).toBe('checked');
    expect(result.criteria.map((c: any) => c.n)).toEqual([1]);
    expect(result.criteria[0].refs[0]).toMatchObject({ path: 'refunds/sections/01-refunds.md', anchor: 'refunds', workspaceId: wsA, docTitle: 'Refund policy' });
    expect(result.overall.actions).toHaveLength(1);
    // The whole library fits the inline budget: every section, no shortlist call, the text in the prompt.
    expect(result.shortlist).toEqual([expect.objectContaining({ path: 'refunds/sections/01-refunds.md', reason: '', workspaceId: wsA })]);
    expect(completeCalls).toBe(0);
    expect(agentArgs.prompt).toMatch(/---BEGIN SECTION refunds\/sections\/01-refunds\.md [0-9a-f]+---\n# Refunds\n\nRefunds are paid within fourteen days of approval\./);
    expect(agentArgs.maxTurns).toBe(4);
    expect(body.run.costUsd).toBeCloseTo(0.2);
    expect(usage.map((u) => u.feature)).toEqual(['story_docs_alignment']);
  });

  it('nothing changed ⇒ the POST reuses the good run: no row, no model call; force runs anyway', async () => {
    const before = (await get()).json().run;
    const calls = agentCalls;
    const r = await post();
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ outcome: 'reused', runId: before.id });
    expect((await persist.latestStoryDocsRun(ctx, 1, wsA, IDENT))!.id).toBe(before.id);
    expect(agentCalls).toBe(calls);
    // A changed story is a new run.
    story = { title: 'Refunds', description: 'Customers get refunds within 60 days.', acceptanceCriteria: '' };
    expect((await post()).json()).toMatchObject({ outcome: 'queued' });
    await manager._storyDocsIdleForTest();
    expect(agentCalls).toBe(calls + 1);
    story = { title: 'Refunds', description: 'Customers get refunds within 60 days.', acceptanceCriteria: '' };
    expect((await post()).json()).toMatchObject({ outcome: 'reused' });
    // Back to the first story (the next tests' default): force runs it even though run 1 matches.
    story = { title: 'Refunds', description: 'Customers get refunds within 30 days.', acceptanceCriteria: '' };
    const forced = await post(1, { ident: IDENT, force: true });
    expect(forced.statusCode).toBe(202);
    await manager._storyDocsIdleForTest();
    expect(agentCalls).toBe(calls + 2);
  });

  it('a library change makes it out of date; a failed re-run keeps the good result beside it', async () => {
    const before = (await get()).json().run;
    await db.update(schema.referenceDocs).set({ builtAt: new Date(1_800_000_000_000) }).where(eq(schema.referenceDocs.accountId, 1)).execute();
    const stale = (await get()).json().run;
    expect(stale).toMatchObject({ id: before.id, current: false, staleBecause: ['library'] });
    agentPayload = null;
    expect((await post()).statusCode).toBe(202);
    await manager._storyDocsIdleForTest();
    const after = (await get()).json();
    expect(after.run).toMatchObject({ status: 'failed', error: 'Claude did not finish the check. Run it again.', result: null });
    expect(after.lastSucceeded).toMatchObject({ id: before.id, status: 'succeeded' });
  });

  it('nothing to read ⇒ no_story, with no row', async () => {
    story = null;
    withBrief = false;
    const before = (await persist.latestStoryDocsRun(ctx, 1, wsA, IDENT))!.id;
    expect((await post()).json()).toEqual({ outcome: 'refused', runId: null, refusal: 'no_story' });
    expect((await persist.latestStoryDocsRun(ctx, 1, wsA, IDENT))!.id).toBe(before);
  });
});

describe('tenancy, cap and restart', () => {
  it('another account never sees these runs, and its workspace id falls back to its own Default', async () => {
    const r = (await get(2, IDENT, wsA)).json();
    expect(r).toMatchObject({ workspaceId: wsB, run: null, lastSucceeded: null, available: false });
    expect(await persist.latestStoryDocsRun(ctx, 2, wsA, IDENT)).toBeNull();
    const own = await persist.latestStoryDocsRun(ctx, 1, wsA, IDENT);
    expect(await persist.getStoryDocsRow(ctx, 2, own!.id)).toBeNull();
    await expect(
      persist.insertQueuedStoryDocs(ctx, {
        accountId: 2,
        workspaceId: wsA,
        ident: IDENT,
        ticketKey: null,
        fingerprint: 'f',
        storyHash: 's',
        criteriaHash: 'c',
        libraryHash: 'l',
        version: 1,
        criteriaSource: 'derived',
        criteria: [],
      }),
    ).rejects.toThrow();
  });

  it('a restart fails orphaned runs', async () => {
    const id = await persist.insertQueuedStoryDocs(ctx, {
      accountId: 1,
      workspaceId: wsA,
      ident: 'jira:https://acme.atlassian.net#ABC-2',
      ticketKey: 'ABC-2',
      fingerprint: 'f',
      storyHash: 's',
      criteriaHash: 'c',
      libraryHash: 'l',
      version: 1,
      criteriaSource: 'derived',
      criteria: [],
    });
    expect(await persist.reconcileOrphanedStoryDocs(ctx)).toBeGreaterThanOrEqual(1);
    expect(await persist.getStoryDocsRow(ctx, 1, id)).toMatchObject({ status: 'failed', error: persist.RESTART_ERROR });
  });

  it('junk workspace values fall back to Default, never a 400', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/docs/story-alignment?ident=${encodeURIComponent(IDENT)}&workspace=${'x'.repeat(60)}`, headers: as(1) });
    expect(r.statusCode).toBe(200);
    expect(r.json().workspaceId).toBe(wsA);
    const p = await post(1, { ident: IDENT, workspaceId: 'junk' });
    expect(p.statusCode).toBe(202);
    await manager._storyDocsIdleForTest();
    expect((await persist.getStoryDocsRow(ctx, 1, p.json().runId))?.workspaceId).toBe(wsA);
  });

  it('the daily cap refuses with no new row — but a held check answers already_running first', async () => {
    const { config } = await import('../../config.js');
    let release!: () => void;
    gate = new Promise<void>((r) => (release = r));
    const first = (await post(1, { ident: IDENT, force: true })).json();
    expect(first).toMatchObject({ outcome: 'queued' });
    const have = await persist.countStoryDocsRunsSince(ctx, 1, 0);
    for (let i = have; i < config.storyDocsDailyCap; i += 1) {
      await persist.insertQueuedStoryDocs(ctx, {
        accountId: 1,
        workspaceId: wsA,
        ident: `jira:https://acme.atlassian.net#CAP-${i}`,
        ticketKey: null,
        fingerprint: 'f',
        storyHash: 's',
        criteriaHash: 'c',
        libraryHash: 'l',
        version: 1,
        criteriaSource: 'derived',
        criteria: [],
      });
    }
    const n = await persist.countStoryDocsRunsSince(ctx, 1, 0);
    expect((await post()).json()).toEqual({ outcome: 'already_running', runId: first.runId });
    release();
    gate = null;
    await manager._storyDocsIdleForTest();
    expect((await post(1, { ident: IDENT, force: true })).json()).toEqual({ outcome: 'refused', runId: null, refusal: 'daily_cap' });
    expect(await persist.countStoryDocsRunsSince(ctx, 1, 0)).toBe(n);
  });
});
