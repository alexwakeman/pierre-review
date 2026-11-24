-- THE COMMERCIAL LICENCE ON THIS MACHINE (2026-11-24; docs/LICENSING.md). CORE, additive.
--   accounts.licence_key                     the signed key from Settings → Licence, verified offline
--   accounts.licence_evaluation_ends_at      the end of the one 30-day evaluation, once started
--   accounts.licence_reminder_snoozed_until  "Remind me later"
ALTER TABLE `accounts` ADD `licence_key` text;
--> statement-breakpoint
ALTER TABLE `accounts` ADD `licence_evaluation_ends_at` integer;
--> statement-breakpoint
ALTER TABLE `accounts` ADD `licence_reminder_snoozed_until` integer;
