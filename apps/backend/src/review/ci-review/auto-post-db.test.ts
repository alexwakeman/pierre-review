// CI AUTO-POSTING (auto-post.ts) over the REAL core client and a FAKE GitHub (the live-PR read and
// the comment post are recorded stubs). What is pinned:
//   1. OFF (auto-posting off, or its CI kind off) ⇒ nothing posted and nothing recorded; a MANUAL
//      run is never posted.
//   2. ONE PR comment per run with every diagnosed cause ABOVE 50% confidence — flaky / infra ones
//      labelled — and nothing at or under 50, nothing not checked; footer + the marker
//      `isLimnPostedComment` reads.
//   3. ONCE PER (PR, head, failing set): a later run with the same set is `already_posted`; a
//      changed set posts again.
//   4. ⚠ THE CLAIM COMES BEFORE THE WRITE: the record is `posting` while GitHub is called, and two
//      calls at once post once.
//   5. Failures are recorded, never retried; a moved head is `failed` with no post; a bot's PR and
//      someone else's PR under 'mine' are skipped.
//
//   DATABASE_URL=<scratch>.db pnpm --filter @pierre-review/backend test ci-review/auto-post-db
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTO_POST_DEFAULT_KINDS, AUTO_POST_FOOTER } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';

const DB_PATH = `${process.env.DATABASE_URL ?? '/tmp/pierre-ci-auto-post'}.ci-auto-post.sqlite`;
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
let settings: typeof import('../claude-review/auto-settings.js');
let wsId = 0;
let repoId = 0;
const users: Record<string, number> = {};
let prSeq = 0;
const HEAD = 'd'.repeat(40);

const postComment = vi.fn();
const settle = vi.fn(async () => ({ visible: true }));
let live: { headSha: string; state: 'open' | 'closed'; draft: boolean; merged: boolean } | null = null;
const deps = () => ({
  ...ap.defaultCiAutoPostDeps,
  livePr: vi.fn(async () => live ?? { headSha: HEAD, state: 'open' as const, draft: false, merged: false }),
  postComment,
  settle,
});

async function makePr(author = 'me'): Promise<number> {
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
      headSha: HEAD,
      authorId: users[author],
      openedAt: new Date(),
      updatedAt: new Date(),
    })
    .returning()
    .execute();
  return p.id;
}

interface I {
  check: string;
  confidence: number | null;
  category?: 'code' | 'test' | 'flaky_or_infra' | 'config' | 'unclear';
  notChecked?: boolean;
}
async function ciRun(prId: number, items: I[], trigger: 'auto' | 'manual' = 'auto'): Promise<number> {
  const id = await persist.insertQueuedCiReview(ctx, {
    accountId: 1,
    workspaceId: wsId,
    prId,
    repoId,
    headSha: HEAD,
    triggerKey: null,
    trigger,
    model: 'm',
  });
  await persist.markCiReviewRunning(ctx, 1, id, {
    headSha: HEAD,
    failingChecks: items.map((i) => i.check),
    ciState: { state: 'failing', checkCount: items.length },
  });
  await persist.saveCiReviewSuccess(ctx, 1, id, {
    summary: 'CI is red.',
    numTurns: 1,
    items: items.map((i, n) => ({
      ref: `F${n + 1}`,
      checkName: i.check,
      jobId: 100 + n,
      step: 'Run tests',
      url: null,
      sent: true,
      carried: false,
      status: i.notChecked ? ('not_checked' as const) : ('diagnosed' as const),
      notCheckedReason: i.notChecked ? ('not_reported' as const) : null,
      cause: i.notChecked ? null : `${i.check} broke @alice`,
      explanation: i.notChecked ? null : 'The log shows it.',
      category: i.notChecked ? null : (i.category ?? 'code'),
      fixableInPr: i.notChecked ? null : true,
      relatedFiles: [],
      assessedAtHead: HEAD,
      confidence: i.confidence,
      path: i.notChecked ? null : 'src/a.ts',
      line: i.notChecked ? null : 3,
      suggestion: i.notChecked ? null : 'Change it.',
    })),
  });
  return id;
}

