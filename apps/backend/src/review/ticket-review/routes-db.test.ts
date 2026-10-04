// THE TICKET REVIEW ROUTES over the REAL core client, a real Fastify and a fake GitHub seam. What
// this pins:
//   1. Posting an item goes to its OWNER PR (else the viewed PR, which must be a member), at the
//      head the run judged, with the story lead; a second post is 409 AlreadyPosted.
//   2. ⚠ A re-raised item is never posted twice: the newer run's copy inherits the posting, and an
//      older run's item is refused once a newer check exists.
//   3. Pasted stories start one-PR 'manual:' runs; the states route refuses over-cap and malformed
//      ident lists rather than truncating.
//
//   pnpm --filter @pierre-review/backend test ticket-review/routes-db
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { TicketAssessment } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';

const DB_PATH = '/tmp/pierre-ticket-review-routes-db.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

const startTicketReview = vi.fn(async () => ({ outcome: 'queued' as const, runId: 999 }));
vi.mock('./manager.js', () => ({
  startTicketReview: (...a: unknown[]) => (startTicketReview as (...x: unknown[]) => unknown)(...a),
  getTicketRunStatus: vi.fn(async () => null),
  subscribeTicketReviewStream: vi.fn(() => () => {}),
}));
vi.mock('../../sync/resync-after-write.js', () => ({ settlePrAfterWrite: async () => ({ visible: true }) }));

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let persist: typeof import('./persist.js');
let fp: typeof import('./fingerprint.js');
let app: FastifyInstance;
let ctx: AgentContext;
const pr: Record<string, number> = {};
const postFinding = vi.fn(async () => ({ commentId: 'gh-1', postedCommentKind: 'pr_comment' as const }));

const IDENT = 'jira:https://acme.atlassian.net/rest/api/3#BMD-7';
const story = { title: 'Export', description: 'd', acceptanceCriteria: '- CSV\n- PDF', source: 'jira' as const, key: 'BMD-7' };
const assessment: TicketAssessment = { alignment: 'partly_aligned', summary: null, criteria: [], missing: [], notRequested: [] };

async function run(items: Array<{ ref: string; ownerPrId: number | null; title: string }>): Promise<number> {
  const live = await fp.readLiveMembers(ctx, 1, [pr.api!, pr.web!]);
  const h = fp.ticketHash(story);
  const id = await persist.insertQueuedTicketReview(ctx, {
    accountId: 1,
    workspaceId: 1,
    ident: IDENT,
    ticketKey: 'BMD-7',
    ticketTitle: 'Export',
    ticket: null,
    originPrId: pr.api!,
    trigger: 'manual',
    model: 'm',
  });
  await persist.markTicketReviewRunning(ctx, 1, id, {
    ticket: story,
    ticketHash: h,
    fingerprint: fp.fingerprint(h, live),
    prCount: 2,
    members: live.map((m) => ({ ...m, checkedOut: true })),
  });
  await persist.saveTicketReviewSuccess(ctx, 1, id, {
    alignment: 'partly_aligned',
    summary: null,
    assessment,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    numTurns: 1,
    items: items.map((i) => ({ ...i, status: 'not_met' as const, body: 'why', path: null, line: null })),
  });
  return id;
}

