// `POST /api/prs/:id/reopen` and its LOCAL STAMP, on a THROWAWAY sqlite DB (the
// review-comment.test.ts pattern): env is set BEFORE importing config/client, the real route,
// real permission check and real query layer all run, and only GitHub (github/mutations.js) and
// the token source are stubbed.
//
// WHAT THIS PINS, and why each one is worth a fixture rather than a comment:
//
//   1. THE PERMISSION RULE IS GITHUB'S: WRITE+ **OR** the PR author. Both halves are asserted,
//      including the half that CLEARS a READ permission by authorship alone.
//   2. TWO 409s, NOT ONE. 'already open' and 'merged' are different facts and the merged one is
//      permanent, so they carry different error codes and different sentences — and in both cases
//      GitHub is never called.
//   3. ⚠ `closedAt` MUST BE NULLED. `db/automation-output.ts` counts `prs_closed_unmerged` as
//      `mergedAt IS NULL` inside a `closedAt` window and NEVER consults `state`, so a reopened PR
//      carrying its old close stamp is reported as abandoned churn until a full walk rewrites the
//      column. A one-line inverse of the close stamp leaves it behind and nothing errors.
//   4. ⚠ THE `pr_reopened` EVENT IS WRITTEN HERE OR NOWHERE. `sync/upsert.ts`'s
//      `lifecycleTransitions` emits it only when the PRE-UPSERT row reads 'closed' — and this
//      stamp has already made it 'open', so every later sync sees prev === 'open' and the
//      transition is lost PERMANENTLY. The dedupeKey is the sync's own spelling
//      (`pr_reopened:<prNodeId>`) so the two writers are idempotent against each other.
//   5. ⚠ `mergeStateStatus` GOES TO 'unknown', NEVER TO A GUESS. GitHub recomputes mergeability
//      asynchronously after a reopen; the stored value predates the close.
//   6. A REFUSAL FROM GITHUB LEAVES THE LOCAL ROW ALONE. The ordinary refusal (the head branch was
//      deleted after the close) is a 409 carrying GitHub's own sentence — not a 502, which would
//      say something is broken and invite a retry that fails identically.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const DB_PATH = '/tmp/pierre-reopen-route-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

const reopenPullRequest = vi.fn();
// Spread the real module so every export this route file (and its siblings) don't stub still
// resolves — a bare factory would break every unmocked import.
vi.mock('../../github/mutations.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  reopenPullRequest,
}));
// ⚠ SPREAD, NOT REPLACE: `getAccountUserId` lives in this module too and must stay REAL — it is
// what resolves the viewer, and a stub would make the authorship half of the permission rule
// vacuous in both directions.
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

const now = Math.floor(Date.now() / 1000) * 1000;
const CLOSED_AT = new Date(now - 3 * 3600_000);

const VIEWER_LOGIN = 'viewer-me';
const prIdByKey = new Map<string, number>();
const nodeIdByKey = new Map<string, string>();
let writeRepoId = 0;
let viewerUserId = 0;
let aliceId = 0;
let foreignPrId = 0;

const pr = (key: string): number => prIdByKey.get(key)!;

