# pierre-review

A **single-page dashboard for tracking a team's GitHub activity across multiple
repositories** — built for sprint situational-awareness: at a glance, who's doing what,
which PRs are stalled, which review threads sit untouched, and what needs _your_ attention.

It ships to npm as **Limn** (`npx limn-review`) and runs **only on your machine**: SQLite, no
hosted backend, no sign-in, no stored GitHub credentials (it shells out to your logged-in `gh`).
**Every feature is free** under the Limn License 1.0 (`LICENSE`: free for individuals and for
organisations where ≤ 3 people use it; a commercial licence above that, via the contact form; no
competing use). The agentic features run on the reader's own Claude or Codex (`LIMN_AI_PROVIDER`,
or Settings → AI). The website (landing, a static demo at `/demo/`, the contact form) is a separate
tiny service, `apps/site`.

> **How to use this file.** This is the lean operating guide: the mental model, the commands,
> and the invariants and landmines you must know BEFORE editing. Per-area depth lives in the
> topic docs below — read the matching doc before non-trivial work in its area, and put NEW
> detail there, not here. **This file has a hard size budget** (under 48k bytes); anything
> discoverable by grepping the code or reading a route/table definition does not belong in it.

## Doc map

| Doc | Read before touching |
|---|---|
| [BACKEND](docs/BACKEND.md) | startup plumbing, sync internals, lean storage, branch snapshot, My Turn, the Pending tabs |
| [SYNC](docs/SYNC.md) · [REALTIME-SYNC](docs/REALTIME-SYNC.md) | sync triggers/backfill · adaptive polling, post-write settle |
| [DATA-MODEL](docs/DATA-MODEL.md) | any schema/table change; per-table contracts; the bot vocabulary |
| [API](docs/API.md) | any route — the per-route contract reference |
| [FRONTEND](docs/FRONTEND.md) | stores, tabs/overlays, FilterBar scoping, timeline internals, PrDetail, This Sprint |
| [MERGE-CI-TRUNK](docs/MERGE-CI-TRUNK.md) | merge verdict/queue, auto-merge runner, the in-app conflict resolver, CI logs, trunk status |
| [CLAUDE-REVIEW](docs/CLAUDE-REVIEW.md) · [CODEX-PLAN](docs/CODEX-PLAN.md) | Claude Review, ticket/CI reviews, diagrams, AI Fix, auto-posting, sprint briefs/paths, the Codex provider · its build history |
| [BOTTLENECKS](docs/BOTTLENECKS.md) | the court ledger behind Reports → Chronology, its budgets and pointers |
| [BLAST-RADIUS](docs/BLAST-RADIUS.md) | the Low/Medium/High reach chip, the co-change index, the impact note |
| [TRACKERS](docs/TRACKERS.md) | the issue tracker: Jira, GitHub Issues, Linear, Notion, stored tickets + worker, the sealed token |
| [SONARCLOUD](docs/SONARCLOUD.md) | the per-(PR, head) snapshot, the review block, the one PR comment, AI Fix's `Q<n>` items |
| [REFERENCE-DOCS](docs/REFERENCE-DOCS.md) | the workspace reference library: ingest, the INDEX → CONTENTS → section tree, `docsContextFor` |
| [ML-SEVERITY](docs/ML-SEVERITY.md) · [ML-NODE-PORT](docs/ML-NODE-PORT.md) | ML severity/category of bot comments · the in-process scorer (`ml/`) |
| [PERIOD-REPORTING](docs/PERIOD-REPORTING.md) | window purity, coverage bias, actor lanes, the person vector |
| [PLATFORM](docs/PLATFORM.md) · [DEMO](docs/DEMO.md) | the platform features (formerly Pro): Activity, Feed, Bots Monitoring, peer benchmark, impact note, work plan, Slack |
| [SECURITY](docs/SECURITY.md) | app.ts, CORS/CSP, host guard, rate limits, data export, dependency posture |
| [PACKAGING](docs/PACKAGING.md) · [RELEASE](docs/RELEASE.md) | build-release, CLI, the AI/ML runtimes · CI publishing |
| [MIGRATIONS](docs/MIGRATIONS.md) · [TESTING](docs/TESTING.md) | any migration; history and fold rules · test projects, CI |
| [`apps/site/README.md`](apps/site/README.md) · [`apps/frontend/src/demo/README.md`](apps/frontend/src/demo/README.md) | the website service + contact form · the static demo and its recording format |

---

## Mental model (read this first)

```
 gh auth token ─┐
                ▼
   GitHub API ──► sync pipeline ──► SQLite ──► Fastify API ──► React SPA
  (GraphQL+REST)  (adaptive tick,   (~/.limn)  (lean /timeline,  (vis-timeline,
                   idempotent)                  detail on demand) zustand, RQ)
```

- **Sync** pulls PR activity into the DB; fully idempotent.
- **The API** is a thin read layer; the timeline endpoint is deliberately _lean_, heavy detail
  fetched on demand.
- **The frontend** is a timeline-first dashboard: server state in React Query, UI/filter state
  in a Zustand store mirrored to the URL.

The load-bearing concept is **derived thread state** (below).

---

## Runtime: local, SQLite, one account

- **One process on the reader's machine.** `/` → 302 `/app`; the SPA at `/app`. GitHub auth is
  `gh auth token`, ALWAYS through `auth/account.ts` `getAccessToken`. ⚠ `github/client.ts`
  exposes **per-account** factories and keeps **NO module-level token cache**. `auth/crypto.ts`
  stays for the tracker / SonarCloud sealed secrets.
- **One synthesized account** (`isLocal`, id 1, refreshed from `gh api user` at boot). `accountId`
  is still denormalized onto the anchor tables (`repos`, `pullRequests`, `events`,
  `claudeReviews`, `workspaces`, `workspaceRepos`, `workspaceReviewers`, `mlCommentLabels`) and
  every query still filters on it; id-addressed getters scope ownership → null → 404; ids that
  arrive in a request BODY are guarded by NAMED COMPOSITE FKs against `(id, account_id)`.
  `users` + `commitFiles` are **global**. Node-id uniques are composite (`(accountId,
  githubNodeId)`, `events (accountId, dedupeKey)`, child `(prId, githubNodeId)`). Keep it that
  way; `verify:isolation` still checks it.
- **SQLite only** (`better-sqlite3`, `db/schema.sqlite.ts`, `db/migrations/`). `db/client.ts`
  types `db` as `BetterSQLite3Database`. The query layer keeps its **async style**: `await
  q.execute()`, `.returning().execute()`, `onConflictDoUpdate`; "rows affected" =
  `.returning({id}).execute().length`. `.get()/.all()/.run()` now compile, but do not mix them in.
  ⚠ **Every transaction goes through `runTransaction`** (better-sqlite3 rejects async callbacks;
  it wraps a manual BEGIN/COMMIT) — and its block must await ONLY in-process DB work, never a
  `fetch`, or it holds the single write lock across network latency. `rawSqlite` is for DDL in
  `platform/migrate.ts` only.
