// OTHER REVIEWERS' THREADS over the REAL core client and migrations (the persist.test.ts pattern).
// What this pins:
//   1. ⚠ OWN-COMMENT EXCLUSION — the ONE predicate (`isLimnPostedComment`): a comment Limn posted (by
//      its text, its stored GitHub id, or the hidden marker — AND authored by the account's own login) is never a "new comment", and a thread
//      rooted on one is never sent as another reviewer's thread. Otherwise a review re-triggers
//      itself the moment its findings are posted.
//   2. `getAutoReviewCandidates` offers an UNCHANGED head for re-review when a qualifying comment (a
//      person's or a bot's, in an unresolved thread) is newer than what every run at that head saw
//      (`comments_through`, else the run's start) — and nothing otherwise.
//   3. `isAutoReReviewSettled` — the waiting item's re-check — applies the same rule.
//   4. The thread assessments round-trip on the ClaudeReview wire; an older row reads as null.
//   5. AI Fix's review seed adds the review's valid, unaddressed threads — for THIS PR's review only.
//
//   pnpm --filter @pierre-review/backend test claude-review/threads-db
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClaudeThreadAssessment } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';

const DB_PATH = '/tmp/pierre-claude-review-threads-db.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let q: typeof import('../../db/queries.js');
let threadsDb: typeof import('../../db/review-threads-for-review.js');
let persist: typeof import('./persist.js');
let aiFix: typeof import('../../coding/ai-fix/manager.js');
let ctx: AgentContext;
let workspaceId = 0;

const HOUR = 60 * 60 * 1000;
const now = Math.floor(Date.now() / 1000) * 1000;
const FLOOR = now - 10 * 24 * HOUR;
const OPENED = FLOOR + HOUR;
const RUN = now - 6 * HOUR; // the run's start
const AFTER = RUN + HOUR;
const BEFORE = RUN - HOUR;

let repoId = 0;
let aliceId = 0;
let bobId = 0;
let botId = 0;
let viewerId = 0;
let prNumber = 1;
let node = 1;
const pr: Record<string, number> = {};

async function seedPr(key: string): Promise<number> {
  const [row] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: `PR_t_${key}`,
      accountId: 1,
      repoId,
      number: prNumber++,
      title: key,
      state: 'open',
      isDraft: false,
      authorId: aliceId,
      headSha: `head_${key}`,
      openedAt: new Date(OPENED),
      updatedAt: new Date(OPENED),
    })
    .returning()
    .execute();
  pr[key] = row.id;
  return row.id;
}

async function run(
  prId: number,
  headSha: string,
  opts: { status?: string; createdAt?: number; commentsThrough?: number | null } = {},
): Promise<number> {
  const [row] = await db
    .insert(schema.claudeReviews)
    .values({
      accountId: 1,
      prId,
      headSha,
      status: opts.status ?? 'succeeded',
      model: 'claude-opus-5-5',
      trigger: 'auto',
      createdAt: new Date(opts.createdAt ?? RUN),
      commentsThrough: opts.commentsThrough != null ? new Date(opts.commentsThrough) : null,
    })
    .returning()
    .execute();
  return row.id;
}

async function postedFinding(reviewId: number, body: string, githubCommentId: string | null = null): Promise<void> {
  await db
    .insert(schema.claudeReviewFindings)
    .values({
      reviewId,
      path: 'src/a.ts',
      line: 3,
      side: 'RIGHT',
      severity: 'warning',
      title: 't',
      body,
      anchored: true,
      fileInDiff: true,
      included: true,
      postedAt: new Date(RUN + 30 * 60 * 1000),
      githubCommentId,
    })
    .execute();
}

