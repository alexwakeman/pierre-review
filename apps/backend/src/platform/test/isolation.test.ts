// Plugin-side cross-account IDOR isolation check (the @pierre/pro analogue of the
// core `verify:isolation`), plus the behaviour of plugin migration 0020 — the file
// that drags every persisted `scope_key` across the teams→workspaces line.
//
// Seeds TWO accounts' rows in review_learnings + repo_digests + the six scope-keyed
// caches over a throwaway in-memory SQLite, then asserts every getter scopes
// accountId and id-addressed projections never leak across accounts.
//
// TODO(integrator): this file is NOT wired into the recursive `pnpm test` — the
// package intentionally ships only a `typecheck` script (no `test` script, no
// better-sqlite3/vitest devDeps) so the later install/test stage can't break on
// the plugin's native build. Run it from the backend workspace, which already has
// both:
//   pnpm --filter @pierre-review/backend exec vitest run src/platform/test
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { and, eq } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
// repo_digests (review_learnings, which shared the old file, moved to core: core migration 0074).
import * as schema from '../activity-digest/schema.sqlite.js';
import * as aiFixSchema from '../ai-fix/schema.sqlite.js';
import * as insightsSchema from '../insights/schema.sqlite.js';
import * as periodSchema from '../insights/period-schema.sqlite.js';
import * as assessSchema from '../review-assess/schema.sqlite.js';
import * as addrSchema from '../resolution-check/schema.sqlite.js';
import * as botThemesSchema from '../bot-themes/schema.sqlite.js';
import * as synthesisSchema from '../synthesis/schema.sqlite.js';
import * as workPlanSchema from '../work-plan/schema.sqlite.js';
import * as flowPointersSchema from '../flow-pointers/schema.sqlite.js';
import { loadFlowPointers } from '../flow-pointers/routes.js';
import * as humanThemesSchema from '../human-themes/schema.sqlite.js';
import * as annotSchema from '../annotations/schema.sqlite.js';
import * as advisorSchema from '../advisor/schema.sqlite.js';
import * as proSettingsSchema from '../settings/schema.sqlite.js';
import { scopeKeyFor } from '../insights/workspace-scope.js';
import { readAnnotation, readPrAnnotationRows } from '../annotations/runner.js';
import { loadSynthesis } from '../synthesis/routes.js';
import { canonicalSynthesisParams, synthesisScopeKey } from '../synthesis/scope.js';
import { loadReport as loadBotThemesReport } from '../bot-themes/routes.js';
import { eraseProByAccountId } from '../retention.js';
import type { ProContext } from '../contract.js';

// The CORE `repos` table, as the plugin sees it through `ctx.schema.repos`. Only the four columns
// the removed digest's `loadRepoNames` read (kept as a seeded core-table stub) — this is a stub for a table core owns, not a second definition
// of it. ⚠ `ctx.schema` is typed `Record<string, any>` in the contract, so a plugin query against a
// column core has DROPPED still TYPECHECKS and only fails as malformed SQL at runtime (that is
// exactly how the `inboxWatch` predicate survived migration 0046 into two Pro code paths). This
// stub is the only thing in the plugin's test tree that would catch such a drift.
const coreRepos = sqliteTable('repos', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  accountId: integer('account_id').notNull(),
  owner: text('owner').notNull(),
  name: text('name').notNull(),
});


// ── WORKSPACE IDS ────────────────────────────────────────────────────────────────────────────
// The scope vocabulary is now a single workspace id (`?workspace=<n>` on the wire, `ws:<n>` in
// `scope_key`), so every seed below keys on a real row in the core `workspaces` stub.
const WS_A = 5; //  account 1, NOT the default — id preserved from legacy team 5 by core 0044.
const WS_A_DEFAULT = 7; //  account 1's Default.
const WS_B_DEFAULT = 9; //  account 2's Default.

// ⚠ THE SHARED SCOPE KEY IS DELIBERATE AND REACHABLE, and it is what keeps every scope-isolation
// assertion below non-vacuous.
//
// Workspace ids are a GLOBAL primary key, so in the happy path no two accounts ever write the same
// `ws:<id>`. That would make `scope_key` alone a sufficient separator and the accountId predicate
// untested — an isolation suite whose seed data can only ever match one account proves nothing.
// But the collision IS reachable: `parseWorkspaceId` does no I/O and deliberately does not check
// ownership (a foreign id degrades to an empty repo set instead of a 404), so account 2 requesting
// `?workspace=5` writes its rows under `ws:5` too. Seeding that case is what makes `accountId` the
// thing doing the work.
const SHARED_SCOPE = scopeKeyFor(WS_A); //  'ws:5' — held by BOTH accounts.
const SECOND_SCOPE = scopeKeyFor(WS_A_DEFAULT); //  'ws:7' — account 1 only.

// The synthesis cache's key (P2.1) — built by the ONE canonical serialiser so the seed and any
// future route read agree byte-for-byte, and shared by BOTH accounts (see the seed's note).
const SYNTHESIS_SCOPE_KEY = synthesisScopeKey(
  WS_A,
  { kind: 'workspace-bots', window: 'rolling_14' },
  null,
);

// The 'person_report' key — the tail-bearing shape (`u:`/`pw:` slots). ⚠ Unlike the workspace
// collision above, this one IS reachable: `u:` carries a users.id, and `users` is a GLOBAL core
// table — two tenants tracking the same repo hold the same subject id, so two accounts minting
// a report for one person over one period collide on the FULL key by construction. `accountId`
// is the only separator, which is exactly what the read below pins.
const PERSON_REPORT_SCOPE_KEY = synthesisScopeKey(
  WS_A,
  // 'person_report' was REMOVED as a kind (2026-10-22); its stored rows are DORMANT and still
  // erased, so the key shape is still exercised here — hence the cast.
  canonicalSynthesisParams({
    kind: 'person_report',
    window: 'rolling_14',
    userId: 31,
    fromMs: Date.parse('2026-08-05T00:00:00Z'),
    toMs: Date.parse('2026-08-19T00:00:00Z'),
  } as unknown as Parameters<typeof canonicalSynthesisParams>[0]),
  null,
);

// ── THE WORK PLAN ────────────────────────────────────────────────────────────────────────────
// `pro_work_plans.scope_key` is `ws:<id>` — the bare workspace key, so SHARED_SCOPE is the key
// BOTH accounts hold (reachable exactly as that constant's note describes: `parseWorkspaceId`
// does no I/O and does not check ownership, so account 2 asking for `?workspace=5` writes its
// plan under `ws:5` too). Plus the narrowed spelling, which only ever appears when the request
// covered a strict subset of the workspace's repos — held by account 1 alone, so ONE account can
// be shown to hold two scopes while the two accounts stay apart at the shared one.
//
// ⚠ The `|r:` tail must be the SORTED csv and must be ABSENT when nothing was narrowed. Spelling
// an unnarrowed scope as `ws:5|r:10,11` would mint a second row for one plan, and the two rows
// would then age independently against the same evidence.
const WORK_PLAN_NARROWED_SCOPE = `${SHARED_SCOPE}|r:10,11`;

// ── PERIOD REPORTS ───────────────────────────────────────────────────────────────────────────
// `workspace_period_reports` keys on a PERIOD, not a scope string, and a period key is derived
// from the cadence alone — so two tenants running a fortnightly sprint from the same Monday
// produce the IDENTICAL key. That makes `period_key` a shared value by construction, in the way
// `scope_key` only becomes one through a foreign-id request.
const PERIOD_KEY = 'sprint-2026-08-18';
const HAIKU = 'claude-haiku-5-5';
const BACKFILL_MODEL = ''; //  the un-narrated backfill row. EMPTY STRING, never NULL — see below.

// The NOT NULL columns every seeded row needs. Overridden per row where the value is the point.
const PERIOD_ROW_BASE = {
  periodKey: PERIOD_KEY,
  periodStart: new Date('2026-08-18T00:00:00Z'),
  periodEnd: new Date('2026-09-01T00:00:00Z'),
  cadenceDays: 14,
  repoIdsJson: '[10,11]',
  coverageJson: '{"trackedRepos":2,"totalRepos":2,"complete":true}',
  metricsJson: '[]',
  metricsSchemaVersion: 1,
  payloadHash: 'ph',
  dataFingerprint: 'fp',
};

// ── THE CORE TABLES PLUGIN MIGRATIONS READ ───────────────────────────────────────────────────
// Plugin migrations run AFTER core's (index.ts completes runMigrations() before bindProPlugin()),
// so by the time 0019/0020 execute, core's schema is fully in place. This fixture holds only
// plugin tables, so those three core tables have to be stubbed or 0020 raises "no such table:
// workspaces" — and a raise there is not a local failure: pro/migrate.ts rethrows, bind.ts logs
// `pro register() failed — OSS mode`, and the ENTIRE plugin goes dark (every capability false,
// every /api/pro/* 404) with nothing a user would connect to a migration.
//
// Minimal on purpose — column names and types match core 0044/0045 exactly for the columns the
// plugin migrations touch; the FKs to `accounts`/`repos` are dropped because those tables are not
// part of this fixture and better-sqlite3 has foreign_keys OFF by default anyway.
const CORE_STUB_DDL = `
CREATE TABLE users (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  github_login text NOT NULL
);
CREATE TABLE repos (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  account_id integer NOT NULL,
  owner text NOT NULL,
  name text NOT NULL
);
CREATE TABLE workspaces (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  account_id integer NOT NULL,
  name text NOT NULL,
  is_default integer DEFAULT 0 NOT NULL,
  created_at integer DEFAULT (unixepoch()) NOT NULL,
  -- core 0074: plugin 0037 copies the retired auto-review switch into these.
  auto_review_enabled integer,
  auto_review_enabled_at integer
);
CREATE UNIQUE INDEX workspaces_account_name ON workspaces (account_id, name);
CREATE UNIQUE INDEX workspaces_id_account ON workspaces (id, account_id);
CREATE TABLE workspace_reviewers (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  account_id integer NOT NULL,
  workspace_id integer NOT NULL,
  author_user_id integer NOT NULL,
  automated integer NOT NULL,
  role text DEFAULT 'review' NOT NULL,
  confidence text NOT NULL,
  source text NOT NULL,
  reasons_json text,
  kind text,
  label text,
  identity_source text DEFAULT 'auto' NOT NULL,
  monthly_cents integer,
  updated_at integer DEFAULT (unixepoch()) NOT NULL
);
CREATE UNIQUE INDEX workspace_reviewers_account_workspace_author
  ON workspace_reviewers (account_id, workspace_id, author_user_id);
`;

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

// Discovered by FILENAME SORT and handed to `exec` as one blob — byte-for-byte the contract
// pro/migrate.ts implements (`readdirSync(folder).filter(.sql).sort()` → `client.exec(text)`).
//
// This replaced a hand-curated list, and the change is load-bearing rather than tidy-up: the
// curated list is what let plugin 0019 be written against two tables core 0045 drops without any
// test noticing, and a discovered list makes the next such file fail HERE instead of silently
// disabling the plugin in production (§9.16). It also means a future migration that reads a core
// table absent from CORE_STUB_DDL fails this suite — which is the signal, not a nuisance.
function pluginMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

function readMigration(file: string): string {
  return readFileSync(`${MIGRATIONS_DIR}${file}`, 'utf8');
}

let sqlite: Database.Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let ctx: ProContext;

