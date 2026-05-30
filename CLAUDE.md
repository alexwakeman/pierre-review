# gh-team-monitor

A **local-only, single-page dashboard for tracking a team's GitHub activity across
multiple repositories**. It's built for sprint situational-awareness: at a glance,
who's doing what, which PRs are stalled, which review threads are sitting
untouched, and what needs _your_ attention right now.

It runs entirely on your machine — there's no hosted backend, no database server,
and no stored credentials. It authenticates by shelling out to your already
logged-in `gh` CLI, syncs activity from the GitHub GraphQL/REST APIs into a local
SQLite file, and renders it as an interactive timeline.

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
gh-team-monitor/
├─ apps/
│  ├─ backend/                 @gh-team-monitor/backend
│  │  ├─ src/
│  │  │  ├─ index.ts           entrypoint: migrate → cache user → buildApp → schedule → listen
│  │  │  ├─ app.ts             Fastify factory: logger, CORS, error handler, route registration
│  │  │  ├─ config.ts          env-driven config (port, dbPath, cron, backfill, thresholds)
│  │  │  ├─ db/
│  │  │  │  ├─ schema.ts        ← Drizzle table definitions (source of truth for the data model)
│  │  │  │  ├─ client.ts        better-sqlite3 + drizzle, sets WAL + foreign_keys pragmas
│  │  │  │  ├─ queries.ts       read layer: buildTimelinePrs(), getPrDetail(), getMyTurn()
│  │  │  │  ├─ triage.ts        computeTriage(): reasonTag, "my turn", new-since-viewed, approvals
│  │  │  │  └─ migrations/      drizzle-kit SQL migrations (commit alongside schema changes)
│  │  │  ├─ github/             auth.ts (gh token), client.ts (graphql/REST), queries.ts (the big query)
│  │  │  ├─ sync/               scheduler, sync-manager, sync-repo, upsert, derive-thread-state, commit-files
│  │  │  │  └─ __fixtures__/threads/   JSON fixtures for the thread-state heuristic tests
│  │  │  └─ api/
│  │  │     ├─ routes/          one file per resource (timeline, prs, open-prs, repos, users, me, threads, health)
│  │  │     └─ plugins/         error-handler, etc.
│  │  └─ data/gh-team-monitor.sqlite   the local DB (gitignored)
│  └─ frontend/                @gh-team-monitor/frontend
│     └─ src/
│        ├─ App.tsx            layout: FilterBar / OpenPrsStrip / Timeline / DetailPane
│        ├─ store/filters.ts   Zustand store: all filter + selection + timeline-hint state
│        ├─ hooks/             useUrlState, useTimeline, usePr, useTriage, useKeyboard, useLocalStorage
│        ├─ api/client.ts      typed fetch wrapper for every endpoint (throws ApiError)
│        ├─ components/        Timeline/, PrDetail, ChecksTab, ThreadList/, ThreadView/, MyTurnPanel/, OpenPrsStrip/, …
│        └─ lib/ui.ts          shared UI metadata (state colors, labels, shapes) + helpers
└─ packages/
   └─ shared/                 @gh-team-monitor/shared — types ONLY, the contract between the two apps
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

Conventions: timestamps are stored as unix-epoch integers (`mode: 'timestamp'`),
node IDs are the stable identity, and **triage fields are computed on read**
(`triage.ts`) — `reasonTag`, `reviewRequestedFromMe`, `newSinceLastViewed`,
approvals, and `isStalled` (`lastCommitAt` vs `stallThresholdDays`) are *not* stored.

### HTTP API (`src/api/routes/`)

Wire format is JSON with ISO-8601 timestamps; payload types live in
`packages/shared`. Each route file maps to a `client.ts` method.

