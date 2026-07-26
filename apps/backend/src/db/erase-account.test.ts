// Account-erasure tests on a THROWAWAY sqlite DB (the billing.test.ts / retention.test.ts
// pattern): env is set BEFORE importing config/client, so every host module arrives via dynamic
// import in beforeAll.
//
// The point of the second test is not "delete works" — it is that a table ADDED LATER and
// forgotten cannot silently survive an erasure. It iterates the exported
// `accountScopedTables()` checklist rather than a copy of it, so a new accountId-bearing table
// that is not handled by `eraseAccountData` fails here instead of quietly leaving personal data
// behind after a user was told it was gone.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-erase-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let eraseAccountData: (accountId: number) => Promise<{ reposDeleted: number }>;
let registerAccountErasureHandler: (h: (a: { accountId: number }) => void) => void;
let accountScopedTables: () => { name: string; count: (id: number) => Promise<number> }[];
let exportAccountData: (accountId: number) => Promise<any>;

const KEEP = 1; // the seeded local account (id 1)
const DOOMED = 2;

/** Pre-erasure row counts for the surviving account, keyed by table name. */
const keepBefore: Record<string, number> = {};

/** Seed one account with a repo, a PR, an event and a row in every account-level table. */
async function seedAccount(accountId: number, login: string): Promise<void> {
  const s = schema;
  await db
    .insert(s.accounts)
    .values({
      id: accountId,
      githubUserId: `NODE_${accountId}`,
      githubLogin: login,
      displayName: login,
      isLocal: accountId === KEEP,
      accessTokenEnc: accountId === KEEP ? null : 'sealed-token-blob',
    })
    .onConflictDoUpdate({
      target: s.accounts.id,
      set: { githubLogin: login, githubUserId: `NODE_${accountId}` },
    })
    .execute();

  const repo = (
    await db
      .insert(s.repos)
      .values({
        accountId,
        githubNodeId: `REPO_${accountId}`,
        owner: 'acme',
        name: `svc-${accountId}`,
      })
      .returning()
      .execute()
  )[0];

  const user = (
    await db
      .insert(s.users)
      .values({ githubLogin: `dev-${accountId}`, displayName: `Dev ${accountId}` })
      .returning()
      .execute()
  )[0];

  const pr = (
    await db
      .insert(s.pullRequests)
      .values({
        accountId,
        repoId: repo.id,
        githubNodeId: `PR_${accountId}`,
        number: 1,
        title: `Change ${accountId}`,
        state: 'open',
        authorId: user.id,
        openedAt: new Date(),
        updatedAt: new Date(),
      })
      .returning()
      .execute()
  )[0];

  await db
    .insert(s.events)
    .values({
      accountId,
      repoId: repo.id,
      prId: pr.id,
      actorId: user.id,
      type: 'pr_opened',
      occurredAt: new Date(),
      dedupeKey: `pr_opened:PR_${accountId}`,
    })
    .execute();

  await db
    .insert(s.reviews)
    .values({
      prId: pr.id,
      githubNodeId: `REV_${accountId}`,
      authorId: user.id,
      state: 'commented',
      body: 'looks fine',
      submittedAt: new Date(),
    })
    .execute();

  // One row in each remaining account-level table, so the checklist has something to catch.
  await db
    .insert(s.aiUsage)
    .values({
      accountId,
      seam: 'summary',
      feature: 'digest',
      model: 'claude-haiku-4-5',
      costUsd: 0.01,
      occurredAt: new Date(),
    })
    .execute();
  await db
    .insert(s.myTurnDismissals)
    .values({ accountId, kind: 'thread', refId: 900 + accountId, dismissedAt: new Date() })
    .execute();
  await db
    .insert(s.botReviewClassification)
    .values({
      accountId,
      authorUserId: user.id,
      automated: true,
      kind: 'coderabbit',
      confidence: 'high',
      source: 'manual',
    })
    .execute();
  const team = (
    await db.insert(s.teams).values({ accountId, name: `Team ${accountId}` }).returning().execute()
  )[0];
  await db
    .insert(s.teamRepos)
    .values({ accountId, teamId: team.id, repoId: repo.id })
    .execute();
  await db
    .insert(s.searchIndex)
    .values({
      accountId,
      repoId: repo.id,
      prId: pr.id,
      kind: 'pr',
      refId: pr.id,
      body: 'searchable text',
      createdAt: new Date(),
    })
    .execute();
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();

  const erase = await import('./erase-account.js');
  eraseAccountData = erase.eraseAccountData;
  registerAccountErasureHandler = erase.registerAccountErasureHandler;
  accountScopedTables = erase.accountScopedTables;
  ({ exportAccountData } = await import('./export-account.js'));

  await seedAccount(KEEP, 'keeper');
  await seedAccount(DOOMED, 'doomed');

  // Snapshot the SURVIVING account's row counts before anything is erased. The isolation
  // assertion compares against this rather than requiring every table to be non-empty — some
  // (claudeReviews, benchmarkContributions) are only populated by features this seed doesn't
  // exercise, and "unchanged" is the property that actually matters.
  for (const t of accountScopedTables()) keepBefore[t.name] = await t.count(KEEP);
});