beforeAll(() => {
  sqlite = new Database(':memory:');
  sqlite.exec(CORE_STUB_DDL);
  // A Default workspace per seeded account — core 0044 guarantees one, and plugin 0020's re-key
  // is a no-op for an account without it (see the migration suite at the bottom of this file).
  sqlite
    .prepare(
      `INSERT INTO workspaces (id, account_id, name, is_default) VALUES
         (?, 1, 'Platform', 0), (?, 1, 'Default', 1), (?, 2, 'Default', 1)`,
    )
    .run(WS_A, WS_A_DEFAULT, WS_B_DEFAULT);
  // Repos for BOTH accounts, matching the repo ids the digest fixtures below use. Account 2 MUST
  // own one, or every "account 1 cannot see it" assertion passes against an empty table and proves
  // nothing — the vacuous-guard failure mode.
  sqlite
    .prepare(
      `INSERT INTO repos (id, account_id, owner, name) VALUES
         (10, 1, 'acme', 'api'), (11, 1, 'acme', 'web'), (20, 2, 'other', 'secret')`,
    )
    .run();

  for (const file of pluginMigrationFiles()) {
    sqlite.exec(readMigration(file));
  }

  db = drizzle(sqlite, {
    schema: {
      ...schema,
      ...aiFixSchema,
      ...insightsSchema,
      ...periodSchema,
      ...assessSchema,
      ...addrSchema,
      ...botThemesSchema,
      ...humanThemesSchema,
      ...annotSchema,
      ...advisorSchema,
      ...proSettingsSchema,
    },
  });
  // A minimal ctx — the readers below touch ctx.db; ctx.schema.repos is how the
  // plugin sees core's tables.
  ctx = { db, schema: { repos: coreRepos } } as unknown as ProContext;

  const now = new Date();
  // (review_learnings + ai_fixes seeds left with the tables: core since migration 0074, their
  // isolation cases are core's apps/backend/src/review/agentic-isolation.test.ts.)
  db.insert(schema.repoDigests)
    .values({ accountId: 1, repoId: 10, payloadHash: 'h1', model: 'm', summary: 'A summary', createdAt: now })
    .run();
  db.insert(schema.repoDigests)
    .values({ accountId: 2, repoId: 20, payloadHash: 'h2', model: 'm', summary: 'B summary', createdAt: now })
    .run();

  // ai_pr_analyses — BOTH accounts have a 'summary' for the SAME prId (100).
  db.insert(aiFixSchema.aiPrAnalyses)
    .values({ accountId: 1, repoId: 10, prId: 100, kind: 'summary', payloadHash: 'p1', summary: 'A analysis', model: 'm', createdAt: now })
    .run();
  db.insert(aiFixSchema.aiPrAnalyses)
    .values({ accountId: 2, repoId: 20, prId: 100, kind: 'summary', payloadHash: 'p2', summary: 'B analysis', model: 'm', createdAt: now })
    .run();


  // sprint_reports — BOTH accounts have a report at the SAME scope key (SHARED_SCOPE, reachable
  // per the note on that constant); account 1 ALSO has one at its Default. The (account_id,
  // scope_key) unique index must let both scopes coexist for one account while keeping the two
  // accounts' SHARED_SCOPE rows distinct.
  db.insert(insightsSchema.sprintReports)
    .values({ accountId: 1, scopeKey: SHARED_SCOPE, insightsHash: 'h1', model: 'm', summary: 'A ws5 sprint', createdAt: now })
    .run();
  db.insert(insightsSchema.sprintReports)
    .values({ accountId: 1, scopeKey: SECOND_SCOPE, insightsHash: 'h1t', model: 'm', summary: 'A ws7 sprint', createdAt: now })
    .run();
  db.insert(insightsSchema.sprintReports)
    .values({ accountId: 2, scopeKey: SHARED_SCOPE, insightsHash: 'h2', model: 'm', summary: 'B ws5 sprint', createdAt: now })
    .run();

  // preset_reports — BOTH accounts cache the SAME preset ('attention_now') at the SAME scope;
  // the (account_id, scope_key, preset_key) index keeps them per-account.
  db.insert(insightsSchema.presetReports)
    .values({ accountId: 1, scopeKey: SHARED_SCOPE, presetKey: 'attention_now', markdown: 'A answer', payloadHash: 'pa', model: 'm', generatedAt: now })
    .run();
  db.insert(insightsSchema.presetReports)
    .values({ accountId: 2, scopeKey: SHARED_SCOPE, presetKey: 'attention_now', markdown: 'B answer', payloadHash: 'pb', model: 'm', generatedAt: now })
    .run();

  // pinned_prompts — BOTH accounts save a prompt at the SAME scope; the (account_id, scope_key)
  // index isn't unique, but reads MUST still scope accountId so one account never sees the other's
  // saved prompts.
  db.insert(insightsSchema.pinnedPrompts)
    .values({ accountId: 1, scopeKey: SHARED_SCOPE, text: 'A pinned prompt', wantChart: true, wantBots: false, createdAt: now })
    .run();
  db.insert(insightsSchema.pinnedPrompts)
    .values({ accountId: 2, scopeKey: SHARED_SCOPE, text: 'B pinned prompt', wantChart: false, wantBots: true, createdAt: now })
    .run();

  // sprint_chat_history — BOTH accounts have stored chats. listSprintChatHistory MUST scope
  // accountId so one account never sees the other's questions/answers, AND scopeKey (history is
  // per workspace context — switching workspaces shows that workspace's own questions). Account 1
  // therefore has TWO rows at SHARED_SCOPE plus one at SECOND_SCOPE that must not show up
  // alongside them.
  db.insert(insightsSchema.sprintChatHistory)
    .values({ accountId: 1, scopeKey: SHARED_SCOPE, question: 'A q1', answer: 'A ans1', createdAt: now })
    .run();
  db.insert(insightsSchema.sprintChatHistory)
    .values({ accountId: 1, scopeKey: SHARED_SCOPE, question: 'A q3', answer: 'A ans3', createdAt: now })
    .run();
  db.insert(insightsSchema.sprintChatHistory)
    .values({ accountId: 1, scopeKey: SECOND_SCOPE, question: 'A q2', answer: 'A ans2', createdAt: now })
    .run();
  db.insert(insightsSchema.sprintChatHistory)
    .values({ accountId: 2, scopeKey: SHARED_SCOPE, question: 'B q1', answer: 'B ans1', createdAt: now })
    .run();

  // workspace_period_reports — FOUR rows, each seeded for a different reason:
  //
  //   1. account 1 @ WS_A, model HAIKU        — the narrated report.
  //   2. account 1 @ WS_A, model ''           — the BACKFILLED (un-narrated) row for the SAME
  //      period. `model` is in the unique key precisely so these two coexist; without it the
  //      backfill would overwrite the report the user paid for.
  //   3. account 2 @ WS_A, model HAIKU        — the cross-account collision on the FULL logical
  //      key. ⚠ This shape is NOT reachable through today's routes: `resolveRequestScope` resolves
  //      `?workspace=` to an id the caller provably owns (a foreign id degrades to their Default),
  //      so account 2 can never write under workspace 5. It is seeded anyway, and deliberately,
  //      because that is a property of ONE resolver — the isolation guarantee must not depend on
  //      every future writer remembering to go through it. With this row present, `accountId` is
  //      the only thing separating the two reads below, which is exactly what makes them
  //      non-vacuous (the MUTATION CHECK proves it).
  //   4. account 2 @ WS_B_DEFAULT, model HAIKU — the shape that IS reachable today: two tenants on
  //      the same cadence produce the identical `period_key`, so the key is shared by construction
  //      even when the workspace ids differ.
  db.insert(periodSchema.workspacePeriodReports)
    .values({ ...PERIOD_ROW_BASE, accountId: 1, workspaceId: WS_A, model: HAIKU, narrativeMd: 'A narrative', generatedAt: now })
    .run();
  db.insert(periodSchema.workspacePeriodReports)
    .values({ ...PERIOD_ROW_BASE, accountId: 1, workspaceId: WS_A, model: BACKFILL_MODEL, narrativeMd: null, generatedAt: now })
    .run();
  db.insert(periodSchema.workspacePeriodReports)
    .values({ ...PERIOD_ROW_BASE, accountId: 2, workspaceId: WS_A, model: HAIKU, narrativeMd: 'B narrative', repoIdsJson: '[20]', generatedAt: now })
    .run();
  db.insert(periodSchema.workspacePeriodReports)
    .values({ ...PERIOD_ROW_BASE, accountId: 2, workspaceId: WS_B_DEFAULT, model: HAIKU, narrativeMd: 'B default narrative', repoIdsJson: '[20]', generatedAt: now })
    .run();

  // comment_assessments — BOTH accounts have an assessment keyed on the SAME root comment id (500);
  // the (account_id, comment_id) unique index keeps them per-account.
  db.insert(assessSchema.commentAssessments)
    .values({ accountId: 1, repoId: 10, prId: 100, threadId: 300, commentId: 500, verdict: 'valid', assessment: 'A assess', payloadHash: 'ca1', model: 'm', createdAt: now })
    .run();
  db.insert(assessSchema.commentAssessments)
    .values({ accountId: 2, repoId: 20, prId: 200, threadId: 400, commentId: 500, verdict: 'weak', assessment: 'B assess', payloadHash: 'ca2', model: 'm', createdAt: now })
    .run();

  // addressed_checks — BOTH accounts have a check keyed on the SAME (targetKind, targetId); the
  // (account_id, target_kind, target_id) unique index keeps them per-account.
  db.insert(addrSchema.addressedChecks)
    .values({ accountId: 1, repoId: 10, prId: 100, targetKind: 'thread', targetId: 700, verdict: 'addressed', confidence: 90, rationale: 'A rationale', payloadHash: 'ac1', model: 'm', createdAt: now })
    .run();
  db.insert(addrSchema.addressedChecks)
    .values({ accountId: 2, repoId: 20, prId: 200, targetKind: 'thread', targetId: 700, verdict: 'not_addressed', confidence: 20, rationale: 'B rationale', payloadHash: 'ac2', model: 'm', createdAt: now })
    .run();

  // bot_theme_reports — BOTH accounts cache a report at the SAME (scope_key, window_kind); the
  // (account_id, scope_key, window_kind) unique index keeps them per-account.
  db.insert(botThemesSchema.botThemeReports)
    .values({ accountId: 1, scopeKey: SHARED_SCOPE, windowKind: 'rolling_14', payloadHash: 'bt1', resultJson: '{"narrative":"A themes"}', model: 'm', generatedAt: now })
    .run();
  db.insert(botThemesSchema.botThemeReports)
    .values({ accountId: 2, scopeKey: SHARED_SCOPE, windowKind: 'rolling_14', payloadHash: 'bt2', resultJson: '{"narrative":"B themes"}', model: 'm', generatedAt: now })
    .run();

  // pro_synthesis (P2.1) — BOTH accounts cache a synthesis under the IDENTICAL scope_key; the
  // (account_id, scope_key) unique index keeps them per-account. ⚠ Like the period-reports
  // cross-account seed above, this collision is NOT reachable through today's routes — the key
  // embeds `ws:<id>` and resolveRequestScope only ever resolves an id the caller owns — and it is
  // seeded anyway, deliberately: that is a property of ONE resolver, and the isolation guarantee
  // must not depend on every future writer remembering to go through it. With this row present,
  // `accountId` is the only thing separating the two loadSynthesis reads below.
  db.insert(synthesisSchema.proSynthesis)
    .values({
      accountId: 1,
      scopeKey: SYNTHESIS_SCOPE_KEY,
      kind: 'workspace-bots',
      payloadHash: 'sy1',
      output: '{"clusters":[{"label":"A cluster","itemIds":["rc:1"],"count":1}],"remainderIds":[],"truncated":false}',
      model: 'm',
      inputCount: 1,
      analyzedCount: 1,
      generatedAt: now,
    })
    .run();
  db.insert(synthesisSchema.proSynthesis)
    .values({
      accountId: 2,
      scopeKey: SYNTHESIS_SCOPE_KEY,
      kind: 'workspace-bots',
      payloadHash: 'sy2',
      output: '{"clusters":[{"label":"B cluster","itemIds":["rc:2"],"count":1}],"remainderIds":[],"truncated":false}',
      model: 'm',
      inputCount: 1,
      analyzedCount: 1,
      generatedAt: now,
    })
    .run();
  // …and the SAME collision under the 'person_report' tail-bearing key — here it is REACHABLE
  // (the `u:` slot is a global users.id; see the key's note above), so the accountId predicate
  // is not defending a hypothetical. Sections-bearing outputs, one per tenant.
  db.insert(synthesisSchema.proSynthesis)
    .values({
      accountId: 1,
      scopeKey: PERSON_REPORT_SCOPE_KEY,
      kind: 'person_report',
      payloadHash: 'pr1',
      output: '{"clusters":[],"remainderIds":[],"truncated":false,"sections":[{"id":"worked_on","prose":"A person report","refs":["pe1:pr:1"]}]}',
      model: 'm',
      inputCount: 1,
      analyzedCount: 1,
      generatedAt: now,
    })
    .run();
  db.insert(synthesisSchema.proSynthesis)
    .values({
      accountId: 2,
      scopeKey: PERSON_REPORT_SCOPE_KEY,
      kind: 'person_report',
      payloadHash: 'pr2',
      output: '{"clusters":[],"remainderIds":[],"truncated":false,"sections":[{"id":"worked_on","prose":"B person report","refs":["pe1:pr:2"]}]}',
      model: 'm',
      inputCount: 1,
      analyzedCount: 1,
      generatedAt: now,
    })
    .run();

  // pro_flow_pointers — BOTH accounts cache pointers under the IDENTICAL `ws:5|d:30` key (the
  // same reachable collision as the work plan: a foreign `?workspace=` degrades, never 404s), and
  // account 1 also holds the 90-day window. The accountId predicate on the read is the only thing
  // between two tenants' prose about their pull requests.
  for (const [accountId, scopeKey, hash, text] of [
    [1, 'ws:5|d:30', 'fp1', 'A pointer'],
    [2, 'ws:5|d:30', 'fp2', 'B pointer'],
    [1, 'ws:5|d:90', 'fp1l', 'A long pointer'],
  ] as const) {
    db.insert(flowPointersSchema.proFlowPointers)
      .values({
        accountId,
        scopeKey,
        payloadHash: hash,
        output: JSON.stringify({ pointers: [{ kind: 'pattern', text, cites: [100] }], droppedIds: 0, droppedPointers: 0 }),
        model: 'm',
        prCount: 1,
        generatedAt: now,
      })
      .run();
  }

  // pro_work_plans — BOTH accounts cache a plan under the IDENTICAL `ws:5` scope_key; the
  // (account_id, scope_key) unique index keeps them per-account, and the accountId predicate on
  // the read is the only thing separating them. ⚠ This collision is REACHABLE, not hypothetical:
  // `parseWorkspaceId` does no I/O and deliberately does not check ownership (a foreign id
  // degrades to an empty repo set rather than a 404), so account 2 requesting `?workspace=5`
  // writes its own row at `ws:5`. Account 1 ALSO holds the NARROWED spelling, proving the unique
  // index lets one tenant hold several scopes at once.
  //
  // The stored `output` carries model PROSE ONLY — no prId, repoId, threadId, githubUrl, rank or
  // figure. Every one of those comes from the live `getWorkPlan` fold; the steps join to it by
  // `WorkPlanItem.id`. A leak through this table can therefore only ever be a sentence, but a
  // sentence about the other tenant's open work is exactly what must not cross.
  db.insert(workPlanSchema.proWorkPlans)
    .values({
      accountId: 1,
      scopeKey: SHARED_SCOPE,
      payloadHash: 'wp1',
      output:
        '{"headline":"A plan headline","steps":[{"id":"wp:merge:100","why":"A why"}],"parked":null,"model":"m","generatedAt":"2026-08-27T00:00:00.000Z","droppedIds":0}',
      model: 'm',
      itemCount: 1,
      generatedAt: now,
    })
    .run();
  db.insert(workPlanSchema.proWorkPlans)
    .values({
      accountId: 2,
      scopeKey: SHARED_SCOPE,
      payloadHash: 'wp2',
      output:
        '{"headline":"B plan headline","steps":[{"id":"wp:merge:200","why":"B why"}],"parked":"B parked","model":"m","generatedAt":"2026-08-27T00:00:00.000Z","droppedIds":0}',
      model: 'm',
      itemCount: 1,
      generatedAt: now,
    })
    .run();
  db.insert(workPlanSchema.proWorkPlans)
    .values({
      accountId: 1,
      scopeKey: WORK_PLAN_NARROWED_SCOPE,
      payloadHash: 'wp1n',
      output:
        '{"headline":"A narrowed headline","steps":[],"parked":null,"model":"m","generatedAt":"2026-08-27T00:00:00.000Z","droppedIds":0}',
      model: 'm',
      itemCount: 0,
      generatedAt: now,
    })
    .run();

  // human_theme_reports — same (scope, window) for BOTH accounts; (account_id, scope_key,
  // window_kind) unique index keeps them per-account.
  db.insert(humanThemesSchema.humanThemeReports)
    .values({ accountId: 1, scopeKey: SHARED_SCOPE, windowKind: 'rolling_14', payloadHash: 'ht1', resultJson: '{"narrative":"A human"}', model: 'm', generatedAt: now })
    .run();
  db.insert(humanThemesSchema.humanThemeReports)
    .values({ accountId: 2, scopeKey: SHARED_SCOPE, windowKind: 'rolling_14', payloadHash: 'ht2', resultJson: '{"narrative":"B human"}', model: 'm', generatedAt: now })
    .run();

  // The advisor's three tables — BOTH accounts hold rows at the SAME logical keys (the same
  // dedupe_key / the same bot_user_id 501), each in its OWN workspace. The accountId predicate
  // is what keeps them apart, and the mutation checks below prove it is doing the work.
  db.insert(advisorSchema.advisorRecommendations)
    .values({ accountId: 1, workspaceId: WS_A_DEFAULT, botUserId: 501, intent: 'SUPPRESS_PATH', dedupeKey: 'SUPPRESS_PATH|501|src/**|rolling_30', targetJson: '{}', evidenceJson: '{}', status: 'pr_opened', prUrl: 'https://github.com/acme/api/pull/9', createdAt: now, updatedAt: now })
    .run();
  db.insert(advisorSchema.advisorRecommendations)
    .values({ accountId: 2, workspaceId: WS_B_DEFAULT, botUserId: 501, intent: 'SUPPRESS_PATH', dedupeKey: 'SUPPRESS_PATH|501|src/**|rolling_30', targetJson: '{}', evidenceJson: '{}', status: 'dismissed', createdAt: now, updatedAt: now })
    .run();
  db.insert(advisorSchema.advisorBotProfiles)
    .values({ accountId: 1, workspaceId: WS_A_DEFAULT, botUserId: 501, kindHint: 'known:coderabbit', ownerRepo: 'acme/bots', profileSource: 'user', createdAt: now, updatedAt: now })
    .run();
  db.insert(advisorSchema.advisorBotProfiles)
    .values({ accountId: 2, workspaceId: WS_B_DEFAULT, botUserId: 501, kindHint: 'prose', ownerRepo: 'other/bots', profileSource: 'user', createdAt: now, updatedAt: now })
    .run();
  db.insert(advisorSchema.advisorConfigEvents)
    .values({ accountId: 1, workspaceId: WS_A_DEFAULT, repoId: 10, botUserId: 501, source: 'advisor_pr', occurredAt: now, description: 'A tuned', createdAt: now })
    .run();
  db.insert(advisorSchema.advisorConfigEvents)
    .values({ accountId: 2, workspaceId: WS_B_DEFAULT, repoId: 20, botUserId: 501, source: 'user_reported', occurredAt: now, description: 'B tuned', createdAt: now })
    .run();

  // pr_comment_annotations — BOTH accounts hold a judgement on the SAME (kind, target_kind,
  // target_id) triple, AND account 1 additionally holds a second KIND on the same target. The
  // (account_id, kind, target_kind, target_id) unique index must let those coexist while keeping
  // the two accounts' rows distinct. Seeding account 2 with REAL rows is what makes the
  // assertions below non-vacuous — see the mutation test at the end of that block.
  db.insert(annotSchema.prCommentAnnotations)
    .values({ accountId: 1, repoId: 10, prId: 100, kind: 'validity', targetKind: 'review_comment', targetId: 900, verdict: 'valid', confidence: null, body: 'A validity', payloadHash: 'pa1', model: 'm', createdAt: now })
    .run();
  db.insert(annotSchema.prCommentAnnotations)
    .values({ accountId: 2, repoId: 20, prId: 200, kind: 'validity', targetKind: 'review_comment', targetId: 900, verdict: 'weak', confidence: null, body: 'B validity', payloadHash: 'pa2', model: 'm', createdAt: now })
    .run();
  db.insert(annotSchema.prCommentAnnotations)
    .values({ accountId: 1, repoId: 10, prId: 100, kind: 'simplify', targetKind: 'review_comment', targetId: 900, verdict: null, confidence: null, body: 'A simplified', payloadHash: 'ps1', model: 'm', createdAt: now })
    .run();
  // Same target_id (900) reused under a DIFFERENT target_kind: prComments.id and
  // reviewComments.id are separate id spaces, which is exactly why target_kind is in the key
  // (the old comment_assessments table keyed on a bare comment id and would have collided).
  db.insert(annotSchema.prCommentAnnotations)
    .values({ accountId: 2, repoId: 20, prId: 200, kind: 'addressed', targetKind: 'pr_comment', targetId: 900, verdict: 'not_addressed', confidence: 20, body: 'B addressed', payloadHash: 'pa3', model: 'm', createdAt: now })
    .run();
});

