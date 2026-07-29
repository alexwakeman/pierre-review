// The auto-merge intent query layer AND the watcher that acts on it, on a THROWAWAY sqlite DB.
//
// Three things worth pinning in the query layer, all safety properties rather than plumbing:
//
//  1. CROSS-ACCOUNT ISOLATION. `auto_merge_requests` is an accountId-bearing table reached by
//     id-addressed routes, so a foreign prId must read as null and a foreign disarm must be a
//     no-op — not "delete the other tenant's pending merge".
//  2. RE-ARM OVERWRITES, including from a terminal state. `(accountId, prId)` is unique; after
//     a `disarmed_head_moved` the user re-arms against the NEW head and the row must come back
//     clean (state 'armed', reason cleared) rather than accumulate history.
//  3. The RUNNER SCAN only returns still-armed rows, returns each row's accountId (that is what
//     makes the watcher fetch the right tenant's token), and rotates a backlog bigger than one
//     tick's bound instead of re-picking the same rows forever.
//
// The watcher tests drive `runAutoMergeTick` against the real DB with GitHub stubbed out. They
// exist because this is the one background pass that can MERGE REAL CODE: every case below is
// something that, wrong, either lands a commit nobody consented to or never lands at all.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The watcher's two outside edges. The DB stays real — the row transitions ARE the behaviour.
vi.mock('../github/mutations.js', () => ({
  fetchPrMergeSnapshot: vi.fn(),
  fetchCommitParents: vi.fn(),
  isCommitContainedInRef: vi.fn(),
  mergePullRequest: vi.fn(),
  updatePullRequestBranch: vi.fn(),
}));
vi.mock('../auth/account.js', () => ({
  getAccessToken: vi.fn(async () => 'gho_test'),
  getAccountUserId: vi.fn(async () => null),
}));

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
// A third PR, on a repo the account has WRITE on and with a SYNCED base ref — the shape the
// watcher needs (no write permission ⇒ it disarms; no synced base ⇒ it can't confirm consent).
let prC = 0;

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

  const [repoC] = await db
    .insert(repos)
    .values({
      accountId: A,
      owner: 'orgc',
      name: 'repoc',
      githubNodeId: 'R_c',
      viewerPermission: 'WRITE',
    })
    .returning()
    .execute();
  const [pr] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: 'PR_c',
      accountId: A,
      repoId: repoC.id,
      number: 7,
      title: 'PR c',
      state: 'open',
      isDraft: false,
      baseRefName: 'main',
      headRefName: 'feat',
      openedAt: new Date(now - 4 * HOUR),
      updatedAt: new Date(now - HOUR),
    })
    .returning()
    .execute();
  prC = pr.id;
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

// The scan order is a FAIRNESS property, not cosmetics: `armedAt` never changes after arming,
// so ordering on it meant a backlog bigger than one tick's bound re-processed the same oldest
// rows forever and the intent past the bound was never evaluated at all.
describe('the runner scan rotates the backlog', () => {
  beforeAll(async () => {
    await db.delete(schema.autoMergeRequests).execute();
    await q.armAutoMerge(A, prA, armArgs('a1'));
    await q.armAutoMerge(B, prB, armArgs('b1'));
    await q.armAutoMerge(A, prC, armArgs('c1'));
  });

  const idFor = async (prId: number): Promise<number> => {
    const rows = await db.select().from(schema.autoMergeRequests).execute();
    return rows.find((r: any) => r.prId === prId).id;
  };

  it('orders least-recently-checked first, never-checked before everything', async () => {
    await q.updateAutoMergeState(await idFor(prA), {
      checkedAt: new Date(now - 10 * 60 * 1000),
      lastReason: 'waiting',
    });
    await q.updateAutoMergeState(await idFor(prB), {
      checkedAt: new Date(now - 60 * 1000),
      lastReason: 'waiting',
    });
    // prC has never been checked → it must come first in BOTH dialects (sqlite sorts NULLs
    // first in ASC, Postgres sorts them last, hence the explicit CASE key in the query).
    const scan = await q.listArmedMergeRequestsForRunner(50);
    expect(scan.map((w: any) => w.prId)).toEqual([prC, prA, prB]);
    // The scan also carries the synced base ref — the watcher's retarget guard reads it.
    expect(scan.find((w: any) => w.prId === prC).syncedBaseRef).toBe('main');
  });

  it('a bounded tick advances instead of re-picking the same row', async () => {
    const first = await q.listArmedMergeRequestsForRunner(1);
    expect(first[0].prId).toBe(prC);
    await q.updateAutoMergeState(first[0].id, { lastReason: 'waiting' });
    const second = await q.listArmedMergeRequestsForRunner(1);
    expect(second[0].prId).toBe(prA);
  });
});

