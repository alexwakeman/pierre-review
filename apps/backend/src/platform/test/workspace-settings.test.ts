// ── PER-WORKSPACE-ONLY: the sprint cadence, the issue tracker, and the PR that finds its own
//    workspace (plugin migration 0031) ────────────────────────────────────────────────────────
//
// This change SIMPLIFIED three settings by removing a fallback rather than adding a feature, and
// removals are the ones that break quietly. Five things are pinned here:
//
//   1. THERE IS NO ACCOUNT-LEVEL CADENCE LEFT. `resolveSprintCadence` reads the workspace row or
//      answers "no cadence". A stale value in the dormant `pro_settings.sprint_*` columns must not
//      resurface, and "no cadence" must NOT become an invented default sprint length.
//   2. TWO SETTINGS SHARE ONE ROW, SO A PATCH MUST NOT CLOBBER ITS NEIGHBOUR. This is the specific
//      hazard of folding the tracker onto `pro_workspace_settings`, and the seeding in
//      `mergeWorkspace` is the whole mitigation.
//   3. CLEARING A CADENCE NULLS THE PAIR — it does NOT delete the row, which would take the
//      tracker with it. And a null pair must read identically to no row at all.
//   4. THE MIGRATION BACKFILLS INTO **EVERY** WORKSPACE. The tracker was account-wide and applied
//      to every PR on the account; a Default-only copy (0030's shape, correct for a webhook) would
//      silently drop ticket links for every other workspace on upgrade.
//   5. (THE ENRICHER moved to core with the tracker at apiVersion 23 — its per-workspace resolution
//      is pinned in apps/backend/src/tracker/settings.test.ts. The tracker columns on this row are
//      DORMANT now: this plugin never reads or writes them, and core's boot-time move reads them
//      once. What is still pinned here is that a plugin write never touches them.)
//   6. THE COMPARISON MODE JOINED THEM (plugin migration 0032), and the claim that kept it
//      account-wide — "a reading preference with no per-team meaning" — was FALSE: the mode
//      COMPOSES with the cadence, so one account setting produced two different window SHAPES
//      across a reader's workspaces. That falsifier is an executable test below, and 0032's
//      backfill copies a DIVERGENT mode into every workspace (0031's tracker case) while leaving
//      an explicit `rolling_14` alone (it is the product default, not a stored fact).
//
//   pnpm --filter @pierre-review/backend exec vitest run src/platform/test/workspace-settings.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable } from 'drizzle-orm/sqlite-core';
import type { ProContext } from '../contract.js';
import * as settingsSchema from '../settings/schema.sqlite.js';
import {
  currentSprintWindow,
  getComparisonWindow,
  mergeWorkspace,
  readWorkspaceProSettings,
  resolveComparisonMode,
  resolveComparisonWindow,
  resolveSprintCadence,
  writeWorkspaceSettings,
} from '../settings/store.js';

const migration = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), 'utf8');

// The CORE tables the plugin reaches through `ctx.schema` / that the migrations JOIN. Stubs for
// tables core owns, not second definitions of them — `ctx.schema` is `Record<string, any>` in the
// contract, so a column core dropped would still TYPECHECK here and fail only as malformed SQL.
const coreWorkspaceRepos = sqliteTable('workspace_repos', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  workspaceId: integer('workspace_id').notNull(),
  repoId: integer('repo_id').notNull(),
});

// `pro_settings` as it exists BEFORE 0031 — the sprint pair and the three issue columns still hold
// values. The drizzle schema no longer declares any of them, which is exactly why the migration
// has to move the data and why the read must never surface it again.
const PRO_SETTINGS_STUB =
  'CREATE TABLE pro_settings (id integer PRIMARY KEY AUTOINCREMENT, account_id integer NOT NULL, ' +
  'sprint_cadence_days integer, sprint_start_at integer, comparison_mode text, report_model text, ' +
  'slack_webhook_url text, slack_cadence text, slack_hour1 integer, slack_hour2 integer, ' +
  'slack_timezone text, slack_last_sent_at integer, slack_last_sent_slot text, ' +
  'issue_provider text, issue_base_url text, issue_project_keys text, ' +
  'bot_slack_digest integer, bot_auto_resolve integer, bot_auto_resolve_days integer, ' +
  'bot_cost_json text, created_at integer NOT NULL DEFAULT (unixepoch()), ' +
  'updated_at integer NOT NULL DEFAULT (unixepoch()));' +
  'CREATE UNIQUE INDEX pro_settings_account ON pro_settings (account_id);';

