// AUTO-POSTING A PR REVIEW, over the REAL core client and a FAKE GitHub (nothing reaches GitHub —
// `ctx.review.postReview` / `postFinding` and the live-PR read are recorded stubs). What is pinned:
//
//   1. OFF ⇒ nothing posted and nothing recorded; a MANUAL run is never auto-posted.
//   2. WHICH PRs: scope 'mine' posts on your own PR and on one you are (or were — request history)
//      asked to review, and skips someone else's; scope 'all' posts there; merged, closed, draft and
//      bot-authored PRs are never posted on (synced AND live).
//   3. WHICH KINDS: blockers, warnings AND questions in ONE review, event COMMENT (the seam anchors
//      each question inline, else falls back); nits off by default; praise never; an ignored (not
//      included) finding never.
//   4. NEVER TWICE: a finding posted by an earlier run — linked by `prior_finding_id` or matching by
//      path + title — is not posted again; nothing new ⇒ no GitHub call, and when the dedupe alone
//      emptied it the skip says 'already_posted' with the ids; a run is claimed once. An earlier
//      run cut off mid-post counts as possibly posted.
//   7. 'mine' also covers a PR the reader reviewed or commented on.
//   8. AUTO VERDICT (stricter than Claude): any blocker ⇒ REQUEST_CHANGES, APPROVE only with
//      Claude's approval and no blocker/warning; sent only off the reader's own PR and over no
//      standing APPROVED / CHANGES_REQUESTED of theirs, read LIVE.
//   5. FAILURES are recorded (failed / partial + the error), never retried; after a 201 the
//      findings are stamped `posted_auto`, the review settles, and the wire says "auto".
//   6. The posted bodies end with the footer and carry the marker `isLimnPostedComment` reads, so
//      our own comments never re-trigger an auto review.
//
//   pnpm --filter @pierre-review/backend test claude-review/auto-post
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTO_POST_DEFAULT_KINDS, AUTO_POST_FOOTER, type ClaudeFindingSeverity } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';

const DB_PATH = '/tmp/pierre-claude-auto-post.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let ctx: AgentContext;
let ap: typeof import('./auto-post.js');
let persist: typeof import('./persist.js');
let settings: typeof import('./auto-settings.js');
let wsId = 0;
let repoId = 0;
const users: Record<string, number> = {};
let prSeq = 0;

const postReview = vi.fn();
const postFinding = vi.fn();
const settle = vi.fn(async () => ({ visible: true }));
let live: { headSha: string; state: 'open' | 'closed'; draft: boolean; merged: boolean } | null = null;
let liveReviewList: Array<{ login: string | null; state: string }> | Error = [];
const liveReviews = vi.fn(async () => {
  if (liveReviewList instanceof Error) throw liveReviewList;
  return liveReviewList;
});
const deps = () => ({
  ...ap.defaultAutoPostDeps,
  livePr: vi.fn(async () => live ?? { headSha: 'HEAD', state: 'open' as const, draft: false, merged: false }),
  liveReviews,
  settle,
});

async function makePr(o: { author: string; state?: 'open' | 'merged' | 'closed'; draft?: boolean } = { author: 'me' }): Promise<number> {
  prSeq += 1;
  const [p] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: `PR_${prSeq}`,
      accountId: 1,
      repoId,
      number: prSeq,
      title: `pr ${prSeq}`,
      state: o.state ?? 'open',
      isDraft: o.draft ?? false,
      headSha: 'HEAD',
      authorId: users[o.author],
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
  path?: string;
  included?: boolean;
  priorFindingId?: number | null;
}
async function run(
  prId: number,
  findings: F[],
  trigger: 'auto' | 'manual' = 'auto',
  verdict: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES' = 'COMMENT',
): Promise<number> {
  const id = await persist.insertQueuedReview(ctx, prId, 'HEAD', 'claude-opus-5-5' as any, 1, [], trigger);
  await persist.saveReviewSuccess(ctx, id, {
    scope: 'diff_only',
    summary: 'Two problems in the parser.\n\n- a null check\n- a race',
    verdict,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    numTurns: 1,
    excludedFiles: [],
    findings: findings.map((f, i) => ({
      path: f.path ?? 'src/a.ts',
      line: 10 + i,
      side: 'RIGHT' as const,
      severity: f.severity,
      title: f.title,
      body: `${f.title} — body`,
      suggestion: null,
      diffHunk: null,
      anchored: true,
      fileInDiff: true,
      included: f.included,
      priorFindingId: f.priorFindingId ?? null,
    })),
  });
  return id;
}

const findingsOf = async (reviewId: number) =>
  (await db.select().from(schema.claudeReviewFindings).where((await import('drizzle-orm')).eq(schema.claudeReviewFindings.reviewId, reviewId)).execute()) as any[];

/** Answer every postReview with a GitHub review that took every finding inline. */
function githubTakesAll(): void {
  postReview.mockImplementation(async (a: any) => ({
    postedReviewId: 'R1',
    inlineFindingIds: a.includedFindings.map((f: any) => f.id),
    prComments: [],
    commentCount: a.includedFindings.length,
    prCommentCount: 0,
  }));
  let n = 0;
  postFinding.mockImplementation(async () => ({ commentId: `C${(n += 1)}`, postedCommentKind: 'pr_comment' }));
}

async function setPost(on: boolean, extra: Record<string, unknown> = {}): Promise<void> {
  await settings.setWorkspaceAutoReview(ctx, 1, wsId, { autoPost: { enabled: on, ...extra } as any });
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
  for (const login of ['me', 'alice', 'renovate[bot]']) {
    const [u] = await db
      .insert(schema.users)
      .values({ githubLogin: login, githubNodeId: `U_${login}`, isBot: login.endsWith('[bot]') })
      .returning()
      .execute();
    users[login] = u.id;
  }
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
    isPg: false,
    runTransaction: client.runTransaction,
    recordAiUsage: async () => {},
    accountIdOf: () => 1,
    review: { postReview, postFinding },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as any as AgentContext;
});

