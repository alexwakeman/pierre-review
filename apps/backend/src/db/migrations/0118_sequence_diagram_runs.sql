-- SEQUENCE DIAGRAM RUNS (2026-10-16; docs/CLAUDE-REVIEW.md § Sequence diagrams). ONE ROW PER RUN.
-- 0115 kept one row per (account, kind, subject, fingerprint) and a Redraw at the same head REWROTE it,
-- clearing the good diagram while the redraw ran — and for good if it then failed, was cancelled or was
-- cut off by a restart. Now every queued run is its own row: the slot shows the newest SUCCEEDED row
-- under a newer run, and "is it drawn at this head?" is still "any row at this fingerprint". The unique
-- index becomes a plain one (same columns, the lookup it served).
-- The Postgres twin is migrations-pg/0105_sequence_diagram_runs.sql.
DROP INDEX IF EXISTS `sequence_diagrams_subject_fp`;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sequence_diagrams_subject_fp_idx` ON `sequence_diagrams` (`account_id`,`kind`,`subject`,`fingerprint`);
