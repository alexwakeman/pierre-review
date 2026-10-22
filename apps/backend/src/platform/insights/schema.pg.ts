// Plugin-owned Postgres schema (cloud mode) — the structural twin of
// `schema.sqlite.ts` (SAME table + column names, SAME nullability), pg-core types.
//
// `scope_key` on all four tables holds `ws:<workspaceId>` after the workspace refactor — the
// column NAME is unchanged, only the value vocabulary. The `.default('all')` is a harmless legal
// string nothing writes any more; see the long note in schema.sqlite.ts for why the prefix exists
// and which of these tables plugin migration 0020 deletes vs re-keys.
import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const sprintReports = pgTable(
  'sprint_reports',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id').notNull(),
    scopeKey: text('scope_key').notNull().default('all'),
    insightsHash: text('insights_hash').notNull(),
    model: text('model').notNull(),
    summary: text('summary').notNull(),
    costUsd: doublePrecision('cost_usd'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    sprintFrom: timestamp('sprint_from', { withTimezone: true, mode: 'date' }),
    sprintTo: timestamp('sprint_to', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    accountScopeUx: uniqueIndex('sr_account_scope').on(t.accountId, t.scopeKey),
  }),
);

// REMOVED: `retroReports` — dropped by plugin migration 0018 in both dialects. See the twin
// note in schema.sqlite.ts for why it was dropped rather than orphaned.

export const pinnedPrompts = pgTable('pinned_prompts', {
  id: serial('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  scopeKey: text('scope_key').notNull().default('all'),
  text: text('text').notNull(),
  wantChart: boolean('want_chart').notNull().default(false),
  wantBots: boolean('want_bots').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});

// Structural twin of the SQLite sprint_chat_history (JSON stored as text in BOTH dialects).
export const sprintChatHistory = pgTable(
  'sprint_chat_history',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id').notNull(),
    scopeKey: text('scope_key').notNull().default('all'),
    question: text('question').notNull(),
    answer: text('answer').notNull(),
    chart: text('chart'),
    prRefs: text('pr_refs'),
    wantChart: boolean('want_chart').notNull().default(false),
    wantBots: boolean('want_bots').notNull().default(false),
    // Twin of schema.sqlite.ts — JSON-serialized InsightsAnswerWindow, NULL on pre-0023 rows.
    // Named `answer_window` because WINDOW is a reserved word here.
    answerWindow: text('answer_window'),
    model: text('model'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    accountCreatedIdx: index('sch_account_created').on(t.accountId, t.createdAt),
  }),
);

// ⚠ DORMANT: the preset prompts are REMOVED; nothing reads or writes `preset_reports`. It stays
// declared for erasure / retention / isolation. Never drop it.
export const presetReports = pgTable(
  'preset_reports',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id').notNull(),
    scopeKey: text('scope_key').notNull().default('all'),
    presetKey: text('preset_key').notNull(),
    markdown: text('markdown').notNull(),
    payloadHash: text('payload_hash').notNull(),
    model: text('model').notNull(),
    costUsd: doublePrecision('cost_usd'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    generatedAt: timestamp('generated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    accountScopeKeyUx: uniqueIndex('pr_account_scope_key').on(
      t.accountId,
      t.scopeKey,
      t.presetKey,
    ),
  }),
);
