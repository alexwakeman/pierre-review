# pierre-review

A **single-page dashboard for tracking a team's GitHub activity across multiple
repositories** — built for sprint situational-awareness: at a glance, who's doing what,
which PRs are stalled, which review threads sit untouched, and what needs _your_ attention.

It runs **two ways from one codebase**, selected by `DEPLOYMENT_MODE`:

- **local** (default): entirely on your machine — SQLite, no hosted backend, no stored
  credentials. Authenticates via your logged-in `gh` CLI, syncs into a local SQLite file,
  opens straight to the timeline.
- **cloud** (multi-tenant): a public landing page, GitHub sign-in (OAuth App and/or GitHub
  App), per-user encrypted accounts, Postgres — self-hostable on Railway.

> **How to use this file.** This is the lean operating guide: the mental model, the
> commands, and the invariants and landmines you must know BEFORE editing. Per-area depth
> lives in the topic docs below — read the matching doc before non-trivial work in its
> area, and when you change things put new detail in the topic doc, keeping only the
> summary here. **This file has a hard size budget** (the 150k-char memory limit; keep it
> under ~100k so there is headroom). Anything discoverable by grepping the code or reading
> a route/table definition does not belong here.

## Doc map

| Doc | Read before touching |
|---|---|
| [docs/BACKEND.md](docs/BACKEND.md) | startup/auth plumbing, sync pipeline internals, lean storage, branch snapshot |
| [docs/SYNC.md](docs/SYNC.md) · [docs/REALTIME-SYNC.md](docs/REALTIME-SYNC.md) | sync triggers/backfill mechanics · adaptive polling + webhooks |
| [docs/DATA-MODEL.md](docs/DATA-MODEL.md) | any schema/table change; per-table contracts; derived thread state |
| [docs/API.md](docs/API.md) | any route — the full per-route contract reference (shapes, status codes, scope rules) |
| [docs/FRONTEND.md](docs/FRONTEND.md) | stores, tabs/overlays, FilterBar scoping, timeline internals, PrDetail |
| [docs/MERGE-CI-TRUNK.md](docs/MERGE-CI-TRUNK.md) | merge verdict/queue, the auto-merge runner, CI log viewer, trunk status |
| [docs/CLAUDE-REVIEW.md](docs/CLAUDE-REVIEW.md) | the agentic PR-review feature |
| [docs/ML-SEVERITY.md](docs/ML-SEVERITY.md) | ML severity/category enrichment of bot comments (the `packages/ml` severity-api seam) |
| [docs/PRO-PLUGIN-AND-ACTIVITY.md](docs/PRO-PLUGIN-AND-ACTIVITY.md) | plugin seam/apiVersion, Activity tab, Feed, the bot platform ("One bot object"), annotations, digests |
| [docs/PRO-PLATFORM.md](docs/PRO-PLATFORM.md) | the Pro platform's own deep-dive |
| [docs/SECURITY.md](docs/SECURITY.md) | app.ts, CORS/CSP, rate limits, GDPR export/erase, dependency posture |
| [docs/PACKAGING.md](docs/PACKAGING.md) · [docs/RELEASE.md](docs/RELEASE.md) | build-release, CLI, landing prerender · CI publishing |
| [docs/MIGRATIONS.md](docs/MIGRATIONS.md) | any migration; the 0044/0045/0046 story, dialect divergences, known gaps |
| [docs/DEPLOY-RAILWAY.md](docs/DEPLOY-RAILWAY.md) · [docs/GITHUB-AUTH-SETUP.md](docs/GITHUB-AUTH-SETUP.md) · [docs/LOCAL-CLOUD-TESTING.md](docs/LOCAL-CLOUD-TESTING.md) · [docs/BILLING-STRIPE.md](docs/BILLING-STRIPE.md) | cloud ops |

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
| DB | SQLite (`better-sqlite3`) | Postgres (`pg`) |
| Schema | `db/schema.sqlite.ts` | `db/schema.pg.ts` (identical names) |
| GitHub auth | `gh auth token` (one account) | OAuth App and/or GitHub App, per-user tokens |
| Accounts | 1 synthesized `isLocal` (id 1) | one per signed-in user |
| Landing | never served (`/` → 302 `/app`) | served at `/` |
| Timeline SPA | `/app` | `/app`, behind the auth gate |
| Claude Review | allowed (flag) | force-disabled (routes unregistered) |
| Sessions/OAuth | none | sealed cookie + `/api/auth/*` |
| CORS | loopback origins only (was `origin:true`) | exactly `APP_BASE_URL` |
| CSP / HSTS | CSP yes (no 3rd-party origins); HSTS no | CSP + HSTS + www→apex 301 |
| Host guard | 421 on non-loopback `Host` | n/a (proxied) |
| Rate limits | on, keyed by the single account | on, keyed by accountId (IP fallback) |
| Analytics | never loaded | GA4, consent-gated |
| Account delete/export | export yes; delete 400s (own the DB file) | both self-service |

**Dual-dialect DB (the foundation).** The query layer is written **once**, `await`-based,
against a PORTABLE async surface:

- `db/client.ts` mode-selects driver + schema at boot — local `drizzle(better-sqlite3,
  sqliteSchema)`, cloud `drizzle(node-postgres Pool, pgSchema)` (pg dynamically imported
  so the unused driver isn't loaded). Exports `db` (TYPED as node-postgres — so a stray
  `.get()/.all()/.run()` is a compile error), `schema`, `isPg`, `closeDb`, `runTransaction`.
- **Portable terminals only**: `await q.execute()`, `.returning().execute()`,
  `onConflictDoUpdate`. NO `.get()/.all()/.run()`, NO `db.execute(sql)` (pg-only). "Rows
  affected" = `.returning({id}).execute().length`; raw-`sql` booleans use `= true`.
- **Transactions are the one dialect fork**: better-sqlite3 rejects async tx callbacks,
  so `runTransaction` does manual `BEGIN/COMMIT/ROLLBACK` on sqlite, a real
  `db.transaction(async tx => …)` on pg; the ~4 tx blocks take the `tx` executor.
- **`schema.sqlite.ts` + `schema.pg.ts` kept in sync BY HAND**, guarded by
  `db/schema-parity.test.ts`. Migrations are per-dialect: hand-written
  `db/migrations/*.sql` (sqlite) + a generated `db/migrations-pg/` baseline
  (`pnpm db:generate:pg`); `run-migrations.ts` picks folder + migrator by mode.

**Multi-tenancy.** Every GitHub entity is owned by an `accounts` row. `accountId` is
**denormalized** onto `repos`, `pullRequests`, `events`, `claudeReviews`,
`myTurnDismissals`, `workspaces`, `workspaceRepos`, `workspaceReviewers`,
`mlCommentLabels` (isolation = one indexed
predicate); everything else reaches its account via `repoId`/`prId`. `users` + `commitFiles` stay
**global**. GitHub-node-id uniques are
**composite** so two accounts can track the same repo (`(accountId, githubNodeId)`,
`events (accountId, dedupeKey)`, child `(prId, githubNodeId)`). Every list/feed query filters
by `accountId`; every id-addressed getter scopes ownership → null/false → 404. Where an id arrives
in a **request body** (`workspaceId`, `repoId` on the membership table) tenancy is additionally
**structural** — a NAMED COMPOSITE FK against `(id, account_id)`, so the cross-account pair fails in
the database rather than in whichever handler remembered to check. The
query-layer IDOR guarantee is checked by `verify:isolation`.

**Auth & tenancy plumbing.**
- `auth/account.ts` — `ensureLocalAccount()` (local, `gh api user`, id 1), `getAccountById`,
  `getAccountUserId` ("who am I" for triage), `getAccessToken` (local → `gh auth token`;
  cloud → decrypt), `upsertCloudAccount` (OAuth). `auth/crypto.ts` — AES-256-GCM sealing
  (`ENCRYPTION_KEY`).
