// Dependency automation FOR TEAMS (merge/dependency-automation.ts, merge/deps-claim.ts) on a THROWAWAY
// sqlite DB, GitHub, the `limn/deps` lines and the AI Fix seams stubbed.
//
// Pinned:
//   • a teammate's FRESH `limn/deps` claim ⇒ SKIPPED and recorded ("robin is handling this"), never
//     a failure, nothing written to GitHub; a STALE one ⇒ Limn claims (pending line) and acts, then
//     posts its done line; the reader's own line never holds anything;
//   • "Fix dependency PRs with AI": OFF ⇒ nothing; a trusted bot's red PR ⇒ ONE unattended AI fix,
//     pushed, recorded with the pushed commit; never twice at a head; at most 2 AI runs per PR per
//     24 h; over the spend budget ⇒ skipped, nothing claimed; a failure not proven LIVE ⇒ nothing;
//     an untrusted bot ⇒ nothing; a push GitHub refused ⇒ failed with the reason;
//   • the log: an ARMED merge is "arm_merge" (done), and "merge_landed" appears ONLY when the
//     watcher's merge landed — never inferred from arming.
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

const DIR = mkdtempSync(join(tmpdir(), 'pierre-dep-teams-'));
process.env.DATABASE_URL = join(DIR, 't.sqlite');
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let auto: any;
let policy: any;
let claims: any;
let gh: any;
let eq: any;
const A = 1;
let viewerId = 0;
let botId = 0;
let untrustedBotId = 0;
let wsId = 0;
let botPr = 0;
let untrustedPr = 0;
const log = { info: () => {}, warn: () => {}, error: () => {} } as any;

// ---- the fake `limn/deps` lines ----
let lines: any[] = [];
let posted: Array<{ state: string; description: string; context: string; sha?: string }> = [];
let nextId = 1;
let listReads = 0;
// Lines are per commit: a line with a `sha` shows only on that commit; one without, on every commit.
const fakeGithub = {
  async listLines(_a: number, _o: string, _n: string, sha: string) {
    listReads += 1;
    return lines.filter((l) => l.sha == null || l.sha === sha).map((l) => ({ ...l }));
  },
  async postLine(_a: number, _o: string, _n: string, sha: string, context: string, post: any) {
    posted.push({ state: post.state, description: post.description, context, ...(sha !== 'h1' ? { sha } : {}) });
    lines.push({ id: nextId++, state: post.state, description: post.description, createdAtMs: Date.now(), login: 'me', sha });
  },
  async login() {
    return 'me';
  },
};
const teammateLine = (state: string, description: string, agoMs: number) => ({
  id: nextId++,
  state,
  description,
  createdAtMs: Date.now() - agoMs,
  login: 'robin',
});

const live = (over: Record<string, unknown> = {}) => ({
  state: 'open',
  isDraft: false,
  headSha: 'h1',
  headRef: 'dependabot/npm_and_yarn/lodash-4.17.21',
  isFork: false,
  title: 'Bump lodash from 4.17.20 to 4.17.21',
  body: 'Bumps lodash from 4.17.20 to 4.17.21.',
  authorLogin: 'dependabot[bot]',
  labels: [],
  ...over,
});

