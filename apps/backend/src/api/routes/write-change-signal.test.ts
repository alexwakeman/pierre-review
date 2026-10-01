// EVERY PR WRITE ROUTE RAISES THE SPA CHANGE SIGNAL BEFORE IT REPLIES — on a THROWAWAY sqlite DB
// (the reopen-pr.test.ts pattern): env is set BEFORE importing config/client, the real routes, real
// permission checks, real local stamps and the real signal all run; only GitHub
// (github/mutations.js), the token source, the targeted sync and the hydration invalidator are
// stubbed.
//
// WHY. A write route stamps its rows locally so the SPA's refetch shows the write at once. A local
// stamp is a board-visible move no walk will ever report, so the route must also raise
// `Repo.lastPrChangeAt` (sync/pr-change-signal.ts) — the ONE way every other screen learns a PR
// moved. And it must raise it BEFORE replying: the SPA's write sweep (frontend
// hooks/prCacheSync.ts) reads `['repos']` first and records the stamps it saw as already covered,
// so a stamp raised after the reply lands after that read and SyncStatus refetches the whole write
// set a SECOND time (three of those reads are on the 60/min `search` tier).
//
// So each case asserts the ORDER, not just the presence: the wrapped `notePrChanged` and an
// `onSend` hook append to one log, and the signal must precede the reply. And the signal names
// the written PR's repo only — never a neighbour, never on a refusal, never for another tenant.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const DB_PATH = '/tmp/pierre-write-change-signal-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

const closePullRequest = vi.fn();
const reopenPullRequest = vi.fn();
const addIssueComment = vi.fn();
const submitPrReview = vi.fn();
const requestReviewers = vi.fn();
const addReviewThreadReply = vi.fn();
const setReviewThreadResolved = vi.fn();
const fetchHeadShaFor = vi.fn();
const fetchPrFilesWithPatch = vi.fn();
const postInlineComment = vi.fn();
vi.mock('../../github/mutations.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  closePullRequest,
  reopenPullRequest,
  addIssueComment,
  submitPrReview,
  requestReviewers,
  addReviewThreadReply,
  setReviewThreadResolved,
  fetchHeadShaFor,
  fetchPrFilesWithPatch,
  postInlineComment,
}));
// ⚠ SPREAD: `getAccountUserId` must stay real — it resolves the viewer for the permission checks.
vi.mock('../../auth/account.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAccessToken: vi.fn(async () => 'tok'),
}));
// The approve and review-comment tails re-read the PR (and the approve arms the settle ladder):
// a no-op sync keeps GitHub out of it, so any signal seen here is the ROUTE's own.
const syncOnePr = vi.fn(async () => false);
vi.mock('../../sync/sync-one-pr.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  syncOnePr,
}));
vi.mock('../../sync/hydrate-detail.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  invalidatePrHydration: vi.fn(),
}));

// One ordered log shared by the signal and the reply.
const order: string[] = [];
vi.mock('../../sync/pr-change-signal.js', async (importOriginal) => {
  const real = await importOriginal<
    Record<string, unknown> & { notePrChanged: (a: number, r: number) => void }
  >();
  return {
    ...real,
    notePrChanged: (accountId: number, repoId: number) => {
      order.push(`signal:${accountId}:${repoId}`);
      real.notePrChanged(accountId, repoId);
    },
  };
});

/* eslint-disable @typescript-eslint/no-explicit-any */
let app: any;
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let eq: any;
let signal: typeof import('../../sync/pr-change-signal.js');

const now = Math.floor(Date.now() / 1000) * 1000;
const VIEWER_LOGIN = 'viewer-me';
let viewerUserId = 0;
let aliceId = 0;
let carolId = 0;
let repoA = 0;
let repoB = 0;
let openPr = 0;
let closedPr = 0;
let otherRepoPr = 0;
let threadId = 0;
let foreignPrId = 0;
let foreignThreadId = 0;

const PATCH = '@@ -10,2 +10,3 @@\n unchanged\n+added\n unchanged again\n';

async function inject(method: string, url: string, body?: unknown): Promise<any> {
  return app.inject({
    method,
    url,
    ...(body !== undefined
      ? { headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) }
      : {}),
  });
}