- `github/client.ts` — **per-account** factories `getGraphqlClientFor`/`ghRestGetFor`/`PostFor(token,…)`.
  **NO module-level token cache** (the #1 leak risk); the gh-token `ghRestGet/Post` remain
  for the local-only Claude Review path.
- `api/plugins/auth.ts` — `registerAccountContext` (sets `request.account`, stamps
  `lastActiveAt`), `registerSession` (cloud cookie), `registerAuthGate` (cloud: 401 unauthed
  `/api` except `/api/health` + `/api/auth/*`), `accountIdOf(req)`.
- `api/routes/auth.ts` (cloud) — OAuth `login` / `callback` (exchange→upsert→session→`/app`) / `logout`.

**Serving & routing.** SPA built `base:'/app/'`, landing (`apps/landing`) at `/`; `app.ts`
registers two `@fastify/static` roots + the single `setNotFoundHandler` that routes them
(full routing in [docs/PACKAGING.md](docs/PACKAGING.md)). **Running cloud:** `cli.ts --cloud`/`--mode` set
`DEPLOYMENT_MODE=cloud`; `docker-compose.yml` is a local Postgres, `Dockerfile` + `railway.json`
deploy to Railway, `assertCloudConfig` fails loud on missing env. Docs: `docs/DEPLOY-RAILWAY.md`,
`docs/GITHUB-AUTH-SETUP.md`, `docs/LOCAL-CLOUD-TESTING.md`.

---

## Stack

- **Monorepo:** pnpm workspaces, TypeScript + ESM throughout, Node ≥20 (dev on 24).
  Workspaces: `backend`, `frontend` (SPA), `landing` (cloud marketing) + types-only `shared`.
- **Backend:** Fastify + Drizzle ORM, **dual-dialect** SQLite (local) / Postgres (cloud);
  `node-cron`, pino. Cloud adds `@fastify/cookie` + `@fastify/secure-session`.
- **Frontend:** React + Vite + Tailwind + `vis-timeline`, Zustand, TanStack Query.
- **GitHub:** `@octokit/graphql` (one fat query per repo) + occasional REST; auth via
  `gh auth token` (local) or a per-account OAuth token (cloud).

---

## Repo layout

> ⚠ **"Workspace" is now TWO things in this repo and they never mean each other.** A **pnpm
> workspace** is a package in this monorepo (`apps/backend`, `packages/shared`, …). A **Workspace**
> (capital W, the product noun) is a named grouping of an account's repos — the app's ONE scope,
> stored in the `workspaces` table. This section is about the former; everything else in this file
> is about the latter. When in doubt, a lowercase "pnpm workspace" is the build tool.

```
pierre-review/
├─ apps/
│  ├─ backend/                 @pierre-review/backend
│  │  ├─ src/
│  │  │  ├─ index.ts           entrypoint: (cloud) assertCloudConfig → migrate → cleanup → (local) ensureLocalAccount → buildApp → schedule → listen
│  │  │  ├─ app.ts             Fastify factory: CORS, (cloud) session + account-context + auth-gate, static roots, routes
│  │  │  ├─ config.ts          env-driven config (deploymentMode/dbDialect + cloud vars); assertCloudConfig()
│  │  │  ├─ cli.ts             bin (dist/cli.js): flags/env, gh pre-check (local), banner, browser-open
│  │  │  ├─ auth/              account.ts (context + per-account tokens), crypto.ts (token sealing)
│  │  │  ├─ db/
│  │  │  │  ├─ schema.sqlite.ts  Drizzle tables (sqlite-core); schema.pg.ts its pg-core twin (parity-guarded)
│  │  │  │  ├─ client.ts        mode-aware driver/schema; exports db, schema, runTransaction, closeDb, isPg
│  │  │  │  ├─ queries.ts       read layer (async, accountId-scoped): getTimeline/getPrDetail/getOpenPrs/getMyTurn/getMergers
│  │  │  │  ├─ triage.ts        computeTriage(): reasonTag, "my turn", new-since-viewed, approvals
│  │  │  │  ├─ branch-queries.ts  getBranchStatus(): default-branch health + trunk commits (+ commit→PR resolution)
│  │  │  │  ├─ daily-brief.ts / person-period.ts / synthesis-input.ts   the apiVersion-21 core folds:
│  │  │  │  │                    free brief counts (5-min TTL, reuses each surface's own fold), the 1:1
│  │  │  │  │                    person vector, the synthesis seam's input assembly (one predicate per kind)
│  │  │  │  └─ migrations/ + migrations-pg/   sqlite (.sql + meta/) | Postgres baseline (`db:generate:pg`)
│  │  │  ├─ github/             auth.ts (gh token), client.ts (per-account factories), queries.ts (the big query),
│  │  │  │                      mutations.ts (REST writes + the GraphQL-only merge queue), branch-queries.ts (trunk, two-phase)
│  │  │  ├─ merge/              auto-merge-runner.ts — the "merge when ready" watcher (own cron, safety gates)
│  │  │  ├─ sync/               scheduler, sync-manager, sync-repo, upsert, derive-thread-state, hydrate-detail,
│  │  │  │                      sync-one-pr (targeted), branch-status (trunk), resync-after-write (post-write tail)
│  │  │  │  └─ __fixtures__/threads/   JSON fixtures for the thread-state heuristic tests
│  │  │  ├─ review/             Claude Review (local-only): agent, review-manager, routing, persist, post-review, prompt
│  │  │  │                      + events.ts (inert review event-bus + learnings registry), llm.ts (cheapComplete seam)
│  │  │  ├─ pro/                open-core seam (no premium logic): contract.ts, bind.ts (guarded import), migrate.ts
│  │  │  └─ api/                routes/ (one file per resource) + plugins/ (error-handler + SPA/landing router, auth)
│  │  └─ data/                 the local SQLite DB (gitignored)
│  ├─ frontend/                @pierre-review/frontend — the timeline SPA (base `/app/`)
│  │  └─ src/
│  │     ├─ App.tsx            useMe() 401 → SignInGate; FilterBar / PinnedTabsBar / Timeline / DetailPane / overlays
│  │     ├─ store/filters.ts   Zustand: all filter + selection + timeline-hint state (+ the transient seeds)
│  │     ├─ hooks/             useUrlState, useTimeline, usePr, useTriage, useMe (+ useProCapabilities), useActivity,
│  │     │                     useAutoMerge, useBranchStatus, useCheckLogs, useAnnotations, useMemberSections, …
│  │     ├─ api/client.ts      typed fetch wrapper (credentialed; throws ApiError)
│  │     ├─ components/        Timeline/, Activity/ (rail + FeedView + open-PR list + digest cards), PrDetail,
│  │     │                     ChecksTab, ThreadList/, ThreadView/, diff/, PinnedTabsBar, …
│  │     └─ lib/ui.ts          shared UI metadata (state colors/labels/shapes) + helpers
│  └─ landing/                 @pierre-review/landing — public marketing page (cloud, served at `/`); no shared runtime code
│                              PRERENDERED per route at build time (prerender.mjs + src/entry-server.tsx,
│                              SEO copy in src/lib/routes.ts) so non-JS clients / AI agents get real HTML
└─ packages/
   ├─ shared/                 @pierre-review/shared — types ONLY, the contract between the apps (src/types.ts)
   ├─ pro/                    @pierre/pro — PRIVATE git submodule (alexwakeman/pierre-pro), runtime-imported plugin (per-repo
   │                          Haiku digest, Insights, Claude Review + AI Fix, Claude Review learnings). Resolved by
   │                          PATH (not a declared dep); absent → clean OSS mode + install still succeeds.
   │                          (My Turn / FYI feed participation is CORE, not Pro — see below.)
   │                          `git submodule update --init` to fetch. See [docs/PRO-PLUGIN-AND-ACTIVITY.md](docs/PRO-PLUGIN-AND-ACTIVITY.md).
   └─ ml/                     pierre-ml — git submodule (alexwakeman/pierre-ml), the `severity-api` microservice.
                              PYTHON, not a pnpm workspace (no package.json ⇒ the `packages/*` glob skips it) and
                              NOT imported — the backend talks to it over HTTP only. Builds, versions and DEPLOYS
                              INDEPENDENTLY; the submodule is a pinned pointer, not a merge of the two codebases.
                              Absent → ML labels are simply dark. See [docs/ML-SEVERITY.md](docs/ML-SEVERITY.md).
```

---

## Commands

All from the repo root unless noted.

| Command | What it does |
|---|---|
| `pnpm install` | install all workspaces |
| `pnpm dev` | run backend (`:4000`) + frontend (`:5173`) + the `packages/ml` severity-api (`:8799`) concurrently, via `scripts/dev.mjs` |
| `pnpm dev:backend` / `pnpm dev:frontend` / `pnpm dev:ml` | run one side only |
| `pnpm build` | recursive build across workspaces |
| `pnpm typecheck` | `tsc --noEmit` across all packages — **run before considering work done** |
| `pnpm test` | recursive `vitest` (backend has tests; frontend/shared are no-ops) |
| `pnpm db:generate` | generate a Drizzle migration from `schema.sqlite.ts` changes |
| `pnpm db:generate:pg` | (re)generate the Postgres baseline → `migrations-pg/` |
| `pnpm db:migrate` | apply pending migrations (dialect-aware; runs on startup too) |
| `pnpm db:studio` / `db:studio:pg` | drizzle-studio against the local DB / a Postgres |
| `pnpm sync:once owner/repo` | one-off sync of one repo without starting the server |
| `pnpm --filter @pierre-review/backend verify:isolation` | query-layer cross-account IDOR check (throwaway DB) |
| `pnpm --filter @pierre/pro typecheck` | typecheck the private Pro plugin (present only when the submodule is checked out) |
| `pnpm demo` | seed the fictional `acme/*` demo data + boot the ISOLATED demo stack (`:4100`/`:5273`, gh off PATH) for browsing; `--free` = OSS mode, `--no-seed` reuses the DB |
| `pnpm shots` | the whole landing-screenshot pipeline: seed → Pro shots → restart in OSS mode → free shots → teardown (`scripts/demo-stack.mjs` + `capture-shots.mjs`) |
| `pnpm package` | assemble `./release` for publishing |

`DEPLOYMENT_MODE=local` (default) vs `cloud` selects the whole stack (SQLite vs Postgres,
landing, OAuth); `pnpm dev` is local unless `DEPLOYMENT_MODE=cloud`. **`pnpm dev` also starts
the `packages/ml` severity-api when that submodule is checked out** (`PIERRE_ML_DIR`,
`SEVERITY_API_PORT`, `PIERRE_ML_DISABLED=1`); every "can't run it" path prints one line and
exits 0, so a clone without `--recurse-submodules` gets the dev loop it always had. ⚠ It exports
`SEVERITY_API_DEFAULT_URL`, never `SEVERITY_API_URL` — `process.loadEnvFile` does NOT overwrite
an already-set variable, so a command-line `SEVERITY_API_URL` would have BEATEN your `.env`.
The frontend dev server
proxies `/api` to the backend (`BACKEND_PORT`, default 4000); the landing has its own dev
server on `:5174`. Config comes from `.env` (repo root) then `apps/backend/.env` (see
`config.ts`); `DATABASE_URL` overrides the SQLite path (local) / is the Postgres conn string
(cloud). Full cloud locally: `docs/LOCAL-CLOUD-TESTING.md`.

---

## Backend

Deep dives: [docs/BACKEND.md](docs/BACKEND.md) (startup/auth + the sync pipeline),
[docs/SYNC.md](docs/SYNC.md), [docs/REALTIME-SYNC.md](docs/REALTIME-SYNC.md).

**Boot order** (`index.ts`): (cloud) `assertCloudConfig()` → migrations → event cleanup →
(local) `ensureLocalAccount()` → `buildApp()` → `bindProPlugin()` → scheduler → listen.
Auth/tenancy plumbing is summarized under Deployment modes above.

### Sync pipeline (`src/sync/`)

Pulls PR activity into the DB, fully idempotent — entities upsert on their GitHub node id
with **composite** conflict targets (`(accountId, githubNodeId)` / events
`(accountId, dedupeKey)` / children `(prId, githubNodeId)`). Before touching it, know:

- **Adaptive polling is the PRIMARY sync strategy in BOTH modes** (`syncAdaptive` defaults
  `true`): the cron is a *tick* (`*/1`), `isDue()` gates each repo by activity bucket
  (hot 120s / warm 300s / cold 900s), incrementals probe with a conditional REST call
  (a 304 is free), and a 30-min floor forces a re-walk (CI-finish / thread-resolve never
  bump `updatedAt`). **Landmine: an explicitly-set `SYNC_CRON` wins** — a deployment
  pinning `*/5` silently negates the hot bucket.
- **Webhooks are ADDITIVE, cloud-only**, and need all three of: the secret env var, event
  subscriptions, the App installed — or they silently deliver nothing. Coverage is per
  repo (`(owner,name)` routed across every account that has it).
- **A VIEWED PR gets its own live cadence**: the SPA polls `POST /api/prs/:id/refresh`
  every ~5s while the pane is open+visible (`sync/refresh-pr.ts`) — probe-gated (free 304)
  with a 30s forced-walk floor, a failed walk remembered (`lastWalkOk` — later 304s must
  not report `synced:true`), and ALL walk attempts floor-gated so a broken token costs
  2 attempts/min, not 12. Never route this through `enqueuePrSync` (its debounce swallows
  the cadence) and never default the poll to `waitForInFlight`.
- First sync of a repo is **two-phase**: a fast ~14-day foreground pass, then the deep
  `backfillDays` (90) backfill in background. Cloud skips accounts idle > 15 min
  (`accounts.lastActiveAt`); local is always-on.
- **GitHub rate limits are PRE-EMPTED, never surfaced as errors.** A per-account in-memory
  budget (`github/rate-budget.ts`, fed by the `rateLimit` block every walk page already
  selects) gates every page/backfill loop with a cancellable ≤1s-sliced wait
  (`waitForSyncToStop` times out at 30s — never one long sleep); classified rate-limit
  errors (`isRateLimitError` — a SEPARATE path; do NOT widen `isRetryableGithubError`,
  a test pins its 403/429 exclusion) wait then retry the SAME page. API-triggered walks
  are SERIALIZED per account (`enqueueSyncForRepo`); a waiting repo reports status
  `'running'` + `paused:{reason:'queued'}`, a rate-limit wait `paused:{reason:'rate_limit',
  resumeAt}` — the red error path is reserved for unrecoverable failures. ⚠ Reservation
  discipline: every synchronous `running`/`queuedRepos`/`deepSyncing` add must be released
  on EVERY bail path INCLUDING thrown lookups (two leaks here wedged repos forever, one
  halted the global scheduler). `noteBudget` must NOT clear `limitedUntil` — the REST
  secondary limiter is independent of GraphQL success. Details in [docs/SYNC.md](docs/SYNC.md).
- **Lean storage** (default in both modes): the PR description, review-comment `diffHunk`,
  commit `message` and `checkRuns` JSON are neither persisted nor fetched — hydrated on
  demand (`sync/hydrate-detail.ts`) and browser-cached. **Comment + review bodies are
  ALWAYS persisted** (the Feed renders full markdown). `PERSIST_BODIES=true` stores all.
- The **default-branch snapshot** at the end of every repo sync is **STRICTLY NON-FATAL**
  (an informational readout must never cost the PR sync that just succeeded) and
  **two-phase for GraphQL-cost reasons** — read the cost analysis in
  [docs/BACKEND.md](docs/BACKEND.md) before restructuring its queries;
  `contexts(first:100)` must NOT be lowered.
- **A completed FULL walk tail-runs the one-time CI-history backfill**
  (`sync/backfill-ci-history.ts`; `CI_HISTORY_BACKFILL=false` disables): trunk commits back
  to the 90-day trend window (the `branch_commits` trim is HYBRID — newest-100 ∪ within-90d,
  so the backfill survives the next tick) + `ci_status_events` synthesized from GitHub's
  retained rollups so the CI charts aren't blank on a fresh repo. A PR's log is touched ONLY
  when it is provably the first-observation snapshot — never real observed
  history. Strictly non-fatal, capped, cancellation-aware; details in
  [docs/SYNC.md](docs/SYNC.md).

### Derived thread state — the heart of the app

`derive-thread-state.ts` classifies each review thread during sync, stored on
`reviewThreads.derivedState`:

| State | Meaning |
|---|---|
| `resolved` | marked resolved on GitHub |
| `likely_addressed` | a commit touched the thread's file _after_ the last comment — **a heuristic** |
| `replied_unresolved` | someone replied, but unresolved and no later commit touched the file |
| `untouched` | no reply, no follow-up commit |

`likely_addressed` is intentionally fuzzy (false positives from unrelated edits, false
negatives from renames) — the UI communicates that uncertainty. Changes REQUIRE a fixture
in `src/sync/__fixtures__/threads/` first (see its README).

### Data model

`db/schema.sqlite.ts` + `schema.pg.ts` are authoritative (28 tables); the table-by-table
contracts are in [docs/DATA-MODEL.md](docs/DATA-MODEL.md). Cross-cutting facts:

- `accountId` is denormalized onto the anchor tables (`repos`, `pullRequests`, `events`,
  `claudeReviews`, `myTurnDismissals`, `workspaces`, `workspaceRepos`,
  `workspaceReviewers`, `mlCommentLabels`); **`users` + `commitFiles` are GLOBAL** — never hand a tenant the
  raw table (`listUsers` is account-scoped by subquery; `/api/users/:id/stats` returns
  counts only, no profile fields, and deliberately no ownership 404).
- Timestamps are unix-epoch integers (sqlite) / `timestamptz` (pg), both read as `Date`.
  GitHub node ids are the stable identity. Triage fields are computed on read
  (`db/triage.ts`), never stored.
- **`workspaces` + `workspaceRepos` are the app's ONE scope.** A repo is in EXACTLY ONE
  workspace (`workspaceRepos` unique `(accountId, repoId)`; assignment is an upsert =
  a MOVE; "remove" = move to Default). Exactly one `isDefault` row per account — enforced
  by a partial unique index that lives in the `.sql` migrations (drizzle index predicates
  are inert metadata). ⚠ A repo with NO membership row is invisible to every
  workspace-scoped read: `upsertRepo` inserts membership in the same transaction, and
  `ensureRepoMemberships` repairs on effectively every request — its insert MUST keep
  `ON CONFLICT … DO NOTHING` (concurrent requests race the unique).
- Tenancy is **STRUCTURAL** wherever an id arrives in a request body: NAMED composite FKs
  against `(id, account_id)`, so a cross-account pair fails in the database in every code
  path. ⚠ `schema-parity.test.ts` compares COLUMNS ONLY — FK/index drift between the two
  dialects passes; diff the `foreignKey({...})` blocks by eye.
- **`workspaceReviewers` is THE BOT OBJECT** — one row per
  `(accountId, workspaceId, authorUserId)` carrying three independently-owned facts:
  judgement (provenance `source`), identity (provenance `identitySource`), and price
  (`monthlyCents` INTEGER CENTS + `costModel` `'flat'|'per_seat'`, exactly one writer:
  `setReviewerCost`; per_seat = unit × `workspaceHumanSeatCount` — distinct human PR
  authors, FIXED 30d window — multiplied on READ, the product never stored). The write rules
  are in Conventions below; the full history (three keys tried, the vendor-identity bug,
  the 0045 fold rules) is [docs/PRO-PLUGIN-AND-ACTIVITY.md](docs/PRO-PLUGIN-AND-ACTIVITY.md)
  § "One bot object". Price rules: per WORKSPACE by deliberate product decision (no
  fan-out, no inheritance on repo moves, **never sum cost across workspaces**); clearing
  is a column write, never a row delete; the two resets (`DELETE …/judgement|identity`)
  are UPDATE + re-derive with a REAL workspace id — never a row delete, never an empty
  scope list — and the identity reset KEEPS the price. `deleteWorkspace` re-homes the
  workspace's repos AND its `workspace_reviewers` rows to Default inside its transaction
  BEFORE deleting (the cascade would destroy manual verdicts and typed prices).
- **`ReviewerRole` has SIX members and EXACTLY ONE of them is the reviewer cohort.**
  `'review' | 'quality_check' | 'dependency' | 'code_agent' | 'release' | 'housekeeping'` —
  what an automation DOES, chosen per workspace from a picker, 1:1 onto an `ActorLane`.
  ⚠ **Every cohort test is `=== 'review'`, never `!== 'quality_check'`.** Those were the
  same answer while there were two roles and became silently wrong at six: the old spelling
  re-admits dependency/code_agent/release/housekeeping into the ROI, behaviour, dedup and
  benchmark sets. Fixed at four sites (`narrowAutomatedIds`, `getBotAnalytics`'s
  `isQualityCheck`, `getBotOverlap`, `bucketReviewers`); `grep -n "quality_check'" ` before
  adding a fifth. The wire field `BotAnalyticsResponse.qualityChecks` and the frontend
  bucket of the same name now hold EVERY non-reviewer role — the names are historical.
  ⚠ **The STORED role beats the login seed on read**, so widening a vocabulary in code does
  nothing for an actor already classified — migration `0053` re-derives `role` for every row
  whose `source <> 'manual'`, and a future vocabulary addition needs the same treatment.
  The five per-family login sets are **DERIVED** from ONE table, `AUTOMATION_VENDORS`
  (login → `{kind, role}`), so the families are disjoint by construction and there is no
  predicate order to get wrong. Hand-mirrored in `sync/bot-detection.ts`; the drift test
  compares it key-by-key AND value-by-value.
- **`AutomatedReviewerKind` carries a brand for EVERY automation family**, not just AI
  reviewers — quality gates, dependency bots, code agents, release and housekeeping
  automation. Before this they all collapsed into `in_house`, the bucket labelled "In-house
  AI" (25 of 37 such rows on the dev corpus were SonarQube, Dependabot, github-actions,
  GitGuardian, Socket, Google CLA and Jit). Classifier step **1b** brands them; migration
  `0054` re-derives `kind` for rows with `identity_source <> 'manual'` and `kind IN
  ('in_house','vendor')`, nulling the cached `label` so the brand name shows.
  ⚠ **`ReviewBotKind` must NEVER absorb them.** It is the AI-reviewer cohort: it drives the
  review-bot badge and keys the rows the cross-org benchmark contributes.
- ⚠ **`getBenchmarkContributions` filters kinds with an ALLOW-list** (`REVIEW_BOT_KINDS`,
  mirrored into `queries.ts`), never a deny-list. Its rows LEAVE THE TENANT and cannot be
  recalled. The old `!== in_house && !== pierre && !== vendor` test was correct only while
  `ReviewBotKind` was the entire branded universe — every kind added above would have passed
  it and shipped a linter into a shared review-bot cohort. Pinned by
  `db/benchmark-vendor-kinds.test.ts`, which goes through the GETTER: a unit test pinning the
  set's contents passed happily while the predicate was mutated back to the deny-list.
- **The Bots card asks for the ROLE first, then offers only that family's vendors** plus
  In-house/custom and Other vendor. ⚠ The role write sits behind an explicit **"Apply role"**
  button, not the select's `change` event: that write stamps `source: 'manual'`, which stops
  the classifier ever re-deriving the row, and a `change` event is not a deliberate act — a
  scroll wheel, an arrow key or the browser restoring form state on reload all fire one (it
  happened during development and silently re-roled a live row). ⚠ `vendorKindsForRole` takes
  the STORED kind as `current` and always includes it: a `<select>` whose `value` is absent
  from its options renders the FIRST option, so the card would show — and then save — a vendor
  the row does not hold.
- **`repos.createdAt` is LOAD-BEARING** — My Turn's per-repo "New PRs" cutoff (per REPO,
  not global; pinned by `db/my-turn-new-prs.test.ts`). There is NO second visibility axis:
  the "watched" columns were dropped in migration 0046.
- `branchCommits` is NOT derivable from `commits` (PR-scoped — a squash-merged PR never
  appears there under the SHA that landed on trunk).
- `autoMergeRequests` is current state, not a log: unique `(accountId, prId)`, re-arm
  overwrites, disarm DELETEs.

### HTTP API

JSON wire, ISO-8601 timestamps; payload types in `packages/shared`; one file per resource
in `api/routes/`, each mapping to a `client.ts` method. The full per-route contract table
is **[docs/API.md](docs/API.md)** — consult it before changing any route's shape. Rules
that hold everywhere:

- **`?workspace=<integer>` is THE scope parameter.** Absent / unknown / unparseable /
  another tenant's id ⇒ the account's DEFAULT workspace — never a 404 (no existence
  oracle, nothing leaks, stale bookmarks degrade to something renderable). Every scoped
  response echoes `workspaceId`. `?repoIds=` survives as data narrowing ONLY, bounded by
  `resolveWorkspaceScope` (`membership ∩ narrow`) — one resolver, not a convention 14
  handlers must remember.
- Client side: send `repoIds` whenever the array exists — **including when empty**
  (`if (ids)`, never `ids.length > 0`; an empty workspace must not widen to the whole
  account) — and every scoped React Query key carries a `ws:<id>` segment.
- Reads are accountId-scoped; id-addressed routes verify ownership → 404. Cloud gate:
  every `/api/*` 401s unauthenticated except `/api/health` + `/api/auth/*`. Claude-review
  routes are only REGISTERED when enabled (local-only).
- `GET /api/workspace-metrics/compare` is DELETED (with the Compare rail entry, its panel
  and `db/workspace-comparison.ts`) — cross-workspace comparison is now the Reports
  "By workspace" axis on the one-report GET, riding the window-pure
  `getPeriodMetricsForWorkspaces` seam; that GET moved to the `search` tier for the same
  cost-multiplies-by-workspace-count reason. `GET /api/daily-brief` (`?rollup=1` adds one
  count line per other workspace) is CORE/FREE, counts only — every figure reuses the
  owning surface's own fold — and also sits on `search`.

---

## Frontend

Full detail (state model, UI regions, timeline internals, PrDetail):
[docs/FRONTEND.md](docs/FRONTEND.md).

Four deliberately-separated state layers: **server state** in TanStack Query (keys built
from filters; PR/thread detail fetched on demand; IndexedDB-persisted with
`staleTime: Infinity` for pr/thread), **filter/selection** in Zustand `store/filters.ts`
(`workspaceId` is the scope), **tabs** in `store/pinnedTabs.ts` (Activity | Timeline +
closable PR/drill-down tabs; exactly one board mounts at a time), **URL** mirrored by
`useUrlState.ts` (serializer diffs against defaults). **App lands on the Activity FEED for
every tier** — the daily `BriefStrip` sits on top of it, and the old one-shot "default to
Insights when Pro is on" effect is gone; the Insights rail entry is labelled **"Reports"**
(LABEL-ONLY — the store/URL value stays `'insights'`). Cloud renders `<SignInGate>` on a
401 from `useMe()`.

Landmines that cost real bugs — read the doc before touching any of these:

- **Bots are HIDDEN by default on Timeline AND Feed**, using the UNION set
  (`hiddenBotUserIds`: `users.isBot` ∪ the workspace's automated reviewers; a manual
  "human" judgement wins BOTH directions). Timeline: `excludeBots` defaults `true`, URL
  emits `bots=0` when shown; the persisted-filter blob migrated v2→v3 SURGICALLY
  (`migratePersistedFilters` drops only the bot keys — never discard the whole blob for a
  default flip). Feed: lens `'hide'` is the transient default and rides the SERVER's
  `excludeBots` (excluded before the page cap); a bot contributor's own activity tab
  derives an effective lens (never written back). `useSearchTimeline` still always sends
  `excludeBots=false` — the Members dropdown's bot listing depends on it, as does
  `rosterTimelineSearch` (which sets it explicitly for the same reason).
- **`workspaceId === null` means "not resolved yet"** — nothing may render
  workspace-scoped data while null. `?workspace=` is the ONE URL param emitted
  always-once-resolved and omitted while null (an unconditional `p.set` writes the literal
  `?workspace=null` on every bare load).
- **`useWorkspaceSync` is three-branch** (null-or-dead / changed / **PRUNE ONLY**) — it must
  NOT keep `repoIds` in lockstep with workspace membership (that kills per-repo show/hide).
  Track the previous id in a ref; a write-only-if-different guard is not sufficient (React
  Query result identity changes on every background refetch).
- Legacy URLs: `?workspace` absent + `?team=<int>` present ⇒ that int IS the workspace id
  (migration 0044 preserved team ids); any other `?team=` form discards `?repos=` too, and
  `repoIds` is always pruned to the resolved workspace's membership before any query runs.
- **`workspaceId` must NOT live in `FilterDefaults`** — persistence and reset share one
  list, so "Clear filters" would teleport the user into Default. It has its own persisted
  slice; `resetAllFilters` preserves it explicitly.
- **The repo picker (`RepoSelectPanel`) is Timeline-ONLY.** Activity, Feed, Bots and
  Reports always cover every repo in the selected workspace — never let the picker scope a
  screen that doesn't render it (pinned by `workspaceOpenPrsScope.test.ts`: of the three
  open-PR search builders, only the Timeline one honours the picker, and the two Activity
  builders stay byte-identical to each other when unscoped so they share one cache entry).
- **Visible sub-tabs are DERIVED, never written back** (`feedInnerTab` 'themes',
  `botsInnerTab` 'advisor'): a scalar may legitimately hold a key the current context
  doesn't render; compute an `effectiveTab` for the render only — a corrective `set…`
  permanently forgets the user's choice. (`botsInnerTab` is down to
  `'roi' | 'advisor' | 'settings'` — 'behaviour' and 'themes' were removed with their tabs and
  did NOT come back when the Themes PANEL did (it sits on the main 'roi' view); the field is
  transient + URL-silent, so member removal is safe. `InsightsSubTab` is GONE entirely: the pane
  is Reports-first, the chat lives inside the report.)
- **Timeline vertical scroll is GATED.** vis virtualizes rows; every programmatic scroll
  goes through `setVisScrollTop` and must claim the gate
  (`intentionalScrollRef` + `scrollLoopRef`) — never write `scrollTop` / call `focus()`
  from a new path or it fights the live loops and jitters (copy `centerShowTarget`).
- `threadStateFilter` is a GLOBAL store field — PrDetail applies it only when
  `selectedPrId === prId`, or a PR opened via tab inherits a stale preset.
- `UserName`'s returned tree SHAPE must not depend on popover-open state (React remounts
  the anchor → detached node → popover in the top-left corner); `usePrBotBehaviour` is
  called before PrDetail's early returns (hooks-order rule).
- Data-derived URLs never go straight into `href`/`src` — `safeExternalUrl()` (React
  renders `javascript:` URLs).
- **The AI surface has EIGHT semantic tokens, and the remaining purple is NOT leftovers.**
  `--ai-surface/-2/-border/-hairline/-ink/-muted/-signal/-signal-fill` are theme-flipping vars
  in `index.css` (`:root` + `.dark`, SPACE-SEPARATED channels — the `--tl-tint` precedent; any
  other format breaks `<alpha-value>` silently) mapped in `tailwind.config.ts`, so an `ai-*`
  class needs no `dark:` twin. `--ai-signal` is the only vermilion allowed to carry/back text
  (darkened from the landing's brand hex to clear WCAG on wash); `--ai-signal-fill` is NON-TEXT
  ONLY. ⚠ **Every surviving `violet-`/`purple-`/`indigo-` hit is a deliberate KEEP** — data
  encoding (event/ML-category/lane/vendor/series palettes, feed category pills) and non-AI
  controls (maintainer shield, merge/auto-merge, deterministic suggested reviewers, Flow
  metrics, timeline tints), plus AI Fix's `DISAGREE_COLOR`, whose comment pins "deliberately NOT
  red" — vermilion recreates exactly that bug. Do not "finish the migration"; the authoritative
  keep-list is in [docs/FRONTEND.md](docs/FRONTEND.md). ⚠ A hex a component DERIVES a wash from
  (`glyph.color + '1a'`) cannot become a var — FeedView's `claude_review` kind carries a
  `className` and skips the style attr instead.
- **The Insights chat is a multi-turn CONVERSATION and the cap is SERVER-side.** Turns live in
  `sprintChatThreads[ws:<id>]`; `SPRINT_CHAT_MAX_TURNS` = 10 counting the live question, and the
  plugin independently re-caps the prior pairs it reads (`CHAT_MAX_PRIOR_TURNS` = 9,
  drift-tested) — a client that sends 25 gets `trimmedTurns` back, not 25 turns of billing.
  ⚠ **The completed turn is appended in `useSprintChat`'s HOOK-level `onSuccess`, never a
  `mutate()` callback**: observer teardown (`chat.reset()` on a workspace switch, or the panel
  unmounting when a PR ref is clicked) kills mutate-scoped callbacks, so a billed,
  server-persisted answer would silently miss the transcript and the NEXT ask would send a
  history missing it. The ask-time workspace rides `onMutate` CONTEXT — the options closure is
  re-swapped on every render while pending. The chart pass gets the grounding MINUS
  `conversation` (CHART_SYSTEM makes everything in DATA a legal chart value, so prior model
  prose would launder hallucinated figures into rendered data, and re-bill every charted turn).
- **The Changes tab renders EVERY thread inline as a collapsed pill, and the path fold is
  RENAME-AWARE.** `indexThreadsByPath` (built ONCE per PR, never a per-row filter) keys on the
  RENDERED path and re-homes a pre-rename thread onto the file's current path — the old fold
  keyed `t.path` while blocks looked up `f.path`, so those threads were invisible. A thread that
  anchors to no row degrades to a FILE-level chip, never disappears, and the tab header counts
  `pr.threads` so the aggregate can't be short by a file beyond the 100-file diff cap. ⚠ The
  BLOCK owns the `consumedFocus` ref, not the pill: the focus target is STICKY and collapsing a
  file unmounts the pill, so a remount would re-open a pill the user closed and teleport the
  view back to it. `ThreadCountChips` is now THE one renderer of the state palette (the
  near-identical `ThreadDots` was deleted); `ThreadCard` is down to **seven** mounts.
- **Sync-round state is a transient store slice** (`syncRound` + `managerOpen`) with ONE
  driver: `SyncStatus` (always mounted in the header, registering its actions via a
  module-level registry). The progress UI embeds INSIDE the WorkspaceManager panel (within
  `panelRef` or click-outside closes the manager); `SyncProgressModal` survives ONLY for
  onboarding adds (`modal:true` iff the manager isn't open).
  Landmines: the signal mailbox is an ARRAY (`syncModalRepoIds` — React 18 batches a
  multi-add loop into ONE effect run; a scalar drops all but the last id); an open
  round's EMPTY `scopeIds` is the all-repos sentinel — never append to it; merging into
  an open round must re-arm `syncing:true` (the poll is disabled without it); the
  `foregroundComplete` handoff excludes `paused.reason==='queued'` rows. Adding a repo
  from the manager AUTO-SWITCHES the active workspace to the destination once the move
  commits (the "synced fine but nothing loaded" fix — the scope used to stay behind).
- **There is ONE bottom-right toast column** (App.tsx): ClaudeReviewBanner, AutoMergeBanner
  and the ambient `GlobalLoadingBar` render as plain cards inside it — never add a new
  independent `fixed bottom-4 right-4` element (three of them were painting over each
  other at the same coordinate). The loading bar covers HEAVY work only: full-mode walks via
  `GET /api/sync-activity` + ML scoring strictly under `isMlScoring`; its ETA treats unchanged
  poll values as no-observation, and its monotonic percent clamp resets on stage/backfill-set
  changes and per-repo regressions (phase 2 legitimately restarts percent from 1.0 → ~0.16).
- **Reactions are fetched ON DEMAND and NEVER STORED** — no column, no migration, no sync
  step. `hooks/useReactions.ts` is a MICROTASK-BATCHED loader: each `ReactionBar`'s
  `['reactions', kind, id]` query fn only enqueues, and one tick's registrations become ONE
  `POST /api/reactions/lookup` (60/batch). Per-PR indexing (the `useMlLabelIndex` shape) could
  NOT serve this — the Feed spans many PRs. The bar renders nothing while state is `undefined`
  (unknown ≠ "no reactions"), the toggle carries a per-target MUTATION key, and these queries
  stay OUT of `shouldDehydrateQuery` (a week-old persisted copy of other people's reactions is
  a lie).
- **The Feed's "CI failures" control is a THREE-state lens, defaulting to OFF.** `feedCiLens`
  cycles `'off'` (default — none fetched) → `'feed'` (rows interleaved chronologically) →
  `'only'` (stream narrowed to CI rows) → `'off'`, so ONE click from rest turns it on. The
  `'off'` boundary is a FETCH toggle riding the feed
  query key AND the head-poll key (a head including rows the loaded page lacks false-fires
  "New activity"); `'only'` is a client-side narrowing that SKIPS the category pills, since
  CI rows are in neither category and the combination could only ever be empty.
  ⚠ **This default has flipped TWICE (off → feed → off) and each flip cost something.** As an
  include-only boolean defaulting off it hid the feature twice over: rows are placed by time,
  so in a busy workspace the newest CI card landed ~23 rows below the fold while the pill's
  count read 34 — indistinguishable from a dead control, while the same code looks perfect in
  a quiet workspace (index 0). **Never ship an include-only toggle whose only feedback is a
  count** — that is why the third state exists. On by default then proved too noisy for a
  first impression, so the default went back off with the always-rendered PILL carrying
  discoverability. It is the ONE feed control that PERSISTS with the filter bar (in
  `FilterDefaults`/`pickFilterBarState`, hence also cleared by "Clear filters") and is
  URL-serialized (`ci=only` / `ci=1`; the `'off'` default is omitted, and both `ci=1` and an
  explicit `ci=0` still read correctly from older links).
  ⚠ **The OMITTED URL value must always track the CURRENT default, and a default flip on a key
  persisted UNCONDITIONALLY needs a `FILTER_STORAGE_VERSION` bump** — v3→v4 drops exactly
  `feedCiLens`, because every blob written under the old default holds a literal `'feed'` no
  one chose, and without the bump the new default would reach new installs only.
  `migratePersistedFilters` steps CHAIN (a v2 blob must land at v4; a per-step early return
  strands it where the version check then discards the whole blob). The legacy boolean
  `feedShowCiFailures` is still DROPPED from stored blobs rather than migrated. Rows are
  actor-less: the server drops them under `botsOnly` or any member filter, and they are
  withheld from `enrichMyTurn` (a null actor is trivially "not you", which would make every
  red build an uncapped My-Turn card).

---

## Merge, CI logs & trunk status (CORE, no AI)

Full detail: [docs/MERGE-CI-TRUNK.md](docs/MERGE-CI-TRUNK.md). The invariants:

- **Every "can this land?" surface resolves through the pure `mergeVerdict()`**
  (`lib/ui.ts`). GitHub's `mergeable` reports ONLY conflict state; `mergeStateStatus` is
  the protection-aware field to lead with. **`unstable` IS mergeable** (only non-required
  checks are red; GitHub's own button merges it); `behind` is not (GitHub 405s).
  `db/triage.ts`'s `READY_MERGE_STATES` and `mergeVerdict`'s `canMerge` must agree, or the
  triage queue and the PR disagree about the same PR.
- The merge queue is GraphQL-only (no REST equivalent; queue presence is not inferable
  from REST). Nothing is synced — state rides the lazy `GET …/merge-options` fetch.
- **Auto-merge ("merge when ready", `merge/auto-merge-runner.ts`) is consent-anchored.**
  It deliberately does NOT use GitHub's `enablePullRequestAutoMerge` (422s on exactly the
  PRs the feature exists for). Arming pins `expectedHeadOid` — consent to merge THE CODE
  THE USER SAW; a head move disarms unless proven to be our own update-merge (three
  proofs, arity-checked); compare-and-set immediately before the merge; write permission
  re-checked at LAND time. **Landmine: `behindBy > 0` is true of most healthy PRs** — only
  `mergeStateStatus === 'behind'` means GitHub is blocking. The UI has exactly ONE way to
  arm: the `MergeWhenReadyControl` button in the Overview Actions row (eligible = verdict
  blocked/behind/unknown OR clean-but-`behindBy>0` — the widening is THIS button's only;
  never gate Merge on `behindBy`), which ALWAYS stores a real `updateStrategy` (never
  `'none'`); while armed the Close button is hidden and a header chip shows the intent
  (`usePrArmedIntent`: the armed list carries 24h-resolved rows, so the predicate is
  `state==='armed'`, never row existence). **Merge-queue repos arm the same way** ("Queue when
  ready"): the intent is stamped `viaMergeQueue` and the terminal action becomes a head-pinned
  ENQUEUE gated on `reviewDecision` — freshen happens once BEFORE the first enqueue, never
  while queued (an update kicks the entry out). `enqueuedAt` is the attribution column, and
  disarm with it set also dequeues (row deleted first — cancel must win). Full contract in
  the doc.
- CI logs are live ranged reads of the signed Actions blob URL — server-side only, NEVER
  returned to a client (it is unauthenticated). Logs are offered for passing checks too.
- Trunk status (`/api/branch-status` over `repos` head columns + `branchCommits`) is
  **informational only** — no attention counts, no badges, no My Turn. Its detail columns
  follow the partial-response write policy (Conventions); the commit→PR map keys on
  `(repoId, number)`, never a bare number.

---

## Claude Review + the Pro plugin

**Claude Review** (agentic PR review, `src/review/`): opt-in, **LOCAL-ONLY**
(`ENABLE_CLAUDE_REVIEW=true`; force-disabled in cloud — the routes are not even
registered). Details: [docs/CLAUDE-REVIEW.md](docs/CLAUDE-REVIEW.md). Non-negotiables:
the agent's tools are read-only with **`Bash` denied outright** (everything it reads from
a PR is attacker-authored), and **no AI SDK ships in npm** — every AI module is reached
only via dynamic `await import()`, and `build-release.mjs` asserts none leak into the
release manifest.

**Pro plugin** (`@pierre/pro`): a PRIVATE git submodule at `packages/pro`
(`git submodule update --init`); all premium logic lives there. The public repo holds only
the contract (`src/pro/contract.ts`), a **path-based** guarded import (`src/pro/bind.ts` —
NEVER a `package.json` dependency; absent submodule ⇒ clean OSS no-op), the capability
passthrough on `/api/me`, and inert seams. Details:
[docs/PRO-PLUGIN-AND-ACTIVITY.md](docs/PRO-PLUGIN-AND-ACTIVITY.md) +
[docs/PRO-PLATFORM.md](docs/PRO-PLATFORM.md). What bites:

- **`apiVersion` is 21 and FOUR literals must agree**: host `contract.ts`, plugin
  `index.ts`, plugin `contract-types.ts`, and `bind.ts`'s runtime gate
  (`plugin?.apiVersion !== 21`) — the actual enforcer. A half-bump silently degrades the
  ENTIRE plugin to OSS mode: capabilities dark, every `/api/pro/*` 404, nothing thrown.
  No test pins it; detection is `tsc` (TS2367 at the gate) + a boot check of `/api/me`.
  ⚠ **The plugin half of a bump lives in a SUBMODULE, so "all four" spans two repos** — the
  gitlink this repo commits must point at a plugin commit carrying the same number, or a
  fresh `git submodule update --init` checks out a plugin the host then rejects.
  ⚠ **Not every contract change is a bump — but "additive" is a NARROW test.** The People
  report widened `getPersonPeriod` with a TRAILING `opts?: {evidence?: boolean}`, added
  `SynthesisScopeKind 'person_report'` + `SynthesisItemKind 'path_area'` + optional
  `StoredSynthesis.sections` / `PersonPeriod.evidence`, and stayed at **21** with ZERO core
  and ZERO plugin migrations — an older plugin calls with four args and type-checks, an older
  host simply never sets the optional field (the `registerAccountErasure` precedent). A
  SPA↔plugin WIRE type (`SprintChatBody.history`, `SprintChatResponse.followUps`/
  `trimmedTurns`, `BotThemesResult`) is not `ProContext` at all and never bumps.
  (20 → 21 is the TIER LINE — ONE bump for the whole calm-consolidation plan:
  `ProCapabilities` gains **`botDepth`** (paid, non-AI depth, gated like `workspaceInsights`)
  and `ProHostQueries` gains FIVE members — `getBotBehaviour`, `getPeriodMetricsForWorkspaces`
  (the Reports "By workspace" axis; no cost fields ever) and three seams declared inert then
  implemented with NO contract change: `getSynthesisInput`, `getDailyBriefCounts`,
  `getPersonPeriod`. 19 → 20 was period-over-period reporting; 18 → 19 "fix from comments"
  (`CodingSeam.generateFix` gains OPTIONAL `commentVerdicts`); 17 → 18 widened
  `getBotAnalytics`'s `window` to `kind | {kind, fromMs, toMs}` and added `'rolling_90'`.
  16 → 17, 15 → 16, 14 → 15 and the per-bump detail are in the topic doc's apiVersion history.)
- **A RESOLVED thread is now judged too, and that flips the question rather than cancelling
  it.** `enumerateCombinedUnits` used to emit no `addressed` slot when `isResolved` — 40% of a
  real workspace's threads, and precisely the population where someone has already CLAIMED it
  was addressed. Resolving is a click, not evidence. The prompt branches on
  `human_marked_resolved`, `isResolved` is in the hash (`t2|` → `t3|`), and the panel is
  retitled "Resolution check". ⚠ The legacy per-item `resolution-check/routes.ts` writes the
  SAME row, so it had to learn `isResolved` in lockstep — a field in one writer's hash and not
  the other's makes each mark the other's row stale forever and re-bill paid work.
- **The hydrated anchor hunk is PROMPT CONTEXT ONLY and must never enter a payload hash.**
  `currentHashFor` recomputes every stored row's hash on the free cached annotations GET fired
  on every PR open — a path that hydrates nothing — so a hydrated value in the hash makes the
  GET and the run disagree forever: every judgement permanently `stale`, re-billed on every
  click. The hunk reaches the prompt through the ONE accessor `hunkFor`;
  `validityPayloadHash` still reads the STORED `root.diffHunk`. Hydration is once per RUN
  (`hunkHydrationDone`), inside the batch loop, after the cache filter (a per-batch fetch is 9
  identical calls on a 50-target run). Pinned by `annotations-combined-targets.test.ts`.
  ⚠ If `PERSIST_BODIES=true` ever becomes the default, or anything starts writing `diff_hunk`
  back, every stored validity row flips stale at once — `writeBackNullBodies` leaves that
  column alone ON PURPOSE.
- **The evidence window's base anchors on the thread's ROOT comment, never its last.**
  `addressedWindowFor` is the ONE copy of that rule (resolution-check imports it, exactly as
  it imports the hash). Last-comment anchoring collapsed the window to `base === head`
  precisely when the fix had WORKED — fix lands 12:23, someone replies "addressed" 12:28,
  the compare short-circuits `identical`, the prompt reads "NONE — the file was not
  modified" and `ADDRESSED_RULES` (correctly) calls that strong evidence of non-fixing:
  `not_addressed` at 95% on a thread whose fix sat in its sibling thread's evidence patch.
  Root anchoring makes an empty compare TRUE again ("nothing landed since the concern was
  raised"), which is why the note/section wording says that and not "since the last
  comment". `commits_after_last_comment` still counts from the LAST comment — different
  question, separate hash field.
- **The grounded `addressed` check has three cost landmines** (full contract in
  [docs/PRO-PLUGIN-AND-ACTIVITY.md](docs/PRO-PLUGIN-AND-ACTIVITY.md)): the payload-hash prefix
  moved `t1|` → `t2|` → `t3|` → **`t4|`** (the last FORCED — `baseSha` is in the formula, so
  the window re-anchor moved every row's hash anyway) and carries the `(baseSha, headSha)`
  PAIR, never the diff TEXT — both writers call the ONE exported
  `addressedThreadPayloadHash` + `addressedWindowFor` rather than hand-copying either;
  the fetch must stay INSIDE the batch loop, AFTER the hash-cache filter / run gate / credit
  check (per-item route: after its cache-hit short-circuit), or a fully-cached click reporting
  `generated: 0` still spends GitHub quota; and the evidence must be spliced INSIDE the
  `want.has('addressed')` branch of `combinedItemBody`, never into the shared `Diff context`
  block above it (that block also feeds *validity*/*simplify*, whose per-kind hashes would not
  change — the drift would be invisible).
