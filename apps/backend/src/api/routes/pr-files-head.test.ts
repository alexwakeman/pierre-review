// GET /api/prs/:id/files ECHOES THE STORED HEAD it read the patches at, on a THROWAWAY sqlite DB
// (the merge-queue-stamp.test.ts pattern): env is set BEFORE importing config/client, the real
// route and query layer run, and only GitHub (github/mutations.js) and the token source are stubbed.
//
// WHY THIS EXISTS. The SPA keeps the Changes tab's diff at `staleTime: Infinity` and persists it,
// and nothing refetched it: after the conflict resolver, AI Fix or Update branch pushed, the tab
// showed the pre-push patches for the whole session. The SPA now refetches the diff when a PR
// detail read after it names another head (`prFilesOutdated`, apps/frontend/src/hooks/usePr.ts),
// which needs this route to say which head its answer belongs to. What this pins:
//
//   1. `headSha` is the row's `head_sha` at the read, and it moves with the row.
//   2. ⚠ THE EMPTY FALLBACK SAYS NULL. A GitHub failure answers `files: []`; stamping it with the
//      head would make the SPA treat "no files" as the current diff until the next push.
//   3. Account isolation: another tenant's PR 404s.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const DB_PATH = '/tmp/pierre-pr-files-head-route-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

const fetchPrFilesWithPatch = vi.fn();
// Spread the real module so every export the routes don't stub still resolves.
vi.mock('../../github/mutations.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchPrFilesWithPatch,
}));
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

let prId = 0;
let foreignPrId = 0;

const oneFile = {
  files: [
    {
      filename: 'src/a.ts',
      previous_filename: undefined,
      status: 'modified',
      additions: 1,
      deletions: 1,
      patch: '@@ -1 +1 @@\n-a\n+b',
      blob_url: 'https://github.com/acme/files/blob/x/src/a.ts',
    },
  ],
  truncated: false,
};

async function setHead(id: number, headSha: string | null): Promise<void> {
  await db
    .update(schema.pullRequests)
    .set({ headSha })
    .where(eq(schema.pullRequests.id, id))
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

  const { accounts, repos, pullRequests, users } = schema;
  const [author] = await db
    .insert(users)
    .values({ githubLogin: 'alice-dev', githubNodeId: 'U_alice_files', isBot: false })
    .returning()
    .execute();
  const insertRepo = async (accountId: number): Promise<number> => {
    const [r] = await db
      .insert(repos)
      .values({
        accountId,
        owner: 'acme',
        name: 'files',
        githubNodeId: `R_files_${accountId}`,
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
        githubNodeId: `PR_files_${key}`,
        accountId,
        repoId: rid,
        number: 12,
        title: `${key} fixture`,
        authorId: author.id,
        state: 'open',
        openedAt: new Date(Date.now() - 86_400_000),
        updatedAt: new Date(Date.now() - 3600_000),
        headSha: 'head-1',
        baseRefName: 'main',
      })
      .returning()
      .execute();
    return p.id;
  };
  prId = await insertPr(1, await insertRepo(1), 'mine');
  await db
    .insert(accounts)
    .values({ id: 2, githubUserId: 'gh_2', githubLogin: 'neighbour' })
    .execute();
  foreignPrId = await insertPr(2, await insertRepo(2), 'foreign');

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
  getAccessToken.mockResolvedValue('tok');
  fetchPrFilesWithPatch.mockResolvedValue(oneFile);
  await setHead(prId, 'head-1');
});

describe('GET /api/prs/:id/files — the head the patches were read at', () => {
  it('echoes the stored head, and follows it when the row moves', async () => {
    const first = await app.inject({ method: 'GET', url: `/api/prs/${prId}/files` });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ truncated: false, headSha: 'head-1' });
    expect(first.json().files).toHaveLength(1);

    await setHead(prId, 'head-2');
    const second = await app.inject({ method: 'GET', url: `/api/prs/${prId}/files` });
    expect(second.json().headSha).toBe('head-2');
  });

  it('says null when there is no stored head', async () => {
    await setHead(prId, null);
    const res = await app.inject({ method: 'GET', url: `/api/prs/${prId}/files` });
    expect(res.statusCode).toBe(200);
    expect(res.json().headSha).toBeNull();
  });

  it('stamps the empty fallback null, never the head', async () => {
    fetchPrFilesWithPatch.mockRejectedValueOnce(new Error('502 from GitHub'));
    const res = await app.inject({ method: 'GET', url: `/api/prs/${prId}/files` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ files: [], truncated: false, headSha: null });
  });

  it("404s another account's PR and never reads GitHub for it", async () => {
    const res = await app.inject({ method: 'GET', url: `/api/prs/${foreignPrId}/files` });
    expect(res.statusCode).toBe(404);
    expect(fetchPrFilesWithPatch).not.toHaveBeenCalled();
  });
});
