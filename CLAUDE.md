# pierre-review

A **single-page dashboard for tracking a team's GitHub activity across multiple
repositories**. It's built for sprint situational-awareness: at a glance, who's
doing what, which PRs are stalled, which review threads are sitting untouched, and
what needs _your_ attention right now.

It runs **two ways from one codebase**, selected by `DEPLOYMENT_MODE`
(`config.deploymentMode`):

- **local** (default): runs entirely on your machine — SQLite, no hosted backend,
  no stored credentials. Authenticates by shelling out to your already logged-in
  `gh` CLI, syncs into a local SQLite file, opens straight to the timeline. The
  original, unchanged experience.
- **cloud** (multi-tenant): a public landing page, GitHub-App OAuth sign-in,
  per-user encrypted accounts, and Postgres — self-hostable on Railway.

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

- **Sync** pulls PR activity and writes it to the DB. It runs on a 5-minute cron
  and is fully idempotent (safe to run repeatedly / overlap).
- **The API** is a thin read layer over the DB. The timeline endpoint is
  deliberately _lean_; heavy detail is fetched on demand.
- **The frontend** is a timeline-first dashboard. Server state lives in React
  Query; UI/filter state lives in a Zustand store mirrored to the URL.

The single most important domain concept is **derived thread state** (see below).
The second is the **local/cloud split** (next section): one codebase, SQLite + `gh`
locally, Postgres + GitHub-App OAuth + a public landing page in the cloud.

---

## Deployment modes (local vs cloud)

One env var — **`DEPLOYMENT_MODE` = `local` (default) | `cloud`** — drives a single
`config.deploymentMode` field that everything branches off (`config.isCloud`,
`config.dbDialect`).

| Concern | local (default, unchanged UX) | cloud (Railway) |
|---|---|---|
| DB | SQLite (`better-sqlite3`) | Postgres (`pg`) |
| Schema module | `db/schema.sqlite.ts` | `db/schema.pg.ts` (identical table/col names) |
| GitHub auth | `gh auth token` (one implicit account) | GitHub App OAuth, per-user tokens |
| Accounts | 1 synthesized `isLocal` account (id 1) | many, one per signed-in user |
| Landing page | never served (`/` → 302 `/app`) | served at `/` |
| Timeline SPA | `/app` (browser opens there) | `/app`, behind the auth gate |
| Claude Review | allowed (flag + local) | force-disabled (routes unregistered) |
| Sessions/OAuth | none | sealed cookie + `/api/auth/*` routes |

**Dual-dialect DB (the foundation).** The query layer is written **once**,
`await`-based, against a PORTABLE async surface and is dialect-agnostic:

- `db/client.ts` mode-selects the driver + schema at boot: local =
  `drizzle(better-sqlite3, sqliteSchema)`, cloud = `drizzle(node-postgres Pool,
  pgSchema)` (pg + the driver are dynamically imported so the unused one isn't
  loaded). It exports `db` (TYPED as the node-postgres instance — so any stray
  `.get()/.all()/.run()` is a compile error), the active `schema`, `isPg`,
  `closeDb()`, and `runTransaction(fn)`.
- **Portable terminals only**: `await q.execute()` (selects/inserts/updates/
  deletes), `.returning().execute()`, `onConflictDoUpdate`. NO `.get()/.all()/
  .run()`, NO `db.execute(sql)` (pg-only — use the query builder). "Rows affected"
  comes from `.returning({id}).execute().length`. Booleans in raw `sql` use
  `= true` (works on both). These were empirically verified on both drivers.
- **Transactions are the one dialect fork**: better-sqlite3 rejects async
  transaction callbacks, so `runTransaction` uses a manual `BEGIN/COMMIT/ROLLBACK`
  on the sqlite path and a real `db.transaction(async tx => …)` on pg. Callbacks
  take a `tx` executor; the ~4 tx blocks (`persistPr`, `deleteRepo`,
  `saveReviewSuccess`, `markReviewPosted`) use it.
- **`schema.sqlite.ts` and `schema.pg.ts` are kept in sync BY HAND** and guarded by
  `db/schema-parity.test.ts` (same tables, columns, nullability). Migrations are
  per-dialect: hand-maintained `db/migrations/*.sql` (sqlite) + a generated
  `db/migrations-pg/` baseline (`pnpm db:generate:pg`). `run-migrations.ts` picks
  the folder + migrator by mode (async either way).

**Multi-tenancy.** Every GitHub entity is owned by an `accounts` row.
`accountId` is **denormalized** onto `repos`, `pullRequests`, `events`,
`claudeReviews`, `myTurnDismissals` (so isolation is a single indexed predicate);
everything else reaches its account via `repoId`/`prId`. `users` + `commitFiles`
stay **global**. GitHub-node-id uniques are **composite** so two accounts can watch
the same repo: `repos (accountId, githubNodeId)`, `pullRequests (accountId,
githubNodeId)`, `events (accountId, dedupeKey)`, child tables `(prId,
githubNodeId)`. Every list/feed query filters by `accountId`; every id-addressed
getter scopes ownership and returns null/false on mismatch (the route → 404). The
query-layer IDOR guarantee is checked by `scripts/verify-isolation.ts`
(`pnpm --filter @pierre-review/backend verify:isolation`).

**Auth & tenancy plumbing.**
- `auth/account.ts` — `ensureLocalAccount()` (local, from `gh api user`, id 1),
  `getAccountById`, `getAccountUserId(accountId)` ("who am I" for triage),
  `getAccessToken(accountId)` (local → `gh auth token`; cloud → decrypt),
  `upsertCloudAccount` (OAuth). `auth/crypto.ts` — AES-256-GCM token sealing
  (`ENCRYPTION_KEY`).