const CORE_STUB =
  'CREATE TABLE workspaces (id integer PRIMARY KEY, account_id integer NOT NULL, name text, ' +
  'is_default integer NOT NULL DEFAULT 0);' +
  'CREATE UNIQUE INDEX workspaces_id_account ON workspaces (id, account_id);' +
  'CREATE TABLE workspace_repos (id integer PRIMARY KEY AUTOINCREMENT, ' +
  'account_id integer NOT NULL, workspace_id integer NOT NULL, repo_id integer NOT NULL);' +
  'CREATE UNIQUE INDEX workspace_repos_account_repo ON workspace_repos (account_id, repo_id);';

// Account 1 owns Default(1) + Platform(2); account 2 owns 90. Repo 100 is in workspace 1, repo 200
// in workspace 2, repo 300 has NO membership row, repo 900 belongs to the other tenant.
const SEED =
  "INSERT INTO workspaces (id, account_id, name, is_default) VALUES (1,1,'Default',1);" +
  "INSERT INTO workspaces (id, account_id, name, is_default) VALUES (2,1,'Platform',0);" +
  "INSERT INTO workspaces (id, account_id, name, is_default) VALUES (90,2,'Other',1);" +
  'INSERT INTO workspace_repos (account_id, workspace_id, repo_id) VALUES (1,1,100);' +
  'INSERT INTO workspace_repos (account_id, workspace_id, repo_id) VALUES (1,2,200);' +
  'INSERT INTO workspace_repos (account_id, workspace_id, repo_id) VALUES (2,90,900);';

let sqlite: Database.Database;
let ctx: ProContext;

/** Apply the three migrations that own this table, in filename order — the order the host's
 *  runPluginMigrations applies them in. */
const applyMigrations = (): void => {
  sqlite.exec(migration('0029_workspace_sprint_cadence.sql'));
  sqlite.exec(migration('0031_workspace_issue_tracker.sql'));
  sqlite.exec(migration('0032_workspace_comparison_mode.sql'));
  sqlite.exec(migration('0035_workspace_jira_api.sql'));
  sqlite.exec(migration('0036_workspace_auto_review.sql'));
};

/** The DORMANT tracker columns, read raw (the plugin's schema no longer declares them). */
const rawIssue = (accountId: number, ws: number) =>
  sqlite
    .prepare(
      'SELECT issue_provider provider, issue_base_url baseUrl, issue_project_keys projectKeys, ' +
        'issue_match_scope matchScope, jira_token token FROM pro_workspace_settings ' +
        'WHERE account_id = ? AND workspace_id = ?',
    )
    .get(accountId, ws) as
    | { provider: string | null; baseUrl: string | null; projectKeys: string | null; matchScope: string | null; token: string | null }
    | undefined;

/** A pre-apiVersion-23 tracker on the row, written the only way left: raw. */
const seedRawTracker = (accountId: number, ws: number, provider: string, baseUrl: string): void => {
  sqlite
    .prepare(
      'INSERT INTO pro_workspace_settings (account_id, workspace_id, issue_provider, issue_base_url, issue_match_scope, jira_token) ' +
        "VALUES (?, ?, ?, ?, 'title', 'plain:tok') ON CONFLICT (account_id, workspace_id) DO UPDATE SET " +
        "issue_provider = excluded.issue_provider, issue_base_url = excluded.issue_base_url, issue_match_scope = 'title', jira_token = 'plain:tok'",
    )
    .run(accountId, ws, provider, baseUrl);
};