afterAll(async () => {
  await closeDb?.();
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
});

beforeEach(async () => {
  postReview.mockReset();
  postFinding.mockReset();
  settle.mockClear();
  live = null;
  liveReviewList = [];
  liveReviews.mockClear();
  githubTakesAll();
  await setPost(true, { scope: 'mine', kinds: { ...AUTO_POST_DEFAULT_KINDS } });
});

describe('the pure rules', () => {
  const base = { state: 'open' as const, isDraft: false, authorIsBot: false, authorIsMe: false, requestedOfMe: false };
  it('eligibility: open, not draft, not a bot, and yours under "mine"', () => {
    expect(ap.autoPostEligibility({ ...base, authorIsMe: true }, 'mine')).toBeNull();
    expect(ap.autoPostEligibility({ ...base, requestedOfMe: true }, 'mine')).toBeNull();
    expect(ap.autoPostEligibility(base, 'mine')).toBe('not_yours');
    expect(ap.autoPostEligibility(base, 'all')).toBeNull();
    expect(ap.autoPostEligibility({ ...base, state: 'merged', authorIsMe: true }, 'all')).toBe('not_open');
    expect(ap.autoPostEligibility({ ...base, state: 'closed' }, 'all')).toBe('not_open');
    expect(ap.autoPostEligibility({ ...base, isDraft: true }, 'all')).toBe('draft');
    expect(ap.autoPostEligibility({ ...base, authorIsBot: true }, 'all')).toBe('bot_author');
  });
  it('kinds: praise is never a kind', () => {
    expect(ap.kindOfSeverity('praise')).toBeNull();
    expect(ap.kindOfSeverity('question')).toBe('questions');
  });
  it('the body leads with the summary sentence, then the footer', () => {
    expect(ap.autoReviewBody('One sentence.\n\n- a\n- b', 2)).toBe(`One sentence.\n\n${AUTO_POST_FOOTER}`);
    expect(ap.autoReviewBody('- only bullets', 3)).toBe(`3 comments from Claude.\n\n${AUTO_POST_FOOTER}`);
  });
});

describe('off, manual, and which PRs', () => {
  it('OFF: nothing is posted and nothing is recorded', async () => {
    await setPost(false);
    const pr = await makePr({ author: 'me' });
    const id = await run(pr, [{ severity: 'blocker', title: 'Null deref' }]);
    expect((await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: id }, deps())).kind).toBe('off');
    expect(postReview).not.toHaveBeenCalled();
    expect((await persist.getClaudeReviewById(ctx, id, 1))?.autoPost).toBeNull();
  });

  it('a MANUAL run is never auto-posted', async () => {
    const pr = await makePr({ author: 'me' });
    const id = await run(pr, [{ severity: 'blocker', title: 'Null deref' }], 'manual');
    expect((await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: id }, deps())).kind).toBe('off');
    expect(postReview).not.toHaveBeenCalled();
  });

  it("'mine': your own PR posts; someone else's is skipped unless you are or were asked", async () => {
    const own = await makePr({ author: 'me' });
    const ownRun = await run(own, [{ severity: 'blocker', title: 'Own bug' }]);
    expect((await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: own, reviewId: ownRun }, deps())).kind).toBe('done');

    const theirs = await makePr({ author: 'alice' });
    const theirsRun = await run(theirs, [{ severity: 'blocker', title: 'Their bug' }]);
    expect(await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: theirs, reviewId: theirsRun }, deps())).toEqual({
      kind: 'skipped',
      reason: 'not_yours',
    });

    const asked = await makePr({ author: 'alice' });
    await db.insert(schema.reviewRequests).values({ prId: asked, userId: users.me }).execute();
    const askedRun = await run(asked, [{ severity: 'blocker', title: 'Asked bug' }]);
    expect((await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: asked, reviewId: askedRun }, deps())).kind).toBe('done');

    // GitHub dropped the request once a review landed: the HISTORY still makes it yours.
    const wasAsked = await makePr({ author: 'alice' });
    await db
      .insert(schema.reviewRequestEvents)
      .values({ prId: wasAsked, githubNodeId: `RRE_${wasAsked}`, kind: 'requested', occurredAt: new Date(), reviewerKind: 'user', reviewerUserId: users.me })
      .execute();
    const wasRun = await run(wasAsked, [{ severity: 'blocker', title: 'History bug' }]);
    expect((await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: wasAsked, reviewId: wasRun }, deps())).kind).toBe('done');
    expect(postReview).toHaveBeenCalledTimes(3);
  });

  it("'all' posts on anyone's human PR", async () => {
    await setPost(true, { scope: 'all' });
    const pr = await makePr({ author: 'alice' });
    const id = await run(pr, [{ severity: 'warning', title: 'Slow loop' }]);
    expect((await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: id }, deps())).kind).toBe('done');
  });

  it('never on merged, closed, draft or bot-authored PRs — synced or live', async () => {
    await setPost(true, { scope: 'all' });
    const cases: Array<[Parameters<typeof makePr>[0], string]> = [
      [{ author: 'me', state: 'merged' }, 'not_open'],
      [{ author: 'me', state: 'closed' }, 'not_open'],
      [{ author: 'me', draft: true }, 'draft'],
      [{ author: 'renovate[bot]' }, 'bot_author'],
    ];
    for (const [o, reason] of cases) {
      const pr = await makePr(o);
      const id = await run(pr, [{ severity: 'blocker', title: 'x' }]);
      expect(await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: id }, deps())).toEqual({ kind: 'skipped', reason });
    }
    // Synced open, but GitHub says it merged / went back to draft.
    for (const [l, reason] of [
      [{ headSha: 'HEAD', state: 'closed', draft: false, merged: true }, 'not_open'],
      [{ headSha: 'HEAD', state: 'open', draft: true, merged: false }, 'draft'],
    ] as const) {
      live = { ...l };
      const pr = await makePr({ author: 'me' });
      const id = await run(pr, [{ severity: 'blocker', title: 'y' }]);
      expect(await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: id }, deps())).toEqual({ kind: 'skipped', reason });
    }
    expect(postReview).not.toHaveBeenCalled();
    expect(postFinding).not.toHaveBeenCalled();
  });
});

