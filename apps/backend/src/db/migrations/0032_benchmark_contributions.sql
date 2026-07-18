-- Cross-org benchmark network (CORE, cloud-only, opt-in), Phase 0: the opt-in flag on
-- accounts + the aggregate-only weekly contributions table. See schema.sqlite.ts for the
-- full rationale (no PII, in_house/pierre excluded, written only by the firewalled rollup).
-- The Postgres baseline is maintained separately (migrations-pg/0019_*).
ALTER TABLE `accounts` ADD `benchmark_opt_in` integer DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE `benchmark_contributions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`vendor_kind` text NOT NULL,
	`week_start` integer NOT NULL,
	`threads` integer DEFAULT 0 NOT NULL,
	`comments` integer DEFAULT 0 NOT NULL,
	`acted_on` integer DEFAULT 0 NOT NULL,
	`untouched` integer DEFAULT 0 NOT NULL,
	`human_follow` integer DEFAULT 0 NOT NULL,
	`oldest_untouched_days` integer,
	`org_size_bucket` text NOT NULL,
	`ml_metrics` text,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bench_contrib_uniq` ON `benchmark_contributions` (`account_id`,`vendor_kind`,`week_start`);
--> statement-breakpoint
CREATE INDEX `bench_contrib_account_idx` ON `benchmark_contributions` (`account_id`);
--> statement-breakpoint
CREATE INDEX `bench_contrib_cohort_idx` ON `benchmark_contributions` (`vendor_kind`,`week_start`);
