-- MY TURN SETTINGS (CORE, free, no AI) + the MENTION CLOCK.
--
-- accounts.my_turn_settings: the reader's My Turn types, type order and ranking weights, stored as
-- OVERRIDES ONLY. NULL = the product defaults, so a later change to a default reaches everyone who
-- never changed it (the 0062 blast_radius_config rule). No default, no backfill. Resolved by
-- packages/shared resolveMyTurnSettings; written only by PUT /api/me/my-turn-settings.
--
-- pr_mentions.mentioned_at / mentioned_by_user_id: WHEN a person last @-mentioned the viewer on the
-- PR, and who. The My Turn mention card clears when the viewer acts AFTER this moment, which needs
-- the moment. NULL until the mention scanner's next tick restamps every row (sync/mention-scan.ts);
-- no backfill here, because the scanner re-derives the whole set every tick anyway. A NULL row
-- produces no card.
-- The Postgres twin is migrations-pg/0055_my_turn_settings.sql.
ALTER TABLE `accounts` ADD `my_turn_settings` text;
--> statement-breakpoint
ALTER TABLE `pr_mentions` ADD `mentioned_at` integer;
--> statement-breakpoint
ALTER TABLE `pr_mentions` ADD `mentioned_by_user_id` integer;
