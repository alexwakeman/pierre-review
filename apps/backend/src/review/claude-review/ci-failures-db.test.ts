// FAILED CI ON THE REVIEWED HEAD over the REAL core client and migrations (the threads-db.test.ts
// pattern). What this pins:
//   1. `claude_reviews.ci_failures` (sqlite 0077) round-trips on the ClaudeReview wire as
//      `ciFailures` + `ciState`.
//   2. An older row (no column value) reads as null on BOTH fields — never [] (which means "looked,
//      nothing failing").
//   3. `loadPriorRunForCarry` hands the stored failures to the next run's carry-forward.
//
//   pnpm --filter @pierre-review/backend test claude-review/ci-failures-db
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClaudeCiFailuresRecord } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';

const DB_PATH = '/tmp/pierre-claude-review-ci-failures-db.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let persist: typeof import('./persist.js');
let ctx: AgentContext;
let prId = 0;

const record: ClaudeCiFailuresRecord = {
  state: 'failing',
  checkCount: 5,
  failures: [
    {
      ref: 'F1',
      checkName: 'test (node 20)',
      jobId: 123,
      step: 'Run tests',
      url: 'https://github.com/acme/api/actions/runs/9/job/123',
      sent: true,
      carried: false,
      status: 'diagnosed',
      notCheckedReason: null,
      cause: 'A test asserts the old default',
      explanation: 'add.test.ts expects 3; the change returns 4.',
      category: 'test',
      fixableInPr: true,
      relatedFiles: [{ path: 'src/add.test.ts', line: 12 }],
      assessedAtHead: 'head_ci',
    },
    {
      ref: null,
      checkName: 'SonarCloud',
      jobId: null,
      step: null,
      url: 'https://sonarcloud.io/x',
      sent: false,
      carried: false,
      status: 'not_checked',
      notCheckedReason: 'no_log',
      cause: null,
      explanation: null,
      category: null,
      fixableInPr: null,
      relatedFiles: [],
      assessedAtHead: 'head_ci',
    },
  ],
};

async function run(headSha: string, status = 'succeeded'): Promise<number> {
  const [row] = await db
    .insert(schema.claudeReviews)
    .values({ accountId: 1, prId, headSha, status, model: 'claude-opus-5-5', createdAt: new Date() })
    .returning()
    .execute();
  return row.id;
}

const success = (ciFailures: ClaudeCiFailuresRecord | null) => ({
  scope: 'worktree' as const,
  summary: 's',
  verdict: 'COMMENT' as const,
  costUsd: null,
  inputTokens: null,
  outputTokens: null,
  numTurns: 1,
  excludedFiles: [],
  findings: [],
  ciFailures,
});

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  persist = await import('./persist.js');
  ctx = {
    db,
    schema,
    isPg: false,
    runTransaction: client.runTransaction,
    recordAiUsage: async () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as any as AgentContext;
  await db
    .insert(schema.accounts)
    .values({ id: 1, githubUserId: 'U_me', githubLogin: 'me', isLocal: true })
    .onConflictDoNothing()
    .execute();
  const [u] = await db.insert(schema.users).values({ githubLogin: 'alice', githubNodeId: 'U_alice' }).returning().execute();
  const [repo] = await db
    .insert(schema.repos)
    .values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_ci' })
    .returning()
    .execute();
  const [p] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: 'PR_ci',
      accountId: 1,
      repoId: repo.id,
      number: 1,
      title: 'ci',
      state: 'open',
      isDraft: false,
      authorId: u.id,
      headSha: 'head_ci',
      openedAt: new Date(),
      updatedAt: new Date(),
    })
    .returning()
    .execute();
  prId = p.id;
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('ci_failures on the ClaudeReview wire', () => {
  it('round-trips the failures and the head state', async () => {
    const id = await run('head_ci', 'running');
    await persist.saveReviewSuccess(ctx, id, success(record));
    const r = (await persist.getClaudeReviewById(ctx, id, 1))!;
    expect(r.ciFailures).toEqual(record.failures);
    expect(r.ciState).toEqual({ state: 'failing', checkCount: 5 });
  });

  it('a green head stores [] — "looked, nothing failing"', async () => {
    const id = await run('head_ci', 'running');
    await persist.saveReviewSuccess(ctx, id, success({ state: 'passing', checkCount: 3, failures: [] }));
    const r = (await persist.getClaudeReviewById(ctx, id, 1))!;
    expect(r.ciFailures).toEqual([]);
    expect(r.ciState).toEqual({ state: 'passing', checkCount: 3 });
  });

  it('an older row, or a run that did not look, reads null on both fields', async () => {
    const old = (await persist.getClaudeReviewById(ctx, await run('head_ci'), 1))!;
    expect(old.ciFailures).toBeNull();
    expect(old.ciState).toBeNull();
    const id = await run('head_ci', 'running');
    await persist.saveReviewSuccess(ctx, id, success(null));
    const r = (await persist.getClaudeReviewById(ctx, id, 1))!;
    expect(r.ciFailures).toBeNull();
    expect(r.ciState).toBeNull();
  });

  it('the next run carries the stored failures forward', async () => {
    const id = await run('head_ci', 'running');
    await persist.saveReviewSuccess(ctx, id, success(record));
    const prior = await persist.loadPriorRunForCarry(ctx, prId, 1, id + 1);
    expect(prior?.ciFailures).toEqual(record.failures);
  });

  it('a malformed stored value is never guessed into a shape', () => {
    expect(persist.ciRecordOf(null)).toBeNull();
    expect(persist.ciRecordOf([])).toBeNull();
    expect(persist.ciRecordOf({ state: 'failing' })).toBeNull();
  });
});