const makeCtx = (): ProContext =>
  ({
    db: drizzle(sqlite, { schema: { ...settingsSchema } }),
    isPg: false,
    log: { warn: () => {}, error: () => {}, info: () => {} },
    schema: { workspaceRepos: coreWorkspaceRepos },
  }) as unknown as ProContext;

// 0029 rewrites a unique index on `workspace_period_reports`, so that table has to exist.
const PERIOD_REPORTS_STUB =
  'CREATE TABLE workspace_period_reports (id integer PRIMARY KEY AUTOINCREMENT, ' +
  'account_id integer NOT NULL, workspace_id integer NOT NULL, period_key text NOT NULL, ' +
  'model text NOT NULL, cadence_days integer NOT NULL, period_end integer);' +
  'CREATE UNIQUE INDEX wpr_account_ws_period_model ON workspace_period_reports ' +
  '(account_id, workspace_id, period_key, model);';

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.exec(CORE_STUB);
  sqlite.exec(SEED);
  sqlite.exec(PRO_SETTINGS_STUB);
  sqlite.exec(PERIOD_REPORTS_STUB);
});

// ── 1. NO ACCOUNT-LEVEL CADENCE ────────────────────────────────────────────────────────────────
describe('the sprint cadence has no account-level fallback', () => {
  beforeEach(() => {
    applyMigrations();
    ctx = makeCtx();
  });

  it('⚠ IGNORES A STALE ACCOUNT CADENCE ENTIRELY', async () => {
    // The upgrade shape: an account that HAD an account-wide cadence, on a workspace that never
    // set its own. Before 0031 this resolved to 21 days. It must now resolve to "no cadence" —
    // the dormant columns are not a second grain that keeps answering.
    sqlite
      .prepare(
        'INSERT INTO pro_settings (account_id, sprint_cadence_days, sprint_start_at) VALUES (?,?,?)',
      )
      .run(1, 21, Math.floor(Date.UTC(2026, 0, 1) / 1000));
    expect(await resolveSprintCadence(ctx, 1, 1)).toEqual({ cadenceDays: null, startAtMs: null });
  });

  it('⚠ "NO CADENCE" IS NOT A NUMBER — nothing invents a default sprint length', async () => {
    // The product default is the ABSENCE of a sprint grid, which is what an unconfigured account
    // has always had. A `?? 14` anywhere in the resolver would make this test's second assertion
    // produce a window, and every Reports grid would silently acquire a fortnight nobody chose.
    const cadence = await resolveSprintCadence(ctx, 1, 1);
    expect(cadence.cadenceDays).toBeNull();
    expect(currentSprintWindow(cadence, Date.now())).toBeNull();
  });

  it("a 'sprint' comparison mode with no cadence degrades to the rolling-14 window", async () => {
    // The one place the absence is USER-VISIBLE, and it is unchanged: choosing 'sprint' on a
    // workspace with no cadence gets a rolling fortnight rather than an error or an empty screen.
    // ⚠ IT IS ALSO THE FACT THAT MADE THE MODE A PER-WORKSPACE SETTING (plugin 0032). While the
    // mode was account-wide, THIS degradation meant one setting produced two different window
    // SHAPES across a reader's workspaces — a sprint-position comparison here, a rolling fortnight
    // there — with nothing on screen naming which one they were looking at.
    const now = Date.UTC(2026, 7, 20);
    const w = resolveComparisonWindow('sprint', await resolveSprintCadence(ctx, 1, 1), now);
    expect(w.mode).toBe('rolling_14');
    expect(w.toMs - w.fromMs).toBe(14 * 86_400_000);
  });

  it('a workspace cadence answers for THAT workspace only', async () => {
    await writeWorkspaceSettings(ctx, 1, 2, {
      sprint: { cadenceDays: 7, startDate: '2026-08-03' },
    });
    expect((await resolveSprintCadence(ctx, 1, 2)).cadenceDays).toBe(7);
    // The account's other workspace is untouched — no inheritance in either direction.
    expect((await resolveSprintCadence(ctx, 1, 1)).cadenceDays).toBeNull();
  });

  it('a cadence < 1 reads as no cadence, like a missing row', async () => {
    // Reachable only by a hand-written UPDATE (the store clamps to 1..90), which is exactly the
    // case a resolver has to survive: two spellings of "unset" must not answer differently.
    sqlite
      .prepare(
        'INSERT INTO pro_workspace_settings (account_id, workspace_id, sprint_cadence_days) VALUES (?,?,?)',
      )
      .run(1, 2, 0);
    expect(await resolveSprintCadence(ctx, 1, 2)).toEqual({ cadenceDays: null, startAtMs: null });
  });
});

