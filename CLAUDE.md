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
│  │  │  │  ├─ workspace-comparison.ts getWorkspaceComparison(): CORE/free cross-WORKSPACE metric matrix
│  │  │  │  │                    (listWorkspaces ∘ getWorkspaceMetrics; takes NO scope — it always compares ALL of them)
│  │  │  │  └─ migrations/ + migrations-pg/   sqlite (.sql + meta/) | Postgres baseline (`db:generate:pg`)
│  │  │  ├─ github/             auth.ts (gh token), client.ts (per-account factories), queries.ts (the big query),
│  │  │  │                      mutations.ts (REST writes + the GraphQL-only merge queue), branch-queries.ts (trunk, two-phase)
│  │  │  ├─ merge/              auto-merge-runner.ts — the "merge when ready" watcher (own cron, safety gates)
│  │  │  ├─ sync/               scheduler, sync-manager, sync-repo, upsert, derive-thread-state, commit-files, hydrate-detail,
│  │  │  │                      sync-one-pr (targeted), branch-status (trunk snapshot), resync-after-write (post-write tail)
│  │  │  │  └─ __fixtures__/threads/   JSON fixtures for the thread-state heuristic tests
│  │  │  ├─ review/             Claude Review (local-only): agent, review-manager, routing, persist, post-review, clone-manager, prompt
│  │  │  │                      + events.ts (inert review event-bus + learnings-provider registry), llm.ts (cheapComplete Haiku seam)
│  │  │  ├─ pro/                open-core seam (no premium logic): contract.ts (ProContext/ProPlugin + capability singleton),
│  │  │  │                      bind.ts (guarded runtime import of @pierre/pro), migrate.ts (plugin-owned dual-dialect migrator)
│  │  │  └─ api/
│  │  │     ├─ routes/          one file per resource (timeline, prs, repos, users, me, threads, activity, claude-review, auth[cloud], …)
│  │  │     └─ plugins/         error-handler (notFoundHandler / SPA+landing router), auth (context + session + gate)
│  │  └─ data/                 the local SQLite DB (gitignored)
│  ├─ frontend/                @pierre-review/frontend — the timeline SPA (base `/app/`)
│  │  └─ src/
│  │     ├─ App.tsx            useMe() 401 → SignInGate; FilterBar / PinnedTabsBar (Activity|Timeline + dynamic tabs) / Timeline / DetailPane / Activity+pinned overlays
│  │     ├─ store/filters.ts   Zustand: all filter + selection + timeline-hint state (+ transient activityRepoId/activityThreadFilter)
│  │     ├─ hooks/             useUrlState, useTimeline, usePr, useTriage, useMe (+ useProCapabilities), useActivity, useReviewLearnings,
│  │     │                     useAutoMerge (arm/disarm + the polled list), useBranchStatus, useCheckLogs (paged log window), useAnnotations, …
│  │     ├─ api/client.ts      typed fetch wrapper (credentialed; throws ApiError)
│  │     ├─ components/        Timeline/, Activity/ (rail + FeedView + open-PR list + collapsible digest cards), PrDetail, ChecksTab, ThreadList/, ThreadView/, PinnedTabsBar, …
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
- First sync of a repo is **two-phase**: a fast ~14-day foreground pass, then the deep
  `backfillDays` (90) backfill in background. Cloud skips accounts idle > 15 min
  (`accounts.lastActiveAt`); local is always-on.
- **Lean storage** (default in both modes): the PR description, review-comment `diffHunk`,
  commit `message` and `checkRuns` JSON are neither persisted nor fetched — hydrated on
  demand (`sync/hydrate-detail.ts`) and browser-cached. **Comment + review bodies are
  ALWAYS persisted** (the Feed renders full markdown). `PERSIST_BODIES=true` stores all.
- The **default-branch snapshot** at the end of every repo sync is **STRICTLY NON-FATAL**
  (an informational readout must never cost the PR sync that just succeeded) and
  **two-phase for GraphQL-cost reasons** — read the cost analysis in
  [docs/BACKEND.md](docs/BACKEND.md) before restructuring its queries;
  `contexts(first:100)` must NOT be lowered.

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