describe('kinds, the one review, and what gets stamped', () => {
  it('blockers, warnings and questions in ONE COMMENT review; nits/praise/ignored never', async () => {
    const pr = await makePr({ author: 'me' });
    const id = await run(pr, [
      { severity: 'blocker', title: 'Null deref' },
      { severity: 'warning', title: 'Slow loop' },
      { severity: 'nit', title: 'Rename x' },
      { severity: 'praise', title: 'Nice' },
      { severity: 'question', title: 'Why retry twice?' },
      { severity: 'question', title: 'Is this async?' },
      { severity: 'blocker', title: 'Ignored one', included: false },
    ]);
    const out = await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: id }, deps());
    expect(out.kind).toBe('done');
    expect(postReview).toHaveBeenCalledTimes(1);
    const args = postReview.mock.calls[0]![0];
    expect(args.verdict).toBe('COMMENT');
    expect(args.dryRun).toBe(false);
    expect(args.body).toBe(`Two problems in the parser.\n\n${AUTO_POST_FOOTER}`);
    expect(args.includedFindings.map((f: any) => f.body)).toEqual([
      'Null deref — body',
      'Slow loop — body',
      'Why retry twice? — body',
      'Is this async? — body',
    ]);
    expect(args.includedFindings.every((f: any) => f.footer === AUTO_POST_FOOTER)).toBe(true);
    // Questions keep their anchor: the seam puts them inline.
    expect(args.includedFindings.find((f: any) => f.body.startsWith('Why'))).toMatchObject({ anchored: true, line: 14 });
    expect(postFinding).not.toHaveBeenCalled();

    const review = (await persist.getClaudeReviewById(ctx, id, 1))!;
    expect(review.autoPost).toMatchObject({ status: 'posted', error: null, postedCount: 4 });
    const posted = review.findings.filter((f) => f.postedAt != null).map((f) => f.title).sort();
    expect(posted).toEqual(['Is this async?', 'Null deref', 'Slow loop', 'Why retry twice?']);
    expect(review.findings.filter((f) => f.postedAt != null).every((f) => f.postedAuto === true)).toBe(true);
    expect(review.findings.filter((f) => f.postedAt == null).every((f) => f.postedAuto === false)).toBe(true);
    expect(review.postedReviewId).toBe('R1');
    expect(settle).toHaveBeenCalledWith(expect.objectContaining({ accountId: 1, prId: pr }));
  });

  it('nits post once switched on; questions stay off when switched off', async () => {
    await setPost(true, { kinds: { nits: true, questions: false } });
    const pr = await makePr({ author: 'me' });
    const id = await run(pr, [
      { severity: 'nit', title: 'Rename x' },
      { severity: 'question', title: 'Why?' },
    ]);
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: id }, deps());
    expect(postReview.mock.calls[0]![0].includedFindings.map((f: any) => f.body)).toEqual(['Rename x — body']);
    expect(postFinding).not.toHaveBeenCalled();
  });

  it('only questions ⇒ one COMMENT review carrying them', async () => {
    const pr = await makePr({ author: 'me' });
    const id = await run(pr, [{ severity: 'question', title: 'Why?' }]);
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: id }, deps());
    expect(postReview).toHaveBeenCalledTimes(1);
    expect(postReview.mock.calls[0]![0].verdict).toBe('COMMENT');
    expect(postReview.mock.calls[0]![0].includedFindings.map((f: any) => f.body)).toEqual(['Why? — body']);
    expect(postFinding).not.toHaveBeenCalled();
  });
});

