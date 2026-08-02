# Sync pipeline

How pierre-review pulls PR activity from GitHub into the database. The **same code
runs in both deployment modes** — the only differences are the token source (`gh`
CLI locally, decrypted OAuth in cloud) and the DB dialect (SQLite vs Postgres). The
read API and frontend never call GitHub directly; they read what sync has written
(the one exception is on-demand text **hydration**, see [Lean storage](#lean-storage-interaction)).

**Code:** `apps/backend/src/sync/` — `scheduler.ts`, `sync-manager.ts`,
`sync-repo.ts`, `upsert.ts`, `commit-files.ts`, `derive-thread-state.ts` — plus
`github/queries.ts` (the GraphQL query) and `auth/account.ts#getAccessToken` (the
per-account token).

```
trigger (cron | repo-add | manual)
        │
        ▼
 sync-manager  ── plan: full backfill vs incremental ──► resolve account token
        │
        ▼
  sync-repo   ── walk PR pages (GraphQL, newest-first) ──┐
        │                                                │ per page:
        │   ◄── ensureCommitFiles (REST, cached) ────────┤  gather commit SHAs
        │                                                │  fetch changed files
        ▼                                                │
   persistPr  ── derive thread state + idempotent upsert ┘  persist each PR
        │
        ▼
   DB (events/PRs/threads/…)   +   syncState (timestamps, status)
```

Sync is **fully idempotent** — every entity upserts on its GitHub node id — so
overlapping runs and re-walks never create duplicates.

---

## Triggers — what starts a sync

| Trigger | Entry point | Notes |
|---|---|---|
| **Scheduled** | `scheduler.ts` → `syncAllRepos()` | `node-cron` at `config.syncCron` (default `*/5 * * * *`). Disabled by `DISABLE_SCHEDULER=true`. |
| **Repo added** | `POST /api/repos` → `runSyncForRepo(…, {background:true})` | The repo has no `syncState` yet → a first **full backfill**. |
| **Manual / deep sync** | `POST /api/repos/:id/sync?full=true` → `runSyncForRepo` | `?full=true` forces a full re-sync (`forceFull`). |

`runSyncForRepo` reserves an in-memory slot **synchronously** before any `await`, so
a cron tick firing mid-call sees the repo as already in-flight and stands down (one
sync per repo at a time).

---

## Initial load (the first sync of a repo)

A repo with **no `lastIncrementalSyncAt`** is planned as `mode: 'full'`, with
`since = now − BACKFILL_DAYS` (default **90** days).

### Two-phase backfill

A full 90-day backfill of an active repo takes a while, and the board would sit
blank until it finished. So the **first full sync runs in two phases** whenever
`BACKFILL_DAYS > FOREGROUND_SYNC_DAYS` (it doesn't for a forced "deep" re-sync —
that board is already populated, so it stays single-pass):

1. **Phase 1 — foreground.** `since = now − FOREGROUND_SYNC_DAYS` (default **14**
   days). Persists per-PR so the recent board fills **in seconds**. It passes
   `commitState: false`, so it deliberately does **not** stamp `syncState` — the
   repo stays "never fully synced" until phase 2 finishes. Progress reports
   `foregroundComplete: false`.
2. **Phase 2 — deep.** Continues the **same cursor walk** (`startCursor` = phase 1's
   `endCursor`, so it doesn't re-walk the foreground pages) back to
   `now − BACKFILL_DAYS`, with `commitState: true` (now stamps `syncState`).

The UI drops you into the recent view the moment phase 1 completes; phase 2 fills in
history in the background. A cancel during either phase leaves the repo
"never synced" (see [Cancel](#cancel)).

---

## Incremental updates (every subsequent sync)

A repo **with** a `lastIncrementalSyncAt` is planned as `mode: 'incremental'`, with
`since = lastIncrementalSyncAt − SYNC_OVERLAP_MINUTES` (default **20**). The overlap
re-fetches a small trailing window so events that landed *during* the previous sync
aren't missed; idempotent upserts make the re-fetch duplicate-free.

> **Why re-walk instead of short-circuiting on `updatedAt`?** GitHub does **not**
> bump a PR's `updatedAt` for every signal we care about (e.g. a CI run finishing,
> a review thread being resolved). A naive "skip PRs not updated since last sync"
> would freeze those signals, so sync deliberately re-walks the whole `since` window
> each run and lets the idempotent upserts reconcile.

---

## The fetch loop (`sync-repo.ts`)

`syncRepo()` builds a per-account GraphQL client and walks pages of
`REPO_ACTIVITY_QUERY`:

- **Paging:** 25 PRs per page, `orderBy: { field: UPDATED_AT, direction: DESC }`,
  `after: cursor`. Because PRs arrive **newest-first**, the walk **stops** as soon as
  a PR's `updatedAt < since`.
- **Per in-window PR:** gather the commit SHAs that could plausibly have addressed an
  **unresolved** review thread (commits landed *after* that thread's last comment) —
  these are the only SHAs whose changed files the thread-state heuristic needs.
- **Per page:** fetch that page's changed-file paths in **one saturated pool**
  (`ensureCommitFiles`), then `persistPr` each in-window PR.
- **Progress** is *time-walked*: the span `[since … newest]` is the work, and the
  current PR's `updatedAt` marks how far through it we are. Reported via `onProgress`
  (`percent`, `prsProcessed`, `pages`).
- **Resume cursor:** if the walk stopped at the `since` cutoff mid-page, a follow-on
  phase resumes from **that page's start cursor** (not its `endCursor`) so the cutoff
  page's older PRs aren't skipped.
- **Per-stage timing** (GraphQL fetch / commit-file REST / DB persist) is accumulated
  and logged, so it's clear which stage dominates a slow sync.
- On a fetch error the repo's `syncState` is stamped `lastSyncStatus: 'error'` +
  `lastSyncError`, and the error re-throws.

---

## Changed files (`commit-files.ts`)

`ensureCommitFiles(owner, name, shas, token)` resolves each SHA → its changed file
paths:

- Backed by the **permanent `commitFiles` cache** — SHAs are immutable, so the cache
  never expires and re-syncs are free. The table is **global** (content-addressed,
  shared across tenants).
- Cache misses are fetched via REST (`GET /repos/:owner/:name/commits/:sha`) through a
  **fixed worker pool** (`COMMIT_FILE_CONCURRENCY`, default **10**) that keeps that
  many requests in flight at once. These REST calls typically dominate sync latency.
- A 403/404 on a single commit is swallowed as "no known files" (the thread-state
  heuristic falls back to other signals) rather than aborting the whole sync.

---

## Persist + idempotency (`upsert.ts`)

`persistPr()` upserts the whole PR subtree (PR, reviews, threads + comments, PR
comments, commits, review requests, and timeline events) in **one transaction**
(`runTransaction`, dialect-aware). Idempotency is **structural**:

- Every GitHub entity upserts on its **node id**; timeline `events` upsert on a
  deterministic **`dedupeKey`** (e.g. `pr_opened:<prNodeId>`).
- Under multi-tenancy the conflict targets are **composite** —
  `(accountId, githubNodeId)`, `(accountId, dedupeKey)`, child tables
  `(prId, githubNodeId)` — so two accounts can track the same repo without colliding.
- **Derived thread state** is computed here (`deriveThreadState`, using the commit
  SHAs + changed files gathered above) and stored on `reviewThreads.derivedState`.
- `upsertRepo()` (the repo row itself, not the PR subtree) is likewise a
  `runTransaction`: it writes the repo **and** its `workspace_repos` membership row,
  targeting the account's **Default** workspace, `ON CONFLICT (account_id, repo_id) DO
  NOTHING`. ⚠ The `DO NOTHING` is load-bearing — a re-sync of an existing repo must
  never move it out of the workspace a human put it in. Membership is all it writes: there
  is no second visibility axis to set (`repos.inbox_watch` and the whole "watched" concept
  were dropped in migration `0046` / pg `0033` — every repo in a workspace is fully live).
  A repo with no membership row would be invisible to every workspace-scoped read, which is
  why the read path also repairs the diff (`ensureRepoMemberships`).
- Only **substantive** reviews emit a `review_submitted` event (an empty "commented"
  review is GitHub's wrapper around inline comments and would duplicate them).
- `reviewRequests` are *reconciled* (delete + reinsert per PR) since GitHub drops a
  request once the reviewer responds.

---

## Status & in-memory state (`sync-manager.ts`)

**Persistent** — the `syncState` table, one row per repo:
`lastFullSyncAt`, `lastIncrementalSyncAt`, `lastSyncStatus`, `lastSyncError`. This is
what `planSync` reads to decide full vs incremental.

**In-memory** (process-local, **not** persisted — resets on restart):

- `running` — repos mid-sync; a second trigger for the same repo stands down.
- `deepSyncing` — repos in a forced-full ("deep") run; while any is in flight the
  scheduled incremental loop **stands down entirely**, so a cron tick doesn't reset a
  deep sync's progress bar to 0% the moment one repo finishes.
- `cancelRequested` — user cancel flags (see below).
- `progressByRepo` — live `SyncProgress` surfaced to the UI via
  `GET /api/repos/:id/sync-status`.

---

## Cancel

`requestSyncCancel(repoId)` sets a flag; the fetch loop polls `shouldCancel()`
**between pages and PRs** and bails out **without** writing a `syncState` timestamp.
So a cancelled **initial backfill** stays "never synced", and the cancel endpoint can
safely delete the repo plus its partial rows (idempotent, harmless — or simply
resumed on the next sync for an existing repo).

---

## Tokens, rate limits, isolation

- The token is resolved **per repo** via `getAccessToken(accountId)` (`gh auth token`
  locally; decrypted OAuth token in cloud) and threaded into the fetch — **never**
  module-cached (a cached token would leak across accounts in cloud).
- Every persisted row is stamped with the owning **`accountId`**; sync is per-account.
- `syncAllRepos` wraps each repo in its own `try/catch`, so one bad token or
  inaccessible repo doesn't abort the loop.
- **Rate limiting:** each page reports `rateLimit.cost` / `remaining` (logged). There
  is no active throttle/backoff today — a single server process serializes syncs and
  the `running` set prevents double-syncing a repo, which keeps usage well within
  GitHub's limits in practice.

---

## Lean storage interaction

By default (`config.persistBodies` is `false`; see **Lean storage** in `CLAUDE.md`)
sync stays lean:

- `REPO_ACTIVITY_QUERY` is **trimmed** to stop fetching the bulky text it no longer
  stores — PR body, PR-comment body, commit message, and review-comment **diff
  hunks** — which shrinks every backfill page. (It keeps **review** bodies, needed to
  detect substantive reviews, and **review-comment** bodies, needed for the stored
  excerpt.)
- `persistPr` writes `null` for the dropped columns and stores a short
  `reviewComments.excerpt` (≤160 chars) for the triage path.

That dropped text is **not** part of sync. It's hydrated **on demand** when a user
opens a PR/thread — `sync/hydrate-detail.ts` fetches the single PR via
`PR_DETAIL_QUERY` and the browser caches it (so an unchanged PR never re-downloads).
Set `PERSIST_BODIES=true` to store everything during sync instead (larger DB, fully
offline detail).

---

## Config knobs

All via env (see `config.ts`); defaults in parentheses.

| Var | Default | Effect |
|---|---|---|
| `BACKFILL_DAYS` | `90` | How far back the first full sync reaches. |
| `FOREGROUND_SYNC_DAYS` | `14` | Two-phase phase-1 window (must be `< BACKFILL_DAYS` to two-phase). |
| `SYNC_OVERLAP_MINUTES` | `20` | Trailing re-fetch window on incremental syncs. |
| `SYNC_CRON` | `*/1` (`*/5` if adaptive is off) | Scheduler **tick**. Under adaptive polling this is not the per-repo cadence — it's how often the due-check runs; the bucket intervals decide what actually syncs. Setting it explicitly overrides the adaptive default, which keeps the old cadence. |
| `SYNC_ADAPTIVE` | `true` (both modes) | Adaptive cadence + conditional probe ([REALTIME-SYNC.md](REALTIME-SYNC.md) Phase 2) — the primary strategy everywhere, since webhooks only cover repos the App is installed on. `false` restores the fixed-clock re-walk. |
| `SYNC_HOT/WARM/COLD_INTERVAL_SEC` | `120` / `300` / `900` | Min seconds between attempts per activity bucket (adaptive only). |
| `SYNC_FLOOR_INTERVAL_SEC` | `1800` | Force a full re-walk this often even when the probe says unchanged — catches CI-finish / thread-resolve, which never bump `updatedAt`. |
| `COMMIT_FILE_CONCURRENCY` | `10` | Concurrent commit-file REST fetches per page. |
| `DISABLE_SCHEDULER` | `false` | Turn the cron loop off (scripts/tests). |
| `PERSIST_BODIES` | `false` | Store bulky text during sync instead of hydrating on demand. |

> `STALL_THRESHOLD_DAYS` (default `3`) also exists but is a **read-side** triage knob
> (`isStalled`), not part of sync.