async function reopen(id: number): Promise<any> {
  return app.inject({ method: 'POST', url: `/api/prs/${id}/reopen` });
}
async function prRow(id: number): Promise<any> {
  const rows = await db
    .select()
    .from(schema.pullRequests)
    .where(eq(schema.pullRequests.id, id))
    .execute();
  return rows[0];
}
async function reopenEvents(id: number): Promise<any[]> {
  return db
    .select()
    .from(schema.events)
    .where(eq(schema.events.prId, id))
    .execute()
    .then((rows: any[]) => rows.filter((r) => r.type === 'pr_reopened'));
}
/** Put the PR back the way GitHub had it before the reopen, so each test starts from 'closed'. */
async function resetClosed(id: number): Promise<void> {
  await db
    .update(schema.pullRequests)
    .set({ state: 'closed', closedAt: CLOSED_AT, mergeStateStatus: 'clean' })
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

  // Migration 0008 seeds account 1 with an EMPTY github_login, which makes `getAccountUserId`
  // return null — the authorship half of the permission rule would then never fire and BOTH the
  // "403 cleared by authorship" and the actor on the event row would be vacuous.
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

  const insertRepo = async (
    accountId: number,
    name: string,
    viewerPermission: string | null,
  ): Promise<number> => {
    const [r] = await db
      .insert(repos)
      .values({
        accountId,
        owner: 'acme',
        name,
        githubNodeId: `R_reopen_${accountId}_${name}`,
        viewerPermission,
      })
      .returning()
      .execute();
    return r.id;
  };
  let n = 1;
  const insertPr = async (
    accountId: number,
    repoId: number,
    key: string,
    values: Record<string, unknown>,
  ): Promise<number> => {
    const nodeId = `PR_reopen_${key}`;
    const [row] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: nodeId,
        accountId,
        repoId,
        number: n++,
        title: `${key} fixture`,
        authorId: aliceId,
        openedAt: new Date(now - 5 * 86_400_000),
        updatedAt: new Date(now - 3600_000),
        headSha: 'headsha',
        ...values,
      })
      .returning()
      .execute();
    prIdByKey.set(key, row.id);
    nodeIdByKey.set(key, nodeId);
    return row.id;
  };

  writeRepoId = await insertRepo(1, 'write', 'WRITE');
  const readRepoId = await insertRepo(1, 'read', 'READ');

  await insertPr(1, writeRepoId, 'closed', { state: 'closed', closedAt: CLOSED_AT });
  await insertPr(1, writeRepoId, 'open', { state: 'open' });
  await insertPr(1, writeRepoId, 'merged', {
    state: 'merged',
    mergedAt: new Date(now - 86_400_000),
    closedAt: new Date(now - 86_400_000),
  });
  // READ permission + somebody else's PR: neither half of the rule is satisfied.
  await insertPr(1, readRepoId, 'read-theirs', { state: 'closed', closedAt: CLOSED_AT });
  // READ permission + the VIEWER authored it: GitHub lets an author reopen their own PR without
  // push access, so the 403 must clear on authorship ALONE.
  await insertPr(1, readRepoId, 'read-mine', {
    state: 'closed',
    closedAt: CLOSED_AT,
    authorId: viewerUserId,
  });

  // Account 2 owns a mirror-image closed PR — what keeps the isolation assertion from passing
  // vacuously (the row exists and is perfectly reopenable, by ITS owner).
  await db
    .insert(schema.accounts)
    .values({ id: 2, githubUserId: 'gh_2', githubLogin: 'neighbour' })
    .execute();
  const foreignRepoId = await insertRepo(2, 'write', 'ADMIN');
  foreignPrId = await insertPr(2, foreignRepoId, 'foreign', {
    state: 'closed',
    closedAt: CLOSED_AT,
  });

  const { prRoutes } = await import('./prs.js');
  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  await app.register(prRoutes);
  await app.ready();
  // Generous: this hook runs the real migrations and loads the whole query layer + route tree,
  // which is a few seconds on a cold transform — past vitest's 10s hook default.
}, 60_000);

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  getAccessToken.mockResolvedValue('tok');
  reopenPullRequest.mockResolvedValue({ ok: true });
  await resetClosed(pr('closed'));
  await db.delete(schema.events).execute();
});

describe('who may reopen', () => {
  it('404s on another account’s PR without touching GitHub', async () => {
    const res = await reopen(foreignPrId);
    expect(res.statusCode).toBe(404);
    expect(reopenPullRequest).not.toHaveBeenCalled();
  });

  it('403s on READ permission when the viewer did not author it', async () => {
    const res = await reopen(pr('read-theirs'));
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('NotPermitted');
    expect(reopenPullRequest).not.toHaveBeenCalled();
  });

  it('⚠ clears that 403 on AUTHORSHIP alone, with the same READ permission', async () => {
    // The half GitHub grants and a `viewerCanPush`-only gate would refuse. Without this the 403
    // above would pass with the author test deleted.
    const res = await reopen(pr('read-mine'));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ reopened: true, state: 'open' });
    await resetClosed(pr('read-mine'));
  });
});

describe('what state may be reopened', () => {
  it('409s NotClosed on an already-open PR, without calling GitHub', async () => {
    const res = await reopen(pr('open'));
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('NotClosed');
    expect(reopenPullRequest).not.toHaveBeenCalled();
  });

  it('⚠ 409s AlreadyMerged on a MERGED PR — its own code and its own sentence', async () => {
    // A merged PR is permanently un-reopenable and an open one is a no-op; sharing a sentence
    // would tell the reader to try again on the one case that can never work.
    const res = await reopen(pr('merged'));
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error).toBe('AlreadyMerged');
    expect(body.message).not.toBe('This PR is already open.');
    expect(reopenPullRequest).not.toHaveBeenCalled();
  });
});

