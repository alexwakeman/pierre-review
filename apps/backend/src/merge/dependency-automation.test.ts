// Dependency automation (merge/dependency-automation.ts) on a THROWAWAY sqlite DB, GitHub stubbed.
//
// Pinned: every switch is OFF by default and per workspace; trust is the STORED bot row's mark and
// only a dependency bot can carry it; approval needs a trusted author, green CI and a policy that
// admits the update, is pinned to the head, happens ONCE per head and is never retried after a
// failure; a conflict first asks Dependabot to rebase, once; a person's cancel stops everything.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../github/mutations.js', () => ({
  fetchPrForAutomation: vi.fn(),
  submitPrReview: vi.fn(),
  addIssueComment: vi.fn(),
  updatePullRequestBody: vi.fn(),
  fetchMergeQueueState: vi.fn(async () => null),
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

const DIR = mkdtempSync(join(tmpdir(), 'pierre-dep-automation-'));
process.env.DATABASE_URL = join(DIR, 't.sqlite');
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let auto: any;
let gh: any;
let eq: any;
const A = 1;
let viewerId = 0;
let botId = 0;
let renovateId = 0;
let personId = 0;
let wsId = 0;
let botPr = 0;
let personPr = 0;
const log = { info: () => {}, warn: () => {}, error: () => {} } as any;

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

beforeAll(async () => {
  const { runMigrations } = await import('../db/run-migrations.js');
  const client = await import('../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  const q = await import('../db/queries.js');
  auto = await import('./dependency-automation.js');
  gh = await import('../github/mutations.js');
  ({ eq } = await import('drizzle-orm'));
  const { users, repos, pullRequests, workspaceReviewers } = schema;
  const user = async (login: string, isBot: boolean): Promise<number> =>
    (await db.insert(users).values({ githubLogin: login, isBot }).returning().execute())[0].id;
  viewerId = await user('me', false);
  botId = await user('dependabot[bot]', true);
  renovateId = await user('renovate[bot]', true);
  personId = await user('alice', false);
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
          openedAt: new Date(),
          updatedAt: new Date(),
        })
        .returning()
        .execute()
    )[0].id;
  botPr = await pr(1, botId);
  personPr = await pr(2, personId);
  wsId = (await q.resolveWorkspaceScope(A, undefined)).workspaceId;
  const row = (authorUserId: number, role: string, kind: string | null) => ({
    accountId: A,
    workspaceId: wsId,
    authorUserId,
    automated: role !== 'human',
    role: role === 'human' ? 'review' : role,
    confidence: 'high',
    source: 'auto',
    kind,
  });
  await db
    .insert(workspaceReviewers)
    .values([row(botId, 'dependency', 'dependabot'), row(renovateId, 'dependency', 'renovate'), row(personId, 'human', null)])
    .execute();
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
  await db.delete(schema.dependencyAutomationActions).execute();
  await db.delete(schema.autoMergePolicySkips).execute();
  await db.delete(schema.reviews).execute();
  await setPr(botPr, { headSha: 'h1', ciStatus: 'success', mergeStateStatus: 'blocked', mergeable: 'mergeable' });
  await auto.setDependencyAutomation(A, wsId, {
    autoApprove: false,
    autoResolveConflicts: false,
    maxLevel: 'major',
    securityOnly: false,
    ecosystems: null,
    trustedBotIds: [],
  });
  for (const f of [gh.fetchPrForAutomation, gh.submitPrReview, gh.addIssueComment, gh.updatePullRequestBody]) f.mockReset();
  gh.fetchPrForAutomation.mockResolvedValue(live());
  gh.submitPrReview.mockResolvedValue({
    databaseId: 9,
    nodeId: 'PRR_9',
    state: 'APPROVED',
    body: 'ok',
    submittedAt: new Date().toISOString(),
    url: 'u',
    authorLogin: 'me',
  });
  gh.addIssueComment.mockResolvedValue({
    nodeId: 'IC_1',
    databaseId: 1,
    body: '@dependabot rebase',
    createdAt: new Date().toISOString(),
    url: 'u',
    authorLogin: 'me',
  });
});