- Data lives in `~/.limn` (`LIMN_DATA_DIR`); `DATABASE_URL` overrides the SQLite path. Config
  comes from `.env` (repo root) then `apps/backend/.env`.

**Removed 2026-10-22 — do not reintroduce:** cloud mode, Postgres, the Pro entitlement layer,
credits, Stripe billing and the cloud benchmark collection (the full list:
[docs/BACKEND.md](docs/BACKEND.md)). Their tables stay dormant, never dropped.

---

## Stack

- **Monorepo:** pnpm workspaces, TypeScript + ESM throughout, Node ≥22 (dev on 24).
- **Backend:** Fastify + Drizzle ORM (SQLite), `node-cron`, pino.
- **Frontend:** React + Vite + Tailwind + `vis-timeline`, Zustand, TanStack Query.
- **GitHub:** `@octokit/graphql` (one fat query per repo) + occasional REST.

## Repo layout

> ⚠ **"Workspace" is TWO things.** A **pnpm workspace** is a package here (`apps/backend`, …).
> A **Workspace** (capital W, the product noun) is a named grouping of an account's repos — the
> app's ONE scope (`workspaces` table). Everything after this section means the latter.

```
pierre-review/
├─ apps/
│  ├─ backend/   src/{index,app,config,cli}.ts · auth/ · ai/ (provider, credentials, codex/) · db/
│  │             (schema.sqlite.ts, client.ts, queries.ts, migrations/) · github/ · sync/ (+
│  │             __fixtures__/threads/) · merge/ · conflict/ · review/ · coding/ · tracker/ ·
│  │             sonar/ · reference-docs/ · ml/ · platform/ (formerly Pro) · api/{routes,plugins}/
│  ├─ frontend/  the SPA (base `/app/`): App.tsx · store/ · hooks/ · api/client.ts · components/ ·
│  │             lib/ui.ts · src/demo/ (the static demo runtime, `--mode demo` only)
│  ├─ landing/   the marketing site, PRERENDERED per route (served by apps/site, NOT the npm release)
│  └─ site/      the website service: landing + /demo/ + /api/contact (node:http, no runtime deps)
└─ packages/
   ├─ shared/    the contract between the apps (types + the few shared folds; see Packaging)
   └─ ml/        pierre-ml submodule: model assets + the Python severity-api. NOT a pnpm workspace.
```

## Commands

All from the repo root unless noted.

| Command | What it does |
|---|---|
| `pnpm install` | install all workspaces |
| `pnpm dev` | backend (`:4000`) + frontend (`:5173`); bot comments scored in-process |
| `pnpm dev:backend` / `dev:frontend` / `dev:ml` / `dev:site` | run one side only |
| `pnpm build` · `pnpm typecheck` | recursive build · `tsc --noEmit` everywhere — **run typecheck before calling work done** |
| `pnpm test` · `test:all` | fast backend tests + site · plus the `slow` ones |
| `pnpm db:generate` · `db:migrate` · `db:studio` | Drizzle migration from `schema.sqlite.ts` · apply (also runs on boot) · studio |
| `pnpm sync:once owner/repo` | one-off sync of one repo without the server |
| `pnpm --filter @pierre-review/backend verify:isolation` | query-layer cross-account IDOR check |
| `pnpm demo` | seed `acme/*` + boot the ISOLATED screenshot stack (`:4100`/`:5273`, gh off PATH); `--no-seed` reuses the DB |
| `pnpm shots` · `pnpm demo:video` | landing screenshots · the walkthrough clip (`--publish` writes `apps/landing/public/media/`) |
| `pnpm demo:record` · `demo:verify` | re-seed and record `apps/frontend/src/demo/data/recording.json` · check every demo view ([docs/DEMO.md](docs/DEMO.md)) |
| `pnpm --filter @pierre-review/frontend build:demo` · `dev:demo` | the static demo → `apps/frontend/dist-demo/` (base `/demo/`) · same on Vite |
| `pnpm test:e2e` · `pnpm verify:ui` | Playwright suite · UI smoke |
| `pnpm package` | assemble `./release` for publishing |

**`pnpm dev` scores bot comments in-process (model from `packages/ml/serving_assets`);
`PIERRE_ML_HTTP=1` runs the Python severity-api instead** ([docs/ML-NODE-PORT.md](docs/ML-NODE-PORT.md);
⚠ it exports `SEVERITY_API_DEFAULT_URL`, never `SEVERITY_API_URL`).

---

## Backend

**Boot order** (`index.ts`): migrations → event cleanup → clone-cache sweep (bounded) →
`ensureLocalAccount()` → `buildApp()` → `bindPlatform()` → scheduler → listen.

### Sync pipeline (`src/sync/`)

Mechanics: [docs/BACKEND.md](docs/BACKEND.md) · [docs/SYNC.md](docs/SYNC.md) ·
[docs/REALTIME-SYNC.md](docs/REALTIME-SYNC.md). The rules:

- **Adaptive polling is THE strategy** (`syncAdaptive` defaults `true`): a 10s *tick*, one at a
  time; `isDue()` gates free 304 probes by bucket; a probe's 2xx (never an error status) walks
  ≤ once/60s per repo (dirty flag). updatedAt-SILENT changes (CI, threads, trunk) are found by the ~1-point/repo SETTLE SWEEP
  (`sync/settle-sweep.ts`), never a walk. ⚠ **An explicitly-set `SYNC_CRON` wins** — pinning
  `*/5` silently negates the hot bucket.
- **A VIEWED PR gets its own live cadence** — the SPA polls `POST /api/prs/:id/refresh` every ~5s
  while the pane is open+visible (`sync/refresh-pr.ts`): probe-gated, 30s forced-walk floor, failed
  walks remembered (`lastWalkOk`). ⚠ Never route it through `enqueuePrSync` (the debounce swallows
  the cadence) and never default the poll to `waitForInFlight`.
- First sync of a repo is **two-phase**: a fast ~14-day foreground pass, then the 90-day backfill.
- **GitHub rate limits are PRE-EMPTED, never surfaced as errors** — loops wait on the budget in
  cancellable ≤1s slices and a waiting repo reports `paused:{…}`. ⚠ Do NOT widen
  `isRetryableGithubError` to cover them (a test pins its 403/429 exclusion). ⚠ Every synchronous
  `running`/`queuedRepos`/`deepSyncing` add must be released on EVERY bail path INCLUDING thrown
  lookups. ⚠ `noteBudget` must NOT clear `limitedUntil`.
