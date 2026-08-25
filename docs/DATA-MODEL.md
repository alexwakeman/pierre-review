# Data model & derived thread state

> Split out of CLAUDE.md (2026-08) to keep the root memory file lean. This is the
> authoritative deep-dive for this area; CLAUDE.md keeps only the summary and the
> cross-cutting landmines. Add new detail HERE, not to CLAUDE.md. References to other
> sections of the old CLAUDE.md resolve via the doc map at the top of CLAUDE.md.

### Derived thread state — the heart of the app

`derive-thread-state.ts` classifies each review thread into one of four states,
computed during sync and **stored** on `reviewThreads.derivedState`:

| State | Meaning |
|---|---|
| `resolved` | marked resolved on GitHub |
| `likely_addressed` | a commit touched the thread's file _after_ the last comment — **a heuristic** |
| `replied_unresolved` | someone replied, but it's unresolved and no later commit touched the file |
| `untouched` | no reply, no follow-up commit |

`likely_addressed` is intentionally fuzzy (false positives from unrelated edits; false
negatives from renames/deletes) — **the UI communicates that uncertainty**; covered by
fixture tests (see Conventions).

### Data model (`src/db/schema.sqlite.ts` + its `schema.pg.ts` twin are authoritative)

28 tables. Multi-tenancy as above (`accountId` denormalized onto the anchor tables;
`users` + `commitFiles` global). The core entities:

- **`accounts`** — a tenant. Local mode has exactly one (`id 1`, `isLocal=true`,
  synthesized from `gh api user`); cloud has one per signed-in user (encrypted
  `accessTokenEnc`). `lastActiveAt` gates the periodic sync (see Sync). Replaces the
  old `localUser` singleton.
- **`repos`** — the account's repos (`accountId`; unique `(accountId, owner, name)` and
  `(accountId, githubNodeId)`). The `repos_id_account` unique index is NOT a lookup index — it is
  the PARENT KEY of the composite `(repo_id, account_id)` FK on `workspace_repos`.
  **`createdAt` (when the repo was ADDED) is LOAD-BEARING, not bookkeeping: it is My Turn's clock.**
  An open, non-draft PR by a non-bot human other than you enters the "New PRs" section only when
  `openedAt >= repos.createdAt` **for its own repo**, so adding a repo with 400 open PRs does not
  dump all 400 into My Turn on day one. ⚠ The cutoff is **per repo** — a single global one passes a
  one-repo fixture and is wrong the moment a second repo is added later (pinned, with that exact
  case, by `db/my-turn-new-prs.test.ts`).
  **`description`** (TEXT, nullable) is the repo's GitHub "About" text, captured by the activity
  sync like `defaultBranch`/`viewerPermission` — the app's ONLY stored repo-purpose text (READMEs
  are never fetched; PR bodies are lean), added as grounding for the sprint chat's
  "About this Workspace" preset. ⚠ Its write follows the three-state partial-response policy AND
  the tolerant-partial caveat: a `graphqlTolerant`-salvaged page nulls an ERRORED field with the
  key still present, so `sync-repo.ts` degrades the whole field to `undefined` (preserve) whenever
  `onPartial` fired — only a CLEAN response may clear a stored description.
  **There is NO second visibility axis.** `inbox_watch` / `inbox_watch_started_at` — a per-repo
  "watched" toggle that quietly narrowed the Feed, recent activity, My Turn and the Pro digest
  collection to a subset of the added repos — were DROPPED in migration `0046` (pg `0033`). With
  Workspaces the **Workspace IS the scope**, and a second axis on top of it only made it ambiguous
  which of the two a given screen was obeying. **Every repo in a workspace is fully live**: Feed,
  Activity, My Turn and Bots all cover it. The one property the watch window really bought is the
  `createdAt` cutoff above, which is why that survived the column that used to carry it
  (`inbox_watch_started_at`).
