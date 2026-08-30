import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Logger } from './sync-repo.js';

// Mocked at the same boundaries as sync-one-pr.test.ts — the DB client, the GraphQL layer, and
// the persist/commit-files/branch-status helpers — so the walk's OWN logic (page handling, the
// thread drain, the SHA gather, the persist wiring) runs for real against no database and no
// GitHub. The per-account rate budget is deliberately NOT mocked: it is in-memory and pure, and
// the drain's pre-emptive gate reads it, so faking it would fake away half of what is asserted.
vi.mock('../db/client.js', () => {
  const syncState = { repoId: 'sync_state.repo_id' };
  const chain: Record<string, unknown> = {
    values: () => chain,
    onConflictDoUpdate: () => chain,
    execute: async () => [],
  };
  return { db: { insert: () => chain }, schema: { syncState } };
});
vi.mock('../github/client.js', () => ({
  getGraphqlClientFor: vi.fn(() => ({})),
  graphqlTolerant: vi.fn(),
  // The page fetch is wrapped in the transient-fault retry; pass it straight through so a
  // failure surfaces as itself rather than after three backoffs.
  withGithubRetry: (fn: () => unknown) => fn(),
  isRateLimitError: () => ({ limited: false, resumeAt: null }),
  isSamlBlock: () => false,
  graphqlChecksHint: () => '',
  summarizeGraphqlErrors: () => '',
}));
vi.mock('./auth-notices.js', () => ({ recordSamlBlock: vi.fn(), clearSamlBlock: vi.fn() }));
vi.mock('./commit-files.js', () => ({ ensureCommitFiles: vi.fn(async () => new Map()) }));
vi.mock('./branch-status.js', () => ({ syncBranchStatus: vi.fn(async () => {}) }));
vi.mock('./upsert.js', () => ({
  persistPr: vi.fn(async () => {}),
  createUserResolver: () => ({ resolve: async () => null }),
  upsertRepo: vi.fn(async () => 1),
}));

import { graphqlTolerant } from '../github/client.js';
import { PR_REVIEW_THREADS_PAGE_QUERY } from '../github/queries.js';
import { __resetRateBudget } from '../github/rate-budget.js';
import { ensureCommitFiles } from './commit-files.js';
import { persistPr } from './upsert.js';
import { syncRepo } from './sync-repo.js';

const mockGraphql = vi.mocked(graphqlTolerant) as unknown as Mock;
const mockEnsure = vi.mocked(ensureCommitFiles) as unknown as Mock;
const mockPersist = vi.mocked(persistPr) as unknown as Mock;

const makeLog = (): Logger => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/** One page of the fat activity query carrying exactly the PRs handed in. */
const activityPage = (prs: unknown[]): unknown => ({
  repository: {
    id: 'R_1',
    nameWithOwner: 'o/n',
    description: null,
    viewerPermission: 'WRITE',
    defaultBranchRef: { name: 'main' },
    pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: prs },
  },
  rateLimit: { remaining: 4000, resetAt: '2030-01-01T00:00:00Z', cost: 15 },
});

const run = async (): Promise<unknown> =>
  syncRepo({
    owner: 'o',
    name: 'n',
    accountId: 7,
    token: 'tok',
    mode: 'incremental',
    since: null,
    commitFileConcurrency: 10,
    log: makeLog(),
  });

beforeEach(() => {
  vi.clearAllMocks();
  // The drain declines to spend inside a known limit window, so a limit left behind by another
  // case would turn this into a green test of nothing.
  __resetRateBudget();
  mockEnsure.mockResolvedValue(new Map());
  mockPersist.mockResolvedValue(undefined);
});

