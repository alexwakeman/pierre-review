// GitHub's MERGE-QUEUE membership, STAMPED by every route that holds a positive answer, on a
// THROWAWAY sqlite DB (the reopen-pr.test.ts pattern): env is set BEFORE importing config/client,
// the real routes, permission checks and query layer run, and only GitHub (github/mutations.js)
// and the token source are stubbed.
//
// WHY THIS EXISTS. The reported bug: queue a PR, navigate away, come back — "Merge ▾" again. The
// merge row now reads the SYNCED `in_merge_queue` column (the Pending board may not fetch), so a
// route that learns the answer and does not write it leaves every screen wrong until the next walk.
// What this pins:
//
//   1. EVERY PATH THAT HOLDS AN ANSWER WRITES IT: the two queue verbs, GET merge-options, the arm
//      route's AlreadyQueued 409 and the disarm route's dequeue of a watcher-made entry.
//   2. ⚠ ONLY A POSITIVE ANSWER IS WRITTEN. merge-options' queue probe is best-effort
//      (`.catch(() => null)`); a probe that FAILED must leave the column exactly as it was, or a
//      queued PR is un-queued on the strength of never having been asked.
//   3. ⚠ A STAMP THAT CHANGES THE ROW RAISES THE CHANGE SIGNAL, and one that changes nothing does
//      not. The board's liveness sweep compares GitHub against the row, so after the stamp it sees
//      no difference — without the signal the card would never repaint.
//   4. ⚠ DELETE merge-queue ASKS FIRST. "Remove from queue" now renders from synced columns that
//      can be minutes old; a PR GitHub no longer holds must be a plain success that CORRECTS the
//      row, without sending a dequeue for a PR that is not queued.
//   5. Account isolation: another tenant's PR 404s and is never written.
//   6. ⚠ A STAMP IS NEVER FATAL IN A ROUTE. It is a local copy of what GitHub already said; once
//      GitHub has accepted an enqueue, a failed local write may not turn the answer into a 502.
//   7. ⚠ DELETE merge-queue on a PR THE QUEUE ALREADY LANDED records the landing, rather than
//      stamping an open row "not queued" and offering Merge for a merged PR.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const DB_PATH = '/tmp/pierre-merge-queue-stamp-route-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

