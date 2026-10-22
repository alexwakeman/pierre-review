-- @pierre/pro plugin migration (SQLite / local mode). Run once by the host's runPluginMigrations
-- (tracked in pro_migrations — plugin migrations are discovered by filename sort and have NO
-- meta/_journal.json; that requirement is CORE-only). Postgres twin:
-- migrations-pg/0019_bot_cost_to_account_reviewers.sql.
--
-- ══ ⚠ THIS FILE IS NOW A LEGAL NO-OP ON EVERY DATABASE THAT HAS NOT ALREADY APPLIED IT ═══════
-- Core migrations 0044/0045 (pg 0031/0032) REPLACED the two tables this file reads and writes:
-- `repo_reviewers` + `account_reviewers` are collapsed onto `workspace_reviewers`, and 0045
-- DROPS them. Core migrations ALWAYS run first (index.ts completes runMigrations() before
-- bindProPlugin() → ctx.registerMigrations → runPluginMigrations), so on every database that has
-- not already applied this file — a fresh local install, a fresh cloud deploy, the demo seeder,
-- CI — the statement below would raise "no such table: repo_reviewers". That is NOT a local
-- failure: pro/migrate.ts rethrows, bind.ts catches it and logs `pro register() failed — OSS
-- mode`, and the ENTIRE plugin goes dark — every capability false, every /api/pro/* 404, and
-- nothing thrown that a user would connect to this file.
--
-- So the two legacy tables are STUBBED below (empty, throwaway) and DROPPED again at the end.
-- The backfill then runs as a legal statement over zero rows and inserts nothing. Dropping is
-- safe precisely BECAUSE core always drops them first: by the time any plugin migration runs, a
-- table of either name can only be this file's own stub. `pro_migrations` still records the file
-- as applied, so a database that already ran the REAL version of it never re-runs this one and
-- keeps its migrated prices.
--
-- NO PRICE IS LOST BY THIS.
--   * A database that already ran the real 0019 (this branch's users) has the values in
--     `account_reviewers.monthly_cents`, and core 0045 folds them into `workspace_reviewers`.
--   * A database upgrading from a pre-0043 release no-ops here, and plugin migration
--     0020_workspace_scope_keys.sql ABSORBS the backfill — reading the same legacy
--     `pro_settings.bot_cost_json` blob straight into `workspace_reviewers.monthly_cents` under
--     the same rules (UPDATE only / never INSERT / guarded on `monthly_cents IS NULL`), with the
--     same rounding rule and the same four JSON-safety layers documented below. Read the two
--     files together; everything under "THE ROUNDING RULE" and "MALFORMED-JSON SAFETY" here is
--     the specification 0020 implements.
--   * `bot_cost_json` is still never dropped, so unmatched logins keep driving ROI through the
--     deprecated read-time fallback either way.
--
-- The rest of this header is kept VERBATIM as the historical record of what the statement does
-- on the one database shape that still executes it meaningfully — none, going forward — and as
-- the derivation of the rules 0020 inherited.
-- ═════════════════════════════════════════════════════════════════════════════════════════════
--
-- DATA MIGRATION ONLY — it alters nothing, and the only tables it creates are the two throwaway
-- stubs described above, both dropped again before the file ends. It moves the legacy per-bot
-- monthly cost
-- out of this plugin's `pro_settings.bot_cost_json` blob into the CORE `account_reviewers` table
-- (core migration 0043 / pg 0030), so no stored price is lost when the editor moves onto the bot
-- row and cost becomes CORE/free.
--
-- WHY IT LIVES IN THE PLUGIN AND NOT IN CORE 0043
-- `pro_settings` is plugin-owned and DOES NOT EXIST on an OSS/npx install. A core migration
-- referencing it would fail there and block boot, and SQLite has no conditional-DDL guard (no
-- `DO $$`). Only the plugin knows the table is there — because only the plugin created it.
--
-- ORDERING PREREQUISITE (load-bearing, and now inverted)
-- This paragraph used to read "`account_reviewers` must already exist when this runs, and it
-- does, because core migrations run first". That ordering is still true and is now the reason
-- the table is GONE by the time we get here (core 0045 drops it), which is exactly why the stubs
-- above exist. The failure it warned about is NOT visible in the way it claimed: a raise here
-- degrades the whole plugin to OSS mode SILENTLY — capabilities off, Pro routes 404, no error
-- the user could connect to a migration. That is the hazard the stubs remove.
--
-- IT WRITES A COLUMN, NOT A ROW, AND THAT IS THE POINT OF THE REDESIGN. Cost is one property of
-- the ACTOR, so it lives on the actor's own row alongside its kind and label. The upsert below
-- therefore fills `monthly_cents` on an existing identity row (the normal case — core 0043 seeds
-- one for every actor that has a repo row) and inserts a bare one only if that row is somehow
-- absent. `monthly_cents` is NULLABLE there, and the `WHERE … IS NULL` guard uses that directly:
-- NULL means "no price set", so filling it can never overwrite a price the user typed, INCLUDING
-- a deliberate 0. There is no inheritance behind either state, so there is no `??`-vs-`||` trap
-- to get wrong here.
--
-- WHAT IT STILL CANNOT MIGRATE, and why the deprecated read-time fallback survives: the blob has
-- had TWO shapes. Entries keyed by `login` are migratable (join `users`). OLDER entries keyed by
-- vendor `kind` are NOT — a kind names a BRAND, not an actor, so there is no `author_user_id` to
-- key a row on, and the kind→login map lives in packages/shared, not in SQL. Those entries stay
-- in the blob (which is deliberately never dropped) and keep driving the ROI panel through the
-- fallback that fills only rows whose server-resolved cost is null.
--
-- GATED ON THE ACTOR ACTUALLY HAVING A BOT ROW (`EXISTS … repo_reviewers`). Core 0042
-- deliberately DROPS auto classifications for actors with no footprint in any repo, so a login
-- match alone is not evidence the actor still exists as a bot object here — importing on the
-- login match alone produced a price with no row anywhere to hang it on. The listing is
-- row-driven, so such a price cannot be displayed, edited or cleared: unreachable, un-clearable
-- data, and worth nothing to anyone (a price for a bot that touches no repo tells you nothing).
-- The alternative — an orphan-surfacing UI — is a screen built to apologise for a migration.
--
-- WHAT HAPPENS TO A SKIPPED PRICE: nothing is lost. `bot_cost_json` is deliberately NEVER
-- dropped, so the entry stays in the blob and keeps driving the ROI panel through the same
-- read-time fallback that serves the kind-keyed entries below (it fills only rows whose
-- server-resolved cost is null). If that actor ever gets a `repo_reviewers` row again, the
-- fallback covers it until someone re-costs it inline — this migration never re-runs.
--
-- DEDUPED BEFORE INSERT (`GROUP BY … MAX(cents)`). A duplicate login inside one account's blob
-- would otherwise present the same conflict key twice in one statement; both values are the
-- user's own input, so taking the larger is arbitrary-but-deterministic, which is the property
-- that matters.
--
-- ── THE ROUNDING RULE, AND WHY IT IS SPELLED OUT ────────────────────────────────────────────
--   cents = floor(usd × 100 + 0.5), evaluated in IEEE-754 binary64, in BOTH dialects.
-- Half-up on the binary64 product. NOT "round to the nearest cent of the exact decimal value",
-- which is what it looks like and is a different function: the legacy write path validated
-- monthlyUsd as `{type:number, minimum:0}` with no `multipleOf`, so a fractional-cent price like
-- 1.005 is REACHABLE, and 1.005 is not representable in binary64 (the nearest double is
-- 1.00499999999999989…).
--
-- MEASURED, on this file's own hostile-blob fixture, before the rule was pinned:
--   monthlyUsd 1.005 → pg 101 cents, sqlite 100 cents.
--   monthlyUsd 0.145 → pg  15 cents, sqlite  14 cents.
-- pg was computing in `numeric` — exact decimal, so 1.005 × 100 is exactly 100.5 and rounds up —
-- while SQLite has only binary64. Neither answer is wrong in isolation; having both is. Nor does
-- pg's `round(double precision)` fix it: that is round-half-to-EVEN on this platform (0.125 →
-- 12), where SQLite's `round()` is half-away-from-zero (13). `floor(x × 100 + 0.5)` depends on
-- nothing but IEEE-754, so the two agree by construction rather than by luck — verified over the
-- shared fixture, row for row.
--
-- ── MALFORMED-JSON SAFETY (four layers, all four needed) ────────────────────────────────────
-- A raise here is not local: runPluginMigrations rethrows, bind.ts log-and-degrades, and the
-- ENTIRE plugin silently drops to OSS mode.
--   1. `json_each()` RAISES on a non-JSON argument, and `json_type(x)` raises on one too — so the
--      guard is a NESTED CASE, not `json_valid(x) AND json_type(x)='array'`: only CASE is
--      documented to evaluate just the selected branch, whereas SQLite may evaluate both sides of
--      an AND. A blob that is neither valid JSON nor an array is replaced by '[]'.
--   2. json_each over an ARRAY still yields scalar elements ([1, "x", null]), and
--      `json_extract('x', '$.login')` raises "malformed JSON" on those. The `e.type = 'object'`
--      filter therefore lives in its OWN CTE, so nothing extracts from an element until it is
--      known to be an object.
--   3. `usd_type IN ('integer','real')` drops a non-numeric monthlyUsd (e.g. "junk") instead of
--      coercing it to 0 and quietly telling the user their $120 bot is free.
--   4. `login_type = 'text'` drops a non-string login. This one is a MIRROR-IMAGE FIX, not a new
--      idea: the pg twin reaches the same set with `jsonb_typeof(e->'login') = 'string'`, and
--      until both were written the two dialects disagreed on `{"login":123,…}` — pg stringified
--      it via `->>` and joined it (matching a user literally named "123"), sqlite kept it out.
--      json_type is used rather than typeof() precisely because it is the exact analogue of
--      jsonb_typeof: `typeof(json_extract(val,'$.login'))` reports 'text' for a nested OBJECT
--      too, since json_extract hands back its JSON source text.
--
-- ONE MEASURED DIVERGENCE FROM THE POSTGRES TWIN, and it is narrower than the earlier draft of
-- this header claimed (which said the pg side is all-or-nothing, full stop): there, a corrupt
-- blob rolls back every account's copy ONLY IF that account also has at least one `repo_reviewers`
-- row. With no bot row the planner eliminates the account before the `::jsonb` cast is evaluated,
-- no exception fires, and every tenant migrates — i.e. it behaves exactly like this file.
-- json_valid() here degrades '[oops' to '[]' unconditionally, so the corrupt tenant is skipped
-- and every other one migrates in BOTH scenarios. Since both dialects record the migration as
-- applied and NEVER retry, an affected tenant stays on the read-time fallback permanently —
-- fixing the blob and re-running by hand is the recovery, and it works.
--
-- Requires SQLite >= 3.33 (UPDATE…FROM era) + JSON1; the bundled better-sqlite3 ships 3.43+.
--
-- RETIREMENT: drop `bot_cost_json`, `ProSettings.bots.cost`, `parseCost` and the ROI fallback one
-- release after this ships, once `SELECT count(*) FROM pro_settings WHERE bot_cost_json IS NOT
-- NULL` is zero (or every remaining entry has been re-costed inline). There is no write path any
-- more, so the set can only shrink.

-- ── THE LEGACY TARGETS, STUBBED ──────────────────────────────────────────────────────────────
-- The sqlite answer to the pg twin's `to_regclass` guard (sqlite has no conditional DDL and no
-- EXCEPTION block). Both are dropped again at the foot of this file. Column sets mirror what the
-- statement below reads/writes, nothing more.
--
-- ⚠ `account_reviewers` MUST carry `UNIQUE (account_id, author_user_id)`. SQLite resolves an
-- `ON CONFLICT (...)` target against a real unique index at PREPARE time — before it knows the
-- SELECT yields zero rows — so a stub without it raises "ON CONFLICT clause does not match any
-- PRIMARY KEY or UNIQUE constraint" and takes the whole plugin down with it. Spelled as a table
-- constraint rather than a named CREATE UNIQUE INDEX so it cannot collide with, or be skipped by
-- `IF NOT EXISTS` against, an index of the same name left anywhere else.
CREATE TABLE IF NOT EXISTS repo_reviewers (
  account_id integer, repo_id integer, author_user_id integer, automated integer,
  role text, confidence text, source text, reasons_json text, updated_at integer
);
CREATE TABLE IF NOT EXISTS account_reviewers (
  account_id integer, author_user_id integer, kind text, label text,
  identity_source text, monthly_cents integer,
  UNIQUE (account_id, author_user_id)
);

WITH elem AS (
  -- Layer 2: filter to OBJECT elements here, so nothing below ever extracts from a scalar.
  SELECT ps.account_id AS account_id,
         e.value       AS val
    FROM pro_settings ps,
         json_each(
           CASE WHEN json_valid(ps.bot_cost_json)
                THEN CASE WHEN json_type(ps.bot_cost_json) = 'array'
                          THEN ps.bot_cost_json ELSE '[]' END
                ELSE '[]' END
         ) e
   WHERE ps.bot_cost_json IS NOT NULL
     AND e.type = 'object'
),
cost_entry AS (
  SELECT account_id,
         json_extract(val, '$.login')      AS login,
         json_extract(val, '$.monthlyUsd') AS usd,
         json_type(val, '$.login')         AS login_type,
         json_type(val, '$.monthlyUsd')    AS usd_type
    FROM elem
),
priced AS (
  -- THREE THINGS ARE HAPPENING IN ONE EXPRESSION; read it inside-out.
  --   * `CASE WHEN ce.usd < 0 THEN 0` is the negative clamp, written as a CASE rather than
  --     SQLite's 2-arg scalar max() so it is not one word away from the aggregate MAX below.
  --   * `CAST(… * 100 + 0.5 AS INTEGER)` is the shared rounding rule — see the header. CAST
  --     truncates toward zero, and the operand is non-negative by the clamp, so this is floor().
  --   * `min(2147483647, …)` is the UPPER clamp — SQLite's 2-ARGUMENT min() is the SCALAR one
  --     (the 1-argument form is the aggregate), applied AFTER the cast so a value that already
  --     saturated int64 still lands on int4 max.
  --   * the outer `MAX(…)` is the AGGREGATE: the per-(account, actor) dedupe.
  --
  -- THE UPPER CLAMP IS NOT DECORATION — IT IS PART OF WHY THE TWO DIALECTS AGREE. The pg twin has
  -- to clamp or `integer out of range` aborts every account's backfill; sqlite's integers are
  -- 64-bit and would have taken the value happily. Measured on the same hostile blob, before this
  -- line: monthlyUsd 99999999999 stored 2147483647 on pg and 9999999999900 here — a value with no
  -- pg representation at all, from identical input. `ReviewerCostBody.monthlyUsd` states the same
  -- bound for the live write path so the route clamps or 400s rather than letting one dialect 500
  -- and the other silently succeed.
  SELECT ce.account_id AS account_id,
         u.id          AS author_user_id,
         MAX(min(2147483647,
                 CAST((CASE WHEN ce.usd < 0 THEN 0 ELSE ce.usd END) * 100 + 0.5 AS INTEGER)))
           AS monthly_cents
    FROM cost_entry ce
    JOIN users u ON lower(u.github_login) = lower(ce.login)
   WHERE ce.usd_type IN ('integer', 'real')
     AND ce.login_type = 'text'
     -- The footprint gate — see the header. No bot row for this actor anywhere in the account
     -- means no row a price could ever be shown on, edited on, or cleared from.
     AND EXISTS (
           SELECT 1 FROM repo_reviewers rr
            WHERE rr.account_id = ce.account_id
              AND rr.author_user_id = u.id
         )
   GROUP BY ce.account_id, u.id
)
INSERT INTO account_reviewers (account_id, author_user_id, monthly_cents)
-- The `WHERE true` is NOT filler and must not be tidied away. SQLite's parser cannot tell an
-- upsert clause from a join constraint in `INSERT … SELECT … FROM x ON CONFLICT`, and raises
-- `near "DO": syntax error`; a WHERE clause terminating the FROM is the documented disambiguator
-- (sqlite.org/lang_upsert.html §"Parsing Ambiguity"). Postgres has no such ambiguity, which is
-- why the twin has no equivalent line — and why this failed only on the sqlite side, at run time.
SELECT account_id, author_user_id, monthly_cents FROM priced WHERE true
-- Fill the price on the actor's existing identity row. `IS NULL` is the whole guard: it makes the
-- statement idempotent AND unable to clobber a price the user has already set inline, including a
-- deliberate 0.
ON CONFLICT (account_id, author_user_id) DO UPDATE
  SET monthly_cents = excluded.monthly_cents
  WHERE account_reviewers.monthly_cents IS NULL;

-- ── THE STUBS, REMOVED ───────────────────────────────────────────────────────────────────────
-- Safe unconditionally: core 0045 drops the real tables before any plugin migration runs, so a
-- table of either name at this point can only be the stub created 60 lines up. Leaving them
-- behind would be worse than cosmetic — an empty `repo_reviewers` sitting next to the live
-- `workspace_reviewers` is a second, differently-keyed answer to "is this login a bot", which is
-- exactly the shape core 0042 dropped `bot_review_classification` to avoid.
--
-- THE PG TWIN HAS NO EQUIVALENT DROP, and that is not an oversight to "harmonise": it CREATES
-- nothing, because `to_regclass` lets it skip the work outright. Only this file has stubs of its
-- own to clean up. Verified both ways — with the legacy tables genuinely present the pg file
-- still performs its original backfill and leaves them for core pg 0032 to drop.
DROP TABLE IF EXISTS repo_reviewers;
DROP TABLE IF EXISTS account_reviewers;
