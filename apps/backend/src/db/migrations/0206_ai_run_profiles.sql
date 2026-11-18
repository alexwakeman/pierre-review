-- AI RUN PROFILES (2026-11-18; docs/CLAUDE-REVIEW.md § The run profiles). CORE, additive.
--
--   accounts.ai_run_profiles   Settings → AI's per-surface choices, one JSON object per machine: the review
--                              (per vendor: on/off, model, effort), AI Fix and Implement story (vendor, model,
--                              effort; Implement also its review rounds). NULL = never chosen: every surface
--                              runs as before (ai_effort, the default provider, the usual models).
ALTER TABLE `accounts` ADD COLUMN `ai_run_profiles` text;