`db/schema.sqlite.ts` + `schema.pg.ts` are authoritative (27 tables); the table-by-table
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
  (`monthlyCents`, INTEGER CENTS, exactly one writer: `setReviewerCost`). The write rules
  are in Conventions below; the full history (three keys tried, the vendor-identity bug,
  the 0045 fold rules) is [docs/PRO-PLUGIN-AND-ACTIVITY.md](docs/PRO-PLUGIN-AND-ACTIVITY.md)
  § "One bot object". Price rules: per WORKSPACE by deliberate product decision (no
  fan-out, no inheritance on repo moves, **never sum cost across workspaces**); clearing
  is a column write, never a row delete; the two resets (`DELETE …/judgement|identity`)
  are UPDATE + re-derive with a REAL workspace id — never a row delete, never an empty
  scope list — and the identity reset KEEPS the price. `deleteWorkspace` re-homes the
  workspace's repos AND its `workspace_reviewers` rows to Default inside its transaction
  BEFORE deleting (the cascade would destroy manual verdicts and typed prices).
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
- `GET /api/workspace-metrics/compare` takes NO scope on purpose (it always compares ALL
  the account's workspaces) and sits on the `search` rate tier — its cost multiplies by
  workspace count.

---

## Frontend

Full detail (state model, UI regions, timeline internals, PrDetail):
[docs/FRONTEND.md](docs/FRONTEND.md).

Four deliberately-separated state layers: **server state** in TanStack Query (keys built
from filters; PR/thread detail fetched on demand; IndexedDB-persisted with
`staleTime: Infinity` for pr/thread), **filter/selection** in Zustand `store/filters.ts`
(`workspaceId` is the scope), **tabs** in `store/pinnedTabs.ts` (Activity | Timeline +
closable PR/drill-down tabs; exactly one board mounts at a time), **URL** mirrored by
`useUrlState.ts` (serializer diffs against defaults). App lands on the Activity console;
cloud renders `<SignInGate>` on a 401 from `useMe()`.

Landmines that cost real bugs — read the doc before touching any of these:

- **`workspaceId === null` means "not resolved yet"** — nothing may render
  workspace-scoped data while null. `?workspace=` is the ONE URL param emitted
  always-once-resolved and omitted while null (an unconditional `p.set` writes the literal
  `?workspace=null` on every bare load).
- **`useWorkspaceSync` is three-branch** (null-or-dead / changed / **PRUNE ONLY**) — it
  must NOT keep `repoIds` in lockstep with workspace membership (that kills per-repo
  show/hide). Track the previous id in a ref; a write-only-if-different guard is not
  sufficient (React Query result identity changes on every background refetch).
- Legacy URLs: `?workspace` absent + `?team=<int>` present ⇒ that int IS the workspace id
  (migration 0044 preserved team ids); any other `?team=` form discards `?repos=` too, and
  `repoIds` is always pruned to the resolved workspace's membership before any query runs.
- **`workspaceId` must NOT live in `FilterDefaults`** — persistence and reset share one
  list, so "Clear filters" would teleport the user into Default. It has its own persisted
  slice; `resetAllFilters` preserves it explicitly.
- **The repo picker (`RepoSelectPanel`) is Timeline-ONLY.** Activity, Feed, Bots and
  Compare always cover every repo in the selected workspace — never let the picker scope a
  screen that doesn't render it (pinned by `workspaceOpenPrsScope.test.ts`: the two
  open-PR search builders must disagree exactly once).
- **Visible sub-tabs are DERIVED, never written back** (`feedInnerTab`, `botsInnerTab`,
  the Compare rail gate): a scalar may legitimately hold a key the current context doesn't
  render; compute an `effectiveTab` for the render only — a corrective `set…` permanently
  forgets the user's choice.
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
  `mergeStateStatus === 'behind'` means GitHub is blocking.
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

- **`apiVersion` is 14 and FOUR literals must agree**: host `contract.ts`, plugin
  `index.ts`, plugin `contract-types.ts`, and `bind.ts`'s runtime gate
  (`plugin?.apiVersion !== 14`) — the actual enforcer. A half-bump silently degrades the
  ENTIRE plugin to OSS mode: capabilities dark, every `/api/pro/*` 404, nothing thrown.
  No test pins it; detection is `tsc` (TS2367 at the gate) + a boot check of `/api/me`.
- **A stale `packages/pro/dist` shadows `src` in dev.** `bind.ts` prefers `src/index.ts`
  outside production and LOGS the entry it bound — the first thing to check when a Pro
  route unexpectedly 404s.
- `ctx.schema` is `Record<string, any>` — a leftover `ctx.schema.teams` type-checks,
  evaluates to `undefined`, and throws only when the query runs. Grep, don't trust the
  compiler.
- Tiers: **core** (free — feed/timeline/My Turn/Bots, no AI) · **pro** (AI summaries +
  Insights, on whenever the plugin is active) · **pro+** (AI Analysis + AI Fix + Claude
  Review, all gated together by the ONE flag `PRO_ADVANCED_AI_ENABLED`).
- Generation is cost-gated everywhere: payload-hash caches (**the hash must zero
  `Date.now()`-derived fields** or a dormant repo re-bills hourly), per-account
  serialisation + intervals, credit metering (`AI_CREDITS_PER_USD` = 1250, inlined in
  THREE places — keep them in lockstep).
