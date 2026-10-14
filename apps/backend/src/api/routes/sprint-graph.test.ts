// Activity → This Sprint as a GRAPH — the CORE routes (api/routes/sprint-stories.ts) and the graph fold's
// DB half (db/sprint-graph.ts), on a THROWAWAY sqlite DB with a real Fastify instance. Pinned:
//   1. FREE: no `periodReports` 402 (GET graph, GET ticket, PUT repos) — This Sprint left Reports.
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
//   8. The drawer: brief, references (links + brief, `inGraph`), the ticket tab's PR fold, repos and
//      `found: false` for a non-node.
//   9. PUT /api/sprint-stories/repos: replace, too_many, bad_repo, no_ticket, bad_request.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const DB_PATH = '/private/tmp/claude-501/pierre-sprint-graph-route-test.sqlite';
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

describe('no Pro gate (This Sprint is free)', () => {
  it('answers without periodReports', async () => {
    setCaps?.(emptyCaps);
    try {
      for (const r of [
        { method: 'GET' as const, url: '/api/sprint-graph' },
        { method: 'GET' as const, url: `/api/sprint-graph/ticket?ident=${encodeURIComponent(id('ENG-1'))}` },
      ]) {
        const res = await app.inject(r);
        expect(res.statusCode).toBe(200);
      }
      // A ticket that is not in the list: the route ran (404 no_ticket), it was not paywalled.
      const put = await app.inject({ method: 'PUT', url: '/api/sprint-stories/repos', payload: { workspaceId: ownWs, ident: 'x', repoIds: [] } });
      expect(put.statusCode).not.toBe(402);
    } finally {
      setCaps?.(fullCaps);
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
    expect(n('ENG-1').brief).toEqual({ state: 'current', summary: 'Brief ENG-1', criteriaCount: 1, criteriaDerived: false });
    // A brief of an older text is pending and draws nothing (no ENG-4 → ENG-1 supersedes edge).
    expect(n('ENG-4').brief.state).toBe('pending');
    expect(n('ENG-8').brief).toEqual({ state: 'pending', summary: null, criteriaCount: 0, criteriaDerived: false });
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
    expect(body.repos).toEqual([{ repoId: ownRepo, fullName: 'acme/web' }]);
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

describe('the sprint story on the graph', () => {
  it('the last story shows even after its input moved, marked stale; the status says where the pass stands', async () => {
    const st = await import('../../db/sprint-story.js');
    st.resetSprintStoryFlight();
    const before = await graph.getSprintGraph(1, ownWs, { aiEnabled: true, now: Date.now(), storyCanRun: true });
    // The fixture sprint has enough tickets for a story: AI on + a credential ⇒ waiting for the next read.
    expect(before).toMatchObject({ story: null, storyStatus: { state: 'waiting', stale: false, lastAttemptAt: null, failure: null } });
    // No credential: never "waiting" for ever.
    const noCred = await graph.getSprintGraph(1, ownWs, { aiEnabled: true, now: Date.now(), storyCanRun: false });
    expect(noCred).toMatchObject({ story: null, storyStatus: { state: 'none' } });
    // In flight: queued by the after-read chain, then writing while the pass holds its slot.
    st.markSprintStoryQueued(1, ownWs, true);
    expect((await graph.getSprintGraph(1, ownWs, { aiEnabled: true, now: Date.now(), storyCanRun: true })).storyStatus.state).toBe('queued');
    expect(st.claimSprintStoryPass(1, ownWs)).toBe(true);
    expect((await graph.getSprintGraph(1, ownWs, { aiEnabled: true, now: Date.now(), storyCanRun: true })).storyStatus.state).toBe('writing');
    st.releaseSprintStoryPass(1, ownWs);
    st.markSprintStoryQueued(1, ownWs, false);
    // A failed pass for TODAY's input: 'failed' with its reason (the backoff holds it).
    const hash = (await graph.sprintStoryTodo(1, ownWs))!.inputHash;
    await st.recordSprintStoryAttempt(1, ownWs, hash, 'number', new Date('2026-10-14T19:00:00Z'));
    expect((await graph.getSprintGraph(1, ownWs, { aiEnabled: true, now: Date.now(), storyCanRun: true })).storyStatus).toEqual({
      state: 'failed',
      stale: false,
      lastAttemptAt: '2026-10-14T19:00:00.000Z',
      failure: 'number',
    });
    // Another tenant's attempt row is not ours.
    expect(await st.sprintStoryAttempt(2, ownWs)).toBeNull();
    // A story stored for an OLDER input (a PR merged since): still shown, marked stale.
    await st.storeSprintStory(1, ownWs, 'an-older-input-hash', {
      headline: 'Baskets are under way.',
      focus: 'The sprint is about baskets.',
      storylines: [{ kind: 'chain', title: 'Baskets', sentence: 'ENG-1 waits on ENG-2.', idents: [id('ENG-1')] }],
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    const after = await graph.getSprintGraph(1, ownWs, { aiEnabled: true, now: Date.now(), storyCanRun: true });
    expect(after.story?.headline).toBe('Baskets are under way.');
    expect(after.storyStatus).toMatchObject({ state: 'failed', stale: true });
    // Written for today's input: current.
    await st.storeSprintStory(1, ownWs, hash, {
      headline: 'Baskets are under way.',
      focus: 'The sprint is about baskets.',
      storylines: [{ kind: 'chain', title: 'Baskets', sentence: 'ENG-1 waits on ENG-2.', idents: [id('ENG-1')] }],
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect((await graph.getSprintGraph(1, ownWs, { aiEnabled: true, now: Date.now(), storyCanRun: true })).storyStatus).toMatchObject({ state: 'current', stale: false });
    // AI off: no story at all.
    expect(await graph.getSprintGraph(1, ownWs, { aiEnabled: false, now: Date.now() })).toMatchObject({ story: null, storyStatus: { state: 'none' } });
    const { and, eq } = await import('drizzle-orm');
    await db.delete(schema.sprintStory).where(and(eq(schema.sprintStory.accountId, 1), eq(schema.sprintStory.workspaceId, ownWs))).execute();
    await db
      .update(schema.sprintReads)
      .set({ storyAttemptAt: null, storyAttemptHash: null, storyAttemptError: null })
      .where(and(eq(schema.sprintReads.accountId, 1), eq(schema.sprintReads.workspaceId, ownWs)))
      .execute();
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
    // The story's day facts come from them.
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

describe('GET /api/sprint-graph/ticket', () => {
  const get = (ident: string, ws = ownWs) =>
    app.inject({ method: 'GET', url: `/api/sprint-graph/ticket?workspace=${ws}&ident=${encodeURIComponent(ident)}` });

  it('a sprint ticket: brief, references, the ticket tab PR fold, repos', async () => {
    const res = await get(id('ENG-1'));
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.found).toBe(true);
    expect(body.ticket).toMatchObject({ key: 'ENG-1', ghost: false, depth: 0, stage: 'not_started' });
    expect(body.briefState).toBe('current');
    expect(body.brief).toMatchObject({ summary: 'Brief ENG-1', criteria: [{ n: 1, text: 'The basket survives a reload' }], criteriaDerived: false });
    expect(body.references.map((r: any) => [r.key, r.relation, r.inGraph, r.status])).toEqual([
      ['ENG-7', 'depends_on', true, 'In Progress'],
      ['ENG-2', 'concurrent', true, 'In Progress'],
      // Out of scope: listed in the drawer, no node.
      ['ENG-60', 'out_of_scope', false, 'In Progress'],
    ]);
    // Each reference carries the brief's reason (null when it gave none).
    expect(body.references.map((r: any) => [r.key, r.why])).toEqual([
      ['ENG-7', 'Needs the saved-basket API ENG-7 adds.'],
      ['ENG-2', null],
      ['ENG-60', null],
    ]);
    // Each reference carries its assignee from the stored rows (null = unassigned).
    expect(body.references.map((r: any) => [r.key, r.assignee])).toEqual([
      ['ENG-7', null],
      ['ENG-2', { name: 'Zed', avatarUrl: null }],
      ['ENG-60', null],
    ]);
    expect(body.prs.found).toBe(true);
    expect(body.prs.open.map((p: any) => p.number)).toEqual([12]);
    expect(body.prs.merged.map((p: any) => p.number)).toEqual([11]);
    expect(body.repos).toEqual({ accepted: [{ repoId: ownRepo, fullName: 'acme/web' }], suggested: [], defaulted: true });
    expect(body.assessment).toBeNull();
  });

  it('a ghost: no repos, links as references; a non-node and a foreign ident answer found:false', async () => {
    const ghost = (await get(id('ENG-70'))).json() as any;
    expect(ghost).toMatchObject({ found: true, repos: null, assessment: null, briefState: 'pending', brief: null });
    expect(ghost.ticket).toMatchObject({ key: 'ENG-70', ghost: true, depth: 2 });
    expect(ghost.references.map((r: any) => [r.key, r.relation, r.inGraph])).toEqual([['ENG-700', 'blocked_by', true]]);
    const eng3 = (await get(id('ENG-3'))).json() as any;
    expect(eng3.references.map((r: any) => [r.key, r.relation, r.done])).toEqual([
      ['ENG-8', 'blocked_by', false],
      ['ENG-6', 'linked', true],
    ]);
    // A ticket Limn never read (ENG-6, only a tracker link) makes no assignee claim at all.
    expect(eng3.references.map((r: any) => [r.key, 'assignee' in r])).toEqual([
      ['ENG-8', true],
      ['ENG-6', false],
    ]);
    for (const ident of [id('ENG-60'), id('ENG-5'), id('ENG-9'), 'not an ident']) {
      const r = (await get(ident)).json() as any;
      expect(r).toMatchObject({ found: false, ticket: null, brief: null, references: [] });
    }
    expect((await app.inject({ method: 'GET', url: '/api/sprint-graph/ticket' })).statusCode).toBe(400);
  });
});

describe('PUT /api/sprint-stories/repos', () => {
  const put = (payload: unknown) => app.inject({ method: 'PUT', url: '/api/sprint-stories/repos', payload: payload as any });
  const repos = async () =>
    ((await app.inject({ method: 'GET', url: `/api/sprint-graph/ticket?ident=${encodeURIComponent(id('ENG-1'))}` })).json() as any).repos;

  it('replaces the accepted set; the drawer then shows it', async () => {
    const res = await put({ workspaceId: ownWs, ident: id('ENG-1'), repoIds: [ownRepo] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ workspaceId: ownWs, ident: id('ENG-1'), accepted: [{ repoId: ownRepo, fullName: 'acme/web' }] });
    expect(await repos()).toMatchObject({ accepted: [{ repoId: ownRepo, fullName: 'acme/web' }], defaulted: false });
  });

  it('refusals', async () => {
    expect((await put({ workspaceId: ownWs, ident: id('ENG-1'), repoIds: [1, 2, 3, 4, 5, 6, 7] })).json().error).toBe('too_many');
    const foreign = await put({ workspaceId: foreignWs, ident: id('ENG-1'), repoIds: [foreignRepo] });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().error).toBe('bad_repo');
    const missing = await put({ workspaceId: ownWs, ident: id('NOPE-1'), repoIds: [] });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe('no_ticket');
    expect((await put({ workspaceId: 'x', ident: id('ENG-1'), repoIds: [] })).statusCode).toBe(400);
    expect((await put({ workspaceId: ownWs, ident: id('ENG-1'), repoIds: ['1'] })).statusCode).toBe(400);
    expect((await repos()).accepted).toEqual([{ repoId: ownRepo, fullName: 'acme/web' }]);
  });
});
