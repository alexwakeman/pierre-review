// THE REPLIES PASS — end to end over the REAL core client and migrations, with a scripted fake agent
// and a FAKE GitHub (nothing reaches GitHub or a model). What is pinned:
//
//   1. WHAT IT JUDGES: only a person's reply newer than the finding's latest judgement (a bot's
//      reply never; Limn's own marked reply is context); nothing to judge ⇒ refused, no row.
//   2. THE GATE IS THE REVIEW'S (`judgeReplyReport`): a deferred BLOCKER is disputed with the
//      templated pushback; a not-valid explanation is accepted.
//   3. STORED AS A RUN ROW (`kind = 'replies'`) whose follow-up items every reader takes as a review's:
//      settled-by-reply, the Open PRs "Earlier:" counts (folded over the latest FULL review), the
//      history; while the tab's latest review, My Turn and the per-head rules read full reviews only.
//   4. ⚠ THE CHAIN ANCHORS ON THE LATEST FULL REVIEW: a full review after a pass follows up the full
//      review's findings (not the pass's), and the accepted one is settled.
//   5. ⚠ NEVER BESIDE A FULL REVIEW in flight (refused), never on a closed PR.
//   6. A MANUAL pass never writes to GitHub; its row's verdict says what the outcome WOULD be.
//   7. AN AUTO pass re-checks the outcome BOTH WAYS through the auto-post gates: APPROVE once the last
//      warning is settled, REQUEST_CHANGES for a disputed blocker (plus its ONE pushback); a person's
//      standing review holds it; the record is claimed ONCE (a second call writes nothing).
//
//   pnpm --filter @pierre-review/backend test replies-check-pipeline
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentContext } from '../agent-context.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-claude-review-replies-check.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
delete process.env.LIMN_AI_DISABLED;

// ---- the fake agent: records each call, answers from `script` ----
const agentCalls: any[] = [];
let script: (args: any) => any = () => ({ replies: [] });
vi.mock('./replies-check-agent.js', () => ({
  runRepliesCheckAgent: async (args: any) => {
    agentCalls.push(args);
    return {
      submitted: true,
      ranOn: { provider: args.provider, model: args.provider === 'codex' ? 'gpt-6.1-terra' : 'claude-sonnet-5', effort: 'medium' },
      replies: script(args).replies,
      aborted: false,
      costUsd: null,
      inputTokens: 10,
      outputTokens: 5,
      numTurns: 1,
    };
  },
}));
// No git clone in a test: the pass then runs without a checkout (the code comes from the finding).
vi.mock('../ticket-review/prepare.js', async (orig) => ({
  ...(await orig<typeof import('../ticket-review/prepare.js')>()),
  prepareMemberWorktrees: async () => {
    throw new Error('no clone in tests');
  },
}));
vi.mock('./ai-ready.js', () => ({ agenticRunReady: () => true }));

const HEAD = 'a'.repeat(40);
const PATH = 'src/mail.ts';
const DIFF = [`diff --git a/${PATH} b/${PATH}`, `--- a/${PATH}`, `+++ b/${PATH}`, '@@ -0,0 +1,4 @@', '+a', '+b', '+c', '+d'].join('\n');
const HOUR = 3600_000;
const LATER = Date.now() + HOUR; // replies land after the review ran
const DEFER = 'Will fix in a follow-up PR.';
const EXPLAIN = 'Intentional: sendMail is only called with validated input from the form layer.';
const BOT = 'Coverage went down by 0.1%.';
const MARK = '\n\n<!-- pierre:claude-review-finding v=1 -->';

let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let ctx: AgentContext;
let persist: typeof import('./persist.js');
let rc: typeof import('./replies-check.js');
let manager: typeof import('./manager.js');
let settings: typeof import('./auto-settings.js');
let wsId = 0;
let repoId = 0;
const users: Record<string, number> = {};
let node = 1;
let prSeq = 0;
let fullReviewGate: Promise<void> | null = null;
let lastFullPrompt = '';

const postReview = vi.fn();
const replyCalls: Array<{ threadNodeId: string; body: string }> = [];
let liveReviewList: Array<{ id?: number; login: string | null; state: string }> = [];
const postDeps = () => ({
  livePr: async () => ({ headSha: HEAD, state: 'open' as const, draft: false, merged: false }),
  settle: async () => ({ visible: true }),
  isAutomation: async (_a: number, _w: number, userId: number | null) => userId === users['codecov[bot]'],
  accountUserId: async () => users.me!,
  accountLogin: async () => 'me',
  liveReviews: async () => liveReviewList,
  dismissReview: async () => ({ ok: true as const }),
  impactLevel: async () => 'low' as const,
});
const resolveDeps = {
  reply: async (_a: number, threadNodeId: string, body: string) => {
    replyCalls.push({ threadNodeId, body });
    return { commentId: `C${replyCalls.length}` };
  },
  resolve: async () => {},
  stamp: async () => {},
  notePrChanged: async () => {},
};

const finding = (title: string, severity: 'blocker' | 'warning' | 'nit' = 'warning', line = 2) => ({
  path: PATH, line, side: 'RIGHT' as const, severity, title, body: `${title}.`,
  suggestion: null, diffHunk: null, anchored: true, fileInDiff: true,
});

