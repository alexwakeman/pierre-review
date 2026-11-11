// THE TICKET REVIEW SWEEPER (sweep.ts) and the member refusal (prepare.ts), over the REAL core
// client and migrations, with a fake plugin seam. What this pins:
//   1. ⚠ ONE HOP: a push to PR X looks only at the tickets X is on. T3, which shares PR Y with T1,
//      is not even considered.
//   2. A re-run waits for the grace window (2 quiet minutes after the push Limn SAW, `head_seen_at`),
//      then queues as 'cascade'.
//   3. ⚠ The per-workspace daily cap counts cascade runs (rows written when queued); a ticket with a
//      PR the reader owns is exempt.
//   4. A FIRST automatic run needs a member opened after the switch-on, or the kick — and waits too.
//   5. ⚠ More than TICKET_REVIEW_MAX_PRS (30) members refuses `too_many_prs` with the count; 30 runs.
//   6. ⚠ A ticket whose run is queued or running WAITS (a member that moves meanwhile is re-judged
//      once the run ends), and a full lane keeps EVERY unreached candidate waiting.
//   7. ⚠ ONE story per ticket, whoever asks: the freshest stored row, never "the first member's".
//   8. ⚠ NO CI hold: a member's running CI never delays a re-run.
//   9. ⚠ BMD-1175: no per-ticket limit; PRs joining restart the window, so a ticket whose PRs are
//      linked minutes apart gets ONE first check with all of them.
//  10. A person's comment the latest check did not see re-checks it (cause 'commented', the grace
//      window from the comment) ONLY while it has a criterion not done.
//  11. ⚠ ALL MET: a check that found every criterion done is never re-run automatically by a push
//      ('off', 'all_met'); one with a criterion not done is.
//
//   pnpm --filter @pierre-review/backend test ticket-review/sweep-db
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TICKET_REVIEW_MAX_PRS, type ClaudeReviewTicket } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-ticket-review-sweep-db.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

// `aiReady` lets one test hold the kick's own immediate sweep back, so the NEXT tick sees the kick.
let aiReady = true;
vi.mock('../claude-review/ai-ready.js', () => ({ agenticRunReady: () => aiReady }));

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let persist: typeof import('./persist.js');
let fp: typeof import('./fingerprint.js');
let sweep: typeof import('./sweep.js');
let prep: typeof import('./prepare.js');
let providers: typeof import('../../tracker/ticket-source.js');
let ctx: AgentContext;
let ws = 0;
const pr: Record<string, number> = {};
const repoIds: number[] = [];

const T1 = 'jira:https://acme.atlassian.net/rest/api/3#BMD-1';
const T2 = 'jira:https://acme.atlassian.net/rest/api/3#BMD-2';
const T3 = 'jira:https://acme.atlassian.net/rest/api/3#BMD-3';
const T4 = 'jira:https://acme.atlassian.net/rest/api/3#BMD-4';
const BIG = 'jira:https://acme.atlassian.net/rest/api/3#BMD-9';
const AT_CAP = 'jira:https://acme.atlassian.net/rest/api/3#BMD-30';
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
  // One more than the cap (TICKET_REVIEW_MAX_PRS, 30), and exactly the cap.
  [BIG]: Array.from({ length: TICKET_REVIEW_MAX_PRS + 1 }, (_, i) => `b${i + 1}`),
  [AT_CAP]: Array.from({ length: TICKET_REVIEW_MAX_PRS }, (_, i) => `b${i + 1}`),
};
const keyOf = (ident: string): string => ident.split('#')[1]!;
// `${ident}|${tag}` → when that PR joined the ticket (tracker_tickets.linked_at).
const linkedAt: Record<string, number> = {};

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
      originPrId: a.originPrId,
      trigger: a.trigger,
      cause: a.cause ?? null,
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

