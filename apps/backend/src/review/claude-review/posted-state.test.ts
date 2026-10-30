// "POSTED AUTOMATICALLY, BUT THE TAB SAID NOT POSTED" — the exact timeline of PR 4 of
// DEFRA/bng-metric-template (local PR 163508), 2026-10-14, replayed over the REAL core client, the
// REAL Claude Review routes and a FAKE GitHub (nothing reaches GitHub):
//
//   14:44 run A (auto) posts nit F1 automatically (review 5519791565, comment 4272298808).
//   14:55 run B (auto, new head): F2 re-raises F1 (prior_finding_id), F3 is a new nit. Auto-posting
//         skips F2 (its chain is on GitHub) and posts F3 — GitHub answers 422 "An internal error
//         occurred" BUT PUBLISHES the review (comment 4272427452). The run is recorded `failed`.
//   15:26 the tab showed F2 and F3 unposted with Post buttons; the reader posted both by hand —
//         two duplicates on GitHub.
//
// What is pinned (posted-state.ts):
//   1. F3's lost post is FOUND (a synced comment of ours with its text, made since run B started,
//      owned by no posted finding) and STAMPED — posted, auto, with its comment id — and run B's
//      auto-post record is corrected to `posted`.
//   2. F2 carries `earlierPost` → F1's comment, posted automatically.
//   3. Both manual routes refuse them: the single Post answers 409 AlreadyPosted and calls nothing;
//      Post review leaves them out.
//   4. A LATER auto run's re-raise of F3 is not posted again.
//   5. The pure rules: a comment older than the run is an earlier post, never a stamp; a comment a
//      posted finding owns is never stamped onto another; a later run that had started is the
//      likelier owner.
//
//   pnpm --filter @pierre-review/backend test claude-review/posted-state
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AUTO_POST_FOOTER, type ClaudeFindingSeverity } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-claude-posted-state.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

vi.mock('./manager.js', () => ({
  AGENTIC_AI_ENABLED: true,
  startReview: vi.fn(),
  getReviewStatus: vi.fn(),
  listActiveReviews: vi.fn(async () => []),
  autoReviewHold: vi.fn(() => null),
  requestReviewCancel: vi.fn(() => false),
  subscribeReviewStream: vi.fn(() => () => {}),
}));

const MARKER = '<!-- pierre:claude-review-finding v=1 -->';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let ctx: AgentContext;
let app: FastifyInstance;
let ap: typeof import('./auto-post.js');
let persist: typeof import('./persist.js');
let settings: typeof import('./auto-settings.js');
let wsId = 0;
let repoId = 0;
let meId = 0;
let prSeq = 0;
let nodeSeq = 0;

const postReview = vi.fn();
const postFinding = vi.fn();
const deps = () => ({
  ...ap.defaultAutoPostDeps,
  livePr: vi.fn(async () => ({ headSha: 'HEAD', state: 'open' as const, draft: false, merged: false })),
  liveReviews: vi.fn(async () => []),
  settle: vi.fn(async () => ({ visible: true })),
});

async function makePr(): Promise<number> {
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
      headSha: 'HEAD',
      authorId: meId,
      openedAt: new Date(),
      updatedAt: new Date(),
    })
    .returning()
    .execute();
  return p.id;
}

interface F {
  severity: ClaudeFindingSeverity;
  title: string;
  body: string;
  path?: string;
  priorFindingId?: number | null;
}
async function run(prId: number, findings: F[]): Promise<number> {
  const id = await persist.insertQueuedReview(ctx, prId, 'HEAD', 'claude-opus-5-5' as any, 1, [], 'auto');
  await persist.saveReviewSuccess(ctx, id, {
    scope: 'diff_only',
    summary: 'The change looks sound.',
    verdict: 'COMMENT',
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    numTurns: 1,
    excludedFiles: [],
    findings: findings.map((f, i) => ({
      path: f.path ?? 'tools/limit.py',
      line: 60 + i,
      side: 'RIGHT' as const,
      severity: f.severity,
      title: f.title,
      body: f.body,
      suggestion: null,
      diffHunk: null,
      anchored: true,
      fileInDiff: true,
      priorFindingId: f.priorFindingId ?? null,
    })),
  });
  return id;
}

