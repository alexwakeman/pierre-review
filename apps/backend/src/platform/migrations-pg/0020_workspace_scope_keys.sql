-- @pierre/pro plugin migration (Postgres / cloud mode) — the twin of
-- migrations/0020_workspace_scope_keys.sql. Run once by the host's runPluginMigrations (tracked
-- in pro_migrations; discovered by FILENAME SORT, no journal — that is a CORE-only requirement).
--
-- TEAMS BECAME WORKSPACES. Same two halves as the sqlite twin; read that file for the full
-- rationale, which is not repeated here:
--
--   PART B  every plugin row carrying a `scope_key`. Column name unchanged, VALUE VOCABULARY
--           becomes `ws:<workspaceId>`. Four regenerable report caches are DELETEd; the two
--           user-authored tables are RE-KEYED BY CASE.
--   PART A  the legacy per-bot PRICE, absorbed from plugin 0019 (now a no-op — core pg 0032
--           dropped `account_reviewers`, the table 0019 wrote). This is the only remaining path
--           from `pro_settings.bot_cost_json` to a stored price on a database upgrading from a
--           pre-0030 release.
--
-- ── THE COMPLETE ENUMERATION OF SCOPE-KEYED PLUGIN TABLES ────────────────────────────────────
--   sprint_reports · preset_reports · bot_theme_reports · human_theme_reports  → DELETE
--     (regenerable Haiku output keyed by an inputs hash; serving one against a mismatched repo
--      set is the exact failure the `ws:` prefix exists to prevent)
--   pinned_prompts · sprint_chat_history                                       → RE-KEY BY CASE
--     (a question the user typed / a transcript they asked to keep — not regenerable)
-- A seventh, `retro_reports`, carried `scope_key` too and is deliberately absent: migration 0018
-- DROPPED it. `pro_settings` has no `scope_key`; repo_digests / review_learnings / ai_fixes /
-- ai_pr_analyses / addressed_checks / comment_assessments / pr_comment_annotations key on repo,
-- PR or review id, never on scope.
--
-- ⚠ `migrations-pg/0007_comparison_mode.sql` and `0010_team_scope.sql` MUST STAY — a database
-- replaying from empty runs them before it reaches this file.
--
-- ── TWO MECHANICAL CONSTRAINTS ───────────────────────────────────────────────────────────────
--  1. NO core-migrator statement-breakpoint markers (the arrow-prefixed comment the drizzle
--     migrator splits on). pro/migrate.ts `execRaw` hands the WHOLE file to `Pool.query` as one
--     blob; that marker is CORE-migrator syntax and is not valid SQL. Keep the literal out of
--     this file entirely, comments included — a grep-based guard cannot tell the two apart.
--  2. Every statement is wrapped in a `DO $$ … EXCEPTION WHEN others THEN RAISE WARNING … END`
--     block. pro/migrate.ts RETHROWS on any plugin-migration failure and bind.ts then degrades
--     the ENTIRE plugin to OSS mode — every capability false, every /api/pro/* 404, silently. A
--     migration that only DELETEs regenerable rows and re-keys its own text is the safest
--     possible thing to downgrade to a warning; losing the plugin is not.
--
-- ── WHY TWO DO BLOCKS AND NOT ONE ────────────────────────────────────────────────────────────
-- A DO block is ONE statement: any error inside it rolls back everything it did. Part A parses a
-- hand-editable JSON blob and is the only thing here that can realistically raise; Part B is pure
-- DELETE/UPDATE over this plugin's own tables. Sharing a block would let a single tenant's
-- corrupt `bot_cost_json` roll back the scope re-key for EVERY tenant — and since pro_migrations
-- records the file as applied either way, those stale scope tokens would never be revisited,
-- which is precisely the D8 failure this migration exists to prevent. Separate blocks make the
-- two failures independent. (The sqlite twin gets the same property from statement ordering:
-- `Database.exec` commits as it goes and Part B runs first.)
--
-- The `pro_settings.bot_cost_json` blob is NOT dropped. It stays a deprecated, read-only,
-- null-only client fallback for logins that could not be attached to a bot row.

-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- PART B — SCOPE KEYS
-- ═════════════════════════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  -- Regenerable model output. Blanket DELETE rather than `WHERE scope_key NOT LIKE 'ws:%'`: no
  -- row can carry a `ws:` key before this migration, so the predicate would only be decoration —
  -- and a blanket delete is idempotent by construction if this file is ever replayed.
  DELETE FROM sprint_reports;
  DELETE FROM preset_reports;
  DELETE FROM bot_theme_reports;
  DELETE FROM human_theme_reports;

  -- User-authored. Re-keyed by case, never deleted:
  --   '<n>' (a bare team id)      → 'ws:<n>' when a workspace n exists for that account (core
  --                                 0031 preserves the team ids precisely so this mapping holds)
  --   'none'                      → the Default (those repos land there under 0031 step 4)
  --   'all' / 'teams' / 'teams:…' → the Default (no single image exists)
  --
  -- The `EXISTS` guard is NOT decoration: without it a row whose account somehow has no Default
  -- workspace takes `COALESCE(NULL, NULL)` → `'ws:' || NULL` → NULL, and `scope_key` is NOT NULL.
  -- `NOT LIKE 'ws:%'` is what makes a re-run a no-op. Both target indexes are PLAIN, not unique
  -- (`pinned_prompts_account_scope`, `sch_account_created`), so collapsing several legacy keys
  -- onto one `ws:` value cannot raise.
  --
  -- `is_default` is a real boolean here; the sqlite twin compares it to 1. That is the only
  -- difference between the two files' Part B.
  UPDATE pinned_prompts
     SET scope_key = 'ws:' || COALESCE(
           (SELECT w.id FROM workspaces w
             WHERE w.account_id = pinned_prompts.account_id
               AND CAST(w.id AS TEXT) = pinned_prompts.scope_key),
           (SELECT w.id FROM workspaces w
             WHERE w.account_id = pinned_prompts.account_id AND w.is_default))
   WHERE scope_key NOT LIKE 'ws:%'
     AND EXISTS (SELECT 1 FROM workspaces w
                  WHERE w.account_id = pinned_prompts.account_id AND w.is_default);

  UPDATE sprint_chat_history
     SET scope_key = 'ws:' || COALESCE(
           (SELECT w.id FROM workspaces w
             WHERE w.account_id = sprint_chat_history.account_id
               AND CAST(w.id AS TEXT) = sprint_chat_history.scope_key),
           (SELECT w.id FROM workspaces w
             WHERE w.account_id = sprint_chat_history.account_id AND w.is_default))
   WHERE scope_key NOT LIKE 'ws:%'
     AND EXISTS (SELECT 1 FROM workspaces w
                  WHERE w.account_id = sprint_chat_history.account_id AND w.is_default);

  -- The `scope_key` column DEFAULTs stay `'all'` in both schema files. Harmless: after this
  -- migration no row uses it, and every writer supplies the value explicitly.
EXCEPTION WHEN others THEN
  RAISE WARNING 'pro 0020: workspace scope_key migration skipped (%). Cached AI reports and pinned/chat scope keys still carry legacy team scope tokens and will not resolve to a workspace.', SQLERRM;
END $$;

-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- PART A — THE LEGACY PER-BOT PRICE (absorbed from plugin 0019)
-- ═════════════════════════════════════════════════════════════════════════════════════════════
--
-- UPDATE ONLY, NEVER INSERT — a correctness rule, not a style choice. A `workspace_reviewers` row
-- carries `automated`, `confidence` and `source` alongside the price; fabricating one to hang a
-- price on would invent judgements nobody made, and a fabricated `source = 'manual'` row would
-- permanently shadow auto-detection (persist() declines to re-derive a row a human owns, and the
-- listing's lazy re-derive triggers on a MISSING row, which a fabricated one is not). The join to
-- `workspace_reviewers` IS the footprint gate plugin 0019 spelled as
-- `EXISTS (SELECT 1 FROM repo_reviewers …)`.
--
-- APPLIED TO EVERY WORKSPACE ROW OF THAT ACTOR — a ONE-TIME SEED of a value that used to be
-- account-wide, exactly like core 0032's copy of kind/label/monthly_cents, NOT an invariant.
-- Price is a per-workspace fact from here on and the copies diverge freely.
--
-- `monthly_cents IS NULL` is the whole guard, with exactly one meaning: NULL = "no price set",
-- `0` = "recorded as free". Idempotent, and unable to clobber a deliberate 0.
--
-- THE ROUNDING RULE, inherited verbatim from 0019: cents = floor(usd × 100 + 0.5) in IEEE-754
-- binary64, in BOTH dialects. KEEP THE `::double precision` CASTS. Reverting to `::numeric` is
-- exact decimal and silently reintroduces a measured divergence from sqlite (1.005 → 101 here vs
-- 100 there); `round(double precision)` is not the fix either — half-to-EVEN here,
-- half-away-from-zero there.
--
-- `LEAST(2147483647, …)` caps at int4 max (~$21,474,836.47). Without it one absurd-but-well-formed
-- price raises `integer out of range`, while sqlite's 64-bit integers take the same blob happily.
-- The twin clamps too, with `min(2147483647, …)`.
--
-- `jsonb_typeof(e->'login') = 'string'` is the mirror image of the twin's
-- `json_type(val, '$.login') = 'text'`: without both, `->>` stringifies a numeric login and joins
-- it — `{"login":123}` matched a user literally named "123" here and was excluded there.
--
-- ── WHY THIS IS A PER-ACCOUNT LOOP AND NOT ONE SET-BASED STATEMENT ───────────────────────────
-- ⚠ MEASURED, on PostgreSQL 16 against this file's own hostile-blob fixture. `bot_cost_json` is a
-- TEXT column, so `::jsonb` on a hand-corrupted value RAISES. Written as one statement over
-- `pro_settings`, a SINGLE tenant whose blob is `'[oops'` — well-formed enough to pass any regex
-- pre-filter, not well-formed enough to cast — raised inside the DO block and rolled back EVERY
-- OTHER TENANT'S PRICES, silently, behind one WARNING. The sqlite twin migrated the same fixture
-- correctly, because `json_valid()` degrades that value to '[]' row by row and only the corrupt
-- tenant is skipped.
--
-- Plugin 0019 had the same shape and mostly got away with it: its `EXISTS (… repo_reviewers …)`
-- semi-join let the planner eliminate a corrupt account BEFORE evaluating the cast, so the blast
-- radius depended on whether that account happened to have a bot row. Here the footprint gate is
-- the UPDATE's own join, which cannot eliminate anything before the CTE is built — so the bad
-- case is the ONLY case. Not a hazard worth re-deriving in a year.
--
-- The loop gives each account its own BEGIN/EXCEPTION subtransaction, so a corrupt blob skips
-- exactly that tenant, with a warning naming it, and every other tenant migrates — the sqlite
-- behaviour, reached by the one mechanism Postgres offers for per-row error recovery. It costs a
-- subtransaction per account THAT HAS A NON-NULL BLOB (a deprecated field, so a small minority)
-- in a one-time migration. Deliberately NOT `pg_input_is_valid()`, which would be tidier and is
-- PostgreSQL 16+: nothing in this repo pins the server version (docker-compose is 16, Railway is
-- whatever Railway provisions), and on 15 that function does not exist, the DO block raises at
-- plan time, and the outer handler skips every tenant — reintroducing precisely the failure this
-- structure exists to remove.
--
-- The outer handler is the last line of defence: a raise that escapes to runPluginMigrations
-- costs the user EVERY Pro feature (bind.ts degrades the whole plugin to OSS mode). Skipping this
-- backfill costs them a price that is still sitting in `bot_cost_json`, still driving ROI through
-- the read-time fallback. Do not remove either handler.
--
-- Kind-keyed legacy entries stay unmigratable (a kind names a BRAND, not an actor) and keep
-- driving ROI through the read-time fallback.
DO $$
DECLARE
  acct record;
BEGIN
  -- The regex is a cheap PRE-filter matching the twin's `json_type(...) = 'array'` branch: a blob
  -- that is a JSON object, or plainly not JSON at all, is skipped silently in both dialects. It is
  -- NOT the safety guard — `'[oops'` passes it. The per-iteration handler below is the guard.
  FOR acct IN
    SELECT ps.account_id AS account_id, ps.bot_cost_json AS blob
      FROM pro_settings ps
     WHERE ps.bot_cost_json IS NOT NULL
       AND ps.bot_cost_json ~ '^\s*\['
     ORDER BY ps.account_id
  LOOP
    BEGIN
      WITH priced AS (
        SELECT u.id AS author_user_id,
               MAX(LEAST(2147483647::double precision,
                         floor(GREATEST(0::double precision,
                                        (e->>'monthlyUsd')::double precision) * 100 + 0.5))::integer)
                 AS monthly_cents
          FROM jsonb_array_elements(acct.blob::jsonb) AS e
               JOIN users u ON lower(u.github_login) = lower(e->>'login')
         WHERE jsonb_typeof(e) = 'object'
           AND jsonb_typeof(e->'monthlyUsd') = 'number'
           AND jsonb_typeof(e->'login') = 'string'
         GROUP BY u.id
      )
      UPDATE workspace_reviewers
         SET monthly_cents = p.monthly_cents
        FROM priced p
       -- Tenancy: `users` is a GLOBAL table, so the login join alone proves nothing about
       -- ownership. `account_id = acct.account_id` is what keeps one tenant's blob from pricing
       -- another tenant's bot rows.
       WHERE workspace_reviewers.account_id     = acct.account_id
         AND workspace_reviewers.author_user_id = p.author_user_id
         AND workspace_reviewers.monthly_cents IS NULL;
    EXCEPTION WHEN others THEN
      RAISE WARNING 'pro 0020: legacy bot_cost_json backfill skipped for account % (%). That account''s values remain in pro_settings.bot_cost_json and keep driving ROI via the read-time fallback; every other account still migrated.', acct.account_id, SQLERRM;
    END;
  END LOOP;
EXCEPTION WHEN others THEN
  RAISE WARNING 'pro 0020: legacy bot_cost_json backfill skipped entirely (%). The values remain in pro_settings.bot_cost_json and keep driving ROI via the read-time fallback.', SQLERRM;
END $$;