const fetchMergeQueueState = vi.fn();
const enqueuePullRequestOnQueue = vi.fn();
const dequeuePullRequestFromQueue = vi.fn();
const fetchPrHeadInfo = vi.fn();
const fetchRepoMergeConfig = vi.fn();
const fetchMergeability = vi.fn();
// Spread the real module so every export these routes don't stub still resolves.
vi.mock('../../github/mutations.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchMergeQueueState,
  enqueuePullRequestOnQueue,
  dequeuePullRequestFromQueue,
  fetchPrHeadInfo,
  fetchRepoMergeConfig,
  fetchMergeability,
}));
// Flipped by the non-fatal test: the change signal is the LAST thing a stamp does, so throwing
// from it is a stamp that fails after GitHub has answered.
let failStampSignal = false;
vi.mock('../../sync/pr-change-signal.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown> & { notePrChanged: (...a: unknown[]) => void }>();
  return {
    ...real,
    notePrChanged: (...args: unknown[]) => {
      if (failStampSignal) throw new Error('local write failed');
      return real.notePrChanged(...args);
    },
  };
});
const getAccessToken = vi.fn(async () => 'tok');
vi.mock('../../auth/account.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAccessToken,
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
let app: any;
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let eq: any;
let q: any;
let signal: any;

const now = Math.floor(Date.now() / 1000) * 1000;
let repoId = 0;
let prId = 0;
let foreignPrId = 0;

/** GitHub's `fetchMergeQueueState` answer, varied per test. */
function queueState(over: Record<string, unknown> = {}) {
  return {
    enabled: true,
    inQueue: false,
    position: null,
    state: null,
    estimatedTimeToMergeMs: null,
    enqueuedAt: null,
    prState: 'OPEN',
    reviewDecision: null,
    ...over,
  };
}

async function row(id: number): Promise<any> {
  const rows = await db
    .select()
    .from(schema.pullRequests)
    .where(eq(schema.pullRequests.id, id))
    .execute();
  return rows[0];
}

async function setQueue(id: number, inMergeQueue: boolean | null, state: string | null): Promise<void> {
  await db
    .update(schema.pullRequests)
    .set({ inMergeQueue, mergeQueueEntryState: state })
    .where(eq(schema.pullRequests.id, id))
    .execute();
}

const signalled = (): Date | null => signal.lastPrChangeAt(1, repoId);

/** The watcher's own enqueue, as it records it (`ArmedMergeRequest` carries no row id). */
async function markEnqueued(): Promise<void> {
  await db
    .update(schema.autoMergeRequests)
    .set({ enqueuedAt: new Date(), phase: 'queued' })
    .where(eq(schema.autoMergeRequests.prId, prId))
    .execute();
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
  q = await import('../../db/queries.js');
  signal = await import('../../sync/pr-change-signal.js');

  const { accounts, repos, pullRequests, users } = schema;
  const [author] = await db
    .insert(users)
    .values({ githubLogin: 'alice-dev', githubNodeId: 'U_alice', isBot: false })
    .returning()
    .execute();

  const insertRepo = async (accountId: number, name: string): Promise<number> => {
    const [r] = await db
      .insert(repos)
      .values({
        accountId,
        owner: 'acme',
        name,
        githubNodeId: `R_mq_${accountId}_${name}`,
        viewerPermission: 'WRITE',
      })
      .returning()
      .execute();
    return r.id;
  };
  const insertPr = async (accountId: number, rid: number, key: string): Promise<number> => {
    const [p] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: `PR_mq_${key}`,
        accountId,
        repoId: rid,
        number: 7,
        title: `${key} fixture`,
        authorId: author.id,
        state: 'open',
        openedAt: new Date(now - 5 * 86_400_000),
        updatedAt: new Date(now - 3600_000),
        headSha: 'headsha',
        baseRefName: 'main',
      })
      .returning()
      .execute();
    return p.id;
  };
  repoId = await insertRepo(1, 'queued');
  prId = await insertPr(1, repoId, 'mine');

  // Account 2 owns a mirror-image PR — what keeps the isolation assertion from passing vacuously.
  await db
    .insert(accounts)
    .values({ id: 2, githubUserId: 'gh_2', githubLogin: 'neighbour' })
    .execute();
  foreignPrId = await insertPr(2, await insertRepo(2, 'queued'), 'foreign');

  const { prRoutes } = await import('./prs.js');
  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  await app.register(prRoutes);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  failStampSignal = false;
  getAccessToken.mockResolvedValue('tok');
  fetchPrHeadInfo.mockResolvedValue({
    headSha: 'headsha',
    headRef: 'feat',
    headRepoFullName: 'acme/queued',
    isFork: false,
    maintainerCanModify: true,
    baseRef: 'main',
  });
  fetchRepoMergeConfig.mockResolvedValue({
    allowMergeCommit: true,
    allowSquashMerge: true,
    allowRebaseMerge: false,
  });
  fetchMergeability.mockResolvedValue({
    mergeable: true,
    mergeableState: 'clean',
    baseRef: 'main',
    baseSha: 'base0',
    behindBy: 0,
    aheadBy: 1,
  });
  await setQueue(prId, null, null);
  await setQueue(foreignPrId, null, null);
  await db.delete(schema.autoMergeRequests).execute();
  signal.__resetPrChangeSignal();
});