- `github/client.ts` — **per-account** factories `getGraphqlClientFor(token)` /
  `ghRestGetFor`/`PostFor(token,…)`. **NO module-level token cache** (the #1 leak
  risk); `ghRestGet/Post` (gh-token) remain for the local-only Claude Review path.
- `api/plugins/auth.ts` — `registerAccountContext` (sets `request.account`),
  `registerSession` (cloud cookie + secure-session), `registerAuthGate` (cloud: 401
  unauthed `/api`, skipping `/api/health` + `/api/auth/*`), `accountIdOf(req)`.
- `api/routes/auth.ts` (cloud) — OAuth `login` (302→authorize+CSRF) / `callback`
  (exchange→upsert→session→`/app`) / `logout`.

**Serving & routing.** SPA built `base:'/app/'`, landing (`apps/landing`) at `/`;
`app.ts` registers two `@fastify/static` roots and the single `setNotFoundHandler`
(`api/plugins/error-handler.ts`) routes them (full routing under **Packaging**).
**Running cloud:** `cli.ts --cloud`/`--mode` set `DEPLOYMENT_MODE=cloud` (skipping the
gh pre-check + SQLite default); `docker-compose.yml` is a local Postgres, `Dockerfile`
+ `railway.json` deploy to Railway, `assertCloudConfig` fails loud on missing env.
Docs: `docs/DEPLOY-RAILWAY.md`, `docs/GITHUB-APP-SETUP.md`, `docs/LOCAL-CLOUD-TESTING.md`.

---

## Stack

- **Monorepo:** pnpm workspaces, TypeScript everywhere, ESM throughout. Node ≥20
  (developed on 24). Three workspaces: `backend`, `frontend` (the SPA), `landing`
  (the cloud marketing page) + the types-only `shared`.
- **Backend:** Fastify + Drizzle ORM, **dual-dialect** — SQLite (`better-sqlite3`,
  local) or Postgres (`pg`, cloud); `node-cron`, pino logging. Cloud adds
  `@fastify/cookie` + `@fastify/secure-session` (sealed sessions).
- **Frontend:** React + Vite + Tailwind + `vis-timeline`, Zustand, TanStack Query.
- **GitHub:** `@octokit/graphql` (one fat query per repo) + occasional REST; auth
  via `gh auth token` (local) or a per-account GitHub-App OAuth token (cloud).

---

## Workspace layout

