# Backend runtime: startup, auth & the sync pipeline

> Split out of CLAUDE.md (2026-08) to keep the root memory file lean. This is the
> authoritative deep-dive for this area; CLAUDE.md keeps only the summary and the
> cross-cutting landmines. Add new detail HERE, not to CLAUDE.md. References to other
> sections of the old CLAUDE.md resolve via the doc map at the top of CLAUDE.md.

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
  `repos`, the last 100 trunk commits (90-day horizon) into `branchCommits`. **STRICTLY NON-FATAL** — it is an
  informational readout, so a token that can walk the PRs but chokes on the branch history must
  never cost the caller the PR sync that just succeeded. **TWO-PHASE, and the split is a cost
  decision**: GitHub prices a GraphQL call from requested nodes, so phase 1
  (`history(first:100)` × `associatedPullRequests(first:3)` = 400 nodes) is **4 points** (the
  widening from 20 commits — 80 nodes, 1 point — is an accepted cost; it feeds the
  branch-trends charts), while nesting `statusCheckRollup.contexts(first:100)` under that
  history would be ~10100 nodes ⇒
  **~102 points on every walk of every repo, green or red**, on a call adaptive polling re-fires
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