async function thread(pr: number, comments: Array<{ authorId: number; at: number; body: string; databaseId?: string }>): Promise<void> {
  const [t] = await db
    .insert(schema.reviewThreads)
    .values({ githubNodeId: `RT_${node++}`, prId: pr, path: PATH, line: 2, isResolved: false, derivedState: 'replied_unresolved', createdAt: new Date(comments[0]!.at) })
    .returning()
    .execute();
  for (const c of comments) {
    await db
      .insert(schema.reviewComments)
      .values({ githubNodeId: `RC_${node++}`, threadId: t.id, prId: pr, authorId: c.authorId, body: c.body, databaseId: c.databaseId ?? null, createdAt: new Date(c.at) })
      .execute();
  }
}

async function makePr(state: 'open' | 'closed' = 'open'): Promise<number> {
  prSeq += 1;
  const [p] = await db
    .insert(schema.pullRequests)
    .values({ githubNodeId: `PR_${prSeq}`, accountId: 1, repoId, number: prSeq, title: `pr ${prSeq}`, state, isDraft: false, openedAt: new Date(), updatedAt: new Date(), headSha: HEAD, authorId: users.alice })
    .returning()
    .execute();
  return p.id;
}

/** A succeeded FULL review at HEAD with these findings, each POSTED inline with its thread + replies. */
async function reviewed(
  pr: number,
  rows: Array<{ title: string; severity: 'blocker' | 'warning' | 'nit'; replies: Array<{ by: string; body: string; at?: number }> }>,
  opts: {
    trigger?: 'auto' | 'manual';
    provider?: 'claude' | 'codex';
    verdict?: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';
    pair?: { role: 'first' } | { role: 'second'; pairId: number };
  } = {},
): Promise<{ reviewId: number; ids: Map<string, number> }> {
  const reviewId = await persist.insertQueuedReview(
    ctx,
    pr,
    HEAD,
    'claude-opus-5-5',
    1,
    [],
    opts.trigger ?? 'auto',
    opts.provider ?? 'claude',
    false,
    opts.pair ?? null,
  );
  await persist.saveReviewSuccess(ctx, reviewId, {
    scope: 'diff_only', summary: 's', verdict: opts.verdict ?? 'COMMENT', costUsd: null, inputTokens: null, outputTokens: null,
    numTurns: 1, excludedFiles: [],
    findings: rows.map((r, i) => finding(r.title, r.severity, 2 + i)),
  });
  const ids = new Map<string, number>((await persist.getClaudeReviewById(ctx, reviewId, 1))!.findings.map((f) => [f.title, f.id] as const));
  for (const r of rows) {
    const id = ids.get(r.title)!;
    const dbId = String(1000 + id);
    await persist.markFindingPosted(ctx, id, dbId);
    await thread(pr, [
      { authorId: users.me!, at: Date.now() - HOUR, body: `${r.title}.${MARK}`, databaseId: dbId },
      ...r.replies.map((x, j) => ({ authorId: users[x.by]!, at: x.at ?? LATER + j * 1000, body: x.body })),
    ]);
  }
  return { reviewId, ids };
}

async function settleFor(prId: number): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (!rc.repliesCheckHeld(1, prId) && !manager.reviewHeldForPr(prId)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('replies check did not finish');
}

const passRows = async (prId: number) =>
  (await persist.listClaudeReviewHistory(ctx, prId, 1)).filter((h) => h.kind === 'replies');

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  const q = await import('../../db/queries.js');
  await db.insert(schema.accounts).values({ id: 1, githubUserId: 'U_me', githubLogin: 'me', isLocal: true }).onConflictDoNothing().execute();
  await db.update(schema.accounts).set({ githubLogin: 'me' }).execute();
  for (const login of ['me', 'alice', 'codecov[bot]']) {
    const [u] = await db.insert(schema.users).values({ githubLogin: login, githubNodeId: `U_${login}`, isBot: login.endsWith('[bot]') }).returning().execute();
    users[login] = u.id;
  }
  const [r] = await db.insert(schema.repos).values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_api' }).returning().execute();
  repoId = r.id;
  wsId = await q.ensureDefaultWorkspace(1);
  await q.ensureRepoMemberships(1);
  ctx = {
    db,
    schema,
    runTransaction: client.runTransaction,
    log: { warn: () => {}, info: () => {}, error: () => {} },
    recordAiUsage: async () => {},
    accountIdOf: () => 1,
    review: {
      postReview,
      prepareReview: async () => ({
        strippedDiff: DIFF, promptDiff: DIFF, changedFiles: [PATH], excludedFiles: [], omittedFiles: [],
        fileMetrics: [{ path: PATH, additions: 4, deletions: 0, isNew: true, apiTouch: false }],
        diffBytes: DIFF.length, diffCapped: false,
      }),
      runReview: async (args: any) => {
        lastFullPrompt = args.prompt;
        if (fullReviewGate) await fullReviewGate;
        return { submitted: true, scope: 'diff_only', summary: 'ok', verdict: 'COMMENT', findings: [], costUsd: null, inputTokens: null, outputTokens: null, numTurns: 1 };
      },
    },
    github: { fetchCompareDiff: async () => ({ ok: false }) },
    queries: {},
  } as any as AgentContext;
  persist = await import('./persist.js');
  manager = await import('./manager.js');
  rc = await import('./replies-check.js');
  settings = await import('./auto-settings.js');
  rc._setRepliesAutoDepsForTest({ post: postDeps() as any, resolve: resolveDeps });
});

