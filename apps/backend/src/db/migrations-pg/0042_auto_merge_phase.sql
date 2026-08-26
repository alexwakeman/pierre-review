-- Auto-merge ("merge when ready") gets a machine-readable phase — the Postgres twin of sqlite
-- 0055_auto_merge_phase.sql. HAND-WRITTEN ADDITIVE, like every pg migration since 0023: never
-- regenerate the baseline with `pnpm db:generate:pg`, which squashes it.
--
-- See the sqlite twin for the full argument. In short: `last_reason` is prose for a human (and
-- is NULL at success), so the cross-PR progress surface needs a field it can switch on; the
-- watcher writes both in the same call, and terminal outcomes stay on `state`.
ALTER TABLE "auto_merge_requests" ADD COLUMN IF NOT EXISTS "phase" text;
