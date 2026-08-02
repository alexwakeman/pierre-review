// Account-erasure tests on a THROWAWAY sqlite DB (the billing.test.ts / retention.test.ts
// pattern): env is set BEFORE importing config/client, so every host module arrives via dynamic
// import in beforeAll.
//
// THE POINT OF THIS FILE IS NOT "delete works". It is that a table ADDED LATER and forgotten
// cannot silently survive an erasure the user was told was complete. That guarantee has THREE
// legs, and all three have to be present or the file is theatre:
//
//   1. COMPLETENESS — every `accountId`-bearing table in the schema appears on the exported
//      `accountScopedTables()` checklist. Derived from the schema module at runtime, so a new
//      table fails here the day it lands. Without this leg, DELETING an entry from the checklist
//      makes the file pass MORE easily, which is the exact inversion a checklist test must not
//      have (this leg is new: the old file iterated the list and could not see an omission).
//   2. NON-VACUITY — the fixture actually SEEDS a row in every table it expects to be cleared.
//      "0 rows remain" is trivially true for a table nothing ever wrote to; §9.5/§9.6 of the
//      workspace spec call this out as the failure mode a rewrite falls into, and this repo has
//      shipped a vacuous isolation guard before.
//   3. ERASURE + ISOLATION — the checklist reads zero for the erased account and byte-identical
//      counts for the surviving one.
//
// The fixture seeds the WORKSPACE TRIO (`workspaces` / `workspace_repos` / `workspace_reviewers`,
// migrations 0044/0045) in place of the four tables that left with the refactor (`teams`,
// `team_repos`, `repo_reviewers`, `account_reviewers`). `workspace_reviewers` is the entry whose
// omission would cost the user data they typed by hand: it carries the manual judgement, the
// human-set vendor name AND `monthly_cents`, the one column no classifier can regenerate.
import { readFileSync, rmSync } from 'node:fs';
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
let ensureDefaultWorkspace: (accountId: number) => Promise<number>;

const KEEP = 1; // the seeded local account (id 1)
const DOOMED = 2;

/** Pre-erasure row counts, keyed by table name. */
const keepBefore: Record<string, number> = {};
const doomedBefore: Record<string, number> = {};
/** The surviving account's reviewer rows before anything is erased (compared byte-for-byte after). */
let keepReviewersBefore: any[] = [];

/**
 * Every table this fixture deliberately writes a row into. The non-vacuity test below asserts
 * each one is genuinely non-empty for the DOOMED account BEFORE the erasure runs — otherwise
 * "0 rows remain" proves nothing about whether `eraseAccountData` handles it.
 *
 * `claudeReviews` and `benchmarkContributions` are the two checklist entries NOT seeded here:
 * both are written only by features this fixture does not exercise (an agentic review run, an
 * opt-in cross-org contribution). They are covered by the completeness leg, not this one.
 */
const SEEDED_TABLES = [
  'accounts',
  'repos',
  'pullRequests',
  'events',
  'aiUsage',
  'myTurnDismissals',
  'workspaces',
  'workspaceRepos',
  'workspaceReviewers',
  'searchIndex',
  'autoMergeRequests',
  'branchCommits',
];

