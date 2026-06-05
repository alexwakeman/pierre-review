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
 gh auth token ─┐
                ▼
   GitHub API ──► sync pipeline ──► SQLite ──► Fastify API ──► React SPA
  (GraphQL+REST)  (every 5 min,     (local    (lean /timeline,  (vis-timeline,
                   idempotent)       file)     detail on demand) zustand, RQ)
```

- **Sync** pulls PR activity and writes it to SQLite. It runs on a 5-minute cron
  and is fully idempotent (safe to run repeatedly / overlap).
- **The API** is a thin read layer over SQLite. The timeline endpoint is
  deliberately _lean_; heavy detail is fetched on demand.
- **The frontend** is a timeline-first dashboard. Server state lives in React
  Query; UI/filter state lives in a Zustand store mirrored to the URL.

The single most important domain concept is **derived thread state** (see below).

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
- `auth/account.ts` — the account context: `ensureLocalAccount()` (local, from
  `gh api user`, id 1), `getAccountById`, `getAccountUserId(accountId)` (the "who
  am I" for triage, replaces the old `getLocalUserId`), `getAccessToken(accountId)`
  (local → `gh auth token`; cloud → decrypt), `upsertCloudAccount` (OAuth).
- `auth/crypto.ts` — AES-256-GCM sealing of stored tokens (`ENCRYPTION_KEY`).
- `github/client.ts` — **per-account** factories `getGraphqlClientFor(token)` /
  `ghRestGetFor(token,…)` / `ghRestPostFor(token,…)`. NO module-level token cache
  (the #1 leak risk). `ghRestGet/Post` (gh-token wrappers) remain for the
  local-only Claude Review posting path.
- `api/plugins/auth.ts` — `registerAccountContext` (sets `request.account` every
  request: local account, or the session's account in cloud), `registerSession`
  (cloud: `@fastify/cookie` + `@fastify/secure-session`), `registerAuthGate`
  (cloud: 401 unauthenticated `/api` data routes, skipping `/api/health` +
  `/api/auth/*`), `accountIdOf(req)`.
- `api/routes/auth.ts` (cloud only) — `GET /api/auth/login` (302 → GitHub authorize
  + CSRF state cookie), `GET /api/auth/callback` (exchange code → upsert account →
  set session → 302 `/app`), `POST /api/auth/logout`.

**Serving & routing.** The SPA is built with **`base:'/app/'`**; the landing app
(`apps/landing`) builds to `/`. `app.ts` registers two `@fastify/static` roots
(`public/` at `/app/`, `public-landing/` at `/` in cloud). The single
`setNotFoundHandler` (`api/plugins/error-handler.ts`) routes: unknown `/api` →
JSON 404; `/app*` GET → SPA index; `/` + other GET → landing (cloud) or 302 `/app`
(local).

**Running cloud locally / packaging.** `cli.ts` gains `--cloud` / `--mode`
(sets `DEPLOYMENT_MODE=cloud`, skips the gh pre-check + SQLite default). `pnpm
package` builds frontend@`/app` + landing + backend and assembles
`public/` + `public-landing/` + `dist/db/migrations{,-pg}`; curated deps add `pg`,
`@fastify/cookie`, `@fastify/secure-session`. `docker-compose.yml` stands up a
local Postgres; `Dockerfile` + `railway.json` deploy to Railway. Cloud startup
fails loud on missing env (`assertCloudConfig`). Docs:
`docs/DEPLOY-RAILWAY.md`, `docs/GITHUB-APP-SETUP.md`, `docs/LOCAL-CLOUD-TESTING.md`.

---

## Stack

- **Monorepo:** pnpm workspaces, TypeScript everywhere, ESM throughout. Node ≥20
  (developed on 24).
- **Backend:** Fastify + Drizzle ORM + SQLite (`better-sqlite3`), `node-cron`,
  pino logging.
- **Frontend:** React + Vite + Tailwind + `vis-timeline`, Zustand, TanStack Query.
- **GitHub:** `@octokit/graphql` (one fat query per repo) + occasional REST, auth
  via `gh auth token`.

---

## Workspace layout

```
pierre-review/
├─ apps/
│  ├─ backend/                 @pierre-review/backend
│  │  ├─ src/
│  │  │  ├─ index.ts           entrypoint: migrate → cache user → buildApp → schedule → listen
│  │  │  ├─ app.ts             Fastify factory: logger, CORS, error handler, route registration
│  │  │  ├─ config.ts          env-driven config (port, dbPath, cron, backfill, thresholds)
│  │  │  ├─ db/
│  │  │  │  ├─ schema.sqlite.ts  ← Drizzle tables (sqlite-core); schema.pg.ts is its pg-core twin (kept in sync; schema-parity.test.ts guards drift)
│  │  │  │  ├─ client.ts        better-sqlite3 + drizzle, sets WAL + foreign_keys pragmas
│  │  │  │  ├─ queries.ts       read layer: getTimeline(), getPrDetail(), getOpenPrs(), getMyTurn(), getMergers()
│  │  │  │  ├─ triage.ts        computeTriage(): reasonTag, "my turn", new-since-viewed, approvals
│  │  │  │  └─ migrations/      drizzle-kit SQL migrations (commit alongside schema changes)
│  │  │  ├─ github/             auth.ts (gh token), client.ts (graphql/REST), queries.ts (the big query)
│  │  │  ├─ sync/               scheduler, sync-manager, sync-repo, upsert, derive-thread-state, commit-files
│  │  │  │  └─ __fixtures__/threads/   JSON fixtures for the thread-state heuristic tests
│  │  │  └─ api/
│  │  │     ├─ routes/          one file per resource (timeline, prs, open-prs, repos, users, mergers, me, threads, health)
│  │  │     └─ plugins/         error-handler, etc.
│  │  └─ data/pierre-review.sqlite   the local DB (gitignored)
│  └─ frontend/                @pierre-review/frontend
│     └─ src/
│        ├─ App.tsx            layout: FilterBar / OpenPrsStrip / Timeline / DetailPane
│        ├─ store/filters.ts   Zustand store: all filter + selection + timeline-hint state
│        ├─ hooks/             useUrlState, useTimeline, usePr, useTriage, useKeyboard, useLocalStorage
│        ├─ api/client.ts      typed fetch wrapper for every endpoint (throws ApiError)
│        ├─ components/        Timeline/, PrDetail, ChecksTab, ThreadList/, ThreadView/, MyTurnPanel/, OpenPrsStrip/, …
│        └─ lib/ui.ts          shared UI metadata (state colors, labels, shapes) + helpers
└─ packages/
   └─ shared/                 @pierre-review/shared — types ONLY, the contract between the two apps
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
| `pnpm db:generate` | generate a Drizzle migration from `schema.ts` changes |
| `pnpm db:migrate` | apply pending migrations (also runs automatically on backend startup) |
| `pnpm db:studio` | open drizzle-studio against the local DB |
| `pnpm sync:once owner/repo` | one-off sync of a single repo without starting the server |

The frontend dev server proxies `/api` to the backend (`BACKEND_PORT`, default 4000).
Config comes from `.env` at the repo root then `apps/backend/.env` (see `config.ts`);
`DATABASE_URL` overrides the SQLite path.

---

## Backend

### Startup & auth

`index.ts` runs migrations, prunes stale data, caches the local user, builds the
Fastify app, starts the scheduler, then listens. **Auth is one-shot at startup**:
it shells out to `gh auth token` (inheriting your SSO/keyring) and **fails loudly
if `gh` isn't authenticated**. The local user identity (`gh api user`) is cached in
the DB and refreshed ~daily; it's non-fatal if offline (you just lose "my turn"
triage). The DB connection opens with `journal_mode=WAL` and `foreign_keys=ON`.

### Sync pipeline (`src/sync/`)

- **Scheduler** (`scheduler.ts`) runs `config.syncCron` (default `*/5 * * * *`)
  and calls `syncAllRepos()`. Disabled by `config.disableScheduler`.
- **Modes** (`sync-manager.ts`): a repo never synced gets a **full backfill**
  (`since = now − backfillDays`, default 90). Otherwise an **incremental** sync
  uses `lastIncrementalSyncAt − syncOverlapMinutes` (default 20) as `since`, so
  events that landed mid-sync aren't missed.
- **Fetch** (`sync-repo.ts` + `github/queries.ts`): one fat `REPO_ACTIVITY_QUERY`
  pulls PRs (25/page, `updatedAt DESC`) with their reviews, threads, comments,
  commits, and checks, walking pages until `updatedAt < since`. Changed-file paths
  per commit are fetched via REST (`commit-files.ts`) and cached **permanently**
  (SHAs are immutable).
- **Persist** (`upsert.ts`): `persistPr()` upserts the whole PR subtree in one
  transaction. **Idempotency** is structural — every GitHub entity upserts on its
  **node ID** (the opaque GraphQL `id`), and timeline `events` upsert on a unique
  `dedupeKey` (e.g. `pr_opened:<prNodeId>`, `commit_pushed:<prNodeId>:<sha>`).
- **Status** is tracked in the `syncState` table (`lastFullSyncAt`,
  `lastIncrementalSyncAt`, `lastSyncStatus`, `lastSyncError`) plus an in-memory
  progress/running set surfaced to the UI while a sync is live.

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

### Data model (`src/db/schema.ts` is authoritative)

~15 tables. The core entities:

- **`repos`** — watched repos (`owner`+`name` unique, `githubNodeId`).
- **`users`** / **`localUser`** — GitHub users (`githubLogin` unique, `isBot`,
  `displayName`, `avatarUrl`) and the cached identity of the `gh`-authed user.
- **`pullRequests`** — PR metadata, state, draft, timestamps, CI/mergeable, etc.
- **`reviews`** — submitted reviews (`state`: approved / changes_requested /
  commented / dismissed / pending). A reviewer's *standing* decision is their
  latest non-`commented` review.
- **`reviewThreads`** + **`reviewComments`** — inline threads (carry stored
  `derivedState`) and their comments; **`prComments`** — issue-level PR comments.
- **`commits`** (`sha`+`prId`) + **`commitFiles`** (`sha` → changed paths, cached).
- **`events`** — the timeline feed; unique `dedupeKey`, typed (`pr_opened`,
  `pr_merged`, `pr_closed`, `review_submitted`, `review_comment`, `pr_comment`,
  `commit_pushed`). Only *substantive* reviews emit an event (an empty
  `commented` review is suppressed so it doesn't duplicate inline markers).
- **`reviewRequests`** — *ephemeral* pending review requests (a `userId` or a
  `teamName`, surfaced as `requestedReviewers` in PR detail); re-derived each sync
  (GitHub drops the request once a review lands).
- **`prViews`** — last-viewed SHA + timestamp per PR (drives "new since you looked").
- **`myTurnDismissals`** — dismissed "my turn" entries (`review_request` | `thread`);
  auto-resurface on newer activity.
- **`syncState`** — per-repo sync bookkeeping.
- **`claudeReviews`** + **`claudeReviewFindings`** — the **Claude Review** feature
  (see below). One run per row (re-review = new row; history kept, keyed by
  `(prId, headSha)`); Claude's `summary`/`verdict` are read-only, the user's
  `userBody`/`userVerdict` are what get posted. Findings carry `anchored`/`included`
  plus the agent's wording. **Not** part of the lean timeline; loaded on demand.

Conventions: timestamps are stored as unix-epoch integers (`mode: 'timestamp'`),
node IDs are the stable identity, and **triage fields are computed on read**
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
| `GET /api/me`, `GET /api/my-turn`, `POST /api/my-turn/dismiss` | local identity + triage queue + dismissals (`/me` also carries `claudeReviewEnabled`) |
| `GET /api/prs/:id/claude-review` | latest run + findings + history + Claude-auth status + `enabled` (Claude Review) |
| `POST /api/prs/:id/claude-review {model}` | start a run → `202 {reviewId}`; `400` no-auth/no-head, `409` busy, `404` disabled |
| `GET /api/prs/:id/claude-review/status`, `POST …/cancel` | poll live progress / abort the SDK run |
| `GET /api/claude-reviews/:reviewId` | a specific past run (history selector) |
| `PATCH /api/claude-reviews/:reviewId {userBody?,userVerdict?}` | save the user's authored draft (never Claude's text) |
| `PATCH /api/claude-findings/:findingId {included?}` | tick a finding for inline posting |
| `POST /api/claude-reviews/:reviewId/post {userVerdict}` (+ `?dryRun=true`) | post one GitHub review (inline comments + body + verdict); `409` if head moved |
| `GET /api/health` | health check |

All `claude-review` routes return `404` when the feature is off (`ENABLE_CLAUDE_REVIEW`).

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
  PR-detail header's **Focus** link (store `focusPrOnTimeline` → `timelineIsolate`),
  **double-clicking a PR bar** (`doubleClick` handler), **and** clicking a
  **cross-user marker** (actor ≠ PR author) — whether a standalone marker or one
  **picked from a cluster** (`onPick`) — all funnel through
  `enterPrFocus` to reach a byte-for-byte identical state: collapse to the rows of
  **every** contributor to the PR, show **only that PR** (sibling bars sharing its
  packed lane hidden via `isolatePrBars`; markers filtered to the PR in
  `rebuildMarkers`, since the shared `cross` band can't be trimmed per-PR). The
  Focus link **fits the window** to the PR's activity span; a cross-user click
  recenters on the clicked instant and anchors that event (popover open + the
  `ev-cross-linked` ring). It's **sticky**: clicks only explore and never leave
  focus, and the marker popover is **trimmed to the focused PR's events**
  (`MarkerPopover` `focusPrId`), so a cluster list shows only that PR's activity.
  Crucially, the **mouse/browser back button leaves focus** (it used to only step
  through popover drill levels): `enterPrFocus` pushes a dedicated `{pierreFocus}`
  history entry, and the `popstate` guard on `prFocusActiveRef` tears the whole focus
  down — restoring the rows, re-centring on the anchor (the clicked event, else the PR
  that triggered focus) and pulsing it — exactly like the bottom-right **Exit focus**
  button or **Esc**. All three exits run `exitFocusCore` (teardown + anchor restore);
  the button/Esc route through `exitFocus`, which also unwinds the focus-owned history
  entries (`(prFocusActive?1:0) + drillDepth`), whereas the back-button path unwinds
  only the remaining drill entries since the browser already consumed the focus entry.
  Toggling the repo filter or a fresh strip/search navigation also drops focus (both
  unwind the history entries first). (The marker popover no longer drives any row
  collapse — `MarkerPopover.focusGroupIds` is gone; it only reports an own-work single
  click so the PR band glows.)
- **Per-row collapse.** Each contributor row label carries a caret
  (`.tl-collapse-caret`, delegated from one capturing click listener on the
  container) that shrinks the row to just its name by hiding the row's subgroup
  bands via `subgroupVisibility` (`setRowCollapsed`). Distinct from focus-mode's
  whole-row `visible:false`: the thin labelled row stays. The collapsed set
  (`collapsedRowsByUserRef`) persists to `localStorage['pierre:collapsedRows']` and is
  re-asserted after each rebuild (new lanes) and after focus exit. vis applies
  `subgroupVisibility` only during a group **restack**, which a bare
  `groups.update`/`redraw` doesn't trigger — so `setRowCollapsed` forces it via
  `itemSet.markDirty({restackGroups:true})` + `redraw()` (otherwise a row with no
  cross-band `xsep` item to mutate wouldn't repaint). **Focus mode suspends per-row
  collapse**: entering focus force-shows the kept bands of any collapsed contributor
  row (`focusSubgroups` sets the keep bands visible), the caret is hidden
  (`.tl-focus-active .tl-collapse-caret`) and its click handler no-ops, and
  `applyCrossSeps` ignores `collapsedRowsByUserRef` while a focus overlay is up. The
  collapse is restored on exit (`applyContext` re-collapses), so the choice survives a
  focus round-trip.
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

- **Opt-in & off by default.** Gated behind `ENABLE_CLAUDE_REVIEW=true`
  (`config.claudeReviewEnabled`) — it spends real money / Agent-SDK credits per run.
  When off, the routes 404 and the frontend hides the tab (via `/api/me`'s
  `claudeReviewEnabled`).
- **No stored secrets.** Claude auth resolves from the ambient environment
  (`ANTHROPIC_API_KEY` → `CLAUDE_CODE_OAUTH_TOKEN` → a logged-in Claude session);
  `review/auth.ts` detects it best-effort (the first real SDK auth error is the
  authoritative gate). Mirrors `github/auth.ts`'s loud-but-friendly failure.
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
- **Schema changes are a two-step commit:** edit `apps/backend/src/db/schema.ts`,
  run `pnpm db:generate`, and commit the generated migration **with** the schema
  change.
- **Keep `/api/timeline` lean.** No comment bodies, no diff hunks — fetch detail
  on demand via `/api/prs/:id`. This endpoint is on the hot path.
- **Heuristics get fixture tests.** Before changing `derive-thread-state.ts`, add
  a sample to `apps/backend/src/sync/__fixtures__/threads/` (see the README there
  for the JSON shape and how to capture a real thread via `gh api`).
- **Idempotency is load-bearing.** New entities must upsert on their GitHub node
  ID; new event types must produce a deterministic, unique `dedupeKey`.
- **TypeScript is strict** (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`).
- The local DB (`apps/backend/data/`) and `.env` files are gitignored — no team
  activity data or tokens are ever committed.

