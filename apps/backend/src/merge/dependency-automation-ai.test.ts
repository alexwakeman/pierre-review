// Dependency automation's CONFLICT RUN (merge/dependency-automation.ts) on a THROWAWAY sqlite DB, with
// GitHub and AI Fix's session stubbed through its seams (`__testing.setAiFixDeps`).
//
// Pinned: after the bot was asked and the wait ran out, ONE unattended AI Fix session starts with the
// MERGE item (`resolveConflicts: true`, the conflict instruction) — only when the automatic budget gate
// allows it and the sandbox is ready; a VALID merge is pushed through AI Fix's own Push and its commit
// recorded (the head that must go green again); a merge Limn's check refused is recorded as failed and
// NOT pushed; a person's cancel wins; no container runtime is one skip row; a reader's open resolver is
// never taken over; and a second tick at the same head never starts another run.
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
const fake = vi.hoisted(() => ({
  allowed: true,
  started: [] as any[],
  pushed: [] as number[],
  stopped: [] as number[],
  state: null as any,
  sandbox: { ok: true } as any,
  /** What `peekSession` says about the MANUAL resolver (a reader's session). */
  readerSession: null as any,
}));
vi.mock('../review/budget-gate.js', () => ({
  automaticRunAllowed: vi.fn(async () => fake.allowed),
}));
vi.mock('../conflict/session.js', () => ({
  peekSession: vi.fn(() => fake.readerSession),
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
  baseRef: 'main',
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

const LATER = () => Date.now() + 2 * 60 * 60_000;

async function settled(): Promise<any[]> {
  await vi.waitFor(async () => {
    const rows = await actions();
    if (rows.some((r) => r.action === 'ai_resolve' && r.state === 'running')) throw new Error('still running');
  });
  return actions();
}

const done = (over: Record<string, unknown> = {}) => ({ status: 'succeeded', patch: null, error: null, provider: 'claude', hasWork: true, mergeReason: null, ...over });

describe('the conflict run', () => {
  beforeEach(async () => {
    fake.allowed = true;
    fake.started = [];
    fake.pushed = [];
    fake.stopped = [];
    fake.state = done();
    fake.sandbox = { ok: true };
    fake.readerSession = null;
    await auto.setDependencyAutomation(A, wsId, { autoResolveConflicts: true, autoFix: false, trustedBotIds: [botId] });
    await setPr(botPr, { mergeStateStatus: 'dirty', mergeable: 'conflicting' });
    auto.bindDependencyAutomationAi({ aiBudget: null } as any);
    auto.__testing.setAiFixDeps({
      allowed: async () => fake.allowed,
      startFix: async (_ctx: unknown, input: any) => {
        fake.started.push(input);
        return { status: 'queued', fixId: 70 + fake.started.length };
      },
      fixState: async () => fake.state,
      push: async (_ctx: unknown, _a: number, fixId: number) => {
        fake.pushed.push(fixId);
        return { ok: true, sha: 'c0ffee1234567' };
      },
      isFixRunning: async () => false,
      sandbox: async () => fake.sandbox,
      stop: async (_c: unknown, _a: number, _p: number, fixId: number) => void fake.stopped.push(fixId),
      pollMs: 5,
    });
    // Dependabot was asked; the wait runs out at LATER().
    await db
      .insert(schema.dependencyAutomationActions)
      .values({ accountId: A, prId: botPr, headSha: 'h1', action: 'rebase_request', state: 'done' })
      .execute();
  });

  it('starts ONE unattended AI Fix with the merge item, pushes a valid merge, once', async () => {
    await auto.runDependencyAutomationTick(log, LATER());
    const rows = await settled();
    expect(fake.started).toHaveLength(1);
    expect(fake.started[0]).toMatchObject({ accountId: A, prId: botPr, resolveConflicts: true });
    expect(fake.started[0].instruction).toContain('It conflicts with main. Resolve the merge conflicts (MERGE) and change nothing else.');
    expect(fake.pushed).toEqual([71]);
    expect(rows.find((r) => r.action === 'ai_resolve')).toMatchObject({
      state: 'done',
      resultSha: 'c0ffee1234567',
      detail: 'Resolved with Claude and pushed c0ffee1',
    });
    await auto.runDependencyAutomationTick(log, LATER());
    expect(fake.started).toHaveLength(1);
  });

  it('pushes nothing when Limn refused the merge, and records why', async () => {
    fake.state = done({ hasWork: false, mergeReason: 'package.json still has a conflict marker.' });
    await auto.runDependencyAutomationTick(log, LATER());
    const rows = await settled();
    expect(fake.pushed).toEqual([]);
    expect(rows.find((r) => r.action === 'ai_resolve')).toMatchObject({
      state: 'failed',
      detail: 'Not pushed: package.json still has a conflict marker.',
    });
  });

  it("a person's cancel wins: recorded, nothing pushed, never retried at the head", async () => {
    fake.state = done({ status: 'cancelled' });
    await auto.runDependencyAutomationTick(log, LATER());
    const rows = await settled();
    expect(fake.pushed).toEqual([]);
    expect(rows.find((r) => r.action === 'ai_resolve')).toMatchObject({ state: 'failed', detail: 'Cancelled.' });
    await auto.runDependencyAutomationTick(log, LATER());
    expect(fake.started).toHaveLength(1);
  });

  it('waits for the bot before the wait runs out, and skips when over budget', async () => {
    await auto.runDependencyAutomationTick(log);
    fake.allowed = false;
    await auto.runDependencyAutomationTick(log, LATER());
    expect(fake.started).toEqual([]);
    expect((await actions()).some((r) => r.action === 'ai_resolve')).toBe(false);
  });

  it('no container runtime: ONE skip row, no claim, no GitHub write; later ticks read nothing', async () => {
    fake.sandbox = { ok: false, reason: 'no_runtime', message: 'No container runtime.' };
    await auto.runDependencyAutomationTick(log, LATER());
    expect(fake.started).toEqual([]);
    const rows = (await actions()).filter((r) => r.action === 'ai_resolve');
    expect(rows).toEqual([expect.objectContaining({ state: 'skipped', detail: 'No container runtime on this computer.', teammateLogin: null })]);
    gh.fetchPrForAutomation.mockClear();
    await auto.runDependencyAutomationTick(log, LATER());
    expect(gh.fetchPrForAutomation).not.toHaveBeenCalled();
    // A busy computer writes nothing at all.
    await db.delete(schema.dependencyAutomationActions).where(eq(schema.dependencyAutomationActions.action, 'ai_resolve')).execute();
    fake.sandbox = { ok: false, reason: 'busy', message: 'Another sandbox session is building.' };
    await auto.runDependencyAutomationTick(log, LATER());
    expect((await actions()).some((r) => r.action === 'ai_resolve')).toBe(false);
  });

  it('conflicting AND red with "Fix them with AI": ONE session with the merge and the CI items, ONE run counted', async () => {
    await auto.setDependencyAutomation(A, wsId, { autoResolveConflicts: false, autoFix: true, trustedBotIds: [botId] });
    await setPr(botPr, { ciStatus: 'failure' });
    fake.state = done({ ciItems: 2 });
    await auto.runDependencyAutomationTick(log, LATER());
    const rows = await settled();
    expect(fake.started).toHaveLength(1);
    expect(fake.started[0]).toMatchObject({ prId: botPr, resolveConflicts: true, withCi: true });
    expect(fake.started[0].instruction).toContain('It conflicts with main, and its CI fails.');
    expect(fake.started[0].instruction).not.toContain('Bump lodash'); // Limn's words only, outside every fence
    expect(fake.pushed).toEqual([71]);
    // ONE row (the conflict run's), so ONE AI run against the cap; no separate CI fix.
    expect(rows.filter((r) => r.action === 'ai_resolve' || r.action === 'ai_fix')).toEqual([
      expect.objectContaining({ action: 'ai_resolve', state: 'done', resultSha: 'c0ffee1234567', detail: 'Resolved conflicts and fixed CI with Claude and pushed c0ffee1' }),
    ]);
    await auto.runDependencyAutomationTick(log, LATER());
    expect(fake.started).toHaveLength(1);
  });

  it('"Resolve their conflicts" alone never fixes CI: a red conflicting PR gets the merge only', async () => {
    await setPr(botPr, { ciStatus: 'failure' });
    await auto.runDependencyAutomationTick(log, LATER());
    await settled();
    expect(fake.started).toHaveLength(1);
    expect(fake.started[0].withCi).toBeUndefined();
    expect(fake.started[0].instruction).toContain('Resolve the merge conflicts (MERGE) and change nothing else.');
  });

  it('a combined start with no MERGE item falls back to the merge-only run under the same claim', async () => {
    await auto.setDependencyAutomation(A, wsId, { autoFix: true, trustedBotIds: [botId] });
    await setPr(botPr, { ciStatus: 'error' });
    auto.__testing.setAiFixDeps({
      allowed: async () => true,
      startFix: async (_ctx: unknown, input: any) => {
        fake.started.push(input);
        return input.withCi ? { status: 'nothing_to_fix' } : { status: 'queued', fixId: 90 };
      },
      fixState: async () => fake.state,
      push: async (_c: unknown, _a: number, fixId: number) => {
        fake.pushed.push(fixId);
        return { ok: true, sha: 'abcdef1234567' };
      },
      isFixRunning: async () => false,
      sandbox: async () => ({ ok: true }),
      stop: async () => {},
      pollMs: 5,
    });
    await auto.runDependencyAutomationTick(log, LATER());
    const rows = await settled();
    expect(fake.started.map((x) => x.withCi === true)).toEqual([true, false]);
    expect(fake.pushed).toEqual([90]);
    expect(rows.filter((r) => r.action === 'ai_resolve')).toEqual([expect.objectContaining({ state: 'done', detail: 'Resolved with Claude and pushed abcdef1' })]);
  });

  it('never takes over the manual resolver a reader has open, or one committing', async () => {
    fake.readerSession = { commitRunning: false, subscribers: new Set([() => {}]) };
    await auto.runDependencyAutomationTick(log, LATER());
    fake.readerSession = { commitRunning: true, subscribers: new Set() };
    await auto.runDependencyAutomationTick(log, LATER());
    expect(fake.started).toEqual([]);
    expect((await actions()).some((r) => r.action === 'ai_resolve')).toBe(false);
  });
});
