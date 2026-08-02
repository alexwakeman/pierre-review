# pierre-review

A **single-page dashboard for tracking a team's GitHub activity across multiple
repositories** — built for sprint situational-awareness: at a glance, who's doing what,
which PRs are stalled, which review threads sit untouched, and what needs _your_ attention.

It runs **two ways from one codebase**, selected by `DEPLOYMENT_MODE`:

- **local** (default): entirely on your machine — SQLite, no hosted backend, no stored
  credentials. Authenticates via your logged-in `gh` CLI, syncs into a local SQLite file,
  opens straight to the timeline. The original, unchanged experience.
- **cloud** (multi-tenant): a public landing page, GitHub sign-in (OAuth App and/or GitHub App), per-user encrypted
  accounts, Postgres — self-hostable on Railway.

See **[Deployment modes](#deployment-modes-local-vs-cloud)** below for the full split.

> This file is the project's living overview — keep it accurate when you change
> architecture, conventions, or the data model.

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
`myTurnDismissals`, `workspaces`, `workspaceRepos`, `workspaceReviewers` (isolation = one indexed
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
(full routing under **Packaging**). **Running cloud:** `cli.ts --cloud`/`--mode` set
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
   └─ pro/                    @pierre/pro — PRIVATE git submodule (alexwakeman/pierre-pro), runtime-imported plugin (per-repo
                              Haiku digest, Insights, Claude Review + AI Fix, Claude Review learnings). Resolved by
                              PATH (not a declared dep); absent → clean OSS mode + install still succeeds.
                              (My Turn / FYI feed participation is CORE, not Pro — see below.)
                              `git submodule update --init` to fetch. See "Open-core Pro plugin".
```

---

## Commands

All from the repo root unless noted.

| Command | What it does |
|---|---|
| `pnpm install` | install all workspaces |
| `pnpm dev` | run backend (`:4000`) + frontend (`:5173`) concurrently |
| `pnpm dev:backend` / `pnpm dev:frontend` | run one side only |
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
landing, OAuth); `pnpm dev` is local unless `DEPLOYMENT_MODE=cloud`. The frontend dev server
proxies `/api` to the backend (`BACKEND_PORT`, default 4000); the landing has its own dev
server on `:5174`. Config comes from `.env` (repo root) then `apps/backend/.env` (see
`config.ts`); `DATABASE_URL` overrides the SQLite path (local) / is the Postgres conn string
(cloud). Full cloud locally: `docs/LOCAL-CLOUD-TESTING.md`.

---

## Backend

### Startup & auth

`index.ts` (cloud: `assertCloudConfig()` first) runs migrations, prunes redundant events,
builds the app, starts the scheduler, listens. Auth differs by mode (see **Deployment
modes**):

- **Local:** one synthesized account (id 1). `ensureLocalAccount()` shells out to
  `gh api user` at startup, caches the identity on the `accounts` row (refreshed ~daily;
  non-fatal offline — you lose "my turn" triage). API calls use `gh auth token`; SQLite
  opens `journal_mode=WAL` + `foreign_keys=ON`.
- **Cloud:** no `gh`; accounts are per-user via one of two GitHub sign-in providers,
  side by side (configure either/both; SignInGate offers what's set): an **OAuth App**
  (`public_repo` scope, no install) and/or a **GitHub App** (private org repos need the App
  installed there). Both mint a user token, encrypted at rest. The chosen provider is folded
  into the OAuth `state` so the single callback exchanges against the right client id/secret.
  `assertCloudConfig()` fails loud at boot on a missing cloud env var; DB is a node-postgres
  `Pool`.

### Sync pipeline (`src/sync/`)

Pulls PR activity from GitHub into the DB; fully idempotent. **See
[docs/SYNC.md](docs/SYNC.md)** for the full pipeline (triggers, two-phase backfill vs
incremental, fetch loop, cancel, rate limits). In brief:

- **Trigger** (`scheduler.ts`): `node-cron` at `config.syncCron` →
  `syncAllRepos()` (off via `config.disableScheduler`); also repo-add + the manual/deep
  `POST /api/repos/:id/sync`. The periodic pass **skips accounts idle >
  `config.syncActiveWindowMinutes`** (default 15; `accounts.lastActiveAt` is stamped on each
  request from a loaded SPA) — a tenant with no open tab stops being re-synced (cloud-only;
  local is always-on).
- **Adaptive polling is the PRIMARY sync strategy in BOTH modes** (docs/REALTIME-SYNC.md;
  `config.syncAdaptive` defaults to **`true` everywhere**). The cron is a **tick**, not a
  cadence — `isDue()` gates each repo by activity bucket (hot <1h→120s, warm <6h→300s,
  cold→900s), and incremental syncs run a conditional REST probe first (a `304` costs no rate
  limit), with a 30-min floor forcing a re-walk so CI-finish / thread-resolve (which never
  bump `updatedAt`) stay fresh. **`syncCron`'s default keys off `syncAdaptive`: `*/1`
  adaptive, `*/5` not** — a `*/5` tick would pin every repo to 5 min and negate the hot
  bucket, so the two MUST move together. **Landmine: an explicitly-set `SYNC_CRON` wins**, so
  a deployment pinning `*/5` silently keeps the old cadence with adaptive on.
- **Webhooks are ADDITIVE on top, cloud only** (`POST /api/webhooks/github` →
  `enqueuePrSync`/`syncOnePr`, targeted, seconds). They are NOT the cloud default because an
  installation needs **admin on the repo** — third-party public repos can never be covered, so
  adaptive is the floor everywhere. Webhooks need **three** things or they silently deliver
  nothing: the secret env var, the **event subscriptions** (default NONE), and the App
  **installed**. Coverage is per **repo**, not per user: the receiver routes by `(owner,name)`
  across every account that has it added, so one install serves every tenant. Signing in via the App
  (`/login/oauth/authorize`) does **not** install it — Settings' `GithubAppInstallSection` is
  the in-app path (the SignInGate link is unreachable once signed in).
- **Plan** (`sync-manager.ts`): never-synced → **full backfill** (`since = now −
  backfillDays`, default 90), run **two-phase** (a fast ~14-day foreground pass, then the
  deep backfill in the background) so the board fills in seconds; else **incremental** from
  `lastIncrementalSyncAt − syncOverlapMinutes` (default 20). Status in `syncState`; a
  process-local running/progress set feeds the live UI.
- **Fetch** (`sync-repo.ts` + `github/queries.ts`): one fat `REPO_ACTIVITY_QUERY` (25
  PRs/page, `updatedAt DESC`) walked until `updatedAt < since`; per-commit changed-file
  paths via REST (`commit-files.ts`), cached **permanently** (immutable SHAs).
- **Persist** (`upsert.ts`): `persistPr()` upserts the whole PR subtree in one
  `runTransaction`, stamping `accountId`. **Idempotency is structural** — entities upsert on
  their GitHub **node id**, events on a `dedupeKey`; conflict targets are **composite**
  (`(accountId, githubNodeId)` / `(accountId, dedupeKey)` / child `(prId, githubNodeId)`).
  Derived thread state computed here.
- **Per-account token** (`getAccessToken`) threaded into the fetch, never
  module-cached; per-account `try/catch` so one bad token doesn't abort the loop.
- **Default-branch snapshot** (`sync/branch-status.ts` + `github/branch-queries.ts`, called at
  the end of every repo sync, foreground pass included): trunk head + its CI rollup onto
  `repos`, the last 20 trunk commits into `branchCommits`. **STRICTLY NON-FATAL** — it is an
  informational readout, so a token that can walk the PRs but chokes on the branch history must
  never cost the caller the PR sync that just succeeded. **TWO-PHASE, and the split is a cost
  decision**: GitHub prices a GraphQL call from requested nodes, so phase 1
  (`history(first:20)` × `associatedPullRequests(first:3)` = 80 nodes) is **1 point**, while
  nesting `statusCheckRollup.contexts(first:100)` under that history would be ~2020 nodes ⇒
  **~21 points on every walk of every repo, green or red**, on a call adaptive polling re-fires
  every 120s. So failing-check DETAIL is a SECOND query (`buildCommitChecksQuery` — aliased
  `object(oid:)` lookups, shas as GraphQL VARIABLES, only the alias names are generated and
  those are index-derived) issued only for the commits phase 1 reported as failure/error/**pending**
  (pending is in the set because GitHub keeps the rollup PENDING while other checks run after one
  already FAILED). ≈1 point per non-green commit, capped by `COMMIT_CHECKS_ALIAS_CAP`=10 — worst
  case 11 points for an all-red window, and the actual figure is LOGGED (`N non-green commit(s),
  M with retrievable checks, K rate-limit point(s)`) rather than asserted. `contexts(first:100)`
  must NOT be lowered: the connection has no failures-first ordering, so a smaller page can
  return 100 green contexts on a red commit — a caret with nothing behind it.

**Lean storage (both modes; default).** `config.persistBodies=false` by default
(`PERSIST_BODIES=true` stores everything — larger DB, fully-offline detail).
**Comment + review bodies are ALWAYS persisted** (both modes): `reviews.body`,
`reviewComments.body`, and `prComments.body` are stored unconditionally so the
consolidated Feed can render full markdown (and review bodies still drive
substantive-review detection). Only the truly bulky, regenerable text stays
**lean-gated** — under lean, sync neither persists nor fetches the **PR description**
(`pullRequests.body`), the review-comment **`diffHunk`**, commit **`message`**, and the
**`checkRuns` JSON** (the `ciStatus` enum is kept); `reviewComments.excerpt` is always
kept too. That gated text (per-tenant-duplicated) is **hydrated on demand** when a
PR/thread opens (`sync/hydrate-detail.ts` → `PR_DETAIL_QUERY`, matched by node id/sha) and
**browser-cached** in IndexedDB (`PersistQueryClientProvider`; `pr`/`thread` queries
`staleTime:Infinity`; `useDetailCache.ts` invalidates only on a newer feed `updatedAt`).
Migration `0010` makes the two `body` columns nullable (they're now written non-null on
every sync).

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

26 tables. Multi-tenancy as above (`accountId` denormalized onto the anchor tables;
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
  `avatarUrl`, `githubType` — the GraphQL author `__typename`, fed to the bot classifier);
  **global**.
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
- **`commits`** (`sha`+`prId`) + **`commitFiles`** (`sha` → changed paths, cached).
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
  `updateStrategy`, the consent anchor `expectedHeadOid`, `state` (`ArmedMergeState`),
  `expiresAt`, `lastCheckedAt`, `lastReason`. FKs cascade from `accounts`/`pullRequests`. Both
  exported (Art. 15 — it records an action the user asked the server to take) and erased.
- **`branchCommits`** — the recent commits on each repo's DEFAULT branch (`accountId`
  denormalized; unique `(accountId, repoId, sha)`; trimmed to `BRANCH_COMMIT_WINDOW`=20 per
  repo in the same transaction as the upsert). **Not derivable from `commits`**, which is
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
- **`workspaceReviewers`** — the **Bot-Triage** table (CORE, `accountId`-scoped). **THE BOT OBJECT:
  ONE row per `(accountId, workspaceId, authorUserId)`**, carrying three independent facts:
  - **JUDGEMENT** (provenance: `source`) — `automated`, `role` (`ReviewerRole`
    `'review'|'quality_check'`, NOT NULL default `'review'`), `confidence`, `source`, `reasonsJson`.
  - **IDENTITY** (provenance: `identitySource`) — `kind`, `label`.
  - **PRICE** (no provenance; exactly one writer) — `monthlyCents`.

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

  The plugin-owned `pro_settings` keeps its 11 `bot_*` columns (its
  `bot_cost_json` now a deprecated READ-only legacy source — `ProSettingsUpdate.bots.cost` was
  REMOVED, there is no write path left; Pierre tag/footer toggles, Slack digest — its
  now-vestigial `bot_auto_resolve*` columns backed the removed mute feature). See
  **Bot-Triage Platform** below. (The old `botMuteRules` table / `/api/bot-mute-rules` mute +
  auto-triage-cron feature was **removed** — see the note below; migration `0029` still creates
  the now-orphaned `bot_mute_rules` table in existing DBs but no code binds it.)

Conventions: timestamps are unix-epoch integers in SQLite (`mode:'timestamp'`) /
`timestamptz` in Postgres — both infer `Date` in the read layer (one hand-rolled epoch
comparison in `getTimeline` uses `tsBound` to bridge). Node IDs are the stable identity;
reads are **accountId-scoped**; **triage fields are computed on read** (`triage.ts`:
`reasonTag`, `reviewRequestedFromMe`, `newSinceLastViewed`, approvals, `isStalled`) — not
stored.

### HTTP API

JSON wire format (ISO-8601 timestamps); payload types in `packages/shared`. Each route
file maps to a `client.ts` method.

**`?workspace=<integer>` is THE scope parameter, everywhere.** It replaced `?scope=` and its five
`TeamScope` wire forms (`all` / `none` / `teams` / `teams:2,4` / `<id>`) with one integer, and there
is no parser, no canonicalisation and no sentinel.

- **Absent, unknown, unparseable, or another tenant's id ⇒ the account's DEFAULT workspace. Not a
  404.** Every id yields the same response shape (so it is not an existence oracle), the resolved id
  is always one the caller owns (so nothing can leak), and a stale bookmark degrades to something
  renderable instead of a blank screen. **Every scoped response echoes `workspaceId`** so the SPA
  can correct its stored id.
- `?repoIds=<csv>` survives as **data narrowing only** — the workspace owns the verdict, so the old
  "one selection cannot mean two things" hazard is structurally gone. But it is **BOUNDED**:
  `resolveWorkspaceScope` returns `membership ∩ (narrow ?? membership)`. Without that,
  `?workspace=5&repoIds=<a repo of workspace 9>` passes the account check, enumerates footprints
  over workspace-9 repos while the lazy classifier writes rows keyed to workspace 5 for actors with
  ZERO footprint there — fabricating exactly the rows `verify:isolation`'s anti-fabrication pair
  forbids. Doing it in one resolver is what stops it being a convention 14 handlers must remember.
- ⚠ **Five CONTENT routes take it too, and they never took `?scope=`**: `/api/timeline`,
  `/api/activity`, `/api/activity/feed`, `/api/open-prs`, `/api/branch-status`. `repoIds` alone was
  enough only while `null` meant "every repo of the account" — a workspace with **zero repos** gives
  `repoIds: []`, every client builder used to drop an empty array, and the server then returned the
  whole account: the precise opposite of "this workspace is empty". Hence also the client rule
  **`if (ids) p.set('repoIds', …)`**, not `if (ids && ids.length > 0)`, and a `ws:<id>` segment on
  every one of those React Query keys (two workspaces sitting on `repoIds = null` otherwise produce
  an identical query string and share a cache slot).

| Method & path | Purpose |
|---|---|
| `GET · POST /api/workspaces` · `PATCH · DELETE /api/workspaces/:id` · `POST /api/workspaces/:id/repos` | **Workspaces** (CORE) — the app's only scope. `GET` ensures the Default row + repairs missing memberships first → `WorkspacesResponse`. `POST {name}` always creates `isDefault:false`; a duplicate name 400s. `PATCH {name?, repoIds?}` — `repoIds` is the workspace's EXACT membership: ids ADDED are moved in, ids DROPPED go to Default via `rehomeReposToDefault`. A move is **membership and nothing else** — there is no second visibility axis to write. Renaming the Default IS allowed. `DELETE` → 204, but **409 `{error:'DefaultWorkspace'}`** on the default row; it re-homes the workspace's repos **and its `workspace_reviewers` rows** to Default inside one transaction before deleting. `POST /:id/repos {repoId}` MOVES one repo in. ⚠ There is **no `DELETE /:id/repos/:repoId`** — a repo is always in exactly one workspace, so "remove" is "POST it to Default". Tier `read` (matched explicitly in `tierFor`, so the choice is recorded rather than inherited) |
| `GET /api/timeline?workspace&from&to&repoIds&userIds&types&statuses&reviewStates&excludeBots` | **lean** feed `{prs[],events[]}` — no bodies/diffs. The window is CLAMPED to `config.retentionDays` and both selects are ROW-CAPPED (5k PRs / 20k events, newest-first) returning `truncated?: true` — unbounded dates used to materialise the whole retained dataset in one response. Defaults: 14d, bots shown (toggle in Members). `reviewStates` filters `review_submitted` markers by verdict (approved/changes_requested/commented/dismissed); absent = all, empty = none |
| `GET /api/prs/:id` | full PR detail (threads, reviews, comments, commits, checks, labels) |
| `POST /api/prs/:id/mark-viewed` (alias `/dismiss`) | record a view (`sha?` defaults to head) → clears new-since badges |
| `GET /api/prs/:id/merge-options` | what the merge control needs, fetched LAZILY (the hot detail path must not wait on GitHub): repo-allowed methods + live mergeability + `mergeQueue` (null unless the base branch really has one — `enabled:false` would make every repo render a queue section) + `autoMerge{allowedByRepo,armed}`. The queue probe is `.catch(() => null)` — best-effort, never fails the control. Up to five upstream calls, so it shares the `prDetail` rate-limit tier with `GET /api/prs/:id` (and `…/files`) |
| `POST · DELETE /api/prs/:id/merge-queue` | enqueue / dequeue on **GitHub's native merge queue** → `MergeQueueResult`. WRITE+ re-checked; enqueue pins the LIVE head sha (same consent anchor as a merge), 400s when the base branch has no queue (rather than failing opaquely inside GraphQL), and is idempotent both ways. GraphQL-only — see `github/mutations.ts` |
| `POST · DELETE /api/prs/:id/auto-merge {mergeMethod,updateStrategy?}` | arm / disarm Pierre's own **"merge when ready"** → `ArmedMergeRequest` · 204 (idempotent). Arming re-checks WRITE+, refuses a non-open PR (409), pins the LIVE head sha (never the synced one — a stale pin disarms itself on the first tick), and 409s `StaleBase` when the synced base ref no longer matches GitHub's. TTL 72h |
| `GET /api/auto-merge` | every armed (+ resolved within 24h, cap 200, newest first) intent for the account → `ArmedMergeListResponse`. A pure DB read — the SPA POLLS it for the "it landed" toast, so it must never touch GitHub |
| `GET /api/prs/:id/checks/:jobId/logs?tail` \| `?startByte&endByte` | a live WINDOW of an Actions job log (never stored) → `CheckLogsResponse`. Offsets are SOURCE bytes (the `\r\n` normalisation is display-only), `endByte` EXCLUSIVE, `hasMore` = "more exists ABOVE this window" — so feeding a response's `startByte` back as the next `endByte` abuts exactly. Every path is capped at `MAX_LOG_BYTES` (8 MiB) via a rolling buffer (~2×cap peak) even when the source ignores `Range`. Serves PASSING checks too — see **Merge, CI logs & trunk status** |
| `GET /api/branch-status?workspace&repoIds` | **default-branch health** per repo in scope → `BranchStatusResponse` (head snapshot + failing checks + the recent trunk commits, each with its own CI state, failing checks and originating `prNumber`/`prId`). Pure DB read off what the branch sync persisted — never a live GitHub call, hence the plain `read` tier. Repos with nothing synced still appear, with nulls. **Informational only:** nothing here feeds attention counts, badges or My Turn |
| `POST /api/prs/:id/resolve-bot-threads {threadIds}` | **bulk-resolve** the review-bot threads a later commit likely addressed → `{resolved,failed,results[]}`. Server RE-DERIVES eligibility (owned + review-bot-originated + `likely_addressed`) ∩ the client's reviewed list, then GitHub-resolves each (shares the `bot-triage/resolve.ts` `resolveThreadsOnGitHub` helper with the scope-wide resolve route); never auto/blind — user-initiated + confirm-gated only. Core |
| `GET /api/bot-reviewers?workspace&repoIds` · `PATCH /api/bot-reviewers/:userId {workspaceId, automated?, role?, kind?, label?}` · `PUT /api/bot-reviewers/:userId/cost {workspaceId, monthlyUsd}` · `DELETE /api/bot-reviewers/:userId/judgement?workspaceId=` · `DELETE …/identity?workspaceId=` | **Bot-Triage** (CORE) — **ONE row, TWO write routes, TWO independent provenance flags.** The LISTING returns one `reviewers` entry per actor with a footprint in the workspace (each carrying judgement + identity + price + `footprint` + `repoFootprints[]` + `sampleReviewBody`) plus the echoed `workspaceId` and the `repoIds` it covered → `DetectedReviewersResponse` (`repoIds: []` means "this workspace has no repos", which a count alone could not distinguish from "no reviewers detected yet"). Its **lazy classification** fires on *an actor with a footprint in this workspace and no row for it* — one derivation per actor per workspace, not per repo. · **`PATCH :userId`** carries the four **re-derivable** fields in one body; all optional (absent = leave alone) but a body with NONE of them 400s (an opinion-free patch would stamp a provenance flag on an empty request and freeze detection). ⚠ **`automated`/`role` stamp `source:'manual'`; `kind`/`label` stamp `identitySource:'manual'` — INDEPENDENTLY.** That independence is the only thing left stopping "not a bot here" from also un-naming the vendor, now that no table boundary does it. ⚠ **A role-only patch still stamps `source:'manual'`**, pinning `automated` too — deliberate: not stamping it lets the next pass re-derive `role` from the login seed and silently revert the edit; a visible, resettable pin beats an edit that quietly disappears. ⚠ Its `set:` object contains **no `monthlyCents` key** — structural, not a rule to remember. · **`PUT …/cost {workspaceId, monthlyUsd}`** stayed a SEPARATE route when the grains merged, and that is the point: cost is derivable by nothing and is money, so keeping it on its own body means no combined body can address the column at all — the same structural guarantee the two-table split gave, with one fewer table. `monthlyUsd` is REQUIRED and NULLABLE so `undefined` is not a third meaning: a number sets it (**0 is real** — "we pay nothing"), null CLEARS it — a column write, never a row delete. Bounds are NOT cosmetic: `[0, 21474836.47]` + `multipleOf:0.01`, the int4-cents ceiling where the dialects stop agreeing (pg RAISES `integer out of range`, sqlite accepts it) — ajv 400s, and the query layer clamps as the backstop. ⚠ It writes **exactly one row** (`(accountId, workspaceId, authorUserId)`): price is PER WORKSPACE. · **Two RESETS, one per provenance flag, and the asymmetry is gone — both are UPDATE + re-derive-in-the-same-request → 200 with the fresh row** (the old per-repo judgement reset DELETED its row and 204'd; that row now also holds the identity and the price, so a delete is lossy). `…/judgement` hands `automated`/`role`/`confidence`/`reasons` back to detection; `…/identity` clears `kind`/`label`, sets `identitySource:'auto'` and **KEEPS THE PRICE** (un-naming a vendor is not a statement about what it costs). ⚠ Both call `classifyReviewer(…, [workspaceId], {only:'judgement'\|'identity'})` — a REAL workspace id. The old identity reset passed an EMPTY repo list and relied on `persist` writing two statements against two TABLES with only the second guarded; with one merged row there is a single per-workspace loop, so an empty list writes NOTHING and "Reset name" becomes a permanent un-naming. ⚠ Order is load-bearing: clear BEFORE deriving, or `persist` skips the still-`manual` row. · **404 rules, one status for all of them, deliberately**: unknown user / unknown-or-foreign workspace / no stored row AND no footprint in that workspace — distinguishing them would be an existence oracle over another tenant's ids and the GLOBAL `users` table. ⚠ The PATCH's gate is `!existing && !hasFootprintInWorkspace(...)`, and the `!existing &&` half is load-bearing: a STORED row whose actor has gone quiet must stay editable, because it is still steering every metric and is the only place its own reset control can live |
| `GET /api/bot-analytics?window&workspace&repoIds` | **Bot-ROI** (CORE): per-`AutomatedReviewerKind` volume/actedOn%/untouched/oldest/humanFollowThrough/noiseRatio/`verdict`(keep\|tune\|**noisy**) + ≤12wk trend + tuning suggestions → `BotAnalyticsResponse`. **Cost is SERVER-resolved from the workspace row** (`costMonthlyUsd` / `costPerActedOnUsd`, from `workspace_reviewers.monthly_cents` via `reviewerCostForUser(accountId, workspaceId)`) — a null here is FINAL. The client keeps a **null-only legacy fallback** (it fills a row ONLY where the server-resolved cost is null, badged `acct`) for logins the plugin's cost backfill could not attach to a bot row, since that migration only ever UPDATEs and never INSERTs. ⚠ **Never sum cost across WORKSPACES**: within this one workspace's rows it is a plain sum (one row per actor), but six workspaces each listing a $120 CodeRabbit is either six subscriptions or one seen six ways and the app must not assert which. **Role split:** the getter computes a row for EVERY automated reviewer, then routes `role:'quality_check'` ones into **`qualityChecks[]`** — same shape, kept OUT of `vendors`/`totals`/`suggestions` (a linter's volume must not move an acted-on % that claims to be about REVIEW throughput, and its untouched threads would earn a `noisy` verdict for doing its job), rendered as a collapsed "excluded from ROI" section so a mis-role is discoverable instead of the bot appearing to vanish. Classification is **workspace-resolved** from the route's own `?workspace=`, while `repoIds` narrows only the DATA — the two answer different questions and can no longer disagree (`BotScope {workspaceId, repoIds}` is one object with two named fields precisely so a call site cannot transpose them or forget which one the verdict comes from). **Response-time-gated verdict:** the verdict keys on `overdueUntouched` (untouched threads older than a **fixed 36h grace window**, `totals.overdueGraceMs`), NOT raw `untouched` — so a bot isn't flagged noisy for threads still inside the grace window. (A MEASURED reply-time norm was tried but the sample is intrinsically fast — only threads someone engaged with draw a reply — so a flat cutoff is the fair gate.) Each row also carries `medianAddressedMs` (that bot's own median **time-to-ADDRESSED** — the earliest of a human reply, a resolve, or the addressing commit for a `likely_addressed` thread, computed read-time from `commits`/`commitFiles` for just those threads' PRs; display-only). ('kill' was renamed 'noisy'.) Vendor rows carry `dormant`+`lastActiveAt`: ANY trend-span footprint (threads, comments, or body-only reviews) keeps a quiet reviewer visible as a DORMANT row (zeroed window counts + trend + last-active chip) instead of vanishing; body-only reviews count as window activity for emission/dormancy but never enter the volume math |
| `GET /api/bot-behaviour?window&workspace&repoIds` | **Bot BEHAVIOUR** (CORE, deterministic, **EXPERIMENTAL**): per bot over the window (+ a 12wk trend), the common review-bot gripes — **TTFR** (median/p90 + distribution + `ttfrTrend`; clock start = `pr_ready_for_review` when observed else `pullRequests.openedAt`), **LoC-to-comments** ratio (diff size ÷ the bot's comment count), a **week×hour activity heatmap** (`activityHeatmap` length-168, `dow*24+hour`, dow 0=Sunday — coverage / rate-limit INFERENCE, from review/comment timestamps NOT commit-push time, labelled inferred/UTC), and **post-first-review follow-up** (rate/avg/dist) → `BotBehaviourResponse`. Same window/workspace/repoIds resolution as `/api/bot-analytics` (one `BotScope`); reuses the ROI identity helpers (`automatedReviewerUserIds`/`classificationKindForUser`/`u<userId>` key). Powers the Bots "**Behaviour**" inner sub-tab (`BotBehaviourPanel`), kept SEPARATE from the ROI panel so it can mature independently. **Anomaly detection (deterministic, self-baseline):** each bot's weekly series (TTFR/volume/follow-up) + a daily strip are judged against the BOT'S OWN robust baseline (median ± MAD, spike-resistant, ≥4 weeks or "building baseline"); TTFR flags only slower-than-typical weeks, volume+follow-up either direction; a silence-run detector flags coverage gaps for a normally-regular bot (run ≥ max(3, 3·median-gap) days, leading run ignored, trailing kept). `trend` points carry `*Anomaly` flags + an `anomalies[]` evidence list (observed vs typical) + `dailyActivity`/`silentRuns`. UI = **markers on the charts** (`LineChart` `pointFlags` ring + a new `DayStrip` with silent runs underlined in the anomaly colour). Also returns **`repoBotDirs`** (per bot × repo × directory) powering the merged **"Where bots work"** grouped+stacked chart (`BotRepoWorkChart`, custom SVG — X = bot; a bar per repo; each stacked by top-level directory + an 'other' tail; actual volumes; single-repo scope → one bar per bot). It REPLACED the two separate `repoPresence` (repo×bot "operate") + `repoAreas` (repo×area "work") charts/fields. No new AI/credit surface, no `apiVersion` bump |
| `GET /api/prs/:id/bot-behaviour` | **PR-scoped Bot behaviour** (CORE, deterministic, **EXPERIMENTAL**): for ONE PR, each automated reviewer's on-PR touch timeline (first review + follow-ups) + how it compares to that bot's OWN typical (an 84-day account-wide robust baseline via `getPrBotBehaviour`) → `PrBotBehaviourResponse`. Flags this PR's TTFR when anomalously slower than typical + follow-ups above typical. Account-scoped → 404 for a foreign PR; empty `bots` when none touched it. Powers the PrDetail "**Bot activity**" tab (`PrBotBehaviourTab`, presence-gated — shown only when a bot touched the PR, NOT Pro) + a ⚠ tab-label badge + a ChecksTab Overview "N bots slower than typical — view" caution that opens the tab. Reuses the ROI identity helpers + the `ANOMALY_Z`/`MIN_BASELINE_POINTS` constants |
| `GET /api/prs/:id/bot-dedup` | **cross-bot dedup** (CORE): automated-reviewer threads grouped by `(path, line±window)` across distinct kinds → consensus/conflict clusters → `BotDedupResponse` |
| `GET /api/bot-analytics/bot-only-prs?window&workspace&repoIds` | the PR list behind `totals.botOnlyPrs` ("only a bot reviewed these") → `BotOnlyPrsResponse` (CORE; `BotOnlyPrItem` carries `repoId`/`openedAt`/`updatedAt`/`state`). **The COUNT (`totals.botOnlyPrs`, banner + ROI stat) is OPEN-only** — `getBotOnlyReviewPrs(…,{openOnly:true})` restricts to open+mergeable, dropping merged-in-window (the banner is a "needs a human before it merges" signal; open PRs are a live, unwindowed snapshot). The LIST route still returns merged (no `openOnly`) so the drill-down `BotOnlyPrsDetail` can **default to OPEN rows** (caption "N open" ≡ the banner) with a **"Show merged (M)" checkbox** that adds merged (client-side filter on `state`; caption → "N open · M merged"). Sortable table (Age/Updated cols + cross-repo repo-filter dropdown). Both BotsView's amber caution AND the Bot-ROI "N bot-only open PRs" stat open this TAB. (`getWorkspaceInsights`' `bot_only_review` card still counts open+merged — a separate Pro surface.) |
| `GET /api/bot-analytics/vendor/:key/prs?window&workspace&repoIds` | per-REVIEWER Bot-PRs drill-down; `key` = the analytics row identity `u<userId>` \| `'pierre'` (invalid → 400) → `BotVendorPrsResponse` (+`key`/`login`). Replaced the old kind-keyed `/:kind/prs` (removed — two in-house bots no longer merge). **Scope-resolved, and it must be:** it is opened FROM a scoped ROI row, so the header label and the per-PR `botOnly` badge both take the SAME `BotScope` the row was computed at — one screen cannot show two contradictory bot-only answers. The getter carries no second classification-key parameter at all, which is what makes that structural rather than a convention |
| `GET /api/bot-threads/resolvable?workspace&repoIds` · `POST /api/bot-threads/resolve {threadIds, workspaceId}` | **workspace-wide review & resolve** of `likely_addressed` bot threads (CORE): the listing is now **UNCAPPED + PR-centric** (`getResolvableBotThreadPrs` → `ResolvableThreadPrsResponse{prs[],totalThreads}`) — **one row PER PR carrying ALL its resolvable thread ids** (`threadIds`) + `resolvableCount` (=`threadIds.length`=`botThreadCounts.likely_addressed`, now equal since uncapped) + a bot-only `botThreadCounts` mix + per-PR `confidenceCounts`/`highConfidenceThreadIds` (the deterministic addressed-confidence breakdown of the resolvable ids) + `repoId`/`authorId`/`ciStatus`/`openedAt`/`updatedAt`. Replaces the old 500-capped grouped-`threads` shape. The confirm-gated resolve still RE-DERIVES eligibility ∩ the explicit ids via `getResolvableBotThreadsForScope` (kept for that path; still 500/POST, client chunks 25 ids/POST for progress) so "Select all" resolves the WHOLE backlog. UI (`BotThreadsDetail`): a **SORTABLE tabular** list (PR/repo/author/age/updated/CI/resolvable/**confidence** — the per-PR High/Medium/Low addressed-confidence mix, sorted by a grade-weighted score), **PRs DESELECTED by default** with per-row checkboxes + **Select-all (across all pages) / Clear** (both greyed when the visible/**filtered** selection is empty), a **"High-confidence only"** toggle that FILTERS the list to PRs with a high-confidence resolvable thread AND scopes Select-all/counts/resolve to that subset (was invisible when it only narrowed the hidden resolve set), resolve pinned TOP with a **Stop** control (halts cleanly between chunks via `shouldStop`), a cross-repo **repo-filter dropdown** + Repo column, and **client-side pagination** (50/PR page; selection & Select-all span pages). All five Activity drill-down overlay tabs are `max-w-[100rem]` (widened from `max-w-6xl`). Clicking a PR row opens its detail Threads tab with the `likely_addressed` state pill preset (not back to the Bots pane). BotRoiPanel's `ResolveBacklogBanner` (reads `totalThreads`) opens the `bot-threads` TAB. Both use `role:'review'` (a linter's finding is not a review comment, and `likely_addressed` is a much weaker claim for one). **The listing and the resolve now evaluate the same rule BY CONSTRUCTION**: `ScopeResolveBotThreadsBody` is `{threadIds, workspaceId}`, so the judgement scope on the POST is literally the workspace the listing was computed at. (Historically it was not: the listing resolved the judgement from `?scope=` while the resolve re-derived at a hardcoded no-team key, so a reviewer marked automated only under a per-team override had its threads offered and then found ineligible — the route resolved 0. There is one scope now, and it rides in the body.) |
| `GET /api/open-prs?workspace&repoIds&userIds` | currently-open PRs (ignores date range) |
| `GET /api/threads/:id` | single thread detail |
| `GET/POST /api/repos`, `DELETE /api/repos/:id` | manage the account's repos (delete → 409 if syncing, else 204) |
| `GET /api/repos/search?q&cursor&limit` | live GitHub repo search → `{results[],hasNextPage,cursor}`; already-added filtered out, owned/member floated up; `limit` 10 (max 25) |
| `GET /api/repos/suggested` | **first-run onboarding**: the viewer's recently-active repos (`VIEWER_REPOS_QUERY`: `viewer.repositories` + `repositoriesContributedTo`, PUSHED_AT desc, null-tolerant for scoped cloud tokens), already-added filtered out, `RepoSearchResult` shape, cap 30 → `SuggestedReposResponse`. Drives `FirstRunOnboarding` (the zero-repo Activity console body, hoisted above all rail branches; top 5 pre-checked, sequential adds, one invalidation batch) |
| `POST /api/repos/:id/sync?full=true` | trigger sync → `202 {status:'started'}`, or `409` if already running |
| `GET /api/users` | GitHub actor metadata for the Members panel. **Account-SCOPED** (`listUsers(accountId)`): `users` is a global TABLE but the listing only returns actors appearing in the caller's own synced data. (`PATCH /api/users/:id` was DELETED — a global, ownership-free `isBot`/`isBotOverridden` write with no frontend caller; use `PATCH /api/bot-reviewers/:userId`.) |
| `GET /api/users/:id/stats?workspace&repoIds` | **Contributor popover** (CORE): one user's **ALL-TIME** totals over the account's synced data → `UserContributionStats` — PRs they AUTHORED by bucket (merged/open/draft/closed, the `prStatusWhere()` mapping), `reviewsGiven`, `comments` (issue-level + inline), plus the `repoIds` actually counted. **COUNTS ONLY, no profile field** — `users` is a global table, so echoing a login/avatar for an arbitrary id would make this id-addressed route a cross-tenant profile lookup; the SPA already holds the account-scoped roster. `reviews`/`prComments`/`reviewComments` carry no `accountId`, so tenancy comes from an `innerJoin(pullRequests)` + `pullRequests.accountId` — **all four** predicates are bound by `verify:isolation` (the `reviewComments` one needs its own seeded row or the guard is vacuous). **No ownership 404** — a foreign/unknown id returns all zeros, deliberately: 404-vs-200 would be an existence oracle over a global table. `reviewsGiven` excludes `pending` AND the body-less `commented` **wrapper** GitHub creates around a batch of inline comments (`isSubstantiveReview`) — those inline comments are already in `comments`, and counting the wrapper double-counted one act (>half the rows for an active reviewer). Migration `0037` (pg `0024`) adds the four `author_id` indexes this needs — without them every count scanned the ACCOUNT's PR set, so cost tracked tenant size, not the person (~55ms of blocked event loop per open on a 6k-PR DB) |
| `GET /api/mergers` | per-repo merge-rights map (who's merged there) → the maintainer shield |
| `GET /api/me/export` · `DELETE /api/me/account` | **data-subject rights** (GDPR Arts. 15/20/17): the whole account as one JSON download (sealed GitHub token excluded) · irreversible erasure, confirm-by-typing-your-login, 400 in local mode. Erasure calls the plugin's `registerAccountErasure` hook — see Security & privacy posture |
| `GET /api/me`, `/api/my-turn`, `POST /api/my-turn/dismiss` | identity + triage queue + dismissals. The queue's **"New PRs"** section is open PRs by a non-bot human other than you, non-draft, **opened at or after their own repo's `createdAt`** (see `repos` above) and deduped against the sections before it (`/me` carries `claudeReviewEnabled` + `deploymentMode` + `pro:{activityDigest,reviewMemory}`; cloud: 401 signed out) |
| `GET /api/activity?workspace&repoIds&userIds` | **Activity tab** (core, no AI): per repo `{stats, threadTotals, maintainerIds, attentionCount, hasUnread, prs[]}` — composes `getActivity`; scoped by the FilterBar repo + member selection (see Activity) |
| `GET /api/activity/feed?workspace&repoIds&userIds&limit&offset&excludeBots&botWindowDays` | **Consolidated Feed** (core, no AI; the Activity "Feed" entry): ONE flat, chronological (newest-first) stream of REAL activity events (opens / merges / reviews / comments, plus **commit-push items that ADDRESSED a review thread** — coalesced per author/PR into runs, affected threads inline via `affectedThreads`/`commitCount`/`changeSummary`; plain pushes excluded). Each item carries **`isMyTurn`** (participation: you authored the PR / are a requested reviewer / previously reviewed-or-commented, AND the actor isn't you) — that flag REPLACES the old two-source (`my_turn` vs `feed`) synthesis + dedup, so there's exactly one row per event. **My Turn / "FYI" is CORE (free, every tier), NOT a Pro capability:** `getConsolidatedFeed` computes `isMyTurn` directly via `feed/my-turn.ts` (no capability gate, no provider seam). `isMyTurn` rows are uncapped; plain activity is capped (`FEED_EVENT_CAP`). `excludeBots=true` drops bot-authored activity. **Paginated** (`limit`/`offset`; default page 50) → `{items[], users[], total, counts, generatedAt}` — **`counts` = server-computed facet counts over the WHOLE post-cap stream** (`ConsolidatedFeedCounts`: myTurn/claude/comments/prEvents/bots/byBotActor/byThreadState via the pure `computeFeedCounts`), so FeedView's pill badges reflect every matching item, not the loaded page (stale IndexedDB responses fall back to page-derived counts). Response also carries **`uncappedTotal?`** (pre-cap post-coalesce stream length) — FeedView's count label renders loaded-of-`total` + a "N most recent of M in window" cap disclosure, never the old visible-of-loaded "50 of 50". **Thread-state pills render on EVERY feed view** (not just botsMode; same semantics: an active state pill hides derivedState-less items). `botWindowDays` (clamped 1–90) widens the **botsOnly** feed window to match the shared `botAnalyticsWindow` selector (normal feed stays 14d); the head poll (`useFeedHasNew`) gets the identical params AND is gated on `!isPlaceholderData` so a window flip can't false-fire the refresh banner. **`includeAllCommits=true`** (the opt-in "**Commits**" pill, OFF by default, `feedShowCommits` transient store toggle) surfaces EVERY commit-push run — not just the thread-addressing ones — via `getCommitThreadItems` dropping its addressed-thread gate (run coalescing kept; a plain run emits empty `affectedThreads` + a "pushed N commits" summary); inert on the `botsOnly` path; threaded into BOTH the feed key and the head-poll key (identical scope). `counts` gained a **`commits`** facet (badges the pill); the **`prEvents`** facet is now READ by FeedView (the PR-events pill finally shows its count). No "seen"/acknowledged concept. |
| `GET /api/workspace-metrics/compare` (**no params**) | **cross-WORKSPACE comparison, CORE/FREE** (`db/workspace-comparison.ts` `getWorkspaceComparison`) — one `WorkspaceComparisonRow` per workspace → `WorkspaceComparisonResponse`, powering the Activity rail's **"Compare workspaces"** entry. ⚠ **It takes NO scope parameter at all**: it always compares ALL of the account's workspaces, Default included, independent of the current selection — a scoped key would fragment one answer across N cache slots, so the React Query key is the bare `['workspace-comparison']`. Isolation is by construction — it narrows `listWorkspaces(accountId)`, so a foreign id matches no row (no 404 oracle); bound by `verify:isolation` with a seeded second account so the negative check isn't vacuous. **Window: trailing 14d**, the same default `/api/workspace-metrics` uses — core cannot read the plugin-owned `pro_settings`, so Compare agrees with the free header above it and may differ from a Pro user's custom-window Insights header. ⚠ **Rate-limit tier `search` (60/min), not `read`** — it is the one route in the app whose cost multiplies by WORKSPACE COUNT (N × `getWorkspaceMetrics`, each a twelve-week PR window) and it takes no narrowing parameter to bound it; on the blanket 600/min bucket a loop over it is a self-inflicted DoS. The SPA only fires it while the Compare rail entry is active. (Its 402-gated Pro ancestor `/api/pro/insights/team-comparison` was DELETED with the rename — leaving an orphan under the old vocabulary is how someone repoints at it.) |
| `GET /api/workspace-metrics?workspace` · `GET /api/workspace-metrics/detail?workspace` | **CORE/FREE** workspace flow-metric header (DORA-ish tiles + 12-week trend charts) + the per-tile PR drill-down. Lives on the cross-repo **Feed** (`FeedMetricsPanel` atop `showingFeed`), not the Pro Insights pane. `getWorkspaceMetrics`/`getWorkspaceMetricsDetail` were always CORE-computed; only the SERVING route was ever Pro-gated. `getWorkspaceMetricsForScope` takes a REQUIRED `repoIds: number[]` — no null, no sentinel. `api.workspaceMetricsDetail` points here, not at the orphaned Pro `/api/pro/insights/metrics-detail`. `MetricsDetail` (drill-down tab) carries no "Pro" badge. (What's left in the Pro Insights pane is the ad-hoc chat alone — metrics, attention cards, Retro and Compare have all moved out; see **Insights**.) **`MetricsDetail` is SORTABLE** (`Activity/sortableTable.tsx`): every column clickable, a sortable **Updated** column (backed by `MetricPr.updatedAt`, in the `getWorkspaceMetricsDetail` SELECT), the Diff column sorts on numeric `additions+deletions` (never the formatted string), and per-tab default sort = recency (updated desc) for open_prs/merges but the metric magnitude (value desc) for the duration/CI tabs (NOT recency for lead time) |
| `GET /api/repos/:id/claude-reviews` | repo-scoped Claude-review history (retrieval only; `enabled:false` when the flag is off) → `{prs:[{runs[]}]}` |
| `POST /api/prs/:id/review-comment` | post ONE inline review comment, re-anchoring to the file's first changed line when the requested `(path,line,side)` isn't addable → `AddReviewCommentResult`. Alone among the write routes it cannot stamp a local row (REST returns no review-THREAD node id), so it resyncs + VERIFIES and reports `visible`/`threadId` — see **Instant comment visibility** in Conventions. Once GitHub has 201'd, nothing downstream may fail the request |
| `GET /api/pro/prs/:id/annotations?kinds` · `POST …/annotations/run` | **comment annotations** (Pro, `prSummary`): the cached per-PR read (pure, no side effects, no generate-on-open) · the ONE billing path — `kind` is a RUN kind (`addressed`\|`validity`\|`simplify`\|**`review`** = all three in one call per target), `targets[]` narrows to the ONE thread/comment the per-item button was pressed on → `AnnotationRunResponse`. **The SSE twin `…/run/stream` and `AnnotationRunBody.onlyStale` are GONE** with the PR-wide sweep bar (a per-item run is one billed call — nothing worth streaming; `onlyStale` had no sender left). An absent `targets` still MEANS the whole PR on the wire (`planRun`'s `anchors.length === 0` branch) but no UI sends it. The 429 gate now carries a `message` — the server serialises runs per ACCOUNT and every thread card has its own button, so "clicked B while A runs" is the ordinary case. `AnnotationRunResponse.noAuth?` marks the 200-with-zero-work "no Anthropic credential" outcome. See **Comment annotations** under the Pro plugin |
| `GET·POST /api/pro/activity/digests*` · `GET·POST /api/pro/prs/:id/review-learnings` · `…/claude-reviews/:id/actions` | **Pro plugin** routes (registered only when `@pierre/pro` loads): per-repo Haiku digest (the Activity Feed renders the COLLECTION of these, scoped to the selected Workspace's repos — no separate cross-repo route/pass) + review-memory data. See "Open-core Pro plugin" |
| `GET /api/auth/providers` · `/login[/​:provider]` · `/callback` · `POST /api/auth/logout` | **cloud only** — GitHub sign-in: which providers are enabled (for SignInGate) / authorize via `oauth`\|`app` (folds provider into `state`; OAuth adds `config.oauthScope`) / exchange+upsert+session→`/app` / clear session |
| `GET /api/prs/:id/claude-review` | latest run + findings + history + auth status + `enabled` |
| `POST /api/prs/:id/claude-review {model}` | start a run → `202 {reviewId}`; `400` no-auth/no-head, `409` busy, `404` disabled |
| `GET …/claude-review/status`, `POST …/cancel` | poll live progress / abort the SDK run |
| `GET /api/claude-reviews` · `/:reviewId` | cross-PR history (one per PR, most-recent succeeded, in window) · a specific past run |
| `PATCH /api/claude-reviews/:reviewId` · `/api/claude-findings/:id` | save the user's draft (never Claude's text) · tick a finding for inline posting |
| `POST /api/claude-reviews/:reviewId/post {userVerdict}` (+ `?dryRun`) | post one GitHub review (inline + body + verdict); `409` if head moved |
| `PUT /api/claude-review/key {key}` | set/clear the local Anthropic key (empty clears); local-only |
| `GET /api/health` | unauthenticated health check |

The `claude-review` routes are **only registered when enabled** (local-only;
`config.claudeReviewEnabled` is force-`false` in cloud → they don't exist there). **Cloud
auth gate:** every `/api/*` data route 401s unauthenticated except `/api/health` +
`/api/auth/*` (`registerAuthGate`); local always has an account so nothing 401s. Reads are
accountId-scoped; id-addressed routes verify ownership (→ 404).

---

## Frontend

### State model

Three layers, deliberately separated:

1. **Server state** → TanStack Query (`useTimeline`, `usePr`, `useTriage`). Timeline query
   keys are built from the active filters (a filter change refetches); PR/thread detail is
   fetched **on demand** on selection.
2. **Filter & selection state** → the Zustand store `store/filters.ts` (`useFilters`):
   **`workspaceId: number | null`** (the scope), repos/members/range, category + derived-state
   filters, the selected PR/thread, transient timeline hints (`timelineFocusPr/At/Event`,
   `timelineCenterAt`), and the `feedMyTurnOnly` feed filter. (The old overlay-focus signals
   `focusActive`/`myTurnOnly`/`timelineIsolate`/`exitFocusSignal` were **removed** — focus is now
   a tab, see below.)
   - ⚠ **`workspaceId === null` means "not resolved yet"**, and **nothing may render
     workspace-scoped data while it is null** — a sync effect fills it from `listWorkspaces()`'s
     default the moment the query lands. `repoIds: number[] | null` keeps its type but its meaning
     shifted: `null` = every repo IN THE ACTIVE WORKSPACE.
   - **All five `TeamScope` canonicalisers are GONE with no replacement** — `scopeToParam`,
     `teamSetToScope`, `scopeToTeamSet`, `teamIdsInScope`, `isMultiTeamScope`. A number needs no
     canonicalisation; that is the entire point.
   - ⚠ **`useWorkspaceSync` must NOT keep `repoIds` in lockstep with the workspace's membership** —
     that and per-repo show/hide are mutually exclusive and the membership would win. The contract
     is three-branch: `workspaceId` null-or-dead ⇒ set Default and re-derive `repoIds`;
     `workspaceId` CHANGED ⇒ re-derive for the new workspace; **otherwise PRUNE ONLY** (drop ids no
     longer in the workspace, leave a user-narrowed subset — and `null` — alone). Track the
     previous id in a ref: a write-only-if-different guard is necessary but not sufficient, because
     `repos`/`workspaces` are React Query results whose identity changes on every background
     refetch.
3. **Tab state** → `store/pinnedTabs.ts` (`usePinnedTabs`): `ActiveTab = 'timeline' | 'activity'
   | <Tab.key>`; a `Tab{key,kind:'pr-detail'|'pr-focus'}` list. `openPrDetailTab` /
   `openPrFocusTab` / `closeTab`. Exactly one board mounts at a time (App keys the board slot;
   see "focus tabs"). (The old My-Turn tab kind + `openMyTurnTab` + the `m` key were removed —
   situational awareness is the Feed + its "My Turn only" toggle.)
4. **URL** → `useUrlState.ts` mirrors the store to the query string both ways (shareable /
   reloadable); the serializer diffs against **defaults**, so the common case stays clean.
   - ⚠ **`?workspace=` is the ONE exception to the diff-against-defaults rule**: there is no static
     default (the Default workspace's id varies per account), so it is emitted **always once
     resolved** and **omitted entirely while `workspaceId` is null** — `writeToUrl` runs from the
     store subscription, which fires on the very first hydrate, so an unconditional `p.set` writes
     the literal string `?workspace=null` on every bare load.
   - ⚠ **`?team=` is dropped but `?repos=` is NOT, and that combination is the trap.** A link in
     the wild (`?team=3&repos=7,9,11`) would otherwise land the user in Default while hydrating
     another workspace's repo ids — a header saying "Default" over someone else's repos, with the
     request honouring them. The rule: `?workspace` absent **and** `?team=<int>` present ⇒
     `workspaceId = <int>` (migration `0044` preserves the team ids deliberately) and `?repos` is
     honoured; `?team` = `all`/`none`/`teams`/`teams:…` (or absent) ⇒ ignore both and **discard
     `?repos`**; and in every case `repoIds` is **PRUNED to the resolved workspace's membership
     before any query runs**. `sanitizePersistedFilters` likewise **drops a persisted `teamScope`
     key entirely** rather than coercing `teamScope: 3` into `workspaceId: 3` — the ids happen to
     be preserved, but `'all'`/`'teams'`/`[2,4]` have no image, and half-migrating persisted state
     is worse than discarding it.

**Auth gate (cloud only).** `App.tsx` calls `useMe()` first; a **401** (cloud, signed out)
renders `<SignInGate>` instead of the app, and a **sign-out** control shows when
`me.deploymentMode === 'cloud'`. Local `/api/me` never 401s, so the app renders as before.
`api/client.ts` sends `credentials` (the session cookie) on every request.

### UI regions (`App.tsx`)

- **FilterBar** — the scope row is **`WorkspaceSelector` + `GlobalSearch`, which show on EVERY
  view**; everything else, `RepoSelectPanel` included, is Timeline-only.
  - **`WorkspaceSelector`** (was `TeamSelector`) is a **single-select RADIO list** — no "All
    repos", no "All Teams", no "No team", no checkboxes, no `toggleTeam`. Default first (badged
    "Default"), then the rest by name, each with its repo count; the trigger label is the active
    workspace's NAME (never "All repos" / "N teams"). Its footer opens the
    **`WorkspaceManager`** modal ("Manage repos & workspaces"), where repo add/remove/assignment
    and the debounced GitHub search picker (`RepoSearch` → `/api/repos/search`) live (a successful
    add pops the sync-progress modal via `syncModalSignal`); `RepoSearch` also mounts standalone
    inside `FirstRunOnboarding` (zero-repo first run).
  - **`RepoSelectPanel` is TIMELINE-ONLY, and `filters.repoIds` is therefore timeline-local in
    effect.** It lists **only the active workspace's repos**, never the account's; `repoIds = null`
    means "every repo IN THIS WORKSPACE"; it canonicalises to `null` at all-or-none and won't hide
    the last one. ⚠ **No per-row remove** (a visibility panel that deletes a repo is a footgun;
    removal lives in `WorkspaceManager`) and **no per-row watch toggle** — the "watched" concept is
    gone (migration `0046` / pg `0033`); every repo in a workspace is fully live. Its empty state is
    the ordinary *empty-workspace* state: "No repos in this workspace — move some in from Manage
    repos & workspaces."
  - **⚠ Activity, the Feed, Bots and Compare ALWAYS cover every repo in the selected Workspace —
    the picker must never silently scope a screen that cannot see it.** It briefly sat outside the
    `isTimeline` gate on the reasoning that the Activity console "reads `repoIds` hardest", which is
    exactly the trap: a control the user set on the Timeline then narrowed a console that renders no
    such control, so the same workspace showed different repos on different tabs with nothing on
    screen to explain it. **The Workspace is the scope; the rail is how you narrow it.** Clicking a
    repo row in the Activity rail is the per-repo view, and that is a DIFFERENT mechanism
    (`filters.activityRepoId`, a single repo id) which is unchanged — as are the drill-down tables'
    own repo-column filter dropdowns (`BotThreadsDetail`, `BotOnlyPrsDetail`, `MetricRepoFilter`),
    which filter rows already on screen rather than scoping a fetch.
  - Timeline-only, i.e. rendered **only when the Timeline board is the active tab**
    (`isTimeline = activeTab === 'timeline'`): Members (auto-scoped, exclude-bots toggle), range
    presets (7/14/30/90d/custom) + a **Now** action (`timelineCenterAt`), event categories,
    derived-state tags, and the right-hand Clear-filters cluster. Activity, Insights,
    PR-detail/focus tabs and every drill-down keep just the scope row. The filter STATE persists
    (reachable again from the Timeline tab); the Activity console's queries never send
    `userIds`/`excludeBots` anyway (its bot control is the feed's bot-lens pills); the board stays
    member-scoped. ⚠ **`workspaceId` must NOT live in `FilterDefaults`** — persistence and reset
    share one list (`pickFilterBarState` writes exactly `FilterDefaults`, `resetAllFilters` spreads
    `freshFilterDefaults()`), so a persisted `workspaceId` would also be **reset by "Clear
    filters"**, silently teleporting the user into Default whenever they cleared a date range. It
    is persisted in its own slice and `resetAllFilters` preserves it explicitly. The
  **Members panel** (`UserSelectPanel`) shows only each repo's **maintainers by default** and
  collapses the non-maintainers behind a per-repo **"Show N more"** (10 at a time; "Show fewer"
  re-collapses; `shownOthers` per-section state, reset on open) — a **search bypasses the
  collapse** (shows all matches flat) so no member is unreachable. Its sticky per-repo headers
  (member + bots sections) carry `z-10` + an opaque bg so scrolling rows don't bleed through.
- **Timeline** — the centerpiece (below).
- **DetailPane** — resizable bottom pane (height persisted) under the board slot. **Hidden
  until a PR is selected** (`selectedPrId != null && !overlayActive`); no selection → the
  Timeline takes the full height (App fires a synthetic `resize` on the transition so vis
  refits). Shows **PrDetail** for the selected PR. **App lands on the Activity console by
  default** (Activity-first; a bare load → `?view=activity`, deep links keep timeline).
- **`AutoMergeBanner`** — a bottom-right toast stack (same shape as `ClaudeReviewBanner`) fed by
  DIFFING `GET /api/auto-merge`: the watcher runs server-side, so an `armed →` terminal
  transition is the only signal the client gets. Transitions only, never current state.
- **Tabs / board slot** (`PinnedTabsBar` + `App.tsx`). `<main>` renders exactly ONE
  `<Timeline>` "board slot" whose `mode` derives from the active tab: absent = the shared
  board; `{kind:'isolate',prId}` = a **pr-focus** tab's own isolated Timeline. `activity` +
  `pr-detail` render as overlays OVER the warm board; `pr-focus` REPLACES the slot (keyed
  remount → at most one vis instance live). `PinnedTabsBar` is **always shown**: **Activity**
  + **Timeline** are the first two chips — permanent, **non-closable** tabs (the header
  segmented control was removed; the tab strip is now the single place to switch views). The
  dynamic tabs (pr-detail / pr-focus) follow as closable PR-named chips. **Closing the active
  tab moves to the adjacent tab** (left, else right, else the Timeline board) — it does NOT
  snap back to the board when other tabs remain (`closeTab` in `store/pinnedTabs.ts`).
  Besides the PR tabs there's a family of **singleton, EPHEMERAL drill-down tabs** (never
  URL/localStorage-persisted; a reload drops them): `metrics-detail`, `bot-prs`, `open-prs`
  (sortable all-open-PRs: age/author/LoC/untouched-threads/CI/approval columns), `bot-only-prs`
  (sortable + Age/Updated + cross-repo repo-filter dropdown), and `bot-threads` (sortable +
  DESELECT-by-default + Select-all/Clear across pages + Stop + repo-filter + client pagination;
  scope-wide review & resolve). **`user-activity` is the one drill-down keyed PER USER**, not a
  singleton (`userActivityKey(userId)` / `parseUserActivityKey`): two people's feeds can sit side
  by side and re-clicking a handle re-focuses their tab. It needs no filters-store seed — the tab
  KEY carries the userId, so a stale key can never show the wrong person; `Tab.userMeta` carries
  the chip's label/avatar. It renders `UserActivityDetail` → `<FeedView userIds={[id]}/>`, which
  is a real ACTOR filter (`inArray(events.actorId, …)`); `getConsolidatedFeed` skips the
  actor-less Claude-run items whenever `userIds` is set, and FeedView drops its cross-repo
  Open-PRs panel + the My-Turn "seen" marker under that scope. **Merge/close rows are recorded
  against the PR's AUTHOR** (`sync/upsert.ts` writes `actorId: authorId`), so on this tab they
  mean "a PR they authored was merged" — the header caption says so rather than implying they
  pressed merge. **Row click across ALL these list surfaces (the drill-down TABLES
  + the inline `OpenPrRows`/`FeedOpenPrsPanel` lists) now
  opens the PR's own detail TAB** (`openPrDetailTab`) — the old feed-isolation / timeline-focus
  on-click + the ⧉ button were removed; **feed isolation is reached from PrDetail's "Show in
  Activity feed" header button** (`FeedIcon`: `setRepoConsoleTab(repoId,'activity')`→`setActivityRepo`
  →`setFeedIsolatedPrId`→`showActivity`, order load-bearing). `bot-threads` rows open the PR's
  Threads tab with the `likely_addressed` pill preset. **Repo-scoped chips show the repo name**
  (`PinnedTabsBar` `TabChip` reads the seed + `useRepos`). Each drill-down = a `TabKind` + key
  const + opener in `pinnedTabs.ts`, a transient read-not-consumed seed + `openXDetail()` action in
  `store/filters.ts` (`{fromActivity:true}` arms Back-to-Activity), a full-`<main>` overlay
  branch in `App.tsx` (MUST join `overlayActive`), and a compact chip in `PinnedTabsBar`. The
  drill-down TABLES (open-prs / bot-only-prs / bot-threads, **plus `MetricsDetail`** — now
  retrofitted, per-tab `sortByTab` state) share `Activity/sortableTable.tsx`
  (`SortHeader`/`compare`/`nextSort`; numeric columns MUST return a number from `sortValue`, or
  `compare` localeCompares lexicographically). The rail's per-repo console remembers its Activity|Bots sub-tab in
  `filters.repoConsoleTabs` (and Insights its sub-tab in `insightsSubTab`) — surviving rail
  switches and tab round-trips; cross-view jumps set it explicitly (e.g. Show-in-feed →
  `setRepoConsoleTab(repoId,'bots')` BEFORE `setActivityRepo`, isolation set AFTER — the
  setter clears `feedIsolatedPrId`).

### The timeline (`components/Timeline/`)

`vis-timeline` with `stack:false` + `stackSubgroups:true`. Rows are nested groups
**repo → contributor** (ids `repo:<rid>`, `repo:<rid>:user:<uid>`); within a contributor
row, subgroups order a PR-bar line, its own-work event line, and a shared cross-user marker
band. PR bars pack into lanes (`lanes.ts`); events are type-shaped SVG markers that
**cluster** at coarse zoom (`clustering.ts`).

Key behaviors to know about:
- **Selection & highlight.** Clicking an event marker/cluster loads its PR into the
  detail pane + opens a popover; clicking a PR bar selects it. Every highlight (selected
  bar, open popover's marker `ev-selected`, focus glows `pr-cross-linked` /
  `ev-cross-linked`) is the **same soft sky pulse** (`ev-select-pulse`). Outside focus,
  clicking empty canvas dismisses **one level at a time**: popover, else selected bar,
  else a lingering exit-anchor glow (`applyExitGlow(null)`).
- **Focus is a TAB, not an overlay** (`mode?: TimelineMode` prop). The PR-detail **Focus**
  link, **double-clicking a PR bar**, and clicking a **cross-user marker / cluster** call
  `usePinnedTabs.openPrFocusTab(meta)` → a persistent, closable **pr-focus tab** whose board
  slot mounts `<Timeline mode={{kind:'isolate',prId}}/>`. That instance **boots directly into
  isolation** (a `bootedRef` effect reuses the internal `enterPrFocus`/`isolatePrBars`/
  `rebuildMarkers`/`fitWindow` as the initial+only state — collapse to the PR's contributor
  rows, show only its bar, fit the window to its span). There is **no exit/restore** — leaving =
  switching/closing the tab (unmount). The isolation is purely component-LOCAL (only one instance
  is ever mounted), so it does NOT drive shared store flags. **A feed card, by contrast, opens a
  pr-DETAIL tab** (`openPrDetailTab`, not pr-focus) — full PrDetail, whose Show/Focus links then
  drive the timeline. **Back button:** opening a tab from the Activity console pushes ONE deduped
  `{pierreTab}` history entry (the app's ONLY `pushState`); App's single `popstate` handler
  (`consumeActivityReturn`) returns to the Activity console, and the feed scrolls + flashes the
  exact item that was clicked (`activityReturnItemId`). **Landmine:** an isolate-tab
  range-preset/window effect must be inert (`if (embeddedPrId != null) return`) or a date-preset
  click overrides the
  boot fit. **Known gap:** a PR merged >90d ago is outside the isolate fetch window → can't
  isolate (the boot `selectPr`s it so the pane still shows).
- **Vertical scroll is GATED — route every programmatic scroll through it.** vis
  virtualizes rows (`timeline.focus()` can't reach off-screen stubs), so all programmatic
  scrolling drives the `.vis-vertical-scroll` panel via `setVisScrollTop`. Several
  authorities move it — the background-sync rebuild's `restoreScrollAnchor` (content
  anchor), `centerShowTarget` ("Show" centring + the isolate-tab boot centre), the
  `rangechanged` recluster — arbitrated by **`intentionalScrollRef`
  (is a scroll claimed?) + `scrollLoopRef` (monotonic loop id)**. An intentional scroll
  CLAIMS ownership (`++scrollLoopRef`; `intentionalScrollRef=true`; a backstop that clears
  the gate only if `scrollLoopRef` is still its id — so a newer claim supersedes the older
  and two loops never write `scrollTop` on alternating frames). While set, the others **stand
  down**: the rebuild's anchor-restore + deferred bar-fit re-anchor are gated on
  `!intentionalScrollRef`, and the recluster re-arms past the settle. **Never write
  `scrollTop` / call `focus()` directly from a new path — go through `setVisScrollTop` and
  claim the gate (copy `centerShowTarget` / `restoreScrollAnchorIntentional`), or it WILL
  fight the live loops and jitter.** Position is preserved by CONTENT anchor (the row at the
  viewport top), not raw pixels, so rows growing/re-sorting above don't ride it upward.
  **On unmount** (closing/leaving a focus tab) the vis cleanup bumps `scrollLoopRef`
  (+`intentionalScrollRef=false`) and `setVisScrollTop` no-ops when the instance is gone /
  detached — else a mid-settle `centerShowTarget` loop writes scroll on a torn-down vis and
  triggers its internal `_updateScrollTop`→null crash.
- **Per-row collapse.** A caret per contributor label (`setRowCollapsed`) shrinks the row
  to its name by hiding its subgroup bands via `subgroupVisibility` (distinct from focus's
  whole-row `visible:false`). Persisted to `localStorage['pierre:collapsedRows']`,
  re-asserted after each rebuild. **Gotcha:** vis applies `subgroupVisibility` only during a
  group restack, so `setRowCollapsed` forces `itemSet.markDirty({restackGroups:true})` +
  `redraw()`. Focus suspends it (force-shows kept bands, hides the caret), restores on exit.
- **Show vs Focus (PR detail).** **Show** (`openPrFocused`) just centres + glow-pulses the
  PR on the shared board (no isolation); **Focus** (`openPrFocusTab`) opens the PR's own
  isolated pr-focus **tab** (above). The per-thread/comment/activity "Show" links
  (`ShowOnTimeline` → `showEventOnTimeline`) + `openPrFocused` funnel through the one
  `timelineFocusPr` consumer effect (now centre-only on the shared board) — the place to start
  for any board-navigation change.
- **Commits are hidden by default** (`DEFAULT_CATEGORIES` excludes `commits`);
  enabling them round-trips through the URL.
- **Contributor names open the USER POPOVER** (`UserProfilePopover`), no longer navigating
  straight to GitHub. Three surfaces: `UserName` (PrDetail / ChecksTab / comments / threads /
  the drill-down tables), the **feed card actor** (`FeedView`), and the **vis-timeline row
  labels**. The card shows an enlarged avatar, the contributor's ALL-TIME
  `GET /api/users/:id/stats` totals, a GitHub-profile link, and **View activity →**. Details
  that are load-bearing:
  - **Scope**: `repoId` prop set (rendered in a PR context) → that repo's numbers; else the
    FilterBar-visible set (`filters.repoIds`, already bounded by the active workspace). The caption states
    which — "12 merged" is meaningless without it. **Pass `repoId` at every new call site.**
  - Both flavours stay a real `<a href>` to the profile: a **modified click (⌘/ctrl/shift/alt)
    or non-primary button is left alone** so "open the profile in a new tab" still works; only
    a plain left click is intercepted + `preventDefault`ed.
  - **Landmine (cost a real bug):** `UserName`'s returned tree SHAPE must not depend on
    `open`. It used to return a bare `<a>` when closed and a `<span>`-wrapped one when open;
    React saw the root type change, remounted the `<a>`, and the popover was handed a DETACHED
    node with a zero rect — the card landed in the page's top-left corner. The shape now keys
    on `shield` alone, and the anchor is a **callback ref** (`useState`), not `useRef`, since
    it is read during render.
  - The timeline label is an HTML STRING rebuilt by vis on every rebuild, so it carries a
    `data-user-gid="repo:<rid>:user:<uid>"` handled by a **delegated capture listener** on the
    container (the collapse-caret pattern; an inline `onclick` would need `script-src
    'unsafe-inline'`, which the CSP does not grant). The popover anchors there by **selector**,
    re-resolved each animation frame like `MarkerPopover`, with the click point as fallback.
    `data-user-gid` must also stay in the vis `click` bail list or the label click reaches
    `dismissEmptyCanvas()`.
  - This REPLACED the old bar-chart metrics toggle + `UserStatsPopover` + `computeUserStats`
    (window-scoped, timeline-only); the new card is a superset.
- A **maintainer shield** (`MaintainerShield`) marks anyone with merge rights in the
  in-context repo (has merged a PR there, from `useMergers`); `UserName` takes an optional
  `repoId` and renders it wherever a username appears in a PR context, mirroring the
  timeline rows' HTML-string shield.
- **Zebra tinting.** Each repo block gets one of two muted hues (blue/purple),
  alternating by repo **rank parity** (`repoTintIndexById` — not `id % 2`, so tints
  stay stable as repos toggle in/out), via `tl-repo-tint-N` / `REPO_TINT_COUNT`;
  contributor rows also carry a subtle `nth-child` band.
- **Sticky repo header** (`.tl-repo-sticky` overlay, mirrors the Changes-tab sticky
  filenames). An absolutely-positioned DOM overlay over the left label panel shows the
  repo currently at the top of the viewport while you scroll. It's a **pure READER** of
  the scroll panel + `.vis-label.tl-repo-header` rects (`updateStickyRepoHeader` /
  `scheduleStickyHeader`, rAF-coalesced) — it NEVER writes `scrollTop` / touches the
  scroll gate, so it can't fight the scroll loops. Registered next to the connectors
  overlay (passive `scroll` listener + `timeline.on('changed')` + `resize`, all torn down
  on unmount); hides when the real header is already visible (no double header).
- The timeline endpoint stays lean — the selected PR is never filtered out (force-shown if a
  filter would hide it); detail loads only on selection.

### PR detail (`PrDetail.tsx`)

Header carries **Show** + **Focus** links (drive the timeline). Tabs (Overview / Threads /
Activity / Changes, + a presence-gated **Bot activity** + capability-gated Claude Review / AI):
- **Overview** — `ChecksTab.tsx`: CI/checks (each Actions check expands into the inline log
  viewer — see **Merge, CI logs & trunk status**), the **merge verdict** line (open PRs only,
  from `mergeVerdict` — this row is where the old "mergeable" lie lived), **Reviewers** (all who
  submitted a review, badged by latest state) above **Approvers** (latest decisive review =
  `approved`), then **Merged by**, **Requested** reviewers, labels, meta, an **Actions** row
  (approve / `MergeControl` / `ClosePrControl`) — then the PR **Summary** (markdown,
  clamped to 3 lines, tall images hidden when collapsed). **PR comments** (oldest first) round the
  tab off — each with a "Show" link, a per-comment "Check review", and its AI annotations **BELOW**
  the comment (a judgement read before the thing it judges is backwards; it also matches the
  per-thread block) — but that list is rendered by **`PrDetail` itself**, not `ChecksTab`, which is
  why the per-comment `CommentAnnotations`/`ReviewCheckButton` call sites are there. The **Checks
  row now also carries the CI-failure diagnosis** (`CiAnalysisCard`, `showFix={false}`) under the
  checks list + re-run control; its visibility goes through `checksRowVisible(checkCount, ciStatus,
  prSummary)` — the row opens for a red `ciStatus` with UNhydrated `checkRuns` (lean storage /
  SAML-SSO) so a stored diagnosis is still reachable, but only with `prSummary`, since the card is
  that branch's only possible content and `Row` always paints its label.
- **Threads** — `ThreadList`/`ThreadView`: review threads grouped by file, **newest first**
  (files by most-recent thread; within a file by `createdAt` desc), with code anchors +
  new-comment highlights; each has a "Show" link. A sticky header carries **derived-state filter
  pills** (Untouched/Replied/Likely-addressed/Resolved, `store.threadStateFilter: Set<DerivedState>`)
  ANDed with the vendor `threadBotFilter`; the pills' badge counts come from the full loaded set
  (stable), and the bulk "Resolve N addressed" set is derived from the full list (independent of
  the visible filter). Each card renders its whole "Check review" output as ONE block under the
  conversation (`ThreadCheckOutput` — the three judgements key on three DIFFERENT ids, so no single
  `<CommentAnnotations>` can express a thread: `simplify` per comment, `validity` on the root,
  `addressed` on the thread; each rewrite is sublabelled with whose comment it rewrites since it is
  no longer adjacent to it). The bulk-resolve OFFER now goes through `ThreadList/resolvable.ts`,
  which consults the unscoped `useDetectedReviewers` listing filtered to the PR's OWN `repoId` —
  matching what the server re-derives (a bot is judged per repo), since classifying by vendor login
  alone offered a count the server then refused, leaving a dead button with an unchanged count. Arriving from the
  `bot-threads` tab presets `{likely_addressed}` via
  `openPrThreadsFiltered`. **Landmine:** `threadStateFilter` is a GLOBAL store field reset only in
  the selection actions — PrDetail applies it only when `selectedPrId === prId` (mirroring App's
  `selectedThreadId` guard) so a PR opened via `openPrDetailTab` doesn't inherit a stale preset.
- **Activity** — a chronological feed (**newest first**) of opens / commits / reviews /
  comments / merge-close, each with a "Show on timeline" action. A timeline **commit**
  ("View in Activity") or **review** ("Open in detail pane") popover deep-links here via the
  `activityFocus` signal (matched by `{type, refId}`) → opens this tab, scrolls to + flashes
  the entry. The "Show" links share `ShowOnTimeline`.
- **Bot activity** (`PrBotBehaviourTab.tsx`, EXPERIMENTAL, CORE) — shown only when a bot touched
  the PR (`hasBots`: `reviews.automatedKind` or a bot thread-opener/commenter). Per bot: its on-PR
  touch timeline + TTFR/follow-ups vs the bot's OWN typical (`/api/prs/:id/bot-behaviour`). A ⚠
  tab-label badge fires when a bot is slower-than-typical; `ChecksTab` gains an Overview "N bots
  slower than typical — view" caution that opens this tab. **Landmine:** `usePrBotBehaviour` is
  called at the top of PrDetail (before the loading/error early returns) — hooks-order rule.

**There is no PR-wide "Check review" bar any more.** `ReviewCheckBar` (which sat above the tab
content, spanning threads + PR comments) is DELETED: a whole-PR sweep on a bot-flooded PR is many
billed calls and tens of seconds before anything appears, and the question a reader has is about
the one thread in front of them. The only run surface is the per-item **`ReviewCheckButton`**
(thread-card header / PR-comment actions row) — one anchor, one combined call.

Keyboard (`useKeyboard.ts`): `/` focuses the filter, `j`/`k` cycle the board's PRs (board
only), `i` opens Insights, `esc` leaves any tab/overlay → the board (else clears the
selection).

---

## Merge, CI logs & trunk status (CORE, no AI)

### The ONE merge verdict (`lib/ui.ts` `mergeVerdict`)

Every surface that answers "can this land?" resolves it through the pure `mergeVerdict()` →
`MergeVerdictInfo{verdict,label,tone,canMerge,detail}`. It replaced `mergeWarning()` plus each
surface's own ad-hoc reading, which is how the same PR could read "mergeable" in the Overview
and "blocked" in the merge control.

**Why GitHub's `mergeable` is not the answer:** it reports ONLY merge-CONFLICT state
(MERGEABLE / CONFLICTING / UNKNOWN). A PR whose REQUIRED checks are failing is still
`mergeable: 'mergeable'` — which is exactly what the Overview row used to render as a green
"mergeable" (~444 open PRs in one real DB). **`mergeStateStatus` is the protection-aware field**
and the one to lead with (`clean` / `blocked` / `unstable` / `behind` / `dirty` / `has_hooks` /
`unknown`); `mergeable` survives only as the conflict corroborator. `mergeStateStatus` is
**ACTOR-AGNOSTIC** — it does not model an admin's bypass power, which is precisely why it needs
no branch-protection API call to be trustworthy, and why "blocked" may not be blocking *you*.
`reviewDecision` (new PR column) names the review half of a `blocked` status so the verdict can
say *why*; absent (the lean timeline PR doesn't carry it) the reason stays generic, never invented.

- **`unstable` IS treated as mergeable** (`canMerge: true`, warn tone): it means only
  NON-required checks are red, and GitHub's own merge button merges it. Do not read "respects
  CI" as stricter than that. `behind` is `canMerge: false` because GitHub itself 405s the merge
  when the repo requires up-to-date branches. `queued`/`armed` are checked FIRST (the truest
  answer to "what happens next"), then conflicts, then draft.
- `db/triage.ts` had the identical blindness: `approved_ready` tested `mergeable === 'mergeable'`
  alone and tagged PRs "approved & ready" with red required checks. It now also requires
  `mergeStateStatus ∈ READY_MERGE_STATES {clean, has_hooks, unstable}` — **that set and
  `mergeVerdict`'s `canMerge` must agree**, or the triage queue and the PR disagree about the
  same PR.
- Consumers: `ChecksTab` (Overview verdict row, open PRs only), `MergeControl`,
  `Activity/RepoOpenPrList` + `Timeline/prBar` via **`mergeVerdictWarning()`**.
  **Landmine:** `mergeVerdict` returns `draft` before it looks at behind/blocked, and `draft`
  is not a compact warning — so a draft that was ALSO behind lost its ⚠ on the dense surfaces.
  `mergeVerdictWarning` re-derives with `isDraft` dropped and shows only
  `conflicts`/`behind` underneath (never `blocked`/`unstable` — "required reviews missing" IS
  what draft means, and unstable's "GitHub will still merge it" is a lie about a draft).
  `MergeControl` deliberately does NOT pass `autoMergeArmed`: the `armed` verdict reports
  `canMerge: true`, which on that surface would enable a Merge button for a blocked PR.
- `PrMergeOptions.mergeStateStatus` is GitHub's LIVE REST string (it can return values the enum
  doesn't model, `draft` among them), so the live path narrows through **`toMergeStateStatus()`**
  rather than casting — anything unrecognised becomes `unknown`.

### Merge queue (GitHub's native)

`fetchMergeQueueState` / `enqueuePullRequestOnQueue` / `dequeuePullRequestFromQueue` are the
one place `github/mutations.ts` **forks from its REST house style**, and it has to:
`enqueuePullRequest`/`dequeuePullRequest` are GraphQL-only with no REST equivalent, and queue
presence is not inferable from REST at all — `MergeStateStatus` has no QUEUED value, so a queued
PR looks like any other blocked one. Nothing is synced (a position changes minute to minute and
only the merge control renders it): state rides the lazy `merge-options` fetch. When a queue
exists the control REPLACES "Merge" with "Add to merge queue" — GitHub refuses a direct merge on
a queued branch, so offering one only produces a confusing 405. `estimatedTimeToMerge` is SECONDS
in GitHub's schema; the ×1000 lives in the single `SECONDS_TO_MS` constant, applied at the two
call sites that read the field (`fetchMergeQueueState` + `enqueuePullRequestOnQueue`).

### "Merge when ready" (`merge/auto-merge-runner.ts`)

A Pierre-side standing intent in `auto_merge_requests`, re-evaluated on its own cron
(`AUTO_MERGE_CRON` `*/2`, registered in `scheduler.ts` under the same `disableScheduler` gate as
sync — hence the UI saying it only lands while the app is running). Bounded per tick
(`MAX_INTENTS_PER_TICK` 25, least-recently-checked first so a backlog rotates), one tick at a
time, grouped per account so each tenant's token is fetched once and one bad token fails only
that tenant.

**It deliberately does NOT use GitHub's `enablePullRequestAutoMerge`**, which has 422'd since
2026-03-25 on any PR that does not ALREADY meet its merge requirements — i.e. exactly the PRs
the feature exists for. Using it would invert the feature.

Pre-flight, before any GitHub read: past `expiresAt` ⇒ `expired`; PR no longer open ⇒
`disarmed_blocked`; **write permission re-checked at LAND time**, not just at arm time, because
access can be revoked in between and the watcher must never act on a stale grant. Then, per
intent, ONE `GET /pulls/{n}` (`fetchPrMergeSnapshot`) serves both the head and the mergeability —
they are non-overlapping fields of the same payload, and reading them separately cost 750 wasted
calls/hour at 25 intents. The gates it feeds:

1. **Pinned `expectedHeadOid`** — arming is consent to merge THE CODE THE USER SAW. A different
   head ⇒ `disarmed_head_moved`, never a merge.
2. **`isOurUpdateMerge`, the one sanctioned re-pin** — a head move is adopted only on all three
   proofs: we issued an update for THIS intent recently against exactly the pinned head; the new
   head is a **TWO-parent** commit whose FIRST parent is that pinned head (a human commit on top
   also has the old head as a parent — the ARITY is what separates "merged into" from "pushed
   onto"); and the second parent is contained in the base ref. Anything unproven, including a
   compare that couldn't run, is a NO.
3. **Async update-branch is never re-pinned optimistically** — GitHub's update returns **202
   ACCEPTED** and merges asynchronously with no handle to poll, so re-reading the head there
   would adopt a concurrent human push as consented-to code. The runner records what it ASKED
   for (`pendingUpdates`, TTL 15 min) and lets a later tick prove the move via (2).
4. **Retarget guard** — a `PATCH pulls/{n}` base change leaves `head.sha` alone, so the head pin
   is blind to it; the runner compares the live base against the last SYNCED base ref and
   disarms on a mismatch (waiting, not merging, when it can't tell). The exact fix is an
   `expected_base_ref` column that does not exist yet.
5. **COMPARE-AND-SET immediately before the merge** — everything above acts on a scan snapshot
   that can be minutes old; a user who hit Cancel mid-tick DELETED the row, and merging anyway
   would leave the UI saying "cancelled" for a PR that landed.
6. **Green light = `mergeableState ∈ {clean, has_hooks, unstable}`** — so, as everywhere else,
   **`unstable` merges** (CI red but not REQUIRED by branch protection), matching GitHub's own
   button. `blocked`/`conflicts` KEEP WAITING with a `lastReason` (unblocking on its own is the
   whole value of arming); only a head move disarms. `unknown` waits.

**Landmine: `behindBy > 0` is true of MOST healthy PRs** (any trunk commit since the branch
point) — only `mergeStateStatus === 'behind'` means GitHub is blocking. Treating `behindBy` as a
blocker parked every clean armed PR forever, and freshening on it every tick pushed a merge
commit (and a CI run) every two minutes for the intent's 72h life; hence `freshenedIntents`,
which honours "update before merging" exactly ONCE. A local rebase (`coding/merge.ts`, local-only
— cloud has no clone) IS synchronous and returns the sha it pushed, so re-pinning to that adopts
nothing we didn't produce. On success the runner stamps the PR merged locally (like the
interactive route) and sets `merged`; a merge/close that happened outside Pierre becomes
`disarmed_blocked`, NOT `merged` — the latter means "the watcher did it" and would raise a false
toast. `MAX_CONSECUTIVE_FAILURES` 3, counted in memory so a restart errs towards retrying.
Client side: `useArmedMerges` polls `GET /api/auto-merge` (45s, foreground only) and
`AutoMergeBanner` toasts only on an `armed → terminal` TRANSITION it observed itself — the first
poll seeds a silent baseline, so a page load never replays yesterday's outcomes.

### CI logs (`github/actions-logs.ts`)

`GET /repos/…/actions/jobs/{id}/logs` 302s to a short-lived signed blob URL that **does honour
HTTP `Range`** (206 + `Content-Range`), so the fetcher resolves the redirect itself
(`redirect:'manual'`) and issues ONE ranged GET for the window it wants — real byte chunking, not
a download-then-slice. The signed URL is server-side only and NEVER returned to a client (it is
unauthenticated and would bypass the route's ownership check). `parseContentRange` also parses
the start-less `bytes */<total>` form — the shape RFC 7233 mandates on a 416, and the only way to
learn the log's true size when the window fell past the end; a start-anchored-only regex made the
416 recovery dead code.

**Logs are offered for PASSING checks too** — the failure-only gate was OURS, not GitHub's, which
serves logs for every Actions job, and "what did this green check actually run?" is a real
question. `CheckRow` now expands for any check with a job id parsed out of its `detailsUrl`;
third-party checks (external URL, no job) keep the plain link row. The viewer opens at the TAIL
and pulls EARLIER chunks as you scroll up (`useCheckLogs`, a `useInfiniteQuery` where "next page"
means earlier, `LOG_PAGE_BYTES` 128 KiB); the prepend is anchored by **distance from the bottom**,
which is what stays constant when content is added above, and the "Load earlier" control lives
OUTSIDE the `<pre>` so it can't change the scroller's `scrollHeight` mid-anchor.

### Default-branch ("trunk") status

`GET /api/branch-status` over `repos`' four head columns + `branch_commits` (written by the sync
step described under **Sync pipeline**). It exists because everything else in this app is
PR-shaped, while a broken default branch invalidates every open PR's CI at once — and because it
**cannot come from the existing `commits` table, which is PR-scoped: a squash-merged PR never
appears there under the SHA that landed on trunk**. Deliberately informational: it feeds no
attention count, no badge, no My Turn.

- **Both detail columns follow the partial-response write policy** (Conventions): `undefined` ⇒
  omit the key from the upsert, `null`/`[]` ⇒ clear. `failingChecksToWrite` /`prNumberToWrite`
  are the implementations, and what counts as GitHub's POSITIVE statement is specific — for
  failing checks, a green/`expected` phase-1 ROLLUP or a phase-2 response that actually carried a
  `contexts` list (an `unknown` rollup, which is also what a nulled-by-partial rollup maps to,
  clears nothing); for the PR ref, an `associatedPullRequests.nodes` ARRAY, whose emptiness means
  "this commit came from no PR" — a direct push, a legitimate steady state, not a gap.
  Phase 2's own failure is caught separately (`syncBranchStatus` is already non-fatal upstream, so
  an unguarded throw here would discard the phase-1 snapshot too): detail failure degrades to "no
  carets", never to "no strip".
- Failing checks reuse `sync/upsert.ts`'s `checkContextState` + `parseActionsIds` **verbatim** (now
  exported) so a trunk failure is the SAME object as a PR failure — one vocabulary, one icon set.
  They are deduped by display name keeping the highest Actions `runId`, because `contexts` returns
  every check suite on the commit and does not collapse to latest-per-name the way GitHub's PR UI
  does. `workflowName` is null for a legacy StatusContext and for a non-Actions suite; nothing may
  require it. The repo-level `failingChecks` is DERIVED from the commit whose sha is `headSha`
  (one writer, one reader), matched by SHA and not by position — a backdated committer date can
  sort the head outside the read cap.
- **Commit → PR link.** `pickAssociatedPrNumber` stores exactly ONE number from
  `associatedPullRequests` under a 0/1/many contract, ranked (merged into THIS default branch) >
  (merged anywhere) > (open) with the lowest number as tiebreak — determinism is the point, since
  `first:1` on an unordered connection could FLIP between syncs. Candidates from another
  repository are DROPPED (the connection spans the repo network, so a fork's PR can appear).
  **Landmine: the read layer's map key is `(repoId, number)`, NEVER a bare number** — PR numbers
  are unique only WITHIN a repo, so a number-keyed map cross-links repo A's #12 onto repo B's
  commit and opens the wrong PR. The `inArray × inArray` predicate intentionally over-matches;
  keying by the pair is what makes that harmless, and there is a seeded test rather than only a
  comment. `prId != null` → open the PR's own detail tab in-app; `prNumber` set but `prId` null
  (squash-merged before the backfill window, or a repo added later) → link out to github.com;
  both null → no chip. Headlines go through `lib/prRef.ts` `trimTrailingPrRef` first: GitHub
  truncates `messageHeadline` itself (~70 chars, a literal U+2026) and the trailing `(#1234)` is
  the FIRST thing eaten, so the chip would otherwise sit next to a dangling `(#2…`.
- UI: `Activity/BranchStatusChip` (rail row: dot + branch + age; a HOLLOW dot for "no CI
  observed", unlike the PR surfaces which render nothing for `unknown`) and
  `Activity/BranchStatusPanel` (cross-repo strip on the Feed entry, `compact` per-repo variant in
  `RepoFeedHeader`). A per-commit expander is driven by `failingChecks.length`, never by the dot's
  colour, so a caret can never open onto an empty drawer.

---

## Claude Review (agentic PR review)

A **Claude Review** tab runs the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`)
against the selected PR, returns **structured JSON findings** (persisted per head SHA,
history kept), lets the user author their own review + tick which findings to post, then
posts **one** GitHub review (inline + body + verdict).

- **Opt-in, off by default, LOCAL-ONLY.** Gated behind `ENABLE_CLAUDE_REVIEW=true`
  (`config.claudeReviewEnabled`) — it spends real money per run. **Force-disabled in cloud**
  (`!isCloud && …`): the routes aren't even registered (`app.ts`), so the gh-CLI/clone-manager
  dep stays unreachable on Railway. When off, the frontend hides the tab (via `/api/me`).
- **Auth resolves from the ambient env** (`ANTHROPIC_API_KEY` → `CLAUDE_CODE_OAUTH_TOKEN`
  → a logged-in Claude session); `review/auth.ts` detects it best-effort (the first real
  SDK auth error is the authoritative gate). A **user-supplied key** (pasted in the tab,
  `PUT /api/claude-review/key`, stored local-only via `review/local-settings.ts`) wins:
  `agent.ts` overrides `process.env.ANTHROPIC_API_KEY` for the run (restored in `finally`,
  gated on `reviewConcurrency===1` to avoid an env race).
- **`src/review/`** mirrors the sync machinery: `review-manager.ts` (in-memory job
  manager, one review/PR, `config.reviewConcurrency` gate, startup reconcile of orphaned
  `running` rows), `agent.ts` (the SDK run: an in-process MCP `submit_review` tool —
  `schema.ts` — captures structured output; read-only tools, `cwd` = a worktree,
  `bypassPermissions`, `settingSources:[]`, `maxTurns`/`maxBudgetUsd` caps,
  `AbortController` cancel), `clone-manager.ts` (partial clones under `config.cloneDir`,
  ephemeral per-run worktrees, LRU cleanup), `prompt.ts` (inline prompt + `NOISE_GLOBS`
  diff stripping), `post-review.ts` (line-anchoring + the single review POST), `persist.ts`.
- **Deterministic routing** (`review/routing.ts`, tested): BEFORE the agent runs, a pure
  diff-metrics gate (`config.reviewRouting`) picks a `reviewMode` — `skip` / `diff_only`
  (tool-less, no clone) / `worktree` (full clone as context) — stored on `reviewMode` +
  `routeReason` (migration 0013). Conservative: `diff_only` only within every size/spread
  ceiling AND touching no exported contract (`API_PATH_PATTERNS`/`EXPORT_MARKERS`); ambiguity
  → `worktree`. User can force a mode per run.
- **Line-anchoring is the load-bearing bug risk** (`buildAnchorIndex` in
  `post-review.ts`): a ticked finding posts inline on its `(path, line, side)` when that
  lands on an addable diff line; otherwise it **re-anchors to the file's first changed
  line** (so an off-by-a-line finding still posts inline) and only truly unplaceable
  ones fall back to the review body. Posting pins `commit_id` to the head SHA, 409s if
  it moved.
- **Frontend:** `ClaudeReviewTab.tsx` + `useClaudeReview.ts` (polls `…/status` while
  running). Claude's output is **read-only** (Copy buttons); a separate "Your review"
  textarea + verdict is what posts. Re-reviewing the same head SHA **warns but is allowed**.
- **Packaging (NO AI in npm):** the AI SDKs (`@anthropic-ai/claude-agent-sdk`,
  `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, and `zod` — used only by the AI tools'
  submit-review schemas) are **NOT** curated runtime deps in `build-release.mjs`; a guardrail
  assert fails the build if any leak into `release/package.json`. Every module that pulls one
  is reached **only** through a dynamic `await import()` — from the private `@pierre/pro`
  plugin's seams (`review/agent`, `coding/agent`, `coding/merge`, `review/prepare`,
  `review/post-seam`) or lazily inside `review/llm.ts` — so the SDKs load **only when the
  plugin is present** (author/dev checkout), **never from npm** and **never in cloud** (`bind.ts`
  returns before any AI import when `!config.proEnabled`). The compiled-but-inert AI `.js`
  files still ship as dead code (harmless — nothing loads them). The inline prompt + `import
  type`-only shared usage keep the no-`.ts`-leak / no-shared-runtime guards passing.

## Open-core Pro plugin (`@pierre/pro`) + the Activity tab

Three workstreams sit behind one **open-core seam**: the public repo holds only the
contract + a guarded import + inert hooks; **all premium logic lives in the private,
runtime-imported `packages/pro`** package. Docs: **[docs/PRO-PLATFORM.md](docs/PRO-PLATFORM.md)**.

**`packages/pro` is a PRIVATE git submodule** (`github.com/alexwakeman/pierre-pro`, SSH).
A pure-OSS checkout of `pierre-review` does **not** have it — `git clone` leaves
`packages/pro/` empty unless you `git submodule update --init` with access. Because the
public repo is genuinely public, the premium source must never be committed here; only the
`.gitmodules` entry + the submodule gitlink are public. It IS a `pnpm` workspace member
(`packages/*` glob) when checked out, so `pnpm install` installs its deps into
`packages/pro/node_modules`; when absent the glob skips the empty dir and install still
succeeds.

**Three tiers.** **core (free)** = plain feed + timeline + **My Turn / "FYI"** (feed participation —
moved back to core, on every tier; see `feed/my-turn.ts`), no AI. **pro** = AI summaries +
Insights (on whenever the plugin is active — no env flag, like `workspaceInsights`/`reviewMemory`).
**pro+** = the expensive advanced-AI features **AI Analysis + AI
Fix + Claude Review**, all gated together by **one** env flag **`PRO_ADVANCED_AI_ENABLED`**
(`PRO_CLAUDE_REVIEW_ENABLED` kept as a back-compat alias; the single source of truth is
`packages/pro/src/tier.ts` `ADVANCED_AI_ENABLED`, read by `index.ts` for the caps AND by each
feature's route/manager self-gate). The `aiAnalysis`/`aiFix`/`claudeReview` capability fields
remain distinct but flip together.

**The plugin boundary.** `src/pro/contract.ts` defines `ProContext` (the host hands the
plugin `db`/`schema`/`runTransaction`/`isPg`/`accountIdOf`/`llm.complete`/`queries`/
`reviewEvents`/`registerLearningsProvider`/`registerScheduledJob`/`registerPrDetailEnricher`/`registerMigrations`/`aiCredits`), `ProPlugin
{apiVersion:14, register()}`, and a `getProCapabilities()` singleton mirrored to the SPA via
`/api/me` (`pro:{activityDigest,reviewMemory,aiAnalysis,prSummary,aiFix,workspaceInsights,claudeReview,slackDigest,issueLinks}`)
exactly like `claudeReviewEnabled`. `src/pro/bind.ts`
runs in `index.ts` between `buildApp()` and `listen()`: gated on **`config.proEnabled`** — now
`PRO_DISABLED!=='true' && (!isCloud || PRO_CLOUD_ENABLED==='true')`, so Pro is on locally by default
AND can run the **paid summary-AI tier in cloud** behind `PRO_CLOUD_ENABLED=true` (agentic AI stays
off via unset `PRO_ADVANCED_AI_ENABLED`; per-account entitlement via `plan!=='free'` + the
`/api/pro/* 402` gate). It is **NOT a declared dependency** — instead `bind.ts` resolves the plugin by
**filesystem path** (`PRO_PLUGIN_PATH` override → `packages/pro/dist/index.js` → `packages/pro/src/index.ts`,
relative to the repo root via `import.meta.url`) and `await import(...)`s it. **Absent submodule ⇒ no entry file ⇒
clean OSS no-op, and `pnpm install` never fails** (the public-CI path). The path-based loader
(not a bare `@pierre/pro` specifier / workspace dep) is what keeps install working without the
submodule — don't reintroduce a `package.json` dependency on it. The plugin imports **no host
internals** — everything arrives via `ctx`; `ctx.db` is node-postgres-typed so a stray `.get()`
is a compile error in the plugin too. It resolves under **tsx** (dev, `src/index.ts`); a built
`node dist` run would need `packages/pro/dist` (no build step yet — Pro is local/dev-only). The
plugin is **never in the release allowlist** (`build-release.mjs`). Plugin owns its **own**
dual-dialect tables (`review_learnings`, `repo_digests`), migrations
(`packages/pro/migrations{,-pg}/*.sql` run via `ctx.registerMigrations` → `src/pro/migrate.ts`,
the one sanctioned raw-`$client` DDL site + `pro_migrations` bookkeeping), and isolation test.

**`apiVersion` is 14** (bumped from 13 by the Workspace refactor — a breaking `ProContext` change).
⚠ **FOUR literals must agree, not two**, and the one that actually enforces the handshake is the
easiest to miss: `apps/backend/src/pro/contract.ts` (the host's declared `ProPlugin['apiVersion']`),
`packages/pro/src/index.ts` (the plugin's exported value), `packages/pro/src/contract-types.ts` (the
plugin's mirror), and **`apps/backend/src/pro/bind.ts`'s `plugin?.apiVersion !== 14` — THE RUNTIME
GATE**. A half-bump makes `bind.ts` log-and-degrade the ENTIRE plugin to OSS mode: capabilities dark,
every `/api/pro/*` 404, nothing thrown. ⚠ **Nothing currently PINS the handshake** —
`pro/contract.test.ts` asserts capability KEYS (it was updated for the `workspaceInsights` rename)
and contains no `apiVersion` reference at all, so the only detection is `tsc` (TS2367 no-overlap at
the `bind.ts` gate, assignability at `index.ts`) plus a boot check that `/api/me` reports
`pro.workspaceInsights === true`. An assertion pinning the plugin's exported value against
`ProPlugin['apiVersion']` is still worth adding. What v14 changed:

- **`BotScopeWire = { workspaceId: number; repoIds: number[] }`** replaces `repoIds?: number[] |
  null` on `getActivity`, `getBotAnalytics`, `getBotReviewComments`, `getHumanReviewComments` and
  `getWorkspaceInsights` (was `getTeamInsights`); `getWorkspaceMetricsDetail` (was
  `getTeamMetricsDetail`) takes a REQUIRED `repoIds: number[]`.
- **NEW `ctx.queries.workspaceScopeForRepo(accountId, repoId)`** — the repo→workspace direction, for
  the two plugin call sites that hold only a repo id (`insights/routes.ts`'s
  `GET /api/pro/insights/repo/:repoId/metrics`, `activity-digest/metrics.ts`'s digest payload
  builder). Without it both are unimplementable.
- **NEW `ctx.queries.defaultWorkspaceId(accountId)`** — for the two ACCOUNT-WIDE CRON paths that
  have no request and therefore no `?workspace=` (the Slack digest and the AI-policy sprint
  refresh). It is a signature change, not vocabulary: their old `scope = 'all'` default has no image.
- Capability **`teamInsights` → `workspaceInsights`**; the other nine fields (`botTriage` included)
  are untouched.
- `ctx.schema` automatically exposes `workspaces`/`workspaceRepos`/`workspaceReviewers` and no
  longer exposes `teams`/`teamRepos`/`repoReviewers`/`accountReviewers`. ⚠ **`tsc` will NOT catch a
  leftover**: `ProCoreSchema` is `Record<string, any>`, so `ctx.schema.teams` type-checks perfectly,
  evaluates to `undefined`, and drizzle throws only when that path executes. Grep, don't trust the
  compiler.
- `insights/scope.ts` → `insights/workspace-scope.ts`, down to ~25 lines: `parseWorkspaceId`,
  `scopeKeyFor(workspaceId) → \`ws:${id}\`` and `resolveWorkspaceRepoIds`. `normalizeScope`,
  `teamSetIds` and `resolveScope`'s five branches are deleted. `resolveWorkspaceRepoIds` returns
  **exactly the workspace's repos** — there is no second set to intersect with. It briefly
  intersected `repos.inboxWatch = true` (the AI corpus was the WATCHED set, so an unscoped sprint
  report / grounded chat / Themes pass would not bill for repos the user had un-watched) but that
  column is gone with the whole watch concept (migration `0046` / pg `0033`), and the bound it was
  really providing — "an AI pass must not fan out past the scope the user chose" — is now provided
  by the workspace itself. ⚠ **The bound still has to hold**: an unscoped AI generator must resolve
  to ONE workspace's repos and never to the account's, which is what `defaultWorkspaceId` is for
  (below).
- ⚠ **The `scope_key` COLUMN NAME did not change; its VOCABULARY did**, to `ws:<workspaceId>`. The
  `ws:` prefix is deliberate: a bare number would alias a legacy `'3'` (team 3) onto workspace 3,
  whose repo set differs, and a stale cached AI report would then be served for the wrong repos.
  Plugin migration `0020` clears the four regenerable report caches and RE-KEYS the two
  user-authored tables (`pinned_prompts`, `sprint_chat_history`) by case; the prefix is what makes
  a partial replay a cache MISS rather than a wrong answer.

**Activity tab — CORE, always-on, NO AI (not flagged); the DEFAULT landing view.** A peer of
Timeline on the **tab axis** (`ActiveTab = 'timeline' | 'activity' | <Tab.key>` in
`store/pinnedTabs.ts`; the Activity console is a full-`<main>` overlay over the warm board;
`?view=activity&activityRepo`). The rail is a fixed block of pseudo-rows, **then a FLAT list of the
active workspace's repos**:

```
◈ Insights (Pro)      gate: caps.workspaceInsights
✦ Feed                always
🤖 Bots               always (CORE/free)
⚖ Compare workspaces  gate: (workspaces ?? []).length >= 2
⚠ Needs attention     always (CORE/free)
── repos ──           flat: no grouping headers, no colour dots, no "Other" bucket
```

The daily surfaces lead; Compare and Needs attention are the occasional ones. **The rail is no
longer GROUPED** — a repo belongs to exactly one workspace and exactly one workspace is ever in
scope, so there is one list, `renderRailRow`'s key is the bare `String(repoId)` (never a
`${teamId}:${repoId}` composite), and `buildTeamColorMap`/`teamGroups`/`leftoverRows`/the "Other"
bucket are all deleted. (`lib/workspaceColors.ts` survives, imported ONLY by
`WorkspaceComparisonPanel`.) Selecting a repo shows a **compact header** (stats + thread-state bar +
per-repo Pro digest) atop that repo's **open-PR list** (`RepoOpenPrList` — all its open PRs with
at-a-glance CI / approval standing / thread counts) THEN that **repo's own feed** (`RepoFeedHeader`
+ `RepoOpenPrList` + `<FeedView repoId>`). The rail selection is `store/filters.ts` `activityRepoId`
(`'feed'` default | `'bots'` | `'attention'` | `'insights'` | **`'compare'`** | a repoId; `'retro'`
is gone with the Retro panel).

- **The Compare gate is `(workspaces ?? []).length >= 2`** — a count over the ACCOUNT-WIDE roster,
  Default included, **never a test on the selection**. It answers "has the user created a workspace
  of their own?", which is only true at 2+. The panel then compares ALL of them, so the entry's data
  does not depend on which workspace is selected. ⚠ `undefined` (not loaded) must read as HIDDEN,
  not "show optimistically" — and the CONVERSE, demoting a deep-linked `?activityRepo=compare` to
  the Feed, must wait until the roster has actually LOADED (`workspaces != null && !canCompare`), or
  that same pre-load window flashes the Feed before Compare.
- **DERIVED, never written back**: when the gate is known-false the render falls back to `'feed'`
  and the store keeps `'compare'`, so deleting and recreating a workspace RESTORES the entry instead
  of having silently forgotten it.
- ⚠ **Branch POSITION in the right-detail chain is load-bearing.** The chain is `noReposAtAll →
  showingBots → showingAttention → showingCompare → showingInsights → noRepos → showingFeed`, where
  `noRepos` means "the SELECTED workspace has no repos" (the account may have plenty, living in
  other workspaces — the empty state distinguishes the two, since the remedy differs: add a repo vs.
  move one in). `showingCompare` must sit **BEFORE `noRepos`** — the natural reading of the rail's
  top-to-bottom order would put it after, which makes Compare unreachable whenever the selected
  workspace happens to be empty, i.e. exactly when someone is setting workspaces up.

Built **entirely on the read layer**: `getActivity` composes
`getInsights`/`getOpenPrs`/`getMergers`; `listClaudeReviewsByRepo` is retrieval-only. **Scoped by
the active WORKSPACE, and by nothing else** — the workspace id flows into the `useActivity` /
`useConsolidatedFeed` query keys (which carry a `ws:<id>` segment), so switching workspace re-scopes
the whole console and refetches (dim, never blank). ⚠ **Neither the Members panel NOR the repo
picker scopes Activity** — both are Timeline-only filters, and the console's queries send
`userIds: null` and never `filters.repoIds`. A `repoIds` on these hooks is always an EXPLICIT caller
scope (the per-repo console passing its own `[repoId]`), never the FilterBar's picker; you narrow
Activity by clicking a repo row in the rail. Refresh re-queries the **DB only**. Open-PR lists show 10 rows; ">10" swaps the old
pagination for a "Show all N" footer opening the sortable `open-prs` drill-down tab.
**Clicking any open-PR row/card opens the PR's detail tab** (`openPrDetailTab`) — no longer
isolates the feed on click. The **"Showing only #N" feed-isolation banner** (`FeedIsolationBanner`,
set from PrDetail's "Show in Activity feed" button or a drill-down, dismissible with Clear) renders
**directly under the panel's summary header** — under `RepoFeedHeader` in the per-repo Activity
console, under the "Review bots" header in `BotsView` (bot-only "Show in feed" lands there), and in
the empty-workspace fallback branch — so it's present in every context isolation can reach (never
sticky; scrolls with content). When isolated, that view also **hides the repo-wide charts +
open-PR list**: RepoConsole drops `RepoInsightsPanel`/`RepoOpenPrList`, and `FeedView` drops its own
cross-repo `FeedOpenPrsPanel`. `FeedView` still reads `feedIsolatedPrId` only to scope its query;
the feed-wide "New activity — Refresh" banner remains sticky as its own element.

**The rail entries' inner sub-tab bars** (all transient + URL-silent, all built DYNAMICALLY so a
tab exists only where it means something):
- **Feed** — `Feed` | `Themes` (Pro, `activityDigest`). Only Themes carries a "pro" pill.
  **`Compare teams` LEFT this bar** for its own rail entry: it compares every workspace in the
  account, which is not a property of the Feed's scope and had no business being nested under it.
  `feedInnerTab` is `'feed' | 'themes'` — `'compare'` is not a member. (It is TRANSIENT: in
  `freshDefaults()` but not in `FilterDefaults`/`pickFilterBarState`/`sanitizePersistedFilters`, and
  `useUrlState` never touches it, so a stale `'compare'` cannot survive a reload and needed no
  migration.)
- **Bots** (`BotsView`) — `ROI` | `Behaviour` | `Themes` (Pro, cross-repo only) | **`Settings`**
  (CORE/free — the classification tab, see below; it shows in the per-repo Bots tab too, where it is
  the same WORKSPACE listing filtered CLIENT-SIDE to the actors with a footprint in that repo).
- **Insights** — the bar **no longer renders**: `SUB_TABS` is down to `Overview` alone (Retro is
  deleted, Compare moved to the Feed, Sprint folded into Overview long ago), and the bar is guarded
  on `SUB_TABS.length > 1`. The apparatus is kept live and type-checked, with a `normalizeSubTab`
  MEMBERSHIP test (not a chain of `=== 'sprint'` literals) so a stale/deep-linked key falls back to
  `overview` instead of stranding the pane on a tab that renders nothing — which is why
  `InsightsSubTab` stays `'overview' | 'sprint'`: the vestigial member is the one value that keeps
  that redirect reachable AND type-checkable. `'retro'`/`'compare'` were REMOVED from the union.

**Landmine — the visible tab is DERIVED, never written back.** `feedInnerTab` / `botsInnerTab` (and
`activityRepoId === 'compare'`) are single scalars that can legitimately hold a key the current
context doesn't render (Themes without the capability, Compare with one workspace). Each consumer
computes an `effectiveTab` fallback for the RENDER only; a corrective `set…` would permanently
forget the user's choice, so deleting a workspace would LOSE Compare rather than restore it when a
second workspace comes back.

**Activity render-perf (client-side; the console + Bots sub-tab mount fresh on every tab switch).**
Two low-risk levers keep opens fast: (1) **warm snapshots** — `useActivity`/`useConsolidatedFeed`
+ the six bot read-queries carry `gcTime: ACTIVITY_GC_TIME` (45min, exported from `useActivity.ts`,
mirrors usePr's `DETAIL_GC_TIME`) so a switch-away-and-back within a session repaints from cache
instead of the default-5-min-GC → skeleton → refetch; retention-only (staleTime unchanged, so no
stale surprise). (2) **smaller first-paint window** — `FeedView`'s initial virtual window is `end:12`
(not 30); the post-paint rAF `recompute` widens it to viewport+`FEED_OVERSCAN`, so first paint no
longer builds ~30 react-markdown/highlight cards it discards a frame later. The bigger "keep
ActivityView mounted-but-hidden" lever was deferred (medium-risk: hidden-mount windowing/`clientHeight`,
mark-seen/insights-default once-per-mount effects, the 60s head poll).

**Review-bot triage — "the calm layer above your review bot" (CORE, deterministic, NO AI).**
Third-party AI review bots (CodeRabbit/Greptile/Copilot/Qodo/…) are a **first-class, triaged
signal**, not generic excluded noise. **Classifier:** `REVIEW_BOTS` (login → vendor `ReviewBotKind`)
+ `reviewBotKind()` in `@pierre-review/shared` (bundled by the frontend); the backend can't import
shared at runtime so `sync/bot-detection.ts` keeps a **LOCAL copy** (folded into `isLikelyBot`),
kept in lockstep by `bot-detection.test.ts`. Verified logins (2026-07); coding agents (`sweep-ai`,
`copilot-swe-agent`) + dependency bots (`dependabot`/`renovate`/`snyk`) are deliberately EXCLUDED —
still `isBot`, just not *review* bots. **Surfaces:** a PrDetail "Bots" chip ("CodeRabbit · 12 · 3
unresolved", `ChecksTab`) that filters the Threads tab to that vendor (`store.threadBotFilter`); a
feed **bot lens** (all/hide/only, `store.feedBotLens`) + per-row vendor tag (`FeedView`); a **core
per-repo acted-on stat** (`ActivityRepoStats.botThreads/botThreadsActedOn` computed in `getActivity`
→ `RepoStats`, free); a **Pro-gated deterministic `bot_signal` Insights card** (per-vendor volume /
acted-on % / oldest-untouched backlog, computed in core `getWorkspaceInsights`, rides `/api/pro/insights`
+ `workspaceInsights` — no new cap); and confirm-gated **bulk-resolve** of
`likely_addressed` bot threads (`ThreadList` → `resolve-bot-threads`). "Acted-on" = the existing
`derivedState ∈ {resolved, likely_addressed}` heuristic (approximate — the UI says so). No migration,
no new AI/credit surface.

**Bot-Triage Platform (v2) — builds ON the v1 layer; CORE deterministic + PRO panels; NO new
AI/credit surface for the deterministic core.** Detection is now an
**account-scoped multi-signal classifier** (`sync/{review-fingerprint,reviewer-classify,reviewer-behavior,
app-attribution}.ts`), resolution order: **manual override > known vendor login > `users.githubType`
`'Bot'`/app-attribution > branded-marker fingerprint > behavioral score (medium confidence, never
auto-badges) > opt-in Haiku tie-break** (settings-gated OFF — the only AI, for the medium band).
`users.githubType` is captured from the GraphQL author `__typename`; `AUTOMATED_LOGIN_PATTERNS` + a
per-account allowlist catch service-account PATs. Classifications live in the CORE account-scoped
`workspace_reviewers` (manual + auto rows, uniq `(accountId, workspaceId, authorUserId)`) — see
**One bot object** below. New shared type
**`AutomatedReviewerKind = ReviewBotKind | 'in_house' | 'pierre'`** (widens `BotSignalVendorStat.kind`).
**Pierre's own review is tagged bot-derived PER-REVIEW** (not per-account): a compute-on-read join
`claudeReviews.postedReviewId = reviews.databaseId` (both TEXT) sets `provenance` = `ai_verbatim`
(`userBody===summary`) vs `human_curated` and `kind='pierre'` on the `ReviewDetail` ONLY — **the human
who posted (their token) is NEVER reclassified**. An optional hidden marker `<!-- pierre:claude-review
v=1 -->` + visible footer are stamped in `review/post-seam.ts`, gated by `pro_settings`
`bots.tagPierreReviews`/`pierreFooter` (threaded via the back-compat OPTIONAL `PostReviewArgs.pierreMarker?`/
`pierreFooter?`), and dogfooded through the same fingerprint detector. **Bot-ROI** (`getBotAnalytics(accountId,
window, scope)`, CORE) → per-kind volume/actedOn%/untouched/`overdueUntouched`/`medianAddressedMs`/oldest/humanFollowThrough/noiseRatio/`verdict`
(keep|tune|**noisy**) + ≤12wk trend + deterministic tuning suggestions → `BotRoiPanel`; **cost is
SERVER-resolved from the workspace row**, with the `pro_settings` `bots.cost` blob surviving only as
a null-only client fallback. The `noisy` (ex-`kill`)
verdict is **response-time-gated**: it keys on `overdueUntouched` (untouched threads older than a
FIXED 36h grace window, `totals.overdueGraceMs`; `medianAddressedMs` per bot = time-to-addressed, display-only), never raw `untouched`, so a bot
isn't flagged noisy for threads still inside the normal response window (tested in
`bot-analytics-verdict.test.ts`). **Cross-bot dedup**
(`getBotDedupClusters(prId,accountId)`): groups automated-reviewer threads by `(path, line±window)`
across DISTINCT kinds → consensus/conflict, a rollup in `ThreadList` + `FeedView`. **Slack:** a
deterministic "Review bots" block in `buildSlackReport` (reads the `bot_signal` card from
`getWorkspaceInsights`), gated on `pro_settings` `bot_slack_digest`, sent even when the AI digest is
empty. ⚠ It is a CRON with no request, so it now resolves `ctx.queries.defaultWorkspaceId(accountId)`
and covers the **Default workspace ONLY** — see Known gaps.
**Resolve (user-initiated only):** resolving `likely_addressed` bot threads on GitHub is a strictly
**user-initiated, confirm-gated** action via the shared `resolveThreadsOnGitHub` helper
(`src/bot-triage/resolve.ts`) — the per-PR `resolve-bot-threads` route + the workspace-wide
`bot-threads/resolve` route. **ONLY `likely_addressed` threads, logged, never a merge.** _(REMOVED:
the old `bot_mute_rules` "hide" mute (Pierre-only cosmetic filter) + the standing `auto_resolve` cron
(`getAutoResolveCandidates` + `sync/bot-triage/auto-triage.ts`, `*/30`) were dropped — "mute in Pierre"
changed no behaviour, and the unattended cron was replaced by the confirm-gated manual resolve. The
`bot_mute_rules` table / `/api/bot-mute-rules` routes / `BotMuteRulesEditor` are gone; migration `0029`
still creates an orphan table; `pro_settings.bot_auto_resolve*` columns are now vestigial.)_
**"Only a bot reviewed this" risk flag:** a `bot_only_review` Insights card (`getBotOnlyReviewPrs`;
Pierre-verbatim counts as bot-derived) + a `ChecksTab` caution. **Settings:** the account-wide
"Review bots" section (`BotSection`) backed by `pro_settings`'s 11 `bot_*` columns — the per-reviewer
`DetectedReviewersTable` lives in the Bots **Settings** sub-tab (below), which shows in the per-repo
Bots tab too, where it is the same WORKSPACE listing filtered client-side to that repo's footprints. Deterministic tuning suggestions on the ROI panel are **advisory only** (no mute action).
**Tiers:** detection/analytics/dedup/resolve are **CORE (free)**; the analytics PANELS, Slack block,
and Pierre tag/footer are **PRO** (gated on the existing `workspaceInsights`/`slackDigest` caps — no
new cap). **Migrations:** core `0027` (`users.github_type`), `0028` (`bot_review_classification`), `0029`
(`bot_mute_rules`, now orphaned), `0042` (pg `0029`: RE-KEY to `repo_reviewers`, per repo, and
DROP `bot_review_classification`), `0043` (pg `0030`: NORMALISE the actor grain out into
`account_reviewers`), **`0045` (pg `0032`: COLLAPSE both onto `workspace_reviewers`, and DROP
them)**, pg baseline `0016`; pro `0009` (`pro_settings` + 11 `bot_*` columns), pro `0019` (now a
guarded NO-OP), pro `0020` (the `bot_cost_json` → `workspace_reviewers.monthly_cents` backfill).
**Landmines:** (1) Pierre = **per-review** provenance — the human
author is never reclassified; (2) resolving bot threads is ALWAYS user-initiated + confirm-gated over
**only `likely_addressed`** threads, never a merge (no automatic/cron path exists); (3) the frontend
must use `automatedReviewerMeta()`, NOT `BOT_VENDOR_META[kind]`, for an `AutomatedReviewerKind`;
(4) `getBotAnalytics` **server-resolves cost from the workspace row** — a null there is FINAL, the
client-side `pro_settings` overlay survives ONLY as a null-only fallback for logins the plugin's
backfill could not attach to a row (it only ever UPDATEs, never INSERTs), and the price must **never
be summed across WORKSPACES**; (5) a **JUDGEMENT write may never touch identity, an IDENTITY write
may never touch judgement, and NEITHER may touch the price** — the two-table boundary that used to
guarantee that is gone, so the guarantee is now (a) two independent provenance columns honoured by
NARROWED `set:` objects and (b) cost living on its own route so no combined body can address the
column. It is **NOT** `additionalProperties:false` (ajv runs `removeAdditional:true`, so it strips
unknown keys rather than rejecting them).

**One bot object: `workspace_reviewers` — the quality-check ROLE, and the merge that ended the
two-table split (CORE, deterministic; migrations `0044`/`0045`, pg `0031`/`0032`).**
The two migrations are ONE change in two steps, and are best read together:

```
0044 / pg 0031  RE-HOME   repo grouping:  teams (m2m)  →  workspaces (1:N), + a Default per account
0045 / pg 0032  COLLAPSE  the bot object: repo_reviewers + account_reviewers → workspace_reviewers
```

**1. A BOT IS A PER-WORKSPACE OBJECT.** "Is this login a bot" is answered once per workspace. This
is the third key this table has had, and the history is worth a paragraph because each move was
paid for:

| key | why it went |
|---|---|
| `(account, TEAM, actor)` + an inheritance chain (team row → team-0 default → auto-detect) | the answer MOVED when someone re-bagged a team's repos, and null-means-inherit leaked into every read, every write body and every badge on the row |
| `(account, REPO, actor)` + `(account, actor)` for identity | correct about installation, but it needed a UNION FOLD at every read, and it was two tables to keep the two facts apart |
| **`(account, WORKSPACE, actor)` — one row, one table** | one workspace is the only scope there is, so both facts are about the same key and there is nothing left to fold |

⚠ **There is NO team key, NO repo key, NO inheritance, NO union fold and NO `resolveJudgements`.**
A vendor running in the six repos of a workspace is **ONE row** — one judgement, one price, one
brand colour — and every "resolve N rows into one answer" helper died with the repo grain. The
per-repo Bots tab is that same one listing, filtered CLIENT-SIDE to the actors with a footprint in
that repo. `workspace_id` arrives in a REQUEST BODY, so tenancy is a COMPOSITE FK against
`workspaces(id, account_id)`: the cross-account insert fails in the database, in every code path.

**2. THE VENDOR-IDENTITY BUG, AND WHY THE FIX SURVIVED THE MERGE.** The reason `account_reviewers`
ever existed: when `kind`/`label` sat on per-repo rows, marking CodeRabbit "not a bot" in ONE repo
nulled that row's kind, that row was the most recently updated, identity resolution reported
`kind = null` account-wide, and **CodeRabbit lost its brand colour and vendor name in every repo the
user never touched** — with no surface anywhere able to undo it. A most-recently-updated tie-break
picks a winner but cannot make the losing rows editable or even visible.

That bug was killed by a TABLE BOUNDARY. **The boundary is gone**, so the same bug is now
representable inside a single row, and what prevents it is code discipline that must not be
loosened:

- **TWO independent provenance columns.** `source` owns `automated`/`role`/`confidence`/`reasons`;
  `identitySource` owns `kind`/`label`. A pass or a handler that respects only one of them either
  reverts a human's vendor correction or freezes auto-detection.
- **NARROWED `set:` OBJECTS, never one shared `values` object.** `persist` loops per workspace,
  reads the existing row's two flags, and assigns the judgement half only when
  `source !== 'manual'` and the identity half only when `identitySource !== 'manual'`; if neither
  half may be written it emits **no statement at all**. The old shared-object pattern is correct for
  a single-grain table and would, here, overwrite a human's vendor name on every auto pass.
- **`monthlyCents` is in NEITHER half** — not in the `set:`, not as a derived INSERT value, nowhere
  in `reviewer-classify.ts`. A row `persist` creates has no price.
- **`persistHumanJudgement` carries no `kind`/`label`** at all, so a human "this is a bot" cannot
  rename the vendor as a side effect.
- **`useBotColors` is now WORKSPACE-SCOPED**, and this is the single most dangerous consequence of
  the merge. It used to call `useDetectedReviewers()` with no arguments *on purpose*, because
  identity was account-wide; under a per-workspace identity that reads an arbitrary workspace's
  answer. The hook's `workspaceId` is therefore the **first, REQUIRED, non-optional parameter**
  (`number | null` — null only for "not resolved yet") so `tsc` is the gate, not a grep — and the
  grep that would be used instead misses the worst offender
  (`ThreadList`'s `useDetectedReviewers(undefined, null, …)` is equally unscoped and does not match
  `useDetectedReviewers()`).

**⚠ IDENTITY AND PRICE ARE NOW PER WORKSPACE. That is the accepted, deliberate consequence.**
CodeRabbit named or priced in workspace A does not carry either into workspace B, and B may
legitimately hold different values or none. Nothing reconciles them and nothing is meant to: there
is no fan-out writer, no INSERT seed and no cross-workspace coupling. Migration `0045` copies the
old account-wide `kind`/`label`/`monthly_cents` into every workspace row of that actor as a ONE-TIME
SEED of a value that *was* account-wide — not an invariant, and the copies diverge freely from the
first edit. Bots are configured at the Workspace level, **all attributes included**; do not
re-derive the old behaviour from the "you buy one subscription per vendor" argument, which was
considered and overruled.

**3. THE WRITE SURFACE IS TWO ROUTES, NOT ONE AND NOT THREE** (full contract in the HTTP API table):
`PATCH :userId {workspaceId, automated?, role?, kind?, label?}` and
`PUT …/cost {workspaceId, monthlyUsd}`.

- The four PATCH fields merged because they are all **re-derivable** — a wrong write is fixed by the
  next classification pass or a reset — so one body keyed by two independent provenance flags
  removes a whole class of "which endpoint do I call" bugs. **Do not split them back apart by
  grain**; the grain mismatch they defended against no longer exists.
- **Cost stayed separate because it is derivable by nothing and it is money.** Its own body means no
  combined body can address `monthly_cents` at all — the same structural guarantee the two-table
  split gave, with one fewer table. **Do not fold it into the PATCH.**
- The classifier honours BOTH provenance flags, which is what lets a manual "not a bot" in workspace
  A coexist with fresh auto verdicts in B and C: there is **no "manual override wins" early return**
  — the derivation always runs and `persist` declines only the halves a human owns.
- **The division now:** *is this login a bot, who is it, and what does it cost* are all per
  **WORKSPACE**; *how we detect bots and how we attribute Limn's own reviews* stays per **ACCOUNT**
  (`BotSection` in the Settings modal). Price is edited INLINE on the reviewer card
  (`DetectedReviewersTable`) and its label reads **"Price for this Workspace"** — not a bare "Price",
  which on an otherwise workspace-scoped card would read as a global setting and invite exactly the
  cross-workspace totalling that is forbidden. `BotSection`'s old "Per-bot cost (account-wide)"
  picker is DELETED — do not reinstate it. Moving the table out of that modal also closed a real
  gap: it was gated on `caps.botTriage`, so an OSS (plugin-absent) `npx` user could not classify a
  reviewer at all.

**RESETTING TO AUTO — two routes, one per provenance flag, and they are now SYMMETRIC.** Both
`DELETE …/judgement?workspaceId=` and `DELETE …/identity?workspaceId=` are an **UPDATE + an
immediate re-derive in the same request**, and both answer **200** with the fresh row.

- ⚠ **Neither may DELETE the row.** The old per-repo judgement reset did exactly that, and it was
  right *then*: the row held nothing else, and the listing's lazy pass fires on a MISSING row, so
  the next pass rebuilt it with a fresh auto verdict. This row also holds the vendor identity AND
  the price, so a delete is lossy.
- ⚠ **Neither may pass an empty scope list.** The old identity reset called `classifyReviewer(…, [])`
  and relied on `persist` writing the two halves as two statements against two TABLES with only the
  second guarded on `repoIds.length > 0`. With one merged row there is a single per-workspace loop,
  so an empty list means **zero iterations and zero writes** — "Reset name" would become a permanent
  un-naming, with the lazy pass (which only fires on a missing row) never re-deriving it,
  `buildIdentity` falling back to the raw login, and `useBotColors` (which filters `kind != null`)
  dropping the brand colour forever. The mechanism is now the explicit
  `PersistOpts { only: 'judgement' | 'identity' }` with a REAL workspace id.
- ⚠ **The identity reset KEEPS THE PRICE.** Un-naming a vendor is not a statement about what it
  costs, and that coupling is precisely what the old two-grain split existed to remove.
- ⚠ **Order is load-bearing:** clear the provenance BEFORE deriving, or `persist` skips the
  still-`manual` row.

⚠ **Without these resets, touching any row pinned it forever** — `source: 'manual'` means detection
never re-derives, and flipping the value back by hand leaves it just as pinned. That is also what
makes the trade below acceptable.

⚠ **A role-only judgement patch stamps `source: 'manual'`**, which also pins `automated` for that
workspace. The alternative — leaving `source` alone — lets the next classification pass re-derive
`role` from the login seed and silently revert the user's edit. The visible, undoable pin was chosen
over an edit that quietly disappears. (This is NOT the old "typing a price froze the classification"
trap: price has its own route and its own `set:`, and cannot reach `source`.)

⚠ **Deleting a workspace must re-home its `workspace_reviewers` rows to Default BEFORE deleting the
row — this is a failure mode the merge CREATED.** Under the old model deleting a team touched no
classification at all (`repo_reviewers` keyed on repo, `account_reviewers` on account). Now the FK
cascade would destroy every `source='manual'` verdict, every `identity_source='manual'` vendor name
and every `monthly_cents` in the workspace — money the user typed — while the repos survive, with no
warning and no undo. `deleteWorkspace` does it as `INSERT … SELECT … ON CONFLICT (account_id,
workspace_id, author_user_id) DO NOTHING` + a DELETE of the leftovers, and **the `DO NOTHING` is the
collision RULE, not an optimisation: DEFAULT'S EXISTING ROW WINS, UNTOUCHED.** Prices are per
workspace, so the two rows may hold different numbers; deleting a workspace is an explicit
destructive act the user confirmed, so losing that workspace's price with it is the expected cost,
whereas silently OVERWRITING a price the user set in Default as a side effect of deleting a
*different* workspace would be strictly worse and would have no undo.

**One door along, same class:** MOVING a repo between workspaces leaves the source workspace's
reviewer row behind (correct — it may still cover other repos, and a footprint-less stored row must
stay editable) and produces a fresh auto row in the destination that inherits **nothing** — not the
price, not the manual judgement, not the vendor label. Its `monthlyCents` is NULL until someone
prices it there. That is the intended per-workspace semantics, not a gap.

**4. `role: ReviewerRole = 'review' | 'quality_check'`** — WHAT an automation is FOR, **orthogonal
to `AutomatedReviewerKind`** (WHO it is). SonarQube / Codecov / Hound post review comments and ARE
automated, but they are not reviewing, and counting them as reviewers is what makes the ROI numbers
lie. Seeded from `QUALITY_CHECK_BOTS` (shared, with the usual hand-synced backend copy in
`sync/bot-detection.ts` + drift test) and re-derived by `defaultRoleFor`, so an unclassified
SonarQube is right before anyone opens the settings tab. It is **NOT** a new `AutomatedReviewerKind`
member: a login would have to give up its brand identity to be marked a linter, and
`getBenchmarkContributions` filters kinds with a RUNTIME string test against exactly
`in_house|pierre|vendor`, so a new member would sail through and ship linters into the **cross-org
benchmark** as a named review-bot cohort — data that leaves the tenant and cannot be un-shipped.
A quality check stays `automated: true`, so `excludeBots`, the feed bot lens and the vendor tag are
unchanged. **The role splits exactly two sets** (`automatedReviewerUserIds(accountId, workspaceId, role)`
takes the filter POSITIONALLY and REQUIRED, so every call site had to be re-read). ⚠ **`null` is gone
from every workspace-scoped getter**: the scope is a `BotScope {workspaceId, repoIds}` whose
`repoIds` is always concrete, and `[]` now simply means "this workspace is empty" — an ordinary
state (a freshly created workspace), not an edge case. The ONE genuine account-wide sweep, the
cross-org benchmark rollup, gets **two explicitly named functions** rather than a null sentinel:
`automatedReviewerUserIdsForAccount(accountId, role)` (the UNION over all workspaces — automated in
ANY workspace counts) and `classificationKindForUserForAccount(accountId)`. ⚠ The latter needs a
WRITTEN tie-break because identity is per workspace and an actor can be `coderabbit` in A and null
in B: **a non-null vendor kind in ANY workspace WINS, ties broken by lowest `workspaceId`.** It is a
named function with a stated rule rather than an incidental `Map` build because its value decides
what leaves the tenant into a CROSS-ORG benchmark and cannot be un-shipped:

| `role: 'review'` — SCORING | `role: 'all'` — EXCLUSION / visibility |
|---|---|
| behaviour + per-PR behaviour (`getBotBehaviourAnalytics`/`getPrBotBehaviour`), dedup, bot themes (`getBotReviewComments`), all three resolvable-thread-backlog getters, `getActivity`'s acted-on stat, `getWorkspaceInsights`' `bot_signal`, the benchmark (`getBenchmarkContributions`) | the bots-only feed (`getConsolidatedFeed`), the human-themes exclusion set (`getHumanReviewComments`), human-follow-through detection (inside `getBotVendorPrs` — "was the replier a HUMAN"), **bot-only PRs** (`getBotOnlyReviewPrs`), **and `getBotAnalytics`** |

**`getBotAnalytics` is the exception that reads like a bug and isn't** — it is the ROI getter, yet
it passes `'all'`. It narrows by SPLITTING, not by filtering: it computes a row for EVERY automated
reviewer and then routes `role:'quality_check'` ones into `qualityChecks[]` (via `reviewerRoleForUser`)
so they are excluded from `vendors`/`totals`/`suggestions` but still RENDERED, in a collapsed
"excluded from ROI" section. Filtering them out of the id set instead would have made a mis-roled bot
silently vanish from the one screen where you'd fix the role. So "ROI scores only review bots" is true
of the OUTPUT and false of the argument — don't grep for `'review'` expecting to find it here.
_(The two in-code comments that used to contradict this — `schema.sqlite.ts`'s `role` comment and
`queries.ts`' `ReviewerRoleFilter` comment, both listing "bot-only PRs" among the sets that narrow —
were corrected during the workspace rename. They now agree with the code and with the paragraph
below.)_

**Bot-only PRs DELIBERATELY DO NOT NARROW**, and the symmetry is tempting enough that it is worth
stating: that list answers "did a human look at this before it merged". A PR reviewed only by
SonarQube has no human reviewer — exactly what the banner exists to surface. Narrowing it to
role `'review'` leaves that PR with zero qualifying bot reviews, fails the "at least one automated
review" leg, and DROPS it from the list, hiding the risk instead of flagging it. The scoring sets
narrow because a linter's volume makes a reviewer's numbers lie; the risk set does not, because a
linter's approval is not a human's.

**Consolidated Feed — CORE, the Activity "Feed" entry (`getConsolidatedFeed` → `FeedView`).** ONE
flat, purely-**chronological** (newest-first) stream of **real activity events** (opens / merges /
reviews / comments), plus **commit-push items that ADDRESSED a review thread**
(`getCommitThreadItems`): consecutive commits by one author on one PR are coalesced into a run
(a >6h gap splits runs), kept only if a commit touched a still-`likely_addressed` thread's file
after that thread's last comment, carrying the addressed threads inline (`affectedThreads` +
`commitCount` + `changeSummary` — "pushed N commits · addressed M threads"); plain
(non-thread-touching) pushes stay excluded. **Each item carries `isMyTurn`** — true when it's an
event on a PR the viewer PARTICIPATES in (authored / requested reviewer / previously reviewed or
commented) AND the actor isn't the viewer. That flag **replaces the old two-source (`my_turn` vs
`feed`) synthesis + its dedup** — there is now exactly one row per underlying event, which killed
the duplication. **My Turn / "FYI" is CORE (free, every tier)** — it was moved back out of Pro
(the `feedMyTurn` capability and the `registerFyiProvider` seam were removed; `feed/fyi-provider.ts`
is gone). The participation compute lives in the core module **`src/feed/my-turn.ts`** (`enrichMyTurn`
+ reason pills + `countNewMyTurnFeedItems`); `getConsolidatedFeed` calls it directly, and `/api/me`
uses `countNewMyTurnFeedItems` for `me.newFeedItems`. Every tier gets the My Turn cards/toggle/badge
+ Welcome-back banner — no capability gate. `isMyTurn` rows are the **content-rich, yellow-bordered
cards** with a "My Turn" badge + a `feedMyTurnOnly` "My Turn only" toggle; they're
uncapped, plain activity is capped (`FEED_EVENT_CAP`). Cards render the **full comment/review body
as markdown**, the affected threads inline, + a merge/review credit line
(`mergedById`/`reviewers`). The **`excludeBots`** filter drops bot-authored activity. **PAGINATED**
— `useConsolidatedFeed` is a `useInfiniteQuery` (page 0 loads `FEED_PAGE_SIZE`=50, "Load more" by
`offset`; `total` tells the client when to stop). **No "seen"/Done concept.**
**Click → pr-DETAIL tab:** clicking ANY feed card → `usePinnedTabs.openPrDetailTab(meta,
{fromActivity, returnItemId: item.id})` opens the full-height PR detail tab (its Show/Focus links
then drive the timeline), pushing a Back-to-Activity history entry; **Back returns to the feed and
scrolls + flashes the clicked item** (`activityReturnItemId`). A digest's `#N` PR ref also opens a
`pr-detail` tab. (The old pr-focus-on-click, the My-Turn tab, and the MyTurnPanel/FeedPanel/pills
are all gone.)