// ── 2 + 3. ONE ROW, TWO SETTINGS ───────────────────────────────────────────────────────────────
describe('writeWorkspaceSettings — one row, two independently-owned settings', () => {
  beforeEach(() => {
    applyMigrations();
    ctx = makeCtx();
  });

  it('⚠ A SPRINT PATCH NEVER TOUCHES THE DORMANT TRACKER COLUMNS', async () => {
    // The tracker left this row at apiVersion 23 and core's boot-time move reads it ONCE. Until it
    // has, a plugin write must leave the old values (the token above all) exactly where they are —
    // the upsert's `set:` names declared columns only, which is what makes them dormant.
    seedRawTracker(1, 2, 'jira', 'https://acme.atlassian.net');
    await writeWorkspaceSettings(ctx, 1, 2, { sprint: { cadenceDays: 7, startDate: '2026-08-03' } });
    await writeWorkspaceSettings(ctx, 1, 2, { comparisonMode: 'sprint' });
    expect((await readWorkspaceProSettings(ctx, 1, 2)).cadenceDays).toBe(7);
    expect(rawIssue(1, 2)).toEqual({
      provider: 'jira',
      baseUrl: 'https://acme.atlassian.net',
      projectKeys: null,
      matchScope: 'title',
      token: 'plain:tok',
    });
    // …and the wire carries no tracker any more.
    expect(Object.keys(await readWorkspaceProSettings(ctx, 1, 2)).sort()).toEqual([
      'cadenceDays',
      'comparisonMode',
      'startDate',
      'workspaceId',
    ]);
  });

  it('⚠ CLEARING THE CADENCE NULLS THE PAIR — it does not delete the row', async () => {
    // Its predecessor `writeWorkspaceCadence` DELETED the row to mean "follow the account
    // default". There is no account default any more, and the row now carries the tracker, so a
    // delete would destroy an unrelated setting.
    seedRawTracker(1, 2, 'linear', 'https://linear.app/acme');
    await writeWorkspaceSettings(ctx, 1, 2, {
      sprint: { cadenceDays: 14, startDate: '2026-08-03' },
    });
    await writeWorkspaceSettings(ctx, 1, 2, { sprint: { cadenceDays: null } });

    const after = await readWorkspaceProSettings(ctx, 1, 2);
    expect(after.cadenceDays).toBeNull();
    // The phase anchor goes with the length: an anchor with no length names no boundary, and
    // leaving one behind would silently re-phase a cadence set later.
    expect(after.startDate).toBeNull();
    expect(rawIssue(1, 2)?.provider).toBe('linear');
    // The row itself survived.
    expect(
      sqlite.prepare('SELECT count(*) c FROM pro_workspace_settings').get(),
    ).toEqual({ c: 1 });
  });

  it('a null pair reads identically to no row at all', async () => {
    await writeWorkspaceSettings(ctx, 1, 2, { sprint: { cadenceDays: null } });
    expect(await resolveSprintCadence(ctx, 1, 2)).toEqual(
      await resolveSprintCadence(ctx, 1, 1), // workspace 1 has no row whatsoever
    );
  });

  it('an omitted startDate keeps the stored anchor; a null one clears it', async () => {
    await writeWorkspaceSettings(ctx, 1, 2, {
      sprint: { cadenceDays: 14, startDate: '2026-08-03' },
    });
    // Cadence-only edit — must not silently re-phase the grid.
    await writeWorkspaceSettings(ctx, 1, 2, { sprint: { cadenceDays: 7 } });
    expect((await readWorkspaceProSettings(ctx, 1, 2)).startDate?.slice(0, 10)).toBe('2026-08-03');
    await writeWorkspaceSettings(ctx, 1, 2, { sprint: { cadenceDays: 7, startDate: null } });
    expect((await readWorkspaceProSettings(ctx, 1, 2)).startDate).toBeNull();
  });

  // ('validates and normalises the tracker fields' and 'an UNSET match scope reads as title+branch'
  // moved to core with the writer: apps/backend/src/tracker/settings.test.ts.)
});