---

## Verifying changes

For backend/heuristic logic, `pnpm test` + `pnpm typecheck`. For UI work, `pnpm
dev` is usually already running; the SQLite DB at `apps/backend/data/` holds real
synced data you can query (e.g. with `sqlite3`) to pick test cases, and you can
deep-link app state via URL params (`?pr=<id>`, `?repos=<ids>`, `?cats=…`) to reach
a specific view without clicking through.

---

## Packaging & publishing

The app ships to npm as a **single unscoped package, `pierre-review`**, runnable
with `npx pierre-review` (or, installed globally, the short `pierre` command — both
bins point at the same `dist/cli.js`). The published tarball contains **only built
artifacts** — no `.ts`, no `src/`, no configs, no tests.

**Single-process production mode.** In production the **one Fastify server serves
both** the JSON API (under `/api`) **and** the built SPA on one port. Static serving
is gated on the presence of a sibling `public/index.html` next to the compiled
server (`dist/../public`): present in the assembled release, **absent in the dev
tree**, so `pnpm dev` (Vite :5173 proxy → :4000) is unchanged. The SPA fallback is
folded into the **single** `setNotFoundHandler` in `api/plugins/error-handler.ts`
(Fastify allows only one per context): a non-`/api` GET returns `index.html`, while
unknown `/api` routes still return a JSON 404. The frontend already calls the API
with relative `/api` paths, so same-origin serving needs no frontend changes.