/** A push Limn saw at `atMs` — the stamps sync/upsert.ts writes when the head moves. */
async function push(tag: string, head: string, atMs: number): Promise<void> {
  const { eq } = await import('drizzle-orm');
  const [row] = (await db
    .select({ seen: schema.pullRequests.headSeenAt, burst: schema.pullRequests.headBurstAt })
    .from(schema.pullRequests)
    .where(eq(schema.pullRequests.id, pr[tag]!))
    .execute()) as Array<{ seen: Date | null; burst: Date | null }>;
  const inBurst = row?.seen != null && atMs - row.seen.getTime() < 2 * 60_000 && atMs >= row.seen.getTime();
  await db
    .update(schema.pullRequests)
    .set({ headSha: head, headSeenAt: new Date(atMs), headBurstAt: inBurst ? (row!.burst ?? row!.seen) : new Date(atMs) })
    .where(eq(schema.pullRequests.id, pr[tag]!))
    .execute();
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
  providers = await import('../../tracker/ticket-source.js');
  ctx = {
    db,
    schema,
    runTransaction: client.runTransaction,
    recordAiUsage: async () => {},
    host: {},
    llm: { detectAuth: () => ({ status: 'ok' }) },
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
  for (let i = 1; i <= TICKET_REVIEW_MAX_PRS + 1; i += 1) await addPr(`b${i}`, repoIds[3]!, new Date(ENABLED_AT - 3_600_000));

  const idOf = (tag: string): number => pr[tag]!;
  providers._overrideTicketSourceForTest({
    ticketsForPr: async (_a, prId) =>
      Object.entries(membership)
        .filter(([, tags]) => tags.some((t) => idOf(t) === prId))
        .map(([ident]) => ({ ident, ticket: story(keyOf(ident)), ticketHash: '' })),
    ticketMembers: async (_a, ident) =>
      (membership[ident] ?? []).map((t) => ({ prId: idOf(t), workspaceId: ws, linkedAtMs: linkedAt[`${ident}|${t}`] ?? null })),
    // THE story of a ticket (core's is the freshest stored row; there are no stored rows here).
    ticketStory: async (_a, ident) => (membership[ident] ? story(keyOf(ident)) : null),
    listChangedTicketIdents: async () => [],
  });
  for (const t of [T1, T2, T3]) await seedCurrentRun(t);
});