// ---- the AI fix seams ----
const fix = {
  allowed: true,
  failing: true,
  started: [] as any[],
  status: 'succeeded',
  patch: 'diff --git a/package.json b/package.json\n',
  push: { ok: true, sha: 'f1x5ha0000000' } as any,
  // The sandbox pre-check's answer, and what the start answers (null ⇒ queued).
  sandbox: { ok: true } as any,
  startAnswer: null as any,
};
const aiFixDeps = () => ({
  allowed: async () => fix.allowed,
  readFailures: async () =>
    fix.failing ? { failures: [{ checkName: 'build', step: 'tsc', excerpt: 'error TS2322' }], otherFailing: [] } : null,
  startFix: async (_ctx: unknown, input: any) => {
    fix.started.push(input);
    return fix.startAnswer ?? { status: 'queued', fixId: 100 + fix.started.length };
  },
  fixState: async () => ({ status: fix.status, patch: fix.patch, error: fix.status === 'failed' ? 'boom' : null, provider: 'claude' }),
  push: async () => fix.push,
  isFixRunning: async () => false,
  sandbox: async () => fix.sandbox,
  pollMs: 1,
});

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
  gh = await import('../github/mutations.js');
  ({ eq } = await import('drizzle-orm'));
  const { users, repos, pullRequests, workspaceReviewers } = schema;
  const user = async (login: string, isBot: boolean, displayName?: string): Promise<number> =>
    (await db.insert(users).values({ githubLogin: login, isBot, displayName }).returning().execute())[0].id;
  viewerId = await user('me', false);
  botId = await user('dependabot[bot]', true);
  untrustedBotId = await user('renovate[bot]', true);
  await user('robin', false, 'Robin Dunn');
  const [repo] = await db
    .insert(repos)
    .values({ accountId: A, owner: 'o', name: 'w', githubNodeId: 'R_w', viewerPermission: 'WRITE' })
    .returning()
    .execute();
  const pr = async (n: number, authorId: number): Promise<number> =>
    (
      await db
        .insert(pullRequests)
        .values({
          githubNodeId: `PR_${n}`,
          accountId: A,
          repoId: repo.id,
          number: n,
          title: 'Bump lodash from 4.17.20 to 4.17.21',
          headRefName: 'dependabot/npm_and_yarn/lodash-4.17.21',
          authorId,
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
  botPr = await pr(1, botId);
  untrustedPr = await pr(2, untrustedBotId);
  wsId = (await q.resolveWorkspaceScope(A, undefined)).workspaceId;
  const row = (authorUserId: number, kind: string) => ({
    accountId: A,
    workspaceId: wsId,
    authorUserId,
    automated: true,
    role: 'dependency',
    confidence: 'high',
    source: 'auto',
    kind,
  });
  await db.insert(workspaceReviewers).values([row(botId, 'dependabot'), row(untrustedBotId, 'renovate')]).execute();
});

afterAll(async () => {
  await closeDb?.();
  rmSync(DIR, { recursive: true, force: true });
});

const actions = async (): Promise<any[]> => db.select().from(schema.dependencyAutomationActions).execute();
const setPr = (id: number, set: Record<string, unknown>) =>
  db.update(schema.pullRequests).set(set).where(eq(schema.pullRequests.id, id)).execute();

beforeEach(async () => {
  auto.__testing.reset();
  claims._resetDepsClaimsForTest();
  claims.setDepsClaimGithubForTest(fakeGithub);
  lines = [];
  posted = [];
  listReads = 0;
  Object.assign(fix, {
    allowed: true,
    failing: true,
    started: [],
    status: 'succeeded',
    push: { ok: true, sha: 'f1x5ha0000000' },
    sandbox: { ok: true },
    startAnswer: null,
  });
  await db.delete(schema.dependencyAutomationActions).execute();
  await db.delete(schema.autoMergeRequests).execute();
  await db.delete(schema.reviews).execute();
  await setPr(botPr, { headSha: 'h1', ciStatus: 'success', mergeStateStatus: 'blocked', mergeable: 'mergeable' });
  await setPr(untrustedPr, { headSha: 'h1', ciStatus: 'success' });
  await db.update(schema.workspaces).set({ teamClaimsEnabled: null }).execute();
  await auto.setDependencyAutomation(A, wsId, {
    autoMerge: false,
    autoApprove: false,
    autoResolveConflicts: false,
    autoFix: false,
    trustedBotIds: [botId],
  });
  for (const f of [gh.fetchPrForAutomation, gh.submitPrReview, gh.fetchPrHeadInfo]) f.mockReset();
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
});

describe('team claims on dependency work', () => {
  it('a teammate’s FRESH claim: skipped and recorded, nothing written to GitHub', async () => {
    await auto.setDependencyAutomation(A, wsId, { autoApprove: true });
    lines = [teammateLine('pending', 'robin handling · fixing CI', 5 * 60_000)];
    await auto.runDependencyAutomationTick(log);
    expect(gh.submitPrReview).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
    const [row] = await actions();
    expect(row).toMatchObject({ action: 'approve', state: 'skipped', teammateLogin: 'robin', teammateHandled: false });
    const repoId = (await db.select().from(schema.pullRequests).execute())[0].repoId;
    const logItems = await auto.listDependencyAutomationLog(A, [repoId]);
    expect(logItems[0]).toMatchObject({
      action: 'approve',
      state: 'skipped',
      detail: 'robin is handling this',
      teammate: { login: 'robin', name: 'Robin Dunn', handled: false },
      repoFullName: 'o/w',
      prNumber: 1,
    });
    // Remembered: the next tick reads nothing and writes nothing.
    await auto.runDependencyAutomationTick(log);
    expect(gh.submitPrReview).not.toHaveBeenCalled();
  });

  it('a STALE claim: Limn claims, acts, and posts its done line; the skip row is taken over', async () => {
    await auto.setDependencyAutomation(A, wsId, { autoApprove: true });
    // A skip recorded earlier at this head is not an attempt.
    await db
      .insert(schema.dependencyAutomationActions)
      .values({ accountId: A, prId: botPr, headSha: 'h1', action: 'approve', state: 'skipped', teammateLogin: 'robin' })
      .execute();
    lines = [teammateLine('pending', 'robin handling · approving', 31 * 60_000)];
    await auto.runDependencyAutomationTick(log);
    expect(gh.submitPrReview).toHaveBeenCalledTimes(1);
    expect(posted).toEqual([
      { state: 'pending', description: 'me handling · approving', context: 'limn/deps' },
      { state: 'success', description: 'me approved', context: 'limn/deps' },
    ]);
    const rows = await actions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'approve', state: 'done', teammateLogin: null });
  });

  it('a teammate’s finished approval holds approval, not the merge', async () => {
    await auto.setDependencyAutomation(A, wsId, { autoApprove: true, autoMerge: true });
    lines = [teammateLine('success', 'robin approved', 60_000)];
    await auto.runDependencyAutomationTick(log);
    expect(gh.submitPrReview).not.toHaveBeenCalled();
    await policy.runDependencyPolicyTick(log);
    const intents = await db.select().from(schema.autoMergeRequests).execute();
    expect(intents.find((i: any) => i.prId === botPr)).toMatchObject({ state: 'armed', armedByPolicy: true });
    const rows = await actions();
    expect(rows.find((r: any) => r.prId === botPr && r.action === 'approve')).toMatchObject({
      state: 'skipped',
      teammateHandled: true,
    });
    expect(rows.find((r: any) => r.prId === botPr && r.action === 'arm_merge')).toMatchObject({ state: 'done' });
  });

  it('the team-claims switch off: nothing is read or posted, the action goes ahead', async () => {
    await db.update(schema.workspaces).set({ teamClaimsEnabled: false }).execute();
    await auto.setDependencyAutomation(A, wsId, { autoApprove: true });
    lines = [teammateLine('pending', 'robin handling · approving', 60_000)];
    await auto.runDependencyAutomationTick(log);
    expect(gh.submitPrReview).toHaveBeenCalledTimes(1);
    expect(posted).toEqual([]);
  });
});

