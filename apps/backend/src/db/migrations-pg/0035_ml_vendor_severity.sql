-- The review bot's OWN declared severity — the Postgres twin of sqlite
-- 0048_ml_vendor_severity.sql. HAND-WRITTEN ADDITIVE, like every pg migration since 0023:
-- never regenerate the baseline with `pnpm db:generate:pg`, which squashes it.
--
-- See the sqlite twin for the full argument. In short: the severity-api's marker reader already
-- extracts the vendor's self-declared severity and we were discarding it, so it is stored beside
-- ours to be DISPLAYED next to it — never folded into it. On `gold_v2_sample` our model scores
-- 0.700 exact / 0.303 ordinal MAE against the vendor badge's 0.474 / 0.697, so the vendor's claim
-- is the less accurate of the two; nothing derives our severity from it.
--
-- Both columns are nullable: most comments carry no vendor badge, and an older severity-api
-- omits the fields entirely (the client reads them defensively → null). No index (read out of an
-- already-fetched row, never a predicate) and no backfill (labels are not re-scored; `pnpm
-- ml:enrich --reset` is the refresh gesture).
ALTER TABLE "ml_comment_labels" ADD COLUMN IF NOT EXISTS "vendor_severity" text;--> statement-breakpoint
ALTER TABLE "ml_comment_labels" ADD COLUMN IF NOT EXISTS "vendor_severity_confidence" text;
