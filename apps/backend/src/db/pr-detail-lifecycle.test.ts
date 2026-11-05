// `PrDetail.lifecycle` — the PR detail Activity tab's reopen / ready-for-review moments, read from
// the synced event log on a THROWAWAY sqlite DB. Only those two types, only this PR, oldest first,
// and the actor resolves in `users[]`.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrDetail } from '@pierre-review/shared';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-pr-detail-lifecycle-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let q: any;
let closeDb: (() => Promise<void>) | undefined;
let prId = 0;
let authorId = 0;
const HOUR = 60 * 60 * 1000;
const now = Math.floor(Date.now() / 1000) * 1000;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  closeDb = client.closeDb;
  await runMigrations();
  q = await import('./queries.js');
  const db: any = client.db;
  const { events, repos, pullRequests, users } = client.schema as any;

  const [u] = await db
    .insert(users)
    .values({ githubLogin: 'dana-dev', githubNodeId: 'U_dana', isBot: false })
    .returning()
    .execute();
  authorId = u.id;
  const [repo] = await db
    .insert(repos)
    .values({ accountId: 1, owner: 'acme', name: 'life', githubNodeId: 'R_life', defaultBranch: 'main' })
    .returning()
    .execute();
  const mkPr = async (key: string): Promise<number> => {
    const [pr] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: `PR_life_${key}`,
        accountId: 1,
        repoId: repo.id,
        number: key === 'a' ? 1 : 2,
        title: key,
        state: 'open',
        isDraft: false,
        authorId,
        openedAt: new Date(now - 10 * HOUR),
        updatedAt: new Date(now - HOUR),
      })
      .returning()
      .execute();
    return pr.id;
  };
  prId = await mkPr('a');
  const other = await mkPr('b');
  const ev = (id: number, type: string, at: number, key: string) => ({
    accountId: 1,
    repoId: repo.id,
    prId: id,
    actorId: authorId,
    type,
    occurredAt: new Date(at),
    dedupeKey: key,
  });
  await db
    .insert(events)
    .values([
      ev(prId, 'pr_reopened', now - 2 * HOUR, 'pr_reopened:a'),
      ev(prId, 'pr_ready_for_review', now - 5 * HOUR, 'pr_ready_for_review:a'),
      ev(prId, 'commit_pushed', now - 3 * HOUR, 'commit:a'),
      ev(other, 'pr_reopened', now - HOUR, 'pr_reopened:b'),
    ])
    .execute();
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('PrDetail.lifecycle', () => {
  it('carries this PR’s reopen and ready-for-review events, oldest first, and nothing else', async () => {
    const d = (await q.getPrDetail(prId, 1)) as PrDetail;
    expect(d.lifecycle).toEqual([
      { type: 'pr_ready_for_review', at: new Date(now - 5 * HOUR).toISOString(), actorId: authorId },
      { type: 'pr_reopened', at: new Date(now - 2 * HOUR).toISOString(), actorId: authorId },
    ]);
    expect(d.users.some((u) => u.id === authorId)).toBe(true);
  });

  it('is scoped to the account', async () => {
    expect(await q.getPrDetail(prId, 2)).toBeNull();
  });
});