afterAll(async () => {
  rc?._setRepliesAutoDepsForTest(null);
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

beforeEach(async () => {
  agentCalls.length = 0;
  replyCalls.length = 0;
  postReview.mockReset();
  postReview.mockImplementation(async () => ({ postedReviewId: '7001', inlineFindingIds: [], prComments: [], commentCount: 0, prCommentCount: 0 }));
  liveReviewList = [];
  await settings.setWorkspaceAutoReview(ctx, 1, wsId, { autoPost: { enabled: false } as any });
});

describe('a manual pass', () => {
  let pr = 0;
  let full = 0;
  let ids = new Map<string, number>();

  beforeAll(async () => {
    pr = await makePr();
    ({ reviewId: full, ids } = await reviewed(pr, [
      { title: 'Drops the error', severity: 'blocker', replies: [{ by: 'alice', body: DEFER }] },
      { title: 'Unchecked input in sendMail', severity: 'warning', replies: [{ by: 'alice', body: EXPLAIN }, { by: 'codecov[bot]', body: BOT }] },
      { title: 'Naming', severity: 'nit', replies: [] },
    ], { trigger: 'manual' }));
  });

  it('plans only the findings with a person’s reply nobody judged', async () => {
    const planned = await rc.planRepliesCheck(ctx, 1, pr);
    expect('refused' in planned).toBe(false);
    if ('refused' in planned) return;
    expect(planned.full.id).toBe(full);
    expect(planned.findings.map((f) => f.title).sort()).toEqual(['Drops the error', 'Unchecked input in sendMail']);
  });

  it('judges through the review’s gate, stores a kind=replies row, and writes nothing to GitHub', async () => {
    script = () => ({
      replies: [
        { ref: 'T1', status: 'reply_accepted', acceptKind: 'deferred', reply: 'Sure, later.', explanation: 'Deferred.' },
        { ref: 'T2', status: 'reply_accepted', acceptKind: 'not_valid', reply: 'Fair, the form validates it.', explanation: 'Validated upstream.' },
      ],
    });
    const started = await rc.startRepliesCheck(ctx, { accountId: 1, prId: pr, trigger: 'manual' });
    expect(started).toMatchObject({ outcome: 'queued', threads: 2 });
    await settleFor(pr);
    expect(agentCalls).toHaveLength(1);
    // The standard depth, on the provider that OWNS the threads (the full review's: Claude).
    expect(agentCalls[0]).toMatchObject({ provider: 'claude', model: 'claude-sonnet-5', worktrees: [] });
    const prompt: string = agentCalls[0].prompt;
    expect(prompt).toContain(DEFER);
    expect(prompt).toContain(EXPLAIN);
    expect(prompt).not.toContain(BOT); // automation never
    expect(prompt).toMatch(/---BEGIN THREAD T1 [0-9a-z]+---/); // nonce-fenced as data

    const rows = await passRows(pr);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'replies', trigger: 'manual', status: 'succeeded' });
    const pass = (await persist.getClaudeReviewById(ctx, rows[0]!.id, 1))!;
    expect(pass.findings).toEqual([]);
    const byTitle = new Map(pass.followUp!.items.map((it) => [it.title, it]));
    // ⚠ The gate: a deferral of a BLOCKER is refused (disputed, templated pushback).
    expect(byTitle.get('Drops the error')).toMatchObject({ status: 'reply_disputed', deferralRefused: true });
    expect(byTitle.get('Unchecked input in sendMail')).toMatchObject({
      status: 'reply_accepted',
      acceptKind: 'not_valid',
      response: 'Fair, the form validates it.',
      reply: { author: 'alice', excerpt: EXPLAIN },
    });
    expect(pass.followUp!.priorReviewId).toBe(full);
    // What the outcome WOULD be: a disputed blocker ⇒ request changes. Shown, never posted.
    expect(pass.verdict).toBe('REQUEST_CHANGES');
    expect(pass.summary).toBe('Replies checked: 1 accepted, 1 still open.');
    expect(pass.autoPost).toBeNull();
    expect(postReview).not.toHaveBeenCalled();
    expect(replyCalls).toEqual([]);
  });

  it('nothing left to judge ⇒ refused with no row; a NEWER reply is judged again', async () => {
    expect(await rc.planRepliesCheck(ctx, 1, pr)).toEqual({ refused: 'nothing_to_check' });
    const r = await rc.startRepliesCheck(ctx, { accountId: 1, prId: pr, trigger: 'manual' });
    expect(r).toEqual({ outcome: 'refused', reason: 'nothing_to_check' });
    expect(await passRows(pr)).toHaveLength(1);
  });

  it('every reader: settled-by-reply sees it; the tab, My Turn and the per-head rules read full reviews', async () => {
    const settled = await persist.loadSettledByReplyFindings(ctx, pr, 1, Number.MAX_SAFE_INTEGER);
    expect(settled.map((f) => f.id)).toEqual([ids.get('Unchecked input in sendMail')]);
    expect((await persist.getLatestClaudeReview(ctx, pr, 1))!.id).toBe(full);
    expect(await persist.getLatestSucceededReviewId(ctx, pr, 1)).toBe(full);
    // Open PRs: the FULL review, with the pass's newer judgements folded over "Earlier:".
    const [state] = await persist.getLatestReviewStates(ctx, [pr], 1);
    expect(state!.reviewId).toBe(full);
    expect(state!.summary!.followUp).toMatchObject({ reply_accepted: 1, reply_disputed: 1 });
    // A pass at the head is not a review of it (one review per head stays the full review's).
    const passId = (await passRows(pr))[0]!.id;
    const cr = schema.claudeReviews;
    const { eq } = await import('drizzle-orm');
    await db.update(cr).set({ headSha: 'f'.repeat(40) }).where(eq(cr.id, passId)).execute();
    expect(await persist.hasReviewAtHead(ctx, pr, 1, 'f'.repeat(40))).toBe(false);
    await db.update(cr).set({ headSha: HEAD }).where(eq(cr.id, passId)).execute();
    const q = await import('../../db/queries.js');
    expect((await q.getUnactionedClaudeReviews(1)).some((c) => c.reviewId === passId)).toBe(false);
  });

  it('⚠ the next FULL review anchors on the full review, not the pass — and the accepted one is settled', async () => {
    const prior = await persist.loadPriorReviewForFollowUp(ctx, pr, 1, Number.MAX_SAFE_INTEGER, new Set([ids.get('Unchecked input in sendMail')!]));
    expect(prior!.reviewId).toBe(full);
    expect(prior!.findings.map((f) => f.title).sort()).toEqual(['Drops the error', 'Naming']);

    const started = await manager.startReview(ctx, 1, pr, 'claude-opus-5-5');
    expect(started.ok).toBe(true);
    await settleFor(pr);
    const latest = (await persist.getLatestClaudeReview(ctx, pr, 1))!;
    expect(latest.kind).toBeUndefined();
    expect(latest.followUp!.priorReviewId).toBe(full);
    expect(latest.followUp!.items.map((it) => it.title).sort()).toEqual(['Drops the error', 'Naming']);
    expect(latest.followUp!.leftOut).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: 'Unchecked input in sendMail', reason: 'settled' })]),
    );
    expect(lastFullPrompt).toContain('Settled in an earlier review');
  });
});

