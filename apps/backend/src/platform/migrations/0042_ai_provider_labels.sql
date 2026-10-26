-- Platform migration (SQLite). Run once by platform/migrate.ts, tracked by NAME in
-- pro_migrations; filename-sorted, no journal, no statement-breakpoint markers.
--
-- RUN LABELLING (docs/CODEX-PLAN.md Phase 4): every stored one-shot write-up names the provider that
-- answered, beside `model`, which now stores the model that RAN (a Codex id on Codex). Nullable; NULL
-- on every older row reads as Claude unless `model` is a Codex id (packages/shared `aiRunProvider`).
-- Only the tables with a live writer: the sprint report, synthesis, bot themes, the work plan, flow
-- pointers and the impact note. Additive only.
--
-- Not blind-replayable (SQLite has no ADD COLUMN IF NOT EXISTS); run-once is pro_migrations' job.
-- Every table is already in the platform's erasure handler (retention.ts).
ALTER TABLE sprint_reports ADD COLUMN provider text;
ALTER TABLE pro_synthesis ADD COLUMN provider text;
ALTER TABLE bot_theme_reports ADD COLUMN provider text;
ALTER TABLE pro_work_plans ADD COLUMN provider text;
ALTER TABLE pro_flow_pointers ADD COLUMN provider text;
ALTER TABLE pr_comment_annotations ADD COLUMN provider text;