// ── 4. THE MIGRATION BACKFILL ──────────────────────────────────────────────────────────────────
describe('migration 0031 moves the account-wide tracker onto every workspace', () => {
  const seedAccountTracker = (keys: string | null = 'ENG,OPS'): void => {
    sqlite
      .prepare(
        'INSERT INTO pro_settings (account_id, issue_provider, issue_base_url, issue_project_keys) ' +
          'VALUES (?,?,?,?)',
      )
      .run(1, 'jira', '  https://acme.atlassian.net  ', keys);
  };

  it('⚠ COPIES INTO EVERY WORKSPACE, NOT JUST THE DEFAULT', async () => {
    // The setting WAS account-wide and applied to every PR on the account. 0030's Default-only
    // shape is right for a webhook (one channel had ever been delivered to) and WRONG here: it
    // would silently drop ticket links for every non-default workspace on upgrade.
    seedAccountTracker();
    applyMigrations();
    ctx = makeCtx();
    for (const ws of [1, 2]) {
      const s = rawIssue(1, ws);
      expect(s?.provider).toBe('jira');
      expect(s?.baseUrl).toBe('https://acme.atlassian.net'); // trimmed, matching the pg btrim
      expect(s?.projectKeys).toBe('ENG,OPS');
    }
    // The other tenant gained nothing.
    expect(rawIssue(2, 90)).toBeUndefined();
  });

  it('⚠ UPDATES a workspace that already has a cadence row rather than skipping it', async () => {
    // `ON CONFLICT … DO NOTHING` here would silently skip exactly the workspaces that had bothered
    // to configure a sprint — the most engaged users getting the worst upgrade.
    sqlite.exec(migration('0029_workspace_sprint_cadence.sql'));
    sqlite
      .prepare(
        'INSERT INTO pro_workspace_settings (account_id, workspace_id, sprint_cadence_days) VALUES (1,2,7)',
      )
      .run();
    seedAccountTracker();
    sqlite.exec(migration('0031_workspace_issue_tracker.sql'));
    sqlite.exec(migration('0032_workspace_comparison_mode.sql'));
    sqlite.exec(migration('0035_workspace_jira_api.sql'));
    sqlite.exec(migration('0036_workspace_auto_review.sql'));
    ctx = makeCtx();
    const s = await readWorkspaceProSettings(ctx, 1, 2);
    expect(rawIssue(1, 2)?.provider).toBe('jira');
    expect(s.cadenceDays).toBe(7); // …and the cadence it already had survived the upsert
  });

  it('a half-configured account copies nothing', async () => {
    // The predicate matches the enricher's own liveness test, so no row is seeded that could never
    // produce a link.
    sqlite
      .prepare('INSERT INTO pro_settings (account_id, issue_provider, issue_base_url) VALUES (?,?,?)')
      .run(1, 'jira', '   ');
    applyMigrations();
    expect(sqlite.prepare('SELECT count(*) c FROM pro_workspace_settings').get()).toEqual({ c: 0 });
  });

  it('⚠ THE BACKFILL IS RE-RUNNABLE; THE SQLITE `ADD COLUMN`s ARE NOT — and that is by dialect', () => {
    // Worth pinning because the two dialects genuinely differ here and the pg twin's header claims
    // replay-safety:
    //   • pg uses `ADD COLUMN IF NOT EXISTS`, so the whole file is blind-replayable. It has to be:
    //     a plugin pg migration that throws is DOWNGRADED TO A WARNING by the host runner, which
    //     silently drops the entire plugin to OSS mode.
    //   • SQLite HAS NO `ADD COLUMN IF NOT EXISTS`. Re-execing the sqlite file raises
    //     "duplicate column name", exactly as plugin 0006's bare ADD COLUMN would. Run-once is
    //     guaranteed by `pro_migrations`, not by the statement.
    // What must be re-runnable either way is the DATA half, since that is the part a hand re-run
    // during an incident would target.
    seedAccountTracker();
    applyMigrations();
    expect(() => sqlite.exec(migration('0031_workspace_issue_tracker.sql'))).toThrow(
      /duplicate column/i,
    );
    const backfill = migration('0031_workspace_issue_tracker.sql').slice(
      migration('0031_workspace_issue_tracker.sql').indexOf('INSERT INTO pro_workspace_settings'),
    );
    sqlite.exec(backfill);
    sqlite.exec(backfill);
    expect(sqlite.prepare('SELECT count(*) c FROM pro_workspace_settings').get()).toEqual({ c: 2 });
  });
});

