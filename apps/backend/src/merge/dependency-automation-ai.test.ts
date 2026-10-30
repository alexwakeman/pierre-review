// Dependency automation's AI FALLBACK (merge/dependency-automation.ts) on a THROWAWAY sqlite DB, with
// GitHub, the resolver session and the AI run stubbed.
//
// Pinned: after the bot was asked and the wait ran out, ONE AI run starts — only when the automatic
// budget gate allows it; a complete, sure answer is committed as a MERGE onto the PR's own branch
// and its commit recorded (the head that must go green again); anything less is recorded as failed
// and NOT pushed; and a second tick at the same head never starts another run.
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
  answer: null as any,
  started: 0,
  land: [] as any[],
  /** What `peekSession` says BEFORE the automation starts its own run (a reader's session). */
  readerSession: null as any,
}));
vi.mock('../review/budget-gate.js', () => ({
  automaticRunAllowed: vi.fn(async () => fake.allowed),
}));
vi.mock('../coding/ai-resolve/run.js', () => ({
  startAiResolve: vi.fn(async () => {
    fake.started += 1;
    return { status: 'started', resolution: {} };
  }),
  getAiResolution: vi.fn(() => fake.answer),
}));
const MODEL = {
  headSha: 'h1',
  baseSha: 'b1',
  prBranchPushable: true,
  prBranchUnavailableReason: null,
  files: [{ index: 0, path: 'package.json', unsupported: null, regions: [{ id: 1, kind: 'conflict' }] }],
};
vi.mock('../conflict/session.js', () => ({
  peekSession: vi.fn(
    () =>
      fake.readerSession ?? { aiRunning: false, subscribers: new Set(), sessionId: 's1', modelHash: 'mh', model: MODEL },
  ),
}));
vi.mock('../api/routes/conflicts.js', () => ({
  runOpen: vi.fn(),
  landSessionResolution: vi.fn(async (_rec: unknown, body: unknown) => {
    fake.land.push(body);
    return { ok: true, result: { commitSha: 'c0ffee1234567' } };
  }),
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

const answer = (choices: any[]) => ({ status: 'succeeded', sessionId: 's1', provider: 'claude', choices, error: null });
const choice = (over: Record<string, unknown> = {}) => ({
  fileIndex: 0,
  regionId: 1,
  decision: 'theirs',
  editId: null,
  lines: null,
  rationale: '',
  confidence: 'high',
  ...over,
});
const LATER = () => Date.now() + 2 * 60 * 60_000;

async function settled(): Promise<any[]> {
  await vi.waitFor(async () => {
    const rows = await actions();
    if (rows.some((r) => r.action === 'ai_resolve' && r.state === 'running')) throw new Error('still running');
  });
  return actions();
}

describe('the AI fallback', () => {
  beforeEach(async () => {
    fake.allowed = true;
    fake.started = 0;
    fake.land = [];
    fake.readerSession = null;
    await auto.setDependencyAutomation(A, wsId, { autoResolveConflicts: true, trustedBotIds: [botId] });
    await setPr(botPr, { mergeStateStatus: 'dirty', mergeable: 'conflicting' });
    auto.bindDependencyAutomationAi({ aiBudget: null } as any);
    // Dependabot was asked; the wait runs out at LATER().
    await db
      .insert(schema.dependencyAutomationActions)
      .values({ accountId: A, prId: botPr, headSha: 'h1', action: 'rebase_request', state: 'done' })
      .execute();
  });

  it('commits a complete, sure answer as a merge onto the PR branch, once', async () => {
    fake.answer = answer([choice()]);
    await auto.runDependencyAutomationTick(log, LATER());
    const rows = await settled();
    expect(fake.started).toBe(1);
    expect(fake.land).toEqual([
      {
        sessionId: 's1',
        expectedHeadSha: 'h1',
        expectedBaseSha: 'b1',
        modelHash: 'mh',
        strategy: 'merge',
        target: { kind: 'pr_branch' },
        files: [{ index: 0, decisions: [{ id: 1, decision: 'theirs' }] }],
      },
    ]);
    expect(rows.find((r) => r.action === 'ai_resolve')).toMatchObject({
      state: 'done',
      resultSha: 'c0ffee1234567',
      detail: 'Resolved with Claude and pushed c0ffee1',
    });
    await auto.runDependencyAutomationTick(log, LATER());
    expect(fake.started).toBe(1);
  });

  it('does not push an answer the AI was unsure of', async () => {
    fake.answer = answer([choice({ confidence: 'low' })]);
    await auto.runDependencyAutomationTick(log, LATER());
    const rows = await settled();
    expect(fake.land).toEqual([]);
    expect(rows.find((r) => r.action === 'ai_resolve')).toMatchObject({ state: 'failed' });
  });

  it('waits for the bot before the wait runs out, and skips when over budget', async () => {
    fake.answer = answer([choice()]);
    await auto.runDependencyAutomationTick(log);
    fake.allowed = false;
    await auto.runDependencyAutomationTick(log, LATER());
    expect(fake.started).toBe(0);
    expect((await actions()).some((r) => r.action === 'ai_resolve')).toBe(false);
  });

  it('never takes over a resolver a reader has open or an AI run a reader started', async () => {
    fake.answer = answer([choice()]);
    fake.readerSession = { aiRunning: false, subscribers: new Set([() => {}]), sessionId: 's1', modelHash: 'mh', model: MODEL };
    await auto.runDependencyAutomationTick(log, LATER());
    fake.readerSession = { aiRunning: true, subscribers: new Set(), sessionId: 's1', modelHash: 'mh', model: MODEL };
    await auto.runDependencyAutomationTick(log, LATER());
    expect(fake.started).toBe(0);
    expect(fake.land).toEqual([]);
    expect((await actions()).some((r) => r.action === 'ai_resolve')).toBe(false);
  });
});
