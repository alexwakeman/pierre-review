-- RELATED REPOS (docs/CLAUDE-REVIEW.md § Related repos): repos of one workspace the reader reviews
-- together. A deep review of a PR in one reads the companion change in the other, read-only.
-- SYMMETRIC, stored both ways. Off by default (no rows). Every id arrives in a request, so every one
-- is a COMPOSITE FK against (id, account_id). Plus `claude_reviews.peers_read`: what a run read
-- beside the PR (ticket peers and related repos), NULL on every older row. Additive only.
CREATE TABLE IF NOT EXISTS `repo_relations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`repo_id` integer NOT NULL,
	`related_repo_id` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `repo_relations_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `workspaces`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `repo_relations_repo_account_fk` FOREIGN KEY (`repo_id`,`account_id`) REFERENCES `repos`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `repo_relations_related_repo_account_fk` FOREIGN KEY (`related_repo_id`,`account_id`) REFERENCES `repos`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `repo_relations_pair` ON `repo_relations` (`account_id`,`workspace_id`,`repo_id`,`related_repo_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `repo_relations_account_repo_idx` ON `repo_relations` (`account_id`,`repo_id`);
--> statement-breakpoint
ALTER TABLE `claude_reviews` ADD `peers_read` text;
