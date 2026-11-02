-- THE CI-HISTORY "STILL OWED" STAMP (2026-11-02; docs/SYNC.md § The CI-history backfill is owed
-- until it ran). CORE, additive, no backfill.
--
--   sync_state.ci_history_pending_at   NEW: set when a completed FULL walk owes the one-time
--                                      CI-history backfill (before it is run or parked in the
--                                      in-memory queue); cleared once the backfill ran. A
--                                      non-NULL value at boot, or at the repo's next walk, runs
--                                      it then. NULL = nothing owed.
ALTER TABLE `sync_state` ADD `ci_history_pending_at` integer;