**The CLI (`apps/backend/src/cli.ts` → `dist/cli.js`).** Shebang'd bin entry. It:
parses `--no-open` / `--port <n>` / `--db <path>` (also `NO_OPEN` / `PORT` /
`DATABASE_URL` env) and maps them to env **before** importing config; sets
`NODE_ENV=production` (so pino-pretty, a devDep, is never loaded and static serving
turns on); defaults the DB to `~/.pierre-review/pierre-review.sqlite` (`mkdir -p`,
**never inside the read-only install dir**); **pre-checks `gh auth token`** with a
friendly message + non-zero exit before booting; prints the cursive Pierre ASCII
banner (`ascii.ts`) + tagline + a `▸ http://localhost:<port>` URL line (ANSI colour
only on a TTY); boots via the exported `start()` from `index.ts`; then opens the
default browser cross-platform (`open` / `start` / `xdg-open`, a built-in — **no
browser-open dependency**) unless `--no-open`. `index.ts` exports `start()` and
guards its auto-invoke with a run-as-main check, so `node dist/index.js` (the
backend `start` script) and the CLI both boot the server exactly once.

**The `@pierre-review/shared` runtime trap.** Shared is **types-only** and is NOT in
the published `dependencies`, so the backend must never `import` a runtime *value*
from it — only `import type` (erased by `verbatimModuleSyntax`). The two prior
offenders, `EVENT_TYPES`/`PR_STATUSES` in `api/routes/timeline.ts` and
`REASON_PRIORITY` in `db/queries.ts`, now use **local `const` copies** (kept in sync
with `packages/shared`). The release assembly greps `release/dist` for real
`@pierre-review/shared` import/require statements and **fails** if any reappear.

