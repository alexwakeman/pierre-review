-- @pierre/pro plugin migration (SQLite / local mode). Run once by the host's runPluginMigrations
-- (tracked in pro_migrations — plugin migrations are discovered by FILENAME SORT and have NO
-- meta/_journal.json; that requirement is CORE-only). Carries no statement-breakpoint markers
-- either: the plugin migrator execs the whole file as one blob. Postgres twin:
-- migrations-pg/0027_synthesis.sql.
--
-- THE ONE synthesis cache (plan P2.1 / D3): C3's drill-down verdicts and C6's workspace bot
-- synthesis are the same capability at different grains — a deterministically-assembled item set,
-- one credit-metered Haiku pass that GROUPS it, and a card whose every number is computed
-- server-side from the validated grouping (D4). One table, not one per feature.
--
-- One row per (account, scope). `scope_key` is the CANONICAL serialised scope descriptor
-- (src/synthesis/scope.ts `synthesisScopeKey` — kind + ws:<id> + window + the drill-down's own
-- narrowing, fixed slot order, absent slots as '-'), so the same drill-down always lands on the
-- same row and a regenerate OVERWRITES rather than accretes. `kind` is also embedded in the key;
-- the standalone column exists so reads/erasure/ops can filter without parsing the key.
--
-- `payload_hash` is the $0-on-unchanged gate (src/synthesis/hash.ts): sha256 over the SORTED
-- input item ids + each item's stable created-at + the analyzed/total counts +
-- SYNTHESIS_SCHEMA_VERSION + SYNTHESIS_PROMPT_VERSION + the scope key. NOTHING Date.now-derived
-- and nothing hydrated — the free GET recomputes it from getSynthesisInput alone to report
-- `stale`, and a version-const bump moves every stored hash at once (the self-executing
-- invalidation the period vector uses).
--
-- `output` is the VALIDATED structure (clusters with server-verified itemIds ⊆ input +
-- server-computed counts, plus the recomputed remainder) as JSON TEXT — TEXT in BOTH dialects,
-- never jsonb, never drizzle mode:'json', so the twins stay structurally identical and one
-- serializer owns the blob (the workspace_period_reports rule). `input_count` (the drill-down's
-- own total at generation time) and `analyzed_count` (what the model actually saw, post-cap) are
-- REAL COLUMNS rather than facts buried in the blob because the coverage line "Summarised X of Y"
-- is the disclosure that keeps a capped synthesis honest — it must survive any output-shape drift.
--
-- No cost columns: spend goes to the shared ai_usage ledger via ctx.recordAiUsage (feature
-- 'synthesis'), the same place every other summary feature records it.
--
-- NO FOREIGN KEY onto core's `workspaces` (the workspace id is only ever resolver-produced — a
-- foreign id degrades to the caller's Default and never travels) and no FK onto PRs: the row is a
-- REGENERABLE scope-keyed cache, the bot_theme_reports family, not a keyed history. It is listed
-- in retention.ts's eraseProByAccountId (account erasure takes everything) and deliberately NOT
-- in pruneProByPrIds — there is no pr_id grain to prune by; staleness, not deletion, is how it
-- ages (the payload hash moves as the underlying items churn).

CREATE TABLE IF NOT EXISTS pro_synthesis (
  id integer PRIMARY KEY AUTOINCREMENT,
  account_id integer NOT NULL,
  scope_key text NOT NULL,
  kind text NOT NULL,
  payload_hash text NOT NULL,
  output text NOT NULL,
  model text NOT NULL,
  input_count integer NOT NULL,
  analyzed_count integer NOT NULL,
  generated_at integer NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS pro_synthesis_account_scope
  ON pro_synthesis (account_id, scope_key);