afterAll(async () => {
  await closeDb?.();
});

describe('exportAccountData', () => {
  it('exports the account and its data', async () => {
    const out = await exportAccountData(DOOMED);
    expect(out).not.toBeNull();
    expect(out.account.githubLogin).toBe('doomed');
    expect(out.repositories).toHaveLength(1);
    expect(out.pullRequests).toHaveLength(1);
    expect(out.events).toHaveLength(1);
    expect(out.reviews).toHaveLength(1);
    expect(out.teams[0].repoIds).toHaveLength(1);
  });

  // The single most important assertion in this file: an export is a file people email to
  // themselves and drop in cloud storage. Shipping the sealed GitHub token in one would be a
  // self-inflicted credential exposure, and it is not data the subject needs.
  it('NEVER includes the stored GitHub token', async () => {
    const out = await exportAccountData(DOOMED);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('sealed-token-blob');
    expect(serialized).not.toContain('accessTokenEnc');
    // It reports only that a token EXISTS.
    expect(out.account.hasStoredGithubToken).toBe(true);
  });

  it('returns null for an account that does not exist', async () => {
    expect(await exportAccountData(9999)).toBeNull();
  });
});

describe('eraseAccountData', () => {
  it('calls the registered plugin erasure hook', async () => {
    const seen: number[] = [];
    registerAccountErasureHandler(({ accountId }) => {
      seen.push(accountId);
    });
    await eraseAccountData(DOOMED);
    // The plugin owns tables core cannot name; without this hook an "account deleted" would
    // leave pro_settings / sprint_reports / repo_digests behind.
    expect(seen).toEqual([DOOMED]);
  });

  // The checklist test. Iterates the EXPORTED table list, so adding an accountId-bearing table
  // without handling it in eraseAccountData fails here.
  it('leaves NO row behind in any account-scoped table', async () => {
    const remaining: string[] = [];
    for (const t of accountScopedTables()) {
      if ((await t.count(DOOMED)) > 0) remaining.push(t.name);
    }
    expect(remaining).toEqual([]);
  });

  it('does not touch the other account (isolation)', async () => {
    for (const t of accountScopedTables()) {
      expect(await t.count(KEEP), `${t.name} changed for the surviving account`).toBe(
        keepBefore[t.name],
      );
    }
    // Sanity: the snapshot itself was meaningful — the surviving account really does still hold
    // its repo, PR, events and account row (otherwise "unchanged" could be vacuously true).
    for (const name of ['accounts', 'repos', 'pullRequests', 'events', 'teams', 'searchIndex']) {
      expect(keepBefore[name], `${name} should have been seeded`).toBeGreaterThan(0);
    }
  });

  it('leaves the GLOBAL users table alone', async () => {
    // `users` is shared across tenants — a login is the same person for everyone, and it holds
    // only public-profile fields the erasing user never contributed. Deleting rows there would
    // corrupt other accounts' data.
    const rows = await db.select().from(schema.users).execute();
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it('is safe to call twice / for an unknown id', async () => {
    await expect(eraseAccountData(DOOMED)).resolves.toEqual({ reposDeleted: 0 });
    await expect(eraseAccountData(9999)).resolves.toEqual({ reposDeleted: 0 });
  });
});
