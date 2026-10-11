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

  it('resetSprintReadForSite clears the old site’s automatic status order', async () => {
    const { eq } = await import('drizzle-orm');
    const row = await store.noteSprintViewed(1, wsA, new Date(1_800_000_200_000));
    await db
      .update(schema.sprintReads)
      .set({
        provider: 'jira',
        apiRoot: 'https://old.atlassian.net',
        statusOrderJson: { source: 'jira_board', readAt: '2026-10-10T00:00:00.000Z', statuses: [{ id: '1', name: 'To Do', category: 'new' }] },
      })
      .where(eq(schema.sprintReads.id, row.id))
      .execute();
    const reset = await store.resetSprintReadForSite(1, wsA, { provider: 'linear', apiRoot: 'https://linear.app/acme' });
    expect(reset?.provider).toBe('linear');
    const [after] = await db.select().from(schema.sprintReads).where(eq(schema.sprintReads.id, row.id)).execute();
    expect(after.statusOrderJson).toBeNull();
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
    expect(rec.outdated).toBe(true);
  });

  it('a stored body serves only in the current format; an old one is outdated, never thrown on', () => {
    const row = (status: string, bodyJson: unknown) =>
      ({
        id: 1, workspaceId: wsA, ident: 'x', model: 'm', status, phase: null, reposJson: [], bodyJson,
        droppedJson: null, error: null, costUsd: null, numTurns: null, createdAt: new Date(0), completedAt: null,
      }) as any;
    const v1 = { criteria: [{ n: 1, existing: 'missing' }], gaps: { missing: [] }, suggestion: { addedCriteria: [] }, questions: [] };
    expect(store.sprintAssessmentRecordOf(row('succeeded', v1))).toMatchObject({ body: null, outdated: true });
    expect(store.sprintAssessmentRecordOf(row('failed', null))).toMatchObject({ body: null, outdated: false });
    const v2 = {
      summary: 'This may already be done.',
      issues: [
        { id: 'spec_gaps', text: 'No behaviour when the upload fails.', ref: null },
        { id: 'no_persona', text: 'dropped', ref: null },
        // A retired id (rubric 1's four issues) is dropped, never thrown on.
        { id: 'too_big', text: 'dropped', ref: null },
        { id: 'unclear_done', text: 'Criterion 2 cannot be checked.', ref: { repo: 'acme/web', path: 'src/a.ts' } },
        { id: 'unclear_done', text: 'a repeat', ref: null },
        'junk',
      ],
      revisedCriteria: ['One', 7, ''],
    };
    expect(store.sprintAssessmentRecordOf(row('succeeded', v2))).toMatchObject({
      outdated: false,
      body: {
        summary: 'This may already be done.',
        issues: [
          { id: 'unclear_done', text: 'Criterion 2 cannot be checked.', ref: { repo: 'acme/web', path: 'src/a.ts' } },
          { id: 'spec_gaps', text: 'No behaviour when the upload fails.', ref: null },
        ],
        revisedCriteria: ['One'],
      },
    });
  });

  it('a run fingerprinted in the old format reads stale', async () => {
    const { createHash } = await import('node:crypto');
    const fold = await import('./sprint-stories.js');
    const ticket = { title: 'T', description: 'D', acceptanceCriteria: 'A' };
    const h = store.sprintTicketTextHash(ticket);
    const accepted = [{ repoId: 1, syncedSha: 'a' }];
    const v1 = createHash('sha256').update(['sprint-assess-v1', h, '1:a'].join('\u0000'), 'utf8').digest('hex');
    expect(fold.sprintAssessmentCurrencyFrom({ status: 'succeeded', fingerprint: v1 }, ticket, accepted)).toBe('stale');
    // A run from the four-issue format (v2) reads stale too: its issues were the old vocabulary.
    const v2 = createHash('sha256').update(['sprint-assess-v2', h, '1:a'].join('\u0000'), 'utf8').digest('hex');
    expect(fold.sprintAssessmentCurrencyFrom({ status: 'succeeded', fingerprint: v2 }, ticket, accepted)).toBe('stale');
    const now = store.sprintAssessFingerprint(h, [{ repoId: 1, sha: 'a' }]);
    expect(fold.sprintAssessmentCurrencyFrom({ status: 'succeeded', fingerprint: now }, ticket, accepted)).toBe('current');
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