- **A stale `packages/pro/dist` shadows `src` in dev.** `bind.ts` prefers `src/index.ts`
  outside production and LOGS the entry it bound — the first thing to check when a Pro
  route unexpectedly 404s.
- `ctx.schema` is `Record<string, any>` — a leftover `ctx.schema.teams` type-checks,
  evaluates to `undefined`, and throws only when the query runs. Grep, don't trust the
  compiler.
- Tiers — **free gets the verdict, paid gets history/depth/explanation**: **core** (free —
  feed/timeline/My Turn, the Bots ROI table with keep/tune/noisy verdicts + ML severity
  columns + the Inflation column's CURRENT-WINDOW counts, Settings classification, the
  daily-brief COUNTS strip, the per-PR `BotTriageCard` deterministic grade — no AI) ·
  **pro** — **`botDepth`** (paid, NON-AI: the per-bot depth tab, workspace charts, the
  inflation weekly sparkline/history, the per-seat cost overlay — its `PUT …/cost` write
  402s without it), `activityDigest` (synthesis verdicts + brief narration),
  `periodReports` (Reports + 1:1 prep), all on the paid summary tier · **pro+** (AI
  Analysis + AI Fix + Claude Review, all gated together by the ONE flag
  `PRO_ADVANCED_AI_ENABLED`).
