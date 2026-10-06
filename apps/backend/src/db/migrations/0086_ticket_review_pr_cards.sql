-- TICKET REVIEW CONTRIBUTION CARDS. One row per (account, PR, head commit): a model-written,
-- verdict-free description of what that PR's head does (summary, interfaces, the story criteria it
-- moves forward, loose ends) plus the PR's changed files at that head (server-written). A ticket
-- review reads a member whose CURRENT head has a card as the card, not as its diff; the run writes a
-- card for every member it read as a diff (source 'story_check') and a cheap per-PR pre-pass writes
-- the overflow (source 'prepass', with its own cost). Re-writing the same head replaces the card.
-- Tenancy: a composite FK against pull_requests(id, account_id). Both delete paths (deleteRepo,
-- retention's deletePrSubtree, via db/ticket-review-prune.ts) and eraseAccountData delete these rows
-- explicitly. The Postgres twin is migrations-pg/0073_ticket_review_pr_cards.sql.
CREATE TABLE IF NOT EXISTS `ticket_review_pr_cards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`pr_id` integer NOT NULL,
	`head_sha` text NOT NULL,
	`card` text NOT NULL,
	`source` text NOT NULL,
	`model` text NOT NULL,
	`cost_usd` real,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `trpc_pr_account_fk` FOREIGN KEY (`pr_id`,`account_id`) REFERENCES `pull_requests`(`id`,`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `trpc_account_pr_head_ux` ON `ticket_review_pr_cards` (`account_id`,`pr_id`,`head_sha`);
