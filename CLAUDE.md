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
`myTurnDismissals` (isolation = one indexed predicate); everything else reaches its account
via `repoId`/`prId`. `users` + `commitFiles` stay **global**. GitHub-node-id uniques are
**composite** so two accounts can watch the same repo (`(accountId, githubNodeId)`,
`events (accountId, dedupeKey)`, child `(prId, githubNodeId)`). Every list/feed query filters
by `accountId`; every id-addressed getter scopes ownership → null/false → 404. The
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

## Workspace layout

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
  across every account watching it, so one install serves every tenant. Signing in via the App
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
- **`repos`** — watched repos (`accountId`; unique `(accountId, owner, name)` and
  `(accountId, githubNodeId)`).
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
  (`accountId`, `review_request`|`thread`; auto-resurface on newer activity).
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
- **`botReviewClassification`** — the **Bot-Triage** classification table (CORE,
  `accountId`-scoped). Stores manual + auto automated-reviewer classifications (unique
  `(accountId, authorUserId)`; a manual row wins the resolution order). The plugin-owned
  `pro_settings` gained 11 `bot_*` columns (cost, Pierre tag/footer toggles, Slack digest —
  its now-vestigial `bot_auto_resolve*` columns backed the removed mute feature). See
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

| Method & path | Purpose |
|---|---|
| `GET /api/timeline?from&to&repoIds&userIds&types&statuses&reviewStates&excludeBots` | **lean** feed `{prs[],events[]}` — no bodies/diffs. The window is CLAMPED to `config.retentionDays` and both selects are ROW-CAPPED (5k PRs / 20k events, newest-first) returning `truncated?: true` — unbounded dates used to materialise the whole retained dataset in one response. Defaults: 14d, bots shown (toggle in Members). `reviewStates` filters `review_submitted` markers by verdict (approved/changes_requested/commented/dismissed); absent = all, empty = none |
| `GET /api/prs/:id` | full PR detail (threads, reviews, comments, commits, checks, labels) |
| `POST /api/prs/:id/mark-viewed` (alias `/dismiss`) | record a view (`sha?` defaults to head) → clears new-since badges |
| `GET /api/prs/:id/merge-options` | what the merge control needs, fetched LAZILY (the hot detail path must not wait on GitHub): repo-allowed methods + live mergeability + `mergeQueue` (null unless the base branch really has one — `enabled:false` would make every repo render a queue section) + `autoMerge{allowedByRepo,armed}`. The queue probe is `.catch(() => null)` — best-effort, never fails the control. Up to five upstream calls, so it shares the `prDetail` rate-limit tier with `GET /api/prs/:id` (and `…/files`) |
| `POST · DELETE /api/prs/:id/merge-queue` | enqueue / dequeue on **GitHub's native merge queue** → `MergeQueueResult`. WRITE+ re-checked; enqueue pins the LIVE head sha (same consent anchor as a merge), 400s when the base branch has no queue (rather than failing opaquely inside GraphQL), and is idempotent both ways. GraphQL-only — see `github/mutations.ts` |
| `POST · DELETE /api/prs/:id/auto-merge {mergeMethod,updateStrategy?}` | arm / disarm Pierre's own **"merge when ready"** → `ArmedMergeRequest` · 204 (idempotent). Arming re-checks WRITE+, refuses a non-open PR (409), pins the LIVE head sha (never the synced one — a stale pin disarms itself on the first tick), and 409s `StaleBase` when the synced base ref no longer matches GitHub's. TTL 72h |
| `GET /api/auto-merge` | every armed (+ resolved within 24h, cap 200, newest first) intent for the account → `ArmedMergeListResponse`. A pure DB read — the SPA POLLS it for the "it landed" toast, so it must never touch GitHub |
| `GET /api/prs/:id/checks/:jobId/logs?tail` \| `?startByte&endByte` | a live WINDOW of an Actions job log (never stored) → `CheckLogsResponse`. Offsets are SOURCE bytes (the `\r\n` normalisation is display-only), `endByte` EXCLUSIVE, `hasMore` = "more exists ABOVE this window" — so feeding a response's `startByte` back as the next `endByte` abuts exactly. Every path is capped at `MAX_LOG_BYTES` (8 MiB) via a rolling buffer (~2×cap peak) even when the source ignores `Range`. Serves PASSING checks too — see **Merge, CI logs & trunk status** |
| `GET /api/branch-status?repoIds` | **default-branch health** per repo in scope → `BranchStatusResponse` (head snapshot + failing checks + the recent trunk commits, each with its own CI state, failing checks and originating `prNumber`/`prId`). Pure DB read off what the branch sync persisted — never a live GitHub call, hence the plain `read` tier. Repos with nothing synced still appear, with nulls. **Informational only:** nothing here feeds attention counts, badges or My Turn |
| `POST /api/prs/:id/resolve-bot-threads {threadIds}` | **bulk-resolve** the review-bot threads a later commit likely addressed → `{resolved,failed,results[]}`. Server RE-DERIVES eligibility (owned + review-bot-originated + `likely_addressed`) ∩ the client's reviewed list, then GitHub-resolves each (shares the `bot-triage/resolve.ts` `resolveThreadsOnGitHub` helper with the scope-wide resolve route); never auto/blind — user-initiated + confirm-gated only. Core |
| `GET /api/bot-reviewers` · `PATCH /api/bot-reviewers/:userId` | **Bot-Triage** (CORE): detected automated reviewers → `DetectedReviewersResponse` · two-way manual override → `ReviewerClassification` (writes `bot_review_classification`) |
| `GET /api/bot-analytics?window=` | **Bot-ROI** (CORE): per-`AutomatedReviewerKind` volume/actedOn%/untouched/oldest/humanFollowThrough/noiseRatio/`verdict`(keep\|tune\|**noisy**) + ≤12wk trend + tuning suggestions → `BotAnalyticsResponse`. Returns `cost=null` — the client overlays cost from `pro_settings`. **Response-time-gated verdict:** the verdict keys on `overdueUntouched` (untouched threads older than a **fixed 36h grace window**, `totals.overdueGraceMs`), NOT raw `untouched` — so a bot isn't flagged noisy for threads still inside the grace window. (A MEASURED reply-time norm was tried but the sample is intrinsically fast — only threads someone engaged with draw a reply — so a flat cutoff is the fair gate.) Each row also carries `medianAddressedMs` (that bot's own median **time-to-ADDRESSED** — the earliest of a human reply, a resolve, or the addressing commit for a `likely_addressed` thread, computed read-time from `commits`/`commitFiles` for just those threads' PRs; display-only). ('kill' was renamed 'noisy'.) Vendor rows carry `dormant`+`lastActiveAt`: ANY trend-span footprint (threads, comments, or body-only reviews) keeps a quiet reviewer visible as a DORMANT row (zeroed window counts + trend + last-active chip) instead of vanishing; body-only reviews count as window activity for emission/dormancy but never enter the volume math |
| `GET /api/bot-behaviour?window&scope&repoIds` | **Bot BEHAVIOUR** (CORE, deterministic, **EXPERIMENTAL**): per bot over the window (+ a 12wk trend), the common review-bot gripes — **TTFR** (median/p90 + distribution + `ttfrTrend`; clock start = `pr_ready_for_review` when observed else `pullRequests.openedAt`), **LoC-to-comments** ratio (diff size ÷ the bot's comment count), a **week×hour activity heatmap** (`activityHeatmap` length-168, `dow*24+hour`, dow 0=Sunday — coverage / rate-limit INFERENCE, from review/comment timestamps NOT commit-push time, labelled inferred/UTC), and **post-first-review follow-up** (rate/avg/dist) → `BotBehaviourResponse`. Same window/scope/repoIds resolution as `/api/bot-analytics`; reuses the ROI identity helpers (`automatedReviewerUserIds`/`classificationKindForUser`/`u<userId>` key). Powers the Bots "**Behaviour**" inner sub-tab (`BotBehaviourPanel`), kept SEPARATE from the ROI panel so it can mature independently. **Anomaly detection (deterministic, self-baseline):** each bot's weekly series (TTFR/volume/follow-up) + a daily strip are judged against the BOT'S OWN robust baseline (median ± MAD, spike-resistant, ≥4 weeks or "building baseline"); TTFR flags only slower-than-typical weeks, volume+follow-up either direction; a silence-run detector flags coverage gaps for a normally-regular bot (run ≥ max(3, 3·median-gap) days, leading run ignored, trailing kept). `trend` points carry `*Anomaly` flags + an `anomalies[]` evidence list (observed vs typical) + `dailyActivity`/`silentRuns`. UI = **markers on the charts** (`LineChart` `pointFlags` ring + a new `DayStrip` with silent runs underlined in the anomaly colour). Also returns **`repoBotDirs`** (per bot × repo × directory) powering the merged **"Where bots work"** grouped+stacked chart (`BotRepoWorkChart`, custom SVG — X = bot; a bar per repo; each stacked by top-level directory + an 'other' tail; actual volumes; single-repo scope → one bar per bot). It REPLACED the two separate `repoPresence` (repo×bot "operate") + `repoAreas` (repo×area "work") charts/fields. No new AI/credit surface, no `apiVersion` bump |
| `GET /api/prs/:id/bot-behaviour` | **PR-scoped Bot behaviour** (CORE, deterministic, **EXPERIMENTAL**): for ONE PR, each automated reviewer's on-PR touch timeline (first review + follow-ups) + how it compares to that bot's OWN typical (an 84-day account-wide robust baseline via `getPrBotBehaviour`) → `PrBotBehaviourResponse`. Flags this PR's TTFR when anomalously slower than typical + follow-ups above typical. Account-scoped → 404 for a foreign PR; empty `bots` when none touched it. Powers the PrDetail "**Bot activity**" tab (`PrBotBehaviourTab`, presence-gated — shown only when a bot touched the PR, NOT Pro) + a ⚠ tab-label badge + a ChecksTab Overview "N bots slower than typical — view" caution that opens the tab. Reuses the ROI identity helpers + the `ANOMALY_Z`/`MIN_BASELINE_POINTS` constants |
| `GET /api/prs/:id/bot-dedup` | **cross-bot dedup** (CORE): automated-reviewer threads grouped by `(path, line±window)` across distinct kinds → consensus/conflict clusters → `BotDedupResponse` |
| `GET /api/bot-analytics/bot-only-prs?window&scope&repoIds` | the PR list behind `totals.botOnlyPrs` ("only a bot reviewed these") → `BotOnlyPrsResponse` (CORE; `BotOnlyPrItem` carries `repoId`/`openedAt`/`updatedAt`/`state`). **The COUNT (`totals.botOnlyPrs`, banner + ROI stat) is OPEN-only** — `getBotOnlyReviewPrs(…,{openOnly:true})` restricts to open+mergeable, dropping merged-in-window (the banner is a "needs a human before it merges" signal; open PRs are a live, unwindowed snapshot). The LIST route still returns merged (no `openOnly`) so the drill-down `BotOnlyPrsDetail` can **default to OPEN rows** (caption "N open" ≡ the banner) with a **"Show merged (M)" checkbox** that adds merged (client-side filter on `state`; caption → "N open · M merged"). Sortable table (Age/Updated cols + cross-repo repo-filter dropdown). Both BotsView's amber caution AND the Bot-ROI "N bot-only open PRs" stat open this TAB. (`getTeamInsights`'s `bot_only_review` card still counts open+merged — a separate Pro surface.) |
| `GET /api/bot-analytics/vendor/:key/prs?window&scope&repoIds` | per-REVIEWER Bot-PRs drill-down; `key` = the analytics row identity `u<userId>` \| `'pierre'` (invalid → 400) → `BotVendorPrsResponse` (+`key`/`login`). Replaced the old kind-keyed `/:kind/prs` (removed — two in-house bots no longer merge) |
| `GET /api/bot-threads/resolvable?scope&repoIds` · `POST /api/bot-threads/resolve {threadIds,repoIds?}` | **scope-wide review & resolve** of `likely_addressed` bot threads (CORE): the listing is now **UNCAPPED + PR-centric** (`getResolvableBotThreadPrs` → `ResolvableThreadPrsResponse{prs[],totalThreads}`) — **one row PER PR carrying ALL its resolvable thread ids** (`threadIds`) + `resolvableCount` (=`threadIds.length`=`botThreadCounts.likely_addressed`, now equal since uncapped) + a bot-only `botThreadCounts` mix + per-PR `confidenceCounts`/`highConfidenceThreadIds` (the deterministic addressed-confidence breakdown of the resolvable ids) + `repoId`/`authorId`/`ciStatus`/`openedAt`/`updatedAt`. Replaces the old 500-capped grouped-`threads` shape. The confirm-gated resolve still RE-DERIVES eligibility ∩ the explicit ids via `getResolvableBotThreadsForScope` (kept for that path; still 500/POST, client chunks 25 ids/POST for progress) so "Select all" resolves the WHOLE backlog. UI (`BotThreadsDetail`): a **SORTABLE tabular** list (PR/repo/author/age/updated/CI/resolvable/**confidence** — the per-PR High/Medium/Low addressed-confidence mix, sorted by a grade-weighted score), **PRs DESELECTED by default** with per-row checkboxes + **Select-all (across all pages) / Clear** (both greyed when the visible/**filtered** selection is empty), a **"High-confidence only"** toggle that FILTERS the list to PRs with a high-confidence resolvable thread AND scopes Select-all/counts/resolve to that subset (was invisible when it only narrowed the hidden resolve set), resolve pinned TOP with a **Stop** control (halts cleanly between chunks via `shouldStop`), a cross-repo **repo-filter dropdown** + Repo column, and **client-side pagination** (50/PR page; selection & Select-all span pages). All five Activity drill-down overlay tabs are `max-w-[100rem]` (widened from `max-w-6xl`). Clicking a PR row opens its detail Threads tab with the `likely_addressed` state pill preset (not back to the Bots pane). BotRoiPanel's `ResolveBacklogBanner` (reads `totalThreads`) opens the `bot-threads` TAB |
| `GET /api/open-prs?repoIds&userIds` | currently-open PRs (ignores date range) |
| `GET /api/threads/:id` | single thread detail |
| `GET/POST /api/repos`, `DELETE /api/repos/:id` | manage watched repos (delete → 409 if syncing, else 204) |
| `GET /api/repos/search?q&cursor&limit` | live GitHub repo search → `{results[],hasNextPage,cursor}`; already-watched filtered out, owned/member floated up; `limit` 10 (max 25) |
| `GET /api/repos/suggested` | **first-run onboarding**: the viewer's recently-active repos (`VIEWER_REPOS_QUERY`: `viewer.repositories` + `repositoriesContributedTo`, PUSHED_AT desc, null-tolerant for scoped cloud tokens), already-added filtered out, `RepoSearchResult` shape, cap 30 → `SuggestedReposResponse`. Drives `FirstRunOnboarding` (the zero-repo Activity console body, hoisted above all rail branches; top 5 pre-checked, sequential adds, one invalidation batch) |
| `POST /api/repos/:id/sync?full=true` | trigger sync → `202 {status:'started'}`, or `409` if already running |
| `GET /api/users` | GitHub actor metadata for the Members panel. **Account-SCOPED** (`listUsers(accountId)`): `users` is a global TABLE but the listing only returns actors appearing in the caller's own synced data. (`PATCH /api/users/:id` was DELETED — a global, ownership-free `isBot`/`isBotOverridden` write with no frontend caller; use `PATCH /api/bot-reviewers/:userId`.) |
| `GET /api/users/:id/stats?repoIds&scope` | **Contributor popover** (CORE): one user's **ALL-TIME** totals over the account's synced data → `UserContributionStats` — PRs they AUTHORED by bucket (merged/open/draft/closed, the `prStatusWhere()` mapping), `reviewsGiven`, `comments` (issue-level + inline), plus the `repoIds` actually counted. **COUNTS ONLY, no profile field** — `users` is a global table, so echoing a login/avatar for an arbitrary id would make this id-addressed route a cross-tenant profile lookup; the SPA already holds the account-scoped roster. `reviews`/`prComments`/`reviewComments` carry no `accountId`, so tenancy comes from an `innerJoin(pullRequests)` + `pullRequests.accountId` — **all four** predicates are bound by `verify:isolation` (the `reviewComments` one needs its own seeded row or the guard is vacuous). **No ownership 404** — a foreign/unknown id returns all zeros, deliberately: 404-vs-200 would be an existence oracle over a global table. `reviewsGiven` excludes `pending` AND the body-less `commented` **wrapper** GitHub creates around a batch of inline comments (`isSubstantiveReview`) — those inline comments are already in `comments`, and counting the wrapper double-counted one act (>half the rows for an active reviewer). Migration `0037` (pg `0024`) adds the four `author_id` indexes this needs — without them every count scanned the ACCOUNT's PR set, so cost tracked tenant size, not the person (~55ms of blocked event loop per open on a 6k-PR DB) |
| `GET /api/mergers` | per-repo merge-rights map (who's merged there) → the maintainer shield |
| `GET /api/me/export` · `DELETE /api/me/account` | **data-subject rights** (GDPR Arts. 15/20/17): the whole account as one JSON download (sealed GitHub token excluded) · irreversible erasure, confirm-by-typing-your-login, 400 in local mode. Erasure calls the plugin's `registerAccountErasure` hook — see Security & privacy posture |
| `GET /api/me`, `/api/my-turn`, `POST /api/my-turn/dismiss` | identity + triage queue + dismissals (`/me` carries `claudeReviewEnabled` + `deploymentMode` + `pro:{activityDigest,reviewMemory}`; cloud: 401 signed out) |
| `GET /api/activity?repoIds&userIds` | **Activity tab** (core, no AI): per repo `{stats, threadTotals, maintainerIds, attentionCount, hasUnread, prs[]}` — composes `getActivity`; scoped by the FilterBar repo + member selection (see Activity) |
| `GET /api/activity/feed?repoIds&userIds&limit&offset&excludeBots&botWindowDays` | **Consolidated Feed** (core, no AI; the Activity "Feed" entry): ONE flat, chronological (newest-first) stream of REAL activity events (opens / merges / reviews / comments, plus **commit-push items that ADDRESSED a review thread** — coalesced per author/PR into runs, affected threads inline via `affectedThreads`/`commitCount`/`changeSummary`; plain pushes excluded). Each item carries **`isMyTurn`** (participation: you authored the PR / are a requested reviewer / previously reviewed-or-commented, AND the actor isn't you) — that flag REPLACES the old two-source (`my_turn` vs `feed`) synthesis + dedup, so there's exactly one row per event. **My Turn / "FYI" is CORE (free, every tier), NOT a Pro capability:** `getConsolidatedFeed` computes `isMyTurn` directly via `feed/my-turn.ts` (no capability gate, no provider seam). `isMyTurn` rows are uncapped; plain activity is capped (`FEED_EVENT_CAP`). `excludeBots=true` drops bot-authored activity. **Paginated** (`limit`/`offset`; default page 50) → `{items[], users[], total, counts, generatedAt}` — **`counts` = server-computed facet counts over the WHOLE post-cap stream** (`ConsolidatedFeedCounts`: myTurn/claude/comments/prEvents/bots/byBotActor/byThreadState via the pure `computeFeedCounts`), so FeedView's pill badges reflect every matching item, not the loaded page (stale IndexedDB responses fall back to page-derived counts). Response also carries **`uncappedTotal?`** (pre-cap post-coalesce stream length) — FeedView's count label renders loaded-of-`total` + a "N most recent of M in window" cap disclosure, never the old visible-of-loaded "50 of 50". **Thread-state pills render on EVERY feed view** (not just botsMode; same semantics: an active state pill hides derivedState-less items). `botWindowDays` (clamped 1–90) widens the **botsOnly** feed window to match the shared `botAnalyticsWindow` selector (normal feed stays 14d); the head poll (`useFeedHasNew`) gets the identical params AND is gated on `!isPlaceholderData` so a window flip can't false-fire the refresh banner. **`includeAllCommits=true`** (the opt-in "**Commits**" pill, OFF by default, `feedShowCommits` transient store toggle) surfaces EVERY commit-push run — not just the thread-addressing ones — via `getCommitThreadItems` dropping its addressed-thread gate (run coalescing kept; a plain run emits empty `affectedThreads` + a "pushed N commits" summary); inert on the `botsOnly` path; threaded into BOTH the feed key and the head-poll key (identical scope). `counts` gained a **`commits`** facet (badges the pill); the **`prEvents`** facet is now READ by FeedView (the PR-events pill finally shows its count). No "seen"/acknowledged concept. |
| `GET /api/team-metrics?scope` · `GET /api/team-metrics/detail?scope` | **CORE/FREE** team flow-metric header (DORA-ish tiles + 12-week trend charts) + the per-tile PR drill-down. Moved OUT of the Pro Insights pane to the cross-repo **Feed** (`FeedMetricsPanel` atop `showingFeed`). `getTeamMetrics`/`getTeamMetricsDetail` were always CORE-computed; only the SERVING route was Pro-gated. `getTeamMetricsForScope` mirrors `getTeamInsights`' repo resolution (`resolveScopeRepoIds`; null/'all' → watched set). `api.teamMetricsDetail` repointed here from the old Pro `/api/pro/insights/metrics-detail` (now orphaned). `MetricsDetail` (drill-down tab) dropped its "Pro" badge. The Pro Insights Overview keeps its attention cards + Sprint/Retro/Compare (metrics no longer render there). **`MetricsDetail` is now SORTABLE** (retrofit onto `Activity/sortableTable.tsx` — it was the last static drill-down): every column clickable, a new sortable **Updated** column (backed by `MetricPr.updatedAt`, added to the `getTeamMetricsDetail` SELECT), the Diff column sorts on numeric `additions+deletions` (never the formatted string), and per-tab default sort = recency (updated desc) for open_prs/merges but the metric magnitude (value desc) for the duration/CI tabs (NOT recency for lead time) |
| `GET /api/repos/:id/claude-reviews` | repo-scoped Claude-review history (retrieval only; `enabled:false` when the flag is off) → `{prs:[{runs[]}]}` |
| `POST /api/prs/:id/review-comment` | post ONE inline review comment, re-anchoring to the file's first changed line when the requested `(path,line,side)` isn't addable → `AddReviewCommentResult`. Alone among the write routes it cannot stamp a local row (REST returns no review-THREAD node id), so it resyncs + VERIFIES and reports `visible`/`threadId` — see **Instant comment visibility** in Conventions. Once GitHub has 201'd, nothing downstream may fail the request |
| `GET /api/pro/prs/:id/annotations?kinds` · `POST …/annotations/run` (+ `/stream`) | **comment annotations** (Pro, `prSummary`): the cached per-PR read (pure, no side effects, no generate-on-open) · the ONE billing path — `kind` is a RUN kind (`addressed`\|`validity`\|`simplify`\|**`review`** = all three in one call per target), `targets[]` narrows to one thread/comment, `onlyStale` is the cheap refresh → `AnnotationRunResponse`. See **Comment annotations** under the Pro plugin |
| `GET·POST /api/pro/activity/digests*` · `GET·POST /api/pro/prs/:id/review-learnings` · `…/claude-reviews/:id/actions` | **Pro plugin** routes (registered only when `@pierre/pro` loads): per-repo Haiku digest (the Activity Feed renders the COLLECTION of these, scoped to WATCHED repos — no separate cross-repo route/pass) + review-memory data. See "Open-core Pro plugin" |
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
   repos/members/range, category + derived-state filters, the selected PR/thread, transient
   timeline hints (`timelineFocusPr/At/Event`, `timelineCenterAt`), and the `feedMyTurnOnly`
   feed filter. (The old overlay-focus signals `focusActive`/`myTurnOnly`/`timelineIsolate`/
   `exitFocusSignal` were **removed** — focus is now a tab, see below.)
3. **Tab state** → `store/pinnedTabs.ts` (`usePinnedTabs`): `ActiveTab = 'timeline' | 'activity'
   | <Tab.key>`; a `Tab{key,kind:'pr-detail'|'pr-focus'}` list. `openPrDetailTab` /
   `openPrFocusTab` / `closeTab`. Exactly one board mounts at a time (App keys the board slot;
   see "focus tabs"). (The old My-Turn tab kind + `openMyTurnTab` + the `m` key were removed —
   situational awareness is the Feed + its "My Turn only" toggle.)
4. **URL** → `useUrlState.ts` mirrors the store to the query string both ways (shareable /
   reloadable); the serializer diffs against **defaults**, so the common case stays clean.

**Auth gate (cloud only).** `App.tsx` calls `useMe()` first; a **401** (cloud, signed out)
renders `<SignInGate>` instead of the app, and a **sign-out** control shows when
`me.deploymentMode === 'cloud'`. Local `/api/me` never 401s, so the app renders as before.
`api/client.ts` sends `credentials` (the session cookie) on every request.

### UI regions (`App.tsx`)

- **FilterBar** — repo/team MANAGEMENT (add/remove/assign) lives in the Activity console's
  **TeamManager** modal ("Manage repos & teams"), where the debounced GitHub search picker
  (`RepoSearch` → `/api/repos/search`) is mounted (a successful add pops the sync-progress
  modal via `syncModalSignal`); `RepoSearch` also mounts standalone inside
  `FirstRunOnboarding` (zero-repo first run). The FilterBar keeps the visibility controls:
  watched repos in a **show/hide dropdown** (`RepoSelectPanel`): per-repo checkbox
  labelled `owner/name`, immediate visibility toggle (canonicalises to `repoIds=null` at
  all/none, won't hide the last one), per-row remove. Plus Members (auto-scoped, exclude-bots
  toggle), range presets (7/14/30/90d/custom) + a **Now** action (`timelineCenterAt`), event
  categories, derived-state tags. **Every filter EXCEPT the Team scope is TIMELINE-only**: the
  Members / Status / Events / Threads / Range controls and the right-hand Clear-filters cluster
  render **only when the Timeline board is the active tab** (`isTimeline = activeTab ===
  'timeline'` in `FilterBar`); Activity, Insights, PR-detail/focus tabs, and every drill-down
  keep just the `TeamSelector`. The filter STATE persists (reachable again from the Timeline
  tab); the Activity console's queries never send `userIds`/`excludeBots` anyway (its bot
  control is the feed's bot-lens pills); the board stays member-scoped. The
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
    FilterBar-visible set (`filters.repoIds`, already team-scope resolved). The caption states
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
  tab off — each with a "Show" link, its AI annotations above the untouched body, and a per-comment
  "Check review" — but that list is rendered by **`PrDetail` itself**, not `ChecksTab`, which is why
  the per-comment `CommentAnnotations`/`ReviewCheckButton` call sites are there.
- **Threads** — `ThreadList`/`ThreadView`: review threads grouped by file, **newest first**
  (files by most-recent thread; within a file by `createdAt` desc), with code anchors +
  new-comment highlights; each has a "Show" link. A sticky header carries **derived-state filter
  pills** (Untouched/Replied/Likely-addressed/Resolved, `store.threadStateFilter: Set<DerivedState>`)
  ANDed with the vendor `threadBotFilter`; the pills' badge counts come from the full loaded set
  (stable), and the bulk "Resolve N addressed" set is derived from the full list (independent of
  the visible filter). Arriving from the `bot-threads` tab presets `{likely_addressed}` via
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

Above the tab CONTENT (not inside any tab) sits the Pro **`ReviewCheckBar`** — the single
"Check review" run. It is there deliberately: the run spans review THREADS (Threads tab) and PR
COMMENTS (Overview tab), so mounting it under either heading misrepresented what a click spends.
It renders `null` without the capability, and carries its own border, so the free layout gains no
empty strip.

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
Insights (on whenever the plugin is active — no env flag, like `teamInsights`/`reviewMemory`).
**pro+** = the expensive advanced-AI features **AI Analysis + AI
Fix + Claude Review**, all gated together by **one** env flag **`PRO_ADVANCED_AI_ENABLED`**
(`PRO_CLAUDE_REVIEW_ENABLED` kept as a back-compat alias; the single source of truth is
`packages/pro/src/tier.ts` `ADVANCED_AI_ENABLED`, read by `index.ts` for the caps AND by each
feature's route/manager self-gate). The `aiAnalysis`/`aiFix`/`claudeReview` capability fields
remain distinct but flip together.

**The plugin boundary.** `src/pro/contract.ts` defines `ProContext` (the host hands the
plugin `db`/`schema`/`runTransaction`/`isPg`/`accountIdOf`/`llm.complete`/`queries`/
`reviewEvents`/`registerLearningsProvider`/`registerScheduledJob`/`registerPrDetailEnricher`/`registerMigrations`/`aiCredits`), `ProPlugin
{apiVersion:13, register()}`, and a `getProCapabilities()` singleton mirrored to the SPA via
`/api/me` (`pro:{activityDigest,reviewMemory,aiAnalysis,prSummary,aiFix,teamInsights,claudeReview,slackDigest,issueLinks}`)
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

**Activity tab — CORE, always-on, NO AI (not flagged); the DEFAULT landing view.** A peer of
Timeline on the **tab axis** (`ActiveTab = 'timeline' | 'activity' | <Tab.key>` in
`store/pinnedTabs.ts`; the Activity console is a full-`<main>` overlay over the warm board;
`?view=activity&activityRepo`). A "State of play" rail whose first entry is **Feed** (cross-repo),
then each repo — selecting a repo shows a **compact header** (stats + thread-state bar +
per-repo Pro digest) atop that repo's **open-PR list** (`RepoOpenPrList` — all its open PRs with
at-a-glance CI / approval standing / thread counts) THEN that **repo's own feed** (`RepoFeedHeader`
+ `RepoOpenPrList` + `<FeedView repoId>`). The rail selection is `store/filters.ts` `activityRepoId`
(`'feed'` default | a repoId). Built **entirely on the read layer**: `getActivity` composes
`getInsights`/`getOpenPrs`/`getMergers`; `listClaudeReviewsByRepo` is retrieval-only. **Scoped by
the FilterBar's REPO selection only** — repo visibility (+ team scope) flows into `useActivity` /
`useConsolidatedFeed` query keys, so a filter change re-scopes the whole console and refetches
(dim, never blank); **Members never scopes Activity** (Timeline-only filter — the console's
queries send `userIds: null` and the Members panel is hidden while Activity is active).
Refresh re-queries the **DB only**. Open-PR lists show 10 rows; ">10" swaps the old pagination
for a "Show all N" footer opening the sortable `open-prs` drill-down tab (a FeedOpenPrsPanel
TEAM group passes its label + exact repo set so the tab reproduces the group's count).
**Clicking any open-PR row/card opens the PR's detail tab** (`openPrDetailTab`) — no longer
isolates the feed on click. The **"Showing only #N" feed-isolation banner** (`FeedIsolationBanner`,
set from PrDetail's "Show in Activity feed" button or a drill-down, dismissible with Clear) renders
**directly under the panel's summary header** — under `RepoFeedHeader` in the per-repo Activity
console, under the "Review bots" header in `BotsView` (bot-only "Show in feed" lands there), and in
the unwatched-repo fallback branch — so it's present in every context isolation can reach (never
sticky; scrolls with content). When isolated, that view also **hides the repo-wide charts +
open-PR list**: RepoConsole drops `RepoInsightsPanel`/`RepoOpenPrList`, and `FeedView` drops its own
cross-repo `FeedOpenPrsPanel`. `FeedView` still reads `feedIsolatedPrId` only to scope its query;
the feed-wide "New activity — Refresh" banner remains sticky as its own element.

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
acted-on % / oldest-untouched backlog, computed in core `getTeamInsights`, rides `/api/pro/insights`
+ `teamInsights` — no new cap, no `apiVersion` bump); and confirm-gated **bulk-resolve** of
`likely_addressed` bot threads (`ThreadList` → `resolve-bot-threads`). "Acted-on" = the existing
`derivedState ∈ {resolved, likely_addressed}` heuristic (approximate — the UI says so). No migration,
no new AI/credit surface.

**Bot-Triage Platform (v2) — builds ON the v1 layer; CORE deterministic + PRO panels; NO new
AI/credit surface for the deterministic core; `apiVersion` STAYS 11.** Detection is now an
**account-scoped multi-signal classifier** (`sync/{review-fingerprint,reviewer-classify,reviewer-behavior,
app-attribution}.ts`), resolution order: **manual override > known vendor login > `users.githubType`
`'Bot'`/app-attribution > branded-marker fingerprint > behavioral score (medium confidence, never
auto-badges) > opt-in Haiku tie-break** (settings-gated OFF — the only AI, for the medium band).
`users.githubType` is captured from the GraphQL author `__typename`; `AUTOMATED_LOGIN_PATTERNS` + a
per-account allowlist catch service-account PATs. Classifications live in the CORE account-scoped
`bot_review_classification` (manual + auto rows, uniq `(accountId, authorUserId)`). New shared type
**`AutomatedReviewerKind = ReviewBotKind | 'in_house' | 'pierre'`** (widens `BotSignalVendorStat.kind`).
**Pierre's own review is tagged bot-derived PER-REVIEW** (not per-account): a compute-on-read join
`claudeReviews.postedReviewId = reviews.databaseId` (both TEXT) sets `provenance` = `ai_verbatim`
(`userBody===summary`) vs `human_curated` and `kind='pierre'` on the `ReviewDetail` ONLY — **the human
who posted (their token) is NEVER reclassified**. An optional hidden marker `<!-- pierre:claude-review
v=1 -->` + visible footer are stamped in `review/post-seam.ts`, gated by `pro_settings`
`bots.tagPierreReviews`/`pierreFooter` (threaded via the back-compat OPTIONAL `PostReviewArgs.pierreMarker?`/
`pierreFooter?`), and dogfooded through the same fingerprint detector. **Bot-ROI** (`getBotAnalytics(accountId,
window)`, CORE) → per-kind volume/actedOn%/untouched/`overdueUntouched`/`medianAddressedMs`/oldest/humanFollowThrough/noiseRatio/`verdict`
(keep|tune|**noisy**) + ≤12wk trend + deterministic tuning suggestions → `BotRoiPanel` (Pro-gated); **cost
is `null` from analytics, overlaid CLIENT-side** from `pro_settings` `bots.cost`. The `noisy` (ex-`kill`)
verdict is **response-time-gated**: it keys on `overdueUntouched` (untouched threads older than a
FIXED 36h grace window, `totals.overdueGraceMs`; `medianAddressedMs` per bot = time-to-addressed, display-only), never raw `untouched`, so a bot
isn't flagged noisy for threads still inside the team's normal response window (tested in
`bot-analytics-verdict.test.ts`). **Cross-bot dedup**
(`getBotDedupClusters(prId,accountId)`): groups automated-reviewer threads by `(path, line±window)`
across DISTINCT kinds → consensus/conflict, a rollup in `ThreadList` + `FeedView`. **Slack:** a
deterministic "Review bots" block in `buildSlackReport` (reads the `bot_signal` card from
`getTeamInsights`), gated on `pro_settings` `bot_slack_digest`, sent even when the AI digest is empty.
**Resolve (user-initiated only):** resolving `likely_addressed` bot threads on GitHub is a strictly
**user-initiated, confirm-gated** action via the shared `resolveThreadsOnGitHub` helper
(`src/bot-triage/resolve.ts`) — the per-PR `resolve-bot-threads` route + the scope-wide
`bot-threads/resolve` route. **ONLY `likely_addressed` threads, logged, never a merge.** _(REMOVED:
the old `bot_mute_rules` "hide" mute (Pierre-only cosmetic filter) + the standing `auto_resolve` cron
(`getAutoResolveCandidates` + `sync/bot-triage/auto-triage.ts`, `*/30`) were dropped — "mute in Pierre"
changed no behaviour, and the unattended cron was replaced by the confirm-gated manual resolve. The
`bot_mute_rules` table / `/api/bot-mute-rules` routes / `BotMuteRulesEditor` are gone; migration `0029`
still creates an orphan table; `pro_settings.bot_auto_resolve*` columns are now vestigial.)_
**"Only a bot reviewed this" risk flag:** a `bot_only_review` Insights card (`getBotOnlyReviewPrs`;
Pierre-verbatim counts as bot-derived) + a `ChecksTab` caution. **Settings:** a "Review bots" section
(`BotSection` / `DetectedReviewersTable`, two-way override) backed by `pro_settings`'s 11 `bot_*`
columns. Deterministic tuning suggestions on the ROI panel are **advisory only** (no mute action).
**Tiers:** detection/analytics/dedup/resolve are **CORE (free)**; the analytics PANELS, Slack block,
and Pierre tag/footer are **PRO** (gated on the existing `teamInsights`/`slackDigest` caps — no new
cap). **Migrations:** core `0027` (`users.github_type`), `0028` (`bot_review_classification`), `0029`
(`bot_mute_rules`, now orphaned), pg baseline `0016`; pro `0009`
(`pro_settings` + 11 `bot_*` columns). **Landmines:** (1) Pierre = **per-review** provenance — the human
author is never reclassified; (2) resolving bot threads is ALWAYS user-initiated + confirm-gated over
**only `likely_addressed`** threads, never a merge (no automatic/cron path exists); (3) `apiVersion` **STAYS 11** (`PostReviewArgs` gained only
OPTIONAL back-compat fields — no new `ProContext` seam); (4) the frontend must use `automatedReviewerMeta()`,
NOT `BOT_VENDOR_META[kind]`, for an `AutomatedReviewerKind`; (5) `getBotAnalytics` returns `cost=null` —
the client overlays cost from `pro_settings`.

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
WATCHED repos** (`inboxWatch=true`) intersected with the FilterBar-visible set — `FeedDigestList`
passes `watched∩visible` ids, and `loadRepoNames` defaults an unscoped request to `inboxWatch=true`
— so the Feed digest never fans out to every added repo. Per-repo collapse state persists via
`store/digestCollapse.ts`. **Cost-safe:** generation only on `POST …/digests/refresh`; a
**payload-hash cache** (unchanged repo = $0; the hash MUST zero `Date.now()`-derived fields like
`age_hours` or a dormant repo re-bills hourly), per-account min-interval + in-flight guard,
USD/repo caps. Capability `activityDigest` tracks `PRO_DIGEST_ENABLED`.

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
rendered ADDITIVELY above the untouched original). Staleness is **PASSIVE** — the GET is a pure
cached read that marks rows stale; nothing regenerates on PR open, which would bill per open of a
bot-flooded PR.

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
- **UI: three buttons became one.** "Simplify all" / "Check validity" / "Check addressed" (which
  lived in TWO places, one of them misleadingly under "PR comments" though a run there covered
  threads) are gone, as are `AddressedMarker` (its verdict pill hid the rationale in a `title`
  tooltip — invisible on touch) and `AddressedCheckControl`, and `ThreadAssessment` is now
  render-only. The entry points are `CommentAnnotations`' **`ReviewCheckBar`** (PR-wide, above the
  tabs, + "Re-check N stale") and **`ReviewCheckButton`** (per thread card / per PR comment, one
  combined call). The legacy per-item routes (`/api/pro/threads/:id/assess`,
  `…/addressed/check`) stay registered — they write the SAME rows through the same writer with the
  same hashes, so they are supported alternate writers, and the PR-wide addressed sweep is still
  reached from `BotThreadsDetail` where the bar isn't mounted.

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
own 14 account-scoped tables (`eraseProByAccountId`). apiVersion stays **13** (purely additive).
**Landmine: `accountScopedTables()` in `erase-account.ts` is a CHECKLIST the test iterates** — a
new `accountId`-bearing table that isn't added there fails `erase-account.test.ts` rather than
silently surviving a deletion the user was told was complete. (It already caught `teamRepos`.)

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
  `resolveScopeRepoIds` / `getTeamMetricsForScope` — 10/10 on drizzle 0.45 + node-postgres, plus
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
- `packages/pro/test/` — **8 files / 115 tests**, now runnable via `packages/pro/vitest.config.ts`
  (which aliases `better-sqlite3` to the backend's copy and exports a PLAIN object, since
  `vitest/config` is unresolvable from a package without vitest): `./apps/backend/node_modules/.bin/vitest
  run --root packages/pro`. The plugin still declares no `test` script and no vitest devDep, so
  `pnpm -r test` skips it — including its cross-account isolation suite.
- `apps/frontend/test/` — **1 file / 15 tests** (`prRef.test.ts`), same arrangement
  (`apps/frontend/vitest.config.ts`, `include` pinned to `test/**` so vitest can't collect the
  Playwright `e2e/*.spec.ts` and fail). Kept OUTSIDE `src/` so `pnpm typecheck` never tries to
  resolve the uninstalled vitest types.

The backend suite itself is **52 files / 480 tests** and DOES run in CI; `vitest.config.ts` raises
`hookTimeout` to 30s because a dozen suites migrate a throwaway SQLite DB in `beforeAll` and lost
the 10s default under parallel load — failures that look exactly like real regressions (a
different subset each run, always in a hook, never an assertion).

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
read resolves null → `[]`/null meanwhile). Plugin migration `0017` adds
`pr_comment_annotations` (+ backfills `comment_assessments` as `kind='validity'`).
**Every hand-written sqlite migration must also be registered in `migrations/meta/_journal.json`
or it SILENTLY skips** — `0038`–`0041` and pg `0025`–`0028` are registered. The Postgres
baseline (`migrations-pg/`) is a squash — cloud starts empty (synced data is regenerable; no
SQLite→Postgres migration). **Known gaps on this branch:** the four pg twins are exercised by
**nothing automated** — the whole test suite runs on SQLite, so their only cover is review plus the
`schema-parity` test on the two schema modules (a pg smoke needs the throwaway-container run
described under Dependency posture); and auto-merge's retarget guard still compares the last SYNCED
base ref rather than a stored `expected_base_ref` (see `merge/auto-merge-runner.ts`). **Docs:**
`docs/SYNC.md`, `docs/DEPLOY-RAILWAY.md`, `docs/GITHUB-AUTH-SETUP.md`,
`docs/LOCAL-CLOUD-TESTING.md`, `docs/DOMAIN-REPUTATION.md` (Safe Browsing + Search Console),
`docs/BILLING-STRIPE.md` (Stripe Payment Link + webhook → `accounts.plan` entitlement),
`docs/RELEASE.md`.