async function threadWith(
  prId: number,
  comments: Array<{ authorId: number; at: number; body: string; databaseId?: string }>,
  opts: { resolved?: boolean; path?: string } = {},
): Promise<number> {
  const [t] = await db
    .insert(schema.reviewThreads)
    .values({
      githubNodeId: `RT_${node++}`,
      prId,
      path: opts.path ?? 'src/a.ts',
      line: 3,
      isResolved: opts.resolved ?? false,
      derivedState: opts.resolved ? 'resolved' : 'untouched',
      createdAt: new Date(comments[0]!.at),
    })
    .returning()
    .execute();
  for (const c of comments) {
    await db
      .insert(schema.reviewComments)
      .values({
        githubNodeId: `RC_${node++}`,
        threadId: t.id,
        prId,
        authorId: c.authorId,
        body: c.body,
        databaseId: c.databaseId ?? null,
        createdAt: new Date(c.at),
      })
      .execute();
  }
  return t.id;
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  q = await import('../../db/queries.js');
  threadsDb = await import('../../db/review-threads-for-review.js');
  persist = await import('./persist.js');
  aiFix = await import('../../coding/ai-fix/manager.js');
  ctx = {
    db,
    schema,
    isPg: false,
    runTransaction: client.runTransaction,
    recordAiUsage: async () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as any as AgentContext;

  const user = async (login: string, isBot = false): Promise<number> => {
    const [u] = await db
      .insert(schema.users)
      .values({ githubLogin: login, githubNodeId: `U_${login}`, isBot })
      .returning()
      .execute();
    return u.id;
  };
  // The account's own login — the author half of `isLimnPostedComment` (Limn posts as the reader).
  await db
    .insert(schema.accounts)
    .values({ id: 1, githubUserId: 'U_viewer-me', githubLogin: 'viewer-me', isLocal: true })
    .onConflictDoUpdate({ target: schema.accounts.id, set: { githubLogin: 'viewer-me' } })
    .execute();
  viewerId = await user('viewer-me');
  aliceId = await user('alice-dev');
  bobId = await user('bob-dev');
  botId = await user('coderabbitai[bot]', true);
  const [repo] = await db
    .insert(schema.repos)
    .values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_t', createdAt: new Date(FLOOR - HOUR) })
    .returning()
    .execute();
  repoId = repo.id;

  // A person commented after the run.
  await run(await seedPr('human'), 'head_human');
  await threadWith(pr.human!, [{ authorId: bobId, at: AFTER, body: 'This leaks the handle.' }]);
  // Another review bot commented after the run.
  await run(await seedPr('bot'), 'head_bot');
  await threadWith(pr.bot!, [{ authorId: botId, at: AFTER, body: 'Potential null dereference.' }]);
  // Limn's own posted finding landed after the run, by TEXT (Post review stores no comment id).
  {
    const id = await run(await seedPr('own-body'), 'head_own-body');
    await postedFinding(id, 'Null deref on line 3.');
    await threadWith(pr['own-body']!, [
      { authorId: viewerId, at: AFTER, body: 'Null deref on line 3.\n\n```suggestion\nif (x) y()\n```' },
    ]);
  }
  // …by its stored GitHub id (the single-comment route), whatever the text says.
  {
    const id = await run(await seedPr('own-id'), 'head_own-id');
    await postedFinding(id, 'Something else entirely.', '987654');
    await threadWith(pr['own-id']!, [{ authorId: viewerId, at: AFTER, body: 'Reworded on GitHub.', databaseId: '987654' }]);
  }
  // …by the hidden marker.
  await run(await seedPr('marker'), 'head_marker');
  await threadWith(pr.marker!, [{ authorId: viewerId, at: AFTER, body: 'x\n<!-- pierre:claude-review v=1 -->' }]);
  // …and the finding marker every posted comment now carries — even after an edit on GitHub.
  await run(await seedPr('finding-marker'), 'head_finding-marker');
  await threadWith(pr['finding-marker']!, [
    { authorId: viewerId, at: AFTER, body: 'Edited on GitHub.\n\n<!-- pierre:claude-review-finding v=1 -->' },
  ]);
  // The marker from SOMEONE ELSE (a teammate's own Limn, or pasted text) is another reviewer's comment.
  await run(await seedPr('foreign-marker'), 'head_foreign-marker');
  await threadWith(pr['foreign-marker']!, [
    { authorId: bobId, at: AFTER, body: 'Mine.\n\n<!-- pierre:claude-review-finding v=1 -->' },
  ]);
  // A comment from BEFORE the run started: the run saw it.
  await run(await seedPr('before'), 'head_before');
  await threadWith(pr.before!, [{ authorId: bobId, at: BEFORE, body: 'old' }]);
  // Covered by `comments_through`.
  await run(await seedPr('covered'), 'head_covered', { commentsThrough: AFTER });
  await threadWith(pr.covered!, [{ authorId: bobId, at: AFTER, body: 'seen' }]);
  // Synced LATE: older than the run's start but newer than what it saw — still new.
  await run(await seedPr('late-sync'), 'head_late-sync', { commentsThrough: BEFORE - HOUR });
  await threadWith(pr['late-sync']!, [{ authorId: bobId, at: BEFORE, body: 'arrived late' }]);
  // A comment in a RESOLVED thread does not count.
  await run(await seedPr('resolved'), 'head_resolved');
  await threadWith(pr.resolved!, [{ authorId: bobId, at: AFTER, body: 'done' }], { resolved: true });
  // A run in flight: nothing offered.
  await run(await seedPr('in-flight'), 'head_in-flight');
  await run(pr['in-flight']!, 'head_in-flight', { status: 'running', createdAt: RUN + 1000 });
  await threadWith(pr['in-flight']!, [{ authorId: bobId, at: AFTER, body: 'x' }]);
  // A human REPLY inside Limn's own thread is new (the root is Limn's, the reply is not).
  {
    const id = await run(await seedPr('reply-to-own'), 'head_reply-to-own');
    await postedFinding(id, 'Missing await.');
    await threadWith(pr['reply-to-own']!, [
      { authorId: viewerId, at: AFTER, body: 'Missing await.' },
      { authorId: aliceId, at: AFTER + 60_000, body: 'Fixed, thanks.' },
    ]);
  }

  workspaceId = (await q.resolveWorkspaceScope(1, null)).workspaceId;
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('getAutoReviewCandidates — re-review on new review comments', () => {
  it('offers an unchanged head only when a qualifying comment is newer than what the run saw', async () => {
    const res = (await q.getAutoReviewCandidates(1, workspaceId, {
      openedSinceMs: FLOOR,
      dayStartMs: now - 24 * HOUR,
      limit: 50,
    }))!;
    const offered = new Map(res.reReview.map((r) => [r.prId, r]));
    expect(offered.get(pr.human!)).toEqual({ prId: pr.human, headSha: 'head_human', commentsAtMs: AFTER, reason: 'comments' });
    expect(offered.get(pr.bot!)?.commentsAtMs).toBe(AFTER);
    expect(offered.get(pr['late-sync']!)?.commentsAtMs).toBe(BEFORE);
    expect(offered.get(pr['reply-to-own']!)?.commentsAtMs).toBe(AFTER + 60_000);
    expect(offered.get(pr['foreign-marker']!)?.commentsAtMs).toBe(AFTER);
    for (const k of ['own-body', 'own-id', 'marker', 'finding-marker', 'before', 'covered', 'resolved', 'in-flight']) {
      expect([k, offered.has(pr[k]!)]).toEqual([k, false]);
    }
  });
});

describe('isAutoReReviewSettled — the waiting item’s re-check', () => {
  it('a moved head is settled by any row at it; new comments only by a run that covered them', async () => {
    expect(await persist.isAutoReReviewSettled(ctx, pr.human!, 1, 'head_human', null)).toBe(true);
    expect(await persist.isAutoReReviewSettled(ctx, pr.human!, 1, 'other_head', null)).toBe(false);
    expect(await persist.isAutoReReviewSettled(ctx, pr.human!, 1, 'head_human', AFTER)).toBe(false);
    expect(await persist.isAutoReReviewSettled(ctx, pr.covered!, 1, 'head_covered', AFTER)).toBe(true);
    // Another tenant's PR: no rows, never settled by someone else's run.
    expect(await persist.isAutoReReviewSettled(ctx, pr.human!, 2, 'head_human', null)).toBe(false);
  });
});

describe('loadReviewThreadsForReview', () => {
  it('sends other reviewers’ threads, never one rooted on Limn’s own finding, nor a resolved one', async () => {
    const prId = await seedPr('load');
    const id = await run(prId, 'head_load');
    await postedFinding(id, 'Own finding body.');
    const human = await threadWith(prId, [
      { authorId: bobId, at: AFTER, body: 'Rename this.', databaseId: '555' },
      { authorId: aliceId, at: AFTER + 600_000, body: 'Will do.' },
    ]);
    const bot = await threadWith(prId, [{ authorId: botId, at: AFTER + 2000, body: 'Possible race.' }], { path: 'src/b.ts' });
    await threadWith(prId, [
      { authorId: viewerId, at: AFTER + 3000, body: 'Own finding body.' },
      { authorId: aliceId, at: AFTER + 700_000, body: 'Disagree.' },
    ]);
    await threadWith(prId, [{ authorId: bobId, at: AFTER + 5000, body: 'resolved one' }], { resolved: true });
    await db
      .insert(schema.commits)
      .values({ sha: 'c1', prId, authorId: aliceId, committedAt: new Date(AFTER + 300_000) })
      .execute();

    const out = await threadsDb.loadReviewThreadsForReview(1, prId);
    expect(out.threads.map((t) => t.threadId)).toEqual([human, bot]);
    const h = out.threads[0]!;
    expect(h.comments.map((c) => c.authorLogin)).toEqual(['bob-dev', 'alice-dev']);
    expect(h.url).toBe(`https://github.com/acme/api/pull/${prNumber - 1}#discussion_r555`);
    expect(h.commitsAfterFirstComment).toBe(1);
    expect(h.commitsAfterLastComment).toBe(0);
    expect(out.threads[1]!.comments[0]!.authorIsBot).toBe(true);
    // The reply inside Limn's own thread is the newest qualifying comment.
    expect(out.newestCommentAt?.getTime()).toBe(AFTER + 700_000);
    // Another tenant reads nothing.
    expect((await threadsDb.loadReviewThreadsForReview(2, prId)).threads).toEqual([]);
  });
});

const assessment = (threadId: number, over: Partial<ClaudeThreadAssessment> = {}): ClaudeThreadAssessment => ({
  ref: 'R1',
  threadId,
  sent: true,
  carried: false,
  authorLogin: 'bob-dev',
  authorIsBot: false,
  path: 'src/a.ts',
  line: 3,
  excerpt: 'This leaks the handle.',
  commentCount: 1,
  lastCommentAt: new Date(AFTER).toISOString(),
  url: null,
  validity: 'valid',
  addressed: 'not_addressed',
  explanation: 'The handle is never closed on the error path.',
  draftReply: null,
  assessedAtHead: 'head_wire',
  ...over,
});

describe('the ClaudeReview wire + AI Fix seed', () => {
  let reviewId = 0;
  let prId = 0;

  beforeAll(async () => {
    prId = await seedPr('wire');
    reviewId = await run(prId, 'head_wire', { status: 'running' });
    await persist.saveReviewSuccess(ctx, reviewId, {
      scope: 'worktree',
      summary: 's',
      verdict: 'COMMENT',
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
      numTurns: 1,
      excludedFiles: [],
      findings: [],
      threadAssessments: [
        assessment(1),
        assessment(2, { validity: 'not_valid', excerpt: 'Use tabs.' }),
        assessment(3, { addressed: 'addressed', excerpt: 'Add a test.' }),
        assessment(4, { validity: 'not_checked', addressed: 'not_checked', excerpt: 'Over the cap.' }),
      ],
    });
  });

  it('round-trips the assessments with server-folded counts; an older row reads as null', async () => {
    const r = (await persist.getClaudeReviewById(ctx, reviewId, 1))!;
    expect(r.threadAssessments).toHaveLength(4);
    expect(r.threadAssessmentCounts).toEqual({
      total: 4,
      assessed: 3,
      validUnaddressed: 1,
      notValid: 1,
      addressed: 1,
      notChecked: 1,
    });
    const old = (await persist.getClaudeReviewById(ctx, await run(prId, 'head_wire'), 1))!;
    expect(old.threadAssessments).toBeNull();
    expect(old.threadAssessmentCounts).toBeNull();
  });

  it('the review seed adds ONLY valid, unaddressed threads, fenced — and only for this PR’s review', async () => {
    const seed = await aiFix.reviewThreadSeed(ctx, reviewId, prId, 1, '- [warning] src/x.ts — t');
    expect(seed).toContain('This leaks the handle.');
    expect(seed).toMatch(/---BEGIN REVIEW THREAD 1 [0-9a-f]{16}---/);
    expect(seed).not.toContain('Use tabs.');
    expect(seed).not.toContain('Add a test.');
    expect(seed).not.toContain('Over the cap.');
    expect(await aiFix.reviewThreadSeed(ctx, reviewId, pr.human!, 1, '')).toBe('');
    expect(await aiFix.reviewThreadSeed(ctx, reviewId, prId, 2, '')).toBe('');
    expect(await aiFix.reviewThreadSeed(ctx, null, prId, 1, '')).toBe('');
  });
});
