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
  fetchMergeQueueState: vi.fn(),
  enqueuePullRequestOnQueue: vi.fn(),
  // The head-of-line rule's LIVE check read. Reset to a bare vi.fn() it resolves undefined,
  // which is the "we don't know" answer — and "don't know" never yields a slot.
  fetchPrHeadCheckRollup: vi.fn(),
}));
vi.mock('../auth/account.js', () => ({
  getAccessToken: vi.fn(async () => 'gho_test'),
  getAccountUserId: vi.fn(async () => null),
}));
// The clone-based rebase (local mode only), reached through a dynamic import inside the runner.
vi.mock('../coding/merge.js', () => ({
  updatePrBranchFromTrunk: vi.fn(async () => ({ headSha: 'rebased1' })),
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
// prD is a SECOND PR on the SAME repo as prC — the whole point of the landing-queue tests: two
// armed intents that must land one at a time. prE is the same shape on a DIFFERENT repo, which
// is what proves the queue is per-repo and not one global line. prF is a THIRD on repo C: a
// fallback that must take a PLACE in the FIFO can only be caught with somebody still in it.
let prD = 0;
let prE = 0;
let prF = 0;

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

  // A workable PR: WRITE on the repo + a synced base ref, so the watcher's pre-flight passes.
  const workablePr = async (
    repoId: number,
    tag: string,
    number: number,
  ): Promise<number> => {
    const [row] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: `PR_${tag}`,
        accountId: A,
        repoId,
        number,
        title: `PR ${tag}`,
        state: 'open',
        isDraft: false,
        baseRefName: 'main',
        headRefName: `feat-${tag}`,
        openedAt: new Date(now - 4 * HOUR),
        updatedAt: new Date(now - HOUR),
      })
      .returning()
      .execute();
    return row.id;
  };
  prD = await workablePr(repoC.id, 'd', 8);
  prF = await workablePr(repoC.id, 'f', 10);

  const [repoE] = await db
    .insert(repos)
    .values({
      accountId: A,
      owner: 'orge',
      name: 'repoe',
      githubNodeId: 'R_e',
      viewerPermission: 'WRITE',
    })
    .returning()
    .execute();
  prE = await workablePr(repoE.id, 'e', 9);
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

const armArgs = (oid: string) => ({
  mergeMethod: 'squash' as const,
  updateStrategy: 'none' as const,
  viaMergeQueue: false,
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
    // The arm RESPONSE is what the SPA seeds its progress card from, so it must already be
    // self-describing: an honest first phase (the watcher is up to a tick away) and the
    // repo/PR identity a cross-PR surface has no other way to look up.
    expect(armed.phase).toBe('pending_first_check');
    expect(armed.repoOwner).toBe('orga');
    expect(armed.repoName).toBe('repoa');
    expect(armed.prNumber).toBe(1);
    expect(armed.prTitle).toBe('PR a');

    const read = await q.getAutoMergeRequest(A, prA);
    expect(read?.prId).toBe(prA);
    const [listed] = await q.listAutoMergeRequests(A);
    expect(listed.repoOwner).toBe('orga');
    expect(listed.prTitle).toBe('PR a');
    expect(listed.phase).toBe('pending_first_check');
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

  it('stores the queue mode, and a re-arm resets the enqueue record (new consent)', async () => {
    const armed = await q.armAutoMerge(A, prA, { ...armArgs('qq1'), viaMergeQueue: true });
    expect(armed.viaMergeQueue).toBe(true);
    expect(armed.enqueuedAt).toBeNull();

    // The watcher enqueues → the stamp reads back and rides the runner scan (it is the
    // attribution record the queue phase keys every decision on).
    const rows = await db.select().from(schema.autoMergeRequests).execute();
    const rowA = rows.find((r: any) => r.prId === prA);
    await q.updateAutoMergeState(rowA.id, {
      enqueuedAt: new Date(now),
      lastReason: 'added to the merge queue',
    });
    const work = (await q.listArmedMergeRequestsForRunner(50)).find(
      (w: any) => w.prId === prA,
    );
    expect(work.viaMergeQueue).toBe(true);
    expect(work.enqueuedAt).not.toBeNull();

    // A re-arm is a NEW consent: the previous intent's queue entry must not be attributed
    // to it.
    const rearmed = await q.armAutoMerge(A, prA, { ...armArgs('qq2'), viaMergeQueue: false });
    expect(rearmed.viaMergeQueue).toBe(false);
    expect(rearmed.enqueuedAt).toBeNull();
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
      gh.fetchMergeQueueState,
      gh.enqueuePullRequestOnQueue,
      gh.fetchPrHeadCheckRollup,
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
    const row = await rowFor(prC);
    expect(row.state).toBe('merged');
    // A terminal row is described by `state` alone: `lastReason` is nulled on success, and a
    // leftover 'merging' phase would give the finished card a second, contradictory line.
    expect(row.lastReason).toBeNull();
    expect(row.phase).toBeNull();
  });

  it('says "merging" while the merge call is in flight (the row is never blank at success)', async () => {
    await q.armAutoMerge(A, prC, { ...armArgs('mmm'), updateStrategy: 'none' });
    gh.fetchPrMergeSnapshot.mockResolvedValue(snapshot({ headSha: 'mmm' }));
    // Observed from INSIDE the GitHub call — the whole point of the stamp is that the row is
    // honest for however long the merge takes, not just after it returns.
    let phaseDuringMerge: string | null = null;
    gh.mergePullRequest.mockImplementation(async () => {
      phaseDuringMerge = (await rowFor(prC)).phase;
      return { ok: true, sha: 'landed_m' };
    });

    await runner.runAutoMergeTick(log);

    expect(phaseDuringMerge).toBe('merging');
    expect((await rowFor(prC)).state).toBe('merged');
  });

  it('REBASES a behind branch, then WAITS FOR CHECKS — phase and prose say the same thing', async () => {
    await q.armAutoMerge(A, prC, { ...armArgs('rrr'), updateStrategy: 'rebase' });
    gh.fetchPrMergeSnapshot.mockResolvedValue(
      snapshot({ headSha: 'rrr', mergeableState: 'behind', behindBy: 2 }),
    );

    await runner.runAutoMergeTick(log);

    expect(gh.mergePullRequest).not.toHaveBeenCalled();
    const row = await rowFor(prC);
    expect(row.state).toBe('armed');
    // The rebase is SYNCHRONOUS, so the pin moves to the sha it pushed (unlike the async
    // native update below, which must not re-pin).
    expect(row.expectedHeadOid).toBe('rebased1');
    // ⚠ The rebase has ALREADY RETURNED by the time this row is written, so the phase must not
    // still say 'updating_rebase' — that spins "Rebasing onto the base branch…" for the rest of
    // the cron interval over a row whose own prose says it is waiting for checks. Phase and
    // prose disagreeing is precisely what this column exists to prevent.
    expect(row.phase).toBe('awaiting_checks');
    expect(row.lastReason).toContain('rebased onto main');
  });

  it("says 'updating_rebase' only WHILE the clone-based rebase is in flight", async () => {
    // The other half of the same rule: the phase is stamped before the call (like 'merging' and
    // 'enqueuing'), because a clone/fetch/rebase/force-push runs for tens of seconds and the SPA
    // re-reads this row every 8s. That window is the ONLY time "Rebasing…" is true.
    const { updatePrBranchFromTrunk } = await import('../coding/merge.js');
    let phaseDuringRebase: string | null = null;
    (updatePrBranchFromTrunk as any).mockImplementationOnce(async () => {
      phaseDuringRebase = (await rowFor(prC)).phase;
      return { headSha: 'rebased1' };
    });
    await q.armAutoMerge(A, prC, { ...armArgs('rr2'), updateStrategy: 'rebase' });
    gh.fetchPrMergeSnapshot.mockResolvedValue(
      snapshot({ headSha: 'rr2', mergeableState: 'behind', behindBy: 2 }),
    );

    await runner.runAutoMergeTick(log);

    expect(phaseDuringRebase).toBe('updating_rebase');
    // …and the prose is left alone until the outcome write, so nothing claims a rebase finished
    // while it is still running.
    expect((await rowFor(prC)).phase).toBe('awaiting_checks');
  });

  it("names WHICH half of 'blocked' is blocking, from the already-synced CI status", async () => {
    // GitHub collapses "required checks running" and "required reviews missing" into one
    // mergeableState. Guessing wrong here puts a false line in front of a user who is deciding
    // whether to go chase a reviewer, so the phase only says 'awaiting_checks' when the synced
    // status actually agrees the checks are still running.
    const { eq } = await import('drizzle-orm');
    const setCi = async (ciStatus: string | null): Promise<void> => {
      await db
        .update(schema.pullRequests)
        .set({ ciStatus })
        .where(eq(schema.pullRequests.id, prC))
        .execute();
    };

    gh.fetchPrMergeSnapshot.mockResolvedValue(
      snapshot({ headSha: 'bbb1', mergeableState: 'blocked' }),
    );

    await setCi('pending');
    await q.armAutoMerge(A, prC, { ...armArgs('bbb1'), updateStrategy: 'none' });
    await runner.runAutoMergeTick(log);
    expect((await rowFor(prC)).phase).toBe('awaiting_checks');

    // Checks are green (or unknown) → protection is blocking for some other reason; the
    // generic phase is the honest one.
    await setCi('success');
    await q.armAutoMerge(A, prC, { ...armArgs('bbb1'), updateStrategy: 'none' });
    await runner.runAutoMergeTick(log);
    const row = await rowFor(prC);
    expect(row.phase).toBe('blocked_protection');
    expect(row.state).toBe('armed');
    expect(gh.mergePullRequest).not.toHaveBeenCalled();

    await setCi(null);
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
    expect(afterUpdate.phase).toBe('updating_merge');

    // A human pushed inside the update window: one parent, so not our merge commit.
    gh.fetchPrMergeSnapshot.mockResolvedValue(snapshot({ headSha: 'human1' }));
    gh.fetchCommitParents.mockResolvedValue(['ccc']);
    await runner.runAutoMergeTick(log);

    expect(gh.mergePullRequest).not.toHaveBeenCalled();
    const disarmed = await rowFor(prC);
    expect(disarmed.state).toBe('disarmed_head_moved');
    // Terminal ⇒ no live phase, even though the previous tick left 'updating_merge' behind.
    expect(disarmed.phase).toBeNull();
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
    expect(row.phase).toBe('awaiting_checks');
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

// The merge-queue path. Same watcher, different terminal action: on a queue-protected base a
// direct merge is refused by GitHub, so the intent's landing verb is a head-pinned enqueue —
// and the entry's fate (queue-merged / thrown out / superseded by a human's own enqueue) is
// what resolves the intent.
describe('the auto-merge watcher on a merge-queue repo', () => {
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
    // A queue repo's resting status: a direct merge is never allowed there, so 'blocked' is
    // what GitHub reports even for a PR the queue would happily take.
    mergeableState: 'blocked',
    baseRef: 'main',
    baseSha: 'base0',
    behindBy: 0,
    aheadBy: 1,
    ...over,
  });

  const queueState = (over: Record<string, unknown> = {}) => ({
    enabled: true,
    inQueue: false,
    position: null,
    state: null,
    estimatedTimeToMergeMs: null,
    enqueuedAt: null,
    prState: 'OPEN',
    reviewDecision: null,
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
      gh.fetchMergeQueueState,
      gh.enqueuePullRequestOnQueue,
      gh.fetchPrHeadCheckRollup,
    ]) {
      fn.mockReset();
    }
    await db.delete(schema.autoMergeRequests).execute();
    const { eq } = await import('drizzle-orm');
    await db
      .update(schema.pullRequests)
      .set({ state: 'open' })
      .where(eq(schema.pullRequests.id, prC))
      .execute();
  });

  it('ENQUEUES instead of direct-merging, pinned to the consented head', async () => {
    await q.armAutoMerge(A, prC, { ...armArgs('qa1'), viaMergeQueue: true });
    gh.fetchPrMergeSnapshot.mockResolvedValue(snapshot({ headSha: 'qa1' }));
    gh.fetchMergeQueueState.mockResolvedValue(queueState());
    gh.enqueuePullRequestOnQueue.mockResolvedValue({
      position: 2,
      state: 'QUEUED',
      estimatedTimeToMergeMs: null,
    });

    await runner.runAutoMergeTick(log);

    expect(gh.mergePullRequest).not.toHaveBeenCalled();
    expect(gh.enqueuePullRequestOnQueue).toHaveBeenCalledTimes(1);
    // (token, prNodeId, expectedHeadOid) — the pin is the same consent anchor as PUT /merge.
    expect(gh.enqueuePullRequestOnQueue.mock.calls[0][1]).toBe('PR_c');
    expect(gh.enqueuePullRequestOnQueue.mock.calls[0][2]).toBe('qa1');
    const row = await rowFor(prC);
    expect(row.state).toBe('armed');
    expect(row.enqueuedAt).not.toBeNull();
    expect(row.lastReason).toContain('position 2');
    expect(row.phase).toBe('queued');
  });

  it('waits to enqueue while required reviews are missing — and says so by name', async () => {
    await q.armAutoMerge(A, prC, { ...armArgs('qb1'), viaMergeQueue: true });
    gh.fetchPrMergeSnapshot.mockResolvedValue(snapshot({ headSha: 'qb1' }));
    gh.fetchMergeQueueState.mockResolvedValue(queueState({ reviewDecision: 'REVIEW_REQUIRED' }));

    await runner.runAutoMergeTick(log);

    expect(gh.enqueuePullRequestOnQueue).not.toHaveBeenCalled();
    const row = await rowFor(prC);
    expect(row.state).toBe('armed');
    expect(row.enqueuedAt).toBeNull();
    expect(row.lastReason).toContain('required reviews');
    expect(row.phase).toBe('awaiting_review');
  });

  it("resolves 'merged' when the queue lands OUR entry (the toast is truthful)", async () => {
    await q.armAutoMerge(A, prC, { ...armArgs('qc1'), viaMergeQueue: true });
    gh.fetchPrMergeSnapshot.mockResolvedValue(snapshot({ headSha: 'qc1' }));
    gh.fetchMergeQueueState.mockResolvedValue(queueState());
    gh.enqueuePullRequestOnQueue.mockResolvedValue({
      position: 1,
      state: 'QUEUED',
      estimatedTimeToMergeMs: null,
    });
    await runner.runAutoMergeTick(log);
    expect((await rowFor(prC)).enqueuedAt).not.toBeNull();

    // Next tick: sitting in the queue — the steady state, still armed.
    gh.fetchMergeQueueState.mockResolvedValue(queueState({ inQueue: true, position: 1 }));
    await runner.runAutoMergeTick(log);
    const queued = await rowFor(prC);
    expect(queued.state).toBe('armed');
    expect(queued.lastReason).toContain('in the merge queue');

    // Final tick: the queue merged it. The LIVE state is what decides — the synced row can
    // lag a fast queue by a whole tick.
    gh.fetchMergeQueueState.mockResolvedValue(queueState({ prState: 'MERGED' }));
    await runner.runAutoMergeTick(log);
    expect((await rowFor(prC)).state).toBe('merged');
    expect(gh.mergePullRequest).not.toHaveBeenCalled();
  });

  it("a queue entry the watcher didn't create supersedes the intent", async () => {
    await q.armAutoMerge(A, prC, { ...armArgs('qd1'), viaMergeQueue: true });
    gh.fetchPrMergeSnapshot.mockResolvedValue(snapshot({ headSha: 'qd1' }));
    gh.fetchMergeQueueState.mockResolvedValue(queueState({ inQueue: true, position: 3 }));

    await runner.runAutoMergeTick(log);

    expect(gh.enqueuePullRequestOnQueue).not.toHaveBeenCalled();
    const row = await rowFor(prC);
    expect(row.state).toBe('disarmed_blocked');
    expect(row.lastReason).toContain('outside auto-merge');
  });

  it('stands down when OUR entry is thrown out of the queue, instead of re-enqueueing', async () => {
    await q.armAutoMerge(A, prC, { ...armArgs('qe1'), viaMergeQueue: true });
    gh.fetchPrMergeSnapshot.mockResolvedValue(snapshot({ headSha: 'qe1' }));
    gh.fetchMergeQueueState.mockResolvedValue(queueState());
    gh.enqueuePullRequestOnQueue.mockResolvedValue({
      position: 1,
      state: 'QUEUED',
      estimatedTimeToMergeMs: null,
    });
    await runner.runAutoMergeTick(log);

    // Dequeued (a human, or the queue judged it UNMERGEABLE) but still open: re-enqueueing
    // would fight that decision.
    gh.fetchMergeQueueState.mockResolvedValue(queueState());
    await runner.runAutoMergeTick(log);

    expect(gh.enqueuePullRequestOnQueue).toHaveBeenCalledTimes(1); // the first tick only
    const row = await rowFor(prC);
    expect(row.state).toBe('disarmed_blocked');
    expect(row.lastReason).toContain('removed from the merge queue');
  });

  it('falls back to the direct merge when the queue was disabled after arming', async () => {
    await q.armAutoMerge(A, prC, { ...armArgs('qf1'), viaMergeQueue: true });
    gh.fetchPrMergeSnapshot.mockResolvedValue(
      snapshot({ headSha: 'qf1', mergeableState: 'clean' }),
    );
    gh.fetchMergeQueueState.mockResolvedValue(queueState({ enabled: false }));
    gh.mergePullRequest.mockResolvedValue({ ok: true, sha: 'landed3' });

    // ⚠ TWO ticks, and the first one is the fix for a double merge, not latency for its own
    // sake: this intent is exempt from the per-repo landing FIFO *because the fold saw
    // `viaMergeQueue: true`*, and a direct merger exempt from the direct FIFO lands a second PR
    // on the repo in the same tick as its actual slot-holder (case (i) below). The first tick
    // that observes the queue gone re-classifies the intent and takes it a number; the next
    // fold gives it a real place and it merges from there.
    await runner.runAutoMergeTick(log);
    expect(gh.mergePullRequest).not.toHaveBeenCalled();
    expect((await rowFor(prC)).phase).toBe('queued_local');

    await runner.runAutoMergeTick(log);

    expect(gh.enqueuePullRequestOnQueue).not.toHaveBeenCalled();
    expect(gh.mergePullRequest).toHaveBeenCalledTimes(1);
    expect((await rowFor(prC)).state).toBe('merged');
  });

  it('freshens from trunk once BEFORE the enqueue, and never while the entry is queued', async () => {
    await q.armAutoMerge(A, prC, {
      ...armArgs('qg1'),
      viaMergeQueue: true,
      updateStrategy: 'merge',
    });
    gh.fetchMergeQueueState.mockResolvedValue(queueState());
    gh.fetchPrMergeSnapshot.mockResolvedValue(snapshot({ headSha: 'qg1', behindBy: 2 }));
    gh.updatePullRequestBranch.mockResolvedValue({ ok: true });

    // Tick 1: behind → bring it current first (the "update from trunk, then queue" contract).
    await runner.runAutoMergeTick(log);
    expect(gh.updatePullRequestBranch).toHaveBeenCalledTimes(1);
    expect(gh.enqueuePullRequestOnQueue).not.toHaveBeenCalled();

    // Tick 2: the head moved to OUR base-into-head merge → re-pin, give its checks a tick.
    gh.fetchPrMergeSnapshot.mockResolvedValue(snapshot({ headSha: 'ourqm1', behindBy: 2 }));
    gh.fetchCommitParents.mockResolvedValue(['qg1', 'trunktip1']);
    gh.isCommitContainedInRef.mockResolvedValue(true);
    await runner.runAutoMergeTick(log);
    expect((await rowFor(prC)).expectedHeadOid).toBe('ourqm1');

    // Tick 3: still nominally behind (trunk keeps moving) — freshening is ONCE, so this tick
    // enqueues, pinned to the freshened head.
    gh.enqueuePullRequestOnQueue.mockResolvedValue({
      position: 1,
      state: 'QUEUED',
      estimatedTimeToMergeMs: null,
    });
    await runner.runAutoMergeTick(log);
    expect(gh.updatePullRequestBranch).toHaveBeenCalledTimes(1);
    expect(gh.enqueuePullRequestOnQueue).toHaveBeenCalledTimes(1);
    expect(gh.enqueuePullRequestOnQueue.mock.calls[0][2]).toBe('ourqm1');

    // Tick 4: queued, trunk moved on again — NO second freshen (an update moves the head,
    // which kicks the entry out of the queue; the queue phase settles before the gates run).
    gh.fetchMergeQueueState.mockResolvedValue(queueState({ inQueue: true, position: 1 }));
    gh.fetchPrMergeSnapshot.mockResolvedValue(snapshot({ headSha: 'ourqm1', behindBy: 7 }));
    await runner.runAutoMergeTick(log);
    expect(gh.updatePullRequestBranch).toHaveBeenCalledTimes(1);
    expect((await rowFor(prC)).state).toBe('armed');
  });
});

// ---------------------------------------------------------------------------------------
// The PER-REPO LANDING QUEUE (rule 8). See db/merge-queue.ts for the bug it fixes: arming five
// bumps on one repo used to freshen all five against a trunk the first merge then moved, after
// which `freshenedIntents` (once per intent LIFETIME) refused to let any of them update again.
// ---------------------------------------------------------------------------------------

describe('the armed FIFO, as a pure fold', () => {
  let mq: any;
  const row = (
    id: number,
    accountId: number,
    repoId: number,
    armedAtMs: number,
    viaMergeQueue = false,
  ) => ({ id, accountId, repoId, prId: id * 100, armedAt: new Date(armedAtMs), viaMergeQueue });

  // The runner's LIVE observations, which the fold cannot derive from the rows. Named fields
  // rather than one set: a conflict yield and a failed-check yield need different copy, and a
  // queue-disabled fallback is not a yield at all.
  const marks = (over: Record<string, Set<number>> = {}) => ({
    yieldedForFailedChecks: new Set<number>(),
    yieldedForConflicts: new Set<number>(),
    queueDisabled: new Set<number>(),
    ...over,
  });

  beforeAll(async () => {
    mq = await import('./merge-queue.js');
  });

  it('gives ONE intent per repo the slot and everyone else a place in line', () => {
    // All five armed in the SAME second — which is what sqlite actually stores, so the id
    // tiebreak is the only surviving record of click order. Shuffled on the way in to prove the
    // fold owns the order rather than trusting the caller's.
    const rows = [row(3, 1, 9, now), row(1, 1, 9, now), row(5, 1, 9, now), row(2, 1, 9, now)];
    const { byIntentId } = mq.buildArmedRepoQueues(rows, marks());
    expect([1, 2, 3, 5].map((id) => byIntentId.get(id).position)).toEqual([1, 2, 3, 4]);
    expect([1, 2, 3, 5].map((id) => byIntentId.get(id).holdsSlot)).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(byIntentId.get(2).depth).toBe(4);
    // Siblings are what a landing clears the freshen marks of: everyone else on this repo.
    expect([...byIntentId.get(1).siblingIds].sort()).toEqual([2, 3, 5]);
  });

  it('keys the group on (accountId, repoId), never repoId alone', () => {
    // Two tenants tracking the SAME repo. A repoId-keyed group would put B behind A — one
    // tenant's landings serialised behind another's, which is a side channel as well as a bug.
    const rows = [row(1, 1, 9, now), row(2, 2, 9, now + 1000)];
    const { byIntentId } = mq.buildArmedRepoQueues(rows, marks());
    expect(byIntentId.get(1).holdsSlot).toBe(true);
    expect(byIntentId.get(2).holdsSlot).toBe(true);
    expect(byIntentId.get(2).position).toBe(1);
    expect(byIntentId.get(1).siblingIds).toEqual([]);
  });

  it('EXCLUDES viaMergeQueue intents from the FIFO — GitHub already serialises them', () => {
    const rows = [row(1, 1, 9, now, true), row(2, 1, 9, now + 1000)];
    const { byIntentId } = mq.buildArmedRepoQueues(rows, marks());
    // The queue intent is never held back and carries NO Limn position — a second queue drawn
    // in front of GitHub's would halve throughput and put two different "queues" on one card.
    expect(byIntentId.get(1)).toMatchObject({ holdsSlot: true, position: null, depth: null });
    // …and it does not count towards the direct intents' depth either.
    expect(byIntentId.get(2)).toMatchObject({ holdsSlot: true, position: 1, depth: 1 });
    // It DOES know its direct siblings: when the queue lands it, the trunk moved for them too.
    expect(byIntentId.get(1).siblingIds).toEqual([2]);
  });

  it('hands the slot past a yielded intent WITHOUT moving it down the line', () => {
    const rows = [row(1, 1, 9, now), row(2, 1, 9, now + 1000), row(3, 1, 9, now + 2000)];
    const { byIntentId } = mq.buildArmedRepoQueues(
      rows,
      marks({ yieldedForFailedChecks: new Set([1]) }),
    );
    expect(byIntentId.get(2).holdsSlot).toBe(true);
    // #1 keeps its place: the moment its checks go green the mark clears and it is 1st again.
    expect(byIntentId.get(1)).toMatchObject({
      position: 1,
      holdsSlot: false,
      yieldReason: 'failed_checks',
    });
  });

  // ── DEFECT #4: a yielded intent that becomes the only one could never reclaim the slot ─────
  it('gives the slot back when EVERY direct intent has yielded — there is nobody to yield to', () => {
    // THE REPRO. #1 stepped aside for failed checks while #2 was behind it; #2 then merged and
    // left. `slotHolderId = direct.find(r => !yielded.has(r.id))` now finds NOBODY, so the one
    // intent on the repo holds no slot: its row claims it is "letting the next armed PR through"
    // when there is no next armed PR, and it never reaches the branches that would report its
    // real block, because only a slot-holder gets that far. The :695 gate already refuses to
    // ENTER a yield with nobody to yield to, so staying in one here was inconsistent as well.
    const alone = mq.buildArmedRepoQueues(
      [row(1, 1, 9, now)],
      marks({ yieldedForFailedChecks: new Set([1]) }),
    );
    expect(alone.byIntentId.get(1)).toMatchObject({
      holdsSlot: true,
      position: 1,
      depth: 1,
      yieldReason: 'failed_checks',
      // …and it may not re-enter the yield from there: nobody is waiting, so the runner does not
      // even pay for the live rollup read that would.
      canYield: false,
    });

    // The same rule at depth > 1: all yielded ⇒ the FIRST keeps the slot rather than the repo
    // going dark. Handing it over merges nothing — the runner re-reads a live snapshot and a PR
    // whose checks failed still parks on its blocker.
    const rows = [row(1, 1, 9, now), row(2, 1, 9, now + 1000), row(3, 1, 9, now + 2000)];
    const all = mq.buildArmedRepoQueues(
      rows,
      marks({ yieldedForFailedChecks: new Set([1, 2]), yieldedForConflicts: new Set([3]) }),
    );
    expect([1, 2, 3].map((id) => all.byIntentId.get(id).holdsSlot)).toEqual([true, false, false]);
    expect([1, 2, 3].every((id) => all.byIntentId.get(id).canYield === false)).toBe(true);
    // Each keeps its OWN reason — "checks failed" and "conflicts" send the author to different
    // screens, and only the first is the wire's `yieldedForFailedChecks`.
    expect(all.byIntentId.get(3).yieldReason).toBe('conflicts');
  });

  // ── DEFECT #2: the queue exemption must follow the LIVE verdict, not the stored flag ───────
  it('puts a queue-DISABLED intent back in the direct FIFO', () => {
    const rows = [row(1, 1, 9, now, true), row(2, 1, 9, now + 1000)];
    // Stored flag says "GitHub serialises me"; the runner has since watched the queue answer
    // `enabled: false`, so this intent direct-merges now — and a direct merger exempt from the
    // direct FIFO lands a second PR on the repo in the same tick.
    const { byIntentId } = mq.buildArmedRepoQueues(rows, marks({ queueDisabled: new Set([1]) }));
    expect(byIntentId.get(1)).toMatchObject({ holdsSlot: true, position: 1, depth: 2 });
    expect(byIntentId.get(2)).toMatchObject({ holdsSlot: false, position: 2, depth: 2 });
  });

  it('leaves the wire fields ABSENT wherever they would not describe a live direct intent', () => {
    const index = mq.buildArmedRepoQueues([row(1, 1, 9, now, true), row(2, 1, 9, now)], marks());
    // A queue intent gets none of the three — a client that has never heard of them must render
    // exactly what it did before.
    expect(mq.withArmedQueueFields({ prId: 100 } as any, index)).toEqual({ prId: 100 });
    // A terminal row is not in the scan at all, so it is the same "absent" path.
    expect(mq.withArmedQueueFields({ prId: 999 } as any, index)).toEqual({ prId: 999 });
    expect(mq.withArmedQueueFields({ prId: 200 } as any, index)).toEqual({
      prId: 200,
      queuePosition: 1,
      queueDepth: 1,
    });
    // False is absent too, never a literal `yieldedForFailedChecks: false`.
    const yielded = mq.buildArmedRepoQueues(
      [row(2, 1, 9, now)],
      marks({ yieldedForFailedChecks: new Set([2]) }),
    );
    expect(mq.withArmedQueueFields({ prId: 200 } as any, yielded)).toMatchObject({
      yieldedForFailedChecks: true,
    });
    // ⚠ …and ONLY that reason writes it. A CONFLICT yield carries its own truthful phase
    // (`waiting_conflicts`); flagging it here would put "checks failed, letting the next PR
    // through" over a PR whose checks are fine.
    const conflicted = mq.buildArmedRepoQueues(
      [row(2, 1, 9, now)],
      marks({ yieldedForConflicts: new Set([2]) }),
    );
    expect(mq.withArmedQueueFields({ prId: 200 } as any, conflicted)).toEqual({
      prId: 200,
      queuePosition: 1,
      queueDepth: 1,
    });
  });
});

describe('the armed-order scan', () => {
  let mq: any;
  beforeAll(async () => {
    mq = await import('./merge-queue.js');
    await db.delete(schema.autoMergeRequests).execute();
  });

  it('is UNBOUNDED, carries repoId, and scopes to one account when asked', async () => {
    await q.armAutoMerge(A, prC, armArgs('o1'));
    await q.armAutoMerge(A, prD, armArgs('o2'));
    await q.armAutoMerge(B, prB, armArgs('o3'));

    // The runner's own cross-tenant scan (null = every account), the sanctioned twin of
    // `listArmedMergeRequestsForRunner`.
    const all = await mq.listArmedIntentOrder(null);
    expect(all.map((r: any) => r.prId).sort()).toEqual([prB, prC, prD].sort());

    // A per-request path passes a real id and must never see, or pay for, another tenant's rows.
    const mine = await mq.listArmedIntentOrder(A);
    expect(mine.map((r: any) => r.prId).sort()).toEqual([prC, prD].sort());
    // prC and prD are the SAME repo — the fact the position fold needs and the intent row does
    // not carry.
    const [c, d] = [prC, prD].map((id) => mine.find((r: any) => r.prId === id));
    expect(c.repoId).toBe(d.repoId);
    expect(c.repoId).not.toBe(mine.find((r: any) => r.prId === prC)?.accountId);

    await db.delete(schema.autoMergeRequests).execute();
  });
});

describe('the auto-merge watcher lands a repo’s batch one at a time', () => {
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

  // The queue tests run two or three PRs through ONE tick, so the snapshot stub has to answer
  // per PR. Keyed on the PR NUMBER, which is `fetchPrMergeSnapshot`'s 4th argument.
  const snapshotsByNumber = (byNumber: Record<number, Record<string, unknown>>): void => {
    gh.fetchPrMergeSnapshot.mockImplementation(
      async (_t: string, _o: string, _n: string, number: number) =>
        snapshot({ headSha: `h${number}`, ...byNumber[number] }),
    );
  };

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
      gh.fetchMergeQueueState,
      gh.enqueuePullRequestOnQueue,
      gh.fetchPrHeadCheckRollup,
    ]) {
      fn.mockReset();
    }
    await db.delete(schema.autoMergeRequests).execute();
    const { eq, inArray } = await import('drizzle-orm');
    void eq;
    await db
      .update(schema.pullRequests)
      .set({ state: 'open' })
      .where(inArray(schema.pullRequests.id, [prC, prD, prE, prF]))
      .execute();
  });

  it('(a) gives ONE intent on a repo the slot and parks the other at queued_local', async () => {
    // The click order: prC first, prD second. Both are perfectly mergeable — under the old
    // runner BOTH would have merged in this one tick, and the second would have been merging
    // against a trunk that moved out from under it mid-tick.
    await q.armAutoMerge(A, prC, armArgs('h7'));
    await q.armAutoMerge(A, prD, armArgs('h8'));
    snapshotsByNumber({ 7: {}, 8: {} });
    gh.mergePullRequest.mockResolvedValue({ ok: true, sha: 'landed_a' });

    await runner.runAutoMergeTick(log);

    // Exactly ONE merge, and it is the one the user clicked first.
    expect(gh.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(gh.mergePullRequest.mock.calls[0][3]).toBe(7);
    expect((await rowFor(prC)).state).toBe('merged');

    const waiting = await rowFor(prD);
    expect(waiting.state).toBe('armed');
    // ⚠ 'queued_local', NOT 'queued' — the latter means GitHub has it in a merge queue. Two
    // different queues on two sides of the network; conflating them is the whole reason the
    // phase got its own member.
    expect(waiting.phase).toBe('queued_local');
    expect(waiting.lastReason).toContain('2nd of 2');
    expect(waiting.lastReason).toContain('orgc/repoc');
  });

  it('(b) does NOT serialise across repos — one line per repo, not one global line', async () => {
    await q.armAutoMerge(A, prC, armArgs('h7'));
    await q.armAutoMerge(A, prE, armArgs('h9'));
    snapshotsByNumber({ 7: {}, 9: {} });
    gh.mergePullRequest.mockResolvedValue({ ok: true, sha: 'landed_b' });

    await runner.runAutoMergeTick(log);

    // Both hold their own repo's slot, so both land on the same tick.
    expect(gh.mergePullRequest).toHaveBeenCalledTimes(2);
    expect(gh.mergePullRequest.mock.calls.map((c: any[]) => c[3]).sort()).toEqual([7, 9]);
    expect((await rowFor(prC)).state).toBe('merged');
    expect((await rowFor(prE)).state).toBe('merged');
  });

  it('(c) never parks a viaMergeQueue intent at queued_local', async () => {
    // prD (direct) is armed FIRST, so a naive "everyone on this repo takes a number" would make
    // the queue intent 2nd of 2 and hold it behind — halving throughput on the one repo where
    // GitHub is already serialising for us.
    await q.armAutoMerge(A, prD, armArgs('h8'));
    await q.armAutoMerge(A, prC, { ...armArgs('h7'), viaMergeQueue: true });
    snapshotsByNumber({ 7: { mergeableState: 'blocked' }, 8: {} });
    gh.fetchMergeQueueState.mockResolvedValue({
      enabled: true,
      inQueue: false,
      position: null,
      state: null,
      estimatedTimeToMergeMs: null,
      enqueuedAt: null,
      prState: 'OPEN',
      reviewDecision: null,
    });
    gh.enqueuePullRequestOnQueue.mockResolvedValue({
      position: 1,
      state: 'QUEUED',
      estimatedTimeToMergeMs: null,
    });
    gh.mergePullRequest.mockResolvedValue({ ok: true, sha: 'landed_c' });

    await runner.runAutoMergeTick(log);

    const queued = await rowFor(prC);
    expect(queued.phase).toBe('queued');
    expect(queued.enqueuedAt).not.toBeNull();
    // The direct intent is unaffected by the queue intent sharing its repo, and vice versa.
    expect((await rowFor(prD)).state).toBe('merged');
  });

  it('(d) still RESOLVES a waiting intent whose PR went away (rules 1–4 run for everyone)', async () => {
    // The crux of the split. A queued intent that has gone bad must resolve on the tick that
    // observes it — parking it behind a slot-holder for hours is the same starvation this queue
    // exists to prevent, one level up.
    await q.armAutoMerge(A, prC, armArgs('h7'));
    await q.armAutoMerge(A, prD, armArgs('h8'));
    const { eq } = await import('drizzle-orm');
    await db
      .update(schema.pullRequests)
      .set({ state: 'closed' })
      .where(eq(schema.pullRequests.id, prD))
      .execute();
    // The slot-holder is parked on something we can't characterise, so it neither merges nor
    // finishes — the waiter has to resolve anyway.
    snapshotsByNumber({ 7: { mergeableState: 'unknown' }, 8: {} });

    await runner.runAutoMergeTick(log);

    const closed = await rowFor(prD);
    expect(closed.state).toBe('disarmed_blocked');
    expect(closed.lastReason).toContain('closed outside auto-merge');
    // A terminal row carries no live phase — least of all the one it would have had.
    expect(closed.phase).toBeNull();
    expect((await rowFor(prC)).state).toBe('armed');
  });

  it('(e) clears a sibling’s freshen mark when a PR on the repo LANDS', async () => {
    // THE REGRESSION, in one test. `freshenedIntents` used to be once per intent LIFETIME, so
    // an intent that freshened before a sibling landed could never update again and sat at
    // "behind" until the 72-hour expiry. `mergeableState: 'clean'` with `behindBy > 0` is the
    // shape that actually depends on the mark (a literal 'behind' state re-freshens regardless).
    await q.armAutoMerge(A, prC, { ...armArgs('h7'), updateStrategy: 'merge' });
    await q.armAutoMerge(A, prD, { ...armArgs('h8'), updateStrategy: 'merge' });
    snapshotsByNumber({ 7: { behindBy: 2 }, 8: { behindBy: 2 } });
    gh.updatePullRequestBranch.mockResolvedValue({ ok: true });

    // Tick 1: prC holds the slot and freshens; prD waits its turn (and does NOT also freshen —
    // N branch updates for N PRs, not N²).
    await runner.runAutoMergeTick(log);
    expect(gh.updatePullRequestBranch).toHaveBeenCalledTimes(1);
    expect(gh.updatePullRequestBranch.mock.calls[0][3]).toBe(7);
    expect((await rowFor(prD)).phase).toBe('queued_local');

    // Meanwhile a human merges prD's PR on GitHub. The trunk just moved under prC — whose one
    // freshen is already spent.
    const { eq } = await import('drizzle-orm');
    await db
      .update(schema.pullRequests)
      .set({ state: 'merged' })
      .where(eq(schema.pullRequests.id, prD))
      .execute();

    // Tick 2: prC is worked first (it holds the slot) and is still marked, so it does nothing;
    // prD's pre-flight then observes the landing and clears its siblings' marks. Deciding on
    // this tick and acting on the next is the contract.
    snapshotsByNumber({ 7: { mergeableState: 'unknown', behindBy: 2 }, 8: {} });
    await runner.runAutoMergeTick(log);
    expect(gh.updatePullRequestBranch).toHaveBeenCalledTimes(1);
    expect((await rowFor(prD)).state).toBe('disarmed_blocked');

    // Tick 3: prC freshens AGAINST THE NEW TRUNK. Without the sibling clear this call never
    // happens and the intent expires at 72h having never updated again.
    snapshotsByNumber({ 7: { behindBy: 2 } });
    await runner.runAutoMergeTick(log);
    expect(gh.updatePullRequestBranch).toHaveBeenCalledTimes(2);
    expect(gh.updatePullRequestBranch.mock.calls[1][3]).toBe(7);
  });

  it('(f) yields the slot when the slot-holder’s checks FAILED, keeping its place', async () => {
    await q.armAutoMerge(A, prC, armArgs('h7'));
    await q.armAutoMerge(A, prD, armArgs('h8'));
    snapshotsByNumber({ 7: { mergeableState: 'blocked' }, 8: { mergeableState: 'blocked' } });
    // The LIVE read, not the synced CI column: yielding re-orders the user's clicks, which is
    // not a decision to make on a sync-interval-stale "failure" that may have gone green.
    gh.fetchPrHeadCheckRollup.mockResolvedValue('FAILURE');

    await runner.runAutoMergeTick(log);

    // Paid for only where it can change something: the slot-holder, on a repo with someone
    // waiting behind it. The waiter returns at the queue hold and never reaches this read.
    expect(gh.fetchPrHeadCheckRollup).toHaveBeenCalledTimes(1);
    expect(gh.fetchPrHeadCheckRollup.mock.calls[0][3]).toBe(7);
    const yielded = await rowFor(prC);
    expect(yielded.state).toBe('armed'); // ⚠ a yield is NOT a disarm
    expect(yielded.phase).toBe('queued_local');
    expect(yielded.lastReason).toContain('checks failed');

    // Tick 2: the slot passed to prD, which is green — it lands while prC waits for its author.
    snapshotsByNumber({ 7: { mergeableState: 'blocked' }, 8: {} });
    gh.mergePullRequest.mockResolvedValue({ ok: true, sha: 'landed_f' });
    await runner.runAutoMergeTick(log);

    expect(gh.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(gh.mergePullRequest.mock.calls[0][3]).toBe(8);
    const still = await rowFor(prC);
    expect(still.state).toBe('armed');
    expect(still.lastReason).toContain('checks failed');
  });

  // ── DEFECT #1: a conflicting slot-holder used to hold the repo for the full 72 hours ───────
  it('(g) a CONFLICTING slot-holder RELEASES the repo instead of parking it for 72h', async () => {
    // THE REPRO, and it is a REGRESSION the queue introduced: before rule 8 existed, #8 merged
    // on the very first tick. With the queue, #7 held the slot, hit the conflicts branch and
    // returned WITHOUT releasing it — five consecutive ticks merged nothing, and the row would
    // have sat there until the 72-hour expiry. The in-code justification ("a conflict fix is a
    // push, rule 1 then disarms and frees the slot") assumed an author action that may never
    // come. The queue must never make a repo worse than no queue.
    await q.armAutoMerge(A, prC, armArgs('h7'));
    await q.armAutoMerge(A, prD, armArgs('h8'));
    snapshotsByNumber({ 7: { mergeable: false, mergeableState: 'dirty' }, 8: {} });
    gh.mergePullRequest.mockResolvedValue({ ok: true, sha: 'landed_g' });

    // Tick 1: #7 steps aside. #8 was parked off the order derived at the TOP of this tick, so
    // it takes the slot on the next one — deciding here and acting next tick is the contract
    // (same shape as (f2)), and two minutes is not 72 hours.
    await runner.runAutoMergeTick(log);
    expect(gh.mergePullRequest).not.toHaveBeenCalled();
    const conflicted = await rowFor(prC);
    expect(conflicted.state).toBe('armed'); // ⚠ a yield is NOT a disarm
    expect(conflicted.phase).toBe('waiting_conflicts');
    expect(conflicted.lastReason).toContain('conflicts with main');

    await runner.runAutoMergeTick(log);
    expect(gh.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(gh.mergePullRequest.mock.calls[0][3]).toBe(8);
    // The conflicting intent is untouched by any of it: still armed, still 1st in the FIFO,
    // still telling its author exactly what is wrong.
    const still = await rowFor(prC);
    expect(still.state).toBe('armed');
    expect(still.phase).toBe('waiting_conflicts');

    // …and it does not merge on some later tick either — a released slot is not a green light.
    await runner.runAutoMergeTick(log);
    expect(gh.mergePullRequest).toHaveBeenCalledTimes(1);
  });

  it('(g2) takes the slot back the tick after the CONFLICT clears', async () => {
    // The un-mark is the same rule in reverse, and it runs for every intent, slot or no slot:
    // the moment GitHub stops reporting a conflict the intent is a slot candidate again. (A
    // conflict fixed by a PUSH never reaches here — rule 1 disarms on the moved head — but a
    // conflict can also clear because the BASE moved, with no head move at all.)
    await q.armAutoMerge(A, prC, armArgs('h7'));
    await q.armAutoMerge(A, prD, armArgs('h8'));
    snapshotsByNumber({ 7: { mergeable: false, mergeableState: 'dirty' }, 8: {} });
    gh.mergePullRequest.mockResolvedValue({ ok: true, sha: 'landed_g2' });
    await runner.runAutoMergeTick(log);
    await runner.runAutoMergeTick(log); // prD lands
    expect((await rowFor(prD)).state).toBe('merged');

    // prC's conflict resolves itself on GitHub's side.
    snapshotsByNumber({ 7: {} });
    await runner.runAutoMergeTick(log); // clears the mark; the order was derived before it
    await runner.runAutoMergeTick(log);
    expect(gh.mergePullRequest).toHaveBeenCalledTimes(2);
    expect(gh.mergePullRequest.mock.calls[1][3]).toBe(7);
  });

  // ── DEFECT #3: the queue position must not erase the waiter's own blocker ──────────────────
  it('(h) a WAITER’s real blocker survives its place in line', async () => {
    // prC holds the slot on something we can't characterise (so it neither merges nor finishes)
    // and prD — 2nd in line — is CONFLICTING. The rule-8 park used to return before the
    // conflicts branch, overwriting prD with {queued_local, "waiting its turn — 2nd of 2"}: true,
    // and a status that sends nobody to fix anything. Worse in tone than in wording —
    // `waiting_conflicts` is one of the banner's STALLED phases, a plain `queued_local` reads as
    // ordinary progress — so a PR that cannot land AT ALL looked like one that was simply next.
    await q.armAutoMerge(A, prC, armArgs('h7'));
    await q.armAutoMerge(A, prD, armArgs('h8'));
    snapshotsByNumber({
      7: { mergeableState: 'unknown' },
      8: { mergeable: false, mergeableState: 'dirty' },
    });

    await runner.runAutoMergeTick(log);

    const waiter = await rowFor(prD);
    expect(waiter.state).toBe('armed');
    expect(waiter.phase).toBe('waiting_conflicts');
    // BOTH facts reach the user: what is wrong, and where it stands.
    expect(waiter.lastReason).toContain('conflicts with main');
    expect(waiter.lastReason).toContain('2nd of 2');
  });

  // ── DEFECT #2: the queue exemption must follow the LIVE verdict, not the stored flag ───────
  it('(i) a queue-DISABLED intent cannot merge alongside the repo’s slot-holder', async () => {
    // THE REPRO: ONE tick produced `mergePullRequest` for TWO PRs on the same repo — the exact
    // thrash the local queue exists to prevent. `viaMergeQueue` rows are exempt from the FIFO
    // because GitHub serialises them, but the runner re-verifies the queue LIVE and, finding it
    // disabled since arming, fell through to the DIRECT merge path with the exemption still on.
    await q.armAutoMerge(A, prF, armArgs('h10')); // armed first ⇒ holds the direct slot
    await q.armAutoMerge(A, prD, armArgs('h8'));
    await q.armAutoMerge(A, prC, { ...armArgs('h7'), viaMergeQueue: true });
    snapshotsByNumber({ 7: {}, 8: {}, 10: {} });
    gh.fetchMergeQueueState.mockResolvedValue({
      enabled: false, // …turned off since the user armed
      inQueue: false,
      position: null,
      state: null,
      estimatedTimeToMergeMs: null,
      enqueuedAt: null,
      prState: 'OPEN',
      reviewDecision: null,
    });
    gh.mergePullRequest.mockResolvedValue({ ok: true, sha: 'landed_i' });

    // Tick 1: the repo lands exactly ONE PR — its actual slot-holder. The fallback only
    // re-classifies itself and takes a number.
    await runner.runAutoMergeTick(log);
    expect(gh.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(gh.mergePullRequest.mock.calls[0][3]).toBe(10);
    const parked = await rowFor(prC);
    expect(parked.state).toBe('armed');
    expect(parked.phase).toBe('queued_local');
    expect(parked.lastReason).toContain('no longer enabled');

    // Tick 2: it is a DIRECT intent now, so it queues behind prD (armed first) instead of
    // merging beside it — one landing per repo per tick, still exactly one.
    await runner.runAutoMergeTick(log);
    expect(gh.mergePullRequest).toHaveBeenCalledTimes(2);
    expect(gh.mergePullRequest.mock.calls[1][3]).toBe(8);
    const waiting = await rowFor(prC);
    expect(waiting.phase).toBe('queued_local');
    expect(waiting.lastReason).toContain('2nd of 2');

    // Tick 3: its turn.
    await runner.runAutoMergeTick(log);
    expect(gh.mergePullRequest).toHaveBeenCalledTimes(3);
    expect(gh.mergePullRequest.mock.calls[2][3]).toBe(7);
  });

  // ── DEFECT #4: a yielded intent that becomes the only one could never reclaim the slot ─────
  it('(j) a yielded intent left ALONE on the repo reports its real state, not a phantom queue', async () => {
    await q.armAutoMerge(A, prC, armArgs('h7'));
    await q.armAutoMerge(A, prD, armArgs('h8'));
    snapshotsByNumber({ 7: { mergeableState: 'blocked' }, 8: { mergeableState: 'blocked' } });
    gh.fetchPrHeadCheckRollup.mockResolvedValue('FAILURE');

    await runner.runAutoMergeTick(log); // prC yields to prD
    expect((await rowFor(prC)).phase).toBe('queued_local');

    // prD goes away — merged by a human, say — and prC is the only armed intent on the repo,
    // still marked. `direct.find(r => !yielded.has(r.id))` then finds NOBODY.
    const { eq } = await import('drizzle-orm');
    await db
      .update(schema.pullRequests)
      .set({ state: 'merged' })
      .where(eq(schema.pullRequests.id, prD))
      .execute();
    await runner.runAutoMergeTick(log);
    expect((await rowFor(prD)).state).toBe('disarmed_blocked');

    // With nobody to yield to, prC holds its own slot again and says what is actually wrong.
    await runner.runAutoMergeTick(log);
    const alone = await rowFor(prC);
    expect(alone.state).toBe('armed');
    expect(alone.phase).toBe('blocked_protection');
    expect(alone.lastReason).not.toContain('letting the next armed PR');
    // …and it does NOT pay for a second live rollup read to re-enter a yield that would hand
    // the slot to nobody. One read, on the tick where yielding could still change something.
    expect(gh.fetchPrHeadCheckRollup).toHaveBeenCalledTimes(1);
  });

  it('(f2) takes the slot back the tick after the block clears', async () => {
    await q.armAutoMerge(A, prC, armArgs('h7'));
    await q.armAutoMerge(A, prD, armArgs('h8'));
    snapshotsByNumber({ 7: { mergeableState: 'blocked' }, 8: { mergeableState: 'blocked' } });
    gh.fetchPrHeadCheckRollup.mockResolvedValue('FAILURE');
    await runner.runAutoMergeTick(log);
    expect((await rowFor(prC)).phase).toBe('queued_local');

    // A CI re-run goes green with no push (the one repair that does NOT move the head, and so
    // the one the head pin can't notice for us). The snapshot we already hold is the whole test.
    snapshotsByNumber({ 7: {}, 8: { mergeableState: 'blocked' } });
    gh.mergePullRequest.mockResolvedValue({ ok: true, sha: 'landed_f2' });
    await runner.runAutoMergeTick(log);
    // Tick 2 only CLEARS the mark (prD held the slot when the tick's order was derived)…
    expect(gh.mergePullRequest).not.toHaveBeenCalled();
    // …and prD, blocked and holding the slot, does NOT pay for a live rollup read: the only
    // other intent on the repo has already stepped aside, so a yield would hand the slot to
    // nobody and its copy would name a PR that does not exist. `canYield`, not `depth > 1`.
    expect(gh.fetchPrHeadCheckRollup).toHaveBeenCalledTimes(1);
    // …and tick 3 hands prC its place back — 1st of 2, which it never lost.
    await runner.runAutoMergeTick(log);
    expect(gh.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(gh.mergePullRequest.mock.calls[0][3]).toBe(7);
  });
});