**Pro: Haiku digests — per-repo, rendered as a COLLECTION** (`packages/pro/src/activity-digest/`).
The flagged AI panel: a per-repo banner in each repo's console (`DigestBanner` → `RepoDigestCard`,
collapsible) AND, atop the Activity "Feed" entry, the **COLLECTION of per-repo digest cards**
(`FeedDigestList` → `useRepoDigests`) — one collapsible `RepoDigestCard` per repo. Each digest is a
**bulleted markdown change-report** referencing PRs as `#<number>` tokens (resolved via
`activity-digest/refs.ts`, scoped to `(accountId, repoId)`) **chained from the prior stored
summary**. `metrics.ts` compacts `getActivity`+`getRepoAnalytics` into a bounded `RepoDigestPayload`;
one non-agentic `ctx.llm.complete` (Haiku) → stored in `repo_digests`. **There is NO separate
cross-repo "Feed digest" route/LLM pass** — the collection simply reads the same `repo_digests`
rows (one source of truth for the caps; the old `feed-digest/` dir was removed). **Scoped to the
active WORKSPACE's repos** — `FeedDigestList` passes that workspace's ids, and an unscoped request
resolves to one workspace, never the account, so the Feed digest never fans out to every added repo.
(It used to intersect the FilterBar-visible set with `inboxWatch=true`; the watch column is gone —
migration `0046` / pg `0033` — and the picker is Timeline-only, so the workspace is the whole bound
now.) Per-repo collapse state persists via
`store/digestCollapse.ts`. **Cost-safe:** generation only on `POST …/digests/refresh`; a
**payload-hash cache** (unchanged repo = $0; the hash MUST zero `Date.now()`-derived fields like
`age_hours` or a dormant repo re-bills hourly), per-account min-interval + in-flight guard,
USD/repo caps. Capability `activityDigest` tracks `PRO_DIGEST_ENABLED`.

