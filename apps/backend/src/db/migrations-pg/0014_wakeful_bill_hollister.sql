ALTER TABLE "accounts" ADD COLUMN "plan" text DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "stripe_customer_id" text;