- **`workspaces`** + **`workspaceRepos`** — **the app's ONE scope** (CORE, `accountId`-scoped).
  A workspace is a named grouping of an account's repos; it replaced `teams`/`team_repos` and the
  five-branch `TeamScope` union (`'all' | 'none' | 'teams' | number | number[]`) with a plain
  workspace id. Exactly one row per account carries `isDefault` — auto-created, **RENAMEABLE, NOT
  deletable**, and every new repo lands in it. That invariant is a DATABASE fact: a PARTIAL UNIQUE
  INDEX `workspaces_one_default ON workspaces(account_id) WHERE is_default` (created in the `.sql`
  migrations, not the drizzle config — drizzle index predicates are metadata nothing here consumes),
  which is what lets `ensureDefaultWorkspace` be `INSERT … ON CONFLICT DO NOTHING` + re-SELECT
  instead of a SELECT-then-INSERT that 500s the loser of a race. `workspaces_id_account` is the
  parent key of the composite workspace FKs, exactly as `repos_id_account` is for the repo ones.
  - **`workspaceRepos` is unique on `(accountId, repoId)`** — a repo is in **EXACTLY ONE**
    workspace, as a database fact, so assignment is an **UPSERT on that key, i.e. a MOVE**, and no
    code path can produce a second membership row. There is no `removeRepoFromWorkspace`: "remove"
    is "move to Default". It is a JOIN TABLE and not a `repos.workspace_id` column because SQLite
    cannot ADD a constraint to an existing table nor cheaply make a column NOT NULL — a NOT NULL FK
    on `repos` means rebuilding `repos` under `foreign_keys=ON` with every child FK in flight.
  - **Tenancy is STRUCTURAL on both FKs**: `workspace_id` and `repo_id` both arrive in REQUEST
    BODIES, so both are COMPOSITE against `(id, account_id)` and NAMED
    (`workspace_repos_workspace_account_fk` / `workspace_repos_repo_account_fk`) so the violation
    message is greppable. A cross-account `(account, workspace)` or `(account, repo)` pair fails in
    the DATABASE, in every code path. ⚠ `schema-parity.test.ts` compares COLUMNS ONLY — not indexes
    and **not foreign keys** — so a composite FK declared in one dialect and omitted in the other
    passes parity. Diff the two files' `foreignKey({name, columns, foreignColumns})` blocks by eye.
  - ⚠ **A repo with NO membership row is invisible to every workspace-scoped read** — no PRs, no
    feed rows, no bots, silently. Closed on both sides: `sync/upsert.ts` `upsertRepo` inserts the
    membership row in the SAME `runTransaction` as the repo row (`ON CONFLICT DO NOTHING`, so a
    re-sync never moves a repo out of the workspace a human put it in), and
    `ensureRepoMemberships(accountId)` repairs the diff from `listWorkspaces` /
    `resolveWorkspaceScope` — i.e. on effectively every request. Because it is **a WRITE on
    essentially every GET**, its insert MUST carry `ON CONFLICT (account_id, repo_id) DO NOTHING`
    (concurrent requests race the unique). It writes **membership and nothing else** — repairing a
    membership is not a user gesture, so it must never look like one to anything downstream.
  - **The `workspaces` cascade is a safety net, not the delete path.** `deleteWorkspace` re-homes
    the workspace's repos AND its `workspace_reviewers` rows to Default *inside its transaction*
    before deleting the row, so the cascade finds nothing to do. Step two is not optional — see the
    landmine under **One bot object** below.
- **`users`** — GitHub actor metadata (`githubLogin` unique, `isBot`, `displayName`,
  `avatarUrl`, `githubType` — the GraphQL author `__typename`, fed to the bot classifier;
  `appSlug` — the `performed_via_github_app.slug` the app-attribution probe persists,
  fill-or-update and never cleared by a later app-less comment; feeds the advisor's
  discovery tier); **global**.