// ── 4b. THE COMPARISON MODE IS PER WORKSPACE (plugin migration 0032) ───────────────────────────
//
// The mode used to sit on `pro_settings` under the claim that it is "a reading preference with no
// per-team meaning". `resolveComparisonWindow` falsifies that in four lines and the last test in
// this block is the falsifier made executable: with ONE mode, two workspaces produce two different
// window SHAPES. It is now stored beside the cadence it composes with — two states, no chain.
describe('the comparison mode is per workspace, with the product default beneath it', () => {
  beforeEach(() => {
    applyMigrations();
    ctx = makeCtx();
  });

  it('an unset workspace reads the PRODUCT DEFAULT, and a stale account value is ignored', async () => {
    // The upgrade shape: an account that HAD an account-wide mode, on a workspace that never set
    // one. The dormant column must not be a second grain that keeps answering.
    sqlite
      .prepare('INSERT INTO pro_settings (account_id, comparison_mode) VALUES (?,?)')
      .run(1, 'rolling_7');
    expect(await resolveComparisonMode(ctx, 1, 1)).toBe('rolling_14');
  });

  it('a junk stored value reads as the default rather than travelling', async () => {
    // Reachable only by a hand-written UPDATE (the writer validates against VALID_COMPARISON),
    // which is exactly the case a resolver has to survive: two spellings of "unset" must not
    // answer differently, and an unknown mode must never reach `MODE_AS_RANGE`'s record lookup.
    sqlite
      .prepare(
        'INSERT INTO pro_workspace_settings (account_id, workspace_id, comparison_mode) VALUES (?,?,?)',
      )
      .run(1, 2, 'rolling_3');
    expect(await resolveComparisonMode(ctx, 1, 2)).toBe('rolling_14');
  });

  it('two workspaces hold two independent modes', async () => {
    await writeWorkspaceSettings(ctx, 1, 1, { comparisonMode: 'rolling_7' });
    await writeWorkspaceSettings(ctx, 1, 2, { comparisonMode: 'sprint' });
    expect(await resolveComparisonMode(ctx, 1, 1)).toBe('rolling_7');
    expect(await resolveComparisonMode(ctx, 1, 2)).toBe('sprint');
    expect((await readWorkspaceProSettings(ctx, 1, 1)).comparisonMode).toBe('rolling_7');
  });

  it('⚠ A MODE PATCH LEAVES THE CADENCE AND THE TRACKER INTACT, AND VICE VERSA', async () => {
    // Three settings on one row now. `mergeWorkspace` seeds every column from the stored row; drop
    // the newest seed and the upsert NULLs the mode on any unrelated patch — a setting that
    // vanishes when you edit its neighbour, with no error anywhere.
    seedRawTracker(1, 2, 'jira', 'https://acme.atlassian.net');
    await writeWorkspaceSettings(ctx, 1, 2, { sprint: { cadenceDays: 7, startDate: '2026-08-03' } });
    await writeWorkspaceSettings(ctx, 1, 2, { comparisonMode: 'sprint' });
    let after = await readWorkspaceProSettings(ctx, 1, 2);
    expect(after.comparisonMode).toBe('sprint');
    expect(after.cadenceDays).toBe(7);
    expect(rawIssue(1, 2)?.provider).toBe('jira');

    // …and back the other way: editing the cadence must not reset the mode.
    await writeWorkspaceSettings(ctx, 1, 2, { sprint: { cadenceDays: 14 } });
    after = await readWorkspaceProSettings(ctx, 1, 2);
    expect(after.comparisonMode).toBe('sprint');
    expect(after.cadenceDays).toBe(14);
  });

  it('clearing the cadence leaves the mode alone — it is a separate fact on the same row', async () => {
    await writeWorkspaceSettings(ctx, 1, 2, { comparisonMode: 'sprint' });
    await writeWorkspaceSettings(ctx, 1, 2, { sprint: { cadenceDays: null } });
    const after = await readWorkspaceProSettings(ctx, 1, 2);
    expect(after.cadenceDays).toBeNull();
    expect(after.comparisonMode).toBe('sprint');
  });

  it('⚠ THE FALSIFIER: ONE MODE, TWO WORKSPACES, TWO WINDOW SHAPES', async () => {
    // This is the whole argument for the move, executable. Workspace 2 has a cadence; workspace 1
    // has none. Give both the SAME mode — as a single account setting necessarily did — and they
    // resolve to different KINDS of window: a sprint-position comparison against a rolling
    // fortnight. Nothing on screen named which one a reader was looking at.
    const now = Date.UTC(2026, 7, 20);
    await writeWorkspaceSettings(ctx, 1, 2, {
      sprint: { cadenceDays: 7, startDate: '2026-08-03' },
      comparisonMode: 'sprint',
    });
    await writeWorkspaceSettings(ctx, 1, 1, { comparisonMode: 'sprint' });
    const withCadence = await getComparisonWindow(ctx, 1, 2, now);
    const without = await getComparisonWindow(ctx, 1, 1, now);
    expect(withCadence.mode).toBe('sprint');
    expect(withCadence.toMs - withCadence.fromMs).toBe(7 * 86_400_000);
    expect(without.mode).toBe('rolling_14');
    expect(without.toMs - without.fromMs).toBe(14 * 86_400_000);
  });

  it('⚠ THE WINDOW READS BOTH HALVES OFF ONE ROW — a stale account mode cannot reach it', async () => {
    sqlite
      .prepare('INSERT INTO pro_settings (account_id, comparison_mode) VALUES (?,?)')
      .run(1, 'sprint');
    await writeWorkspaceSettings(ctx, 1, 2, { sprint: { cadenceDays: 7, startDate: '2026-08-03' } });
    const w = await getComparisonWindow(ctx, 1, 2, Date.UTC(2026, 7, 20));
    // The workspace never chose 'sprint', so it gets the default rolling fortnight even though it
    // HAS a cadence and the dormant account column says otherwise.
    expect(w.mode).toBe('rolling_14');
  });
});

