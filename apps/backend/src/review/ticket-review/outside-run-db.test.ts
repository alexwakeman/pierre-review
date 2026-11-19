// CODE OUTSIDE THE TICKET in a REAL story check run (manager.ts + outside.ts) over the REAL core client
// and migrations, with git, the agent and the tracker faked. What this pins:
//   1. Planning (pure + DB): the workspace's other repositories, related ones first, then by owner/name,
//      at most STORY_CHECK_OUTSIDE_REPOS_MAX (member repos never count), the rest NAMED; an OPEN PR in a
//      related repository on a member's branch name that is not on the ticket is read as unlinked.
//   2. A run reads exactly the right roots: the member's worktree, every outside default branch that
//      could be checked out, the unlinked PR's head — handed to the agent's path guard — and MEMBERS.md
//      and the prompt list them labelled apart; a source that could not be checked out is named
//      (`read: false`) and never fails the run.
//   3. The stored run: met-outside criteria labelled, an outside `expectedIn` → `noPrIn` (never a post
//      target), the outside context on the assessment, and ⚠ the fingerprint is the members' only.
//   4. The workspace switch OFF ⇒ members only: no outside root, no outside context, no label — and the
//      run's fingerprint carries the switch (OFF), never an outside SHA.
//   5. Unlinked PRs: never a FORK's, never on a default branch name.
//   6. THE BRANCH CHECK (the review loops): the ticket's OWN PRs are never "outside" (their repository is not
//      "no PR on this ticket", their PR is not "not linked"); a target's own branch is the target; the
//      clone cache's deferred eviction runs.
//
//   pnpm --filter @pierre-review/backend test ticket-review/outside-run-db
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { STORY_CHECK_OUTSIDE_REPOS_MAX, type TicketReviewStreamEvent } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-ticket-review-outside-db.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

// ---- fakes: git (clone cache), the agent, the shared review slots, the diffs ----
const FAIL_REPO = 'r05';
vi.mock('../clone-manager.js', async (orig) => ({
  ...(await orig<typeof import('../clone-manager.js')>()),
  prepPeerWorktrees: async (peers: Array<{ owner: string; name: string; number: number; headSha: string }>) => ({
    peers: peers.map((p) => ({ ...p, path: `/wt/pr-${p.name}-${p.number}`, repoCloneDir: '/c', error: null })),
    cleanup: async () => {},
  }),
  prepDefaultBranchCheckouts: async (repos: Array<{ owner: string; name: string; branch: string | null }>) => ({
    checkouts: repos.map((r) =>
      r.name === FAIL_REPO
        ? { ...r, path: null, repoCloneDir: null, sha: null, error: 'boom' }
        : { ...r, path: `/wt/default-${r.name}`, repoCloneDir: '/c', sha: `sha-${r.name}`, error: null },
    ),
    cleanup: async () => {},
  }),
  cleanupCloneCache: () => void (cacheEvictions.n += 1),
  // The branch check's own target checkouts (the review loop).
  prepHeadWorktree: async (owner: string, name: string) => ({ repoCloneDir: '/c', worktreePath: `/wt/head-${owner}-${name}` }),
  localBranchDiff: async () => 'diff --git a/src/b.ts b/src/b.ts\n+y',
  removeWorktreeLocked: async () => {},
}));
const cacheEvictions = vi.hoisted(() => ({ n: 0 }));
interface AgentCall {
  worktrees: string[];
  prompt: string;
  membersMd: string;
}
const calls: AgentCall[] = [];
let payload: unknown = null;
vi.mock('./agent.js', () => ({
  runTicketReviewAgent: async (a: { worktrees: string[]; prompt: string; cwd: string }) => {
    calls.push({ worktrees: [...a.worktrees], prompt: a.prompt, membersMd: readFileSync(join(a.cwd, 'MEMBERS.md'), 'utf8') });
    return { submitted: true, payload, aborted: false, costUsd: 0, inputTokens: 1, outputTokens: 1, numTurns: 1, model: 'm' };
  },
}));
vi.mock('../claude-review/manager.js', () => ({
  AGENTIC_AI_ENABLED: true,
  REVIEW_APPLY_AUTH_ENV: false,
  registerReviewSlotPeer: () => {},
  reviewSlotFree: () => true,
  reviewLaneWaiting: () => ({ manual: false, auto: false }),
  pumpReviewLane: () => {},
}));
vi.mock('./prepare.js', async (orig) => ({
  ...(await orig<typeof import('./prepare.js')>()),
  fetchMemberDiffs: async (ms: Array<{ prId: number }>) =>
    new Map(ms.map((m) => [m.prId, { diff: 'diff --git a/src/a.ts b/src/a.ts\n+x', changedFiles: ['src/a.ts'], noiseFiles: [] }])),
  refreshTicketCommentsForRun: async () => false,
}));
vi.mock('../diagrams/trigger.js', () => ({ maybeDrawStoryDiagramAfterTicketReview: async () => {} }));

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let ctx: AgentContext;
let ws = 0;
const repo: Record<string, number> = {};
const pr: Record<string, number> = {};
const IDENT = 'jira:https://acme.atlassian.net/rest/api/3#PAY-1';
const story = { title: 'Pay', description: 'd', acceptanceCriteria: '- CSV\n- PDF\n- Mail', source: 'jira' as const, key: 'PAY-1' };