- **Lean storage**: PR description, review-comment `diffHunk`, commit `message` and `checkRuns`
  JSON are hydrated on demand (`sync/hydrate-detail.ts`). **Comment + review bodies are ALWAYS
  persisted** (`PERSIST_BODIES=true` stores all).
- The **default-branch snapshot** ending every repo sync is **STRICTLY NON-FATAL** and two-phase
  for GraphQL cost; `contexts(first:100)` must NOT be lowered.
- **A completed FULL walk tail-runs the one-time CI-history backfill**. ⚠ A PR's CI log is touched
  ONLY when provably its first-observation snapshot.

### Derived thread state — the heart of the app

`derive-thread-state.ts` classifies each review thread during sync (`reviewThreads.derivedState`):

| State | Meaning |
|---|---|
| `resolved` | marked resolved on GitHub |
| `likely_addressed` | a commit touched the thread's file _after_ the last comment — **a heuristic** |
| `replied_unresolved` | replied, but unresolved and no later commit touched the file |
| `untouched` | no reply, no follow-up commit |

`likely_addressed` is intentionally fuzzy and the UI must keep communicating that uncertainty.
Before changing the heuristic, add a fixture to `src/sync/__fixtures__/threads/`.

### Data model

`db/schema.sqlite.ts` is authoritative for core; `platform/*/schema.sqlite.ts` for the platform's
`pro_*` tables. Per-table contracts and the automation vocabulary (`ReviewerRole` — SIX members,
EXACTLY ONE of which, `'review'`, is the reviewer cohort · `AutomatedReviewerKind` ·
`AUTOMATION_VENDORS`, the ONE table every per-family login set is DERIVED from ·
`REVIEW_BOT_KINDS`) live in [docs/DATA-MODEL.md](docs/DATA-MODEL.md). Without opening it:

- Timestamps are unix-epoch ints read as `Date`. GitHub node ids are the identity. Triage fields
  are computed on read, never stored.
- **`workspaces` + `workspaceRepos` are the ONE scope** — a repo is in EXACTLY ONE workspace,
  assignment is an upsert = a MOVE, and the one `isDefault` row per account is a partial unique
  index in the `.sql` migration (drizzle predicates are inert). ⚠ A repo with NO membership row is
  invisible everywhere, so `ensureRepoMemberships` MUST keep `ON CONFLICT … DO NOTHING`.
- **`workspaceReviewers` is THE BOT OBJECT** — one row per `(accountId, workspaceId,
  authorUserId)`: judgement, identity and price (one writer `setReviewerCost`). Price is per
  WORKSPACE — **never sum cost across workspaces**.
  ⚠ `deleteWorkspace` re-homes its repos AND its reviewer rows to Default BEFORE deleting.
- ⚠ Every reviewer-cohort test is **`=== 'review'`, never `!== 'quality_check'`**; **the STORED
  role/kind beats the login seed on read**; `ReviewBotKind` must NEVER absorb non-reviewer brands;
  **`vendorKindsForRole` always includes the STORED kind**.
- **`repos.createdAt` is LOAD-BEARING** (an onboarding floor for My Turn). `branchCommits` is NOT
  derivable from `commits`. `autoMergeRequests` is state, not a log (unique `(accountId, prId)`).

### HTTP API

JSON wire, ISO-8601 timestamps; payload types in `packages/shared`; one file per resource in
`api/routes/`, each mapping to a `client.ts` method. **Consult [docs/API.md](docs/API.md) before
changing a route's shape.** The platform's `/api/pro/*` URL paths are historical and stay.

- **`?workspace=<integer>` is THE scope parameter.** Absent / unknown / unparseable ⇒ the
  DEFAULT workspace — **never a 404**. Every scoped response echoes `workspaceId`. `?repoIds=` is
  data narrowing ONLY, bounded by `resolveWorkspaceScope` (`membership ∩ narrow`).
- Client side: send `repoIds` whenever the array exists — **including when empty** (`if (ids)`,
  never `ids.length > 0`); every scoped React Query key carries a `ws:<id>` segment.
- ⚠ **`GET /api/feed` is DELETED** (`getFeed` stays, for `GET /api/activity/feed`). There is NO
  cross-workspace comparison anywhere — do not add one.

---

## Product voice — PLAIN ENGLISH, AND AS LITTLE OF IT AS POSSIBLE

Every user-facing string (SPA, landing, server-templated sentences) is plain English, and the
shortest honest version wins.

- **NAME THE THING.** "CodeRabbit", not "the same product"; "similar-sized repos", not "the
  cohort". A term that needs the reader to know the fold is the wrong term.
- **STATE THE FACT AND STOP.** No hedging preambles, no confidence chips narrating themselves.
  ⚠ Certainty is still COMPUTED and still ORDERS lists; only the narration goes.
- **A NUMBER IS NOT A DISCLOSURE.** Round it, give it a checkable denominator; prefer a figure
  that needs no caveat.
- **THE HONESTY RULES ARE NOT NEGOTIABLE, AND NOT AN EXCUSE FOR LENGTH** — label populations
  apart and refuse rather than guess, in fewer words.
- **EXPLANATION LIVES BEHIND AN ⓘ BUTTON** (`InfoButton`, `components/InfoModal.tsx`) beside the
  heading it explains — never caption paragraphs or definitions folded into row labels.
- **SMALL TEXT IS NOT FREE.** 11px floor for a label, 12px for a sentence; contrast enforced by
  `textContrast.test.ts` + `vendorInk.test.ts`.
- **No "Pro", "paid", "plan" or credits wording anywhere** — everything is available.

## Frontend

Four separated state layers: **server state** in TanStack Query (detail on demand,
IndexedDB-persisted), **filter/selection** in Zustand `store/filters.ts` (`workspaceId` is the
scope), **tabs** in `store/pinnedTabs.ts` (one board mounts at a time), **URL** mirrored by
`useUrlState.ts`. App lands on **Activity → Open PRs** (headed by the trunk strip). Nav: ONE
sidebar (`components/shell/` `goTo`), never unmounted. Pending is `?activityRepo=attention`; the Insights rail entry is
labelled **"Reports"** (store/URL value stays `'insights'`). The only gates are
`me.ai.enabled` (agentic) and `me.mlSeverity` (ML queries).
Read [docs/FRONTEND.md](docs/FRONTEND.md) before touching any of:

