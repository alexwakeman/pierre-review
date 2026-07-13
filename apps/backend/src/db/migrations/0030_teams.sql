-- Teams (CORE): a named grouping of an account's repos, plus the many-to-many join
-- (team_repos; overlap allowed). Account-scoped isolation (accountId denormalized onto
-- the join). FKs cascade so deleting an account/team/repo cleans up membership rows.
-- The Postgres baseline is regenerated separately via `pnpm db:generate:pg`.
CREATE TABLE `teams` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teams_account_name` ON `teams` (`account_id`,`name`);
--> statement-breakpoint
CREATE INDEX `teams_account_idx` ON `teams` (`account_id`);
--> statement-breakpoint
CREATE TABLE `team_repos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`team_id` integer NOT NULL,
	`repo_id` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_repos_team_repo` ON `team_repos` (`team_id`,`repo_id`);
--> statement-breakpoint
CREATE INDEX `team_repos_account_idx` ON `team_repos` (`account_id`);
--> statement-breakpoint
CREATE INDEX `team_repos_repo_idx` ON `team_repos` (`repo_id`);
