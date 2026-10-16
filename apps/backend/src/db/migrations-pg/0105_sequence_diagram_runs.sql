-- SEQUENCE DIAGRAM RUNS (2026-10-16). Twin of migrations/0118_sequence_diagram_runs.sql, where the
-- contract lives: one row per run, the unique index becomes a plain one.
DROP INDEX IF EXISTS "sequence_diagrams_subject_fp";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sequence_diagrams_subject_fp_idx" ON "sequence_diagrams" USING btree ("account_id","kind","subject","fingerprint");
