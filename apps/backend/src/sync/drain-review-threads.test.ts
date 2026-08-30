import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Logger } from './sync-repo.js';

// Mocked at the same boundaries as sync-one-pr.test.ts: the GraphQL layer and the per-account
// rate budget. The drain owns no DB access, so nothing else needs standing in.
vi.mock('../github/client.js', () => ({
  getGraphqlClientFor: vi.fn(() => ({})),
  graphqlTolerant: vi.fn(),
  graphqlChecksHint: () => '',
  summarizeGraphqlErrors: () => '',
  // The tests tag a rate-limit rejection as { limited: true }.
  isRateLimitError: (e: unknown) =>
    (e as { limited?: boolean })?.limited === true
      ? { limited: true, resumeAt: new Date('2030-01-01T00:00:00Z') }
      : { limited: false, resumeAt: null },
}));
vi.mock('../github/rate-budget.js', () => ({
  isLimited: vi.fn(() => false),
  noteBudget: vi.fn(),
  noteLimited: vi.fn(),
}));

import { graphqlTolerant } from '../github/client.js';
import { isLimited, noteBudget, noteLimited } from '../github/rate-budget.js';
import { drainReviewThreads } from './drain-review-threads.js';
import {
  PR_REVIEW_THREADS_PAGE_QUERY,
  REPO_ACTIVITY_QUERY,
  type GqlReviewThread,
  type GqlThreadPage,
} from '../github/queries.js';

const mockGraphql = vi.mocked(graphqlTolerant) as unknown as Mock;
const mockIsLimited = vi.mocked(isLimited) as unknown as Mock;
const mockNoteBudget = vi.mocked(noteBudget) as unknown as Mock;
const mockNoteLimited = vi.mocked(noteLimited) as unknown as Mock;

const makeLog = (): Logger => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const thread = (id: string): GqlReviewThread =>
  ({
    id,
    isResolved: false,
    isOutdated: false,
    isCollapsed: false,
    path: 'a.ts',
    line: 1,
    resolvedBy: null,
    comments: { nodes: [] },
  }) as unknown as GqlReviewThread;

/** A first page as the fat query returns it. `info` omitted = the pre-drain fixture shape. */
const firstPage = (
  ids: string[],
  info?: { hasNextPage?: boolean | null; endCursor?: string | null } | null,
): GqlThreadPage<GqlReviewThread> => ({
  totalCount: 108,
  ...(info === undefined ? {} : { pageInfo: info }),
  nodes: ids.map(thread),
});

/** A continuation response carrying `ids`, pointing at `next` (or ending). */
const contResponse = (ids: string[], next: string | null): unknown => ({
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: next !== null, endCursor: next },
        nodes: ids.map(thread),
      },
    },
  },
  rateLimit: { remaining: 4000, resetAt: '2030-01-01T00:00:00Z', cost: 1 },
});

const opts = {
  owner: 'o',
  name: 'n',
  number: 9016,
  accountId: 7,
  token: 'tok',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockIsLimited.mockReturnValue(false);
});