async function setPost(on: boolean, extra: Record<string, unknown> = {}): Promise<void> {
  await settings.setWorkspaceAutoReview(ctx, 1, wsId, { autoPost: { enabled: on, ...extra } as any });
}
const record = async (id: number) => (await persist.getCiReviewRow(ctx, 1, id))!.autoPost;
const post = (prId: number, runId: number) => ap.maybeAutoPostCiReview(ctx, { accountId: 1, prId, runId }, deps());

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
  settings = await import('../claude-review/auto-settings.js');
  ctx = {
    db,
    schema,
    isPg: false,
    runTransaction: client.runTransaction,
    recordAiUsage: async () => {},
    accountIdOf: () => 1,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as any as AgentContext;
});

afterAll(async () => {
  await closeDb?.();
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
});

let commentSeq = 0;
beforeEach(async () => {
  postComment.mockReset();
  postComment.mockImplementation(async () => ({ commentId: `IC${(commentSeq += 1)}` }));
  settle.mockClear();
  live = null;
  await setPost(true, { scope: 'all', kinds: { ...AUTO_POST_DEFAULT_KINDS } });
});

describe('the pure rules', () => {
  it('posts only diagnosed causes above 50%', () => {
    const it0 = { status: 'diagnosed', cause: 'x', confidence: 51 } as any;
    expect(ap.selectCiItemsToPost([it0, { ...it0, confidence: 50 }, { ...it0, confidence: null }, { ...it0, status: 'not_checked' }])).toEqual([it0]);
  });
  it('neutralises mentions and forged markers', () => {
    expect(ap.safeCommentText('ping @bob <!-- x')).toBe('ping @​bob &lt;!-- x');
  });
});

