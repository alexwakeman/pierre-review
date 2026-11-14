// THE `limn/deps` LEDGER AND ITS RECONCILER (merge/deps-claim-ledger.ts, merge/deps-claim-release.ts) on a
// THROWAWAY sqlite DB, GitHub, the lines and the AI Fix seams stubbed. The gaps the 2026-11-14 audit found,
// each closed the way the review claims close them (review/claude-review/team-claim-release.ts):
//
//   (a) a claim left pending by a crash is released ("Cleared by me: didn't finish · free to claim"), and a
//       final line GitHub did not take is posted again — only while our pending line is the newest;
//   (b) a teammate's EXPIRED pending line this Limn skipped for is released ONCE ("… robin's claim expired");
//   (c) an armed merge's line is renewed while its intent is armed, and released when the intent ends
//       unlanded, so a teammate may arm; a landed one is closed with nothing posted;
//   (d) a rebase ask whose machine can't run the AI step says "AI step open to teammates" (at the ask, or
//       when the step comes), and a teammate's Limn then runs the AI step after the wait;
//   (h) an AI-pushed line GitHub did not take is posted again on the pushed commit.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../github/mutations.js', () => ({
  fetchPrForAutomation: vi.fn(),
  submitPrReview: vi.fn(),
  addIssueComment: vi.fn(),
  updatePullRequestBody: vi.fn(),
  fetchPrHeadInfo: vi.fn(),
  fetchMergeQueueState: vi.fn(async () => null),
  fetchRepoMergeConfig: vi.fn(async () => ({
    allowMergeCommit: true,
    allowSquashMerge: true,
    allowRebaseMerge: true,
    defaultBranch: 'main',
  })),
  fetchPrMergeSnapshot: vi.fn(),
  mergePullRequest: vi.fn(),
}));
vi.mock('../auth/account.js', () => ({
  getAccessToken: vi.fn(async () => 'gho_test'),
  getAccountUserId: vi.fn(async () => viewerId),
}));
vi.mock('../sync/resync-after-write.js', () => ({
  asSyncLogger: (l: unknown) => l,
  resyncPrAfterWrite: vi.fn(async () => {}),
}));
vi.mock('../sync/pr-settle.js', () => ({
  notePrChangedForPr: vi.fn(async () => {}),
  schedulePrSettle: vi.fn(),
}));

const DIR = mkdtempSync(join(tmpdir(), 'pierre-deps-release-'));
process.env.DATABASE_URL = join(DIR, 't.sqlite');
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let auto: any;
let policy: any;
let claims: any;
let release: any;
let gh: any;
let eq: any;
const A = 1;
let viewerId = 0;
let botId = 0;
let wsId = 0;
let botPr = 0;
const log = { info: () => {}, warn: () => {}, error: () => {} } as any;
const MIN = 60_000;

// ---- the fake `limn/deps` lines: per commit (a line without `sha` shows on every commit) ----
let lines: any[] = [];
let posted: Array<{ state: string; description: string; sha: string }> = [];
let nextId = 1;
let failPost: ((description: string) => boolean) | null = null;
const fakeGithub = {
  async listLines(_a: number, _o: string, _n: string, sha: string) {
    return lines.filter((l) => l.sha == null || l.sha === sha).map((l) => ({ ...l }));
  },
  async postLine(_a: number, _o: string, _n: string, sha: string, _context: string, post: any) {
    if (failPost?.(post.description)) throw new Error('GitHub said no');
    posted.push({ state: post.state, description: post.description, sha });
    lines.push({ id: nextId++, state: post.state, description: post.description, createdAtMs: Date.now(), login: 'me', sha });
  },
  async login() {
    return 'me';
  },
};
const robin = (state: string, description: string, agoMs: number, sha = 'h1') => ({
  id: nextId++,
  state,
  description,
  createdAtMs: Date.now() - agoMs,
  login: 'robin',
  sha,
});

const live = (over: Record<string, unknown> = {}) => ({
  state: 'open',
  isDraft: false,
  headSha: 'h1',
  headRef: 'dependabot/npm_and_yarn/lodash-4.17.21',
  baseRef: 'main',
  isFork: false,
  title: 'Bump lodash from 4.17.20 to 4.17.21',
  body: 'Bumps lodash from 4.17.20 to 4.17.21.',
  authorLogin: 'dependabot[bot]',
  labels: [],
  ...over,
});