describe('drainReviewThreads', () => {
  // The single most important case: EVERY hand-built fixture and every tolerant-salvaged
  // partial lands here, and all of them must behave exactly as they did before the drain
  // existed — truncated, but with no request and no throw.
  it('issues no request when the connection carries no pageInfo at all', async () => {
    const page = firstPage(['t1', 't2']);

    const res = await drainReviewThreads(page, { ...opts, log: makeLog() });

    expect(mockGraphql).not.toHaveBeenCalled();
    expect(res).toEqual({ added: 0, pages: 0, incomplete: false });
    expect(page.nodes).toHaveLength(2);
  });

  it('issues no request when GitHub says the first page is the whole list', async () => {
    const page = firstPage(['t1'], { hasNextPage: false, endCursor: 'c1' });

    const res = await drainReviewThreads(page, { ...opts, log: makeLog() });

    expect(mockGraphql).not.toHaveBeenCalled();
    expect(res.added).toBe(0);
    expect(res.incomplete).toBe(false);
  });

  // hasNextPage:true with a null cursor is not "start over" — it is "we cannot continue".
  it('stops rather than re-reading page one when the cursor is missing', async () => {
    const page = firstPage(['t1'], { hasNextPage: true, endCursor: null });

    const res = await drainReviewThreads(page, { ...opts, log: makeLog() });

    expect(mockGraphql).not.toHaveBeenCalled();
    expect(res.added).toBe(0);
  });

  it('appends every continuation page in order and reports the spend', async () => {
    mockGraphql
      .mockResolvedValueOnce(contResponse(['t3', 't4'], 'c2'))
      .mockResolvedValueOnce(contResponse(['t5'], null));
    const page = firstPage(['t1', 't2'], { hasNextPage: true, endCursor: 'c1' });

    const res = await drainReviewThreads(page, { ...opts, log: makeLog() });

    expect(res).toEqual({ added: 3, pages: 2, incomplete: false });
    expect(page.nodes.map((t) => t.id)).toEqual(['t1', 't2', 't3', 't4', 't5']);
    // Each continuation continues from the PREVIOUS page's cursor, never from the first.
    expect(mockGraphql.mock.calls[0]?.[2]).toMatchObject({ cursor: 'c1', number: 9016 });
    expect(mockGraphql.mock.calls[1]?.[2]).toMatchObject({ cursor: 'c2' });
    // Every response's rateLimit is fed back so the caller's own gate sees this spend.
    expect(mockNoteBudget).toHaveBeenCalledTimes(2);
    // The connection now describes what it HOLDS. Leaving the first page's cursor here would
    // make a second drain of the same object re-fetch from the top and double every thread.
    expect(page.pageInfo).toEqual({ hasNextPage: false, endCursor: null });
  });

  it('leaves a resume cursor on the connection when it stops short', async () => {
    mockGraphql
      .mockResolvedValueOnce(contResponse(['t3'], 'c2'))
      .mockRejectedValueOnce(new Error('boom'));
    const page = firstPage(['t1'], { hasNextPage: true, endCursor: 'c1' });

    await drainReviewThreads(page, { ...opts, log: makeLog() });

    expect(page.pageInfo).toEqual({ hasNextPage: true, endCursor: 'c2' });
  });

  it('declines to spend when the account is already in a hard limit window', async () => {
    mockIsLimited.mockReturnValue(true);
    const page = firstPage(['t1'], { hasNextPage: true, endCursor: 'c1' });

    const res = await drainReviewThreads(page, { ...opts, log: makeLog() });

    expect(mockGraphql).not.toHaveBeenCalled();
    expect(res).toEqual({ added: 0, pages: 0, incomplete: true });
  });

  // A partial drain is strictly more data than before (threads upsert, nothing prunes), so
  // the contract is "keep what arrived", never "throw away the page".
  it('keeps the pages it got when a continuation fails, and reports a limit it hit', async () => {
    mockGraphql
      .mockResolvedValueOnce(contResponse(['t3'], 'c2'))
      .mockRejectedValueOnce(Object.assign(new Error('rate limited'), { limited: true }));
    const page = firstPage(['t1'], { hasNextPage: true, endCursor: 'c1' });

    const res = await drainReviewThreads(page, { ...opts, log: makeLog() });

    expect(res).toEqual({ added: 1, pages: 1, incomplete: true });
    expect(page.nodes.map((t) => t.id)).toEqual(['t1', 't3']);
    // Without this the walk's next pre-emptive gate stands down while the drain keeps firing.
    expect(mockNoteLimited).toHaveBeenCalledWith(7, new Date('2030-01-01T00:00:00Z'));
  });

  it('never throws on an ordinary failure', async () => {
    mockGraphql.mockRejectedValue(new Error('boom'));
    const page = firstPage(['t1'], { hasNextPage: true, endCursor: 'c1' });

    await expect(drainReviewThreads(page, { ...opts, log: makeLog() })).resolves.toMatchObject({
      incomplete: true,
    });
    expect(mockNoteLimited).not.toHaveBeenCalled();
  });

  it('stops between pages when the walk is cancelled', async () => {
    mockGraphql.mockResolvedValue(contResponse(['t3'], 'c2'));
    let calls = 0;
    const page = firstPage(['t1'], { hasNextPage: true, endCursor: 'c1' });

    const res = await drainReviewThreads(page, {
      ...opts,
      log: makeLog(),
      shouldCancel: () => calls++ > 0,
    });

    expect(res.incomplete).toBe(true);
    expect(mockGraphql).toHaveBeenCalledTimes(1);
  });

  it('stops with what it has when the PR node disappears mid-drain', async () => {
    mockGraphql.mockResolvedValueOnce({
      repository: { pullRequest: null },
      rateLimit: { remaining: 4000, resetAt: '2030-01-01T00:00:00Z', cost: 1 },
    });
    const page = firstPage(['t1'], { hasNextPage: true, endCursor: 'c1' });

    const res = await drainReviewThreads(page, { ...opts, log: makeLog() });

    expect(res).toEqual({ added: 0, pages: 1, incomplete: true });
    expect(page.nodes).toHaveLength(1);
  });

  // The graphqlTolerant three-state rule, one level inside the connection: a partial nulls the
  // errored SELECTION and leaves its key present, so `nodes: null` is "the list never arrived",
  // not "there are none". Dereferencing it would throw out of a module whose whole posture is
  // that it degrades — the walk would stamp the repo `lastSyncStatus='error'` and drop every
  // remaining PR on the page, and hydration would 500 a PR that was otherwise fine.
  it('degrades to the first page when a partial nulls the continuation list', async () => {
    mockGraphql.mockResolvedValueOnce({
      repository: {
        pullRequest: {
          reviewThreads: { pageInfo: { hasNextPage: true, endCursor: 'c2' }, nodes: null },
        },
      },
      rateLimit: { remaining: 4000, resetAt: '2030-01-01T00:00:00Z', cost: 1 },
    });
    const page = firstPage(['t1'], { hasNextPage: true, endCursor: 'c1' });

    const res = await drainReviewThreads(page, { ...opts, log: makeLog() });

    expect(res).toEqual({ added: 0, pages: 1, incomplete: true });
    expect(page.nodes.map((t) => t.id)).toEqual(['t1']);
    // Resume from the page we asked for, not the one it claimed to hand back: we never saw it.
    expect(page.pageInfo).toEqual({ hasNextPage: true, endCursor: 'c1' });
  });

  // The likelier half of the same partial: a per-node error nulls one ELEMENT. It must not
  // reach `page.nodes` — persistPr and both callers' own `.filter((t) => !t.isResolved)` walk
  // this list unguarded — and it must not be counted as a thread that was appended.
  it('drops null thread nodes out of a partial continuation instead of appending them', async () => {
    mockGraphql.mockResolvedValueOnce({
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [null, thread('t3'), null],
          },
        },
      },
      rateLimit: { remaining: 4000, resetAt: '2030-01-01T00:00:00Z', cost: 1 },
    });
    const page = firstPage(['t1'], { hasNextPage: true, endCursor: 'c1' });

    const res = await drainReviewThreads(page, { ...opts, log: makeLog() });

    expect(res).toEqual({ added: 1, pages: 1, incomplete: false });
    expect(page.nodes.every((t) => t != null)).toBe(true);
    expect(page.nodes.map((t) => t.id)).toEqual(['t1', 't3']);
  });

  // Not a shape GitHub produces — the point is that it CANNOT produce an infinite loop here.
  it('stops instead of spinning when the cursor does not advance', async () => {
    mockGraphql.mockResolvedValue(contResponse(['t3'], 'c1'));
    const page = firstPage(['t1'], { hasNextPage: true, endCursor: 'c1' });

    const res = await drainReviewThreads(page, { ...opts, log: makeLog() });

    expect(mockGraphql).toHaveBeenCalledTimes(1);
    expect(res.incomplete).toBe(true);
  });

  it('caps the pages one PR can spend', async () => {
    // Always "more", always a fresh cursor — only the page cap can end this.
    let n = 0;
    mockGraphql.mockImplementation(async () => contResponse([`t${n}`], `c${++n + 1}`));
    const page = firstPage(['t1'], { hasNextPage: true, endCursor: 'c1' });

    const res = await drainReviewThreads(page, { ...opts, log: makeLog() });

    expect(res.pages).toBe(20);
    expect(res.incomplete).toBe(true);
  });
});

