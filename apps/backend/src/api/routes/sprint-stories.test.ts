// Reports → This sprint — the CORE read routes (api/routes/sprint-stories.ts) and the list fold
// (db/sprint-stories.ts), on a THROWAWAY sqlite DB with a real Fastify instance. Pinned:
//   1. Pro on `periodReports`: 402 before any DB work (GET and PUT).
//   2. Another tenant's workspace id resolves to the caller's Default (never theirs, never a 404).
//   3. Order: Not started first, then In progress; most flags first; then key. Done tickets are counted,
//      not listed; out-of-sprint and other tenants' tickets never listed.
//   4. A view stamps `sprint_reads.viewed_at` and kicks a due read.
//   5. Labels: a CURRENT label makes label chips; `aiEnabled` false → 'off' and no label chips.
//   6. PUT /api/sprint-stories/repos: replace, too_many, bad_repo (another tenant's repo through a
//      foreign workspace id lands on the caller's Default), no_ticket, bad_request.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const DB_PATH = '/private/tmp/claude-501/pierre-sprint-stories-route-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let app: FastifyInstance;
let closeDb: (() => Promise<void> | void) | undefined;
let db: any;
let schema: any;
let setCaps: ((c: any) => void) | undefined;
let emptyCaps: any;
let fullCaps: any;
let store: typeof import('../../db/sprint-store.js');
let fold: typeof import('../../db/sprint-stories.js');
let ownWs = 0;
let foreignWs = 0;
let ownRepo = 0;
let foreignRepo = 0;
let ROOT = '';
const kicks: Array<[number, number]> = [];
const VALUE = 'As a shopper, I want to save my basket, so that I can finish later.';

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  closeDb = client.closeDb;
  await runMigrations();
  db = client.db;
  schema = client.schema;
  const q = await import('../../db/queries.js');
  const have = new Set((await db.select().from(schema.accounts).execute()).map((a: any) => a.id));
  if (!have.has(1)) await db.insert(schema.accounts).values({ id: 1, githubUserId: 'U_sst_a', githubLogin: 'sst-a', isLocal: true }).execute();
  if (!have.has(2)) await db.insert(schema.accounts).values({ id: 2, githubUserId: 'U_sst_b', githubLogin: 'sst-b', isLocal: false }).execute();
  ownWs = await q.ensureDefaultWorkspace(1);
  foreignWs = await q.ensureDefaultWorkspace(2);
  const shared = await import('@pierre-review/shared');
  ROOT = shared.jiraApiRoot('https://acme.atlassian.net') as string;
  for (const [accountId, workspaceId] of [
    [1, ownWs],
    [2, foreignWs],
  ]) {
    await db.insert(schema.workspaceTrackers).values({ accountId, workspaceId, provider: 'jira', baseUrl: 'https://acme.atlassian.net' }).execute();
  }
  const [r1] = await db.insert(schema.repos).values({ accountId: 1, githubNodeId: 'R_sst_web', owner: 'acme', name: 'web' }).returning({ id: schema.repos.id }).execute();
  const [r2] = await db.insert(schema.repos).values({ accountId: 2, githubNodeId: 'R_sst_b', owner: 'other', name: 'api' }).returning({ id: schema.repos.id }).execute();
  ownRepo = r1.id;
  foreignRepo = r2.id;
  await q.assignReposToWorkspace(ownWs, 1, [ownRepo]);
  await q.assignReposToWorkspace(foreignWs, 2, [foreignRepo]);

  const ticket = (accountId: number, workspaceId: number, key: string, o: Record<string, unknown>) => ({
    accountId,
    workspaceId,
    ident: shared.trackerTicketIdent('jira', ROOT, key),
    provider: 'jira',
    apiRoot: ROOT,
    issueKey: key,
    url: `https://acme.atlassian.net/browse/${key}`,
    title: `Story ${key}`,
    description: VALUE,
    acceptanceCriteria: '- Basket survives a reload\n- Basket expires after 30 days',
    statusName: 'To Do',
    statusCategory: 'new',
    assigneeName: 'Zed',
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
    fetchedAt: new Date(),
    nextCheckAt: new Date(),
    ...o,
  });
  await db.insert(schema.sprintTickets).values([
    ticket(1, ownWs, 'ENG-1', { assigneeName: 'Amy' }),
    ticket(1, ownWs, 'ENG-2', { statusName: 'In Progress', statusCategory: 'indeterminate', acceptanceCriteria: '', description: 'Fix it' }),
    ticket(1, ownWs, 'ENG-3', { description: 'Fix it' }),
    ticket(1, ownWs, 'ENG-4', { statusName: 'Done', statusCategory: 'done' }),
    ticket(1, ownWs, 'ENG-5', { inSprint: false }),
    ticket(2, foreignWs, 'ENG-9', {}),
  ]).execute();
  // A CURRENT label on ENG-1: criterion 2 not testable, no out of scope.
  const { storyLabelInput } = await import('../../db/story-label-input.js');
  const input = storyLabelInput({ title: 'Story ENG-1', description: VALUE, acceptanceCriteria: '- Basket survives a reload\n- Basket expires after 30 days' }, 'jira')!;
  await db
    .insert(schema.storyLabels)
    .values({
      accountId: 1,
      ident: shared.trackerTicketIdent('jira', ROOT, 'ENG-1'),
      textHash: input.textHash,
      rubricVersion: shared.STORY_RUBRIC_VERSION,
      criteriaJson: [
        { n: 1, testable: true, bundled: false, dependsOnOtherWork: false },
        { n: 2, testable: false, bundled: false, dependsOnOtherWork: false },
      ],
      storyJson: { outOfScopeStated: false, dependencyNamed: true, nonCodeWork: false },
      criteriaCount: 2,
      model: 'claude-haiku-5-5',
    })
    .execute();

  store = await import('../../db/sprint-store.js');
  store.setSprintReadKicker((a, w) => kicks.push([a, w]));
  fold = await import('../../db/sprint-stories.js');
  const contract = await import('../../pro/contract.js');
  emptyCaps = contract.EMPTY_CAPABILITIES;
  fullCaps = { ...contract.EMPTY_CAPABILITIES, periodReports: true };
  contract.setProCapabilities(fullCaps);
  setCaps = contract.setProCapabilities;
  const { sprintStoriesRoutes } = await import('./sprint-stories.js');
  const { registerAccountContext } = await import('../plugins/auth.js');
  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  registerAccountContext(app);
  await app.register(sprintStoriesRoutes);
  await app.ready();
});