- The plugin owns its own dual-dialect tables/migrations/isolation test; plugin migrations
  take NO `--> statement-breakpoint` and their pg twins wrap in `DO $$ … EXCEPTION`
  warnings (a plugin-migration failure is TOTAL and SILENT — OSS-mode degrade).

---

## ML severity/category on bot comments (CORE, free tier, no LLM)

Every bot-authored review comment / PR comment / review body is labelled with a **severity**
(`nit`·`minor`·`major`·`critical`) and up to eight **categories** by the `severity-api`
microservice from the **`packages/ml`** submodule (fine-tuned ModernBERT ONNX on CPU + a
deterministic marker parser). Badges render on the comments; a rollup sits on the Bots tab.
Full detail: **[docs/ML-SEVERITY.md](docs/ML-SEVERITY.md)**. The invariants:

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
  (service unreachable, worker backed off, or a comment the service keeps rejecting — one live
  comment in this dev DB does exactly that, blocking its whole workspace), and spinning on it is
  a worse lie than the premature "done" this replaced.
- Advisory: macro-F1 ≈ 0.66 and CRITICAL is under-recalled, so the product buckets
  **major+critical as "high"** and nothing auto-acts on a label.

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

- **ESM module resolution differs per package.** Backend **NodeNext** — relative imports
  need explicit `.js` (`./foo.js`); frontend **Bundler** — no extensions. The #1 confusion.
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
  canonicalisers and three server parsers, and shipped a real bug: `teamSetToScope` collapsed a FULL
  selection to the `'teams'` sentinel and a ONE-team selection to a bare number, so `Array.isArray`
  missed "every team ticked" and `=== 'teams'` missed an explicit 2-of-5 — which made the Compare
  tab vanish and the rail un-group. Anything that would need a helper to answer "which repos is this
  scope?" is a sign the union is coming back.
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
  mount.** `CiAnalysisCard` was written to be mounted twice, its own comment said "the copy mounted
  inline on the Overview tab", and its tier was correctly moved from the pro+ `aiFix` to the cheap
  `prSummary` — but the only mount was inside the pro+ **AI Fix tab**, so no summary-tier user could
  ever reach the CI diagnosis. Only the tier change had landed. When a change says a component "now
  renders in X", the check is `grep '<Component'`, not the diff of the component.
- **Two mounts of one paid-generation card must share the MUTATION key, not just the query key.**
  `CiAnalysisCard`'s in-flight state reads `useIsMutating({mutationKey:['ai-fix-ci',prId]})`, because
  per-mount `isPending` reset to "Analyze" on a tab switch mid-run — inviting a second BILLED POST.
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
    SELECT (`findPostedReviewComment`, matched on the numeric database id OR the node id, since
    their equality is a convention and not a contract). `waitForInFlight` exists because the
    in-flight targeted sync may have read GitHub BEFORE the write, so ITS success proves nothing
    about the new row — the writer queues behind it (bounded, 3 attempts) and fetches itself.
    Nothing in `resync-after-write.ts` throws: a failed resync must never turn a successful post
    into an error.
  - **The `visible`/`threadId` copy contract is a safety rule, not cosmetics.** `visible:false`
    with a NON-NULL `commentId` means the comment IS on GitHub and we merely couldn't confirm it
    locally — the copy must say "it'll show up here shortly", never "it failed", and must never
    offer a retry, because a retry DOUBLE-POSTS. `threadId` is null whenever `visible` is false.
    Once GitHub has 201'd, the route may not fail: the handler's single `catch` (the 422 →
    "couldn't place", everything else → 502) is only reachable from a failure BEFORE the post,
    because `confirmPostedReviewComment` — the sole call after it — never throws.
  - **Known limit:** the targeted sync pages `reviewThreads(first: 50)`, so on a PR with more
    threads than that a brand-new one may fall outside the page — a real, expected `visible:false`.
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
[docs/MIGRATIONS.md](docs/MIGRATIONS.md)): the two account-wide Pro crons (Slack digest,
sprint refresh) now cover the Default workspace ONLY; PrDetail still classifies bots
client-side by login; the legacy `?team=` URL rule is unit-tested nowhere;
`SprintReportCard` has no importer yet the AI-policy sweep still spends;
`packages/pro/test/` (135 tests) + `apps/frontend/test/` (135 tests) do not run in CI;
auto-merge's retarget guard still lacks a stored `expected_base_ref`; ML labels are never
re-scored (neither an edited body nor a model-version bump invalidates one — `pnpm ml:enrich
--reset` is the only refresh); a SINGLE comment the severity-api rejects blocks its whole
workspace's enrichment backlog forever (`hardFailure` abandons the workspace, and the candidate
query re-selects the same comment next tick — live in this dev DB; the sync UI declines to
report it as progress but nothing quarantines it); and pg `0034` has not been replayed against
a real Postgres.
