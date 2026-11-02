-- SETTINGS → FEATURES (2026-11-01; docs/FRONTEND.md § Features shown, shared features.ts). CORE,
-- additive, visibility only.
--
--   accounts.feature_settings           NEW: the reader's switches, overrides only (JSON). NULL = every
--                                       default applies. Written only by PUT /api/me/feature-settings.
--   accounts.features_existing_install  NEW: 1 for an account that already had repositories when this
--                                       migration ran — its defaults show every destination, so an
--                                       existing install looks exactly as before. A new install
--                                       (an account created later, or one with no repos yet) is 0 and
--                                       starts with Bots Monitoring and Feed hidden.
ALTER TABLE `accounts` ADD `feature_settings` text;
--> statement-breakpoint
ALTER TABLE `accounts` ADD `features_existing_install` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `accounts` SET `features_existing_install` = 1
  WHERE EXISTS (SELECT 1 FROM `repos` WHERE `repos`.`account_id` = `accounts`.`id`);
