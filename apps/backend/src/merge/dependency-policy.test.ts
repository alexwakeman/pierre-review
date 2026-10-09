// Dependency auto-merge (merge/dependency-policy.ts) on a THROWAWAY sqlite DB, GitHub stubbed.
//
// Pinned: the setting is OFF by default and per workspace; the sweep arms only dependency
// automation the account can push to, marks it `armedByPolicy`, re-arms a NEW head after the bot
// pushes, never re-arms the SAME head of an ended intent, and never re-arms a PR a person
// cancelled; the bulk dry run plans from synced rows and names its skips.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../github/mutations.js', () => ({
  fetchPrHeadInfo: vi.fn(),
  fetchMergeQueueState: vi.fn(async () => null),
  fetchRepoMergeConfig: vi.fn(async () => ({
    allowMergeCommit: false,
    allowSquashMerge: true,
    allowRebaseMerge: true,
    defaultBranch: 'main',
  })),
  fetchPrMergeSnapshot: vi.fn(),
  mergePullRequest: vi.fn(),
}));
vi.mock('../auth/account.js', () => ({
  getAccessToken: vi.fn(async () => 'gho_test'),
  getAccountUserId: vi.fn(async () => null),
}));

const DIR = mkdtempSync(join(tmpdir(), 'pierre-dep-policy-'));
process.env.DATABASE_URL = join(DIR, 't.sqlite');
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let q: any;
let policy: any;
let gh: any;
let eq: any;
const A = 1;
let wsId = 0;
let depPr = 0; // dependabot, WRITE repo
let draftDep = 0; // dependabot, draft
let humanPr = 0; // a person's PR
let readOnlyDep = 0; // dependabot on a READ-only repo
const log = { info: () => {}, warn: () => {}, error: () => {} } as any;

beforeAll(async () => {
  const { runMigrations } = await import('../db/run-migrations.js');
  const client = await import('../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  q = await import('../db/queries.js');
  policy = await import('./dependency-policy.js');
  gh = await import('../github/mutations.js');
  ({ eq } = await import('drizzle-orm'));
  const { repos, pullRequests } = schema;
  const [repoW] = await db
    .insert(repos)
    .values({ accountId: A, owner: 'o', name: 'w', githubNodeId: 'R_w', viewerPermission: 'WRITE' })
    .returning()
    .execute();
  const [repoR] = await db
    .insert(repos)
    .values({ accountId: A, owner: 'o', name: 'r', githubNodeId: 'R_r', viewerPermission: 'READ' })
    .returning()
    .execute();
  const pr = async (repoId: number, n: number, over: Record<string, unknown>): Promise<number> => {
    const [row] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: `PR_${repoId}_${n}`,
        accountId: A,
        repoId,
        number: n,
        title: `PR ${n}`,
        state: 'open',
        isDraft: false,
        baseRefName: 'main',
        headSha: 'h1',
        mergeStateStatus: 'blocked',
        mergeable: 'mergeable',
        openedAt: new Date(),
        updatedAt: new Date(),
        ...over,
      })
      .returning()
      .execute();
    return row.id;
  };
  depPr = await pr(repoW.id, 1, { dependencyVendor: 'dependabot' });
  draftDep = await pr(repoW.id, 2, { dependencyVendor: 'dependabot', isDraft: true });
  humanPr = await pr(repoW.id, 3, {});
  readOnlyDep = await pr(repoR.id, 4, { dependencyVendor: 'dependabot' });
  wsId = (await q.resolveWorkspaceScope(A, undefined)).workspaceId;
});

afterAll(async () => {
  await closeDb?.();
  rmSync(DIR, { recursive: true, force: true });
});

const intentFor = async (prId: number): Promise<any> =>
  (await db.select().from(schema.autoMergeRequests).execute()).find((r: any) => r.prId === prId);

beforeEach(async () => {
  await db.delete(schema.autoMergeRequests).execute();
  await db.delete(schema.autoMergePolicySkips).execute();
  await db.update(schema.pullRequests).set({ headSha: 'h1' }).where(eq(schema.pullRequests.id, depPr)).execute();
  gh.fetchPrHeadInfo.mockReset();
  gh.fetchPrHeadInfo.mockResolvedValue({
    headSha: 'h1',
    headRef: 'dependabot/x',
    headRepoFullName: 'o/w',
    isFork: false,
    maintainerCanModify: true,
    baseRef: 'main',
  });
});

describe('the setting', () => {
  it('is OFF by default, per workspace, and 404s a foreign workspace', async () => {
    expect(await policy.getDependencyAutoMerge(A, wsId)).toEqual({ enabled: false });
    expect(await policy.setDependencyAutoMerge(A, wsId, true)).toBe(true);
    expect(await policy.getDependencyAutoMerge(A, wsId)).toEqual({ enabled: true });
    expect(await policy.getDependencyAutoMerge(A, 99_999)).toBeNull();
    expect(await policy.setDependencyAutoMerge(A, 99_999, true)).toBe(false);
    await policy.setDependencyAutoMerge(A, wsId, false);
    const [row] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, wsId)).execute();
    expect(row.dependencyAutoMerge).toBeNull();
  });
});

