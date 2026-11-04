// WITHDRAWING LIMN'S OWN AUTOMATIC APPROVAL, over the REAL core client and a FAKE GitHub. Pinned:
//
//   1. A later run at a NEW head that does not approve dismisses Limn's own automatic approval FIRST
//      (COMMENT and REQUEST_CHANGES alike), then posts; the REQUEST_CHANGES goes out.
//   2. A hand approval, or one posted with the Post button (no auto_post record), is never touched.
//   3. THE CLAIM: the push path and the run path never both dismiss; a refusal (403) is recorded in
//      GitHub's words and never retried.
//   4. The push path runs only when the head moved, auto review + auto-posting are on and the
//      workspace switch (ON by default) is on; never on the reader's own PR.
//
//   pnpm --filter @pierre-review/backend test claude-review/approval-withdraw
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeFindingSeverity } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-claude-approval-withdraw.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let ctx: AgentContext;
let ap: typeof import('./auto-post.js');
let aw: typeof import('./approval-withdraw.js');
let persist: typeof import('./persist.js');
let settings: typeof import('./auto-settings.js');
let wsId = 0;
let repoId = 0;
const users: Record<string, number> = {};
let prSeq = 0;

const H1 = 'aaaaaaa1111111111111111111111111111111111';
const H2 = '91482c8222222222222222222222222222222222';

const postReview = vi.fn();
const settle = vi.fn(async () => ({ visible: true }));
const dismissReview = vi.fn(async (..._a: unknown[]): Promise<{ ok: true } | { ok: false; message: string }> => ({ ok: true }));
let liveHead = H1;
let liveReviewList: Array<{ id?: string; login: string | null; state: string }> = [];
const liveReviews = vi.fn(async () => liveReviewList);
const deps = () => ({
  ...ap.defaultAutoPostDeps,
  livePr: vi.fn(async () => ({ headSha: liveHead, state: 'open' as const, draft: false, merged: false })),
  liveReviews,
  settle,
  dismissReview,
  impactLevel: vi.fn(async () => 'low' as const),
});
const pushDeps = () => ({
  accountLogin: async () => 'me',
  accountUserId: async () => users.me!,
  liveReviews,
  dismissReview,
  settle,
});

async function makePr(author = 'alice'): Promise<number> {
  prSeq += 1;
  const [p] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: `PR_${prSeq}`,
      accountId: 1,
      repoId,
      number: prSeq,
      title: `pr ${prSeq}`,
      state: 'open',
      isDraft: false,
      headSha: H1,
      authorId: users[author],
      openedAt: new Date(),
      updatedAt: new Date(),
    })
    .returning()
    .execute();
  return p.id;
}

async function run(
  prId: number,
  headSha: string,
  findings: Array<{ severity: ClaudeFindingSeverity; title: string }>,
  verdict: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES',
  trigger: 'auto' | 'manual' = 'auto',
): Promise<number> {
  const id = await persist.insertQueuedReview(ctx, prId, headSha, 'claude-opus-5-5' as any, 1, [], trigger);
  await persist.saveReviewSuccess(ctx, id, {
    scope: 'diff_only',
    summary: 'A summary.',
    verdict,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    numTurns: 1,
    excludedFiles: [],
    findings: findings.map((f, i) => ({
      path: 'src/a.ts',
      line: 10 + i,
      side: 'RIGHT' as const,
      severity: f.severity,
      title: f.title,
      body: `${f.title} — body`,
      suggestion: null,
      diffHunk: null,
      anchored: true,
      fileInDiff: true,
      priorFindingId: null,
    })),
  });
  return id;
}

const rec = async (id: number) =>
  (await db.select().from(schema.claudeReviews).where((await import('drizzle-orm')).eq(schema.claudeReviews.id, id)).execute())[0].autoPost;

/** Run A: a clean run at H1 on alice's PR, auto-posted as APPROVE (GitHub review 'R1'). */
async function approvedPr(author = 'alice'): Promise<{ pr: number; a: number }> {
  const pr = await makePr(author);
  liveHead = H1;
  liveReviewList = [];
  const a = await run(pr, H1, [], 'APPROVE');
  await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: a }, deps());
  expect(await rec(a)).toMatchObject({ githubReviewId: 'R1', verdict: { submitted: 'APPROVE' } });
  postReview.mockClear();
  settle.mockClear();
  liveReviews.mockClear();
  // GitHub: the approval stands; the PR moved to H2.
  liveReviewList = [{ id: 'R1', login: 'me', state: 'APPROVED' }];
  liveHead = H2;
  return { pr, a };
}

