// THE STORY CHECK'S STORED CLOCK in persistPr (migration 0182): `head_seen_at` is when Limn SAW the
// head move and `head_burst_at` where the current run of pushes began. Throwaway sqlite, the real
// persistPr, no GitHub.
//
// What this pins:
//   1. An insert stamps both with the PR's opening (never "now": a first sync of an old PR is not a push).
//   2. A walk that restates the same head writes nothing.
//   3. A new head stamps `head_seen_at` with the time it was SEEN — never the commit's committedAt.
//   4. A head with no known head before it (a read that lacked it) is not a push.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GqlPullRequest } from '../github/queries.js';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-upsert-head-seen-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let upsert: typeof import('./upsert.js');
let repoId = 0;

const head = (oid: string | null) => ({
  headCommit: { nodes: oid == null ? [] : [{ commit: { oid, statusCheckRollup: null } }] },
  commits: { nodes: oid == null ? [] : [{ commit: { oid, committedDate: '2026-01-01T00:00:00Z' } }] },
});

function gqlPr(n: number, over: Partial<GqlPullRequest> = {}): GqlPullRequest {
  return {
    id: `PR_head_${n}`,
    number: n,
    title: 'Bump mermaid from 11.15.0 to 11.16.1',
    body: null,
    bodyText: '',
    isDraft: false,
    state: 'OPEN',
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    files: { nodes: [] },
    createdAt: '2026-09-01T00:00:00Z',
    mergedAt: null,
    closedAt: null,
    updatedAt: '2026-09-02T00:00:00Z',
    url: `https://github.com/acme/head/pull/${n}`,
    baseRefName: 'main',
    headRefName: 'dependabot/npm_and_yarn/mermaid-11.16.1',
    mergeable: null,
    mergeStateStatus: null,
    author: { login: 'dependabot[bot]', id: 'BOT_dependabot', __typename: 'Bot' },
    mergedBy: null,
    labels: { nodes: [{ name: 'dependencies', color: '0366d6' }] },
    reviewRequests: { nodes: [] },
    reviews: { nodes: [] },
    reviewThreads: { nodes: [] },
    comments: { nodes: [] },
    commits: { nodes: [] },
    ...over,
  } as unknown as GqlPullRequest;
}

async function persist(pr: GqlPullRequest): Promise<void> {
  await upsert.persistPr(pr, repoId, upsert.createUserResolver(), new Map(), 1);
}

async function rowOf(nodeId: string): Promise<any> {
  const { eq } = await import('drizzle-orm');
  return (
    await db.select().from(schema.pullRequests).where(eq(schema.pullRequests.githubNodeId, nodeId)).execute()
  )[0];
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../db/run-migrations.js');
  const client = await import('../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  upsert = await import('./upsert.js');
  const [r] = await db
    .insert(schema.repos)
    .values({ accountId: 1, owner: 'acme', name: 'head', githubNodeId: 'R_head_1' })
    .returning()
    .execute();
  repoId = r.id;
});

afterAll(() => {
  vi.useRealTimers();
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('persistPr — head_seen_at / head_burst_at', () => {
  it('an insert stamps the opening; the same head again writes nothing', async () => {
    await persist(gqlPr(1, head('a1') as any));
    const row = await rowOf('PR_head_1');
    expect(row.headSeenAt.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(row.headBurstAt.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    await persist(gqlPr(1, head('a1') as any));
    expect((await rowOf('PR_head_1')).headSeenAt.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('a new head is stamped when SEEN; pushes under 2 minutes apart keep the burst start', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-09T15:00:00Z'));
    await persist(gqlPr(1, head('a2') as any));
    let row = await rowOf('PR_head_1');
    expect(row.headSeenAt.toISOString()).toBe('2026-11-09T15:00:00.000Z');
    expect(row.headBurstAt.toISOString()).toBe('2026-11-09T15:00:00.000Z');
    vi.setSystemTime(new Date('2026-11-09T15:01:30Z'));
    await persist(gqlPr(1, head('a3') as any));
    row = await rowOf('PR_head_1');
    expect(row.headSeenAt.toISOString()).toBe('2026-11-09T15:01:30.000Z');
    expect(row.headBurstAt.toISOString()).toBe('2026-11-09T15:00:00.000Z');
    vi.setSystemTime(new Date('2026-11-09T15:10:00Z'));
    await persist(gqlPr(1, head('a4') as any));
    row = await rowOf('PR_head_1');
    expect(row.headBurstAt.toISOString()).toBe('2026-11-09T15:10:00.000Z');
    vi.useRealTimers();
  });

  it('a head refilled after a read without one is not a push', async () => {
    await persist(gqlPr(2, head(null) as any));
    expect((await rowOf('PR_head_2')).headSeenAt).toBeNull();
    await persist(gqlPr(2, head('b1') as any));
    expect((await rowOf('PR_head_2')).headSeenAt).toBeNull();
  });
});
