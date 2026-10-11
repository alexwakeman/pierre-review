// Reports → This sprint — the CORE read routes (api/routes/sprint-stories.ts) and the list fold
// (db/sprint-stories.ts), on a THROWAWAY sqlite DB with a real Fastify instance. Pinned:
//   1. Pro on `periodReports`: 402 before any DB work (GET and PUT).
//   2. Another tenant's workspace id resolves to the caller's Default (never theirs, never a 404).
//   3. Order: stage (Not started, In progress, In review, Done), then status section, then most flags,
//      then key. Done tickets are counted and listed last; out-of-sprint and other tenants' tickets never
//      listed. The response carries the status layout (`statusLayout`) and each row its `stage`.
//   4. A view stamps `sprint_reads.viewed_at` and kicks a due read; a view listing a PENDING label asks
//      for the label run (the after-read hook), deduped.
//   5. Issues: a CURRENT label feeds the label half (criterion reasons, a named ticket resolved through
//      stored tickets, spec gaps); tracker links raise "Blocked" with no label (a done link does not);
//      `aiEnabled` false → 'off' and only code issues.
//   7. PUT /api/sprint-stories/checks: strict on a post; a stored old-shape value reads as defaults.
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
    ticket(1, ownWs, 'ENG-3', {
      description: 'Fix it',
      blockedByJson: [
        { key: 'ENG-8', title: 'Payments API', status: 'To Do', category: 'new', relation: 'is blocked by', url: 'https://acme.atlassian.net/browse/ENG-8' },
        { key: 'ENG-6', title: 'Old spike', status: 'Done', category: 'done', relation: 'depends on', url: null },
      ],
    }),
    ticket(1, ownWs, 'ENG-4', { statusName: 'Done', statusCategory: 'done' }),
    ticket(1, ownWs, 'ENG-5', { inSprint: false }),
    // Named by ENG-1's label: a stored ticket, out of the sprint — resolved for its title and status.
    ticket(1, ownWs, 'ENG-7', { inSprint: false, title: 'Cookie banner', statusName: 'In Progress', statusCategory: 'indeterminate' }),
    ticket(2, foreignWs, 'ENG-9', {}),
  ]).execute();
  // A CURRENT label on ENG-1: criterion 2 not testable, one named dependency (ENG-7), one spec gap.
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
        { n: 1, testable: true, reason: null },
        { n: 2, testable: false, reason: 'no expected result' },
      ],
      storyJson: {
        dependencies: [{ kind: 'ticket', what: 'banner', owner: 'UCD team', ticketKey: 'eng-7' }],
        gaps: [{ type: 'edge_case', text: 'No behaviour when the basket is empty' }],
      },
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
      { method: 'PUT' as const, url: '/api/sprint-stories/checks', payload: { workspaceId: ownWs, checks: { off: [], issueTypes: [] } } },
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
    expect(body.tickets.map((t: any) => [t.key, t.phase, t.stage, t.flagCount])).toEqual([
      ['ENG-1', 'not_started', 'not_started', 2],
      ['ENG-3', 'not_started', 'not_started', 1],
      ['ENG-2', 'in_progress', 'in_progress', 1],
      // Done tickets are listed now, last.
      ['ENG-4', 'done', 'done', 0],
    ]);
    const eng1 = body.tickets[0];
    expect(eng1.labels).toBe('current');
    expect(eng1.issues).toEqual([
      { id: 'unclear_done', total: 2, reasons: ['untestable'], criteria: [{ n: 2, reason: 'no expected result' }], blockers: [], gaps: [] },
      {
        id: 'blocked',
        total: 2,
        reasons: ['named'],
        criteria: [],
        blockers: [
          {
            source: 'text',
            kind: 'ticket',
            ticketKey: 'eng-7',
            what: 'Cookie banner',
            owner: 'UCD team',
            status: 'In Progress',
            category: 'indeterminate',
            relation: null,
            url: 'https://acme.atlassian.net/browse/ENG-7',
            resolved: false,
          },
        ],
        gaps: [],
      },
    ]);
    // Spec gaps are not a chip: they ride apart, for the opened card's own section.
    expect(eng1.specGaps).toEqual([{ type: 'edge_case', text: 'No behaviour when the basket is empty' }]);
    expect(body.tickets[1].specGaps).toEqual([]);
    // ENG-3: a tracker link raises Blocked with no label; the done link is dropped (`isRealStoryBlocker`).
    const eng3 = body.tickets[1];
    expect(eng3.issues.map((i: any) => i.id)).toEqual(['blocked']);
    expect(eng3.issues[0].reasons).toEqual(['linked']);
    expect(eng3.issues[0].blockers.map((b: any) => [b.ticketKey, b.resolved])).toEqual([['ENG-8', false]]);
    expect(body.tickets[2].issues.map((i: any) => i.id)).toEqual(['unclear_done']);
    // Anchored findings ride every ticket, built server-side (db/sprint-findings.ts).
    expect(eng1.findings.map((f: any) => [f.id, f.issue, f.source])).toEqual([
      ['u-c2', 'unclear_done', 'code'],
      ['b-0', 'blocked', 'code'],
      ['g-0', 'spec_gaps', 'code'],
    ]);
    expect(eng3.findings.map((f: any) => [f.id, f.rule])).toEqual([['b-0', 'waits_on_ticket']]);
    // The status layout: no stored board order → the category fallback over the sprint's statuses.
    expect(body.statusLayout.order.map((o: any) => [o.name, o.category, o.count])).toEqual([
      ['To Do', 'new', 2],
      ['In Progress', 'indeterminate', 1],
      ['Done', 'done', 1],
    ]);
    expect([body.statusLayout.codingBegins, body.statusLayout.codingEnds]).toEqual(['In Progress', null]);
    expect(eng1.replaceTarget).toEqual({ kind: 'description' });
    // The workspace's ONLY repo is a confident suggestion: accepted by default until the reader saves.
    expect(eng1.repos).toEqual({ accepted: [{ repoId: ownRepo, fullName: 'acme/web' }], suggested: [], defaulted: true });
    expect(body.repos).toEqual([{ repoId: ownRepo, fullName: 'acme/web' }]);
    expect(kicks).toContainEqual([1, ownWs]);
    const read = await store.readSprintRead(1, ownWs);
    expect(read).not.toBeNull();
    expect(await store.readSprintRead(1, foreignWs)).toBeNull();
  });

  it('a view listing a pending label asks for the label run (the after-read hook), once a minute', async () => {
    const hooks = await import('../../tracker/sprint/hooks.js');
    const { config } = await import('../../config.js');
    hooks.resetSprintViewDedupe();
    const fired: Array<[number, number]> = [];
    hooks.setAfterSprintRead((a, w) => void fired.push([a, w]));
    try {
      const body = (await app.inject({ method: 'GET', url: `/api/sprint-stories?workspace=${ownWs}` })).json() as any;
      const pending = body.tickets.filter((t: any) => t.labels === 'pending').length;
      expect(pending > 0).toBe(config.aiEnabled);
      await app.inject({ method: 'GET', url: `/api/sprint-stories?workspace=${ownWs}` });
      expect(fired).toEqual(config.aiEnabled ? [[1, ownWs]] : []);
    } finally {
      hooks.setAfterSprintRead(null);
      hooks.resetSprintViewDedupe();
    }
  });

  it('aiEnabled false → labels off and no label issues', async () => {
    const out = await fold.getSprintStories(1, ownWs, { aiEnabled: false, now: Date.now() });
    expect(out.aiEnabled).toBe(false);
    const eng1 = out.tickets.find((t) => t.key === 'ENG-1')!;
    expect(eng1.labels).toBe('off');
    expect(eng1.issues).toEqual([]);
    expect(out.tickets.find((t) => t.key === 'ENG-2')!.issues.map((i) => i.id)).toEqual(['unclear_done']);
    // Links are code: they still raise Blocked with labels off.
    expect(out.tickets.find((t) => t.key === 'ENG-3')!.issues.map((i) => i.id)).toEqual(['blocked']);
  });
});

