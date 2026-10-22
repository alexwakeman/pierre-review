// Plugin-owned SQLite schema (local mode) for period-over-period reporting — the stored,
// IMMUTABLE artifact behind the Insights → Reports sub-tab. Structural twin: `period-schema.pg.ts`
// (same table + column names, same nullability). Migrated by the host via ctx.registerMigrations
// (../../migrations/0025_period_reports.sql); this module is ONLY the typed query surface.
//
// ⚠ A NEW FILE RATHER THAN A FIFTH TABLE IN `schema.{sqlite,pg}.ts` ON PURPOSE. The four tables
// there are all `scope_key`-keyed regenerable caches that plugin migration 0020 DELETES wholesale;
// this one is a KEYED HISTORY that must survive every such sweep, and keeping the two families in
// separate files keeps that difference visible to whoever writes the next scope migration.
//
// ⚠ THIS PACKAGE HAS NO SCHEMA-PARITY TEST (core's cannot see plugin tables), so every edit here
// must be mirrored BY EYE into `period-schema.pg.ts`.
//
// Account-scoped ⇒ listed in retention.ts's `eraseProByAccountId` and seeded in
// test/isolation.test.ts. NOT PR-keyed ⇒ deliberately absent from `pruneProByPrIds`: outliving the
// per-PR TTL sweep is the entire point of the feature (see the note there).
//
// It imports NO shared types on purpose. The wire shapes (`PeriodReport`, `PeriodMetricValue`, …)
// live in @pierre-review/shared and describe the DECODED blobs; this module describes the columns,
// which are TEXT in both dialects. Keeping the two apart means one serializer owns each blob and a
// wire-type edit can never silently change what is on disk.
import { sql } from 'drizzle-orm';
import { integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// ONE stored report per (account, workspace, period, MODEL).
//
// ⚠ `model` IS PART OF THE IDENTITY, and the empty string is a REAL VALUE in it. A backfilled
// (un-narrated) row stores `''`, never NULL: NULL never compares equal to NULL in either dialect,
// so NULL-modelled rows do not collide in the unique index and a re-run of the 8-period backfill
// would insert a whole fresh set every time. The column is nullable because `PeriodReport.model`
// is `string | null` on the wire, and the migration carries `DEFAULT ''` so a writer that OMITS
// the column still lands on the colliding value — but nothing may write NULL into it.
//
// ⚠ Every `onConflictDoUpdate` on this table must target exactly
// [accountId, workspaceId, periodKey, model, cadenceDays] — `cadenceDays` JOINED the index in
// plugin migration 0029. A stale conflict target TYPE-CHECKS perfectly and
// raises "no unique or exclusion constraint matching the ON CONFLICT specification" at RUNTIME,
// in both dialects, only when a row is actually written (the 0042/0045 lesson).
export const workspacePeriodReports = sqliteTable(
  'workspace_period_reports',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id').notNull(),
    // Always an id the account owns — `resolveRequestScope` degrades a foreign/unknown
    // `?workspace=` to the account's Default rather than letting it travel. There is no FK onto
    // core's `workspaces` (see the migration's note): a CASCADE would destroy stored artifacts on
    // a scope reorganisation, which is precisely what core's `deleteWorkspace` re-homes to avoid.
    workspaceId: integer('workspace_id').notNull(),
    // 'sprint-<YYYY-MM-DD of the period start, UTC>' — sortable, deterministic, and safe in a URL
    // path segment (which is why it is not the `s:2026-08-18` form the plan sketched).
    periodKey: text('period_key').notNull(),
    periodStart: integer('period_start', { mode: 'timestamp' }).notNull(),
    periodEnd: integer('period_end', { mode: 'timestamp' }).notNull(),
    // Only 'sprint' exists today — the configured cadence IS the grain. Kept as a column rather
    // than assumed so a second grain does not need a migration to tell the two apart.
    grain: text('grain').notNull().default('sprint'),
    // Stored per row because a cadence change mid-history makes two periods incomparable: that
    // comparison is REFUSED ('cadence_changed'), never silently subtracted. ⚠ It is also PART OF
    // THE ROW IDENTITY (migration 0029): rows measured under a retired cadence stay in the table,
    // are filtered out of the list / the history / the detail, and remain readable at an explicit
    // archived key.
    cadenceDays: integer('cadence_days').notNull(),
    // JSON number[] — the workspace membership this period was actually computed over. Membership
    // drifts; the row records what it measured.
    repoIdsJson: text('repo_ids_json').notNull(),
    // JSON PeriodCoverage {trackedRepos, totalRepos, complete}. NOT derivable at read time and not
    // cosmetic: repo onboarding is the biggest source of fake "growth" in a retroactive series, so
    // the forecast only consumes periods whose coverage was complete for the stable subset.
    coverageJson: text('coverage_json').notNull(),
    // JSON PeriodMetricValue[] — all 12, in PERIOD_METRIC_KEYS order. A metric with no data stores
    // `null`, which is NOT 0 and must never render as 0.
    metricsJson: text('metrics_json').notNull(),
    // PERIOD_METRICS_SCHEMA_VERSION at generation time. A later addition bumps it; an older row
    // simply lacks that metric and must render "no prior", never 0.
    metricsSchemaVersion: integer('metrics_schema_version').notNull(),
    // The four derived blobs. All nullable: a backfilled row has metrics and coverage only.
    comparisonJson: text('comparison_json'),
    forecastJson: text('forecast_json'),
    // Effort vs automation (plugin migration 0026). Nullable + additive: a row written before
    // the breakdown existed carries none, which renders as an absent panel, never as 0% automation.
    lanesJson: text('lanes_json'),
    movementsJson: text('movements_json'),
    suggestedJson: text('suggested_json'),
    // The narration. NULL on a backfilled (un-narrated) period — and `model = ''` alongside it.
    narrativeMd: text('narrative_md'),
    model: text('model').default(''),
    // The generation cache key (folds in the metrics, comparison, forecast, cadence, repo id set,
    // schema version AND the model — and nothing `Date.now()`-derived, or a dormant workspace
    // re-bills on every click).
    payloadHash: text('payload_hash').notNull(),
    // The staleness probe: `getPeriodMetrics`'s fingerprint over the RAW counts. Recomputed on the
    // free GET; a difference sets `stale: true` on the response and offers regeneration. A stored
    // report is never silently regenerated — that would break comparability with the copy someone
    // has already forwarded. NOT NULL on every row including a backfilled one, since a NULL would
    // make "is this stale?" undecidable rather than false.
    dataFingerprint: text('data_fingerprint').notNull(),
    // Spend, for the after-the-fact readout beside the pre-flight estimate. NULL on a backfilled
    // row (no LLM call) — and note `recordAiUsage` drops any row with costUsd <= 0, so a cached
    // regeneration is invisible to the ledger by design.
    creditsSpent: real('credits_spent'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    generatedAt: integer('generated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
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
