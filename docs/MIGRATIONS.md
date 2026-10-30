# Migrations, history & known gaps

> Split out of CLAUDE.md (2026-08) to keep the root memory file lean. This is the
> authoritative deep-dive for this area; CLAUDE.md keeps only the summary and the
> cross-cutting landmines. Add new detail HERE, not to CLAUDE.md. References to other
> sections of the old CLAUDE.md resolve via the doc map at the top of CLAUDE.md.

## Two migration folders, one database

Limn runs on SQLite only. There are two migration sets, both applied at boot, core first:

- **Core** — `apps/backend/src/db/migrations/` (`0000`+), applied by drizzle's migrator through
  `meta/_journal.json` (`"version": "6"`). ⚠ **The journal is hand-maintained**: a `.sql` file on
  disk with no journal entry SILENTLY SKIPS — the boot looks perfect and every query against the
  new relation 500s. Prefer hand-writing additive migrations over a full `pnpm db:generate`.
- **Platform** — `apps/backend/src/platform/migrations/` (`0001`–`0040`, the former Pro plugin's),
  applied by `platform/migrate.ts` `runPluginMigrations` after core's (`bindPlatform` →
  `registerPlatform` → `ctx.registerMigrations`). Filename-sorted, NO journal (do not add one),
  each file once by NAME, recorded in **`pro_migrations`** (`name`, `applied_at`) — the same
  bookkeeping plugin-era installs already carry, so nothing re-runs after the fold. A file is handed
  whole to `better-sqlite3`'s `exec`, so it takes NO `--> statement-breakpoint`. ⚠ A failing
  platform migration now FAILS THE BOOT (it rethrows through `bindPlatform`); under the plugin it
  silently dropped the whole plugin to OSS mode, which is why older entries below are written so
  defensively. The release copies the folder to `release/dist/platform/migrations`.

**Postgres (removed 2026-10-22).** Until the hosted mode was deleted, every core and plugin
migration had a hand-written Postgres twin (`migrations-pg/`, a squashed baseline at pg `0000` plus
additive files up to pg `0111`, journal `"version": "7"`), kept column-parity with SQLite by
`schema-parity.test.ts`, and replayed by hand against a throwaway database because the unit suite
never executed one (last full replay: core pg `0051`, plugin `0033`, PostgreSQL 16.9,
2026-09-09). The pg files, `schema.pg.ts`, the parity test and the pg scripts are gone; the pg
numbers that used to sit beside each SQLite number below have been dropped. Some entries still
explain a choice by a dialect divergence that no longer exists — read those as history.

## History & planning

SQLite migrations (`0000`+) track the schema's evolution — `0008_multitenant_accounts`
added the `accounts` table + `accountId` + composite uniques; `0009`/`0010` added lean
storage; `0013` Claude-review routing (`reviewMode`/`routeReason`); `0014`
`accounts.lastActiveAt` and `0026` `accounts.aiCreditAllowance` (both dormant since 2026-10-22: no
idle-account sync gate, no credit metering); the **Bot-Triage** trio `0027`
(`users.github_type`), `0028` (`bot_review_classification`), `0029` (`bot_mute_rules`), plus
platform migration `0009` (`pro_settings` + 11 `bot_*` columns); `0037` the four `author_id` indexes the contributor popover needs. The **merge / CI / trunk**
batch adds `0038` `auto_merge_requests`; `0039` the four `repos`
default-branch columns + `branch_commits`; `0040` `pull_requests.review_decision`;
`0041` `branch_commits.failing_checks` + `.pr_number` + the
`(account_id, repo_id, number)` PR index the commit→PR resolution needs — all additive and
nullable, so there is no backfill (the branch sync re-upserts the same window every tick, and the
read resolves null → `[]`/null meanwhile). `0042`/`0043` RE-KEYED the bot object
from (account, author) to (account, REPO, author) and then NORMALISED the actor-grain columns out
into `account_reviewers`; **`0044`/`0045` superseded both** and are, again, ONE
change in two steps — read them together:

```
0044  RE-HOME   repo grouping:  teams (m2m)  →  workspaces (1:N), + a Default per account
0045  COLLAPSE  the bot object: repo_reviewers + account_reviewers → workspace_reviewers
```

**`0044`** creates `workspaces` + `workspace_repos`, backfills one workspace per existing team
**WITH THE TEAM IDS PRESERVED** (a URL, a bookmark, a persisted filter and — after platform `0020` —
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
`account_reviewers` and `0045` folds them in. **Platform `0019` is a guarded NO-OP** — it read
`repo_reviewers` and wrote `account_reviewers`, both of which core `0045` drops, and core migrations
ALWAYS run first (`index.ts` completes `runMigrations()` before `bindPlatform()` →
`ctx.registerMigrations` → `runPluginMigrations`), so unfixed it would raise "no such table" on
every database that had not already applied it — fresh installs, the demo seeder, CI. (Under the
plugin that failure was TOTAL and SILENT — the whole plugin dropped to OSS mode; today it fails the
boot.) It is fixed by stubbing the two legacy tables and dropping them again, which is safe
precisely because core always drops them first.
**Platform `0020` does two jobs**: (A) it ABSORBS `0019`'s backfill for databases upgrading from a
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
where its own workspace can never surface it. ⚠ **Platform migrations take NO
`--> statement-breakpoint`** (the runner hands the whole file to `client.exec`; the
marker is core-migrator syntax and is not valid SQL). `platform/migrations/
0007_comparison_mode.sql` and `0010_team_scope.sql` **must STAY**: a database replaying from empty
runs them before reaching `0020`. Platform migration `0017` adds `pr_comment_annotations` (+ backfills
`comment_assessments` as `kind='validity'`); platform `0018` **DROPS `retro_reports`** — `0008`/`0010`, which create and widen it, must STAY, since a database replaying from
empty still runs them first.
**`0046` DROPS the two "watched" columns** — `repos.inbox_watch` and
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
**Known gaps on this branch:**
- ✅ **CLOSED — the Slack digest is now PER WORKSPACE, capped** (plugin migration `0030`,
  `workspace_slack_targets`). This entry used to read "the one remaining account-wide plugin cron
  covers the DEFAULT workspace only", a deliberate reduction taken over iterating all workspaces
  "which would multiply a billed LLM call by workspace count on a sweep". **That reduction has been
  reversed on purpose, and the cost story is now this:**
  - **Only the SPRINT REPORT multiplies.** `refreshSprintReport` is keyed (account, workspace) —
    its own throttle key, its own `sprint_reports` row at `scope_key = 'ws:<id>'`, its own payload
    hash — so N selected workspaces are up to N Haiku calls per send, and **$0 for any workspace
    whose insights have not moved**.
  - **The per-repo digests do NOT multiply.** `runRefresh` is throttled and payload-hash-cached per
    ACCOUNT and is still called account-wide (`requested: null`); the first due workspace of a
    sweep may regenerate and every later one is served its cached rows. `buildSlackReport` narrows
    them for **display** only. ⚠ Do not pass a workspace's repo ids as `requested` to "scope" it —
    that narrows the GENERATION plan and each workspace would bill its own subset.
  - **The bound is `SLACK_TARGET_WORKSPACE_CAP` (12)**, enforced at the write (it **refuses** an
    over-cap save rather than truncating) and re-applied defensively in the sweep (which
    **truncates** by workspace id — nobody is there to be told). **It is DISCLOSED in the Settings
    copy**, alongside the sentence "every selected workspace generates its own report on every
    send". That closes the standing "state it in the Settings copy" obligation this entry carried,
    which had never been honoured.
  - ⚠ **`slack_last_sent_slot` moved with it and had to.** It was ONE column per account; under a
    per-workspace sweep a single marker re-sends the workspaces that already went out and skips
    the ones that had not. Migration `0030` CARRIES the old marker onto the Default-workspace row
      so the first sweep after an upgrade does not re-post an already-delivered digest — pinned by
    `platform/test/slack-targets.test.ts`.
  - The seven `pro_settings.slack_*` columns are now **DORMANT** (still present, removed from the
    drizzle schema, never selected, never written) — the `ai_update_mode` precedent. ONE live
    spelling.
  (This gap used to name TWO crons; the other — the AI-policy sprint refresh,
  `ai-policy/scheduler.ts` → `refreshSprintReport` — was DELETED along with the "AI summary
  updates" setting. ⚠ **"The AI summaries are now manual-only" is TRUE ONLY FOR AN ACCOUNT WITH NO
  SLACK CADENCE.** `buildSlackReport` independently regenerates the per-repo digests AND the sprint
  report on the Slack cadence, so a configured account still has an automated billed path — it is
  just a delivery schedule the user chose rather than a background policy. Since `0030` that path is
  **one sprint report per SELECTED WORKSPACE**, up to the cap, per send.)
- **PrDetail still classifies bots CLIENT-SIDE by LOGIN** — `ChecksTab`'s "Bots" chips group
  threads by `botVendorMeta(user)` and `ThreadList`'s vendor filter by `threadBotKind`, both
  login→`ReviewBotKind` only. A stored workspace judgement and the `quality_check` role never reach
  that surface (the bulk-resolve OFFER on the same screen DOES consult the classification, so the
  two can disagree by design).
- ⚠ **`0047_drop_my_turn_dismissals` is DESTRUCTIVE and ONE-WAY** — there is no down migration and no
  archive step. It is safe only because the predicate that made the table necessary now exists
  (docs/BACKEND.md § My Turn — the ball rule); a dismissal row has nothing left to mean.
- **`trunk_ci_status_events` (`0052`) has NO BACKFILL.** The table is append-only and
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
  is the Slack digest, which renders the report into a message rather than into that card. The
  importer-less card is now DELETED outright (`SprintReportCard.tsx` + `useSprintReport`, the
  consolidation cut list); the plugin's `sprint-report.ts` routes and the Slack digest's use of
  `refreshSprintReport` survive. (`PresetPromptPanel` is also importer-less, but its server side
  is deliberately kept.)
- **`apps/frontend/test/` still does not run in CI** — and it holds the workspace refactor's frontend
  evidence (`workspaceScope.test.ts`, `botReviewerQueryKey.test.ts`). The platform's tests, including
  its cross-account isolation suite, run with the backend's `pnpm test` since the fold.
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
**Docs:** `docs/SYNC.md`, `docs/DATA-MODEL.md`, `docs/RELEASE.md`.



## `0047` — `ml_comment_labels`

Additive, hand-written.
Creates the one table behind [ML-SEVERITY.md](ML-SEVERITY.md): ML severity/category labels for
bot-authored text. Journal entry `idx 47 / version "6"`, `when: 1785800000000`.

Points worth remembering:

- All three id FKs (`account_id`, `repo_id`, `pr_id`) are **ON DELETE cascade**, so the table
  joins NEITHER `deleteRepo` nor `deletePrSubtree` — the `search_index` precedent. It IS in
  `accountScopedTables()` and is deleted explicitly in `eraseAccountData`, because erasure must
  not depend on `foreign_keys=ON`.
- `target_id` has **no FK**: it names a row in one of three tables depending on `target_kind`,
  which is exactly why `target_kind` is part of the unique `mcl_account_target`.
- Columns: `real` for `severity_prob`; `text ... mode:'json'` for the two category columns;
  `integer` for `is_summary`; `integer` + `DEFAULT (unixepoch())` for the three timestamps.
- ⚠ A running `tsx watch` dev server applies migrations on every restart, so editing a `.sql`
  file AFTER the watcher has already applied it leaves the dev DB on the old DDL with the new
  file's hash unrecorded. Drop the table, delete its `__drizzle_migrations` row, re-run
  `pnpm db:migrate`. This happened while writing this migration.



## `0048` — `ml_comment_labels.vendor_severity`

Two additive nullable `text` columns — `vendor_severity` (`nit`…`critical`) and
`vendor_severity_confidence` (`high`/`medium`/`low`) — carrying the REVIEW BOT'S OWN declared
severity, which the severity-api's marker parser already extracted and we were discarding.
Journal entry `idx 48 / version "6"`, `when: 1785900000000`. No index (read out of an already-fetched label row, never a predicate)
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

## `0050` — `users.app_slug`

One additive nullable `text` column on the GLOBAL `users` table: the GitHub App slug behind an
actor's comments (`performed_via_github_app.slug`, REST-only), which `sync/app-attribution.ts`
always received and used to collapse into a PR-level boolean. Journal entries
`idx 50 / version "6"` and `idx 37 / version "7"`, sharing `when: 1786100000000`. No index, no
backfill.

- Written by `persistAppSlugs` (fill-or-update: a null fills, a DIFFERENT slug updates — apps get
  renamed — but a later app-less comment never clears an observed slug; most of a bot's comments
  carry no attribution object).
- Was read by the Bot Tuning Advisor's discovery tier (App-authored vs Actions-authored split),
  REMOVED 2026-10-26 — nothing reads it now. The
  probe itself still has no caller ANYWHERE — and the `bots.deepDetect` setting that was meant to
  trigger it has since been DELETED (it lived in the plugin's `pro_settings`, which CORE's
  `classifyReviewer` cannot read, so it was never wired to anything). The column fills only when
  something invokes the probe; wiring it in now needs a CORE-side gate, never a plugin setting.

## Platform `0021` — Bot Tuning Advisor tables (DORMANT since 2026-10-26)

The Advisor is removed; these tables are kept, never dropped, and still erased.
Three account-scoped platform tables (filename-sorted, NO journal, no
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
PR-keyed, so `pruneProByPrIds` is deliberately unchanged.

## `0052` — `trunk_ci_status_events`

One additive table, hand-written, **no backfill**. Journal entry `idx 52 / version "6"`,
`when: 1786300000000`. It is the TRUNK twin of `ci_status_events`:
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
  column name, different shape, matching `branch_commits` on purpose (`text mode:'json'`
  with `$type<>()`, so the difference is a compile-time fact). The Feed
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

## Platform `0022` — `pr_comment_annotations.evidence`

One additive nullable `text` column on the platform's annotation table (filename-sorted, NO
journal, no `--> statement-breakpoint`): the GROUNDING DIFF the `addressed`
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
  docs/PLATFORM.md.)