describe('Fix dependency PRs with AI', () => {
  const bindAi = () => {
    auto.bindDependencyAutomationAi({} as any);
    auto.__testing.setAiFixDeps(aiFixDeps());
  };

  it('OFF by default: a red PR gets nothing', async () => {
    bindAi();
    await setPr(botPr, { ciStatus: 'failure' });
    await auto.runDependencyAutomationTick(log);
    expect(fix.started).toEqual([]);
    expect(await actions()).toEqual([]);
  });

  it('ON: one unattended fix, pushed, recorded with its commit; never twice at the head', async () => {
    bindAi();
    await auto.setDependencyAutomation(A, wsId, { autoFix: true });
    await setPr(botPr, { ciStatus: 'failure' });
    await setPr(untrustedPr, { ciStatus: 'failure' });
    await auto.runDependencyAutomationTick(log);
    await auto.__testing.settle();
    expect(fix.started).toHaveLength(1); // the untrusted bot's PR is never touched
    expect(fix.started[0]).toMatchObject({ accountId: A, prId: botPr });
    expect(fix.started[0].instruction).toContain('Check "build", step "tsc"');
    const [row] = await actions();
    expect(row).toMatchObject({ action: 'ai_fix', state: 'done', resultSha: 'f1x5ha0000000' });
    expect(row.detail).toBe('Fixed with Claude and pushed f1x5ha0');
    expect(posted.map((p) => p.description)).toEqual([
      'me handling · fixing CI',
      'me fixed CI · pushed f1x5ha0',
      "me's AI pushed this commit · merged only once CI is green",
    ]);
    // The AI-pushed line goes on the PUSHED commit, for every machine's merge sweep.
    expect(posted.at(-1)).toMatchObject({ state: 'success', sha: 'f1x5ha0000000' });
    // The pushed head must go green again before anything approves or arms it.
    expect(await auto.aiPushedHeads(A, [botPr])).toEqual(new Set([`${botPr}:f1x5ha0000000`]));
    await auto.runDependencyAutomationTick(log);
    await auto.__testing.settle();
    expect(fix.started).toHaveLength(1);
  });

  it('at most 2 AI runs per PR per 24 hours, across heads', async () => {
    bindAi();
    await auto.setDependencyAutomation(A, wsId, { autoFix: true });
    for (const head of ['h0', 'hx']) {
      await db
        .insert(schema.dependencyAutomationActions)
        .values({ accountId: A, prId: botPr, headSha: head, action: head === 'h0' ? 'ai_fix' : 'ai_resolve', state: 'failed' })
        .execute();
    }
    await setPr(botPr, { ciStatus: 'failure' });
    await auto.runDependencyAutomationTick(log);
    expect(fix.started).toEqual([]);
  });

  it('over the spend budget, or the failure not proven live: skipped, nothing claimed', async () => {
    bindAi();
    await auto.setDependencyAutomation(A, wsId, { autoFix: true });
    await setPr(botPr, { ciStatus: 'failure' });
    fix.allowed = false;
    await auto.runDependencyAutomationTick(log);
    fix.allowed = true;
    fix.failing = false; // re-run since: GitHub shows nothing failing now
    await auto.runDependencyAutomationTick(log);
    expect(fix.started).toEqual([]);
    expect(await actions()).toEqual([]);
    expect(posted).toEqual([]);
  });

  it('a push GitHub refused is recorded as failed with the reason, and the line says so', async () => {
    bindAi();
    await auto.setDependencyAutomation(A, wsId, { autoFix: true });
    await setPr(botPr, { ciStatus: 'failure' });
    fix.push = { ok: false, message: 'The branch moved.' };
    await auto.runDependencyAutomationTick(log);
    await auto.__testing.settle();
    const [row] = await actions();
    expect(row).toMatchObject({ action: 'ai_fix', state: 'failed', detail: 'Not pushed: The branch moved.', resultSha: null });
    expect(posted.at(-1)).toMatchObject({ state: 'success', description: "me couldn't fix CI" });
  });

  it('⚠ no container runtime: ONE skipped row with the reason, no claim, no GitHub write; later ticks read nothing', async () => {
    bindAi();
    await auto.setDependencyAutomation(A, wsId, { autoFix: true });
    await setPr(botPr, { ciStatus: 'failure' });
    fix.sandbox = { ok: false, reason: 'no_runtime', message: 'Docker is not running.' };
    await auto.runDependencyAutomationTick(log);
    expect(fix.started).toEqual([]);
    expect(posted).toEqual([]); // no limn/deps line: nothing claimed
    const [first, ...more] = await actions();
    expect(more).toEqual([]);
    expect(first).toMatchObject({ action: 'ai_fix', state: 'skipped', detail: auto.NO_SANDBOX_DETAIL, teammateLogin: null });
    // The next ticks: the head is already recorded — no live PR read, the row is not rewritten.
    const reads = gh.fetchPrForAutomation.mock.calls.length;
    await auto.runDependencyAutomationTick(log);
    await auto.runDependencyAutomationTick(log);
    expect(gh.fetchPrForAutomation.mock.calls.length).toBe(reads);
    const after = await actions();
    expect(after).toHaveLength(1);
    expect(after[0].updatedAt.getTime()).toBe(first.updatedAt.getTime());
    // The log says so, with no teammate.
    const repoIds = (await db.select({ id: schema.pullRequests.repoId }).from(schema.pullRequests).where(eq(schema.pullRequests.id, botPr)).execute()).map((r: any) => r.id);
    const logRows = await auto.listDependencyAutomationLog(A, repoIds);
    expect(logRows[0]).toMatchObject({ action: 'ai_fix', state: 'skipped', detail: auto.NO_SANDBOX_DETAIL, teammate: null });
    // A runtime appears: the skip is not an attempt — the claim takes it over and the fix runs.
    fix.sandbox = { ok: true };
    await auto.runDependencyAutomationTick(log);
    await auto.__testing.settle();
    expect(fix.started).toHaveLength(1);
    const [row] = await actions();
    expect(row).toMatchObject({ action: 'ai_fix', state: 'done', resultSha: 'f1x5ha0000000', teammateLogin: null });
  });

  it('a skip for no runtime never counts toward the 2-runs cap', async () => {
    bindAi();
    await auto.setDependencyAutomation(A, wsId, { autoFix: true });
    // One real run on an older head + a no-runtime skip on another: one attempt, so a run may start.
    await db
      .insert(schema.dependencyAutomationActions)
      .values({ accountId: A, prId: botPr, headSha: 'h0', action: 'ai_fix', state: 'failed' })
      .execute();
    await auto.recordSandboxSkip(A, botPr, 'hz', 'ai_fix', auto.NO_SANDBOX_DETAIL);
    await setPr(botPr, { ciStatus: 'failure' });
    await auto.runDependencyAutomationTick(log);
    await auto.__testing.settle();
    expect(fix.started).toHaveLength(1);
  });

  it('a busy sandbox: nothing read, claimed or recorded — a later tick decides', async () => {
    bindAi();
    await auto.setDependencyAutomation(A, wsId, { autoFix: true });
    await setPr(botPr, { ciStatus: 'failure' });
    fix.sandbox = { ok: false, reason: 'busy', message: 'Another sandbox session is building.' };
    const reads = gh.fetchPrForAutomation.mock.calls.length;
    await auto.runDependencyAutomationTick(log);
    expect(gh.fetchPrForAutomation.mock.calls.length).toBe(reads);
    expect(fix.started).toEqual([]);
    expect(await actions()).toEqual([]);
    expect(posted).toEqual([]);
  });

  it('the start loses the sandbox race after the claim: the claim is given back (busy), or becomes the skip (no runtime)', async () => {
    bindAi();
    await auto.setDependencyAutomation(A, wsId, { autoFix: true });
    await setPr(botPr, { ciStatus: 'failure' });
    fix.startAnswer = { status: 'build_busy' };
    await auto.runDependencyAutomationTick(log);
    expect(fix.started).toHaveLength(1);
    expect(await actions()).toEqual([]); // given back: the row is gone
    expect(posted).toHaveLength(2); // the claim, then its release
    expect(posted[0]?.description).toBe('me handling · fixing CI');
    fix.startAnswer = { status: 'no_runtime', message: 'gone' };
    await auto.runDependencyAutomationTick(log);
    const rows = await actions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'skipped', detail: auto.NO_SANDBOX_DETAIL });
  });

  it('⚠ a person’s cancel wins: a cancelled fix is recorded "Cancelled." and never pushed', async () => {
    bindAi();
    await auto.setDependencyAutomation(A, wsId, { autoFix: true });
    await setPr(botPr, { ciStatus: 'failure' });
    fix.status = 'cancelled';
    let pushed = 0;
    auto.__testing.setAiFixDeps({ ...aiFixDeps(), push: async () => ((pushed += 1), fix.push) });
    await auto.runDependencyAutomationTick(log);
    await auto.__testing.settle();
    expect(pushed).toBe(0);
    expect((await actions())[0]).toMatchObject({ action: 'ai_fix', state: 'failed', detail: 'Cancelled.' });
  });

  it('a teammate already tried this head: skipped, recorded as theirs', async () => {
    bindAi();
    await auto.setDependencyAutomation(A, wsId, { autoFix: true });
    await setPr(botPr, { ciStatus: 'failure' });
    lines = [teammateLine('success', "robin couldn't fix CI", 10 * 60_000)];
    await auto.runDependencyAutomationTick(log);
    expect(fix.started).toEqual([]);
    expect((await actions())[0]).toMatchObject({ action: 'ai_fix', state: 'skipped', detail: 'robin handled this' });
  });
});