describe('the panel', () => {
  it('is OFF by default, lists only dependency bots, and 404s a foreign workspace', async () => {
    const got = await auto.getDependencyAutomation(A, wsId);
    expect(got.settings).toEqual({
      autoMerge: false,
      autoApprove: false,
      autoResolveConflicts: false,
      policy: { maxLevel: 'major', securityOnly: false, ecosystems: null },
    });
    expect(got.bots.map((b: any) => [b.login, b.trusted, b.canRebase])).toEqual([
      ['dependabot[bot]', false, true],
      ['renovate[bot]', false, true],
    ]);
    expect(await auto.getDependencyAutomation(A, 99_999)).toBeNull();
    expect(await auto.setDependencyAutomation(A, 99_999, { autoApprove: true })).toBe(false);
  });

  it('trusts only the workspace’s dependency bots, and writes only what the patch names', async () => {
    await auto.setDependencyAutomation(A, wsId, { trustedBotIds: [botId, personId], maxLevel: 'minor' });
    const got = await auto.getDependencyAutomation(A, wsId);
    expect(got.bots.find((b: any) => b.userId === botId).trusted).toBe(true);
    expect(got.settings.policy.maxLevel).toBe('minor');
    const person = (await db.select().from(schema.workspaceReviewers).execute()).find((r: any) => r.authorUserId === personId);
    expect(person.dependencyTrusted).toBeNull();
    await auto.setDependencyAutomation(A, wsId, { ecosystems: ['python', 'javascript', 'python'] });
    expect((await auto.getDependencyAutomation(A, wsId)).settings.policy).toEqual({
      maxLevel: 'minor',
      securityOnly: false,
      ecosystems: ['javascript', 'python'],
    });
  });
});

