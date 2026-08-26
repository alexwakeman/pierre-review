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

### CI-history backfill (after the full walk)

A newly added repo would otherwise start with **blank CI charts**: the trunk DayStrip
only spans the newest 100 trunk commits, and `ci_status_events` — the transition log
behind "CI recovery" and "CI failures by stage" — records only changes a sync
*witnesses*, so a first walk writes at most one row per PR. GitHub, however, retains
per-commit check state indefinitely, so after every **completed full walk** (a repo's
first sync or a forced deep re-sync — never incremental, never after a cancel)
`runSyncForRepo`'s completion hook runs `runCiHistoryBackfill`
(`sync/backfill-ci-history.ts`), gated by `config.ciHistoryBackfill` and loaded via
dynamic import. It has two independently non-fatal halves:

1. **Trunk history** (`backfillBranchHistory` in `sync/branch-status.ts`): paginated
   `history(since: now − 90d)` on the default branch, ≤10 pages × 100 commits at ~4
   points each, upserting the same rows as the live snapshot (minus failing-check
   detail — the trend cells need only `ciStatus`). Survives the next tick because the
   trim is hybrid: newest-100 unconditionally + anything inside the 90-day trend
   window ([MERGE-CI-TRUNK.md](MERGE-CI-TRUNK.md)).
2. **PR CI events** (`backfillPrCiHistory`): the walk already stored every PR's commit
   shas + committer dates, so this fetches their retained `statusCheckRollup`s in
   ~1-point batches of 100 (`buildCommitStatesQuery`, ≤2000 shas newest-PR-first),
   failing-check **names** for the newest ≤200 red commits (reusing
   `buildCommitChecksQuery`, ~1 point per commit), and synthesizes the transition rows
   the sync would have written — `observedAt` = committer date. **The safety rule**: a
   PR is touched only when its stored events are provably the initial walk's snapshot
   (zero rows, or ONE row whose `headSha` is the newest stored commit — that row is
   replaced in the same transaction); any PR with real observed history is left alone,
   which is what makes the pass safe on a deep re-sync of a long-tracked repo. An
   all-green PR writes nothing. Honest limits: a same-sha red→green (re-run flake fix)
   is invisible — only the final rollup survives — and a red commit past the names cap
   still opens a recovery streak but contributes nothing to the by-stage chart. Every
   truncation (sha budget, page cap) is disclosed in the summary log line.

The backfill runs while the repo still holds its `running` slot (no snapshot can race
it) and respects cancellation between GraphQL batches — a cancelled PR-events pass
writes nothing, since a partial log would be indistinguishable from a complete one.

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
- `queuedRepos` + `apiSyncChain` — the per-account **serial queue** for API-triggered
  walks (`enqueueSyncForRepo`; see *Tokens, rate limits, isolation* below). A queued repo
  reads as `running` with `progress.paused = { reason: 'queued' }`; a cancel while queued
  drops it synchronously (never started, `waitForSyncToStop` sees not-running).
- `progressByRepo` — live `SyncProgress` surfaced to the UI via
  `GET /api/repos/:id/sync-status`.
- (in `github/rate-budget.ts`) the per-account **rate budget** — `remaining`/`resetAt`
  from the last walk page + any observed hard-limit window.

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
- **Rate limiting is handled actively, per account** — a rate limit is a *pause*, never
  a red error; `lastSyncStatus: 'error'` is reserved for genuinely unrecoverable
  failures. Four pieces:
  - **The budget** (`github/rate-budget.ts`, in-memory per accountId): every walk page
    feeds `noteBudget` from the `rateLimit { remaining resetAt }` block it already
    selects; `noteLimited` records an observed hard limit. `gateBudget` — called at the
    top of the PR-walk page loop, the CI-history backfill's chunk loops and the
    trunk-history pagination — sleeps until the reset (cancellable, ≤1s slices checking
    `shouldCancel`) whenever `remaining` is under a ~100-point floor or a limited window
    is active, instead of spending pages into the hard 403.
  - **The classifier** (`isRateLimitError` in `github/client.ts`, deliberately SEPARATE
    from `isRetryableGithubError` — do not widen the retry predicate): GraphQL
    `errors[].type === 'RATE_LIMITED'`, REST 429, or a 403 with rate-limit/abuse
    wording; reads `Retry-After` / `x-ratelimit-reset` (which `ghRest` attaches to its
    thrown errors) for the resume time. A classified page failure notes the limit,
    waits via the same gate, then **retries the same page** (cursor unchanged), up to 5
    waits per page before falling through to the real error path. Commit-file fetches
    stop fanning out on a limited error; adaptive probes and the PR-detail refresh skip
    cheaply while `isLimited`.
  - **The paused contract**: while waiting, `SyncProgress.paused =
    { reason: 'rate_limit', resumeAt }` rides the normal progress plumbing — status
    stays `running`, and the flag clears the moment the walk moves again.
  - **The per-account queue** (`enqueueSyncForRepo` in `sync-manager.ts`): API-triggered
    walks (repo add, manual/deep sync) run one at a time per account; waiters show
    `paused: { reason: 'queued' }`. This replaced the process-wide
    `MAX_CONCURRENT_SYNCS` cap and its 429 on `POST /api/repos/:id/sync` (the per-repo
    cooldown 429s remain). The scheduler's own sequential loop is exempt.

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
| `CI_HISTORY_BACKFILL` | `true` | The one-time post-full-sync CI-history backfill (trunk trend window + synthesized PR CI events). `false` disables both halves. |
| `DISABLE_SCHEDULER` | `false` | Turn the cron loop off (scripts/tests). |
| `PERSIST_BODIES` | `false` | Store bulky text during sync instead of hydrating on demand. |

