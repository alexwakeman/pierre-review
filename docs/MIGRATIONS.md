# Migrations, history & known gaps

> Split out of CLAUDE.md (2026-08) to keep the root memory file lean. This is the
> authoritative deep-dive for this area; CLAUDE.md keeps only the summary and the
> cross-cutting landmines. Add new detail HERE, not to CLAUDE.md. References to other
> sections of the old CLAUDE.md resolve via the doc map at the top of CLAUDE.md.

## History & planning

SQLite migrations (`0000`+) track the schema's evolution — `0008_multitenant_accounts`
added the `accounts` table + `accountId` + composite uniques; `0009`/`0010` added lean
storage; `0013` Claude-review routing (`reviewMode`/`routeReason`); `0014`
`accounts.lastActiveAt`; `0026` `accounts.aiCreditAllowance`; the **Bot-Triage** trio `0027`
(`users.github_type`), `0028` (`bot_review_classification`), `0029` (`bot_mute_rules`) — pg
baseline `0016`, plus plugin migration `0009` (`pro_settings` + 11 `bot_*` columns); `0037`
(pg `0024`) the four `author_id` indexes the contributor popover needs. The **merge / CI / trunk**
batch adds `0038` (pg `0025`) `auto_merge_requests`; `0039` (pg `0026`) the four `repos`
default-branch columns + `branch_commits`; `0040` (pg `0027`) `pull_requests.review_decision`;
`0041` (pg `0028`) `branch_commits.failing_checks` + `.pr_number` + the
`(account_id, repo_id, number)` PR index the commit→PR resolution needs — all additive and
nullable, so there is no backfill (the branch sync re-upserts the same window every tick, and the
read resolves null → `[]`/null meanwhile). `0042`/`0043` (pg `0029`/`0030`) RE-KEYED the bot object
from (account, author) to (account, REPO, author) and then NORMALISED the actor-grain columns out
into `account_reviewers`; **`0044`/`0045` (pg `0031`/`0032`) superseded both** and are, again, ONE
change in two steps — read them together:

```
0044 / pg 0031  RE-HOME   repo grouping:  teams (m2m)  →  workspaces (1:N), + a Default per account
0045 / pg 0032  COLLAPSE  the bot object: repo_reviewers + account_reviewers → workspace_reviewers
```

**`0044`** creates `workspaces` + `workspace_repos`, backfills one workspace per existing team
**WITH THE TEAM IDS PRESERVED** (a URL, a bookmark, a persisted filter and — after plugin `0020` —
a cache row all carry the number; renumbering would silently repoint them at a different repo set),
adds a Default per account under a **three-level name fallback** (`Default` → `Default workspace` →
`Default (workspace <accountId>)`, because `workspaces_account_name` is unique and a user may
already own a team literally called "Default"), gives every repo exactly one membership (a repo in
2+ teams keeps its EARLIEST assignment; anything left over goes to Default), creates the partial
unique `workspaces_one_default` **after** the Default backfill, and DROPS `team_repos` then `teams`.
**`0045`** creates `workspace_reviewers`, folds the per-repo judgements up to the workspace
(`automated` = union; `role` = `'review'` if ANY contributing row says so; `confidence` = the
highest among the rows on the WINNING side of `automated`), copies the actor's `kind`/`label`/
`identity_source`/`monthly_cents` into **every** workspace row of that actor as a one-time seed, and
DROPS both legacy tables. Two fold rules are deliberate and were argued out rather than defaulted:
- **`source` folds to `'manual'` if ANY contributing row was manual, even when the union sent
  `automated` the other way.** It is not the read-time union rule, and that is the point: `source`
  is also the WRITE GATE in `persist` and the flag behind "Reset classification". Folding to auto
  would let the next pass silently overwrite a human's opinion with no control offered to undo it.
  A visible, resettable pin beats a judgement that vanishes — and the one lossy case (a manual row
  that LOST) gets an explicit `⚠ conflicting per-repo judgements were merged — review this` string
  in the synthesised `reasons_json` so it is on the card rather than inferred.
- **The migrated `source` is never the literal `'auto'`** — that is the `identity_source`
  vocabulary, not a `ClassificationSource` member, and an out-of-union value would never self-heal
  (`persist` only revisits rows it derives, and the listing's lazy trigger is a MISSING row, which
  after this migration no actor has). It carries the winning row's OWN source, `'fingerprint'` as
  the fallback.