describe('never twice', () => {
  it('a run is claimed once: a second call posts nothing', async () => {
    const pr = await makePr({ author: 'me' });
    const id = await run(pr, [{ severity: 'blocker', title: 'Null deref' }]);
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: id }, deps());
    expect((await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: id }, deps())).kind).toBe('already_claimed');
    expect(postReview).toHaveBeenCalledTimes(1);
  });

  it('an earlier run’s posted finding is not re-posted — by link or by fingerprint — and nothing new ⇒ no call', async () => {
    const pr = await makePr({ author: 'me' });
    const first = await run(pr, [
      { severity: 'blocker', title: 'Null deref in parse' },
      { severity: 'question', title: 'Why retry twice?' },
    ]);
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: first }, deps());
    const [blocker, question] = await findingsOf(first);
    postReview.mockClear();
    postFinding.mockClear();
    // A later (moved-head) run re-raises both: one linked, one only by its title.
    const second = await run(pr, [
      { severity: 'blocker', title: 'Null deref in parse', priorFindingId: blocker.id },
      { severity: 'question', title: 'Why do we retry twice?' },
      { severity: 'warning', title: 'A brand new problem' },
    ]);
    expect(question.postedAt).not.toBeNull();
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: second }, deps());
    expect(postReview.mock.calls[0]![0].includedFindings.map((f: any) => f.body)).toEqual(['A brand new problem — body']);
    expect(postFinding).not.toHaveBeenCalled();

    postReview.mockClear();
    const third = await run(pr, [{ severity: 'blocker', title: 'Null deref in parse' }]);
    expect(await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: third }, deps())).toEqual({
      kind: 'skipped',
      reason: 'already_posted',
    });
    expect(postReview).not.toHaveBeenCalled();
    const [thirdFinding] = await findingsOf(third);
    const rec = (await db.select().from(schema.claudeReviews).where((await import('drizzle-orm')).eq(schema.claudeReviews.id, third)).execute())[0].autoPost;
    expect(rec).toMatchObject({ status: 'skipped', reason: 'already_posted', alreadyPostedFindingIds: [thirdFinding.id] });
    expect((await persist.getClaudeReviewById(ctx, third, 1))?.autoPost).toMatchObject({ reason: 'already_posted', alreadyPostedCount: 1 });

    // The server's own left-out re-raise (`included: false` + a prior: the comment is already on
    // this commit) is a dedupe too — 'already_posted' with its id, never 'nothing_new'.
    const sameCommit = await run(pr, [{ severity: 'blocker', title: 'Null deref in parse', included: false, priorFindingId: blocker.id }]);
    const [left] = await findingsOf(sameCommit);
    expect(await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: sameCommit }, deps())).toEqual({
      kind: 'skipped',
      reason: 'already_posted',
    });
    const rec2 = (await db.select().from(schema.claudeReviews).where((await import('drizzle-orm')).eq(schema.claudeReviews.id, sameCommit)).execute())[0].autoPost;
    expect(rec2).toMatchObject({ reason: 'already_posted', alreadyPostedFindingIds: [left.id] });

    // Truly nothing to post (only a nit, nits off) stays 'nothing_new'.
    const fourth = await run(pr, [{ severity: 'nit', title: 'Rename' }]);
    expect(await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: fourth }, deps())).toEqual({
      kind: 'skipped',
      reason: 'nothing_new',
    });
  });

  it('a finding a PERSON posted earlier is not auto-posted again either', async () => {
    const pr = await makePr({ author: 'me' });
    const first = await run(pr, [{ severity: 'warning', title: 'Leaks a handle' }], 'manual');
    const [f] = await findingsOf(first);
    await persist.markFindingPosted(ctx, f.id, 'GH9', 'inline');
    const second = await run(pr, [{ severity: 'warning', title: 'Leaks a handle', priorFindingId: f.id }]);
    expect(await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: second }, deps())).toEqual({
      kind: 'skipped',
      reason: 'already_posted',
    });
    expect(postReview).not.toHaveBeenCalled();
  });

  it('an earlier run cut off mid-post counts as possibly posted (never retried)', async () => {
    const pr = await makePr({ author: 'me' });
    const first = await run(pr, [{ severity: 'blocker', title: 'Half posted' }]);
    const [f] = await findingsOf(first);
    await db
      .update(schema.claudeReviews)
      .set({ autoPost: { status: 'posting', at: new Date().toISOString(), reason: null, error: null, findingIds: [f.id], postedFindingIds: [], githubReviewId: null } })
      .where((await import('drizzle-orm')).eq(schema.claudeReviews.id, first))
      .execute();
    const second = await run(pr, [{ severity: 'blocker', title: 'Half posted' }]);
    expect(await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: second }, deps())).toEqual({
      kind: 'skipped',
      reason: 'already_posted',
    });
    // …and the manual Post buttons wait while it is fresh.
    expect(await ap.isAutoPostingNow(ctx, first)).toBe(true);
    expect(await ap.isAutoPostingNow(ctx, first, Date.now() + ap.AUTO_POST_LOCK_MS + 1)).toBe(false);
  });
});

describe('failures are recorded, never retried', () => {
  it('a GitHub error ⇒ failed + the error; nothing stamped; a second call does not retry', async () => {
    postReview.mockImplementation(async () => {
      throw new Error('GitHub REST POST -> 422: Unprocessable');
    });
    const pr = await makePr({ author: 'me' });
    const id = await run(pr, [{ severity: 'blocker', title: 'Null deref' }]);
    const out = await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: id }, deps());
    expect(out).toMatchObject({ kind: 'done', record: { status: 'failed', error: 'GitHub REST POST -> 422: Unprocessable' } });
    const review = (await persist.getClaudeReviewById(ctx, id, 1))!;
    expect(review.autoPost).toMatchObject({ status: 'failed', postedCount: 0 });
    expect(review.findings.every((f) => f.postedAt == null)).toBe(true);
    expect(settle).not.toHaveBeenCalled();
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: id }, deps());
    expect(postReview).toHaveBeenCalledTimes(1);
  });

  it('the review lands but a question does not ⇒ partial; the landed part stays stamped', async () => {
    // The seam's PR-level fallback is best-effort: a comment it could not post is simply absent.
    postReview.mockImplementation(async (a: any) => ({
      postedReviewId: 'R1',
      inlineFindingIds: a.includedFindings.filter((f: any) => !f.body.startsWith('Why')).map((f: any) => f.id),
      prComments: [],
      commentCount: 1,
      prCommentCount: 0,
    }));
    const pr = await makePr({ author: 'me' });
    const id = await run(pr, [
      { severity: 'blocker', title: 'Null deref' },
      { severity: 'question', title: 'Why?' },
    ]);
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: id }, deps());
    const review = (await persist.getClaudeReviewById(ctx, id, 1))!;
    expect(review.autoPost).toMatchObject({ status: 'partial', error: 'Some comments could not be posted.', postedCount: 1 });
    expect(review.findings.find((f) => f.title === 'Null deref')?.postedAuto).toBe(true);
    expect(review.findings.find((f) => f.title === 'Why?')?.postedAt).toBeNull();
  });

  it('a head that moved since the review ⇒ failed, nothing posted', async () => {
    live = { headSha: 'NEWER', state: 'open', draft: false, merged: false };
    const pr = await makePr({ author: 'me' });
    const id = await run(pr, [{ severity: 'blocker', title: 'Null deref' }]);
    const out = await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: id }, deps());
    expect(out).toMatchObject({ kind: 'done', record: { status: 'failed', error: 'The PR changed since this review.' } });
    expect(postReview).not.toHaveBeenCalled();
  });
});