/** The signal for `repoId` was raised, exactly once, BEFORE the reply — and nothing else was. */
function expectSignalledBeforeReply(repoId: number): void {
  expect(order).toEqual([`signal:1:${repoId}`, 'reply']);
  expect(signal.lastPrChangeAt(1, repoId)).not.toBeNull();
}

function expectNoSignal(): void {
  expect(order.filter((e) => e.startsWith('signal:'))).toEqual([]);
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  ({ eq } = await import('drizzle-orm'));
  signal = await import('../../sync/pr-change-signal.js');

  const { accounts, repos, pullRequests, users, reviewThreads } = schema;
  // Migration 0008 seeds account 1 with an EMPTY github_login; the approve's "not your own PR"
  // check and the comment's author both resolve the viewer through it.
  await db.update(accounts).set({ githubLogin: VIEWER_LOGIN }).where(eq(accounts.id, 1)).execute();
  const insertUser = async (login: string): Promise<number> => {
    const [u] = await db
      .insert(users)
      .values({ githubLogin: login, githubNodeId: `U_${login}`, isBot: false })
      .returning()
      .execute();
    return u.id;
  };
  viewerUserId = await insertUser(VIEWER_LOGIN);
  aliceId = await insertUser('alice-dev');
  carolId = await insertUser('carol-dev');

  const insertRepo = async (accountId: number, name: string): Promise<number> => {
    const [r] = await db
      .insert(repos)
      .values({ accountId, owner: 'acme', name, githubNodeId: `R_sig_${accountId}_${name}`, viewerPermission: 'WRITE' })
      .returning()
      .execute();
    return r.id;
  };
  let n = 1;
  const insertPr = async (
    accountId: number,
    repoId: number,
    key: string,
    values: Record<string, unknown> = {},
  ): Promise<number> => {
    const [row] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: `PR_sig_${key}`,
        accountId,
        repoId,
        number: n++,
        title: `${key} fixture`,
        state: 'open',
        authorId: aliceId,
        openedAt: new Date(now - 5 * 86_400_000),
        updatedAt: new Date(now - 3600_000),
        headSha: 'headsha',
        ...values,
      })
      .returning()
      .execute();
    return row.id;
  };
  const insertThread = async (prId: number, key: string): Promise<number> => {
    const [t] = await db
      .insert(reviewThreads)
      .values({
        githubNodeId: `PRRT_sig_${key}`,
        prId,
        path: 'src/a.ts',
        line: 11,
        isResolved: false,
        derivedState: 'untouched',
        createdAt: new Date(now - 3600_000),
      })
      .returning()
      .execute();
    return t.id;
  };

  repoA = await insertRepo(1, 'a');
  repoB = await insertRepo(1, 'b');
  openPr = await insertPr(1, repoA, 'open');
  closedPr = await insertPr(1, repoA, 'closed', { state: 'closed', closedAt: new Date(now - 3600_000) });
  // A second repo of the SAME account: the signal must name the written PR's repo, not this one.
  otherRepoPr = await insertPr(1, repoB, 'other-repo');
  threadId = await insertThread(openPr, 'a');

  // Account 2 owns a mirror-image PR and thread (what keeps the isolation cases non-vacuous).
  await db.insert(accounts).values({ id: 2, githubUserId: 'gh_2', githubLogin: 'neighbour' }).execute();
  const foreignRepo = await insertRepo(2, 'a');
  foreignPrId = await insertPr(2, foreignRepo, 'foreign');
  foreignThreadId = await insertThread(foreignPrId, 'foreign');

  const { prRoutes } = await import('./prs.js');
  const { threadRoutes } = await import('./threads.js');
  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  // Runs once the handler has returned and the payload is being sent — i.e. the reply.
  app.addHook('onSend', async (_req: unknown, _reply: unknown, payload: unknown) => {
    order.push('reply');
    return payload;
  });
  await app.register(prRoutes);
  await app.register(threadRoutes);
  await app.ready();
}, 60_000);