const postItem = (runId: number, itemId: number, viewedPrId: number) =>
  app.inject({ method: 'POST', url: `/api/ticket-reviews/${runId}/items/${itemId}/post`, payload: { viewedPrId } });

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
  await db.insert(schema.accounts).values({ id: 1, githubUserId: 'U_me', githubLogin: 'me', isLocal: true }).onConflictDoNothing().execute();
  let n = 0;
  for (const name of ['api', 'web', 'other']) {
    const [r] = await db.insert(schema.repos).values({ accountId: 1, owner: 'acme', name, githubNodeId: `R_${name}` }).returning().execute();
    const [p] = await db
      .insert(schema.pullRequests)
      .values({
        githubNodeId: `PR_${name}`,
        accountId: 1,
        repoId: r.id,
        number: (n += 1),
        title: name,
        state: 'open',
        isDraft: false,
        headSha: `h_${name}`,
        openedAt: new Date(),
        updatedAt: new Date(),
      })
      .returning()
      .execute();
    pr[name] = p.id;
  }
  ctx = {
    db,
    schema,
    isPg: false,
    runTransaction: client.runTransaction,
    recordAiUsage: async () => {},
    accountIdOf: () => 1,
    host: { isCloud: false },
    llm: { detectAuth: () => ({ status: 'ok' }) },
    aiCredits: { check: async () => ({ agentBlocked: false }) },
    review: { postFinding },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as any as AgentContext;
  const { default: Fastify } = await import('fastify');
  const { registerTicketReviewRoutes } = await import('./routes.js');
  app = Fastify({ logger: false });
  registerTicketReviewRoutes(app, ctx);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

beforeEach(() => {
  postFinding.mockClear();
  startTicketReview.mockClear();
});

describe('POST /api/ticket-reviews/:id/items/:itemId/post', () => {
  let first = 0;
  let firstItems: number[] = [];

  it('posts to the owner PR at the judged head, once', async () => {
    first = await run([
      { ref: 'AC1', ownerPrId: null, title: 'CSV' },
      { ref: 'AC2', ownerPrId: pr.web!, title: 'PDF' },
    ]);
    firstItems = (await persist.getTicketReviewById(ctx, 1, first))!.items.map((i) => i.id);

    const res = await postItem(first, firstItems[1]!, pr.api!);
    expect(res.statusCode).toBe(200);
    const call = (postFinding.mock.calls[0] as unknown[])[0] as any;
    expect(call.prNumber).toBe(2);
    expect(call.reviewHeadSha).toBe('h_web');
    expect(call.finding.storyLead).toBe('BMD-7 · AC2 (not met): PDF');
    expect(res.json().item.posted.commentId).toBe('gh-1');
    const again = await postItem(first, firstItems[1]!, pr.api!);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('AlreadyPosted');
  });

  it('an unowned item goes to the viewed PR, which must be a member', async () => {
    const outside = await postItem(first, firstItems[0]!, pr.other!);
    expect(outside.statusCode).toBe(400);
    expect(outside.json().error).toBe('NotAMember');
    expect(postFinding).not.toHaveBeenCalled();
  });

  it('⚠ a re-raise inherits the posting, and an older run is superseded', async () => {
    const second = await run([
      { ref: 'AC1', ownerPrId: null, title: 'CSV' },
      { ref: 'AC2', ownerPrId: null, title: 'PDF' },
    ]);
    const items = (await persist.getTicketReviewById(ctx, 1, second))!.items;
    const reraised = items.find((i) => i.title === 'PDF')!;
    expect(reraised.posted?.commentId).toBe('gh-1');
    expect((await postItem(second, reraised.id, pr.api!)).json().error).toBe('AlreadyPosted');
    const old = await postItem(first, firstItems[0]!, pr.api!);
    expect(old.statusCode).toBe(409);
    expect(old.json().error).toBe('Superseded');
    expect(postFinding).not.toHaveBeenCalled();
  });
});

describe('POST /api/ticket-reviews', () => {
  it('a pasted story starts a one-PR manual run', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ticket-reviews',
      payload: { prId: pr.api, tickets: [{ title: 'Pasted', acceptanceCriteria: '- a' }] },
    });
    expect(res.statusCode).toBe(202);
    const args = (startTicketReview.mock.calls[0] as unknown[])[1] as any;
    expect(args.ident).toMatch(new RegExp(`^manual:${pr.api}:[0-9a-f]{8}$`));
    expect(args.manualTicket.title).toBe('Pasted');
    expect(args.trigger).toBe('manual');
  });

  it('an unknown PR is 404 and a malformed ident 400', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/ticket-reviews', payload: { prId: 9999 } })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'POST', url: '/api/ticket-reviews', payload: { prId: pr.api, ident: 'nope' } })).statusCode,
    ).toBe(400);
  });
});

describe('POST /api/ticket-reviews/states', () => {
  it('refuses over-cap and malformed lists, answers in request order', async () => {
    const many = Array.from({ length: 101 }, (_, i) => `jira:https://x#K-${i + 1}`);
    expect((await app.inject({ method: 'POST', url: '/api/ticket-reviews/states', payload: { idents: many } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/ticket-reviews/states', payload: { idents: ['bad'] } })).statusCode).toBe(400);
    const res = await app.inject({ method: 'POST', url: '/api/ticket-reviews/states', payload: { idents: [IDENT, 'jira:https://x#K-1'] } });
    expect(res.statusCode).toBe(200);
    expect(res.json().states.map((s: any) => [s.ident, s.status])).toEqual([
      [IDENT, 'current'],
      ['jira:https://x#K-1', 'none'],
    ]);
  });
});