/** A synced review thread whose root comment is ours (as GitHub + the sync would leave it). */
async function syncedRoot(prId: number, path: string, databaseId: string, body: string, at: Date, line: number | null = 3): Promise<number> {
  nodeSeq += 1;
  const [t] = await db
    .insert(schema.reviewThreads)
    .values({ githubNodeId: `T_${nodeSeq}`, prId, path, line, isResolved: false, derivedState: 'untouched', createdAt: at })
    .returning()
    .execute();
  await db
    .insert(schema.reviewComments)
    .values({ githubNodeId: `C_${nodeSeq}`, threadId: t.id, prId, databaseId, authorId: meId, body, createdAt: at })
    .execute();
  return t.id;
}

const autoBody = (text: string, fallback = false): string =>
  [text, ...(fallback ? ['_The line this refers to isn’t part of the PR’s diff, so it’s anchored to the file’s first change._'] : []), AUTO_POST_FOOTER, MARKER].join('\n\n');

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
  const [u] = await db.insert(schema.users).values({ githubLogin: 'me', githubNodeId: 'U_me' }).returning().execute();
  meId = u.id;
  const [r] = await db.insert(schema.repos).values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_api' }).returning().execute();
  repoId = r.id;
  wsId = await q.ensureDefaultWorkspace(1);
  await q.ensureRepoMemberships(1);
  ap = await import('./auto-post.js');
  persist = await import('./persist.js');
  settings = await import('./auto-settings.js');
  ctx = {
    db,
    schema,
    runTransaction: client.runTransaction,
    recordAiUsage: async () => {},
    accountIdOf: () => 1,
    review: { postReview, postFinding },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as any as AgentContext;
  // This workspace's real settings: scope all, nits ON.
  await settings.setWorkspaceAutoReview(ctx, 1, wsId, { autoPost: { enabled: true, scope: 'all', kinds: { nits: true } } as any });
  const { default: Fastify } = await import('fastify');
  const { registerClaudeReviewRoutes } = await import('./routes.js');
  app = Fastify({ logger: false });
  registerClaudeReviewRoutes(app, ctx);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
});

beforeEach(() => {
  postReview.mockReset();
  postFinding.mockReset();
});

const F1_TEXT = '`limit_value_map` keeps an entry only when its stored value exactly matches `escape(name)`.';
const F2_TEXT = 'This was raised in a previous review and is still not fixed. `limit_value_map` keeps an entry only when its value exactly matches.';
const F3_TEXT = '`_report_manual_steps` still warns that vertical area habitats are empty.';