afterAll(async () => {
  store?.setSprintReadKicker(null);
  setCaps?.(emptyCaps);
  await app?.close();
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('GET /api/sprint-stories', () => {
  it('402s without periodReports, before any DB work', async () => {
    setCaps?.(emptyCaps);
    const before = await db.select().from(schema.sprintReads).execute();
    for (const r of [
      { method: 'GET' as const, url: '/api/sprint-stories' },
      { method: 'PUT' as const, url: '/api/sprint-stories/repos', payload: { workspaceId: ownWs, ident: 'x', repoIds: [] } },
      { method: 'PUT' as const, url: '/api/sprint-stories/checks', payload: { workspaceId: ownWs, checks: { off: [], issueTypes: {} } } },
    ]) {
      const res = await app.inject(r);
      expect(res.statusCode).toBe(402);
      expect(res.json()).toEqual({ error: 'pro required' });
    }
    expect(await db.select().from(schema.sprintReads).execute()).toEqual(before);
    setCaps?.(fullCaps);
  });

  it('lists the caller’s sprint in order, counts done, stamps the view and kicks the read', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/sprint-stories?workspace=${foreignWs}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.workspaceId).toBe(ownWs);
    expect(body).toMatchObject({ trackerOn: true, provider: 'jira', doneCount: 1, source: null });
    expect(body.read.readAt).toBeNull();
    expect(body.tickets.map((t: any) => [t.key, t.phase, t.flagCount])).toEqual([
      ['ENG-1', 'not_started', 2],
      ['ENG-3', 'not_started', 1],
      ['ENG-2', 'in_progress', 2],
    ]);
    const eng1 = body.tickets[0];
    expect(eng1.labels).toBe('current');
    expect(eng1.chips.map((c: any) => c.id)).toEqual(['criterion_not_testable', 'out_of_scope_missing']);
    expect(eng1.chips[0].criterion).toEqual({ n: 2, text: 'Basket expires after 30 days' });
    expect(eng1.replaceTarget).toEqual({ kind: 'description' });
    expect(eng1.repos).toEqual({ accepted: [], suggested: [] });
    expect(body.repos).toEqual([{ repoId: ownRepo, fullName: 'acme/web' }]);
    expect(kicks).toContainEqual([1, ownWs]);
    const read = await store.readSprintRead(1, ownWs);
    expect(read).not.toBeNull();
    expect(await store.readSprintRead(1, foreignWs)).toBeNull();
  });

  it('aiEnabled false → labels off and no label chips', async () => {
    const out = await fold.getSprintStories(1, ownWs, { aiEnabled: false, now: Date.now() });
    expect(out.aiEnabled).toBe(false);
    const eng1 = out.tickets.find((t) => t.key === 'ENG-1')!;
    expect(eng1.labels).toBe('off');
    expect(eng1.chips).toEqual([]);
  });
});

