-- Stripe billing seam (additive). `plan` ('free' | 'pro', default 'free') is set ONLY by
-- the Stripe webhook (api/routes/billing.ts) — the OAuth upsert never touches it, so a
-- re-login can't reset a paid plan. `stripe_customer_id` (cus_…) is captured from
-- checkout.session.completed so subscription webhooks can resolve the account.
-- The Postgres baseline is regenerated separately via `pnpm db:generate:pg`.
ALTER TABLE `accounts` ADD `plan` text NOT NULL DEFAULT 'free';--> statement-breakpoint
ALTER TABLE `accounts` ADD `stripe_customer_id` text;