- **`pullRequests`** — PR metadata, state, draft, timestamps, CI/mergeable, etc.; carries
  `accountId`, unique `(accountId, githubNodeId)`. `reviewDecision` (`approved` |
  `changes_requested` | `review_required` | null) is GitHub's OVERALL review verdict — the
  thing that lets a `blocked` merge state say WHICH half of branch protection is unmet (see
  **Merge, CI logs & trunk status**). `mergeStateStatus` deliberately does NOT model GitHub's
  `DRAFT` value (it maps to `unknown`): draft-ness is already `isDraft`, and folding it in
  would leave a draft reporting `draft` with no idea whether it is otherwise clean.
- **`reviews`** — submitted reviews (`state`: approved / changes_requested / commented /
  dismissed / pending). A reviewer's *standing* decision is their latest non-`commented` review.
- **`reviewThreads`** + **`reviewComments`** — inline threads (stored `derivedState`) +
  comments; **`prComments`** — issue-level. Under lean storage the `body` is nullable (null
  when lean); `reviewComments.excerpt` always holds a short preview.
- **`commits`** (`sha`+`prId`) + **`commitFiles`** (`sha` → changed paths, cached). ⚠ `commitFiles`
  is **GLOBAL** (content-addressed by sha, no `accountId`), so every reader must reach it through
  shas already proven to belong to the tenant — never by a bare path predicate. Two readers do
  this today: the addressing-commit resolution in `queries.ts` and `db/person-period.ts`'s
  person-evidence path-area fold (which joins through the tenant-scoped commit shas of an
  already-capped authored-PR set, which is also what bounds its scan). `verify:isolation` seeds
  both tenants with a decoy path bucket so a dropped join leaks rather than finding nothing.
