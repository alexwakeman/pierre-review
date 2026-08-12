-- Auto-merge ("merge when ready") learns GitHub's native merge queue — the Postgres twin of
-- sqlite 0051_auto_merge_queue.sql. HAND-WRITTEN ADDITIVE, like every pg migration since
-- 0023: never regenerate the baseline with `pnpm db:generate:pg`, which squashes it.
--
-- See the sqlite twin for the full argument. In short: `via_merge_queue` (arm-time fact —
-- the watcher enqueues instead of direct-merging) + `enqueued_at` (the watcher's own
-- enqueue, the attribution record for 'merged' vs 'disarmed_blocked').
ALTER TABLE "auto_merge_requests" ADD COLUMN IF NOT EXISTS "via_merge_queue" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "auto_merge_requests" ADD COLUMN IF NOT EXISTS "enqueued_at" timestamp with time zone;
