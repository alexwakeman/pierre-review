import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Logger } from './sync-repo.js';

// Mock at the same boundaries as sync-manager.test.ts / two-phase-sync.test.ts: the DB
// client, config, per-account token, the GraphQL layer, and the persist/commit-files
// helpers — so syncOnePr's own logic (SHA gathering, persist wiring, guards) is exercised
// without touching Postgres/SQLite or GitHub.
vi.mock('../config.js', () => ({
  config: { webhookDebounceMs: 4000, commitFileConcurrency: 10, persistBodies: false },
}));
vi.mock('../db/client.js', () => {
  const repos = { id: 'repos.id', owner: 'repos.owner', name: 'repos.name', accountId: 'repos.accountId' };
  const repoRow = { owner: 'o', name: 'n', accountId: 7 };
  const select = (): Record<string, unknown> => {
    const chain: Record<string, unknown> = {
      from: () => chain,
      where: () => chain,
      limit: () => chain,
      execute: async () => [repoRow],
    };
    return chain;
  };
  return { db: { select }, schema: { repos } };
});
vi.mock('../auth/account.js', () => ({ getAccessToken: vi.fn(async () => 'tok') }));
vi.mock('../github/client.js', () => ({
  getGraphqlClientFor: vi.fn(() => ({})),
  graphqlTolerant: vi.fn(),
  // A SAML error node is tagged { saml: true } by the tests below.
  isSamlBlock: (e: unknown) =>
    Array.isArray(e) && e.some((x) => (x as { saml?: boolean })?.saml === true),
  graphqlChecksHint: () => '',
  summarizeGraphqlErrors: () => '',
}));
vi.mock('./auth-notices.js', () => ({ recordSamlBlock: vi.fn(), clearSamlBlock: vi.fn() }));
vi.mock('./commit-files.js', () => ({ ensureCommitFiles: vi.fn(async () => new Map()) }));
vi.mock('./upsert.js', () => ({
  persistPr: vi.fn(async () => {}),
  createUserResolver: () => ({ resolve: async () => null }),
}));

import { graphqlTolerant } from '../github/client.js';
import { ensureCommitFiles } from './commit-files.js';
import { persistPr } from './upsert.js';
import { recordSamlBlock, clearSamlBlock } from './auth-notices.js';
import { PR_ACTIVITY_ONE_QUERY, REPO_ACTIVITY_QUERY } from '../github/queries.js';
import { syncOnePr, enqueuePrSync, __resetTargetedSyncState } from './sync-one-pr.js';

const mockGraphql = vi.mocked(graphqlTolerant) as unknown as Mock;
const mockEnsure = vi.mocked(ensureCommitFiles) as unknown as Mock;
const mockPersist = vi.mocked(persistPr) as unknown as Mock;
const mockRecordSaml = vi.mocked(recordSamlBlock);
const mockClearSaml = vi.mocked(clearSamlBlock);

const makeLog = (): Logger => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

// A PR node with one UNRESOLVED thread (last comment on the 10th) and one resolved one.
// Only commits AFTER the unresolved thread's last comment should be gathered for the
// thread-state heuristic — so SHA_LATER (11th) is fetched, SHA_EARLIER (5th) is not.
const prNode = {
  reviewThreads: {
    nodes: [
      { isResolved: false, comments: { nodes: [{ createdAt: '2026-07-10T00:00:00Z' }] } },
      { isResolved: true, comments: { nodes: [{ createdAt: '2026-07-01T00:00:00Z' }] } },
    ],
  },
  commits: {
    nodes: [
      { commit: { oid: 'SHA_LATER', committedDate: '2026-07-11T00:00:00Z' } },
      { commit: { oid: 'SHA_EARLIER', committedDate: '2026-07-05T00:00:00Z' } },
    ],
  },
};

const okResponse = (pr: unknown) => ({
  repository: { pullRequest: pr },
  rateLimit: { cost: 1, remaining: 4999, resetAt: '' },
});

beforeEach(() => {
  vi.clearAllMocks();
  __resetTargetedSyncState();
  mockEnsure.mockResolvedValue(new Map());
  mockPersist.mockResolvedValue(undefined);
});

