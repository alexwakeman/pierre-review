-- Part A: deterministic "was this thread addressed?" upgrade. Store a graded addressed-confidence
-- + a machine reason tag + who resolved the thread, alongside the existing derivedState. All
-- additive (defaulted / nullable) so the backfill is a no-op — the next sync recomputes them.
-- The Postgres baseline is regenerated separately via `pnpm db:generate:pg`.
ALTER TABLE `review_threads` ADD `addressed_confidence` text DEFAULT 'none' NOT NULL;
--> statement-breakpoint
ALTER TABLE `review_threads` ADD `addressed_reason` text;
--> statement-breakpoint
ALTER TABLE `review_threads` ADD `resolved_by_login` text;