beforeAll(async () => {
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  const q = await import('../../db/queries.js');
  await db.insert(schema.accounts).values({ id: 1, githubUserId: 'U_me', githubLogin: 'me', isLocal: true }).onConflictDoNothing().execute();
  await db.update(schema.accounts).set({ githubLogin: 'me' }).execute();
  for (const login of ['me', 'alice']) {
    const [u] = await db.insert(schema.users).values({ githubLogin: login, githubNodeId: `U_${login}`, isBot: false }).returning().execute();
    users[login] = u.id;
  }
  await db.update(schema.accounts).set({ githubUserId: 'U_me' }).execute();
  const [r] = await db.insert(schema.repos).values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_api' }).returning().execute();
  repoId = r.id;
  wsId = await q.ensureDefaultWorkspace(1);
  await q.ensureRepoMemberships(1);
  ap = await import('./auto-post.js');
  aw = await import('./approval-withdraw.js');
  persist = await import('./persist.js');
  settings = await import('./auto-settings.js');
  ctx = {
    db,
    schema,
    runTransaction: client.runTransaction,
    recordAiUsage: async () => {},
    accountIdOf: () => 1,
    review: { postReview, postFinding: vi.fn() },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as any as AgentContext;
});

afterAll(async () => {
  await closeDb?.();
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
});

beforeEach(async () => {
  postReview.mockReset();
  postReview.mockImplementation(async (a: any) => ({
    postedReviewId: 'R1',
    inlineFindingIds: a.includedFindings.map((f: any) => f.id),
    prComments: [],
    commentCount: a.includedFindings.length,
    prCommentCount: 0,
  }));
  settle.mockClear();
  dismissReview.mockReset();
  dismissReview.mockImplementation(async () => ({ ok: true }));
  liveReviews.mockClear();
  await settings.setWorkspaceAutoReview(ctx, 1, wsId, {
    enabled: true,
    withdrawApprovalOnPush: true,
    autoPost: { enabled: true, scope: 'all', autoVerdict: true },
  });
});

describe('the pure pieces', () => {
  it('the messages count by severity and name the short head', () => {
    expect(aw.withdrawMessageForRun({ blockers: 0, warnings: 3 }, H2)).toBe('Limn withdrew its approval: 3 warnings found at 91482c8.');
    expect(aw.withdrawMessageForRun({ blockers: 1, warnings: 1 }, H2)).toBe(
      'Limn withdrew its approval: 1 blocker and 1 warning found at 91482c8.',
    );
    expect(aw.withdrawMessageForRun({ blockers: 0, warnings: 0 }, H2)).toBe('Limn withdrew its approval: not approved at 91482c8.');
    expect(aw.withdrawMessageForPush(H2)).toBe('Limn withdrew its approval: new commits since it approved (91482c8).');
  });

  it("the standing review is Limn's only by a stored id; the gate lets a request for changes out over it", () => {
    const list = [{ id: 'R1', login: 'me', state: 'APPROVED' }];
    expect(ap.ownStandingReview(list, 'me', new Set(), new Set(['R1']))).toEqual({ state: 'LIMN_AUTO_APPROVED', reviewId: 'R1' });
    expect(ap.ownStandingReview(list, 'me', new Set(), new Set(['R9']))).toEqual({ state: 'APPROVED', reviewId: 'R1' });
    expect(ap.verdictGate('REQUEST_CHANGES', { authorIsMe: false, ownLatest: 'LIMN_AUTO_APPROVED' })).toEqual({
      wanted: 'REQUEST_CHANGES',
      submitted: 'REQUEST_CHANGES',
      heldReason: null,
    });
    expect(ap.verdictGate('REQUEST_CHANGES', { authorIsMe: false, ownLatest: 'APPROVED' }).heldReason).toBe('prior_review');
  });
});

describe('a later run withdraws it', () => {
  it('COMMENT run with warnings at a new head: dismissed FIRST, then posted; recorded on both runs', async () => {
    const { pr, a } = await approvedPr();
    const b = await run(
      pr,
      H2,
      [
        { severity: 'warning', title: 'W1' },
        { severity: 'warning', title: 'W2' },
        { severity: 'warning', title: 'W3' },
      ],
      'COMMENT',
    );
    postReview.mockImplementation(async (x: any) => ({
      postedReviewId: 'R2',
      inlineFindingIds: x.includedFindings.map((f: any) => f.id),
      prComments: [],
      commentCount: x.includedFindings.length,
      prCommentCount: 0,
    }));
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: b }, deps());
    expect(dismissReview).toHaveBeenCalledTimes(1);
    expect(dismissReview.mock.calls[0]!.slice(1)).toEqual([
      'acme',
      'api',
      expect.any(Number),
      'R1',
      'Limn withdrew its approval: 3 warnings found at 91482c8.',
    ]);
    expect(postReview).toHaveBeenCalledTimes(1);
    expect(dismissReview.mock.invocationCallOrder[0]!).toBeLessThan(postReview.mock.invocationCallOrder[0]!);
    expect(postReview.mock.calls[0]![0].verdict).toBe('COMMENT');
    expect(await rec(b)).toMatchObject({
      status: 'posted',
      withdrewApproval: { reviewId: 'R1', how: 'withdrawn', error: null },
    });
    expect((await rec(a)).approvalWithdrawal).toMatchObject({ status: 'withdrawn', why: 'run', byReviewId: b, headSha: H2 });
    expect(settle).toHaveBeenCalled();
    // The wire carries both.
    expect(persist.autoPostWireOf(await rec(a))?.approvalWithdrawal?.status).toBe('withdrawn');
    expect(persist.autoPostWireOf(await rec(b))?.withdrewApproval?.how).toBe('withdrawn');
  });

  it('REQUEST_CHANGES run: dismissed first, and the request goes out', async () => {
    const { pr } = await approvedPr();
    const b = await run(pr, H2, [{ severity: 'blocker', title: 'Null deref' }], 'REQUEST_CHANGES');
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: b }, deps());
    expect(dismissReview).toHaveBeenCalledTimes(1);
    expect(dismissReview.mock.calls[0]![5]).toBe('Limn withdrew its approval: 1 blocker found at 91482c8.');
    expect(postReview.mock.calls[0]![0].verdict).toBe('REQUEST_CHANGES');
    expect(await rec(b)).toMatchObject({ verdict: { submitted: 'REQUEST_CHANGES', heldReason: null }, withdrewApproval: { how: 'withdrawn' } });
  });

  it('a later run that approves again leaves it (and a run at the same head never withdraws)', async () => {
    const { pr } = await approvedPr();
    const b = await run(pr, H2, [], 'APPROVE');
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: b }, deps());
    expect(dismissReview).not.toHaveBeenCalled();
    expect(postReview.mock.calls[0]![0].verdict).toBe('APPROVE');
    const { pr: pr2 } = await approvedPr();
    liveHead = H1;
    const c = await run(pr2, H1, [{ severity: 'warning', title: 'W' }], 'COMMENT');
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr2, reviewId: c }, deps());
    expect(dismissReview).not.toHaveBeenCalled();
  });

  it('a hand approval, or one posted with the Post button, is never touched', async () => {
    const pr = await makePr();
    // A manual run the reader posted with the Post button: no auto_post record.
    const a = await run(pr, H1, [], 'APPROVE', 'manual');
    expect(await rec(a)).toBeNull();
    liveHead = H2;
    liveReviewList = [{ id: 'R7', login: 'me', state: 'APPROVED' }];
    const b = await run(pr, H2, [{ severity: 'blocker', title: 'Null deref' }], 'REQUEST_CHANGES');
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: b }, deps());
    expect(dismissReview).not.toHaveBeenCalled();
    expect(await rec(b)).toMatchObject({ verdict: { submitted: 'COMMENT', heldReason: 'prior_review' } });
    expect((await rec(b)).withdrewApproval).toBeUndefined();
    // The push path never touches it either.
    expect((await aw.maybeWithdrawApprovalOnPush(ctx, { accountId: 1, prId: pr, headSha: H2 }, pushDeps())).kind).toBe('none');
    expect(dismissReview).not.toHaveBeenCalled();
  });

  it('a 403 is recorded in GitHub’s words on both runs and never retried; the review still posts', async () => {
    const { pr, a } = await approvedPr();
    dismissReview.mockImplementation(async () => ({ ok: false, message: 'Must have admin rights to Repository.' }));
    const b = await run(pr, H2, [{ severity: 'warning', title: 'W' }], 'COMMENT');
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: b }, deps());
    expect(postReview).toHaveBeenCalledTimes(1);
    expect(await rec(b)).toMatchObject({
      status: 'posted',
      withdrewApproval: { how: 'withdraw_failed', error: 'Must have admin rights to Repository.' },
    });
    expect((await rec(a)).approvalWithdrawal).toMatchObject({ status: 'failed', error: 'Must have admin rights to Repository.' });
    // Never again: not by a later run, not by a push.
    const c = await run(pr, '3333333333333333333333333333333333333333', [{ severity: 'warning', title: 'W2' }], 'COMMENT');
    liveHead = '3333333333333333333333333333333333333333';
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: c }, deps());
    await aw.maybeWithdrawApprovalOnPush(ctx, { accountId: 1, prId: pr, headSha: '4444444444444444444444444444444444444444' }, pushDeps());
    expect(dismissReview).toHaveBeenCalledTimes(1);
  });

  it('a withdrawal that was the only write: no review is sent, and the record says posted', async () => {
    const { pr } = await approvedPr();
    // Every finding already on GitHub (none here) and auto verdict off: nothing but the withdrawal.
    await settings.setWorkspaceAutoReview(ctx, 1, wsId, { autoPost: { autoVerdict: false } });
    const b = await run(pr, H2, [], 'COMMENT');
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: b }, deps());
    expect(postReview).not.toHaveBeenCalled();
    expect(dismissReview).toHaveBeenCalledTimes(1);
    expect(dismissReview.mock.calls[0]![5]).toBe('Limn withdrew its approval: not approved at 91482c8.');
    expect(await rec(b)).toMatchObject({ status: 'posted', error: null, withdrewApproval: { how: 'withdrawn' } });
  });
});

