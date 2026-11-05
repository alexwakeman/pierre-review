-- MY TURN "Merged after your Limn approved" counts only merges from the moment the card type
-- reached this install — an upgrade must not drop every recent approved-then-merged PR on My Turn.
-- NULL (an account created later) reads as that account's own `created_at`.
ALTER TABLE `accounts` ADD `approved_merged_since` integer;
--> statement-breakpoint
UPDATE `accounts` SET `approved_merged_since` = unixepoch();