- **Bots are HIDDEN by default on the Timeline; the Feed is People OR Bots, never mixed**, both by
  the UNION `hiddenBotUserIds` (a manual "human" judgement wins BOTH directions). ⚠
  `useSearchTimeline` / `rosterTimelineSearch` always send `excludeBots=false`. A PR Focus tab
  filters CLIENT-SIDE (`Timeline/isolateFilter.ts`); ⚠ no filter in `buildTimelineSearch`'s `prIds`
  branch, and never idle the board's `useTimeline()` in Focus.
- **`workspaceId === null` means "not resolved yet"** — render nothing workspace-scoped and omit
  `?workspace=` while null. **`useWorkspaceSync` is three-branch** (null-or-dead / changed / PRUNE
  ONLY), tracking the previous id in a ref. **`workspaceId` must NOT live in `FilterDefaults`**.
  Legacy `?team=<int>` with no `?workspace` IS the workspace id.
- **The repo picker is Timeline-ONLY.** Activity, Feed, Bots and Reports cover the whole workspace.
- **The Feed is a STREAM (`FeedView`) and nothing else** — no survey panels, Pending items or
  sub-tabs (bot classification is a Bots Monitoring tab). A default flip on a persisted key needs a `FILTER_STORAGE_VERSION` bump (now v5; `migratePersistedFilters`
  steps CHAIN).
- **REPORTS IS TIED TO ONE REPORTING WINDOW** — resolved ONCE per request by core
  `db/reporting-window.ts` `getReportingWindow`; never a second resolver. Exceptions are LABELLED
  (docs/FRONTEND.md § ONE REPORTING WINDOW).
- **"Where the work is happening" = two `charts/RepoRows` cards in `WorkspaceFlowMetrics`**
  (never `WorkspaceMetricsPanel`); **unknown is never zero** (`linesChanged: null` → "size
  unknown"; a null reach verdict is undrawn).
- **The Pending board is SEVEN scored TABS** (`PENDING_TABS`, `db/pending-tabs.ts`) ranked by ONE
  scorer (`db/work-plan.ts` `scoreCards`). ⚠ **It ranks the UNCAPPED fold, then caps**; only
  `/api/attention` passes `uncapped`. ⚠ **Each count is its own population** (`/api/daily-brief`
  returns the same figures). ⚠ **The tabs are an ALLOW-list.** Every floor/cap/threshold lives ONCE
  in `packages/shared/src/pending-rules.ts`. The literal stays `'attention'`.
- **NOTHING ON THE PENDING BOARD MAY FETCH ON MOUNT.** Merge buttons gate on synced fields through
  `mergeVerdict()`; live merge options are CLICK-gated; HIDE, never disable. A QUEUED PR never
  shows Merge. `conflicts` carries ONE action (the resolver), only in `writableRepoIds`.
- **Board freshness is ONE batched sweep, `POST /api/attention/liveness`** (mergeability for ≤ 25
  ids — 50 502s). ⚠ An observed `unknown` never demotes a known merge state. ⚠ **It returns
  COUNTS, never cards**: refetch `['attention-cards']` + `['daily-brief']` + `['work-plan']` together.
- **MY TURN IS THE BALL RULE, STATE-DERIVED** ([docs/BACKEND.md](docs/BACKEND.md) § My Turn): a
  card exists only while the reader owes an action not taken since the last RELATED event. ⚠ The
  one stored thing is a per-SUBJECT DISMISSAL timestamp, applied inside `getMyTurn`. ⚠ **No bot
  action returns the ball, including a push**; bot-ness via `globalAutomationUserIds`, NEVER
  `hiddenBotUserIds`. ⚠ **Filter the SEED list, never the built array.** One card per PR
  (`onePerPr`), except Claude reviews.
- **A surface that NOTIFIES counts `myTurnPersonal`; one you OPEN counts `myTurn`.**
  `attentionRelevance` is three-valued and every entry point SEATS it; `myTurnOther` is never
  `myTurn - myTurnPersonal`; `?attnRel=` is the only key emitted.
- **THE PENDING MUTE rides `relevance`, once, inside `getMyTurn`** (`db/pending-mute.ts`): a muted
  repo's rows become `relevance: 'none'`; no population changes. ⚠ The write must scope its delete
  to the named workspace's membership.
- **Visible sub-tabs are DERIVED, never written back** (`effectiveTab`s) — a corrective `set…`
  permanently forgets the choice.
- **BLAST RADIUS is ONE resolver, `blastRadius()`** (shared `blast-radius.ts`); the wire carries
  SIGNALS, never a level, and the level never moves onto sync. Its unknown-is-not-zero rules:
  [docs/BLAST-RADIUS.md](docs/BLAST-RADIUS.md).
- **Timeline vertical scroll is GATED** — every programmatic scroll goes through
  `setVisScrollTop` and claims the gate; copy `centerShowTarget`.
- **THERE IS NO THREADS TAB.** Threads live in Changes: inline pills, or the sticky bar's
  "Threads only" view; every thread link lands through PrDetail `showThread`. The fold is
  RENAME-AWARE (`indexThreadsByPath`); `threadStateFilter` is global — applied only when
  `selectedPrId === prId`. `UserName`'s tree SHAPE must not depend on popover-open state.
- **EVERY ICON IS A COMPONENT IN `components/Icons.tsx`** (exception: `FileTypeIcons.tsx`); no
  icon emoji/library. `CaretIcon` = menu trigger, `ChevronIcon` = expand/collapse.
- **The AI surface has EIGHT `--ai-*` tokens** with SPACE-separated channels; surviving
  `violet-`/`purple-`/`indigo-` hits are deliberate keeps.
- **Every AI surface gates VISIBILITY on `me.ai.enabled` and its Run button on the ONE
  `AiRunGate kind=…`** (`components/AiSetup.tsx`), agentic and one-shot alike. Never credits: on an
  API key a run shows US$; on a subscription its share of the week, never US$ — always through ONE
  formatter, `useRunCostText()` (`lib/aiBudget.ts` `runCostText`).
- **Sync-round state has ONE driver, `SyncStatus`; there is ONE header toast strip,
  `HeaderToasts`** (never a second strip or a `fixed` toast). Both: docs/FRONTEND.md.
- **Reactions are fetched ON DEMAND (one batched lookup), NEVER STORED.**

---

## Merge, CI logs & trunk status (no AI)

Full detail: [docs/MERGE-CI-TRUNK.md](docs/MERGE-CI-TRUNK.md). The invariants:

- **Every "can this land?" surface resolves through the pure `mergeVerdict()`** (`lib/ui.ts`);
  lead with `mergeStateStatus`. ⚠ **`unstable` IS mergeable**; `behind` is not.
  `db/triage.ts` `READY_MERGE_STATES` and `mergeVerdict`'s `canMerge` must agree.
- **`blocked` carries a ranked `blockers[]`** (`deriveMergeBlockers`, PR detail ONLY), each
  `proven` or `inferred` — only `reviewDecision` can be proven. ⚠ Never assert unresolved threads
  are the blocker. `approved` removes a row, never adds one.
- **Withdraw approval** dismisses the viewer's own latest APPROVED review (read live). PR action
  buttons hide behind one "Show actions" reveal; facts never hide.
- **GitHub's merge queue**: membership synced and stamped via `db/pr-merge-queue-stamp.ts` (NOT
  `db/merge-queue.ts`, Limn's own landing order); position/ETA live-only.
- **Auto-merge (`merge/auto-merge-runner.ts`) is consent-anchored** — never GitHub's
  `enablePullRequestAutoMerge`. Arming pins `expectedHeadOid`; compare-and-set + permission
  re-check at LAND time. ⚠ **`behindBy > 0` is normal** — only `mergeStateStatus === 'behind'`
  blocks. Every arm goes through `armIntentLive`. Queue repos: freshen BEFORE the first enqueue,
  never while queued.
- **Dependency auto-merge** (`merge/dependency-policy.ts`): OFF by default; a person's cancel is
  never overridden; red CI backs off after ONE live-proven failure.
- **A repo's armed intents land ONE AT A TIME** (`db/merge-queue.ts`; `queued_local` ≠
  `queued`). ⚠ Rules 1–4 still run for every intent; `freshenedIntents` is once per TURN.