// ── 4c. MIGRATION 0032's BACKFILL ──────────────────────────────────────────────────────────────
describe('migration 0032 moves a DIVERGENT account mode onto every workspace', () => {
  const seedAccountMode = (mode: string, accountId = 1): void => {
    sqlite
      .prepare('INSERT INTO pro_settings (account_id, comparison_mode) VALUES (?,?)')
      .run(accountId, mode);
  };

  it('⚠ COPIES INTO EVERY WORKSPACE, NOT JUST THE DEFAULT', async () => {
    // The mode applied to every workspace's Insights window, so a Default-only copy would be a
    // silent regression: every other team's comparison would quietly re-frame on upgrade. This is
    // 0031's TRACKER case, not 0031's CADENCE case (which deliberately backfilled nothing, because
    // copying one team's fortnight would have invented a per-team fact nobody stated).
    seedAccountMode('sprint');
    applyMigrations();
    ctx = makeCtx();
    expect(await resolveComparisonMode(ctx, 1, 1)).toBe('sprint');
    expect(await resolveComparisonMode(ctx, 1, 2)).toBe('sprint');
    // …and not into the other tenant's workspace.
    expect(await resolveComparisonMode(ctx, 2, 90)).toBe('rolling_14');
  });

  it('an explicit `rolling_14` is NOT copied — the default is not a stored value', async () => {
    // Writing the product default into a row creates configuration that says nothing and turns
    // "the default" into something somebody later has to reason about. NULL is skipped for the
    // same reason.
    seedAccountMode('rolling_14');
    applyMigrations();
    ctx = makeCtx();
    expect(sqlite.prepare('SELECT count(*) c FROM pro_workspace_settings').get()).toEqual({ c: 0 });
    expect(await resolveComparisonMode(ctx, 1, 1)).toBe('rolling_14');
  });

  it('⚠ UPDATES a workspace that already has a row rather than skipping it', async () => {
    // `ON CONFLICT … DO NOTHING` would silently skip exactly the workspaces that had bothered to
    // configure a sprint or a tracker — the most engaged users getting the worst upgrade.
    sqlite.exec(migration('0029_workspace_sprint_cadence.sql'));
    sqlite
      .prepare(
        'INSERT INTO pro_workspace_settings (account_id, workspace_id, sprint_cadence_days) VALUES (1,2,7)',
      )
      .run();
    seedAccountMode('rolling_7');
    sqlite.exec(migration('0031_workspace_issue_tracker.sql'));
    sqlite.exec(migration('0032_workspace_comparison_mode.sql'));
    sqlite.exec(migration('0035_workspace_jira_api.sql'));
    sqlite.exec(migration('0036_workspace_auto_review.sql'));
    ctx = makeCtx();
    const s = await readWorkspaceProSettings(ctx, 1, 2);
    expect(s.comparisonMode).toBe('rolling_7');
    expect(s.cadenceDays).toBe(7); // …and the cadence it already had survived the upsert
  });

  it('⚠ THE BACKFILL IS RE-RUNNABLE; THE SQLITE `ADD COLUMN` IS NOT — and that is by dialect', () => {
    // Same dialect split as 0031: pg uses `ADD COLUMN IF NOT EXISTS` (a plugin pg migration that
    // throws is downgraded to a WARNING that silently drops the whole plugin to OSS mode), SQLite
    // has no such form and relies on `pro_migrations` for run-once. The DATA half must be
    // re-runnable either way — that is the part a hand re-run during an incident targets.
    seedAccountMode('sprint');
    applyMigrations();
    expect(() => sqlite.exec(migration('0032_workspace_comparison_mode.sql'))).toThrow(
      /duplicate column/i,
    );
    const file = migration('0032_workspace_comparison_mode.sql');
    const backfill = file.slice(file.indexOf('INSERT INTO pro_workspace_settings'));
    sqlite.exec(backfill);
    sqlite.exec(backfill);
    expect(sqlite.prepare('SELECT count(*) c FROM pro_workspace_settings').get()).toEqual({ c: 2 });
  });
});

// (§5, the enricher finding the PR's own workspace, moved to core with the tracker at apiVersion
// 23: apps/backend/src/tracker/settings.test.ts § 3.)

// (§7, auto Claude review, moved to core with Claude Review — its switch is `workspaces.
// auto_review_enabled[_at]` now: apps/backend/src/review/claude-review/auto-settings.test.ts.)