describe('when it does not run', () => {
  it('⚠ never beside a FULL review in flight: refused, no row, no model', async () => {
    const pr = await makePr();
    await reviewed(pr, [{ title: 'Leaks a handle', severity: 'warning', replies: [{ by: 'alice', body: 'Closed in the finally block.' }] }]);
    let release!: () => void;
    fullReviewGate = new Promise((r) => (release = r));
    const started = await manager.startReview(ctx, 1, pr, 'claude-opus-5-5');
    expect(started.ok).toBe(true);
    const r = await rc.startRepliesCheck(ctx, { accountId: 1, prId: pr, trigger: 'manual' });
    expect(r).toEqual({ outcome: 'refused', reason: 'review_in_progress' });
    expect(agentCalls).toHaveLength(0);
    release();
    fullReviewGate = null;
    await settleFor(pr);
    expect(await passRows(pr)).toHaveLength(0);
  });

  it('a closed PR, or one never reviewed', async () => {
    const closed = await makePr('closed');
    await reviewed(closed, [{ title: 'X', severity: 'warning', replies: [{ by: 'alice', body: 'nope' }] }]);
    expect(await rc.startRepliesCheck(ctx, { accountId: 1, prId: closed, trigger: 'manual' })).toEqual({ outcome: 'not_open' });
    const fresh = await makePr();
    expect(await rc.startRepliesCheck(ctx, { accountId: 1, prId: fresh, trigger: 'manual' })).toEqual({
      outcome: 'refused',
      reason: 'no_review',
    });
  });
});