afterAll(async () => {
  // The approve arms the settle ladder; drop its timers before the DB closes.
  (await import('../../sync/pr-settle.js')).__resetPrSettle();
  await app?.close();
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  syncOnePr.mockResolvedValue(false);
  signal.__resetPrChangeSignal();
  order.length = 0;
  const { pullRequests, reviewThreads } = schema;
  await db.update(pullRequests).set({ state: 'open', closedAt: null }).where(eq(pullRequests.id, openPr)).execute();
  await db
    .update(pullRequests)
    .set({ state: 'closed', closedAt: new Date(now - 3600_000) })
    .where(eq(pullRequests.id, closedPr))
    .execute();
  await db
    .update(reviewThreads)
    .set({ isResolved: false, derivedState: 'untouched' })
    .where(eq(reviewThreads.id, threadId))
    .execute();
});

describe('PR write routes raise the change signal before replying', () => {
  it('close', async () => {
    closePullRequest.mockResolvedValue({ ok: true });
    const res = await inject('POST', `/api/prs/${openPr}/close`);
    expect(res.statusCode).toBe(200);
    expectSignalledBeforeReply(repoA);
    expect(signal.lastPrChangeAt(1, repoB)).toBeNull();
  });

  it('reopen', async () => {
    reopenPullRequest.mockResolvedValue({ ok: true });
    const res = await inject('POST', `/api/prs/${closedPr}/reopen`);
    expect(res.statusCode).toBe(200);
    expectSignalledBeforeReply(repoA);
  });

  it('a PR comment', async () => {
    addIssueComment.mockResolvedValue({
      nodeId: 'IC_sig',
      databaseId: 41,
      body: 'hi',
      createdAt: new Date(now).toISOString(),
      url: 'https://github.com/c/41',
      authorLogin: VIEWER_LOGIN,
    });
    const res = await inject('POST', `/api/prs/${otherRepoPr}/comment`, { body: 'hi' });
    expect(res.statusCode).toBe(200);
    expectSignalledBeforeReply(repoB);
    expect(signal.lastPrChangeAt(1, repoA)).toBeNull();
  });

  it('an approval (the ladder it arms stays in the background)', async () => {
    submitPrReview.mockResolvedValue({
      databaseId: 42,
      nodeId: 'PRR_sig',
      state: 'APPROVED',
      body: '',
      submittedAt: new Date(now).toISOString(),
      url: 'https://github.com/r/42',
      authorLogin: VIEWER_LOGIN,
    });
    const res = await inject('POST', `/api/prs/${openPr}/approve`, {});
    expect(res.statusCode).toBe(200);
    expectSignalledBeforeReply(repoA);
  });

  it('a reviewer request', async () => {
    requestReviewers.mockResolvedValue(undefined);
    const res = await inject('POST', `/api/prs/${openPr}/request-reviewers`, { userIds: [carolId] });
    expect(res.statusCode).toBe(200);
    expectSignalledBeforeReply(repoA);
  });

  it('an inline review comment — even when the resync could not confirm it', async () => {
    fetchHeadShaFor.mockResolvedValue('headsha');
    fetchPrFilesWithPatch.mockResolvedValue({
      files: [{ filename: 'src/a.ts', patch: PATCH, additions: 1, deletions: 0 }],
      truncated: false,
    });
    postInlineComment.mockResolvedValue({ databaseId: 5150, nodeId: 'PRRC_sig', url: 'https://github.com/c/1' });
    const res = await inject('POST', `/api/prs/${openPr}/review-comment`, {
      path: 'src/a.ts',
      line: 11,
      body: 'nit',
    });
    expect(res.statusCode).toBe(200);
    // The comment IS on GitHub (commentId set) though the no-op sync did not store it.
    expect(res.json()).toMatchObject({ commentId: 5150, visible: false });
    expectSignalledBeforeReply(repoA);
  });

  it('an inline comment that posted NOTHING raises nothing', async () => {
    fetchHeadShaFor.mockResolvedValue('headsha');
    fetchPrFilesWithPatch.mockResolvedValue({ files: [], truncated: false });
    const res = await inject('POST', `/api/prs/${openPr}/review-comment`, {
      path: 'src/a.ts',
      line: 11,
      body: 'nit',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ commentId: null });
    expectNoSignal();
  });
});