- **Conflicts are resolved in the app** (`src/conflict/`, `components/conflicts/`; read the doc's
  § Resolving conflicts first). ⚠ The commit body carries only indexes, ids and enum members — an
  edited region travels as an opaque `editId` (`POST …/conflicts/edit`). ⚠ The wand NEVER picks a
  side. ⚠ Nothing is applied before the reader presses something, except a "Resolve with Claude"
  run the reader started. ⚠ Sessions are pinned to `(headSha, baseSha, modelHash)` — **bump
  `CONFLICT_MODEL_VERSION` with any fold change**. ⚠ The commit is HARD BLOCKED until every
  decidable region is decided (`CommitPlan.canCommit`).
- CI logs are live ranged reads of the signed Actions blob URL — **NEVER returned to a client**.
- Trunk status (`/api/branch-status`) is **informational only** — no counts, badges or My Turn.
- ⚠ **`limn/` commit statuses (team claims) are NEVER CI** — every CI read filters them via shared
  `isLimnStatusContext` / `rollupStateWithoutLimn` (docs/CLAUDE-REVIEW.md § Team claims).

---

## The agentic features (Claude or Codex)

Claude Review (+ follow-up, auto review, chat, the per-ticket TICKET review, the CI review,
design diagrams, Check threads), AI Fix (+ Plan first), Resolve with Claude, the reference-docs
library, sprint briefs/paths and every one-shot completion, on Claude or Codex. Details: [docs/CLAUDE-REVIEW.md](docs/CLAUDE-REVIEW.md) (§ Codex, the second provider) ·
history: [docs/CODEX-PLAN.md](docs/CODEX-PLAN.md). Non-negotiables:

- **ONE switch, `config.aiEnabled` = `LIMN_AI_DISABLED !== 'true'`.** `registerAgenticRoutes`
  registers NOTHING when off. `MeResponse.ai` carries `enabled` / `runtime` / `auth` / `provider` /
  `providerSetting` / `providers` / `kinds` (the pre-flight per run kind); no credential swaps the Run button for ONE
  line, never hides the feature.
- ⚠ **EVERY MODEL CALL GOES THROUGH `ai/provider.ts`**: runners call a provider's `runAgent`,
  `cheapComplete` calls `.complete`. ONLY `ai/providers/claude.ts` (+ `ai/runtime.ts`) calls
  `query`/loads an SDK, adding the path guard, own-tools hook and isolation (`provider-seam.test.ts`).
  The DEFAULT provider is `activeProviderId` (`LIMN_AI_PROVIDER` = `claude`|`codex`|`auto`, else
  Settings → AI; `auto` = Claude when both are signed in): it runs every AUTOMATIC run and every
  surface without a model menu. A MANUAL picker run (AI Review, AI Fix) names `{provider, model}`
  (`ai/run-choice.ts`). A job resolves its provider ONCE; row label, follow-up chain, ledger and
  budget use the RUN's. Every run row stores the `provider` + `model` that RAN, shown ONLY via
  `aiRunLabel`; ⚠ a stored model fed to a new run goes through `requestModelOf`.
- **CLAUDE: ONE CREDENTIAL LADDER** (`ai/credentials.ts` `resolveAiCredential`): the reader's
  Claude Code login first (a `claude` session on disk or `CLAUDE_CODE_OAUTH_TOKEN`), else the
  environment's `ANTHROPIC_API_KEY`; `LIMN_AI_USE_API_KEY=true` puts the key first. Agent runs pass
  the ladder's environment as the query `env` (`agentAuthOptions()`, so a login run never sees the
  key); `cheapComplete` takes the Agent SDK on the login and the Anthropic API on the key. **No
  caller picks its own credential, and nothing is stored.** Copy never promises subscription
  billing. `REVIEW_BUDGET_USD` (default $6.75). Spend is recorded (`recordAiUsage`), never metered.
- **EFFORT IS ONE SETTING** (Settings → AI → Effort; `ai/effort.ts` `agenticRunEffort`, read once per
  run): the review (+ specialists, follow-ups), AI Fix and Plan first, the SAME word on both providers.
  Default (NULL) = today: Claude medium, Codex by depth. `REVIEW_EFFORT` wins. ⚠ Opus 5.5 is NOT pinned;
  only adaptive thinking is. The run stores what it sent (`aiRunLabel(provider, model, effort)`).
- **CODEX** (Phase 3 complete: every agent kind ported, `codexRunnable()` true) runs the pinned CLI
  directly — `codex exec --json --strict-config` — in Limn's OWN Codex home `~/.limn/codex`
  (`limn ai login codex` or Settings; a ChatGPT sign-in only — an OpenAI API key is REFUSED until it
  can be priced). ⚠ The reader's `~/.codex` is NEVER read or written. The lockdown is ONE list
  (`ai/codex/config.ts` `LOCKED_SETTINGS`: no shell, web, images, plugins or memories;
  `project_doc_max_bytes=0`); files are read ONLY through Limn's workspace MCP server. ⚠ Codex skips
  an untrusted hook SILENTLY, so every run refuses unless `verifyHookTrusted` proves the PreToolUse
  ALLOW-list hook runs. Results are strict JSON Schemas (`ai/result-schemas.ts`) fed to the SAME
  handlers, one retry via `exec resume`; Limn runs the specialists; writes are read from git; a
  run's thread is deleted once its usage is recorded. Models: deep `gpt-6.1-sol`, standard
  `gpt-6.1-terra`, fast `gpt-6-luna`. ⚠ A Codex change leaves Claude's prompts byte-identical
  (`prompt-golden.json`); Codex wording goes through `ai/prompt-tools.ts`.
