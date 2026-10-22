-- @pierre/pro plugin migration (SQLite / local mode). Discovered by FILENAME SORT, no journal, no
-- statement-breakpoint markers (the plugin migrator execs the file as one blob). Postgres twin:
-- migrations-pg/0034_flow_pointers.sql.
--
-- THE CHRONOLOGY POINTERS cache — the credit-metered Haiku pointers beside Reports → Chronology:
-- three to five short, digit-free sentences about the nature of the pull requests behind the
-- figures, each citing the PRs it rests on.
--
-- ⚠ THE EVIDENCE IS NOT STORED HERE. Core folds it fresh from the same pass the panel renders, and
-- the links a reader clicks are rebuilt from that live fold, so nothing in this row can put a PR
-- or a figure on screen by itself. `output` holds the model's prose and the cited ids only.
--
-- One row per (account, scope); `scope_key` is `ws:<workspaceId>|d:<windowDays>`. The unique index
-- makes a regenerate overwrite. `payload_hash` is the $0-on-unchanged gate (src/flow-pointers/
-- hash.ts) — per-PR figures computed from fixed timestamps, never anything derived from now().
--
-- No foreign keys (the pro_work_plans family): a regenerable scope-keyed cache, erased with the
-- account (retention.ts eraseProByAccountId), never pruned per PR.

CREATE TABLE IF NOT EXISTS pro_flow_pointers (
  id integer PRIMARY KEY AUTOINCREMENT,
  account_id integer NOT NULL,
  scope_key text NOT NULL,
  payload_hash text NOT NULL,
  output text NOT NULL,
  model text NOT NULL,
  pr_count integer NOT NULL,
  generated_at integer NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS pro_flow_pointers_account_scope
  ON pro_flow_pointers (account_id, scope_key);