- **The file is a plain `ALTER TABLE … ADD COLUMN`** (SQLite has no `IF NOT EXISTS` there,
  and `pro_migrations` guarantees one application). If it ever fails, delete its row from
  `pro_migrations` and restart once the cause is cleared.

## Platform `0024` — `ai_fixes.comment_targets` + `comment_verdicts`

⚠ **DORMANT since core `0078`**: the comments seed was removed; these columns are no longer written
or read (old rows keep their data).

Two additive nullable `text` columns holding JSON on the `ai_fixes` table (filename-sorted, NO journal, no `--> statement-breakpoint`). They are the record of a **comments-seeded** fix run — the "fix from comments" workflow:
`comment_targets` is the `AiFixCommentTarget[]` the run was given (written at INSERT, in prompt
order, each carrying its `C<n>` ref label), `comment_verdicts` the `AiFixCommentVerdict[]` the
agent reported (written on SUCCESS). `ref` is the join key between the two; both are NULL on every
other seed.

- **`0023` is the Insights chat-answer-window pair**, so this one is `0024`.
- **Nullable with no default, deliberately.** `platform/test/isolation.test.ts` auto-applies
  every file in `platform/migrations` (`readdirSync` + sort) and inserts `ai_fixes` rows from a
  FIXED value list — a `NOT NULL` column without a default would break that suite.
- **Stored, not re-derived.** The targets are resolved once at launch (bodies, authors, file
  anchors and hydrated anchor hunks), and the prompt is rendered and stored at the same moment, so
  the run's inputs are frozen. Re-resolving them to render the report would give a different answer
  once the PR moved on, and would put a GitHub call behind a plain GET.
- **The verdicts are the agent's SELF-REPORT and are stored as commentary only.** The authoritative
  changeset is still the captured git diff — `filesTouched` inside a verdict is labelled as the
  agent's own account wherever the UI shows it.


⚠ **Platform `0003`'s eight `ai_fixes` columns are DORMANT**: `resolved_strategy`, `resolved_patch`,
`resolved_diff`, `resolved_base_sha`, `resolved_files_changed`, `resolved_conflict_files`,
`resolved_at`, `resolve_error`. They held AI Fix's stored rebase artifact, and that
trunk-reconciliation path was removed (docs/CLAUDE-REVIEW.md § AI Fix). They
are undeclared in `platform/ai-fix/schema.sqlite.ts` (a comment there names the
set), so drizzle never selects or writes them — which also stopped the getters reading the stored
mbox/diff blobs on every tab load. Old rows keep their values (2 on the dev database) until retention
or erasure removes the whole row. None is indexed, so a later batched `DROP COLUMN` is possible. (Same batch, core side:
`claude_reviews.model` lost its TypeScript-only drizzle `enum:`. The column was always plain `text`
with no CHECK, so there is no migration; see docs/CLAUDE-REVIEW.md § Models.)

## `0053` — re-derive `workspace_reviewers.role` against five vocabularies

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
- **It supersedes `0042`'s's narrower quality-check list** rather than repeating it.
- **The `[bot]` suffix is stripped** with `replace(lower(github_login), '[bot]', '')` — and the
  stripping itself is load-bearing, because the same actor exists as two `users`
  rows with different GitHub node ids and a list covering one spelling splits it across two roles.
  `replace()` is safe on sqlite because no GitHub login may contain `[` or `]`.

## `0054` — brand the automations stored as `in_house`

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
- The `[bot]` strip is the same as `0053`'s.

- **Verified on a live database.** After applying, the only rows left at `in_house` were the ones
  that should be: four genuinely unknown logins (`cdp-github-action`, `erxes-dev-agent`,
  `tjpeel-ee`, a user literally named `Copilot`) and nine rows a human had named
  (`identity_source: 'manual'`), which the guard is there to protect.

## Platform `0025`/`0026` — period reports · `0027` — `pro_synthesis`

**`0025`** (`workspace_period_reports` + `sprint_cadence` settings surface) and **`0026`**
(the lanes column) are the period-reporting storage — recorded in
[PERIOD-REPORTING.md](PERIOD-REPORTING.md); the file-level rules here are the
standard platform ones (filename-sorted, NO journal, no `--> statement-breakpoint`).

**`0027` creates `pro_synthesis`** — the ONE cache table behind `GET/POST /api/pro/synthesis`
(drill-down verdict cards, the workspace "What they're flagging" synthesis, brief/roll-up/person
narration; full contract in [PLATFORM.md](PLATFORM.md) § The synthesis seam). One row per
`(account_id, scope_key)` with a unique index (`pro_synthesis_account_scope`) — every
`onConflictDoUpdate` in `synthesis/routes.ts` targets exactly that pair (the 0042/0045 lesson is
cited at the write site). Facts that live at the DDL grain:

- **`output` is JSON as `text`** — never drizzle `mode:'json'` — so one serializer owns the blob (the
  `workspace_period_reports` rule).
- **`input_count`/`analyzed_count` are REAL COLUMNS**, not facts buried in the blob: the
  "Summarised X of Y" coverage line is the disclosure that keeps a capped synthesis honest, and
  it must survive any output-shape drift.
- **No foreign keys, deliberately** — the workspace id is only ever resolver-produced (a foreign
  id degrades to Default and never travels), and the row is a REGENERABLE scope-keyed cache (the
  `bot_theme_reports` family), not a keyed history. It is in `retention.ts`'s
  `eraseProByAccountId` and deliberately NOT in `pruneProByPrIds` (no pr_id grain — it ages by
  STALENESS: the payload hash moves as the underlying items churn).
### `0061_auto_merge_durable_anchors`

Two nullable `text` columns on `auto_merge_requests`, no backfill and no default.

- `expected_base_ref` — the base branch pinned AT ARM TIME. The retarget guard was re-reading the
  synced `pull_requests.base_ref_name` on every tick, so any walk that corrected that column read
  as "the PR was retargeted" and disarmed an intent nobody had touched. NULL on pre-existing rows,
  which fall back to the synced value exactly as before.
- `update_issued_against_oid` — the head SHA an in-flight `update-branch` was issued against. It
  lived only in a process-local Map, so a restart (every `pnpm dev` file save; every upgrade)
  turned the watcher's OWN merge commit into an unexplained head move and disarmed the intent.

⚠ **NULL MEANS "NOT RECORDED", AND THAT IS WHY NEITHER TAKES A DEFAULT.** A default on
`expected_base_ref` would assert the user consented to a branch nobody asked them about.

### `0065_workspace_flow_settings`

One nullable JSON column, `workspaces.flow_settings` (`text`) — Chronology's
working hours and budgets as OVERRIDES ONLY. No backfill: NULL is "every default", which is right
for every existing row. See docs/DATA-MODEL.md.

### `0066_review_request_events`

The review-request HISTORY table (`review_request_events`, a PR child with no `account_id`, unique
`(pr_id, github_node_id)`, both FKs) plus `pull_requests.review_requests_synced_at`. No backfill in
SQL: the one-time GitHub backfill (`sync/backfill-review-requests.ts`) fills it after walks, keyed
on the NULL stamp. See docs/DATA-MODEL.md and docs/BOTTLENECKS.md § Asking for a review.

### Platform `0034_flow_pointers`

`pro_flow_pointers`, the Chronology pointers cache — the `pro_work_plans` shape exactly
(`(account_id, scope_key)` unique, no FK, erased with the account, never pruned per PR).

### `0067_pr_security_signals`