```
pierre-review/
├─ apps/
│  ├─ backend/                 @pierre-review/backend
│  │  ├─ src/
│  │  │  ├─ index.ts           entrypoint: (cloud) assertCloudConfig → migrate → cleanup → (local) ensureLocalAccount → buildApp → schedule → listen
│  │  │  ├─ app.ts             Fastify factory: CORS, (cloud) session+account-context+auth-gate, static (public@/app + public-landing@/), routes
│  │  │  ├─ config.ts          env-driven config incl. deploymentMode/dbDialect + cloud vars; assertCloudConfig()
│  │  │  ├─ cli.ts             bin (dist/cli.js): --no-open/--port/--db/--cloud/--mode, gh pre-check (local), banner, browser-open
│  │  │  ├─ auth/              account.ts (account context + per-account tokens), crypto.ts (AES-256-GCM token sealing)
│  │  │  ├─ db/
│  │  │  │  ├─ schema.sqlite.ts  ← Drizzle tables (sqlite-core); schema.pg.ts is its pg-core twin (kept in sync; schema-parity.test.ts guards drift)
│  │  │  │  ├─ client.ts        mode-aware: better-sqlite3+sqliteSchema (local) | node-postgres Pool+pgSchema (cloud); exports db, schema, runTransaction, closeDb, isPg
│  │  │  │  ├─ queries.ts       read layer (async, accountId-scoped): getTimeline(), getPrDetail(), getOpenPrs(), getMyTurn(), getMergers()
│  │  │  │  ├─ triage.ts        computeTriage(): reasonTag, "my turn", new-since-viewed, approvals
│  │  │  │  ├─ migrations/      sqlite migrations (.sql + meta/ journal), commit alongside schema changes
│  │  │  │  └─ migrations-pg/   Postgres baseline (generated via `pnpm db:generate:pg`)
│  │  │  ├─ github/             auth.ts (gh token, local), client.ts (per-account graphql/REST factories), queries.ts (the big query)
│  │  │  ├─ sync/               scheduler, sync-manager, sync-repo, upsert, derive-thread-state, commit-files
│  │  │  │  └─ __fixtures__/threads/   JSON fixtures for the thread-state heuristic tests
│  │  │  ├─ review/             Claude Review (local-only): agent, review-manager, persist, post-review, clone-manager, prompt, auth, local-settings (user key)
│  │  │  └─ api/
│  │  │     ├─ routes/          one file per resource (timeline, prs, open-prs, repos, users, mergers, me, threads, health, auth[cloud], claude-review)
│  │  │     └─ plugins/         error-handler (single notFoundHandler / SPA+landing router), auth (account context + session + gate)
│  │  └─ data/pierre-review.sqlite   the local DB (gitignored)
│  ├─ frontend/                @pierre-review/frontend — the timeline SPA (built with base `/app/`)
│  │  └─ src/
│  │     ├─ App.tsx            useMe() 401 → SignInGate + cloud sign-out; layout: FilterBar / OpenPrsStrip / Timeline / DetailPane
│  │     ├─ store/filters.ts   Zustand store: all filter + selection + timeline-hint state
│  │     ├─ hooks/             useUrlState, useTimeline, usePr, useTriage (+useMe), useKeyboard, useLocalStorage
│  │     ├─ api/client.ts      typed fetch wrapper (credentialed; throws ApiError)
│  │     ├─ components/        Timeline/, PrDetail, ChecksTab, ThreadList/, ThreadView/, MyTurnPanel/, OpenPrsStrip/, SignInGate, …
│  │     └─ lib/ui.ts          shared UI metadata (state colors, labels, shapes) + helpers
│  └─ landing/                 @pierre-review/landing — public marketing page (cloud, served at `/`); independent Vite+React+Tailwind, shares no runtime code
└─ packages/
   └─ shared/                 @pierre-review/shared — types ONLY, the contract between the apps
      └─ src/types.ts
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
| `pnpm typecheck` | `tsc --noEmit` across all packages — **run this before considering work done** |
| `pnpm test` | recursive `vitest` (backend has tests; frontend/shared are no-ops) |
| `pnpm db:generate` | generate a Drizzle migration from `schema.sqlite.ts` changes |
| `pnpm db:generate:pg` | (re)generate the Postgres baseline from `schema.pg.ts` → `migrations-pg/` |
| `pnpm db:migrate` | apply pending migrations (dialect-aware; also runs on backend startup) |
| `pnpm db:studio` / `db:studio:pg` | open drizzle-studio against the local DB / a Postgres |
| `pnpm sync:once owner/repo` | one-off sync of a single repo without starting the server |
| `pnpm --filter @pierre-review/backend verify:isolation` | query-layer cross-account IDOR check (15 assertions, throwaway DB) |
| `pnpm package` | assemble `./release` (app + landing + backend) for publishing |

`DEPLOYMENT_MODE=local` (default) vs `cloud` selects the whole stack (SQLite vs
Postgres, landing page, OAuth). `pnpm dev` is local unless `DEPLOYMENT_MODE=cloud`
is set. The frontend dev server proxies `/api` to the backend (`BACKEND_PORT`,
default 4000); the landing has its own dev server on `:5174`
(`pnpm --filter @pierre-review/landing dev`). Config comes from `.env` at the repo
root then `apps/backend/.env` (see `config.ts`); local `DATABASE_URL` overrides the
SQLite path, cloud `DATABASE_URL` is the Postgres connection string. To run the
full cloud experience locally, see `docs/LOCAL-CLOUD-TESTING.md`.

---

## Backend

### Startup & auth

`index.ts` (cloud: `assertCloudConfig()` first) runs migrations, prunes redundant
events, builds the Fastify app, starts the scheduler, then listens. Auth differs by
mode (see **Deployment modes**):

- **Local:** one synthesized account (id 1). `ensureLocalAccount()` shells out to
  `gh api user` at startup (inheriting your SSO/keyring) and caches the identity on
  the `accounts` row, refreshed ~daily; non-fatal if offline (you just lose "my
  turn" triage). GitHub API calls use `gh auth token`. The SQLite connection opens
  with `journal_mode=WAL` and `foreign_keys=ON`. (The CLI also pre-checks
  `gh auth token` and fails loudly with a friendly message.)
- **Cloud:** no `gh`; accounts are created per user via GitHub-App OAuth, each with
  an encrypted token. `assertCloudConfig()` fails loud at boot on a missing cloud
  env var. The DB is a node-postgres `Pool`.

### Sync pipeline (`src/sync/`)

Pulls PR activity from GitHub into the DB; fully idempotent. **See
[docs/SYNC.md](docs/SYNC.md)** for the full pipeline — triggers, two-phase initial
backfill vs incremental, the fetch loop, cancel, rate limits. In brief:

- **Trigger** (`scheduler.ts`): `node-cron` at `config.syncCron` (default `*/5`) →
  `syncAllRepos()` (off via `config.disableScheduler`); also repo-add and the
  manual/deep `POST /api/repos/:id/sync`.
- **Plan** (`sync-manager.ts`): never-synced → **full backfill** (`since = now −
  backfillDays`, default 90), run **two-phase** (a fast ~14-day foreground pass, then
  the deep backfill in the background) so the board fills in seconds; else
  **incremental** from `lastIncrementalSyncAt − syncOverlapMinutes` (default 20) so
  mid-sync events aren't missed. Status is in `syncState`; an in-memory
  running/progress set (process-local) feeds the live UI.
- **Fetch** (`sync-repo.ts` + `github/queries.ts`): one fat `REPO_ACTIVITY_QUERY`
  (25 PRs/page, `updatedAt DESC`) walked until `updatedAt < since`; changed-file paths
  per commit via REST (`commit-files.ts`), cached **permanently** (immutable SHAs).
- **Persist** (`upsert.ts`): `persistPr()` upserts the whole PR subtree in one
  `runTransaction`, stamping `accountId`. **Idempotency is structural** — entities
  upsert on their GitHub **node id**, events on a `dedupeKey`; under multi-tenancy the
  conflict targets are **composite** (`(accountId, githubNodeId)` / `(accountId,
  dedupeKey)` / child `(prId, githubNodeId)`). Derived thread state computed here.
- **Per-account token** (`getAccessToken`) threaded into the fetch, never
  module-cached; per-account `try/catch` so one bad token doesn't abort the loop.

**Lean storage (both modes; default).** `config.persistBodies` is `false` by default
(`PERSIST_BODIES=true` stores everything — larger DB, fully-offline detail). When
lean, sync neither persists nor fetches bulky user text — comment/review/PR bodies,
review-comment `diffHunk`, commit `message`, the `checkRuns` JSON (the `ciStatus` enum
is kept); `REPO_ACTIVITY_QUERY` is trimmed (keeping review bodies for
substantive-review detection + review-comment bodies for a stored
`reviewComments.excerpt`). That text — regenerable, per-tenant-duplicated, the dominant
storage cost (~70%) — is instead **hydrated on demand** when a PR/thread opens
(`sync/hydrate-detail.ts` → `PR_DETAIL_QUERY`, matched by node id/sha) and
**browser-cached** in IndexedDB (`PersistQueryClientProvider` + `lib/queryPersist.ts`;
`pr`/`thread` queries `staleTime:Infinity`; `hooks/useDetailCache.ts` invalidates only
on a newer feed `updatedAt`). `cleanupRedundantReviewEvents` is skipped when lean;
SQLite migration `0010` makes the two `body` columns nullable.

### Derived thread state — the heart of the app

`derive-thread-state.ts` classifies each review thread into one of four states,
computed during sync and **stored** on `reviewThreads.derivedState`:

| State | Meaning |
|---|---|
| `resolved` | marked resolved on GitHub |
| `likely_addressed` | a commit touched the thread's file _after_ the last comment — **a heuristic** |
| `replied_unresolved` | someone replied, but it's unresolved and no later commit touched the file |
| `untouched` | no reply, no follow-up commit |

`likely_addressed` is intentionally fuzzy (false positives from unrelated edits;
false negatives from file renames/deletes) — **the UI communicates that
uncertainty**, and the logic is covered by fixture tests (see Conventions).

### Data model (`src/db/schema.sqlite.ts` + its `schema.pg.ts` twin are authoritative)

17 tables. Multi-tenancy: `accountId` is denormalized onto the tenancy-anchor
tables (`repos`, `pullRequests`, `events`, `claudeReviews`, `myTurnDismissals`) and
indexed; everything else reaches its account via `repoId`/`prId`. `users` and
`commitFiles` stay **global**. The core entities:

- **`accounts`** — a tenant. Local mode has exactly one (`id 1`, `isLocal=true`,
  synthesized from `gh api user`); cloud has one per signed-in user (with an
  encrypted `accessTokenEnc`). Replaces the old `localUser` singleton.
- **`repos`** — watched repos (`accountId`; unique `(accountId, owner, name)` and
  `(accountId, githubNodeId)`).
- **`users`** — GitHub actor metadata (`githubLogin` unique, `isBot`,
  `displayName`, `avatarUrl`); **global** (shared across accounts).
- **`pullRequests`** — PR metadata, state, draft, timestamps, CI/mergeable, etc.;
  carries `accountId`, unique `(accountId, githubNodeId)`.
- **`reviews`** — submitted reviews (`state`: approved / changes_requested /
  commented / dismissed / pending). A reviewer's *standing* decision is their
  latest non-`commented` review.
- **`reviewThreads`** + **`reviewComments`** — inline threads (carry stored
  `derivedState`) and their comments; **`prComments`** — issue-level PR comments.
  Under lean storage `reviewComments`/`prComments` `body` is nullable (and null when
  lean); `reviewComments.excerpt` always holds a short preview (see **Lean storage**
  under Sync).
- **`commits`** (`sha`+`prId`) + **`commitFiles`** (`sha` → changed paths, cached).
- **`events`** — the timeline feed; carries `accountId`, unique `(accountId,
  dedupeKey)`, typed (`pr_opened`, `pr_merged`, `pr_closed`, `review_submitted`,
  `review_comment`, `pr_comment`, `commit_pushed`). Only *substantive* reviews emit
  an event (an empty `commented` review is suppressed so it doesn't duplicate inline
  markers).
- **`reviewRequests`** — *ephemeral* pending review requests (a `userId` or a
  `teamName`, surfaced as `requestedReviewers` in PR detail); re-derived each sync
  (GitHub drops the request once a review lands).
- **`prViews`** — last-viewed SHA + timestamp per PR (drives "new since you looked").
- **`myTurnDismissals`** — dismissed "my turn" entries (`accountId`,
  `review_request` | `thread`); auto-resurface on newer activity.
- **`syncState`** — per-repo sync bookkeeping.
- **`claudeReviews`** + **`claudeReviewFindings`** — the **Claude Review** feature
  (see below; `claudeReviews` carries `accountId`). One run per row (re-review = new
  row; history kept, keyed by `(prId, headSha)`); Claude's `summary`/`verdict` are
  read-only, the user's `userBody`/`userVerdict` are what get posted. Findings carry
  `anchored`/`included` plus the agent's wording. **Not** part of the lean timeline;
  loaded on demand.

Conventions: timestamps are stored as unix-epoch integers in SQLite
(`mode: 'timestamp'`) / `timestamptz` in Postgres — both infer `Date` in the read
layer, so the query code is dialect-agnostic (one hand-rolled epoch comparison in
`getTimeline` uses the `tsBound` helper to bridge). Node IDs are the stable
identity; reads are **accountId-scoped**; and **triage fields are computed on read**
(`triage.ts`) — `reasonTag`, `reviewRequestedFromMe`, `newSinceLastViewed`,
approvals, and `isStalled` (`lastCommitAt` vs `stallThresholdDays`) are *not* stored.

### HTTP API (`src/api/routes/`)

Wire format is JSON with ISO-8601 timestamps; payload types live in
`packages/shared`. Each route file maps to a `client.ts` method.

| Method & path | Purpose |
|---|---|
| `GET /api/timeline?from&to&repoIds&userIds&types&statuses&excludeBots` | **lean** feed: `{ prs[], events[] }`, no bodies/diffs. Defaults: last 14d, `excludeBots=true` |
| `GET /api/prs/:id` | full PR detail (threads, reviews, comments, commits, checks, labels) |
| `POST /api/prs/:id/mark-viewed` (alias `/dismiss`) | record a view (`sha?` defaults to head) → clears new-since badges |
| `GET /api/open-prs?repoIds&userIds` | currently-open PRs (ignores date range) |
| `GET /api/threads/:id` | single thread detail |
| `GET /api/repos`, `POST /api/repos`, `DELETE /api/repos/:id` | manage watched repos (delete → 409 if syncing, else 204) |
| `GET /api/repos/search?q&cursor&limit` | live GitHub repo search for the Add-repo picker → `{ results[], hasNextPage, cursor }`: GraphQL `search(type: REPOSITORY)` best-match, already-watched repos filtered out, owned/member repos floated to top; `limit` default 10 (max 25) |
| `POST /api/repos/:id/sync?full=true` | trigger sync → `202 {status:'started'}`, or `409` if already running |
| `GET /api/users` (+ isBot updates) | user list / bot flagging |
| `GET /api/mergers` | per-repo merge-rights map (who's merged a PR there) → maintainer shield on row labels |
| `GET /api/me`, `GET /api/my-turn`, `POST /api/my-turn/dismiss` | account identity + triage queue + dismissals (`/me` also carries `claudeReviewEnabled` + `deploymentMode`; cloud: 401 when signed out) |
| `GET /api/auth/login`, `GET /api/auth/callback`, `POST /api/auth/logout` | **cloud only** — GitHub-App OAuth: 302→authorize / exchange+upsert+session→`/app` / clear session |
| `GET /api/prs/:id/claude-review` | latest run + findings + history + Claude-auth status + `enabled` (Claude Review) |
| `POST /api/prs/:id/claude-review {model}` | start a run → `202 {reviewId}`; `400` no-auth/no-head, `409` busy, `404` disabled |
| `GET /api/prs/:id/claude-review/status`, `POST …/cancel` | poll live progress / abort the SDK run |
| `GET /api/claude-reviews/:reviewId` | a specific past run (history selector) |
| `PATCH /api/claude-reviews/:reviewId {userBody?,userVerdict?}` | save the user's authored draft (never Claude's text) |
| `PATCH /api/claude-findings/:findingId {included?}` | tick a finding for inline posting |
| `POST /api/claude-reviews/:reviewId/post {userVerdict}` (+ `?dryRun=true`) | post one GitHub review (inline comments + body + verdict); `409` if head moved |
| `PUT /api/claude-review/key {key}` | set/clear the local user-supplied Anthropic key (empty clears); local-only |
| `GET /api/health` | health check (unauthenticated) |

The `claude-review` routes are **only registered when the feature is enabled** —
which is local-only (`config.claudeReviewEnabled` is force-`false` in cloud), so in
cloud they don't exist at all. **Cloud auth gate:** every `/api/*` data route 401s
when unauthenticated, except `/api/health` and `/api/auth/*` (`registerAuthGate`);
in local mode there's always an account so nothing 401s. Reads are accountId-scoped
and id-addressed routes verify ownership (→ 404 on mismatch).

---

## Frontend

### State model

Three layers, deliberately separated:

1. **Server state** → TanStack Query (`hooks/useTimeline.ts`, `usePr.ts`,
   `useTriage.ts`). Query keys for the timeline are built from the active filters
   so changing a filter refetches; PR/thread detail is fetched **on demand** when
   a PR is selected.
2. **Filter & selection state** → the Zustand store in `store/filters.ts`
   (`useFilters`): repos/members/date-range, event-category toggles,
   derived-state filters, the selected PR/thread, transient timeline hints
   (`timelineFocusPr`, `timelineFocusAt`, `timelineFocusEvent`, `timelineIsolate`,
   `timelineCenterAt`),
   and focus-mode signals (`focusActive`, `exitFocusSignal`) shared with the
   keyboard hook so Escape can drive focus.
3. **URL** → `hooks/useUrlState.ts` mirrors the store to the query string both
   ways, so views are shareable/reloadable. The serializer diffs against the
   **defaults**, so the common case stays a clean URL.

**Auth gate (cloud only).** `App.tsx` calls `useMe()` first; if it returns **401**
(cloud, signed out) it renders `<SignInGate>` (a "Sign in with GitHub" →
`/api/auth/login`) instead of the app, and a **sign-out** control shows in the
header when `me.deploymentMode === 'cloud'`. In local mode `/api/me` never 401s, so
the app renders exactly as before. `api/client.ts` sends `credentials` on every
request (the session cookie) and `setClaudeKey()` posts the local Anthropic key.

### UI regions (`App.tsx`)

- **FilterBar** — add repos via a debounced GitHub search picker (`RepoSearch`,
  scrollable results panel: avatar, stars, open-PR count, description, paginated;
  hits `/api/repos/search`; a successful add pops the sync-progress modal via the
  transient `syncModalSignal` store signal that `SyncStatus` watches). The watched
  repos live in a **show/hide dropdown** (`RepoSelectPanel`): a checkbox per repo
  labelled with its full `owner/name` (so same-named repos under different owners
  stay distinct), immediate visibility toggle (canonicalises to `repoIds=null` when
  all/none, and won't let you hide the last one), plus a per-row remove. Members
  (auto-scoped to who's active in the window, with an exclude-bots toggle), range
  presets (7/14/30/90d/custom) plus a
  **Now** action (recenter the window on the present, keeping the zoom — a
  transient `timelineCenterAt` store signal), event categories, and derived-state
  tags.
- **OpenPrsStrip** — collapsible top strip of open PRs with `all` / `my_turn` /
  `needs_attention` filters.
- **Timeline** — the centerpiece (see below).
- **DetailPane** — resizable bottom pane (height persisted to localStorage). Shows
  **MyTurnPanel** (the empty/no-selection state: awaiting-your-review, your PRs,
  threads awaiting you) or **PrDetail** for the selected PR.

### The timeline (`components/Timeline/`)

`vis-timeline` with `stack:false` + `stackSubgroups:true`. Rows are nested groups:
**repo → contributor**, group ids `repo:<rid>` and `repo:<rid>:user:<uid>`. Within
a contributor row, subgroups order a PR-bar line, its own-work event line, and a
shared cross-user marker band. PR bars get packed into lanes (`lanes.ts`); events
render as type-shaped SVG markers that **cluster** at coarse zoom (`clustering.ts`).

Key behaviors to know about:
- **Selection & highlight.** Clicking any event marker (or picking one from a
  cluster) loads its PR into the detail pane and opens a popover; clicking a PR bar
  selects it. Every highlight — the selected PR bar, the open popover's marker
  (`ev-selected`), the focus glows (`pr-cross-linked` / `ev-cross-linked`) — is the
  **same soft sky pulse** (`ev-select-pulse`), *not* a yellow border or marching-ants
  ring (both removed). Outside focus, clicking empty canvas dismisses **one level at
  a time**: an open popover first, else the selected PR bar, else a lingering
  exit-anchor glow left after leaving focus (`applyExitGlow(null)`).
- **One unified focus overlay** (`enterPrFocus` in `Timeline/index.tsx`). The
  PR-detail **Focus** link (`focusPrOnTimeline` → `timelineIsolate`), **double-clicking
  a PR bar**, and clicking a **cross-user marker** (standalone or picked from a
  cluster) all funnel through `enterPrFocus` to one identical state: collapse to every
  contributor's row, show **only that PR** (siblings hidden via `isolatePrBars`;
  markers filtered in `rebuildMarkers`). The Focus link fits the PR's span; a
  cross-user click recenters on the clicked instant + anchors it. It's **sticky**
  (clicks only explore), and the popover is trimmed to the focused PR (`focusPrId`).
  All exits — bottom-right **Exit focus**, **Esc**, **and the browser back button**
  (`enterPrFocus` pushes a `{pierreFocus}` history entry the `popstate` guard tears
  down) — run `exitFocusCore`: restore the rows, re-center + pulse the anchor.
  Repo-filter toggles and fresh strip/search nav also drop focus.
- **Per-row collapse.** A caret on each contributor label (`setRowCollapsed`) shrinks
  the row to its name by hiding its subgroup bands via `subgroupVisibility` — distinct
  from focus's whole-row `visible:false` (the labelled row stays). The collapsed set
  persists to `localStorage['pierre:collapsedRows']`, re-asserted after each rebuild.
  **Gotcha:** vis applies `subgroupVisibility` only during a group restack, so
  `setRowCollapsed` forces `itemSet.markDirty({restackGroups:true})` + `redraw()`.
  Focus mode suspends it (force-shows kept bands, hides the caret) and restores on exit.
- **Show vs Focus (PR detail).** **Show** (`openPrFocused`) just centres + glow-pulses
  the PR in the regular view — no focus. **Focus** enters the PR-isolation overlay
  above. Both, plus the per-thread / per-comment / activity "Show" links
  (`ShowOnTimeline` → `showEventOnTimeline`, which recentres on a specific event +
  glows its marker), funnel through the one `timelineFocusPr` consumer effect in
  `Timeline/index.tsx` — its three branches (isolate / show-event / centre-only) are
  the place to start for any timeline-navigation change.
- **Commits are hidden by default** (`DEFAULT_CATEGORIES` excludes `commits`);
  enabling them round-trips through the URL.
- **Contributor names are GitHub profile links** (the `UserName` component / the
  timeline row labels), using the login even when a display name is shown. A
  **maintainer shield** (`MaintainerShield`) sits next to anyone who has merge rights
  in the repo in context (has merged a PR there, from `useMergers`); `UserName` takes
  an optional `repoId` and renders it wherever a username appears in a PR context
  (ChecksTab, PrDetail header/activity/comments, thread comments), mirroring the
  timeline rows' own HTML-string shield.
- **Zebra striping** on contributor rows (alternating subtle band) via `nth-child`
  in `index.css`, applied to both the label and foreground panels.
- The timeline endpoint stays lean — the selected PR is never filtered out (it's
  force-shown if a filter would hide it), and detail loads only on selection.

### PR detail (`PrDetail.tsx`)

Header carries left-aligned **Show** + **Focus** links (drive the timeline, see
above). Three tabs:
- **Overview** — `ChecksTab.tsx` (CI/checks + **Merged by** — `pr.mergedById`,
  resolved via the detail's `users` array; only on merged PRs — + **Approvers** —
  each reviewer whose latest decisive review is `approved` — + requested reviewers +
  labels + meta), then the PR **Summary** (the PR body as markdown, clamped to the
  first 3 lines with a Show more/less toggle), then **PR comments** (issue-level,
  **newest first**), each with a left "Show" link.
- **Threads** — `ThreadList`/`ThreadView`: review threads grouped by file, **newest
  first** (files ordered by their most-recent thread; threads within a file by
  `createdAt` desc), with code anchors and new-comment highlights; each thread has a
  left "Show" link.
- **Activity** — a chronological feed (**newest first**) of opens / commits /
  reviews / comments / merge-close, each with a "Show on timeline" action. A
  timeline **commit** popover's "View in Activity" link deep-links here: the store
  `activityFocus` signal opens this tab and scrolls to + flashes that commit's row.

> Note: **Checks** was merged into Overview (`ChecksTab`); **Threads** is its own tab
> again. The per-thread / per-comment / activity "Show" links all use the shared
> `ShowOnTimeline` component.

Keyboard: `/` focuses the filter, `j`/`k` cycle PRs, `esc` exits focus mode if
active (leaving the selection intact) else clears the selection
(`hooks/useKeyboard.ts`).

---

## Claude Review (agentic PR review)

The app's first feature that reaches beyond read-only mirroring. A **Claude Review**
tab in the PR detail pane runs the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`)
against the selected PR, returns **structured JSON findings**, persists them per head
SHA (history kept), lets the user author their own review + tick which findings to post,
then posts **one** GitHub review (inline comments + body + verdict).

- **Opt-in, off by default, LOCAL-ONLY.** Gated behind `ENABLE_CLAUDE_REVIEW=true`
  (`config.claudeReviewEnabled`) — it spends real money / Agent-SDK credits per run.
  **Force-disabled in cloud** (`config.claudeReviewEnabled = !isCloud && …`): the
  routes aren't even registered (`app.ts`), keeping the gh-CLI / clone-manager
  dependency unreachable on Railway. When off, the frontend hides the tab (via
  `/api/me`'s `claudeReviewEnabled`).
- **Auth resolves from the ambient environment** (`ANTHROPIC_API_KEY` →
  `CLAUDE_CODE_OAUTH_TOKEN` → a logged-in Claude session); `review/auth.ts` detects
  it best-effort (the first real SDK auth error is the authoritative gate). A
  **user-supplied key** (pasted in the tab, `PUT /api/claude-review/key`, stored
  local-only in `~/.pierre-review/config.json` via `review/local-settings.ts`)
  takes precedence: `agent.ts` overrides `process.env.ANTHROPIC_API_KEY` for the run
  (`applyUserAnthropicKey`, restored in `finally`, gated on `reviewConcurrency===1`
  to avoid an env race). Nothing is ever written to the cloud DB.
- **`src/review/`** mirrors the sync machinery: `review-manager.ts` (in-memory job
  manager, one review per PR, `config.reviewConcurrency` gate, startup reconcile of
  orphaned `running` rows), `agent.ts` (the SDK run: an in-process MCP `submit_review`
  tool — `schema.ts` — captures structured output; read-only tools only, `cwd` = a git
  worktree, `permissionMode:'bypassPermissions'`, `settingSources:[]`, `maxTurns` +
  `maxBudgetUsd` caps, `AbortController` for cancel), `clone-manager.ts` (partial clones
  under `config.cloneDir` = `~/.pierre-review/clones`, ephemeral per-run worktrees,
  LRU cache cleanup), `prompt.ts` (inline reviewer prompt + `NOISE_GLOBS` diff
  stripping), `post-review.ts` (unified-diff line-anchoring + the single GitHub review
  POST via `ghRestPost`), `persist.ts` (DB writes).
- **Line-anchoring is the load-bearing bug risk** (`buildAnchorIndex` in
  `post-review.ts`): a finding posts inline only if ticked AND its `(path, line, side)`
  lands on an addable diff line; unticked/unanchored are surfaced, never auto-injected.
  Posting pins `commit_id` to the head SHA and 409s if the head moved.
- **Frontend:** `ClaudeReviewTab.tsx` + `useClaudeReview.ts` (TanStack Query, polls
  `…/status` while running). Claude's output is **read-only** (each finding has a Copy
  button); a separate "Your review" textarea + verdict is what posts. Re-reviewing the
  same head SHA **warns but is allowed**.
- **Packaging:** the SDK + its peers (`@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`)
  + `zod` are curated runtime deps in `build-release.mjs`; the inline prompt + `import
  type`-only shared usage keep the no-`.ts`-leak / no-shared-runtime guards passing.

## Conventions & gotchas

- **ESM module resolution differs per package.** Backend is **NodeNext** —
  relative imports need explicit `.js` extensions (`./foo.js`). Frontend is
  **Bundler** — no extensions. Don't mix them up; the compiler will complain but
  it's the #1 source of confusion.
- **The `shared` package is the only bridge.** Never import backend code from the
  frontend or vice versa — go through `@pierre-review/shared` (types only; it
  has no build output, `main`/`types` point at `src`).
- **Two schemas, kept in sync BY HAND.** Edit **both** `db/schema.sqlite.ts` and
  `db/schema.pg.ts` (same tables/columns/`$type`s — `schema-parity.test.ts` fails on
  drift). Then `pnpm db:generate` for the sqlite migration (commit it with the
  change) **and** `pnpm db:generate:pg` to refresh the Postgres baseline. The sqlite
  schema changes since the original `localUser`-era are hand-written
  (`0008_multitenant_accounts.sql`), so prefer hand-writing additive sqlite
  migrations over a full `db:generate`.
- **Dual-dialect query layer = portable async only.** `db` is typed as the
  node-postgres instance; use `await q.execute()` / `.returning().execute()` /
  `runTransaction` — never `.get()/.all()/.run()` or `db.execute(sql)` (a compile
  error / pg-only). Booleans in raw `sql` use `= true`. See **Deployment modes**.
- **Per-account isolation is load-bearing.** Every list/feed query must filter by
  `accountId`; every id-addressed read/write must scope ownership (→ null/false →
  404). New id-routes: run `verify:isolation` after. GitHub tokens come from the
  account (`getAccessToken`) — never a module-level cache.
- **Keep `/api/timeline` lean.** No comment bodies, no diff hunks — fetch detail
  on demand via `/api/prs/:id`. This endpoint is on the hot path.
- **Heuristics get fixture tests.** Before changing `derive-thread-state.ts`, add
  a sample to `apps/backend/src/sync/__fixtures__/threads/` (see the README there
  for the JSON shape and how to capture a real thread via `gh api`).
- **Idempotency is load-bearing.** New entities must upsert on their GitHub node
  ID — under multi-tenancy the unique/conflict target is **composite** with the
  scoping column (`accountId` or `prId`); new event types produce a deterministic
  `dedupeKey` (unique per `(accountId, dedupeKey)`).
- **TypeScript is strict** (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`).
- The local DB (`apps/backend/data/`) and `.env` files are gitignored — no team
  activity data or tokens are ever committed. Cloud secrets (`ENCRYPTION_KEY`,
  `SESSION_SECRET`, GitHub-App creds) live only in env (`.env.cloud.example` is the
  template); stored OAuth tokens are AES-256-GCM-sealed.

---

## Verifying changes

For backend/heuristic logic, `pnpm test` + `pnpm typecheck` (4 workspaces). For UI
work, `pnpm dev` is usually already running; the SQLite DB at `apps/backend/data/`
holds real synced data you can query (e.g. with `sqlite3`) to pick test cases, and
you can deep-link app state via URL params (`?pr=<id>`, `?repos=<ids>`, `?cats=…`)
to reach a specific view without clicking through.

For **multi-tenant / cloud** changes: `verify:isolation` proves cross-account IDOR
at the query layer (15 assertions against a throwaway DB). To exercise the full
deployed experience locally — landing at `/`, OAuth, Postgres, app at `/app` —
bring up `docker compose up -d db` and run `--cloud` / `DEPLOYMENT_MODE=cloud` per
`docs/LOCAL-CLOUD-TESTING.md`. Confirm **local is unchanged** (`pnpm dev` →
straight to `/app`, no landing, no sign-in).

---

## Packaging & publishing

Ships to npm as a **single unscoped package `pierre-review`** (`npx pierre-review`,
or `pierre` installed globally — both bins → `dist/cli.js`). Tarball is **built
artifacts only** (no `.ts`/`src`/configs/tests). The CI publishing automation
(version computation, atomic tag+commit, idempotent publish) is documented in
**[docs/RELEASE.md](docs/RELEASE.md)** — and **never run `npm publish`/`npm login`
from here**; let CI (or the user) do it.

**Single-process production.** One Fastify server serves the JSON API (`/api`), the
SPA (`/app`), and — in cloud — the landing (`/`). Static serving is gated on sibling
`public/index.html` + `public-landing/index.html` (present in the release, **absent
in the dev tree**, so `pnpm dev`'s Vite proxy is unchanged). All routing is the
**single** `setNotFoundHandler` (`api/plugins/error-handler.ts`): unknown `/api` →
JSON 404; `/app*` → SPA; `/` + other → landing (cloud) or 302 `/app` (local). SPA
built `base:'/app/'`, calls the API with relative `/api`.

**CLI** (`cli.ts` → `dist/cli.js`): parses `--no-open/--port/--db/--cloud/--mode`
(and matching env), maps them to env **before** importing config, sets
`NODE_ENV=production` (no pino-pretty; static serving on). Local defaults the DB to
`~/.pierre-review/…sqlite` (never the read-only install dir) and pre-checks
`gh auth token`; `--cloud` skips both (Postgres `DATABASE_URL`; `assertCloudConfig`
validates at boot). Prints the ASCII banner + URL, boots via `start()` from
`index.ts` (guarded run-as-main), opens the browser cross-platform (built-in, no dep)
unless `--no-open`.

**Two load-bearing traps:**
- **`@pierre-review/shared` is types-only** and NOT a published dep — the backend must
  `import type` only (never a runtime value); offenders use local `const` copies. The
  release greps `release/dist` and **fails** on any real shared import/require.
- **pnpm is pinned** (`packageManager: pnpm@9.15.9`) so CI, the Railway `Dockerfile`
  (corepack), and local dev match; a newer pnpm blocks native builds
  (`ERR_PNPM_IGNORED_BUILDS` on `better-sqlite3`/`esbuild` — also in
  `pnpm.onlyBuiltDependencies`). Bumping the pin = regenerate `pnpm-lock.yaml`.

**`pnpm package`** (`scripts/build-release.mjs`) assembles `./release/`: builds
frontend(`/app`)+landing+backend, copies compiled JS + both migration folders
(`.sql`+`meta/`) + SPA→`public/` + landing→`public-landing/`, generates
`package.json` (curated deps: **drop** shared, **add** `@fastify/static|cookie|
secure-session`, `pg`), `release-README.md`→`README.md`. Sanity asserts fail on a
missing key file, a leaked `.ts`, or a shared runtime import. `better-sqlite3` stays a
runtime dep (native); `pg` loads only in cloud (dynamic import).

---

## History & planning

Early commits carry `pN` phase notation from the original v1/v1.1 plan (removed). The
SQLite migrations (`0000`+) track the schema's evolution — `0008_multitenant_accounts`
added the `accounts` table + `accountId` + composite uniques; `0009`/`0010` added lean
storage. The Postgres baseline (`migrations-pg/0000_*` + `0001`) is a squash of the
current schema — cloud starts empty (synced data is regenerable; no SQLite→Postgres
migration). **Docs:** `docs/SYNC.md` (sync pipeline), `docs/DEPLOY-RAILWAY.md`,
`docs/GITHUB-APP-SETUP.md`, `docs/LOCAL-CLOUD-TESTING.md`,
`docs/DOMAIN-REPUTATION.md` (Chrome Safe Browsing warning + Search Console),
`docs/RELEASE.md`.
