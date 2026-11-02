-- THE SPRINT-SOURCE PROBE (2026-11-02; docs/TRACKERS.md § The sprint-source probe). CORE, additive, no
-- backfill.
--
--   sprint_reads.probe_checked_at   NEW: when the tracker worker last asked GitHub whether this GitHub
--                                   Issues workspace has a current Projects iteration or an open
--                                   milestone with a due date. NULL = never. Asked again after
--                                   SPRINT_PROBE_INTERVAL_MS, and never once a sprint read exists.
--   sprint_reads.probe_source_json  NEW: what the probe found (a `SprintSource`, kind 'iteration' or
--                                   'milestone'), NULL = nothing. Read ONLY by `hasSprintSource` (the
--                                   This Sprint default in Settings → Features), and only while the
--                                   workspace has no successful sprint read — a read's own source wins.
--
-- A probe may CREATE the workspace's row (`viewed_at` = epoch 0, `next_read_at` = epoch 0): the demand
-- gate is unchanged — a row whose tab was never opened is never read.
ALTER TABLE `sprint_reads` ADD `probe_checked_at` integer;
--> statement-breakpoint
ALTER TABLE `sprint_reads` ADD `probe_source_json` text;
