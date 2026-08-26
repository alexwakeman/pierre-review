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