**Pro: the Insights pane is now the grounded chat ALONE — "Retro" is DELETED.** The Insights
"Retro" sub-tab, its view + hook, the plugin generator (`insights/retro.ts`), the
`/api/pro/retro[/refresh]` routes and the `retro_reports` **table** (plugin migration `0018`,
both dialects) are all gone. The retrospective is a **quick-question pill** in `AdHocChatPanel`
(`RETRO_PROMPT`, a frontend-local const paired with `SPRINT_REPORT_PROMPT` — backward-looking vs
forward-looking), answering from the SAME grounded chat payload every other pill uses: one billing
path, one cache, one prompt surface instead of a second parallel generator. It deliberately asks
only for what `buildChatPayload` HOLDS — merged PRs, flow metrics, CI failure reasons, attention
items — **not themes or sentiment**, which needed the retro's own 50-item corpus of raw comment
bodies; asking would just trip the chat's "the JSON doesn't hold the answer" decline. Discussion
themes live in the Feed's Pro **Themes** tab. It is a **NOT a new `PresetPromptKey`**: each key is
consumed by the plugin as two EXHAUSTIVE `Record<PresetPromptKey, string>` maps plus its own cache
row and throttle, for a pill that only prefills the chat box. The table was **dropped rather than
orphaned** because it carried `account_id`: an orphan would have to stay in `eraseProByAccountId`'s
checklist (and keep both drizzle definitions alive) forever — deleting the feature while keeping
100% of its schema surface. Historical `ai_usage` rows with `feature='retro_report'` survive on
purpose: that money was really spent and must keep counting toward month-to-date credits (the
column is free text, so no migration). `PresetPromptPanel` is likewise **importer-less** but kept,
because its server side (`preset-prompt.ts` + its cache rows/throttles) is still live and this is
its only client — delete both together or neither.

