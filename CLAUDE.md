# pierre-review

A **single-page dashboard for tracking a team's GitHub activity across multiple
repositories** — built for sprint situational-awareness: at a glance, who's doing what,
which PRs are stalled, which review threads sit untouched, and what needs _your_ attention.

It runs **two ways from one codebase**, selected by `DEPLOYMENT_MODE`:

- **local** (default): entirely on your machine — SQLite, no hosted backend, no stored
  credentials. Authenticates via your logged-in `gh` CLI and opens straight to the timeline.
- **cloud** (multi-tenant): a public landing page, GitHub sign-in (OAuth App and/or GitHub
  App), per-user encrypted accounts, Postgres — self-hostable on Railway.

> **How to use this file.** This is the lean operating guide: the mental model, the commands,
> and the invariants and landmines you must know BEFORE editing. Per-area depth lives in the
> topic docs below — read the matching doc before non-trivial work in its area, and put NEW
> detail there, not here. **This file has a hard size budget** (~50k); anything discoverable by
> grepping the code or reading a route/table definition does not belong in it.

## Doc map

| Doc | Read before touching |
|---|---|
| [BACKEND](docs/BACKEND.md) | startup/auth plumbing, sync internals, lean storage, branch snapshot |
| [SYNC](docs/SYNC.md) · [REALTIME-SYNC](docs/REALTIME-SYNC.md) | sync triggers/backfill · adaptive polling + webhooks |
| [DATA-MODEL](docs/DATA-MODEL.md) | any schema/table change; per-table contracts; the bot vocabulary |
| [API](docs/API.md) | any route — the per-route contract reference |
| [FRONTEND](docs/FRONTEND.md) | stores, tabs/overlays, FilterBar scoping, timeline internals, PrDetail |
| [MERGE-CI-TRUNK](docs/MERGE-CI-TRUNK.md) | merge verdict/queue, auto-merge runner, CI logs, trunk status |
| [CLAUDE-REVIEW](docs/CLAUDE-REVIEW.md) | the agentic PR-review feature |
| [BOTTLENECKS](docs/BOTTLENECKS.md) | the court ledger behind Reports -> "Chronology" |
| [ML-SEVERITY](docs/ML-SEVERITY.md) | ML severity/category of bot comments (`packages/ml`) |
| [PERIOD-REPORTING](docs/PERIOD-REPORTING.md) | window purity, coverage bias, actor lanes, the person vector |
| [PRO-PLUGIN-AND-ACTIVITY](docs/PRO-PLUGIN-AND-ACTIVITY.md) | plugin seam/apiVersion, Activity, Feed, the bot platform, annotations, digests, the work plan |
| [PRO-PLATFORM](docs/PRO-PLATFORM.md) | the Pro platform's own deep-dive |
| [SECURITY](docs/SECURITY.md) | app.ts, CORS/CSP, rate limits, GDPR, dependency posture |
| [PACKAGING](docs/PACKAGING.md) · [RELEASE](docs/RELEASE.md) | build-release, CLI, landing prerender · CI publishing |
| [MIGRATIONS](docs/MIGRATIONS.md) | any migration; dialect divergences, known gaps |
| [DEPLOY-RAILWAY](docs/DEPLOY-RAILWAY.md) · [GITHUB-AUTH-SETUP](docs/GITHUB-AUTH-SETUP.md) · [LOCAL-CLOUD-TESTING](docs/LOCAL-CLOUD-TESTING.md) · [BILLING-STRIPE](docs/BILLING-STRIPE.md) | cloud ops |

---

## Mental model (read this first)

```
 gh token / OAuth ─┐
                   ▼
   GitHub API ──► sync pipeline ──► SQLite | Postgres ──► Fastify API ──► React SPA
  (GraphQL+REST)  (every 5 min,     (local  |  cloud)    (lean /timeline,  (vis-timeline,
                   idempotent)                            detail on demand) zustand, RQ)
```

- **Sync** pulls PR activity into the DB on a 5-minute cron; fully idempotent.
- **The API** is a thin read layer; the timeline endpoint is deliberately _lean_, heavy
  detail fetched on demand.
- **The frontend** is a timeline-first dashboard: server state in React Query, UI/filter
  state in a Zustand store mirrored to the URL.

The two load-bearing concepts: **derived thread state** (below) and the **local/cloud
split** (next section).

---

## Deployment modes (local vs cloud)

One env var — **`DEPLOYMENT_MODE` = `local` (default) | `cloud`** — drives
`config.deploymentMode`, which everything branches off (`config.isCloud`, `config.dbDialect`).

| Concern | local (default) | cloud (Railway) |
|---|---|---|
| DB / schema | SQLite (`better-sqlite3`), `schema.sqlite.ts` | Postgres (`pg`), `schema.pg.ts` |
| GitHub auth | `gh auth token` (one account) | OAuth App and/or GitHub App, per-user tokens |
| Accounts | 1 synthesized `isLocal` (id 1) | one per signed-in user |
| Landing / SPA | landing never served (`/` → 302 `/app`); SPA at `/app` | landing at `/`; SPA at `/app` behind the auth gate |
| Claude Review | allowed (flag) | force-disabled (routes unregistered) |
| Sessions/OAuth | none | sealed cookie + `/api/auth/*` |
| CORS | loopback origins only | exactly `APP_BASE_URL` |
| CSP / HSTS | CSP yes (no 3rd-party origins); no HSTS | CSP + HSTS + www→apex 301 |
| Host guard | 421 on non-loopback `Host` | n/a (proxied) |
| Rate limits | keyed by the single account | keyed by accountId (IP fallback) |
| Analytics | never loaded | GA4, consent-gated |
| Account delete/export | export yes; delete 400s | both self-service |

**Dual-dialect DB (the foundation).** The query layer is written **once**, `await`-based,
against a PORTABLE async surface (mechanics: [docs/BACKEND.md](docs/BACKEND.md)):

- `db/client.ts` mode-selects driver + schema at boot and exports `db` **TYPED as
  node-postgres**, so a stray `.get()/.all()/.run()` is a compile error.
- **Portable terminals only**: `await q.execute()`, `.returning().execute()`,
  `onConflictDoUpdate`. NO `.get()/.all()/.run()`, NO `db.execute(sql)` (pg-only). "Rows
  affected" = `.returning({id}).execute().length`; raw-`sql` booleans use `= true`.
- **Transactions are the one dialect fork** — better-sqlite3 rejects async tx callbacks, so
  every transaction goes through `runTransaction`, whose blocks take the `tx` executor. The two
  schema files are **kept in sync BY HAND** (see Conventions); migrations are per-dialect.

**Multi-tenancy.** Every GitHub entity is owned by an `accounts` row. `accountId` is
**denormalized** onto the anchor tables (`repos`, `pullRequests`, `events`, `claudeReviews`,
`myTurnDismissals`, `workspaces`, `workspaceRepos`, `workspaceReviewers`, `mlCommentLabels`);
everything else reaches its account via `repoId`/`prId`, and `users` + `commitFiles` stay
**global**. GitHub-node-id uniques are **composite** so two accounts can track the same repo
(`(accountId, githubNodeId)`, `events (accountId, dedupeKey)`, child `(prId, githubNodeId)`).
Every list/feed query filters by `accountId`; every id-addressed getter scopes ownership →
null/false → 404. ⚠ Where an id arrives in a **request body**, tenancy is additionally
**STRUCTURAL** — a NAMED COMPOSITE FK against `(id, account_id)`, so the cross-account pair
fails in the database, not in whichever handler remembered to check. `verify:isolation` checks
the query-layer IDOR guarantee.

**Auth, serving & routing** — plumbing in [docs/BACKEND.md](docs/BACKEND.md), static/SPA
routing in [docs/PACKAGING.md](docs/PACKAGING.md). Tokens ALWAYS come from `auth/account.ts`'s
`getAccessToken` (local → `gh auth token`; cloud → decrypt an AES-256-GCM-sealed token).
⚠ `github/client.ts` exposes **per-account** factories and keeps **NO module-level token
cache** — the #1 cross-tenant leak risk. `cli.ts --cloud` sets `DEPLOYMENT_MODE=cloud`.

---

## Stack

- **Monorepo:** pnpm workspaces, TypeScript + ESM throughout, Node ≥20 (dev on 24).
  Workspaces: `backend`, `frontend` (SPA), `landing` (cloud marketing) + types-only `shared`.
- **Backend:** Fastify + Drizzle ORM (dual-dialect), `node-cron`, pino; cloud adds
  `@fastify/cookie` + `@fastify/secure-session`.
- **Frontend:** React + Vite + Tailwind + `vis-timeline`, Zustand, TanStack Query.
- **GitHub:** `@octokit/graphql` (one fat query per repo) + occasional REST.

---

## Repo layout

> ⚠ **"Workspace" is TWO things in this repo and they never mean each other.** A **pnpm
> workspace** is a package in this monorepo (`apps/backend`, `packages/shared`, …). A
> **Workspace** (capital W, the product noun) is a named grouping of an account's repos — the
> app's ONE scope, stored in the `workspaces` table. This section is about the former;
> everything else in this file is about the latter.

```
pierre-review/
├─ apps/
│  ├─ backend/     src/{index,app,config,cli}.ts · auth/ · db/ (schema.sqlite.ts +
│  │               schema.pg.ts parity-guarded, client.ts, queries.ts, triage.ts,
│  │               migrations/ + migrations-pg/) · github/ · merge/ · sync/ (+ its
│  │               __fixtures__/threads/) · review/ · pro/ · api/{routes,plugins}/ ·
│  │               data/ (local SQLite, gitignored)
│  ├─ frontend/    the timeline SPA (base `/app/`): App.tsx · store/{filters,pinnedTabs} ·
│  │               hooks/ · api/client.ts · components/ · lib/ui.ts (palette, mergeVerdict,
│  │               safeExternalUrl)
│  └─ landing/     public marketing page (cloud, at `/`), PRERENDERED per route at build time
└─ packages/
   ├─ shared/      types ONLY — the contract between the apps; no build output
   ├─ pro/         @pierre/pro — PRIVATE submodule, runtime-imported by PATH, never a declared
   │               dep; absent → clean OSS mode. `git submodule update --init` to fetch.
   └─ ml/          pierre-ml — submodule, the `severity-api` microservice. PYTHON, NOT a pnpm
                   workspace and NOT imported (HTTP only). Absent → ML labels are dark.
```

---

## Commands

All from the repo root unless noted.

