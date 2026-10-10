import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The This-sprint foundation store (db/sprint-store.ts) on a SCRATCH SQLite — never apps/backend/data.
// Pins: the demand-gate upsert, the latest-per-ticket reads (tenant-scoped), the pure hashes, and the
// STRUCTURAL tenancy of sprint_ticket_repos (a cross-account (repo, account) pair fails in the DB).

const DB_PATH = '/private/tmp/claude-501/pierre-sprint-store-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let store: typeof import('./sprint-store.js');
let wsA = 0;
let wsB = 0;
let repoA = 0;
let repoB = 0;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  closeDb = client.closeDb;
  await runMigrations();
  db = client.db;
  schema = client.schema;
  const q = await import('./queries.js');
  const have = new Set((await db.select().from(schema.accounts).execute()).map((a: any) => a.id));
  if (!have.has(1)) await db.insert(schema.accounts).values({ id: 1, githubUserId: 'U_ss_a', githubLogin: 'ss-a', isLocal: true }).execute();
  if (!have.has(2)) await db.insert(schema.accounts).values({ id: 2, githubUserId: 'U_ss_b', githubLogin: 'ss-b', isLocal: false }).execute();
  wsA = await q.ensureDefaultWorkspace(1);
  wsB = await q.ensureDefaultWorkspace(2);
  const [ra] = await db
    .insert(schema.repos)
    .values({ accountId: 1, githubNodeId: 'R_ss_a', owner: 'acme', name: 'web' })
    .returning({ id: schema.repos.id })
    .execute();
  const [rb] = await db
    .insert(schema.repos)
    .values({ accountId: 2, githubNodeId: 'R_ss_b', owner: 'other', name: 'api' })
    .returning({ id: schema.repos.id })
    .execute();
  repoA = ra.id;
  repoB = rb.id;
  store = await import('./sprint-store.js');
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('sprint store', () => {
  it('noteSprintViewed creates a due row, then only moves viewed_at', async () => {
    const t0 = new Date(1_800_000_000_000);
    const first = await store.noteSprintViewed(1, wsA, t0);
    expect(first.nextReadAt.getTime()).toBe(0);
    expect(first.viewedAt.getTime()).toBe(t0.getTime());
    await db
      .update(schema.sprintReads)
      .set({ nextReadAt: new Date(1_900_000_000_000) })
      .where((await import('drizzle-orm')).eq(schema.sprintReads.id, first.id))
      .execute();
    const t1 = new Date(1_800_000_100_000);
    const again = await store.noteSprintViewed(1, wsA, t1);
    expect(again.id).toBe(first.id);
    expect(again.viewedAt.getTime()).toBe(t1.getTime());
    expect(again.nextReadAt.getTime()).toBe(1_900_000_000_000);
    await store.markSprintReadDue(1, wsA);
    expect((await store.readSprintRead(1, wsA))?.nextReadAt.getTime()).toBe(0);
    // Another tenant's id reads nothing.
    expect(await store.readSprintRead(2, wsA)).toBeNull();
  });

  it('latest-per-ticket reads are newest-first and tenant-scoped', async () => {
    const base = { workspaceId: wsA, ident: 'jira:https://acme.atlassian.net#ENG-1', model: 'claude-sonnet-5', fingerprint: 'f', textHash: 'h', reposJson: [] };
    await db.insert(schema.sprintAssessments).values({ ...base, accountId: 1, status: 'failed', createdAt: new Date(1_000_000) }).execute();
    await db.insert(schema.sprintAssessments).values({ ...base, accountId: 1, status: 'succeeded', createdAt: new Date(2_000_000) }).execute();
    await db.insert(schema.sprintAssessments).values({ ...base, workspaceId: wsB, accountId: 2, status: 'running', createdAt: new Date(3_000_000) }).execute();
    const mine = await store.latestSprintAssessments(1, wsA, [base.ident]);
    expect(mine.get(base.ident)?.status).toBe('succeeded');
    expect((await store.latestSprintAssessments(2, wsA, [base.ident])).size).toBe(0);
    const rec = store.sprintAssessmentRecordOf(mine.get(base.ident)!);
    expect(rec.phase).toBeNull();
    expect(rec.body).toBeNull();
  });

  it('hashes are pure and order-free', () => {
    const h = store.sprintTicketTextHash({ title: 'T', description: 'D', acceptanceCriteria: 'A' });
    expect(h).toBe(store.sprintTicketTextHash({ title: 'T', description: 'D', acceptanceCriteria: 'A' }));
    expect(h).not.toBe(store.sprintTicketTextHash({ title: 'T', description: 'D', acceptanceCriteria: 'B' }));
    const a = store.sprintAssessFingerprint(h, [{ repoId: 2, sha: 'b' }, { repoId: 1, sha: 'a' }]);
    expect(a).toBe(store.sprintAssessFingerprint(h, [{ repoId: 1, sha: 'a' }, { repoId: 2, sha: 'b' }]));
    expect(a).not.toBe(store.sprintAssessFingerprint(h, [{ repoId: 1, sha: 'a' }, { repoId: 2, sha: 'c' }]));
  });

  it('sprint_ticket_repos refuses another account’s repo in the database', async () => {
    const row = { workspaceId: wsA, ident: 'jira:https://acme.atlassian.net#ENG-1', via: 'manual', acceptedAt: new Date() };
    await db.insert(schema.sprintTicketRepos).values({ ...row, accountId: 1, repoId: repoA }).execute();
    await expect(
      db.insert(schema.sprintTicketRepos).values({ ...row, accountId: 1, repoId: repoB }).execute(),
    ).rejects.toThrow();
  });
});
