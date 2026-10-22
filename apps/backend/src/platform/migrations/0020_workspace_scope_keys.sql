-- @pierre/pro plugin migration (SQLite / local mode). Run once by the host's runPluginMigrations
-- (tracked in pro_migrations — plugin migrations are discovered by FILENAME SORT and have NO
-- meta/_journal.json; that requirement is CORE-only, do not add one). Postgres twin:
-- migrations-pg/0020_workspace_scope_keys.sql.
--
-- TEAMS BECAME WORKSPACES. This file drags the plugin's own persisted state across the same line
-- core migrations 0044/0045 drew, and it does TWO separate jobs that arrived here for two
-- different reasons. Read them as two halves:
--
--   PART A  the legacy per-bot PRICE, absorbed from plugin 0019 (which is now a no-op — see the
--           banner at the top of 0019_bot_cost_to_account_reviewers.sql). 0019 wrote
--           `account_reviewers.monthly_cents`; core 0045 dropped that table. On a database
--           upgrading from a pre-0043 release, 0019 no-ops, so THIS file is the only remaining
--           path from `pro_settings.bot_cost_json` to a stored price — now
--           `workspace_reviewers.monthly_cents`.
--
--   PART B  every plugin row carrying a `scope_key`. The COLUMN NAME does not change (renaming
--           it across six tables and two dialects buys nothing); the VALUE VOCABULARY does, to
--           `ws:<workspaceId>`.
--
-- ── WHY THE `ws:` PREFIX AND NOT A BARE NUMBER ───────────────────────────────────────────────
-- Workspace ids ARE the old team ids (core 0044 preserves them deliberately). A bare `'3'` would
-- therefore be indistinguishable from the legacy `'3'` that meant team 3 — whose repo set is NOT
-- necessarily workspace 3's, because 0044 step 3's earliest-assignment tie-break can SHRINK a
-- workspace relative to its predecessor team. An un-prefixed value would silently serve a cached
-- AI report computed over one repo set as the answer for another. The prefix makes "already
-- migrated" a decidable property of the value itself, which is also what makes every statement
-- below idempotent (`NOT LIKE 'ws:%'`).
--
-- ── EVERY PLUGIN TABLE WITH A SCOPE-DERIVED KEY, AND WHAT HAPPENS TO IT ──────────────────────
-- Six tables carry `scope_key`. They split on ONE question: is the row model output, or is it
-- something a human wrote?
--
--   sprint_reports        DELETE   Haiku output keyed by an inputs hash. Regenerable, $0 to
--   preset_reports        DELETE   re-derive on unchanged input, and serving a stale one against
--   bot_theme_reports     DELETE   a mismatched repo set is the exact failure the prefix exists
--   human_theme_reports   DELETE   to prevent. Deleting is cheaper than reasoning about it.
--
--   pinned_prompts        RE-KEY   the text is a question the USER typed. Not regenerable.
--   sprint_chat_history   RE-KEY   a past Q&A transcript the user asked to keep. Not regenerable.
--
-- A seventh, `retro_reports`, also carried `scope_key` (added by 0010) and is deliberately NOT
-- referenced here: migration 0018 DROPPED it. `pro_settings` has no `scope_key` (its bot columns
-- are account-wide), and the remaining plugin tables — repo_digests, review_learnings, ai_fixes,
-- ai_pr_analyses, addressed_checks, comment_assessments, pr_comment_annotations — are keyed by
-- repo id, PR id or review id, never by scope. That is the complete enumeration.
--
-- ⚠ `migrations/0007_comparison_mode.sql` and `0010_team_scope.sql` MUST STAY. A database
-- replaying from empty runs them before it reaches this file. Do not delete or rewrite them, and
-- do not rename the `scope_key` column they create.
--
-- ── THE RE-KEY IS BY CASE, NOT A BLANKET MOVE TO DEFAULT ─────────────────────────────────────
-- Core 0044 preserves the team ids precisely so cache rows can follow them. Sending them all to
-- Default throws that mapping away and files a transcript asked in team 5's context somewhere
-- chat.ts's `eq(scopeKey, …)` filter will never surface again.
--
--   '<n>' (a bare team id)     → 'ws:<n>', PROVIDED a workspace n exists for that account (it
--                                does, unless the team had been deleted); otherwise the Default.
--   'none'                     → 'ws:<default>' — those repos genuinely land in Default under
--                                0044 step 4.
--   'all' / 'teams' / 'teams:…'→ 'ws:<default>' — no single image exists.
--
-- Both target indexes are PLAIN, not unique (`pinned_prompts_account_scope`,
-- `sch_account_created`), so collapsing several legacy keys onto one `ws:` value cannot raise.
--
-- Accepted, and the reason the four report tables are deleted rather than re-keyed: a re-keyed
-- transcript may reference PRs from a repo that has since moved workspaces (the 0044 tie-break
-- again). It is timestamped history, not a cached answer, so that is fine.
--
-- ── TWO MECHANICAL CONSTRAINTS ON THIS FILE, BOTH EASY TO VIOLATE ────────────────────────────
--  1. NO core-migrator statement-breakpoint markers (the arrow-prefixed comment the drizzle
--     migrator splits on). pro/migrate.ts `execRaw` hands the WHOLE file to better-sqlite3's
--     `Database.exec` (or pg's `Pool.query`) as one blob; that marker is CORE-migrator syntax
--     and is not valid SQL. No plugin migration contains it, not even inside a comment — a
--     grep-based guard cannot tell the two apart, so keep the literal out of this file entirely.
--  2. SQLite has no conditional DDL and no EXCEPTION block, so nothing here may be allowed to
--     raise: pro/migrate.ts rethrows, bind.ts logs `pro register() failed — OSS mode`, and the
--     ENTIRE plugin goes dark with no error a user would connect to a migration. Every statement
--     below therefore reads only tables that certainly exist at this point — the plugin's own
--     (earlier plugin migrations, applied in filename order) and core's `users` / `workspaces` /
--     `workspace_reviewers` (core runMigrations() always completes before bindProPlugin()).
--
-- ORDER IS DELIBERATE: PART B RUNS FIRST. `Database.exec` commits each statement as it goes and
-- pro_migrations is only stamped after the whole file succeeds, so if Part A ever did raise, Part
-- B is already committed and the retry on next boot is a no-op for it (`NOT LIKE 'ws:%'`) — the
-- D8 requirement is satisfied even in the failure case. The reverse order would leave stale
-- scope tokens behind a failing JSON parse.
--
-- The `pro_settings.bot_cost_json` blob is NOT dropped by this file. It stays a deprecated,
-- read-only, null-only client fallback for logins that could not be attached to a bot row.

-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- PART B — SCOPE KEYS
-- ═════════════════════════════════════════════════════════════════════════════════════════════

-- Regenerable model output. Blanket DELETE rather than a `WHERE scope_key NOT LIKE 'ws:%'`: no
-- row can carry a `ws:` key before this migration, so the predicate would only be decoration —
-- and a blanket delete is idempotent by construction if this file is ever replayed.
DELETE FROM sprint_reports;
DELETE FROM preset_reports;
DELETE FROM bot_theme_reports;
DELETE FROM human_theme_reports;

-- User-authored. Re-keyed by case, never deleted.
--
-- The `EXISTS` guard is NOT decoration: without it, a row whose account somehow has no Default
-- workspace would take `COALESCE(NULL, NULL)` → `'ws:' || NULL` → NULL, and `scope_key` is NOT
-- NULL — a raise, i.e. the whole plugin dark. With it, such a row is simply left alone.
-- `NOT LIKE 'ws:%'` is what makes a re-run a no-op.
UPDATE pinned_prompts
   SET scope_key = 'ws:' || COALESCE(
         (SELECT w.id FROM workspaces w
           WHERE w.account_id = pinned_prompts.account_id
             AND CAST(w.id AS TEXT) = pinned_prompts.scope_key),
         (SELECT w.id FROM workspaces w
           WHERE w.account_id = pinned_prompts.account_id AND w.is_default = 1))
 WHERE scope_key NOT LIKE 'ws:%'
   AND EXISTS (SELECT 1 FROM workspaces w
                WHERE w.account_id = pinned_prompts.account_id AND w.is_default = 1);

UPDATE sprint_chat_history
   SET scope_key = 'ws:' || COALESCE(
         (SELECT w.id FROM workspaces w
           WHERE w.account_id = sprint_chat_history.account_id
             AND CAST(w.id AS TEXT) = sprint_chat_history.scope_key),
         (SELECT w.id FROM workspaces w
           WHERE w.account_id = sprint_chat_history.account_id AND w.is_default = 1))
 WHERE scope_key NOT LIKE 'ws:%'
   AND EXISTS (SELECT 1 FROM workspaces w
                WHERE w.account_id = sprint_chat_history.account_id AND w.is_default = 1);

-- The `scope_key` column DEFAULTs stay `'all'` in both schema files. That is a harmless legal
-- string: after this migration no row uses it, and every writer supplies the value explicitly.
-- Changing a column default is a migration nobody needs.

-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- PART A — THE LEGACY PER-BOT PRICE (absorbed from plugin 0019)
-- ═════════════════════════════════════════════════════════════════════════════════════════════
--
-- UPDATE ONLY, NEVER INSERT — and that is a correctness rule, not a style choice. A row in
-- `workspace_reviewers` carries `automated`, `confidence` and `source` alongside the price;
-- fabricating one to hang a price on would invent judgements nobody made, and a fabricated
-- `source = 'manual'` row would permanently shadow auto-detection for that actor (persist()
-- declines to re-derive a row a human owns, and the listing's lazy re-derive triggers on a
-- MISSING row, which a fabricated one is not). The join to `workspace_reviewers` below IS the
-- footprint gate plugin 0019 spelled as `EXISTS (SELECT 1 FROM repo_reviewers …)`: no bot row,
-- no price — a price with no row to display, edit or clear on is unreachable data.
--
-- APPLIED TO EVERY WORKSPACE ROW OF THAT ACTOR. This is a ONE-TIME SEED of a value that used to
-- be account-wide, exactly like core 0045's copy of `kind`/`label`/`monthly_cents` — NOT an
-- invariant to maintain. From here on price is a per-workspace fact: setReviewerCost writes ONE
-- row, nothing fans out, and the copies diverge freely as the user edits them.
--
-- `monthly_cents IS NULL` is the whole guard, and it has exactly one meaning: NULL = "no price
-- set", `0` = "recorded as free". Nothing inherits, so the guard makes this idempotent AND
-- unable to clobber a deliberate 0.
--
-- ── THE ROUNDING RULE, INHERITED VERBATIM FROM 0019 ──────────────────────────────────────────
--   cents = floor(usd × 100 + 0.5), evaluated in IEEE-754 binary64, in BOTH dialects.
-- NOT "round to the nearest cent of the exact decimal value", which is a different function: the
-- legacy write path validated monthlyUsd as `{type:number, minimum:0}` with no `multipleOf`, so
-- a fractional-cent price like 1.005 is REACHABLE and is not representable in binary64. Computed
-- in `numeric`, pg gave 101 cents where sqlite gave 100; `round(double precision)` does not fix
-- it either (half-to-EVEN here, half-away-from-zero there). `floor(x * 100 + 0.5)` over a double
-- depends on nothing but IEEE-754, so the two dialects agree by construction. See 0019's header
-- for the measured fixture values.
--
-- ── MALFORMED-JSON SAFETY (four layers, all four needed) ─────────────────────────────────────
-- Reproduced from 0019 unchanged, because a raise here costs the user the whole plugin:
--   1. `json_each()` RAISES on a non-JSON argument, and so does `json_type(x)` — so the guard is
--      a NESTED CASE, not `json_valid(x) AND json_type(x) = 'array'`: only CASE is documented to
--      evaluate just the selected branch, whereas SQLite may evaluate both sides of an AND.
--   2. json_each over an ARRAY still yields scalar elements, and `json_extract('x','$.login')`
--      raises "malformed JSON" on those — so the `e.type = 'object'` filter lives in its OWN CTE
--      and nothing extracts from an element until it is known to be an object.
--   3. `usd_type IN ('integer','real')` drops a non-numeric monthlyUsd instead of coercing it to
--      0 and quietly telling the user their $120 bot is free.
--   4. `login_type = 'text'` drops a non-string login — the mirror image of the pg twin's
--      `jsonb_typeof(e->'login') = 'string'`. Without both, `{"login":123}` matched a user
--      literally named "123" on pg and was excluded on sqlite, from the same blob.
--
-- `min(2147483647, …)` is the UPPER clamp — SQLite's 2-ARGUMENT min() is the SCALAR one (the
-- 1-argument form is the aggregate), applied AFTER the CAST so a value that already saturated
-- int64 still lands on int4 max. It is not decoration: `monthly_cents` is int4 on Postgres, which
-- RAISES `integer out of range` where sqlite's 64-bit integers accept the value happily. The
-- outer MAX() is the AGGREGATE — the per-(account, actor) dedupe, so one account's blob cannot
-- present the same key twice. `CASE WHEN ce.usd < 0 THEN 0` is the lower clamp, written as a CASE
-- so it is not one word away from that MAX.
--
-- Kind-keyed legacy entries (an older blob shape) remain unmigratable — a kind names a BRAND, not
-- an actor, so there is no author_user_id to key on, and the kind→login map lives in
-- packages/shared, not in SQL. They stay in the blob and keep driving the read-time fallback.
--
-- `UPDATE … FROM` requires SQLite >= 3.33; the bundled better-sqlite3 ships 3.43+. It is spelled
-- the same way in the pg twin, so the two files stay diffable.
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
  SELECT ce.account_id AS account_id,
         u.id          AS author_user_id,
         MAX(min(2147483647,
                 CAST((CASE WHEN ce.usd < 0 THEN 0 ELSE ce.usd END) * 100 + 0.5 AS INTEGER)))
           AS monthly_cents
    FROM cost_entry ce
    JOIN users u ON lower(u.github_login) = lower(ce.login)
   WHERE ce.usd_type IN ('integer', 'real')
     AND ce.login_type = 'text'
   GROUP BY ce.account_id, u.id
)
UPDATE workspace_reviewers
   SET monthly_cents = p.monthly_cents
  FROM priced p
 WHERE p.account_id     = workspace_reviewers.account_id
   AND p.author_user_id = workspace_reviewers.author_user_id
   AND workspace_reviewers.monthly_cents IS NULL;