describe('our own bodies are recognised as ours', () => {
  it('footer + marker on inline and PR-level bodies; isLimnPostedComment says ours only for our login', async () => {
    const { findingCommentBody, prLevelFindingBody, FINDING_COMMENT_MARKER } = await import('../post-review.js');
    const { isLimnPostedComment } = await import('../../db/review-threads-for-review.js');
    const inline = findingCommentBody({ body: 'b', editedBody: null, suggestion: 'x()' }, { footer: AUTO_POST_FOOTER });
    const question = prLevelFindingBody(
      { path: 'src/a.ts', line: 3, body: 'Why?', editedBody: null, suggestion: null },
      { outsideDiffNote: false, footer: AUTO_POST_FOOTER },
    );
    for (const body of [inline, question]) {
      expect(body.endsWith(`${AUTO_POST_FOOTER}\n\n${FINDING_COMMENT_MARKER}`)).toBe(true);
      expect(isLimnPostedComment({ body, databaseId: '1', authorLogin: 'Me' }, undefined, 'me')).toBe(true);
      expect(isLimnPostedComment({ body, databaseId: '1', authorLogin: 'alice' }, undefined, 'me')).toBe(false);
    }
    expect(question).not.toContain('isn’t part of this PR’s diff');
  });

  it('an auto-posted comment never counts as a new comment for an auto re-review', async () => {
    const { newestReviewCommentAt } = await import('../../db/review-threads-for-review.js');
    const { findingCommentBody } = await import('../post-review.js');
    const pr = await makePr({ author: 'alice' });
    const [th] = await db
      .insert(schema.reviewThreads)
      .values({ prId: pr, githubNodeId: `RT_${pr}`, path: 'src/a.ts', isResolved: false, derivedState: 'untouched', createdAt: new Date() })
      .returning()
      .execute();
    await db
      .insert(schema.reviewComments)
      .values({
        prId: pr,
        threadId: th.id,
        githubNodeId: `RC_${pr}`,
        databaseId: '77',
        authorId: users.me,
        body: findingCommentBody({ body: 'b', editedBody: null, suggestion: null }, { footer: AUTO_POST_FOOTER }),
        createdAt: new Date(),
      })
      .execute();
    expect((await newestReviewCommentAt(1, [pr], new Date(0))).has(pr)).toBe(false);
    // Not vacuous: a teammate's reply in the same thread DOES count.
    await db
      .insert(schema.reviewComments)
      .values({ prId: pr, threadId: th.id, githubNodeId: `RC2_${pr}`, databaseId: '78', authorId: users.alice, body: 'Fixed?', createdAt: new Date() })
      .execute();
    expect((await newestReviewCommentAt(1, [pr], new Date(0))).has(pr)).toBe(true);
  });
});

describe("'mine' also counts a PR you reviewed or commented on", () => {
  it('pure: participation makes it yours', () => {
    const base = { state: 'open' as const, isDraft: false, authorIsBot: false, authorIsMe: false, requestedOfMe: false };
    expect(ap.autoPostEligibility({ ...base, participatedByMe: true }, 'mine')).toBeNull();
    expect(ap.autoPostEligibility({ ...base, participatedByMe: false }, 'mine')).toBe('not_yours');
  });

  it('a review, a review comment or a PR comment by you each count; a teammate’s does not', async () => {
    const make = async () => {
      const pr = await makePr({ author: 'alice' });
      return { pr, id: await run(pr, [{ severity: 'blocker', title: `Bug ${pr}` }]) };
    };
    // A teammate's comment does not make it yours.
    const other = await make();
    await db.insert(schema.prComments).values({ prId: other.pr, githubNodeId: `IC_o${other.pr}`, authorId: users.alice, body: 'hi', createdAt: new Date() }).execute();
    expect(await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: other.pr, reviewId: other.id }, deps())).toEqual({ kind: 'skipped', reason: 'not_yours' });

    const reviewed = await make();
    await db
      .insert(schema.reviews)
      .values({ prId: reviewed.pr, githubNodeId: `RV_${reviewed.pr}`, authorId: users.me, state: 'commented', submittedAt: new Date() })
      .execute();
    const commented = await make();
    await db.insert(schema.prComments).values({ prId: commented.pr, githubNodeId: `IC_${commented.pr}`, authorId: users.me, body: 'hm', createdAt: new Date() }).execute();
    const threaded = await make();
    const [th] = await db
      .insert(schema.reviewThreads)
      .values({ prId: threaded.pr, githubNodeId: `RT_m${threaded.pr}`, path: 'src/a.ts', isResolved: false, derivedState: 'untouched', createdAt: new Date() })
      .returning()
      .execute();
    await db
      .insert(schema.reviewComments)
      .values({ prId: threaded.pr, threadId: th.id, githubNodeId: `RC_m${threaded.pr}`, authorId: users.me, body: 'why?', createdAt: new Date() })
      .execute();
    for (const x of [reviewed, commented, threaded]) {
      expect((await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: x.pr, reviewId: x.id }, deps())).kind).toBe('done');
    }
    expect(postReview).toHaveBeenCalledTimes(3);
  });
});

