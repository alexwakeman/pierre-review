-- DESIGN DIAGRAMS (2026-10-17; docs/CLAUDE-REVIEW.md § Design diagrams). The sequence-diagram process
-- now produces a small DESIGN GRID (acts × layers, validated JSON) instead of Mermaid source. One new
-- nullable JSON column; `source` is KEPT (no column drops) and no longer written. Design-era rows are
-- told apart by `diagram_type = 'design'` (stamped at queue time) — the reads ignore every other row,
-- so the stored Mermaid diagrams simply stop showing and the next review draws a design.
-- The Postgres twin is migrations-pg/0106_design_diagrams.sql.
ALTER TABLE `sequence_diagrams` ADD `design` text;