describe('an AUTO pass: the outcome, both ways, through the auto-post gates', () => {
  beforeEach(async () => {
    await settings.setWorkspaceAutoReview(ctx, 1, wsId, { autoPost: { enabled: true, scope: 'all', autoVerdict: true } as any });
  });

  it('UP: the last warning settled ⇒ ONE APPROVE review, claimed once', async () => {
    const pr = await makePr();
    await reviewed(pr, [{ title: 'Unchecked input', severity: 'warning', replies: [{ by: 'alice', body: EXPLAIN }] }]);
    script = () => ({ replies: [{ ref: 'T1', status: 'reply_accepted', acceptKind: 'not_valid', reply: 'Fair.' }] });
    expect((await rc.startRepliesCheck(ctx, { accountId: 1, prId: pr, trigger: 'auto' })).outcome).toBe('queued');
    await settleFor(pr);
    expect(postReview).toHaveBeenCalledTimes(1);
    const sent = postReview.mock.calls[0]![0];
    expect(sent.verdict).toBe('APPROVE');
    expect(sent.includedFindings).toEqual([]);
    expect(sent.body).toMatch(/^Replies checked: the remaining points are settled\.\n\n_Posted automatically by Limn’s Claude review\._$/);
    const passId = (await passRows(pr))[0]!.id;
    const pass = (await persist.getClaudeReviewById(ctx, passId, 1))!;
    expect(pass.trigger).toBe('auto');
    expect(pass.autoPost).toMatchObject({ status: 'posted', verdict: { wanted: 'APPROVE', submitted: 'APPROVE', heldReason: null } });
    // ⚠ THE CLAIM: a second call (a restart, a race) writes nothing.
    const { maybePostRepliesOutcome, computeRepliesOutcome } = await import('./replies-outcome.js');
    const outcome = await computeRepliesOutcome(ctx, 1, pr, pass.followUp!.items);
    expect(outcome.wanted).toBe('APPROVE');
    expect((await maybePostRepliesOutcome(ctx, { accountId: 1, prId: pr, reviewId: passId, outcome }, postDeps() as any)).kind).toBe('already_claimed');
    expect(postReview).toHaveBeenCalledTimes(1);
  });

  it('DOWN: a disputed blocker ⇒ REQUEST_CHANGES naming it, and its ONE pushback', async () => {
    const pr = await makePr();
    await reviewed(pr, [{ title: 'Drops the error', severity: 'blocker', replies: [{ by: 'alice', body: DEFER }] }]);
    script = () => ({ replies: [{ ref: 'T1', status: 'reply_disputed', reply: 'The error is swallowed on line 2; please handle it here.' }] });
    await rc.startRepliesCheck(ctx, { accountId: 1, prId: pr, trigger: 'auto' });
    await settleFor(pr);
    expect(postReview).toHaveBeenCalledTimes(1);
    expect(postReview.mock.calls[0]![0]).toMatchObject({ verdict: 'REQUEST_CHANGES' });
    expect(postReview.mock.calls[0]![0].body).toContain('Replies checked: “Drops the error” is still a blocker.');
    expect(replyCalls).toHaveLength(1);
    expect(replyCalls[0]!.body).toContain('please handle it here');
    // GitHub now shows Limn's own request for changes (the pass's recorded review id).
    liveReviewList = [{ id: 7001, login: 'me', state: 'CHANGES_REQUESTED' }];
    // A later reply, disputed again: no second pushback on that thread, ever — and the same request
    // for changes is not sent twice (held: Limn's own block already stands).
    await db.insert(schema.reviewComments).values({
      githubNodeId: `RC_${node++}`,
      threadId: (await db.select().from(schema.reviewThreads).execute()).at(-1).id,
      prId: pr,
      authorId: users.alice,
      body: 'Really, later.',
      createdAt: new Date(LATER + 10 * HOUR),
    }).execute();
    await rc.startRepliesCheck(ctx, { accountId: 1, prId: pr, trigger: 'auto' });
    await settleFor(pr);
    expect(await passRows(pr)).toHaveLength(2);
    expect(replyCalls).toHaveLength(1);
    expect(postReview).toHaveBeenCalledTimes(1);
    const second = (await persist.getClaudeReviewById(ctx, (await passRows(pr))[0]!.id, 1))!;
    expect(second.autoPost).toMatchObject({ status: 'skipped', verdict: { wanted: 'REQUEST_CHANGES', heldReason: 'already_requested' } });
  });

  it('⚠ the reader’s own standing review holds the verdict: no approval, and the reason stays in Limn', async () => {
    const pr = await makePr();
    await reviewed(pr, [{ title: 'Naming is off', severity: 'warning', replies: [{ by: 'alice', body: 'It follows the house style.' }] }]);
    liveReviewList = [{ id: 1, login: 'me', state: 'APPROVED' }];
    script = () => ({ replies: [{ ref: 'T1', status: 'reply_accepted', acceptKind: 'not_valid', reply: 'Fair.' }] });
    await rc.startRepliesCheck(ctx, { accountId: 1, prId: pr, trigger: 'auto' });
    await settleFor(pr);
    expect(postReview).not.toHaveBeenCalled();
    const pass = (await persist.getClaudeReviewById(ctx, (await passRows(pr))[0]!.id, 1))!;
    expect(pass.autoPost).toMatchObject({
      status: 'skipped',
      verdict: { wanted: 'APPROVE', submitted: 'COMMENT', heldReason: 'prior_review' },
    });
    expect(pass.autoPost?.reasonPosted).toBeUndefined();
  });

  it('⚠ an OPEN review request of the reader: the held approval’s reason stays in Limn (a review would answer the request)', async () => {
    const pr = await makePr();
    await db.insert(schema.reviewRequests).values({ prId: pr, userId: users.me }).execute();
    await reviewed(pr, [{ title: 'Naming is off', severity: 'warning', replies: [{ by: 'alice', body: 'It follows the house style.' }] }]);
    liveReviewList = [{ id: 1, login: 'me', state: 'APPROVED' }];
    script = () => ({ replies: [{ ref: 'T1', status: 'reply_accepted', acceptKind: 'not_valid', reply: 'Fair.' }] });
    await rc.startRepliesCheck(ctx, { accountId: 1, prId: pr, trigger: 'auto' });
    await settleFor(pr);
    expect(postReview).not.toHaveBeenCalled();
    const pass = (await persist.getClaudeReviewById(ctx, (await passRows(pr))[0]!.id, 1))!;
    expect(pass.autoPost).toMatchObject({
      status: 'skipped',
      verdict: { wanted: 'APPROVE', submitted: 'COMMENT', heldReason: 'prior_review' },
    });
    expect(pass.autoPost?.reasonPosted).toBeUndefined();
  });

  it('LEFTOVERS: a question still open under "nits only" holds the approval; the reason is stored, shown and posted', async () => {
    await settings.setWorkspaceAutoReview(ctx, 1, wsId, { autoPost: { approveLeftovers: 'nits' } as any });
    try {
      const pr = await makePr();
      await reviewed(pr, [
        { title: 'Unchecked input', severity: 'warning', replies: [{ by: 'alice', body: EXPLAIN }] },
        { title: 'Why a map', severity: 'question' as any, replies: [] },
      ]);
      script = () => ({ replies: [{ ref: 'T1', status: 'reply_accepted', acceptKind: 'not_valid', reply: 'Fair.' }] });
      await rc.startRepliesCheck(ctx, { accountId: 1, prId: pr, trigger: 'auto' });
      await settleFor(pr);
      expect(postReview).toHaveBeenCalledTimes(1);
      expect(postReview.mock.calls[0]![0]).toMatchObject({
        verdict: 'COMMENT',
        body: 'Not approved: a question is still open.\n\n_Posted automatically by Limn’s Claude review._',
      });
      const state = await rc.repliesCheckState(ctx, 1, pr);
      expect(state?.latest?.notApproved).toEqual({ heldReason: 'open_findings', text: 'Not approved: a question is still open.' });
      // The default rule (nits and questions may remain) would have approved.
      await settings.setWorkspaceAutoReview(ctx, 1, wsId, { autoPost: { approveLeftovers: 'nits_questions' } as any });
      const { computeRepliesOutcome } = await import('./replies-outcome.js');
      const pass = (await persist.getClaudeReviewById(ctx, (await passRows(pr))[0]!.id, 1))!;
      expect((await computeRepliesOutcome(ctx, 1, pr, pass.followUp!.items)).wanted).toBe('APPROVE');
    } finally {
      await settings.setWorkspaceAutoReview(ctx, 1, wsId, { autoPost: { approveLeftovers: 'nits_questions' } as any });
    }
  });

  it('A CLAUDE + CODEX REVIEW: a half that said COMMENT and raised nothing holds it under strict, not under relaxed', async () => {
    try {
      const pr = await makePr();
      const first = await reviewed(
        pr,
        [{ title: 'Unchecked input', severity: 'warning', replies: [{ by: 'alice', body: EXPLAIN }] }],
        { provider: 'claude', verdict: 'APPROVE', pair: { role: 'first' } },
      );
      await reviewed(pr, [], { provider: 'codex', verdict: 'COMMENT', pair: { role: 'second', pairId: first.reviewId } });
      script = () => ({ replies: [{ ref: 'T1', status: 'reply_accepted', acceptKind: 'not_valid', reply: 'Fair.' }] });
      await rc.startRepliesCheck(ctx, { accountId: 1, prId: pr, trigger: 'auto' });
      await settleFor(pr);
      expect(postReview).toHaveBeenCalledTimes(1);
      const sent = postReview.mock.calls[0]![0];
      expect(sent.verdict).toBe('COMMENT');
      expect(sent.body.startsWith('Not approved: Codex didn’t approve.')).toBe(true);
      const pass = (await persist.getClaudeReviewById(ctx, (await passRows(pr))[0]!.id, 1))!;
      expect(pass.autoPost).toMatchObject({ verdict: { heldReason: 'pair_strict' } });
      // Relaxed: the same outcome approves.
      await settings.setWorkspaceAutoReview(ctx, 1, wsId, { pairStrictness: 'relaxed' });
      const { computeRepliesOutcome } = await import('./replies-outcome.js');
      expect((await computeRepliesOutcome(ctx, 1, pr, pass.followUp!.items)).wanted).toBe('APPROVE');
    } finally {
      await settings.setWorkspaceAutoReview(ctx, 1, wsId, { pairStrictness: 'strict' });
    }
  });

  it('nothing the replies changed (a warning still open) ⇒ no review, no record', async () => {
    const pr = await makePr();
    await reviewed(pr, [
      { title: 'Unchecked input', severity: 'warning', replies: [{ by: 'alice', body: EXPLAIN }] },
      { title: 'Slow loop', severity: 'warning', replies: [] },
    ]);
    script = () => ({ replies: [{ ref: 'T1', status: 'reply_accepted', acceptKind: 'not_valid', reply: 'Fair.' }] });
    await rc.startRepliesCheck(ctx, { accountId: 1, prId: pr, trigger: 'auto' });
    await settleFor(pr);
    expect(postReview).not.toHaveBeenCalled();
    const pass = (await persist.getClaudeReviewById(ctx, (await passRows(pr))[0]!.id, 1))!;
    expect(pass.autoPost).toBeNull();
    expect(pass.verdict).toBe('COMMENT');
  });

  it('counts its automatic passes for the per-PR cap', async () => {
    const pr = await makePr();
    await reviewed(pr, [{ title: 'Unchecked input', severity: 'warning', replies: [{ by: 'alice', body: EXPLAIN }] }]);
    script = () => ({ replies: [{ ref: 'T1', status: 'not_checked' }] });
    await rc.startRepliesCheck(ctx, { accountId: 1, prId: pr, trigger: 'auto' });
    await settleFor(pr);
    expect(await rc.countAutoRepliesPassesSince(ctx, 1, pr, Date.now() - HOUR)).toBe(1);
    expect(await rc.countAutoRepliesPassesSince(ctx, 1, pr, Date.now() + HOUR)).toBe(0);
  });
});