describe('the claim', () => {
  it('push first, then the run: one dismissal', async () => {
    const { pr, a } = await approvedPr();
    const out = await aw.maybeWithdrawApprovalOnPush(ctx, { accountId: 1, prId: pr, headSha: H2 }, pushDeps());
    expect(out).toMatchObject({ kind: 'done', record: { status: 'withdrawn', why: 'push' } });
    expect(dismissReview.mock.calls[0]![5]).toBe('Limn withdrew its approval: new commits since it approved (91482c8).');
    expect((await rec(a)).approvalWithdrawal).toMatchObject({ status: 'withdrawn', why: 'push' });
    expect(settle).toHaveBeenCalledTimes(1);
    // GitHub still shows it (a stale read): the run must not dismiss it again.
    const b = await run(pr, H2, [{ severity: 'warning', title: 'W' }], 'COMMENT');
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: b }, deps());
    expect(dismissReview).toHaveBeenCalledTimes(1);
    expect(postReview).toHaveBeenCalledTimes(1);
    expect((await rec(b)).withdrewApproval).toBeUndefined();
  });

  it('the run first, then the push: one dismissal; and the claim itself holds once', async () => {
    const { pr, a } = await approvedPr();
    const b = await run(pr, H2, [{ severity: 'warning', title: 'W' }], 'COMMENT');
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: b }, deps());
    expect(dismissReview).toHaveBeenCalledTimes(1);
    expect((await aw.maybeWithdrawApprovalOnPush(ctx, { accountId: 1, prId: pr, headSha: H2 }, pushDeps())).kind).toBe('none');
    expect(dismissReview).toHaveBeenCalledTimes(1);
    expect(await aw.claimApprovalWithdrawal(ctx, 1, a, { why: 'push', headSha: H2, message: 'x' })).toBe(false);
  });
});

