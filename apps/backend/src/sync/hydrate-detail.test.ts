// The 60s hydration cache and its INVALIDATION path, mocked at the same boundaries as
// sync-one-pr.test.ts (config, db client, token, GraphQL) so no DB or GitHub is touched.
//
// The invalidator is what makes a just-posted inline comment show its code context: a
// comment's `diffHunk` is lean-gated (sync stores null unless PERSIST_BODIES=true), so
// hydration is the ONLY source of it, and a ≤60s-old snapshot has no entry for the new
// comment's node id. Deleting the cached entry alone is not enough — hence the epoch guard
// covered by the last two cases.
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { PrDetail } from '@pierre-review/shared';

vi.mock('../config.js', () => ({ config: { persistBodies: false } }));
// nodeIdMap's selects; no stored rows, so nothing is overlaid onto comments/reviews and the
// PR body alone tells us WHICH upstream snapshot a call was served.
vi.mock('../db/client.js', () => {
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    innerJoin: () => chain,
    limit: () => chain,
    set: () => chain,
    returning: () => chain,
    execute: async () => [],
  };
  // Stand-in tables: hydrate-detail destructures these off `schema` at module load and only
  // ever reads column handles off them (the mocked query chain ignores the values).
  const table = (): Record<string, string> => ({
    id: 'id',
    githubNodeId: 'github_node_id',
    prId: 'pr_id',
    body: 'body',
    owner: 'owner',
    name: 'name',
    number: 'number',
  });
  return {
    // `update` is reachable only when the NULL-body write-back finds rows, and the select
    // chain returns none here — the write-back's real behaviour is covered on a real DB by
    // hydrate-backfill.test.ts.
    db: { select: () => chain, update: () => chain },
    schema: {
      reviews: table(),
      reviewComments: table(),
      prComments: table(),
      reviewThreads: table(),
      pullRequests: table(),
      repos: table(),
    },
  };
});
vi.mock('../auth/account.js', () => ({ getAccessToken: vi.fn(async () => 'tok') }));
vi.mock('../github/client.js', () => ({
  getGraphqlClientFor: vi.fn(() => ({})),
  graphqlTolerant: vi.fn(),
  isSamlBlock: () => false,
  graphqlChecksHint: () => '',
  summarizeGraphqlErrors: () => '',
  // Read by hydration's own catch and by the thread drain's. A mock factory REPLACES the
  // module, so omitting a real export turns any case that reaches a failure path into an
  // unrelated "no export defined" error rather than the behaviour under test.
  isRateLimitError: () => ({ limited: false, resumeAt: null }),
}));
vi.mock('./upsert.js', () => ({ checkRunsFrom: () => [] }));

import { graphqlTolerant } from '../github/client.js';
import { PR_DETAIL_THREADS_PAGE_QUERY } from '../github/queries.js';
import { __resetRateBudget } from '../github/rate-budget.js';
import {
  fetchReviewCommentHunks,
  hydratePrDetail,
  invalidatePrHydration,
} from './hydrate-detail.js';

const mockGraphql = vi.mocked(graphqlTolerant) as unknown as Mock;

// A PR node whose only distinguishing field is the body — that's the snapshot marker.
const node = (body: string): unknown => ({
  repository: {
    pullRequest: {
      body,
      reviews: { nodes: [] },
      reviewThreads: { nodes: [] },
      comments: { nodes: [] },
      commits: { nodes: [] },
      headCommit: { nodes: [] },
      additions: 1,
      deletions: 0,
      changedFiles: 1,
      files: { nodes: [] },
    },
  },
});

// The stored detail hydration overlays onto. Only the fields hydratePrDetail reads matter.
const detail = {
  id: 1,
  number: 7,
  repoFullName: 'acme/api',
  githubUrl: 'https://github.com/acme/api/pull/7',
  threads: [],
  reviews: [],
  comments: [],
  commits: [],
} as unknown as PrDetail;

const hydrate = async (): Promise<string | null> =>
  (await hydratePrDetail(detail, 1)).body;

beforeEach(() => {
  vi.clearAllMocks();
  // Start each case from a clean cache for this key.
  invalidatePrHydration(1, 'acme', 'api', 7);
  // Hydration and the thread drain both pre-empt on the real per-account budget, so a leaked
  // limit from another case would make either a silent no-op.
  __resetRateBudget();
});

