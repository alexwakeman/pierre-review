// THE SERVER → SPA PR CHANGE SIGNAL (sync/pr-change-signal.ts) and its main writer, persistPr.
// Throwaway sqlite; the real persistPr, no GitHub.
//
// What this pins:
//   1. ⚠ DIFF-GATED. A walk that restates what is stored must NOT raise the signal — a raise
//      costs every open SPA tab a cascade of refetches (three on the `search` rate-limit tier), so
//      "a row was written" is never enough; only a board-visible column MOVING is.
//   2. Each board-visible column moves it: state, draft, head, CI, both merge columns, review
//      decision, and the merge-queue pair — the latter ONLY when the response observed it (the
//      three-state rule: an absent selection wrote nothing, so it cannot have moved) — and GitHub's
//      `updatedAt`, the proxy for a new review / comment / reply / commit in a child table.
//   3. A first sighting of an OPEN PR is a new card and moves it; a merged/closed first sighting
//      (the deep backfill's history) does not.
//   4. The listing decoration is ACCOUNT-keyed and adds NO key for a repo with nothing recorded.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at load), and every
// value import is dynamic inside beforeAll for the same reason (see db/pr-liveness.test.ts).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GqlPullRequest } from '../github/queries.js';

const DB_PATH = '/tmp/pierre-pr-change-signal-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let schema: any;
let db: any;
let closeDb: (() => void) | undefined;
let upsert: typeof import('./upsert.js');
let signal: typeof import('./pr-change-signal.js');
let repoId = 0;

function gqlPr(over: Partial<GqlPullRequest> & Record<string, unknown> = {}): GqlPullRequest {
  return {
    id: 'PR_sig_1',
    number: 1,
    title: 'A change',
    body: null,
    bodyText: '',
    isDraft: false,
    state: 'OPEN',
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    files: { nodes: [] },
    createdAt: '2026-09-01T00:00:00Z',
    mergedAt: null,
    closedAt: null,
    updatedAt: '2026-09-02T00:00:00Z',
    url: 'https://github.com/acme/sig/pull/1',
    baseRefName: 'main',
    headRefName: 'feature',
    mergeable: 'CONFLICTING',
    mergeStateStatus: 'DIRTY',
    reviewDecision: null,
    headCommit: {
      nodes: [{ commit: { oid: 'sha-1', statusCheckRollup: { state: 'PENDING', contexts: { nodes: [] } } } }],
    },
    author: { login: 'alice', id: 'U_alice', __typename: 'User' },
    mergedBy: null,
    labels: { nodes: [] },
    reviewRequests: { nodes: [] },
    reviews: { nodes: [] },
    reviewThreads: { nodes: [] },
    comments: { nodes: [] },
    commits: { nodes: [] },
    ...over,
  } as unknown as GqlPullRequest;
}

async function persist(pr: GqlPullRequest): Promise<void> {
  await upsert.persistPr(pr, repoId, upsert.createUserResolver(), new Map(), 1);
}

const signalled = (): Date | null => signal.lastPrChangeAt(1, repoId);

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../db/run-migrations.js');
  const client = await import('../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  upsert = await import('./upsert.js');
  signal = await import('./pr-change-signal.js');
  const [r] = await db
    .insert(schema.repos)
    .values({ accountId: 1, owner: 'acme', name: 'sig', githubNodeId: 'R_sig_1' })
    .returning()
    .execute();
  repoId = r.id;
});