**Pro: Comment annotations — the "Check review" platform** (`packages/pro/src/annotations/`,
capability `prSummary`). ONE plugin-owned table `pr_comment_annotations` (migration `0017`) holds
any AI judgement ABOUT a review comment, discriminated by **`(accountId, kind, targetKind,
targetId)`** — that key exists because targets span `thread` / `review_comment` / `pr_comment`
and the superseded `comment_assessments` keyed a bare comment id, so `prComments.id` and
`reviewComments.id` would have silently collided. Three stored `AnnotationKind`s: `validity`
(does the point hold up — the old `comment_assessments`, whose rows migration `0017` backfills
`INSERT OR IGNORE`; that TABLE is deliberately not dropped, so a rollback is a code change rather
than a data restore), `addressed` (was the concern
dealt with, plus what is still open), `simplify` (a faithful rewrite of a bot wall-of-text,
rendered ADDITIVELY beside the untouched original). Staleness is **PASSIVE** — the GET is a pure
cached read that marks rows stale; nothing regenerates on PR open, which would bill per open of a
bot-flooded PR. The re-check is simply pressing the same per-item "Check review" again (there is no
bulk "re-check the stale ones" any more — there is no PR-wide sweep to hang it off).

- **`AnnotationRunKind = AnnotationKind | 'review'`, and the split is load-bearing.** `'review'`
  is a RUN kind ONLY: one combined model call per target emitting all three judgements, writing
  the SAME rows three separate runs would. **It must never reach the DB** — there is no `review`
  row, no `review` payload hash, no `counts.review`, and it is excluded from the `KINDS` set the
  cached GET's `kinds=` filter validates against. A combined run and three single-kind runs are
  indistinguishable in storage, which is exactly what keeps each kind's staleness and
  $0-on-unchanged cache independent. **Each of the three rows keeps its OWN per-kind payload
  hash**: a single combined hash would mark all three stale the moment any one input moved and
  re-bill three judgements for one change (the trap the digest cache already taught us).
  Economically it is also a win — 50 threads was 50 billed `addressed` calls, combined it is
  `ceil(50/6)` = 9 calls for all three.