describe('the PR 163508 timeline', () => {
  it('a lost auto post is found and stamped; a re-raise of a posted finding reads as posted; neither posts again', async () => {
    const prId = await makePr();

    // 14:44 — run A posts F1 automatically.
    const runA = await run(prId, [{ severity: 'nit', title: 'Value Map can be emptied without any error', body: F1_TEXT }]);
    postReview.mockImplementationOnce(async (a: any) => ({
      postedReviewId: '5519791565',
      inlineFindingIds: a.includedFindings.map((f: any) => f.id),
      inlineComments: [{ findingId: a.includedFindings[0].id, commentId: '4272298808' }],
      prComments: [],
      commentCount: 1,
      prCommentCount: 0,
    }));
    const outA = await ap.maybeAutoPostReview(ctx, { accountId: 1, prId, reviewId: runA }, deps());
    expect(outA).toMatchObject({ kind: 'done', record: { status: 'posted' } });
    const f1 = (await persist.getClaudeReviewById(ctx, runA, 1))!.findings[0]!;
    await syncedRoot(prId, 'tools/limit.py', '4272298808', autoBody(F1_TEXT), new Date());

    // 14:55 — run B: F2 re-raises F1, F3 is new. GitHub answers 422 but publishes the review.
    const runB = await run(prId, [
      { severity: 'nit', title: 'Value Map can be emptied without any error', body: F2_TEXT, priorFindingId: f1.id },
      { severity: 'nit', title: 'Manual-step warning now contradicts the new warning', body: F3_TEXT, path: 'plugin/old_to_new.py' },
    ]);
    postReview.mockImplementationOnce(async () => {
      throw Object.assign(new Error('GitHub REST POST /repos/acme/api/pulls/1/reviews -> 422: {"errors":["An internal error occurred, please try again."]}'), { status: 422 });
    });
    const outB = await ap.maybeAutoPostReview(ctx, { accountId: 1, prId, reviewId: runB }, deps());
    // Auto-posting itself already left F2 out (its chain is on GitHub) and tried F3 alone.
    expect(outB.kind).toBe('done');
    const recB = (outB as any).record;
    expect(recB.status).toBe('failed');
    expect(postReview.mock.calls.at(-1)![0].includedFindings.map((f: any) => f.body)).toEqual([
      expect.stringContaining('_report_manual_steps'),
    ]);
    // The sync brings the comment GitHub published anyway (anchored to the file's first change).
    await new Promise((r) => setTimeout(r, 1100)); // a later second than run B's start
    await syncedRoot(prId, 'plugin/old_to_new.py', '4272427452', autoBody(F3_TEXT, true), new Date());

    // 15:26 — what the tab reads.
    const shownB = (await persist.getClaudeReviewById(ctx, runB, 1))!;
    const [f2, f3] = shownB.findings;
    // 1. F3 IS posted — automatically, with GitHub's comment id — and the run no longer says it failed.
    expect(f3).toMatchObject({ githubCommentId: '4272427452', postedCommentKind: 'inline', postedAuto: true });
    expect(f3!.postedAt).not.toBeNull();
    expect(shownB.autoPost).toMatchObject({ status: 'posted', error: null, postedCount: 1 });
    // 2. F2's point is on GitHub through F1.
    expect(f2!.postedAt).toBeNull();
    expect(f2!.earlierPost).toEqual({
      findingId: f1.id,
      githubCommentId: '4272298808',
      postedCommentKind: 'inline',
      postedAt: expect.any(String),
      postedAuto: true,
    });

    // 3. The manual routes refuse both — nothing reaches GitHub.
    for (const f of [f2!, f3!]) {
      const res = await app.inject({ method: 'POST', url: `/api/claude-findings/${f.id}/post` });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'AlreadyPosted' });
    }
    expect(postFinding).not.toHaveBeenCalled();
    postReview.mockImplementationOnce(async (a: any) => ({ preview: { includedIds: a.includedFindings.map((f: any) => f.id) } }));
    const dry = await app.inject({ method: 'POST', url: `/api/claude-reviews/${runB}/post?dryRun=true`, payload: { userVerdict: 'COMMENT' } });
    expect(dry.statusCode).toBe(200);
    expect(postReview.mock.calls.at(-1)![0].includedFindings).toEqual([]);

    // 4. A later auto run that re-raises F3 does not post it again.
    const runC = await run(prId, [
      { severity: 'nit', title: 'Manual-step warning now contradicts the new warning', body: `Still not fixed. ${F3_TEXT}`, path: 'plugin/old_to_new.py', priorFindingId: f3!.id },
    ]);
    postReview.mockClear();
    const outC = await ap.maybeAutoPostReview(ctx, { accountId: 1, prId, reviewId: runC }, deps());
    expect(outC).toEqual({ kind: 'skipped', reason: 'already_posted' });
    expect(postReview).not.toHaveBeenCalled();
    const f4 = (await persist.getClaudeReviewById(ctx, runC, 1))!.findings[0]!;
    expect(f4.earlierPost).toMatchObject({ findingId: f3!.id, githubCommentId: '4272427452', postedAuto: true });
  });

  it('the record is corrected even after the reader posted the duplicate by hand (the dev DB today)', async () => {
    const prId = await makePr();
    const r = await run(prId, [{ severity: 'nit', title: 'Warning contradicts', body: F3_TEXT, path: 'plugin/old_to_new.py' }]);
    postReview.mockImplementationOnce(async () => {
      throw Object.assign(new Error('-> 422: An internal error occurred, please try again.'), { status: 422 });
    });
    const out = await ap.maybeAutoPostReview(ctx, { accountId: 1, prId, reviewId: r }, deps());
    expect((out as any).record.status).toBe('failed');
    await new Promise((res) => setTimeout(res, 1100));
    // GitHub's copy from the "failed" auto post, then the reader's manual duplicate.
    await syncedRoot(prId, 'plugin/old_to_new.py', 'AUTO1', autoBody(F3_TEXT, true), new Date());
    const f = (await persist.getClaudeReviewById(ctx, r, 1))!.findings[0]!;
    // (Read before the manual post: stamped from the orphan. Undo that to replay the manual path.)
    await db.update(schema.claudeReviewFindings).set({ postedAt: null, githubCommentId: null, postedAuto: null, postedCommentKind: null }).where((await import('drizzle-orm')).eq(schema.claudeReviewFindings.id, f.id)).execute();
    await db.update(schema.claudeReviews).set({ autoPost: { ...(out as any).record } }).where((await import('drizzle-orm')).eq(schema.claudeReviews.id, r)).execute();
    await syncedRoot(prId, 'plugin/old_to_new.py', 'MANUAL1', [F3_TEXT, MARKER].join('\n\n'), new Date());
    await persist.markFindingPosted(ctx, f.id, 'MANUAL1', 'inline');
    const shown = (await persist.getClaudeReviewById(ctx, r, 1))!;
    expect(shown.findings[0]).toMatchObject({ githubCommentId: 'MANUAL1' });
    expect(shown.autoPost).toMatchObject({ status: 'posted', error: null, postedCount: 1 });
  });

  it('a person’s comment of ours made BEFORE the run started is an earlier post, never a stamp', async () => {
    const prId = await makePr();
    const text = 'Guard the empty list before indexing.';
    // The thread sits on the finding's line (`run` puts the first finding on line 60).
    await syncedRoot(prId, 'tools/limit.py', '777', [text, MARKER].join('\n\n'), new Date(Date.now() - 3_600_000), 60);
    const r = await run(prId, [{ severity: 'warning', title: 'Empty list', body: text }]);
    const f = (await persist.getClaudeReviewById(ctx, r, 1))!.findings[0]!;
    expect(f.postedAt).toBeNull();
    expect(f.earlierPost).toEqual({ findingId: null, githubCommentId: '777', postedCommentKind: 'inline', postedAt: expect.any(String), postedAuto: false });
  });
});

