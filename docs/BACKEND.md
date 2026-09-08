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

---

## ⚠ A local write stamp can DELETE the event it exists to record (`markPrReopenedLocally`)

**The rule.** A GitHub-write route stamps its row locally so the SPA's re-read from the local DB
reflects the write immediately (CLAUDE.md § Conventions). But `sync/upsert.ts`'s
`lifecycleTransitions` decides what to emit by comparing the **PRE-UPSERT** row against GitHub — so
a stamp that writes the POST state can erase the transition the next walk would have narrated.
Before stamping a state, check whether any event is derived from the state you are overwriting.

**Where it bites.** `pr_reopened` is emitted only when the pre-upsert row reads `closed`. The moment
`POST /api/prs/:id/reopen` stamps `state: 'open'`, every subsequent sync sees `prev.state === 'open'`
and the branch never runs again — **permanently**. A reopen done through Pierre would be missing
from the timeline and the feed forever, while the same reopen done on github.com still appears. So
`markPrReopenedLocally` writes the `events` row **itself**, inside `runTransaction`, with the SAME
`pr_reopened:<prNodeId>` dedupe key and `(accountId, dedupeKey)` conflict target the sync would have
used — the two writers stay idempotent against each other if a walk ever does reach the branch.

⚠ **The asymmetry is why this is easy to miss.** The CLOSE direction has no such problem: `pr_closed`
comes off the state branch (`pr.state === 'CLOSED' && closedAt`), not off `prev`, so
`markPrClosedLocally` is a one-line `.set()` and costs nothing. Writing the reopen stamp as its
one-line inverse type-checks, passes every existing test, and silently deletes the event.

Two more things the reopen stamp does that its mirror does not:

- ⚠ **It NULLs `closedAt`.** `db/automation-output.ts` computes `prs_closed_unmerged` as
  `mergedAt IS NULL` inside a `closedAt` WINDOW and never consults `state`, so a reopened PR that
  keeps its old close stamp is reported as abandoned churn until a full walk rewrites the column.
  `db/pr-liveness.ts` will not fix it either — that sweep only ever WRITES `closedAt`, never nulls it.
- ⚠ **It sets `mergeStateStatus: 'unknown'`, never a guess.** GitHub recomputes mergeability
  asynchronously after a reopen and the stored value predates the close; anything else lets
  `mergeVerdict()`, the Merge button, the Pending card and `db/triage.ts`'s `READY_MERGE_STATES`
  assert a landing verdict from a stale computation. Same write, same reason, as the close stamp.

The update is account-scoped in its OWN predicate (`eq(pullRequests.accountId, accountId)`) rather
than inheriting the route's check, and the events insert derives `repoId`/`nodeId` from that scoped
UPDATE's `.returning()`, so it cannot reach another tenant's repo. Route contract, permission rule
and failure codes: [API.md](API.md).

---

## ⚠ `req.raw.on('close')` is NOT a client-disconnect signal on a POST — watch the REPLY socket

**The rule.** On a POST, a client-disconnect abort must be wired to **`reply.raw`** (or the
hijacked `raw` after `reply.hijack()`), never to `req.raw`. Every billed-loop route in this
codebase has the same shape — a long run whose `shouldStop`/`aborted` flag exists so a client
that goes away stops costing money — and getting this wrong turns the whole route into a silent
no-op.

**Why.** A request's `'close'` event fires when the **REQUEST** is complete. For a POST that
means *the moment Fastify finishes reading the JSON body* — before the handler has done anything
at all, and while the client is still sitting there waiting for the response. So:

```ts
// ❌ permanently true before the first iteration
let aborted = false;
req.raw.on('close', () => { aborted = true; });
await runAnnotations(…, { shouldStop: () => aborted });
```

The run breaks out of its very first iteration and every `send()` is suppressed.

**The failure mode is SILENT, not loud.** Nothing throws, nothing logs, no status code changes:

- the annotations run routes returned **`generated: 0` inside a normal `200`** — indistinguishable
  from "everything was already cached";
- the digest **Regenerate** SSE twin returned a 200 with an **empty body** and no progress at
  all, even though the digests really were being generated behind it.

A route that looks like a no-op with no error anywhere is exactly what this produces.

### The verification

Measured with a standalone Fastify probe (2026-07-30), both directions, on the same server:

```
POST:  reqClosed = true    replyClosed = false     <- client still waiting
GET :  reqClosed = false   replyClosed = false
```

`reply.raw`'s `'close'` is the signal that was actually wanted: it stays false while the client
is waiting for the response and fires when the client goes away. That is why the fix is a
one-line swap rather than a redesign.

### What was fixed, and what must NOT be "fixed"

Fixed at four sites: the plugin's annotations run routes (**JSON and SSE**), the
digest-regenerate SSE, and the per-item resolution-check route.

⚠ **The `…/stream` endpoints that are GETs are unaffected and must not be changed.** Claude
Review and AI Fix stream over a **GET with no body**, correctly using the hijacked `raw`; a
GET's `req.raw` does not close early (see the probe above), so "harmonising" them would be a
change with no upside and a real risk of reintroducing the asymmetry.

**Any NEW POST that wants a client-disconnect abort needs this** — it is the shape every billed
loop here uses. The in-code comments at `packages/pro/src/annotations/routes.ts` and
`packages/pro/src/activity-digest/routes.ts` restate the reasoning at the call site so a reader
of either does not have to find this doc first.

## My Turn — the ball rule