describe('teams: holds before reads, other machines, AI-pushed heads', () => {
  const bindAi = () => {
    auto.bindDependencyAutomationAi({} as any);
    auto.__testing.setAiFixDeps(aiFixDeps());
  };

  it('a remembered teammate hold on the action costs no live PR read on later ticks', async () => {
    bindAi();
    await auto.setDependencyAutomation(A, wsId, { autoFix: true });
    await setPr(botPr, { ciStatus: 'failure' });
    lines = [teammateLine('success', "robin couldn't fix CI", 10 * 60_000)];
    await auto.runDependencyAutomationTick(log);
    expect(fix.started).toEqual([]);
    const reads = gh.fetchPrForAutomation.mock.calls.length;
    const listed = listReads;
    for (let i = 0; i < 3; i++) await auto.runDependencyAutomationTick(log);
    // Neither the PR nor its lines are read again while the hold is remembered.
    expect(gh.fetchPrForAutomation.mock.calls.length).toBe(reads);
    expect(listReads).toBe(listed);
  });

  it("the reader's OTHER machine already tried this head (own login, no local row): not tried again", async () => {
    bindAi();
    await auto.setDependencyAutomation(A, wsId, { autoFix: true });
    await setPr(botPr, { ciStatus: 'failure' });
    lines = [{ id: nextId++, state: 'success', description: "me couldn't fix CI", createdAtMs: Date.now() - 60_000, login: 'me' }];
    await auto.runDependencyAutomationTick(log);
    await auto.__testing.settle();
    expect(fix.started).toEqual([]);
  });

  it("a head a teammate's AI pushed is armed only once its CI is green", async () => {
    await auto.setDependencyAutomation(A, wsId, { autoMerge: true });
    await setPr(botPr, { headSha: 'x1', ciStatus: 'pending' });
    await setPr(untrustedPr, { ciStatus: 'failure' });
    gh.fetchPrHeadInfo.mockResolvedValue({ headSha: 'x1', headRef: 'dependabot/x', headRepoFullName: 'o/w', isFork: false, maintainerCanModify: true, baseRef: 'main' });
    lines = [{ ...teammateLine('success', "robin's AI pushed this commit · merged only once CI is green", 60_000), sha: 'x1' }];
    await policy.runDependencyPolicyTick(log);
    let intents = await db.select().from(schema.autoMergeRequests).execute();
    expect(intents.find((i: any) => i.prId === botPr)).toBeUndefined();
    expect(posted).toEqual([]);
    // Green now (and the short re-check memory has passed): armed.
    claims._resetDepsClaimsForTest();
    claims.setDepsClaimGithubForTest(fakeGithub);
    await setPr(botPr, { ciStatus: 'success' });
    await policy.runDependencyPolicyTick(log);
    intents = await db.select().from(schema.autoMergeRequests).execute();
    expect(intents.find((i: any) => i.prId === botPr)).toMatchObject({ state: 'armed' });
  });

  it('"Fix them with AI" stored on while the AI is off never asks a bot to rebase', async () => {
    // No AI bound (the reset in beforeEach): the switch is hidden in Settings.
    await auto.setDependencyAutomation(A, wsId, { autoFix: true, autoResolveConflicts: false });
    await setPr(botPr, { mergeable: 'conflicting', mergeStateStatus: 'dirty' });
    const comments = gh.addIssueComment.mock.calls.length;
    const bodies = gh.updatePullRequestBody.mock.calls.length;
    gh.addIssueComment.mockResolvedValue({ databaseId: 1, nodeId: 'IC_1', body: 'x', createdAt: new Date().toISOString(), url: 'u', authorLogin: 'me' });
    await auto.runDependencyAutomationTick(log);
    expect(gh.addIssueComment.mock.calls.length).toBe(comments);
    expect(gh.updatePullRequestBody.mock.calls.length).toBe(bodies);
    expect(await actions()).toEqual([]);
  });
});

describe('the log: armed vs landed', () => {
  it('arming records "arm_merge"; only a LANDED merge records "merge_landed"', async () => {
    await auto.setDependencyAutomation(A, wsId, { autoMerge: true });
    await policy.runDependencyPolicyTick(log);
    const repoId = (await db.select().from(schema.pullRequests).execute())[0].repoId;
    let items = await auto.listDependencyAutomationLog(A, [repoId]);
    const armed = items.filter((i: any) => i.prId === botPr);
    expect(armed.map((i: any) => [i.action, i.state, i.detail])).toEqual([['arm_merge', 'done', null]]);
    expect(posted.map((p) => p.description)).toContain('me armed the merge · lands when checks pass');
    // The watcher's merge outcome (never the arm) writes the landing — once per head.
    await auto.recordDependencyMergeLanded(A, botPr, 'h1');
    await auto.recordDependencyMergeLanded(A, botPr, 'h1');
    items = await auto.listDependencyAutomationLog(A, [repoId]);
    expect(items.filter((i: any) => i.prId === botPr).map((i: any) => i.action).sort()).toEqual(['arm_merge', 'merge_landed']);
  });
});
