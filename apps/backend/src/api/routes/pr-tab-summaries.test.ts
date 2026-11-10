// POST /api/prs/tab-summaries over the REAL core client and a real Fastify. What this pins:
//   1. The stored row, the repo's full name, the author and the thread counts by derived state.
//   2. ⚠ Another account's PR is ABSENT — the same answer as "never synced".
//   3. A malformed or over-cap list 400s rather than truncating.
//
//   pnpm --filter @pierre-review/backend test pr-tab-summaries
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PR_TAB_SUMMARIES_MAX, type PrTabSummariesResponse } from '@pierre-review/shared';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-pr-tab-summaries-route.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let closeDb: (() => Promise<void> | void) | undefined;
let app: FastifyInstance;
let mine = 0;
let quiet = 0;
let theirs = 0;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  const db: any = client.db;
  const schema: any = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  await db
    .insert(schema.accounts)
    .values([
      { id: 1, githubUserId: 'U_me', githubLogin: 'me', isLocal: true },
      { id: 2, githubUserId: 'U_other', githubLogin: 'other', isLocal: false },
    ])
    .onConflictDoNothing()
    .execute();
  const [author] = await db
    .insert(schema.users)
    .values({ githubLogin: 'robin-dev', displayName: 'Robin' })
    .returning()
    .execute();
  const pr = async (accountId: number, owner: string, name: string, extra: Record<string, unknown>): Promise<number> => {
    const [r] = await db
      .insert(schema.repos)
      .values({ accountId, owner, name, githubNodeId: `R_${owner}_${name}` })
      .returning()
      .execute();
    const [p] = await db
      .insert(schema.pullRequests)
      .values({
        githubNodeId: `PR_${owner}_${name}`,
        accountId,
        repoId: r.id,
        number: 7,
        title: `${name} change`,
        state: 'open',
        isDraft: false,
        headSha: 'h',
        openedAt: new Date(),
        updatedAt: new Date(),
        ...extra,
      })
      .returning()
      .execute();
    return p.id;
  };
  mine = await pr(1, 'acme', 'api', {
    authorId: author.id,
    ciStatus: 'failure',
    mergeable: 'mergeable',
    mergeStateStatus: 'blocked',
    reviewDecision: 'changes_requested',
    inMergeQueue: null,
  });
  quiet = await pr(1, 'acme', 'web', { state: 'merged', isDraft: false });
  theirs = await pr(2, 'secret', 'vault', {});
  const thread = (prId: number, n: number, derivedState: string, isResolved = false) =>
    db
      .insert(schema.reviewThreads)
      .values({ githubNodeId: `T_${prId}_${n}`, prId, path: 'a.ts', isResolved, derivedState, createdAt: new Date() })
      .execute();
  await thread(mine, 1, 'untouched');
  await thread(mine, 2, 'untouched');
  await thread(mine, 3, 'likely_addressed');
  await thread(mine, 4, 'resolved', true);
  await thread(theirs, 1, 'untouched');

  const { default: Fastify } = await import('fastify');
  const { prTabSummaryRoutes } = await import('./pr-tab-summaries.js');
  app = Fastify({ logger: false });
  await app.register(prTabSummaryRoutes);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

const read = (prIds: unknown) => app.inject({ method: 'POST', url: '/api/prs/tab-summaries', payload: { prIds } });

describe('POST /api/prs/tab-summaries', () => {
  it("answers the account's PRs from the database, and nobody else's", async () => {
    const res = await read([mine, quiet, theirs, 999_999]);
    expect(res.statusCode).toBe(200);
    const prs = (res.json() as PrTabSummariesResponse).prs;
    expect(prs.map((p) => p.id).sort((a, b) => a - b)).toEqual([mine, quiet].sort((a, b) => a - b));
    expect(prs.find((p) => p.id === mine)).toEqual({
      id: mine,
      repoFullName: 'acme/api',
      number: 7,
      title: 'api change',
      authorLogin: 'robin-dev',
      authorDisplayName: 'Robin',
      state: 'open',
      isDraft: false,
      ciStatus: 'failure',
      mergeable: 'mergeable',
      mergeStateStatus: 'blocked',
      reviewDecision: 'changes_requested',
      inMergeQueue: false,
      threadCounts: { resolved: 1, likely_addressed: 1, replied_unresolved: 0, untouched: 2 },
    });
    expect(prs.find((p) => p.id === quiet)).toMatchObject({
      repoFullName: 'acme/web',
      authorLogin: null,
      state: 'merged',
      ciStatus: 'unknown',
      reviewDecision: null,
      threadCounts: { resolved: 0, likely_addressed: 0, replied_unresolved: 0, untouched: 0 },
    });
  });

  it('400s a malformed or over-cap list', async () => {
    expect((await read('x')).statusCode).toBe(400);
    expect((await read([1.5])).statusCode).toBe(400);
    expect((await read(Array.from({ length: PR_TAB_SUMMARIES_MAX + 1 }, (_, i) => i + 1))).statusCode).toBe(400);
    expect((await read([])).json()).toEqual({ prs: [] });
  });
});