describe('the provider of the run that owns each thread', () => {
  it('groups threads by provider, Claude first; the owner’s provider when it can run', () => {
    const f = (id: number) => ({ id }) as any;
    const owners = new Map<number, 'claude' | 'codex'>([[1, 'codex'], [2, 'claude'], [3, 'codex']]);
    expect(rc.groupByProvider([f(1), f(2), f(3), f(4)], owners, (o) => o ?? 'claude')).toEqual([
      { provider: 'claude', findingIds: [2, 4] },
      { provider: 'codex', findingIds: [1, 3] },
    ]);
    // Codex cannot run here ⇒ its threads go to the default.
    expect(rc.groupByProvider([f(1), f(2)], owners, () => 'claude')).toEqual([{ provider: 'claude', findingIds: [1, 2] }]);
  });

  it('a Claude + Codex pair: both halves’ threads are judged, each by its own provider, and the outcome counts both', async () => {
    await settings.setWorkspaceAutoReview(ctx, 1, wsId, { autoPost: { enabled: false } as any });
    const pr = await makePr();
    // Claude's half: a warning nobody replied to (still open). Codex's half: a warning whose reply
    // is accepted. Only Codex's half settled ⇒ the PR still has an open warning ⇒ no APPROVE.
    const first = await reviewed(
      pr,
      [{ title: 'Slow loop', severity: 'warning', replies: [{ by: 'alice', body: DEFER }] }],
      { provider: 'claude', trigger: 'manual', pair: { role: 'first' } },
    );
    await reviewed(
      pr,
      [{ title: 'Unchecked input', severity: 'warning', replies: [{ by: 'alice', body: EXPLAIN }] }],
      { provider: 'codex', trigger: 'manual', pair: { role: 'second', pairId: first.reviewId } },
    );
    const planned = await rc.planRepliesCheck(ctx, 1, pr);
    expect('refused' in planned).toBe(false);
    if ('refused' in planned) return;
    expect(planned.findings.map((f) => f.title).sort()).toEqual(['Slow loop', 'Unchecked input']);
    agentCalls.length = 0;
    script = (call: any) =>
      call.provider === 'codex'
        ? { replies: [{ ref: 'T1', status: 'reply_accepted', acceptKind: 'not_valid', reply: 'Fair.' }] }
        : { replies: [{ ref: 'T1', status: 'reply_disputed', reply: 'The loop is still quadratic on line 2.' }] };
    await rc.startRepliesCheck(ctx, { accountId: 1, prId: pr, trigger: 'manual' });
    await settleFor(pr);
    expect(agentCalls.map((a) => a.provider)).toEqual(['claude', 'codex']);
    const rows = await passRows(pr);
    expect(rows.map((r) => r.provider).sort()).toEqual(['claude', 'codex']);
    const { computeRepliesOutcome } = await import('./replies-outcome.js');
    const codexPass = (await persist.getClaudeReviewById(ctx, rows.find((r) => r.provider === 'codex')!.id, 1))!;
    // The outcome rests on BOTH halves: Claude's open warning keeps it from approving.
    const outcome = await computeRepliesOutcome(ctx, 1, pr, codexPass.followUp!.items);
    expect(outcome.wanted).not.toBe('APPROVE');
  });

  it('a thread a Codex review posted is judged by Codex', async () => {
    await settings.setWorkspaceAutoReview(ctx, 1, wsId, { autoPost: { enabled: false } as any });
    const pr = await makePr();
    await reviewed(pr, [{ title: 'Unchecked input', severity: 'warning', replies: [{ by: 'alice', body: EXPLAIN }] }], { provider: 'codex', trigger: 'manual' });
    script = () => ({ replies: [{ ref: 'T1', status: 'reply_accepted', acceptKind: 'not_valid', reply: 'Fair.' }] });
    await rc.startRepliesCheck(ctx, { accountId: 1, prId: pr, trigger: 'manual' });
    await settleFor(pr);
    expect(agentCalls.map((a) => a.provider)).toEqual(['codex']);
    const rows = await passRows(pr);
    expect(rows[0]).toMatchObject({ provider: 'codex', model: 'gpt-6.1-terra' });
  });
});