`monthly_cents` needs no CORE backfill: on this branch's databases the values are already in
`account_reviewers` and `0045` folds them in. **Plugin `0019` is now a guarded NO-OP** — it read
`repo_reviewers` and wrote `account_reviewers`, both of which core `0045` drops, and core migrations
ALWAYS run first (`index.ts` completes `runMigrations()` before `bindProPlugin()` →
`ctx.registerMigrations` → `runPluginMigrations`), so unfixed it would raise "no such table" on
every database that had not already applied it — fresh installs, fresh cloud deploys, the demo
seeder, CI. ⚠ **That failure is TOTAL and SILENT**: `pro/migrate.ts` rethrows, `bind.ts` logs
`pro register() failed — OSS mode`, every capability goes false and every `/api/pro/*` 404s with
nothing thrown. It is fixed by stubbing the two legacy tables and dropping them again (sqlite) /
a `to_regclass` guard (pg), which is safe precisely because core always drops them first.
**Plugin `0020` does two jobs**: (A) it ABSORBS `0019`'s backfill for databases upgrading from a
pre-`0043` release, reading `pro_settings.bot_cost_json` straight into
`workspace_reviewers.monthly_cents` under the same rules — **UPDATE only, never INSERT** (fabricating
a row would invent `automated`/`confidence`/`source` judgements nobody made, and a fabricated
`source='manual'` row would permanently shadow auto-detection), guarded on `monthly_cents IS NULL`
so it is idempotent and can never clobber a deliberate `0`, and it does not drop the blob — unmatched
logins keep driving ROI through the client's read-time fallback; and (B) it moves the six `scope_key`
tables to the `ws:<workspaceId>` vocabulary — **the four regenerable REPORT caches are DELETED, the
two USER-AUTHORED tables (`pinned_prompts`, `sprint_chat_history`) are RE-KEYED BY CASE** (`'<n>'` →
`'ws:<n>'` where that workspace exists, everything else → the Default), because `0044` preserves the
ids precisely so cache rows can follow them and a blanket move to Default would file a transcript
where its own workspace can never surface it. ⚠ **Plugin migrations take NO
`--> statement-breakpoint`** (the runner hands the whole file to `client.exec`/`Pool.query`; the
marker is core-migrator syntax and is not valid SQL), and the pg twin wraps its work in
`DO $$ … EXCEPTION WHEN others THEN RAISE WARNING …` exactly like pg `0019` — a failure here would
cost the user every Pro feature, and `0020` is pure DELETE/UPDATE over regenerable or re-keyable
rows, i.e. the safest possible thing to downgrade to a warning. `packages/pro/migrations/
0007_comparison_mode.sql` and `0010_team_scope.sql` **must STAY**: a database replaying from empty
runs them before reaching `0020`. Plugin migration `0017` adds `pr_comment_annotations` (+ backfills
`comment_assessments` as `kind='validity'`); plugin `0018` **DROPS `retro_reports`** (both
dialects) — `0008`/`0010`, which create and widen it, must STAY, since a database replaying from
empty still runs them first.
**`0046` (pg `0033`) DROPS the two "watched" columns** — `repos.inbox_watch` and
`repos.inbox_watch_started_at` — and with them the whole second visibility axis (see the `repos`
bullet under **Data model**). It is a pure `DROP COLUMN` pair with no backfill, because the property
worth keeping already had a home: the "New PRs" cutoff moved to `repos.created_at`, which is NOT
NULL, is written on insert, and for any repo added under the old model IS the moment watching
started. Two things to know if you touch it:
- **SQLite really can drop these.** `ALTER TABLE … DROP COLUMN` refuses a column that is a PK, is
  UNIQUE, is INDEXED, or is named in a partial index / CHECK / FK / generated column. Neither
  qualifies — the four indexes on `repos` are `repos_account_owner_name`, `repos_account_node`,
  `repos_account_idx` and `repos_id_account`, and none mentions either column — so no 12-step table
  rebuild is needed. That was CHECKED against a real database, not assumed; re-check before adding a
  `DROP COLUMN` for anything else.
- **The two files are deliberately NOT symmetrical.** The pg twin uses `DROP COLUMN IF EXISTS`; the
  sqlite one cannot, because SQLite has no such clause. drizzle's migrator records each file once so
  a normal run is fine, but the sqlite file is **not hand-replayable**.

