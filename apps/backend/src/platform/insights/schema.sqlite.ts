// Plugin-owned SQLite schema (local mode) for the Insights "Sprint report" +
// per-workspace "Preset prompt" answers — Haiku summaries of the workspace-insights state.
// Structural twin: `schema.pg.ts` (same table + column names + nullability). Migrated by the host
// via ctx.registerMigrations (the .sql under ../migrations); this module is ONLY the typed query
// surface.
//
// ── `scope_key` ACROSS ALL FOUR TABLES BELOW ─────────────────────────────────────────────────
// The COLUMN NAME did not change with the workspace refactor (renaming it across six tables and
// two dialects buys nothing); the VALUE VOCABULARY did, to `ws:<workspaceId>` — built by exactly
// one function, `scopeKeyFor` in ./workspace-scope.ts. The `ws:` prefix is load-bearing: workspace
// ids ARE the old team ids (core 0044 preserves them), so a bare '3' would be indistinguishable
// from the legacy '3' that meant team 3, whose repo set is not necessarily workspace 3's — and a
// cached AI report computed over one repo set would silently be served as the answer for another.
// The prefix makes a legacy value simply unmatchable: the worst case is a cache miss.
//
// The `.default('all')` on each column is a HARMLESS LEGAL STRING and is deliberately left alone:
// plugin migration 0020 leaves no row using it (it DELETEs sprint_reports / preset_reports and
// re-keys pinned_prompts / sprint_chat_history by case), every writer supplies the value
// explicitly, and changing a column default is a migration nobody needs.
import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// One sprint report per (account, WORKSPACE), keyed by a structural hash of the Insights state at
// generation time (so the client can flag "Insights changed — regenerate"). Regenerable model
// output, so plugin 0020 DELETEs the legacy rows rather than re-keying them.
export const sprintReports = sqliteTable(
  'sprint_reports',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id').notNull(),
    scopeKey: text('scope_key').notNull().default('all'),
    insightsHash: text('insights_hash').notNull(),
    model: text('model').notNull(),
    summary: text('summary').notNull(),
    costUsd: real('cost_usd'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    sprintFrom: integer('sprint_from', { mode: 'timestamp' }),
    sprintTo: integer('sprint_to', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    accountScopeUx: uniqueIndex('sr_account_scope').on(t.accountId, t.scopeKey),
  }),
);

// REMOVED: `retroReports` / the `retro_reports` table (created by migration 0008, widened by
// 0010, DROPPED by 0018). The Insights "Retro" sub-tab is gone; the retrospective is now a
// quick-question pill on the grounded Insights chat, which answers from the shared chat payload
// and needs no cache table of its own.
//
// The table was dropped rather than orphaned on purpose. It carried `account_id`, so an orphan
// would have to stay in `eraseProByAccountId`'s list forever (an account-scoped table missing
// from that list is the GDPR landmine CLAUDE.md calls out) — which means keeping this drizzle
// definition alive purely so the erasure line compiles. That deletes the feature and keeps 100%
// of its schema surface. The rows themselves are regenerable Haiku output keyed by an inputs
// hash: no user-authored text, and the spend record lives separately on the `ai_usage` ledger.

// A saved, re-runnable ad-hoc "Ask about the sprint" prompt (Pro). Per (account, WORKSPACE) so one
// workspace's pins are distinct from another's. Stores the question text + the two toggles
// (graph / bot-performance) so re-running restores the exact request. `want_chart`/`want_bots`
// are 0/1 integers (sqlite has no boolean); the pg twin uses real booleans.
// USER-AUTHORED text → plugin 0020 RE-KEYS these rows by case, never deletes them.
export const pinnedPrompts = sqliteTable('pinned_prompts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  accountId: integer('account_id').notNull(),
  scopeKey: text('scope_key').notNull().default('all'),
  text: text('text').notNull(),
  wantChart: integer('want_chart', { mode: 'boolean' }).notNull().default(false),
  wantBots: integer('want_bots', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

// One stored past ad-hoc chat Q&A (Pro). Per account, ALL workspaces in one personal history (each
// row records its own `scopeKey`). Persists the full answer + serialized chart + PR refs so
// re-opening a past question in the History panel is free (no re-run). `chart`/`pr_refs` are
// JSON strings (nullable); `want_chart`/`want_bots` are 0/1 sqlite booleans. Indexed by
// (account_id, created_at) for the newest-first paginated listing.
// USER-AUTHORED transcript → plugin 0020 RE-KEYS these rows by case, never deletes them. A re-keyed
// transcript may reference PRs from a repo that has since moved workspaces; it is timestamped
// history, not a cached answer, which is exactly why the four report caches are deleted instead.
export const sprintChatHistory = sqliteTable(
  'sprint_chat_history',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id').notNull(),
    scopeKey: text('scope_key').notNull().default('all'),
    question: text('question').notNull(),
    answer: text('answer').notNull(),
    chart: text('chart'), // JSON-serialized SprintChatChartSpec | null
    prRefs: text('pr_refs'), // JSON-serialized DigestPrRef[]
    wantChart: integer('want_chart', { mode: 'boolean' }).notNull().default(false),
    wantBots: integer('want_bots', { mode: 'boolean' }).notNull().default(false),
    // JSON-serialized InsightsAnswerWindow — the range this answer covered. NULL on rows written
    // before the range picker (plugin 0023), and deliberately NOT backfilled: a past answer's
    // window is unknowable, and stamping the current default on it would be a made-up caption.
    // Column is `answer_window`, not `window` — WINDOW is a reserved word in Postgres.
    answerWindow: text('answer_window'),
    model: text('model'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    accountCreatedIdx: index('sch_account_created').on(t.accountId, t.createdAt),
  }),
);

// One cached preset-prompt answer per (account, WORKSPACE, presetKey) — a one-click "ask about
// this workspace" Markdown answer. Keyed by a payload hash so re-clicking an unchanged workspace
// is $0. Regenerable model output → plugin 0020 DELETEs the legacy rows.
// ⚠ DORMANT: the preset prompts are REMOVED; nothing reads or writes `preset_reports`. It stays
// declared for erasure / retention / isolation. Never drop it.
export const presetReports = sqliteTable(
  'preset_reports',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id').notNull(),
    scopeKey: text('scope_key').notNull().default('all'),
    presetKey: text('preset_key').notNull(),
    markdown: text('markdown').notNull(),
    payloadHash: text('payload_hash').notNull(),
    model: text('model').notNull(),
    costUsd: real('cost_usd'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    generatedAt: integer('generated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    accountScopeKeyUx: uniqueIndex('pr_account_scope_key').on(
      t.accountId,
      t.scopeKey,
      t.presetKey,
    ),
  }),
);