describe('auto verdict', () => {
  const f = (severity: ClaudeFindingSeverity, o: { included?: boolean; story?: boolean } = {}) => ({
    severity,
    included: o.included ?? true,
    story: o.story ? { index: 0, ref: 'AC1' } : null,
  });

  it('is stricter than Claude: blocker ⇒ REQUEST_CHANGES; APPROVE only with no blocker or warning', () => {
    expect(ap.autoVerdictFor('APPROVE', [])).toBe('APPROVE');
    expect(ap.autoVerdictFor('APPROVE', [f('nit'), f('question')])).toBe('APPROVE');
    expect(ap.autoVerdictFor('APPROVE', [f('warning')])).toBe('COMMENT');
    expect(ap.autoVerdictFor('APPROVE', [f('blocker')])).toBe('REQUEST_CHANGES');
    expect(ap.autoVerdictFor('COMMENT', [f('blocker')])).toBe('REQUEST_CHANGES');
    expect(ap.autoVerdictFor('COMMENT', [])).toBe('COMMENT');
    expect(ap.autoVerdictFor('REQUEST_CHANGES', [f('warning')])).toBe('COMMENT');
    expect(ap.autoVerdictFor(null, [])).toBe('COMMENT');
    // Ignored and story findings do not count.
    expect(ap.autoVerdictFor('APPROVE', [f('blocker', { included: false }), f('warning', { story: true })])).toBe('APPROVE');
    // …but the server's own left-out RE-RAISE (`included: false` with a prior, never posted) is an
    // open issue, not an ignore: it still counts.
    expect(ap.autoVerdictFor('APPROVE', [{ ...f('blocker', { included: false }), postedAt: null, priorFindingId: 7 }])).toBe('REQUEST_CHANGES');
  });

  it('the gate: own PR and a standing verdict hold it to COMMENT; unreadable never guesses', () => {
    expect(ap.verdictGate('APPROVE', { authorIsMe: true, ownLatest: 'none' })).toEqual({ wanted: 'APPROVE', submitted: 'COMMENT', heldReason: 'own_pr' });
    expect(ap.verdictGate('APPROVE', { authorIsMe: false, ownLatest: 'none' })).toEqual({ wanted: 'APPROVE', submitted: 'APPROVE', heldReason: null });
    expect(ap.verdictGate('REQUEST_CHANGES', { authorIsMe: false, ownLatest: 'COMMENTED' }).submitted).toBe('REQUEST_CHANGES');
    for (const s of ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'] as const) {
      expect(ap.verdictGate('APPROVE', { authorIsMe: false, ownLatest: s })).toEqual({ wanted: 'APPROVE', submitted: 'COMMENT', heldReason: 'prior_review' });
    }
    expect(ap.verdictGate('APPROVE', { authorIsMe: false, ownLatest: 'unreadable' }).heldReason).toBe('reviews_unreadable');
    // The latest of YOUR submitted reviews decides; pending and other people's are ignored.
    const list = [
      { login: 'Me', state: 'APPROVED' },
      { login: 'alice', state: 'CHANGES_REQUESTED' },
      { login: 'me', state: 'COMMENTED' },
      { login: 'me', state: 'PENDING' },
    ];
    expect(ap.ownLatestReview(list, 'me')).toBe('COMMENTED');
    expect(ap.ownLatestReview(list.slice(0, 2), 'me')).toBe('APPROVED');
    expect(ap.ownLatestReview([], 'me')).toBe('none');
    expect(ap.ownLatestReview(list, null)).toBe('unreadable');
  });

  it('off ⇒ always COMMENT, and no live review read', async () => {
    await setPost(true, { scope: 'all' });
    const pr = await makePr({ author: 'alice' });
    const id = await run(pr, [{ severity: 'blocker', title: 'Bug' }]);
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: id }, deps());
    expect(postReview.mock.calls[0]![0].verdict).toBe('COMMENT');
    expect(liveReviews).not.toHaveBeenCalled();
    expect((await persist.getClaudeReviewById(ctx, id, 1))?.autoPost?.verdict).toBeUndefined();
  });

  it('a blocker on a teammate’s PR ⇒ REQUEST_CHANGES, recorded', async () => {
    await setPost(true, { scope: 'all', autoVerdict: true });
    const pr = await makePr({ author: 'alice' });
    const id = await run(pr, [{ severity: 'blocker', title: 'Bug' }]);
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: id }, deps());
    expect(postReview.mock.calls[0]![0].verdict).toBe('REQUEST_CHANGES');
    expect(liveReviews).toHaveBeenCalledTimes(1);
    expect((await persist.getClaudeReviewById(ctx, id, 1))?.autoPost).toMatchObject({
      status: 'posted',
      verdict: { wanted: 'REQUEST_CHANGES', submitted: 'REQUEST_CHANGES', heldReason: null },
    });
  });

  it('a clean approved run APPROVES even with nothing to post', async () => {
    await setPost(true, { scope: 'all', autoVerdict: true });
    const pr = await makePr({ author: 'alice' });
    const id = await run(pr, [{ severity: 'nit', title: 'Rename' }], 'auto', 'APPROVE');
    const out = await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: id }, deps());
    expect(out.kind).toBe('done');
    const args = postReview.mock.calls[0]![0];
    expect(args.verdict).toBe('APPROVE');
    expect(args.includedFindings).toEqual([]);
    expect(args.body.endsWith(AUTO_POST_FOOTER)).toBe(true);
    expect((await persist.getClaudeReviewById(ctx, id, 1))?.autoPost).toMatchObject({ status: 'posted', postedCount: 0 });
    expect(settle).toHaveBeenCalled();
  });

  it('your own PR: never approves or requests changes, and does not read reviews', async () => {
    await setPost(true, { autoVerdict: true });
    const pr = await makePr({ author: 'me' });
    const id = await run(pr, [{ severity: 'blocker', title: 'Own bug' }]);
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: id }, deps());
    expect(postReview.mock.calls[0]![0].verdict).toBe('COMMENT');
    expect(liveReviews).not.toHaveBeenCalled();
    expect((await persist.getClaudeReviewById(ctx, id, 1))?.autoPost?.verdict).toEqual({
      wanted: 'REQUEST_CHANGES',
      submitted: 'COMMENT',
      heldReason: 'own_pr',
    });
    // Nothing to post on your own clean PR ⇒ a skip, not an empty COMMENT review.
    postReview.mockClear();
    const clean = await makePr({ author: 'me' });
    const cleanRun = await run(clean, [], 'auto', 'APPROVE');
    expect(await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: clean, reviewId: cleanRun }, deps())).toEqual({ kind: 'skipped', reason: 'nothing_new' });
    expect(postReview).not.toHaveBeenCalled();
  });

  it('your standing APPROVED (read live, even when the synced table says nothing) holds it to COMMENT', async () => {
    await setPost(true, { scope: 'all', autoVerdict: true });
    liveReviewList = [
      { login: 'me', state: 'COMMENTED' },
      { login: 'ME', state: 'APPROVED' },
    ];
    const pr = await makePr({ author: 'alice' });
    const id = await run(pr, [{ severity: 'blocker', title: 'Late bug' }]);
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: id }, deps());
    expect(postReview.mock.calls[0]![0].verdict).toBe('COMMENT');
    expect((await persist.getClaudeReviewById(ctx, id, 1))?.autoPost?.verdict?.heldReason).toBe('prior_review');

    // With nothing to post, a held verdict posts nothing at all.
    postReview.mockClear();
    const pr2 = await makePr({ author: 'alice' });
    const id2 = await run(pr2, [], 'auto', 'APPROVE');
    expect(await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr2, reviewId: id2 }, deps())).toEqual({ kind: 'skipped', reason: 'nothing_new' });
    expect(postReview).not.toHaveBeenCalled();
    expect((await persist.getClaudeReviewById(ctx, id2, 1))?.autoPost?.verdict?.heldReason).toBe('prior_review');
  });

  it('the live read fails ⇒ COMMENT, recorded as unreadable', async () => {
    await setPost(true, { scope: 'all', autoVerdict: true });
    liveReviewList = new Error('GitHub 502');
    const pr = await makePr({ author: 'alice' });
    const id = await run(pr, [{ severity: 'blocker', title: 'Bug' }]);
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: id }, deps());
    expect(postReview.mock.calls[0]![0].verdict).toBe('COMMENT');
    expect((await persist.getClaudeReviewById(ctx, id, 1))?.autoPost?.verdict?.heldReason).toBe('reviews_unreadable');
  });
});