describe('the queue verbs stamp what they just proved', () => {
  it('POST merge-queue stamps queued + the normalised entry state, and raises the signal', async () => {
    fetchMergeQueueState.mockResolvedValue(queueState());
    enqueuePullRequestOnQueue.mockResolvedValue({
      position: 2,
      state: 'AWAITING_CHECKS',
      estimatedTimeToMergeMs: null,
    });
    const res = await app.inject({ method: 'POST', url: `/api/prs/${prId}/merge-queue`, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ inQueue: true, position: 2 });
    const r = await row(prId);
    expect(r.inMergeQueue).toBe(true);
    expect(r.mergeQueueEntryState).toBe('awaiting_checks');
    expect(signalled()).not.toBeNull();
  });

  it('DELETE merge-queue dequeues a queued PR and stamps it out', async () => {
    await setQueue(prId, true, 'queued');
    fetchMergeQueueState.mockResolvedValue(queueState({ inQueue: true, state: 'QUEUED', position: 1 }));
    dequeuePullRequestFromQueue.mockResolvedValue(undefined);
    const res = await app.inject({ method: 'DELETE', url: `/api/prs/${prId}/merge-queue` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ inQueue: false, position: null, state: null });
    expect(dequeuePullRequestFromQueue).toHaveBeenCalledTimes(1);
    const r = await row(prId);
    expect(r.inMergeQueue).toBe(false);
    expect(r.mergeQueueEntryState).toBeNull();
    expect(signalled()).not.toBeNull();
  });

  it('⚠ DELETE merge-queue ASKS FIRST: GitHub says not queued → success, row corrected, no dequeue', async () => {
    // The row claims queued (minutes-old synced state the collapsed row rendered from); GitHub has
    // already landed or dropped it.
    await setQueue(prId, true, 'queued');
    fetchMergeQueueState.mockResolvedValue(queueState({ inQueue: false }));
    const res = await app.inject({ method: 'DELETE', url: `/api/prs/${prId}/merge-queue` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ inQueue: false, position: null, state: null });
    expect(dequeuePullRequestFromQueue).not.toHaveBeenCalled();
    expect((await row(prId)).inMergeQueue).toBe(false);
  });

  it('⚠ DELETE merge-queue on a PR the queue already LANDED records the merge, not "open, unqueued"', async () => {
    await setQueue(prId, true, 'mergeable');
    fetchMergeQueueState.mockResolvedValue(queueState({ inQueue: false, prState: 'MERGED' }));
    try {
      const res = await app.inject({ method: 'DELETE', url: `/api/prs/${prId}/merge-queue` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ inQueue: false, position: null, state: null });
      expect(dequeuePullRequestFromQueue).not.toHaveBeenCalled();
      const r = await row(prId);
      expect(r.state).toBe('merged');
      expect(r.inMergeQueue).toBe(false);
      expect(r.mergeQueueEntryState).toBeNull();
      // Nobody here knows who the queue merged it as; the next walk does.
      expect(r.mergedById).toBeNull();
    } finally {
      const unsettled = await import('../../sync/unsettled-prs.js');
      await unsettled.__unsettledPrsDrain();
      unsettled.__resetUnsettledPrs();
      await db
        .update(schema.pullRequests)
        .set({ state: 'open', mergedAt: null, mergedById: null })
        .where(eq(schema.pullRequests.id, prId))
        .execute();
    }
  });

  it('⚠ a stamp that FAILS after GitHub accepted the enqueue still answers 200, never a 502', async () => {
    fetchMergeQueueState.mockResolvedValue(queueState());
    enqueuePullRequestOnQueue.mockResolvedValue({
      position: 1,
      state: 'QUEUED',
      estimatedTimeToMergeMs: null,
    });
    failStampSignal = true;
    const res = await app.inject({ method: 'POST', url: `/api/prs/${prId}/merge-queue`, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ inQueue: true, position: 1 });
    expect(enqueuePullRequestOnQueue).toHaveBeenCalledTimes(1);
  });

  it('⚠ a failing stamp does not turn GET merge-options into an error', async () => {
    fetchMergeQueueState.mockResolvedValue(queueState({ inQueue: true, state: 'QUEUED' }));
    failStampSignal = true;
    const res = await app.inject({ method: 'GET', url: `/api/prs/${prId}/merge-options` });
    expect(res.statusCode).toBe(200);
    expect(res.json().mergeQueue).toMatchObject({ inQueue: true, entryState: 'queued' });
  });

  it('DELETE merge-queue falls through to the dequeue when the probe itself fails', async () => {
    await setQueue(prId, true, 'queued');
    fetchMergeQueueState.mockRejectedValue(new Error('GraphQL boom'));
    dequeuePullRequestFromQueue.mockResolvedValue(undefined);
    const res = await app.inject({ method: 'DELETE', url: `/api/prs/${prId}/merge-queue` });
    expect(res.statusCode).toBe(200);
    expect(dequeuePullRequestFromQueue).toHaveBeenCalledTimes(1);
    expect((await row(prId)).inMergeQueue).toBe(false);
  });

  it('404s on another account’s PR and writes nothing', async () => {
    fetchMergeQueueState.mockResolvedValue(queueState({ inQueue: true, state: 'QUEUED' }));
    const res = await app.inject({ method: 'GET', url: `/api/prs/${foreignPrId}/merge-options` });
    expect(res.statusCode).toBe(404);
    expect((await row(foreignPrId)).inMergeQueue).toBeNull();
    expect(fetchMergeQueueState).not.toHaveBeenCalled();
  });
});

