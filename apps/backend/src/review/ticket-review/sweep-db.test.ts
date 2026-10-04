// THE TICKET REVIEW SWEEPER (sweep.ts) and the member refusal (prepare.ts), over the REAL core
// client and migrations, with a fake plugin seam. What this pins:
//   1. ⚠ ONE HOP: a push to PR X looks only at the tickets X is on. T3, which shares PR Y with T1,
//      is not even considered.
//   2. A re-run waits for the settle (5 minutes quiet), then queues as 'cascade'.
//   3. ⚠ The per-workspace daily cap counts cascade runs (rows written when queued).
//   4. A FIRST automatic run needs a member opened after the switch-on, or the kick.
//   5. ⚠ More than TICKET_REVIEW_MAX_PRS members refuses `too_many_prs` with the count.
//   6. ⚠ A ticket whose run is queued or running WAITS (a member that moves meanwhile is re-judged
//      once the run ends), and a full lane keeps EVERY unreached candidate waiting.
//   7. ⚠ ONE story per ticket, whoever asks: the freshest stored row, never "the first member's".
//
//   pnpm --filter @pierre-review/backend test ticket-review/sweep-db
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeReviewTicket } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';

const DB_PATH = '/tmp/pierre-ticket-review-sweep-db.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

vi.mock('../claude-review/ai-ready.js', () => ({ agenticRunReady: () => true }));

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let persist: typeof import('./persist.js');
let fp: typeof import('./fingerprint.js');
let sweep: typeof import('./sweep.js');
let prep: typeof import('./prepare.js');
let providers: typeof import('../plugin-providers.js');
let ctx: AgentContext;
let ws = 0;
const pr: Record<string, number> = {};
const repoIds: number[] = [];

const T1 = 'jira:https://acme.atlassian.net/rest/api/3#BMD-1';
const T2 = 'jira:https://acme.atlassian.net/rest/api/3#BMD-2';
const T3 = 'jira:https://acme.atlassian.net/rest/api/3#BMD-3';
const T4 = 'jira:https://acme.atlassian.net/rest/api/3#BMD-4';
const BIG = 'jira:https://acme.atlassian.net/rest/api/3#BMD-9';
const T5 = 'jira:https://acme.atlassian.net/rest/api/3#BMD-5';
const T6 = 'jira:https://acme.atlassian.net/rest/api/3#BMD-6';
const story = (key: string): ClaudeReviewTicket => ({
  title: `Story ${key}`,
  description: 'd',
  acceptanceCriteria: '- one',
  source: 'jira',
  key,
});
// ticket → member PR tags
const membership: Record<string, string[]> = {
  [T1]: ['x', 'y'],
  [T2]: ['x'],
  [T3]: ['y', 'z'],
  [T4]: ['old'],
  [BIG]: ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9'],
};
const keyOf = (ident: string): string => ident.split('#')[1]!;

// The sweeper's clock is injected, but rows are stamped with the real clock and the cap counts
// from the UTC day of the tick — so every tick must fall on the same UTC day as now.
const NOW = Date.now();
const T0 = NOW % 86_400_000 > 23 * 3_600_000 ? NOW - 3_600_000 : NOW;
const ENABLED_AT = T0 - 24 * 3_600_000;
let dailyCap = 20;
const enqueued: Array<{ ident: string; trigger: string }> = [];

async function addPr(tag: string, repoId: number, openedAt: Date): Promise<void> {
  const [p] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: `PR_${tag}`,
      accountId: 1,
      repoId,
      number: Object.keys(pr).length + 1,
      title: tag,
      state: 'open',
      isDraft: false,
      headSha: `h_${tag}`,
      openedAt,
      updatedAt: openedAt,
    })
    .returning()
    .execute();
  pr[tag] = p.id;
}