// REMINDERS (user decision 2026-10-14): a finding already on GitHub is never posted again BY
// ACCIDENT, but "Post reminder" posts it on purpose — marked as a reminder, linking the first comment,
// recorded beside (never instead of) the original post. Bulk and auto posting still skip it.
describe('Post reminder', () => {
  it('409 without the flag; with it the post goes through, marked, and is recorded beside the original', async () => {
    const prId = await makePr();
    const prNumber = prSeq;
    const runA = await run(prId, [{ severity: 'nit', title: 'Value Map can be emptied without any error', body: F1_TEXT }]);
    postReview.mockImplementationOnce(async (a: any) => ({
      postedReviewId: 'R_A',
      inlineFindingIds: a.includedFindings.map((f: any) => f.id),
      inlineComments: [{ findingId: a.includedFindings[0].id, commentId: '9001' }],
      prComments: [],
      commentCount: 1,
      prCommentCount: 0,
    }));
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId, reviewId: runA }, deps());
    const f1 = (await persist.getClaudeReviewById(ctx, runA, 1))!.findings[0]!;
    await syncedRoot(prId, 'tools/limit.py', '9001', autoBody(F1_TEXT), new Date(), 60);
    const runB = await run(prId, [
      { severity: 'nit', title: 'Value Map can be emptied without any error', body: F2_TEXT, priorFindingId: f1.id },
      { severity: 'warning', title: 'Brand new point', body: 'Close the handle on the error path.', path: 'tools/other.py' },
    ]);
    const [f2, fresh] = (await persist.getClaudeReviewById(ctx, runB, 1))!.findings;
    expect(f2!.earlierPost).toMatchObject({ findingId: f1.id, githubCommentId: '9001' });

    // No flag: refused, nothing reaches GitHub.
    const plain = await app.inject({ method: 'POST', url: `/api/claude-findings/${f2!.id}/post` });
    expect(plain.statusCode).toBe(409);
    expect(plain.json()).toMatchObject({ error: 'AlreadyPosted' });
    // A reminder of something NOT on GitHub is refused too: post it instead.
    const notPosted = await app.inject({ method: 'POST', url: `/api/claude-findings/${fresh!.id}/post`, payload: { reminder: true } });
    expect(notPosted.statusCode).toBe(409);
    expect(notPosted.json()).toMatchObject({ error: 'NotPosted' });
    expect(postFinding).not.toHaveBeenCalled();

    // With the flag: posted, the body opens on the reminder line linking the first comment.
    postFinding.mockImplementationOnce(async () => ({ commentId: 'REM1', postedCommentKind: 'inline' }));
    const res = await app.inject({ method: 'POST', url: `/api/claude-findings/${f2!.id}/post`, payload: { reminder: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ githubCommentId: 'REM1', reminder: true });
    expect(postFinding).toHaveBeenCalledTimes(1);
    const sent = postFinding.mock.calls[0]![0].finding;
    expect(sent.storyLead).toMatch(/^\*\*Reminder:\*\* first raised \[on \d{1,2} [A-Z][a-z]{2} \d{4}\]\(https:\/\/github\.com\/acme\/api\/pull\/\d+#discussion_r9001\)\.$/);
    expect(sent.storyLead).toContain(`/pull/${prNumber}#discussion_r9001`);
    // The real comment body: reminder first, the finding's text, Limn's hidden marker last.
    const { findingCommentBody } = await import('../post-review.js');
    const body = findingCommentBody({ body: sent.body, editedBody: null, suggestion: null, storyLead: sent.storyLead }, { footer: AUTO_POST_FOOTER });
    expect(body.startsWith('**Reminder:**')).toBe(true);
    expect(body).toContain(F2_TEXT);
    expect(body).toContain(AUTO_POST_FOOTER);
    expect(body.endsWith(MARKER)).toBe(true);

    // Recorded BESIDE the original: still not the finding's own post, still linked to F1's comment.
    await syncedRoot(prId, 'tools/limit.py', 'REM1', [sent.storyLead, F2_TEXT, MARKER].join('\n\n'), new Date(), 60);
    const after = (await persist.getClaudeReviewById(ctx, runB, 1))!.findings[0]!;
    expect(after.postedAt).toBeNull();
    expect(after.earlierPost).toMatchObject({ findingId: f1.id, githubCommentId: '9001' });
    expect(after.reminder).toEqual({ githubCommentId: 'REM1', postedCommentKind: 'inline', postedAt: expect.any(String) });

    // Bulk "Post review" still leaves it out.
    postReview.mockImplementationOnce(async (a: any) => ({ preview: { includedIds: a.includedFindings.map((f: any) => f.id) } }));
    const dry = await app.inject({ method: 'POST', url: `/api/claude-reviews/${runB}/post?dryRun=true`, payload: { userVerdict: 'COMMENT' } });
    expect(dry.statusCode).toBe(200);
    expect(postReview.mock.calls.at(-1)![0].includedFindings.map((f: any) => f.id)).toEqual([fresh!.id]);

    // A later auto run re-raising it does not post it, and the reminder's comment is never read as
    // that re-raise's own (lost) post.
    const runC = await run(prId, [
      { severity: 'nit', title: 'Value Map can be emptied without any error', body: F2_TEXT, priorFindingId: f2!.id },
    ]);
    postReview.mockClear();
    const outC = await ap.maybeAutoPostReview(ctx, { accountId: 1, prId, reviewId: runC }, deps());
    expect(outC).toEqual({ kind: 'skipped', reason: 'already_posted' });
    expect(postReview).not.toHaveBeenCalled();
    const fC = (await persist.getClaudeReviewById(ctx, runC, 1))!.findings[0]!;
    expect(fC.postedAt).toBeNull();
    expect(fC.earlierPost).toMatchObject({ findingId: f1.id, githubCommentId: '9001' });

    // A second reminder replaces the shown one; the first stays claimed.
    postFinding.mockImplementationOnce(async () => ({ commentId: 'REM2', postedCommentKind: 'inline' }));
    expect((await app.inject({ method: 'POST', url: `/api/claude-findings/${f2!.id}/post`, payload: { reminder: true } })).statusCode).toBe(200);
    const again = (await persist.getClaudeReviewById(ctx, runB, 1))!.findings[0]!;
    expect(again.reminder).toMatchObject({ githubCommentId: 'REM2' });
  });

  it('the reminder line', async () => {
    const { reminderLead, findingCommentUrl } = await import('./posted-state.js');
    const pr = { owner: 'o', name: 'r', prNumber: 7 };
    expect(findingCommentUrl(pr, { githubCommentId: '5', postedCommentKind: 'pr_comment' })).toBe('https://github.com/o/r/pull/7#issuecomment-5');
    expect(findingCommentUrl(pr, { githubCommentId: null, postedCommentKind: 'inline' })).toBeNull();
    expect(reminderLead({ url: 'https://x/1', postedAt: '2026-10-12T09:00:00Z' })).toBe('**Reminder:** first raised [on 12 Oct 2026](https://x/1).');
    expect(reminderLead({ url: null, postedAt: '2026-10-12T09:00:00Z' })).toBe('**Reminder:** first raised on 12 Oct 2026.');
    expect(reminderLead({ url: null, postedAt: null })).toBe('**Reminder:** raised earlier on this PR.');
  });
});

describe('the pure rules', () => {
  const base = (o: Partial<import('./posted-state.js').PostedStateFinding>) => ({
    id: 1,
    reviewId: 10,
    path: 'a.ts',
    body: 'Fix the race.',
    editedBody: null,
    priorFindingId: null,
    postedAt: null,
    githubCommentId: null,
    postedCommentKind: null,
    postedAuto: null,
    ...o,
  });
  const comment = (id: string, body: string, at: number, login = 'me') => ({ threadId: Number(id), databaseId: id, body, authorLogin: login, createdAt: at });

  it('a comment a posted finding owns is never stamped onto another; another author never matches', async () => {
    const ps = await import('./posted-state.js');
    const input = {
      findings: [
        base({ id: 1, reviewId: 10, postedAt: new Date(1000), githubCommentId: '50', postedCommentKind: 'inline' as const }),
        base({ id: 2, reviewId: 11 }),
      ],
      runStartedAt: new Map([[10, 0], [11, 500]]),
      threads: [{ id: 50, path: 'a.ts' }, { id: 51, path: 'a.ts' }],
      threadComments: [comment('50', `Fix the race.\n\n${MARKER}`, 1000), comment('51', `Fix the race.\n\n${MARKER}`, 1200, 'someone')],
      prComments: [],
      accountLogin: 'me',
    };
    expect(ps.stampsFor(input, 11)).toEqual([]);
    // Still on GitHub, though: it reads as an earlier post.
    expect(ps.earlierPostsFor(input, 11).get(2)).toMatchObject({ findingId: null, githubCommentId: '50' });
  });

  it('a later run that had started when the comment was made is its likelier owner', async () => {
    const ps = await import('./posted-state.js');
    const input = {
      findings: [base({ id: 1, reviewId: 10 }), base({ id: 2, reviewId: 11 })],
      runStartedAt: new Map([[10, 0], [11, 500]]),
      threads: [{ id: 60, path: 'a.ts' }],
      threadComments: [comment('60', `Fix the race.\n\n${MARKER}`, 900)],
      prComments: [],
      accountLogin: 'me',
    };
    expect(ps.stampsFor(input, 10)).toEqual([]);
    expect(ps.stampsFor(input, 11)).toEqual([
      { findingId: 2, githubCommentId: '60', postedCommentKind: 'inline', postedAt: new Date(900), postedAuto: false },
    ]);
  });

  it('a PR-level comment matches on the file it names and the text', async () => {
    const ps = await import('./posted-state.js');
    const input = {
      findings: [base({ id: 1, reviewId: 10, path: 'docs/x.md' })],
      runStartedAt: new Map([[10, 0]]),
      threads: [],
      threadComments: [],
      prComments: [
        { databaseId: '90', body: `**\`other.md\`**\n\nFix the race.\n\n${MARKER}`, authorLogin: 'me', createdAt: 100 },
        { databaseId: '91', body: `**\`docs/x.md\`**\n\nFix the race.\n\n${AUTO_POST_FOOTER}\n\n${MARKER}`, authorLogin: 'me', createdAt: 100 },
      ],
      accountLogin: 'me',
    };
    expect(ps.stampsFor(input, 10)).toEqual([
      { findingId: 1, githubCommentId: '91', postedCommentKind: 'pr_comment', postedAt: new Date(100), postedAuto: true },
    ]);
  });

  it('⚠ the same words on ANOTHER line are another finding: both stay postable', async () => {
    const ps = await import('./posted-state.js');
    const input = {
      findings: [
        // A: "Unused import." posted on line 3 (comment 111). B: same words, same file, line 40, same run.
        base({ id: 1, reviewId: 10, line: 3, body: 'Unused import.', postedAt: new Date(1000), githubCommentId: '111', postedCommentKind: 'inline' as const }),
        base({ id: 2, reviewId: 10, line: 40, body: 'Unused import.' }),
        // C: a later run, same words, line 70 — no chain.
        base({ id: 3, reviewId: 11, line: 70, body: 'Unused import.' }),
      ],
      runStartedAt: new Map([[10, 0], [11, 5000]]),
      threads: [{ id: 111, path: 'a.ts', line: 3 }],
      threadComments: [comment('111', `Unused import.\n\n${MARKER}`, 1000)],
      prComments: [],
      accountLogin: 'me',
    };
    expect(ps.stampsFor(input, 10)).toEqual([]);
    expect(ps.earlierPostsFor(input, 10).has(2)).toBe(false);
    expect(ps.earlierPostsFor(input, 11).has(3)).toBe(false);
    // The same words on the SAME line in a later run are the same point: posted earlier.
    const again = { ...input, findings: [...input.findings.slice(0, 2), base({ id: 3, reviewId: 11, line: 3, body: 'Unused import.' })] };
    expect(ps.earlierPostsFor(again, 11).get(3)).toMatchObject({ githubCommentId: '111' });
    // An outdated thread (no current line) still matches on its text.
    const outdated = { ...again, threads: [{ id: 111, path: 'a.ts', line: null }] };
    expect(ps.earlierPostsFor(outdated, 11).get(3)).toMatchObject({ githubCommentId: '111' });
  });

  it('a PR-level comment names the line too: another line is another finding', async () => {
    const ps = await import('./posted-state.js');
    const input = {
      findings: [base({ id: 1, reviewId: 10, path: 'docs/x.md', line: 12 })],
      runStartedAt: new Map([[10, 0]]),
      threads: [],
      threadComments: [],
      prComments: [{ databaseId: '92', body: `**\`docs/x.md:4\`**\n\nFix the race.\n\n${MARKER}`, authorLogin: 'me', createdAt: 100 }],
      accountLogin: 'me',
    };
    expect(ps.stampsFor(input, 10)).toEqual([]);
    expect(ps.earlierPostsFor(input, 10).size).toBe(0);
  });

  it('severity labels: a comment posted with the lead and one posted before it both match', async () => {
    const ps = await import('./posted-state.js');
    const { findingCommentBody, prLevelFindingBody } = await import('../post-review.js');
    const shape = { body: 'Fix the race.', editedBody: null, suggestion: null };
    const labelled = findingCommentBody({ ...shape, severity: 'warning' });
    expect(labelled.startsWith('**Warning**\n\nFix the race.')).toBe(true);
    for (const body of [labelled, `Fix the race.\n\n${MARKER}`]) {
      const input = {
        findings: [base({ id: 1, reviewId: 10, line: 3 })],
        runStartedAt: new Map([[10, 0]]),
        threads: [{ id: 70, path: 'a.ts', line: 3 }],
        threadComments: [comment('70', body, 100)],
        prComments: [],
        accountLogin: 'me',
      };
      expect(ps.stampsFor(input, 10)).toEqual([
        { findingId: 1, githubCommentId: '70', postedCommentKind: 'inline', postedAt: new Date(100), postedAuto: false },
      ]);
    }
    const prBody = prLevelFindingBody({ ...shape, path: 'docs/x.md', line: 12, severity: 'nit' });
    expect(prBody.startsWith('**Nit** · `docs/x.md:12`')).toBe(true);
    for (const body of [prBody, `**\`docs/x.md:12\`**\n\nFix the race.\n\n${MARKER}`]) {
      const input = {
        findings: [base({ id: 1, reviewId: 10, path: 'docs/x.md', line: 12 })],
        runStartedAt: new Map([[10, 0]]),
        threads: [],
        threadComments: [],
        prComments: [{ databaseId: '93', body, authorLogin: 'me', createdAt: 100 }],
        accountLogin: 'me',
      };
      expect(ps.stampsFor(input, 10)).toEqual([
        { findingId: 1, githubCommentId: '93', postedCommentKind: 'pr_comment', postedAt: new Date(100), postedAuto: false },
      ]);
    }
  });

  it('isVerdictRefusal: a 422 "internal error" is ambiguous, never a refusal', async () => {
    expect(ap.isVerdictRefusal(Object.assign(new Error('-> 422: An internal error occurred, please try again.'), { status: 422 }))).toBe(false);
    expect(ap.isVerdictRefusal(Object.assign(new Error('-> 422: Can not approve your own pull request'), { status: 422 }))).toBe(true);
  });
});