describe('auto resolve', () => {
  const reply = vi.fn(async (_a: number, _node: string, _body: string) => ({ commentId: 'RPL1' as string | null }));
  const resolve = vi.fn(async () => {});
  const stamp = vi.fn(async () => {});
  const notePrChanged = vi.fn(async () => {});
  const rdeps = () => ({ reply, resolve, stamp, notePrChanged });

  beforeEach(() => {
    for (const m of [reply, resolve, stamp, notePrChanged]) m.mockClear();
    reply.mockImplementation(async () => ({ commentId: 'RPL1' }));
    resolve.mockImplementation(async () => {});
  });

  /** A first auto run whose blocker is posted inline (inside a review: no comment id kept), + its synced thread. */
  async function postedFinding(o: { threadAuthor?: string; marker?: boolean } = {}) {
    const { findingCommentBody } = await import('../post-review.js');
    const pr = await makePr({ author: 'me' });
    const first = await run(pr, [{ severity: 'blocker', title: 'Null deref', path: 'src/p.ts' }]);
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: first }, deps(), rdeps());
    const [f] = await findingsOf(first);
    expect(f.postedAt).not.toBeNull();
    const [th] = await db
      .insert(schema.reviewThreads)
      .values({ prId: pr, githubNodeId: `RT_r${pr}`, path: 'src/p.ts', isResolved: false, derivedState: 'likely_addressed', createdAt: new Date() })
      .returning()
      .execute();
    const body = findingCommentBody({ body: f.body, editedBody: null, suggestion: null }, { footer: AUTO_POST_FOOTER });
    await db
      .insert(schema.reviewComments)
      .values({
        prId: pr,
        threadId: th.id,
        githubNodeId: `RC_r${pr}`,
        databaseId: `9${pr}`,
        authorId: users[o.threadAuthor ?? 'me'],
        body: o.marker === false ? f.body : body,
        createdAt: new Date(),
      })
      .execute();
    return { pr, first, finding: f, thread: th };
  }

  async function followUpRun(pr: number, first: number, priorFindingId: number, status: 'addressed' | 'no_longer_applies' | 'not_addressed') {
    const id = await persist.insertQueuedReview(ctx, pr, 'abcdef1234567', 'claude-opus-5-5' as any, 1, [], 'auto');
    await persist.saveReviewSuccess(ctx, id, {
      scope: 'diff_only',
      summary: 'Looks fixed.',
      verdict: 'COMMENT',
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
      numTurns: 1,
      excludedFiles: [],
      findings: [],
      followUp: {
        priorReviewId: first,
        priorHeadSha: 'HEAD',
        headMoved: true,
        changesSinceShown: true,
        items: [
          { ref: 'P1', priorFindingId, sent: true, carried: false, status, explanation: null, path: 'src/p.ts', line: 10, side: 'RIGHT', severity: 'blocker', title: 'Null deref' },
        ],
      },
    } as any);
    return id;
  }

  it('pure: the reply names the short sha and carries the footer + marker', async () => {
    const ar = await import('./auto-resolve.js');
    const { isLimnPostedComment } = await import('../../db/review-threads-for-review.js');
    const b = ar.autoResolveReplyBody('addressed', 'abcdef1234567');
    expect(b.startsWith('Addressed in abcdef1.')).toBe(true);
    expect(ar.autoResolveReplyBody('no_longer_applies', 'abcdef1234567').startsWith('No longer applies as of abcdef1.')).toBe(true);
    expect(b).toContain(AUTO_POST_FOOTER);
    expect(isLimnPostedComment({ body: b, databaseId: null, authorLogin: 'me' }, undefined, 'me')).toBe(true);
    expect(ar.resolvableStatus('partly_addressed')).toBeNull();
  });

  it('off by default: nothing is replied or resolved', async () => {
    const { pr, first, finding } = await postedFinding();
    const id = await followUpRun(pr, first, finding.id, 'addressed');
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: id }, deps(), rdeps());
    expect(reply).not.toHaveBeenCalled();
  });

  it('replies, THEN resolves, stamps, records — once only', async () => {
    await setPost(true, { autoResolve: true });
    const { pr, first, finding, thread } = await postedFinding();
    const order: string[] = [];
    reply.mockImplementation(async () => {
      order.push('reply');
      return { commentId: 'RPL1' };
    });
    resolve.mockImplementation(async () => {
      order.push('resolve');
    });
    const id = await followUpRun(pr, first, finding.id, 'addressed');
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: id }, deps(), rdeps());
    expect(order).toEqual(['reply', 'resolve']);
    expect(reply.mock.calls[0]![1]).toBe(thread.githubNodeId);
    expect(String(reply.mock.calls[0]![2])).toMatch(/^Addressed in abcdef1\./);
    expect(stamp).toHaveBeenCalledWith(thread.id, 1);
    expect(notePrChanged).toHaveBeenCalledWith(1, [pr]);
    const [row] = (await findingsOf(first)).filter((r: any) => r.id === finding.id);
    expect(row.autoResolvedAt).not.toBeNull();
    expect(row.autoResolve).toMatchObject({ status: 'resolved', outcome: 'addressed', byReviewId: id, replyCommentId: 'RPL1', error: null });
    expect((await persist.getClaudeReviewById(ctx, first, 1))?.findings[0]?.autoResolve?.status).toBe('resolved');

    // A later run judging it again (even with the local thread still unresolved) never repeats it.
    const again = await followUpRun(pr, id, finding.id, 'addressed');
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: again }, deps(), rdeps());
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it('follows an unposted re-raise back to the inline-posted ancestor and resolves ITS thread', async () => {
    await setPost(true, { autoResolve: true });
    const { pr, first, finding, thread } = await postedFinding();
    // Run 2 raises it again; the dedupe never posts the re-raise (no auto post is run for it).
    const mid = await run(pr, [{ severity: 'blocker', title: 'Null deref', path: 'src/p.ts', priorFindingId: finding.id }]);
    const [reraise] = await findingsOf(mid);
    expect(reraise.postedAt).toBeNull();
    // Run 3's follow-up names the RE-RAISE, not the posted original.
    const id = await followUpRun(pr, mid, reraise.id, 'addressed');
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: id }, deps(), rdeps());
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]![1]).toBe(thread.githubNodeId);
    const [row] = (await findingsOf(first)).filter((r: any) => r.id === finding.id);
    expect(row.autoResolve).toMatchObject({ status: 'resolved', byReviewId: id });
  });

  it('a failed resolve is recorded with the reply id and never retried', async () => {
    await setPost(true, { autoResolve: true });
    const { pr, first, finding } = await postedFinding();
    resolve.mockImplementation(async () => {
      throw new Error('Resource not accessible by integration');
    });
    const id = await followUpRun(pr, first, finding.id, 'no_longer_applies');
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: id }, deps(), rdeps());
    expect(String(reply.mock.calls[0]![2])).toMatch(/^No longer applies as of abcdef1\./);
    const [row] = (await findingsOf(first)).filter((r: any) => r.id === finding.id);
    expect(row.autoResolvedAt).toBeNull();
    expect(row.autoResolve).toMatchObject({ status: 'failed', replyCommentId: 'RPL1', error: 'Resource not accessible by integration' });
    expect(stamp).not.toHaveBeenCalled();
    const again = await followUpRun(pr, id, finding.id, 'no_longer_applies');
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: again }, deps(), rdeps());
    expect(reply).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('a failed reply is recorded and the thread is not resolved', async () => {
    await setPost(true, { autoResolve: true });
    const { pr, first, finding } = await postedFinding();
    reply.mockImplementation(async () => {
      throw new Error('403');
    });
    const id = await followUpRun(pr, first, finding.id, 'addressed');
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: pr, reviewId: id }, deps(), rdeps());
    expect(resolve).not.toHaveBeenCalled();
    const [row] = (await findingsOf(first)).filter((r: any) => r.id === finding.id);
    expect(row.autoResolve).toMatchObject({ status: 'failed', replyCommentId: null, error: '403' });
  });

  it('only Limn’s own threads, only addressed / no longer applies', async () => {
    await setPost(true, { autoResolve: true });
    // Not addressed ⇒ nothing.
    const a = await postedFinding();
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: a.pr, reviewId: await followUpRun(a.pr, a.first, a.finding.id, 'not_addressed') }, deps(), rdeps());
    // A thread someone else started with the same words ⇒ not ours.
    const b = await postedFinding({ threadAuthor: 'alice' });
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: b.pr, reviewId: await followUpRun(b.pr, b.first, b.finding.id, 'addressed') }, deps(), rdeps());
    // Our login but no Limn marker ⇒ not ours either.
    const c = await postedFinding({ marker: false });
    await ap.maybeAutoPostReview(ctx, { accountId: 1, prId: c.pr, reviewId: await followUpRun(c.pr, c.first, c.finding.id, 'addressed') }, deps(), rdeps());
    expect(reply).not.toHaveBeenCalled();
    for (const x of [a, b, c]) {
      const [row] = (await findingsOf(x.first)).filter((r: any) => r.id === x.finding.id);
      expect(row.autoResolve).toBeNull();
    }
  });
});