- **`events`** — the timeline feed; `accountId`, unique `(accountId, dedupeKey)`, typed
  (`pr_opened`/`pr_merged`/`pr_closed`/`review_submitted`/`review_comment`/`pr_comment`/
  `commit_pushed`). Only *substantive* reviews emit an event (an empty `commented` review is
  suppressed so it doesn't duplicate inline markers).
- **`reviewRequests`** — *ephemeral* pending requests (`userId` or `teamName`, surfaced as
  `requestedReviewers`); re-derived each sync (GitHub drops the request once a review lands).
- **`prViews`** — last-viewed SHA + ts per PR ("new since you looked"); **`syncState`** —
  per-repo sync bookkeeping; **`myTurnDismissals`** — dismissed "my turn" entries
  (`accountId`, `review_request`|`thread`; auto-resurface on newer activity). ⚠ The stored `kind`
  for a dismissed "New PRs" entry is the legacy string **`watched_repo_pr`** — a DB enum value kept
  for the existing rows, not a surviving concept; the wire field is likewise still
  `MyTurnResponse.watchedRepoPrs`. Renaming either would be a migration + a breaking wire change for
  no behaviour.
- **`claudeReviews`** + **`claudeReviewFindings`** — the **Claude Review** feature (see
  below; carries `accountId`). One run per row (re-review = new row; history kept, keyed by
  `(prId, headSha)`); Claude's `summary`/`verdict` read-only, the user's
  `userBody`/`userVerdict` are what post. Each run records its `reviewMode`/`routeReason`;
  findings carry `anchored`/`included` + the agent's wording. **Not** in the lean timeline;
  loaded on demand.
- **`autoMergeRequests`** — one standing "merge when ready" intent per `(accountId, prId)`
  (that pair is the unique/upsert target, so re-arming OVERWRITES — this is current state, not a
  log; disarm DELETEs rather than adding a "cancelled" state). Carries `mergeMethod`,
  `updateStrategy`, the consent anchor `expectedHeadOid`, `viaMergeQueue` (the base had a merge
  queue at arm time — the watcher ENQUEUES instead of direct-merging), `enqueuedAt` (when the
  WATCHER enqueued; the attribution record — merged-while-set resolves 'merged', a human's queue
  entry never does, and disarm-with-it-set also dequeues; reset by every re-arm), `state`
  (`ArmedMergeState`), `expiresAt`, `lastCheckedAt`, `lastReason`. FKs cascade from
  `accounts`/`pullRequests`. Both
  exported (Art. 15 — it records an action the user asked the server to take) and erased.
- **`branchCommits`** — the recent commits on each repo's DEFAULT branch (`accountId`
  denormalized; unique `(accountId, repoId, sha)`; trimmed to `BRANCH_COMMIT_WINDOW`=100 per
  repo in the same transaction as the upsert. COUNT bound only — a writer-side age bound was
  tried and REVERTED: it deleted a dormant repo's entire set every sync; the 90-day horizon
  lives in `getBranchTrends`' read filter instead. The branch-status strip still reads only
  the 10 most recent merged-PR groups (`READ_PR_CAP`; commits consolidated by `prNumber`,
  direct pushes chart-only); the full window feeds `GET /api/branch-trends`). **Not derivable from `commits`**, which is
  PR-scoped — a squash-merged PR never appears there under the SHA that landed on trunk. Plus
  four nullable `repos` columns for the head snapshot (`defaultBranchName` /
  `defaultBranchHeadSha` / `defaultBranchCiStatus` / `defaultBranchUpdatedAt`, the last being
  OUR observation time, not a commit time). `defaultBranchName` is kept separate from the older
  `defaultBranch` on purpose — that one is written by the activity sync for maintainer
  inference, and sharing it would make the two syncs clobber each other's freshness. Two later
  columns answer "why is that dot red / where did this come from": `failingChecks`
  (`BranchCheckRun[]`, FAILURES ONLY so a green commit stores null — **not** lean-gated, since a
  trunk commit belongs to no PR and so has no hydrate-on-demand path to be lazy into; same
  column NAME as `ciStatusEvents.failingChecks` but a different shape, which `$type<>()` makes a
  compile-time fact) and `prNumber` (a plain number, deliberately NOT a `pullRequests` FK — the
  PR is often unsynced when the commit is observed, a stored id would go stale on the next PR
  re-sync, and a real FK would drag this table into both delete paths). In
  `accountScopedTables()` + explicitly erased; NOT in the Art. 15 export (unlike
  `autoMergeRequests`) — if that was a decision rather than an omission it isn't recorded anywhere.