| Method & path | Purpose |
|---|---|
| `GET /api/timeline?from&to&repoIds&userIds&types&excludeBots` | **lean** feed: `{ prs[], events[] }`, no bodies/diffs. Defaults: last 14d, `excludeBots=true` |
| `GET /api/prs/:id` | full PR detail (threads, reviews, comments, commits, checks, labels) |
| `POST /api/prs/:id/mark-viewed` (alias `/dismiss`) | record a view (`sha?` defaults to head) → clears new-since badges |
| `GET /api/open-prs?repoIds&userIds` | currently-open PRs (ignores date range) |
| `GET /api/threads/:id` | single thread detail |
| `GET /api/repos`, `POST /api/repos`, `DELETE /api/repos/:id` | manage watched repos (delete → 409 if syncing, else 204) |
| `POST /api/repos/:id/sync?full=true` | trigger sync → `202 {status:'started'}`, or `409` if already running |
| `GET /api/users` (+ isBot updates) | user list / bot flagging |
| `GET /api/me`, `GET /api/my-turn`, `POST /api/my-turn/dismiss` | local identity + triage queue + dismissals |
| `GET /api/health` | health check |

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
   derived-state filters, the selected PR/thread, and transient timeline hints
   (`timelineFocusPr`, `timelineFocusAt`, `timelineFocusEvent`).
3. **URL** → `hooks/useUrlState.ts` mirrors the store to the query string both
   ways, so views are shareable/reloadable. The serializer diffs against the
   **defaults**, so the common case stays a clean URL.

### UI regions (`App.tsx`)

- **FilterBar** — add/remove repos, members (auto-scoped to who's active in the
  window, with an exclude-bots toggle), range presets (7/14/30/90d/custom), event
  categories, and derived-state tags.
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
- **Focus mode** — clicking a *cross-user* marker (one person acting on another's
  PR) opens a popover and collapses every row except the two involved
  contributors, with the linked PR bar and clicked marker glowing. The bottom-left
  **Exit focus** button (or browser-back) restores all rows, re-centers on the
  marker that opened the focus, and gives it a brief fade glow. Toggling the repo
  filter also drops focus.
- **Commits are hidden by default** (`DEFAULT_CATEGORIES` excludes `commits`);
  enabling them round-trips through the URL.
- **Contributor names are GitHub profile links** (the `UserName` component / the
  timeline row labels), using the login even when a display name is shown.
- **Zebra striping** on contributor rows (alternating subtle band) via `nth-child`
  in `index.css`, applied to both the label and foreground panels.
- The timeline endpoint stays lean — the selected PR is never filtered out (it's
  force-shown if a filter would hide it), and detail loads only on selection.

### PR detail (`PrDetail.tsx`)

Two tabs:
- **Overview** — PR metadata + CI/checks + **Approvers** (each reviewer whose
  latest decisive review is `approved`) + requested reviewers + labels
  (`ChecksTab.tsx`), followed by the review **Threads** (`ThreadList`/`ThreadView`,
  grouped by file, with code anchors and new-comment highlights).
- **Activity** — a chronological feed of opens / commits / reviews / comments /
  merge-close, each with a "Show on timeline" action.

> Note: Overview is the *merged* former "Checks" + "Threads" tabs. There is no
> longer a standalone Checks or Threads tab.

Keyboard: `/` focuses the filter, `j`/`k` cycle PRs, `esc` clears selection
(`hooks/useKeyboard.ts`).

---

## Conventions & gotchas

- **ESM module resolution differs per package.** Backend is **NodeNext** —
  relative imports need explicit `.js` extensions (`./foo.js`). Frontend is
  **Bundler** — no extensions. Don't mix them up; the compiler will complain but
  it's the #1 source of confusion.
- **The `shared` package is the only bridge.** Never import backend code from the
  frontend or vice versa — go through `@gh-team-monitor/shared` (types only; it
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

## History & planning

`V1_PLAN.md` has the full plan and the Phase 1–6 breakdown; commit messages use
phase notation (e.g. `feat(p3): add timeline endpoint`). Migration files
(`0000`–`…`) track the schema's evolution (v1.1 added CI/labels, later ones added
my-turn dismissals and review `databaseId` deep-link fields).