/** A succeeded run of `ident` at today's live inputs — so it reads current. */
async function seedCurrentRun(ident: string): Promise<void> {
  const ids = membership[ident]!.map((t) => pr[t]!);
  const live = await fp.readLiveMembers(ctx, 1, ids);
  const h = fp.ticketHash(story(keyOf(ident)));
  const id = await persist.insertQueuedTicketReview(ctx, {
    accountId: 1,
    workspaceId: ws,
    ident,
    ticketKey: keyOf(ident),
    ticketTitle: null,
    ticket: null,
    originPrId: ids[0]!,
    trigger: 'manual',
    model: 'm',
  });
  await persist.markTicketReviewRunning(ctx, 1, id, {
    ticket: story(keyOf(ident)),
    ticketHash: h,
    fingerprint: fp.fingerprint(h, live),
    prCount: live.length,
    members: live.map((m) => ({ ...m, checkedOut: true })),
  });
  await persist.saveTicketReviewSuccess(ctx, 1, id, {
    alignment: 'aligned',
    summary: null,
    assessment: { alignment: 'aligned', summary: null, criteria: [], missing: [], notRequested: [] },
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    numTurns: 1,
    items: [],
  });
}

const deps = (): import('./sweep.js').TicketSweepDeps => ({
  roster: async () => [{ accountId: 1, workspaceId: ws, enabledAtMs: ENABLED_AT }],
  // Writes the row the real lane writes when it queues, so the cap counter sees it.
  enqueue: async (c, a) => {
    const runId = await persist.insertQueuedTicketReview(c, {
      accountId: a.accountId,
      workspaceId: a.workspaceId,
      ident: a.ident,
      ticketKey: a.ticketKey,
      ticketTitle: a.ticketTitle,
      ticket: null,
      originPrId: a.originPrId,
      trigger: a.trigger,
      model: 'm',
    });
    enqueued.push({ ident: a.ident, trigger: a.trigger });
    return { outcome: 'queued', runId };
  },
  laneRoom: () => 20,
  held: () => false,
  dailyCap,
});

/** The fake lane never runs what it queued: end those rows, as a finished run would. */
async function endQueuedRuns(): Promise<void> {
  const { eq } = await import('drizzle-orm');
  await db
    .update(schema.ticketReviews)
    .set({ status: 'cancelled' })
    .where(eq(schema.ticketReviews.status, 'queued'))
    .execute();
}

async function push(tag: string, head: string): Promise<void> {
  const { eq } = await import('drizzle-orm');
  await db.update(schema.pullRequests).set({ headSha: head }).where(eq(schema.pullRequests.id, pr[tag]!)).execute();
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  persist = await import('./persist.js');
  fp = await import('./fingerprint.js');
  sweep = await import('./sweep.js');
  prep = await import('./prepare.js');
  providers = await import('../plugin-providers.js');
  ctx = {
    db,
    schema,
    isPg: false,
    runTransaction: client.runTransaction,
    recordAiUsage: async () => {},
    host: { isCloud: false },
    llm: { detectAuth: () => ({ status: 'ok' }) },
    aiCredits: { check: async () => ({ agentBlocked: false }) },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as any as AgentContext;
  await db.insert(schema.accounts).values({ id: 1, githubUserId: 'U_me', githubLogin: 'me', isLocal: true }).onConflictDoNothing().execute();
  const [w] = await db.insert(schema.workspaces).values({ accountId: 1, name: 'Team', isDefault: false }).returning().execute();
  ws = w.id;
  for (const name of ['api', 'web', 'app', 'big']) {
    const [r] = await db.insert(schema.repos).values({ accountId: 1, owner: 'acme', name, githubNodeId: `R_${name}` }).returning().execute();
    repoIds.push(r.id);
    await db.insert(schema.workspaceRepos).values({ accountId: 1, workspaceId: ws, repoId: r.id }).execute();
  }
  const fresh = new Date(T0 - 3_600_000);
  await addPr('x', repoIds[0]!, fresh);
  await addPr('y', repoIds[1]!, fresh);
  await addPr('z', repoIds[2]!, fresh);
  await addPr('old', repoIds[2]!, new Date(ENABLED_AT - 3_600_000));
  for (let i = 1; i <= 9; i += 1) await addPr(`b${i}`, repoIds[3]!, new Date(ENABLED_AT - 3_600_000));

  const idOf = (tag: string): number => pr[tag]!;
  providers.registerAgenticProviders({
    ticketsForPr: async (_a, prId) =>
      Object.entries(membership)
        .filter(([, tags]) => tags.some((t) => idOf(t) === prId))
        .map(([ident]) => ({ ident, ticket: story(keyOf(ident)), ticketHash: '' })),
    ticketMembers: async (_a, ident) => (membership[ident] ?? []).map((t) => ({ prId: idOf(t), workspaceId: ws })),
    listChangedTicketIdents: async () => [],
  });
  for (const t of [T1, T2, T3]) await seedCurrentRun(t);
});

