import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Logger } from './sync-repo.js';

// A walk that dies BEFORE the first page is parsed used to leave NO trace anywhere: syncRepo
// learns its own repoId from `upsertRepo`, which runs after page one comes back, and the
// error-recording upsert in its catch was guarded on that id. So a repo GitHub will not
// resolve — 404, renamed, revoked token, SAML wall — threw, was logged to a file nobody
// reads, and reported `status: 'idle'`, `lastSyncError: null` on every surface. planSync then
// found no `lastIncrementalSyncAt`, planned another FULL walk, and the loop ran once a minute
// for five weeks. `knownRepoId` is the fix; these are its two halves — the row gets written,
// and no `repos` row is ever minted for a repo that does not resolve.
//
// Same seams as sync-repo.test.ts, except the db mock RECORDS what was written.
const dbSeam = vi.hoisted(() => ({
  writes: [] as Array<{ values: Record<string, unknown>; set: Record<string, unknown> }>,
  failWrite: null as Error | null,
}));
vi.mock('../db/client.js', () => {
  const syncState = { repoId: 'sync_state.repo_id' };
  return {
    db: {
      insert: () => {
        const rec = {
          values: {} as Record<string, unknown>,
          set: {} as Record<string, unknown>,
        };
        const chain: Record<string, unknown> = {
          values: (v: Record<string, unknown>) => ((rec.values = v), chain),
          onConflictDoUpdate: (o: { set: Record<string, unknown> }) => (
            (rec.set = o.set), chain
          ),
          execute: async () => {
            if (dbSeam.failWrite) throw dbSeam.failWrite;
            dbSeam.writes.push(rec);
            return [];
          },
        };
        return chain;
      },
    },
    schema: { syncState },
  };
});
vi.mock('../github/client.js', () => ({
  getGraphqlClientFor: vi.fn(() => ({})),
  graphqlTolerant: vi.fn(),
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
import { __resetRateBudget } from '../github/rate-budget.js';
import { upsertRepo } from './upsert.js';
import { syncRepo } from './sync-repo.js';

const mockGraphql = vi.mocked(graphqlTolerant) as unknown as Mock;
const mockUpsertRepo = vi.mocked(upsertRepo) as unknown as Mock;

const makeLog = (): Logger => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

// What GitHub returns for a repo it will not resolve for this token: the `repository` node is
// null while the sibling `rateLimit` block is still charged (this is the 15-point spend the
// four dead repos were making once a minute).
const notFoundPage = {
  repository: null,
  rateLimit: { remaining: 4000, resetAt: '2030-01-01T00:00:00Z', cost: 15 },
};

const run = (over: { knownRepoId?: number } = {}, log = makeLog()): Promise<unknown> =>
  syncRepo({
    owner: 'o',
    name: 'n',
    accountId: 7,
    token: 'tok',
    mode: 'full',
    since: new Date('2026-01-01T00:00:00Z'),
    commitFileConcurrency: 10,
    log,
    ...over,
  });

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateBudget();
  dbSeam.writes.length = 0;
  dbSeam.failWrite = null;
  mockGraphql.mockResolvedValue(notFoundPage);
});

describe('a walk that fails before upsertRepo', () => {
  it('records an error sync_state row from the caller-supplied repo id', async () => {
    await expect(run({ knownRepoId: 42 })).rejects.toThrow('not found or inaccessible');

    // THE ASSERTION: the failure is now DATA. getSyncStatus reads exactly this row and
    // reports 'error' + the message, so the sync manager stops showing a silent 'idle'.
    expect(dbSeam.writes).toHaveLength(1);
    expect(dbSeam.writes[0]?.values).toMatchObject({
      repoId: 42,
      lastSyncStatus: 'error',
    });
    expect(dbSeam.writes[0]?.values.lastSyncError).toContain('not found or inaccessible');
    // ...and it stamps NO timestamps, so planSync still treats the repo as never-synced and
    // retries it (on the backed-off cadence) rather than declaring it good.
    expect(dbSeam.writes[0]?.values).not.toHaveProperty('lastIncrementalSyncAt');
    expect(dbSeam.writes[0]?.set).toEqual({
      lastSyncStatus: 'error',
      lastSyncError: expect.stringContaining('not found or inaccessible'),
    });
  });

  it('never mints a repos row for a repository GitHub will not resolve', async () => {
    await expect(run({ knownRepoId: 42 })).rejects.toThrow('not found or inaccessible');
    // The `!resp.repository` bail sits ABOVE upsertRepo precisely so a name that does not
    // resolve cannot become a row the scheduler then walks forever. (An EXISTING row is
    // deliberately left alone — a null repository is also what a revoked token and a rename
    // look like, and deleting on that signal would destroy real synced history.)
    expect(mockUpsertRepo).not.toHaveBeenCalled();
  });

  it('writes nothing when the caller cannot say which repo it is', async () => {
    // Pins the old behaviour as the REASON knownRepoId exists: with no id from either side
    // there is no row to write, and the failure is invisible. Every scheduler/sync-manager
    // path supplies one.
    await expect(run()).rejects.toThrow('not found or inaccessible');
    expect(dbSeam.writes).toHaveLength(0);
  });

  it('never lets a failed error-write mask the real failure', async () => {
    // With knownRepoId the row is the CALLER's claim rather than one this walk just upserted,
    // so a repo deleted mid-walk can fail this insert's FK. The user must still see the 404.
    dbSeam.failWrite = new Error('FOREIGN KEY constraint failed');
    const log = makeLog();
    await expect(run({ knownRepoId: 42 }, log)).rejects.toThrow('not found or inaccessible');
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('could not record the failure on sync_state'),
    );
  });
});
