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
│  │  │  │  └─ migrations/ + migrations-pg/   sqlite (.sql + meta/) | Postgres baseline (`db:generate:pg`)
│  │  │  ├─ github/             auth.ts (gh token), client.ts (per-account factories), queries.ts (the big query)
│  │  │  ├─ sync/               scheduler, sync-manager, sync-repo, upsert, derive-thread-state, commit-files, hydrate-detail
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
│  │     ├─ App.tsx            useMe() 401 → SignInGate; FilterBar / OpenPrsStrip / PinnedTabsBar (Activity|Timeline + dynamic tabs) / Timeline / DetailPane / Activity+pinned overlays
│  │     ├─ store/filters.ts   Zustand: all filter + selection + timeline-hint state (+ transient activityRepoId/activityThreadFilter)
│  │     ├─ hooks/             useUrlState, useTimeline, usePr, useTriage, useMe (+ useProCapabilities), useActivity, useReviewLearnings, …
│  │     ├─ api/client.ts      typed fetch wrapper (credentialed; throws ApiError)
│  │     ├─ components/        Timeline/, Activity/ (rail + FeedView + open-PR list + collapsible digest cards), PrDetail, ChecksTab, ThreadList/, ThreadView/, PinnedTabsBar, …
│  │     └─ lib/ui.ts          shared UI metadata (state colors/labels/shapes) + helpers
│  └─ landing/                 @pierre-review/landing — public marketing page (cloud, served at `/`); no shared runtime code
└─ packages/
   ├─ shared/                 @pierre-review/shared — types ONLY, the contract between the apps (src/types.ts)
   └─ pro/                    @pierre/pro — PRIVATE git submodule (alexwakeman/pierre-pro), runtime-imported plugin (per-repo
                              Haiku digest, Insights, Claude Review + AI Fix, Claude Review learnings, FYI/My-Turn feed
                              enrichment). Resolved by PATH (not a declared dep); absent → clean OSS
                              mode + install still succeeds. `git submodule update --init` to fetch. See "Open-core Pro plugin".
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

- **Trigger** (`scheduler.ts`): `node-cron` at `config.syncCron` (default `*/5`) →
  `syncAllRepos()` (off via `config.disableScheduler`); also repo-add + the manual/deep
  `POST /api/repos/:id/sync`. The periodic pass **skips accounts idle >
  `config.syncActiveWindowMinutes`** (default 15; `accounts.lastActiveAt` is stamped on each
  request from a loaded SPA) — a tenant with no open tab stops being re-synced (cloud-only;
  local is always-on).
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