> `STALL_THRESHOLD_DAYS` (default `3`) also exists but is a **read-side** triage knob
> (`isStalled`), not part of sync.


---

## Not part of this pipeline: ML enrichment

`sync/ml-enrichment.ts` lives in this directory but is **not a sync stage**. It has its own cron,
takes no hook from `syncRepo` / `syncOnePr` / `persistPr`, and pulls its worklist from the
database instead ("bot-authored text with no label yet"). That is deliberate — the classifier's
cost tracks total text and `persistPr` runs entirely inside `runTransaction`, which on SQLite is
a manual `BEGIN`/`COMMIT` on the one shared connection. See [ML-SEVERITY.md](ML-SEVERITY.md).

---

## Not part of this pipeline either: `@mention` derivation

`sync/mention-scan.ts` is the second pull-based worker in this directory (CORE, free, no LLM, **no
GitHub quota** — comment and review bodies are always persisted, so nothing is fetched). It fills
`pr_mentions`, the MENTION arm of My Turn's personal-relevance flag; the table's contract is in
[DATA-MODEL.md](DATA-MODEL.md).

**Why a worker and not a read.** The obvious implementation is a text predicate inside
`getMyTurn` — and it is the wrong shape by an order of magnitude. `getMyTurn` runs inside
`getWorkspaceInsights`, which runs on **every Feed landing**, and the predicate is a substring
scan over every comment and review body in scope (65k rows / ~0.19s on this repo's own dev
account). Paying that per request to answer a question whose answer changes a few times a week is
a misplaced fold. The scan runs on a `*/5` cron (`MENTION_SCAN_CRON`, a module constant — there is
no per-deployment decision to make), rotates accounts like the ML worker, and is wall-clock
bounded at 60s per tick; the request path then does one indexed existence lookup.

**Why a FULL re-derive per tick, and not a cursor.** A watermark over the three comment tables has
to be right about four different ways the corpus changes, and every wrong answer is silent:

| Change | What a cursor gets wrong |
|---|---|
| a 90-day **backfill** | inserts rows whose `created_at` predates any time-based watermark |
| a body **edit** | changes neither the row's id nor its `created_at` |
| a **deleted** comment | must REMOVE a mention; an insert-only writer never can |
| Postgres **sequence gaps** | ids commit out of order, so an id watermark can skip a row forever |

Re-deriving the whole set and diffing it against what is stored is correct under all four with no
state to keep, and it is affordable because the expensive half is bounded by the MATCHES, not the
corpus. ⚠ **The delete half is load-bearing**: without it `personal` becomes a ratchet that only
ever widens.

**Invalidation — how staleness is bounded, in each direction:**

- a **new mention** becomes personal within one tick;
- a **removed** mention stops being personal within one tick;
- a **renamed account** narrows **immediately**, before any tick, because the read
  (`viewerMentionedPrIds`) is login-scoped against `pr_mentions.login`; it re-widens only once the
  scan has actually re-derived under the new login;
- ⚠ an account whose `github_login` has not resolved yet (local mode before `gh api user`
  answers) is **skipped**, never scanned as the empty string — deriving an empty set would delete
  every stored row, i.e. a transient `gh` outage would un-personalise the whole inbox.

Absence never widens: with no rows at all the flag degrades exactly to the phase-1 maintainer
test, which is why the feature needs no enable flag.
