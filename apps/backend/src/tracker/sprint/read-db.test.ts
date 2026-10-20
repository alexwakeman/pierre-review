import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SprintSource } from '@pierre-review/shared';

// The sprint list read (./read.ts) on a SCRATCH SQLite — never apps/backend/data. Pins:
//   • THE DEMAND GATE: a workspace whose tab was not opened in SPRINT_VIEW_TTL_DAYS is not read; a
//     viewed one is read once, then not again until `next_read_at`; a Refresh mark makes it due.
//   • STORE RULES: upsert on (account, workspace, ident) with `first_seen_at` insert-only; tickets a
//     later read no longer returns flip `in_sprint` false; rows unseen 90 days are pruned; the
//     source + read state land on `sprint_reads`; a failure records a CODE and KEEPS the last list.
//   • THE PROJECT KEYS come from this workspace's stored tickets (+ its allowlist); none → no_projects.
//   • THE FORCED RE-READ: a row at `next_check_at` = epoch 0 is re-read alone, once.
//   • ENTITLEMENT + ISOLATION: an account without Reports is not read; another tenant's rows untouched.
//   • the after-read hook fires on success only.
//   • THE STATUS ORDER + LINKS: a returned order lands on `sprint_reads.status_order_json`; an order
//     read that failed (undefined + a code) keeps the stored order and the list read still succeeds;
//     a ticket's blocking links + status id are stored, and a read that did not carry links keeps them.
//   • REFERENCED TICKETS: one lookup per read for keys the sprint names that no stored row knows,
//     stored in `sprint_ref_tickets`, replaced next read, kept when the lookup fails, per tenant.

const DB_PATH = '/private/tmp/claude-501/pierre-sprint-read-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let ctx: import('../context.js').TrackerContext;
let read: typeof import('./read.js');
let store: typeof import('../../db/sprint-store.js');
let hooks: typeof import('./hooks.js');
let eq: typeof import('drizzle-orm').eq;
let and: typeof import('drizzle-orm').and;
let wsA = 0;
let wsB = 0;
let prA = 0;

const ROOT = 'https://acme.atlassian.net';
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 10, 12);
const ident = (key: string) => `jira:${ROOT}#${key}`;

function ticket(key: string, over: Record<string, unknown> = {}) {
  return {
    key,
    title: `Title ${key}`,
    description: 'As a user I want things, so that I can.',
    issueType: { id: '10001', name: 'Story' },
    status: { name: 'To Do', category: 'new' as const },
    assignee: null,
    candidates: [{ id: 'customfield_1', name: 'Acceptance Criteria', text: '- It works', match: 'strong' as const }],
    omittedCandidates: 0,
    projectKey: 'ENG',
    epic: { key: 'ENG-100', title: 'Epic' },
    components: ['Billing'],
    sprintName: 'Sprint 42',
    issueUpdatedAt: new Date(T0 - DAY),
    ...over,
  };
}

const SOURCE: SprintSource = { kind: 'sprint', provider: 'jira', names: ['Sprint 42'] };