afterAll(() => {
  sqlite.close();
});

describe('repo_digests isolation', () => {
  it('a cached-digest read only returns the caller account', () => {
    const t = schema.repoDigests;
    const a = db.select().from(t).where(eq(t.accountId, 1)).all();
    const b = db.select().from(t).where(eq(t.accountId, 2)).all();
    expect(a).toHaveLength(1);
    expect(a[0].summary).toBe('A summary');
    expect(b).toHaveLength(1);
    expect(b[0].summary).toBe('B summary');
    // Account 1 cannot read account 2's repo digest by repo id.
    const crossRepo = db
      .select()
      .from(t)
      .where(and(eq(t.accountId, 1), eq(t.repoId, 20)))
      .all();
    expect(crossRepo).toHaveLength(0);
  });
});

describe('sprint_reports scope isolation', () => {
  it('scope-keyed reads stay per-account and per-scope', () => {
    const t = insightsSchema.sprintReports;
    // Account 1's SHARED_SCOPE report — scoped by (accountId, scopeKey).
    const aShared = db
      .select()
      .from(t)
      .where(and(eq(t.accountId, 1), eq(t.scopeKey, SHARED_SCOPE)))
      .all();
    expect(aShared).toHaveLength(1);
    expect(aShared[0].summary).toBe('A ws5 sprint');
    // Account 1's second workspace coexists (composite unique) and is distinct.
    const aSecond = db
      .select()
      .from(t)
      .where(and(eq(t.accountId, 1), eq(t.scopeKey, SECOND_SCOPE)))
      .all();
    expect(aSecond).toHaveLength(1);
    expect(aSecond[0].summary).toBe('A ws7 sprint');
    // Account 2 cannot read account 1's report at the same key; it only sees its own.
    const bShared = db
      .select()
      .from(t)
      .where(and(eq(t.accountId, 2), eq(t.scopeKey, SHARED_SCOPE)))
      .all();
    expect(bShared).toHaveLength(1);
    expect(bShared[0].summary).toBe('B ws5 sprint');
    // Account 2 has nothing at account 1's Default workspace key.
    expect(
      db.select().from(t).where(and(eq(t.accountId, 2), eq(t.scopeKey, SECOND_SCOPE))).all(),
    ).toHaveLength(0);
  });
});

describe('sprint_chat_history isolation (DORMANT since 2026-10-22: no route reads it)', () => {
  // The chat and its history reader were removed; the table is kept and still erased. What stays
  // pinned is that a scoped read of the stored rows separates the two accounts.
  it('an accountId-scoped read never returns the other account’s rows at a shared scope', () => {
    const t = insightsSchema.sprintChatHistory;
    const a = db
      .select()
      .from(t)
      .where(and(eq(t.accountId, 1), eq(t.scopeKey, SHARED_SCOPE)))
      .all();
    const b = db
      .select()
      .from(t)
      .where(and(eq(t.accountId, 2), eq(t.scopeKey, SHARED_SCOPE)))
      .all();
    expect(a).toHaveLength(2);
    expect(a.every((r: { question: string }) => r.question.startsWith('A '))).toBe(true);
    expect(b).toHaveLength(1);
    expect(b[0].question).toBe('B q1');
  });

  it('MUTATION CHECK: the accountId predicate — not the scope key — separates the two accounts', () => {
    // Both accounts hold rows at the SAME `ws:5`, so dropping accountId returns BOTH. Without
    // this counterfactual the assertions above would pass on a query that ignored accountId.
    const t = insightsSchema.sprintChatHistory;
    const unscoped = db.select().from(t).where(eq(t.scopeKey, SHARED_SCOPE)).all();
    expect(unscoped).toHaveLength(3); // 2 × account 1 + 1 × account 2
    expect(
      Array.from(new Set(unscoped.map((r: { accountId: number }) => r.accountId))).sort(),
    ).toEqual([1, 2]);
  });
});