/**
 * Seed one account with a repo, a PR, an event and a row in every account-level table —
 * including all three workspace tables, which is what makes the checklist able to catch them.
 */
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

  // ── THE WORKSPACE TRIO (migrations 0044/0045) ──────────────────────────────────────────────
  // Two workspaces per account: the auto-created Default (through the REAL writer, so the
  // partial unique `workspaces_one_default` is honoured the way production honours it) plus a
  // second one the repo has been MOVED into. A repo belongs to exactly one workspace, so the
  // membership row lives with the move.
  const defaultWorkspaceId = await ensureDefaultWorkspace(accountId);
  const extra = (
    await db
      .insert(s.workspaces)
      .values({ accountId, name: `Platform ${accountId}`, isDefault: false })
      .returning()
      .execute()
  )[0];
  await db
    .insert(s.workspaceRepos)
    .values({ accountId, workspaceId: extra.id, repoId: repo.id })
    .execute();

  // The bot object, now ONE row carrying three independent facts: the judgement (source),
  // the identity (identity_source) and the PRICE. Seeded in BOTH workspaces at DIFFERENT prices
  // — price is a per-workspace fact, so this is a legitimate state, and it means the erasure has
  // two rows to clear rather than one.
  for (const [workspaceId, cents] of [
    [extra.id, 3000],
    [defaultWorkspaceId, 1500],
  ] as [number, number][]) {
    await db
      .insert(s.workspaceReviewers)
      .values({
        accountId,
        workspaceId,
        authorUserId: user.id,
        automated: true,
        role: 'review',
        confidence: 'high',
        source: 'manual',
        reasonsJson: ['manually tagged as an automated reviewer'],
        kind: 'coderabbit',
        label: 'CodeRabbit',
        identitySource: 'manual',
        monthlyCents: cents,
      })
      .execute();
  }

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
  // A standing auto-merge intent. Seeded explicitly because the checklist test below asserts
  // "0 rows remain", which is vacuously true for a table nothing ever wrote to — an unseeded
  // table proves nothing about whether eraseAccountData actually handles it.
  await db
    .insert(s.autoMergeRequests)
    .values({
      accountId,
      prId: pr.id,
      mergeMethod: 'squash',
      updateStrategy: 'rebase',
      expectedHeadOid: `head-${accountId}`,
      state: 'armed',
      armedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    .execute();
  // A default-branch commit snapshot — same reasoning (and it carries an author name +
  // commit subject, so it is personal data an erasure must not leave behind).
  await db
    .insert(s.branchCommits)
    .values({
      accountId,
      repoId: repo.id,
      sha: `trunk-${accountId}`,
      messageHeadline: `Land change ${accountId}`,
      authorUserId: user.id,
      authorName: `Dev ${accountId}`,
      committedAt: new Date(),
      ciStatus: 'success',
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
  ({ ensureDefaultWorkspace } = await import('./queries.js'));

  await seedAccount(KEEP, 'keeper');
  await seedAccount(DOOMED, 'doomed');

  // Snapshot BOTH accounts' row counts before anything is erased.
  //   • DOOMED, so the "0 rows remain" assertions can be shown to be non-vacuous.
  //   • KEEP, so the isolation assertion compares against a real baseline rather than requiring
  //     every table to be non-empty — some (claudeReviews, benchmarkContributions) are only
  //     populated by features this seed doesn't exercise, and "unchanged" is the property that
  //     actually matters.
  for (const t of accountScopedTables()) {
    keepBefore[t.name] = await t.count(KEEP);
    doomedBefore[t.name] = await t.count(DOOMED);
  }
  keepReviewersBefore = await db.select().from(schema.workspaceReviewers).execute();
  keepReviewersBefore = keepReviewersBefore.filter((r: any) => r.accountId === KEEP);
});

afterAll(async () => {
  await closeDb?.();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// LEG 1 + LEG 2: the checklist is complete, and the fixture is not vacuous. Both must hold
// BEFORE the erasure runs, so they sit in their own describe ahead of it.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('accountScopedTables — the checklist itself', () => {
  // WITHOUT THIS TEST, REMOVING AN ENTRY FROM THE CHECKLIST MAKES THE SUITE PASS: every other
  // assertion in this file ITERATES the list, so a table that leaves it simply stops being
  // checked. That is the one direction a checklist guard must be able to see, and it is what
  // makes CLAUDE.md's claim — "a new accountId-bearing table that isn't added there fails
  // erase-account.test.ts" — actually true rather than aspirational.
  //
  // The expected set is DERIVED from the live schema module (any export with an `account_id`
  // column), not hand-listed, so a table added tomorrow is covered without touching this file.
  it('names every accountId-bearing table in the schema', () => {
    const bearing = Object.entries(schema)
      .filter(
        ([, t]: [string, any]) =>
          t && typeof t === 'object' && t.accountId && t.accountId.name === 'account_id',
      )
      .map(([name]) => name);
    // Sanity: the derivation itself found something. A refactor that changed how drizzle exposes
    // columns would otherwise turn this whole test into a no-op.
    expect(bearing.length).toBeGreaterThan(10);
    expect(bearing).toContain('workspaceReviewers');
    expect(bearing).toContain('workspaceRepos');
    expect(bearing).toContain('workspaces');

    const listed = new Set(accountScopedTables().map((t) => t.name));
    // `accounts` is on the checklist keyed by its own `id`, so it never appears in `bearing`.
    expect(listed.has('accounts')).toBe(true);

    // ⚠ KNOWN, PRE-EXISTING GAP, exempted by NAME so it can never widen silently.
    // `ci_status_events` carries accountId but is cleared per-repo inside `deleteRepo`, so an
    // erasure that completes leaves none behind — it has simply never been added to the
    // checklist. The relation asserted is a SUBSET, not equality, so adding it to
    // `accountScopedTables()` (which it should be, to make the guarantee independent of the
    // repo loop succeeding) needs no change here.
    const KNOWN_UNCHECKED = new Set(['ciStatusEvents']);
    const missing = bearing.filter((n) => !listed.has(n) && !KNOWN_UNCHECKED.has(n));
    expect(missing, 'accountId-bearing tables absent from accountScopedTables()').toEqual([]);

    // And nothing on the checklist names a table that does not exist.
    for (const name of listed) {
      expect(schema[name], `accountScopedTables() names unknown table ${name}`).toBeTruthy();
    }
  });

  // LEG 2. Every table this fixture claims to seed really does hold a row for the account that
  // is about to be erased — otherwise the "leaves NO row behind" assertion below is satisfied by
  // an empty table and proves nothing. The workspace trio is named explicitly because it is the
  // part that arrived with migrations 0044/0045.
  it('the fixture seeds a real row for the doomed account in every table it covers', () => {
    for (const name of SEEDED_TABLES) {
      const msg = `${name} was never seeded — its erasure check is vacuous`;
      expect(doomedBefore[name], msg).toBeGreaterThan(0);
    }
    // Two workspaces, two reviewer rows (one per workspace), one membership row.
    expect(doomedBefore.workspaces).toBe(2);
    expect(doomedBefore.workspaceReviewers).toBe(2);
    expect(doomedBefore.workspaceRepos).toBe(1);
  });
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
    // Workspaces replaced teams in the Art. 15 payload; each row still carries its repo ids.
    expect(out.workspaces).toHaveLength(2);
    const platform = out.workspaces.find((w: any) => w.name === `Platform ${DOOMED}`);
    expect(platform.repoIds).toHaveLength(1);
    expect(out.workspaces.find((w: any) => w.isDefault).repoIds).toHaveLength(0);
  });

  // The bot object is Art. 15 material in its own right: human judgements, a human-set vendor
  // name, and a price the user typed. A rename that dropped it from the export would be a silent
  // regression of a data-subject right.
  it('includes the workspace reviewers, judgement + identity + price', async () => {
    const out = await exportAccountData(DOOMED);
    expect(out.workspaceReviewers).toHaveLength(2);
    expect(out.workspaceReviewers.map((r: any) => r.monthlyCents).sort()).toEqual([1500, 3000]);
    expect(out.workspaceReviewers[0].label).toBe('CodeRabbit');
    expect(out.workspaceReviewers[0].source).toBe('manual');
    expect(out.workspaceReviewers[0].identitySource).toBe('manual');
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

  // The checklist test. Iterates the EXPORTED table list, so a table that IS on the list but is
  // not handled by eraseAccountData fails here. (A table MISSING from the list is caught by the
  // completeness test above — the two legs cover opposite directions.)
  it('leaves NO row behind in any account-scoped table', async () => {
    const remaining: string[] = [];
    for (const t of accountScopedTables()) {
      if ((await t.count(DOOMED)) > 0) remaining.push(t.name);
    }
    expect(remaining).toEqual([]);
  });

  // Called out separately from the loop above because these three are the refactor's new
  // surface and because `workspace_reviewers` is the one table whose survival would cost the
  // user data no classifier can regenerate.
  it('clears the workspace trio specifically, including the prices', async () => {
    const { workspaces, workspaceRepos, workspaceReviewers } = schema;
    for (const table of [workspaces, workspaceRepos, workspaceReviewers]) {
      const rows = (await db.select().from(table).execute()) as any[];
      expect(rows.filter((r) => r.accountId === DOOMED)).toEqual([]);
    }
  });

  it('does not touch the other account (isolation)', async () => {
    for (const t of accountScopedTables()) {
      expect(await t.count(KEEP), `${t.name} changed for the surviving account`).toBe(
        keepBefore[t.name],
      );
    }
    // Sanity: the snapshot itself was meaningful — the surviving account really does still hold
    // its repo, PR, events, workspaces and bot rows (otherwise "unchanged" could be vacuously
    // true).
    for (const name of SEEDED_TABLES) {
      expect(keepBefore[name], `${name} should have been seeded`).toBeGreaterThan(0);
    }
    // Counts alone would not notice the surviving account's PRICE being overwritten, so compare
    // the rows themselves.
    const after = ((await db.select().from(schema.workspaceReviewers).execute()) as any[]).filter(
      (r) => r.accountId === KEEP,
    );
    expect(after).toEqual(keepReviewersBefore);
    expect(after.map((r) => r.monthlyCents).sort()).toEqual([1500, 3000]);
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

  // ⚠ THE ASSERTION ABOVE IS VACUOUS FOR THE WORKSPACE TRIO ON ITS OWN, and this test is why it
  // exists. `workspaces.account_id` cascades from `accounts`, and both children cascade from
  // `workspaces` — so on SQLite with `foreign_keys=ON`, deleting the account row alone clears all
  // three. Mutation-checked: removing the explicit `workspaceReviewers` delete, and separately
  // removing the explicit `workspaces` delete, both leave "leaves NO row behind" PASSING.
  //
  // The explicit statements exist precisely so the erasure promise does not depend on a pragma
  // (SQLite enforces FKs only when asked) — so the honest test is to take the pragma away and
  // require the erasure to stand up by itself. A THIRD account is seeded for this so nothing
  // above is disturbed.
  it('erases the workspace trio WITHOUT relying on the FK cascades', async () => {
    const SANDBOX = 3;
    await seedAccount(SANDBOX, 'sandboxed');
    for (const name of ['workspaces', 'workspaceRepos', 'workspaceReviewers']) {
      const t = accountScopedTables().find((x) => x.name === name)!;
      expect(await t.count(SANDBOX), `${name} not seeded for the sandbox account`).toBeGreaterThan(
        0,
      );
    }
    // Connection-level pragma; a no-op inside a transaction, so it must be set out here.
    const raw = (db as any).$client;
    expect(raw?.pragma, 'expected the better-sqlite3 handle via drizzle $client').toBeTruthy();
    raw.pragma('foreign_keys = OFF');
    try {
      expect(raw.pragma('foreign_keys', { simple: true })).toBe(0);
      await eraseAccountData(SANDBOX);
      for (const t of accountScopedTables()) {
        expect(
          await t.count(SANDBOX),
          `${t.name} survived an erasure once the cascades were switched off`,
        ).toBe(0);
      }
    } finally {
      raw.pragma('foreign_keys = ON');
    }
  });

  // A STRUCTURAL assertion, and deliberately so. Presence is now covered behaviourally by the
  // test above; ORDER is not, and cannot be: the explicit child deletes clear the children
  // whichever way round they run, with or without the cascades. Child-before-parent is still the
  // documented contract — Postgres checks FKs immediately, so a parent-first delete would depend
  // entirely on the cascade firing — and the only way to pin it is to look at the statements.
  it('deletes the workspace tables child-before-parent', () => {
    const src = readFileSync(new URL('./erase-account.ts', import.meta.url), 'utf8');
    const at = (needle: string): number => {
      const i = src.indexOf(needle);
      expect(i, `${needle} not found in erase-account.ts`).toBeGreaterThan(-1);
      return i;
    };
    const reviewers = at('.delete(workspaceReviewers)');
    const memberships = at('.delete(workspaceRepos)');
    const parents = at('.delete(workspaces)');
    expect(reviewers).toBeLessThan(memberships);
    expect(memberships).toBeLessThan(parents);
  });
});