19 tables. Multi-tenancy as above (`accountId` denormalized onto the anchor tables;
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
  `accountId`, unique `(accountId, githubNodeId)`.
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
- **`botReviewClassification`** + **`botMuteRules`** — the **Bot-Triage** tables (both CORE,
  `accountId`-scoped). `botReviewClassification` stores manual + auto automated-reviewer
  classifications (unique `(accountId, authorUserId)`; a manual row wins the resolution order);
  `botMuteRules` holds per-reviewer mute/auto-triage rules (`action` `hide`|`auto_resolve` +
  `autoResolveDays`). The plugin-owned `pro_settings` gained 11 `bot_*` columns (cost, Pierre
  tag/footer toggles, Slack digest). See **Bot-Triage Platform** below.

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
| `GET /api/timeline?from&to&repoIds&userIds&types&statuses&reviewStates&excludeBots` | **lean** feed `{prs[],events[]}` — no bodies/diffs. Defaults: 14d, bots shown (toggle in Members). `reviewStates` filters `review_submitted` markers by verdict (approved/changes_requested/commented/dismissed); absent = all, empty = none |
| `GET /api/prs/:id` | full PR detail (threads, reviews, comments, commits, checks, labels) |
| `POST /api/prs/:id/mark-viewed` (alias `/dismiss`) | record a view (`sha?` defaults to head) → clears new-since badges |
| `POST /api/prs/:id/resolve-bot-threads {threadIds}` | **bulk-resolve** the review-bot threads a later commit likely addressed → `{resolved,failed,results[]}`. Server RE-DERIVES eligibility (owned + review-bot-originated + `likely_addressed`) ∩ the client's reviewed list, then GitHub-resolves each (shares the `bot-triage/resolve.ts` `resolveThreadsOnGitHub` helper with auto-triage; behavior unchanged); never auto/blind. Core |
| `GET /api/bot-reviewers` · `PATCH /api/bot-reviewers/:userId` | **Bot-Triage** (CORE): detected automated reviewers → `DetectedReviewersResponse` · two-way manual override → `ReviewerClassification` (writes `bot_review_classification`) |
| `GET /api/bot-analytics?window=` | **Bot-ROI** (CORE): per-`AutomatedReviewerKind` volume/actedOn%/untouched/oldest/humanFollowThrough/noiseRatio/`verdict`(keep\|tune\|kill) + ≤12wk trend + tuning suggestions → `BotAnalyticsResponse`. Returns `cost=null` — the client overlays cost from `pro_settings` |
| `GET /api/prs/:id/bot-dedup` | **cross-bot dedup** (CORE): automated-reviewer threads grouped by `(path, line±window)` across distinct kinds → consensus/conflict clusters → `BotDedupResponse` |
| `GET·POST·DELETE /api/bot-mute-rules` | **Bot-Triage** mute/auto-triage rules (CORE; `bot_mute_rules`) |
| `GET /api/open-prs?repoIds&userIds` | currently-open PRs (ignores date range) |
| `GET /api/threads/:id` | single thread detail |
| `GET/POST /api/repos`, `DELETE /api/repos/:id` | manage watched repos (delete → 409 if syncing, else 204) |
| `GET /api/repos/search?q&cursor&limit` | live GitHub repo search → `{results[],hasNextPage,cursor}`; already-watched filtered out, owned/member floated up; `limit` 10 (max 25) |
| `POST /api/repos/:id/sync?full=true` | trigger sync → `202 {status:'started'}`, or `409` if already running |
| `GET /api/users` (+ isBot updates) | user list / bot flagging |
| `GET /api/mergers` | per-repo merge-rights map (who's merged there) → the maintainer shield |
| `GET /api/me`, `/api/my-turn`, `POST /api/my-turn/dismiss` | identity + triage queue + dismissals (`/me` carries `claudeReviewEnabled` + `deploymentMode` + `pro:{activityDigest,reviewMemory}`; cloud: 401 signed out) |
| `GET /api/activity?repoIds&userIds` | **Activity tab** (core, no AI): per repo `{stats, threadTotals, maintainerIds, attentionCount, hasUnread, prs[]}` — composes `getActivity`; scoped by the FilterBar repo + member selection (see Activity) |
| `GET /api/activity/feed?repoIds&userIds&limit&offset&excludeBots` | **Consolidated Feed** (core, no AI; the Activity "Feed" entry): ONE flat, chronological (newest-first) stream of REAL activity events (opens / merges / reviews / comments, plus **commit-push items that ADDRESSED a review thread** — coalesced per author/PR into runs, affected threads inline via `affectedThreads`/`commitCount`/`changeSummary`; plain pushes excluded). Each item carries **`isMyTurn`** (participation: you authored the PR / are a requested reviewer / previously reviewed-or-commented, AND the actor isn't you) — that flag REPLACES the old two-source (`my_turn` vs `feed`) synthesis + dedup, so there's exactly one row per event. **FYI is a Pro capability (`feedMyTurn`):** core (`getConsolidatedFeed`) builds plain rows; the `@pierre/pro` FYI provider (registered on the `registerFyiProvider` seam) sets `isMyTurn`. `isMyTurn` rows are uncapped; plain activity is capped (`FEED_EVENT_CAP`). `excludeBots=true` drops bot-authored activity. **Paginated** (`limit`/`offset`; default page 50) → `{items[], users[], total, generatedAt}`. No "seen"/acknowledged concept. |
| `GET /api/repos/:id/claude-reviews` | repo-scoped Claude-review history (retrieval only; `enabled:false` when the flag is off) → `{prs:[{runs[]}]}` |
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

- **FilterBar** — add repos via a debounced GitHub search picker (`RepoSearch` →
  `/api/repos/search`; a successful add pops the sync-progress modal via `syncModalSignal`).
  Watched repos live in a **show/hide dropdown** (`RepoSelectPanel`): per-repo checkbox
  labelled `owner/name`, immediate visibility toggle (canonicalises to `repoIds=null` at
  all/none, won't hide the last one), per-row remove. Plus Members (auto-scoped, exclude-bots
  toggle), range presets (7/14/30/90d/custom) + a **Now** action (`timelineCenterAt`), event
  categories, derived-state tags.
- **OpenPrsStrip** — collapsible top strip of open PRs (`all` / `my_turn` / `needs_attention`).
- **Timeline** — the centerpiece (below).
- **DetailPane** — resizable bottom pane (height persisted) under the board slot. **Hidden
  until a PR is selected** (`selectedPrId != null && !overlayActive`); no selection → the
  Timeline takes the full height (App fires a synthetic `resize` on the transition so vis
  refits). Shows **PrDetail** for the selected PR. **App lands on the Activity console by
  default** (Activity-first; a bare load → `?view=activity`, deep links keep timeline).
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
- **Contributor names are GitHub profile links** (`UserName` + the row labels). A
  **maintainer shield** (`MaintainerShield`) marks anyone with merge rights in the
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

Header carries **Show** + **Focus** links (drive the timeline). Three tabs:
- **Overview** — `ChecksTab.tsx`: CI/checks, **Reviewers** (all who submitted a review,
  badged by latest state) above **Approvers** (latest decisive review = `approved`), then
  **Merged by**, **Requested** reviewers, labels, meta — then the PR **Summary** (markdown,
  clamped to 3 lines, tall images hidden when collapsed) and **PR comments** (oldest first),
  each with a "Show" link.
- **Threads** — `ThreadList`/`ThreadView`: review threads grouped by file, **newest first**
  (files by most-recent thread; within a file by `createdAt` desc), with code anchors +
  new-comment highlights; each has a "Show" link.
- **Activity** — a chronological feed (**newest first**) of opens / commits / reviews /
  comments / merge-close, each with a "Show on timeline" action. A timeline **commit**
  ("View in Activity") or **review** ("Open in detail pane") popover deep-links here via the
  `activityFocus` signal (matched by `{type, refId}`) → opens this tab, scrolls to + flashes
  the entry. The "Show" links share `ShowOnTimeline`.

Keyboard (`useKeyboard.ts`): `/` focuses the filter, `j`/`k` cycle the board's PRs (board
only), `i` opens Insights, `esc` leaves any tab/overlay → the board (else clears the
selection).

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

**Three tiers.** **core (free)** = plain feed + timeline, no AI, no FYI. **pro** = AI summaries +
Insights + **FYI / "My Turn"** (`feedMyTurn`, on whenever the plugin is active — no env flag, like
`teamInsights`/`reviewMemory`). **pro+** = the expensive advanced-AI features **AI Analysis + AI
Fix + Claude Review**, all gated together by **one** env flag **`PRO_ADVANCED_AI_ENABLED`**
(`PRO_CLAUDE_REVIEW_ENABLED` kept as a back-compat alias; the single source of truth is
`packages/pro/src/tier.ts` `ADVANCED_AI_ENABLED`, read by `index.ts` for the caps AND by each
feature's route/manager self-gate). The `aiAnalysis`/`aiFix`/`claudeReview` capability fields
remain distinct but flip together.

**The plugin boundary.** `src/pro/contract.ts` defines `ProContext` (the host hands the
plugin `db`/`schema`/`runTransaction`/`isPg`/`accountIdOf`/`llm.complete`/`queries`/
`reviewEvents`/`registerLearningsProvider`/`registerScheduledJob`/`registerPrDetailEnricher`/`registerMigrations`/`aiCredits`), `ProPlugin
{apiVersion:11, register()}`, and a `getProCapabilities()` singleton mirrored to the SPA via
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
the FilterBar** — the repo + member selection flows into `useActivity` / `useConsolidatedFeed`
query keys, so a filter change re-scopes the whole console and refetches (dim, never blank).
Refresh re-queries the **DB only**.

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
window)`, CORE) → per-kind volume/actedOn%/untouched/oldest/humanFollowThrough/noiseRatio/`verdict`
(keep|tune|kill) + ≤12wk trend + deterministic tuning suggestions → `BotRoiPanel` (Pro-gated); **cost
is `null` from analytics, overlaid CLIENT-side** from `pro_settings` `bots.cost`. **Cross-bot dedup**
(`getBotDedupClusters(prId,accountId)`): groups automated-reviewer threads by `(path, line±window)`
across DISTINCT kinds → consensus/conflict, a rollup in `ThreadList` + `FeedView`. **Slack:** a
deterministic "Review bots" block in `buildSlackReport` (reads the `bot_signal` card from
`getTeamInsights`), gated on `pro_settings` `bot_slack_digest`, sent even when the AI digest is empty.
**Mute + auto-triage:** the CORE account-scoped `bot_mute_rules` (`action` `hide`|`auto_resolve` +
`autoResolveDays`); `hide` applied at read in analytics/feed; a CORE rule-gated scheduled job
(`sync/scheduler.ts`, `*/30 * * * *`) runs `getAutoResolveCandidates` → the shared `resolveThreadsOnGitHub`
helper (`src/bot-triage/{resolve,auto-triage}.ts`) — **ONLY `likely_addressed` threads, age-gated,
logged, never a merge, INERT with zero rules** (the `resolve-bot-threads` route shares the same helper).
**"Only a bot reviewed this" risk flag:** a `bot_only_review` Insights card (`getBotOnlyReviewPrs`;
Pierre-verbatim counts as bot-derived) + a `ChecksTab` caution. **Settings:** a "Review bots" section
(`BotSection` / `DetectedReviewersTable` / `BotMuteRulesEditor`, two-way override) backed by
`pro_settings`'s 11 new `bot_*` columns. **Tiers:** detection/analytics/dedup/mute/auto-triage are
**CORE (free)**; the analytics PANELS, Slack block, and Pierre tag/footer are **PRO** (gated on the
existing `teamInsights`/`slackDigest` caps — no new cap). **Migrations:** core `0027` (`users.github_type`),
`0028` (`bot_review_classification`), `0029` (`bot_mute_rules`), pg baseline `0016`; pro `0009`
(`pro_settings` + 11 `bot_*` columns). **Landmines:** (1) Pierre = **per-review** provenance — the human
author is never reclassified; (2) auto-triage is a CORE scheduled + rule-gated job over **only
`likely_addressed`** threads, never a merge; (3) `apiVersion` **STAYS 11** (`PostReviewArgs` gained only
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
the duplication. **FYI / "My Turn" is a Pro capability (`feedMyTurn`).** Core builds every item as
a PLAIN row (`isMyTurn:false`); the participation compute lives ONLY in `@pierre/pro`
(`packages/pro/src/my-turn/`), registered on the core **`registerFyiProvider`** seam
(`src/feed/fyi-provider.ts`, mirroring `registerLearningsProvider`) and called by
`getConsolidatedFeed` BEFORE the cap. Without the plugin (free tier) the feed stays plain — no FYI
on the wire, no cards/toggle/badge, no Welcome-back banner (the `me.newFeedItems` count also comes
from the provider). `isMyTurn` rows are the **content-rich, yellow-bordered cards** with a "My
Turn" badge + a `feedMyTurnOnly` "My Turn only" toggle (all gated on `feedMyTurn`); they're
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
- **Keep `/api/timeline` lean** — no bodies/diff hunks; fetch detail on demand via
  `/api/prs/:id` (hot path).
- **Heuristics get fixture tests.** Before changing `derive-thread-state.ts`, add a sample to
  `src/sync/__fixtures__/threads/` (see its README for the JSON shape + how to capture a real
  thread via `gh api`).
- **Idempotency is load-bearing.** New entities upsert on their GitHub node ID — the conflict
  target is **composite** with the scoping column (`accountId`/`prId`); new event types
  produce a deterministic `dedupeKey`.
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

**CLI** (`cli.ts` → `dist/cli.js`): parses `--no-open/--port/--db/--cloud/--mode` (+ env),
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
baseline `0016`, plus plugin migration `0009` (`pro_settings` + 11 `bot_*` columns). The Postgres
baseline (`migrations-pg/`) is a squash — cloud starts empty (synced data is regenerable; no
SQLite→Postgres migration). **Docs:**
`docs/SYNC.md`, `docs/DEPLOY-RAILWAY.md`, `docs/GITHUB-AUTH-SETUP.md`,
`docs/LOCAL-CLOUD-TESTING.md`, `docs/DOMAIN-REPUTATION.md` (Safe Browsing + Search Console),
`docs/BILLING-STRIPE.md` (Stripe Payment Link + webhook → `accounts.plan` entitlement),
`docs/RELEASE.md`.