describe('preset_reports scope isolation', () => {
  it('a cached preset read scopes accountId even on a shared (scope, preset)', () => {
    const t = insightsSchema.presetReports;
    const a = db
      .select()
      .from(t)
      .where(and(eq(t.accountId, 1), eq(t.scopeKey, SHARED_SCOPE), eq(t.presetKey, 'attention_now')))
      .all();
    const b = db
      .select()
      .from(t)
      .where(and(eq(t.accountId, 2), eq(t.scopeKey, SHARED_SCOPE), eq(t.presetKey, 'attention_now')))
      .all();
    expect(a).toHaveLength(1);
    expect(a[0].markdown).toBe('A answer');
    expect(b).toHaveLength(1);
    expect(b[0].markdown).toBe('B answer');
    // Account 1 never sees account 2's cached answer for the same scope+preset.
    expect(a.every((r: { accountId: number }) => r.accountId === 1)).toBe(true);
  });
});

describe('pinned_prompts scope isolation', () => {
  it('a saved-prompt read scopes accountId even at a shared scope', () => {
    const t = insightsSchema.pinnedPrompts;
    const a = db
      .select()
      .from(t)
      .where(and(eq(t.accountId, 1), eq(t.scopeKey, SHARED_SCOPE)))
      .all();
    const b = db
      .select()
      .from(t)
      .where(and(eq(t.accountId, 2), eq(t.scopeKey, SHARED_SCOPE)))
      .all();
    expect(a).toHaveLength(1);
    expect(a[0].text).toBe('A pinned prompt');
    expect(b).toHaveLength(1);
    expect(b[0].text).toBe('B pinned prompt');
    // Account 1 never sees account 2's saved prompt at the same scope.
    expect(a.every((r: { accountId: number }) => r.accountId === 1)).toBe(true);
  });
});