describe('the push path', () => {
  it('skipped when the head did not move', async () => {
    const { pr } = await approvedPr();
    expect((await aw.maybeWithdrawApprovalOnPush(ctx, { accountId: 1, prId: pr, headSha: H1 }, pushDeps())).kind).toBe('none');
    expect(liveReviews).not.toHaveBeenCalled();
    expect(dismissReview).not.toHaveBeenCalled();
  });

  it('skipped when auto review is off, or auto-posting is off', async () => {
    const { pr } = await approvedPr();
    await settings.setWorkspaceAutoReview(ctx, 1, wsId, { enabled: false });
    expect((await aw.maybeWithdrawApprovalOnPush(ctx, { accountId: 1, prId: pr, headSha: H2 }, pushDeps())).kind).toBe('off');
    await settings.setWorkspaceAutoReview(ctx, 1, wsId, { enabled: true, autoPost: { enabled: false } });
    expect((await aw.maybeWithdrawApprovalOnPush(ctx, { accountId: 1, prId: pr, headSha: H2 }, pushDeps())).kind).toBe('off');
    expect(dismissReview).not.toHaveBeenCalled();
  });

  it('the setting: ON by default; off skips the push path (a later run still withdraws)', async () => {
    const fresh = settings.autoReviewOf(null);
    expect(fresh.withdrawApprovalOnPush).toBe(true);
    const { pr } = await approvedPr();
    const off = await settings.setWorkspaceAutoReview(ctx, 1, wsId, { withdrawApprovalOnPush: false });
    expect(off?.withdrawApprovalOnPush).toBe(false);
    expect((await settings.readWorkspaceAutoReview(ctx, 1, wsId))?.withdrawApprovalOnPush).toBe(false);
    expect((await aw.maybeWithdrawApprovalOnPush(ctx, { accountId: 1, prId: pr, headSha: H2 }, pushDeps())).kind).toBe('off');
    expect(dismissReview).not.toHaveBeenCalled();
    const b = await run(pr, H2, [{ severity: 'warning', title: 'W' }], 'COMMENT');
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: b }, deps());
    expect(dismissReview).toHaveBeenCalledTimes(1);
    const on = await settings.setWorkspaceAutoReview(ctx, 1, wsId, { withdrawApprovalOnPush: true });
    expect(on?.withdrawApprovalOnPush).toBe(true);
  });

  it('skipped when the approval no longer stands live (a later review of the reader, or dismissed)', async () => {
    const { pr } = await approvedPr();
    liveReviewList = [
      { id: 'R1', login: 'me', state: 'APPROVED' },
      { id: 'R5', login: 'me', state: 'CHANGES_REQUESTED' },
    ];
    expect((await aw.maybeWithdrawApprovalOnPush(ctx, { accountId: 1, prId: pr, headSha: H2 }, pushDeps())).kind).toBe('not_standing');
    liveReviewList = [{ id: 'R1', login: 'me', state: 'DISMISSED' }];
    expect((await aw.maybeWithdrawApprovalOnPush(ctx, { accountId: 1, prId: pr, headSha: H2 }, pushDeps())).kind).toBe('not_standing');
    expect(dismissReview).not.toHaveBeenCalled();
  });

  it("never on the reader's own PR", async () => {
    const pr = await makePr('me');
    // Seed an approval record by hand (GitHub would refuse one on your own PR).
    const a = await run(pr, H1, [], 'APPROVE');
    const { eq } = await import('drizzle-orm');
    await db
      .update(schema.claudeReviews)
      .set({
        autoPost: {
          status: 'posted',
          at: new Date().toISOString(),
          reason: null,
          error: null,
          findingIds: [],
          postedFindingIds: [],
          githubReviewId: 'R1',
          verdict: { wanted: 'APPROVE', submitted: 'APPROVE', heldReason: null },
        },
      })
      .where(eq(schema.claudeReviews.id, a))
      .execute();
    liveReviewList = [{ id: 'R1', login: 'me', state: 'APPROVED' }];
    expect((await aw.maybeWithdrawApprovalOnPush(ctx, { accountId: 1, prId: pr, headSha: H2 }, pushDeps())).kind).toBe('none');
    expect(dismissReview).not.toHaveBeenCalled();
  });
});