describe('hydration cache', () => {
  it('serves a second open of the same PR from cache (no second GitHub call)', async () => {
    mockGraphql.mockResolvedValue(node('first'));

    expect(await hydrate()).toBe('first');
    expect(await hydrate()).toBe('first');
    expect(mockGraphql).toHaveBeenCalledTimes(1);
  });

  it('invalidatePrHydration forces the next open to re-fetch', async () => {
    mockGraphql.mockResolvedValue(node('before-write'));
    expect(await hydrate()).toBe('before-write');

    mockGraphql.mockResolvedValue(node('after-write'));
    invalidatePrHydration(1, 'acme', 'api', 7);

    expect(await hydrate()).toBe('after-write');
    expect(mockGraphql).toHaveBeenCalledTimes(2);
  });

  it('leaves other PRs / other accounts alone', async () => {
    mockGraphql.mockResolvedValue(node('first'));
    expect(await hydrate()).toBe('first');

    // Same PR, different tenant; different PR, same tenant.
    invalidatePrHydration(2, 'acme', 'api', 7);
    invalidatePrHydration(1, 'acme', 'api', 8);

    expect(await hydrate()).toBe('first');
    expect(mockGraphql).toHaveBeenCalledTimes(1);
  });

  it('does not hand a pre-invalidation in-flight fetch to a reader that arrived after it', async () => {
    // The race the epoch guard exists for: a hydration that started BEFORE the write is
    // reading pre-write state, so sharing it with a post-write reader would serve exactly
    // the stale snapshot the invalidation was meant to drop.
    let releaseFirst: (() => void) | null = null;
    mockGraphql.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve(node('before-write'));
        }),
    );

    const inFlight = hydrate();
    for (let i = 0; i < 20 && releaseFirst === null; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    invalidatePrHydration(1, 'acme', 'api', 7);

    mockGraphql.mockResolvedValue(node('after-write'));
    const after = hydrate();

    releaseFirst!();
    // Whoever asked before the write still gets that answer; the later reader gets the fresh
    // one from its own fetch.
    expect(await inFlight).toBe('before-write');
    expect(await after).toBe('after-write');
    expect(mockGraphql).toHaveBeenCalledTimes(2);
  });

  it('a pre-invalidation fetch that resolves late cannot re-poison the cache', async () => {
    let releaseFirst: (() => void) | null = null;
    mockGraphql.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve(node('before-write'));
        }),
    );

    const inFlight = hydrate();
    for (let i = 0; i < 20 && releaseFirst === null; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    invalidatePrHydration(1, 'acme', 'api', 7);
    releaseFirst!();
    await inFlight;

    // Its result was returned to its own caller but never cached, so the next open fetches.
    mockGraphql.mockResolvedValue(node('after-write'));
    expect(await hydrate()).toBe('after-write');
    expect(mockGraphql).toHaveBeenCalledTimes(2);
  });
});

// WIRING PIN for the review-thread drain (sync/drain-review-threads.ts). PR_DETAIL_QUERY still
// asks for `reviewThreads(first: 50)` — the cap is priced per REQUEST, not per row — so on a
// bot-flooded PR the tail exists only because one line in fetchGhPrTextUncached fetches it.
//
// ORDER is what makes this more than a "was it called?" spy: hydration matches stored rows by
// node id, so a comment past the first page must be in the map by the time the map is BUILT.
// Delete the drain, or move it below the `reviewCommentByNode` loop, and RC_TAIL becomes
// indistinguishable from a comment GitHub says has no code context — the exact confusion
// `commentsSeen` exists to let the caller resolve.
describe('review-thread drain wiring', () => {
  const detailWithTail = (): unknown => ({
    repository: {
      pullRequest: {
        body: 'b',
        reviews: { nodes: [] },
        reviewThreads: {
          totalCount: 2,
          pageInfo: { hasNextPage: true, endCursor: 'CURSOR_1' },
          nodes: [
            { comments: { nodes: [{ id: 'RC_PAGE1', body: 'p', diffHunk: '@@ -1 +1 @@ head' }] } },
          ],
        },
        comments: { nodes: [] },
        commits: { nodes: [] },
        headCommit: { nodes: [] },
        additions: 1,
        deletions: 0,
        changedFiles: 1,
        files: { nodes: [] },
      },
    },
    rateLimit: { remaining: 4000, resetAt: '2030-01-01T00:00:00Z', cost: 1 },
  });

  const threadsContinuation = {
    repository: {
      pullRequest: {
        reviewThreads: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            { comments: { nodes: [{ id: 'RC_TAIL', body: 't', diffHunk: '@@ -9 +9 @@ tail' }] } },
          ],
        },
      },
    },
    rateLimit: { remaining: 3999, resetAt: '2030-01-01T00:00:00Z', cost: 1 },
  };

  it('puts a thread past the first page into the hunk map and the seen count', async () => {
    mockGraphql.mockImplementation(async (_c: unknown, query: unknown) =>
      query === PR_DETAIL_THREADS_PAGE_QUERY ? threadsContinuation : detailWithTail(),
    );

    const res = await fetchReviewCommentHunks(1, 'acme', 'api', 7);

    expect(res.ok).toBe(true);
    // One detail fetch, then one continuation from the first page's cursor.
    expect(mockGraphql).toHaveBeenCalledTimes(2);
    expect(mockGraphql.mock.calls[1]?.[2]).toMatchObject({ cursor: 'CURSOR_1', number: 7 });
    expect(res.commentsSeen).toBe(2);
    expect(res.hunkByNodeId.get('RC_TAIL')).toBe('@@ -9 +9 @@ tail');
    expect(res.hunkByNodeId.get('RC_PAGE1')).toBe('@@ -1 +1 @@ head');
  });
});