describe('workspace_period_reports isolation', () => {
  const t = periodSchema.workspacePeriodReports;

  it('a (account, workspace, period) read never returns the other account\'s report', () => {
    // Account 1 holds TWO rows for this period — the narrated one and the backfilled one — and
    // account 2 holds one at the SAME workspace id and the SAME period key.
    const a = db
      .select()
      .from(t)
      .where(and(eq(t.accountId, 1), eq(t.workspaceId, WS_A), eq(t.periodKey, PERIOD_KEY)))
      .all();
    expect(a).toHaveLength(2);
    expect(a.map((r: { model: string }) => r.model).sort()).toEqual([BACKFILL_MODEL, HAIKU]);
    expect(a.every((r: { accountId: number }) => r.accountId === 1)).toBe(true);
    expect(
      a.find((r: { model: string }) => r.model === HAIKU).narrativeMd,
    ).toBe('A narrative');
    // The backfilled row is metrics-only: no narrative, and the empty-string model beside it.
    expect(a.find((r: { model: string }) => r.model === BACKFILL_MODEL).narrativeMd).toBeNull();

    const b = db
      .select()
      .from(t)
      .where(and(eq(t.accountId, 2), eq(t.workspaceId, WS_A), eq(t.periodKey, PERIOD_KEY)))
      .all();
    expect(b).toHaveLength(1);
    expect(b[0].narrativeMd).toBe('B narrative');

    // Account 1 asking for account 2's OWN workspace gets nothing …
    expect(
      db.select().from(t).where(and(eq(t.accountId, 1), eq(t.workspaceId, WS_B_DEFAULT))).all(),
    ).toHaveLength(0);
    // … and the positive control: that row is real and answers for its true owner. Without it the
    // assertion above would also pass against an empty table.
    const bOwn = db
      .select()
      .from(t)
      .where(and(eq(t.accountId, 2), eq(t.workspaceId, WS_B_DEFAULT)))
      .all();
    expect(bOwn).toHaveLength(1);
    expect(bOwn[0].narrativeMd).toBe('B default narrative');
  });

  it('MUTATION CHECK: accountId — not the workspace id, not the period key — separates them', () => {
    // Reproduce the lookup with the account predicate REMOVED and prove it would return BOTH
    // accounts' rows, so a future edit that drops it cannot look harmless. Two separate leaks are
    // asserted because the two candidate "natural" keys both fail on their own:
    //   • the FULL logical key (workspace + period + model) — the seeded collision.
    const unscopedFullKey = db
      .select()
      .from(t)
      .where(and(eq(t.workspaceId, WS_A), eq(t.periodKey, PERIOD_KEY), eq(t.model, HAIKU)))
      .all();
    expect(unscopedFullKey).toHaveLength(2);
    expect(
      unscopedFullKey.map((r: { accountId: number }) => r.accountId).sort(),
    ).toEqual([1, 2]);
    //   • the PERIOD KEY alone — shared by construction, since it is derived from the cadence and
    //     two tenants on the same fortnight produce the same string.
    const unscopedByPeriod = db.select().from(t).where(eq(t.periodKey, PERIOD_KEY)).all();
    expect(
      Array.from(
        new Set(unscopedByPeriod.map((r: { accountId: number }) => r.accountId)),
      ).sort(),
    ).toEqual([1, 2]);

    // The same lookup WITH the predicate returns exactly the caller's own row.
    const scoped = db
      .select()
      .from(t)
      .where(
        and(
          eq(t.accountId, 1),
          eq(t.workspaceId, WS_A),
          eq(t.periodKey, PERIOD_KEY),
          eq(t.model, HAIKU),
        ),
      )
      .all();
    expect(scoped).toHaveLength(1);
    expect(scoped[0].narrativeMd).toBe('A narrative');
  });

  it('`model` is in the unique key, so a Sonnet run lands BESIDE the Haiku row', () => {
    // The whole reason `model` is part of the identity: re-narrating a period on a pricier model
    // must not destroy the copy the user already read (and may have forwarded).
    db.insert(t)
      .values({
        ...PERIOD_ROW_BASE,
        accountId: 1,
        workspaceId: WS_A,
        model: 'claude-sonnet-5',
        narrativeMd: 'A sonnet narrative',
        generatedAt: new Date(),
      })
      .run();
    const rows = db
      .select()
      .from(t)
      .where(and(eq(t.accountId, 1), eq(t.workspaceId, WS_A), eq(t.periodKey, PERIOD_KEY)))
      .all();
    expect(rows.map((r: { model: string }) => r.model).sort()).toEqual([
      BACKFILL_MODEL,
      HAIKU,
      'claude-sonnet-5',
    ]);
    expect(
      rows.find((r: { model: string }) => r.model === HAIKU).narrativeMd,
    ).toBe('A narrative');

    // …and the index really is UNIQUE on the full four-column key, which is also the proof that
    // migration 0025 applied: a second insert at an EXISTING (account, workspace, period, model)
    // raises rather than duplicating, so every writer must go through onConflictDoUpdate targeting
    // exactly [accountId, workspaceId, periodKey, model].
    expect(() =>
      db
        .insert(t)
        .values({
          ...PERIOD_ROW_BASE,
          accountId: 1,
          workspaceId: WS_A,
          model: 'claude-sonnet-5',
          narrativeMd: 'a duplicate',
          generatedAt: new Date(),
        })
        .run(),
    ).toThrow(/UNIQUE/i);
  });

  it('a NULL model would NOT collide — which is exactly why a backfilled row stores \'\'', () => {
    // The landmine this table's key is shaped around, asserted rather than asserted-in-a-comment.
    // SQLite (and Postgres) treat NULLs in a unique index as DISTINCT, so a NULL-modelled row
    // never conflicts with anything — and the 8-period backfill, which re-runs on every first
    // generate, would insert a fresh set of rows every time, without bound.
    const key = 'sprint-1999-01-01'; //  throwaway period, cleaned up below.
    const row = (model: string | null) => ({
      ...PERIOD_ROW_BASE,
      periodKey: key,
      accountId: 1,
      workspaceId: WS_A,
      model,
      generatedAt: new Date(),
    });
    db.insert(t).values(row(null)).run();
    db.insert(t).values(row(null)).run(); //  no conflict: NULL never equals NULL
    expect(
      db.select().from(t).where(and(eq(t.accountId, 1), eq(t.periodKey, key))).all(),
    ).toHaveLength(2);

    // The EMPTY STRING is an ordinary value and does collide — which is what makes a repeated
    // backfill idempotent instead of unbounded.
    db.insert(t).values(row(BACKFILL_MODEL)).run();
    expect(() => db.insert(t).values(row(BACKFILL_MODEL)).run()).toThrow(/UNIQUE/i);

    db.delete(t).where(eq(t.periodKey, key)).run();
  });

  it('GDPR: eraseProByAccountId deletes the stored reports, and only the caller\'s', async () => {
    // ⚠ THE OMISSION THIS CATCHES IS INVISIBLE ELSEWHERE. An account-scoped PLUGIN table left out
    // of `eraseProByAccountId`'s array survives an erasure the user was told was complete, and
    // core's own erasure test cannot see it — it iterates core's `accountScopedTables()`, which
    // cannot name a table across the open-core boundary. This is the only check there is.
    //
    // A third account, seeded here so the erasure destroys nothing the rest of the suite reads.
    db.insert(t)
      .values({
        ...PERIOD_ROW_BASE,
        periodKey: 'sprint-2026-09-01',
        accountId: 3,
        workspaceId: 77,
        model: HAIKU,
        narrativeMd: 'C narrative',
        generatedAt: new Date(),
      })
      .run();
    expect(db.select().from(t).where(eq(t.accountId, 3)).all()).toHaveLength(1);

    // `log` is stubbed onto a COPY of ctx (the shared one has none): eraseProByAccountId swallows a
    // per-table failure through ctx.log.error, and an undefined logger would turn a real miss into
    // a TypeError rather than the assertion below.
    await eraseProByAccountId(
      { ...ctx, log: { error: () => {} } } as unknown as ProContext,
      3,
    );

    expect(db.select().from(t).where(eq(t.accountId, 3)).all()).toHaveLength(0);
    // The other tenants are untouched — the erasure is account-scoped, not a table wipe.
    expect(
      db
        .select()
        .from(t)
        .where(and(eq(t.accountId, 1), eq(t.workspaceId, WS_A), eq(t.model, HAIKU)))
        .all(),
    ).toHaveLength(1);
    expect(db.select().from(t).where(eq(t.accountId, 2)).all().length).toBeGreaterThan(0);
  });

  it('migration 0025 also added pro_settings.report_model', () => {
    // The second half of the same file, which has no other coverage: the period report's narration
    // model is per account, and a silently-missing column would surface as a 500 on the Pro
    // settings route rather than as anything connected to this migration.
    const cols = (
      sqlite.prepare("SELECT name FROM pragma_table_info('pro_settings')").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(cols).toContain('report_model');
  });
});

describe('comment_assessments isolation', () => {
  it('a retained assessment read scopes accountId even on a shared root comment id', () => {
    const t = assessSchema.commentAssessments;
    const a = db
      .select()
      .from(t)
      .where(and(eq(t.accountId, 1), eq(t.commentId, 500)))
      .all();
    const b = db
      .select()
      .from(t)
      .where(and(eq(t.accountId, 2), eq(t.commentId, 500)))
      .all();
    expect(a).toHaveLength(1);
    expect(a[0].assessment).toBe('A assess');
    expect(b).toHaveLength(1);
    expect(b[0].assessment).toBe('B assess');
    // Account 1 never sees account 2's assessment for the same comment id.
    expect(a.every((r: { accountId: number }) => r.accountId === 1)).toBe(true);
  });
});

describe('addressed_checks isolation', () => {
  it('a retained check read scopes accountId even on a shared (targetKind, targetId)', () => {
    const t = addrSchema.addressedChecks;
    const a = db
      .select()
      .from(t)
      .where(and(eq(t.accountId, 1), eq(t.targetKind, 'thread'), eq(t.targetId, 700)))
      .all();
    const b = db
      .select()
      .from(t)
      .where(and(eq(t.accountId, 2), eq(t.targetKind, 'thread'), eq(t.targetId, 700)))
      .all();
    expect(a).toHaveLength(1);
    expect(a[0].rationale).toBe('A rationale');
    expect(b).toHaveLength(1);
    expect(b[0].rationale).toBe('B rationale');
    // Account 1 never sees account 2's check for the same target.
    expect(a.every((r: { accountId: number }) => r.accountId === 1)).toBe(true);
  });
});

describe('pr_comment_annotations isolation', () => {
  it('readAnnotation scopes accountId on a SHARED (kind, targetKind, targetId)', async () => {
    // Both accounts hold a `validity` judgement on review-comment 900.
    const a = await readAnnotation(ctx, 1, 'validity', 'review_comment', 900);
    const b = await readAnnotation(ctx, 2, 'validity', 'review_comment', 900);
    expect(a?.body).toBe('A validity');
    expect(b?.body).toBe('B validity');
    expect(a?.verdict).toBe('valid');
    expect(b?.verdict).toBe('weak');
  });

  it('target_kind is part of the identity — the same id in two id spaces never collides', async () => {
    // Account 2 holds `addressed` on PR-COMMENT 900 but nothing on REVIEW-comment 900.
    expect(await readAnnotation(ctx, 2, 'addressed', 'pr_comment', 900)).not.toBeNull();
    expect(await readAnnotation(ctx, 2, 'addressed', 'review_comment', 900)).toBeNull();
    // …and account 1 holds neither (it only has validity + simplify on the review comment).
    expect(await readAnnotation(ctx, 1, 'addressed', 'pr_comment', 900)).toBeNull();
  });

  it('kinds coexist on one target, and readPrAnnotationRows never crosses accounts', async () => {
    const a = await readPrAnnotationRows(ctx, 1, 100);
    expect(a.map((r) => r.kind).sort()).toEqual(['simplify', 'validity']);
    expect(a.every((r) => r.body.startsWith('A '))).toBe(true);

    // Account 1 asking for account 2's PR id gets nothing — the accountId predicate, not the
    // prId, is what excludes it.
    expect(await readPrAnnotationRows(ctx, 1, 200)).toHaveLength(0);
    // Account 2's own rows are intact and its own.
    const b = await readPrAnnotationRows(ctx, 2, 200);
    expect(b).toHaveLength(2);
    expect(b.every((r) => r.body.startsWith('B '))).toBe(true);

    // Kind narrowing still stays account-scoped.
    const aValidity = await readPrAnnotationRows(ctx, 1, 100, ['validity']);
    expect(aValidity).toHaveLength(1);
    expect(aValidity[0]!.body).toBe('A validity');
  });

  it('MUTATION CHECK: the assertions above fail without the accountId predicate', () => {
    // An isolation test whose seed data can only ever match one account is VACUOUS — it passes
    // whether or not the query scopes accountId. This asserts the counterfactual directly: run
    // the SAME lookup with the accountId predicate REMOVED and prove it would return BOTH
    // accounts' rows, so the predicate is what does the work above.
    const t = annotSchema.prCommentAnnotations;
    const withoutAccountScope = db
      .select()
      .from(t)
      .where(
        and(eq(t.kind, 'validity'), eq(t.targetKind, 'review_comment'), eq(t.targetId, 900)),
      )
      .all();
    expect(withoutAccountScope).toHaveLength(2);
    expect(
      withoutAccountScope.map((r: { accountId: number }) => r.accountId).sort(),
    ).toEqual([1, 2]);

    // The same query WITH the predicate returns exactly one — the caller's own.
    const scoped = db
      .select()
      .from(t)
      .where(
        and(
          eq(t.accountId, 1),
          eq(t.kind, 'validity'),
          eq(t.targetKind, 'review_comment'),
          eq(t.targetId, 900),
        ),
      )
      .all();
    expect(scoped).toHaveLength(1);
    expect(scoped[0].body).toBe('A validity');
  });
});

describe('bot_theme_reports scope isolation', () => {
  it('loadReport scopes accountId even on a shared (scope, window)', async () => {
    // The GET/POST cache read itself, not a re-spelled select — the accountId predicate under
    // test is the one production runs (the loadSynthesis precedent). Both accounts hold a row at
    // the SAME (scope_key, window_kind) — reachable via a foreign `?workspace=` id, see the
    // seed's note — so only that predicate separates them.
    const a = await loadBotThemesReport(ctx, 1, SHARED_SCOPE, 'rolling_14');
    const b = await loadBotThemesReport(ctx, 2, SHARED_SCOPE, 'rolling_14');
    expect(a?.narrative).toBe('A themes');
    expect(b?.narrative).toBe('B themes');
    // An account with no row at the key gets null, not someone else's report.
    expect(await loadBotThemesReport(ctx, 3, SHARED_SCOPE, 'rolling_14')).toBeNull();
  });
});

describe('pro_synthesis isolation (P2.1)', () => {
  it('loadSynthesis scopes accountId even on an identical scope_key', async () => {
    // The GET/POST cache read itself, not a re-spelled select — the accountId predicate under
    // test is the one production runs. Both accounts hold a row at the SAME key (unreachable
    // through today's resolver, seeded deliberately — see the seed), so only that predicate
    // separates them.
    const a = await loadSynthesis(ctx, 1, SYNTHESIS_SCOPE_KEY);
    const b = await loadSynthesis(ctx, 2, SYNTHESIS_SCOPE_KEY);
    expect(a?.payloadHash).toBe('sy1');
    expect(a?.output).toContain('A cluster');
    expect(b?.payloadHash).toBe('sy2');
    expect(b?.output).toContain('B cluster');
    // An account with no row at the key gets null, not someone else's synthesis.
    expect(await loadSynthesis(ctx, 3, SYNTHESIS_SCOPE_KEY)).toBeNull();
  });

  it("scopes accountId on the 'person_report' tail-bearing key — a REACHABLE collision", async () => {
    // The `u:` slot carries a GLOBAL users.id, so two tenants tracking the same repo mint this
    // exact key for one subject+period in the ordinary course of use (no foreign-id request
    // needed) — the accountId predicate is the entire boundary between their reports.
    const a = await loadSynthesis(ctx, 1, PERSON_REPORT_SCOPE_KEY);
    const b = await loadSynthesis(ctx, 2, PERSON_REPORT_SCOPE_KEY);
    expect(a?.payloadHash).toBe('pr1');
    expect(a?.output).toContain('A person report');
    expect(b?.payloadHash).toBe('pr2');
    expect(b?.output).toContain('B person report');
    expect(await loadSynthesis(ctx, 3, PERSON_REPORT_SCOPE_KEY)).toBeNull();
  });

  it('GDPR: eraseProByAccountId covers pro_synthesis, and only the caller\'s rows', async () => {
    // The omission this catches is invisible elsewhere: an account-scoped PLUGIN table left out
    // of eraseProByAccountId's array survives an erasure the user was told was complete, and
    // core's erasure test iterates core's own accountScopedTables(), which cannot name this one.
    const t = synthesisSchema.proSynthesis;
    db.insert(t)
      .values({
        accountId: 3,
        scopeKey: SYNTHESIS_SCOPE_KEY,
        kind: 'workspace-bots',
        payloadHash: 'sy3',
        output: '{"clusters":[],"remainderIds":[],"truncated":false}',
        model: 'm',
        inputCount: 0,
        analyzedCount: 0,
        generatedAt: new Date(),
      })
      .run();
    expect(db.select().from(t).where(eq(t.accountId, 3)).all()).toHaveLength(1);

    await eraseProByAccountId(
      { ...ctx, log: { error: () => {} } } as unknown as ProContext,
      3,
    );

    expect(db.select().from(t).where(eq(t.accountId, 3)).all()).toHaveLength(0);
    // The other tenants' syntheses are untouched — account-scoped, not a table wipe. Two rows
    // each: the workspace-bots seed + the person_report seed.
    expect(db.select().from(t).where(eq(t.accountId, 1)).all()).toHaveLength(2);
    expect(db.select().from(t).where(eq(t.accountId, 2)).all()).toHaveLength(2);
  });
});

// ── pro_workspace_settings: the PER-WORKSPACE Pro config ────────────────────────────────────
//
// The row that decides which fortnight a workspace's Reports, Insights window and Slack digest are
// cut on — and, since plugin migration 0031, which Jira/Linear instance its pull requests deep-link
// into. That second half raised the stakes on this table's tenancy: a leak here is not a number,
// it is a customer's internal tracker hostname rendered on another tenant's PR.
//
// Two guarantees are pinned here, and they are different guarantees:
//
//   1. THE READ IS SCOPED BY (account, workspace). `resolveSprintCadence` selects on BOTH, and a
//      workspace id is REACHABLE across tenants in the sense that matters — a foreign `?workspace=`
//      degrades to the caller's Default rather than being rejected, so the account predicate is the
//      whole boundary if a handler ever passes an id through.
//   2. THE WRITE IS STRUCTURALLY TENANT-BOUND. `workspace_id` arrives on a request, so plugin
//      migration 0029 carries the NAMED composite FK against `workspaces (id, account_id)` — a
//      cross-account PAIR fails in the DATABASE, not in whichever handler remembered to check.
describe('pro_workspace_settings isolation', () => {
  const t = proSettingsSchema.proWorkspaceSettings;

  // ⚠ MUTATION CHECK — drop `eq(t.accountId, accountId)` here and the first test must go red
  // (it reads account 2's cadence for account 1). Verified red-then-green when this was written.
  const readCadence = (accountId: number, workspaceId: number) =>
    db
      .select()
      .from(t)
      .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId)))
      .all();

  // A third account with a workspace of its own, so the erasure case destroys nothing the rest of
  // the suite reads.
  const WS_C = 31;

  beforeAll(() => {
    sqlite
      .prepare('INSERT INTO workspaces (id, account_id, name, is_default) VALUES (?, 3, ?, 1)')
      .run(WS_C, 'Default C');
    // Both tenants hold a config row, at their OWN workspace ids.
    db
      .insert(t)
      .values({
        accountId: 1,
        workspaceId: WS_A_DEFAULT,
        sprintCadenceDays: 7,
      })
      .run();
    db
      .insert(t)
      .values({
        accountId: 2,
        workspaceId: WS_B_DEFAULT,
        sprintCadenceDays: 28,
      })
      .run();
  });

  // (The tracker hostname left this row with the tracker at apiVersion 23 — core's
  // `workspace_trackers` isolation is in core's verify:isolation.)
  it('one tenant never reads another tenant\'s cadence', () => {
    expect(readCadence(1, WS_A_DEFAULT)[0]?.sprintCadenceDays).toBe(7);
    expect(readCadence(2, WS_B_DEFAULT)[0]?.sprintCadenceDays).toBe(28);
    // The cross pairs are EMPTY, not the other tenant's row. Since plugin 0031 removed the
    // account-level fallback, empty is the FINAL answer for both settings — there is nothing
    // beneath this read that could fill it in.
    expect(readCadence(1, WS_B_DEFAULT)).toHaveLength(0);
    expect(readCadence(2, WS_A_DEFAULT)).toHaveLength(0);
  });

  it('the database itself refuses a cross-account (workspace, account) pair', () => {
    // The composite FK from migration 0029. Not a handler check — this is why a body-supplied
    // workspace id cannot reach another tenant's row even if a future route forgets to resolve it.
    //
    // ⚠ VACUITY CHECK, because this assertion depends on a PRAGMA rather than on the DDL.
    // better-sqlite3 (11.x) opens with `foreign_keys = 1`, so the constraint is live here — the
    // note near the top of this fixture claiming otherwise is stale. Confirm before trusting this
    // test: `sqlite.pragma('foreign_keys = OFF')` immediately above the insert must make it PASS
    // (verified when this was written), which is what proves the throw comes from the pair and not
    // from something incidental. Postgres enforces it unconditionally — verified by hand against
    // the replayed pg chain (§ Replaying the pg chain), where the same insert reports
    // `Key (workspace_id, account_id)=(20, 1) is not present in table "workspaces"`.
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(() =>
      db.insert(t).values({ accountId: 1, workspaceId: WS_B_DEFAULT, sprintCadenceDays: 14 }).run(),
    ).toThrow(/FOREIGN KEY/i);
    // ...and the OWNED pair is accepted, so the throw above is the PAIR failing rather than every
    // write to this table failing.
    expect(() =>
      db.insert(t).values({ accountId: 3, workspaceId: WS_C, sprintCadenceDays: 21 }).run(),
    ).not.toThrow();
    db.delete(t).where(eq(t.accountId, 3)).run();
  });

  it('GDPR: eraseProByAccountId takes the config rows, and only the caller\'s', async () => {
    db.insert(t).values({ accountId: 3, workspaceId: WS_C, sprintCadenceDays: 21 }).run();
    expect(db.select().from(t).where(eq(t.accountId, 3)).all()).toHaveLength(1);
    await eraseProByAccountId({ ...ctx, log: { error: () => {} } } as unknown as ProContext, 3);
    expect(db.select().from(t).where(eq(t.accountId, 3)).all()).toHaveLength(0);
    expect(db.select().from(t).where(eq(t.accountId, 1)).all()).toHaveLength(1);
    expect(db.select().from(t).where(eq(t.accountId, 2)).all()).toHaveLength(1);
  });
});

