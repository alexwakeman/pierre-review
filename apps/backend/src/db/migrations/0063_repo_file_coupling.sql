-- BLAST RADIUS: the per-repo CO-CHANGE index (CORE, free, no AI, no GitHub calls).
--
-- "Which files in this repository does everything else change with?" — the cross-file dependency
-- reading, derived ENTIRELY from data already stored (`pull_requests.files` on MERGED pull
-- requests). A real import graph would need file CONTENTS, i.e. a GitHub fetch per file, and the
-- Pending board may not fetch on mount.
--
-- DERIVED, so this table is a CACHE: dropping it loses nothing but a rebuild, and it carries no
-- foreign-key cascade duty of its own. It still denormalizes `account_id` like every other anchor
-- table, and is therefore in `accountScopedTables()`.
--
-- ⚠ IT STORES ONLY THE HUBS. A path below `hub_bar` is simply absent, so the JSON stays small
-- (measured: 84 paths across 7 real repositories, vs 11,651 distinct paths seen).
--
-- ⚠ `hub_bar` IS max(repo p90, an absolute floor), AND BOTH HALVES ARE LOAD-BEARING. A p90 alone
-- is exceeded by a tenth of paths by construction, so a repository with no coupling still
-- publishes "hubs": measured, a config repo produced 77 of them — eight per-environment copies of
-- one service's .env file. Adding the absolute floor took that repo to zero while leaving
-- `redis.go`, `src/renderers/WebGLRenderer.js` and `crates/bevy_render/src/lib.rs` standing.
-- The Postgres twin is migrations-pg/0050_repo_file_coupling.sql.
CREATE TABLE `repo_file_coupling` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`repo_id` integer NOT NULL,
	`hub_bar` integer NOT NULL,
	`pr_count` integer NOT NULL,
	`hubs` text NOT NULL,
	`built_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rfc_account_repo` ON `repo_file_coupling` (`account_id`,`repo_id`);