- **No AI SDK in the npm manifest** — downloaded on first use ("Set up AI" / `limn ai install
  [codex]`) and value-imported ONLY by `ai/runtime.ts` (`loadAgentSdk`/`loadAnthropicSdk`/`loadZod`);
  `build-release.mjs` asserts it.
- **THE SPEND BUDGET** (ON by default at 50% of the week on a subscription — the reader may change or switch it off; never-set on an API key = no cap; per machine, `ai/budget.ts`; read per provider): ⚠
  **every AUTOMATIC model run asks the ONE gate first** (`review/budget-gate.ts`
  `automaticRunAllowed` / `ctx.aiBudget`) and is SKIPPED, never queued, when over; a reader's click
  is never refused (the SPA asks). On a subscription it is a share of the week and of the 5-hour
  session in PERCENTAGES ONLY — no US$ on a subscription anywhere; the header reads the SAME
  `['ai-budget']` query. Claude: Limn's spend ÷ the estimated allowance; its usage reading (the
  `loadAgentSdk` Query tap — never add per-runner forwarding) NEVER blocks. ChatGPT: TOKEN-WEIGHTED,
  Limn's tokens ÷ the account's tokens × Codex's own `usedPercent`, per window.
- **The agents' tools**: the reviewer and every chat are read-only, **`Bash` denied**; the fixer has
  file tools + `submit_fix`, `DISALLOWED_TOOLS = ['Bash','NotebookEdit']` — **it builds and tests
  nothing**, and the SPA says "Not built or tested here." ⚠ `WORKTREE_RULES` and the tool list change
  together (`no-shell.test.ts`). Every run sits behind the PATH GUARD (`review/path-guard.ts`).
  Anything an agent reads from a PR is UNTRUSTED.
- **Nothing is posted or pushed until the reader presses the button**, except the per-workspace
  auto-post / Push automatically switches (OFF by default). Auto-posting is AUTO RUNS ONLY, under
  the reader's account, ONE review, `COMMENT` unless the OFF-by-default `autoVerdict` allows
  stricter (then a run not approved says why — alone, ONCE per (PR, head), if nothing else posts);
  ⚠ the `auto_post` record is CLAIMED (compare-and-set) BEFORE any GitHub write, a
  failure is recorded and NEVER retried. Every posted body carries the hidden marker so
  `isLimnPostedComment` holds.
- **Auto review is OFF per workspace until switched on**; ONE start rule (`autoReviewDue`); it
  re-reviews once per new HEAD; only a PERSON's or a REVIEW bot's (`=== 'review'`) comments count,
  never Limn's own. A FAILED auto run at the head is retried by that same rule only when TRANSIENT
  (≤ 3 auto rows per head, counted in the DB); "Run auto reviews now" / Retry (`POST
  …/auto-review/sweep`) waives the waits and that cap, never the daily cap. A succeeded auto run on the reader's own PR may start an AUTO FIX (≤ 3 per PR
  per 24h, `workspaces.auto_fix_enabled` OFF by default).
- ⚠ **A replies pass (`claude_reviews.kind = 'replies'`) is a run row, NOT a review**: every "latest
  review" / "run at this head" reader filters `kind IS NULL`; the follow-up chain anchors on the
  latest FULL review (docs/CLAUDE-REVIEW.md § The replies pass).
- **Thread judgements**: "what Claude says now" is ONE fold, `currentThreadAssessmentsForPrs`
  (latest review + later Check threads, newer wins); words only from `lib/claudeThreadMarker.ts`.
- **Separate processes, never inside a PR review**: the CI review (`review/ci-review/`; the signed
  log URL never leaves the server), the TICKET review (`review/ticket-review/`; ONE story per
  ticket via `ticketStory`), design diagrams (`review/diagrams/`). ⚠ `tracker/runtime.ts` opens the
  DB at import — keep review-side tracker imports LAZY.
- **AI Fix has TWO seeds**, `review` and `plain` (`comments`/`ci_analysis` 400 `SeedRemoved`, still
  read as history). Plan mode is MANUAL and READ-ONLY. URL paths kept (`/api/pro/prs/:id/ai-fix*`).
- **The moved modules take ONE `AgentContext`** (`review/agent-context.ts`), never the platform
  context.
- **SonarCloud** and **reference docs** ([docs/SONARCLOUD.md](docs/SONARCLOUD.md),
  [docs/REFERENCE-DOCS.md](docs/REFERENCE-DOCS.md)): sealed write-only tokens; a Sonar snapshot is
  kept only when SonarCloud analysed THIS head; the docs crawl is same-host, LINEAR scanners over
  untrusted text, every doc link through `resolveDocLink`.

## Platform features (formerly Pro)

The old `@pierre/pro` plugin is core code at **`apps/backend/src/platform/`** — reporting, Bots
Monitoring, the work-plan wording, the impact note, Slack.
[docs/PLATFORM.md](docs/PLATFORM.md).

- **Bound statically at boot**: `platform/context.ts` `bindPlatform` builds ONE `ProContext`
  (`platform/contract.ts`) and calls `registerPlatform`. Platform modules read the host ONLY
  through that ctx — inject a new host dependency there, never import it. Tests pass a fake ctx.
- **Its own migrations**: `platform/migrations/*.sql`, run after core's, filename-sorted, each once
  by NAME in `pro_migrations`; NO journal. A failure FAILS THE BOOT. Tables keep their `pro_*` names
  (`proSchemaFor()`).
- `ctx.schema` is `Record<string, any>` — a stale table name type-checks and throws only at run
  time. Grep, don't trust the compiler.
- **Generation is cost-gated**: the payload-hash cache (⚠ **zero `Date.now()`-derived fields** and
  never hash a HYDRATED or derived value, or every judgement reads `stale` forever); a per-account
  in-flight slot claimed SYNCHRONOUSLY.
- ⚠ **The D4 digit gate rejects UNICODE numerals** (`/^[^\p{Nd}\p{No}\p{Nl}]*$/u`). A
  model-derived figure and a code-derived figure are LABELLED APART.
- **The work plan: THE CODE RANKS, THE MODEL NARRATES** — the scorer is core (`db/work-plan.ts`);
  the model adds a headline, a `parked` line and one `why` per row, and may name ONLY a listed
  card. ⚠ `ageHours`/`stallRisk`/`score` stay OUT of the payload hash; ONE PR IS ONE JOB.