// ── workspace_slack_targets: the PER-WORKSPACE Slack webhook ───────────────────────────────
//
// The only plugin table that holds a LIVE SECRET — an incoming-webhook URL that is a bearer
// credential for a channel. Core's `accountScopedTables()` cannot see plugin tables, so the
// plugin's own erasure hook is the ONLY path that reaches it; that is pinned below rather than
// left to the retention list being read correctly.
//
// Filed here for the same reason its sibling `pro_workspace_settings` is: this is the canonical
// per-table isolation file, and a table whose tenancy is proved only in its FEATURE suite is one
// rename away from nobody noticing it stopped being proved at all.
describe('workspace_slack_targets isolation', () => {
  const t = proSettingsSchema.workspaceSlackTargets;

  // ⚠ MUTATION CHECK — drop `eq(t.accountId, accountId)` here and the first test must go red
  // (it reads account 2's webhook for account 1). Verified red-then-green when this was written.
  const readTarget = (accountId: number, workspaceId: number) =>
    db
      .select()
      .from(t)
      .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId)))
      .all();

  // A third account's workspace, so the erasure case destroys nothing the rest of the suite reads.
  const WS_D = 32;
  const HOOK_A = 'https://hooks.slack.com/services/T00000000/B00000000/aaaaaaaaaaaaaaaaaaaaaaaa';
  const HOOK_B = 'https://hooks.slack.com/services/T11111111/B11111111/bbbbbbbbbbbbbbbbbbbbbbbb';

  beforeAll(() => {
    sqlite
      .prepare('INSERT INTO workspaces (id, account_id, name, is_default) VALUES (?, 3, ?, 0)')
      .run(WS_D, 'Slack D');
    db.insert(t).values({ accountId: 1, workspaceId: WS_A_DEFAULT, webhookUrl: HOOK_A }).run();
    db.insert(t).values({ accountId: 2, workspaceId: WS_B_DEFAULT, webhookUrl: HOOK_B }).run();
  });

  it("one tenant never reads another tenant's webhook", () => {
    expect(readTarget(1, WS_A_DEFAULT)[0]?.webhookUrl).toBe(HOOK_A);
    expect(readTarget(2, WS_B_DEFAULT)[0]?.webhookUrl).toBe(HOOK_B);
    // The cross pairs are EMPTY, not the other tenant's row. For a credential the distinction is
    // the whole point: "no webhook configured" is a safe answer, another tenant's is a breach.
    expect(readTarget(1, WS_B_DEFAULT)).toHaveLength(0);
    expect(readTarget(2, WS_A_DEFAULT)).toHaveLength(0);
  });

  it('the database itself refuses a cross-account (workspace, account) pair', () => {
    // The named composite FK from plugin migration 0030. `workspace_id` arrives on a request body,
    // so tenancy here is STRUCTURAL — the pair fails in the database, not in whichever handler
    // remembered to check.
    //
    // ⚠ VACUITY CHECK: this assertion depends on a PRAGMA, so pin it. better-sqlite3 (11.x) opens
    // with `foreign_keys = 1`; `sqlite.pragma('foreign_keys = OFF')` immediately above the insert
    // must make this test PASS, which is what proves the throw comes from the PAIR.
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(() =>
      db.insert(t).values({ accountId: 1, workspaceId: WS_B_DEFAULT, webhookUrl: HOOK_A }).run(),
    ).toThrow(/FOREIGN KEY/i);
    // ...and the OWNED pair is accepted, so the throw above is the pair failing rather than every
    // write to this table failing.
    expect(() =>
      db.insert(t).values({ accountId: 3, workspaceId: WS_D, webhookUrl: HOOK_A }).run(),
    ).not.toThrow();
    db.delete(t).where(eq(t.accountId, 3)).run();
  });

  it('GDPR: eraseProByAccountId destroys the webhook, and only the caller\'s', async () => {
    // ⚠ This is the ONLY delete path that reaches a live plaintext credential — core's
    // accountScopedTables() cannot see plugin tables. If this goes red, an erased account's
    // channel token is still on disk.
    db.insert(t).values({ accountId: 3, workspaceId: WS_D, webhookUrl: HOOK_A }).run();
    expect(db.select().from(t).where(eq(t.accountId, 3)).all()).toHaveLength(1);
    await eraseProByAccountId({ ...ctx, log: { error: () => {} } } as unknown as ProContext, 3);
    expect(db.select().from(t).where(eq(t.accountId, 3)).all()).toHaveLength(0);
    expect(db.select().from(t).where(eq(t.accountId, 1)).all()).toHaveLength(1);
    expect(db.select().from(t).where(eq(t.accountId, 2)).all()).toHaveLength(1);
  });
});

describe('pro_work_plans isolation', () => {
  // The scoped cache read, spelled ONCE so the accountId predicate under test has a single home —
  // the same (account_id, scope_key) select the route's loader runs to serve a cached plan and to
  // decide `stale`.
  //
  // ⚠ MUTATION CHECK — this is how you prove the two tests below are not vacuous. Delete
  // `eq(t.accountId, accountId)` from this predicate: BOTH the shared-key test and the narrowed-
  // key test must go red (each returns 2 rows instead of 1, and reads the WRONG tenant's headline
  // out of row zero). If they still pass, the seed has lost one tenant's rows and the suite is
  // proving nothing. Verified red-then-green when this case was written.
  const t = workPlanSchema.proWorkPlans;
  const loadPlanRow = (accountId: number, scopeKey: string) =>
    db
      .select()
      .from(t)
      .where(and(eq(t.accountId, accountId), eq(t.scopeKey, scopeKey)))
      .all();

  it('a cached plan scopes accountId even on an identical scope_key', () => {
    // Both accounts hold a row at `ws:5` — REACHABLE (a foreign `?workspace=` id is never
    // rejected, it degrades to an empty repo set; see the seed's note), so `accountId` is the
    // entire boundary between two tenants' plans.
    const a = loadPlanRow(1, SHARED_SCOPE);
    const b = loadPlanRow(2, SHARED_SCOPE);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].payloadHash).toBe('wp1');
    expect(a[0].output).toContain('A plan headline');
    expect(b[0].payloadHash).toBe('wp2');
    expect(b[0].output).toContain('B plan headline');
    // Neither read can see so much as a sentence of the other's — the only thing this table ever
    // stores about the other tenant's work.
    expect(a[0].output).not.toContain('B plan headline');
    expect(a[0].output).not.toContain('B parked');
    expect(b[0].output).not.toContain('A plan headline');
    // An account with no row at the key gets nothing, not someone else's plan. (A cache MISS is
    // the correct answer: the panel still renders — the worklist is folded live, and only the
    // narration is cached.)
    expect(loadPlanRow(3, SHARED_SCOPE)).toEqual([]);
  });

  it('the narrowed `|r:` scope_key is a SEPARATE row, and still account-scoped', () => {
    // One account holding two scopes at once is what makes the (account_id, scope_key) unique
    // index the right shape: the unnarrowed workspace plan and a repo-narrowed one are different
    // populations and must not overwrite each other on regenerate.
    const narrowed = loadPlanRow(1, WORK_PLAN_NARROWED_SCOPE);
    expect(narrowed).toHaveLength(1);
    expect(narrowed[0].payloadHash).toBe('wp1n');
    expect(narrowed[0].output).toContain('A narrowed headline');
    // …and it is a DIFFERENT row from account 1's bare `ws:5` plan, not an alias of it.
    expect(narrowed[0].id).not.toBe(loadPlanRow(1, SHARED_SCOPE)[0].id);
    // Account 2 asking for the same narrowed key sees nothing of account 1's.
    expect(loadPlanRow(2, WORK_PLAN_NARROWED_SCOPE)).toEqual([]);
  });

  it("GDPR: eraseProByAccountId covers pro_work_plans, and only the caller's rows", async () => {
    // The omission this catches is invisible elsewhere: an account-scoped PLUGIN table left out
    // of eraseProByAccountId's array survives an erasure the user was told was complete, and
    // core's erasure test iterates core's own accountScopedTables(), which cannot name this one.
    // pruneProByPrIds will never reach this table either — the row spans a whole workspace and
    // has no pr_id grain — so THIS list is its only delete path.
    db.insert(t)
      .values({
        accountId: 3,
        scopeKey: SHARED_SCOPE,
        payloadHash: 'wp3',
        output:
          '{"headline":"C plan headline","steps":[],"parked":null,"model":"m","generatedAt":"2026-08-27T00:00:00.000Z","droppedIds":0}',
        model: 'm',
        itemCount: 0,
        generatedAt: new Date(),
      })
      .run();
    expect(db.select().from(t).where(eq(t.accountId, 3)).all()).toHaveLength(1);

    await eraseProByAccountId(
      { ...ctx, log: { error: () => {} } } as unknown as ProContext,
      3,
    );

    expect(db.select().from(t).where(eq(t.accountId, 3)).all()).toHaveLength(0);
    // The other tenants' plans are untouched — account-scoped, not a table wipe. Account 1 keeps
    // both of its scopes; account 2 keeps its one.
    expect(db.select().from(t).where(eq(t.accountId, 1)).all()).toHaveLength(2);
    expect(db.select().from(t).where(eq(t.accountId, 2)).all()).toHaveLength(1);
  });
});

describe('pro_flow_pointers isolation', () => {
  // ⚠ MUTATION CHECK: delete the accountId predicate from `loadFlowPointers` and the first test
  // goes red (account 2 reads account 1's row, the lower id). Verified when this was written.
  it('cached pointers scope accountId even on an identical scope_key', async () => {
    const a = await loadFlowPointers(ctx, 1, 'ws:5|d:30');
    const b = await loadFlowPointers(ctx, 2, 'ws:5|d:30');
    expect(a?.payloadHash).toBe('fp1');
    expect(a?.output).toContain('A pointer');
    expect(a?.output).not.toContain('B pointer');
    expect(b?.payloadHash).toBe('fp2');
    expect(b?.output).toContain('B pointer');
    expect(b?.output).not.toContain('A pointer');
    expect(await loadFlowPointers(ctx, 3, 'ws:5|d:30')).toBeNull();
  });

  it('each window is its own row, and still account-scoped', async () => {
    expect((await loadFlowPointers(ctx, 1, 'ws:5|d:90'))?.payloadHash).toBe('fp1l');
    expect(await loadFlowPointers(ctx, 2, 'ws:5|d:90')).toBeNull();
  });

  it("GDPR: eraseProByAccountId covers pro_flow_pointers, and only the caller's rows", async () => {
    const t = flowPointersSchema.proFlowPointers;
    db.insert(t)
      .values({ accountId: 3, scopeKey: 'ws:5|d:30', payloadHash: 'fp3', output: '{"pointers":[]}', model: 'm', prCount: 0, generatedAt: new Date() })
      .run();
    expect(db.select().from(t).where(eq(t.accountId, 3)).all()).toHaveLength(1);
    await eraseProByAccountId({ ...ctx, log: { error: () => {} } } as unknown as ProContext, 3);
    expect(db.select().from(t).where(eq(t.accountId, 3)).all()).toHaveLength(0);
    expect(db.select().from(t).where(eq(t.accountId, 1)).all()).toHaveLength(2);
    expect(db.select().from(t).where(eq(t.accountId, 2)).all()).toHaveLength(1);
  });
});