describe('syncOnePr', () => {
  it('fetches one PR, gathers only post-threshold commit SHAs, and persists once', async () => {
    mockGraphql.mockResolvedValue(okResponse(prNode));

    const ok = await syncOnePr(1, 42, makeLog());

    expect(ok).toBe(true);
    // Only the commit AFTER the unresolved thread's last comment is fetched.
    expect(mockEnsure).toHaveBeenCalledWith('o', 'n', ['SHA_LATER'], 'tok', 10);
    // Persisted with the fetched node, the passed repoId, and the repo's accountId.
    expect(mockPersist).toHaveBeenCalledTimes(1);
    expect(mockPersist).toHaveBeenCalledWith(
      prNode,
      1,
      expect.anything(),
      expect.any(Map),
      7,
    );
    // A clean read self-dismisses any prior SAML flag; nothing recorded.
    expect(mockClearSaml).toHaveBeenCalledWith(7, 'o');
    expect(mockRecordSaml).not.toHaveBeenCalled();
  });

  it('skips (no persist) when the PR is gone / inaccessible', async () => {
    mockGraphql.mockResolvedValue(okResponse(null));

    const ok = await syncOnePr(1, 43, makeLog());

    expect(ok).toBe(false);
    expect(mockPersist).not.toHaveBeenCalled();
  });

  it('flags the org for the reconnect banner on a SAML wall', async () => {
    // The whole `repository` node is forbidden → data null; onPartial fires with a SAML error.
    mockGraphql.mockImplementation(
      async (
        _c: unknown,
        _q: unknown,
        _v: unknown,
        onPartial?: (e: unknown) => void,
      ) => {
        onPartial?.([{ saml: true }]);
        return { repository: null, rateLimit: { cost: 0, remaining: 4999, resetAt: '' } };
      },
    );

    const ok = await syncOnePr(1, 44, makeLog());

    expect(ok).toBe(false);
    expect(mockRecordSaml).toHaveBeenCalledWith(7, 'o');
    expect(mockClearSaml).not.toHaveBeenCalled();
    expect(mockPersist).not.toHaveBeenCalled();
  });

  it('stands down (returns false) when the same PR is already in flight', async () => {
    let release: (() => void) | null = null;
    // Hold the first run open inside persist so its (repoId, prNumber) stays reserved.
    mockPersist.mockImplementationOnce(
      () => new Promise<void>((r) => { release = () => r(); }),
    );
    mockGraphql.mockResolvedValue(okResponse(prNode));

    // The first call reserves its slot synchronously (before any await), so the second —
    // issued before the first settles — sees it in flight and stands down.
    const first = syncOnePr(1, 45, makeLog());
    const second = await syncOnePr(1, 45, makeLog());
    expect(second).toBe(false);

    // Let the first run reach the (hanging) persist, then release it.
    for (let i = 0; i < 20 && release === null; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(release).not.toBeNull();
    release!();

    expect(await first).toBe(true);
    // Only the first run persisted; the second never got past the guard.
    expect(mockPersist).toHaveBeenCalledTimes(1);
  });
});

describe('enqueuePrSync', () => {
  it('coalesces a burst for the same PR into a single syncOnePr', async () => {
    vi.useFakeTimers();
    try {
      mockGraphql.mockResolvedValue(okResponse(prNode));
      const log = makeLog();

      // Three signals within the debounce window (a push burst: push + synchronize + check_run).
      enqueuePrSync(1, 50, log);
      enqueuePrSync(1, 50, log);
      enqueuePrSync(1, 50, log);

      // Nothing runs until the burst settles.
      expect(mockPersist).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(4000 + 10);

      // One coalesced run.
      expect(mockPersist).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs distinct PRs independently', async () => {
    vi.useFakeTimers();
    try {
      mockGraphql.mockResolvedValue(okResponse(prNode));
      const log = makeLog();

      enqueuePrSync(1, 60, log);
      enqueuePrSync(1, 61, log);

      await vi.advanceTimersByTimeAsync(4000 + 10);

      expect(mockPersist).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// The single-PR query MUST select the same PR node fields as the per-repo walk (they share
// PR_NODE_FIELDS) so a targeted fetch feeds persistPr unchanged. Guards against a future
// edit that inlines/forks one of them or unbalances the interpolated braces.
describe('PR_ACTIVITY_ONE_QUERY shape parity', () => {
  const balanced = (q: string): boolean =>
    (q.match(/{/g) ?? []).length === (q.match(/}/g) ?? []).length;

  it('is well-formed and fetches a single PR by number', () => {
    expect(balanced(PR_ACTIVITY_ONE_QUERY)).toBe(true);
    expect(PR_ACTIVITY_ONE_QUERY).toContain('pullRequest(number: $number)');
    expect(REPO_ACTIVITY_QUERY).toContain('pullRequests(');
  });

  it('shares the full PR node field set with the per-repo walk', () => {
    for (const field of [
      'reviewThreads',
      'reviewRequests',
      'mergeStateStatus',
      'statusCheckRollup',
      'headCommit',
      'committedDate',
    ]) {
      expect(PR_ACTIVITY_ONE_QUERY).toContain(field);
      expect(REPO_ACTIVITY_QUERY).toContain(field);
    }
  });
});