- **The peer benchmark** reads the BUNDLED `platform/data/benchmark/benchmark-fit.json`. ⚠
  **Refusals are the product** — never normalise one into a distribution shape. ⚠ **Money lives
  at WORKSPACE grain only** (a `?repoIds=`-NARROWED request builds no rollup); `$ per acted-on
  thread` REFUSES rather than falling back.
- **Slack** (`platform/slack/`): a TEAM digest — never a card about or naming the configuring
  account. Event signals (AUTO review ran — ⚠ never a manual run, PR merged) are OFF by default,
  CLAIMED before the post, never retried; a merge is announced only when SEEN LIVE (`sync/merge-notice.ts`).
- **The severity INFLATION index** counts only BADGED findings; a bot that badges nothing is
  OMITTED and NAMED, never a zero. Major+critical bucket as "high".

## Period reporting, Chronology, This Sprint

- **Period reporting** ([docs/PERIOD-REPORTING.md](docs/PERIOD-REPORTING.md)): metrics are core
  (`db/period-metrics.ts` and siblings); storage and narration are the
  platform's. Every metric is **WINDOW-PURE** (`[fromMs, toMs)` on every column; an explicit `toMs`
  reaches every fold). History is **COVERAGE-BIASED**. **One row never mixes headline and subset
  populations** (`rowFigures()`). `PERIOD_METRICS_SCHEMA_VERSION` is in the hash (three spellings
  in lockstep); a metric is RENAMED, never redefined. Grain (sprint vs month) is a READING choice,
  never stored. Every reading setting is PER WORKSPACE, no inheritance.
- **Chronology** ([docs/BOTTLENECKS.md](docs/BOTTLENECKS.md), `db/pr-intervals.ts`): every open
  hour belongs to a court (reviewer / author / landing). ⚠ A bot action never moves the ball and
  bot-authored PRs are not measured; flag only LOPSIDED *AND* SLOW; NO person is named (except the
  new-contributor marker). `getFlowCourts` stays account-row-free (`verify:isolation` calls it).
- **This Sprint** (fixed tab, `?view=sprint`; [docs/FRONTEND.md](docs/FRONTEND.md) § This Sprint):
  `GET /api/sprint-graph` is DB only, ONE fold (`db/sprint-graph-fold.ts`). Briefs, themes, "needs
  code" judgements and critical paths are made after a read, never on a view. ONE `LaneBoard`, rows by
  PR count; the story view opens only through `useOpenStory()`. Never bring the force-graph canvas back.
- **Trackers** ([docs/TRACKERS.md](docs/TRACKERS.md)): ONE per workspace; read when a PR is
  RECEIVED, never when VIEWED (exception: the sprint list read). ⚠ **The ONE tracker write is the
  Jira status transition the reader picks** in the story view (`tracker/status-change.ts`); nothing
  else writes. Customer-typed hosts go through `tracker/jira/fetch.ts`. Idents only via
  `trackerTicketIdent`/`trackerTicketRow`.
- Still gone: the story report, story-health charts, "Ask about this period", the People report,
  1:1 prep (tables dormant, still erased).

## ML severity/category on bot comments (no LLM)

Every bot-authored comment / review body gets a **severity** (`nit`·`minor`·`major`·`critical`) and
categories. [docs/ML-SEVERITY.md](docs/ML-SEVERITY.md) · [docs/ML-NODE-PORT.md](docs/ML-NODE-PORT.md).

- **TWO SCORERS, ONE SEAM (`ml/scorer.ts`)**: the in-process model (onnxruntime-node in a CHILD
  PROCESS; first use downloads ~240 MB: "Set up" / `limn ml install`, imported ONLY by
  `ml/runtime.ts`) or the HTTP `severity-api` (`SEVERITY_API_URL`). ⚠ Availability changes at run
  time — ask `isMlScoringAvailable()`. ⚠ The Node port matches the Python BYTE FOR BYTE
  (`packages/ml/data/parity`). ⚠ **It must never slow the
  machine**: one comment per run, 1 thread, background priority, a duty cycle, paused on battery.
- **Enrichment is a PULL worker (`sync/ml-enrichment.ts`), never a sync step**. Batch budget is
  CHARACTERS; results zipped POSITIONALLY (a length mismatch throws). `ml_comment_labels` is keyed
  `(accountId, targetKind, targetId)`. The badge never fetches (one `['ml-labels', prId]` index).
- ⚠ **`pending > 0` is NOT "scoring in progress"** — use `isMlScoring`. The enrichment kick sits
  ABOVE `clearSyncProgress`; an `await` added above it reopens the gap.
- The vendor's own badge is stored to be SHOWN, never BELIEVED.

---

## Security & privacy

Read [docs/SECURITY.md](docs/SECURITY.md) before touching `app.ts`, CORS/CSP, rate limiting or an
AI route. `api/plugins/security.ts` (CSP, loopback-only CORS, cross-origin guard, the host guard —
421 on a non-loopback `Host`, against DNS rebinding) and `api/plugins/rate-limit.ts`.

- **CORS allows loopback origins only** — the server has no auth, so any wider origin lets any
  open page read the whole dataset. The cross-origin guard and the host guard are separate
  protections, not redundancy.
- **A new route that spends money or GitHub quota needs a rate-limit TIER** in `tierFor` (+
  `rate-limit.test.ts`); follow the token, not "this route is DB-only". ⚠ Spell the EXACT path
  segment into `hitsGithub`.
- pino `redact`s auth headers. `GET /api/me/export` exports the account's data; a new
  `accountId`-bearing table must join `accountScopedTables()` (`db/erase-account.ts`) — the test
  iterates it. The platform erases its own tables through its registered handler.

## Conventions & gotchas

- **Relative imports carry an explicit `.js` everywhere** — backend AND frontend.
- **`packages/shared` is the only bridge.** Never import backend↔frontend directly.
- **Colour and contrast are MEASURED.** ⚠ A raw brand hex may not be TEXT colour — go through
  `vendorInk()` (it sets the `--ink-*` variables only, never `color`). `decorative-mark` is the
  only contrast opt-out, never on text that says something.
- **FOUR PATH CLASSIFIERS, NONE FOLDED INTO ANOTHER**: `NOISE_GLOBS`, `isLockFile`,
  `isNonCodeFile`, `BLAST_SURFACES` + `isTestFile` (`db/code-loc.ts` names all four).
- **`apps/backend/src/db/queries.ts` CONTAINS LITERAL NUL BYTES** — search it with `grep -a` /
  `rg -a` (and `git diff -a`), or a missing match is a false negative.
