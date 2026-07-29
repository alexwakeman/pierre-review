// The auto-merge intent query layer, on a THROWAWAY sqlite DB.
//
// Three things worth pinning, all of them safety properties rather than plumbing:
//
//  1. CROSS-ACCOUNT ISOLATION. `auto_merge_requests` is an accountId-bearing table reached by
//     id-addressed routes, so a foreign prId must read as null and a foreign disarm must be a
//     no-op — not "delete the other tenant's pending merge".
//  2. RE-ARM OVERWRITES, including from a terminal state. `(accountId, prId)` is unique; after
//     a `disarmed_head_moved` the user re-arms against the NEW head and the row must come back
//     clean (state 'armed', reason cleared) rather than accumulate history.
//  3. The RUNNER SCAN only returns still-armed rows, and returns each row's accountId — that
//     accountId is what makes the watcher fetch the right tenant's token.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-auto-merge-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let q: any;

const HOUR = 60 * 60 * 1000;
const now = Math.floor(Date.now() / 1000) * 1000;

// account 1 is seeded by migration 0008; account 2 is the other tenant.
const A = 1;
const B = 2;
let prA = 0;
let prB = 0;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  q = await import('./queries.js');
  await runMigrations();

  const { accounts, repos, pullRequests } = schema;
  await db
    .insert(accounts)
    .values({ id: B, githubUserId: 'U_b', githubLogin: 'bob', isLocal: false })
    .execute();

  const seed = async (accountId: number, tag: string): Promise<number> => {
    const [repo] = await db
      .insert(repos)
      .values({ accountId, owner: `org${tag}`, name: `repo${tag}`, githubNodeId: `R_${tag}` })
      .returning()
      .execute();
    const [pr] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: `PR_${tag}`,
        accountId,
        repoId: repo.id,
        number: 1,
        title: `PR ${tag}`,
        state: 'open',
        isDraft: false,
        openedAt: new Date(now - 4 * HOUR),
        updatedAt: new Date(now - HOUR),
      })
      .returning()
      .execute();
    return pr.id;
  };
  prA = await seed(A, 'a');
  prB = await seed(B, 'b');
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

const armArgs = (oid: string) => ({
  mergeMethod: 'squash' as const,
  updateStrategy: 'none' as const,
  expectedHeadOid: oid,
  expiresAt: new Date(now + 72 * HOUR),
});

describe('auto-merge intents', () => {
  it('arms, reads back, and pins the expected head', async () => {
    const armed = await q.armAutoMerge(A, prA, armArgs('aaaaaaa1'));
    expect(armed.state).toBe('armed');
    expect(armed.expectedHeadOid).toBe('aaaaaaa1');
    expect(armed.mergeMethod).toBe('squash');
    expect(armed.lastCheckedAt).toBeNull();

    const read = await q.getAutoMergeRequest(A, prA);
    expect(read?.prId).toBe(prA);
  });

  it('is account-scoped in both directions (IDOR blocked)', async () => {
    await q.armAutoMerge(B, prB, armArgs('bbbbbbb1'));

    // B cannot see A's intent through A's prId…
    expect(await q.getAutoMergeRequest(B, prA)).toBeNull();
    // …and A cannot see B's.
    expect(await q.getAutoMergeRequest(A, prB)).toBeNull();

    // A's list is A's only.
    const listA = await q.listAutoMergeRequests(A);
    expect(listA.map((r: any) => r.prId)).toEqual([prA]);

    // A foreign disarm reports "nothing was armed" AND leaves the row alone.
    expect(await q.disarmAutoMerge(B, prA)).toBe(false);
    expect(await q.getAutoMergeRequest(A, prA)).not.toBeNull();
  });

  it('re-arming overwrites a TERMINAL row back to a clean armed state', async () => {
    const first = await q.getAutoMergeRequest(A, prA);
    expect(first?.state).toBe('armed');

    // The watcher disarms it: the branch moved.
    const rows = await db.select().from(schema.autoMergeRequests).execute();
    const rowA = rows.find((r: any) => r.prId === prA);
    await q.updateAutoMergeState(rowA.id, {
      state: 'disarmed_head_moved',
      lastReason: 'the branch moved (aaaaaaa1 → aaaaaaa2)',
    });
    const disarmed = await q.getAutoMergeRequest(A, prA);
    expect(disarmed.state).toBe('disarmed_head_moved');
    expect(disarmed.lastReason).toContain('the branch moved');
    // A resolved row must drop out of the runner's scan immediately.
    expect(
      (await q.listArmedMergeRequestsForRunner(50)).map((w: any) => w.prId),
    ).not.toContain(prA);

    // The user re-arms against the new head.
    const rearmed = await q.armAutoMerge(A, prA, armArgs('aaaaaaa2'));
    expect(rearmed.state).toBe('armed');
    expect(rearmed.expectedHeadOid).toBe('aaaaaaa2');
    expect(rearmed.lastReason).toBeNull();
    expect(rearmed.lastCheckedAt).toBeNull();
    // Still exactly one row for the PR — a re-arm is an overwrite, not an append.
    const all = await db.select().from(schema.autoMergeRequests).execute();
    expect(all.filter((r: any) => r.prId === prA)).toHaveLength(1);
  });

  it('the runner scan returns armed rows with their owning account + repo coordinates', async () => {
    const work = await q.listArmedMergeRequestsForRunner(50);
    const byPr = new Map<number, any>(work.map((w: any) => [w.prId, w]));
    expect(byPr.get(prA)?.accountId).toBe(A);
    expect(byPr.get(prB)?.accountId).toBe(B);
    expect(byPr.get(prA)?.owner).toBe('orga');
    expect(byPr.get(prA)?.prState).toBe('open');
    // The bound is honoured — one tick must never be unbounded GitHub traffic.
    expect(await q.listArmedMergeRequestsForRunner(1)).toHaveLength(1);
  });

  it('disarm deletes the row (an intent the user withdrew is not history)', async () => {
    expect(await q.disarmAutoMerge(A, prA)).toBe(true);
    expect(await q.getAutoMergeRequest(A, prA)).toBeNull();
    // Idempotent: a second disarm is a no-op, not an error.
    expect(await q.disarmAutoMerge(A, prA)).toBe(false);
    // B's intent is untouched.
    expect((await q.getAutoMergeRequest(B, prB))?.state).toBe('armed');
  });
});