const fix = { allowed: true, started: [] as any[], sandbox: { ok: true } as any, push: { ok: true, sha: 'p0sh000000000' } as any };
const aiFixDeps = () => ({
  allowed: async () => fix.allowed,
  readFailures: async () => ({ failures: [{ checkName: 'build', step: 'tsc', excerpt: 'error TS2322' }], otherFailing: [] }),
  startFix: async (_ctx: unknown, input: any) => {
    fix.started.push(input);
    return { status: 'queued', fixId: 100 + fix.started.length };
  },
  fixState: async () => ({ status: 'succeeded', patch: 'diff --git a/x b/x\n', error: null, provider: 'claude' }),
  push: async () => fix.push,
  isFixRunning: async () => false,
  sandbox: async () => fix.sandbox,
  pollMs: 1,
});
const bindAi = () => {
  auto.bindDependencyAutomationAi({} as any);
  auto.__testing.setAiFixDeps(aiFixDeps());
};

beforeAll(async () => {
  const { runMigrations } = await import('../db/run-migrations.js');
  const client = await import('../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  const q = await import('../db/queries.js');
  auto = await import('./dependency-automation.js');
  policy = await import('./dependency-policy.js');
  claims = await import('./deps-claim.js');
  release = await import('./deps-claim-release.js');
  gh = await import('../github/mutations.js');
  ({ eq } = await import('drizzle-orm'));
  const { users, repos, pullRequests, workspaceReviewers } = schema;
  const user = async (login: string, isBot: boolean): Promise<number> =>
    (await db.insert(users).values({ githubLogin: login, isBot }).returning().execute())[0].id;
  viewerId = await user('me', false);
  botId = await user('dependabot[bot]', true);
  await user('robin', false);
  const [repo] = await db
    .insert(repos)
    .values({ accountId: A, owner: 'o', name: 'w', githubNodeId: 'R_w', viewerPermission: 'WRITE' })
    .returning()
    .execute();
  botPr = (
    await db
      .insert(pullRequests)
      .values({
        githubNodeId: 'PR_1',
        accountId: A,
        repoId: repo.id,
        number: 1,
        title: 'Bump lodash from 4.17.20 to 4.17.21',
        headRefName: 'dependabot/npm_and_yarn/lodash-4.17.21',
        authorId: botId,
        state: 'open',
        isDraft: false,
        baseRefName: 'main',
        headSha: 'h1',
        ciStatus: 'success',
        reviewDecision: 'review_required',
        mergeStateStatus: 'blocked',
        mergeable: 'mergeable',
        dependencyVendor: 'dependabot',
        openedAt: new Date(),
        updatedAt: new Date(),
      })
      .returning()
      .execute()
  )[0].id;
  wsId = (await q.resolveWorkspaceScope(A, undefined)).workspaceId;
  // dependabot[bot] carries NO trust mark: it is trusted by default.
  await db
    .insert(workspaceReviewers)
    .values({
      accountId: A,
      workspaceId: wsId,
      authorUserId: botId,
      automated: true,
      role: 'dependency',
      confidence: 'high',
      source: 'auto',
      kind: 'dependabot',
    })
    .execute();
});

afterAll(async () => {
  await closeDb?.();
  rmSync(DIR, { recursive: true, force: true });
});

const ledger = async (): Promise<any[]> => db.select().from(schema.depsClaimLines).execute();
const setPr = (set: Record<string, unknown>) => db.update(schema.pullRequests).set(set).where(eq(schema.pullRequests.id, botPr)).execute();
/** This process "restarts": every live claim and remembered hold is gone; the lines stay. */
const restart = () => {
  claims._resetDepsClaimsForTest();
  claims.setDepsClaimGithubForTest(fakeGithub);
  release._resetDepsClaimReleaseForTest();
};

beforeEach(async () => {
  auto.__testing.reset();
  restart();
  lines = [];
  posted = [];
  failPost = null;
  Object.assign(fix, { allowed: true, started: [], sandbox: { ok: true }, push: { ok: true, sha: 'p0sh000000000' } });
  for (const t of [schema.dependencyAutomationActions, schema.autoMergeRequests, schema.reviews, schema.depsClaimLines]) {
    await db.delete(t).execute();
  }
  await setPr({ headSha: 'h1', ciStatus: 'success', mergeStateStatus: 'blocked', mergeable: 'mergeable' });
  await auto.setDependencyAutomation(A, wsId, { autoMerge: false, autoApprove: false, autoResolveConflicts: false, autoFix: false });
  for (const f of [gh.fetchPrForAutomation, gh.submitPrReview, gh.fetchPrHeadInfo, gh.addIssueComment]) f.mockReset();
  gh.fetchPrForAutomation.mockResolvedValue(live());
  gh.fetchPrHeadInfo.mockResolvedValue({
    headSha: 'h1',
    headRef: 'dependabot/x',
    headRepoFullName: 'o/w',
    isFork: false,
    maintainerCanModify: true,
    baseRef: 'main',
  });
  gh.submitPrReview.mockResolvedValue({
    databaseId: 9,
    nodeId: 'PRR_9',
    state: 'APPROVED',
    body: 'ok',
    submittedAt: new Date().toISOString(),
    url: 'u',
    authorLogin: 'me',
  });
  gh.addIssueComment.mockResolvedValue({ databaseId: 1, nodeId: 'IC_1', body: '@dependabot rebase', createdAt: new Date().toISOString(), url: 'u', authorLogin: 'me' });
});

const pr = () => ({ id: botPr, accountId: A, owner: 'o', name: 'w', headSha: 'h1' });

describe('(a) a line left pending, and a final line GitHub did not take', () => {
  it('a crash mid-action: the ledger row is found and the pending line released once', async () => {
    const claim = await auto.beginDependencyAction({ log }, pr(), 'approve');
    expect(claim).not.toBeNull();
    expect((await ledger())[0]).toMatchObject({ action: 'approve', state: 'pending', login: 'me', owner: 'o', name: 'w' });
    // While the action is live in this process the reconciler leaves it alone.
    await release.releaseStaleDepsClaims(log);
    expect(posted.map((p) => p.description)).toEqual(['me handling · approving']);
    restart(); // Limn stopped before the approval finished
    await auto.reconcileDependencyActionsOnStartup();
    await release.releaseStaleDepsClaims(log);
    expect(posted.at(-1)).toMatchObject({ state: 'success', description: "Cleared by me: didn't finish · free to claim" });
    expect((await ledger())[0]).toMatchObject({ state: 'released' });
    await release.releaseStaleDepsClaims(log);
    expect(posted).toHaveLength(2);
    // A teammate reads the head as free.
    expect(claims.decideDepsClaim(lines, 'robin', Date.now(), 'approve', { action: 'approve' })).toEqual({ kind: 'free' });
  });

  it('a newer line by a teammate: the row is closed and nothing is posted over it', async () => {
    await auto.beginDependencyAction({ log }, pr(), 'approve');
    restart();
    lines.push(robin('pending', 'robin handling · approving', -1000));
    await release.releaseStaleDepsClaims(log);
    expect(posted).toHaveLength(1);
    expect((await ledger())[0]).toMatchObject({ state: 'released', lastError: 'superseded' });
  });

  it('the final line failed: the reconciler posts THAT line, not a release', async () => {
    await auto.setDependencyAutomation(A, wsId, { autoApprove: true });
    failPost = (d) => d === 'me approved';
    await auto.runDependencyAutomationTick(log);
    expect(gh.submitPrReview).toHaveBeenCalledTimes(1);
    expect((await ledger())[0]).toMatchObject({ state: 'pending', finalDescription: 'me approved' });
    failPost = null;
    await release.releaseStaleDepsClaims(log);
    expect(posted.at(-1)).toMatchObject({ state: 'success', description: 'me approved' });
    expect((await ledger())[0]).toMatchObject({ state: 'finished', finalDescription: null });
    // The approval itself is never retried.
    await auto.runDependencyAutomationTick(log);
    expect(gh.submitPrReview).toHaveBeenCalledTimes(1);
  });

  it('a failed retry backs off and is tried again later', async () => {
    await auto.beginDependencyAction({ log }, pr(), 'approve');
    restart();
    failPost = () => true;
    await release.releaseStaleDepsClaims(log);
    expect((await ledger())[0]).toMatchObject({ state: 'pending', releaseAttempts: 1 });
    failPost = null;
    await release.releaseStaleDepsClaims(log); // inside the backoff: not tried
    expect(posted).toHaveLength(1);
    await release.releaseStaleDepsClaims(log, { nowMs: Date.now() + 2 * MIN });
    expect(posted.at(-1)?.description).toBe("Cleared by me: didn't finish · free to claim");
  });
});

describe('(b) a teammate’s expired pending line', () => {
  const skip = () =>
    db
      .insert(schema.dependencyAutomationActions)
      .values({ accountId: A, prId: botPr, headSha: 'h1', action: 'approve', state: 'skipped', teammateLogin: 'robin', teammateHandled: false })
      .execute();

  it('is released ONCE, naming them', async () => {
    await skip();
    lines = [robin('pending', 'robin handling · approving', 31 * MIN)];
    await release.releaseStaleDepsClaims(log);
    expect(posted).toEqual([{ state: 'success', description: "Cleared by me: robin's claim expired", sha: 'h1' }]);
    await release.releaseStaleDepsClaims(log);
    restart();
    await release.releaseStaleDepsClaims(log); // durable: a restart does not post it again
    expect(posted).toHaveLength(1);
    expect((await ledger()).find((r: any) => r.whose === 'teammate')).toMatchObject({ login: 'robin', state: 'released' });
  });

  it('a live claim, or one that settled, is left alone', async () => {
    await skip();
    lines = [robin('pending', 'robin handling · approving', 5 * MIN)];
    await release.releaseStaleDepsClaims(log);
    lines = [robin('pending', 'robin handling · approving', 40 * MIN), robin('success', 'robin approved', 2 * MIN)];
    restart();
    await release.releaseStaleDepsClaims(log);
    expect(posted).toEqual([]);
  });
});

describe('(c) an armed merge', () => {
  const armIt = async () => {
    await auto.setDependencyAutomation(A, wsId, { autoMerge: true });
    await policy.runDependencyPolicyTick(log);
    const [intent] = await db.select().from(schema.autoMergeRequests).execute();
    expect(intent).toMatchObject({ state: 'armed', armedByPolicy: true });
    expect(posted.at(-1)?.description).toBe('me armed the merge · lands when checks pass');
    expect((await ledger())[0]).toMatchObject({ action: 'arm_merge', state: 'armed' });
    return intent;
  };

  it('is renewed while armed — not before the renewal interval', async () => {
    await armIt();
    await release.releaseStaleDepsClaims(log);
    expect(posted).toHaveLength(2);
    await release.releaseStaleDepsClaims(log, { nowMs: Date.now() + claims.DEPS_ARMED_RENEW_MS + MIN });
    expect(posted).toHaveLength(3);
    expect(posted.at(-1)).toMatchObject({ state: 'success', description: 'me armed the merge · lands when checks pass' });
  });

  it('ends unlanded (expired): released at once, and a teammate may arm', async () => {
    const intent = await armIt();
    const robinView = () => claims.decideDepsClaim(lines, 'robin', Date.now(), 'merge', { action: 'arm_merge', ciGreen: true });
    expect(robinView().kind).toBe('handled');
    await db.update(schema.autoMergeRequests).set({ state: 'expired' }).where(eq(schema.autoMergeRequests.id, intent.id)).execute();
    await release.releaseStaleDepsClaims(log);
    expect(posted.at(-1)).toMatchObject({ state: 'success', description: 'Cleared by me: merge not armed any more · free to claim' });
    expect((await ledger())[0]).toMatchObject({ state: 'released' });
    expect(robinView()).toEqual({ kind: 'free' });
    await release.releaseStaleDepsClaims(log);
    expect(posted).toHaveLength(3);
  });

  it('a machine that went away: its armed line expires on the lease for teammates', async () => {
    await armIt();
    const later = Date.now() + claims.DEPS_ARMED_LEASE_MS + MIN;
    expect(claims.decideDepsClaim(lines, 'robin', later, 'merge', { action: 'arm_merge', ciGreen: true })).toEqual({ kind: 'free' });
  });

  it('landed: closed, nothing posted', async () => {
    const intent = await armIt();
    await db.update(schema.autoMergeRequests).set({ state: 'merged' }).where(eq(schema.autoMergeRequests.id, intent.id)).execute();
    await release.releaseStaleDepsClaims(log);
    expect(posted).toHaveLength(2);
    expect((await ledger())[0]).toMatchObject({ state: 'finished', lastError: 'merged' });
  });
});

describe('(d) a rebase ask whose machine cannot run the AI step', () => {
  const conflicting = () => setPr({ mergeable: 'conflicting', mergeStateStatus: 'dirty' });

  it('no AI on this machine: the ask says the AI step is open to teammates', async () => {
    await auto.setDependencyAutomation(A, wsId, { autoResolveConflicts: true });
    await conflicting();
    await auto.runDependencyAutomationTick(log);
    expect(gh.addIssueComment).toHaveBeenCalledTimes(1);
    expect(posted.at(-1)?.description).toBe('me asked the bot to rebase · AI step open to teammates');
  });

  it('AI runs here at the ask, but not when the step comes (over budget): the ask is re-posted open, once', async () => {
    bindAi();
    await auto.setDependencyAutomation(A, wsId, { autoResolveConflicts: true });
    await conflicting();
    await auto.runDependencyAutomationTick(log);
    expect(posted.at(-1)?.description).toBe('me asked the bot to rebase');
    // The wait is over and this machine is over its AI budget.
    await db
      .update(schema.dependencyAutomationActions)
      .set({ createdAt: new Date(Date.now() - 31 * MIN) })
      .where(eq(schema.dependencyAutomationActions.action, 'rebase_request'))
      .execute();
    fix.allowed = false;
    await auto.runDependencyAutomationTick(log);
    expect(fix.started).toEqual([]);
    expect(posted.at(-1)?.description).toBe('me asked the bot to rebase · AI step open to teammates');
    const n = posted.length;
    await auto.runDependencyAutomationTick(log);
    expect(posted).toHaveLength(n);
  });

  it('the teammate side: robin’s open ask counts as the ask, and after the wait this Limn runs the AI step', async () => {
    bindAi();
    await auto.setDependencyAutomation(A, wsId, { autoResolveConflicts: true });
    await conflicting();
    lines = [robin('success', 'robin asked the bot to rebase · AI step open to teammates', 10 * MIN)];
    await auto.runDependencyAutomationTick(log);
    expect(gh.addIssueComment).not.toHaveBeenCalled(); // never asks the bot a second time
    const skip = (await db.select().from(schema.dependencyAutomationActions).execute())[0];
    expect(skip).toMatchObject({ action: 'rebase_request', state: 'skipped', teammateHandled: true });
    // Still inside the wait: nothing.
    await auto.runDependencyAutomationTick(log);
    expect(fix.started).toEqual([]);
    // The wait from robin's ask runs out.
    await db
      .update(schema.dependencyAutomationActions)
      .set({ createdAt: new Date(Date.now() - 31 * MIN) })
      .where(eq(schema.dependencyAutomationActions.id, skip.id))
      .execute();
    await auto.runDependencyAutomationTick(log);
    await auto.__testing.settle();
    expect(fix.started).toHaveLength(1);
    expect(fix.started[0]).toMatchObject({ prId: botPr, resolveConflicts: true });
  });

  it('a plain ask (the asker will run the AI step) still holds a teammate’s AI step', async () => {
    bindAi();
    await auto.setDependencyAutomation(A, wsId, { autoResolveConflicts: true });
    await conflicting();
    lines = [robin('success', 'robin asked the bot to rebase', 40 * MIN)];
    await auto.runDependencyAutomationTick(log);
    const skip = (await db.select().from(schema.dependencyAutomationActions).execute())[0];
    await db
      .update(schema.dependencyAutomationActions)
      .set({ createdAt: new Date(Date.now() - 31 * MIN) })
      .where(eq(schema.dependencyAutomationActions.id, skip.id))
      .execute();
    restart();
    await auto.runDependencyAutomationTick(log);
    await auto.__testing.settle();
    expect(fix.started).toEqual([]);
  });
});

describe('(h) the AI-pushed line', () => {
  it('a write GitHub did not take is posted again on the pushed commit', async () => {
    bindAi();
    await auto.setDependencyAutomation(A, wsId, { autoFix: true });
    await setPr({ ciStatus: 'failure' });
    failPost = (d) => d.includes('AI pushed this commit');
    await auto.runDependencyAutomationTick(log);
    await auto.__testing.settle();
    expect(fix.started).toHaveLength(1);
    expect(posted.some((p) => p.description.includes('AI pushed this commit'))).toBe(false);
    expect((await ledger()).find((r: any) => r.action === 'ai_pushed')).toMatchObject({ headSha: 'p0sh000000000', state: 'claiming' });
    failPost = null;
    await release.releaseStaleDepsClaims(log);
    expect(posted.at(-1)).toMatchObject({ state: 'success', sha: 'p0sh000000000', description: "me's AI pushed this commit · merged only once CI is green" });
    expect((await ledger()).find((r: any) => r.action === 'ai_pushed')).toMatchObject({ state: 'finished' });
    // A teammate's sweep now waits for green CI on that commit.
    const onPushed = lines.filter((l) => l.sha === 'p0sh000000000');
    expect(claims.decideDepsClaim(onPushed, 'robin', Date.now(), 'merge', { action: 'arm_merge' })).toEqual({ kind: 'awaiting_ci' });
  });
});