describe('the sweep', () => {
  it('does nothing while the setting is off', async () => {
    await policy.setDependencyAutoMerge(A, wsId, false);
    await policy.runDependencyPolicyTick(log);
    expect(await intentFor(depPr)).toBeUndefined();
  });

  it('arms ONLY writable, non-draft dependency automation — marked as the policy’s', async () => {
    await policy.setDependencyAutoMerge(A, wsId, true);
    await policy.runDependencyPolicyTick(log);
    const row = await intentFor(depPr);
    expect(row).toMatchObject({ state: 'armed', armedByPolicy: true, expectedHeadOid: 'h1' });
    // The repo's first enabled method; GitHub's own update-branch.
    expect(row.mergeMethod).toBe('squash');
    expect(row.updateStrategy).toBe('merge');
    expect(await intentFor(draftDep)).toBeUndefined();
    expect(await intentFor(humanPr)).toBeUndefined();
    expect(await intentFor(readOnlyDep)).toBeUndefined();
    const wire = await q.getAutoMergeRequest(A, depPr);
    expect(wire.armedByPolicy).toBe(true);
  });

  it('re-arms the NEW head after the bot pushes, never the same head of an ended intent', async () => {
    await policy.setDependencyAutoMerge(A, wsId, true);
    await policy.runDependencyPolicyTick(log);
    // The watcher disarmed it for a head move; the sync has not seen the push yet.
    await db
      .update(schema.autoMergeRequests)
      .set({ state: 'disarmed_head_moved' })
      .where(eq(schema.autoMergeRequests.prId, depPr))
      .execute();
    await policy.runDependencyPolicyTick(log);
    expect((await intentFor(depPr)).state).toBe('disarmed_head_moved');
    // Synced row says h2, but GitHub still says h1 (the pinned one): refused.
    await db.update(schema.pullRequests).set({ headSha: 'h2' }).where(eq(schema.pullRequests.id, depPr)).execute();
    await policy.runDependencyPolicyTick(log);
    expect((await intentFor(depPr)).state).toBe('disarmed_head_moved');
    // GitHub says h2: armed on it.
    gh.fetchPrHeadInfo.mockResolvedValue({
      headSha: 'h2',
      headRef: 'dependabot/x',
      headRepoFullName: 'o/w',
      isFork: false,
      maintainerCanModify: true,
      baseRef: 'main',
    });
    await policy.runDependencyPolicyTick(log);
    expect(await intentFor(depPr)).toMatchObject({ state: 'armed', expectedHeadOid: 'h2' });
  });

  it('never re-arms a PR a person cancelled', async () => {
    await policy.setDependencyAutoMerge(A, wsId, true);
    await policy.runDependencyPolicyTick(log);
    await q.disarmAutoMerge(A, depPr);
    await policy.recordPolicySkip(A, depPr);
    await policy.recordPolicySkip(A, depPr); // idempotent
    await policy.runDependencyPolicyTick(log);
    expect(await intentFor(depPr)).toBeUndefined();
  });
});

describe('"Merge or arm all" — the dry run', () => {
  it('plans from synced rows, names every skip, and calls no GitHub', async () => {
    await db
      .update(schema.pullRequests)
      .set({ mergeStateStatus: 'clean' })
      .where(eq(schema.pullRequests.id, depPr))
      .execute();
    const scope = await q.resolveWorkspaceScope(A, wsId);
    const items = await policy.runDependencyMergeAll({
      accountId: A,
      workspaceId: scope.workspaceId,
      repoIds: scope.repoIds,
      prIds: [depPr, draftDep, humanPr, readOnlyDep],
      dryRun: true,
      log,
    });
    expect(items.map((i: any) => i.outcome)).toEqual([
      { action: 'merge' },
      { action: 'skipped', reason: 'draft' },
      { action: 'skipped', reason: 'not_found' },
      { action: 'skipped', reason: 'no_write_access' },
    ]);
    expect(gh.fetchPrHeadInfo).not.toHaveBeenCalled();
    expect(gh.mergePullRequest).not.toHaveBeenCalled();
    await db
      .update(schema.pullRequests)
      .set({ mergeStateStatus: 'blocked' })
      .where(eq(schema.pullRequests.id, depPr))
      .execute();
  });

  it('a real run arms what GitHub will not land yet', async () => {
    gh.fetchPrMergeSnapshot.mockResolvedValue({
      headSha: 'h1',
      mergeable: true,
      mergeableState: 'blocked',
      baseRef: 'main',
    });
    const scope = await q.resolveWorkspaceScope(A, wsId);
    const items = await policy.runDependencyMergeAll({
      accountId: A,
      workspaceId: scope.workspaceId,
      repoIds: scope.repoIds,
      prIds: [depPr],
      dryRun: false,
      log,
    });
    expect(items[0].outcome).toEqual({ action: 'armed' });
    expect(gh.mergePullRequest).not.toHaveBeenCalled();
    const row = await intentFor(depPr);
    // A click, so the reader's intent — not the policy's.
    expect(row.armedByPolicy).toBe(false);
  });
});