// The continuation exists to feed the SAME persistPr as the first page. If its thread
// selection drifts from the walk's, threads 51+ arrive with fewer fields than threads 1-50
// and deriveThreadState starts answering differently depending on which page a thread landed
// on — a defect that would only ever show up on the bot-flooded PRs this drain exists for.
describe('PR_REVIEW_THREADS_PAGE_QUERY shape parity', () => {
  it('is well-formed and continues from a required cursor', () => {
    const balanced = (q: string): boolean =>
      (q.match(/{/g) ?? []).length === (q.match(/}/g) ?? []).length;
    expect(balanced(PR_REVIEW_THREADS_PAGE_QUERY)).toBe(true);
    // String! not String: a null cursor would silently re-read page one, forever.
    expect(PR_REVIEW_THREADS_PAGE_QUERY).toContain('$cursor: String!');
    expect(PR_REVIEW_THREADS_PAGE_QUERY).toContain('reviewThreads(first: 50, after: $cursor)');
  });

  it('selects every thread field the walk selects', () => {
    for (const field of [
      'isResolved',
      'isOutdated',
      'isCollapsed',
      'resolvedBy',
      'fullDatabaseId',
      'createdAt',
    ]) {
      expect(PR_REVIEW_THREADS_PAGE_QUERY).toContain(field);
      expect(REPO_ACTIVITY_QUERY).toContain(field);
    }
  });

  // The cap is priced per REQUEST, not per row (measured: 15 pts/page at 50, 28 at 100 —
  // charged identically on a repo with no threads at all). Raising it taxes every repo
  // forever for a 2.6% tail that a 100 cap would not fully cover anyway; drain instead.
  it('keeps the walk capped at 50 with the connection metadata that makes draining possible', () => {
    expect(REPO_ACTIVITY_QUERY).toContain('reviewThreads(first: 50)');
    expect(REPO_ACTIVITY_QUERY).toMatch(/reviewThreads\(first: 50\) \{\s*totalCount/);
  });
});