Four nullable columns on `pull_requests` — `dependency_vendor`, `security_fix`, `advisory_ids`
(`text` json) and `security_checked_at` — with no backfill in SQL: NULL
`security_checked_at` is "never classified", and the GitHub backfill
(`sync/backfill-pr-security.ts`) works through open automation PRs after walks. See
docs/DATA-MODEL.md § dependency + security signals and docs/SYNC.md.

It also carries the `workspace_reviewers` UPDATEs for six new automation logins and Semgrep's
per-org App (three for `role`, seven for `kind`): the stored role and kind beat the login seed on
read, so a code-only vocabulary change never reaches a workspace whose Bots tab already classified
them. Same three conditions as `0053`/`0054` (`source <> 'manual'`; `identity_source <> 'manual'`
with `kind IN ('in_house','vendor')`; `label = NULL`), and the same `replace` vs `regexp_replace`
divergence. Journal `when` `1789696800000`.

### `0068_my_turn_settings`

Three nullable columns, no backfill in SQL:

- `accounts.my_turn_settings` (`text` json) — the reader's My Turn settings as
  OVERRIDES ONLY; NULL is "every default", which is right for every existing row (the `0062`
  `blast_radius_config` rule). See docs/DATA-MODEL.md § `accounts.my_turn_settings`.
- `pr_mentions.mentioned_at` (`integer`) and
  `pr_mentions.mentioned_by_user_id` (`integer`, no FK) — the newest human mention's time and
  author. Existing rows stay NULL until the mention scanner's next tick restamps them (it re-derives
  the whole set every tick), and a NULL row shows no card. The table's unique is unchanged, so the
  scanner's new `onConflictDoUpdate` targets the existing `prm_account_pr`.

Journal `when` `1789783200000` (one day after `0067`).

### `0069_my_turn_dismissals`

A unique index `pull_requests_id_account` on `pull_requests (id, account_id)` — never a lookup (`id`
is the primary key), only the parent key of the new composite FK — and the `my_turn_dismissals`
table: `account_id` (FK accounts, cascade), nullable `pr_id` + `repo_id` with NAMED composite FKs
`my_turn_dismissals_pr_account_fk` / `_repo_account_fk` against `(id, account_id)`, `dismissed_at`
NOT NULL, and two unique indexes `(account_id, pr_id)` / `(account_id, repo_id)`. A composite FK
with a NULL member is not checked (MATCH SIMPLE), which is what lets one table carry both subject
kinds. ⚠ Same table NAME as the one `0060` dropped, different contract — see the file's
header and docs/DATA-MODEL.md. No backfill. Journal `when` `1789869600000`.

### `0070_claude_review_follow_up_ticket`

Four nullable columns, no backfill: `claude_reviews.ticket`, `.ticket_assessment` and `.follow_up`
(`text` json) and `claude_review_findings.prior_finding_id` (`integer`). The
last is a SOFT reference with NO FK on purpose — it always points at a finding of the same PR, and
`retention.ts` + `deleteRepo` delete a PR's findings in one `inArray(reviewId, …)` statement, so an
FK would only add delete-ordering risk. `claude_reviews.model` needed nothing for the new
`claude-opus-5-5` id: it is plain `text` (no CHECK). Journal `when` `1789956000000`. `src/db/claude-review-follow-up-columns.test.ts` runs the sqlite
half through the real migrator in CI. Contracts: docs/CLAUDE-REVIEW.md.

### Platform `0035_workspace_jira_api`

Four nullable `text` columns on `pro_workspace_settings` — `jira_email`, `jira_token` (a
CREDENTIAL: `sealed:v1:…` / `plain:…`, see SECURITY.md), `jira_ac_field_id`, `jira_ac_field_name`.
No backfill (NULL = no Jira API access), no new erasure entry (the table is already erased with the
account), tenancy unchanged (0029's composite FK). ⚠ **`jira_ac_field_id` / `jira_ac_field_name` went DORMANT one
release later** — the acceptance-criteria field moved to the Claude Review panel, per ticket
(docs/CLAUDE-REVIEW.md). They stay in the table and are undeclared in both schema modules; do not
drop them. The file is bare `ADD COLUMN` (run-once via `pro_migrations`). ⚠ Every hand-built test DB
that replays `0029`/`0031`/`0032` and then touches the store must replay `0035` too — the store now
SELECTs the four columns (`workspace-settings.test.ts`, `settings-route-schema.test.ts`,
`jira-routes.test.ts`; `isolation.test.ts` replays the whole folder).

### `0071_claude_review_trigger`

One column, `claude_reviews.trigger` — `text NOT NULL DEFAULT 'manual'`, `'manual' | 'auto'` (who
started the run; `'auto'` = the per-workspace auto-review sweeper). The default makes every
existing row a click, which is what it was. CORE, not a plugin table, because a CORE read needs it:
`getUnactionedClaudeReviews` carries it to the My Turn card, which labels an auto run "Auto review".
Journal `when` `1790042400000`. `src/db/my-turn-claude-review.test.ts` runs the sqlite half through the real migrator.

### `0072_commit_message_headline`

One nullable column, `commits.message_headline` — GitHub's `messageHeadline` (first line, at most 200
chars), read by My Turn's "Pushed since" card. NULL is "not synced yet": the walk selects it on every
pass (not lean-gated) and writes it only when received, and `sync/backfill-commit-headlines.ts` fills
open PRs' older commits after each walk. Separate from `message` (the lean-gated full body).

### `0073_claude_review_chat`

