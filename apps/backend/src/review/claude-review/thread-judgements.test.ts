// POST /api/claude-review/thread-judgements — the thread cards' Claude marker: per PR, the NEWEST
// succeeded run that assessed threads, over the REAL core client and migrations.
//
// ⚠ DATABASE_URL IS SET BEFORE THE FIRST IMPORT of the host's config/client (a scratch file).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq as eqOp } from 'drizzle-orm';
import type { ClaudeThreadAssessment } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const DB_PATH = '/tmp/pierre-claude-thread-judgements.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

vi.mock('./manager.js', () => ({
  AGENTIC_AI_ENABLED: true,
  autoReviewHold: () => null,
  startReview: vi.fn(),
  getReviewStatus: vi.fn(),
  listActiveReviews: vi.fn(() => []),
  requestReviewCancel: vi.fn(() => false),
  subscribeReviewStream: vi.fn(() => () => {}),
}));
vi.mock('../../coding/ai-fix/manager.js', () => ({
  isFixRunning: () => false,
  startReviewFix: vi.fn(),
  loadReviewSeed: vi.fn(),
}));

let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let app: FastifyInstance;
let judged = 0;
let newerRunning = 0;
let never = 0;
let foreign = 0;
let judgedReview = 0;
let olderReview = 0;

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

const assessment = (threadId: number, over: Partial<ClaudeThreadAssessment> = {}): ClaudeThreadAssessment => ({
  ref: 'R1',
  threadId,
  sent: true,
  carried: false,
  authorLogin: 'x',
  authorIsBot: false,
  path: 'a.ts',
  line: 1,
  excerpt: 'e',
  commentCount: 1,
  lastCommentAt: null,
  url: null,
  validity: 'valid',
  addressed: 'addressed',
  explanation: 'The rename covers it.',
  draftReply: null,
  assessedAtHead: HEAD,
  ...over,
});

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  const ctx = {
    db,
    schema,
    isPg: false,
    runTransaction: client.runTransaction,
    log: { warn: () => {}, info: () => {}, error: () => {} },
    accountIdOf: (req: any) => Number(req.headers['x-account'] ?? 1),
  } as any as AgentContext;
  const persist = await import('./persist.js');

  const { accounts, repos, pullRequests, claudeReviews } = schema;
  await db
    .insert(accounts)
    .values({ id: 2, githubUserId: 'U_tj_other', githubLogin: 'other', isLocal: false })
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
  const r1 = await repo(1, 'tj-a');
  judged = await pr(1, r1, 'judged', 1);
  newerRunning = await pr(1, r1, 'newer-running', 2);
  never = await pr(1, r1, 'never', 3);
  foreign = await pr(2, await repo(2, 'tj-foreign'), 'foreign', 1);

  const succeed = async (id: number, threadAssessments: ClaudeThreadAssessment[] | null) => {
    await persist.saveReviewSuccess(ctx, id, {
      scope: 'diff_only',
      summary: 's',
      verdict: 'APPROVE',
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
      numTurns: 1,
      excludedFiles: [],
      findings: [],
    } as any);
    await db.update(claudeReviews).set({ threadAssessments }).where(eqOp(claudeReviews.id, id)).execute();
  };

  // `judged`: an OLDER run's judgements, then the newest run's (which wins); the newest run also
  // carries a not_checked thread (dropped) and an earlier-head judgement.
  olderReview = await persist.insertQueuedReview(ctx, judged, OLD, 'claude-opus-5-5', 1);
  await succeed(olderReview, [assessment(1, { addressed: 'not_addressed', assessedAtHead: OLD })]);
  judgedReview = await persist.insertQueuedReview(ctx, judged, HEAD, 'claude-opus-5-5', 1);
  await succeed(judgedReview, [
    assessment(1),
    assessment(2, { validity: 'not_checked', addressed: 'not_checked', sent: false, ref: null }),
    assessment(3, { validity: 'not_valid', carried: true, assessedAtHead: OLD }),
  ]);
  // `newerRunning`: a succeeded run with judgements, then a newer run still queued — the older stands.
  const first = await persist.insertQueuedReview(ctx, newerRunning, OLD, 'claude-opus-5-5', 1);
  await succeed(first, [assessment(9, { assessedAtHead: OLD })]);
  await persist.insertQueuedReview(ctx, newerRunning, HEAD, 'claude-opus-5-5', 1);
  // `foreign`: another account's run.
  await succeed(await persist.insertQueuedReview(ctx, foreign, HEAD, 'claude-opus-5-5', 2), [assessment(5)]);

  const { default: Fastify } = await import('fastify');
  const { registerClaudeReviewRoutes } = await import('./routes.js');
  app = Fastify({ logger: false });
  registerClaudeReviewRoutes(app, ctx as any);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

const read = (prIds: unknown, account = 1) =>
  app.inject({
    method: 'POST',
    url: '/api/claude-review/thread-judgements',
    headers: { 'x-account': String(account) },
    payload: { prIds } as object,
  });

describe('POST /api/claude-review/thread-judgements', () => {
  it('serves the newest succeeded run that judged threads, and drops unjudged threads', async () => {
    const res = await read([judged, never]);
    expect(res.statusCode).toBe(200);
    const prs = res.json().prs as any[];
    expect(prs.map((p) => p.prId)).toEqual([judged]);
    const p = prs[0];
    expect(p).toMatchObject({ reviewId: judgedReview, reviewedHeadSha: HEAD, currentHeadSha: HEAD });
    expect(p.judgements).toEqual([
      {
        threadId: 1,
        validity: 'valid',
        addressed: 'addressed',
        explanation: 'The rename covers it.',
        assessedAtHead: HEAD,
        carried: false,
      },
      {
        threadId: 3,
        validity: 'not_valid',
        addressed: 'addressed',
        explanation: 'The rename covers it.',
        assessedAtHead: OLD,
        carried: true,
      },
    ]);
  });

  it('a newer run still in flight does not hide the last judgements', async () => {
    const prs = (await read([newerRunning])).json().prs as any[];
    expect(prs).toHaveLength(1);
    expect(prs[0].judgements.map((j: any) => j.threadId)).toEqual([9]);
    expect(prs[0].reviewedHeadSha).toBe(OLD);
  });

  it("never returns another account's judgements", async () => {
    expect(((await read([foreign, judged])).json().prs as any[]).map((p) => p.prId)).toEqual([judged]);
    expect(((await read([foreign, judged], 2)).json().prs as any[]).map((p) => p.prId)).toEqual([foreign]);
  });

  it('empty ⇒ empty; over the cap or malformed ⇒ 400', async () => {
    expect((await read([])).json()).toEqual({ prs: [] });
    const ids = Array.from({ length: 1001 }, (_, i) => i + 1);
    expect((await read(ids)).statusCode).toBe(400);
    expect((await read(['x'])).statusCode).toBe(400);
  });
});
