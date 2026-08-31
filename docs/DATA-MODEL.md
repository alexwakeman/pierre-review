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

29 tables. Multi-tenancy as above (`accountId` denormalized onto the anchor tables;
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
  - **JUDGEMENT** (provenance: `source`) — `automated`, `role` (`ReviewerRole` — **SIX** members,
    NOT NULL default `'review'`; see "The automation vocabulary" below), `confidence`, `source`,
    `reasonsJson`.
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
    ⚠ **THE PLUGIN NOW READS THIS PAIR TOO** — the Bots → Benchmark tab's cost block
    (`packages/pro/src/bots/benchmark/{collect,cost}.ts`) selects `monthly_cents` + `cost_model` on
    the SAME single-workspace-predicate read that fetches the judgement beside them, and resolves
    `per_seat` through the OPTIONAL host seam `ProHostQueries.workspaceHumanSeatCount?` — core's own
    function, so there is still exactly ONE multiplier in the product and the Benchmark cannot quote
    a different monthly figure for the same bot than the ROI table does. It is a READ ONLY: nothing
    in the plugin writes either column, and `null` never becomes `0` on the way past. A per-seat
    price the seam cannot resolve is EXCLUDED from the figure and disclosed, never read as the unit.
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




## `pr_mentions` (CORE, free — "@you was mentioned on this PR")

One row per `(account, PR)` where the account's viewer login is `@`-mentioned in a PR comment, a
review body or an inline review comment. It is the **MENTION arm of My Turn's personal-relevance
flag** (`MyTurnPr.personal`): the repo arm asks *"is this your patch of ground"*, this one asks
*"did somebody type your name"* — and a mention makes a PR personal **even in a repo the viewer
only READS**, which is exactly why it cannot be folded into the maintainer test. Written ONLY by
`sync/mention-scan.ts`; read only through `db/pr-mentions.ts`.

- **PRESENCE IS THE WHOLE FACT.** There is no `mentioned` boolean and no "scanned, found nothing"
  row, so every reader is one indexed existence check (`prm_account_pr`). Absence is the answer,
  and it is the SAFE answer: a deployment whose scanner has never run behaves exactly as it did
  before mentions existed — the flag degrades to the maintainer test and nothing widens.
- **WHY A TABLE, NOT A COLUMN ON `pull_requests`.** The fact is derived, re-derivable and about a
  `(tenant, PR)` pair rather than about the PR; it is sparse (12 rows out of 8.5k PRs on this
  repo's own dev account). Widening the hottest table in the schema — and every sync upsert that
  writes it — for a column that is false 99.9% of the time buys nothing.
- **`login` is PROVENANCE, not a denormalised copy of `accounts.github_login`** (stored
  lowercased). It records which login the row was matched FOR, which is what lets the read refuse
  rows derived under a login the account no longer has. See the invalidation rules in
  [SYNC.md](SYNC.md) § "@mention derivation".
- **The match is a WORD BOUNDARY, and the SQL is only a prefilter.** `lower(body) LIKE '%@login%'`
  matches `@alexwakeman` when the login is `alex`, and `bob@alex.com` for anyone; `mentionsLogin`
  (a regex with explicit leading/trailing classes) is the authority on every row the scan returns.
  ⚠ Dropping that confirmation leaves a scanner that still finds every true mention and silently
  invents a pile of false ones — pinned by the case table in `db/pr-mentions.test.ts`.
- The FKs cascade from `accounts`/`repos`/`pull_requests`, and unlike `ml_comment_labels` the row
  is ALSO deleted explicitly in **`deleteRepo`** (by `repo_id`), **`deletePrSubtree`** (by
  `pr_id`) and **`eraseAccountData`**, and it is on the `accountScopedTables()` checklist. A
  surviving row does not merely waste space: it goes on asserting that a deleted PR is personally
  relevant.
- **Deliberately NOT in the account export.** It is fully re-derivable from `prComments` /
  `reviews` / `reviewComments`, which the export already carries verbatim — the same standing as
  `ml_comment_labels` and `search_index`. (Recorded here because `branchCommits`' absence from
  that export was an omission nobody wrote down; this one is a choice.)




## The automation vocabulary — `AUTOMATION_VENDORS`, `ReviewerRole`, `AutomatedReviewerKind`

Three vocabularies describe an automated actor, and they are **orthogonal axes, not one enum**:

| Axis | Type | Question | Provenance column |
|---|---|---|---|
| Judgement | `automated: boolean` + `ReviewerRole` | is it automation, and **what does it DO** | `source` |
| Identity | `AutomatedReviewerKind` (+ `label`) | **WHO** is it — the vendor brand | `identitySource` |
| Price | `monthlyCents` + `costModel` | what does it cost | (no provenance; one writer) |

All three live in ONE `workspace_reviewers` row — see **`workspaceReviewers`** above.

### `ReviewerRole` has SIX members, and EXACTLY ONE is the reviewer cohort

```
'review' | 'quality_check' | 'dependency' | 'code_agent' | 'release' | 'housekeeping'
```

What an automation DOES, chosen per workspace from a picker, mapping **1:1** onto an
`ActorLane` via `REVIEWER_ROLE_LANE` (see [PERIOD-REPORTING.md](PERIOD-REPORTING.md) § lanes).
The column is NOT NULL, default `'review'`.

⚠ **Every cohort test is `=== 'review'`, never `!== 'quality_check'`.** Those two spellings were
the same answer while there were exactly two roles, and became **silently wrong** at six: the
old spelling re-admits `dependency` / `code_agent` / `release` / `housekeeping` into the ROI,
behaviour, dedup and benchmark sets. Fixed at four sites — `narrowAutomatedIds`,
`getBotAnalytics`'s `isQualityCheck`, `getBotOverlap`, `bucketReviewers`. **`grep -n
"quality_check'"` before adding a fifth.** The wire field
`BotAnalyticsResponse.qualityChecks` and the frontend bucket of the same name now hold EVERY
non-reviewer role — the names are historical.

⚠ **The STORED role beats the login seed on read.** Widening a vocabulary in code therefore
does NOTHING for an actor already classified. Migration **`0053`** re-derives `role` for every
row whose `source <> 'manual'`, and a future vocabulary addition needs the same treatment.

### `AUTOMATION_VENDORS` is the ONE table the five per-family login sets are DERIVED from

`packages/shared/src/types.ts`:

```ts
export const AUTOMATION_VENDORS: Record<string, { kind: AutomatedReviewerKind; role: ReviewerRole }>
```

**One row per login, carrying BOTH facts.** `REVIEW_BOTS` owns the AI-reviewer family; this
owns every other kind of automation that touches a PR. It is ONE table rather than five login
sets plus a parallel login→kind map, because **a login has exactly one identity and one default
role, and those are facts about the same key**. Two tables keyed by login is precisely the "a
fact lives at ONE grain" trap this codebase has paid for before: the second one drifts and
nothing detects it.

Consequences worth stating:

- **The five families are disjoint BY CONSTRUCTION** — there is no predicate order to get
  wrong. `roleForBotLogin(login)` has exactly one answer per login (the vocabularies are
  asserted pairwise disjoint), which is why `db/actor-lanes.ts` makes ONE call instead of five
  ordered predicates.
- `role` is the **DEFAULT** role for the login; a human's choice always wins.
- `kind` is the vendor **identity**, orthogonal to role. A login may legitimately appear in
  `REVIEW_BOTS` too when the same brand does both jobs — and where it does, **the two tables
  MUST agree on the kind**; `bot-detection.test.ts` asserts that rather than leaving it to a
  reader.
- It is **hand-mirrored in `sync/bot-detection.ts`** (the backend cannot import shared at
  runtime — see [PERIOD-REPORTING.md](PERIOD-REPORTING.md) § three spellings). The **drift test
  compares it key-by-key AND value-by-value** — a key-only comparison would pass while a
  vendor's role silently changed.

⚠ **Why the `kind` column exists at all.** Before it, every automation that was not an AI
reviewer resolved to `kind: 'in_house'` via the classifier's githubType fallback — the bucket
literally labelled **"In-house AI"**. On the dev corpus that bucket held sonarqubecloud,
dependabot[bot], github-actions[bot], gitguardian, socket-security, google-cla and jit-ci:
**25 of 37 such rows**. Every one rendered as "In-house AI" with the same grey chip, so a user
could not tell their SonarQube from their CLA bot on the screen that exists to classify them.

Classifier step **1b** brands them. Migration **`0054`** re-derives `kind` for rows with
`identity_source <> 'manual'` and `kind IN ('in_house','vendor')`, **nulling the cached `label`**
so the brand name shows.

⚠ **`ReviewBotKind` must NEVER absorb the other families.** It is the AI-reviewer cohort: it
drives the review-bot badge and keys the rows the cross-org benchmark contributes.

## `REVIEW_BOT_KINDS` is an ALLOW-list — `getBenchmarkContributions`

```ts
export const REVIEW_BOT_KINDS: ReadonlySet<string>   // shared/types.ts, MIRRORED into queries.ts
export function isBenchmarkableVendorKind(kind): boolean
```

`getBenchmarkContributions` decides which vendor rows may be contributed to the cross-org
benchmark. **Those rows LEAVE THE TENANT and cannot be recalled.**

The old test was a **deny-list**: `kind !== 'in_house' && kind !== 'pierre' && kind !== 'vendor'`.
That was correct **only while `ReviewBotKind` was the entire branded universe**. The moment
`AutomatedReviewerKind` grew quality-gate / dependency / code-agent / release / housekeeping
brands, **every one of them would have passed it** — shipping a linter's volume into a shared
cross-org *review-bot* cohort, permanently, for everyone, with no way to un-ship it.

An allow-list cannot fail that way: **a new kind is excluded until someone deliberately adds
it here.**

⚠ **Pinned by `db/benchmark-vendor-kinds.test.ts`, which goes THROUGH THE GETTER.** This matters
more than it sounds: a unit test that merely pinned the SET's contents passed happily while the
predicate was mutated back to the deny-list. The set is not the invariant — the *filter* is.

## `vendorKindsForRole` always includes the STORED kind

```ts
vendorKindsForRole(role: ReviewerRole, current?: AutomatedReviewerKind | null): AutomatedReviewerKind[]
```

The Bots card asks for the **ROLE first**, then offers only that family's vendors plus the
generic escape hatches (In-house/custom, Other vendor). `roleForVendorKind` returns `null` for a
kind legal in every role, and **a kind with no entry is treated as `null` — permissive**,
because hiding a stored value from its own picker is how a user's saved vendor silently changes
on the next save.

⚠ **The `current` argument is NOT a convenience.** A `<select>` whose `value` is absent from its
options renders the **FIRST option** instead — so the card would *show* a vendor the row does
not hold, and the next save would *write* that wrong vendor. Role and identity are independently
owned halves (`source` vs `identitySource`), so a row legitimately carries a vendor from another
family: someone marks CodeRabbit a quality check without renaming it. The stored value has to
stay selectable.

⚠ **The role write sits behind an explicit "Apply role" BUTTON, not the select's `change`
event.** That write stamps `source: 'manual'`, which stops the classifier ever re-deriving the
row — and a `change` event is not a deliberate act: a scroll wheel, an arrow key, or the browser
restoring form state on reload all fire one. It happened during development and silently
re-roled a live row.

## `onConflictDoUpdate` inventory — the conflict target of every writer, per table

⚠ **When a unique index CHANGES, every `onConflictDoUpdate` on that table must change with it.**
A stale target **type-checks perfectly** and raises *"no unique or exclusion constraint matching
the ON CONFLICT specification"* at **RUNTIME**, in **both dialects**, and **only when a row is
actually written** — so an insert-only test never reaches the branch. The bot writers took this
hit twice in a row (`0042` re-keyed to three columns, `0045` re-keyed the three columns again).

**Before adding a writer: `grep -n onConflictDo` over BOTH trees (core + `packages/pro`) and
check every hit against its table's declared unique.**

| Table | Conflict target | Writers |
|---|---|---|
| `workspace_reviewers` | `[accountId, workspaceId, authorUserId]` (`workspace_reviewers_account_workspace_author`) | `sync/reviewer-classify.ts` `persist` + `persistHumanJudgement`; every `queries.ts` bot writer (manual classification ~9605); `deleteWorkspace`'s reviewer re-home (`onConflictDoNothing`, ~626) |
| `workspace_repos` | `[accountId, repoId]` — **the unique that makes an assignment a MOVE** | `assignReposToWorkspace` (~716), `upsertRepo`'s in-transaction membership insert, `ensureRepoMemberships` (both `onConflictDoNothing`) |
| `workspaces` | the `workspaces` uniques (incl. the **partial** one-`isDefault`-per-account index that lives in the `.sql` migrations — drizzle index predicates are inert metadata) | `ensureDefaultWorkspace` (`onConflictDoNothing`) |
| `repos` | `[accountId, githubNodeId]` | `upsertRepo` |
| `pull_requests` / `events` / children | `(accountId, githubNodeId)` · `(accountId, dedupeKey)` · child `(prId, githubNodeId)` | `sync/upsert.ts` (the whole PR subtree) |
| `review_comments` / `pr_comments` / `reviews` | `[prId, githubNodeId]` | `sync/upsert.ts` + the post-write local stamps in `queries.ts` (~7897 / ~7931 / ~7979) |
| `commit_files` | `sha` (immutable content — a single-column target) | `sync/commit-files.ts` |
| `pr_views` | `prId` | `markPrViewed` (~5416), the bulk mark-all (~5447) |
| `my_turn_dismissals` | `[kind, refId]` — **deliberately omits `accountId`** (`refId` is a global PK) | `dismissMyTurn` (~5512) |
| `auto_merge_requests` | `[accountId, prId]` — current state, not a log; re-arm OVERWRITES, disarm DELETEs | `armAutoMerge` (~14009) |
| `benchmark_contributions` | `[accountId, vendorKind, weekStart]` | the benchmark rollup (~13444) |
| `ml_comment_labels` | `(account_id, target_kind, target_id)` (`mcl_account_target`) | `db/ml-labels.ts` (the enrichment worker's ONLY writer) |
| `pr_mentions` | `(account_id, pr_id)` (`prm_account_pr`), `onConflictDoNothing` | `db/pr-mentions.ts` `syncAccountMentions` (the mention scanner's ONLY writer) |
| `accounts` | the account uniques | `auth/account.ts` (`ensureLocalAccount`, `upsertCloudAccount`) |
| `repos` head/trunk columns | `[accountId, githubNodeId]` / `branch_commits` composite | `sync/branch-status.ts`, `sync/sync-repo.ts` |

⚠ **`persist()` must NOT share one values object between the insert and the `set:`.** It did,
and that was correct while the table held one grain. With judgement + identity + price in one
row, a shared object overwrites a human's vendor name on every auto pass — and if `monthlyCents`
ever crept into it, every auto pass would silently wipe the price the user typed. It builds the
`set:` per workspace from the two stored provenance flags and **emits no statement when neither
half may be written**. It is a **READ-THEN-NARROW, not an `onConflictDoUpdate … WHERE`** —
drizzle spells `setWhere` differently per dialect while `db` is pg-typed.

## Reading the bot table — `resolveWorkspaceReviewers` and its helper roster

**Every read of `workspace_reviewers` needs an EXPLICIT workspace predicate.** With one row per
`(account, workspace, actor)` there is nothing to fold: the old `resolveJudgements` (per-repo,
unioned) and `resolveIdentities` (per-account) merged into ONE function the moment both facts
landed on the same key.

```ts
async function resolveWorkspaceReviewers(accountId, workspaceId): Promise<Map<number, ResolvedReviewer>>
```

ONE read of ONE row per actor in ONE workspace, served directly by
`workspace_reviewers_account_workspace_idx`. `ResolvedReviewer` carries
`{automated, role, manualHuman, confidence, source, reasons, kind, label, identitySource,
monthlyCents, costModel}` — where **`manualHuman` (`source === 'manual' && !automated`) is its
own field** because it is the one judgement that must beat a known vendor login.

**The helper roster over it — ALL of these take a `workspaceId`,** since every one of those
facts is per workspace:

| Helper | Answers |
|---|---|
| `automatedReviewerUserIds(accountId, workspaceId, role)` | the automated id set, `'review'` \| `'all'` |
| `classificationKindForUser(accountId, workspaceId)` | id → `AutomatedReviewerKind` |
| `classificationLabelMap(accountId, workspaceId)` | id → display label |
| `reviewerRoleForUser(accountId, workspaceId)` | id → `ReviewerRole` (stored) |
| `manualRoleUserIds(accountId, workspaceId)` | ids whose role was chosen BY A PERSON (automated rows only) |
| `manualHumanUserIds(accountId, workspaceId)` | ids a person vouched for as human |
| `reviewerCostForUser(accountId, workspaceId)` | id → resolved monthly cost (per-seat multiplied on READ) |

⚠ **The old failure is worth remembering when writing a NEW read.** Helpers that collapsed the
multi-row table one-row-per-author (`new Map(rows.map(…))`, `limit(1)`, no `ORDER BY`) returned
rows in **heap order, which flips after any UPDATE on Postgres** — so the same query answered
differently on the two dialects, and differently on the same dialect after an edit. Go through
`resolveWorkspaceReviewers`.

**The ONLY account-wide sweep is the cross-org benchmark**, and it gets **two explicitly named
functions rather than a null sentinel**, so no ordinary read can reach it by accident:

- `automatedReviewerUserIdsForAccount(accountId, role)`
- `classificationKindForUserForAccount(accountId)`

Its union rule is the old multi-repo one, lifted: automated in ANY workspace ⇒ automated;
`role: 'review'` in any workspace ⇒ `'review'` (a login that lints one workspace and reviews
another belongs in the reviewer cohort); a manual "this is a human" only counts when **NO**
workspace calls the actor automated.
