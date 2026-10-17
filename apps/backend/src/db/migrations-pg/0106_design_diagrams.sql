-- DESIGN DIAGRAMS (2026-10-17). Twin of migrations/0119_design_diagrams.sql, where the contract lives:
-- one nullable JSON column for the design grid; `source` kept and no longer written.
ALTER TABLE "sequence_diagrams" ADD COLUMN IF NOT EXISTS "design" jsonb;