**MY TURN = the reader owes an action on this PR, and nothing they have done since the last RELATED
event discharges it.** Derived on every read from `reviews`, `review_comments`, `pr_comments` and
`commits`. Nothing is stored: there is no dismissal table, no "done" state, no tombstone. A card
appears when the state says so and vanishes when the state says so.

### What the predecessor did, and why it was wrong

`getAddedRepoActionablePrIds` tested exactly: *the repo has a `createdAt`, the PR opened at or after
it, the author is a non-bot who is not you, and the PR is open and non-draft.* It joined `reviews`,
`pr_comments`, `review_comments`, `commits`, `events` and `pr_views` **zero times**. The card was
therefore a fact about the PR's **creation**, and creation never un-happens — so it could not
self-clear while the PR stayed open. A PR the reader had approved eleven days earlier still rendered
"New PR from @robin-dunn". The **Done** button existed to compensate manually, and on this one
section the dismissal was **sticky forever** (no timestamp comparison, unlike the other four), whose
undo was fully built in the backend and mounted nowhere in the SPA.

⚠ **`repos.createdAt` was never the missing predicate.** It is an ONBOARDING FLOOR — its own comment
says "adding a repo with 400 open PRs dumps all 400 into My Turn on day one". Per-repo, viewer-blind,
evaluated once and monotonic. "Have I acted" is per-PR, per-viewer and time-ordered. They share only
a `>=` operator.

### The summons — what puts the ball in your court

| # | Rule | Where |
|---|---|---|
| S1 | A review is outstanding from you (`review_requests` row with `user_id = me`) | pre-existing |
| S2 | A PR in a repo you added that you have **never touched** (`mineLast == null`) | the reformed `watched_repo_pr` |
| S3a | A human **reply** in a thread you opened, still unresolved | `getThreadsAwaiting` — the ONE place the rule already existed |
| S3b | A thread you opened has gone **`likely_addressed`** | `awaitingKind: 'likely_addressed'` |
| S3c | A human **commit** after your last action — new code makes your review stale | `NewPrBall.kind === 'commits_after'` |
| S4 | A finished Claude review with an un-posted actionable finding | `getUnactionedClaudeReviews` |

### What does NOT return the ball

⚠ **RELATEDNESS, NOT RECENCY.** A human PR-level comment, or a comment on somebody else's thread,
does **not** summon you back. This is the difference between the rule as specified and a naive
"anything after me" rule, and it is what stops a teammate's side-comment re-summoning you.

⚠ **NO BOT ACTION EVER RETURNS THE BALL — INCLUDING A PUSH.** This **deliberately diverges** from
Chronology (`db/pr-intervals.ts`), which counts *every* commit regardless of author because a push is
code arriving whoever's name is on it. That is right for an aggregate flow measure and wrong for a
personal summons: a formatting bot's push is not a reason to re-read a PR. Both rules are correct for
their own question — **do not "fix" one to match the other.**

⚠ Bot-ness resolves through the **global `users.isBot` set**, never `hiddenBotUserIds`, which REQUIRES
a `workspaceId` — and `getMyTurn` also runs **unscoped** for the notification watcher. A commit with a
null author is *not* a human push (unproven must not summon).

### Discharge

Any action of yours at or after the summoning moment: a review of **any** state (a bare `commented`
review counts), a review comment, a PR comment, or a commit. ⚠ `pr_views` is NOT an action —
`markPrViewed` stamps on pane open, so reading it here would clear cards on hover.

⚠ **`events` is NOT usable for this.** It looks free and is **lossy**: `sync/upsert.ts` emits
`review_submitted` only when `isSubstantiveReview` passes, so bodiless `commented` reviews produce no
row at all — precisely the actions this rule must see.

### Where the test goes, and why it must go there

⚠ **FILTER THE SEED LIST, NEVER THE BUILT ARRAY.** `myTurnTotal = ranked.length` is taken *after* seed
assembly and *before* the 50-slice. Removing seeds moves numerator and denominator together and every
cap disclosure stays arithmetically true; removing cards after the slice — or on the client — leaves
`myTurnTotal` stale and over-claims "50 of 148".

⚠ It belongs in the **helper**, which `getMyTurn` and `getActionableActivityIds` SHARE, so the board,
the browser notification, the brief count and the activity list move together.

### Two adjacent bugs the Done button was hiding

⚠ **`getThreadsAwaiting` had no `state = 'open'` predicate.** With dismissals removed it returned 31
threads, every one on a PR that had already merged or closed — each previously hand-dismissed.
Deleting the button without this makes the board strictly worse.

⚠ **`getUnactionedClaudeReviews` must count posted FINDINGS, not the parent run's `postedAt`.** The
per-finding post route stamps `claude_review_findings.posted_at` and never the parent, so a run-only
test makes the card immortal. Measured: 96 runs / 2 stamped, 287 findings / 62 stamped. Fixed
CORE-side, because the plugin-side fix heals no already-unstamped run.

### The card must explain itself

"New PR from @x" is true only of S2. A row kept by S3c reads **"You approved · @robin-dunn pushed 2
commits since"**, and its section chip says **"Pushed since"**. `MyTurnCard.ball` carries the FACT and
the SPA picks the WORDS — a chip keyed on `reason` alone said "New PR" directly beside that detail,
the card contradicting itself in two adjacent elements. ⚠ An **absent** `ball` falls back to the
section label, never to a guess: the field is trailing-optional for wire tolerance, and an older
response must not have "Pushed since" invented over a PR nobody has touched.