describe('human_theme_reports scope isolation', () => {
  it('a cached human-themes report scopes accountId even on a shared (scope, window)', () => {
    const t = humanThemesSchema.humanThemeReports;
    const a = db
      .select()
      .from(t)
      .where(and(eq(t.accountId, 1), eq(t.scopeKey, SHARED_SCOPE), eq(t.windowKind, 'rolling_14')))
      .all();
    const b = db
      .select()
      .from(t)
      .where(and(eq(t.accountId, 2), eq(t.scopeKey, SHARED_SCOPE), eq(t.windowKind, 'rolling_14')))
      .all();
    expect(a).toHaveLength(1);
    expect(a[0].resultJson).toBe('{"narrative":"A human"}');
    expect(b).toHaveLength(1);
    expect(b[0].resultJson).toBe('{"narrative":"B human"}');
    expect(a.every((r: { accountId: number }) => r.accountId === 1)).toBe(true);
  });
});

describe('advisor tables scope isolation', () => {
  it('recommendations scope accountId even on an identical dedupe_key', () => {
    const t = advisorSchema.advisorRecommendations;
    const key = 'SUPPRESS_PATH|501|src/**|rolling_30';
    const a = db.select().from(t).where(and(eq(t.accountId, 1), eq(t.dedupeKey, key))).all();
    const b = db.select().from(t).where(and(eq(t.accountId, 2), eq(t.dedupeKey, key))).all();
    expect(a).toHaveLength(1);
    expect(a[0].status).toBe('pr_opened');
    expect(b).toHaveLength(1);
    expect(b[0].status).toBe('dismissed');
  });

  it('profiles scope accountId even on the same bot user', () => {
    const t = advisorSchema.advisorBotProfiles;
    const a = db.select().from(t).where(and(eq(t.accountId, 1), eq(t.botUserId, 501))).all();
    const b = db.select().from(t).where(and(eq(t.accountId, 2), eq(t.botUserId, 501))).all();
    expect(a).toHaveLength(1);
    expect(a[0].ownerRepo).toBe('acme/bots');
    expect(b).toHaveLength(1);
    expect(b[0].ownerRepo).toBe('other/bots');
  });

  it('config-event anchors scope accountId even on the same bot user', () => {
    const t = advisorSchema.advisorConfigEvents;
    const a = db.select().from(t).where(and(eq(t.accountId, 1), eq(t.botUserId, 501))).all();
    expect(a).toHaveLength(1);
    expect(a[0].description).toBe('A tuned');
  });

  it('MUTATION CHECK: without the accountId predicate, both accounts leak into one read', () => {
    // The seeds share every logical key across accounts on purpose — if these ever return one
    // row, the seed went vacuous and the three assertions above stop proving anything.
    const rec = advisorSchema.advisorRecommendations;
    const unscoped = db
      .select()
      .from(rec)
      .where(eq(rec.dedupeKey, 'SUPPRESS_PATH|501|src/**|rolling_30'))
      .all();
    expect(unscoped).toHaveLength(2);
    expect(unscoped.map((r: { accountId: number }) => r.accountId).sort()).toEqual([1, 2]);
    const prof = advisorSchema.advisorBotProfiles;
    expect(db.select().from(prof).where(eq(prof.botUserId, 501)).all()).toHaveLength(2);
    const evt = advisorSchema.advisorConfigEvents;
    expect(db.select().from(evt).where(eq(evt.botUserId, 501)).all()).toHaveLength(2);
  });
});

