-- @pierre/pro plugin migration (Postgres / cloud mode) — the twin of
-- migrations/0019_bot_cost_to_account_reviewers.sql. Run once by the host's runPluginMigrations
-- (tracked in pro_migrations; discovered by filename sort, no journal).
--
-- ══ ⚠ THIS FILE IS NOW A LEGAL NO-OP ON EVERY DATABASE THAT HAS NOT ALREADY APPLIED IT ═══════
-- Core pg migrations 0031/0032 REPLACED the two tables this file reads and writes:
-- `repo_reviewers` + `account_reviewers` collapse onto `workspace_reviewers`, and 0032 DROPS
-- them. Core migrations ALWAYS run first (index.ts completes runMigrations() before
-- bindProPlugin() → ctx.registerMigrations → runPluginMigrations), so on every database that has
-- not already applied this file — a fresh cloud deploy above all — the INSERT below would raise
-- `relation "account_reviewers" does not exist`. On Postgres that error fires at PLAN time, i.e.
-- when the statement is first REACHED, and the existing EXCEPTION handler would catch it and
-- RAISE WARNING — so the plugin would survive, but every tenant's costs would be silently
-- skipped with a warning nobody reads. The `to_regclass` guard below makes the skip explicit and
-- costs nothing.
--
-- (The sqlite twin has no EXCEPTION block, so there the same raise reaches runPluginMigrations,
-- bind.ts logs `pro register() failed — OSS mode`, and the ENTIRE plugin goes dark. Both files
-- are guarded so the two dialects behave the same way for the same reason.)
--
-- NO PRICE IS LOST. A database that already ran this file keeps its values in
-- `account_reviewers.monthly_cents`, and core 0032 folds them into `workspace_reviewers`. A
-- database upgrading from a pre-0030 release no-ops here, and plugin migration
-- 0020_workspace_scope_keys.sql ABSORBS the backfill — same blob, same rounding rule, same
-- guards, writing `workspace_reviewers.monthly_cents` instead. Read the two files together.
-- ═════════════════════════════════════════════════════════════════════════════════════════════
--
-- DATA MIGRATION ONLY. Moves the legacy per-bot monthly cost out of this plugin's
-- `pro_settings.bot_cost_json` blob into the CORE `account_reviewers` table (core pg migration
-- 0030), so no stored price is lost when cost becomes CORE/free and moves onto the actor row.
-- See the sqlite twin for the full rationale:
--   * it lives in the PLUGIN because `pro_settings` does not exist on an OSS install;
--   * core migrations run BEFORE the plugin binds, so `account_reviewers` always exists first;
--   * it writes a COLUMN, not a row: cost is one property of the actor, so it fills
--     `monthly_cents` on the identity row core 0030 already seeded, and inserts a bare row only
--     if that is somehow absent;
--   * `kind`-keyed legacy entries are NOT migratable (a kind names a brand, not an actor) and
--     stay in the blob, driving the deprecated read-time fallback.
--
-- GATED ON THE ACTOR HAVING A BOT ROW (`EXISTS … repo_reviewers`), same as the sqlite twin. Core
-- pg 0029 drops auto classifications for actors with no footprint in any repo, so a login match
-- alone would import a price with no row anywhere to hang it on — and the listing is row-driven,
-- so nothing could display, edit or clear it. A skipped price is NOT lost: `bot_cost_json` is
-- never dropped and the entry keeps driving ROI through the read-time fallback.
--
-- Deduped by `GROUP BY … MAX(cents)` before the insert, so one account's blob cannot present the
-- same conflict key twice in a single statement. `ON CONFLICT … DO UPDATE … WHERE monthly_cents
-- IS NULL` then makes it idempotent AND unable to clobber a price the user already set inline —
-- including a deliberate 0. (NULL means "no price set" and nothing inherits, so that guard has
-- exactly one meaning.)
--
-- ── THE ROUNDING RULE ───────────────────────────────────────────────────────────────────────
--   cents = floor(usd × 100 + 0.5), evaluated in IEEE-754 binary64, in BOTH dialects.
-- This file used to compute in `numeric` (`ROUND((e->>'monthlyUsd')::numeric * 100)`), which is
-- exact decimal, and SQLite has only binary64 — so the same blob produced different rows:
--   monthlyUsd 1.005 → pg 101 cents, sqlite 100 cents.
--   monthlyUsd 0.145 → pg  15 cents, sqlite  14 cents.
-- Measured on this file's own hostile-blob fixture. Fractional cents are REACHABLE because the
-- legacy write path validated monthlyUsd as `{type:number, minimum:0}` with no `multipleOf`.
-- `round(double precision)` is not the fix either: it is round-half-to-EVEN on this platform
-- (0.125 → 12) where SQLite's `round()` is half-away-from-zero (13). `floor(x * 100 + 0.5)` over
-- a double depends on nothing but IEEE-754, so the two dialects agree by construction rather than
-- by luck — verified over the shared fixture, row for row. Keep the `::double precision` cast:
-- reverting it to `::numeric` silently reintroduces the divergence with no error anywhere.
--
-- ── TWO LAYERS OF BLAST-RADIUS PROTECTION ───────────────────────────────────────────────────
-- A raise here is not local: runPluginMigrations rethrows, bind.ts log-and-degrades, and the
-- ENTIRE Pro plugin silently drops to OSS mode on a cloud deploy.
--   1. `bot_cost_json` is a TEXT column, so `::jsonb` on a hand-corrupted value would ERROR (and
--      an object rather than an array would error inside jsonb_array_elements). The CASE feeds
--      '[]'::jsonb unless the value looks like a JSON array. CASE short-circuits here — the
--      operand is not constant-foldable, so the cast on the false branch is never evaluated.
--   2. The whole statement is wrapped in a DO block that downgrades any surviving error to a
--      WARNING. Skipping the backfill is SAFE by construction: the blob is not dropped and the
--      read-time fallback keeps serving those values. Losing the plugin is not.
--
--      WHAT THAT ROLLBACK ACTUALLY COSTS IS PLAN-DEPENDENT, not unconditional (an earlier draft
--      of this header said "all-or-nothing … measured, not assumed", and the measurement it cited
--      predated the EXISTS gate). The DO block is one statement, so any error that DOES fire rolls
--      back every account's copy — but with the `EXISTS … repo_reviewers` gate in place, whether
--      one fires depends on the plan:
--        * corrupt blob on an account with NO repo_reviewers rows → the semi-join eliminates that
--          pro_settings row before the `::jsonb` cast is ever evaluated. No exception, no
--          rollback, EVERY other tenant migrates. Identical outcome to sqlite.
--        * corrupt blob on an account that DOES have at least one repo_reviewers row → the cast
--          is evaluated, it raises, and the EXCEPTION block rolls back every account's copy.
--      Both measured on PostgreSQL 16.13 against the shared fixture. The sqlite twin degrades
--      '[oops' to '[]' unconditionally and so skips only the corrupt tenant in BOTH cases.
--      Do not "reconcile" the two files by removing this block — the EXCEPTION wrapper is what
--      stops a raise reaching runPluginMigrations, which would drop the WHOLE plugin to OSS mode
--      on a cloud deploy. The remaining asymmetry is the lesser problem.
--
-- LEAST caps at int4 max (~$21,474,836.47). Without it a single absurd-but-well-formed price in
-- ONE account raises "integer out of range", the EXCEPTION block rolls the whole statement back,
-- and NO tenant's costs migrate — while sqlite, whose integers are 64-bit, migrates the same blob
-- happily. THE TWIN CLAMPS TOO (`min(2147483647, …)`): measured on the same blob before both were
-- clamped, monthlyUsd 99999999999 stored 2147483647 here and 9999999999900 there, a value with no
-- representation in this dialect at all. `ReviewerCostBody.monthlyUsd` states the bound for the
-- live write path so a route clamps or 400s instead of letting this side 500.
--
-- `jsonb_typeof(e->'login') = 'string'` is the mirror image of the twin's `json_type(val,
-- '$.login') = 'text'`. Without it `->>` stringifies a numeric login and joins it: `{"login":123}`
-- matched a user literally named "123" here and was excluded there — same blob, different rows.
DO $$
BEGIN
  -- THE GUARD. Both legacy tables are gone after core pg 0032, and plpgsql only plans a statement
  -- when control actually reaches it — so a false IF means the INSERT below is never parsed
  -- against the catalog and the missing relations cannot raise at all. Same pattern core pg 0029
  -- uses. Checked for BOTH names because the statement reads one and writes the other, and a
  -- half-migrated database (either table present alone) must also take the skip rather than fail
  -- halfway. `public.` is spelled because to_regclass resolves against search_path.
  IF to_regclass('public.repo_reviewers') IS NOT NULL
     AND to_regclass('public.account_reviewers') IS NOT NULL THEN
  WITH priced AS (
    SELECT ps.account_id AS account_id,
           u.id          AS author_user_id,
           MAX(LEAST(2147483647::double precision,
                     floor(GREATEST(0::double precision,
                                    (e->>'monthlyUsd')::double precision) * 100 + 0.5))::integer)
             AS monthly_cents
      FROM pro_settings ps
           CROSS JOIN LATERAL jsonb_array_elements(
             CASE WHEN ps.bot_cost_json ~ '^\s*\[' THEN ps.bot_cost_json::jsonb ELSE '[]'::jsonb END
           ) AS e
           JOIN users u ON lower(u.github_login) = lower(e->>'login')
     WHERE ps.bot_cost_json IS NOT NULL
       AND jsonb_typeof(e) = 'object'
       AND jsonb_typeof(e->'monthlyUsd') = 'number'
       AND jsonb_typeof(e->'login') = 'string'
       -- The footprint gate — see the header. No bot row for this actor anywhere in the account
       -- means no row a price could ever be shown on, edited on, or cleared from.
       AND EXISTS (
             SELECT 1 FROM repo_reviewers rr
              WHERE rr.account_id = ps.account_id
                AND rr.author_user_id = u.id
           )
     GROUP BY ps.account_id, u.id
  )
  INSERT INTO account_reviewers (account_id, author_user_id, monthly_cents)
  SELECT account_id, author_user_id, monthly_cents FROM priced
  ON CONFLICT (account_id, author_user_id) DO UPDATE
    SET monthly_cents = excluded.monthly_cents
    WHERE account_reviewers.monthly_cents IS NULL;
  END IF;
EXCEPTION WHEN others THEN
  RAISE WARNING 'pro 0019: legacy bot_cost_json backfill skipped (%). The values remain in pro_settings.bot_cost_json and keep driving ROI via the read-time fallback.', SQLERRM;
END $$;