- **`trunkCiStatusEvents`** — the default-branch CI **transition log** (`accountId` denormalized;
  migration `0052` / pg `0039`), the trunk twin of `ciStatusEvents`. It has to exist because
  `branchCommits.ciStatus` is updated IN PLACE by the snapshot's idempotent upsert, so a commit
  that turns red hours after it landed carries no record of WHEN — the only timestamps on that row
  are `committedAt` and `createdAt`, and presenting either as "trunk CI failed at" would be a lie.
  `observedAt` is OUR observation time (the branch query selects no `completedAt`), so UI copy says
  **"detected"**, never "failed at". `failingChecks` is `BranchCheckRun[]` — the `branchCommits`
  shape, deliberately NOT `ciStatusEvents`' bare `string[]`, with `$type<>()` making the difference
  a compile-time fact. Written by `sync/branch-status.ts` only on a TRANSITION (status / head sha /
  failing-name set differs from this repo's last row) and only on a POSITIVE statement from GitHub
  — an `unknown` rollup, which is what `graphqlTolerant` yields when a partial response NULLs the
  selection, records nothing — outside the snapshot transaction, strictly non-fatal. A pure head
  move while trunk is GREEN and nothing is failing is not a transition either, so a hot repo's log
  is not dominated by rows that state nothing. ⚠ **Retention is HYBRID, not a count trim**: the
  newest `TRUNK_CI_EVENT_WINDOW`=200 rows per repo **∪** everything inside the Feed's read window
  (`FEED_WINDOW_DAYS`, imported from `db/queries.ts` so retention can never drift below the read),
  via the pure exported `staleTrunkCiEventIds`. Each half alone is wrong: a pure count bound evicted
  the very failure rows `getTrunkCiFailureFeedItems` reads on the most active repos (invisibly — the
  Feed just stops showing trunk failures), and a pure age bound deletes a dormant repo's entire log
  so every next observation reads as a first observation forever. Same shape as `branchCommits`'
  trim, opposite failure modes. `pruneOldData` is anchored to a parent PR's `updatedAt` and a trunk
  row has no PR, so its absence there is STRUCTURAL. Both FKs cascade, but it is ALSO deleted
  explicitly in `deleteRepo` (by `repoId`) and `eraseAccountData` so the guarantee never depends on
  SQLite's `foreign_keys=ON`; it is on the `accountScopedTables()` checklist. **No backfill** — the
  only writer appends at the end of a full walk, so the trunk half of the CI feed stays blank until
  each repo's next full walk (`sync/backfill-ci-history.ts` synthesizes only the PR-side rows).
- **`workspaceReviewers`** — the **Bot-Triage** table (CORE, `accountId`-scoped). **THE BOT OBJECT:
  ONE row per `(accountId, workspaceId, authorUserId)`**, carrying three independent facts:
  - **JUDGEMENT** (provenance: `source`) — `automated`, `role` (`ReviewerRole`
    `'review'|'quality_check'`, NOT NULL default `'review'`), `confidence`, `source`, `reasonsJson`.
  - **IDENTITY** (provenance: `identitySource`) — `kind`, `label`.
  - **PRICE** (no provenance; exactly one writer) — `monthlyCents` + `costModel`.

  Unique `(accountId, workspaceId, authorUserId)` — **the conflict target of every writer** — plus
  `(accountId, workspaceId)` / `(accountId, authorUserId)` listing indexes and the named composite
  FK `workspace_reviewers_workspace_account_fk` against `workspaces(id, account_id)`. `authorUserId`
  has a plain, cascade-less FK to `users`, which is GLOBAL storage shared by every account and never
  deleted.

  **Why ONE table now.** It replaced `repo_reviewers` (judgement, per repo) + `account_reviewers`
  (identity + price, per account). That split existed because the two facts lived at DIFFERENT
  grains: "not a bot on `web`" had to not blank CodeRabbit's brand colour on `api` and `infra`. With
  a workspace as the only scope both facts are about the same key, so a second table would key on
  the identical three columns and be joined at every call site — this table with extra steps.
  "CodeRabbit across the six repos of a workspace" is ONE row: one judgement, one price, one brand
  colour. There is no fold, no union, no inheritance, no deduplication and no `resolveJudgements`.

  ⚠ **THE HISTORICAL BUG, kept here because it is what stops someone re-splitting the table — and
  because the merge means it can now come back INSIDE one row.** When `kind`/`label` sat on
  per-repo rows, clicking "Not a bot" in ONE repo nulled the kind, identity resolution picked that
  row up, and CodeRabbit lost its brand colour and vendor name in **every repo the user never
  touched**, with no surface able to undo it. What used to prevent that was a TABLE BOUNDARY. It is
  now **two independent provenance columns honoured by NARROWED `set:` OBJECTS** — code discipline,
  pinned by tests (`db/workspace-reviewer.test.ts` asserts all six directions in PAIRS):
  - `source` owns `automated`/`role`/`confidence`/`reasonsJson`; `identitySource` owns
    `kind`/`label`. A classification pass that respects only one of them either reverts a human's
    vendor correction or freezes auto-detection.
  - `sync/reviewer-classify.ts` `persist` therefore **must not** use one shared `values` object for
    the insert and the `set:` (the pattern that is correct for a single-grain table): it builds the
    `set:` per workspace, adding the judgement half only when `existing.source !== 'manual'` and the
    identity half only when `existing.identitySource !== 'manual'`, and skips the statement entirely
    when neither half may be written.
  - `persistHumanJudgement`'s values object contains **no `kind`/`label` at all**, so a human "this
    is a bot" cannot rename the vendor as a side effect. Under the merged table that is the only
    thing stopping it.

  **`monthlyCents`** (INTEGER, nullable) is the bot's monthly price — CORE/free, moved out of the
  plugin's account-wide `pro_settings.bot_cost_json` blob. INTEGER CENTS in BOTH dialects on
  purpose: pg `numeric` has no sqlite twin and node-postgres returns it as a STRING (silently
  breaking the shared `number` wire type), while REAL is a float64 that can't hold money; the WIRE
  is DOLLARS, converted only at the store boundary. **TWO states, not three** — NULL = "no price
  set", `0` = "recorded as free"; nothing inherits, so there is no chain behind a `??`.
  - ⚠ **PRICE IS PER WORKSPACE, and this was a deliberate product decision that OVERRULES the old
    "you buy ONE subscription from a vendor" argument.** Bots are configured at the Workspace level
    — *all* attributes, price included. Editing CodeRabbit's price in workspace A leaves B
    byte-identical, and B may legitimately hold a different number or none. That divergence is
    intended, not drift: there is **no fan-out writer, no INSERT seed and no cross-workspace
    coupling of any kind**. A row `persist` creates comes up with `monthlyCents = null` until
    someone prices it. Do not re-derive the old account-wide behaviour from first principles.
  - ⚠ **Exactly ONE writer names the column**: `setReviewerCost`, an UPDATE keyed on
    `(accountId, workspaceId, authorUserId)` — one row. `monthlyCents` appears in **no other `set:`
    or UPDATE object anywhere**, and in `reviewer-classify.ts` it does not appear at all, neither in
    a `set:` nor as a derived INSERT value. Clearing a price is a **column write, never a row
    delete** — the row also carries the judgement and the identity.
  - **`costModel`** (TEXT `'flat'|'per_seat'`, NOT NULL default `'flat'`) says how `monthlyCents`
    is READ, never a second price: `flat` = the whole workspace subscription (every pre-existing
    row's meaning, preserved by the default); `per_seat` = a per-seat UNIT price multiplied **on
    read** by the workspace's derived human seat count (`workspaceHumanSeatCount`: distinct human
    PR authors over the workspace's membership repos, trailing **fixed 30 days** — a price is
    invoice-shaped and must not float with the viewed analytics window; exclusions route through
    `automatedReviewerUserIds` ∪ global `isBot`, with a manual-human judgement winning both
    directions). ⚠ **The product (seats × cents) is NEVER stored** — it can exceed int4 and goes
    stale the moment a contributor opens a PR; the wire carries `costMonthlyUsd` as the EFFECTIVE
    monthly with the unit preserved in `costUnitMonthlyUsd`. Ownership is `monthlyCents`'s,
    verbatim: same single writer (`setReviewerCost`, one UPDATE), same standalone cost route,
    never in the PATCH body, never in any derived write; clearing the price resets the model to
    `'flat'` in that same UPDATE.
  - ⚠ **Never sum cost ACROSS workspaces on one screen.** Six workspaces each listing a $120
    CodeRabbit is either six subscriptions or one seen six ways and **the app must not assert
    which** — Compare-workspaces shows the figures side by side and does not total them. WITHIN one
    workspace there is exactly one row per actor, so a total there is a plain sum;
    `monthlyCostTotal`'s dedupe-by-`userId` is then a trivially-satisfied standing invariant and is
    kept as the cheap guard that it was never handed two workspaces' rows.
  - ⚠ The value is **CLAMPED to the int4 cents ceiling** (`$21,474,836.47`) in the query layer AND
    bounded by the route schema: above it Postgres RAISES `integer out of range` while SQLite's
    64-bit integers accept it happily, so an unbounded field means the same request succeeds locally
    and 500s in cloud.

  The plugin-owned `pro_settings` still HAS its 11 `bot_*` columns, but only ONE is live:
  `bot_slack_digest`. `bot_cost_json` is a deprecated READ-only legacy source
  (`ProSettingsUpdate.bots.cost` was REMOVED, there is no write path left), and the other NINE are
  **DORMANT** — present in every database, dropped from the drizzle schema modules and from the
  wire, never selected and never written, with **no migration**: `bot_auto_resolve*` backed the
  removed mute feature; `bot_inhouse_detect` / `bot_auto_tag` / `bot_login_allowlist` /
  `bot_deep_detect` / `bot_ai_tiebreak` backed the removed "Detection" settings (which had no
  consumer — CORE's classifier cannot read a plugin table); `bot_tag_pierre` / `bot_pierre_footer`
  backed the removed "Limn attribution" settings (the marker is now unconditional). The
  policy columns `ai_update_mode` / `ai_interval_minutes` are dormant on the same terms. See
  **Bot-Triage Platform** below. (The old `botMuteRules` table / `/api/bot-mute-rules` mute +
  auto-triage-cron feature was **removed** — see the note below; migration `0029` still creates
  the now-orphaned `bot_mute_rules` table in existing DBs but no code binds it.)

Conventions: timestamps are unix-epoch integers in SQLite (`mode:'timestamp'`) /
`timestamptz` in Postgres — both infer `Date` in the read layer (one hand-rolled epoch
comparison in `getTimeline` uses `tsBound` to bridge). Node IDs are the stable identity;
reads are **accountId-scoped**; **triage fields are computed on read** (`triage.ts`:
`reasonTag`, `reviewRequestedFromMe`, `newSinceLastViewed`, approvals, `isStalled`) — not
stored.




## `ml_comment_labels` (CORE, free tier — ML severity/category on bot text)

One row per classified target. Written ONLY by the background enrichment worker
(`sync/ml-enrichment.ts`), which batches text to the `severity-api` microservice from the
`packages/ml` submodule; read by the per-PR badge index and the Bots severity rollup. Full
contract: [ML-SEVERITY.md](ML-SEVERITY.md).

- `target_kind` ∈ `review_comment | pr_comment | review` (the review **body**), `target_id` is
  that entity's own PK **within its kind**. THREE DIFFERENT ID SPACES — which is why the unique
  `mcl_account_target` is `(account_id, target_kind, target_id)` and why every lookup, server or
  client, must carry the kind. `target_id` is deliberately NOT a foreign key (no single FK can
  express three parents; the plugin's `pr_comment_annotations` has the same shape).
- `severity` (`nit|minor|major|critical`) + `severity_ord` (0–3) + `severity_prob`;
  `categories` (multi-label, never empty) + `category_probs` (all eight keys);
  `is_summary` (a PR walkthrough rather than a finding — a separate axis, NOT a category).
- `backend` / `model_version` are verbatim from the service. A `backend` lacking
  `modernbert-onnx` means the ONNX model did not load and the marker heuristic answered — a
  degraded deployment that the Bots panel surfaces rather than hiding.
- `body_hash` is sha256 of the text ACTUALLY SENT (trimmed + capped). Comment bodies are
  mutable, so a boolean "enriched" flag would go stale invisibly. ⚠ Stored but not yet compared
  — see the known gap on re-scoring.
- `account_id` / `repo_id` / `pr_id` / `author_user_id` are DENORMALISED so a scoped read is one
  indexed predicate rather than a three-way UNION back to the polymorphic parents. They are
  snapshot facts about an immutable parent, not a second writable copy of a live fact.
- All three id FKs **cascade**, so the table is deliberately in NEITHER `deleteRepo` nor
  `deletePrSubtree` (the `search_index` precedent). It IS in `accountScopedTables()` and is
  deleted explicitly in `eraseAccountData`.
- The **rollup counts only actors the workspace CURRENTLY calls bots** — a label whose author
  has since been marked human is stored but excluded.
