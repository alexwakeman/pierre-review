// POST /api/claude-review/states — the Open PRs table's "Claude review" column: the LATEST run
// per listed PR, over the REAL core client and migrations (the claude-review-persist precedent),
// so the account join and the head comparison run against the real schema.
//
// ⚠ DATABASE_URL IS SET BEFORE THE FIRST IMPORT of the host's config/client.
//
// AUTO REVIEW: the manager's live hold is folded over the stored runs — a PR whose auto review
// still waits in its lane (NO row yet) reads `queued`, an auto run in flight reads the hold's
// status, and `trigger` rides every entry so the cell can mark auto runs.
//
//   pnpm --filter @pierre-review/backend test claude-review-states
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CLAUDE_REVIEW_STATES_MAX_IDS, type ClaudeReviewTicket } from '@pierre-review/shared';
import type { AgentContext as ProContext } from '../agent-context.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const DB_PATH = '/tmp/pierre-claude-review-states.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

// The manager's live auto-review holds, per (account 1) PR id. Another account sees none.
const holds = new Map<number, 'queued' | 'running'>();
vi.mock('./manager.js', () => ({
  AGENTIC_AI_ENABLED: true,
  autoReviewHold: (prId: number, accountId: number) =>
    accountId === 1 ? (holds.get(prId) ?? null) : null,
  startReview: vi.fn(),
  getReviewStatus: vi.fn(),
  listActiveReviews: vi.fn(() => []),
  requestReviewCancel: vi.fn(() => false),
  subscribeReviewStream: vi.fn(() => () => {}),
}));

let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let app: FastifyInstance;
let persist: typeof import('./persist.js');
let ctx: ProContext;
// PRs of account 1: never reviewed / reviewed at head / reviewed, then pushed / re-run queued.
let fresh = 0;
let current = 0;
let moved = 0;
let rerun = 0;
let foreign = 0;
// Auto review: waiting in its lane (no row) / its run in flight / finished.
let lane = 0;
let autoRunning = 0;
let autoDone = 0;

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const ticket: ClaudeReviewTicket = { title: 'Reset password', description: null, acceptanceCriteria: '- a' };

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  ctx = {
    db,
    schema,
    isPg: false,
    runTransaction: client.runTransaction,
    log: { warn: () => {}, info: () => {}, error: () => {} },
    // The account comes from a test header so one app serves both tenants.
    accountIdOf: (req: any) => Number(req.headers['x-account'] ?? 1),
  } as any as ProContext;
  persist = await import('./persist.js');

  const { accounts, repos, pullRequests } = schema;
  await db
    .insert(accounts)
    .values({ id: 2, githubUserId: 'U_states_other', githubLogin: 'other', isLocal: false })
    .execute();
  const repo = async (accountId: number, key: string) =>
    (
      await db
        .insert(repos)
        .values({ accountId, owner: 'acme', name: key, githubNodeId: `R_${key}` })
        .returning()
        .execute()
    )[0].id as number;
  const pr = async (accountId: number, repoId: number, key: string, n: number) =>
    (
      await db
        .insert(pullRequests)
        .values({
          githubNodeId: `PR_${key}`,
          accountId,
          repoId,
          number: n,
          title: key,
          state: 'open',
          isDraft: false,
          openedAt: new Date(),
          updatedAt: new Date(),
          headSha: HEAD,
        })
        .returning()
        .execute()
    )[0].id as number;
  const r1 = await repo(1, 'states-a');
  fresh = await pr(1, r1, 'fresh', 1);
  current = await pr(1, r1, 'current', 2);
  moved = await pr(1, r1, 'moved', 3);
  rerun = await pr(1, r1, 'rerun', 4);
  lane = await pr(1, r1, 'lane', 5);
  autoRunning = await pr(1, r1, 'auto-running', 6);
  autoDone = await pr(1, r1, 'auto-done', 7);
  const r2 = await repo(2, 'states-foreign');
  foreign = await pr(2, r2, 'foreign', 1);

  const succeed = async (id: number, verdict: 'APPROVE' | 'REQUEST_CHANGES') =>
    persist.saveReviewSuccess(ctx, id, {
      scope: 'diff_only',
      summary: 's',
      verdict,
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
      numTurns: 1,
      excludedFiles: [],
      findings: [],
    } as any);

  await succeed(await persist.insertQueuedReview(ctx, current, HEAD, 'claude-opus-5-5', 1, ticket), 'APPROVE');
  await succeed(await persist.insertQueuedReview(ctx, moved, OLD, 'claude-opus-5-5', 1), 'REQUEST_CHANGES');
  await succeed(await persist.insertQueuedReview(ctx, rerun, OLD, 'claude-opus-5-5', 1), 'APPROVE');
  await persist.insertQueuedReview(ctx, rerun, HEAD, 'claude-opus-5-5', 1);
  await succeed(await persist.insertQueuedReview(ctx, foreign, HEAD, 'claude-opus-5-5', 2), 'APPROVE');
  // The auto runs: one still queued in the DB (the manager says it is running), one finished.
  await persist.insertQueuedReview(ctx, autoRunning, HEAD, 'claude-opus-5-5', 1, null, 'auto');
  await succeed(
    await persist.insertQueuedReview(ctx, autoDone, HEAD, 'claude-opus-5-5', 1, null, 'auto'),
    'APPROVE',
  );

  const { default: Fastify } = await import('fastify');
  const { registerClaudeReviewRoutes } = await import('./routes.js');
  app = Fastify({ logger: false });
  registerClaudeReviewRoutes(app, ctx);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

