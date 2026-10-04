// TICKET REVIEW PERSISTENCE over the REAL core client and migrations (sqlite 0080). What this pins:
//   1. A run round-trips: queued → running (story, fingerprint, members) → succeeded (assessment,
//      items), and reads back on the wire with its members' display fields.
//   2. A re-raised item links to the previous run's item and INHERITS its posting (never posted
//      twice); posting is compare-and-set.
//   3. The currency inputs: latest succeeded run + members, the in-flight run, the newest attempt —
//      and a head push makes the derived state stale.
//   4. AI Fix's owned items come from the latest succeeded run only.
//   5. The daily cap counts 'auto' and 'cascade', never 'manual'.
//   6. Deleting one member PR keeps a run its other PRs still hold; deleting the last drops it.
//   7. Another account's ids read as null.
//
//   pnpm --filter @pierre-review/backend test ticket-review/persist-db
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TicketAssessment } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';

const DB_PATH = '/tmp/pierre-ticket-review-persist-db.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let client: any;
let closeDb: (() => Promise<void> | void) | undefined;
let persist: typeof import('./persist.js');
let fp: typeof import('./fingerprint.js');
let ctx: AgentContext;
let ws = 0;
const pr: Record<string, number> = {};

const IDENT = 'jira:https://acme.atlassian.net/rest/api/3#BMD-1';
const story = { title: 'Export', description: 'd', acceptanceCriteria: '- CSV\n- PDF', source: 'jira' as const, key: 'BMD-1' };

const assessment = (status: 'met' | 'not_met'): TicketAssessment => ({
  alignment: status === 'met' ? 'aligned' : 'partly_aligned',
  summary: 's',
  criteria: [
    { ref: 'AC1', index: 0, text: 'CSV', status: 'met', explanation: null, deliveredBy: [pr.api!], evidence: [], expectedIn: null },
    { ref: 'AC2', index: 1, text: 'PDF', status, explanation: 'x', deliveredBy: [], evidence: [], expectedIn: null },
  ],
  missing: [],
  notRequested: [],
});

async function addPr(tag: string, repoId: number, head: string): Promise<number> {
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
      headSha: head,
      openedAt: new Date(),
      updatedAt: new Date(),
    })
    .returning()
    .execute();
  pr[tag] = p.id;
  return p.id;
}

async function runOnce(trigger: 'manual' | 'auto' | 'cascade', status: 'met' | 'not_met'): Promise<number> {
  const id = await persist.insertQueuedTicketReview(ctx, {
    accountId: 1,
    workspaceId: ws,
    ident: IDENT,
    ticketKey: 'BMD-1',
    ticketTitle: 'Export',
    ticket: null,
    originPrId: pr.api!,
    trigger,
    model: 'm',
  });
  const live = await fp.readLiveMembers(ctx, 1, [pr.api!, pr.web!]);
  const h = fp.ticketHash(story);
  await persist.markTicketReviewRunning(ctx, 1, id, {
    ticket: story,
    ticketHash: h,
    fingerprint: fp.fingerprint(h, live),
    prCount: live.length,
    members: live.map((m) => ({ ...m, checkedOut: true })),
  });
  await persist.saveTicketReviewSuccess(ctx, 1, id, {
    alignment: assessment(status).alignment,
    summary: 's',
    assessment: assessment(status),
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    numTurns: 3,
    items:
      status === 'met'
        ? []
        : [{ ref: 'AC2', status: 'not_met', title: 'PDF', body: 'x', ownerPrId: pr.web!, path: null, line: null }],
  });
  return id;
}