// WIRING PIN for the review-thread drain (sync/drain-review-threads.ts). The drain is one line
// inside the per-PR loop, and every guarantee it makes is invisible from here unless something
// asserts it: without it, a PR with more than fifty threads is persisted with its fifty OLDEST
// and the newest review round — the unresolved bot findings the product exists to surface —
// never lands at all.
//
// The fixture makes ORDER assertable, which is the half a "was it called?" spy would miss. The
// PR's ONLY unresolved thread arrives on the CONTINUATION, and the commit cutoff feeding the
// addressed-state heuristic is derived from the unresolved threads — so `ensureCommitFiles`
// receives SHA_LATER only if the drain ran BEFORE the gather. Delete the drain, or move it
// below the gather (the two edits the comment there warns against), and the walk asks for no
// commit files at all.
describe('syncRepo review-thread drain wiring', () => {
  const overflowPr = (): Record<string, unknown> => ({
    number: 9016,
    updatedAt: '2026-07-12T00:00:00Z',
    reviewThreads: {
      totalCount: 2,
      pageInfo: { hasNextPage: true, endCursor: 'CURSOR_1' },
      // Page one holds only a RESOLVED thread: on its own it contributes no cutoff.
      nodes: [
        {
          id: 'T_OLD',
          isResolved: true,
          comments: { nodes: [{ createdAt: '2026-07-01T00:00:00Z' }] },
        },
      ],
    },
    commits: {
      nodes: [
        { commit: { oid: 'SHA_LATER', committedDate: '2026-07-11T00:00:00Z' } },
        { commit: { oid: 'SHA_EARLIER', committedDate: '2026-07-05T00:00:00Z' } },
      ],
    },
  });

  const threadsContinuation = {
    repository: {
      pullRequest: {
        reviewThreads: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: 'T_NEW',
              isResolved: false,
              comments: { nodes: [{ createdAt: '2026-07-10T00:00:00Z' }] },
            },
          ],
        },
      },
    },
    rateLimit: { remaining: 3999, resetAt: '2030-01-01T00:00:00Z', cost: 1 },
  };

  it('drains the tail before deriving the commit cutoff, and persists one merged list', async () => {
    const pr = overflowPr();
    mockGraphql.mockImplementation(async (_c: unknown, query: unknown) =>
      query === PR_REVIEW_THREADS_PAGE_QUERY ? threadsContinuation : activityPage([pr]),
    );

    const res = (await run()) as { prCount: number; rateLimitCost: number };

    expect(res.prCount).toBe(1);
    // One fat page, then one continuation for the PR that overflowed, from ITS cursor.
    expect(mockGraphql).toHaveBeenCalledTimes(2);
    expect(mockGraphql.mock.calls[1]?.[1]).toBe(PR_REVIEW_THREADS_PAGE_QUERY);
    expect(mockGraphql.mock.calls[1]?.[2]).toMatchObject({ cursor: 'CURSOR_1', number: 9016 });
    // The cutoff came from the DRAINED thread — the ordering assertion.
    expect(mockEnsure).toHaveBeenCalledWith('o', 'n', ['SHA_LATER'], 'tok', 10, 7);
    // persistPr receives ONE complete list, never a page at a time (see drain-review-threads.ts:
    // its prior-thread snapshot is read once, up front).
    expect(mockPersist).toHaveBeenCalledTimes(1);
    const persisted = mockPersist.mock.calls[0]?.[0] as typeof pr;
    const threads = persisted.reviewThreads as { nodes: { id: string }[] };
    expect(threads.nodes.map((t) => t.id)).toEqual(['T_OLD', 'T_NEW']);
    // The continuation's point is reported in the walk's own spend, not swallowed.
    expect(res.rateLimitCost).toBe(16);
  });

  it('costs nothing extra for a PR whose threads fit one page', async () => {
    const pr = overflowPr();
    (pr.reviewThreads as { pageInfo: unknown }).pageInfo = {
      hasNextPage: false,
      endCursor: 'CURSOR_1',
    };
    mockGraphql.mockImplementation(async () => activityPage([pr]));

    const res = (await run()) as { rateLimitCost: number };

    // The overwhelmingly common shape: GitHub said the first page is the whole list, so the
    // walk's cost is exactly what it was before the drain existed.
    expect(mockGraphql).toHaveBeenCalledTimes(1);
    expect(res.rateLimitCost).toBe(15);
    expect(mockPersist).toHaveBeenCalledTimes(1);
  });
});
