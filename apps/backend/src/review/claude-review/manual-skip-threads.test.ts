// A MANUAL review routed `skip` (no textual change) reads no code and so judges no thread. A person
// who pressed Review still gets the threads judged: Check threads starts in its place (its own door
// and caps). An AUTO run is unchanged. Over the REAL core client and migrations, a fake prepare.
//
//   pnpm --filter @pierre-review/backend test manual-skip-threads
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentContext } from '../agent-context.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const DB_PATH = '/tmp/pierre-claude-review-manual-skip.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
delete process.env.LIMN_AI_DISABLED;

const beside = vi.hoisted(() => ({ calls: [] as Array<[number, number]> }));
vi.mock('./thread-check.js', () => ({
  startThreadCheckBesideManualReview: async (_ctx: unknown, accountId: number, prId: number) => {
    beside.calls.push([accountId, prId]);
    return { outcome: 'refused', reason: 'nothing_changed' };
  },
}));

const HEAD = 'a'.repeat(40);
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let ctx: AgentContext;
let manager: typeof import('./manager.js');
let persist: typeof import('./persist.js');
let prId = 0;
let runs = 0;
let lines = 0;

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
    runTransaction: client.runTransaction,
    log: { warn: () => {}, info: () => {}, error: () => {} },
    recordAiUsage: async () => {},
    aiCredits: { check: async () => ({ agentBlocked: false }) },
    review: {
      prepareReview: async () => ({
        strippedDiff: '',
        promptDiff: '',
        changedFiles: ['bin.png'],
        excludedFiles: [],
        omittedFiles: [],
        // 0 lines ⇒ the router answers `skip`.
        fileMetrics: [{ path: 'bin.png', additions: lines, deletions: 0, isNew: false, apiTouch: false }],
        diffBytes: 0,
        diffCapped: false,
      }),
      runReview: async () => {
        runs += 1;
        return { submitted: true, scope: 'diff_only', summary: 'ok', verdict: 'COMMENT', findings: [], costUsd: null, inputTokens: null, outputTokens: null, numTurns: 1 };
      },
    },
    github: { fetchCompareDiff: async () => ({ ok: false }) },
    queries: {},
  } as any as AgentContext;
  manager = await import('./manager.js');
  persist = await import('./persist.js');
  const repoId = (
    await db.insert(schema.repos).values({ accountId: 1, owner: 'acme', name: 'skip', githubNodeId: 'R_skip' }).returning().execute()
  )[0].id;
  prId = (
    await db
      .insert(schema.pullRequests)
      .values({ githubNodeId: 'PR_skip', accountId: 1, repoId, number: 1, title: 'skip', state: 'open', isDraft: false, openedAt: new Date(), updatedAt: new Date(), headSha: HEAD })
      .returning()
      .execute()
  )[0].id;
});

afterAll(() => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

async function runToEnd(): Promise<string> {
  const started = await manager.startReview(ctx, 1, prId, 'claude-opus-5-5');
  if (!started.ok) throw new Error(`not started: ${started.reason}`);
  for (let i = 0; i < 200; i++) {
    const r = await persist.getClaudeReviewById(ctx, started.reviewId, 1);
    if (r && r.status !== 'queued' && r.status !== 'running') {
      await new Promise((res) => setTimeout(res, 30));
      return r.reviewMode ?? '';
    }
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error('review did not finish');
}

describe('a manual review that reads no code', () => {
  it('starts Check threads in its place; a review that reads code judges threads itself', async () => {
    lines = 0;
    expect(await runToEnd()).toBe('skip');
    expect(runs).toBe(0);
    expect(beside.calls).toEqual([[1, prId]]);

    beside.calls.length = 0;
    lines = 3;
    expect(await runToEnd()).toBe('diff_only');
    expect(runs).toBe(1);
    expect(beside.calls).toEqual([]);
  });
});