const usage: Array<{ feature: string; costUsd: number }> = [];

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  persist = await import('./persist.js');
  fp = await import('./fingerprint.js');
  ctx = {
    db,
    schema,
    isPg: false,
    runTransaction: client.runTransaction,
    recordAiUsage: async (u: { feature: string; costUsd: number }) => {
      usage.push(u);
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as any as AgentContext;
  await db
    .insert(schema.accounts)
    .values({ id: 1, githubUserId: 'U_me', githubLogin: 'me', isLocal: true })
    .onConflictDoNothing()
    .execute();
  await db
    .insert(schema.accounts)
    .values({ id: 2, githubUserId: 'U_b', githubLogin: 'b', isLocal: false })
    .onConflictDoNothing()
    .execute();
  // `workspace_id` carries no FK (a deleted workspace's runs simply stop counting).
  ws = 42;
  const [ra] = await db.insert(schema.repos).values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_api' }).returning().execute();
  const [rw] = await db.insert(schema.repos).values({ accountId: 1, owner: 'acme', name: 'web', githubNodeId: 'R_web' }).returning().execute();
  await addPr('api', ra.id, 'h_api');
  await addPr('web', rw.id, 'h_web');
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('ticket review persistence', () => {
  let first = 0;
  let second = 0;

  it('round-trips a run with its members and items', async () => {
    first = await runOnce('manual', 'not_met');
    const r = await persist.getTicketReviewById(ctx, 1, first);
    expect(r?.status).toBe('succeeded');
    expect(r?.ticket?.key).toBe('BMD-1');
    expect(r?.members.map((m) => m.repo).sort()).toEqual(['acme/api', 'acme/web']);
    expect(r?.assessment?.criteria[1]?.status).toBe('not_met');
    expect(r?.items).toHaveLength(1);
    expect(r?.items[0]?.ownerPrId).toBe(pr.web);
    expect(await persist.getTicketReviewById(ctx, 2, first)).toBeNull();
  });

  it('posting is compare-and-set, and a re-raise inherits the posting', async () => {
    const item = (await persist.getTicketReviewById(ctx, 1, first))!.items[0]!;
    expect(await persist.markTicketItemPosted(ctx, 2, item.id, { prId: pr.web!, commentId: 'c0' })).toBe(false);
    expect(
      await persist.markTicketItemPosted(ctx, 1, item.id, { prId: pr.web!, commentId: 'c1', postedAt: new Date(Date.now() - 60_000) }),
    ).toBe(true);
    expect(await persist.markTicketItemPosted(ctx, 1, item.id, { prId: pr.web!, commentId: 'c2' })).toBe(false);
    second = await runOnce('cascade', 'not_met');
    const again = (await persist.getTicketReviewById(ctx, 1, second))!.items[0]!;
    expect(again.priorItemId).toBe(item.id);
    expect(again.posted?.commentId).toBe('c1');
    expect(again.posted?.carried).toBe(true);
    expect(await persist.markTicketItemPosted(ctx, 1, again.id, { prId: pr.web!, commentId: 'c3' })).toBe(false);
  });

  it('currency inputs: current until a member pushes', async () => {
    const inputs = (await persist.getTicketStateInputs(ctx, 1, [IDENT, 'jira:x#NOPE-1'])).get(IDENT)!;
    expect(inputs.latest?.id).toBe(second);
    expect(inputs.runningRunId).toBeNull();
    const live = await fp.readLiveMembers(ctx, 1, [pr.api!, pr.web!]);
    const h = fp.ticketHash(story);
    expect(fp.deriveTicketReviewState({ ident: IDENT, latest: inputs.latest, runningRunId: null, live: { ticketHash: h, members: live } }).status).toBe('current');
    const { eq } = await import('drizzle-orm');
    await db.update(schema.pullRequests).set({ headSha: 'h_web2' }).where(eq(schema.pullRequests.id, pr.web!)).execute();
    const moved = await fp.readLiveMembers(ctx, 1, [pr.api!, pr.web!]);
    const st = fp.deriveTicketReviewState({ ident: IDENT, latest: inputs.latest, runningRunId: null, live: { ticketHash: h, members: moved } });
    expect(st.status).toBe('stale');
    expect(st.staleBecause).toEqual(['pr_pushed']);
    expect(st.changedPrIds).toEqual([pr.web]);
    const none = (await persist.getTicketStateInputs(ctx, 1, ['jira:x#NOPE-1'])).get('jira:x#NOPE-1')!;
    expect(none.latest).toBeNull();
    expect((await persist.getTicketStateInputs(ctx, 2, [IDENT])).get(IDENT)!.latest).toBeNull();
  });

  it('owned items come from the latest succeeded run only', async () => {
    const owned = await persist.getOwnedTicketItemsForPr(ctx, 1, pr.web!);
    expect(owned.map((o) => o.ticketReviewId)).toEqual([second]);
    expect(await persist.getOwnedTicketItemsForPr(ctx, 1, pr.api!)).toEqual([]);
    expect(await persist.getOwnedTicketItemsForPr(ctx, 2, pr.web!)).toEqual([]);
  });

  it('the daily cap counts auto and cascade runs, never manual', async () => {
    await runOnce('auto', 'met');
    const dayStart = Date.now() - 3_600_000;
    expect(await persist.countAutoTicketReviewsSince(ctx, 1, ws, dayStart)).toBe(2);
    expect(await persist.countAutoTicketReviewsSince(ctx, 2, ws, dayStart)).toBe(0);
  });

  it('lists the latest run of each ticket a PR is on', async () => {
    const list = await persist.listLatestTicketReviewsForPr(ctx, 1, pr.web!);
    expect(list).toHaveLength(1);
    expect(list[0]?.alignment).toBe('aligned');
    expect(await persist.listLatestTicketReviewsForPr(ctx, 2, pr.web!)).toEqual([]);
  });

  it('legacy story findings come from the latest run that checked a story, not the latest run', async () => {
    const { loadLegacyStoryFindings } = await import('./prepare.js');
    const [old] = await db
      .insert(schema.claudeReviews)
      .values({ accountId: 1, prId: pr.api!, headSha: 'h0', status: 'succeeded', model: 'm', ticket: [story] })
      .returning()
      .execute();
    await db
      .insert(schema.claudeReviewFindings)
      .values({ reviewId: old.id, path: 'a.ts', severity: 'major', title: 'PDF missing', body: 'b', storyIndex: 0, storyRef: 'S1-AC2' })
      .execute();
    // A PR review written since the split stores no story; it must not hide the earlier verdict.
    await db
      .insert(schema.claudeReviews)
      .values({ accountId: 1, prId: pr.api!, headSha: 'h1', status: 'succeeded', model: 'm' })
      .execute();
    const found = await loadLegacyStoryFindings(ctx, 1, [pr.api!], { key: 'BMD-1', title: 'Export' });
    expect(found.map((f) => f.ref)).toEqual(['S1-AC2']);
    expect(await loadLegacyStoryFindings(ctx, 2, [pr.api!], { key: 'BMD-1', title: 'Export' })).toEqual([]);
    expect(await loadLegacyStoryFindings(ctx, 1, [pr.api!], { key: 'OTHER-9', title: 'x' })).toEqual([]);
  });

  it('⚠ a thrown failure or a restart clears the fingerprint (retryable); a run that ended without an answer keeps it; spend is recorded either way', async () => {
    const OTHER = 'jira:https://acme.atlassian.net/rest/api/3#BMD-77';
    const start = async (): Promise<number> => {
      const id = await persist.insertQueuedTicketReview(ctx, {
        accountId: 1,
        workspaceId: ws,
        ident: OTHER,
        ticketKey: 'BMD-77',
        ticketTitle: null,
        ticket: null,
        originPrId: pr.api!,
        trigger: 'auto',
        model: 'm',
      });
      await persist.markTicketReviewRunning(ctx, 1, id, {
        ticket: story,
        ticketHash: 'h',
        fingerprint: 'fp',
        prCount: 1,
        members: [],
      });
      return id;
    };
    usage.length = 0;
    const thrown = await start();
    await persist.markTicketReviewFailed(ctx, 1, thrown, 'network', { costUsd: 0.5 }, { retryable: true });
    expect((await persist.getTicketReviewRow(ctx, 1, thrown))?.fingerprint).toBeNull();
    const stopped = await start();
    await persist.markTicketReviewFailed(ctx, 1, stopped, 'budget', { costUsd: 4 });
    expect((await persist.getTicketReviewRow(ctx, 1, stopped))?.fingerprint).toBe('fp');
    const cancelled = await start();
    await persist.markTicketReviewCancelled(ctx, 1, cancelled, { costUsd: 1 });
    expect((await persist.getTicketReviewRow(ctx, 1, cancelled))?.costUsd).toBe(1);
    expect(usage.map((u) => [u.feature, u.costUsd])).toEqual([
      ['ticket_review', 0.5],
      ['ticket_review', 4],
      ['ticket_review', 1],
    ]);
    const orphan = await start();
    expect(await persist.reconcileOrphanedTicketReviews(ctx)).toBeGreaterThanOrEqual(1);
    const row = await persist.getTicketReviewRow(ctx, 1, orphan);
    expect([row?.status, row?.fingerprint]).toEqual(['failed', null]);
  });

  it('deleting a member PR keeps runs other PRs hold; the last one drops them', async () => {
    const { pruneTicketReviewsForPrs } = await import('../../db/ticket-review-prune.js');
    await client.runTransaction((tx: any) => pruneTicketReviewsForPrs(tx, [pr.web!]));
    const kept = await persist.getTicketReviewById(ctx, 1, second);
    expect(kept?.members.map((m) => m.prId)).toEqual([pr.api]);
    expect(kept?.items[0]?.ownerPrId).toBeNull();
    await client.runTransaction((tx: any) => pruneTicketReviewsForPrs(tx, [pr.api!]));
    expect(await persist.getTicketReviewById(ctx, 1, second)).toBeNull();
  });
});