- **THE SCOPE IS ONE INTEGER** — no scope vocabulary, sentinels or parsers. **`BotScope {
  workspaceId, repoIds }`** is only ever built by `resolveWorkspaceScope`.
- **A fact lives at exactly ONE grain** — never denormalise it. Every read of the bot table takes
  an EXPLICIT workspaceId (`resolveWorkspaceReviewers`). ⚠ A one-row-per-author collapse without
  `ORDER BY` reads heap order. ⚠ `persist()` must NOT share one values object between insert and
  `set:` — it builds `set:` from the provenance flags, and `role` is DERIVED.
- **When a unique index CHANGES, every `onConflictDoUpdate` on that table must change with it** —
  a stale target type-checks and fails only when a row is actually written.
- **Keep `/api/timeline` lean** — detail on demand via `/api/prs/:id`.
- **A new GitHub-write route must STAMP or SETTLE-AND-VERIFY, THEN CASCADE**
  (`settlePrAfterWrite`, stating the expected effect; a merge calls `noteMergeLanded`); the SPA
  refetches through `invalidateAfterPrWrite`. ⚠ `visible:false` with a non-null `commentId` means
  it IS on GitHub — say "it'll show up shortly", **never offer a retry (it double-posts)**.
- **A column may be CLEARED only on a positive statement from GitHub** — `graphqlTolerant` nulls
  forbidden fields; model `undefined` (omit) vs `null`/`[]` (clear) (reference:
  `sync/branch-status.ts`).
- **A PR number resolves to a local id only within `(accountId, repoId)`.**
- **Never put a data-derived URL straight into `href`/`src`** — `safeExternalUrl()`.
- **Idempotency is load-bearing** — upsert on GitHub node ids with composite conflict targets;
  new event types get a deterministic `dedupeKey`.
- **`req.raw.on('close')` fires when a POST body is read** — watch `reply.raw` for a disconnect.
  The GET `…/stream` endpoints are fine.
- **A PR with no stored impact note issues NO request of its own** — read the one per-PR
  `useAnnotationIndex` query.
- **A feature can be built and UNREACHABLE — grep for the mount** (`grep '<Component'`).
- **TypeScript is strict** (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`).

## Verifying changes

`pnpm test` + `pnpm typecheck` for backend/heuristic logic (+ touched `slow` files). For UI,
`pnpm dev` is usually running (real-DB cases: `sqlite3`); deep-link with `?pr=<id>`, `?repos=<ids>`
on `/app/`. New id-routes: `verify:isolation`.

⚠ **`apps/frontend/test/` does not run in CI** (the frontend's `test` script is a no-op) and is
not typechecked — run it by hand: `./apps/backend/node_modules/.bin/vitest run --root
apps/frontend`. ⚠ **The E2E fixtures (`apps/frontend/e2e/mock-api.ts`) are a typechecked wire
contract** (`tsconfig.e2e.json`), but an unhandled route falls through to an untyped `{}`, and a
gap shows as a BLANK PAGE (no error boundary). Add a fixture with every boot-time route. The
demo's sample recording is generated from the same fixtures.

## Packaging & publishing

Ships to npm as `limn-review` (bin `limn`; the deprecated `pierre-review` stub forwards — ⚠ never
re-add that bin to limn-review). An existing `~/.pierre-review` is moved to `~/.limn` ONCE by a
single rename (`data-dir.ts`), never clobbering. Internal identifiers (`pierre*`, the DB file
name, `pro_*` tables, `/api/pro/*`) stay. **The release ships the backend + SPA only — no landing.**
Publishing is CI-only — **never run `npm publish`/`npm login` here**.
[docs/PACKAGING.md](docs/PACKAGING.md) · [docs/RELEASE.md](docs/RELEASE.md).

- **`@pierre-review/shared` is VENDORED** at `release/dist/shared` (it holds real code, e.g. the
  conflict fold, that both sides must agree on to the byte); every emitted specifier is rewritten
  and the build fails on one it missed. Never add it to the manifest; never fork a shared fold.
- The platform's migrations + benchmark data are copied to `release/dist/platform/`.
- **AI and ML runtimes install on first use** at pins the build writes into `limnAiRuntime` /
  `limnMlRuntime` / `limnMlModels`; only `ai/runtime.ts` / `ml/runtime.ts` may value-import them
  (the build greps `release/dist`); the Codex CLI (`@openai/codex`) is never imported, only run.
  ⚠ zod comes from the SAME install as the SDK, by its ESM entry.
- **pnpm is PINNED** (`packageManager: pnpm@9.15.9`); bumping it means regenerating the lockfile.

## The website (`apps/site`) and the demo

- **`apps/site`** serves limn-review.com: the prerendered landing, `/demo/` and the contact form
  (the commercial-licence path; [apps/site/README.md](apps/site/README.md)). ⚠ Its rate limit reads
  `X-Forwarded-For` from the RIGHT (`TRUST_PROXY_HOPS`). GA lives in the landing only, never the SPA.
- The landing's `<!-- seo:start/end -->` / `<!-- app:start/end -->` markers in
  `apps/landing/index.html` are load-bearing (the prerenderer throws without them).
- **The static demo** (`apps/frontend/src/demo/`, `build:demo`, base `/demo/`) is the real SPA with
  `window.fetch` answered from a RECORDING ([its README](apps/frontend/src/demo/README.md)). ⚠ A
  normal `vite build` must stay byte-for-byte free of it, and it must hold the site's CSP.
- ⚠ **EVERY USER-VISIBLE CHANGE MUST REACH THE DEMO, IN THE SAME COMMIT.** UI ships there by
  itself; DATA does not. A new route/view/tab/field, a changed shape or an unseeded feature: seed it
  (`seed-demo*.ts`, fictional Acme), visit it in `scripts/record-demo-steps.mjs` + `verify-demo.mjs`
  `VIEWS`, `pnpm demo:record`, `build:demo` + `pnpm demo:verify`, commit `recording.json`
  ([docs/DEMO.md](docs/DEMO.md) § Keeping it current). PR CI and `deploy-site.yml` run
  verify-demo (a failure blocks the deploy), but it sees only MISSING answers, never a stale shape.

## Migrations

Read [docs/MIGRATIONS.md](docs/MIGRATIONS.md) before writing ANY migration.

- **The journal is hand-maintained** (`db/migrations/meta/_journal.json`, entries `"version":
  "6"`). An unregistered file **SILENTLY SKIPS** — the boot looks fine and queries fail on a
  missing relation. Edit `schema.sqlite.ts` first; prefer hand-written additive migrations.
- Dormant tables (Pro/cloud/story-report era) are kept and still erased — never drop or
  re-declare them casually.
