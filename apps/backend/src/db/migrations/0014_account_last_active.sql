-- Activity gating for the scheduler (additive). `last_active_at` records the last
-- time a loaded frontend for this account talked to the backend; the periodic sync
-- skips accounts not active within config.syncActiveWindowMinutes so a tenant with no
-- open tab stops being re-synced. Nullable; existing rows stay NULL (eligible only
-- once they next show activity). Cloud-relevant; local has one always-on account.
ALTER TABLE `accounts` ADD `last_active_at` integer;