describe('GET merge-options stamps a positive probe, and only a positive one', () => {
  it('stamps a queued answer, and carries the normalised entry state on the wire', async () => {
    fetchMergeQueueState.mockResolvedValue(
      queueState({ inQueue: true, state: 'MERGEABLE', position: 1, estimatedTimeToMergeMs: 60_000 }),
    );
    const res = await app.inject({ method: 'GET', url: `/api/prs/${prId}/merge-options` });
    expect(res.statusCode).toBe(200);
    expect(res.json().mergeQueue).toMatchObject({
      inQueue: true,
      position: 1,
      state: 'MERGEABLE',
      entryState: 'mergeable',
    });
    const r = await row(prId);
    expect(r.inMergeQueue).toBe(true);
    expect(r.mergeQueueEntryState).toBe('mergeable');
    expect(signalled()).not.toBeNull();
  });

  it('stamps a positive "not queued" over a stale queued row', async () => {
    await setQueue(prId, true, 'queued');
    fetchMergeQueueState.mockResolvedValue(queueState({ inQueue: false }));
    await app.inject({ method: 'GET', url: `/api/prs/${prId}/merge-options` });
    const r = await row(prId);
    expect(r.inMergeQueue).toBe(false);
    expect(r.mergeQueueEntryState).toBeNull();
  });

  it('⚠ a FAILED probe writes nothing — a queued row stays queued', async () => {
    await setQueue(prId, true, 'awaiting_checks');
    fetchMergeQueueState.mockRejectedValue(new Error('Resource not accessible by integration'));
    const res = await app.inject({ method: 'GET', url: `/api/prs/${prId}/merge-options` });
    expect(res.statusCode).toBe(200);
    expect(res.json().mergeQueue).toBeNull();
    const r = await row(prId);
    expect(r.inMergeQueue).toBe(true);
    expect(r.mergeQueueEntryState).toBe('awaiting_checks');
    expect(signalled()).toBeNull();
  });

  it('⚠ an answer that changes nothing raises NO signal (a signal costs the SPA a cascade)', async () => {
    await setQueue(prId, true, 'queued');
    fetchMergeQueueState.mockResolvedValue(queueState({ inQueue: true, state: 'QUEUED' }));
    await app.inject({ method: 'GET', url: `/api/prs/${prId}/merge-options` });
    expect(signalled()).toBeNull();
  });
});

describe('the auto-merge routes stamp the queue they touch', () => {
  it('⚠ arm’s AlreadyQueued 409 stamps the membership it just proved', async () => {
    // The reader pressed "Merge when ready" because their screen did not know. The 409 is right;
    // leaving the row unaware is the bug.
    fetchMergeQueueState.mockResolvedValue(
      queueState({ inQueue: true, state: 'AWAITING_CHECKS', position: 3 }),
    );
    const res = await app.inject({
      method: 'POST',
      url: `/api/prs/${prId}/auto-merge`,
      payload: { mergeMethod: 'squash' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('AlreadyQueued');
    const r = await row(prId);
    expect(r.inMergeQueue).toBe(true);
    expect(r.mergeQueueEntryState).toBe('awaiting_checks');
    expect(signalled()).not.toBeNull();
  });

  it('disarming a watcher-enqueued intent dequeues it AND stamps it out', async () => {
    await setQueue(prId, true, 'queued');
    await q.armAutoMerge(1, prId, {
      mergeMethod: 'squash',
      updateStrategy: 'merge',
      viaMergeQueue: true,
      expectedHeadOid: 'headsha',
      expectedBaseRef: 'main',
      expiresAt: new Date(now + 3600_000),
    });
    await markEnqueued();
    dequeuePullRequestFromQueue.mockResolvedValue(undefined);
    const res = await app.inject({ method: 'DELETE', url: `/api/prs/${prId}/auto-merge` });
    expect(res.statusCode).toBe(204);
    expect(dequeuePullRequestFromQueue).toHaveBeenCalledTimes(1);
    const r = await row(prId);
    expect(r.inMergeQueue).toBe(false);
    expect(r.mergeQueueEntryState).toBeNull();
  });

  it('a failed disarm dequeue leaves the row alone (GitHub said nothing)', async () => {
    await setQueue(prId, true, 'queued');
    await q.armAutoMerge(1, prId, {
      mergeMethod: 'squash',
      updateStrategy: 'merge',
      viaMergeQueue: true,
      expectedHeadOid: 'headsha',
      expectedBaseRef: 'main',
      expiresAt: new Date(now + 3600_000),
    });
    await markEnqueued();
    dequeuePullRequestFromQueue.mockRejectedValue(new Error('boom'));
    const res = await app.inject({ method: 'DELETE', url: `/api/prs/${prId}/auto-merge` });
    expect(res.statusCode).toBe(204);
    expect((await row(prId)).inMergeQueue).toBe(true);
  });
});