- **`COMBINED_CHUNK_SIZE` = 6, smaller than the single-kind `CHUNK_SIZE` = 8**: a combined item
  emits a rewrite AND a validity rationale AND the two-section addressed summary (~3.4× a
  `simplify` item's output), so 8 would want ~6.5–7k output tokens. Overflow does not error — it
  truncates and the salvage parse silently drops the cut items, surfacing only as a lower
  `generated`. The chunked shape is used even for ONE unit (`parseSingle`'s "verdict:" first line
  can't carry three judgements). `recordAiUsage` fires ONCE per call (the authoritative cost);
  per-row `costUsd` is a double approximation divided by what each unit REQUESTED.
- **The clock exemption is measured in BILLED CALLS, not units.** A run of
  `ceil(units / COMBINED_CHUNK_SIZE) <= 1` bypasses the 30s per-account interval clock and does
  not stamp it. It was `SMALL_RUN_UNITS = 1`, which broke the very case it exists for: a thread
  anchor EXPANDS to the thread plus one unit per long reply, so on a bot-flooded PR a single
  per-thread click is already 2+ units and the next click seconds later was refused `too_soon` →
  429 — while both clicks cost exactly one call. Spend is still bounded by the per-account
  in-flight serialiser, `MAX_TARGETS_PER_RUN` 50 (resumable), the credit gate, and the `ai`
  20/min + `ai_hourly` 120/h buckets.
- **Landmine — EXPANSION.** The three kinds key their rows on DIFFERENT `(targetKind, targetId)`
  pairs for the SAME thread: `addressed` on `('thread', T)`, `validity` on the thread's ROOT
  `('review_comment', id)`, `simplify` on `('review_comment', id)` for EVERY comment in it. So a
  plain equality match against a `{'thread', T}` anchor finds only the `addressed` target: "Check
  review" on one thread reports `generated: 1`, renders one chip, and silently produces neither a
  validity nor a simplify verdict — with no error anywhere. A thread anchor therefore matches on
  THREAD IDENTITY (`targetMatchesAnchor`), resolved from the corpus; comment anchors match
  themselves.
- **Landmine — INTERSECTION ONLY.** `targets[]` is a POST-FILTER over targets enumerated from the
  already-account-scoped PR corpus, and is **NEVER a fetch key**. The ids come from the client, so
  a "load the named targets" implementation would let `{'review_comment', <another tenant's
  id>}` posted against a PR I own read a foreign comment body, spend my credits summarising it,
  and store the result where my own cached GET serves it back. An anchor matching nothing is
  counted `skipped`; the route SHAPE-validates only, on purpose.
- Counting unit: `requested`/`generated`/`cached`/`skipped` count the things a human pointed at
  (a thread, a comment) — never rows, of which a combined unit writes up to three. With anchors,
  the PR's other ineligible candidates are not counted as `skipped` (that read as nonsense on a
  300-thread PR); only unmatched anchors are.
- **UI: it is now PER-ITEM ONLY.** The three original buttons ("Simplify all" / "Check validity" /
  "Check addressed"), then the **PR-wide `ReviewCheckBar`** that replaced them (with its
  "Re-check N stale"), are ALL gone — a whole-PR sweep is many billed calls and tens of seconds,
  and the answer wanted is about the one thread on screen. A **SECOND** PR-wide sweep went with it:
  `PrAddressedCheckButton`, rendered once per ROW of the `bot-threads` drill-down, posting the
  plugin's `POST /api/pro/prs/:id/addressed/check` — one billed call **per target, up to 50**, a
  worse cost model than the combined runner's `ceil(units/6)`. That route + its SSE twin +
  `runPrBatch`/`enumeratePrTargets` and the per-account batch gate they needed are deleted; the
  drill-down row now shows only the deterministic addressed-confidence mix it is already sorted on.
  Also deleted: the **SSE run path** end to end (`…/annotations/run/stream`, `AnnotationRunProgress`
  in both the plugin and its frontend mirror, the hook's `stop`/`reset`/progress state) — a per-item
  run is one billed call, so there is no progress worth streaming — and **`onlyStale`**, whose only
  sender was the bar. The `AbortController` STAYS: it closes the socket, and the route's
  `reply.raw.on('close')` is what stops the billing loop for a run the user walked away from (a fat
  thread anchor really is several calls). What remains: **`ReviewCheckButton`** (thread-card header /
  PR-comment actions) + the render-only panels. `AddressedMarker` / `AddressedCheckControl` /
  `ThreadAssessment` / `useAddressedCheck` / `usePrAddressedCheck` / `useCommentAssessment` are all
  deleted; the legacy PER-ITEM routes (`/api/pro/threads/:id/assess`, `…/{threads,pr-comments}/:id/
  addressed/check`) stay registered as callerless alternate writers into the same rows.
- **Output rendering: ONE block per target.** A thread's judgements render under the whole
  conversation (`ThreadCheckOutput` in `ThreadCard`) instead of scattering a rewrite above each
  comment body; a PR comment's render under its card. The "the original is always still on screen,
  unedited" invariant survives (the conversation is above the block) and each rewrite is
  sublabelled ("@coderabbitai's opening comment", "reply 2") since it is no longer adjacent.
- **`lib/annotationRun.ts` `annotationRunMessage` — a click must never be silent.** The run route
  answers **200** for outcomes that produce nothing (no Anthropic credential, exhausted credits), so
  a 200 alone tells the reader nothing, and with the SSE `{type:'error'}` events and the bar's
  "· out of credits" suffix both gone the button just flipped back to its idle label.
  `AnnotationRunResponse.noAuth?` says it outright; the counter arithmetic
  (`requested - cached - skipped > 0` with no `generated`/`failed`) is kept as a FALLBACK for older
  plugin builds and worded with "may", because it is an inference.

**Pro: Claude Review learnings/memory** (`packages/pro/src/review-memory/`). Core seam =
`src/review/events.ts`: an **inert** typed event-bus (5 emit sites in `claude-review.ts`,
zero subscribers in OSS) + a learnings-provider registry, plus an optional
`priorReviewContext` prompt slot threaded `review-manager → agent → prompt` (byte-identical
when no provider). The plugin subscribes, enriches via `ctx.db`, appends `review_learnings`
rows (9 `kind`s, `dedupeKey`-idempotent), and on a new run injects a bounded markdown context
block. Two capability-gated UI surfaces in core: a pre-run "matches" panel (`ClaudeReviewTab`)
and a per-entry action log (`ClaudeReviewsModal`).

**`review/llm.ts` `cheapComplete` — the cheap-tier LLM seam (auth is load-bearing).** Core-owned
so the plugin adds no Anthropic dep. It MUST accept **every** credential Claude Review does:
explicit `ANTHROPIC_API_KEY`/local key → raw `@anthropic-ai/sdk` (metered); **otherwise the
Claude Agent SDK `query()`** (single-turn, no tools) — the same runtime Claude Review uses —
which resolves a `CLAUDE_CODE_OAUTH_TOKEN` **or an ambient logged-in `claude` session**. The
raw SDK alone can't use an ambient session (the common Pro/Max local case), which silently
broke the digest. Any new core LLM seam must follow this dual-auth pattern.

---

## Security & privacy posture (read before touching app.ts, CORS, or any AI route)

Hardened for public release (2026-07-26). Two new **zero-dependency** core plugins own it —
deliberately hand-rolled rather than `@fastify/helmet`/`@fastify/rate-limit`, because a new
runtime dep must also be threaded through the curated release manifest + the pinned lockfile,
and helmet's default CSP is wrong for this app three ways over.

**`api/plugins/security.ts`** — registered FIRST in `app.ts` so headers ride on every response
(redirects, 404s, static assets):
- **CSP per surface**: `/api` → `default-src 'none'`; `/app*` → the SPA policy; else the landing
  policy. `style-src 'unsafe-inline'` is unavoidable and accepted (React style attrs +
  vis-timeline positions items by mutating `element.style`); **`script-src` stays strict** — no
  `'unsafe-inline'`, no `'unsafe-eval'` (verified: no `eval`/`new Function` in vis-timeline /
  vis-data / vis-util). `img-src https:` is REQUIRED — comment bodies are third-party markdown
  embedding arbitrary hosts. Google origins enter the CSP **only in cloud**.
- nosniff, `X-Frame-Options: DENY` + `frame-ancestors 'none'`, `Referrer-Policy:
  strict-origin-when-cross-origin` (app URLs carry repo/PR ids), `Permissions-Policy`, COOP;
  `/api` also gets `Cross-Origin-Resource-Policy: same-origin` + `Cache-Control: no-store`.
  HSTS + the www→apex 301 moved here from `app.ts` (still cloud-gated).
- **`corsOriginDelegate` — CORS is now an ALLOWLIST IN BOTH MODES.** Local mode was
  `origin: true` (reflect ANY origin) *and* has no auth (every request resolves to account 1),
  so **any page the developer had open could read their whole synced GitHub dataset
  cross-origin and drive their write actions**. That was the audit's one CRITICAL. Local now
  allows any **loopback** origin on any port (dev 5173/5174, demo 5273, the packaged CLI's own
  port); cloud allows exactly `config.appBaseUrl`. `ALLOWED_ORIGINS` adds more.
- **`registerCrossOriginGuard` — NOT redundant with CORS.** CORS only decides whether the
  attacker's page may READ the response; a simple cross-origin POST is still delivered and still
  executes. Rejects state-changing `/api` calls whose `Sec-Fetch-Site: cross-site` (falling back
  to `Origin`); header-less clients (curl/CLI/webhooks) pass, since CSRF needs a browser. Also
  guards the mutating GET `/api/auth/reconnect`. Exempts the HMAC-authenticated webhook routes.
- **`registerHostGuard`** (local, loopback binds only) — 421s a non-loopback `Host`, the
  DNS-rebinding case that survives every origin check. `ALLOWED_HOSTS` opts a named host back in.

**`api/plugins/rate-limit.ts`** — fixed-window buckets keyed by **accountId** (the thing that
spends money), IP fallback for unauthenticated routes. Registered AFTER `registerAccountContext`.
Tiers: `ai` 20/min **+ `ai_hourly` 120/h**, `pr_detail` 60/min, `github_write` 60/min, `sync`
20/min, `search` 60/min, `auth` 30/min, `webhook` 600/min, `read` 600/min. **Landmine: Claude
Review kept its PRE-plugin paths** (`/api/prs/:id/claude-review*`, `/api/claude-reviews/*`,
`/api/claude-findings/*`), so `tierFor` matches those EXPLICITLY — a `/api/pro/` prefix test
would leave the most expensive routes on the 600/min read tier. `RATE_LIMIT_DISABLED=true` is the
escape hatch; `RATE_LIMIT_<TIER>` tunes a bucket. The `pr_detail` matcher covers `GET
/api/prs/:id` **plus `/merge-options`, `/files`, `/checks/:jobId/logs` and `/suggested-reviewers`**
— it was anchored to the bare id "because the sub-routes are DB-only reads", which was true when
written and quietly stopped being true, leaving the most GitHub-expensive GETs in the family on the
blanket bucket. **That mistake was then made twice**: the first fix asserted, in `tierFor`'s own
comment AND in a test, that `suggested-reviewers` "really is DB-only" — but
`enrichReviewerSuggestions` takes an access token (`github/reviewer-suggest.ts:35`), reads CODEOWNERS
over REST (`github/codeowners.ts`) and infers review teams over GraphQL (`github/team-reviewers.ts`).
Per-`(account, repo)` TTL caches make repeats free, but a cache-cold loop spends quota. **When in
doubt, follow the token** — and note that the passing test was pinning the wrong answer, so a test
agreeing with the code is only evidence of intent when the code is right. Genuinely DB-only and
correctly on `read`: `/bot-behaviour`, `/bot-dedup`, `/mention-candidates`, the retrieval-only
`/claude-review`, the cached `GET …/annotations`, `GET /api/auto-merge` and `GET /api/branch-status`.

**Fastify factory hardening** (`app.ts`): `trustProxy: config.isCloud` (Railway proxies — without
it the limiter's IP fallback collapses into one bucket; NOT set locally, where it would let a
client choose its own key), `bodyLimit` 256 KiB, `requestTimeout` 60s,
`routerOptions.maxParamLength` 200 (top-level is FSTDEP022-deprecated), and a pino **`redact`**
list — an `err` from a failed HTTP call carries the outgoing `Authorization: token gho_…` /
`x-api-key: sk-ant-…` headers and pino serializes errors deeply.

**Other fixes worth knowing:**
- **`error-handler.ts`**: 5xx bodies are GENERIC in cloud (`err.message` on a 500 is whatever
  Postgres/GitHub/Anthropic said — query fragments, paths, upstream bodies). 4xx stay verbatim
  (author-written contract text); local passes 5xx through (the operator IS the caller).
- **`db/queries.ts` `listUsers(accountId)`** — `users` stays GLOBAL storage but the LISTING is
  account-scoped via 6 correlated subqueries (event actors, PR authors/mergers, requested
  reviewers, review + comment authors). Unscoped, it handed any tenant every other tenant's
  synced contributors. **`PATCH /api/users/:id` + `setUserBot` were DELETED** — a global,
  ownership-free write of the sticky `isBotOverridden` flag, with no frontend caller; bot
  classification is the account-scoped `PATCH /api/bot-reviewers/:userId`.
- **`getTimeline`**: window CLAMPED to `config.retentionDays` in the route + hard row caps
  (`TIMELINE_PR_ROW_CAP` 5k / `TIMELINE_EVENT_ROW_CAP` 20k, newest-first) returning
  `truncated?: true`. `?from=1970&to=2100` used to materialise the whole retained dataset.
- **`github/codeowners.ts` ReDoS**: each `**/` compiled to its own nullable `(?:.*/)?`, so
  `('**/' × 14) + 'zzz.txt'` in a repo-supplied CODEOWNERS froze the single-threaded server for
  every tenant. Runs of `**/` are now COLLAPSED (semantically identical) + caps on file size,
  rule count, pattern length and paths matched.
- **`github/auth.ts`**: `gh auth token` is CACHED (5-min TTL + in-flight coalescing) and has an
  async form. `getAccessToken` used the SYNC one on every request — 50–300ms of blocked event
  loop plus a forked process per request.
- **`sync/hydrate-detail.ts`**: 60s cache + in-flight map. **`persistBodies` is FALSE by default
  in BOTH modes** (the old module comment claimed otherwise), so every `GET /api/prs/:id` ran
  `PR_DETAIL_QUERY` against GitHub — a loop over ids drained the tenant's 5k points/hour.
  **A write that must be visible IMMEDIATELY has to bust that cache** —
  `invalidatePrHydration(accountId, owner, name, number)`. Deleting the cache entry alone is NOT
  enough: a fetch started *before* the write is still in the in-flight map, and the next reader
  would join it and be served pre-write text. So the invalidator also bumps a per-key **epoch**,
  and `fetchGhPrText` refuses both to cache a result whose epoch moved and to share an in-flight
  fetch that began in an older epoch.
- **`sync-manager.ts`**: per-repo manual-sync cooldown (`manualSyncCooldownMs`, 5 min forced-full
  / 30s manual) + `apiSyncSlotsExhausted()` cap (4) → 429 from the route. Also added the missing
  `await` on `runSyncForRepo` (the 409 branch was dead).
- **`review/agent.ts`**: **`Bash` REMOVED from `WORKTREE_TOOLS` and denied outright.** A review
  reads attacker-authored text (title/description/diff/comments); with `bypassPermissions` + a
  shell that is RCE on the developer's machine via a stranger's PR. The old
  `Bash(rm *)`-style blocklist was never a boundary. Both review prompts + the AI-Fix prompt
  gained explicit **untrusted-input / prompt-injection** instructions.
- **Cross-tenant in-memory state (plugin)**: `getReviewStatus`, `listActiveReviews(accountId)`,
  `requestReviewCancel(prId, accountId)` and `getFixStatus` all key on prId in PROCESS-GLOBAL
  maps — they now verify the entry's own `accountId`, and the claude-review SSE stream checks PR
  ownership BEFORE `reply.hijack()` (the ai-fix pattern). Previously a foreign running PR
  streamed another tenant's live agent activity (file paths + source snippets).
- **Slack webhook SSRF (plugin)**: `normalizeSlackWebhookUrl` is an ALLOWLIST
  (`https://hooks.slack.com/services/…` only, exact host — not `endsWith`), enforced at BOTH the
  storage and the `fetch` sink, `redirect: 'error'`, and the response body no longer comes back
  in the error (it was a read primitive against the Railway private network).
- **`resolution-check` fan-out (plugin)**: `MAX_TARGETS_PER_BATCH` 50 + per-account in-flight set
  + 30s interval + abort wiring on the JSON twin. One billed LLM call per thread, uncapped, on an
  app built for bot-flooded PRs.
- **402 entitlement gate** (`plugins/auth.ts` `isProPath`) now covers the non-`/api/pro/`
  Claude-Review paths. Latent today (agentic is off in cloud) — real the day it is enabled.
- **`assertCloudConfig`** now rejects a `SESSION_SECRET` under 32 bytes or a placeholder (it is
  stretched by a single SHA-256 into the session sealing key, bypassing secure-session's own
  minimum + its slow KDF, so a weak one is brute-forceable → forge any account's cookie), and a
  non-https `APP_BASE_URL` (the cookie's `secure` flag derives from that scheme).
- **SQLite file perms** 0600 + dir 0700 (incl. the `-wal`/`-shm` siblings).
- **Dockerfile** runs as `USER node`, not root. **CI** gained a **blocking** `pnpm audit
  --audit-level high --prod`; all 8 highs that existed were cleared (see Dependency posture).
- **`.gitignore`** is `.env*` + `!*.example` — it was `.env` + `.env.local` only, and the docs
  tell readers to create `.env.cloud` with `SESSION_SECRET`/`ENCRYPTION_KEY` in it.

**GDPR / privacy.** GA4 is now **consent-gated in BOTH bundles** (`lib/consent.ts` +
`CookieBanner`, storage key shared so answering on the landing carries into the app): gtag.js is
never FETCHED before an explicit grant (configuring-but-denying still contacts Google), Consent
Mode v2 defaults denied, Google Signals + ad personalisation off, withdrawal deletes the `_ga`
cookies. **The brand font is SELF-HOSTED** (`src/fonts/*.woff2`, relative `url()` so Vite
base-prefixes it to `/app/`) — the Google Fonts `<link>` leaked every viewer's IP to Google
(breaking local mode's no-phone-home promise) and forced an inline `onload` handler that would
have needed `script-src 'unsafe-inline'`. New landing routes **`/privacy`, `/cookies`, `/terms`**
(+ footer column, sitemap, a terms line on `SignInGate`). Data-subject rights are SELF-SERVICE:
`GET /api/me/export` (`db/export-account.ts` — explicit column lists; the sealed token is NEVER
in the output) and `DELETE /api/me/account` (`db/erase-account.ts`, confirm-by-typing-your-login,
refused in local mode). Erasure reuses `deleteRepo` per repo, then the enumerated account-level
tables, then calls the **new optional `ctx.registerAccountErasure` seam** so the plugin drops its
own 14 account-scoped tables (`eraseProByAccountId`).
**Landmine: `accountScopedTables()` in `erase-account.ts` is a CHECKLIST the test iterates** — a
new `accountId`-bearing table that isn't added there fails `erase-account.test.ts` rather than
silently surviving a deletion the user was told was complete. (It caught `teamRepos` once already.)
The Workspace refactor took **FOUR** entries out (`repoReviewers`, `accountReviewers`, `teams`,
`teamRepos`) and put **THREE** in (`workspaces`, `workspaceRepos`, `workspaceReviewers`) — the net
drop of one is correct and intended (two bot tables collapsed into one), and it is spelled out here
because an off-by-one in a checklist is exactly how a table gets missed. ⚠ **`workspaceRepos`
carries its own `accountId`, not only `workspaceId`/`repoId`**, so it belongs on the list in its own
right rather than as a cascade dependent. `eraseAccountData` deletes child-before-parent
(`workspaceReviewers` → `workspaceRepos` → `workspaces`) inside one transaction: Postgres checks FKs
immediately, so relying on the cascades alone would be dialect-dependent. `export-account.ts` was a
RENAME, not an addition — both bot collections became the single `workspaceReviewers`, and `teams`
became `workspaces` with each row carrying its `repoIds`.

**Dependency posture (2026-07-26).** The dev tree went from `8 high / 10 moderate / 1 low` to
`1 moderate / 1 low`, and **the PUBLISHED npm package audits clean — 0 vulnerabilities**. CI now
BLOCKS on high. (The two are different trees: root `pnpm.overrides` do NOT travel with the
published manifest, so the release was audited separately as an `npx` user would receive it.) Two of the fixes were live vulnerabilities in
code this app actually runs, so they are worth knowing:
- **`@fastify/static` 9.1.3 → ^10.1.2** — route-guard bypass via path traversal + a
  non-canonical-path authorization bypass. This app serves TWO static roots. v10 needed no code
  change; verified against the packaged release (SPA index, deep links, hashed assets, the
  self-hosted font, `/` → 302, JSON 404 on unknown `/api`, and five traversal payloads — no leak).
- **`drizzle-orm` 0.38.4 → ^0.45.2** — SQL injection via improperly escaped SQL identifiers, in
  the whole query layer. Also bumped `drizzle-kit` → ^0.31.10, and `fastify` → ^5.10.0.
  **`packages/pro` declares the same two as devDeps and MUST stay in lockstep**, or the plugin
  type-checks against a different drizzle than `ctx.db` actually is.
- Transitives no direct bump reaches are pinned in root `pnpm.overrides`: `fast-uri` ^3.1.4,
  `find-my-way` ^9.7.0, `hono` ^4.12.32, `@hono/node-server` ^2.0.12, `shell-quote` ^1.9.0
  (arrived with drizzle 0.45's `gel`), and `brace-expansion@>=3.0.0 <5.0.7` → ^5.0.8 — note the
  **scoped selector**: a blanket pin would drag 1.x/2.x consumers onto a different major.
- **`node-cron` 3.0.3 → ^4.6.0** cleared the last advisory from the published package (v3
  pinned a vulnerable `uuid`). `@types/node-cron` was DROPPED — v4 ships its own typings and the
  DefinitelyTyped stub is for v3. Only four API surfaces are used (`schedule`, `validate`,
  `ScheduledTask`, `task.stop()`) and all survive; verified at runtime that `schedule()` still
  AUTO-STARTS without an explicit `.start()` (the sync loop depends on it) and that `stop()`
  halts it.
- **Knowingly left below the gate in the DEV tree only**, neither shipped nor reachable: `uuid`
  (moderate — via `vis-data`, and the bug needs v3/v5/v6 with a `buf` argument; vis-data calls v4
  with none) and `body-parser` (low — inside express inside the MCP SDK, an AI dep that ships in
  no release artifact).
- **Verification beyond the unit suite** (which runs on SQLite only): a Postgres smoke on a
  throwaway container exercised `getTimeline` / `getActivity` / `getOpenPrs` / `getMyTurn` /
  `getMergers` / `listUsers` / `getConsolidatedFeed` / `searchPrs` (raw-`sql` templates) /
  the scope resolver / the workspace metrics getter — 10/10 on drizzle 0.45 + node-postgres, plus
  pg migrations from empty. **Gotcha found doing it:** `DROP SCHEMA public CASCADE` does NOT
  reset a pg dev database — drizzle keeps its journal in a separate `drizzle` schema, so the
  migrator then reports "Migrations applied" having done nothing. Drop both schemas.
- Fastify 5.10 deprecated the top-level `disableRequestLogging` (FSTDEP023); it moved to
  `logController: new LogController({...})`. Same class of fix as `routerOptions.maxParamLength`
  — a boot-time deprecation warning is noise in the terminal of every packaged-CLI user.

**Tests:** `api/plugins/security.test.ts` (15), `api/plugins/rate-limit.test.ts` (15),
`db/erase-account.test.ts` (8), a codeowners ReDoS regression, and
`packages/pro/test/slack-webhook-url.test.ts`.

**Two suites exist that CI does not run — a known gap, both needing a devDependency + script
decision (each would touch the root lockfile, which is why neither was taken unilaterally):**
- `packages/pro/test/` — **9 files / 135 tests**, runnable via `packages/pro/vitest.config.ts`
  (which aliases `better-sqlite3` to the backend's copy and exports a PLAIN object, since
  `vitest/config` is unresolvable from a package without vitest): `./apps/backend/node_modules/.bin/vitest
  run --root packages/pro`. The plugin still declares no `test` script and no vitest devDep, so
  `pnpm -r test` skips it — including its cross-account isolation suite, whose fixture replays a
  **hardcoded, curated** plugin-migration list against an in-memory SQLite holding only plugin
  tables (so plugin `0020`, which reads core `workspaces`, needs a minimal core stub in that
  fixture) and whose scope-isolation assertions are non-vacuous only because its seeded rows use
  the `ws:` vocabulary.
- `apps/frontend/test/` — **9 files / 127 tests**, same arrangement (`apps/frontend/vitest.config.ts`,
  `include` pinned to `test/**` so vitest can't collect the Playwright `e2e/*.spec.ts` and fail).
  Kept OUTSIDE `src/` so `pnpm typecheck` never tries to resolve the uninstalled vitest types.
  Where the pure logic extracted from components is pinned: `annotationRun.test.ts`
  (`annotationRunMessage`), **`workspaceScope.test.ts`** (persistence of `workspaceId` — that all
  five legacy `teamScope` shapes are DISCARDED not coerced, that it is absent from
  `pickFilterBarState` so "Clear filters" can't teleport you into Default, and that the wire emits
  `?workspace=` always-once-resolved and `repoIds` **including when empty**),
  `botReviewerQueryKey.test.ts` (the three-segment key, and that a `repoIds`-narrowed listing never
  shares a slot with the workspace-wide one `useBotColors` reads), `botReviewers.test.ts`,
  `botCost.test.ts`, `resolvableBotThreads.test.ts` and `checksRow.test.ts`; `prRef.test.ts`
  predates them all. (`teamScope.test.ts` was DELETED with the canonicalisers it pinned.)
  **`workspaceOpenPrsScope.test.ts`** pins the Timeline-only-picker rule from the client side: the
  two open-PR search builders must disagree **exactly once** — when the board is narrowed —
  `buildOpenPrsSearch` honouring `filters.repoIds` (Timeline) and `workspaceOpenPrsSearch` ignoring
  it (Activity). Both failure modes are silent: pick up `repoIds` on the Activity side and a list
  comes back short, scoped by a control that is not on screen; let the two strings diverge in the
  common case and they stop sharing a React Query cache entry (the key IS the string), so the same
  list is fetched twice forever with both copies rendering correctly.
  ⚠ **Known hole, flagged in that file's own header:** the legacy `?team=` URL rule lives in
  `readWorkspaceFromUrl`/`readFromUrl` in `hooks/useUrlState.ts`, neither of which is exported, so
  re-implementing it in the test would pin a copy rather than the code — it is unit-tested nowhere.

The backend suite itself is **55 files / 534 tests** and DOES run in CI. Dropping the "watched"
concept added **`db/my-turn-new-prs.test.ts`**, which pins My Turn's clock: an open, non-draft PR by
a non-bot human other than you enters the "New PRs" section iff `openedAt >= repos.createdAt` FOR
ITS OWN REPO. It seeds two repos added eight days apart and — the case a lax fixture misses — a PR
in the later repo that clears the EARLIER repo's cutoff, so a single global cutoff fails it. Three
mutations were run against `getAddedRepoActionablePrIds` to prove the assertions bite: dropping the
comparison (caught by the before-cutoff PR), replacing the per-repo lookup with a global minimum
(caught by that cross-repo PR), and `>=` → `>` (caught by the exactly-at-cutoff PR). The
you-authored-it / bot-authored / draft exclusions are seeded as controls in the same loop. The
Workspace refactor renamed
`db/team-comparison.test.ts` → `db/workspace-comparison.test.ts` (dropping the `TeamScope`
wire-form cases — there are no wire forms — and keeping the two-way account scoping with a seeded
second account so the negative check isn't vacuous) and rewrote `db/bot-reviewer-grains.test.ts` →
**`db/workspace-reviewer.test.ts`**, which pins the same six directions in PAIRS now that there is
no table boundary to do it: a judgement patch leaves identity + price byte-identical and vice versa,
a cost write leaves everything else alone, a full `classifyReviewer` pass honours each provenance
flag independently, the identity RESET actually re-derives (`kind` non-null again), and **a
`setReviewerCost` in workspace A leaves that actor's rows in B and C byte-identical** — including a
row already holding a *different* price and a row whose price is still NULL. The three team-keyed
bot suites (`bot-cost-per-team`, `bot-vendor-prs-team`, `detected-reviewers-scope`) were deleted
with the grain they tested. `vitest.config.ts` raises `hookTimeout` to 30s because a dozen suites
migrate a throwaway SQLite DB in `beforeAll` and lost the 10s default under parallel load — failures
that look exactly like real regressions (a different subset each run, always in a hook, never an
assertion).

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
  `set:` objects rather than a table boundary. See **One bot object** above.
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

Ships to npm as a **single unscoped package `pierre-review`** (`npx pierre-review`, or
`pierre` global — both bins → `dist/cli.js`). Tarball is **built artifacts only** (no
`.ts`/src/configs/tests). CI publishing (version computation, atomic tag+commit, idempotent
publish) is in **[docs/RELEASE.md](docs/RELEASE.md)** — **never run `npm publish`/`npm login`
from here**; let CI (or the user) do it.

**Single-process production.** One Fastify server serves the JSON API (`/api`), the SPA
(`/app`), and — in cloud — the landing (`/`). Static serving is gated on sibling
`public/index.html` + `public-landing/index.html` (in the release, **absent in the dev
tree**, so `pnpm dev`'s Vite proxy is unchanged). All routing is the **single**
`setNotFoundHandler` (`api/plugins/error-handler.ts`): unknown `/api` → JSON 404; `/app*`
→ SPA; `/` + other → landing (cloud) or 302 `/app` (local). SPA built `base:'/app/'`.

**The landing is PRERENDERED at build time** (`apps/landing/prerender.mjs`, chained after
`vite build`). It used to be a pure CSR SPA: every URL returned the same ~7.8 KB shell whose
whole `<body>` was an empty `#root` + a splash caret, so anything that doesn't execute JS —
an AI agent, a link unfurler, a text browser, a crawler on a render budget — saw a site with
no content and no way to tell `/pricing` from `/privacy`. Now a Vite **SSR build** of
`src/entry-server.tsx` renders each route through `renderToStaticMarkup` into
`dist/<route>/index.html` (21–70 KB of real content), with that route's own
title/description/**canonical** baked in. Load-bearing details:
- **`src/lib/routes.ts` is the ONE source of truth** for per-route SEO copy — read by the
  pages' `useSeo()` (which now only matters for client-side hops) AND by the prerenderer, so
  the static head and the hydrated head cannot drift.
- **`index.html` carries `<!-- seo:start/end -->` + `<!-- app:start/end -->` markers**; the
  prerenderer replaces those regions and **throws if they're missing**. Deleting them silently
  reverts the whole site to a contentless shell.
- **`createRoot`, NOT `hydrateRoot`** — several components deliberately differ between the
  static and browser trees (`HeroWordmark` starts resolved so crawlers see "Pierre" not the
  mid-animation "PR"; `CookieBanner` renders nothing until it has read `localStorage`). A
  fresh client render reaches the same end state with no mismatch failure mode.
- **`router.setStaticPath()`** pins `currentPath()` per render — without it every route
  prerenders as the home page.
- Serving: `@fastify/static` (`wildcard: false`) already answers `/pricing/` from its
  directory-index scan; **`/pricing` (the canonical form) falls through to the not-found
  handler**, which resolves it against a Set of routes scanned **once at boot** — so a URL can
  only ever select an entry found on disk and no request path is ever joined onto a filesystem
  root. Legacy `/insights` + `/reviews` get a copy of `/pro`'s HTML (canonical → `/pro`).
- **Guardrails, because the failure is SILENT** (a broken prerender still looks perfect in a
  browser): `prerender.mjs` asserts 8 routes and a per-page floor, `build-release.mjs` asserts
  each `public-landing/<route>/index.html` exists and contains real content, and
  `api/plugins/landing-routes.test.ts` covers the routing + traversal.

**CLI** (`cli.ts` → `dist/cli.js`): the **`pierre status` subcommand** (peeled off argv
BEFORE `parseArgs`, whose default case rejects bare tokens) renders the cross-repo My-Turn
queue in the terminal via `status.ts` — OSC-8 clickable links (non-TTY falls back to
`label (url)`), `--watch` repaint loop (new-since-tick bullets), `--sync` (re-syncs ≤ every
5 min under watch), `--interval/--db`; LOCAL-only (refuses cloud), refuses to create an
empty DB without `--sync`, one-shot `runMigrations → ensureLocalAccount → getMyTurn →
closeDb` lifecycle, env mapped before any config/db import. The server path parses
`--no-open/--port/--db/--cloud/--mode` (+ env),
maps them to env **before** importing config, sets `NODE_ENV=production`. Local defaults
the DB to `~/.pierre-review/…sqlite` (never the read-only install dir) + pre-checks
`gh auth token`; `--cloud` skips both (Postgres `DATABASE_URL`; `assertCloudConfig` at
boot). Prints the banner + URL, boots via `start()` (guarded run-as-main), opens the
browser (built-in, no dep) unless `--no-open`.

**Two load-bearing traps:**
- **`@pierre-review/shared` is types-only** and NOT a published dep — the backend must
  `import type` only (offenders use local `const` copies); the release greps `release/dist`
  and **fails** on any real shared import/require.
- **pnpm is pinned** (`packageManager: pnpm@9.15.9`) so CI, the Railway `Dockerfile`, and
  local dev match; a newer pnpm blocks native builds (`ERR_PNPM_IGNORED_BUILDS` on
  `better-sqlite3`/`esbuild` — also in `pnpm.onlyBuiltDependencies`). Bumping = regenerate
  `pnpm-lock.yaml`.

**`pnpm package`** (`scripts/build-release.mjs`) assembles `./release/`: builds
frontend(`/app`)+landing+backend, copies compiled JS + both migration folders +
SPA→`public/` + landing→`public-landing/`, generates `package.json` (curated deps:
**drop** shared **and all AI SDKs** (`@anthropic-ai/*`, `@modelcontextprotocol/sdk`, `zod`),
**add** `@fastify/static|cookie|secure-session`, `pg`). Sanity asserts fail on a missing key
file, a leaked `.ts`, a shared runtime import, or **any AI SDK dep leaking into the manifest**.
`better-sqlite3` is a native runtime dep; `pg` loads only in cloud. **No AI ships in npm** —
the AI SDKs load only when the private `@pierre/pro` plugin is present (dev/author checkout),
via dynamic `await import()`; an npm-local user (`proEnabled` true, plugin absent) never
touches them, and the public npm publish never registers AI routes.

**`--with-pro` (the PAID cloud image ONLY).** `build-release.mjs --with-pro` additionally: builds
`@pierre/pro` to `packages/pro/dist` (via the new `tsconfig.build.json` + `pnpm --filter @pierre/pro
build`), copies `packages/pro/{dist,migrations,migrations-pg}`→`release/pro/` (preserving the
dist↔migrations sibling layout so the plugin's `../migrations` URL resolves), adds **only**
`@anthropic-ai/sdk` to the manifest (core's `review/llm.ts` raw metered path — the agentic SDKs +
`zod` stay forbidden even here), and extends the shared-import grep to `release/pro`. The `Dockerfile`
gates this on `ARG WITH_PRO=` (empty default = byte-identical OSS image): non-empty ⇒ build the plugin
+ `pnpm package --with-pro` + `ENV PRO_PLUGIN_PATH=/app/pro/dist/index.js`. `.github/workflows/deploy-cloud.yml`
(workflow_dispatch) checks out the private submodule via `PRO_DEPLOY_KEY`, `docker build --build-arg
WITH_PRO=true`, pushes to private GHCR; Railway deploys that image. The public `release.yml` NEVER
passes `--with-pro`, so its zero-AI-deps guarantee is intact. See `docs/DEPLOY-RAILWAY.md` §"the paid
Pro tier".

**Credit metering (paid cloud).** `AI_CREDITS_PER_USD` is **1250** ($1 model cost = 1250 credits;
also inlined in `pro/insights/routes.ts` + `db/credits.ts` — keep the three in lockstep). Core owns
the allowance math: `db/credits.ts` `aiCreditStatus(account,now)` → `{allowanceCredits,usedCredits,
remainingCredits,blocked}` (local `isLocal` = null/unmetered; paid cloud = `accounts.aiCreditAllowance
?? 2500`; free cloud = 0), summed from the `ai_usage` ledger since the UTC month start (auto-resets on
the 1st; migration `0026` added the nullable column). Exposed as **`ctx.aiCredits.check`**; the plugin
gates the digest (`runRefresh`) + sprint (`refreshSprintReport`) generators on `blocked`, returning a
`creditsExhausted` state (the SPA disables Generate/Regenerate + shows the used/2500 meter in
`TrackUsage`). Agentic entry points aren't gated yet — dead code while agentic is off in cloud +
unmetered locally; wire them when a metered agentic tier ships.

---

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
`"version": "6"`, **pg entries are `"version": "7"`**; `0038`–`0046` and pg `0025`–`0033` are
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