describe('approval', () => {
  const on = (extra: Record<string, unknown> = {}) =>
    auto.setDependencyAutomation(A, wsId, { autoApprove: true, trustedBotIds: [botId], ...extra });

  it('approves a trusted bot’s green PR once per head, pinned to it', async () => {
    await on();
    await auto.runDependencyAutomationTick(log);
    expect(gh.submitPrReview).toHaveBeenCalledTimes(1);
    expect(gh.submitPrReview.mock.calls[0][4]).toMatchObject({ event: 'APPROVE', commitId: 'h1' });
    expect(gh.submitPrReview.mock.calls[0][4].body).toContain('<!-- pierre:claude-review');
    expect((await actions()).map((a) => [a.action, a.state, a.headSha])).toEqual([['approve', 'done', 'h1']]);
    await auto.runDependencyAutomationTick(log);
    expect(gh.submitPrReview).toHaveBeenCalledTimes(1);
    // The person's PR is never touched, trusted or not.
    expect(gh.fetchPrForAutomation.mock.calls.every((c: any[]) => c[3] === 1)).toBe(true);
  });

  it('does nothing while the switch is off, the bot is untrusted, or CI is not green', async () => {
    await auto.runDependencyAutomationTick(log);
    await auto.setDependencyAutomation(A, wsId, { autoApprove: true });
    await auto.runDependencyAutomationTick(log);
    await on();
    for (const ci of ['pending', 'failure', null]) {
      await setPr(botPr, { ciStatus: ci });
      await auto.runDependencyAutomationTick(log);
    }
    expect(gh.submitPrReview).not.toHaveBeenCalled();
  });

  it('skips a head that moved, and a fork', async () => {
    await on();
    gh.fetchPrForAutomation.mockResolvedValueOnce(live({ headSha: 'h2' }));
    await auto.runDependencyAutomationTick(log);
    gh.fetchPrForAutomation.mockResolvedValueOnce(live({ isFork: true }));
    await auto.runDependencyAutomationTick(log);
    expect(gh.submitPrReview).not.toHaveBeenCalled();
  });

  it('honours the policy: size, security-only, ecosystem', async () => {
    await on({ maxLevel: 'patch' });
    gh.fetchPrForAutomation.mockResolvedValue(live({ title: 'Bump lodash from 4.17.20 to 5.0.0', body: null }));
    await setPr(botPr, { title: 'Bump lodash from 4.17.20 to 5.0.0' });
    await auto.runDependencyAutomationTick(log);
    await on({ maxLevel: 'major', securityOnly: true });
    await auto.runDependencyAutomationTick(log);
    await on({ securityOnly: false, ecosystems: ['python'] });
    await auto.runDependencyAutomationTick(log);
    expect(gh.submitPrReview).not.toHaveBeenCalled();
    await on({ ecosystems: ['javascript'] });
    await auto.runDependencyAutomationTick(log);
    expect(gh.submitPrReview).toHaveBeenCalledTimes(1);
    await setPr(botPr, { title: 'Bump lodash from 4.17.20 to 4.17.21' });
  });

  it('records a failed approval and never retries it at that head', async () => {
    await on();
    gh.submitPrReview.mockRejectedValueOnce(new Error('Can not approve your own pull request'));
    await auto.runDependencyAutomationTick(log);
    await auto.runDependencyAutomationTick(log);
    expect(gh.submitPrReview).toHaveBeenCalledTimes(1);
    expect((await actions())[0]).toMatchObject({ state: 'failed', detail: 'Can not approve your own pull request' });
    // A NEW head is a new action.
    await setPr(botPr, { headSha: 'h2' });
    gh.fetchPrForAutomation.mockResolvedValue(live({ headSha: 'h2' }));
    await auto.runDependencyAutomationTick(log);
    expect(gh.submitPrReview).toHaveBeenCalledTimes(2);
  });

  it('a person’s cancel stops it', async () => {
    await on();
    await db.insert(schema.autoMergePolicySkips).values({ accountId: A, prId: botPr }).execute();
    await auto.runDependencyAutomationTick(log);
    expect(gh.submitPrReview).not.toHaveBeenCalled();
  });
});

describe('conflicts', () => {
  it('asks Dependabot to rebase once, then waits; no AI without a bound context', async () => {
    await auto.setDependencyAutomation(A, wsId, { autoResolveConflicts: true, trustedBotIds: [botId] });
    await setPr(botPr, { mergeStateStatus: 'dirty', mergeable: 'conflicting' });
    await auto.runDependencyAutomationTick(log);
    await auto.runDependencyAutomationTick(log);
    expect(gh.addIssueComment).toHaveBeenCalledTimes(1);
    expect(gh.addIssueComment.mock.calls[0][4]).toBe('@dependabot rebase');
    // Long past the wait: still nothing, because no AI context is bound in this process.
    await auto.runDependencyAutomationTick(log, Date.now() + 2 * 60 * 60_000);
    expect((await actions()).map((a) => [a.action, a.state, a.detail])).toEqual([
      ['rebase_request', 'done', 'Asked Dependabot to rebase'],
    ]);
    expect(gh.submitPrReview).not.toHaveBeenCalled();
  });

  it('the log lists what was done, newest first', async () => {
    await auto.setDependencyAutomation(A, wsId, { autoApprove: true, trustedBotIds: [botId] });
    await auto.runDependencyAutomationTick(log);
    const repoIds = (await db.select().from(schema.repos).execute()).map((r: any) => r.id);
    const items = await auto.listDependencyAutomationLog(A, repoIds);
    expect(items.map((i: any) => [i.action, i.state, i.repoFullName, i.prNumber])).toEqual([
      ['approve', 'done', 'o/w', 1],
    ]);
    expect(await auto.listDependencyAutomationLog(2, repoIds)).toEqual([]);
  });
});