A new CORE table, `claude_review_chat_messages` — one row per Claude Review chat message (a
review's general thread when `finding_id` is NULL, else one finding's thread), plus the unique
index `claude_reviews_id_account (id, account_id)`, which exists only as the parent key of the new
table's composite tenancy FK `crcm_review_account_fk (review_id, account_id) → claude_reviews(id,
account_id)` (the `pull_requests_id_account` trick from `0069`). `finding_id` is a plain FK to
`claude_review_findings`; every FK cascades, and both delete paths (`deleteRepo`, retention's
`deletePrSubtree`) plus `eraseAccountData` delete the rows explicitly, before the findings and runs.
CORE because the parents are core tables and only core's delete paths can reach it; the plugin
writes it through `ctx.schema`. Journal `when` `1790215200000`.

### Platform `0036_workspace_auto_review`

Two nullable columns on `pro_workspace_settings`: `auto_review_enabled` (integer) and `auto_review_enabled_at` (integer) — the switch-on moment the
sweeper reviews from. No backfill (NULL = off). ⚠ Like `0035`, every hand-built test DB that touches
the store must replay it (the store SELECTs both columns): `workspace-settings.test.ts`,
`settings-route-schema.test.ts`, `jira-routes.test.ts`.

### `0087_auto_post`

AUTO-POSTING of Claude review output (docs/CLAUDE-REVIEW.md § Auto-posting). Six nullable columns,
no defaults, no backfill — so no insert path has to name any of them (deliberately NOT the 0083/0084
`NOT NULL DEFAULT` shape, whose SQLite DDL default could not be changed later):
`workspaces.auto_post_enabled` (`integer`; NULL/false = OFF for every workspace,
existing and new), `workspaces.auto_post_settings` (`text` JSON; OVERRIDES ONLY
`{ scope?, kinds? }`, resolved through `resolveAutoPostSettings`), `claude_reviews.auto_post` and
`ticket_reviews.auto_post` (JSON: what auto-posting did with that run — the claim is a compare-and-set
from NULL), and `claude_review_findings.posted_auto` / `ticket_review_items.posted_auto` (`integer`;
true = "Posted automatically"). Every column sits on an existing table, so
neither delete path, erasure nor `accountScopedTables()` changes. Journal `when` `1790928000000`.

### `0086_ticket_review_pr_cards`

One new table, `ticket_review_pr_cards` — the ticket review's CONTRIBUTION CARDS (docs/CLAUDE-REVIEW.md
§ Ticket review; contract in schema.sqlite.ts): one row per `(account_id, pr_id, head_sha)` (unique
`trpc_account_pr_head_ux`, `saveCards`' upsert target), `card` JSON (`text`),
`source` (`story_check` | `prepass`), `model`, nullable `cost_usd` (`real`), `created_at`. Tenancy is STRUCTURAL: the named composite FK `trpc_pr_account_fk (pr_id,
account_id) → pull_requests(id, account_id)` ON DELETE cascade (plus the usual `account_id` FK). No
backfill: cards appear as ticket reviews run. Both delete paths clear it through
`db/ticket-review-prune.ts`; `eraseAccountData` + `accountScopedTables()` own it. Journal `when`
`1790841600000`.

### `0085_auto_review_daily_cap`

One nullable column, `workspaces.auto_review_daily_cap` (`integer`, no
default) — the per-workspace auto Claude review daily cap (docs/CLAUDE-REVIEW.md § Auto review).
OVERRIDES ONLY: NULL means the product default `AUTO_REVIEW_DAILY_CAP` (20), resolved through
`resolveAutoReviewDailyCap`; a PUT of exactly 20 stores NULL. No backfill, and no workspace insert
has to name it. Written only by `setWorkspaceAutoReview` (the route bounds it 1..500), read by the
sweeper's roster (`listAutoReviewWorkspaces`) and the wire shape. Journal `when` `1790838000000`.

### `0084_auto_fix_off_by_default`

Auto AI Fix is OFF by default. It runs one `UPDATE` switching every workspace off; the switch
shipped one release earlier, so nobody had time to choose it. ⚠ **SQLite cannot change a column default in place**, so
0083's DDL default (1) stays. Both workspace inserts in `db/queries.ts` (`ensureDefaultWorkspace`,
`createWorkspace`) therefore write `autoFixEnabled: false` explicitly, and the read side treats only
an explicit `true` as on. A raw insert that omits the column on SQLite still gets 1, so never add a
third insert path without the value. Journal `when` is `1790751600000`.

### `0083_workspace_auto_fix`

One column, `workspaces.auto_fix_enabled` (`integer DEFAULT 1 NOT NULL`) — the per-workspace auto AI Fix switch (docs/CLAUDE-REVIEW.md § AI Fix → AUTO FIX).
⚠ **DEFAULT TRUE on purpose**: auto fix ran unconditionally before this column, so every existing
workspace keeps that until someone switches it off; no backfill. Written only by
`setWorkspaceAutoReview`, read by `maybeStartAutoFix` via `readWorkspaceAutoFixForPr`. Journal `when`
`1790665200000`.

### `0082_ci_reviews`

Two new core tables for the CI REVIEW (docs/CLAUDE-REVIEW.md § CI review), no change to any existing
core table. `ci_reviews` (one run per (PR, head, failing check set); `account_id` denormalised, a
unique `(id, account_id)` — `ci_reviews_id_account` — for the child's composite FK, and
`cir_pr_account_fk` `(pr_id, account_id)` → `pull_requests` `ON DELETE cascade`) and
`ci_review_items` (one per failing check; `ciri_review_account_fk`). `workspace_id` is a SOFT
reference like `ticket_reviews.workspace_id`. `ci_review_items.job_id` is `integer`, which SQLite stores as 64-bit (GitHub Actions job ids are
past 2^31). A PR delete prunes through `db/ci-review-prune.ts` in BOTH `deleteRepo` and
`deletePrSubtree`; both tables are in `accountScopedTables()` + `eraseAccountData`.
`claude_reviews.ci_failures` (`0077`) becomes LEGACY (no new run writes it). Journal `when`
`1790661600000`.

### `0081_review_request_requester`

One nullable column, `review_request_events.requester_user_id` (FK `users.id`) — who asked for the
review, from the ReviewRequestedEvent's `actor` (docs/DATA-MODEL.md § `review_request_events`). Plus
ONE DATA STEP: `review_requests_synced_at` is set back to NULL on every OPEN PR that has a
`requested` row with no requester (i.e. every open PR with any stored request, at migration time).
That puts them on the EXISTING history backfill's worklist (`sync/backfill-review-requests.ts`,
which now takes un-stamped OPEN PRs first, then in-window merged ones, under the same 100-per-repo
cap and budget contract) so each is re-read once and re-stamped — no new fetch path. Merged and
closed PRs are left alone: no card reads their requester. Until the re-read lands, Chronology
counts those open PRs as "not known". `ALTER TABLE … ADD … REFERENCES` + the `UPDATE` behind a breakpoint. Journal `when`
`1790658000000`.

### `0080_ticket_reviews` + platform `0039_jira_ticket_peers`

Three new core tables for the TICKET review (docs/CLAUDE-REVIEW.md § Ticket review), no change to
any existing core table. `ticket_reviews` (one run per ticket ident; `account_id` denormalised, a
unique `(id, account_id)` for the children's composite FKs), `ticket_review_members` (one row per
member PR at the head the run read; `trm_review_account_fk` and `trm_pr_account_fk`, both `ON DELETE
cascade`) and `ticket_review_items` (`tri_review_account_fk`). `workspace_id`, `origin_pr_id`,
`owner_pr_id`, `posted_pr_id` and `prior_item_id` are SOFT references — a PR delete prunes through
`db/ticket-review-prune.ts` in BOTH `deleteRepo` and `deletePrSubtree`, and all three tables are in
`accountScopedTables()` + `eraseAccountData`. The plugin half adds `pro_pr_jira_tickets.changed_at`
(moves only when story text or membership moves) and two indexes, `(account_id, api_root,
issue_key)` for the members read and `(account_id, changed_at)` for the sweeper. Not fixed in the
unreleased `0079`: its story columns are now LEGACY (no new run writes them).

### `0079_claude_finding_story`

Two nullable columns on `claude_review_findings`, no backfill: `story_index` (integer — the ticket's
0-based position on the run) and `story_ref` (text — the criterion's ref `AC2`, or a not-done item's
`M1`). Set together on a STORY FINDING — the server makes one per not met / partly met criterion and
per "Not done" item of the run's user-story assessment (`review/claude-review/ticket.ts`
`storyFindingsFrom`) so a story reaches GitHub the way every finding does; NULL on an ordinary
finding and on every older row (an older review keeps its story results in the stories section only,
and the AI Fix seed still builds `S…` items for it). The retired per-ticket "Post as comment" needed
no migration to remove: its record lived inside the `ticket_assessment` JSON, and an old row's
`posted` key is ignored on read. Journal `when` `1790650800000` (one step after
`0078`).

### `0078_ai_fix_change_report`

Three nullable `text` columns on core `ai_fixes`, no backfill (
text JSON like the table's other JSON columns). `trigger` — `'manual' | 'auto'` (`'auto'` is the
auto-review agent calling `startReviewFix`; NULL reads as `'manual'`). `review_items` — the
`AiFixReviewItem[]` a `'review'` run was given, each with the ref the agent must cite (`F1`, `P1`,
`T1`, `S1-AC2`, `S1-M1`, `C1`) and `included: false` for the ones left out for the prompt budget;
written at INSERT, NULL on a plain run. `change_report` — the validated `AiFixChangeReport`
(per-file summary + refs, the refs it deliberately did not fix, the refs it never mentioned);
written on SUCCESS. The removed comments seed's `comment_targets` / `comment_verdicts` (plugin
`0024`, adopted by `0074`) stay in place: old rows keep their data, nothing reads it. Shares `when`
`1790647200000` (one step after `0077`).

### `0077_claude_review_ci_failures`

One nullable column on `claude_reviews`, no backfill: `ci_failures` (JSON / jsonb), one object
`{state, checkCount, failures[]}` — the reviewed head's CI as the run saw it and, per failing check,
Claude's diagnosis or the server's `not_checked` reason (see [CLAUDE-REVIEW.md](CLAUDE-REVIEW.md) §
Failed CI on the reviewed head). NULL on every older row reads on the wire as `ciFailures: null` /
`ciState: null` ("did not look at CI"). Journal `when` `1790560800000`.

### `0076_claude_review_threads`

Two nullable columns on `claude_reviews`, no backfill. `thread_assessments` (JSON / jsonb): every
OTHER open review thread on the PR as the run judged it (validity + addressed; see
[CLAUDE-REVIEW.md](CLAUDE-REVIEW.md) § Other reviewers' threads); NULL on every older row reads on the
wire as "did not assess threads". `comments_through` (unix seconds / timestamptz): the newest
qualifying review-thread comment the run saw — the comment half of the auto re-review key; NULL ⇒ the
row's `created_at` stands in, so the deploy does not re-review every commented PR.

### `0075_review_lens_drop_learnings`

Two unrelated Claude Review changes in one file. `claude_review_findings.lens` (nullable text, no
backfill): the specialist angle a DEEP review's finding came from (`ClaudeFindingLens`); NULL = a
general finding, and every older row. And `DROP TABLE IF EXISTS review_learnings` — review memory
was deleted (capture, retrieval, prompt block, the two routes, the shared types). DROP takes the
five `rl_*` indexes with it. Nothing recreates the table: core `0074`'s `CREATE … IF NOT EXISTS`
already ran on every install that reaches `0075`, and the plugin's own DDL for it was stripped when Claude Review moved to core.

### `0074_adopt_agentic_tables` + platform `0037_auto_review_to_core`

Claude Review, review memory and AI Fix's fixer moved from the plugin into CORE (2026-10), and
their two tables moved with them — **ADOPTED IN PLACE, never renamed**. `0074` is `CREATE TABLE IF
NOT EXISTS` + `CREATE [UNIQUE] INDEX IF NOT EXISTS` for `review_learnings` and `ai_fixes` with the
plugin's FINAL column set and its own index names (`rl_*`, `af_*`), **no foreign keys** (SQLite
cannot add one to an existing table without a rebuild, so a fresh and an adopted install would
differ; tenancy is the query layer + `verify:isolation`), plus two plain columns on core
`workspaces`: `auto_review_enabled` / `auto_review_enabled_at`. On the dev DB the
tables already exist, so the CREATEs are no-ops and the rows stay. The fresh `ai_fixes` omits plugin
`0003`'s eight dormant `resolved_*` / `resolve_error` columns (nothing declares them; an adopted
table that still has them reads identically). SQLite cannot `ADD COLUMN IF NOT EXISTS`, so an install whose plugin stopped before plugin `0024`
would keep an `ai_fixes` without the two comments-seed columns — no such install is known.

⚠ **THE PLUGIN'S COPY OF THAT DDL WAS STRIPPED IN THE SAME CHANGE** — plugin `0001` keeps only
`repo_digests`, `0002` only `ai_pr_analyses`, `0003` and `0024` are COMMENT-ONLY. Core migrations
run before the plugin binds, so on a FRESH SQLite install core creates the full `ai_fixes` first;
left as statements, `0003`/`0024`'s bare `ALTER TABLE ai_fixes ADD COLUMN` would throw "duplicate
column" and the plugin migrator would have dropped the WHOLE plugin to OSS mode silently (today:
fail the boot). Editing an applied
plugin file is safe — `pro_migrations` tracks the filename only.

Plugin `0037` copies each workspace's auto-review switch from `pro_workspace_settings` into core
`workspaces` ONCE: only an ON switch with a floor, only onto the same `(account, workspace)`, and
never over a value the new core route already wrote (`WHERE auto_review_enabled IS NULL`). It lives
in the PLUGIN because a core statement naming `pro_workspace_settings` would fail on every install
that never had the plugin. The plugin columns are
dormant (the `0031` precedent). Pinned by `platform/test/auto-review-to-core.test.ts`; every
hand-built plugin test DB that runs ALL plugin migrations needs the two core columns on its
`workspaces` stub (`isolation`, `period-report`, `period-month-grain`, `period-cadence-change`).
Ownership moved with the tables: `deleteRepo`, retention's `deletePrSubtree`, `eraseAccountData` and
`accountScopedTables()` cover them (before, the plugin had NO deleteRepo hook and both orphaned on a
repo removal); the plugin's `pruneProByPrIds` / `eraseProByAccountId` no longer name them.

### Platform `0038_pr_jira_tickets`

Two new plugin tables, no change to any existing one. `pro_pr_jira_tickets` — the STORED Jira
tickets, one row per `(account_id, pr_id, issue_key)` (unique index
`pro_pr_jira_tickets_account_pr_key`, the worker's `onConflictDoUpdate` target), plus a plain index
on `(account_id, workspace_id, issue_type_id)` for the per-issue-type re-derivation.
`pro_jira_ac_fields` — the acceptance-criteria field per `(account_id, workspace_id, api_root,
issue_type_id)` (unique `pro_jira_ac_fields_account_ws_site_type`). No FKs (the plugin family); no
backfill — the worker fills the table on its first tick, new tickets first, 40 per account per
pass. Both are in `eraseProByAccountId`; ticket rows are also in `pruneProByPrIds`. Column parity is
PINNED by `platform/test/jira-ticket-schema-parity.test.ts`. `pro_workspace_settings.jira_ac_field_*` (0035) stay dormant. Rationale:
[TRACKERS.md](TRACKERS.md).

### `0088_issue_tracker` — the issue tracker moves to CORE

Three tables, no data. `workspace_trackers` — ONE tracker per workspace (provider, base URL, project
keys, match scope, `auth_email` + the SEALED `auth_token`), unique `(account_id, workspace_id)`
(`workspace_trackers_account_workspace`, the writer's conflict target), the named composite FK
`workspace_trackers_workspace_account_fk` → `workspaces (id, account_id)` ON DELETE cascade (the id
arrives in a request PATH). `tracker_tickets` — the provider-aware successor of the plugin's
`pro_pr_jira_tickets`: the same columns plus `provider` (NOT NULL DEFAULT `'jira'`), unique
`(account_id, pr_id, issue_key)`, indexes `(account_id, workspace_id, issue_type_id)`,
`(account_id, provider, api_root, issue_key)`, `(account_id, changed_at)` and `(pr_id)`; no FKs.
`pro_jira_ac_fields` — ADOPTED IN PLACE (plugin `0038`'s DDL verbatim, `CREATE … IF NOT EXISTS`, the
same index name), the `0074` / ai_fixes precedent.

- ⚠ **NO DATA IS COPIED HERE.** The sources are plugin tables, absent on a fresh or plugin-less
  install, and SQLite cannot test for a table in SQL. The values are MOVED at boot by
  `src/tracker/legacy-import.ts` (after the plugin binds): each source table and column is tested
  first, the copy is `ON CONFLICT DO NOTHING`, and in the same transaction the source is CLEARED
  (`pro_workspace_settings.issue_*` / `jira_email` / `jira_token` NULLed — the cadence on the same
  row untouched — and `pro_pr_jira_tickets` emptied). A move, not a copy, so it is safe on every
  boot with no marker and a token is never at rest twice. The token moves in its stored form
  (`plain:` / `sealed:v1:`), so nothing is re-entered. Pinned: `src/tracker/legacy-import.test.ts`.
- ⚠ **Why a NEW tickets table, not `ADD COLUMN provider` on the adopted one**: the adopted table may
  or may not carry plugin `0039`'s `changed_at`, and SQLite has no `ADD COLUMN IF NOT EXISTS` — one
  of the two install shapes would fail the boot. A new table has one shape everywhere.
- **Plugin `0038`/`0039` were stripped to `SELECT 1;`** in the same change: a fresh install no longer
  grows `pro_pr_jira_tickets`, and `0039`'s bare `ALTER TABLE` on a table that no longer exists would
  have thrown and dropped the WHOLE plugin to OSS mode. An install that already ran them keeps what they made
  (recorded in `pro_migrations`); the move empties it.
- Ownership: both delete paths (`deleteRepo`, retention's `deletePrSubtree`) prune `tracker_tickets`
  by PR; `eraseAccountData` and `accountScopedTables()` cover all three; the account export carries
  `workspace_trackers` with the token reduced to `hasToken`.

### `0089_github_issue_links` — the issues a PR closes (GitHub Issues adapter)

Two additive columns on `pull_requests`: `closing_issues` (JSON text, lower-cased
`owner/repo#12` keys in GitHub's order) and `closing_issues_checked_at`. Written ONLY by the tracker
worker's targeted `nodes(ids:)` step (`tracker/github/links.ts`), and only for PRs in a workspace
whose tracker is GitHub Issues — the repo walk's query is unchanged. ⚠ NULL is "never read", never
"closes nothing" (`[]` is the positive statement); the worker neither prunes nor reads a PR whose
links are NULL. No data to move, no index (every read is by PR id). Journal `when` `1791100800000`.