describe('review fixes: pair coverage, the outcome anchor, the daily cap', () => {
  const MIN = 60_000;
  let eq: typeof import('drizzle-orm').eq;
  const setTimes = async (reviewId: number, createdAtMs: number, commentsThroughMs: number | null) =>
    db
      .update(schema.claudeReviews)
      .set({ createdAt: new Date(createdAtMs), commentsThrough: commentsThroughMs == null ? null : new Date(commentsThroughMs) })
      .where(eq(schema.claudeReviews.id, reviewId))
      .execute();
  beforeAll(async () => {
    ({ eq } = await import('drizzle-orm'));
  });
  beforeEach(async () => {
    await settings.setWorkspaceAutoReview(ctx, 1, wsId, { autoPost: { enabled: true, scope: 'all', autoVerdict: true } as any });
  });

  it('⚠ a pair: a reply on a CLAUDE finding that landed while the Claude half ran is still judged (the Codex half’s later start does not cover it)', async () => {
    const pr = await makePr();
    const now = Date.now();
    const first = await reviewed(
      pr,
      [{ title: 'Leaks the handle', severity: 'warning', replies: [{ by: 'alice', body: EXPLAIN, at: now - 30 * MIN }] }],
      { provider: 'claude', pair: { role: 'first' } },
    );
    const second = await reviewed(pr, [], { provider: 'codex', pair: { role: 'second', pairId: first.reviewId } });
    // The Claude half started 2 h ago; the Codex half started 10 min ago and saw comments through 20 min ago.
    await setTimes(first.reviewId, now - 2 * HOUR, null);
    await setTimes(second.reviewId, now - 10 * MIN, now - 20 * MIN);
    const planned = await rc.planRepliesCheck(ctx, 1, pr);
    expect('refused' in planned).toBe(false);
    if ('refused' in planned) return;
    expect(planned.findings.map((f) => f.title)).toEqual(['Leaks the handle']);
  });

  it('the outcome anchors on the latest SUCCEEDED full review: a cancelled run after it does not hide it', async () => {
    const pr = await makePr();
    await reviewed(pr, [{ title: 'Unchecked input', severity: 'warning', replies: [{ by: 'alice', body: EXPLAIN }] }]);
    // The reader pressed Review and stopped it: a newer cancelled full row at the same head.
    const stopped = await persist.insertQueuedReview(ctx, pr, HEAD, 'claude-opus-5-5', 1, [], 'manual', 'claude');
    await persist.markReviewCancelled(ctx, stopped);
    script = () => ({ replies: [{ ref: 'T1', status: 'reply_accepted', acceptKind: 'not_valid', reply: 'Fair.' }] });
    expect((await rc.startRepliesCheck(ctx, { accountId: 1, prId: pr, trigger: 'auto' })).outcome).toBe('queued');
    await settleFor(pr);
    expect(postReview).toHaveBeenCalledTimes(1);
    expect(postReview.mock.calls[0]![0].verdict).toBe('APPROVE');
  });

  it('⚠ an automatic outcome never rests on a MANUAL review, nor on a review of another head', async () => {
    const pr = await makePr();
    const auto = await reviewed(pr, [{ title: 'Unchecked input', severity: 'warning', replies: [] }]);
    const items = [
      { priorFindingId: auto.ids.get('Unchecked input')!, status: 'reply_accepted', severity: 'warning', title: 'Unchecked input' },
    ] as any;
    const { computeRepliesOutcome, maybePostRepliesOutcome } = await import('./replies-outcome.js');
    const onAuto = await computeRepliesOutcome(ctx, 1, pr, items, HEAD);
    expect(onAuto.restsOnAuto).toBe(true);
    // A pass at a newer head: the review is of older commits ⇒ no outcome at all.
    const moved = await computeRepliesOutcome(ctx, 1, pr, items, 'b'.repeat(40));
    expect(moved).toMatchObject({ wanted: null, noBlocker: false, full: null });
    // The reader then ran a MANUAL review at the head and kept it local (no findings).
    await reviewed(pr, [], { trigger: 'manual' });
    const onManual = await computeRepliesOutcome(ctx, 1, pr, items, HEAD);
    expect(onManual.restsOnAuto).toBe(false);
    // An AUTO replies pass row at the head (as the pass stores it).
    const passId = await persist.insertQueuedReview(ctx, pr, HEAD, 'claude-sonnet-5', 1, [], 'auto', 'claude');
    await db
      .update(schema.claudeReviews)
      .set({ kind: 'replies', status: 'succeeded', finishedAt: new Date() })
      .where(eq(schema.claudeReviews.id, passId))
      .execute();
    // Even handed a wanted APPROVE, the automatic writer does nothing over a manual run…
    const held = await maybePostRepliesOutcome(
      ctx,
      { accountId: 1, prId: pr, reviewId: passId, outcome: { ...onManual, wanted: 'APPROVE', noBlocker: true } },
      postDeps() as any,
    );
    expect(held.kind).toBe('nothing');
    expect(postReview).not.toHaveBeenCalled();
    // …while the same outcome resting on auto runs posts.
    const posted = await maybePostRepliesOutcome(
      ctx,
      { accountId: 1, prId: pr, reviewId: passId, outcome: { ...onManual, restsOnAuto: true, wanted: 'APPROVE', noBlocker: true } },
      postDeps() as any,
    );
    expect(posted.kind).toBe('done');
    expect(postReview).toHaveBeenCalledTimes(1);
  });

  it('a Claude + Codex pair counts ONCE toward the daily auto-review cap', async () => {
    const q = await import('../../db/queries.js');
    const read = async () =>
      (await q.getAutoReviewCandidates(1, wsId, { openedSinceMs: 0, dayStartMs: Date.now() - HOUR, limit: 0 }))!.autoToday;
    const before = await read();
    const pr = await makePr();
    const first = await persist.insertQueuedReview(ctx, pr, HEAD, 'claude-opus-5-5', 1, [], 'auto', 'claude', false, { role: 'first' });
    await persist.insertQueuedReview(ctx, pr, HEAD, 'claude-opus-5-5', 1, [], 'auto', 'codex', false, { role: 'second', pairId: first });
    expect(await read()).toBe(before + 1);
    // An ordinary auto run still counts.
    await persist.insertQueuedReview(ctx, pr, HEAD, 'claude-opus-5-5', 1, [], 'auto', 'claude');
    expect(await read()).toBe(before + 2);
  });
});