const states = (prIds: unknown, account = 1) =>
  app.inject({
    method: 'POST',
    url: '/api/claude-review/states',
    headers: { 'x-account': String(account) },
    payload: { prIds } as object,
  });

describe('POST /api/claude-review/states', () => {
  it('returns the latest run per PR, with the ticket and the moved flag; unreviewed PRs are absent', async () => {
    const res = await states([fresh, current, moved, rerun]);
    expect(res.statusCode).toBe(200);
    const byPr = new Map((res.json().states as any[]).map((s) => [s.prId, s]));
    expect(byPr.has(fresh)).toBe(false);
    expect(byPr.get(current)).toMatchObject({
      status: 'succeeded',
      verdict: 'APPROVE',
      reviewedHeadSha: HEAD,
      headMoved: false,
      ticket: { title: 'Reset password', acceptanceCriteria: '- a' },
    });
    expect(typeof byPr.get(current).finishedAt).toBe('string');
    expect(byPr.get(moved)).toMatchObject({
      status: 'succeeded',
      verdict: 'REQUEST_CHANGES',
      reviewedHeadSha: OLD,
      headMoved: true,
      ticket: null,
    });
    // Two runs: the NEWEST wins, even though the older one succeeded.
    expect(byPr.get(rerun)).toMatchObject({ status: 'queued', verdict: null, headMoved: false });
  });

  it("never returns another account's run", async () => {
    const mine = await states([foreign, current]);
    expect((mine.json().states as any[]).map((s) => s.prId)).toEqual([current]);
    const theirs = await states([foreign, current], 2);
    expect((theirs.json().states as any[]).map((s) => s.prId)).toEqual([foreign]);
  });

  it('an empty list is an empty answer; duplicates count once', async () => {
    expect((await states([])).json()).toEqual({ states: [] });
    const dup = await states([current, current]);
    expect(dup.json().states).toHaveLength(1);
  });

  it('over the cap ⇒ 400, never truncated', async () => {
    const ids = Array.from({ length: CLAUDE_REVIEW_STATES_MAX_IDS + 1 }, (_, i) => i + 1);
    const res = await states(ids);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'TooManyIds' });
    const atCap = await states(ids.slice(0, CLAUDE_REVIEW_STATES_MAX_IDS));
    expect(atCap.statusCode).toBe(200);
  });

  it('a malformed body ⇒ 400', async () => {
    expect((await states('nope')).statusCode).toBe(400);
    expect((await states(['x'])).statusCode).toBe(400);
  });
});

describe('POST /api/claude-review/states — auto review', () => {
  afterAll(() => holds.clear());

  it('a PR whose auto review waits in its lane (no row) reads queued, with no review id', async () => {
    holds.set(lane, 'queued');
    const byPr = new Map(((await states([lane, current])).json().states as any[]).map((s) => [s.prId, s]));
    expect(byPr.get(lane)).toEqual({
      prId: lane,
      reviewId: null,
      status: 'queued',
      verdict: null,
      reviewedHeadSha: null,
      finishedAt: null,
      ticket: null,
      headMoved: false,
      trigger: 'auto',
    });
    // A clicked run says so too.
    expect(byPr.get(current)).toMatchObject({ trigger: 'manual' });
  });

  it('an auto run in flight takes the hold\'s status and keeps its row', async () => {
    holds.set(autoRunning, 'running');
    const [s] = (await states([autoRunning])).json().states as any[];
    expect(s).toMatchObject({ prId: autoRunning, status: 'running', trigger: 'auto' });
    expect(typeof s.reviewId).toBe('number');
  });

  it('a finished auto run carries trigger auto, so the cell can mark it', async () => {
    const [s] = (await states([autoDone])).json().states as any[];
    expect(s).toMatchObject({ status: 'succeeded', verdict: 'APPROVE', trigger: 'auto' });
  });

  it("never reports another account's hold", async () => {
    holds.set(lane, 'queued');
    const theirs = await states([lane], 2);
    expect(theirs.json().states).toEqual([]);
  });

  it('once the hold ends, a lane PR with no row is absent again', async () => {
    holds.delete(lane);
    const res = await states([lane]);
    expect(res.json().states).toEqual([]);
  });
});
