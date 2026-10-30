-- THE WORKTREE LEDGER (docs/BACKEND.md § Worktree cleanup). One row per per-run checkout under the
-- clone cache's `.worktrees/`, naming its owner (kind, PR, ticket, run) and the process that made it,
-- so the sweep (review/worktree-gc.ts) removes only trees nothing still needs. Additive; no backfill —
-- a checkout made before this table is an unledgered orphan the sweep collects by age.
CREATE TABLE `worktree_ledger` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer,
	`path` text NOT NULL,
	`clone_dir` text NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`pr_id` integer,
	`ticket` text,
	`run_id` integer,
	`head_sha` text,
	`pid` integer NOT NULL,
	`instance` text NOT NULL,
	`pin_reason` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer NOT NULL,
	`released_at` integer,
	`removed_at` integer,
	`remove_reason` text,
	`bytes_reclaimed` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `worktree_ledger_path` ON `worktree_ledger` (`path`);
--> statement-breakpoint
CREATE INDEX `worktree_ledger_removed` ON `worktree_ledger` (`removed_at`);
