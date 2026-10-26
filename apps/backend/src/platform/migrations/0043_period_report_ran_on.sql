-- Platform migration (SQLite). Run once by platform/migrate.ts, tracked by NAME in
-- pro_migrations; filename-sorted, no journal, no statement-breakpoint markers.
--
-- RUN LABELLING for the period write-up (docs/CODEX-PLAN.md Phase 4; missed by 0042). A period
-- report's `model` is part of the row's unique identity and the generation cache key, so it keeps
-- the REQUESTED Claude id; what actually wrote the narrative is stored beside it: `ran_model` (a
-- Codex id on Codex) and `provider`. Nullable; NULL on every older row reads as `model` on Claude.
-- Additive only.
--
-- Not blind-replayable (SQLite has no ADD COLUMN IF NOT EXISTS); run-once is pro_migrations' job.
-- The table is already in the platform's erasure handler (retention.ts).
ALTER TABLE workspace_period_reports ADD COLUMN ran_model text;
ALTER TABLE workspace_period_reports ADD COLUMN provider text;