let listed: { tickets: ReturnType<typeof ticket>[]; fail: unknown | null; calls: number; args: any[]; extra?: Record<string, unknown> };
const fakeLister = async (a: any) => {
  listed.calls += 1;
  listed.args.push(a);
  if (listed.fail != null) throw listed.fail;
  return { source: SOURCE, tickets: listed.tickets, truncated: false, ...(listed.extra ?? {}) };
};
// The referenced-ticket lookup (./ref-status.ts): a fake, so no test ever reaches a real tracker.
let refAsked: string[][] = [];
let refAnswer: (keys: readonly string[]) => Array<{ key: string; title: string | null; status: string | null; category: 'new' | 'indeterminate' | 'done' | null; url: string | null; description?: string | null; blockedBy?: any[] }> = () => [];
const fakeRefLister = async (_call: unknown, keys: readonly string[]) => {
  refAsked.push([...keys]);
  return { tickets: refAnswer(keys), complete: true };
};
const opts = (now = T0) => ({
  now: () => now,
  listers: { jira: fakeLister },
  refListers: { jira: fakeRefLister },
  entitled: async (a: number) => a === 1,
});

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  closeDb = client.closeDb;
  await runMigrations();
  db = client.db;
  schema = client.schema;
  ({ eq, and } = await import('drizzle-orm'));
  const q = await import('../../db/queries.js');
  const have = new Set((await db.select().from(schema.accounts).execute()).map((a: any) => a.id));
  if (!have.has(1)) await db.insert(schema.accounts).values({ id: 1, githubUserId: 'U_sr_a', githubLogin: 'sr-a', isLocal: true }).execute();
  if (!have.has(2)) await db.insert(schema.accounts).values({ id: 2, githubUserId: 'U_sr_b', githubLogin: 'sr-b', isLocal: false }).execute();
  wsA = await q.ensureDefaultWorkspace(1);
  wsB = await q.ensureDefaultWorkspace(2);
  const { buildTrackerContext } = await import('../runtime.js');
  ctx = buildTrackerContext({ warn: () => {}, info: () => {}, error: () => {} });
  const { storeTrackerToken } = await import('../secret.js');
  for (const [accountId, workspaceId] of [
    [1, wsA],
    [2, wsB],
  ] as const) {
    await db
      .insert(schema.workspaceTrackers)
      .values({ accountId, workspaceId, provider: 'jira', baseUrl: ROOT, authEmail: 'me@acme.com', authToken: storeTrackerToken(ctx.host, 'tok') })
      .execute();
  }
  // One stored PR ticket on account 1's workspace, so the sprint read knows the ENG project.
  const [repo] = await db.insert(schema.repos).values({ accountId: 1, githubNodeId: 'R_sr_a', owner: 'acme', name: 'web' }).returning({ id: schema.repos.id }).execute();
  const [pr] = await db
    .insert(schema.pullRequests)
    .values({ accountId: 1, repoId: repo.id, githubNodeId: 'PR_sr_a', number: 1, title: 'ENG-1 thing', state: 'open', openedAt: new Date(T0), updatedAt: new Date(T0) })
    .returning({ id: schema.pullRequests.id })
    .execute();
  prA = pr.id;
  await db
    .insert(schema.trackerTickets)
    .values({ accountId: 1, workspaceId: wsA, prId: prA, provider: 'jira', issueKey: 'ENG-1', detectedFrom: 'title', detectOrder: 0, apiRoot: ROOT, url: `${ROOT}/browse/ENG-1`, state: 'ok', checkedAt: new Date(T0), nextCheckAt: new Date(T0 + DAY) })
    .execute();
  read = await import('./read.js');
  store = await import('../../db/sprint-store.js');
  hooks = await import('./hooks.js');
});

