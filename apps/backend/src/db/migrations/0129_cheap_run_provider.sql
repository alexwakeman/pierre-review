-- RUN LABELLING for the one-shot sprint and story writers (docs/CODEX-PLAN.md Phase 4; missed by
-- 0128). Sprint briefs, sprint themes and story labels run through the cheap seam, which answers on
-- Codex when Codex is the active provider. `model` now stores the model that RAN (a Codex id on
-- Codex) and `provider` names who answered. Nullable; NULL on every older row, read as Claude unless
-- `model` is a Codex id (packages/shared `aiRunProvider`). Additive only.
ALTER TABLE `sprint_briefs` ADD `provider` text;
--> statement-breakpoint
ALTER TABLE `sprint_themes` ADD `provider` text;
--> statement-breakpoint
ALTER TABLE `story_labels` ADD `provider` text;