afterAll(async () => {
  providers._resetTicketSourceForTest();
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

  it('⚠ one hop: a push to X looks at T1 and T2 only, and waits for the grace window', async () => {
    await push('x', 'h_x2', T0 + 60_000);
    const r = await sweep.runTicketReviewSweep(ctx, T0 + 60_000, deps());
    expect(r.considered).toEqual([T1, T2]);
    expect(r.queued).toEqual([]);
    const early = await sweep.runTicketReviewSweep(ctx, T0 + 150_000, deps());
    expect(early.queued).toEqual([]);
  });

  it('after 2 quiet minutes both re-run as cascade — never T3 — with the cause stored', async () => {
    const r = await sweep.runTicketReviewSweep(ctx, T0 + 3 * 60_000, deps());
    expect(r.queued.map((q) => [q.ident, q.trigger])).toEqual([
      [T1, 'cascade'],
      [T2, 'cascade'],
    ]);
    expect(r.considered).not.toContain(T3);
    const { eq } = await import('drizzle-orm');
    const rows = (await db
      .select({ cause: schema.ticketReviews.cause })
      .from(schema.ticketReviews)
      .where(eq(schema.ticketReviews.status, 'queued'))
      .execute()) as Array<{ cause: string | null }>;
    expect(rows.map((x) => x.cause)).toEqual(['pushed', 'pushed']);
  });

  it('⚠ the daily cap counts those cascade runs', async () => {
    expect(await persist.countAutoTicketReviewsSince(ctx, 1, ws, NOW - 3_600_000)).toBe(2);
    dailyCap = 2;
    await push('z', 'h_z2', T0 + 8 * 60_000);
    await sweep.runTicketReviewSweep(ctx, T0 + 8 * 60_000, deps());
    const capped = await sweep.runTicketReviewSweep(ctx, T0 + 15 * 60_000, deps());
    expect(capped.considered).toContain(T3);
    expect(capped.queued).toEqual([]);
    // ⚠ A ticket with a PR the READER owns is never held by the cap.
    const { eq } = await import('drizzle-orm');
    const [me] = await db.insert(schema.users).values({ githubLogin: 'me-cap', githubNodeId: 'U_me_cap' }).returning().execute();
    await db.update(schema.pullRequests).set({ authorId: me.id }).where(eq(schema.pullRequests.id, pr.y!)).execute();
    const mine = await sweep.runTicketReviewSweep(ctx, T0 + 15 * 60_000 + 1, { ...deps(), readerUserId: async () => me.id });
    expect(mine.queued.map((q) => q.ident)).toEqual([T3]);
    await db.update(schema.pullRequests).set({ authorId: null }).where(eq(schema.pullRequests.id, pr.y!)).execute();
    await endQueuedRuns();
    // Not the reader's: held until the cap has room.
    await push('z', 'h_z2b', T0 + 15 * 60_000);
    const held = await sweep.runTicketReviewSweep(ctx, T0 + 17 * 60_000 + 30_000, deps());
    expect(held.queued).toEqual([]);
    dailyCap = 4;
    const room = await sweep.runTicketReviewSweep(ctx, T0 + 18 * 60_000, deps());
    expect(room.queued.map((q) => q.ident)).toEqual([T3]);
    dailyCap = 20;
  });

  it('a first run needs a member opened after the switch-on, or the kick', async () => {
    await push('old', 'h_old2', T0 + 20 * 60_000);
    const r = await sweep.runTicketReviewSweep(ctx, T0 + 20 * 60_000, deps());
    expect(r.considered).toContain(T4);
    expect(r.queued).toEqual([]);
    // The kick's own immediate sweep finds AI not ready and stops before consuming the kick, so
    // the next tick is the one that sees it.
    aiReady = false;
    sweep.kickTicketSweep(ctx, 1, pr.old!);
    aiReady = true;
    // The kick lifts the floor, not the grace window: still 2 quiet minutes after the push.
    const kicked = await sweep.runTicketReviewSweep(ctx, T0 + 21 * 60_000, deps());
    expect(kicked.queued).toEqual([]);
    const due = await sweep.runTicketReviewSweep(ctx, T0 + 22 * 60_000, deps());
    expect(due.queued).toEqual([{ ident: T4, trigger: 'auto', workspaceId: ws }]);
  });

  it('⚠ a held ticket waits, and is re-judged once its run is gone', async () => {
    await endQueuedRuns();
    await push('y', 'h_y2', T0 + 30 * 60_000);
    const held = await sweep.runTicketReviewSweep(ctx, T0 + 30 * 60_000, { ...deps(), held: (_a, i) => i === T1 || i === T3 });
    expect(held.considered).toEqual([T1, T3]);
    expect(held.queued).toEqual([]);
    // Y did not move again: only waiting brings T1 and T3 back. Once the run is gone they queue, 2
    // quiet minutes after the push seen WHILE held (T0+30) — never counted from the run's end.
    const back = await sweep.runTicketReviewSweep(ctx, T0 + 31 * 60_000, deps());
    expect(back.considered).toEqual([T1, T3]);
    expect(back.queued).toEqual([]);
    const after = await sweep.runTicketReviewSweep(ctx, T0 + 32 * 60_000, deps());
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

  it('⚠ does not wait for CI: a member whose CI is still running re-runs on the grace window alone', async () => {
    await endQueuedRuns();
    const { eq } = await import('drizzle-orm');
    await db
      .update(schema.pullRequests)
      .set({ headSha: 'h_z3', headSeenAt: new Date(T0 + 60 * 60_000), ciStatus: 'pending' })
      .where(eq(schema.pullRequests.id, pr.z!))
      .execute();
    // The old CI hold would wait until this head was 30 minutes old (T0+90).
    const first = await sweep.runTicketReviewSweep(ctx, T0 + 60 * 60_000, deps());
    const later = await sweep.runTicketReviewSweep(ctx, T0 + 62 * 60_000, deps());
    expect([...first.queued, ...later.queued].map((q) => [q.ident, q.trigger])).toEqual([[T3, 'cascade']]);
  });

  it('⚠ pushes during a run: the window counts from the LAST push, not the first or the run end', async () => {
    await endQueuedRuns();
    const { and, eq, desc } = await import('drizzle-orm');
    const B = T0 + 70 * 60_000;
    const min = (n: number): number => B + n * 60_000;
    const heldX = { ...deps(), held: (_a: number, i: string) => i === T1 || i === T2 };
    // A run of T1 and T2 is in flight from B to B+15; X is pushed at +1, +8 and +14.
    await push('x', 'h_x_r1', min(1));
    await sweep.runTicketReviewSweep(ctx, min(1), heldX);
    await push('x', 'h_x_r2', min(8));
    await sweep.runTicketReviewSweep(ctx, min(8), heldX);
    await push('x', 'h_x_r3', min(14));
    const held = await sweep.runTicketReviewSweep(ctx, min(14), heldX);
    expect(held.queued).toEqual([]);
    // The run ends at B+15.
    for (const ident of [T1, T2]) {
      const [row] = await db
        .select({ id: schema.ticketReviews.id })
        .from(schema.ticketReviews)
        .where(and(eq(schema.ticketReviews.accountId, 1), eq(schema.ticketReviews.ticketIdent, ident)))
        .orderBy(desc(schema.ticketReviews.id))
        .limit(1)
        .execute();
      await db
        .update(schema.ticketReviews)
        .set({ createdAt: new Date(min(0)), startedAt: new Date(min(0)), completedAt: new Date(min(15)) })
        .where(eq(schema.ticketReviews.id, row!.id))
        .execute();
    }
    const early = await sweep.runTicketReviewSweep(ctx, min(15), deps());
    expect(early.queued).toEqual([]);
    const due = await sweep.runTicketReviewSweep(ctx, min(16), deps());
    expect(due.queued.map((q) => [q.ident, q.trigger])).toEqual([
      [T1, 'cascade'],
      [T2, 'cascade'],
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

// ⚠ THE BMD-1175 DAY (2026-11-09). A first check ran on 1 of the story's 5 PRs; the other 4 were
// linked minutes later and a "PR joined" re-check followed (5 of the day's 20 checks went that way).
// Two story edits then used the ticket's "3 push re-checks", and the 10 real pushes that afternoon
// waited until midnight. Now: joins restart the 2-minute window (first checks wait too), there is no
// per-ticket limit, and every queued run says why.
describe('the grace window and no per-ticket limit (BMD-1175)', () => {
  const STORY = 'jira:https://acme.atlassian.net/rest/api/3#BMD-1175';
  const BUSY = 'jira:https://acme.atlassian.net/rest/api/3#BMD-1083';
  const DAY = NOW - (NOW % 86_400_000);
  const B = DAY + 6 * 3_600_000;
  const at = (min: number): number => B + min * 60_000;
  const causes = async (ident: string): Promise<Array<string | null>> => {
    const { eq, asc } = await import('drizzle-orm');
    const rows = (await db
      .select({ cause: schema.ticketReviews.cause, trigger: schema.ticketReviews.trigger })
      .from(schema.ticketReviews)
      .where(eq(schema.ticketReviews.ticketIdent, ident))
      .orderBy(asc(schema.ticketReviews.id))
      .execute()) as Array<{ cause: string | null; trigger: string }>;
    return rows.filter((r) => r.trigger !== 'manual').map((r) => r.cause);
  };

  it('PRs linked minutes apart get ONE first check, with all of them', async () => {
    await endQueuedRuns();
    sweep._resetTicketSweepForTest();
    dailyCap = 500;
    // Baseline: whatever a reset re-reads is settled and ended, so only this ticket moves from here.
    await sweep.runTicketReviewSweep(ctx, at(-30), deps());
    await sweep.runTicketReviewSweep(ctx, at(-20), deps());
    await endQueuedRuns();

    const tags = ['p1', 'p2', 'p3', 'p4', 'p5'];
    membership[STORY] = [];
    const join = async (tag: string, minute: number): Promise<void> => {
      await addPr(tag, repoIds[tags.indexOf(tag) % 3]!, new Date(at(minute)));
      await push(tag, `h_${tag}`, at(minute));
      membership[STORY]!.push(tag);
      linkedAt[`${STORY}|${tag}`] = at(minute);
    };
    await join(tags[0]!, 0);
    const queued: string[] = [];
    const tick = async (minute: number): Promise<void> => {
      const r = await sweep.runTicketReviewSweep(ctx, at(minute), deps());
      queued.push(...r.queued.filter((q) => q.ident === STORY).map((q) => q.trigger));
    };
    await tick(0);
    await tick(1);
    await join(tags[1]!, 1.5);
    await tick(2);
    await tick(3);
    await join(tags[2]!, 3.2);
    await join(tags[3]!, 3.4);
    await tick(4);
    await join(tags[4]!, 5);
    await tick(5);
    await tick(6);
    expect(queued).toEqual([]);
    await tick(7);
    await tick(8);
    expect(queued).toEqual(['auto']);
    expect(await causes(STORY)).toEqual(['first']);
    await endQueuedRuns();
  });

  it('⚠ no per-ticket limit: every push burst after a quiet spell gets its own re-check', async () => {
    await endQueuedRuns();
    await addPr('busy', repoIds[0]!, new Date(at(19)));
    membership[BUSY] = ['busy'];
    await seedCurrentRun(BUSY);
    let runs = 0;
    for (let i = 0; i < 6; i += 1) {
      const m = 20 + i * 5;
      await push('busy', `h_busy_${i}`, at(m));
      const a = await sweep.runTicketReviewSweep(ctx, at(m + 1), deps());
      const b = await sweep.runTicketReviewSweep(ctx, at(m + 2), deps());
      runs += [...a.queued, ...b.queued].filter((q) => q.ident === BUSY).length;
      await endQueuedRuns();
    }
    expect(runs).toBe(6);
    expect((await causes(BUSY)).every((c) => c === 'pushed')).toBe(true);
  });

  it('a story whose PRs never go quiet is still checked within the 20-minute ceiling', async () => {
    await endQueuedRuns();
    // Rows are stamped by the real clock; put the last run before this burst, as it was.
    const { eq } = await import('drizzle-orm');
    await db
      .update(schema.ticketReviews)
      .set({ createdAt: new Date(at(50)), startedAt: new Date(at(50)) })
      .where(eq(schema.ticketReviews.ticketIdent, BUSY))
      .execute();
    let first = -1;
    for (let m = 60; m <= 85; m += 1) {
      await push('busy', `h_busy_c${m}`, at(m));
      const r = await sweep.runTicketReviewSweep(ctx, at(m) + 30_000, deps());
      if (first < 0 && r.queued.some((q) => q.ident === BUSY)) first = m;
    }
    expect(first).toBe(80);
    dailyCap = 20;
  });

  it('switching auto review off everywhere drops every watch', async () => {
    await push('busy', 'h_busy_off', at(100));
    await sweep.runTicketReviewSweep(ctx, at(100), deps());
    const off = await sweep.runTicketReviewSweep(ctx, at(103), { ...deps(), roster: async () => [] });
    expect(off.considered).toEqual([]);
    await endQueuedRuns();
  });
});

describe('member refusal', () => {
  it(`⚠ refuses too_many_prs with the count`, async () => {
    const r = await prep.resolveTicketInputs(ctx, 1, BIG, { originPrId: pr.b1! });
    expect(TICKET_REVIEW_MAX_PRS).toBe(30);
    expect(r).toMatchObject({ ok: false, reason: 'too_many_prs', prCount: TICKET_REVIEW_MAX_PRS + 1 });
  });

  it('exactly TICKET_REVIEW_MAX_PRS members is accepted', async () => {
    const r = await prep.resolveTicketInputs(ctx, 1, AT_CAP, { originPrId: pr.b1! });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.members).toHaveLength(TICKET_REVIEW_MAX_PRS);
  });
});

describe('the story of a ticket', () => {
  const at = (key: string, iso: string): ClaudeReviewTicket => ({ ...story(key), title: `as of ${iso}`, fetchedAt: iso });

  it("the tracker's ticketStory answers for every caller", async () => {
    const saved = providers.getTicketSource().ticketStory;
    providers._overrideTicketSourceForTest({ ticketStory: async () => at('BMD-1', 'canonical') });
    try {
      expect((await prep.jiraStoryFor(1, T1, [pr.y!]))?.title).toBe('as of canonical');
      expect((await prep.jiraStoryFor(1, T1, [pr.x!]))?.title).toBe('as of canonical');
    } finally {
      providers._overrideTicketSourceForTest({ ticketStory: saved });
    }
  });
});

describe("a person's comment the latest check did not see", () => {
  const TC = 'jira:https://acme.atlassian.net/rest/api/3#BMD-77';
  const comments: Record<string, Array<{ id: string; createdAt: string }>> = {};

  /** A succeeded run of TC at today's inputs that saw comment c1, with these verdicts. */
  async function seedRun(statuses: string[]): Promise<void> {
    const ids = [pr.z!];
    const live = await fp.readLiveMembers(ctx, 1, ids);
    const h = fp.ticketHash(story('BMD-77'));
    const id = await persist.insertQueuedTicketReview(ctx, {
      accountId: 1,
      workspaceId: ws,
      ident: TC,
      ticketKey: 'BMD-77',
      ticketTitle: null,
      originPrId: ids[0]!,
      trigger: 'manual',
      model: 'm',
    });
    await persist.markTicketReviewRunning(ctx, 1, id, {
      ticket: story('BMD-77'),
      ticketHash: h,
      fingerprint: fp.fingerprint(h, live),
      prCount: live.length,
      members: live.map((m) => ({ ...m, checkedOut: true })),
      commentsSeen: { ids: ['c1'], count: 1, hash: 'x' },
    });
    await persist.saveTicketReviewSuccess(ctx, 1, id, {
      alignment: 'partly_aligned',
      summary: null,
      assessment: {
        alignment: 'partly_aligned',
        summary: null,
        criteria: statuses.map((status, i) => ({
          ref: `AC${i + 1}`,
          index: i,
          text: 't',
          status: status as never,
          explanation: null,
          deliveredBy: [],
          evidence: [],
          expectedIn: null,
        })),
        missing: [],
        notRequested: [],
      },
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
      numTurns: 1,
      items: [],
    });
  }

  const state = async (nowMs: number) => {
    const { loadTicketAutoState } = await import('./auto-inputs.js');
    return loadTicketAutoState(
      ctx,
      TC,
      {
        accountId: 1,
        enabled: new Map([[ws, ENABLED_AT]]),
        viaPrId: null,
        kicked: false,
        aiReady: true,
        overBudget: false,
        laneRoom: 20,
        held: false,
        dailyCap: 500,
        readerUserId: null,
      },
      nowMs,
    );
  };

  beforeAll(() => {
    membership[TC] = ['z'];
    providers._overrideTicketSourceForTest({
      ticketComments: async (_a, ident) =>
        (comments[ident] ?? []).map((c) => ({ id: c.id, author: 'Dana Lee', createdAt: c.createdAt, updatedAt: null, body: 'Done in the CMS.' })),
    });
  });
  afterAll(() => {
    delete membership[TC];
    providers._overrideTicketSourceForTest({ ticketComments: undefined });
  });

  it('re-checks (cause "commented", grace window from the comment) only while a criterion is not done', async () => {
    await endQueuedRuns();
    const nowMs = Date.now();
    comments[TC] = [{ id: 'c1', createdAt: new Date(nowMs - 3_600_000).toISOString() }];
    await seedRun(['met', 'not_met']);
    expect((await state(nowMs))!.plan.status).toBe('up_to_date');
    // A new comment one minute ago: waiting out the 2 quiet minutes, then due as 'commented'.
    comments[TC] = [...comments[TC]!, { id: 'c2', createdAt: new Date(nowMs - 60_000).toISOString() }];
    const waiting = (await state(nowMs))!;
    expect(waiting.plan.status).toBe('waiting');
    expect(waiting.plan.lastChange?.kind).toBe('commented');
    const due = (await state(nowMs + 61_000))!;
    expect(due.plan.status).toBe('due');
    expect(due.cause).toBe('commented');
    // The same new comment on a check whose criteria are all DONE (met + met outside code): nothing to re-check.
    await seedRun(['met', 'met_outside_code']);
    expect((await state(nowMs + 61_000))!.plan.status).toBe('up_to_date');
  });

  it('⚠ a push never re-checks a ticket whose latest check found every criterion done', async () => {
    await endQueuedRuns();
    const nowMs = Date.now();
    comments[TC] = [{ id: 'c1', createdAt: new Date(nowMs - 3_600_000).toISOString() }];
    await seedRun(['met', 'met_outside_code']);
    await push('z', `h_allmet_${nowMs}`, nowMs - 5 * 60_000);
    const all = (await state(nowMs))!;
    expect(all.plan).toMatchObject({ status: 'off', reason: 'all_met', due: false });
    // The same push on a check with a criterion not done: due.
    await seedRun(['met', 'partly_met']);
    await push('z', `h_gap_${nowMs}`, nowMs - 5 * 60_000);
    expect((await state(nowMs))!.plan.status).toBe('due');
  });
});