afterAll(async () => {
  providers._resetAgenticProvidersForTest();
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

beforeEach(() => {
  enqueued.length = 0;
});

describe('ticket review sweep', () => {
  it('a baseline tick queues nothing: every ticket is current, and the old one is before the floor', async () => {
    sweep._resetTicketSweepForTest();
    const r = await sweep.runTicketReviewSweep(ctx, T0, deps());
    expect(r.queued).toEqual([]);
    expect(enqueued).toEqual([]);
  });

  it('⚠ one hop: a push to X looks at T1 and T2 only, and waits for the settle', async () => {
    await push('x', 'h_x2');
    const r = await sweep.runTicketReviewSweep(ctx, T0 + 60_000, deps());
    expect(r.considered).toEqual([T1, T2]);
    expect(r.queued).toEqual([]);
  });

  it('after 5 quiet minutes both re-run as cascade — never T3', async () => {
    const r = await sweep.runTicketReviewSweep(ctx, T0 + 7 * 60_000, deps());
    expect(r.queued.map((q) => [q.ident, q.trigger])).toEqual([
      [T1, 'cascade'],
      [T2, 'cascade'],
    ]);
    expect(r.considered).not.toContain(T3);
  });

  it('⚠ the daily cap counts those cascade runs', async () => {
    expect(await persist.countAutoTicketReviewsSince(ctx, 1, ws, NOW - 3_600_000)).toBe(2);
    dailyCap = 2;
    await push('z', 'h_z2');
    await sweep.runTicketReviewSweep(ctx, T0 + 8 * 60_000, deps());
    const capped = await sweep.runTicketReviewSweep(ctx, T0 + 15 * 60_000, deps());
    expect(capped.considered).toContain(T3);
    expect(capped.queued).toEqual([]);
    dailyCap = 3;
    const room = await sweep.runTicketReviewSweep(ctx, T0 + 16 * 60_000, deps());
    expect(room.queued.map((q) => q.ident)).toEqual([T3]);
    dailyCap = 20;
  });

  it('a first run needs a member opened after the switch-on, or the kick', async () => {
    await push('old', 'h_old2');
    const r = await sweep.runTicketReviewSweep(ctx, T0 + 20 * 60_000, deps());
    expect(r.considered).toContain(T4);
    expect(r.queued).toEqual([]);
    sweep.kickTicketSweep({ ...ctx, host: { isCloud: true } } as AgentContext, 1, pr.old!);
    const kicked = await sweep.runTicketReviewSweep(ctx, T0 + 21 * 60_000, deps());
    expect(kicked.queued).toEqual([{ ident: T4, trigger: 'auto', workspaceId: ws }]);
  });

  it('⚠ a held ticket waits, and is re-judged once its run is gone', async () => {
    await endQueuedRuns();
    await push('y', 'h_y2');
    const held = await sweep.runTicketReviewSweep(ctx, T0 + 30 * 60_000, { ...deps(), held: (_a, i) => i === T1 || i === T3 });
    expect(held.considered).toEqual([T1, T3]);
    expect(held.queued).toEqual([]);
    // Y did not move again: only waiting brings T1 and T3 back — through the settle, then queued.
    const back = await sweep.runTicketReviewSweep(ctx, T0 + 31 * 60_000, deps());
    expect(back.considered).toEqual([T1, T3]);
    const after = await sweep.runTicketReviewSweep(ctx, T0 + 37 * 60_000, deps());
    expect(after.queued.map((q) => q.ident)).toEqual([T1, T3]);
  });

  it('⚠ a full lane keeps every candidate it did not reach waiting', async () => {
    await endQueuedRuns();
    const fresh = new Date(T0 + 38 * 60_000 - 3_600_000);
    await addPr('u', repoIds[0]!, fresh);
    await addPr('v', repoIds[1]!, fresh);
    membership[T5] = ['u'];
    membership[T6] = ['v'];
    const full = await sweep.runTicketReviewSweep(ctx, T0 + 38 * 60_000, { ...deps(), laneRoom: () => 0 });
    expect(full.stopped).toBe('lane_full');
    expect(full.considered).toEqual([T5]);
    const room = await sweep.runTicketReviewSweep(ctx, T0 + 39 * 60_000, deps());
    expect(room.queued.map((q) => [q.ident, q.trigger])).toEqual([
      [T5, 'auto'],
      [T6, 'auto'],
    ]);
  });

  it('oneHopIdents never follows a fellow member', () => {
    const ticketsOf = new Map<number, string[]>([
      [1, ['T1', 'T2']],
      [2, ['T1', 'T3']],
    ]);
    expect(sweep.oneHopIdents([1], ticketsOf)).toEqual(['T1', 'T2']);
  });
});

describe('member refusal', () => {
  it(`⚠ refuses too_many_prs with the count`, async () => {
    const r = await prep.resolveTicketInputs(ctx, 1, BIG, { originPrId: pr.b1!, manualTicket: null });
    expect(r).toMatchObject({ ok: false, reason: 'too_many_prs', prCount: 9 });
  });

  it('a pasted story is a one-member ticket; no story refuses no_ticket', async () => {
    const ident = fp.manualTicketIdent(pr.x!, { title: 'Pasted', acceptanceCriteria: '- a' });
    const ok = await prep.resolveTicketInputs(ctx, 1, ident, {
      originPrId: pr.x!,
      manualTicket: { title: 'Pasted', description: null, acceptanceCriteria: '- a' },
    });
    expect(ok.ok && ok.members.map((m) => m.prId)).toEqual([pr.x]);
    const none = await prep.resolveTicketInputs(ctx, 1, ident, { originPrId: pr.x!, manualTicket: null });
    expect(none).toMatchObject({ ok: false, reason: 'no_ticket' });
  });
});

describe('the story of a ticket', () => {
  const at = (key: string, iso: string): ClaudeReviewTicket => ({ ...story(key), title: `as of ${iso}`, fetchedAt: iso });

  it('⚠ without ticketStory: the freshest fetchedAt across members, whatever order they are passed in', async () => {
    const saved = providers.getAgenticProviders().ticketsForPr!;
    // PR x merged with the old text; PR y is open and was re-read since.
    providers.registerAgenticProviders({
      ticketsForPr: async (_a, prId) => [
        { ident: T1, ticket: at('BMD-1', prId === pr.x ? '2026-01-01T00:00:00.000Z' : '2026-06-01T00:00:00.000Z'), ticketHash: '' },
      ],
    });
    try {
      expect((await prep.jiraStoryFor(1, T1, [pr.x!, pr.y!]))?.title).toBe('as of 2026-06-01T00:00:00.000Z');
      expect((await prep.jiraStoryFor(1, T1, [pr.y!, pr.x!]))?.title).toBe('as of 2026-06-01T00:00:00.000Z');
    } finally {
      providers.registerAgenticProviders({ ticketsForPr: saved });
    }
  });

  it("the plugin's ticketStory answers for every caller when present", async () => {
    providers.registerAgenticProviders({ ticketStory: async () => at('BMD-1', 'canonical') });
    try {
      expect((await prep.jiraStoryFor(1, T1, [pr.y!]))?.title).toBe('as of canonical');
      expect((await prep.jiraStoryFor(1, T1, [pr.x!]))?.title).toBe('as of canonical');
    } finally {
      providers.registerAgenticProviders({ ticketStory: undefined });
    }
  });
});