afterAll(() => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

beforeEach(() => signal.__resetPrChangeSignal());

describe('persistPr → the PR change signal', () => {
  it('a first sighting raises it; restating the same row does NOT', async () => {
    await persist(gqlPr());
    expect(signalled()).not.toBeNull();
    signal.__resetPrChangeSignal();
    // The same GitHub answer again — the adaptive walk's overlap window does exactly this.
    await persist(gqlPr());
    expect(signalled()).toBeNull();
    // A field outside the set moving on its own (no updatedAt bump) raises nothing either.
    await persist(gqlPr({ title: 'A retitled change' }));
    expect(signalled()).toBeNull();
  });

  it('a newer updatedAt raises it — a review, comment or reply a webhook sync just stored', async () => {
    await persist(gqlPr());
    signal.__resetPrChangeSignal();
    await persist(gqlPr({ updatedAt: '2026-09-03T00:00:00Z' }));
    expect(signalled()).not.toBeNull();
  });

  it('a MERGED or CLOSED first sighting (the deep backfill) does not raise it', async () => {
    await persist(
      gqlPr({
        id: 'PR_sig_hist_1',
        number: 51,
        state: 'MERGED',
        mergedAt: '2026-09-02T00:00:00Z',
      } as any),
    );
    await persist(
      gqlPr({
        id: 'PR_sig_hist_2',
        number: 52,
        state: 'CLOSED',
        closedAt: '2026-09-02T00:00:00Z',
      } as any),
    );
    expect(signalled()).toBeNull();
    // An OPEN first sighting is a new card.
    await persist(gqlPr({ id: 'PR_sig_new_open', number: 53 } as any));
    expect(signalled()).not.toBeNull();
  });

  it('a merge-state move raises it — the stale conflict clearing', async () => {
    await persist(gqlPr());
    signal.__resetPrChangeSignal();
    await persist(gqlPr({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' } as any));
    expect(signalled()).not.toBeNull();
  });

  it('a head move and a CI move each raise it', async () => {
    await persist(gqlPr());
    signal.__resetPrChangeSignal();
    await persist(
      gqlPr({
        headCommit: {
          nodes: [{ commit: { oid: 'sha-2', statusCheckRollup: { state: 'PENDING', contexts: { nodes: [] } } } }],
        },
      } as any),
    );
    expect(signalled()).not.toBeNull();
    signal.__resetPrChangeSignal();
    await persist(
      gqlPr({
        headCommit: {
          nodes: [{ commit: { oid: 'sha-2', statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [] } } } }],
        },
      } as any),
    );
    expect(signalled()).not.toBeNull();
  });

  it('the merge-queue pair moves it only when the response observed it', async () => {
    await persist(gqlPr({ isInMergeQueue: false, mergeQueueEntry: null } as any));
    signal.__resetPrChangeSignal();
    // Selection absent (a partial response / an older fixture): learn nothing, raise nothing.
    await persist(gqlPr());
    expect(signalled()).toBeNull();
    // Observed and different: raised.
    await persist(gqlPr({ isInMergeQueue: true, mergeQueueEntry: { state: 'QUEUED' } } as any));
    expect(signalled()).not.toBeNull();
  });

  it('is strictly increasing, so two changes in one millisecond are still two', () => {
    signal.notePrChanged(1, 999);
    const a = signal.lastPrChangeAt(1, 999)!.getTime();
    signal.notePrChanged(1, 999);
    const b = signal.lastPrChangeAt(1, 999)!.getTime();
    expect(b).toBeGreaterThan(a);
  });
});

describe('boardVisibleMoved', () => {
  const base = {
    state: 'open',
    isDraft: false,
    headSha: 'a',
    ciStatus: 'success',
    mergeable: 'mergeable',
    mergeStateStatus: 'clean',
    reviewDecision: null,
    inMergeQueue: false,
    mergeQueueEntryState: null,
  };

  it('is false for an identical row and true for each board column', () => {
    const { boardVisibleMoved } = upsert;
    expect(boardVisibleMoved(base, { ...base })).toBe(false);
    for (const [k, v] of [
      ['state', 'merged'],
      ['isDraft', true],
      ['headSha', 'b'],
      ['ciStatus', 'failure'],
      ['mergeable', 'conflicting'],
      ['mergeStateStatus', 'dirty'],
      ['reviewDecision', 'approved'],
    ] as const) {
      expect(boardVisibleMoved(base, { ...base, [k]: v } as any)).toBe(true);
    }
    expect(boardVisibleMoved(null, { ...base })).toBe(true);
    expect(boardVisibleMoved(null, { ...base, state: 'merged' })).toBe(false);
    expect(boardVisibleMoved(null, { ...base, state: 'closed' })).toBe(false);
  });

  it('compares updatedAt by instant, and only when the write carries one', () => {
    const { boardVisibleMoved } = upsert;
    const t = new Date('2026-09-02T00:00:00Z');
    const prev = { ...base, updatedAt: t };
    expect(boardVisibleMoved(prev, { ...base, updatedAt: new Date(t.getTime()) })).toBe(false);
    expect(
      boardVisibleMoved(prev, { ...base, updatedAt: new Date('2026-09-02T00:00:01Z') }),
    ).toBe(true);
    expect(boardVisibleMoved(prev, { ...base })).toBe(false);
  });

  it('ignores an UNOBSERVED queue pair, compares an observed one', () => {
    const { boardVisibleMoved } = upsert;
    const { inMergeQueue: _q, mergeQueueEntryState: _s, ...unobserved } = base;
    expect(boardVisibleMoved({ ...base, inMergeQueue: true }, unobserved as any)).toBe(false);
    expect(boardVisibleMoved(base, { ...base, inMergeQueue: true })).toBe(true);
    expect(
      boardVisibleMoved(
        { ...base, inMergeQueue: true, mergeQueueEntryState: 'queued' },
        { ...base, inMergeQueue: true, mergeQueueEntryState: 'unmergeable' },
      ),
    ).toBe(true);
  });
});

describe('withPrChangeSignal — the GET /api/repos decoration', () => {
  it('is account-keyed and adds no key where nothing was recorded', () => {
    signal.notePrChanged(1, 10);
    const rows = signal.withPrChangeSignal(1, [{ id: 10 }, { id: 11 }]);
    expect(typeof rows[0]!.lastPrChangeAt).toBe('string');
    expect('lastPrChangeAt' in rows[1]!).toBe(false);
    // Another tenant naming the same repo id reads nothing.
    const other = signal.withPrChangeSignal(2, [{ id: 10 }]);
    expect('lastPrChangeAt' in other[0]!).toBe(false);
  });
});

describe('onPrChanged — server caches that must drop on a change', () => {
  it('calls each listener with the (account, repo) the signal names, until unsubscribed', () => {
    const seen: Array<[number, number]> = [];
    const off = signal.onPrChanged((a, r) => seen.push([a, r]));
    try {
      signal.notePrChanged(3, 30);
      signal.notePrChanged(4, 40);
      expect(seen).toEqual([
        [3, 30],
        [4, 40],
      ]);
    } finally {
      off();
    }
    signal.notePrChanged(3, 30);
    expect(seen).toHaveLength(2);
  });

  it('contains a throwing listener: the signal and every other listener still land', () => {
    const seen: number[] = [];
    const offBad = signal.onPrChanged(() => {
      throw new Error('cache exploded');
    });
    const offGood = signal.onPrChanged((_a, r) => seen.push(r));
    try {
      const before = signal.lastPrChangeAt(5, 50)?.getTime() ?? 0;
      expect(() => signal.notePrChanged(5, 50)).not.toThrow();
      expect(signal.lastPrChangeAt(5, 50)!.getTime()).toBeGreaterThan(before);
      expect(seen).toEqual([50]);
    } finally {
      offBad();
      offGood();
    }
  });

  it('survives the test reset — a listener is a module-load registration, not signal state', () => {
    const seen: number[] = [];
    const off = signal.onPrChanged((_a, r) => seen.push(r));
    try {
      signal.__resetPrChangeSignal();
      signal.notePrChanged(6, 60);
      expect(seen).toEqual([60]);
    } finally {
      off();
    }
  });
});