- **AI Fix has FOUR seeds** (`AiFixSeed`) and the newest one, **`'comments'` ("fix from
  comments")**, is a picker + basket on the AI Fix tab: the chosen comments become a numbered
  prompt list, the agent must **judge each comment's validity BEFORE fixing it**, and it reports
  per comment — including an argued **pushback** the user can send as a reply with one click
  (nothing posts itself). Same single run, same one commit, same push flow. Stored in two
  nullable JSON columns on `ai_fixes` (plugin migration `0024`), joined by the `C<n>` ref label
  the PLUGIN's prompt assigns — core's `submit_fix` carries the verdicts without knowing what
  the items are. Landmines: `resolveSeedText` short-circuits on `input.seedText` before any
  seed-kind branch; the seed text was the ONE uncapped input in the fix prompt; the prompt is
  rendered and STORED at start time so bodies/hunks are frozen; this seed WIDENS the
  attacker-authored channel to every comment dragged in (fencing is the whole mitigation); and
  it must never get its own queue/slot (the worktree is keyed on the SHA alone). Full contract:
  [docs/PRO-PLUGIN-AND-ACTIVITY.md](docs/PRO-PLUGIN-AND-ACTIVITY.md) § "Fix from comments".
- **The Bots "Themes" panel is BACK, merged with the deterministic layer** (`bot-themes/
  build.ts` + `routes.ts`, `GET`/`POST /api/pro/bot-themes[/refresh]`, still over the
  never-dropped `bot_theme_reports` table — no migration). It replaces the `SynthesisCard`
  mount on the MAIN Bots view **only**; the three drill-down SynthesisCards
  (BotVolume/BotFlagging/BotThreads) and the seam's `'workspace-bots'` kind are untouched.
  ⚠ **Its two figure classes are NOT both exact and the copy must say which is which.**
  Per-theme `commentCount` is a code fold of code-derived counts (Σ each cited cluster's `count`
  over the model's DEDUPLICATED validated memberIds), as are per-bot volume/acted-on and the
  area split; the model's `occurrences` (the legacy `≈` fallback) and the category/severity
  rollups built from it are ESTIMATES — an earlier draft captioned the whole panel "exact". The
  revival also re-fixed three legacy defects: the payload hash DROPPED the day-quantised
  `windowKey` (it re-billed every dormant scope daily) for a version literal `bt2`; the refresh
  claims its per-account slot SYNCHRONOUSLY with the credit check INSIDE the try/finally (the
  legacy `await` sat in that gap, so two POSTs both passed and both billed); and `VALID_WINDOWS`
  had to learn `rolling_90` or a valid client window cached the wrong population.
- ⚠ **The D4 digit gate rejects UNICODE numerals, not `[0-9]`.** The synthesis prompt's input is
  attacker-authored, and "write the count in full-width digits" walked straight through the ASCII
  spelling — `２３`/`٣` (Nd), `²` (No), `Ⅻ` (Nl) all read as numbers. It is now
  `/^[^\p{Nd}\p{No}\p{Nl}]*$/u`. Spelled-out counts stay a prompt-only rule.
- Generation is cost-gated everywhere: payload-hash caches (**the hash must zero
  `Date.now()`-derived fields** or a dormant repo re-bills hourly), per-account
  serialisation + intervals, credit metering (`AI_CREDITS_PER_USD` = 1250, inlined in
  TWO places — `shared/types.ts` + `db/credits.ts`; the plugin's third copy is gone).
- The plugin owns its own dual-dialect tables/migrations/isolation test; plugin migrations
  take NO `--> statement-breakpoint` and their pg twins wrap in `DO $$ … EXCEPTION`
  warnings (a plugin-migration failure is TOTAL and SILENT — OSS-mode degrade).
- **Bot Tuning Advisor** (Pro, gated like `workspaceInsights` via the `botAdvisor`
  capability): turns the graded-comment corpus into evidence-backed config changes per bot.
  CORE computes deterministic evidence CELLS (`getAdvisorFindings` — (bot × path-bucket) /
  (bot × category) / (bot × partner), floors + the path-coverage disclosure — plus the
  `getBotEffectPanel` verification math and `db/changepoint.ts`); the PLUGIN
  (`packages/pro/src/advisor/`) derives intents, runs the emitter adapters (CodeRabbit,
  Greptile, Copilot/generic prose with a managed `limn:advisor` marker block) and serves
  `/api/pro/advisor/*`. Outputs: brief (default until a tuning PR merges) / config PR (via
  `commitFilesAndOpenPr`: default-branch worktree → NEW branch, never force, workflow paths
  refused, `visible:false` copy contract; `POST …/preview` is the writes-nothing dry-run on the
  same gate chain) / GitHub issue. Non-negotiables: the recommendation text is TEMPLATED, never
  model-generated — the ONE LLM touchpoint (`refine/`) rewords prose inside the marker block
  behind a deterministic diff-guard, and `llm-isolation.test.ts` pins that the deterministic
  modules cannot reach it; the mandatory retro-check gate 422s any suppression it cannot
  simulate; **a cell with ANY acted-on high-severity finding never earns a full suppress** (the
  veto — it downgrades to the nit-scoped QUIET_PATH_NITS when the path is nit-dominated, else to
  silence); **a suppression needs ≥1 untouched thread on a PR that has since MERGED** (the
  merged-past gate — open-PR silence is not final; the same signal is the ROI table's "Merged
  past" column, keyed on window `mergedAt`); path cells are adaptive-depth (`a/b/**` when that
  prefix meets the floor, the coarse `a/**` only when no child does — emitted globs never
  overlap); nothing the advisor computes may feed `botVerdict`. Config events
  (`advisor_config_events`) anchor the before/after effect panel — measurement stays
  independent of emission. Full detail:
  [docs/PRO-PLUGIN-AND-ACTIVITY.md](docs/PRO-PLUGIN-AND-ACTIVITY.md).

---

## Period reporting + effort-vs-automation (Insights → Reports)

A stored, forwardable artifact per completed period ("5 Aug – 19 Aug"), its comparison against
the prior one, and a refusable forecast. **Metrics are CORE** (`db/period-metrics.ts`,
`db/forecast.ts`, `db/actor-lanes.ts`); storage, narration and routes are plugin-owned
(pro migrations `0025`/`0026`). The invariants:

- **Every metric is WINDOW-PURE** — a function of events timestamped in `[fromMs, toMs)`, with
  a TWO-SIDED predicate on every column. A stored historical period must stay reproducible, so
  no "as of now" snapshot may enter the vector (hence no `openPrs`, no `ciFailingNow`).
- **Retroactive history is COVERAGE-BIASED.** Merged PRs by fortnight read 39 → 570 over six
  months while contributing repos read 4 → 18: the "trend" is repo onboarding. Hence
  `getPeriodCoverage`, the stable-SUBSET comparison, and a forecast that REFUSES rather than
  fitting a line through an artifact.
- **ONE ROW MUST NEVER MIX THE HEADLINE AND SUBSET POPULATIONS.** The headline is the full
  membership, the delta is the coverage-stable subset — `rowFigures()` is the one place that
  decides, because rendering `117 | 146 | −33` where 117−146 = −29 is the defect this feature
  shipped three times in one build.
- **`PERIOD_METRICS_SCHEMA_VERSION` is 2 and is folded into `payloadHashFor`**, so a bump is
  self-executing: every stored row goes `stale` and regenerates on the next read. Three
  spellings (shared, core, plugin) kept in lockstep; a drift test pins the key list.
  ⚠ **v1 → v2 was a CORRECTNESS fix, not a feature.** v1's `median_time_to_first_review_hours`
  read `pull_requests.first_review_at`, which records whoever reviewed FIRST — so on a
  workspace where `github-actions[bot]` auto-approves on push it reported **0h across 115 PRs
  against a real human median of 18.3h**. It is renamed (never redefined in place, so a v1 and
  a v2 row can't be subtracted under one key) to `median_time_to_first_human_review_hours` and
  computed from the `reviews` table with a lane filter. Same release added the human-only twins
  `human_merged_prs` / `median_human_pr_size_lines` (blended PR size read 68 — Dependabot's 14
  mixed with the humans' 142, a number no PR resembled) and `automation_merge_share_pct`.
- **A `_pct` metric MUST join `PCT_METRIC_KEYS`** in the plugin or its forecast projects an
  impossible number. That is a silent defect, not a compile error.
- **Seven `ActorLane`s, and the vector's human-only figures come from the same resolver the lane
  panel does.** Automation contaminates different metrics depending on what it DOES — a
  dependency bot inflates throughput, a quality gate inflates review counts, an AI reviewer's
  volume is the only automation volume that means anything. The dependency/`code_agent` split
  resists collapsing: both author PRs, but a merged bump is overhead and a merged agent PR is
  delivered work.
- ⚠ **"Time until a person reviewed it" has ONE fold** (`loadFirstHumanReviewHours`), read by
  both the vector and the lane panel, which render one directly above the other. They had two,
  and reported 18.16h and 18.27h on the same screen under a caption saying they were the same
  measurement — because the lane fold looked only INSIDE the window, so a PR reviewed in an
  earlier period counted as freshly reviewed. **The all-time lookback is load-bearing** and must
  not be "optimised" back to the window; the candidate ids travel as BIND PARAMETERS, which is
  why that scan has its own much smaller cap (`PERIOD_FIRST_REVIEW_PR_CAP`).
- The automation set is the lane resolver's **UNION** (workspace verdict ∪ `users.isBot` ∪ the
  login vocabularies, minus manual humans), not `automatedReviewerUserIds` alone — real accounts
  carry `dependabot` and `dependabot[bot]` as two rows with one of each pair at `automated = 0`,
  which is what put bot text in `human_review_comments`.

**The People report** (Reports → People → "Begin report") — a multi-select picker of humans AND
bots, one report with a SECTION per pick. Full contract:
[docs/PRO-PLUGIN-AND-ACTIVITY.md](docs/PRO-PLUGIN-AND-ACTIVITY.md) § "The People report".

- **PREP, NOT SCORING survives the widening.** The multi-select is sanctioned; a cross-person
  SHAPE is not — sections ALPHABETICAL by label (humans/bots interleaved), no ranking, no
  cross-person sort by any metric, no comparison table, and `getPersonPeriod` KEEPS its
  one-person-per-request shape (the CLIENT loops; still no batch/list spelling anywhere). The
  guardrail comments in `db/person-period.ts`, plugin `person-routes.ts` and
  `PeriodPeopleSection.tsx` were REWORDED, not deleted.
- ⚠ **The section used to list the ACCOUNT's users** — every workspace's humans under every
  workspace's Reports pane. The roster is workspace-scoped through the ONE extracted builder
  `hooks/useMemberSections.ts` (`inScopeRepoIds` = the whole workspace's membership,
  `includeRosterRemainder: false` — that remainder WAS the bleed).
- ⚠ **The picker must NOT read `useSearchTimeline`/`useSearchOpenPrs`** — both carry TIMELINE
  BOARD state (`filters.repoIds`, plus the Range preset) whose controls aren't mounted on the
  Reports pane, so a narrowing left on the board silently dropped workspace members with no
  visible cause (the `RepoSelectPanel` rule at the timeline grain). It uses
  `rosterTimelineSearch`/`useRosterTimeline` + `useWorkspaceOpenPrs`; pinned by
  `apps/frontend/test/peopleRosterScope.test.ts` in the `workspaceOpenPrsScope` idiom.
- Evidence is **ADDITIVE ON THE SAME FOLD**, never a sibling: `?evidence=1` widens each windowed
  scan to a capped `ORDER BY … LIMIT` over the IDENTICAL predicate (the medians hand back their
  sample PRs through the folds' own sinks), runs every guardrail once, never moves a cell.
  `verify:isolation` 166 → 169 for this arm — including the GLOBAL `commitFiles` path-area reach,
  tenant-safe only because it is joined through tenant-proven commit shas.
- ⚠ **`PERSON_REPORT_VERSION` (now 2) is KIND-SCOPED staleness** — it prefixes every evidence id
  `pe<v>:`, so a `person_report` prompt edit bumps IT, never `SYNTHESIS_PROMPT_VERSION`. And a
  version literal only reaches the hash through an id that EXISTS: two ordinary inputs carry zero
  evidence items, so a constant `pe<v>:none` sentinel is minted for that slice or those rows read
  `stale: false` forever and serve the old prompt at $0.
- ⚠ **`getBotAnalytics` honoured an explicit `toMs` in only TWO of its folds** — the thread scan,
  `mergedPastRows`, `getMlWindowAggregates` and `countUnlabelledBotText` were `>= from` with no
  upper bound, so ONE ROW mixed two window populations at the bot grain. ⚠ **The first fix was
  itself wrong:** applying `lt(col, to)` UNCONDITIONALLY excluded rows written in the CURRENT
  SECOND under the enum form (`to ≡ Date.now()`; these columns are second-granular on sqlite),
  which flaked `verify:isolation`. The rule is
  `const toBound = typeof window === 'string' ? null : to;` — upper predicate for EXPLICIT bounds
  only, which also keeps every enum-form scan byte-identical to the drill-downs over the same
  rows. Explicit bounds are half-open `lt`, never `lte`.

## ML severity/category on bot comments (CORE, free tier, no LLM)

Every bot-authored review comment / PR comment / review body is labelled with a **severity**
(`nit`·`minor`·`major`·`critical`) and up to eight **categories** by the `severity-api`
microservice from the **`packages/ml`** submodule (fine-tuned ModernBERT ONNX on CPU + a
deterministic marker parser). Badges render on the comments; the Bots rail shows ONE merged
table (ROI + severity columns over ONE shared window — the ML fold rides `getBotAnalytics`
via `ml_comment_labels.targetCreatedAt`; `/api/bot-severity` is DELETED — the fold has no
other serving route). Full detail: **[docs/ML-SEVERITY.md](docs/ML-SEVERITY.md)**. The invariants:

- **`SEVERITY_API_URL` IS THE WHOLE GATE.** Unset ⇒ no worker, `/api/me` reports
  `mlSeverity:false`, the SPA issues zero ML queries. That is also what keeps the feature dark
  under `npx pierre-review` (which ships no model). The flag is a **top-level** `MeResponse`
  field, NOT part of `pro` — `entitledProCapabilities` zeroes that object for free cloud
  accounts, i.e. exactly this feature's audience.
- **Enrichment is a PULL-BASED BACKGROUND WORKER (`sync/ml-enrichment.ts`), never a sync step.**
  Inference cost tracks TOTAL TEXT (measured: 32 short comments 2.7s vs 32 long ones 28.4s;
  ~17.5k items ≈ 7M chars ≈ an hour locally), and `persistPr` runs entirely inside
  `runTransaction` — an awaited `fetch` there holds the single sqlite write lock across network
  latency. The worker re-derives "bot text with no label yet" every tick, which is ALSO why
  webhook/post-write paths need no hook and why a bot classified later (workspace_reviewers rows
  are written LAZILY, on a read of the Bots tab) brings its whole backlog with it.
- **The batch budget is CHARACTERS, not items** — a batch pads to its longest member, so the
  worker sorts candidates by length before packing (`config.mlBatchMaxChars`, 128-item cap,
  service hard cap 256). Results are zipped POSITIONALLY; a length mismatch throws rather than
  attaching one comment's severity to another.
- `ml_comment_labels` is keyed `(accountId, targetKind, targetId)` — `targetId` lives in THREE
  id spaces (`reviewComments`/`prComments`/`reviews`), so every lookup carries the kind
  (`PrDetail` renders PR comments and review bodies in ONE list, where this is easiest to get
  wrong). Cleanup rides the cascading `pr_id` FK, so it is deliberately in NEITHER delete path
  (the `search_index` precedent) but IS in `accountScopedTables()`.
- Reads only: three DB-only routes, no generate endpoint, nothing billable. The badge NEVER
  fetches — every mount reads the one `['ml-labels', prId]` per-PR index.
- **A SYNC HAS TWO HALVES and the UI must show both.** The walk stores the text; this pass makes
  the badges, and it always FOLLOWS the walk. The enrichment kick therefore sits **above**
  `clearSyncProgress` in `runSyncForRepo`'s `finally` — it used to sit below, which put the model
  calls structurally downstream of "done" and left no window in which any indicator could
  represent them. That works only because `runMlEnrichmentTick` flips `running` before its first
  `await`; an `await` added above it reopens the gap (pinned by `sync-manager.test.ts`).
  `GET /api/ml-status` (account-wide, NO scope — the worker's own grain) feeds the header
  spinner, the sync-menu line and the modal's scoring row. ⚠ **`pending > 0` is NOT "scoring in
  progress"** — go through `isMlScoring`. Backlog with nothing draining it is a real state
  (service unreachable, worker backed off, a rejected comment blocking its workspace), and
  spinning on it is a worse lie than the premature "done" this replaced.
- **The vendor's own severity badge is stored to be SHOWN, never to be BELIEVED** — on the
  adjudicated gold-300 it is the worst of the three raters (0.474 exact vs our 0.700) and tuning
  towards agreement with it measurably degrades us, so it must never be an input to the model.
- **The severity INFLATION index** is now the ROI table's **Inflation column**
  (`BotVendorAnalytics.mlInflation` — per-bot over/under-call counts, CURRENT-WINDOW =
  FREE; the ≤12-week `weekly` sparkline/history ships only under the paid `botDepth`
  entitlement, ABSENT — not empty — for free accounts). The old two Behaviour-tab charts
  are gone with that tab, but their rules survive the move: it counts only the BADGED
  findings, so a bot that badges nothing is **OMITTED and NAMED**, never drawn as a zero —
  no badge is silence, not agreement. Numbers are counts, never shares, and a clicked
  count IS the flagging drill-down's `filteredTotal`. The bot + direction ride the STORE
  SEED, because two cells open the same `findings` selector and the tab chip would
  otherwise read "Flagged · Findings" twice; `refineQueryKey` therefore carries a
  `|bot:<id>|` slot.
- Advisory: macro-F1 ≈ 0.66 (0.700 exact / 0.303 ordinal MAE on the gold-300, at the human
  ceiling) and CRITICAL is under-recalled, so the product buckets **major+critical as "high"**
  and nothing auto-acts on a label.

---

## Security & privacy

**Read [docs/SECURITY.md](docs/SECURITY.md) before touching `app.ts`, CORS/CSP, rate
limiting, auth plumbing, or any AI route.** Two zero-dependency core plugins own the
posture: `api/plugins/security.ts` (per-surface CSP, CORS allowlist, cross-origin + host
guards, HSTS) and `api/plugins/rate-limit.ts` (fixed-window buckets keyed by accountId).
Always-true rules:

- **CORS is an allowlist in BOTH modes** — local allows loopback origins only (reflecting
  any origin was the audit's one CRITICAL: local has no auth, so any open page could read
  the whole synced dataset); cloud allows exactly `APP_BASE_URL`. The cross-origin guard
  (blocks cross-site state-changing POSTs CORS still delivers) and the host guard
  (DNS-rebinding) are separate protections, not redundancy.
- When picking a rate tier, **follow the token**: "this route is DB-only" rots (it did,
  twice — and once a test was pinning the wrong answer). The expensive Claude-Review paths
  are matched EXPLICITLY in `tierFor` (they don't live under `/api/pro/`).
- 5xx bodies are generic in cloud (4xx stay verbatim); pino `redact`s outgoing auth
  headers; the sealed GitHub token is NEVER in the account export.
- GDPR is self-service: `GET /api/me/export` + `DELETE /api/me/account`; erasure iterates
  `accountScopedTables()` (a tested checklist — see Conventions) and calls the plugin's
  `registerAccountErasure` hook. GA4 is consent-gated in both bundles; the brand font is
  self-hosted.

---

## Conventions & gotchas

- **Relative imports carry an explicit `.js` EVERYWHERE — backend AND frontend.** What
  differs per package is the tsconfig `moduleResolution`, not the import style: the backend
  is **NodeNext**, which REQUIRES `./foo.js`; the frontend is **Bundler**, which merely
  ALLOWS it (TS and Vite both map `./foo.js` → `./foo.ts`). The repo writes it either way —
  760 relative imports under `apps/frontend/src` use `.js`, 3 (all of `Wordmark`) do not —
  so match the code, not the resolver. (This line used to say "frontend — no extensions".)
- **`apps/backend/src/db/queries.ts` CONTAINS LITERAL NUL BYTES (~offset 132k)**, so search
  tools treat it as BINARY and quietly under-report: `rg` prints only the matches BEFORE the
  first NUL and then says `binary file matches`; a `grep` that skips binaries (`-I`, which
  some wrappers set) prints NOTHING and exits 1. Either reads as "the symbol isn't there".
  Any audit of that file must use `grep -a` / `rg -a` (and `git diff -a` for its diff) —
  this produced a real false-negative "confirmed clean" pass.
- **The `shared` package is the only bridge.** Never import backend↔frontend directly — go
  through `@pierre-review/shared` (types only; no build output).
- **Two schemas, kept in sync BY HAND.** Edit **both** `schema.sqlite.ts` + `schema.pg.ts`
  (`schema-parity.test.ts` fails on drift), then `pnpm db:generate` (sqlite migration, commit
  it) **and** `pnpm db:generate:pg`. Prefer hand-writing additive sqlite migrations over a
  full `db:generate` (the schema is hand-written since `0008_multitenant_accounts`).
- **Dual-dialect query layer = portable async only** — `await q.execute()` /
  `.returning().execute()` / `runTransaction`; never `.get()/.all()/.run()` or
  `db.execute(sql)`. See **Deployment modes**.
- **Per-account isolation is load-bearing.** Every list/feed query filters by `accountId`;
  every id-addressed read/write scopes ownership (→ 404). New id-routes: run
  `verify:isolation`. Tokens come from `getAccessToken`, never a module cache.
- **THE SCOPE IS ONE INTEGER. Do not reintroduce a scope vocabulary.** There is exactly one shape —
  a workspace id — with no sentinels, no wire strings, no canonicalisers and no parsers. Its
  predecessor `TeamScope` (`'all' | 'none' | 'teams' | number | number[]`) needed five client
  canonicalisers and three server parsers, and shipped a real bug: `teamSetToScope` collapsed a
  FULL selection to the `'teams'` sentinel and a ONE-team selection to a bare number, so neither
  `Array.isArray` nor `=== 'teams'` caught every case. Anything that would need a helper to
  answer "which repos is this scope?" is a sign the union is coming back.
- **`BotScope { workspaceId, repoIds }` — two named fields, because they answer different
  questions.** The WORKSPACE decides who counts as a bot; the REPO LIST narrows which data is
  measured. The old single `repoIds: number[] | null` conflated them and let a call site transpose a
  number and a number[] or forget which one the verdict came from. `null` is gone; `[]` means "this
  workspace is empty" and is an ordinary state. **A `BotScope` is only ever constructed by
  `resolveWorkspaceScope`**, whose contract guarantees `repoIds ⊆ the workspace's membership` — no
  handler builds one from `parseIntList(q.repoIds)` directly.
- **A fact lives at exactly ONE grain — never denormalise one onto the other.** Judgement, identity
  and price are all facts about `(account, workspace, actor)` and live in ONE row. When `kind`/
  `label` were REPLICATED across an actor's repo rows, held consistent only by convention, that
  carried three standing obligations (a new repo row had to SEED them from its siblings; `persist`
  had to gate on two provenance flags in one row; "the account-wide identity" was a read of *any one
  of them*, which elects a winner the moment two disagree) and one live bug. The lesson survives the
  merge unchanged — what is different is that the guard is now provenance columns and narrowed
  `set:` objects rather than a table boundary. See [docs/PRO-PLUGIN-AND-ACTIVITY.md](docs/PRO-PLUGIN-AND-ACTIVITY.md) § "One bot object".
- **When a unique index CHANGES, every `onConflictDoUpdate` on that table must change with it.**
  A stale target **type-checks perfectly** and raises "no unique or exclusion constraint matching the
  ON CONFLICT specification" at RUNTIME, in both dialects, **only when a row is actually written** —
  so an insert-only test never reaches the branch. The bot writers took this hit twice in a row
  (`0042` re-keyed to 3 columns, `0045` re-keyed the 3 columns again), and the current inventory is:
  `reviewer-classify.ts` `persist` and every `queries.ts` bot writer target
  `[accountId, workspaceId, authorUserId]`; `assignReposToWorkspace`, `upsertRepo`'s membership
  insert, `ensureRepoMemberships` and `ensureDefaultWorkspace` target `[accountId, repoId]` /
  the `workspaces` uniques; `deleteWorkspace`'s reviewer re-home targets the 3-column bot key.
  `grep -n onConflictDo` over both trees and check every hit against its table's declared unique.
- **Every read of the bot table needs an EXPLICIT workspace predicate.** With one row per
  `(account, workspace, actor)` there is nothing to fold — `resolveJudgements`/`resolveIdentities`
  merged into `resolveWorkspaceReviewers(accountId, workspaceId)`. ⚠ **But the old failure is worth
  remembering when writing a NEW read**: helpers that collapsed a multi-row table one-row-per-author
  (`new Map(rows.map(…))`, `limit(1)`, no `ORDER BY`) returned rows in **heap order, which flips
  after any UPDATE on Postgres**. Go through `resolveWorkspaceReviewers` and the helpers over it
  (`automatedReviewerUserIds` / `classificationKindForUser` / `reviewerRoleForUser` /
  `classificationLabelMap` / `reviewerCostForUser` — **all of them now take a workspaceId**, since
  every one of those facts is per workspace). The only account-wide sweep is the benchmark, and it
  gets two explicitly named `…ForAccount` functions rather than a null sentinel.
- **Landmine — `persist()` must NOT share one values object between insert and `set:`.** It did, and
  that was correct while the table held one grain. With judgement + identity + price in one row a
  shared object overwrites a human's vendor name on every auto pass — and if `monthlyCents` ever
  crept into it, every auto pass would silently wipe the price the user typed. It now builds the
  `set:` per workspace from the two stored provenance flags and emits no statement when neither half
  may be written. Two properties inside it are also load-bearing: `role` is **DERIVED** there from
  the local quality-check list rather than round-tripped off the caller's classification (otherwise
  the migration's role fold is re-written from a stale default on the next pass and SonarQube goes
  straight back into the review-bot metrics — the `ReviewerClassification` parameter is role-LESS on
  purpose so this cannot be reintroduced), and `persist` **reads the stored rows and NARROWS the
  write list** rather than using a `setWhere`, which drizzle spells differently per dialect while
  `db` is pg-typed.
- **A target with no stored annotations must render NOTHING and issue NO request.** `ThreadAssessment`
  rendered its bordered panel unconditionally whenever the Pro tier was on, behind a hook keyed PER
  THREAD at ~5 DB queries a call — so a 60-thread PR fired 60 requests to draw 60 empty boxes, and
  `ThreadCard` is mounted in **eight** places (Threads tab, feed, search results, attention cards,
  Pro themes drill-down, diff view). Every judgement now reads the ONE shared per-PR
  `useAnnotationIndex` query and returns `null` when the target has none.
- **A feature can be fully built, correctly gated, and completely UNREACHABLE — grep for the
  mount.** `CiAnalysisCard`'s own comment said "the copy mounted inline on the Overview tab" and
  its tier was correctly moved from the pro+ `aiFix` to the cheap `prSummary` — but the only
  mount was inside the pro+ **AI Fix tab**, so no summary-tier user could ever reach the CI
  diagnosis. Only the tier change had landed. When a change says a component "now renders in X",
  the check is `grep '<Component'`, not the diff of the component.
- **Two mounts of one paid-generation card must share the MUTATION key, not just the query key**
  (`useIsMutating({mutationKey})` — `CiAnalysisCard`, `useRefreshBotThemes`): per-mount
  `isPending` resets to "Generate" on a tab switch mid-run, inviting a second BILLED POST.
- **Open-core boundary (`@pierre/pro`).** Premium code lives ONLY in the private submodule
  `packages/pro` (`alexwakeman/pierre-pro`) — never commit it into this public repo (only
  `.gitmodules` + the gitlink are public). The public repo holds just the contract, the
  path-based guarded import, the capability passthrough, and inert seams (an emitter with zero
  subscribers, an optional prompt string). Never add `@pierre/pro` to any `package.json`
  `dependencies` / lockfile / `build-release.mjs` allowlist — `bind.ts` loads it by FILE PATH
  so `pnpm install` works without the submodule. The plugin ships its **own** dual-dialect
  tables + parity + migrations + isolation test (core's `verify:isolation` can't see plugin
  tables). Bump `apiVersion` on any breaking `ProContext` change; `bind.ts` log-and-degrades.
- **Landmine: the plugin ENTRY ORDER flips by environment, and a stale `dist` shadows `src`.**
  `packages/pro/dist` is built only for the `--with-pro` release image, is gitignored, and nothing
  in the dev loop refreshes it — so with `dist` first, `pnpm dev` silently froze the plugin at
  whenever it was last built: every route added afterwards 404'd while the plugin looked perfectly
  healthy (capabilities on, older routes serving). `bind.ts` now prefers `src/index.ts` unless
  `NODE_ENV=production` (where no `.ts` loader exists), and **logs the entry it bound** — the first
  thing to check when a Pro route unexpectedly 404s.
- **Keep `/api/timeline` lean** — no bodies/diff hunks; fetch detail on demand via
  `/api/prs/:id` (hot path).
- **A new route that spends money or GitHub quota needs a rate-limit TIER.** Add it to `tierFor`
  in `api/plugins/rate-limit.ts` (and to `rate-limit.test.ts`) — the default is the generous
  600/min `read` bucket, which is silently wrong for an LLM call or a GraphQL walk. Spell the
  route's **EXACT path segment** into `hitsGithub`: the alternation had `comments`/`reviews` in
  the plural while the routes are `/comment` and `/review-comment`, and omitted `close`,
  `ci/rerun` and `request-reviewers`, so five GitHub-write routes silently sat on the `read`
  bucket. Nothing errors — the tier is just wrong.
- **A new GitHub-write route must either stamp its row locally or resync-and-verify.** A write is
  not done when GitHub 201s: the SPA re-reads from the local DB, so anything the sync hasn't
  observed yet is invisible and the UI ends up promising "on the next sync". Most write routes
  stamp the affected row themselves. `POST /api/prs/:id/review-comment` is the one that CAN'T —
  REST returns the comment's ids but not the enclosing review THREAD's node id, so a forged local
  row would have no reply/resolve identity — and it instead runs the tail in
  `sync/resync-after-write.ts` (bust hydration → targeted `syncOnePr` → a confirming SELECT) and
  reports a `visible` flag rather than guessing. Two routes are still short of that:
  `/request-reviewers` stamps only the ids it could resolve to synced `users` rows (direct logins
  land on the next sync), and `/update-branch` stamps NOTHING — the new head sha it just pushed is
  invisible until a sync. Adding the tail costs that action a full extra GitHub round trip, so it
  is a per-route latency decision, not a blanket rule.
  - The tail is `invalidatePrHydration` → `syncOnePr(…, {waitForInFlight:true})` → a confirming
    SELECT (matched on the numeric db id OR the node id — their equality is a convention, not a
    contract). `waitForInFlight` exists because the in-flight targeted sync may have read GitHub
    BEFORE the write, so ITS success proves nothing. Nothing in `resync-after-write.ts` throws.
  - **The `visible`/`threadId` copy contract is a safety rule, not cosmetics.** `visible:false`
    with a NON-NULL `commentId` means the comment IS on GitHub and we merely couldn't confirm it
    locally — the copy must say "it'll show up here shortly", never "it failed", and must never
    offer a retry, because a retry DOUBLE-POSTS. `threadId` is null whenever `visible` is false.
    Once GitHub has 201'd the route may not fail: the single `catch` is only reachable from a
    failure BEFORE the post. Known limit: the targeted sync pages `reviewThreads(first: 50)`, so
    a brand-new thread on a bigger PR is a real, expected `visible:false`.
- **A column may be CLEARED only on a positive statement from GitHub.** `graphqlTolerant` hands
  back partial data with forbidden fields NULLED, so "GitHub said there is nothing" and "we never
  received that selection" look identical — and an unconditional write NULLs good detail on every
  tick for such a token, invisibly. Model the three states (`undefined` = omit the key from the
  upsert, `null`/`[]` = clear) and SPREAD the observed keys into the values/set objects rather than
  assigning them. `sync/branch-status.ts`'s `failingChecksToWrite` / `prNumberToWrite` are the
  reference pair.
- **A PR number resolves to a local id only within `(accountId, repoId)`.** Numbers are unique per
  REPO, so any map keyed on a bare number cross-links one repo's #12 onto another's row. See
  `db/branch-queries.ts`.
- **A new `accountId`-bearing table must be added to `accountScopedTables()`** in
  `db/erase-account.ts` (and erased in `eraseAccountData`), or a user's deletion silently leaves
  it behind. The test iterates that list, so the omission fails CI.
- **Never put a data-derived URL straight into `href`/`src`.** React renders `javascript:` URLs
  (it only console-warns), and check-run `details_url` etc. are third-party-supplied — go through
  `safeExternalUrl()` in `lib/ui.ts`.
- **Anything an agent reads from a PR is UNTRUSTED input** (title/description/diff/comments are
  written by whoever opened it). Don't widen an agent's tool surface — `review/agent.ts` denies
  `Bash` outright, and a per-command blocklist is not a substitute.
- **Heuristics get fixture tests.** Before changing `derive-thread-state.ts`, add a sample to
  `src/sync/__fixtures__/threads/` (see its README for the JSON shape + how to capture a real
  thread via `gh api`).
- **Idempotency is load-bearing.** New entities upsert on their GitHub node ID — the conflict
  target is **composite** with the scoping column (`accountId`/`prId`); new event types
  produce a deterministic `dedupeKey`.
- **`req.raw.on('close')` is NOT a client-disconnect signal on a POST — watch the REPLY socket.**
  A request's `close` fires when the REQUEST is complete, which for a POST means the moment
  Fastify finishes reading the body — before the handler has done anything. Wiring a
  `shouldStop`/`aborted` flag to it makes it permanently true: the run breaks out of its first
  iteration and every `send` is suppressed, so the route 200s with an empty body while looking
  like a no-op with no error anywhere. Use `reply.raw` (or the hijacked `raw`) instead; verified
  both ways — on a POST with a body, `req.raw` reports closed and `reply.raw` does not, while
  the client is still waiting. The `…/stream` endpoints that are **GETs** (Claude Review, AI Fix)
  are unaffected and must not be "fixed".
- **TypeScript is strict** (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`).
- The local DB + `.env` files are gitignored. Cloud secrets (`ENCRYPTION_KEY`,
  `SESSION_SECRET`, the OAuth App client id/secret) live only in env (`.env.cloud.example` template);
  stored OAuth tokens are AES-256-GCM-sealed.

---

## Verifying changes

For backend/heuristic logic, `pnpm test` + `pnpm typecheck` (4 workspaces). For UI work,
`pnpm dev` is usually already running; the SQLite DB at `apps/backend/data/` holds real
synced data you can query (`sqlite3`) to pick test cases, and you can deep-link app state via
URL params (`?pr=<id>`, `?repos=<ids>`, `?cats=…`; the dev SPA base is `/app/`, so use
`http://localhost:5173/app/?pr=<id>`).

For **multi-tenant / cloud** changes: `verify:isolation` proves cross-account IDOR at the
query layer. To exercise the full deployed experience locally (landing, OAuth, Postgres),
`docker compose up -d db` + `--cloud` per `docs/LOCAL-CLOUD-TESTING.md`; confirm **local is
unchanged** (`pnpm dev` → straight to `/app`, no landing/sign-in).

---

## Packaging & publishing

Ships to npm as the single unscoped package `pierre-review` (`npx pierre-review`), built
artifacts only; one Fastify process serves `/api` + `/app` + (cloud) the prerendered
landing. Publishing is CI-only — **never run `npm publish`/`npm login` from here**.
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

The full history, the 0044/0045 fold rules, the eight sqlite↔pg divergences and the plugin
0019/0020 story live in [docs/MIGRATIONS.md](docs/MIGRATIONS.md) — read it before writing
ANY migration. Operating rules:

- **BOTH journals are hand-maintained** (each folder's `meta/_journal.json`; sqlite
  entries `"version": "6"`, pg `"7"`). An unregistered file **SILENTLY SKIPS** — the boot
  looks perfect and every query 500s on a missing relation. The pg half is the one that
  gets forgotten.
- **Never run `pnpm db:generate:pg` for an incremental change** — it squashes the
  baseline. pg migrations are hand-written additive, like the sqlite ones since `0008`.
- Plugin migrations are filename-sorted with NO journal (do not add one), take NO
  `--> statement-breakpoint`, and their pg twins downgrade failures to warnings — because
  a plugin-migration failure silently drops the whole plugin to OSS mode.
- The unit suite runs on SQLite only. pg `0031`–`0033` and plugin `0020`'s pg twin have
  not been replayed against a real Postgres (known gap; the throwaway-container recipe is
  in docs/SECURITY.md § dependency posture — mind the `DROP SCHEMA public CASCADE` gotcha:
  drizzle keeps its journal in a separate `drizzle` schema).

**Known gaps on this branch** (full list + closed-gaps record in
[docs/MIGRATIONS.md](docs/MIGRATIONS.md)): the ONE remaining account-wide Pro cron (the
Slack digest) covers the Default workspace ONLY; PrDetail still classifies bots
client-side by login; the legacy `?team=` URL rule is unit-tested nowhere;
`packages/pro/test/` (351 tests / 23 files) + `apps/frontend/test/` (532 / 39) do not run in
CI (`pnpm test` is recursive vitest and the frontend's `test` script is `echo "no tests"`), and
neither directory is typechecked (both tsconfigs include only `src`) — run them by hand with
`./apps/backend/node_modules/.bin/vitest run --root packages/pro | --root apps/frontend`;
**the People report's BOT sections cannot chart authoring-family automation** — a Dependabot
has no review output, so its section shows the honest "PRs this automation authored are not
charted here" rather than an empty ROI row (the authored-PR half is simply not built yet);
auto-merge's retarget guard still lacks a stored `expected_base_ref`; **AI Fix's conflict-resolver
paths (`rebaseResolve` / `mergeResolveAndPush`) GATE on credits but never CHARGE them** — only
`saveFixSuccess` calls `recordAiUsage`, so a fix that ends in a rebase-resolve under-bills; ML labels are never
re-scored (neither an edited body nor a model-version bump invalidates one — `pnpm ml:enrich
--reset` is the only refresh); a SINGLE comment the severity-api rejects still blocks its whole
workspace's enrichment backlog forever (`hardFailure` abandons the workspace, and the candidate
query re-selects the same comment next tick — the sync UI declines to report it as progress, but
nothing quarantines it; the one live instance of this is fixed at both ends, so the mechanism is
now latent rather than firing); **`trunk_ci_status_events` has NO backfill** — the writer only
appends on a transition observed at the end of a full walk, so the trunk half of the CI feed
stays blank for a repo until its next full walk (the PR half is populated by
`backfill-ci-history.ts`, which does not touch the trunk table); **a manual role on ONE row of a
duplicated identity re-splits that actor across two lanes** (a human classified
`github-actions[bot]` and its twin `github-actions` kept the derived role, so one lands in
`ai_review` and the other in `quality_gate` — a manual judgement is per user row by design, and
nothing propagates it across the `[bot]`-normalised pair the vocabularies otherwise join); and pg
`0036`–`0037`, pg `0039`–`0041` + the plugin `0021`–`0027` pg twins have not been replayed
against a real Postgres (the chain through pg `0035` HAS been — see docs/MIGRATIONS.md). ⚠ pg
`0040`/`0041` use `regexp_replace(…, '\[bot\]$', '')` where their sqlite twins use `replace()`,
so they are the divergences worth replaying before a cloud deploy.