// The watcher itself, GitHub stubbed. Each case is a way the pass could merge code nobody
// consented to — or never merge at all.
describe('the auto-merge watcher', () => {
  let runner: any;
  let gh: any;
  const log = { info: () => {}, warn: () => {}, error: () => {} } as any;

  const snapshot = (over: Record<string, unknown> = {}) => ({
    headSha: 'aaa',
    headRef: 'feat',
    headRepoFullName: 'orgc/repoc',
    isFork: false,
    maintainerCanModify: true,
    mergeable: true,
    mergeableState: 'clean',
    baseRef: 'main',
    baseSha: 'base0',
    behindBy: 0,
    aheadBy: 1,
    ...over,
  });

  const rowFor = async (prId: number): Promise<any> => {
    const rows = await db.select().from(schema.autoMergeRequests).execute();
    return rows.find((r: any) => r.prId === prId);
  };

  beforeAll(async () => {
    runner = await import('../merge/auto-merge-runner.js');
    gh = await import('../github/mutations.js');
  });

  beforeEach(async () => {
    for (const fn of [
      gh.fetchPrMergeSnapshot,
      gh.fetchCommitParents,
      gh.isCommitContainedInRef,
      gh.mergePullRequest,
      gh.updatePullRequestBranch,
    ]) {
      fn.mockReset();
    }
    await db.delete(schema.autoMergeRequests).execute();
    // A previous case may have landed the PR locally; every case starts from an open one.
    const { eq } = await import('drizzle-orm');
    await db
      .update(schema.pullRequests)
      .set({ state: 'open' })
      .where(eq(schema.pullRequests.id, prC))
      .execute();
  });

  it('merges a CLEAN pr whose trunk merely moved on (behindBy is not a blocker)', async () => {
    // The regression: `behindBy` comes from an independent /compare and is > 0 for almost every
    // healthy PR, so treating it as "behind" parked every armed PR forever when the user chose
    // updateStrategy 'none'. Only GitHub's own 'behind' merge state blocks a merge.
    await q.armAutoMerge(A, prC, { ...armArgs('aaa'), updateStrategy: 'none' });
    gh.fetchPrMergeSnapshot.mockResolvedValue(snapshot({ mergeableState: 'clean', behindBy: 3 }));
    gh.mergePullRequest.mockResolvedValue({ ok: true, sha: 'landed1' });

    await runner.runAutoMergeTick(log);

    expect(gh.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(gh.mergePullRequest.mock.calls[0][4]).toMatchObject({ expectedHeadSha: 'aaa' });
    expect((await rowFor(prC)).state).toBe('merged');
  });

  it('refuses to merge a PR that was RETARGETED to another base', async () => {
    // The head pin can't see a retarget — head.sha is untouched — so without this the watcher
    // would land the change in a branch the user never chose.
    await q.armAutoMerge(A, prC, { ...armArgs('bbb'), updateStrategy: 'none' });
    gh.fetchPrMergeSnapshot.mockResolvedValue(snapshot({ headSha: 'bbb', baseRef: 'release/2' }));

    await runner.runAutoMergeTick(log);

    expect(gh.mergePullRequest).not.toHaveBeenCalled();
    const row = await rowFor(prC);
    expect(row.state).toBe('disarmed_blocked');
    expect(row.lastReason).toContain('retargeted');
  });

  it('does not adopt a head it merely OBSERVED after an async update-branch', async () => {
    await q.armAutoMerge(A, prC, { ...armArgs('ccc'), updateStrategy: 'merge' });
    gh.fetchPrMergeSnapshot.mockResolvedValue(
      snapshot({ headSha: 'ccc', mergeableState: 'behind', behindBy: 2 }),
    );
    gh.updatePullRequestBranch.mockResolvedValue({ ok: true });

    await runner.runAutoMergeTick(log);

    expect(gh.updatePullRequestBranch).toHaveBeenCalledTimes(1);
    const afterUpdate = await rowFor(prC);
    // GitHub's 202 is ASYNC: the pin must stay put until the move is PROVEN to be ours.
    expect(afterUpdate.expectedHeadOid).toBe('ccc');
    expect(afterUpdate.state).toBe('armed');

    // A human pushed inside the update window: one parent, so not our merge commit.
    gh.fetchPrMergeSnapshot.mockResolvedValue(snapshot({ headSha: 'human1' }));
    gh.fetchCommitParents.mockResolvedValue(['ccc']);
    await runner.runAutoMergeTick(log);

    expect(gh.mergePullRequest).not.toHaveBeenCalled();
    expect((await rowFor(prC)).state).toBe('disarmed_head_moved');
  });

  it('re-pins only to the PROVEN base-into-head merge it asked for', async () => {
    await q.armAutoMerge(A, prC, { ...armArgs('ddd'), updateStrategy: 'merge' });
    gh.fetchPrMergeSnapshot.mockResolvedValue(
      snapshot({ headSha: 'ddd', mergeableState: 'behind', behindBy: 2 }),
    );
    gh.updatePullRequestBranch.mockResolvedValue({ ok: true });
    await runner.runAutoMergeTick(log);

    // Two parents, first = the head we asked GitHub to update, second contained in the base.
    gh.fetchPrMergeSnapshot.mockResolvedValue(snapshot({ headSha: 'ourmerge1' }));
    gh.fetchCommitParents.mockResolvedValue(['ddd', 'basetip1']);
    gh.isCommitContainedInRef.mockResolvedValue(true);
    await runner.runAutoMergeTick(log);

    const row = await rowFor(prC);
    expect(row.state).toBe('armed');
    expect(row.expectedHeadOid).toBe('ourmerge1');
    // The move is not merged on the same tick — the new head's checks haven't even queued.
    expect(gh.mergePullRequest).not.toHaveBeenCalled();
  });

  it('a Cancel during the tick wins the race (compare-and-set before merging)', async () => {
    await q.armAutoMerge(A, prC, { ...armArgs('eee'), updateStrategy: 'none' });
    // The user hits Cancel while the tick is out at GitHub — which is where all the time goes.
    gh.fetchPrMergeSnapshot.mockImplementation(async () => {
      await q.disarmAutoMerge(A, prC);
      return snapshot({ headSha: 'eee' });
    });
    gh.mergePullRequest.mockResolvedValue({ ok: true, sha: 'landed2' });

    await runner.runAutoMergeTick(log);

    expect(gh.mergePullRequest).not.toHaveBeenCalled();
    expect(await q.getAutoMergeRequest(A, prC)).toBeNull();
  });
});
