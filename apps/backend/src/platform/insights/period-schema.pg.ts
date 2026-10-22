// Plugin-owned Postgres schema (cloud mode) — the structural twin of `period-schema.sqlite.ts`
// (SAME table + column names, SAME nullability), pg-core types. Every column comment lives in the
// sqlite twin; only the differences that are NOT mechanical are repeated here.
//
// ⚠ There is NO schema-parity test in this package (core's cannot see plugin tables) — the two
// files are kept in step BY EYE. The mechanical mapping is: `integer(...).primaryKey({autoIncrement})`
// → `serial`, `integer(..., {mode:'timestamp'})` → `timestamp(..., {withTimezone:true, mode:'date'})`,
// `real` → `doublePrecision`, `default(sql\`(unixepoch())\`)` → `defaultNow()`. JSON stays TEXT in
// BOTH dialects — never jsonb, never drizzle `mode:'json'`.
import {
  doublePrecision,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// ONE stored report per (account, workspace, period, MODEL). `model` is part of the identity so a
// Sonnet run cannot destroy the Haiku row; a backfilled row stores '' and NEVER null, because a
// NULL does not collide in a unique index here either — Postgres treats NULLs as distinct in a
// unique index exactly as SQLite does, so the backfill would duplicate without bound.
export const workspacePeriodReports = pgTable(
  'workspace_period_reports',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id').notNull(),
    workspaceId: integer('workspace_id').notNull(),
    periodKey: text('period_key').notNull(),
    periodStart: timestamp('period_start', { withTimezone: true, mode: 'date' }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true, mode: 'date' }).notNull(),
    grain: text('grain').notNull().default('sprint'),
    cadenceDays: integer('cadence_days').notNull(),
    repoIdsJson: text('repo_ids_json').notNull(),
    coverageJson: text('coverage_json').notNull(),
    metricsJson: text('metrics_json').notNull(),
    metricsSchemaVersion: integer('metrics_schema_version').notNull(),
    comparisonJson: text('comparison_json'),
    forecastJson: text('forecast_json'),
    // Effort vs automation (plugin migration 0026). Nullable + additive: a row written before
    // the breakdown existed carries none, which renders as an absent panel, never as 0% automation.
    lanesJson: text('lanes_json'),
    movementsJson: text('movements_json'),
    suggestedJson: text('suggested_json'),
    narrativeMd: text('narrative_md'),
    model: text('model').default(''),
    payloadHash: text('payload_hash').notNull(),
    dataFingerprint: text('data_fingerprint').notNull(),
    creditsSpent: doublePrecision('credits_spent'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    generatedAt: timestamp('generated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    accountWsPeriodModelCadenceUx: uniqueIndex('wpr_account_ws_period_model_cadence').on(
      t.accountId,
      t.workspaceId,
      t.periodKey,
      t.model,
      // ⚠ `cadenceDays` JOINED THE IDENTITY in plugin migration 0029. Without it a cadence change
      // (14 → 7) whose new period start day collides with an old one made the upsert OVERWRITE the
      // stored artifact in place — a different window's numbers under the same name, in a document
      // somebody had already forwarded. With it the two coexist: the new-cadence row generates
      // fresh and the old one stays readable at its archived key.
      t.cadenceDays,
    ),
  }),
);
