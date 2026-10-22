// Activity → This Sprint as a GRAPH — the CORE routes (api/routes/sprint-stories.ts) and the graph fold's
// DB half (db/sprint-graph.ts), on a THROWAWAY sqlite DB with a real Fastify instance. Pinned:
//   1. FREE: no `periodReports` 402 (GET graph, GET ticket-story) — This Sprint left Reports.
//   2. Another tenant's workspace id resolves to the caller's Default (never theirs, never a 404).
//   3. Nodes: the sprint (stage, then key) then GHOSTS reached through an EDGE (a blocking tracker
//      link, a CURRENT brief's depends_on / concurrent / builds_on / supersedes) — chains followed
//      ghost → ghost; an out_of_scope / context reference draws no edge and no node. Other tenants'
//      rows and out-of-sprint rows never listed.
//   4. Edges: deduped, direction from → dependency, tracker beats text, `degree` counts them.
//   5. A STALE brief (text changed) is 'pending' and draws nothing; aiEnabled false → 'off', tracker
//      edges only.
//   6. PRs: every PR on the ticket in THIS workspace's repos (open first), draft + CI.
//   7. A view stamps `sprint_reads.viewed_at` and kicks a due read; a stored read of another site is
//      reset.
//   8. The story view's lean read (GET /api/ticket-story): a sprint ticket's facts, text and CURRENT
//      brief; a ghost's 'pending'; a ticket that left the sprint says nothing will brief it ('none');
//      `found: false` for a ticket Limn holds no text for, another tenant's, or an unparseable ident.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DB_PATH = join(tmpdir(), 'pierre-sprint-graph-route-test.sqlite');
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let app: FastifyInstance;
let closeDb: (() => Promise<void> | void) | undefined;
let db: any;
let schema: any;
let store: typeof import('../../db/sprint-store.js');
let graph: typeof import('../../db/sprint-graph.js');
let ownWs = 0;
let foreignWs = 0;
let ownRepo = 0;
let foreignRepo = 0;
let ROOT = '';
let id = (_k: string): string => '';
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
  if (!have.has(1)) await db.insert(schema.accounts).values({ id: 1, githubUserId: 'U_sg_a', githubLogin: 'sg-a', isLocal: true }).execute();
  if (!have.has(2)) await db.insert(schema.accounts).values({ id: 2, githubUserId: 'U_sg_b', githubLogin: 'sg-b', isLocal: false }).execute();
  ownWs = await q.ensureDefaultWorkspace(1);
  foreignWs = await q.ensureDefaultWorkspace(2);
  const shared = await import('@pierre-review/shared');
  ROOT = shared.jiraApiRoot('https://acme.atlassian.net') as string;
  id = (k: string) => shared.trackerTicketIdent('jira', ROOT, k);
  for (const [accountId, workspaceId] of [
    [1, ownWs],
    [2, foreignWs],
  ]) {
    await db.insert(schema.workspaceTrackers).values({ accountId, workspaceId, provider: 'jira', baseUrl: 'https://acme.atlassian.net' }).execute();
  }
  const [r1] = await db.insert(schema.repos).values({ accountId: 1, githubNodeId: 'R_sg_web', owner: 'acme', name: 'web' }).returning({ id: schema.repos.id }).execute();
  const [r2] = await db.insert(schema.repos).values({ accountId: 2, githubNodeId: 'R_sg_b', owner: 'other', name: 'api' }).returning({ id: schema.repos.id }).execute();
  ownRepo = r1.id;
  foreignRepo = r2.id;
  await q.assignReposToWorkspace(ownWs, 1, [ownRepo]);
  await q.assignReposToWorkspace(foreignWs, 2, [foreignRepo]);

  const ticket = (accountId: number, workspaceId: number, key: string, o: Record<string, unknown>) => ({
    accountId,
    workspaceId,
    ident: id(key),
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
  await db
    .insert(schema.sprintTickets)
    .values([
      ticket(1, ownWs, 'ENG-1', { assigneeName: 'Amy', epicKey: 'ENG-100', epicTitle: 'Baskets' }),
      ticket(1, ownWs, 'ENG-2', { statusName: 'In Progress', statusCategory: 'indeterminate', acceptanceCriteria: '', description: 'Fix it' }),
      ticket(1, ownWs, 'ENG-3', {
        description: 'Fix it',
        blockedByJson: [
          // A BLOCKING tracker link → a depends_on edge to a ghost (ENG-8).
          { key: 'ENG-8', title: 'Payments API', status: 'To Do', category: 'new', relation: 'is blocked by', url: 'https://acme.atlassian.net/browse/ENG-8' },
          // A non-blocking link: no edge (the drawer lists it as 'linked').
          { key: 'ENG-6', title: 'Old spike', status: 'Done', category: 'done', relation: 'relates to', url: null },
        ],
      }),
      ticket(1, ownWs, 'ENG-4', { statusName: 'Done', statusCategory: 'done' }),
      ticket(1, ownWs, 'ENG-5', { inSprint: false }),
      ticket(2, foreignWs, 'ENG-9', {}),
    ])
    .execute();
  // Ghosts the read stored: ENG-7 (named by ENG-1 as depends_on) → ENG-70 (ENG-7's brief: builds_on) →
  // ENG-700 (ENG-70's tracker link). ENG-8 (ENG-3's link). ENG-60 named only as out of scope: no node.
  const ref = (key: string, depth: number, o: Record<string, unknown> = {}) => ({
    accountId: 1,
    workspaceId: ownWs,
    ident: id(key),
    provider: 'jira',
    apiRoot: ROOT,
    issueKey: key,
    title: `Ghost ${key}`,
    statusName: 'In Progress',
    statusCategory: 'indeterminate',
    url: `https://acme.atlassian.net/browse/${key}`,
    readAt: new Date(),
    description: `Ghost ${key} text`,
    acceptanceCriteria: '',
    depth,
    ...o,
  });
  await db
    .insert(schema.sprintRefTickets)
    .values([
      ref('ENG-7', 1),
      ref('ENG-70', 2, {
        blockedByJson: [{ key: 'ENG-700', title: null, status: null, category: null, relation: 'depends on', url: null }],
      }),
      ref('ENG-700', 3, { statusName: 'Done', statusCategory: 'done' }),
      ref('ENG-8', 1, { statusName: 'To Do', statusCategory: 'new' }),
      ref('ENG-60', 1),
    ])
    .execute();
  // A foreign tenant's ghost on the same ident: never read by account 1.
  await db.insert(schema.sprintRefTickets).values({ ...ref('ENG-7', 1), accountId: 2, workspaceId: foreignWs, title: 'FOREIGN' }).execute();

  const briefs = await import('../../db/sprint-briefs.js');
  const brief = async (key: string, row: { title: string; description: string; acceptanceCriteria: string }, refs: any[], summary = `Brief ${key}`) =>
    briefs.storeSprintBrief(1, ownWs, id(key), briefs.sprintBriefInput({ ...row, blockedByJson: null }, 'jira').textHash, {
      summary,
      oneLiner: `Line ${key}`,
      criteria: [{ n: 1, text: 'The basket survives a reload' }],
      criteriaDerived: false,
      references: refs,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
  const eng1Text = { title: 'Story ENG-1', description: VALUE, acceptanceCriteria: '- Basket survives a reload\n- Basket expires after 30 days' };
  await brief('ENG-1', eng1Text, [
    { ticketKey: 'ENG-7', relation: 'depends_on', quote: 'once ENG-7 ships', why: 'Needs the saved-basket API ENG-7 adds.' },
    { ticketKey: 'ENG-2', relation: 'concurrent', quote: null },
    { ticketKey: 'ENG-60', relation: 'out_of_scope', quote: null },
  ]);
  // ENG-2 says the same concurrent thing back: ONE edge.
  await brief('ENG-2', { title: 'Story ENG-2', description: 'Fix it', acceptanceCriteria: '' }, [{ ticketKey: 'ENG-1', relation: 'concurrent', quote: null }]);
  await brief('ENG-7', { title: 'Ghost ENG-7', description: 'Ghost ENG-7 text', acceptanceCriteria: '' }, [{ ticketKey: 'ENG-70', relation: 'builds_on', quote: null }]);
  // A STALE brief (the text has changed since): pending, draws nothing.
  await brief('ENG-4', { title: 'Story ENG-4 (old title)', description: VALUE, acceptanceCriteria: '' }, [{ ticketKey: 'ENG-1', relation: 'supersedes', quote: null }]);

  // PRs on ENG-1: an open draft with red CI, a merged one; one in a repo of another workspace is not listed.
  const pr = async (n: number, state: string, o: Record<string, unknown> = {}) => {
    const [row] = await db
      .insert(schema.pullRequests)
      .values({ accountId: 1, repoId: ownRepo, githubNodeId: `PR_sg_${n}`, number: n, title: `ENG-1 part ${n}`, state, openedAt: new Date(), updatedAt: new Date(), ...o })
      .returning({ id: schema.pullRequests.id })
      .execute();
    await db
      .insert(schema.trackerTickets)
      .values({ accountId: 1, workspaceId: ownWs, prId: row.id, provider: 'jira', issueKey: 'ENG-1', detectedFrom: 'title', detectOrder: 0, apiRoot: ROOT, url: `${ROOT}/browse/ENG-1`, state: 'ok', checkedAt: new Date(), fetchedAt: new Date(), nextCheckAt: new Date() })
      .execute();
    return row.id as number;
  };
  // An unbranded CI account GitHub types as a Bot: `isBot` rides the author (the Members filter drops it).
  const [ci] = await db.insert(schema.users).values({ githubLogin: 'ci-runner', githubType: 'Bot' }).returning({ id: schema.users.id }).execute();
  await pr(11, 'merged', { mergedAt: new Date(Date.now() - 86_400_000), authorId: ci.id });
  const [amy] = await db.insert(schema.users).values({ githubLogin: 'amy-sg', displayName: 'Amy' }).returning({ id: schema.users.id }).execute();
  await pr(12, 'open', { isDraft: true, ciStatus: 'failure', authorId: amy.id });

  store = await import('../../db/sprint-store.js');
  store.setSprintReadKicker((a, w) => kicks.push([a, w]));
  graph = await import('../../db/sprint-graph.js');
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
  await app?.close();
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('no Pro gate (This Sprint is free)', () => {
  it('answers without periodReports', async () => {
    try {
      for (const r of [
        { method: 'GET' as const, url: '/api/sprint-graph' },
        { method: 'GET' as const, url: `/api/ticket-story?ident=${encodeURIComponent(id('ENG-1'))}` },
      ]) {
        const res = await app.inject(r);
        expect(res.statusCode).toBe(200);
      }
    } finally {
    }
  });
});

describe('GET /api/sprint-graph', () => {
  it('nodes, ghost chains, edges, degree, PRs; stamps the view and kicks the read; a foreign id lands on Default', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/sprint-graph?workspace=${foreignWs}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.workspaceId).toBe(ownWs);
    expect(body).toMatchObject({ trackerOn: true, provider: 'jira', source: null, ghostsTruncated: false });
    expect(body.nodes.map((n: any) => [n.key, n.ghost, n.depth, n.stage])).toEqual([
      ['ENG-1', false, 0, 'not_started'],
      ['ENG-3', false, 0, 'not_started'],
      ['ENG-2', false, 0, 'in_progress'],
      ['ENG-4', false, 0, 'done'],
      ['ENG-7', true, 1, 'in_progress'],
      ['ENG-8', true, 1, 'not_started'],
      ['ENG-70', true, 2, 'in_progress'],
      ['ENG-700', true, 3, 'done'],
    ]);
    const key = (ident: string) => body.nodes.find((n: any) => n.ident === ident)?.key;
    expect(body.edges.map((e: any) => [key(e.from), key(e.to), e.kind, e.source]).sort()).toEqual(
      [
        ['ENG-1', 'ENG-7', 'depends_on', 'text'],
        ['ENG-1', 'ENG-2', 'concurrent', 'text'],
        ['ENG-3', 'ENG-8', 'depends_on', 'tracker'],
        ['ENG-7', 'ENG-70', 'builds_on', 'text'],
        ['ENG-70', 'ENG-700', 'depends_on', 'tracker'],
      ].sort(),
    );
    expect(body.edges.find((e: any) => key(e.to) === 'ENG-7').quote).toBe('once ENG-7 ships');
    expect(body.edges.find((e: any) => key(e.to) === 'ENG-7').why).toBe('Needs the saved-basket API ENG-7 adds.');
    const n = (k: string) => body.nodes.find((x: any) => x.key === k);
    expect(n('ENG-1').degree).toBe(2);
    expect(n('ENG-7').degree).toBe(2);
    expect(n('ENG-4').degree).toBe(0);
    expect(n('ENG-1').brief).toEqual({ state: 'current', summary: 'Brief ENG-1', oneLiner: 'Line ENG-1', criteriaCount: 1, criteriaDerived: false });
    // A brief of an older text is pending and draws nothing (no ENG-4 → ENG-1 supersedes edge).
    expect(n('ENG-4').brief.state).toBe('pending');
    expect(n('ENG-8').brief).toEqual({ state: 'pending', summary: null, oneLiner: null, criteriaCount: 0, criteriaDerived: false });
    expect(n('ENG-1').epic).toEqual({ key: 'ENG-100', title: 'Baskets' });
    expect(n('ENG-1').assignee).toEqual({ name: 'Amy', avatarUrl: null });
    expect(n('ENG-7').title).toBe('Ghost ENG-7');
    expect(n('ENG-1').prs.map((p: any) => [p.number, p.state, p.draft, p.ciState])).toEqual([
      [12, 'open', true, 'failure'],
      [11, 'merged', false, null],
    ]);
    expect(n('ENG-1').prs[0].url).toBe('https://github.com/acme/web/pull/12');
    // The PR's author rides along (the Members filter folds it into the ticket's assignee), with the
    // global automation verdict.
    expect(n('ENG-1').prs.map((p: any) => p.author)).toEqual([
      { login: 'amy-sg', name: 'Amy', isBot: false },
      { login: 'ci-runner', name: null, isBot: true },
    ]);
    expect(body.briefs).toEqual({ current: 3, pending: 5 });
    expect(body.statusLayout.order.map((o: any) => o.name)).toEqual(['To Do', 'In Progress', 'Done']);
    expect('repos' in body).toBe(false);
    expect(kicks).toContainEqual([1, ownWs]);
    expect(await store.readSprintRead(1, ownWs)).not.toBeNull();
    expect(await store.readSprintRead(1, foreignWs)).toBeNull();
  });

  it('aiEnabled false → briefs off, tracker edges only', async () => {
    const out = await graph.getSprintGraph(1, ownWs, { aiEnabled: false, now: Date.now() });
    expect(out.nodes.every((n) => n.brief.state === 'off' && n.brief.summary == null)).toBe(true);
    expect(out.nodes.filter((n) => n.ghost).map((n) => n.key)).toEqual(['ENG-8']);
    expect(out.edges.map((e) => e.source)).toEqual(['tracker']);
  });

  it('a stored read of another tracker site reads as "Reading…", is made due and kicked', async () => {
    const t = schema.sprintReads;
    const { and, eq } = await import('drizzle-orm');
    const where = and(eq(t.accountId, 1), eq(t.workspaceId, ownWs));
    const old = new Date(Date.now() - 60_000);
    await db
      .update(t)
      .set({ provider: 'jira', apiRoot: 'https://old.atlassian.net', readAt: old, checkedAt: old, sourceJson: { kind: 'sprint', provider: 'jira', names: ['Old'] }, nextReadAt: new Date(Date.now() + 3_600_000) })
      .where(where)
      .execute();
    kicks.length = 0;
    const out = await graph.getSprintGraph(1, ownWs, { aiEnabled: true, now: Date.now() });
    expect(out.read.readAt).toBeNull();
    expect(out.source).toBeNull();
    expect(kicks).toContainEqual([1, ownWs]);
    const [row] = await db.select().from(t).where(where).execute();
    expect(row).toMatchObject({ apiRoot: ROOT, provider: 'jira', readAt: null });
    expect(row.nextReadAt.getTime()).toBe(0);
  });
});

describe('the sprint builder on the graph', () => {
  it('the last paths show even after their input moved, marked stale; the status says where the pass stands', async () => {
    const st = await import('../../db/sprint-paths.js');
    st.resetSprintPathsFlight();
    const before = await graph.getSprintGraph(1, ownWs, { aiEnabled: true, now: Date.now(), pathsCanRun: true });
    // The fixture sprint has enough tickets: AI on + a credential ⇒ waiting for the next read.
    expect(before).toMatchObject({ paths: null, pathsStatus: { state: 'waiting', stale: false, lastAttemptAt: null, failure: null } });
    // No credential: never "waiting" for ever.
    expect(await graph.getSprintGraph(1, ownWs, { aiEnabled: true, now: Date.now(), pathsCanRun: false })).toMatchObject({ pathsStatus: { state: 'none' } });
    // In flight: queued by the after-read chain, then writing while the pass holds its slot.
    st.markSprintPathsQueued(1, ownWs, true);
    expect((await graph.getSprintGraph(1, ownWs, { aiEnabled: true, now: Date.now(), pathsCanRun: true })).pathsStatus.state).toBe('queued');
    expect(st.claimSprintPathsPass(1, ownWs)).toBe(true);
    expect((await graph.getSprintGraph(1, ownWs, { aiEnabled: true, now: Date.now(), pathsCanRun: true })).pathsStatus.state).toBe('writing');
    st.releaseSprintPathsPass(1, ownWs);
    st.markSprintPathsQueued(1, ownWs, false);
    // The todo builds the SAME input the GET hashes.
    const input = (await graph.sprintPathsTodo(1, ownWs))!;
    expect(input.keys).toEqual(expect.arrayContaining(['ENG-1', 'ENG-2', 'ENG-3', 'ENG-4', 'ENG-7', 'ENG-8']));
    expect(input.keys).not.toContain('ENG-70');
    // A failed pass for TODAY's input: 'failed' with its reason (the backoff holds it).
    await st.recordSprintPathsAttempt(1, ownWs, input.inputHash, 'refused', new Date('2026-10-14T19:00:00Z'));
    expect((await graph.getSprintGraph(1, ownWs, { aiEnabled: true, now: Date.now(), pathsCanRun: true })).pathsStatus).toEqual({
      state: 'failed',
      stale: false,
      lastAttemptAt: '2026-10-14T19:00:00.000Z',
      failure: 'refused',
    });
    expect(await st.storedSprintPaths(2, ownWs)).toBeNull();
    // Paths stored for an OLDER input: still shown (idents resolved from the keys), marked stale.
    const v = {
      paths: [{ title: 'Saved baskets', tickets: ['ENG-7', 'ENG-1'], advice: 'Land the basket API first.', risk: 'high' as const }],
      callouts: [{ title: 'Nobody owns these', tickets: ['ENG-3'] }],
      costUsd: 0.2,
      inputTokens: 1,
      outputTokens: 1,
    };
    await st.storeSprintPaths(1, ownWs, 'an-older-input-hash', v);
    const after = await graph.getSprintGraph(1, ownWs, { aiEnabled: true, now: Date.now(), pathsCanRun: true });
    expect(after.paths?.paths).toEqual([{ title: 'Saved baskets', tickets: ['ENG-7', 'ENG-1'], idents: [id('ENG-7'), id('ENG-1')], advice: 'Land the basket API first.', risk: 'high' }]);
    expect(after.paths?.callouts).toEqual([{ title: 'Nobody owns these', tickets: ['ENG-3'], idents: [id('ENG-3')] }]);
    expect(after.pathsStatus).toMatchObject({ state: 'failed', stale: true });
    // Written for today's input: current.
    await st.storeSprintPaths(1, ownWs, input.inputHash, v);
    expect((await graph.getSprintGraph(1, ownWs, { aiEnabled: true, now: Date.now(), pathsCanRun: true })).pathsStatus).toMatchObject({ state: 'current', stale: false });
    // AI off: no paths at all.
    expect(await graph.getSprintGraph(1, ownWs, { aiEnabled: false, now: Date.now() })).toMatchObject({ paths: null, pathsStatus: { state: 'none' } });
    const { and, eq } = await import('drizzle-orm');
    await db.delete(schema.sprintPaths).where(and(eq(schema.sprintPaths.accountId, 1), eq(schema.sprintPaths.workspaceId, ownWs))).execute();
  });

  it('the daily cap: today\'s runs used up reads as failed (daily_cap) until the UTC day turns', async () => {
    const st = await import('../../db/sprint-paths.js');
    const { config } = await import('../../config.js');
    const now = new Date();
    for (let i = 0; i < config.sprintPathsDailyCap; i += 1) await st.noteSprintPathsRun(1, ownWs, now);
    expect((await st.storedSprintPaths(1, ownWs))?.runsToday).toBe(config.sprintPathsDailyCap);
    expect((await graph.getSprintGraph(1, ownWs, { aiEnabled: true, now: now.getTime(), pathsCanRun: true })).pathsStatus).toMatchObject({ state: 'failed', failure: 'daily_cap' });
    // The next UTC day: the count starts again.
    expect(st.runsTodayOf(await st.storedSprintPaths(1, ownWs), new Date(now.getTime() + 86_400_000))).toBe(0);
    const { and, eq } = await import('drizzle-orm');
    await db.delete(schema.sprintPaths).where(and(eq(schema.sprintPaths.accountId, 1), eq(schema.sprintPaths.workspaceId, ownWs))).execute();
  });

  it('pace and people: code counts; reviews waiting through the member mapping, null when unmapped', async () => {
    const g = await graph.getSprintGraph(1, ownWs, { aiEnabled: true, now: Date.now() });
    // ENG-1 (To Do), ENG-2 (In Progress), ENG-3 (To Do), ENG-4 (Done); no sprint dates in OSS. Open
    // dependencies: ENG-1 → ENG-7 (a brief's depends_on) and ENG-3 → ENG-8 (a tracker link).
    expect(g.pace).toEqual({
      daysElapsed: null,
      daysTotal: null,
      timeUsedPct: null,
      tickets: 4,
      live: 3,
      done: 1,
      productReview: 0,
      codeMerged: 0,
      openDependencies: 2,
      chains: 2,
    });
    // Amy maps to amy-sg (her PR on ENG-1); Zed has no GitHub account mapped → null, never 0.
    expect(g.people).toEqual([
      { name: 'Amy', names: ['Amy'], reviewsWaiting: 0 },
      { name: 'Zed', names: ['Zed'], reviewsWaiting: null },
    ]);
    // An open PR in this workspace waiting on Amy's review counts; a merged one does not.
    const [amy] = await db.select({ id: schema.users.id }).from(schema.users).where((await import('drizzle-orm')).eq(schema.users.githubLogin, 'amy-sg')).execute();
    const mk = async (n: number, state: string) => {
      const [row] = await db
        .insert(schema.pullRequests)
        .values({ accountId: 1, repoId: ownRepo, githubNodeId: `PR_sg_rr_${n}`, number: n, title: `Other ${n}`, state, openedAt: new Date(), updatedAt: new Date() })
        .returning({ id: schema.pullRequests.id })
        .execute();
      await db.insert(schema.reviewRequests).values({ prId: row.id, userId: amy.id }).execute();
      return row.id as number;
    };
    const ids = [await mk(901, 'open'), await mk(902, 'merged')];
    const again = await graph.getSprintGraph(1, ownWs, { aiEnabled: false, now: Date.now() });
    expect(again.people.find((p) => p.name === 'Amy')?.reviewsWaiting).toBe(1);
    const { inArray } = await import('drizzle-orm');
    await db.delete(schema.reviewRequests).where(inArray(schema.reviewRequests.prId, ids)).execute();
    await db.delete(schema.pullRequests).where(inArray(schema.pullRequests.id, ids)).execute();
  });

  it('sprintDates: the tracker\'s own dates; none → null (no cadence in OSS)', async () => {
    const { and, eq } = await import('drizzle-orm');
    const where = and(eq(schema.sprintReads.accountId, 1), eq(schema.sprintReads.workspaceId, ownWs));
    expect((await graph.getSprintGraph(1, ownWs, { aiEnabled: false, now: Date.now() })).sprintDates).toBeNull();
    await db
      .update(schema.sprintReads)
      .set({ sourceJson: { kind: 'sprint', provider: 'jira', names: ['Sprint 15'] }, sprintStartsAt: new Date('2026-10-14T10:15:00Z'), sprintEndsAt: new Date('2026-10-27T17:00:00Z') })
      .where(where)
      .execute();
    expect((await graph.getSprintGraph(1, ownWs, { aiEnabled: false, now: Date.now() })).sprintDates).toEqual({
      startsAt: '2026-10-14T10:15:00.000Z',
      endsAt: '2026-10-27T17:00:00.000Z',
      source: 'tracker',
    });
    // The pace's day facts come from them.
    const t = await graph.sprintTimingFor(1, ownWs, { kind: 'sprint', provider: 'jira', names: ['S'] }, Date.parse('2026-10-20T12:00:00Z'), {
      sprintStartsAt: new Date('2026-10-14T10:15:00Z'),
      sprintEndsAt: new Date('2026-10-27T17:00:00Z'),
    });
    expect(t).toEqual({ day: 7, days: 14, daysLeft: 7 });
    // Never for the status fallback.
    expect(await graph.sprintTimingFor(1, ownWs, { kind: 'status_fallback', provider: 'jira', reason: 'none_active', from: 'x', to: 'y' }, Date.now(), {
      sprintStartsAt: new Date('2026-10-14T10:15:00Z'),
      sprintEndsAt: new Date('2026-10-27T17:00:00Z'),
    })).toBeNull();
    await db.update(schema.sprintReads).set({ sourceJson: null, sprintStartsAt: null, sprintEndsAt: null }).where(where).execute();
  });
});

describe('the code cards (signals) on the graph', () => {
  it('pace, out of step, blocked outside; "since you last looked" only after a visit gap, and it survives refetches', async () => {
    const { and, eq } = await import('drizzle-orm');
    const where = and(eq(schema.sprintReads.accountId, 1), eq(schema.sprintReads.workspaceId, ownWs));
    await db.delete(schema.sprintViewSnapshots).execute();
    await db
      .update(schema.sprintReads)
      .set({ sourceJson: { kind: 'sprint', provider: 'jira', names: ['Sprint 15'] }, sprintStartsAt: new Date('2026-10-14T10:15:00Z'), sprintEndsAt: new Date('2026-10-27T17:00:00Z') })
      .where(where)
      .execute();
    const T = Date.parse('2026-10-20T12:00:00Z');
    const get = (now: number) => graph.getSprintGraph(1, ownWs, { aiEnabled: true, now });
    const first = await get(T);
    const kinds = (x: { signals: Array<{ kind: string }> }) => x.signals.map((s) => s.kind);
    // A first-ever view: no "since you last looked".
    expect(kinds(first)).toEqual(['pace', 'out_of_step', 'blocked_outside']);
    const by = (k: string) => first.signals.find((s) => s.kind === k)!;
    expect(by('pace')).toMatchObject({ title: 'Day 7 of 14', sentence: "50% of the sprint's time has gone and 25% of its tickets are complete (1 of 4)." });
    expect(by('pace').idents.sort()).toEqual([id('ENG-1'), id('ENG-2'), id('ENG-3')].sort());
    expect(by('out_of_step')).toEqual({
      kind: 'out_of_step',
      title: 'Tracker and code disagree',
      sentence: '1 ticket: 1 not started with a draft pull request open.',
      idents: [id('ENG-1')],
    });
    expect(by('blocked_outside').sentence).toBe('2 sprint tickets wait on 2 tickets outside the sprint that are not complete; 1 of them has not started.');
    expect(by('blocked_outside').idents.sort()).toEqual([id('ENG-1'), id('ENG-3'), id('ENG-7'), id('ENG-8')].sort());
    // ENG-2 moves to Done; a refetch inside the gap shows nothing yet (the baseline has not rolled).
    const st = schema.sprintTickets;
    await db.update(st).set({ statusName: 'Done', statusCategory: 'done' }).where(and(eq(st.accountId, 1), eq(st.issueKey, 'ENG-2'))).execute();
    expect(kinds(await get(T + 60_000))).not.toContain('since_last');
    // A new visit after the gap compares against the previous visit's LAST view (T + 1 min, which already
    // saw ENG-2 done — a move seen while looking is not news). ENG-4 moves back while nobody looks.
    await db.update(st).set({ statusName: 'To Do', statusCategory: 'new' }).where(and(eq(st.accountId, 1), eq(st.issueKey, 'ENG-4'))).execute();
    const later = await get(T + 60_000 + 31 * 60_000);
    const since = later.signals.find((s) => s.kind === 'since_last')!;
    expect(later.signals[0]?.kind).toBe('since_last');
    expect(since).toEqual({ kind: 'since_last', title: 'Since 31 minutes ago', sentence: '1 ticket moved to Not started.', idents: [id('ENG-4')] });
    // ⚠ Refetches inside the visit keep the diff (the baseline holds).
    const refetch = await get(T + 60_000 + 33 * 60_000);
    expect(refetch.signals.find((s) => s.kind === 'since_last')?.sentence).toBe('1 ticket moved to Not started.');
    // No sprint dates: no pace.
    await db.update(schema.sprintReads).set({ sprintStartsAt: null, sprintEndsAt: null }).where(where).execute();
    expect(kinds(await get(T + 60_000 + 34 * 60_000))).not.toContain('pace');
    await db.update(st).set({ statusName: 'In Progress', statusCategory: 'indeterminate' }).where(and(eq(st.accountId, 1), eq(st.issueKey, 'ENG-2'))).execute();
    await db.update(st).set({ statusName: 'Done', statusCategory: 'done' }).where(and(eq(st.accountId, 1), eq(st.issueKey, 'ENG-4'))).execute();
    await db.update(schema.sprintReads).set({ sourceJson: null }).where(where).execute();
    await db.delete(schema.sprintViewSnapshots).execute();
  });
});

describe('GET /api/ticket-story', () => {
  const get = (ident: string, ws = ownWs) =>
    app.inject({ method: 'GET', url: `/api/ticket-story?workspace=${ws}&ident=${encodeURIComponent(ident)}` });

  it('a sprint ticket: its facts, its text and its CURRENT brief', async () => {
    const res = await get(id('ENG-1'));
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body).toMatchObject({ workspaceId: ownWs, ident: id('ENG-1'), found: true, briefState: 'current' });
    expect(body.ticket).toMatchObject({
      key: 'ENG-1',
      title: 'Story ENG-1',
      provider: 'jira',
      assignee: { name: 'Amy', avatarUrl: null },
      epic: { key: 'ENG-100', title: 'Baskets' },
      inSprint: true,
    });
    expect(body.brief).toMatchObject({ summary: 'Brief ENG-1', criteria: [{ n: 1, text: 'The basket survives a reload' }], criteriaDerived: false });
    expect(body.story.acceptanceCriteria).toContain('Basket survives a reload');
    // Lean: no PRs, references, repos or assessment ride this read.
    for (const k of ['prs', 'references', 'repos', 'assessment']) expect(k in body).toBe(false);
  });

  it('a ghost is pending; a ticket that left the sprint says nothing will brief it; the rest is found:false', async () => {
    const ghost = (await get(id('ENG-70'))).json() as any;
    expect(ghost).toMatchObject({ found: true, briefState: 'pending', brief: null });
    expect(ghost.ticket).toMatchObject({ key: 'ENG-70', epic: null, inSprint: false });
    const left = (await get(id('ENG-5'))).json() as any;
    expect(left).toMatchObject({ found: true, briefState: 'none', brief: null });
    expect(left.ticket.inSprint).toBe(false);
    // ENG-6: only a tracker link (no row). ENG-9: another tenant's. And an unparseable ident.
    for (const ident of [id('ENG-6'), id('ENG-9'), 'not an ident']) {
      expect((await get(ident)).json()).toMatchObject({ found: false, ticket: null, brief: null, story: null, briefState: 'none' });
    }
    // Another tenant's workspace id lands on the caller's Default (never theirs).
    expect(((await get(id('ENG-1'), foreignWs)).json() as any).workspaceId).toBe(ownWs);
    expect((await app.inject({ method: 'GET', url: '/api/ticket-story' })).statusCode).toBe(400);
  });

  it('a ticket that left the sprint but is still linked from it reads like the graph\'s ghost: the ref row\'s text and brief', async () => {
    const { and, eq } = await import('drizzle-orm');
    const briefs = await import('../../db/sprint-briefs.js');
    const fresh = { title: 'ENG-5 (renamed since)', description: 'New text', acceptanceCriteria: '' };
    await db
      .insert(schema.sprintRefTickets)
      .values({ accountId: 1, workspaceId: ownWs, ident: id('ENG-5'), provider: 'jira', apiRoot: ROOT, issueKey: 'ENG-5', ...fresh, statusName: 'In Review', statusCategory: 'indeterminate', url: null, readAt: new Date(), depth: 1 })
      .execute();
    const pending = (await get(id('ENG-5'))).json() as any;
    expect(pending).toMatchObject({ found: true, briefState: 'pending', brief: null, story: { description: 'New text' } });
    expect(pending.ticket).toMatchObject({ title: 'ENG-5 (renamed since)', status: { name: 'In Review' }, inSprint: false });
    await briefs.storeSprintBrief(1, ownWs, id('ENG-5'), briefs.sprintBriefInput({ ...fresh, blockedByJson: null }, 'jira').textHash, {
      summary: 'Brief of the ref text',
      oneLiner: 'Ref text',
      criteria: [],
      criteriaDerived: true,
      references: [],
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect((await get(id('ENG-5'))).json()).toMatchObject({ briefState: 'current', brief: { summary: 'Brief of the ref text' } });
    const rt = schema.sprintRefTickets;
    await db.delete(rt).where(and(eq(rt.accountId, 1), eq(rt.issueKey, 'ENG-5'))).execute();
    // With no ref row, the old out-of-sprint row again: nothing will brief it.
    expect((await get(id('ENG-5'))).json()).toMatchObject({ briefState: 'none', ticket: { title: 'Story ENG-5' } });
  });
});

describe('ticket checks and the change token', () => {
  const prIdOf = async (n: number): Promise<number> =>
    (await db.select().from(schema.pullRequests).execute()).find((r: any) => r.accountId === 1 && r.number === n).id;
  const graphOf = async () => (await app.inject({ method: 'GET', url: `/api/sprint-graph?workspace=${ownWs}` })).json() as any;
  const tokenOf = async () => {
    const res = await app.inject({ method: 'GET', url: `/api/sprint-graph/token?workspace=${ownWs}` });
    expect(res.statusCode).toBe(200);
    return res.json() as any;
  };

  it('the token GET answers the graph GET\'s token and stamps nothing', async () => {
    const g = await graphOf();
    expect(g.changeToken).toMatch(/^[0-9a-f]{16}$/);
    const before = await store.readSprintRead(1, ownWs);
    const t = await tokenOf();
    expect(t).toEqual({ workspaceId: ownWs, changeToken: g.changeToken });
    expect((await store.readSprintRead(1, ownWs))!.viewedAt?.getTime()).toBe(before!.viewedAt?.getTime());
    // Another tenant's id lands on the caller's Default, never theirs.
    expect((await app.inject({ method: 'GET', url: `/api/sprint-graph/token?workspace=${foreignWs}` })).json()).toEqual(t);
  });

  it('a succeeded ticket check reads as "n of m met"; a member push marks it stale; the token moves with both', async () => {
    const t0 = (await tokenOf()).changeToken;
    const p11 = await prIdOf(11);
    const p12 = await prIdOf(12);
    const assessment = {
      criteria: [
        { n: 1, text: 'Basket survives a reload', status: 'met' },
        { n: 2, text: 'Basket expires after 30 days', status: 'not_met' },
        { n: 3, text: 'Shown on the page', status: 'partly_met' },
      ],
    };
    const [run] = await db
      .insert(schema.ticketReviews)
      .values({ accountId: 1, workspaceId: ownWs, ticketIdent: id('ENG-1'), status: 'succeeded', model: 'claude-opus-5-5', assessment, completedAt: new Date('2026-10-19T10:00:00Z') })
      .returning({ id: schema.ticketReviews.id })
      .execute();
    await db
      .insert(schema.ticketReviewMembers)
      .values([
        { ticketReviewId: run.id, accountId: 1, prId: p11, repoId: ownRepo, headSha: '', prState: 'merged' },
        { ticketReviewId: run.id, accountId: 1, prId: p12, repoId: ownRepo, headSha: '', prState: 'open' },
      ])
      .execute();
    // Another tenant's run on the same ident is never read.
    await db.insert(schema.ticketReviews).values({ accountId: 2, workspaceId: foreignWs, ticketIdent: id('ENG-1'), status: 'running', model: 'claude-opus-5-5' }).execute();
    const g1 = await graphOf();
    const n1 = g1.nodes.find((x: any) => x.key === 'ENG-1');
    expect(n1.check).toEqual({ met: 1, partlyMet: 1, notMet: 1, unsettled: 0, total: 3, checkedAt: '2026-10-19T10:00:00.000Z', stale: false });
    expect(n1.checkRunning).toBe(false);
    expect(g1.nodes.find((x: any) => x.key === 'ENG-2').check).toBeNull();
    expect(g1.nodes.filter((x: any) => x.ghost).every((x: any) => x.check == null && x.checkRunning === false)).toBe(true);
    expect(g1.changeToken).not.toBe(t0);
    expect((await tokenOf()).changeToken).toBe(g1.changeToken);

    await db.update(schema.pullRequests).set({ headSha: 'abc123' }).where((await import('drizzle-orm')).eq(schema.pullRequests.id, p12)).execute();
    const g2 = await graphOf();
    expect(g2.nodes.find((x: any) => x.key === 'ENG-1').check.stale).toBe(true);
    expect(g2.changeToken).not.toBe(g1.changeToken);
    // Nothing changed: the token holds across reads (no clock in it).
    expect((await tokenOf()).changeToken).toBe(g2.changeToken);

    // A queued run reads as running.
    await db.insert(schema.ticketReviews).values({ accountId: 1, workspaceId: ownWs, ticketIdent: id('ENG-2'), status: 'queued', model: 'claude-opus-5-5' }).execute();
    expect((await graphOf()).nodes.find((x: any) => x.key === 'ENG-2').checkRunning).toBe(true);
  });

  it('AI off: no checks are read', async () => {
    const out = await graph.getSprintGraph(1, ownWs, { aiEnabled: false, now: Date.now() });
    expect(out.nodes.every((n) => n.check == null && n.checkRunning === false)).toBe(true);
  });
});