afterAll(async () => {
  hooks?.setAfterSprintRead(null);
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

beforeEach(() => {
  listed = { tickets: [ticket('ENG-1'), ticket('ENG-2')], fail: null, calls: 0, args: [] };
  read.resetSprintRead();
});

async function rows(accountId: number, workspaceId: number) {
  const st = schema.sprintTickets;
  return db.select().from(st).where(and(eq(st.accountId, accountId), eq(st.workspaceId, workspaceId))).execute() as Promise<any[]>;
}

describe('project keys', () => {
  it('come from the workspace’s stored tickets (+ allowlist); another tenant sees none', async () => {
    const { sprintProjectKeys } = await import('./project-keys.js');
    expect(await sprintProjectKeys(ctx, 1, wsA, 'jira', ROOT)).toEqual(['ENG']);
    expect(await sprintProjectKeys(ctx, 2, wsB, 'jira', ROOT)).toEqual([]);
    expect(await sprintProjectKeys(ctx, 1, wsA, 'jira', 'https://other.atlassian.net')).toEqual([]);
  });
});

describe('the demand gate', () => {
  it('a workspace never viewed is not read', async () => {
    await read.runSprintReadTick(ctx, opts());
    expect(listed.calls).toBe(0);
  });

  it('a viewed workspace is read once, then only when due again; Refresh makes it due', async () => {
    let fired: Array<[number, number]> = [];
    hooks.setAfterSprintRead((a, w) => fired.push([a, w]));
    await store.noteSprintViewed(1, wsA, new Date(T0));
    await read.runSprintReadTick(ctx, opts());
    expect(listed.calls).toBe(1);
    expect(listed.args[0].projectKeys).toEqual(['ENG']);
    expect(fired).toEqual([[1, wsA]]);
    const r = await store.readSprintRead(1, wsA);
    expect(r?.sourceJson).toEqual(SOURCE);
    expect(r?.provider).toBe('jira');
    expect(r?.errorCode).toBeNull();
    expect(r?.nextReadAt.getTime()).toBeGreaterThan(T0);
    // Not due yet.
    await read.runSprintReadTick(ctx, opts(T0 + 60_000));
    expect(listed.calls).toBe(1);
    // Refresh → due.
    await store.markSprintReadDue(1, wsA);
    await read.runSprintReadTick(ctx, opts(T0 + 120_000));
    expect(listed.calls).toBe(2);
    fired = [];
    hooks.setAfterSprintRead(null);
  });

  it('a view older than the TTL is not read; an account without Reports is not read', async () => {
    await store.markSprintReadDue(1, wsA);
    await read.runSprintReadTick(ctx, opts(T0 + 8 * DAY));
    expect(listed.calls).toBe(0);
    await store.noteSprintViewed(2, wsB, new Date(T0));
    await read.runSprintReadTick(ctx, opts());
    // Account 1 is due (marked above) and read; account 2 has no Reports.
    expect(listed.args.every((a: any) => a.call.provider === 'jira')).toBe(true);
    expect((await store.readSprintRead(2, wsB))?.readAt).toBeNull();
  });
});

describe('store rules', () => {
  it('upserts, keeps first_seen_at, flips the missing out of the sprint, prunes the long-unseen', async () => {
    await read.readWorkspaceSprint(ctx, 1, wsA, opts(T0));
    const first = await rows(1, wsA);
    const one = first.find((r) => r.ident === ident('ENG-1'));
    expect(one).toMatchObject({ title: 'Title ENG-1', acceptanceCriteria: '- It works', acFieldId: 'customfield_1', projectKey: 'ENG', epicKey: 'ENG-100', sprintName: 'Sprint 42', inSprint: true, statusCategory: 'new', url: `${ROOT}/browse/ENG-1` });
    expect(JSON.parse(one.componentsJson)).toEqual(['Billing']);
    const firstSeen = one.firstSeenAt.getTime();
    // A later read returns ENG-1 (edited) and not ENG-2.
    listed.tickets = [ticket('ENG-1', { title: 'Edited' })];
    await read.readWorkspaceSprint(ctx, 1, wsA, opts(T0 + DAY));
    const second = await rows(1, wsA);
    const again = second.find((r) => r.ident === ident('ENG-1'));
    expect(again.title).toBe('Edited');
    expect(again.firstSeenAt.getTime()).toBe(firstSeen);
    expect(second.find((r) => r.ident === ident('ENG-2')).inSprint).toBe(false);
    // Both tickets have an accepted repo; the pruned one's goes with it.
    const [repoRow] = await db.select({ id: schema.repos.id }).from(schema.repos).where(eq(schema.repos.accountId, 1)).execute();
    for (const key of ['ENG-1', 'ENG-2']) {
      await db
        .insert(schema.sprintTicketRepos)
        .values({ accountId: 1, workspaceId: wsA, ident: ident(key), repoId: repoRow.id, via: 'manual', acceptedAt: new Date(T0) })
        .execute();
    }
    // 91 days later ENG-2 (last seen T0) is pruned, ENG-1 (seen at the read) stays.
    await read.readWorkspaceSprint(ctx, 1, wsA, opts(T0 + 91 * DAY));
    const third = await rows(1, wsA);
    expect(third.map((r) => r.ident).sort()).toEqual([ident('ENG-1')]);
    const accepted = await db.select().from(schema.sprintTicketRepos).where(eq(schema.sprintTicketRepos.accountId, 1)).execute();
    expect(accepted.map((r: any) => r.ident)).toEqual([ident('ENG-1')]);
  });

  it('stores the sprint\'s own dates on every read; a read with none clears them', async () => {
    const sr = schema.sprintReads;
    const datesOf = async () => {
      const [r] = await db.select({ s: sr.sprintStartsAt, e: sr.sprintEndsAt }).from(sr).where(and(eq(sr.accountId, 1), eq(sr.workspaceId, wsA))).execute();
      return [r.s?.toISOString() ?? null, r.e?.toISOString() ?? null];
    };
    listed.tickets = [ticket('ENG-1')];
    listed.extra = { dates: { startsAt: new Date('2026-10-14T10:15:00Z'), endsAt: new Date('2026-10-27T17:00:00Z') } };
    await read.readWorkspaceSprint(ctx, 1, wsA, opts(T0 + 92 * DAY));
    expect(await datesOf()).toEqual(['2026-10-14T10:15:00.000Z', '2026-10-27T17:00:00.000Z']);
    listed.extra = {};
    await read.readWorkspaceSprint(ctx, 1, wsA, opts(T0 + 93 * DAY));
    expect(await datesOf()).toEqual([null, null]);
  });

  it('a failure records the code, keeps the list and the last good read', async () => {
    const before = await store.readSprintRead(1, wsA);
    const { JiraFetchError } = await import('../jira/fetch.js');
    listed.fail = new JiraFetchError('http', 429);
    const res = await read.readWorkspaceSprint(ctx, 1, wsA, opts(T0 + 100 * DAY));
    expect(res).toEqual({ ok: false, stored: 0, code: 'rate_limited' });
    const after = await store.readSprintRead(1, wsA);
    expect(after?.errorCode).toBe('rate_limited');
    expect(after?.readAt?.getTime()).toBe(before?.readAt?.getTime());
    expect(after?.nextReadAt.getTime()).toBe(Math.floor((T0 + 100 * DAY + 5 * 60_000) / 1000) * 1000);
    expect((await rows(1, wsA)).length).toBe(1);
    expect(read.sprintReadErrorMessage('jira', 'rate_limited')).toBe("Jira's rate limit is used up for now. Limn will read the sprint again in a few minutes.");
    expect(read.sprintReadErrorMessage('jira', 'unauthorized')).toBe(
      'Jira did not accept the saved token. Check the email and token in Settings.',
    );
  });

  it('no projects seen → no_projects, with a sentence naming the tracker; no call made', async () => {
    await store.noteSprintViewed(2, wsB, new Date(T0));
    const res = await read.readWorkspaceSprint(ctx, 2, wsB, opts(T0));
    expect(res.code).toBe('no_projects');
    expect(listed.calls).toBe(0);
    expect((await store.readSprintRead(2, wsB))?.errorCode).toBe('no_projects');
    expect(read.sprintReadErrorMessage('jira', 'no_projects')).toMatch(/^No Jira tickets have been seen/);
    expect(await rows(2, wsB)).toEqual([]);
  });
});

describe('a workspace the ticket worker backed off', () => {
  it('records the worker’s code (so the page names it) and moves next_read_at on; no call made', async () => {
    const [{ readWorkspaceTrackerRow, trackerAccessOf }, { prepareTrackerCall }, worker] = await Promise.all([
      import('../settings.js'),
      import('../calls.js'),
      import('../worker.js'),
    ]);
    const prepared = prepareTrackerCall(trackerAccessOf(ctx.host, await readWorkspaceTrackerRow(ctx, 1, wsA)), { cloud: false });
    if (!prepared.ok) throw new Error('call did not prepare');
    const now = T0 + 150 * DAY;
    worker.__backOffForTest(1, wsA, worker.accessFingerprint(prepared.call), now + 3_600_000, 'unauthorized');
    try {
      const res = await read.readWorkspaceSprint(ctx, 1, wsA, opts(now));
      expect(res).toEqual({ ok: false, stored: 0, code: 'unauthorized' });
      expect(listed.calls).toBe(0);
      const r = await store.readSprintRead(1, wsA);
      expect(r?.errorCode).toBe('unauthorized');
      expect(r?.nextReadAt.getTime()).toBeGreaterThan(now);
    } finally {
      worker.resetTrackerWorker();
    }
  });
});

describe('POST /api/sprint-stories/refresh', () => {
  it('is free (no Reports needed): stamps, marks due, kicks, 202s', async () => {
    const Fastify = (await import('fastify')).default;
    const contract = await import('../../pro/contract.js');
    const { registerSprintReadRoutes } = await import('./routes.js');
    const before = contract.getProCapabilities();
    const app = Fastify();
    let account: { isLocal: boolean; plan: string } | null = null;
    app.decorateRequest('account', null);
    app.addHook('onRequest', async (req) => {
      (req as any).account = account;
    });
    registerSprintReadRoutes(app, { ...ctx, accountIdOf: () => 1 });
    const kicks: Array<[number, number]> = [];
    store.setSprintReadKicker((a, w) => kicks.push([a, w]));
    try {
      // A free cloud account, no Pro capabilities at all — still allowed.
      contract.setProCapabilities({ ...before, periodReports: false });
      account = { isLocal: false, plan: 'free' };
      await db.update(schema.sprintReads).set({ nextReadAt: new Date(T0 + 365 * DAY) }).where(eq(schema.sprintReads.workspaceId, wsA)).execute();
      // Another tenant's workspace id falls to the caller's Default — never a 404.
      const ok = await app.inject({ method: 'POST', url: '/api/sprint-stories/refresh', payload: { workspaceId: wsB } });
      expect(ok.statusCode).toBe(202);
      const body = ok.json();
      expect(body.workspaceId).toBe(wsA);
      expect(body.read).toHaveProperty('readAt');
      expect(kicks).toEqual([[1, wsA]]);
      expect((await store.readSprintRead(1, wsA))?.nextReadAt.getTime()).toBe(0);
      expect(await store.readSprintRead(1, wsB)).toBeNull();
      // No agentic seam (cloud, AI off): no `ticketChecks` at all.
      expect('ticketChecks' in body).toBe(false);
      // With the seam (local, AI on): it runs for the RESOLVED workspace and its answer rides the 202.
      const asked: Array<[number, number]> = [];
      hooks.setSprintTicketChecks(async (a, w) => {
        asked.push([a, w]);
        return { started: 2, skipped: null };
      });
      const withChecks = await app.inject({ method: 'POST', url: '/api/sprint-stories/refresh', payload: { workspaceId: wsA } });
      expect(withChecks.statusCode).toBe(202);
      expect(withChecks.json().ticketChecks).toEqual({ started: 2, skipped: null });
      expect(asked).toEqual([[1, wsA]]);
      // A throwing seam never fails the refresh.
      hooks.setSprintTicketChecks(async () => {
        throw new Error('boom');
      });
      const threw = await app.inject({ method: 'POST', url: '/api/sprint-stories/refresh', payload: { workspaceId: wsA } });
      expect(threw.statusCode).toBe(202);
      expect(threw.json().ticketChecks).toEqual({ started: 0, skipped: null });
    } finally {
      hooks.setSprintTicketChecks(null);
      contract.setProCapabilities(before);
      store.setSprintReadKicker(null);
      await app.close();
    }
  });
});

describe('status order and blocking links', () => {
  const ORDER = {
    source: 'jira_board' as const,
    statuses: [
      { id: '1', name: 'To Do', category: 'new' as const },
      { id: '3', name: 'In Development', category: 'indeterminate' as const },
    ],
    readAt: new Date(T0).toISOString(),
  };
  const LINK = { key: 'ENG-9', title: 'Cookie banner', status: 'To Do', category: 'new' as const, relation: 'is blocked by', url: `${ROOT}/browse/ENG-9` };
  const orderOf = async () => {
    const sr = schema.sprintReads;
    const [r] = await db.select({ o: sr.statusOrderJson }).from(sr).where(and(eq(sr.accountId, 1), eq(sr.workspaceId, wsA))).execute();
    return r?.o ?? null;
  };

  it('stores the order, the links and the status id; a failed order read keeps the stored order', async () => {
    listed.tickets = [ticket('ENG-1', { status: { name: 'In Development', category: 'indeterminate', id: '3' }, blockedBy: [LINK] })];
    listed.extra = { statusOrder: ORDER };
    expect((await read.readWorkspaceSprint(ctx, 1, wsA, opts(T0 + 200 * DAY))).ok).toBe(true);
    expect(await orderOf()).toEqual(ORDER);
    const one = (await rows(1, wsA)).find((r) => r.ident === ident('ENG-1'));
    expect(one.blockedByJson).toEqual([LINK]);
    expect(one.statusId).toBe('3');

    // The order read failed this time: the list still lands, the stored order stands. The ticket read
    // carried no links (undefined): the stored links stand too.
    listed.tickets = [ticket('ENG-1', { title: 'Again', status: { name: 'In Development', category: 'indeterminate', id: '3' } })];
    listed.extra = { statusOrder: undefined, statusOrderError: 'forbidden' };
    expect((await read.readWorkspaceSprint(ctx, 1, wsA, opts(T0 + 201 * DAY))).ok).toBe(true);
    expect(await orderOf()).toEqual(ORDER);
    const again = (await rows(1, wsA)).find((r) => r.ident === ident('ENG-1'));
    expect(again.title).toBe('Again');
    expect(again.blockedByJson).toEqual([LINK]);

    // A positive "none": links [] clear, order null (no board) clears.
    listed.tickets = [ticket('ENG-1', { blockedBy: [] })];
    listed.extra = { statusOrder: null };
    await read.readWorkspaceSprint(ctx, 1, wsA, opts(T0 + 202 * DAY));
    expect(await orderOf()).toBeNull();
    expect((await rows(1, wsA)).find((r) => r.ident === ident('ENG-1')).blockedByJson).toEqual([]);
    listed.extra = undefined;
  });
});

describe('referenced tickets and ghost chains (./ref-status.ts)', () => {
  const refRows = async (accountId: number) =>
    db.select().from(schema.sprintRefTickets).where(eq(schema.sprintRefTickets.accountId, accountId)).execute() as Promise<any[]>;

  it('asks for every key the sprint names (never its own), stores them, replaces them on the next read; knownTicketsFor reads them', async () => {
    refAsked = [];
    refAnswer = (keys) => keys.filter((k) => k !== 'ENG-77').map((k) => ({ key: k, title: `Title ${k}`, status: 'Done', category: 'done', url: `${ROOT}/browse/${k}` }));
    listed.tickets = [
      ticket('ENG-1', {
        description: `Supersedes ${ROOT}/browse/ENG-50. Uses ENG-51 and ENG-77; follows ENG-2. UTF-8. Not OPS-1.`,
        blockedBy: [{ key: 'ENG-60', title: null, status: null, category: null, relation: 'is blocked by', url: null }],
      }),
      ticket('ENG-2'),
    ];
    expect((await read.readWorkspaceSprint(ctx, 1, wsA, opts(T0 + 300 * DAY))).ok).toBe(true);
    // ENG-1 / ENG-2 are sprint tickets; OPS is not a project this workspace reads; UTF-8 is a word.
    expect(refAsked).toEqual([['ENG-60', 'ENG-50', 'ENG-51', 'ENG-77']]);
    const stored = await refRows(1);
    expect(stored.map((r) => [r.issueKey, r.statusName, r.statusCategory, r.workspaceId]).sort()).toEqual([
      ['ENG-50', 'Done', 'done', wsA],
      ['ENG-51', 'Done', 'done', wsA],
      ['ENG-60', 'Done', 'done', wsA],
    ]);
    const { knownTicketsFor } = await import('../../db/story-issue-input.js');
    expect((await knownTicketsFor(1, 'jira', ROOT, ['eng-51'])).get('ENG-51')).toMatchObject({ title: 'Title ENG-51', status: 'Done', category: 'done' });
    expect((await knownTicketsFor(1, 'jira', ROOT, ['ENG-51'], { refs: false })).has('ENG-51')).toBe(false);
    // Another tenant reads none of it.
    expect((await knownTicketsFor(2, 'jira', ROOT, ['ENG-51'])).size).toBe(0);
    expect(await refRows(2)).toEqual([]);

    // The next read: ENG-51 is no longer named → its row goes; ENG-50 is now a sprint ticket, so the
    // store already knows it and it is not asked again (its row goes too).
    refAsked = [];
    listed.tickets = [ticket('ENG-1', { description: `Uses ${ROOT}/browse/ENG-50 and ENG-60`, blockedBy: [] }), ticket('ENG-50')];
    expect((await read.readWorkspaceSprint(ctx, 1, wsA, opts(T0 + 301 * DAY))).ok).toBe(true);
    expect(refAsked).toEqual([['ENG-60']]);
    expect((await refRows(1)).map((r) => r.issueKey)).toEqual(['ENG-60']);

    // A lookup that fails keeps what it had; the read itself still succeeds.
    const failing = { ...opts(T0 + 302 * DAY), refListers: { jira: async () => { throw new Error('boom'); } } };
    expect((await read.readWorkspaceSprint(ctx, 1, wsA, failing as never)).ok).toBe(true);
    expect((await refRows(1)).map((r) => r.issueKey)).toEqual(['ENG-60']);
  });

  it('follows a chain through blocking links to SPRINT_GHOST_DEPTH_MAX, and a brief pass asks for the next hop (mode missing)', async () => {
    const link = (key: string) => [{ key, title: null, status: null, category: null, relation: 'is blocked by', url: null }];
    const next: Record<string, string> = { 'ENG-80': 'ENG-81', 'ENG-81': 'ENG-82', 'ENG-82': 'ENG-83', 'ENG-83': 'ENG-84' };
    refAsked = [];
    refAnswer = (keys) =>
      keys.map((k) => ({ key: k, title: `Title ${k}`, status: 'To Do', category: 'new', url: null, description: `Text of ${k}`, blockedBy: next[k] != null ? link(next[k]!) : [] }));
    listed.tickets = [ticket('ENG-1', { description: 'Plain', blockedBy: link('ENG-80') }), ticket('ENG-2', { description: 'Plain', blockedBy: [] })];
    expect((await read.readWorkspaceSprint(ctx, 1, wsA, opts(T0 + 310 * DAY))).ok).toBe(true);
    // Depth 1, then one hop per round, never past depth 3.
    expect(refAsked).toEqual([['ENG-80'], ['ENG-81'], ['ENG-82']]);
    const rows = await refRows(1);
    expect(rows.map((r) => [r.issueKey, r.depth, r.description]).sort()).toEqual([
      ['ENG-80', 1, 'Text of ENG-80'],
      ['ENG-81', 2, 'Text of ENG-81'],
      ['ENG-82', 3, 'Text of ENG-82'],
    ]);
    // A brief on ENG-81 (its CURRENT text) names ENG-90 as a dependency: the expansion asks for it at
    // depth 3, stores it and deletes nothing.
    const briefs = await import('../../db/sprint-briefs.js');
    const e81 = rows.find((r) => r.issueKey === 'ENG-81');
    await briefs.storeSprintBrief(1, wsA, e81.ident, briefs.sprintBriefInput(e81, 'jira').textHash, {
      summary: 's',
      oneLiner: 's',
      criteria: [],
      criteriaDerived: true,
      references: [{ ticketKey: 'ENG-90', relation: 'depends_on', quote: null }],
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    refAsked = [];
    expect(await read.expandSprintGhosts(ctx, 1, wsA, opts(T0 + 311 * DAY))).toBe(1);
    expect(refAsked).toEqual([['ENG-90']]);
    expect((await refRows(1)).map((r) => [r.issueKey, r.depth]).sort()).toEqual([
      ['ENG-80', 1],
      ['ENG-81', 2],
      ['ENG-82', 3],
      ['ENG-90', 3],
    ]);
    // Nothing new to ask: no call.
    refAsked = [];
    expect(await read.expandSprintGhosts(ctx, 1, wsA, opts(T0 + 312 * DAY))).toBe(0);
    expect(refAsked).toEqual([]);
  });
});