describe('sortSprintTickets', () => {
  it('stage, then the status section in layout order, then most flags, then key', () => {
    const row = (key: string, stage: string, status: string, flagCount: number) => ({ key, stage, status: { name: status, category: null }, flagCount }) as any;
    const layout = { order: [{ name: 'To Do' }, { name: 'In Development' }, { name: 'Ready for QA' }, { name: 'In PO Review' }] } as any;
    const out = fold.sortSprintTickets(
      [
        row('A-11', 'done', 'Done', 5),
        row('A-9', 'in_review', 'In PO Review', 0),
        row('A-1', 'in_progress', 'Ready for QA', 3),
        row('A-2', 'in_progress', 'In Development', 0),
        row('A-3', 'in_progress', 'in development', 2),
        row('A-4', 'not_started', 'To Do', 0),
        row('A-10', 'in_progress', 'Unknown', 9),
      ],
      layout,
    );
    expect(out.map((r: any) => r.key)).toEqual(['A-4', 'A-3', 'A-2', 'A-1', 'A-10', 'A-9', 'A-11']);
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
    // No criteria field of its own: only the description is replaceable.
    expect(eng1.replaceBases.acceptanceCriteria).toBeNull();
    expect(eng1.replaceBases.description).toMatchObject({ truncated: false, hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
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
  const list = async () => (await app.inject({ method: 'GET', url: '/api/sprint-stories' })).json() as any;
  const DEFAULTS = { off: [], issueTypes: [] };

  it('stores the checks; the list echoes them and drops the switched-off issues', async () => {
    const before = await list();
    expect(before.checks).toEqual(DEFAULTS);
    const res = await put({ workspaceId: ownWs, checks: { off: ['spec_gaps'], issueTypes: [' Story ', 'story', 'Bug'] } });
    expect(res.statusCode).toBe(200);
    const checks = { off: ['spec_gaps'], issueTypes: ['Story', 'Bug'] };
    expect(res.json()).toEqual({ workspaceId: ownWs, checks });
    const after = await list();
    expect(after.checks).toEqual(checks);
    // ENG-1 has no issue type, so it is checked; only its spec gaps section is switched off.
    expect(after.tickets.find((t: any) => t.key === 'ENG-1').issues.map((i: any) => i.id)).toEqual(['unclear_done', 'blocked']);
    expect(after.tickets.find((t: any) => t.key === 'ENG-1').specGaps).toEqual([]);
    for (const t of after.tickets) expect(t.flagCount).toBe(t.issues.length);
    expect(Array.isArray(after.issueTypes)).toBe(true);
    // Back to the defaults, stored as NULL.
    await put({ workspaceId: ownWs, checks: DEFAULTS });
    expect((await list()).checks).toEqual(DEFAULTS);
    const { eq } = await import('drizzle-orm');
    const [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, ownWs)).execute();
    expect(ws.sprintChecks).toBeNull();
  });

  it('a ticket whose type is not listed shows no issues and is still listed', async () => {
    const { eq, and } = await import('drizzle-orm');
    const t = schema.sprintTickets;
    await db.update(t).set({ issueTypeName: 'Bug' }).where(and(eq(t.accountId, 1), eq(t.issueKey, 'ENG-1'))).execute();
    await put({ workspaceId: ownWs, checks: { off: [], issueTypes: ['Story'] } });
    const eng1 = (await list()).tickets.find((x: any) => x.key === 'ENG-1');
    expect(eng1.issues).toEqual([]);
    expect(eng1.flagCount).toBe(0);
    await db.update(t).set({ issueTypeName: null }).where(and(eq(t.accountId, 1), eq(t.issueKey, 'ENG-1'))).execute();
    await put({ workspaceId: ownWs, checks: DEFAULTS });
  });

  it('an old stored shape reads as the defaults (unknown ids dropped, object issueTypes → [])', async () => {
    const { eq } = await import('drizzle-orm');
    await db.update(schema.workspaces).set({ sprintChecks: { off: ['no_persona'], issueTypes: {} } }).where(eq(schema.workspaces.id, ownWs)).execute();
    expect((await list()).checks).toEqual(DEFAULTS);
    await db
      .update(schema.workspaces)
      .set({ sprintChecks: { off: ['no_persona', 'too_big', 'scope_unstated', 'blocked'], issueTypes: { no_criteria: ['Story'] } } })
      .where(eq(schema.workspaces.id, ownWs))
      .execute();
    // The retired ids (too_big, scope_unstated) are dropped; a current one survives.
    expect((await list()).checks).toEqual({ off: ['blocked'], issueTypes: [] });
    await db.update(schema.workspaces).set({ sprintChecks: null }).where(eq(schema.workspaces.id, ownWs)).execute();
  });

  it('refuses malformed checks and writes nothing', async () => {
    for (const checks of [
      { off: ['nope'], issueTypes: [] },
      { off: ['no_persona'], issueTypes: [] },
      { off: ['too_big'], issueTypes: [] },
      { off: 'x' },
      { off: [], issueTypes: {} },
      { off: [], issueTypes: [''] },
      { off: [], issueTypes: ['x'.repeat(81)] },
      { off: [], issueTypes: ['a\u0007b'] },
      { off: [], issueTypes: Array.from({ length: 41 }, (_, k) => `T${k}`) },
      null,
    ]) {
      expect((await put({ workspaceId: ownWs, checks })).statusCode).toBe(400);
    }
    expect((await put({ workspaceId: 'x', checks: DEFAULTS })).statusCode).toBe(400);
    expect((await list()).checks).toEqual(DEFAULTS);
  });
});