### `0090_linear_links` — the Linear issues a PR is attached to (Linear adapter)

Three additive columns on `pull_requests`: `linear_links` (JSON text, upper-cased
`ENG-123` keys in Linear's order), `linear_links_root` (the Linear workspace, `https://linear.app/<key>`,
the read was made against) and `linear_links_checked_at`. Written ONLY by the tracker worker's Linear
linker (`tracker/linear/links.ts`, batched `attachmentsForURL`), only for PRs in a workspace whose
tracker is Linear with a saved key — the repo walk's query is unchanged. ⚠ NULL is "never read", and a
root other than the workspace's current one counts as never read; unlike GitHub's `closing_issues`
the links ADD to key detection, so NULL never hides a detected ticket. No data to move, no index
(every read is by PR id). Journal `when` `1791187200000`.


### Platform `0040_slack_event_signals` — the two Slack event signals

Two nullable boolean switches on `workspace_slack_targets` (`notify_reviews`, `notify_merges`; NULL
reads as off) and a new table `slack_signal_notices (account_id, kind, ref_id)` with unique index
`slack_signal_notices_account_kind_ref` — the claimed "already sent" markers (`kind` `merge` keys the
PR id, `review` the Claude Review run id). No data to move, no FK onto core (open-core boundary); the
table is in the plugin's erasure hook. No core migration: the merger was already synced
(`pull_requests.merged_by_id`).; the plugin chain now ends at **40**.

### `0093_dependency_auto_merge` — dependency auto-merge

Additive: `workspaces.dependency_auto_merge` (nullable boolean, NULL = OFF), `auto_merge_requests
.armed_by_policy` (nullable boolean, NULL = a person armed it) and a new table
`auto_merge_policy_skips` (`(account_id, pr_id)` unique `amps_account_pr`, composite FK
`amps_pr_account_fk` against `pull_requests(id, account_id)`, cascade). No data to move; existing
intents read as a person's. Journal `when` `1791446400000`. Contract:
docs/MERGE-CI-TRUNK.md § Dependency auto-merge.

### `0094_repo_uses_github_issues` — GitHub Issues as the automatic default tracker

Additive: `repos.uses_github_issues` (nullable boolean; NULL = never answered) and
`repos.github_issues_checked_at` (timestamp). Plus ONE data step: `UPDATE workspace_trackers SET
provider = 'none' WHERE provider IS NULL`. From here on `provider` NULL (or no row) means "no choice
stored → follow the automatic default" and the literal `'none'` is a chosen None; every NULL row that
existed before was somebody choosing None (the legacy move copies only rows with a value), so it
keeps that meaning. Journal `when` `1791532800000`, slotted BEFORE `0095` (written concurrently) — ⚠ drizzle's sqlite migrator skips an entry whose `when` is at or
below the newest APPLIED one, so a DB that had already applied 0095 before 0094 existed would skip
0094 silently; none did at the time of writing. Contract: docs/TRACKERS.md § Automatic default.

### `0096_workspace_setting_events` — settings history for Chronology "Over time"

Additive: a new APPEND-ONLY table `workspace_setting_events` (`account_id`, `workspace_id`, `kind`,
`summary`, `occurred_at`), index `workspace_setting_events_account_ws_time_idx`, and the named
COMPOSITE FK `workspace_setting_events_workspace_account_fk` onto `workspaces (id, account_id)` with
cascade (the `workspace_trackers` precedent — every writer gets the workspace id from a request path).
GOING FORWARD ONLY: nothing is backfilled, and the page states the first row's date as the start of
settings history. In `accountScopedTables()` and erased explicitly. Journal `when` `1791705600000` (after `0095`). Contract: docs/BOTTLENECKS.md § Over time.

### `0097_story_reports` — the story report's runs

Additive: a new table `story_reports` — one row per agentic story-report run (Reports → Stories):
`window_choice`, `from_at`/`to_at`, `range_json`, `model`, `status` (queued · running · succeeded ·
failed · cancelled), `fingerprint`, `picked_json`, `population_json`, `report_json` (null until
succeeded), `dropped_json`, `error`, `cost_usd`, `input_tokens`, `output_tokens`, `num_turns`,
`created_at`, `completed_at`. Index `story_reports_account_ws_window_idx` on (account, workspace,
window_choice, created_at), and the named COMPOSITE FK `story_reports_workspace_account_fk` onto
`workspaces (id, account_id)` with cascade (`workspace_id` arrives in a POST body; a report is
regenerable). In `accountScopedTables()` and erased explicitly. Journal `when` `1791792000000` (after `0096`). Contract: docs/CLAUDE-REVIEW.md § Story report.
⚠ **DORMANT since 2026-10-18** — the story report was removed; the table is kept, never dropped
(no read or write; still erased).
It REPLACED the per-story notes, whose plugin migration `0041_story_notes` was never committed and is
DELETED. A dev DB that ran it keeps an orphan `pro_story_notes` table (harmless) and
its `pro_migrations` record — never reuse the file name `0041_story_notes.sql`.

### `0098_tracker_ticket_dates` — a ticket's own created / resolved dates

Additive: two NULLABLE timestamp columns on `tracker_tickets` — `issue_created_at` and
`issue_resolved_at` (Jira `created` / `resolutiondate`, GitHub Issues `createdAt` / `closedAt`, Linear
`createdAt` / `completedAt`). No default and no backfill in SQL: a row read before this migration
stays NULL until its next read (open PRs: the 30-minute TTL; merged PRs: the worker's bounded
ticket-dates nudge, `tracker/dates-backfill.ts`). The positive-answer rule applies (an absent field
keeps the stored value; null clears). Neither column moves `changed_at`. Journal `when`
`1791878400000` (after `0097`). Contract: docs/TRACKERS.md § Created and
resolved dates. ⚠ The tracker test suites exec single migrations by name — each one that execs
`0088_issue_tracker.sql` now execs `0098` too.

### `0099_story_labels` — Story health's model labels

