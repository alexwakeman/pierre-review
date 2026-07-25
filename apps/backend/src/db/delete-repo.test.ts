// deleteRepo on a THROWAWAY sqlite DB, with foreign_keys=ON (client.ts sets the pragma).
//
// REGRESSION: ci_status_events FKs BOTH repos and pull_requests with ON DELETE no action
// (migrations 0022 / pg 0011). deleteRepo never cleared it, so removing a repo that had
// ever recorded a CI transition FK-failed at the pullRequests delete → a 500 from
// DELETE /api/repos/:id (observed in cloud). Seeding a ci_status_events row is what makes
// this test fail against the old code.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-delete-repo-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let deleteRepo: (id: number, accountId: number) => Promise<boolean>;
let eq: any;

// Seed a repo + PR + the FK-trickiest children, including a ci_status_events row (which
// references the repo AND the PR).
async function seedRepo(tag: string): Promise<{ repoId: number; prId: number }> {
  const { repos, pullRequests, events, reviewThreads, reviewComments, ciStatusEvents } =
    schema;
  const at = new Date();
  const [repo] = await db
    .insert(repos)
    .values({ accountId: 1, owner: `o_${tag}`, name: `r_${tag}`, githubNodeId: `R_${tag}` })
    .returning()
    .execute();
  const [pr] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: `PR_${tag}`,
      accountId: 1,
      repoId: repo.id,
      number: 1,
      title: `pr ${tag}`,
      state: 'open',
      isDraft: false,
      openedAt: at,
      updatedAt: at,
    })
    .returning()
    .execute();
  await db
    .insert(events)
    .values({
      accountId: 1,
      repoId: repo.id,
      prId: pr.id,
      type: 'pr_opened',
      occurredAt: at,
      dedupeKey: `pr_opened:${tag}`,
    })
    .execute();
  const [thread] = await db
    .insert(reviewThreads)
    .values({
      githubNodeId: `RT_${tag}`,
      prId: pr.id,
      path: 'a.ts',
      isResolved: false,
      derivedState: 'untouched',
      createdAt: at,
    })
    .returning()
    .execute();
  await db
    .insert(reviewComments)
    .values({ githubNodeId: `RC_${tag}`, threadId: thread.id, prId: pr.id, createdAt: at })
    .execute();
  // The row that used to break the delete.
  await db
    .insert(ciStatusEvents)
    .values({
      accountId: 1,
      repoId: repo.id,
      prId: pr.id,
      headSha: `sha_${tag}`,
      status: 'failure',
      failingChecks: ['build'],
      observedAt: at,
    })
    .execute();
  return { repoId: repo.id, prId: pr.id };
}

async function counts(repoId: number, prId: number) {
  const { repos, pullRequests, events, reviewThreads, reviewComments, ciStatusEvents } =
    schema;
  const c = async (t: any, col: any, v: number) =>
    (await db.select().from(t).where(eq(col, v)).execute()).length;
  return {
    repos: await c(repos, repos.id, repoId),
    prs: await c(pullRequests, pullRequests.id, prId),
    events: await c(events, events.prId, prId),
    threads: await c(reviewThreads, reviewThreads.prId, prId),
    comments: await c(reviewComments, reviewComments.prId, prId),
    ciEvents: await c(ciStatusEvents, ciStatusEvents.prId, prId),
  };
}

let target = { repoId: 0, prId: 0 };
let keep = { repoId: 0, prId: 0 };

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  ({ deleteRepo } = await import('./queries.js'));
  ({ eq } = await import('drizzle-orm'));
  await runMigrations();
  target = await seedRepo('gone');
  keep = await seedRepo('kept');
});

afterAll(() => closeDb?.());

describe('deleteRepo', () => {
  it('deletes a repo whose PRs have ci_status_events rows (no FK violation)', async () => {
    expect(await counts(target.repoId, target.prId)).toEqual({
      repos: 1,
      prs: 1,
      events: 1,
      threads: 1,
      comments: 1,
      ciEvents: 1,
    });

    await expect(deleteRepo(target.repoId, 1)).resolves.toBe(true);

    expect(await counts(target.repoId, target.prId)).toEqual({
      repos: 0,
      prs: 0,
      events: 0,
      threads: 0,
      comments: 0,
      ciEvents: 0,
    });
  });

  it('leaves another repo untouched', async () => {
    expect(await counts(keep.repoId, keep.prId)).toEqual({
      repos: 1,
      prs: 1,
      events: 1,
      threads: 1,
      comments: 1,
      ciEvents: 1,
    });
  });

  it('returns false for a repo owned by a different account', async () => {
    expect(await deleteRepo(keep.repoId, 999)).toBe(false);
    expect((await counts(keep.repoId, keep.prId)).repos).toBe(1);
  });
});