describe('ai_pr_analyses isolation', () => {
  it('a summary read scopes accountId even on a shared prId', () => {
    const t = aiFixSchema.aiPrAnalyses;
    const a = db
      .select()
      .from(t)
      .where(and(eq(t.accountId, 1), eq(t.prId, 100), eq(t.kind, 'summary')))
      .all();
    const b = db
      .select()
      .from(t)
      .where(and(eq(t.accountId, 2), eq(t.prId, 100), eq(t.kind, 'summary')))
      .all();
    expect(a).toHaveLength(1);
    expect(a[0].summary).toBe('A analysis');
    expect(b).toHaveLength(1);
    expect(b[0].summary).toBe('B analysis');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// PLUGIN MIGRATION 0020 — the teams→workspaces re-key of every persisted scope_key, plus the
// legacy per-bot price absorbed from the (now no-op) 0019.
//
// WHY THIS LIVES IN THE ISOLATION SUITE. Both halves are cross-account writes over data the user
// paid for or typed: Part B moves rows between scope keys and Part A writes a price onto a bot
// row. A mis-scoped predicate in either is exactly the leak the rest of this file exists to catch,
// and the migration is the one code path that touches every account's rows at once.
//
// It gets its OWN database because 0020 DELETEs the four report tables wholesale: seeding legacy
// rows into the fixture above would have to happen before the migrations run, and the isolation
// seeds would then be indistinguishable from migration output.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

// Accounts used only by this suite (a separate Database, so they cannot collide with the above).
const M_A = 1; //  three workspaces, a legacy cost blob.
const M_B = 2; //  one Default, no blob — the account-scoping control for both halves.
const M_NO_DEFAULT = 3; //  no Default workspace at all — the EXISTS-guard control.
const M_BAD_BLOB = 4; //  a corrupt `bot_cost_json` — must degrade, never raise.

const M_WS_A1 = 5; //  account 1, successor of legacy team 5.
const M_WS_A2 = 6; //  account 1, a second non-default workspace.
const M_WS_A_DEFAULT = 7;
const M_WS_B_DEFAULT = 9;
const M_WS_BAD_DEFAULT = 12;

const CODERABBIT_USER = 42;
const GREPTILE_USER = 43;
const NUMERIC_LOGIN_USER = 44; //  a user literally named "123" — see the login_type layer below.

let mSqlite: Database.Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mDb: any;
let mCtx: ProContext;

/** Every scope key still present in the two re-keyed tables, as `${table}:${account}:${key}`. */
// The removed chat's history reader (`listSprintChatHistory`) is gone with its route; the table is
// DORMANT but still re-keyed by migration 0020, so the join it relied on is asserted directly.
async function listSprintChatHistory(
  _ctx: unknown,
  accountId: number,
  scopeKey: string,
  _limit: number,
  _offset: number,
): Promise<{ total: number; items: Array<{ question: string }> }> {
  const items = mSqlite
    .prepare(
      'SELECT question FROM sprint_chat_history WHERE account_id = ? AND scope_key = ? ORDER BY id DESC',
    )
    .all(accountId, scopeKey) as Array<{ question: string }>;
  return { total: items.length, items };
}

function scopeKeyRows(table: 'pinned_prompts' | 'sprint_chat_history'): string[] {
  return (
    mSqlite
      .prepare(`SELECT account_id, scope_key FROM ${table} ORDER BY id`)
      .all() as Array<{ account_id: number; scope_key: string }>
  ).map((r) => `${r.account_id}:${r.scope_key}`);
}

beforeAll(() => {
  mSqlite = new Database(':memory:');
  mSqlite.exec(CORE_STUB_DDL);
  mSqlite.exec(`
    INSERT INTO workspaces (id, account_id, name, is_default) VALUES
      (${M_WS_A1}, ${M_A}, 'Platform', 0),
      (${M_WS_A2}, ${M_A}, 'Infra', 0),
      (${M_WS_A_DEFAULT}, ${M_A}, 'Default', 1),
      (${M_WS_B_DEFAULT}, ${M_B}, 'Default', 1),
      (${M_WS_BAD_DEFAULT}, ${M_BAD_BLOB}, 'Default', 1);
    INSERT INTO users (id, github_login) VALUES
      (${CODERABBIT_USER}, 'coderabbitai'),
      (${GREPTILE_USER}, 'greptileai'),
      (${NUMERIC_LOGIN_USER}, '123');
  `);
  // ⚠ M_NO_DEFAULT deliberately gets NO workspace row. Core 0044 guarantees every account one, so
  // this state is unreachable in production — which is precisely why 0020's `EXISTS (… is_default
  // …)` guard looks like decoration and is not: without it the COALESCE yields NULL, `'ws:' ||
  // NULL` is NULL, `scope_key` is NOT NULL, and the statement RAISES. A raise in a plugin
  // migration is not a local failure — pro/migrate.ts rethrows and bind.ts degrades the ENTIRE
  // plugin to OSS mode, silently.

  const files = pluginMigrationFiles();
  const twenty = '0020_workspace_scope_keys.sql';
  expect(files).toContain(twenty); //  a rename must not silently skip the whole suite below.

  for (const file of files) {
    if (file === twenty) seedLegacyRows();
    mSqlite.exec(readMigration(file));
  }

  mDb = drizzle(mSqlite, { schema: { ...insightsSchema } });
  mCtx = { db: mDb } as unknown as ProContext;
});

afterAll(() => {
  mSqlite.close();
});

/** The pre-workspace world, written just before 0020 runs — every legacy scope-key form. */
function seedLegacyRows(): void {
  // PART B inputs. The legacy vocabulary was: a bare team id, 'none', 'all', 'teams', 'teams:…'.
  const legacy: Array<[number, string]> = [
    [M_A, '5'], //  the exact successor: workspace 5 exists for account 1 → ws:5
    [M_A, 'all'], //  no single image → the Default
    [M_A, 'none'], //  those repos genuinely land in Default under core 0044 step 4
    [M_A, 'teams:1,2'], //  no single image → the Default
    [M_A, '99'], //  a DELETED team — no workspace 99 → the Default
    [M_B, '5'], //  ⚠ workspace 5 belongs to account 1. Must land on account 2's OWN Default.
    [M_B, 'all'],
    [M_NO_DEFAULT, 'all'], //  no Default workspace → left alone rather than raising
  ];
  const pinned = mSqlite.prepare(
    'INSERT INTO pinned_prompts (account_id, scope_key, text, want_chart, want_bots) VALUES (?, ?, ?, 0, 0)',
  );
  const chat = mSqlite.prepare(
    'INSERT INTO sprint_chat_history (account_id, scope_key, question, answer) VALUES (?, ?, ?, ?)',
  );
  for (const [account, key] of legacy) {
    pinned.run(account, key, `prompt ${account}/${key}`);
    chat.run(account, key, `question ${account}/${key}`, `answer ${account}/${key}`);
  }

  // The four REGENERABLE report caches — deleted wholesale, because serving one computed over a
  // predecessor team's repo set as the answer for a workspace is the exact failure the `ws:`
  // prefix exists to prevent.
  mSqlite
    .prepare(
      'INSERT INTO sprint_reports (account_id, scope_key, insights_hash, model, summary) VALUES (?, ?, ?, ?, ?)',
    )
    .run(M_A, '5', 'h', 'm', 'stale sprint');
  mSqlite
    .prepare(
      'INSERT INTO preset_reports (account_id, scope_key, preset_key, markdown, payload_hash, model) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(M_A, 'all', 'attention_now', 'stale preset', 'h', 'm');
  mSqlite
    .prepare(
      'INSERT INTO bot_theme_reports (account_id, scope_key, window_kind, payload_hash, result_json, model) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(M_A, 'all', 'rolling_14', 'h', '{"narrative":"stale bots"}', 'm');
  mSqlite
    .prepare(
      'INSERT INTO human_theme_reports (account_id, scope_key, window_kind, payload_hash, result_json, model) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(M_A, 'all', 'rolling_14', 'h', '{"narrative":"stale humans"}', 'm');

  // PART A inputs — the legacy per-login price blob + the bot rows it can attach to.
  //
  // The blob exercises all four malformed-JSON layers 0019 specified and 0020 inherited:
  //   a scalar element (nothing may json_extract from it), a kind-keyed entry (a kind names a
  //   BRAND, not an actor — unmigratable), a non-TEXT login (which would otherwise match the user
  //   literally named "123"), and a non-numeric monthlyUsd (coercing it to 0 would tell the user
  //   their $12 bot is free).
  mSqlite
    .prepare('INSERT INTO pro_settings (account_id, bot_cost_json) VALUES (?, ?)')
    .run(
      M_A,
      JSON.stringify([
        { login: 'coderabbitai', monthlyUsd: 30 },
        'not-an-object',
        { kind: 'copilot', monthlyUsd: 19 },
        { login: 123, monthlyUsd: 5 },
        { login: 'greptileai', monthlyUsd: 'twelve' },
      ]),
    );
  // A blob that is not JSON at all. `json_each` RAISES on such an argument, so the nested-CASE
  // guard is what keeps this account (and therefore the whole plugin) alive.
  mSqlite
    .prepare('INSERT INTO pro_settings (account_id, bot_cost_json) VALUES (?, ?)')
    .run(M_BAD_BLOB, '[oops');

  const reviewer = mSqlite.prepare(
    `INSERT INTO workspace_reviewers
       (account_id, workspace_id, author_user_id, automated, confidence, source, monthly_cents)
     VALUES (?, ?, ?, 1, 'high', 'auto', ?)`,
  );
  reviewer.run(M_A, M_WS_A1, CODERABBIT_USER, null); //  → 3000
  reviewer.run(M_A, M_WS_A2, CODERABBIT_USER, null); //  → 3000 (the seed applies to EVERY row)
  reviewer.run(M_A, M_WS_A_DEFAULT, CODERABBIT_USER, 0); //  a deliberate 0 — must survive
  reviewer.run(M_A, M_WS_A1, GREPTILE_USER, null); //  monthlyUsd 'twelve' → dropped, stays NULL
  reviewer.run(M_A, M_WS_A1, NUMERIC_LOGIN_USER, null); //  login 123 is not TEXT → stays NULL
  reviewer.run(M_B, M_WS_B_DEFAULT, CODERABBIT_USER, null); //  another account's blob → stays NULL
  reviewer.run(M_BAD_BLOB, M_WS_BAD_DEFAULT, CODERABBIT_USER, null); //  corrupt blob → stays NULL
}

describe('plugin migration 0019 — the legal no-op', () => {
  it('does not leave a second, differently-keyed answer to "is this login a bot"', () => {
    // 0019 STUBS repo_reviewers/account_reviewers so its statement is legal on a database where
    // core 0045 already dropped them, then DROPS the stubs. An empty `repo_reviewers` sitting
    // next to the live `workspace_reviewers` is exactly the shape core 0042 dropped
    // `bot_review_classification` to avoid.
    const left = mSqlite
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name IN ('repo_reviewers', 'account_reviewers')`,
      )
      .all();
    expect(left).toEqual([]);
  });

  it('the whole plugin migration sequence replays from empty without raising', () => {
    // The beforeAll above IS the assertion — a raise anywhere in the discovered list fails the
    // hook. Stated as a test so the guarantee is named: pro/migrate.ts rethrows and bind.ts turns
    // any failure here into `pro register() failed — OSS mode`, i.e. every capability false and
    // every /api/pro/* 404, with nothing thrown that a user would connect to a migration.
    expect(pluginMigrationFiles().length).toBeGreaterThan(0);
    expect(
      mSqlite.prepare('SELECT count(*) AS n FROM pinned_prompts').get(),
    ).toEqual({ n: 8 });
  });
});

describe('plugin migration 0020 Part B — scope keys become ws:<workspaceId>', () => {
  it('re-keys a bare team id to its EXACT successor workspace', () => {
    // Core 0044 preserves the team ids precisely so cache rows can follow them. Sending them all
    // to Default would throw that mapping away.
    expect(scopeKeyRows('pinned_prompts')).toContain(`${M_A}:${scopeKeyFor(M_WS_A1)}`);
    expect(scopeKeyRows('sprint_chat_history')).toContain(`${M_A}:${scopeKeyFor(M_WS_A1)}`);
  });

  it('collapses every key with no single image onto the account Default', () => {
    // 'all' / 'none' / 'teams:…' / a deleted team's id — four legacy rows, one destination.
    const dflt = `${M_A}:${scopeKeyFor(M_WS_A_DEFAULT)}`;
    expect(scopeKeyRows('pinned_prompts').filter((k) => k === dflt)).toHaveLength(4);
    expect(scopeKeyRows('sprint_chat_history').filter((k) => k === dflt)).toHaveLength(4);
  });

  it('never re-keys one account onto ANOTHER account\'s workspace', () => {
    // Account 2 also had a legacy `'5'`, but workspace 5 belongs to account 1. The subquery's
    // `w.account_id = <table>.account_id` predicate is the only thing stopping account 2's
    // transcript from being filed under account 1's workspace — where account 2 could never see
    // it again and account 1 could.
    expect(scopeKeyRows('pinned_prompts')).toContain(`${M_B}:${scopeKeyFor(M_WS_B_DEFAULT)}`);
    expect(scopeKeyRows('pinned_prompts')).not.toContain(`${M_B}:${scopeKeyFor(M_WS_A1)}`);
    expect(scopeKeyRows('sprint_chat_history')).not.toContain(`${M_B}:${scopeKeyFor(M_WS_A1)}`);
    // Account 1's own ws:5 row is still there, so the assertion above is a scoping result and not
    // an artefact of the re-key having failed for everyone.
    expect(scopeKeyRows('sprint_chat_history')).toContain(`${M_A}:${scopeKeyFor(M_WS_A1)}`);
  });

  it('leaves a row alone when its account has no Default workspace, instead of raising', () => {
    // The `EXISTS` guard. `scope_key` is NOT NULL, so without it this row is a raise — and a raise
    // costs the user every Pro feature.
    expect(scopeKeyRows('pinned_prompts')).toContain(`${M_NO_DEFAULT}:all`);
    expect(scopeKeyRows('sprint_chat_history')).toContain(`${M_NO_DEFAULT}:all`);
  });

  it('leaves NO orphan: every re-keyed row names a workspace its own account owns', () => {
    // The whole point of the migration. A row whose scope_key no `scopeKeyFor(w.id)` can produce
    // is invisible to every reader forever — silent, and for the report tables it would also cost
    // real money in regeneration.
    const owned = new Set(
      (
        mSqlite.prepare('SELECT id, account_id FROM workspaces').all() as Array<{
          id: number;
          account_id: number;
        }>
      ).map((w) => `${w.account_id}:${scopeKeyFor(w.id)}`),
    );
    for (const table of ['pinned_prompts', 'sprint_chat_history'] as const) {
      for (const row of scopeKeyRows(table)) {
        // The one documented exception: an account with no Default keeps its legacy key.
        if (row === `${M_NO_DEFAULT}:all`) continue;
        expect(owned.has(row)).toBe(true);
      }
    }
  });

  it('THE POINT OF THE PREFIX: a re-keyed row is still found by the RUNTIME key builder', async () => {
    // A purge (or a re-key) that leaves rows the running code can never look up again is silent
    // and, for the caches, costs real money in regeneration. So assert the join directly: the key
    // `scopeKeyFor(workspaceId)` produces at request time must select the row migration 0020
    // wrote. `listSprintChatHistory` (above) mirrors the removed reader's predicate.
    const successor = await listSprintChatHistory(mCtx, M_A, scopeKeyFor(M_WS_A1), 10, 0);
    expect(successor.total).toBe(1);
    expect(successor.items[0]!.question).toBe(`question ${M_A}/5`);

    // The four collapsed rows are reachable at the Default workspace's key.
    const dflt = await listSprintChatHistory(mCtx, M_A, scopeKeyFor(M_WS_A_DEFAULT), 10, 0);
    expect(dflt.total).toBe(4);

    // Account 2's re-homed row answers at ITS Default and nowhere else.
    expect((await listSprintChatHistory(mCtx, M_B, scopeKeyFor(M_WS_B_DEFAULT), 10, 0)).total).toBe(2);
    expect((await listSprintChatHistory(mCtx, M_B, scopeKeyFor(M_WS_A1), 10, 0)).total).toBe(0);

    // And the legacy vocabulary now selects NOTHING — the migration was not a no-op.
    expect((await listSprintChatHistory(mCtx, M_A, '5', 10, 0)).total).toBe(0);
    expect((await listSprintChatHistory(mCtx, M_A, 'all', 10, 0)).total).toBe(0);

    // The pinned-prompt route reads with the identical (accountId, scopeKeyFor(ws)) predicate.
    const t = insightsSchema.pinnedPrompts;
    const pinned = mDb
      .select()
      .from(t)
      .where(and(eq(t.accountId, M_A), eq(t.scopeKey, scopeKeyFor(M_WS_A1))))
      .all();
    expect(pinned).toHaveLength(1);
    expect(pinned[0].text).toBe(`prompt ${M_A}/5`);
  });

  it('is IDEMPOTENT — a replay re-keys nothing a second time', () => {
    const before = scopeKeyRows('sprint_chat_history');
    mSqlite.exec(readMigration('0020_workspace_scope_keys.sql'));
    expect(scopeKeyRows('sprint_chat_history')).toEqual(before);
    // `NOT LIKE 'ws:%'` is what makes that true, and it is also what makes the ordering guarantee
    // in 0020's header work: Part B is already committed if Part A ever raises, so a retry on the
    // next boot is a no-op for the half that matters.
  });

  it('DELETES the four regenerable report caches rather than re-keying them', () => {
    for (const t of ['sprint_reports', 'preset_reports', 'bot_theme_reports', 'human_theme_reports']) {
      expect(mSqlite.prepare(`SELECT count(*) AS n FROM ${t}`).get()).toEqual({ n: 0 });
    }
  });
});

describe('plugin migration 0020 Part A — the legacy per-bot price', () => {
  /** monthly_cents for one (account, workspace, actor). */
  function cents(account: number, workspace: number, user: number): number | null {
    const row = mSqlite
      .prepare(
        `SELECT monthly_cents AS c FROM workspace_reviewers
          WHERE account_id = ? AND workspace_id = ? AND author_user_id = ?`,
      )
      .get(account, workspace, user) as { c: number | null } | undefined;
    return row ? row.c : null;
  }

  it('seeds the account-wide legacy price onto EVERY workspace row of that actor', () => {
    // A ONE-TIME SEED of a value that used to be account-wide — not an invariant. From here on
    // price is per workspace: setReviewerCost writes ONE row and the copies diverge freely.
    expect(cents(M_A, M_WS_A1, CODERABBIT_USER)).toBe(3000);
    expect(cents(M_A, M_WS_A2, CODERABBIT_USER)).toBe(3000);
  });

  it('never clobbers a deliberate 0 — NULL means "no price", 0 means "recorded as free"', () => {
    expect(cents(M_A, M_WS_A_DEFAULT, CODERABBIT_USER)).toBe(0);
  });

  it('is account-scoped: one account\'s blob cannot price another account\'s bot row', () => {
    // The same actor, the same vendor, a different tenant. `p.account_id =
    // workspace_reviewers.account_id` is the whole guarantee.
    expect(cents(M_B, M_WS_B_DEFAULT, CODERABBIT_USER)).toBeNull();
  });

  it('drops a non-numeric monthlyUsd rather than coercing it to free', () => {
    expect(cents(M_A, M_WS_A1, GREPTILE_USER)).toBeNull();
  });

  it('drops a non-TEXT login rather than matching a user literally named "123"', () => {
    // `lower(123)` is the string '123' in SQLite, so without the `login_type = 'text'` filter this
    // entry matches a real user — and the pg twin, which tests `jsonb_typeof(...) = 'string'`,
    // would not. Same blob, two answers.
    expect(cents(M_A, M_WS_A1, NUMERIC_LOGIN_USER)).toBeNull();
  });

  it('degrades a corrupt blob to no-price instead of raising', () => {
    // `json_each('[oops')` RAISES. The nested-CASE guard (not `json_valid(x) AND json_type(x) =
    // 'array'`, since SQLite may evaluate both sides of an AND) is what keeps the plugin alive.
    expect(cents(M_BAD_BLOB, M_WS_BAD_DEFAULT, CODERABBIT_USER)).toBeNull();
  });

  it('UPDATEs only — it never fabricates a workspace_reviewers row to hang a price on', () => {
    // A fabricated row would invent automated/confidence/source judgements nobody made, and a
    // fabricated `source = 'manual'` would permanently shadow auto-detection for that actor.
    // Seven rows went in; seven come out.
    expect(mSqlite.prepare('SELECT count(*) AS n FROM workspace_reviewers').get()).toEqual({ n: 7 });
    // …and the kind-keyed legacy entry ({kind:'copilot'}) created nothing: a kind names a BRAND,
    // not an actor, so there is no author_user_id to key on.
    expect(
      mSqlite.prepare("SELECT count(*) AS n FROM users WHERE github_login = 'copilot'").get(),
    ).toEqual({ n: 0 });
  });
});