Additive: a new table `story_labels` — `account_id` (FK `accounts`, cascade), `ident`, `text_hash`,
`rubric_version`, `criteria_json`, `story_json`, `criteria_count`, `model`, `cost_usd`,
`input_tokens`, `output_tokens`, `created_at`; UNIQUE `story_labels_identity_ux` on (account_id,
ident, rubric_version, text_hash) — the label run's insert is `ON CONFLICT DO NOTHING` on exactly
that target. No workspace column (a ticket's story is one fact per account) and so no composite FK
(no request body names a row). In `accountScopedTables()`, erased explicitly, and checked by
`verify:isolation`. Journal `when` `1791964800000` (after `0098`).
Contract: docs/CLAUDE-REVIEW.md § Story labels.

### `0100_sprint_stories` — This sprint (then under Reports; now This Sprint, a fixed tab)

Additive: five new tables — `sprint_reads`, `sprint_tickets`, `sprint_ticket_repos`,
`sprint_assessments`, `tracker_writes` (docs/DATA-MODEL.md § This Sprint). Uniques (every
`onConflictDo*` uses exactly these): `sprint_reads (account_id, workspace_id)`, `sprint_tickets
(account_id, workspace_id, ident)`, `sprint_ticket_repos (account_id, workspace_id, ident, repo_id)`,
`tracker_writes (account_id, request_id)`; `sprint_assessments` has none. NAMED composite FKs onto
`workspaces(id, account_id)` on all five and onto `repos(id, account_id)` on `sprint_ticket_repos`,
all cascade. In `accountScopedTables()`, erased explicitly, `deleteRepo` deletes
`sprint_ticket_repos` rows, checked by `verify:isolation`. Contract: docs/TRACKERS.md § The sprint list
read / § The write-back.

### `0101_sprint_reads_api_root` — the site a sprint list was read from

Additive `sprint_reads.api_root text` (NULL before the first read). With `provider`, the GET
(`db/sprint-stories.ts`) spots a workspace that moved to another tracker or site since its stored read
and resets that row (`resetSprintReadForSite`: no source, no read time, due now) so the page says
"Reading…" instead of the old read's time over an empty list. A separate migration because `0100` was
already applied in development.

### `0102_workspace_sprint_checks` — which chips a workspace raises
`workspaces.sprint_checks` (text JSON), OVERRIDES ONLY (`SprintChecks`): NULL = every
Reports → This sprint check on for every issue type. Read and written only by `db/sprint-checks.ts`.

### `0103_sprint_statuses_and_blockers` — sections by status, blocking links
Six additive, nullable columns, no new table (so `accountScopedTables()` is unchanged):
`tracker_tickets` + `sprint_tickets` gain `blocked_by_json` (the ticket's blocking tracker links,
`TicketLinkBlocker[]`; NULL = not read, never "none") and `status_id`; `sprint_reads` gains
`status_order_json` (the automatic status order); `workspaces` gains `sprint_statuses` (the
per-workspace override). Text JSON. Journal `when` `1792051203000`. Ships with
rubric 2 of the story labels (`STORY_RUBRIC_VERSION` 2 — a code bump, no migration: old
`story_labels` rows simply stop counting).

### `0104_sprint_ticket_repos_saved` — "the reader saved this ticket's repos"
One additive, nullable column, no new table: `sprint_tickets.repos_saved_at`, stamped by `PUT
/api/sprint-stories/repos` even for an EMPTY set. NULL = never saved, so the CONFIDENT repo
suggestions are the accepted set by default (`effectiveSprintRepos`); a ticket with stored
`sprint_ticket_repos` rows but no stamp counts as saved. The sprint read's upsert never sets it; a
pruned row takes it with it. The same release changes the SHAPE of `workspaces.sprint_statuses` to
`{sections}` (four stages) with NO migration: a stored `{order, deliveredFrom}` is converted on read.
(2026-10-17: the shape moved again, to `{buckets, mergedColumn}` — user-defined status buckets — also
with NO migration; both older shapes are converted on read. docs/TRACKERS.md § The status order and
buckets.)
Journal `when` `1792051204000`.

### `0106_sprint_ref_tickets` — referenced tickets' status
One additive table, `sprint_ref_tickets` (account, workspace, ident, provider, api_root, issue_key,
title, status_name, status_category, url, read_at), unique `(account_id, workspace_id, ident)` (the
lookup's `onConflictDoUpdate` target), index `(account_id, issue_key)`, named composite FK onto
`workspaces(id, account_id)` with cascade. Written only by the sprint read (docs/TRACKERS.md § The
sprint list read → Referenced tickets). Ships with rubric 4 of the story labels (`STORY_RUBRIC_VERSION`
4 — a code bump: every story relabels). Journal `when` `1792051203003`.

### `0107_sprint_graph` — the sprint graph: ghost text, briefs; the write-back's table dropped
Additive on `sprint_ref_tickets`: `description`, `acceptance_criteria`, `issue_type_name`,
`assignee_name`, `assignee_avatar_url`, `blocked_by_json` (text) and `depth` (integer
NOT NULL DEFAULT 1 — existing rows read as named by the sprint). New table `sprint_briefs` (account,
workspace, ident, text_hash, brief_version, summary, criteria_json, criteria_derived, references_json,
model, cost/tokens, created_at), unique `(account_id, workspace_id, ident)` (the pass's
`onConflictDoUpdate` target), named composite FK onto `workspaces(id, account_id)` with cascade; in
`accountScopedTables()` + erasure + `verify:isolation`. `DROP TABLE IF EXISTS tracker_writes` — the
write-back is removed (its rows are history of a feature that no longer exists; nothing reads them).
`workspaces.sprint_checks` is NOT dropped (SQLite needs a table rebuild): it is dormant. Journal `when`
`1792051203004`.

### `0108_sprint_themes` — the sprint graph's themes
New table `sprint_themes` (account, workspace, input_hash, theme_version, themes_json, assignments_json,
model, cost/tokens, created_at), unique `(account_id, workspace_id)` (the pass's `onConflictDoUpdate`
target), named composite FK `sprint_themes_workspace_account_fk` onto `workspaces(id, account_id)` with
cascade; in `accountScopedTables()` + erasure + `verify:isolation`. Purely additive. Journal `when`
`1792051203005`.

### `0109_sprint_story` — the sprint story (⚠ DORMANT since `0120`)
New table `sprint_story` (account, workspace, input_hash, story_version, story_json, model, cost/tokens,
created_at), unique `(account_id, workspace_id)` (the pass's `onConflictDoUpdate` target), named
composite FK `sprint_story_workspace_account_fk` onto `workspaces(id, account_id)` with cascade; in
`accountScopedTables()` + erasure + `verify:isolation`. Purely additive. Journal `when` sqlite
`1792137603005`.

### `0110_finding_reminder` — Claude Review reminders
`claude_review_findings.reminder` (`text` JSON, nullable): the latest "Post reminder"
of an already-posted finding (`ClaudeFindingReminder`; earlier reminders' comment ids in
`earlierCommentIds`). NULL = none. Never the finding's own post. Purely additive; no new table, so
nothing joins `accountScopedTables()` (the column rides the findings' existing delete paths). Journal
`when` `1792137603006`.

### `0111_sprint_dates_story_attempt` — the sprint's dates + the story pass's last attempt (the three `story_attempt_*` columns DORMANT since `0120`)
Five nullable columns on `sprint_reads`: `sprint_starts_at` / `sprint_ends_at` (the tracker's own sprint
dates, written by every good sprint read — docs/TRACKERS.md § The sprint list read) and
`story_attempt_at` / `story_attempt_hash` / `story_attempt_error` (the sprint story pass's last attempt
that called Claude and its failure code, NULL = stored — the backoff of the retired story pass). Purely additive on an already account-scoped table; `resetSprintReadForSite` clears all
five. Journal `when` `1792137603007`.

### `0112_sprint_view_snapshots` — "Since you last looked" on This Sprint
New table `sprint_view_snapshots`: ONE row per (account, workspace) with two slots, `current_json` /
`current_at` (the latest view's snapshot: each sprint ticket's stage + the merged pull requests on sprint
tickets) and `baseline_json` / `baseline_at` (the previous visit's last view; NULL until a second visit).
Written and read only by `db/sprint-signals.ts` (docs/CLAUDE-REVIEW.md § Sprint paths → The code cards).
Account FK (cascade) + the NAMED composite FK `sprint_view_snapshots_workspace_account_fk` onto
`workspaces (id, account_id)`; unique `(account_id, workspace_id)`; in `accountScopedTables()`, erased,
checked by `verify:isolation`. Journal `when` `1792137603008`.

### `0113_ai_fix_plan` — AI Fix plan mode
Six nullable columns on `ai_fixes`, no backfill: `plan` (JSON `AiFixPlan`), `plan_transcript` (JSON
`AiFixPlanMessage[]`), `plan_status` (`planning | plan_ready | approved | discarded | failed`; NULL = never
planned), `plan_revision` (integer), `plan_seed` (JSON `{kind, text}`, server-only) and `plan_cost_usd`
(`real`). Text JSON like the table's other JSON columns. A plan row carries
the new `status = 'planned'` until it is approved or discarded (docs/CLAUDE-REVIEW.md § Plan mode). No new
table, so `accountScopedTables()` / erasure / both delete paths already cover it. Journal `when` sqlite
`1792137603009`.

### `0114_sonarcloud` — SonarCloud
Two new tables (docs/SONARCLOUD.md). `workspace_sonar`: one row per workspace — `organization`, the SEALED
write-only `auth_token` (tracker/secret.ts forms), `project_keys` (JSON map repoId → key, overrides only),
`updated_at`; the named COMPOSITE FK `workspace_sonar_workspace_account_fk` onto `workspaces (id, account_id)`
and unique `(account_id, workspace_id)`. `sonar_snapshots`: one row per `(account_id, pr_id, head_sha)`
(unique) — `state`, `message`, `project_key`, `quality_gate` / `issues` / `post` JSON (text), `total_issues`, `total_hotspots`, `fetched_at`. No FK on `pr_id` (the tracker_tickets precedent),
so BOTH delete paths delete it explicitly. Both tables are in `accountScopedTables()`, erased, and checked
by `verify:isolation`. Journal `when` `1792137603010`.

### `0115_sequence_diagrams` — sequence diagrams
One new table (docs/CLAUDE-REVIEW.md § Sequence diagrams). `sequence_diagrams`: one row per
`(account_id, kind, subject, fingerprint)` (unique `sequence_diagrams_subject_fp`) — `kind` `pr|story`,
`subject` (the PR id as text, or the ticket ident), `pr_id` (pr rows; NULL on story rows), `ticket_key`,
`head_sha`, `members` JSON (text), `trigger`, `status`, `model`, `title`, `caption`,
`diagram_type`, `source`, `refusal`, `error`, the run's telemetry (`cost_usd` real) and three timestamps; index `(account_id, created_at)` for the daily cap. No FK on `pr_id`
(the sonar_snapshots precedent): BOTH delete paths delete PR rows explicitly; story rows go with the
account. In `accountScopedTables()`, erased, and checked by `verify:isolation`. Journal `when` sqlite
`1792137603011`.

### `0118_sequence_diagram_runs` — one sequence-diagram row per run
Drops the unique `sequence_diagrams_subject_fp` and creates the plain index
`sequence_diagrams_subject_fp_idx` on the same columns. A Redraw at the same fingerprint used to REWRITE
the row holding the good diagram (clearing it, for good if the redraw failed); every queued run is now
its own row and nothing writes `ON CONFLICT` on this table any more. Story rows now also go with a
deleted member PR in both delete paths (`db/sequence-diagram-prune.ts`; code, not DDL). Journal `when`
`1792137605014`.

### `0119_design_diagrams` — the design grid replaces Mermaid
One nullable JSON column on `sequence_diagrams`: `design` (`text` json mode) — the
validated `DesignDiagram` (docs/CLAUDE-REVIEW.md § Design diagrams). `source` is KEPT and no longer
written. No backfill and no row deletes: design-era rows are told apart by `diagram_type = 'design'`
(stamped at queue time, code not DDL), and the reads ignore every other row.

### `0116_reference_docs` — the reference docs library
One column and two tables (docs/REFERENCE-DOCS.md). `workspaces.docs_in_review` (integer, nullable, no default — NULL/false = off). `reference_docs`: one row per document — `slug`
(unique `(account_id, workspace_id, slug)`), `title`, `source_kind`, `source_name`, `source_url`,
`byte_size`, `status`, `progress`, `stage`, `error`, `section_count`, `sections` / `topics` JSON (text), `summary`, `page_count`, the latest build's telemetry (`cost_usd` real) and `created_at` / `updated_at` / `build_started_at` / `built_at`. `reference_doc_chat_messages`:
`conversation_id`, `role`, `content`, `citations` JSON, telemetry, `created_at`; index
`(account_id, workspace_id, conversation_id)`. Both take the named COMPOSITE FK onto
`workspaces (id, account_id)` (`reference_docs_workspace_account_fk`, `reference_doc_chat_workspace_account_fk`).
The text lives as FILES under `<docsDir>/<accountId>/<workspaceId>/`, removed by erasure and the workspace
delete route. Both tables in `accountScopedTables()`, erased, and checked by `verify:isolation`. Journal
`when` `1792137603012`.

### `0117_review_doc_references` — reference docs in reviews
Two nullable JSON columns, no index (docs/REFERENCE-DOCS.md § Use in reviews). `claude_reviews.doc_references`
(text): the reference-library passages a PR review used, each server-checked — NULL = the
run did not read the library, `[]` = it read it and kept nothing. `claude_review_findings.doc_citations`
(text): the library sections one finding rests on, NULL = none. The ticket review and the
sprint check need NO column: theirs ride their existing JSON (`ticket_reviews.assessment.references`,
`sprint_assessments.body_json.references`). Both columns sit on tables already in the delete paths and
erasure. Journal `when` `1792137604013`.

### `0120_sprint_paths` — the sprint builder's critical paths
New table `sprint_paths`: ONE row per (account, workspace) — `input_hash`, `paths_version`, `paths_json`
(text JSON; ticket KEYS only), `model`, `cost_usd` (real),
`input_tokens`, `output_tokens`, `written_at` (all nullable: a row may hold only an attempt or a counted
run), the last attempt `attempt_at` / `attempt_hash` / `attempt_error`, today's run count `runs_day`
('YYYY-MM-DD' UTC) + `runs_today` (not null, default 0), `created_at` / `updated_at`. Unique
`(account_id, workspace_id)` — EVERY `onConflictDoUpdate` on it targets exactly that; account FK (cascade)
+ the NAMED composite FK `sprint_paths_workspace_account_fk` onto `workspaces (id, account_id)`; in
`accountScopedTables()`, erased, checked by `verify:isolation` (docs/CLAUDE-REVIEW.md § Sprint paths).
⚠ It REPLACES the Haiku sprint story: `sprint_story` (`0109`) and
`sprint_reads.story_attempt_at / _hash / _error` (`0111`) are DORMANT from here — never
written or read, kept for their rows (`sprint_story` is still erased). Journal `when` sqlite
`1792137607016`.

### `0121_story_docs_alignments` — check a story against the docs
New table `story_docs_alignments`: ONE row PER RUN (a click) — `ident`, `ticket_key`, `status`, the
`fingerprint` + its parts `story_hash` / `criteria_hash` / `library_hash` / `version`, `criteria_source`,
`criteria_json` / `shortlist_json` / `result_json` (text JSON), `error`, `shortlist_model`,
`model`, `cost_usd` (both calls), tokens, turns, `created_at` / `started_at` / `completed_at`. NO unique
index (so no `onConflictDoUpdate` target to keep in step); indexes `(account_id, workspace_id, ident, id)`
and `(account_id, created_at)` (the daily cap). Account FK (cascade) + the NAMED composite FK
`story_docs_alignments_workspace_account_fk` onto `workspaces (id, account_id)`, ON DELETE cascade — a
deleted workspace takes its runs (their links name THAT library; NOT re-homed to Default by
`deleteWorkspace`). In `accountScopedTables()`, erased, checked by `verify:isolation`; not exported (model
output, regenerable). Journal `when` `1792137608016`.

### `0122_claude_thread_checks` — Check threads
New table `claude_thread_checks`: ONE row PER RUN of the light threads-only pass — `workspace_id`
(the auto daily cap), `pr_id`, `repo_id`, `head_sha`, `trigger` (`manual|auto`), `status`, `model`,
`threads_sent`, `thread_assessments` (the WHOLE reconciled set; text JSON),
`comments_through`, `refused`, `error`, cost/tokens/turns, `started_at` / `completed_at` / `created_at`.
NO unique index (no `onConflictDoUpdate` target). Indexes `(account_id, pr_id, created_at)` and
`(account_id, workspace_id, created_at)`. Account FK (cascade) + the NAMED composite FK
`ctc_pr_account_fk` onto `pull_requests (id, account_id)`, ON DELETE cascade (the `ci_reviews`
pattern, so neither delete path needs an entry). In `accountScopedTables()`, erased, checked by
`verify:isolation`. Journal `when` `1792137609016`.

### `0123_sprint_brief_one_liner` — the sprint card's one line
`ALTER TABLE sprint_briefs ADD one_liner text` (nullable). Written by the
brief pass from `SPRINT_BRIEF_VERSION` 5; a row without it is a pre-v5 brief and no longer current. Column
only — no new table, so no `accountScopedTables()` / erasure / `verify:isolation` change (`sprint_briefs`
is already covered). The `onConflictDoUpdate` `set:` in `storeSprintBrief` carries it. Journal `when`
`1792137610016`.

### `0124_reference_doc_crawl` — "Follow links" on a web page
`ALTER TABLE reference_docs ADD COLUMN crawl_json` (`text` JSON, nullable;
`ReferenceDocCrawl`). NULL = one page or an uploaded file (every existing row). Column only — no new
table, so no `accountScopedTables()` / erasure / `verify:isolation` change (`reference_docs` is already
covered). [REFERENCE-DOCS.md](REFERENCE-DOCS.md) § Following links. Journal `when` sqlite
`1792137611016`.

### `0126_workspace_auto_diagrams` — design diagrams after each review, per workspace
`ALTER TABLE workspaces ADD auto_diagrams_enabled integer DEFAULT 1 NOT NULL`. ⚠ **DEFAULT TRUE on
purpose**: a diagram was drawn after every review before this column, so every workspace, existing
and new, keeps that until someone switches it off; no backfill, and the inserts in `db/queries.ts`
need not name it (the DDL default is the product default, unlike `0083`/`0084`). Read side: only a
stored false is off. Written only by `setWorkspaceAutoReview`; read by review/diagrams/trigger.ts via
`diagramsSwitchedOnForPr`. Column only — no new table, so no `accountScopedTables()` / erasure /
`verify:isolation` change (`workspaces` is already covered). [CLAUDE-REVIEW.md](CLAUDE-REVIEW.md)
§ Design diagrams. Journal `when` sqlite `1792137613016`.

### `0127_ai_usage_provider` — the spend ledger names its AI provider
`ALTER TABLE ai_usage ADD provider text DEFAULT 'claude' NOT NULL` + `ADD share_pct real` (nullable).
The provider seam (`ai/provider.ts`, [CODEX-PLAN.md](CODEX-PLAN.md) § 8.1): every row before it was
Claude's, and SQLite fills the default into existing rows; `share_pct` is a subscription run's rise in
its provider's weekly window when the provider reports one (NULL for every Claude row). Token columns
stay nullable. Every budget fold over the ledger (`ai/budget.ts` `readLedger`, `readCycleCosts`)
filters on `provider` = the active provider. Column only — `ai_usage` is already in
`accountScopedTables()`, erasure and the export. Pinned fresh + upgraded by
`db/ai-usage-provider-migration.test.ts`. Journal `when` sqlite `1792137614016`.

### `0130_ai_effort` — the Effort setting and the effort each run used
`ALTER TABLE accounts ADD ai_effort text` (Settings → AI → Effort; NULL = Default; written by
`PUT /api/ai/effort`, loaded at boot by `ai/provider-store.ts`), `claude_reviews ADD effort text`,
`ai_fixes ADD effort text` + `ADD plan_effort text` (the effort the run SENT, stamped with its provider
and model; NULL on every older row). Additive, nullable, columns only — every table is already in
`accountScopedTables()`, erasure and the export; no `verify:isolation` change. Pinned by
`api/routes/ai-provider.test.ts` and `review/claude-review/mixed-providers.test.ts`.
[CLAUDE-REVIEW.md](CLAUDE-REVIEW.md) § The effort setting. Journal `when` sqlite `1792137617016`.

### `0131_related_repos` — related repos + what a review read beside the PR
`CREATE TABLE repo_relations (account_id, workspace_id, repo_id, related_repo_id, created_at)` with
three NAMED composite FKs (`repo_relations_workspace_account_fk`, `…_repo_account_fk`,
`…_related_repo_account_fk`, all cascade), the unique `repo_relations_pair` on all four keys and the
index `(account_id, repo_id)`; plus `ALTER TABLE claude_reviews ADD peers_read text` (JSON, NULL on
every older row). Symmetric, stored both ways; off by default (no rows). Joins
`accountScopedTables()`, the erasure (before `workspaces`) and the export; `deleteRepo` and every
membership writer drop a moved repo's rows. `verify:isolation` covers the setting and the
review-time read. [CLAUDE-REVIEW.md](CLAUDE-REVIEW.md) § Related repos. Journal `when` sqlite
`1792137618016`. (Written as `0130` on its own branch beside `0130_ai_effort`; renumbered to `0131`
when the two merged, before either shipped.)

### `0132_sprint_code_judgements` — This Sprint's "Needs code" judgements
`CREATE TABLE sprint_code_judgements (account_id, workspace_id, ident, text_hash, judge_version,
needs_code, reason, model, provider, cost_usd, input_tokens, output_tokens, created_at)` with the
unique `sprint_code_judgements_account_ws_ident` (the ONLY `onConflictDoUpdate` target) and the named
composite FK `sprint_code_judgements_workspace_account_fk` onto `workspaces(id, account_id)` (cascade).
Additive. Joins `accountScopedTables()`, the erasure and the export. [CLAUDE-REVIEW.md](CLAUDE-REVIEW.md)
§ Sprint code judgements. Journal `when` sqlite `1792137619016`. (Parallel branches may also have taken
`0132`; renumber on merge like `0131`.)

### `0134_team_claims` — "Mark auto reviews on GitHub"
`ALTER TABLE workspaces ADD team_claims_enabled integer` (NULL/0 = OFF, the default; only a stored true
is on) and `ALTER TABLE claude_reviews ADD team_claim text` (JSON `ClaudeTeamClaimRecord`: what the
team claim did for one AUTO run; NULL = no claim attempted). Additive; both ride existing tables, so
the erasure and the export already cover them. [CLAUDE-REVIEW.md](CLAUDE-REVIEW.md) § Team claims.
Journal `when` sqlite `1792137621016`.

### `0135_review_pairs` — Claude + Codex pairs
`ALTER TABLE claude_reviews ADD pair_id integer` (the FIRST half's run id, on both halves), `ADD
pair_role text` (`'first'` \| `'second'`), `ADD pair_dropped integer` (the second half's findings
dropped in code as repeats of the first's), and `ALTER TABLE workspaces ADD auto_review_providers text`
(NULL = auto reviews on the default provider; `'both'` = a pair). Additive, nullable, no backfill: every
older row is an ordinary run, every workspace keeps the default. No FK on `pair_id` (a soft link like
`prior_finding_id`; both halves are the same account's rows of the same PR). Both tables are already in
`accountScopedTables()`, the erasure and the export. [CLAUDE-REVIEW.md](CLAUDE-REVIEW.md) § Claude +
Codex. Journal `when` sqlite `1792137622016`.

### `0136_review_kind` — the replies pass
`ALTER TABLE claude_reviews ADD kind text`: `'replies'` on a REPLIES PASS (a run that judged only
people's replies on Limn's own posted findings), NULL on every full review, older rows included.
Additive, nullable, no backfill. ⚠ Every "latest review" / "run at this head" reader now filters
`kind IS NULL` (the list is in [CLAUDE-REVIEW.md](CLAUDE-REVIEW.md) § The replies pass); the table is
already in `accountScopedTables()`, erasure and the export. Journal `idx` 136, `when` sqlite
`1792137623016`. `0134`, `0135` and `0136` were built in parallel and landed together, in order.

### `0137_review_pair_consolidation` — a Claude + Codex pair as ONE review
`ALTER TABLE claude_reviews ADD pair_consolidation text` (JSON `ClaudeReviewPairConsolidation`, on a
pair's FIRST row only: the one summary, the code verdict, each kept finding's source, the merged-away
duplicates and the half that did not finish) and `ALTER TABLE claude_review_findings ADD merged_into
integer` (a merged-away duplicate → the kept finding's id; no FK, a soft link like
`prior_finding_id`). Additive, nullable, no backfill: an older pair reads as its two halves joined in
code. Both tables are already in `accountScopedTables()`, the erasure and the export.
[CLAUDE-REVIEW.md](CLAUDE-REVIEW.md) § Claude + Codex. Journal `idx` 137, `when` sqlite `1792137624016`.

### `0138_team_claim_lines` — the team-claim LEDGER
A new CORE table, `team_claim_lines`: one row per GitHub status line (`limn/review-claude` |
`limn/review-codex`) this machine holds or released on a PR head (`whose 'mine'`: state `claiming` →
`pending` → `finished` | `released`; `whose 'teammate'`: a teammate's expired line released once). Written
BEFORE the pending line is posted, so the reconciler (`team-claim-release.ts`, boot + every auto-review
tick) can release a line a restart or a dropped run left pending. Two indexes (`state`; `account_id,
pr_id, head_sha`). `owner` / `name` (the repo, at write time) let a line be released after its PR or
repo left Limn. No FK on `pr_id` (the `sonar_snapshots` precedent): `deleteRepo` and retention's
`deletePrSubtree` delete its rows EXCEPT this machine's OPEN ones; the erasure and
`accountScopedTables()` take it explicitly. ⚠ ONE BACKFILL: every
(account, PR, head, context) whose NEWEST auto run's `team_claim` record (from the last 14 days) still
read pending (`state 'marked'`, `lastLine 'reviewing' | 'unfinished'`) gets a `pending` row with a NULL
login (the account's login is used) and the repo's owner/name, so lines older Limn left pending are
released at the first boot — ⚠ only where the head's newest line is still this account's pending one (the
reconciler reads GitHub first; a teammate's newer claim or review is left alone). (The `owner`/`name`
columns were added to 0138 in place before it shipped.)
[CLAUDE-REVIEW.md](CLAUDE-REVIEW.md) § Team claims → Releasing stale lines. Journal `idx` 138, `when`
sqlite `1792137625016`.

### `0139_instance_meta` — this database's own id
A new CORE table, `instance_meta (key text PK, value text)`: facts about the database FILE, never an
account's — so NOT in `accountScopedTables()`, not erased, not exported. One key so far, `instance_id`,
a random UUID written on first read (`db/instance-id.ts`, insert-or-ignore then re-read). It is the
reference-docs `.owner` marker that stops one database's janitor deleting another's library
([REFERENCE-DOCS.md](REFERENCE-DOCS.md) § Ownership). No backfill. Journal `idx` 139, `when`
sqlite `1792137626016`.

### `0140_reference_doc_wiki` — Confluence (wiki) sources for the reference library
Self-contained and additive ([REFERENCE-DOCS.md](REFERENCE-DOCS.md) § Wiki sources). Two new JSON columns
on `reference_docs` — `wiki_json` (`ReferenceDocWikiState`: provider, site, root page, depth, last check,
daily list, unreachable since / why, a 429's retry-after) and `summary_cache_json`
(`ReferenceDocSummaryCache`: section content hash → summary + the document summary); a UNIQUE index
`reference_docs (id, account_id)` (the target of the new composite FK); `workspaces.docs_used_at` (the
refresh's 7-day demand gate). Two new tables: `reference_doc_wiki_pages` (one row per page: version,
last edit, converted-markdown hash, last fetch, last error; unique `(doc_id, page_id)`, the upsert
target; named composite FK `(doc_id, account_id)` → `reference_docs (id, account_id)` ON DELETE
CASCADE) and `workspace_wiki_credentials` (a SEALED wiki token per `(account, workspace, provider)`;
composite FK onto `workspaces`, cascade). Both join `accountScopedTables()`, the erasure (explicitly,
pages before their documents) and the export (the credential WITHOUT its token); the docs DELETE route
removes the page rows explicitly too. No backfill. Journal `idx` 140, `when` sqlite `1792137627016`

### `0141_tracker_ticket_comments` + `0142_ticket_review_comments_seen` — ticket comments
`0141` creates the CORE table `tracker_ticket_comments`: one row per `(account_id, provider, api_root,
issue_key, comment_id)` — per TICKET, never per PR — with author name + id, `is_bot`, markdown `body`,
`created_at` / `updated_at` / `fetched_at`, and the unique index every upsert targets
(`tracker_ticket_comments_ticket_comment`). No FKs (the `tracker_tickets` precedent): the worker's key
prune and BOTH PR delete paths remove comments of tickets no `tracker_tickets` row names
(`db/ticket-comments-prune.ts`); the erasure and `accountScopedTables()` take it explicitly. `0142` adds
the nullable `ticket_reviews.comments_seen` (JSON `{ids, count, hash}`), kept OUT of the fingerprint.
Split in two so a test schema can build the tracker table without `ticket_reviews`. Additive, no
backfill: comments arrive on each ticket's next read.
[TRACKERS.md](TRACKERS.md) § Ticket comments. Journal `idx` 141 / 142, `when` sqlite `1792137629016` /
`1792137630016`.

### `0143_reference_doc_figures` — figures as text (+ Notion, which needs no schema)
Self-contained and additive ([REFERENCE-DOCS.md](REFERENCE-DOCS.md) § Figures, § Wiki sources → Notion).
One new nullable JSON column, `reference_docs.figures_json` (`ReferenceDocFigures`: the latest build's
described / outlined / kept / pending figures and the one sentence when they could not be described here),
and one new table, `reference_doc_figure_descriptions` — the AI image-description CACHE, one row per
`(account_id, image_hash)` (UNIQUE, the upsert target): `description` (one line, or `DECORATIVE`),
`provider`, `model`, `cost_usd`, `created_at`; FK onto `accounts`, cascade. It joins `accountScopedTables()`,
the erasure (explicitly) and the export, and `verify:isolation` checks it. NOTION adds no schema: its token is
a `workspace_wiki_credentials` row with provider `notion` (0140), and `reference_docs.wiki_json` already
carries the provider. No backfill. Journal `idx` 143, `when` sqlite `1792137632016`.

### `0144_workspace_tracker_notion` — Notion as an issue tracker
Adds the nullable `workspace_trackers.notion_config` (text, JSON shared `NotionTrackerMapping`): the
Notion database's property mapping beside the one tracker row it belongs to. On an existing table, so
the erasure, the export (named column, not a secret) and the composite FK already cover it. Additive, no
backfill: a Notion workspace is unmapped until someone saves a mapping. Every tracker test that builds
`workspace_trackers` from `0088` also runs `0144`.
[TRACKERS.md](TRACKERS.md) § Notion. Journal `idx` 144, `when` sqlite `1792137640016`.

### `0145_verdict_strictness` — the auto verdict's two rules + a replies pass's reason
`ALTER TABLE workspaces ADD pair_verdict_strictness text` (NULL = strict: a Claude + Codex pair
approves only when both approved; `'relaxed'`), `ALTER TABLE workspaces ADD approve_leftovers text`
(NULL = nits and questions may stay open on an approve; `'nits'`, `'none'`) and `ALTER TABLE
claude_reviews ADD verdict_reason text` (JSON `{heldReason, text}`, a replies pass's "Not approved: …"
line). Additive, nullable, no backfill: NULL is today's rule everywhere. Both tables are already in
`accountScopedTables()`, the erasure and the export. [CLAUDE-REVIEW.md](CLAUDE-REVIEW.md) § Auto-posting
→ THE TWO RULES / THE REASON. Journal `idx` 145, `when` sqlite `1792137641016`. ⚠ Written as `0139` on its own branch and
renumbered on merge (the reference-docs and tracker migrations had published 0139–0144); a database that
had applied it as `0139` was re-applied by hand once.

### `0146_ai_fix_checks` — AI Fix "Run tests"
`ALTER TABLE ai_fixes ADD checks text` — JSON `AiFixChecks`: the check names the reader ticked
(written at insert, so an approved plan's build runs the same), then what Limn ran (results, install
steps, the commit hook). Additive, nullable, no backfill: NULL = no tests asked for (every older row,
every auto fix). `ai_fixes` is already in `accountScopedTables()`, the erasure and the export.
[CLAUDE-REVIEW.md](CLAUDE-REVIEW.md) § Run tests. Journal `idx` 146, `when` sqlite `1792137642016`.
⚠ Written on its own branch: renumber on merge if another branch published `0146` first.

### No migration — "Check against code" removed (2026-10-18): `sprint_ticket_repos` + `sprint_assessments` DORMANT

The sprint drawer, its repo picker and "Check against code" (`review/sprint-assess/`) were removed with
the story view. NO drop migration: `sprint_ticket_repos` (`0100`), `sprint_assessments`
(`0100`, `mode` from `0105`) and `sprint_tickets.repos_saved_at` (`0104`) stay in the schema, the journal and `accountScopedTables()` + erasure; nothing reads or
writes them (`deleteRepo` and the sprint read's prune still delete `sprint_ticket_repos` rows). The two
json columns of `sprint_assessments` are typed `unknown` now that the shared body types are gone.

## 2026-10-18 — six plugin tables made DORMANT (no migration)

Removing the one-shot Haiku features (AI PR summary, "Check review", assess / addressed checks,
the per-hunk conflict suggestion, the per-repo digest, "Discussion themes", preset prompts) took
**no migration in either repo**: `repo_digests`, `human_theme_reports`, `comment_assessments`,
`addressed_checks`, `ai_pr_analyses` and `preset_reports` stay declared, erased and pruned; nothing
reads or writes them. `pr_comment_annotations` stays live for `impact`; its comment-kind rows and
`pro_synthesis`'s `brief` / `rollup` rows are dormant. See DATA-MODEL.md § Dormant tables.