**`pnpm package`** (`scripts/build-release.mjs`, no extra deps) assembles a clean
`./release/`: builds frontend + backend, copies compiled backend JS (pruning
`.js.map` and `.test.js`), copies the drizzle `migrations/*.sql` **+ `meta/`
journal** into `dist/db/migrations/` (tsc doesn't emit `.sql`; the runtime resolves
them at `dist/db/migrations`), copies the built SPA into `public/`, generates
`release/package.json` (name `pierre-review`, version copied from
`apps/backend/package.json`, both bins, curated deps that **drop** shared and
**add** `@fastify/static`), and copies `scripts/release-README.md` → `README.md`.
Sanity asserts fail the build on a missing key file, any leaked `.ts`, or a shared
runtime import. **`better-sqlite3` stays a runtime dependency** (native addon,
rebuilt per-machine at install) — never bundled. `release/` is gitignored.

**Publishing is now automated by CI** (`.github/workflows/release.yml`, documented
in `docs/RELEASE.md`): every push/merge to `main` bumps the patch version in
`apps/backend/package.json` (the canonical published version), runs `pnpm package`,
pushes the `chore(release): bump to X.Y.Z [skip ci]` commit + `vX.Y.Z` tag, then
`npm publish`es `./release`. A manual `workflow_dispatch` allows `minor`/`major`
bumps. A job-level `if:` (skip when the head commit starts with `chore(release):`)
plus the `[skip ci]` suffix guard against an infinite release loop. The order is
deliberately **bump → build → push → publish** so a failed publish only leaves an
npm version gap (self-healing) rather than poisoning the next merge. CI needs an
`NPM_TOKEN` secret (npm Automation/granular token) and `contents: write`; see
`docs/RELEASE.md` for token minting, branch-protection options, and the one-time
manual first publish that claims the unscoped name. **Still never run
`npm publish` / `npm login` from here** — let CI (or the user) do it.

---

## History & planning

`V1_PLAN.md` has the full plan and the Phase 1–6 breakdown; commit messages use
phase notation (e.g. `feat(p3): add timeline endpoint`). Migration files
(`0000`–`…`) track the schema's evolution (v1.1 added CI/labels, later ones added
my-turn dismissals and review `databaseId` deep-link fields).
