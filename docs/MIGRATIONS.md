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
`"version": "6"`, **pg entries are `"version": "7"`**; every file through sqlite `0052` /
pg `0039` is registered (the two twins of a pair share one `when`, e.g. `1786300000000` for
`0052`/pg `0039`). (Plugin migrations are discovered by filename sort and have NO journal — that
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
- **The one remaining ACCOUNT-WIDE Pro CRON covers the DEFAULT WORKSPACE ONLY** — the Slack digest
  (`slack/report.ts`). It has no request and therefore no `?workspace=`, and its old
  `scope = 'all'` default has no image under a single-id scope, so it resolves
  `ctx.queries.defaultWorkspaceId(accountId)`. Previously it covered every repo in the account. This is a real behaviour reduction, taken deliberately over iterating all workspaces,
  which would multiply a billed LLM call by workspace count on a sweep. **State it in the
  Settings copy for the Slack digest.**
  (This gap used to name TWO crons; the other — the AI-policy sprint refresh,
  `ai-policy/scheduler.ts` → `refreshSprintReport` — was DELETED along with the "AI summary
  updates" setting. ⚠ **"The AI summaries are now manual-only" is TRUE ONLY FOR AN ACCOUNT WITH NO
  SLACK CADENCE.** `buildSlackReport` independently regenerates the per-repo digests AND the sprint
  report on the Slack cadence, so a configured account still has an automated billed path — it is
  just a delivery schedule the user chose rather than a background policy.)
- **PrDetail still classifies bots CLIENT-SIDE by LOGIN** — `ChecksTab`'s "Bots" chips group
  threads by `botVendorMeta(user)` and `ThreadList`'s vendor filter by `threadBotKind`, both
  login→`ReviewBotKind` only. A stored workspace judgement and the `quality_check` role never reach
  that surface (the bulk-resolve OFFER on the same screen DOES consult the classification, so the
  two can disagree by design).
- **Plugin `0020`'s pg twin has not been replayed against a real Postgres.** The unit suite is
  SQLite-only, so nothing automated covers the dialect divergences it carries. (CORE's pg chain
  `0000`→`0035` — including `0031`/`0032` — WAS replayed by hand during `0035`; see that section.
  It is still a one-off by hand, not CI, so it will go stale again.) The same is true of
  everything added since: **pg `0036`–`0037`, pg `0039` and the plugin `0021`/`0022`/`0023`/`0024`
  pg twins are unverified against a real Postgres.**
- **`trunk_ci_status_events` (`0052` / pg `0039`) has NO BACKFILL.** The table is append-only and
  written only by `sync/branch-status.ts`, on a TRANSITION, at the end of a full repo walk — and
  the one-time CI-history backfill (`sync/backfill-ci-history.ts`) synthesizes only the PR-side
  `ci_status_events`, deliberately not this. So the Feed's `trunk_ci_failed` half stays EMPTY for
  a repo until its next full walk observes a red trunk, however much trunk history
  `branch_commits` already holds. Nothing is wrong; the log records observations, and it has none
  before it existed.
- **The legacy `?team=` URL rule is unit-tested nowhere.** It lives in
  `readWorkspaceFromUrl`/`readFromUrl` in `hooks/useUrlState.ts`, neither of which is exported, so a
  test would pin a copy rather than the code — flagged in `workspaceScope.test.ts`'s own header.
- ~~**`SprintReportCard` has no importer**, yet the plugin's AI-policy sweep (`*/5`) still calls
  `refreshSprintReport` for every account not on `manual`.~~ **CLOSED** — the AI-policy sweep is
  gone, so nothing calls `refreshSprintReport` on a timer any more; the only automated caller left
  is the Slack digest, which renders the report into a message rather than into that card. The card
  is still importer-less; it just no longer costs anything. (`PresetPromptPanel` is also
  importer-less, but its server side is deliberately kept.)
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
- ✅ **pg `0034` HAS now been replayed against a real Postgres** — see `0048` / pg `0035` below,
  which replayed the whole pg chain (`0000`→`0035`) into a throwaway database on Postgres 17.
- ⚠ A running `tsx watch` dev server applies migrations on every restart, so editing a `.sql`
  file AFTER the watcher has already applied it leaves the dev DB on the old DDL with the new
  file's hash unrecorded. Drop the table, delete its `__drizzle_migrations` row, re-run
  `pnpm db:migrate`. This happened while writing this migration.



## `0048` / pg `0035` — `ml_comment_labels.vendor_severity`

Two additive nullable `text` columns — `vendor_severity` (`nit`…`critical`) and
`vendor_severity_confidence` (`high`/`medium`/`low`) — carrying the REVIEW BOT'S OWN declared
severity, which the severity-api's marker parser already extracted and we were discarding.
Journal entries `idx 48 / version "6"` and `idx 35 / version "7"`, sharing
`when: 1785900000000`. No index (read out of an already-fetched label row, never a predicate)
and no backfill.

- **This is not an input to our label.** On `gold_v2_sample` (300 comments, fresh label-free
  adjudication, marker-stratified, held out) our model scores 0.700 exact / 0.303 ordinal MAE
  against the vendor badge's 0.474 / 0.697 — the bot's self-assessment is the WORSE of the two.
  The columns exist to be displayed beside ours; nothing derives, corrects or falls back from
  them.
- **Both nullable, for two reasons that are indistinguishable after the fact and need not be
  distinguished**: most comments carry no vendor badge at all, and an older severity-api build
  omits the response fields entirely. The client (`ml/severity-client.ts`) reads both defensively
  — absent, null, non-string, or a word outside the union all become `null`, and nothing throws.
  A throw there would fail the batch, and a failed batch abandons its workspace's backlog for the
  tick.
- **Both columns are in BOTH halves of `upsertMlLabels`'s upsert** — the values object AND the
  `set:` clause — so a re-score can CLEAR a stale claim, not just set one. Omitting them from
  `set:` type-checks perfectly and freezes the first value ever stored; `db/ml-labels.test.ts`
  mutation-tested exactly that (removing the two `set:` keys fails two cases).
- **Existing rows keep NULL.** Labels are never re-scored (ML-SEVERITY.md § known gaps), so
  historical rows gain a vendor claim only via `pnpm ml:enrich --reset`. A null renders nothing.
- ✅ **Replayed against a real Postgres 17.** The entire pg chain `0000`→`0035` was applied in
  journal order into a throwaway database (`docker exec … psql -v ON_ERROR_STOP=1`), then
  smoke-tested at row level: the insert stores the claim, an `ON CONFLICT (account_id,
  target_kind, target_id) DO UPDATE` re-write with NULLs clears it, the row count stays 1 and our
  own `severity` is untouched. Re-applying `0035` is a no-op (`ADD COLUMN IF NOT EXISTS`). This
  also closes the standing gap on pg `0031`–`0034` — by hand, once; CI still does not do it.

## `0050` / pg `0037` — `users.app_slug`

One additive nullable `text` column on the GLOBAL `users` table: the GitHub App slug behind an
actor's comments (`performed_via_github_app.slug`, REST-only), which `sync/app-attribution.ts`
always received and used to collapse into a PR-level boolean. Journal entries
`idx 50 / version "6"` and `idx 37 / version "7"`, sharing `when: 1786100000000`. No index, no
backfill.

- Written by `persistAppSlugs` (fill-or-update: a null fills, a DIFFERENT slug updates — apps get
  renamed — but a later app-less comment never clears an observed slug; most of a bot's comments
  carry no attribution object).
- Read by the Bot Tuning Advisor's discovery tier (App-authored vs Actions-authored split). The
  probe itself still has no caller ANYWHERE — and the `bots.deepDetect` setting that was meant to
  trigger it has since been DELETED (it lived in the plugin's `pro_settings`, which CORE's
  `classifyReviewer` cannot read, so it was never wired to anything). The column fills only when
  something invokes the probe; wiring it in now needs a CORE-side gate, never a plugin setting.

## Plugin `0021` — Bot Tuning Advisor tables

Three account-scoped plugin tables (sqlite + pg twins, filename-sorted, NO journal, no
`--> statement-breakpoint`): `advisor_recommendations` (unique
`(account_id, workspace_id, dedupe_key)`), `advisor_bot_profiles` (unique
`(account_id, workspace_id, bot_user_id)` + the NAMED composite FK
`advisor_bot_profiles_workspace_account_fk (workspace_id, account_id) → workspaces(id,
account_id)` **spelled in the migration SQL only** — drizzle cannot declare an FK onto a core
table across the open-core boundary, and index/FK metadata in the schema modules is inert anyway;
ON DELETE CASCADE because core's `deleteWorkspace` cannot re-home plugin rows), and
`advisor_config_events` (append-only, index `(account_id, repo_id, occurred_at)`, no unique).
Unlike the DO-block data migrations, this is pure `CREATE TABLE IF NOT EXISTS` DDL (the
0014/0017 idiom). All three are in `eraseProByAccountId` and the isolation-test seeds; none is
PR-keyed, so `pruneProByPrIds` is deliberately unchanged. ⚠ The pg twin (like plugin `0020`'s)
has not been replayed against a real Postgres.

## `0052` / pg `0039` — `trunk_ci_status_events`

One additive table in both dialects, hand-written (never `db:generate:pg` — it squashes the pg
baseline), **no backfill**. Journal entries `idx 52 / version "6"` and `idx 39 / version "7"`,
sharing `when: 1786300000000`. It is the TRUNK twin of `ci_status_events`:
`branch_commits.ci_status` is updated IN PLACE by the branch snapshot's idempotent upsert, so a
trunk commit that turns red hours after it landed carries no record of WHEN — its only timestamps are
`committed_at` (git commit time) and `created_at` (first insertion), and presenting either as
"trunk CI failed at" would be a quiet lie. Columns: `account_id` + `repo_id` (both `ON DELETE
cascade`), nullable `branch_name`, `head_sha`, `status`, `failing_checks`, `observed_at`; indexes
`tcse_account_repo_observed (account_id, repo_id, observed_at)` (the Feed read AND the trim) and
`tcse_account_idx`.

- **Write rules live in `sync/branch-status.ts`** (`recordTrunkCiTransition`, exported predicate
  `trunkCiTransitionChanged`): a row is appended only on a TRANSITION (status / head sha /
  failing-check NAME SET differs from this repo's last row) and only on a POSITIVE statement from
  GitHub — `head_sha == null` or `status === 'unknown'` records nothing, since `unknown` is also
  what `graphqlTolerant` yields when a partial response NULLs the rollup. ⚠ The name dimension is
  DROPPED from the comparison when phase 2 never told us which checks failed (`undefined` ≠ `[]`),
  or a repo whose detail fetch fails would log a spurious transition on every sync. The whole
  block runs OUTSIDE the snapshot's transaction inside its own `try` — strictly non-fatal, like
  everything else in the branch snapshot.
- **`failing_checks` is `BranchCheckRun[]`, NOT `ci_status_events`' bare `string[]`** — same
  column name, different shape, matching `branch_commits` on purpose (sqlite `text mode:'json'`,
  pg `jsonb`, `$type<>()` in both schemas so the difference is a compile-time fact). The Feed
  normalises to bare names on the wire.
- **`observed_at` is OUR observation time** (the branch query selects no `completedAt`), so UI
  copy says "detected", never "failed at".
- **Retention is a HYBRID trim in the writer**, NOT the time-based sweep: `pruneOldData` anchors
  everything to a parent PR's `updated_at` and a trunk row has no PR — `retention.ts` records that
  absence as structural. The bound is the newest `TRUNK_CI_EVENT_WINDOW = 200` rows per repo **∪**
  everything still inside the Feed's read window (`FEED_WINDOW_DAYS`, IMPORTED from `db/queries.ts`
  rather than restated, so retention can never drift below the read), computed by the pure exported
  `staleTrunkCiEventIds` and applied select-then-delete-by-id because a correlated `DELETE … LIMIT`
  is not portable. ⚠ **Neither half alone is correct** — the same shape as `branch_commits`' trim,
  for opposite reasons: a pure COUNT bound evicted the very failure rows
  `getTrunkCiFailureFeedItems` reads over `FEED_WINDOW_DAYS` on the most active repos (a repo
  syncing every 120s outruns 200 rows long before 14 days elapse, and the symptom is invisible —
  the Feed quietly stops showing trunk failures on exactly the repos that have the most), while a
  pure AGE bound would delete a dormant repo's entire log so the next observation reads as a first
  observation forever. Both FKs cascade, but the
  table is ALSO deleted explicitly by `deleteRepo` (by `repoId`) and `eraseAccountData`, so the
  guarantee does not depend on SQLite's `foreign_keys=ON`; it is on the `accountScopedTables()`
  checklist rather than in the `KNOWN_UNCHECKED` exemption `ci_status_events` sits in.
- **No backfill, by construction** — see the known-gaps entry above.

## Plugin `0022` — `pr_comment_annotations.evidence`

One additive nullable `text` column on the plugin's annotation table (sqlite + pg twins,
filename-sorted, NO journal, no `--> statement-breakpoint`): the GROUNDING DIFF the `addressed`
verdict was judged against, as the JSON `annotations/evidence.ts#encodeEvidence` writes
(`{v:1, baseSha, headSha, path, outcome:'changed'|'untouched'|'unavailable', patch, previousPath,
note}`). Written for `addressed` rows with `target_kind='thread'` only; every other kind stores an
explicit NULL.

- **Stored rather than re-derived** because the annotations GET is a pure CACHED read fired on
  every PR open — re-fetching the compare to draw the evidence panel would put a GitHub call on
  every open of every bot-flooded PR. (Same reason the payload hash carries the `(base, head)`
  PAIR and never the diff text.)
- **Additive and nullable, so existing rows stay readable.** They simply have no evidence to show;
  the panel renders nothing for them and the next "Check review" fills it in — which they are due
  anyway, because the addressed payload-hash prefix moved `t1|` → `t2|` in the same change and
  marks every existing addressed row stale exactly once. (It has moved twice more since, for the
  same one-off reason each time: `t3|` when `isResolved` entered the hash, `t4|` when the evidence
  window re-anchored on the thread's ROOT comment. Current prefix: **`t4|`** — see
  docs/PRO-PLUGIN-AND-ACTIVITY.md.)
- **The sqlite file is a plain `ALTER TABLE … ADD COLUMN`** (SQLite has no `IF NOT EXISTS` there,
  and `pro_migrations` guarantees one application); the pg twin is `ADD COLUMN IF NOT EXISTS`
  inside the standard `DO $$ … EXCEPTION WHEN others THEN RAISE WARNING` wrapper. ⚠ Be honest
  about what that warning path costs HERE: `readPrAnnotationRows` SELECTs this column, so a
  database that took the warning 500s on the annotations GET — the "Check review" surface breaks
  while the rest of the plugin keeps serving. That is still the better trade than a raise, which
  takes the WHOLE plugin dark (OSS-mode degrade) with nothing anyone would connect to this file;
  the fix is to delete the row from `pro_migrations` and restart once the cause is cleared.
- ⚠ The pg twin has not been replayed against a real Postgres.

## Plugin `0024` — `ai_fixes.comment_targets` + `comment_verdicts`

Two additive nullable `text` columns holding JSON on the plugin's `ai_fixes` table (sqlite + pg
twins, filename-sorted, NO journal, no `--> statement-breakpoint`; the pg twin is
`ADD COLUMN IF NOT EXISTS` inside the standard `DO $$ … EXCEPTION WHEN others THEN RAISE WARNING`
wrapper). They are the record of a **comments-seeded** fix run — the "fix from comments" workflow:
`comment_targets` is the `AiFixCommentTarget[]` the run was given (written at INSERT, in prompt
order, each carrying its `C<n>` ref label), `comment_verdicts` the `AiFixCommentVerdict[]` the
agent reported (written on SUCCESS). `ref` is the join key between the two; both are NULL on every
other seed.

- **`0023` is the Insights chat-answer-window pair**, so this one is `0024` in both folders.
- **Nullable with no default, deliberately.** `packages/pro/test/isolation.test.ts` auto-applies
  every file in `packages/pro/migrations` (`readdirSync` + sort) and inserts `ai_fixes` rows from a
  FIXED value list — a `NOT NULL` column without a default would break that suite.
- **Stored, not re-derived.** The targets are resolved once at launch (bodies, authors, file
  anchors and hydrated anchor hunks), and the prompt is rendered and stored at the same moment, so
  the run's inputs are frozen. Re-resolving them to render the report would give a different answer
  once the PR moved on, and would put a GitHub call behind a plain GET.
- **The verdicts are the agent's SELF-REPORT and are stored as commentary only.** The authoritative
  changeset is still the captured git diff — `filesTouched` inside a verdict is labelled as the
  agent's own account wherever the UI shows it.
- ⚠ What the pg warning path costs here: the ai-fix GET SELECTs both columns, so a database that
  took the warning 500s that route — the whole AI Fix tab breaks while the rest of the plugin keeps
  serving. Still the better trade than a raise, which takes the WHOLE plugin dark (OSS-mode
  degrade); the fix is to delete the row from `pro_migrations` and restart once the cause is
  cleared.
- ⚠ The pg twin has not been replayed against a real Postgres.

## `0053` / pg `0040` — re-derive `workspace_reviewers.role` against five vocabularies

Five `UPDATE`s, one per non-review role, over rows whose `source <> 'manual'`. No schema change —
this is a pure data correction, and it exists because of a read-order property that makes a
code-only fix insufficient.

- **WHY A MIGRATION AT ALL.** `reviewerRoleForUser` applies the login seed FIRST and lets a stored
  `workspace_reviewers` row overwrite it. That ordering is correct (an explicit row must beat a
  default), but it means adding a login to `QUALITY_CHECK_BOTS` — or to any of the four
  vocabularies introduced alongside `ReviewerRole`'s widening — has **no effect on an actor that
  has already been classified**, and the lazy classifier stamps a row the first time anyone opens
  the Bots tab. Any future vocabulary addition needs the same treatment or it only reaches installs
  that have never used the product.
- **What it corrected on the dev corpus.** `github-actions` + `github-actions[bot]` held 385
  submitted reviews and 3,116 comments between them while roled `'review'` — the largest "AI
  reviewer" in the account's ROI table was a CI runner. `dependabot[bot]` (738 authored PRs) was
  roled `'review'` too, for an actor that has never reviewed anything.
- **`source <> 'manual'` is the whole safety condition** — a role a person chose is never
  re-derived, exactly as migration `0042`'s backfill had it. The judgement half is owned by
  `source`. ⚠ The flip side is a real, accepted limitation: where a human classified ONE row of a
  duplicated identity, the pair now splits across two lanes (see the known-gaps list in CLAUDE.md).
- **It supersedes `0042`'s / pg `0029`'s narrower quality-check list** rather than repeating it.
- ⚠ **THE ONE DIALECT DIVERGENCE:** sqlite strips the `[bot]` suffix with
  `replace(lower(github_login), '[bot]', '')`, pg with
  `regexp_replace(lower("github_login"), '\[bot\]$', '')`. Same operation, each in its dialect's
  idiom — and the stripping itself is load-bearing, because the same actor exists as two `users`
  rows with different GitHub node ids and a list covering one spelling splits it across two roles.
  `replace()` is safe on sqlite because no GitHub login may contain `[` or `]`.
- ⚠ The pg twin has not been replayed against a real Postgres.

## `0054` / pg `0041` — brand the automations stored as `in_house`

One `UPDATE` per vendor kind (68 of them), over rows whose identity was never set by a human. No
schema change; a data correction with the same read-order justification as `0053`.

- **WHY.** The classifier had no step between "known AI-reviewer login" and the `githubType`
  fallback, so every OTHER automation — quality gates, dependency bots, code agents, release and
  housekeeping bots — was stored as `kind: 'in_house'`, the bucket labelled **"In-house AI"**. On
  the dev corpus that was 25 of 37 such rows, holding sonarqubecloud, dependabot[bot],
  github-actions[bot], gitguardian, socket-security, google-cla and jit-ci. They rendered with the
  same grey chip and the same wrong name on the one screen that exists to classify them. The
  stored `kind` wins on read, so widening the vocabulary in code alone reaches only installs
  nobody has opened the Bots tab on.
- **It covers the AI-REVIEW vendors too**, which was not the original intent — found by checking
  the result on a live database, where `deepsource-io`, `github-code-quality` and
  `chatgpt-codex-connector` were also sitting at `in_house` because their rows predate those
  logins joining `REVIEW_BOTS`. Identical staleness, identical fix.
- **THE THREE CONDITIONS ARE EACH LOAD-BEARING:**
  - `identity_source <> 'manual'` — a vendor a HUMAN named is never re-derived. Identity is owned
    by `identity_source` and judgement by `source`, so this touches only the identity half and
    leaves a manual "not a bot" verdict on the same row alone.
  - `kind IN ('in_house','vendor')` — only the UNBRANDED kinds are upgraded. A row already
    carrying a real brand got it from a stronger signal (a vendor-login or fingerprint hit), and
    silently overwriting that is how a correction is lost.
  - `label = NULL` — the label CACHES the kind's display name, and the old rows hold the literal
    "In-house AI" or the bare login. Leaving it would print "In-house AI" beside a SonarQube chip.
- ⚠ **The dialect divergence is the same as `0053`**: `replace(lower(…), '[bot]', '')` on sqlite,
  `regexp_replace(lower(…), '\[bot\]$', '')` on Postgres.
- **Verified on a live database.** After applying, the only rows left at `in_house` were the ones
  that should be: four genuinely unknown logins (`cdp-github-action`, `erxes-dev-agent`,
  `tjpeel-ee`, a user literally named `Copilot`) and nine rows a human had named
  (`identity_source: 'manual'`), which the guard is there to protect.
- ⚠ The pg twin has not been replayed against a real Postgres.