describe('a stored read of another tracker site', () => {
  it('reads as "Reading…" (no time, no source), is made due and kicked; then stays put', async () => {
    const shared = await import('@pierre-review/shared');
    const t = schema.sprintReads;
    const { and, eq } = await import('drizzle-orm');
    const where = and(eq(t.accountId, 1), eq(t.workspaceId, ownWs));
    const old = new Date(Date.now() - 60_000);
    await db
      .update(t)
      .set({
        provider: 'jira',
        apiRoot: 'https://old.atlassian.net',
        readAt: old,
        checkedAt: old,
        sourceJson: { kind: 'sprint', provider: 'jira', names: ['Old'] },
        nextReadAt: new Date(Date.now() + 3_600_000),
      })
      .where(where)
      .execute();
    kicks.length = 0;
    const out = await fold.getSprintStories(1, ownWs, { aiEnabled: true, now: Date.now() });
    expect(out.read.readAt).toBeNull();
    expect(out.source).toBeNull();
    expect(kicks).toContainEqual([1, ownWs]);
    const [row] = await db.select().from(t).where(where).execute();
    expect(row).toMatchObject({ apiRoot: ROOT, provider: 'jira', readAt: null });
    expect(row.nextReadAt.getTime()).toBe(0);
    // The replace base: the full stored text's hash, and whether the wire cut it.
    const eng1 = out.tickets.find((x) => x.key === 'ENG-1')!;
    expect(eng1.replaceBase.truncated).toBe(false);
    expect(eng1.replaceBase.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(shared.sprintReplaceBaseText(eng1, eng1.replaceTarget)).toBe(VALUE);
  });
});

describe('PUT /api/sprint-stories/repos', () => {
  const ident = () => `jira:${ROOT}#ENG-1`;
  const put = (payload: unknown) => app.inject({ method: 'PUT', url: '/api/sprint-stories/repos', payload: payload as any });

  it('replaces the accepted set; the list then shows it', async () => {
    const res = await put({ workspaceId: ownWs, ident: ident(), repoIds: [ownRepo] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ workspaceId: ownWs, ident: ident(), accepted: [{ repoId: ownRepo, fullName: 'acme/web' }] });
    const list = (await app.inject({ method: 'GET', url: '/api/sprint-stories' })).json() as any;
    expect(list.tickets.find((t: any) => t.key === 'ENG-1').repos.accepted).toEqual([{ repoId: ownRepo, fullName: 'acme/web' }]);
  });

  it('refusals', async () => {
    expect((await put({ workspaceId: ownWs, ident: ident(), repoIds: [1, 2, 3, 4, 5, 6, 7] })).json().error).toBe('too_many');
    // A foreign workspace id lands on the caller's Default, where the foreign repo is not a member.
    const foreign = await put({ workspaceId: foreignWs, ident: ident(), repoIds: [foreignRepo] });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().error).toBe('bad_repo');
    const missing = await put({ workspaceId: ownWs, ident: `jira:${ROOT}#NOPE-1`, repoIds: [] });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe('no_ticket');
    expect((await put({ workspaceId: 'x', ident: ident(), repoIds: [] })).statusCode).toBe(400);
    expect((await put({ workspaceId: ownWs, ident: ident(), repoIds: ['1'] })).statusCode).toBe(400);
    // Nothing was written by a refusal.
    const list = (await app.inject({ method: 'GET', url: '/api/sprint-stories' })).json() as any;
    expect(list.tickets.find((t: any) => t.key === 'ENG-1').repos.accepted).toEqual([{ repoId: ownRepo, fullName: 'acme/web' }]);
  });
});

describe('PUT /api/sprint-stories/checks', () => {
  const put = (payload: unknown) => app.inject({ method: 'PUT', url: '/api/sprint-stories/checks', payload: payload as any });

  it('stores the checks; the list echoes them and drops the switched-off chips', async () => {
    const before = (await app.inject({ method: 'GET', url: '/api/sprint-stories' })).json() as any;
    const checks = { off: ['no_persona'], issueTypes: { no_criteria: ['Story'] } };
    const res = await put({ workspaceId: ownWs, checks });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ workspaceId: ownWs, checks });
    const list = (await app.inject({ method: 'GET', url: '/api/sprint-stories' })).json() as any;
    expect(list.checks).toEqual(checks);
    for (const t of list.tickets) {
      expect(t.chips.some((c: any) => c.id === 'no_persona')).toBe(false);
      expect(t.flagCount).toBe(t.chips.length);
    }
    expect(Array.isArray(list.issueTypes)).toBe(true);
    expect(before.checks).toEqual({ off: [], issueTypes: {} });
    // Back to the defaults.
    await put({ workspaceId: ownWs, checks: { off: [], issueTypes: {} } });
    expect(((await app.inject({ method: 'GET', url: '/api/sprint-stories' })).json() as any).checks).toEqual({ off: [], issueTypes: {} });
  });

  it('refuses malformed checks and writes nothing', async () => {
    for (const checks of [{ off: ['nope'], issueTypes: {} }, { off: 'x' }, { off: [], issueTypes: { no_persona: [''] } }, null]) {
      expect((await put({ workspaceId: ownWs, checks })).statusCode).toBe(400);
    }
    expect((await put({ workspaceId: 'x', checks: { off: [], issueTypes: {} } })).statusCode).toBe(400);
    expect(((await app.inject({ method: 'GET', url: '/api/sprint-stories' })).json() as any).checks).toEqual({ off: [], issueTypes: {} });
  });
});