describe('thread write routes raise the change signal before replying', () => {
  it('a reply', async () => {
    addReviewThreadReply.mockResolvedValue({
      nodeId: 'PRRC_reply_sig',
      databaseId: 77,
      body: 'done',
      createdAt: new Date(now).toISOString(),
      url: 'https://github.com/c/77',
      authorLogin: VIEWER_LOGIN,
    });
    const res = await inject('POST', `/api/threads/${threadId}/reply`, { body: 'done' });
    expect(res.statusCode).toBe(200);
    expectSignalledBeforeReply(repoA);
  });

  it('a resolve', async () => {
    setReviewThreadResolved.mockResolvedValue({ isResolved: true });
    const res = await inject('POST', `/api/threads/${threadId}/resolve`, { resolved: true });
    expect(res.statusCode).toBe(200);
    expectSignalledBeforeReply(repoA);
  });
});

describe('refusals raise nothing', () => {
  it('GitHub refusing a close (502) raises nothing', async () => {
    closePullRequest.mockResolvedValue({ ok: false, reason: 'error', message: 'nope' });
    const res = await inject('POST', `/api/prs/${openPr}/close`);
    expect(res.statusCode).toBe(502);
    expectNoSignal();
  });

  it('another account’s PR / thread 404s and raises nothing, for either account', async () => {
    const a = await inject('POST', `/api/prs/${foreignPrId}/close`);
    const b = await inject('POST', `/api/threads/${foreignThreadId}/resolve`, { resolved: true });
    expect([a.statusCode, b.statusCode]).toEqual([404, 404]);
    expectNoSignal();
    expect(closePullRequest).not.toHaveBeenCalled();
    expect(setReviewThreadResolved).not.toHaveBeenCalled();
  });
});

// Both bot-thread resolve routes (per-PR and workspace-wide) delegate to this ONE helper, so the
// signal lives there and is pinned there.
describe('resolveThreadsOnGitHub — the shared bot-thread resolve', () => {
  it('signals each repo it STAMPED, once, and none it failed to resolve', async () => {
    const { resolveThreadsOnGitHub } = await import('../../bot-triage/resolve.js');
    const { reviewThreads } = schema;
    const [bThread] = await db
      .insert(reviewThreads)
      .values({
        githubNodeId: 'PRRT_sig_b',
        prId: otherRepoPr,
        path: 'src/b.ts',
        line: 1,
        isResolved: false,
        derivedState: 'likely_addressed',
        createdAt: new Date(now - 3600_000),
      })
      .returning()
      .execute();
    try {
      // repo A's thread resolves; repo B's fails on GitHub.
      setReviewThreadResolved.mockImplementation(async (_tok: string, nodeId: string) => {
        if (nodeId === 'PRRT_sig_b') throw new Error('GitHub said no');
        return { isResolved: true };
      });
      const out = await resolveThreadsOnGitHub(1, [
        { id: threadId, threadNodeId: 'PRRT_sig_a', prId: openPr },
        { id: bThread.id, threadNodeId: 'PRRT_sig_b', prId: otherRepoPr },
      ]);
      expect({ resolved: out.resolved, failed: out.failed }).toEqual({ resolved: 1, failed: 1 });
      expect(order).toEqual([`signal:1:${repoA}`]);
      expect(signal.lastPrChangeAt(1, repoB)).toBeNull();
    } finally {
      await db.delete(reviewThreads).where(eq(reviewThreads.id, bThread.id)).execute();
    }
  });

  it('an empty selection signals nothing (and fetches no token)', async () => {
    const { resolveThreadsOnGitHub } = await import('../../bot-triage/resolve.js');
    const out = await resolveThreadsOnGitHub(1, []);
    expect(out).toEqual({ resolved: 0, failed: 0, results: [] });
    expectNoSignal();
  });
});

describe('notePrChangedForPrs — the id-list read behind every route signal', () => {
  it('resolves each PR to its repo, once per repo, and only for THIS account', async () => {
    const { notePrChangedForPrs, getPrRepoIds } = await import('../../sync/pr-settle.js');
    expect((await getPrRepoIds(1, [openPr, closedPr, otherRepoPr])).sort()).toEqual([repoA, repoB].sort());
    // Another tenant naming account 1's PR ids reads nothing, and so raises nothing.
    expect(await getPrRepoIds(2, [openPr, otherRepoPr])).toEqual([]);
    await notePrChangedForPrs(2, [openPr, otherRepoPr]);
    expectNoSignal();
    await notePrChangedForPrs(1, [openPr, closedPr]);
    expect(order).toEqual([`signal:1:${repoA}`]);
  });
});