**BOTH journals are hand-maintained, and the pg half is the one that gets forgotten.**
`run-migrations.ts` picks the folder AND the migrator by mode, and each migrator reads its OWN
folder's `meta/_journal.json` — a file that is not registered **SILENTLY SKIPS**. sqlite entries are
`"version": "6"`, **pg entries are `"version": "7"`**; `0038`–`0047` and pg `0025`–`0034` are
registered. (Plugin migrations are discovered by filename sort and have NO journal — that
requirement is core-only, do not add one.) An unregistered pg file produces a perfectly
successful-looking boot that then 500s on a missing relation for every query. **Do not run
`pnpm db:generate:pg` for an incremental change** — it squashes the baseline; `0031`/`0032` are
hand-written additive, exactly like `0029`/`0030`, and so is `0033`.

**Eight places the two dialects genuinely diverge in `0044`/`0045` vs `0031`/`0032`**, none of which
may be "harmonised": pg `serial` does NOT advance on an explicit-id INSERT, so `0031` needs a
`setval` between the team-id-preserving insert and the Default backfill (without it the Default
insert takes `nextval = 1`, collides with preserved team id 1, and **the migration aborts and cloud
never boots** — and its `is_called` third argument must be false on an empty table so a fresh
deploy's first workspace is id 1, not 2); pg has no `max(boolean)` so `0032` uses `bool_or`; boolean
literals (`is_default = 1` vs bare `is_default`); **integer flags inside a pg boolean expression** —
`manual_aut`/`manual_any`/`any_review` are integer `MAX(CASE … 1 ELSE 0 END)` in BOTH dialects, so
`CASE WHEN f.aut AND f.manual_aut THEN …` raises `argument of AND must be type boolean, not type
integer` and aborts the whole migration (it must be `… AND f.manual_aut = 1`); **the pg
`to_regclass` guard covers ONLY the statements that READ `teams`/`team_repos`** — wrapping the
Default backfill and the unassigned-repo sweep as well would make a pg database without `teams`
create zero workspaces and zero memberships while the sqlite twin's stub tables always run them,
i.e. two files implementing two different algorithms; `reasons_json` is `jsonb` in pg so the
synthesised CASE needs `::jsonb`; `WHERE true` before `ON CONFLICT` is a sqlite parsing
disambiguator only; and the partial-index predicate differs (`WHERE is_default = 1` vs
`WHERE is_default`).

The Postgres baseline (`migrations-pg/`) is a squash — cloud starts empty (synced data is
regenerable; no SQLite→Postgres migration). **Postgres was PROVEN once by hand for the migrations
that existed at the time** (through pg `0030`), which retired the standing "the pg twins are
exercised by nothing" gap for those files. It was a POINT-IN-TIME result, not a guarantee: nothing
automated re-checks it and the suite still runs on SQLite only, so **pg `0031`/`0032`/`0033` and plugin
`0020`'s pg twin are unverified until someone repeats the replay** (see the throwaway-container
recipe under Dependency posture, and mind the `DROP SCHEMA public CASCADE` gotcha there — it leaves
drizzle's own `drizzle` schema behind and the migrator then no-ops, reporting success having done
nothing).
**Known gaps on this branch:**
- **The two ACCOUNT-WIDE Pro CRONS now cover the DEFAULT WORKSPACE ONLY** — the Slack digest
  (`slack/report.ts`) and the AI-policy sprint refresh (`ai-policy/scheduler.ts` →
  `refreshSprintReport`). They have no request and therefore no `?workspace=`, and their old
  `scope = 'all'` default has no image under a single-id scope, so both resolve
  `ctx.queries.defaultWorkspaceId(accountId)`. Previously they covered every repo in the account. This is a real behaviour reduction, taken deliberately over iterating all workspaces,
  which would multiply a billed LLM call by workspace count on a `*/5` sweep. **State it in the
  Settings copy for the Slack digest.**
- **PrDetail still classifies bots CLIENT-SIDE by LOGIN** — `ChecksTab`'s "Bots" chips group
  threads by `botVendorMeta(user)` and `ThreadList`'s vendor filter by `threadBotKind`, both
  login→`ReviewBotKind` only. A stored workspace judgement and the `quality_check` role never reach
  that surface (the bulk-resolve OFFER on the same screen DOES consult the classification, so the
  two can disagree by design).