async function addRepo(name: string): Promise<number> {
  const [r] = await db.insert(schema.repos).values({ accountId: 1, owner: 'acme', name, githubNodeId: `R_${name}`, defaultBranch: 'main' }).returning().execute();
  await db.insert(schema.workspaceRepos).values({ accountId: 1, workspaceId: ws, repoId: r.id }).execute();
  repo[name] = r.id;
  return r.id;
}

async function addPr(tag: string, repoName: string, number: number, branch: string, head: string): Promise<number> {
  const [p] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: `PR_${tag}`,
      accountId: 1,
      repoId: repo[repoName]!,
      number,
      title: tag,
      state: 'open',
      isDraft: false,
      headSha: head,
      headRefName: branch,
      openedAt: new Date(),
      updatedAt: new Date(),
    })
    .returning()
    .execute();
  pr[tag] = p.id;
  return p.id;
}

async function runToEnd(): Promise<number> {
  const m = await import('./manager.js');
  const started = await m.startTicketReview(ctx, {
    accountId: 1,
    workspaceId: ws,
    ident: IDENT,
    ticketKey: 'PAY-1',
    ticketTitle: 'Pay',
    originPrId: pr.api!,
    trigger: 'manual',
  });
  if (started.outcome !== 'queued') throw new Error(`not queued: ${started.outcome}`);
  const runId = started.runId;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('run did not finish')), 20_000);
    const off = m.subscribeTicketReviewStream(runId, (e: TicketReviewStreamEvent) => {
      if (e.type !== 'done') return;
      clearTimeout(t);
      off();
      resolve();
    });
  });
  return runId;
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  ctx = {
    db,
    schema,
    runTransaction: client.runTransaction,
    recordAiUsage: async () => {},
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as any as AgentContext;
  await db.insert(schema.accounts).values({ id: 1, githubUserId: 'U_me', githubLogin: 'me', isLocal: true }).onConflictDoNothing().execute();
  const [w] = await db.insert(schema.workspaces).values({ accountId: 1, name: 'Team', isDefault: false }).returning().execute();
  ws = w.id;
  // The member's repository, a related one, and 13 more: 14 outside repositories for a cap of 12.
  await addRepo('api');
  await addRepo('web');
  for (let i = 1; i <= 13; i += 1) await addRepo(`r${String(i).padStart(2, '0')}`);
  for (const [a, b] of [
    [repo.api!, repo.web!],
    [repo.web!, repo.api!],
  ]) {
    await db.insert(schema.repoRelations).values({ accountId: 1, workspaceId: ws, repoId: a, relatedRepoId: b }).execute();
  }
  await addPr('api', 'api', 1, 'pay-1', 'h_api');
  // In the related repository: one on the member's branch (unlinked), one on another branch.
  await addPr('webSame', 'web', 2, 'pay-1', 'h_web2');
  await addPr('webOther', 'web', 3, 'other', 'h_web3');
  // A FORK's PR on the same branch name (newer: rule 1 would pick it) and one from web's default branch.
  await addPr('webFork', 'web', 4, 'pay-1', 'h_web4');
  await db.update(schema.pullRequests).set({ isCrossRepository: true }).where((await import('drizzle-orm')).eq(schema.pullRequests.id, pr.webFork!)).execute();
  await addPr('webMain', 'web', 6, 'main', 'h_web6');
  const { _overrideTicketSourceForTest } = await import('../../tracker/ticket-source.js');
  _overrideTicketSourceForTest({
    ticketMembers: async () => [{ prId: pr.api!, workspaceId: ws }],
    ticketStory: async () => story,
    ticketComments: async () => [],
    refreshComments: async () => ({ fresh: false }),
  });
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('outsideRepoSet (pure)', () => {
  it('orders related first, then by name, skips members, caps and names the rest', async () => {
    const { outsideRepoSet } = await import('./outside.js');
    const ws2 = [
      { repoId: 1, fullName: 'acme/api' },
      { repoId: 2, fullName: 'acme/Zed' },
      { repoId: 3, fullName: 'acme/beta' },
      { repoId: 4, fullName: 'acme/alpha' },
      { repoId: 5, fullName: 'acme/gamma' },
    ];
    expect(outsideRepoSet({ memberRepoIds: [1], workspaceRepos: ws2, declaredRepoIds: [5, 2], max: 3 })).toEqual({
      ids: [5, 2, 4],
      leftOut: ['acme/beta'],
    });
    expect(outsideRepoSet({ memberRepoIds: [1, 2, 3, 4, 5], workspaceRepos: ws2, declaredRepoIds: [] })).toEqual({ ids: [], leftOut: [] });
  });
});

describe('a story check run with code outside the ticket', () => {
  it('plans the related repository first, the cap, and the unlinked same-branch PR', async () => {
    const { planOutside } = await import('./outside.js');
    const plan = await planOutside(ctx, 1, ws, [{ prId: pr.api!, repoId: repo.api!, open: true, ref: 'PR1' }]);
    expect(plan.repos).toHaveLength(STORY_CHECK_OUTSIDE_REPOS_MAX);
    expect(plan.repos.map((r) => r.name).slice(0, 3)).toEqual(['web', 'r01', 'r02']);
    expect(plan.repos.some((r) => r.name === 'api')).toBe(false);
    expect(plan.leftOut).toEqual(['acme/r12', 'acme/r13']);
    expect(plan.unlinked).toEqual([
      { prId: pr.webSame, repoId: repo.web, owner: 'acme', name: 'web', number: 2, headSha: 'h_web2', sameBranchAs: 'PR1' },
    ]);
    // ⚠ The FORK (#4, newer) is never "the same branch"; nor is any PR when the branch is a default branch.
    expect(plan.unlinked.map((u) => u.number)).toEqual([2]);
    const onMain = await planOutside(ctx, 1, ws, [{ prId: null, repoId: repo.api!, open: true, branch: 'main', ref: 'PR1' }]);
    expect(onMain.unlinked).toEqual([]);
    // Another workspace's id, or another account, never reads this one's repositories.
    expect((await planOutside(ctx, 1, ws + 999, [{ prId: pr.api!, repoId: repo.api!, open: true, ref: 'PR1' }])).repos).toEqual([]);
    expect(await planOutside(ctx, 2, ws, [{ prId: pr.api!, repoId: repo.api!, open: true, ref: 'PR1' }])).toEqual({ repos: [], unlinked: [], leftOut: [] });
  });

  it('reads the right roots, labels them, and stores the run (fingerprint: members only)', async () => {
    // X1 = web, X2..X12 = r01..r11, X13 = web#2 (unlinked).
    payload = {
      alignment: 'partly_aligned',
      summary: 'Most of it is already in X1.',
      criteria: [
        { text: 'CSV', status: 'met', explanation: 'In X1.', metOutsideTicket: 'X1' },
        { text: 'PDF', status: 'met', explanation: 'x', metOutsideTicket: 'X13' },
        { text: 'Mail', status: 'not_met', explanation: 'x', expectedIn: { repo: 'acme/r01' } },
      ],
      missing: [{ title: 'Docs page', explanation: 'x', expectedIn: { repo: 'acme/r02' } }],
      notRequested: [],
      cards: [],
    };
    const runId = await runToEnd();
    const call = calls.at(-1)!;
    expect(call.worktrees).toContain(`/wt/pr-api-1`);
    expect(call.worktrees).toContain('/wt/default-web');
    expect(call.worktrees).toContain('/wt/default-r01');
    expect(call.worktrees).toContain('/wt/pr-web-2');
    expect(call.worktrees.some((p) => p.includes(FAIL_REPO) || p.includes('r12') || p.includes('r13'))).toBe(false);
    expect(call.worktrees).toHaveLength(1 + STORY_CHECK_OUTSIDE_REPOS_MAX - 1 + 1);
    expect(call.prompt).toContain('# Outside the ticket (13)');
    expect(call.prompt).toContain('X13: acme/web #2 (open, same branch as PR1, not linked to the ticket)');
    expect(call.membersMd).toContain('## X1: acme/web (no PR on this ticket)');
    expect(call.membersMd).toContain('## X13: acme/web #2 (same branch, not linked to the ticket)');
    expect(call.membersMd).toContain('Not read (past the limit of repositories): acme/r12, acme/r13');

    const persist = await import('./persist.js');
    const fp = await import('./fingerprint.js');
    const r = (await persist.getTicketReviewById(ctx, 1, runId))!;
    expect(r.status).toBe('succeeded');
    const a = r.assessment!;
    expect(a.criteria.map((c) => [c.status, c.outside?.repo ?? null, c.outside?.number ?? null])).toEqual([
      ['met', 'acme/web', null],
      ['met', 'acme/web', 2],
      ['not_met', null, null],
    ]);
    expect(a.summary).toBe('Most of it is already in acme/web.');
    expect(a.outside?.leftOut).toEqual(['acme/r12', 'acme/r13']);
    expect(a.outside?.sources.find((x) => x.repo === `acme/${FAIL_REPO}`)?.read).toBe(false);
    expect(r.items.map((i) => [i.ref, i.ownerPrId, i.noPrIn ?? null])).toEqual([
      ['AC3', null, 'acme/r01'],
      ['M1', null, 'acme/r02'],
    ]);
    // ⚠ Context, not inputs: the stored fingerprint is the members' alone.
    const live = await fp.readLiveMembers(ctx, 1, [pr.api!]);
    const row = (await db.select().from(schema.ticketReviews).where((await import('drizzle-orm')).eq(schema.ticketReviews.id, runId)).execute())[0];
    expect(row.fingerprint).toBe(fp.fingerprint(fp.ticketHash(story), live));
  });

  it('the switch off ⇒ the members only', async () => {
    const { setWorkspaceAutoReview } = await import('../claude-review/auto-settings.js');
    const after = await setWorkspaceAutoReview(ctx, 1, ws, { storyCheckAllRepos: false });
    expect(after?.storyCheckAllRepos).toBe(false);
    const runId = await runToEnd();
    const call = calls.at(-1)!;
    expect(call.worktrees).toEqual(['/wt/pr-api-1']);
    expect(call.prompt).not.toContain('Outside the ticket');
    expect(call.membersMd).not.toContain('Outside the ticket');
    const r = (await (await import('./persist.js')).getTicketReviewById(ctx, 1, runId))!;
    expect(r.assessment?.outside).toBeUndefined();
    // The switch is in the fingerprint (OFF adds a part); outside SHAs never are.
    const fp = await import('./fingerprint.js');
    const live = await fp.readLiveMembers(ctx, 1, [pr.api!]);
    const row = (await db.select().from(schema.ticketReviews).where((await import('drizzle-orm')).eq(schema.ticketReviews.id, runId)).execute())[0];
    expect(row.fingerprint).toBe(fp.fingerprint(fp.ticketHash(story), live, { outsideOff: true }));
    expect(row.fingerprint).not.toBe(fp.fingerprint(fp.ticketHash(story), live));
    // The X refs it was never given cannot carry a met.
    expect(r.assessment?.criteria.slice(0, 2).map((c) => c.status)).toEqual(['unclear', 'unclear']);
    // Back on: NULL is not written back, a stored true reads on.
    expect((await setWorkspaceAutoReview(ctx, 1, ws, { storyCheckAllRepos: true }))?.storyCheckAllRepos).toBe(true);
  });
});

describe('the branch story check (the review loops)', () => {
  it('⚠ never reads the ticket\'s own PRs as outside, treats its own branch as itself, and evicts the clone cache', async () => {
    const { setWorkspaceAutoReview } = await import('../claude-review/auto-settings.js');
    await setWorkspaceAutoReview(ctx, 1, ws, { storyCheckAllRepos: true });
    const { _resetOutsideBackoffForTest } = await import('./outside.js');
    _resetOutsideBackoffForTest();
    payload = { alignment: 'aligned', summary: 's', criteria: [{ text: 'CSV', status: 'met', explanation: 'x', deliveredBy: ['PR1'] }] };
    const before = cacheEvictions.n;
    const { runBranchStoryCheck } = await import('../../coding/review-loop/story-check.js');
    // The loop builds web on PAY-1's branch; the ticket's own PR is api#1 (also on pay-1, in a related repo).
    const res = await runBranchStoryCheck(ctx, {
      accountId: 1,
      workspaceId: ws,
      ident: IDENT,
      ticket: story,
      targets: [
        { ref: 'PR1', id: 900, repoId: repo.web!, repo: 'acme/web', owner: 'acme', name: 'web', branch: 'pay-1', head: { localRef: 'refs/pierre/local/x', sha: 'f'.repeat(40) }, baseSha: 'b'.repeat(40), title: null },
      ],
      prior: null,
      claims: [],
      provider: 'claude',
      abort: new AbortController(),
      feature: 'story_loop_check',
    });
    expect(res.status).toBe('succeeded');
    const call = calls.at(-1)!;
    // api is the ticket's repository (api#1): never "no PR on this ticket", api#1 never "not linked".
    expect(call.prompt).not.toContain('acme/api, default branch');
    expect(call.prompt).not.toMatch(/acme\/api #1 \(open, same branch/);
    expect(call.membersMd).not.toContain('acme/api (no PR on this ticket)');
    // web#2 is on the TARGET's own branch in the target's repository: the target itself, not "not linked".
    expect(call.prompt).not.toContain('acme/web #2');
    // The other repositories are still read.
    expect(call.prompt).toContain('X1: acme/r01, default branch');
    expect(call.worktrees).toContain('/wt/head-acme-web');
    await new Promise((r) => setImmediate(r));
    expect(cacheEvictions.n).toBeGreaterThan(before);
  });
});
