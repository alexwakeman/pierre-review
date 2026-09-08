-- GitHub's native merge queue as a SYNCED, STORED fact — the Postgres twin of sqlite
-- 0059_merge_queue_state.sql. HAND-WRITTEN ADDITIVE, like every pg migration since 0023: never
-- regenerate the baseline with `pnpm db:generate:pg`, which squashes it.
--
-- Read the sqlite twin for the full argument. The two things that will otherwise be re-litigated:
--   • it is stored because MergeStateStatus has NO QUEUED member — a queued PR reports `blocked`,
--     indistinguishable from a protection-blocked one — and the Pending board may not fetch on
--     mount to find out (fifty cards would be ~150 GitHub calls to paint a screen);
--   • ⚠ NEITHER COLUMN TAKES A DEFAULT: null means "not observed", not "not queued". A DEFAULT
--     false would assert about every already-synced PR that GitHub had said it is out of the
--     queue, which it never did.
-- Position and estimatedTimeToMerge stay live-only in GET /api/prs/:id/merge-options — genuinely
-- volatile, and rendered only by the click-gated merge control.
ALTER TABLE "pull_requests" ADD COLUMN IF NOT EXISTS "in_merge_queue" boolean;--> statement-breakpoint
-- GitHub's MergeQueueEntryState, lowercased (awaiting_checks | locked | mergeable | queued |
-- unmergeable). Kept as `text` with a drizzle `enum:`, matching every other stored enum on this
-- table — no native pg enum, so there is nothing to CREATE TYPE here.
ALTER TABLE "pull_requests" ADD COLUMN IF NOT EXISTS "merge_queue_entry_state" text;