- **pg `0031`/`0032` and plugin `0020`'s pg twin have not been replayed against a real Postgres**
  (see the paragraph above). The unit suite is SQLite-only, so nothing automated covers the eight
  dialect divergences those files carry.
- **The legacy `?team=` URL rule is unit-tested nowhere.** It lives in
  `readWorkspaceFromUrl`/`readFromUrl` in `hooks/useUrlState.ts`, neither of which is exported, so a
  test would pin a copy rather than the code — flagged in `workspaceScope.test.ts`'s own header.
- **`SprintReportCard` has no importer**, yet the plugin's AI-policy sweep (`*/5`) still calls
  `refreshSprintReport` for every account not on `manual` — real spend for a card nothing renders.
  (`PresetPromptPanel` is also importer-less, but its server side is deliberately kept.)
- **`packages/pro/test/` and `apps/frontend/test/` still do not run in CI** (see Tests above) — and
  they now hold the workspace refactor's frontend evidence (`workspaceScope.test.ts`,
  `botReviewerQueryKey.test.ts`) plus the plugin's cross-account isolation suite.
- Auto-merge's retarget guard still compares the last SYNCED base ref rather than a stored
  `expected_base_ref` (see `merge/auto-merge-runner.ts`).

**CLOSED by the Workspace refactor** (recorded so nobody re-opens them from a stale reading):
`?scope=`'s five wire forms and their canonicalisers; the repo-with-no-scope `'none'` bucket; the
rail's "Other" group; the two-table bot split and its per-grain write routes; **and the
manually-RENAMED-actor gap** — an actor renamed but automated nowhere used to lose its
identity-reset control, because `actorSummaries` skipped it and the account-wide card was the only
home of "Reset name to auto". With one row per actor per workspace the row exists; the fix is
completed by the bucket predicate, which is `!automated && (isManualOverride || identitySource ===
'manual')` — ⚠ `isManualOverride` ALONE is not enough, because a *renamed* actor carries
`identitySource === 'manual'` with `source === 'auto'` and would fall under no bucket at all.
**Docs:**
`docs/SYNC.md`, `docs/DEPLOY-RAILWAY.md`, `docs/GITHUB-AUTH-SETUP.md`,
`docs/LOCAL-CLOUD-TESTING.md`, `docs/DOMAIN-REPUTATION.md` (Safe Browsing + Search Console),
`docs/BILLING-STRIPE.md` (Stripe Payment Link + webhook → `accounts.plan` entitlement),
`docs/RELEASE.md`.



## `0047` / pg `0034` — `ml_comment_labels`

Additive, hand-written in both dialects (never `db:generate:pg` — it squashes the pg baseline).
Creates the one table behind [ML-SEVERITY.md](ML-SEVERITY.md): ML severity/category labels for
bot-authored text. Journal entries `idx 47 / version "6"` and `idx 34 / version "7"`, sharing
`when: 1785800000000` as every paired twin does.

Points worth remembering:

- All three id FKs (`account_id`, `repo_id`, `pr_id`) are **ON DELETE cascade**, so the table
  joins NEITHER `deleteRepo` nor `deletePrSubtree` — the `search_index` precedent. It IS in
  `accountScopedTables()` and is deleted explicitly in `eraseAccountData`, because erasure must
  not depend on which dialect enforces FKs.
- `target_id` has **no FK**: it names a row in one of three tables depending on `target_kind`,
  which is exactly why `target_kind` is part of the unique `mcl_account_target`.
- Dialect columns: sqlite `real` / pg `double precision` for `severity_prob`; sqlite
  `text ... mode:'json'` / pg `jsonb` for the two category columns; sqlite `integer` /
  pg `boolean` for `is_summary`; sqlite `integer` + `DEFAULT (unixepoch())` / pg
  `timestamp with time zone` + `DEFAULT now()` for the three timestamps.
- ⚠ **pg `0034` has not been replayed against a real Postgres** — same status as pg `0031`–`0033`.
- ⚠ A running `tsx watch` dev server applies migrations on every restart, so editing a `.sql`
  file AFTER the watcher has already applied it leaves the dev DB on the old DDL with the new
  file's hash unrecorded. Drop the table, delete its `__drizzle_migrations` row, re-run
  `pnpm db:migrate`. This happened while writing this migration.