| Command | What it does |
|---|---|
| `pnpm install` | install all workspaces |
| `pnpm dev` | backend (`:4000`) + frontend (`:5173`) + the `packages/ml` severity-api (`:8799`) |
| `pnpm dev:backend` / `dev:frontend` / `dev:ml` | run one side only |
| `pnpm build` | recursive build across workspaces |
| `pnpm typecheck` | `tsc --noEmit` across all packages — **run before considering work done** |
| `pnpm test` | recursive `vitest` (backend only; frontend/shared are no-ops) |
| `pnpm db:generate` | generate a Drizzle migration from `schema.sqlite.ts` changes |
| `pnpm db:generate:pg` | (re)generate the Postgres baseline → `migrations-pg/` |
| `pnpm db:migrate` | apply pending migrations (dialect-aware; runs on startup too) |
| `pnpm db:studio` / `db:studio:pg` | drizzle-studio against the local DB / a Postgres |
| `pnpm sync:once owner/repo` | one-off sync of one repo without starting the server |
| `pnpm --filter @pierre-review/backend verify:isolation` | query-layer cross-account IDOR check |
| `pnpm --filter @pierre/pro typecheck` | typecheck the private Pro plugin (needs the submodule) |
| `pnpm demo` | seed `acme/*` demo data + boot the ISOLATED demo stack (`:4100`/`:5273`, gh off PATH); `--free` = OSS mode, `--no-seed` reuses the DB |
| `pnpm shots` | landing-screenshot pipeline: seed → Pro shots → restart OSS → free shots → teardown |
| `pnpm package` | assemble `./release` for publishing |

`DEPLOYMENT_MODE=local` (default) vs `cloud` selects the whole stack. **`pnpm dev` also starts
the `packages/ml` severity-api when that submodule is checked out** (`PIERRE_ML_DIR`,
`SEVERITY_API_PORT`, `PIERRE_ML_DISABLED=1`); every "can't run it" path exits 0, so a clone
without `--recurse-submodules` still gets the dev loop. ⚠ It exports
`SEVERITY_API_DEFAULT_URL`, never `SEVERITY_API_URL` — `process.loadEnvFile` does NOT overwrite
an already-set variable, so a command-line `SEVERITY_API_URL` would BEAT your `.env`. Config
comes from `.env` (repo root) then `apps/backend/.env`; `DATABASE_URL` overrides the SQLite
path (local) / is the Postgres conn string (cloud). Full cloud locally:
`docs/LOCAL-CLOUD-TESTING.md`.

---

## Backend

**Boot order** (`index.ts`): (cloud) `assertCloudConfig()` → migrations → event cleanup →
(local) `ensureLocalAccount()` → `buildApp()` → `bindProPlugin()` → scheduler → listen.

### Sync pipeline (`src/sync/`)

Pulls PR activity into the DB, fully idempotent (see **Idempotency** in Conventions).
Mechanics: [docs/BACKEND.md](docs/BACKEND.md) · [docs/SYNC.md](docs/SYNC.md) ·
[docs/REALTIME-SYNC.md](docs/REALTIME-SYNC.md). The rules:

- **Adaptive polling is the PRIMARY sync strategy in BOTH modes** (`syncAdaptive` defaults
  `true`): the cron is a *tick* (`*/1`), `isDue()` gates each repo by activity bucket, and a
  30-min floor forces a re-walk (CI-finish / thread-resolve never bump `updatedAt`). ⚠ **An
  explicitly-set `SYNC_CRON` wins** — pinning `*/5` silently negates the hot bucket.
- **Webhooks are ADDITIVE, cloud-only**, and need all three of the secret env var, event
  subscriptions and the App installed — or they silently deliver nothing.
- **A VIEWED PR gets its own live cadence** — the SPA polls `POST /api/prs/:id/refresh` every
  ~5s while the pane is open+visible (`sync/refresh-pr.ts`): probe-gated, 30s forced-walk floor,
  failed walks remembered (`lastWalkOk` — later 304s must not report `synced:true`). ⚠ Never
  route it through `enqueuePrSync` (the debounce swallows the cadence) and never default the
  poll to `waitForInFlight`.
- First sync of a repo is **two-phase**: a fast ~14-day foreground pass, then the deep 90-day
  backfill in background. Cloud skips accounts idle > 15 min; local is always-on.
- **GitHub rate limits are PRE-EMPTED, never surfaced as errors** — loops wait on the
  per-account budget in cancellable ≤1s slices and a waiting repo reports `paused:{…}` (red is
  for unrecoverable failures only). ⚠ Do NOT widen `isRetryableGithubError` to cover them — a
  test pins its 403/429 exclusion. ⚠ Every synchronous
  `running`/`queuedRepos`/`deepSyncing` add must be released on EVERY bail path INCLUDING
  thrown lookups. ⚠ `noteBudget` must NOT clear `limitedUntil`.
- **Lean storage** (default both modes): PR description, review-comment `diffHunk`, commit
  `message` and `checkRuns` JSON are neither persisted nor fetched — hydrated on demand
  (`sync/hydrate-detail.ts`). **Comment + review bodies are ALWAYS persisted**
  (`PERSIST_BODIES=true` stores all).
- The **default-branch snapshot** ending every repo sync is **STRICTLY NON-FATAL** and
  two-phase for GraphQL-cost reasons — read the cost analysis in the doc before restructuring
  it; `contexts(first:100)` must NOT be lowered.
- **A completed FULL walk tail-runs the one-time CI-history backfill**
  (`CI_HISTORY_BACKFILL=false` disables). ⚠ A PR's CI log is touched ONLY when provably its
  first-observation snapshot — never real observed history.

### Derived thread state — the heart of the app

`derive-thread-state.ts` classifies each review thread during sync, stored on
`reviewThreads.derivedState`:

| State | Meaning |
|---|---|
| `resolved` | marked resolved on GitHub |
| `likely_addressed` | a commit touched the thread's file _after_ the last comment — **a heuristic** |
| `replied_unresolved` | replied, but unresolved and no later commit touched the file |
| `untouched` | no reply, no follow-up commit |

`likely_addressed` is intentionally fuzzy (unrelated edits, renames) and the UI must keep
communicating that uncertainty.

### Data model

`db/schema.sqlite.ts` + `schema.pg.ts` are authoritative (29 tables). **Per-table contracts and
the automation vocabulary (`ReviewerRole` — SIX members, EXACTLY ONE of which, `'review'`, is
the reviewer cohort · `AutomatedReviewerKind` · `AUTOMATION_VENDORS`, the ONE table every
per-family login set is DERIVED from · `REVIEW_BOT_KINDS`) live in
[docs/DATA-MODEL.md](docs/DATA-MODEL.md)** — read it before any schema or bot-classification
work. Without opening it:

- **`users` + `commitFiles` are GLOBAL** (`accountId` is denormalized onto the anchor tables
  listed under **Deployment modes**) — never hand a tenant the raw global table.
- Timestamps are unix-epoch ints (sqlite) / `timestamptz` (pg), both read as `Date`. GitHub
  node ids are the identity. Triage fields are computed on read, never stored.
- **`workspaces` + `workspaceRepos` are the app's ONE scope** — a repo is in EXACTLY ONE
  workspace, assignment is an upsert = a MOVE, and the one `isDefault` row per account is
  enforced by a partial unique index in the `.sql` migrations (drizzle index predicates are
  inert metadata). ⚠ A repo with NO membership row is invisible to every workspace-scoped read,
  so `ensureRepoMemberships`' insert MUST keep `ON CONFLICT … DO NOTHING`.
- **`workspaceReviewers` is THE BOT OBJECT** — one row per
  `(accountId, workspaceId, authorUserId)` carrying judgement, identity and price as three
  independently-owned facts (`monthlyCents` INTEGER CENTS; one writer, `setReviewerCost`;
  per_seat multiplies on READ, never stored). Price is per WORKSPACE — **never sum cost across
  workspaces**; clearing is a column write, never a row delete. ⚠ `deleteWorkspace` re-homes
  that workspace's repos AND its `workspace_reviewers` rows to Default BEFORE deleting, or the
  cascade destroys manual verdicts and prices.
- ⚠ Five more rules have their own headings in the doc, each of which has cost a real bug:
  `schema-parity.test.ts` **compares COLUMNS ONLY** (diff `foreignKey({...})` blocks by eye);
  every reviewer-cohort test is **`=== 'review'`, never `!== 'quality_check'`**; **the STORED
  role/kind beats the login seed on read**, and `ReviewBotKind` must NEVER absorb the
  non-reviewer brands; **`getBenchmarkContributions` filters with an ALLOW-list, never a
  deny-list** (its rows LEAVE THE TENANT); **`vendorKindsForRole` always includes the STORED
  kind**, and the role write sits behind an explicit "Apply role" button.
- **`repos.createdAt` is LOAD-BEARING** — My Turn's per-repo "New PRs" cutoff, and the only
  visibility axis. `branchCommits` is NOT derivable from `commits` (PR-scoped; a squash-merged
  PR never appears there under the SHA that landed on trunk). `autoMergeRequests` is state, not
  a log — unique `(accountId, prId)`, re-arm overwrites, disarm DELETEs.

### HTTP API

JSON wire, ISO-8601 timestamps; payload types in `packages/shared`; one file per resource in
`api/routes/`, each mapping to a `client.ts` method. **Consult [docs/API.md](docs/API.md)
before changing any route's shape.** Everywhere:

- **`?workspace=<integer>` is THE scope parameter.** Absent / unknown / unparseable / another
  tenant's id ⇒ the account's DEFAULT workspace — **never a 404** (no existence oracle). Every
  scoped response echoes `workspaceId`. `?repoIds=` survives as data narrowing ONLY, bounded by
  `resolveWorkspaceScope` (`membership ∩ narrow`) — one resolver, not a convention 14 handlers
  must remember.
- Client side: send `repoIds` whenever the array exists — **including when empty** (`if (ids)`,
  never `ids.length > 0`; an empty workspace must not widen to the whole account); every scoped
  React Query key carries a `ws:<id>` segment.
- Cloud gate: every `/api/*` 401s unauthenticated except `/api/health` + `/api/auth/*`.
- ⚠ **`GET /api/feed` and `GET /api/workspace-metrics/compare` are DELETED** — do not
  reintroduce either. `getFeed` STAYS, called internally by the scoped
  `GET /api/activity/feed`; cross-workspace comparison is the Reports "By workspace" axis, on
  the `search` tier because its cost multiplies by workspace count (as does
  `GET /api/daily-brief`).

---

## Product voice — PLAIN ENGLISH, AND AS LITTLE OF IT AS POSSIBLE

**Every user-facing string in this product is written in plain English, and the shortest honest
version wins.** This governs the SPA, the landing page, and the strings the plugin templates and
sends over the wire — a sentence composed server-side lands on the same screen as one written in
a component, and the reader cannot tell them apart.

