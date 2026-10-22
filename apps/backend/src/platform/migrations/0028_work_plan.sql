-- @pierre/pro plugin migration (SQLite / local mode). Run once by the host's runPluginMigrations
-- (tracked in pro_migrations — plugin migrations are discovered by FILENAME SORT and have NO
-- meta/_journal.json; that requirement is CORE-only). Carries no statement-breakpoint markers
-- either: the plugin migrator execs the whole file as one blob. Postgres twin:
-- migrations-pg/0028_work_plan.sql.
--
-- THE WORK PLAN cache — the credit-metered Haiku narration of the Activity feed's prioritised
-- worklist ("what should I work on today", the panel under the daily-brief strip).
--
-- ⚠ THE WORKLIST ITSELF IS NOT STORED HERE, and that is the feature's safety property rather than
-- an optimisation. `getWorkPlan` (core, db/work-plan.ts) folds the ranked items fresh from the
-- SAME /api/attention cards the daily brief counts, so the panel and the strip above it are ONE
-- population by construction — a plan that contradicted the strip would be a defect in one fold,
-- not two opinions. What this table caches is only the part that costs money and cannot be
-- recomputed: the model's prose. `output` therefore contains no figure, id, link or rank; the
-- stored steps join back to the live evidence by WorkPlanItem.id
-- (`wp:<kind>:<prId|repoId[:threadId]>` — namespaced, stable across ticks, deliberately time-free
-- so it survives as a join key), and a step naming an id the fold no longer produces simply
-- renders nothing. Nothing in this row can put an item, or a number, on the board by itself.
--
-- One row per (account, scope). `scope_key` is `ws:<workspaceId>` plus a `|r:<sorted csv>` tail
-- ONLY when the request narrowed below the workspace's full membership — absent slots stay absent
-- rather than being spelled, so the unnarrowed workspace and a narrowing that happens to cover
-- every repo cannot mint two rows for one plan. The unique index below is what makes a regenerate
-- OVERWRITE rather than accrete.
--
-- `payload_hash` is the $0-on-unchanged gate (src/work-plan/hash.ts), computed over the evidence's
-- stable code-derived shape. ⚠ TWO FIELDS OF WorkPlanEvidence MUST NEVER ENTER IT:
-- `generatedAt` (an ISO stamp of the fold itself) and every `facts.ageHours` (derived from `now`).
-- Either one moves on a timer and re-bills a dormant workspace on every poll. The exposure here is
-- worse than usual because the FREE GET recomputes the hash from a fresh fold in order to report
-- `stale` — so a clock-derived field makes the GET and the POST disagree forever: every plan
-- permanently stale, re-billed on every click.
--
-- `output` is the validated StoredWorkPlan as JSON TEXT — TEXT in BOTH dialects, never jsonb,
-- never drizzle mode:'json', so the twins stay structurally identical and one serializer owns the
-- blob (the workspace_period_reports rule). `item_count` is a REAL COLUMN, not a fact buried in
-- the blob, for the reason pro_synthesis stores its coverage counts: the panel discloses
-- "narrated N of M", and that disclosure is what keeps a capped list honest — it must survive any
-- output-shape drift. It counts the items the plan was generated AGAINST (the capped evidence
-- list, WORK_PLAN_ITEM_CAP), not the steps the model chose to write.
--
-- No cost columns: spend goes to the shared ai_usage ledger via ctx.recordAiUsage, the same place
-- every other summary feature records it.
--
-- NO FOREIGN KEY onto core's `workspaces` (the workspace id is only ever resolver-produced — a
-- foreign id degrades to an empty repo set and never travels) and none onto PRs: the row is a
-- REGENERABLE scope-keyed cache, the pro_synthesis / bot_theme_reports family, not a keyed
-- history. It is listed in retention.ts's eraseProByAccountId (account erasure takes everything)
-- and deliberately NOT in pruneProByPrIds — the row spans a whole workspace, so there is no pr_id
-- grain to prune by, and staleness (the payload hash moves as the worklist churns), not deletion,
-- is how it ages.

CREATE TABLE IF NOT EXISTS pro_work_plans (
  id integer PRIMARY KEY AUTOINCREMENT,
  account_id integer NOT NULL,
  scope_key text NOT NULL,
  payload_hash text NOT NULL,
  output text NOT NULL,
  model text NOT NULL,
  item_count integer NOT NULL,
  generated_at integer NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS pro_work_plans_account_scope
  ON pro_work_plans (account_id, scope_key);