describe('the local stamp', () => {
  it('flips the row to open, NULLS closedAt and un-knows the merge state', async () => {
    const res = await reopen(pr('closed'));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ reopened: true, state: 'open' });

    const row = await prRow(pr('closed'));
    expect(row.state).toBe('open');
    // ⚠ THE ONE THAT WOULD SHIP BROKEN. `prs_closed_unmerged` is counted off `closedAt` +
    // `mergedAt IS NULL` and never reads `state`, so a leftover close stamp reports a live PR as
    // abandoned churn for as long as it takes a full walk to rewrite the column.
    expect(row.closedAt).toBeNull();
    // ⚠ NOT A GUESS. GitHub recomputes mergeability asynchronously after a reopen, so anything
    // other than 'unknown' would let mergeVerdict() assert a landing verdict from a pre-close
    // value — the Merge button, the Pending card and READY_MERGE_STATES all read it.
    expect(row.mergeStateStatus).toBe('unknown');
    // The merge columns are not this route's business, in either direction.
    expect(row.mergedAt).toBeNull();
    expect(row.mergedById).toBeNull();
    // Account-scoped and id-addressed: the neighbouring closed PR is untouched.
    expect((await prRow(pr('read-theirs'))).state).toBe('closed');
  });

  it('⚠ writes the pr_reopened event itself, with the sync’s own dedupeKey', async () => {
    await reopen(pr('closed'));

    const rows = await reopenEvents(pr('closed'));
    expect(rows).toHaveLength(1);
    const ev = rows[0];
    // The sync's spelling, so the two writers are idempotent against each other. Stamping
    // `state: 'open'` is precisely what stops `lifecycleTransitions` from ever emitting this row,
    // so if this write is missing the reopen never appears on the timeline or the feed — with
    // nothing anywhere reporting a failure.
    expect(ev.dedupeKey).toBe(`pr_reopened:${nodeIdByKey.get('closed')}`);
    expect(ev.accountId).toBe(1);
    expect(ev.repoId).toBe(writeRepoId);
    expect(ev.prId).toBe(pr('closed'));
    expect(ev.actorId).toBe(viewerUserId);
    expect(ev.refTable).toBe('pull_requests');
    expect(ev.refId).toBe(pr('closed'));
  });

  it('stays ONE event row across a close-and-reopen round trip', async () => {
    await reopen(pr('closed'));
    // What a sync (or the Close button) would do next, then the same reopen again.
    await resetClosed(pr('closed'));
    const res = await reopen(pr('closed'));

    expect(res.statusCode).toBe(200);
    // The `onConflictDoUpdate` on (accountId, dedupeKey) — the same conflict target the sync
    // uses — is what makes the stamp idempotent instead of duplicating the timeline marker.
    expect(await reopenEvents(pr('closed'))).toHaveLength(1);
  });
});

describe('when GitHub refuses', () => {
  it('⚠ answers 409 with GitHub’s own sentence, and leaves the row closed', async () => {
    // The ORDINARY aftermath of closing a PR is that the head branch gets deleted, and GitHub
    // then refuses the reopen. Nothing is broken and no retry helps, so this is a conflict, not
    // a 502 — and the useful text is NESTED in GitHub's `errors[]` ("Validation Failed" alone
    // explains nothing).
    const sentence = 'state cannot be changed. The feature-x branch was deleted.';
    reopenPullRequest.mockResolvedValue({
      ok: false,
      reason: 'not_reopenable',
      message: sentence,
    });

    const res = await reopen(pr('closed'));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'NotReopenable', message: sentence });

    const row = await prRow(pr('closed'));
    expect(row.state).toBe('closed');
    expect(row.closedAt).not.toBeNull();
    expect(await reopenEvents(pr('closed'))).toHaveLength(0);
  });

  it.each([
    ['not_found', 404, 'NotFound'],
    ['error', 502, 'GitHubError'],
  ])('maps %s to %i, leaving the row alone', async (reason, status, error) => {
    reopenPullRequest.mockResolvedValue({ ok: false, reason, message: 'nope' });

    const res = await reopen(pr('closed'));
    expect(res.statusCode).toBe(status);
    expect(res.json().error).toBe(error);
    expect((await prRow(pr('closed'))).state).toBe('closed');
    expect(await reopenEvents(pr('closed'))).toHaveLength(0);
  });

  it('502s when the token cannot be resolved, without stamping anything', async () => {
    getAccessToken.mockRejectedValue(new Error('gh auth token failed'));

    const res = await reopen(pr('closed'));
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('GitHubError');
    expect(reopenPullRequest).not.toHaveBeenCalled();
    expect((await prRow(pr('closed'))).state).toBe('closed');
  });
});