- **NAME THE THING.** "CodeRabbit", not "the same product". "Similar-sized repos", not "the
  cohort". "Comments your team used", not "acted-on threads". If a term needs the reader to know
  how the fold works, it is the wrong term — the Benchmark tab shipped with *corpus*, *fitted*,
  *percentile*, *activity band* and *settled threads* on one screen and a reader reported that
  they could not tell what was being compared.
- **STATE THE FACT AND STOP.** Do not explain what you cannot know, do not label your own
  confidence, do not pre-empt the reader's reasoning. The blocked-PR row shipped with a preamble
  about what GitHub does and does not tell us, a PROVEN/INFERRED chip on every row, and a note
  under each explaining the hedge — three layers of scaffolding around one short true sentence.
  It now prints the facts. ⚠ The certainty is still COMPUTED and still ORDERS the list; what was
  removed is the narration, not the rigour.
- **A NUMBER IS NOT A DISCLOSURE.** Round it (`94.6097%` is noise past the units digit), and give
  it a denominator a reader can check. But a caveat nobody asked for is verbiage: prefer a figure
  that needs no caveat to a figure wearing one.
- **THE HONESTY RULES ARE NOT NEGOTIABLE, AND ARE NOT AN EXCUSE FOR LENGTH.** Everything under
  *Period reporting*, *Chronology* and *The peer benchmark* about labelling populations apart and
  refusing rather than guessing still holds — those exist so the app does not assert what it
  cannot back. Meet them in fewer words; never by adding a paragraph of hedging.
- **SMALL TEXT IS NOT FREE.** 8-10px uppercase-with-tracking is the least legible setting there
  is. 11px is the floor for a label, 12px for a sentence, and contrast is enforced from source by
  `apps/frontend/test/textContrast.test.ts` + `vendorInk.test.ts` (see **Colour and contrast**
  under *Conventions*).

## Frontend

Four deliberately-separated state layers: **server state** in TanStack Query (PR/thread detail
on demand, IndexedDB-persisted at `staleTime: Infinity`), **filter/selection** in Zustand
`store/filters.ts` (`workspaceId` is the scope), **tabs** in `store/pinnedTabs.ts` (exactly one
board mounts at a time), **URL** mirrored by `useUrlState.ts` (serializer diffs against
defaults). App lands on the Activity FEED; the Insights rail entry is labelled **"Reports"**
(LABEL-ONLY — the store/URL value stays `'insights'`). Cloud renders `<SignInGate>` on a 401.

Landmines that cost real bugs — read [docs/FRONTEND.md](docs/FRONTEND.md) before touching any:

- **Bots are HIDDEN by default on Timeline AND Feed**, using the UNION set `hiddenBotUserIds`
  (`users.isBot` ∪ the workspace's automated reviewers; a manual "human" judgement wins BOTH
  directions); the Feed lens `'hide'` rides the SERVER's `excludeBots`, excluded before the page
  cap. ⚠ `useSearchTimeline` and `rosterTimelineSearch` always send `excludeBots=false` — the
  Members dropdown's bot listing depends on it.
- **`workspaceId === null` means "not resolved yet"** — nothing may render workspace-scoped data
  while null, and `?workspace=` is omitted while null (an unconditional `p.set` writes the
  literal `?workspace=null` on every bare load).
- **`useWorkspaceSync` is three-branch** (null-or-dead / changed / **PRUNE ONLY**) — it must
  NOT keep `repoIds` in lockstep with workspace membership. Track the previous id in a ref; a
  write-only-if-different guard is not sufficient (React Query result identity changes on every
  background refetch).
- ⚠ Legacy `?team=<int>` with no `?workspace` IS the workspace id; any other `?team=` form
  discards `?repos=` too (the trap is in [docs/FRONTEND.md](docs/FRONTEND.md)). `repoIds` is
  always pruned to the resolved workspace's membership before any query runs.
- **`workspaceId` must NOT live in `FilterDefaults`** (it has its own slice) — persistence and
  reset share one list, so "Clear filters" would teleport the user into Default.
- **The repo picker (`RepoSelectPanel`) is Timeline-ONLY.** Activity, Feed, Bots and Reports
  always cover every repo in the workspace — never let the picker scope a screen that doesn't
  render it.
- **The Feed is a STREAM: `BriefStrip` → `BranchStatusPanel` → `FeedView`, and nothing else.** Two
  survey panels were removed from above it — the work plan (now the Pending head) and the
  flow-metric header (now `WorkspaceFlowMetrics` on Reports). Do not re-add either. ⚠ **The Reports
  rail entry is UNGATED on every tier** precisely because those free metrics live there now; the
  pane gates its Pro half internally — `PeriodReportsPanel`, Track usage, **and now the Chronology
  sub-tab**, each as a visible-but-locked pane. The same rule holds on the **Bots** rail: the entry
  and the sub-tab strip stay open on every tier (it owns the free Settings/classification screen),
  and the `roi` and `benchmark` BODIES lock. ⚠ **A gated sub-tab must still be SELECTABLE** — `effectiveInsightsTab`
  normalises an out-of-union value and nothing else, never a capability fallback, or an unentitled
  `?insightsTab=bottlenecks` from a bookmark silently lands on Overview explaining nothing.
- **"Where the work is happening" is TWO CHARTS under Flow metrics, never one blended score**
  (`WorkspaceRepoActivityCharts`, riding `repoActivity` on the SAME free `/api/workspace-metrics`
  response): PRs opened per repo, STACKED people vs automation, beside lines changed, same order in
  both. A normalised activity index is "a number no PR resembles" one more time; a GROUPED chart is
  separately broken because `BarChart`'s `niceMax` gives both series ONE y-axis. ⚠ It mounts in
  `WorkspaceFlowMetrics`, **never inside `WorkspaceMetricsPanel`** — that panel ALSO mounts per-repo
  behind a Pro gate, where a per-repo breakdown is one bar for paying accounts only. ⚠ Its window is
  a rolling 14 days (`INSIGHT_SPRINT_DAYS`) and CANNOT be the sprint cadence (plugin-owned, this is
  free) — a THIRD window on that panel, so it says so. ⚠ **Unknown size is not zero size**
  (`linesChanged: null`, never a fabricated 0 — and `BarChart` drops every `v <= 0`, so the unsized
  COUNT must be disclosed in words); a repo added mid-window is MARKED, never pro-rated; the top-12
  cap states what it cut on BOTH axes.
- **Pending cards carry MERGE-RELATED ACTIONS, on the two FORWARD kinds only** (`merge`,
  `update_branch`) - Merge, Merge-when-ready, Cancel, Update branch. ⚠ **NOTHING ON THE BOARD
  MAY FETCH ON MOUNT**: `MergeWhenReadyControl` fetches merge-options EAGERLY (~3 GitHub calls per
  PR), so fifty cards would be 150 calls to paint a board. The buttons gate on the card's OWN
  synced `mergeStateStatus`/`mergeable`/`viewerCanPush` through `mergeVerdict()`, and the live
  fetch is CLICK-GATED. `viewerCanPush` rides the card for the same reason; it is a VISIBILITY
  gate only - the merge route re-checks permission, head oid and live merge state. HIDE, never
  disable. Mid-merge is THREE layers on one row: a live manual merge (read off the SHARED
  `mergePrMutationKey`/`updateBranchMutationKey` via `useIsMutating`, never a per-mount
  `isPending`), then the armed intent's `armedPhaseHeadline`, then the synced verdict.
- **The board's freshness against GITHUB is ONE batched sweep, `POST /api/attention/liveness`** —
  the sanctioned alternative to per-card fetching, not an exception to it. It sends the board's PR
  ids and re-reads them in one `nodes(ids:)` call (2 GraphQL points, ~5-7s). ⚠ **MEASURED: 90 ids
  answer in ~1.4s for scalars, but adding `mergeable`/`mergeStateStatus` 502s at 50 ids** - GitHub
  computes mergeability on demand, so that half is a RANKED subset capped at 25 (forward cards
  first). ⚠ An observed `unknown` never demotes a known merge state, or the sweep flip-flops
  forever. ⚠ **IT RETURNS COUNTS, NEVER CARDS**: `changed > 0` means REFETCH `['attention-cards']`
  + `['daily-brief']` (+ `['work-plan']`) together - a local splice kills `capFor`'s
  `shown === count` guard and the "50 of 148" disclosure with it. Those same three keys are the
  ONLY ones that opt out of the app-wide `refetchOnWindowFocus: false`, and they do it TOGETHER.
- **`InsightPrRef.authorIsBot`/`authorBotKind` say who opened a PR**, built in the ONE `prRef`
  builder. WARN The resolution is NOT the login: a manual workspace judgement wins BOTH
  directions, then `users.isBot`, then the login seeds a vendor - the same resolution the
  bot-hiding union uses, never a second classifier that can disagree with the Timeline. WARN
  `authorIsBot: true` with a NULL kind is a real, common state (an unbranded CI account) and
  renders a generic "Bot"; a bot chip on a person is a false claim about a human, so only bots
  are badged.
- **The Pending board is `head ∪ tail === cards`, DISJOINT** — `GET /api/attention`'s `doNextIds`
  is the ranked "Do next" head as CARD ids (free on every tier; only its NARRATION is Pro), and the
  board renders ONE list with a divider. The head is a **RE-ORDERING, never a filter**: every cap
  disclosure gates on `shown === count`, so a partition that dropped a card — including a tail row
  whose PR is already in the head, which is MARKED rather than removed — kills "50 of 148" with no
  error. The head is suppressed under an ISOLATION only (an isolated board is single-kind), never
  under the relevance lens, so `headCount === 0` is the common case and the divider needs both
  bounds (`> 0 && < cards.length`). ⚠ "Pending" is a LABEL-ONLY rename of "Needs attention" — the
  store/URL literal stays `'attention'`.