describe('CI auto-posting', () => {
  it('off ⇒ nothing posted or recorded; the CI kind off ⇒ the same; a manual run never posts', async () => {
    const pr = await makePr();
    await setPost(false);
    const a = await ciRun(pr, [{ check: 'test', confidence: 90 }]);
    expect(await post(pr, a)).toEqual({ kind: 'off' });
    await setPost(true, { scope: 'all', kinds: { ...AUTO_POST_DEFAULT_KINDS, ciFailures: false } });
    expect(await post(pr, a)).toEqual({ kind: 'off' });
    expect(await record(a)).toBeNull();
    await setPost(true, { scope: 'all', kinds: { ...AUTO_POST_DEFAULT_KINDS } });
    const m = await ciRun(pr, [{ check: 'test', confidence: 90 }], 'manual');
    expect(await post(pr, m)).toEqual({ kind: 'off' });
    expect(postComment).not.toHaveBeenCalled();
  });

  it('one comment with every cause above 50%, flaky ones labelled; footer + marker', async () => {
    const pr = await makePr();
    const id = await ciRun(pr, [
      { check: 'build', confidence: 85 },
      { check: 'e2e', confidence: 70, category: 'flaky_or_infra' },
      { check: 'lint', confidence: 40 },
      { check: 'docs', confidence: null, notChecked: true },
    ]);
    const out = await post(pr, id);
    expect(out.kind).toBe('done');
    expect(postComment).toHaveBeenCalledTimes(1);
    const [owner, name, number, body] = postComment.mock.calls[0]!;
    expect([owner, name, number]).toEqual(['acme', 'api', prSeq]);
    expect(body).toContain('`build`');
    expect(body).toContain('`e2e`');
    expect(body).toContain('Likely flaky or an infrastructure problem');
    expect(body).not.toContain('`lint`');
    expect(body).not.toContain('`docs`');
    expect(body).toContain('Confidence: 85%');
    expect(body).toContain('@​alice'); // no ping
    expect(body).toContain(AUTO_POST_FOOTER);
    const { isLimnPostedComment } = await import('../../db/review-threads-for-review.js');
    expect(isLimnPostedComment({ body, databaseId: null, authorLogin: 'me' }, undefined, 'me')).toBe(true);
    const rec = await record(id);
    expect(rec).toMatchObject({ status: 'posted', commentId: 'IC' + commentSeq, headSha: HEAD, error: null });
    expect(rec!.itemIds).toHaveLength(2);
    expect(settle).toHaveBeenCalledTimes(1);
    // The wire carries the record without ids.
    expect((await persist.getCiReviewById(ctx, 1, id))!.autoPost).toMatchObject({ status: 'posted', postedCount: 2 });
    // Confidence round-trips.
    expect((await persist.getCiReviewById(ctx, 1, id))!.items.map((i) => i.confidence)).toEqual([85, 70, 40, null]);
  });

  it('once per head + failing set; a changed set posts again', async () => {
    const pr = await makePr();
    const first = await ciRun(pr, [{ check: 'build', confidence: 90 }]);
    expect((await post(pr, first)).kind).toBe('done');
    const again = await ciRun(pr, [{ check: 'build', confidence: 95 }]);
    expect(await post(pr, again)).toEqual({ kind: 'skipped', reason: 'already_posted' });
    expect(await record(again)).toMatchObject({ status: 'skipped', reason: 'already_posted' });
    const grown = await ciRun(pr, [{ check: 'build', confidence: 90 }, { check: 'test', confidence: 90 }]);
    expect((await post(pr, grown)).kind).toBe('done');
    expect(postComment).toHaveBeenCalledTimes(2);
  });

  it('nothing above 50% ⇒ skipped, no GitHub call', async () => {
    const pr = await makePr();
    const id = await ciRun(pr, [{ check: 'build', confidence: 50 }]);
    expect(await post(pr, id)).toEqual({ kind: 'skipped', reason: 'nothing_new' });
    expect(postComment).not.toHaveBeenCalled();
  });

  it('⚠ claims before the write, and two calls at once post once', async () => {
    const pr = await makePr();
    const id = await ciRun(pr, [{ check: 'build', confidence: 90 }]);
    let seen: unknown = null;
    postComment.mockImplementation(async () => {
      seen = await record(id);
      return { commentId: 'IC_claim' };
    });
    const [a, b] = await Promise.all([post(pr, id), post(pr, id)]);
    expect(postComment).toHaveBeenCalledTimes(1);
    expect(seen).toMatchObject({ status: 'posting' });
    expect([a.kind, b.kind].sort()).toEqual(['already_claimed', 'done']);
    expect(await post(pr, id)).toEqual({ kind: 'already_claimed' });
  });

  it('a GitHub failure is recorded and never retried', async () => {
    const pr = await makePr();
    const id = await ciRun(pr, [{ check: 'build', confidence: 90 }]);
    postComment.mockRejectedValueOnce(new Error('Resource not accessible by integration'));
    const out = await post(pr, id);
    expect(out).toMatchObject({ kind: 'done', record: { status: 'failed', error: 'Resource not accessible by integration' } });
    expect(await post(pr, id)).toEqual({ kind: 'already_claimed' });
    expect(postComment).toHaveBeenCalledTimes(1);
    expect(settle).not.toHaveBeenCalled();
    // The same set on a later run is not a retry either.
    const later = await ciRun(pr, [{ check: 'build', confidence: 90 }]);
    expect(await post(pr, later)).toEqual({ kind: 'skipped', reason: 'already_posted' });
  });

  it('a moved head is failed with no post; bots and (under "mine") strangers are skipped', async () => {
    const pr = await makePr();
    const id = await ciRun(pr, [{ check: 'build', confidence: 90 }]);
    live = { headSha: 'e'.repeat(40), state: 'open', draft: false, merged: false };
    expect(await post(pr, id)).toMatchObject({ kind: 'done', record: { status: 'failed' } });
    expect(postComment).not.toHaveBeenCalled();
    live = null;

    const botPr = await makePr('renovate[bot]');
    const b = await ciRun(botPr, [{ check: 'build', confidence: 90 }]);
    expect(await post(botPr, b)).toEqual({ kind: 'skipped', reason: 'bot_author' });

    await setPost(true, { scope: 'mine', kinds: { ...AUTO_POST_DEFAULT_KINDS } });
    const theirs = await makePr('alice');
    const t = await ciRun(theirs, [{ check: 'build', confidence: 90 }]);
    expect(await post(theirs, t)).toEqual({ kind: 'skipped', reason: 'not_yours' });
    expect(postComment).not.toHaveBeenCalled();
  });
});