- **A surface that NOTIFIES counts `myTurnPersonal`; a surface you OPEN counts `myTurn`** (banner,
  Workspace badges, "Elsewhere" rows, browser notification vs the Pending board). ⚠ A
  narrow count may only navigate through ITS OWN lens — `attentionRelevance` is THREE-VALUED
  (`'mine'` = direct + maintained = the retired `personal`; `'others'` = `relevance === 'none'`;
  `null` = everything), and every entry point SEATS its value, `null` included, because
  `setActivityRepo` early-returns `{}` on an unchanged rail. ⚠ Pair narrow with narrow in the cap
  disclosure (`myTurnPersonalCapDisclosure` / `myTurnOtherCapDisclosure`), or the "+" silently
  vanishes — and **`myTurnOther` is never `myTurn - myTurnPersonal`** (a subtraction has no
  denominator, so `capFor`'s `shown === count` guard drops the disclosure).
- **`MyTurnCard.relevance` writes THREE card labels** — `'direct'` → "Your turn", `'maintained'` →
  "In your repos" (orbit, not ownership), `'none'` → the neutral kind label. ⚠ An ABSENT
  `relevance` renders the NEUTRAL label even when `personal === true`: a missing field may never
  invent an ownership claim on screen. ⚠ `?attnPersonal=1` is retired but still PARSED (as
  `'mine'`) — it shipped, so it is in bookmarks and in history entries Back replays; `?attnRel=` is
  the only key emitted.
- **THE PENDING MUTE RIDES `relevance`, ONCE, SERVER-SIDE** (CORE/free, both modes; migration
  `0058`/pg `0045` — `workspaces.pending_muted` + `pending_muted_repos`, read via
  `db/pending-mute.ts`, written by `PUT /api/workspaces/:id/pending-mute`, edited in Settings →
  Workspace). A muted repo's my_turn rows are forced to `relevance: 'none'` inside **`getMyTurn`**,
  at the one fold where `personal` is derived — so the card relabels, the browser notification
  stops, `myTurnPersonal` drops it and the broad `myTurn` population is UNTOUCHED, with no second
  predicate anywhere. ⚠ **TWO INDEPENDENT FACTS, OR-ed, NEVER A CHAIN** (workspace switch ∪ named
  repos); `pending_muted_repos` carries no `workspace_id`, so the write MUST scope its delete to
  the named workspace's membership or a Save clears every other workspace's mutes. ⚠ It is **NOT**
  the `repos.inbox_watch` axis `0046` dropped: no screen's population changes — a muted repo is
  fully live everywhere — only whether a row may CLAIM YOUR TURN and interrupt you. ⚠ It applies in
  the UNSCOPED `getMyTurn` too, because the notification watcher reads exactly that. ⚠ It reaches
  `my_turn` ONLY — the two FORWARD kinds carry `relevance` for the ranker weight and the severity
  accent, not as an ownership claim. ⚠ `muted` is DISPLAY ONLY: no counter, lens or ranker may read
  it. ⚠ A muted item DOES rank lower in "Do next" (`RELEVANCE_WEIGHT`) — accepted and pinned, not
  emergent. ⚠ It is also why the Settings **Workspace heading is no longer Pro-gated**: a free
  workspace section must never sit below the `/api/pro/settings` gate, which 404s with no plugin.
- **Visible sub-tabs are DERIVED, never written back** (`feedInnerTab`, `botsInnerTab`,
  `insightsTab` — Reports' Overview/Bottlenecks) —
  compute an `effectiveTab` for the render only; a corrective `set…` permanently forgets the
  choice.
- **Timeline vertical scroll is GATED.** Every programmatic scroll goes through
  `setVisScrollTop` and must claim the gate (`intentionalScrollRef` + `scrollLoopRef`) — never
  write `scrollTop` / call `focus()` from a new path; copy `centerShowTarget`.
- `threadStateFilter` is a GLOBAL store field — PrDetail applies it only when
  `selectedPrId === prId`, or a PR opened via tab inherits a stale preset.
- `UserName`'s returned tree SHAPE must not depend on popover-open state — React remounts the
  anchor and the popover lands in the top-left corner.
- **EVERY RENDERED ICON IS A COMPONENT IN `components/Icons.tsx`** — the SPA ships no icon library
  and no icon emoji. An emoji paints its own colour (so it cannot be dimmed, hovered or themed), a
  glyph's metrics are a font lookup, and neither can be sized. ⚠ **What stayed a character is a
  DECISION, listed at the bottom of that file's header**: regex matchers against vendor comment
  bodies (`sync/review-fingerprint.ts`, `bot-resolution-markers.ts`, the bot-theme classifiers —
  changing one silently breaks bot classification), `Activity/periodReportMarkdown.ts` (a markdown
  export with no DOM), the backend CLI, prose arrows, and anything inside a `title=`/`aria-label=`
  string, which cannot hold an SVG and was REWORDED instead. ⚠ `▾` is TWO controls: `CaretIcon`
  (solid) for a menu trigger, `ChevronIcon` for an expand/collapse — decide by what the click does.
  `lib/ui.ts` is `.ts` and cannot hold JSX, so `CHECK_STATE_META.icon` is a component REFERENCE
  rendered `<m.icon />`.
- **The AI surface has EIGHT `--ai-*` semantic tokens**, whose channels must stay
  SPACE-SEPARATED (any other format silently breaks Tailwind's `<alpha-value>`);
  `--ai-signal-fill` is NON-TEXT ONLY. ⚠ **Every surviving `violet-`/`purple-`/`indigo-` hit
  is a deliberate KEEP** — do not "finish the migration"; keep-list in the doc.
- **The Insights chat is multi-turn and the cap is SERVER-side.** ⚠ **The completed turn is
  appended in `useSprintChat`'s HOOK-level `onSuccess`, never a `mutate()` callback** (observer
  teardown kills mutate-scoped callbacks, losing a billed answer). ⚠ The chart pass gets the
  grounding MINUS `conversation`, or prior model prose launders hallucinated figures into data.
- **The Changes tab's thread fold is RENAME-AWARE**: `indexThreadsByPath` is built ONCE per PR
  (never a per-row filter), keys on the RENDERED path and re-homes a pre-rename thread onto the
  file's current path; a thread anchoring to no row degrades to a FILE-level chip. ⚠ The BLOCK
  owns the `consumedFocus` ref, not the pill (the target is STICKY, so a remount re-opens a
  pill the user closed).
- **Sync-round state is a transient store slice** (`syncRound` + `managerOpen`) with ONE
  driver, `SyncStatus`. ⚠ The signal mailbox is an ARRAY, never a scalar (React 18 batches a
  multi-add loop into ONE effect run); an open round's EMPTY `scopeIds` is the all-repos
  sentinel — never append to it; merging into an open round must re-arm `syncing:true`.
- **There is ONE bottom-right toast column** (App.tsx) — never add another independent
  `fixed bottom-4 right-4` element. Its `GlobalLoadingBar` covers HEAVY work only: full-mode
  walks + ML scoring strictly under `isMlScoring`.
- **Reactions are fetched ON DEMAND and NEVER STORED** — no column, no migration, no sync step;
  `useReactions` MICROTASK-BATCHES every bar's registration into ONE
  `POST /api/reactions/lookup`. The bar renders nothing while state is `undefined` (unknown ≠
  "no reactions"), the toggle carries a per-target MUTATION key, and these queries stay OUT of
  `shouldDehydrateQuery`.
- **The Feed's "CI failures" control is a THREE-state lens defaulting to OFF** (`feedCiLens`:
  `'off'` → `'feed'` → `'only'`). **Never ship an include-only toggle whose only feedback is a
  count.** ⚠ **The OMITTED URL value must always track the CURRENT default, and a default flip
  on a key persisted UNCONDITIONALLY needs a `FILTER_STORAGE_VERSION` bump.**
  ⚠ `migratePersistedFilters` steps CHAIN — a v2 blob must land at v4, and a per-step early
  return strands it where the version check discards the whole blob.

---

## Merge, CI logs & trunk status (CORE, no AI)

Full detail: [docs/MERGE-CI-TRUNK.md](docs/MERGE-CI-TRUNK.md). The invariants:

- **Every "can this land?" surface resolves through the pure `mergeVerdict()`** (`lib/ui.ts`).
  GitHub's `mergeable` reports ONLY conflict state; `mergeStateStatus` is the protection-aware
  field to lead with. ⚠ **`unstable` IS mergeable** (only non-required checks are red); `behind`
  is not (GitHub 405s). `db/triage.ts`'s `READY_MERGE_STATES` and `mergeVerdict`'s `canMerge`
  must agree, or the triage queue and the PR disagree.
- **`blocked` is the ONE verdict GitHub refuses to explain, so it is the ONE that carries a
  ranked `blockers[]`** (`deriveMergeBlockers`, PR-DETAIL ONLY — the Pending board's cards carry
  no review status and must not fetch to find out). ⚠ **EVERY ENTRY IS MARKED `proven` OR
  `inferred`, and only `reviewDecision` can be proven** — nothing else on GitHub's payload names
  a rule, and `branchProtectionRule` is ADMIN-ONLY (its null is indistinguishable from "you may
  not look", so it is deliberately NOT synced). ⚠ **NEVER ASSERT UNRESOLVED THREADS ARE THE
  BLOCKER**: only 89 of 572 blocked PRs have any. ⚠ The blocker count is `!isResolved` and
  INCLUDES `likely_addressed`, so it is a THIRD population next to the Bots chips' "need a look"
  and triage's `untouched` — each names itself on screen. ⚠ `approved` REMOVES a row, never adds
  one (the predecessor asserted "required checks aren’t passing" on green-CI PRs).
  [docs/MERGE-CI-TRUNK.md](docs/MERGE-CI-TRUNK.md) § Why a blocked PR is blocked.
- The merge queue is GraphQL-only (presence is not inferable from REST) and nothing is synced —
  state rides the lazy `GET …/merge-options` fetch.
- **Auto-merge ("merge when ready", `merge/auto-merge-runner.ts`) is consent-anchored.** It
  deliberately does NOT use GitHub's `enablePullRequestAutoMerge` (422s on exactly the PRs it
  exists for). Arming pins `expectedHeadOid` — consent to merge THE CODE THE USER SAW;
  a head move disarms unless proven to be our own update-merge, with a compare-and-set and a
  write-permission re-check at LAND time. ⚠ **`behindBy > 0` is true of most healthy PRs** —
  only `mergeStateStatus === 'behind'` means GitHub is blocking, so never gate Merge on
  `behindBy`. Exactly ONE UI path arms (`MergeWhenReadyControl`), always storing a real
  `updateStrategy`. Merge-queue repos arm the same way with a head-pinned ENQUEUE — freshen
  once BEFORE the first enqueue, never while queued; disarm with `enqueuedAt` set also dequeues
  (cancel must win).
- **A repo's armed intents land ONE AT A TIME** (`db/merge-queue.ts`): one slot per
  `(accountId, repoId)` in `armedAt` order, the rest at phase `queued_local`. ⚠ **RULES 1–4 STILL
  RUN FOR EVERY INTENT** — only freshen/enqueue/merge is gated, or a queued intent whose PR was
  closed sits unresolved for hours. ⚠ **`queued_local` ≠ `queued`** (GitHub's merge queue), and
  `viaMergeQueue` intents are excluded from the local queue entirely. ⚠ **`freshenedIntents` is
  once per TURN, not per lifetime** — a landing clears its repo-siblings' marks, or a batch
  strands itself at "behind" until the 72h expiry.
- CI logs are live ranged reads of the signed Actions blob URL — server-side only, **NEVER
  returned to a client** (it is unauthenticated).
- Trunk status (`/api/branch-status`) is **informational only** — no attention counts, badges
  or My Turn. Its detail columns follow the partial-response write policy (Conventions); the
  commit→PR map keys on `(repoId, number)`.

---

## Claude Review + the Pro plugin

**Claude Review** (agentic PR review, `src/review/`): opt-in, **LOCAL-ONLY**
(`ENABLE_CLAUDE_REVIEW=true`; force-disabled in cloud — the routes are not even registered).
Details: [docs/CLAUDE-REVIEW.md](docs/CLAUDE-REVIEW.md). Non-negotiables: the agent's tools are
read-only with **`Bash` denied outright**, and **no AI SDK ships in npm** — every AI module is
reached only via dynamic `await import()`, and `build-release.mjs` asserts none leak into the
release manifest. ⚠ **Its credential ladder is TWO RUNGS and there is NO stored key**: an ambient
Claude session (preferred — the run STRIPS `ANTHROPIC_API_KEY` so a subscription pays instead of a
meter), else the environment's `ANTHROPIC_API_KEY`, untouched. The BYO key in
`~/.pierre-review/config.json`, its Settings form, `GET`/`PUT /api/claude-review/key` and
`ReviewSeam.setLocalKey` are RETIRED — an already-stored value is left on disk and never read, and
`review/local-settings.ts` survives only for the still-live per-review BUDGET.

**Pro plugin** (`@pierre/pro`): a PRIVATE git submodule at `packages/pro`
(`git submodule update --init`); all premium logic lives there. The public repo holds only the
contract (`src/pro/contract.ts`), a **path-based** guarded import (`src/pro/bind.ts` — NEVER a
`package.json` dependency; absent submodule ⇒ clean OSS no-op), the capability passthrough on
`/api/me`, and inert seams. Details:
[docs/PRO-PLUGIN-AND-ACTIVITY.md](docs/PRO-PLUGIN-AND-ACTIVITY.md) +
[docs/PRO-PLATFORM.md](docs/PRO-PLATFORM.md). What bites:

- **`apiVersion` is 21 and FOUR literals must agree**: host `contract.ts`, plugin `index.ts`,
  plugin `contract-types.ts`, and `bind.ts`'s runtime gate — **the actual enforcer**. A
  half-bump silently degrades the ENTIRE plugin to OSS mode: capabilities dark, every
  `/api/pro/*` 404, nothing thrown. No test pins it; detection is `tsc` + a boot check of
  `/api/me`. ⚠ **The plugin half lives in a SUBMODULE, so "all four" spans two repos** — the
  gitlink must point at a plugin commit carrying the same number. ⚠ **"Additive" is a NARROW
  test**: a TRAILING optional parameter, optional field or new union member can stay put; a
  SPA↔plugin WIRE type is not `ProContext` at all.
- **A stale `packages/pro/dist` shadows `src` in dev.** `bind.ts` prefers `src/index.ts` outside
  production and LOGS the entry it bound — check that first when a Pro route unexpectedly 404s.
- `ctx.schema` is `Record<string, any>` — a leftover `ctx.schema.teams` type-checks and throws
  only when the query runs. Grep, don't trust the compiler.
- Tiers — **free gets the per-PR truth, paid gets the cross-team roll-up**: **core** is free and
  AI-free (feed/timeline/My Turn, per-COMMENT ML severity badges, Settings classification, the
  bot-only caution + `TuningSuggestions`, the daily-brief COUNTS strip, the `BotTriageCard` grade);
  **pro** adds `botDepth` (NON-AI depth **and the WHOLE Bots → ROI panel** — vendor table,
  keep/tune/noisy verdicts, the Inflation column *counts included*, ML flagging, volume, seat
  prices), `activityDigest`, and `periodReports` (period reports + by-workspace axis + the People
  report + **Chronology**); **pro+** is AI Analysis + AI Fix + Claude Review, on the ONE flag
  `PRO_ADVANCED_AI_ENABLED`.
- ⚠ **Those last SIX surfaces are VISIBLE-BUT-LOCKED, reversing the app's "absent, never upsold"
  posture** (Chronology, period reports, the People report, the by-workspace axis, the ROI panel,
  and the Bots → **Benchmark** tab): tab listed, `ProBadge` on it, body renders `ProLockPanel` — all
  from `components/ProGate.tsx`
  (badge + lock + `useProGateState`; nothing hand-rolls a vermilion chip). Scoped to those six — a
  seventh needs its own argument, written down where ProGate.tsx keeps the other six.
  **Every one is server-enforced with a 402** (a client gate is not a monetisation gate) **and
  every hook reaching a gated route ANDs the capability into its own `enabled`**, or the SPA polls
  a 402. ⚠ Local/OSS is gated too — `entitledProCapabilities` short-circuits on `isLocal` to
  whatever the plugin published, so a flag-less `pnpm dev` with the submodule shows all five
  LOCKED; `PRO_DIGEST_ENABLED=true` is the fully-entitled dev run (`pnpm demo` sets it).
- **Generation is cost-gated everywhere** — every gate is a bill somebody paid: the
  payload-hash cache (⚠ **the hash must zero `Date.now()`-derived fields**, or a dormant scope
  re-bills on a timer); a per-account in-flight slot **claimed SYNCHRONOUSLY, with the credit
  check INSIDE the try/finally** (an `await` in that gap lets two POSTs both bill);
  min-intervals armed on BILLED runs only; credit metering (`AI_CREDITS_PER_USD` = 1250,
  inlined in `shared/types.ts` + `db/credits.ts`).
- ⚠ **A hydrated or derived value must NEVER enter a payload hash.** The free cached-read GET
  recomputes every stored row's hash on a path that hydrates nothing, so a hydrated field
  makes the GET and the run disagree forever — every judgement permanently `stale`, re-billed
  on every click. Both writers of a shared row must hash the SAME fields (the ONE exported
  `addressedThreadPayloadHash` / `addressedWindowFor`), and a GitHub fetch belongs INSIDE the
  batch loop AFTER the hash-cache filter.
- ⚠ **The evidence window's base anchors on the thread's ROOT comment, never its last** —
  last-comment anchoring collapses it to `base === head` exactly when the fix WORKED. A
  RESOLVED thread is still judged: resolving is a click, not evidence.
- ⚠ **The D4 digit gate rejects UNICODE numerals, not `[0-9]`** — the synthesis prompt's input
  is attacker-authored. It is `/^[^\p{Nd}\p{No}\p{Nl}]*$/u`; spelled-out counts stay a
  prompt-only rule.
- ⚠ **A model-derived figure and a code-derived figure must be LABELLED APART** in a panel that
  mixes them.
- **AI Fix has FOUR seeds** (`AiFixSeed`); ⚠ the newest, `'comments'`, WIDENS the
  attacker-authored channel to every comment dragged in (fencing is the mitigation) and must
  never get its own queue/slot — the worktree is keyed on the SHA alone.
- **Bot Tuning Advisor** (Pro, `botAdvisor`): CORE computes the evidence cells, the PLUGIN
  emits. Non-negotiables — recommendation text is TEMPLATED, never model-generated (the ONE LLM
  touchpoint sits behind a diff-guard `llm-isolation.test.ts` pins unreachable); **a cell with
  ANY acted-on high-severity finding never earns a full suppress**; **a suppression needs ≥1
  untouched thread on a PR that has since MERGED**; nothing it computes may feed `botVerdict`.
- **The peer benchmark** (`GET /api/pro/bot-benchmark`, Pro on `botDepth`, apiVersion stays 21): the
  COHORT half of "how does our bot compare" — per-(vendor × activity band) distributions fitted in
  `packages/ml` and BUNDLED at `packages/pro/data/benchmark/benchmark-fit.json`, resolved as a
  SIBLING of `src`/`dist` (the `../migrations` precedent; a `./data/` path breaks in dev).
  Deterministic; **no `?workspace=` and no `workspaceId` echo** because nothing about the caller
  reaches the response. Contract in
  [docs/PRO-PLUGIN-AND-ACTIVITY.md](docs/PRO-PLUGIN-AND-ACTIVITY.md) § The peer benchmark. What
  bites: ⚠ **refusals are the PRODUCT** — the bundled corpus is now REAL (2,204 repos, fit v2:
  43 fitted cells over 7 vendors, 415 fitted metric-cells) but 2 cells and 170 metric-cells still
  refuse on `cell_floor`, and severity/category are absent entirely because the corpus is UNSCORED;
  never normalise one into a distribution shape (`{quantiles: null}`, `nRepos: 0`, `grid: []`); ⚠
  **staleness is RECOMPUTED per request**, the stored age decays on disk; ⚠ `metricSpecs` ships in
  FULL because **the app's columns are NOT the cohort's** (`actedOnPct` folds in `likely_addressed`
  and divides by every thread; `acted_on_rate` divides by SETTLED ones) — and the SPA renders
  display labels only, never a re-typed definition; ⚠ `?cells=` caps at 24 and
  **400s over-cap, never truncates**; ⚠ `build-release.mjs` must copy `data` or the failure is
  PRODUCTION-ONLY and silent; ⚠ a refresh is a THREE-repo motion (`fit.py --publish` → commit in the
  submodule → **move the gitlink**). Its SIBLING `GET /api/pro/bot-benchmark/placement` places the
  CUSTOMER (workspace-scoped, echoes `workspaceId`); the SPA half is **Bots → Benchmark**, the SIXTH
  visible-but-locked surface — ONE fetch on mount, the anomaly list as the headline, every
  percentile carrying its cohort n AND its band count (bands are 10/10/9/7/4/3/2 per vendor), and
  fourteen distinct refusal sentences ([docs/FRONTEND.md](docs/FRONTEND.md) § Bots → Benchmark).
  ⚠ **THAT ROUTE IS TWO SCREENS AT TWO GRAINS, AND MONEY LIVES ON EXACTLY ONE.** The RAIL renders
  `rollup[]` (ONE CARD PER VENDOR over the workspace — pooled counters, a per-repo evidence table, a
  spread, the price); the REPO TAB renders the per-repository units and **no money at all**. Same
  route, same ONE fetch; `apiVersion` STAYS 21 (`rollup?` is an optional field on a
  `packages/shared` wire type, which is not `ProContext`). ⚠ **THE ROLLUP CARRIES NO PERCENTILE OF
  ITS OWN** — pooling is VOLUME-weighted while the cohort distribution is one-repo-one-vote, so a
  workspace spanning four bands folds to a number belonging to no cell, and there is no distribution
  of workspaces to rank it in anyway. Its comparison arrives as the SPREAD (how many of its
  per-repo placements sit below/at/above their own medians) and the estate-matched EXPECTATION —
  both DERIVED FROM THE PER-REPO UNITS, never computed at estate grain.
  `BotBenchmarkPlacementUnit.cost` is **DELETED from the wire** (a price is stored once PER
  WORKSPACE; the old block divided a whole subscription by one repository's work), and the guarantee
  is STRUCTURAL — a `?repoIds=`-NARROWED request builds no rollup, and it is the NARROWING that
  decides, never the resulting repo count. `BotRoiPanel`'s `$/acted-on` follows the same rule
  (`showCost = botDepth && repoId == null` — do NOT simplify back to `botDepth`). ⚠ **`$ per
  acted-on thread` DIVIDES BY A CHOSEN CALENDAR MONTH — `COST_WINDOW_DAYS` = `DAYS_PER_MONTH`
  (30.44) — AT BOTH ENDS**: `monthlyUsd ÷ (acted-on threads whose SETTLE POINT fell in
  `[now − 30.44d, now)`)`, a division the card prints both halves of. It replaced `Σ_r (acted_r ×
  30.44 ÷ spanDays_r)`, a window NOBODY CHOSE (237 days on a real card), an order statistic one old
  comment could set, and a divisor no component ever rendered — US$23.94 against the ROI tab's
  US$3.2 for the same bot at the same price. **30.44 and not 30 is load-bearing**: the ROI tab
  annualises by `DAYS_PER_MONTH ÷ windowDays`, so the two tabs agree at exactly one window length
  and `test/benchmark-roi-agreement.test.ts` fails if the constant moves. The window is FIXED, never
  the ROI chip (a placement must not move because someone flipped a selector elsewhere), and it
  **REFUSES rather than falling back** — `repo_window_incomplete` (a repo younger than the window:
  partial work, whole price), `nothing_acted_on` (a dormant reviewer), `window_underpopulated`
  (< 10 acted-on threads), each withholding the per-thread money ALONE. ⚠ The two tabs still differ
  on real data (US$1.97 vs US$3.22) because the acted-on DEFINITIONS differ by design — do not
  reconcile them. Five fold rules
  in [docs/PRO-PLUGIN-AND-ACTIVITY.md](docs/PRO-PLUGIN-AND-ACTIVITY.md), each of which has already
  cost a bug: rates are additive but **spans are NOT** (now VACUOUS — nothing divides by a span;
  kept for its argument); `yours` carries the WINDOW's thread pair and `unacted` the whole SLICE's
  under the same field names, so each sentence names its own population; the pooled headline rate
  (over every live repo) and the fitted-subset rate are TWO NUMBERS that must be labelled apart and
  **NEVER SUBTRACTED** — both, plus both repo counts, ride the wire (PERIOD-REPORTING's
  headline-vs-subset defect, one grain over); a cohort median of **`0` is NO median** — all three
  `qodo` bands in the shipped corpus publish one; and **`workspace_truncated` OUTRANKS every other
  cost refusal**, because a partial estate makes the exact claim false in the INFLATING direction —
  money refuses on all three arms while counters and the spread, honest sums over a stated subset,
  still render.
- **The work plan** (`workPlan` gates the NARRATION ONLY): "what should I work on today", folded
  into the **Pending** board as its ranked "Do next" head. **THE CODE RANKS, FREE; THE MODEL
  NARRATES, PAID** — the rank is CORE (`db/work-plan.ts`) and served free by `GET /api/attention`,
  and the plugin adds a headline, one `why` per head row and a `parked` line. There is no
  "Plan for today" panel; it was the attention board's own population on a second, paywalled
  surface. Contract in
  [docs/PRO-PLUGIN-AND-ACTIVITY.md](docs/PRO-PLUGIN-AND-ACTIVITY.md) § The work plan. What bites:
  **the brief says how much, the plan says in what order, and they are ONE population** (both fold
  `getWorkspaceInsights`' cards; `counts` rides the wire so the agreement is ASSERTABLE); the CODE
  ranks and the model may only foreground/order/annotate; ⚠ `ageHours`/`stallRisk`/`score` are
  `now`-derived and must stay OUT of the payload hash; ⚠ **ONE PR IS ONE JOB** — the id dedup is
  not enough, a second pass keys on `prId` and wins by time-free `proximity`; ⚠ a repo-grained row
  (a red trunk) must not be described as a PR in the payload, its facts, or on screen; ⚠
  `ProHostQueries.getWorkPlan` is OPTIONAL so `apiVersion` stays 21.

---

## Period reporting + effort-vs-automation (Insights → Reports)

A stored, forwardable artifact per completed period, its comparison against the prior one, and
a refusable forecast. **Metrics are CORE** (`db/period-metrics.ts`, `db/forecast.ts`,
`db/actor-lanes.ts`, `db/person-period.ts`); storage, narration and routes are plugin-owned.
**Full contract: [docs/PERIOD-REPORTING.md](docs/PERIOD-REPORTING.md)**. The invariants:

- **EVERY Pro reading setting on this surface IS PER-WORKSPACE, with the product default beneath it
  and NO inheritance chain** — the sprint cadence + phase anchor, the Jira/Linear tracker and, since
  plugin migration 0032, the **comparison mode**, all on one `pro_workspace_settings` row.
  ⚠ The mode moved because the claim keeping it account-wide was FALSE: it COMPOSES with the
  cadence, so `'sprint'` is a sprint-position window on a workspace that has one and a rolling
  fortnight on one that does not — one account setting, two window SHAPES, nothing on screen saying
  which. `resolveComparisonWindow`/`resolveInsightsRange` take RESOLVED VALUES, never a settings
  row, and `getComparisonWindow` reads both halves off ONE row so they cannot come from two grains.

- **Every metric is WINDOW-PURE** — events timestamped in `[fromMs, toMs)`, TWO-SIDED predicate
  on every column. A stored period must stay reproducible, so no "as of now" snapshot enters the
  vector (no `openPrs`, no `ciFailingNow`).
- **Retroactive history is COVERAGE-BIASED** — check the contributing-repo count per bucket
  before believing any long chart; hence `getPeriodCoverage`, the stable-SUBSET comparison and a
  REFUSING forecast.
- **ONE ROW MUST NEVER MIX THE HEADLINE AND SUBSET POPULATIONS.** Headline = full membership,
  delta = the coverage-stable subset, and `rowFigures()` is the one place that decides — a row
  whose three cells do not arithmetically agree is the defect this feature shipped three times.
- **`PERIOD_METRICS_SCHEMA_VERSION` is folded into `payloadHashFor`**, so a bump is
  self-executing; three spellings — shared, core, plugin — stay in lockstep. ⚠ A metric is
  RENAMED, never redefined in place, or a v1 and a v2 row become subtractable under one key.
- ⚠ **A `_pct` metric MUST join `PCT_METRIC_KEYS`** in the plugin or its forecast projects an
  impossible number — a silent defect, not a compile error.
- **TWO GRAINS COEXIST — the sprint cadence (default) and REAL CALENDAR MONTHS** (`PeriodGrain`),
  plus a live **month to date**. The grain is a READING CHOICE on the request
  (`?grain=` on the list; every other route derives it from the KEY, `sprint-YYYY-MM-DD` vs
  `month-YYYY-MM`) and is NEVER a stored setting — folding it into the cadence row would move the
  free flow-metrics window on another tab. ⚠ **The comparison refusal keys on GRAIN FIRST, and on
  `cadenceDays` ONLY within the sprint grain**: Jan is 31 days and Feb is 28, so a bare day-count
  test refuses EVERY month-over-month comparison, silently. ⚠ A month row keeps its REAL day count
  (28-31), never a sentinel. ⚠ **`grain` is a column that four sites used to hard-code**, so a month
  row persisted as `month` and served as `sprint`; read it. ⚠ **The forecast REFUSES at month grain**
  (`uneven_periods`) — `db/forecast.ts` fits on the ARRAY INDEX, so 28-vs-31 days is a ±5.4% swing it
  reads as signal and February dips every year. ⚠ **Month-to-date is LIVE, UN-STORED and UN-BILLED**
  — an open period's fingerprint moves on every merge (permanent `stale`) and its upper bound is
  `Date.now()` (which may never enter a payload hash); no Generate button, and its own `search` tier
  on `GET /api/pro/insights/month-to-date`. ⚠ The month-word BAN is GRAIN-CONDITIONAL in five
  places INCLUDING THE LLM SYSTEM PROMPT — forked, never deleted, or a 14-day report regains
  permission to call itself monthly.
- **Seven `ActorLane`s, and the vector's human-only figures come from the same resolver the
  lane panel does** — a blended figure is a number no PR resembles. Four more ⚠ rules have
  their own headings in the doc: the automation set is the lane resolver's **UNION**, never
  `automatedReviewerUserIds` alone; the dependency / `code_agent` split **resists collapsing**;
  **"time until a person reviewed it" has ONE fold** whose **all-time lookback is load-bearing**;
  and **an explicit `toMs` must reach EVERY fold of a windowed getter — and only an explicit
  one** (`typeof window === 'string' ? null : to`, half-open `lt`, never `lte`).

**The People report** (Reports → People) — a multi-select picker of humans AND bots, one report
with a SECTION per pick; contract in
[docs/PRO-PLUGIN-AND-ACTIVITY.md](docs/PRO-PLUGIN-AND-ACTIVITY.md) § "The People report".

- **PREP, NOT SCORING.** The multi-select is sanctioned; a cross-person SHAPE is not — sections
  ALPHABETICAL by label, no ranking, no cross-person sort, no comparison table, and
  `getPersonPeriod` KEEPS its one-person-per-request shape (the CLIENT loops; no batch/list
  spelling anywhere). The guardrail comments in `db/person-period.ts`, `person-routes.ts` and
  `PeriodPeopleSection.tsx` stay.
- **A bot section renders TWO vectors and the DATA decides which appear**, never the stored
  role (that would be the login heuristic at one remove).
- ⚠ **The picker must NOT read `useSearchTimeline`/`useSearchOpenPrs`** — both carry TIMELINE
  BOARD state whose controls aren't mounted on Reports. Use `useRosterTimeline` +
  `useWorkspaceOpenPrs` and the ONE roster builder `hooks/useMemberSections.ts`.
- Two cost landmines are in the doc: **evidence (`?evidence=1`) is ADDITIVE ON THE SAME FOLD**,
  never a sibling scan; **`PERSON_REPORT_VERSION` is KIND-SCOPED staleness** reaching the hash
  only through an evidence id that EXISTS.

---

## Chronology — the court ledger (Insights -> Reports)

Every hour a pull request is open, somebody is holding the ball: a **reviewer** who has not looked,
an **author** who owes a response, or nobody - approved and waiting to land. **PRO on
`periodReports`** (no new capability, apiVersion stays 21), deterministic — no model anywhere in
it. `db/pr-intervals.ts` + `api/routes/flow.ts` + `Activity/BottlenecksPanel.tsx`. Full contract:
**[docs/BOTTLENECKS.md](docs/BOTTLENECKS.md)**. ⚠ The 402 lives on the ROUTE; `getFlowCourts` stays
capability-blind because `verify:isolation` calls that fold directly, with no account row.

⚠ **This REPLACED a path-bucket feature that emitted "`src/**` is a bottleneck".** A
directory is four proxies from anything an EM can change and on a single-package repo IS the
repository. `single_reviewer_path` and `round_trips` are deleted; `size_latency` is deleted as a
finding (845k PRs say size does not predict time-to-merge, r_s = 0.26); `approval_parked` survives
as the LANDING court. Without opening the doc:

- ⚠ **A BOT ACTION NEVER MOVES THE BALL, AND BOT-AUTHORED PULL REQUESTS ARE NOT MEASURED** -
  the moat, and it changed the answer: bot work was 43% of merges and SLOWER, so blending moved the
  split 72/10/18 to 60/16/24 and cited dependency bumps as things people waited on.
- ⚠ **LOPSIDED *AND* SLOW, or say nothing.** A real repo is 73% author-court with an
  eighteen-minute p75; a share without a magnitude invents a crisis in a healthy repo.
- ⚠ **THE ADVICE IS PER COURT, NOT PER REPO.** Stated once per section - six repos in one
  court produced six identical paragraphs on the first cut.
- ⚠ **A NEVER-HUMAN-TOUCHED PR IS EXCLUDED** (46% of merges) - its ledger is 100% reviewer by
  construction. Reported separately as a governance finding.
- ⚠ **NO PERSON IS NAMED ANYWHERE**, and the server sends no actor ids, so it is structural.

## ML severity/category on bot comments (CORE, free tier, no LLM)

Every bot-authored review comment / PR comment / review body is labelled with a **severity**
(`nit`·`minor`·`major`·`critical`) and up to eight **categories** by the `severity-api`
microservice from **`packages/ml`**. Full detail: **[docs/ML-SEVERITY.md](docs/ML-SEVERITY.md)**.

- **`SEVERITY_API_URL` IS THE WHOLE GATE.** Unset ⇒ no worker, `/api/me` reports
  `mlSeverity:false`, the SPA issues zero ML queries — which keeps the feature dark under
  `npx pierre-review`. ⚠ The flag is **top-level** on `MeResponse`, NOT part of `pro`:
  `entitledProCapabilities` zeroes that object for free cloud accounts, exactly this feature's
  audience.
- **Enrichment is a PULL-BASED BACKGROUND WORKER (`sync/ml-enrichment.ts`), never a sync
  step** — `persistPr` runs inside `runTransaction`, so an awaited `fetch` there would hold the
  single sqlite write lock across network latency. The worker re-derives "bot text with no
  label yet" every tick, so webhook/post-write paths need no hook and a bot classified later
  brings its backlog with it.
- **The batch budget is CHARACTERS, not items** (a batch pads to its longest member, so the
  worker sorts by length before packing: `config.mlBatchMaxChars`, 128-item cap). ⚠ Results are
  zipped POSITIONALLY; a length mismatch throws rather than mislabelling a comment.
- `ml_comment_labels` is keyed `(accountId, targetKind, targetId)` — `targetId` lives in THREE
  id spaces, so every lookup carries the kind. Cleanup rides the cascading `pr_id` FK:
  deliberately in NEITHER delete path, but IS in `accountScopedTables()`. The badge NEVER
  fetches (every mount reads the one `['ml-labels', prId]` per-PR index).
- **A SYNC HAS TWO HALVES and the UI must show both.** The enrichment kick sits **above**
  `clearSyncProgress` in `runSyncForRepo`'s `finally`, which works only because
  `runMlEnrichmentTick` flips `running` before its first `await` — ⚠ an `await` added above it
  reopens the gap. ⚠ **`pending > 0` is NOT "scoring in progress"** — go through `isMlScoring`;
  backlog with nothing draining it is real.
- **The vendor's own severity badge is stored to be SHOWN, never to be BELIEVED** — it is never
  an input to the model.
- **The severity INFLATION index** is the ROI table's Inflation column — **PAID in full**
  (`botDepth`): the column is a cell of the paid vendor table, so an unentitled account receives no
  `vendors[]` to draw it in (the weekly history is separately ABSENT — not empty — because it is an
  extra scan WIDTH). The per-COMMENT severity badge is a different route and stays free.
  ⚠ It counts only the BADGED findings, so a bot that badges nothing is **OMITTED and NAMED**,
  never drawn as a zero. CRITICAL is under-recalled, so the product buckets **major+critical as
  "high"** and nothing auto-acts on a label. ⚠ **The cell's sparkline now has an enlarged twin in
  the same panel's chart row** (`InflationHistoryChart` — key, axis, hover; one small panel per bot,
  amber/violet = direction, the bot's hue on the name dot only). It plots **counts, never a rate**
  (no weekly denominator exists on the wire), its span is a FIXED 12 weeks beside window-scoped
  table counts and it **says so on the card**, and its marks are deliberately NOT clickable (the
  flagging route has no week narrowing, so a click would open a list contradicting the mark). It is
  NOT a re-add of the two workspace-grain inflation ChartCards P1.2/C2 cut — those stay cut; see
  docs/ML-SEVERITY.md § The enlarged inflation chart.

---

## Security & privacy

**Read [docs/SECURITY.md](docs/SECURITY.md) before touching `app.ts`, CORS/CSP, rate limiting,
auth plumbing, or any AI route.** Two zero-dependency core plugins own the posture:
`api/plugins/security.ts` (CSP, CORS allowlist, cross-origin + host guards, HSTS) and
`api/plugins/rate-limit.ts` (fixed-window buckets keyed by accountId). Always-true rules:

- **CORS is an allowlist in BOTH modes** — local allows loopback origins only (local has no
  auth, so reflecting any origin let any open page read the whole synced dataset); cloud allows
  exactly `APP_BASE_URL`. The cross-origin guard and the host guard (DNS-rebinding) are
  separate protections, not redundancy.
- When picking a rate tier, **follow the token**: "this route is DB-only" rots. The expensive
  Claude-Review paths are matched EXPLICITLY in `tierFor` (they don't live under `/api/pro/`).
- 5xx bodies are generic in cloud (4xx stay verbatim); pino `redact`s outgoing auth headers;
  the sealed GitHub token is NEVER in the account export.
- GDPR is self-service: `GET /api/me/export` + `DELETE /api/me/account`; erasure iterates
  `accountScopedTables()` and calls the plugin's `registerAccountErasure` hook. GA4 is
  consent-gated in both bundles.

---

## Conventions & gotchas

- **Relative imports carry an explicit `.js` EVERYWHERE — backend AND frontend.** The backend's
  NodeNext resolution REQUIRES it; the frontend's Bundler resolution merely allows it.
- **Colour and contrast — MEASURED, NOT EYEBALLED.** ⚠ **A RAW BRAND HEX MAY NOT BE TEXT COLOUR.**
  `BOT_VENDOR_META[kind].color` is right for a chart stroke, where the component owns the ground;
  as text it must go through **`vendorInk()`** (`lib/ui.ts`), which emits `--ink-light`/`--ink-dark`
  and lets `index.css` pick per theme. 40 of 83 vendor colours failed AA on the dark page and 43 on
  the light one — Cursor's `#334155` rendered at 1.94:1. ⚠ **TWO VARIANTS ARE FORCED, NOT A
  PREFERENCE**: clearing 4.5:1 on white needs luminance ≤ 0.175 and on the near-black page ≥ 0.184,
  so NO single colour is legible as small text on both (`vendorInk.test.ts` proves it by sweep — do
  not "simplify" this back to one stored colour). ⚠ `vendorInk()` sets the VARIABLES ONLY and no
  `color`: the colour comes from `[style*='--ink-light']` in CSS, and an inline `color` would beat
  it. An earlier cut put the pick at `:root` — a custom property containing `var()` is substituted
  where it is DECLARED, so it resolved against root's undefined value, died there, and every chip
  silently kept its inherited grey. It typechecked and rendered; only the screen showed it.
  Two guards run from source (hand-run only, like all frontend tests): `textContrast.test.ts` fails
  on a muted pairing below AA and on a theme-less colour measured failing, and **`decorative-mark`
  is the ONLY opt-out** — a separator, an `aria-hidden` glyph, a gridline. ⚠ It may never be put on
  text that says something: an em-dash meaning "no value", a "90d" window and a "Not scored yet"
  marker were all on the original list and were made legible instead.
- **`apps/backend/src/db/queries.ts` CONTAINS LITERAL NUL BYTES (~offset 132k)**, so search
  tools treat it as BINARY and quietly under-report: `rg` prints only the matches BEFORE the
  first NUL and then says `binary file matches`; a `grep` that skips binaries (`-I`, which
  some wrappers set) prints NOTHING and exits 1. Either reads as "the symbol isn't there".
  Any audit of that file must use `grep -a` / `rg -a` (and `git diff -a` for its diff) —
  this produced a real false-negative "confirmed clean" pass.
- **The `shared` package is the only bridge.** Never import backend↔frontend directly.
- **Two schemas, kept in sync BY HAND.** Edit **both** `schema.sqlite.ts` + `schema.pg.ts`
  (`schema-parity.test.ts` fails on drift), then `pnpm db:generate` (sqlite migration, commit
  it) **and** `pnpm db:generate:pg`. Prefer hand-writing additive sqlite migrations over a
  full `db:generate`.
- **Dual-dialect query layer = portable async only** (see **Deployment modes**) — never
  `.get()/.all()/.run()` or `db.execute(sql)`.
- **Per-account isolation is load-bearing** (contract under **Deployment modes**). New
  id-routes: run `verify:isolation`. Tokens come from `getAccessToken`, never a module cache.
- **THE SCOPE IS ONE INTEGER. Do not reintroduce a scope vocabulary** — no sentinels, wire
  strings, canonicalisers or parsers. Anything needing a helper to answer "which repos is this
  scope?" means its predecessor `TeamScope` is coming back.
- **`BotScope { workspaceId, repoIds }` — two named fields answering different questions**: the
  WORKSPACE decides who counts as a bot, the REPO LIST narrows which data is measured. `null`
  is gone; `[]` means "this workspace is empty". **A `BotScope` is only ever constructed by
  `resolveWorkspaceScope`** (which guarantees `repoIds ⊆ the workspace's membership`) — never
  from `parseIntList` directly.
- **A fact lives at exactly ONE grain — never denormalise one onto the other**, or "the
  account-wide value" becomes a read of *any one* replica. Judgement, identity and price all
  live in ONE row, guarded by provenance columns + narrowed `set:` objects.
- **When a unique index CHANGES, every `onConflictDoUpdate` on that table must change with
  it.** A stale target **type-checks perfectly** and raises "no unique or exclusion constraint
  matching the ON CONFLICT specification" at RUNTIME, in both dialects, **only when a row is
  actually written** — an insert-only test never reaches the branch. `grep -n onConflictDo` over
  both trees against each table's declared unique.
- **Every read of the bot table needs an EXPLICIT workspace predicate** — go through
  `resolveWorkspaceReviewers(accountId, workspaceId)` and the helpers over it, **all of which
  take a workspaceId**; the only account-wide sweep is the benchmark, via named `…ForAccount`
  functions. ⚠ A helper collapsing a multi-row table one-row-per-author
  (`new Map(rows.map(…))`, `limit(1)`, no `ORDER BY`) reads rows in **heap order, which flips
  after any UPDATE on Postgres**.
- ⚠ **`persist()` must NOT share one values object between insert and `set:`** — a shared
  object overwrites a human's vendor name on every auto pass and can wipe a typed price. It
  builds the `set:` per workspace from the stored provenance flags and emits no statement when
  neither half may be written. Inside it, `role` is **DERIVED**, never round-tripped off the
  caller's classification (`ReviewerClassification` is role-LESS on purpose), and it **reads
  the stored rows and NARROWS the write list** rather than using a `setWhere`.
- **A target with no stored annotations must render NOTHING and issue NO request** — read the
  ONE per-PR `useAnnotationIndex` query, never a per-target hook behind a tier flag.
- **A feature can be fully built, correctly gated, and completely UNREACHABLE — grep for the
  mount.** When a change says a component "now renders in X", check `grep '<Component'`.
- **Two mounts of one paid-generation card must share the MUTATION key, not just the query key**
  (`useIsMutating({mutationKey})`) — per-mount `isPending` resets to "Generate" on a tab switch
  mid-run, inviting a second BILLED POST.
- **Open-core boundary (`@pierre/pro`).** Premium code lives ONLY in the private submodule
  `packages/pro` — **never commit it into this public repo** (only `.gitmodules` + the gitlink
  are public), and never add `@pierre/pro` to any `package.json` `dependencies` / lockfile /
  `build-release.mjs` allowlist (`bind.ts` loads it by FILE PATH so `pnpm install` works
  without the submodule). The plugin ships its **own** tables + parity + migrations + isolation
  test — core's `verify:isolation` can't see plugin tables.
- **Keep `/api/timeline` lean** — no bodies/diff hunks; detail on demand via `/api/prs/:id`.
- **A new route that spends money or GitHub quota needs a rate-limit TIER.** Add it to
  `tierFor` in `api/plugins/rate-limit.ts` (and `rate-limit.test.ts`) — the default 600/min
  `read` bucket is silently wrong for an LLM call or a GraphQL walk. ⚠ Spell the route's
  **EXACT path segment** into `hitsGithub`: a near-miss (plural `comments` vs the real
  `/comment`) parks a GitHub-write route on `read`, and nothing errors.
- **A new GitHub-write route must either stamp its row locally or resync-and-verify.** A write
  is not done when GitHub 201s: the SPA re-reads from the local DB, so anything the sync hasn't
  observed is invisible. Most write routes stamp the affected row themselves; the one that
  CAN'T (`POST /api/prs/:id/review-comment` — REST returns no thread node id) runs the tail in
  `sync/resync-after-write.ts` and reports a `visible` flag. The tail costs an extra GitHub
  round trip, so it is a per-route latency decision, not a blanket rule.
  - ⚠ **The `visible`/`threadId` copy contract is a safety rule, not cosmetics.**
    `visible:false` with a NON-NULL `commentId` means the comment IS on GitHub and we merely
    couldn't confirm it locally — the copy must say "it'll show up here shortly", never "it
    failed", and must **never offer a retry, because a retry DOUBLE-POSTS**. Once GitHub has
    201'd the route may not fail.
- **A column may be CLEARED only on a positive statement from GitHub.** `graphqlTolerant`
  hands back partial data with forbidden fields NULLED, so "GitHub said there is nothing" and
  "we never received that selection" look identical. Model the three states (`undefined` = omit
  the key, `null`/`[]` = clear) and SPREAD the observed keys into the values/set objects
  (reference: `sync/branch-status.ts`).
- **A PR number resolves to a local id only within `(accountId, repoId)`** — numbers are unique
  per REPO, so a map keyed on a bare number cross-links one repo's #12 onto another's row.
- **A new `accountId`-bearing table must be added to `accountScopedTables()`** in
  `db/erase-account.ts` (and erased in `eraseAccountData`), or a deletion silently leaves it
  behind. The test iterates that list, so an omission fails CI.
- **Never put a data-derived URL straight into `href`/`src`.** React renders `javascript:` URLs
  (it only console-warns) and check-run `details_url` etc. are third-party-supplied — go
  through `safeExternalUrl()` in `lib/ui.ts`.
- **Anything an agent reads from a PR is UNTRUSTED input.** Don't widen an agent's tool surface
  — `review/agent.ts` denies `Bash` outright, and a per-command blocklist is no substitute.
- **Heuristics get fixture tests.** Before changing `derive-thread-state.ts`, add a sample to
  `src/sync/__fixtures__/threads/` (README has the JSON shape).
- **Idempotency is load-bearing.** New entities upsert on their GitHub node ID — the conflict
  target is **composite** with the scoping column (`accountId`/`prId`); new event types
  produce a deterministic `dedupeKey`.
- **`req.raw.on('close')` is NOT a client-disconnect signal on a POST — watch the REPLY
  socket.** A request's `close` fires when the REQUEST is complete, which for a POST is the
  moment Fastify finishes reading the body, so a `shouldStop` flag wired to it is permanently
  true and the route 200s with an empty body. Use `reply.raw` (or the hijacked `raw`). The
  `…/stream` endpoints that are **GETs** (Claude Review, AI Fix) are unaffected and must not be
  "fixed".
- **TypeScript is strict** (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`).
- The local DB + `.env` files are gitignored. Cloud secrets (`ENCRYPTION_KEY`,
  `SESSION_SECRET`, the OAuth client id/secret) live only in env; stored OAuth tokens are
  AES-256-GCM-sealed.

---

## Verifying changes

For backend/heuristic logic, `pnpm test` + `pnpm typecheck` (4 workspaces). For UI work,
`pnpm dev` is usually already running; the SQLite DB at `apps/backend/data/` holds real synced
data you can query (`sqlite3`) to pick test cases, and app state deep-links via URL params
(`?pr=<id>`, `?repos=<ids>`, `?cats=…`) against the dev SPA base `/app/`.

For **multi-tenant / cloud** changes: `verify:isolation` proves cross-account IDOR at the
query layer. To exercise the deployed experience locally, `docker compose up -d db` +
`--cloud` per `docs/LOCAL-CLOUD-TESTING.md`; confirm **local is unchanged** (`pnpm dev` →
straight to `/app`, no landing/sign-in).

---

## Packaging & publishing

Ships to npm as the single unscoped package `pierre-review` (`npx pierre-review`), built
artifacts only. Publishing is CI-only — **never run `npm publish`/`npm login` from here**.
Details: [docs/PACKAGING.md](docs/PACKAGING.md) + [docs/RELEASE.md](docs/RELEASE.md).
The traps:

- **`@pierre-review/shared` is types-only and NOT a published dep** — backend imports must
  be `import type` only; the release build greps `release/dist` and fails on a real one.
- **pnpm is PINNED** (`packageManager: pnpm@9.15.9`); bumping it means regenerating
  `pnpm-lock.yaml` or native builds fail (`ERR_PNPM_IGNORED_BUILDS`).
- **No AI ships in npm**: the AI SDKs are never curated runtime deps; a guardrail assert
  fails the build if any leak into `release/package.json`. `--with-pro` (the paid cloud
  image only; public release CI never passes it) adds only `@anthropic-ai/sdk`.
- The landing prerender's `<!-- seo:start/end -->` / `<!-- app:start/end -->` markers in
  `apps/landing/index.html` are load-bearing — deleting them silently reverts the site to
  a contentless shell (the prerenderer throws, but only at build time).

---

## Migrations & history

The full history, fold rules and sqlite↔pg divergences live in
[docs/MIGRATIONS.md](docs/MIGRATIONS.md) — read it before writing ANY migration. Operating
rules:

- **BOTH journals are hand-maintained** (each folder's `meta/_journal.json`; sqlite entries
  `"version": "6"`, pg `"7"`). An unregistered file **SILENTLY SKIPS** — the boot looks perfect
  and every query 500s on a missing relation. The pg half is the one that gets forgotten.
- **Never run `pnpm db:generate:pg` for an incremental change** — it squashes the baseline. pg
  migrations are hand-written additive, like the sqlite ones since `0008`.
- Plugin migrations are filename-sorted with NO journal (do not add one), take NO
  `--> statement-breakpoint`, and their pg twins downgrade failures to warnings — because
  a plugin-migration failure silently drops the whole plugin to OSS mode.

**Known gaps** — full list in [docs/MIGRATIONS.md](docs/MIGRATIONS.md). The ones that change
how you work:

- **The unit suite runs on SQLite ONLY**, so every pg migration is replayed BY HAND. ✅ The whole
  chain is currently green: core `0000`→`0043` (44/44) **and** all 28 plugin pg twins applied
  into a throwaway database on **PostgreSQL 16.9**, 2026-08-27, yielding full table parity with
  SQLite (the only absentee is `pro_migrations`, which the plugin's own runner creates rather
  than a `.sql` file). Recipe + the standing local Postgres are in docs/MIGRATIONS.md § Replaying
  the pg chain. **A new pg migration is unreplayed until someone repeats this** — the suite will
  not tell you.
  - ⚠ The `regexp_replace(…, '\[bot\]$', '')` vs `replace(…, '[bot]', '')` divergence
    (pg `0040`/`0041` vs their sqlite twins `0053`/`0054`) is REAL but unreachable: the two
    disagree on `foo[bot]bar` (`foo[bot]bar` vs `foobar`) and on a LEADING `[bot]`, and agree
    everywhere else. Measured identical across all 4,561 real logins, and zero of them carry
    `[bot]` anywhere but the end — which is the only place GitHub puts it. Do not "fix" one to
    match the other; each is idiomatic for its dialect.
- ⚠ **AI Fix's conflict-resolver paths (`rebaseResolve` / `mergeResolveAndPush`) GATE on credits
  but never CHARGE them** — only `saveFixSuccess` calls `recordAiUsage`, so a fix ending in a
  rebase-resolve under-bills. (Recorded only here; no topic doc carries it.)
- **`packages/pro/test/` and `apps/frontend/test/` do not run in CI** (`pnpm test` is
  recursive vitest and the frontend's `test` script is `echo "no tests"`), and neither
  directory is typechecked (both tsconfigs include only `src`). Run them by hand:

  ```
  ./apps/backend/node_modules/.bin/vitest run --root packages/pro
  ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
  ```
