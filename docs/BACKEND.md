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
event discharges it.** Derived on every read from `reviews`, `review_comments`, `pr_comments`,
`commits` and the mention scanner's `pr_mentions` (plus, for the promotions below, the PR's own
merge and CI columns and `repos`' default-branch columns). Nothing about a CARD is stored: there is
no "done" state and no tombstone. A card appears when the state says so and vanishes when the state
says so. What IS stored is the reader's choice of which TYPES exist (§ Settings: gates and
promotions) and — since sqlite `0069` / pg `0056` — a per-SUBJECT dismissal whose only power is to
hide what happened BEFORE it (§ Dismissals and one card per PR).

### Dismissals and one card per PR (`db/my-turn-dismissals.ts`)

**A dismissal sets a subject down until something new happens on it** — for the item the reader
cannot act on now, or ever. It is built so that it cannot repeat the retired Done button's failure
(below), which stored "I dealt with this" and never expired:

- The SUBJECT is a pull request, or a repository for a red default branch — never a card: one PR can
  hold several jobs, and dismissing the one on screen must not surface the next.
- `getMyTurn` passes EVERY candidate item through `MyTurnDismissalFilter.keep` BEFORE anything else
  looks at it — in particular before the fixed-precedence claim, or a dismissed review request would
  claim the PR and swallow the newer mention that should bring it back. An item is hidden only while
  its OWN clock (the section's `since`; a thread's `lastReplyAt`; a Claude run's `finishedAt`; a red
  branch's `observedAt`, never its `since`, whose fallback is the fold time) is at or before
  `dismissed_at`. Anything later shows, ALONE: a new reply comes back as a reply, not as the review
  request that was set down. An item with no clock cannot prove it is newer and stays hidden.
- ⚠ **A subject with NO item at all DISCHARGES its row** (`dischargeable`, then
  `dischargeMyTurnDismissals`) — you acted, it closed, the request was withdrawn. So a later summons
  starts fresh. Without it, a re-requested review (clocked by the PR's FIRST request, which never
  moves) would arrive already dismissed — exactly the weeks-long hiding 0060 cites. Only subjects the
  read could have seen are discharged (a workspace fold has not looked at other workspaces' repos);
  a closed PR is dead wherever it lives. ⚠ A GET therefore sometimes DELETEs — bounded, indexed, and
  only when there is something to drop.
- Everything downstream reads the result, so the board, the brief's counts, the badges, the browser
  notification and the CLI all stop showing a dismissed item together. A dismissed PROMOTION goes
  back to its home tab (the promoted sets are built from the filtered sections) — the job still
  exists; it is only off the reader's plate. `MyTurnResponse.dismissed` lists subjects wholly hidden
  by a live dismissal (a subject with a newer item showing is back on the plate, and is not listed).

**One card per PR, on the board only** (`onePerPr`, `getMyTurn(…, { onePerPr: true })`, passed only
by `getWorkspaceInsights`). With it the fixed claim is skipped, every section is built in full, and
each PR keeps ONE item: the lowest index in the reader's type order, then the OLDEST clock (the
scorer's pick too — same PR and type means the same proximity and relevance, so the longer wait
scores higher and wins `compareScored`'s age tie-break), then the item's own id. Applied before the
promoted sets, so a promotion that loses to another job on its PR stays on its home tab. Red branches
are repo-grained and never collide. ⚠ **`GET /api/my-turn` does NOT pass it** and keeps the fixed
precedence: the notification watcher diffs item ids, and a deduplicated list would flip the winner
whenever a PR's top job cleared, announcing the runner-up as "new". A consequence the reader chose:
which card represents a PR now depends on the type order, so reordering can change a card's reason
(pinned in `my-turn-settings.test.ts`).

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

Each rule is one card type (`MyTurnCardReason`) and one section of `MyTurnResponse`. "Human" means an
author id that is known, is not you, and is not in the global automation set (below).

| # | Rule | Type · section | Clock (`since`) |
|---|---|---|---|
| S1 | A review is outstanding from you (`review_requests` row with `user_id = me`) | `review_request` · `awaitingReview` | when it was requested |
| S2 | A PR in a repo you added that you have **never touched** (`mineLast == null`). **Off by default** — a survey of the workspace, not a summons | `watched_repo_pr` · `watchedRepoPrs` | `openedAt` |
| S3a | The newest **human** comment in a thread you opened is not yours, and the thread is unresolved. A bot reply never counts | `thread` · `threadsAwaiting` (`getThreadTurns`) | that comment |
| S3b | You had the last human word in a thread you opened, and it has gone **`likely_addressed`** | `thread` (`awaitingKind: 'likely_addressed'`) | your comment |
| S3c | A human **commit** after your last action — new code makes your review stale | `pushed_since` · `pushedSince` (`NewPrBall.kind === 'commits_after'`) | that commit |
| S3d | In a thread SOMEBODY ELSE opened that you commented in, the newest human comment is someone else's, after your newest comment there, unresolved | `thread_reply` · `threadReplies` (`getThreadTurns`) | that comment |
| S4 | A finished Claude review with an un-posted actionable finding | `claude_review` · `claudeReviewsToAction` | when the run finished |
| S5 | Your newest action on the PR is a **PR-level comment**, and a human commented at PR level after it | `comment_reply` · `commentReplies` | the FIRST such comment (when the ball came back) |
| S6 | A human **@-mentioned** you on an open PR after your last action on it | `mention` · `mentions` | `pr_mentions.mentioned_at` |

- **S3c, S5 and S6 are `direct`**, like every rule but S2: each needs you to have been involved.
  S3c used to share S2's section and relevance; it is its own type now, so the two have separate
  switches and S2 alone keeps the maintainer test (`'maintained'` / `'none'`).
- **The onboarding floor reaches the new sources.** S3d, S5 and S6 need the summoning event at or
  after the repo's `createdAt`; without it, adding a repo and its 90-day backfill would surface two
  months of old replies and mentions at once. (S2 and S3c already read it through
  `getAddedRepoActionablePrIds`.)
- **S6 reads a clock the scanner stamps** (`sync/mention-scan.ts`, [SYNC.md](SYNC.md) § "@mention
  derivation"): the newest mention of you by a human on each PR. A row with a NULL `mentioned_at`
  (the scanner has not restamped it since migration `0068`) shows no card — under-notifying is the
  safe direction. A new mention shows within one scan tick (5 min); in cloud the scanner covers only
  recently active accounts, so a returning reader waits one tick.
- **S3d, S5 and S6 include drafts and automation-authored PRs**: conversations happen on drafts,
  and a colleague can name you on a Dependabot PR.
- **One PR, one summons.** The PR-grained types claim PRs in a FIXED precedence —
  `review_request > pr_approved > your_pr > mention > comment_reply > pushed_since > watched_repo_pr`
  — and each drops what an earlier SHOWN type claimed. ⚠ Fixed, never the reader's display order:
  which card exists must not depend on a display preference. Thread-grained, own-work, Claude and
  red-trunk cards coexist with everything (each is a different job).

### What does NOT return the ball

⚠ **RELATEDNESS, NOT RECENCY.** A human comment that is not an answer to you does **not** summon
you back: a PR-level comment after your review, a comment in a thread you never wrote in. This is
the difference between the rule as specified and a naive "anything after me" rule, and it is what
stops a teammate's side-comment re-summoning you. ⚠ **S5 is narrow on purpose**: it fires only when
your LAST action on the PR was itself a PR-level comment — the narrowest reading in which the next
person's comment is plausibly a reply to yours. It can still fire on a courtesy "thanks, merged"
after your "LGTM"; the type's switch is the escape, not a wider or cleverer rule.

⚠ **NO BOT ACTION EVER RETURNS THE BALL — INCLUDING A PUSH.** This **deliberately diverges** from
Chronology (`db/pr-intervals.ts`), which counts *every* commit regardless of author because a push is
code arriving whoever's name is on it. That is right for an aggregate flow measure and wrong for a
personal summons: a formatting bot's push is not a reason to re-read a PR. Both rules are correct for
their own question — **do not "fix" one to match the other.**

⚠ Bot-ness resolves through the **global AUTOMATION set** — `globalAutomationUserIds()`
(`db/automation-ids.ts`): `users.isBot` ∪ `users.github_type = 'Bot'` ∪ the `AUTOMATION_VENDORS`
logins and prefixes. `getMyTurn` reads it ONCE and hands it to every rule, and the mention scanner
builds from the same set, so a mention it stamps is one the ball rule honours. Why not `users.isBot`
alone: S3d, S5 and S6 read OTHER people's comments, and on the dev DB five accounts GitHub types as
a Bot but `isBot` misses wrote **112 PR comments on 82 open PRs** (google-cla 73, socket-security
24, cdp-github-action 12, gitguardian 2, jit-ci 1) — each would have summoned you as "a person
commented after you". The wider set also stops Copilot and cdp-github-action pushes returning the
ball (S3c), and stops a PR opened by a GitHub-typed Bot being a "New PR" (S2). `users.isBot` itself
is unchanged.

⚠ It is still **never `hiddenBotUserIds`**, which REQUIRES a `workspaceId` — and `getMyTurn` also
runs **unscoped** for the notification watcher. So a workspace's manual "this is a human" cannot
reach it; accepted, because every member is an account GitHub types as an App or a known vendor
login. A commit or comment with a null author is *not* a human (unproven must not summon).

### Discharge

Any action of yours at or after the summoning moment: a review of **any** state (a bare `commented`
review counts), a review comment, a PR comment, or a commit (`lastActionClocks`). The thread types
(S3a, S3b, S3d) clear when you comment in that thread or it is resolved. Every type clears when the
PR closes. The promotions below clear on STATE, not on your action: the build goes green, the
conflict is resolved, the PR stops being ready, the thread gets a reply or a later commit, the
branch goes green.
⚠ `pr_views` is NOT an action — `markPrViewed` stamps on pane open, so reading it here would clear
cards on hover.

⚠ **`events` is NOT usable for this.** It looks free and is **lossy**: `sync/upsert.ts` emits
`review_submitted` only when `isSubstantiveReview` passes, so bodiless `commented` reviews produce no
row at all — precisely the actions this rule must see.

### Where the test goes, and why it must go there

⚠ **FILTER THE SEED LIST, NEVER THE BUILT ARRAY.** `myTurnTotal = ranked.length` is taken *after* seed
assembly and *before* the 50-slice. Removing seeds moves numerator and denominator together and every
cap disclosure stays arithmetically true; removing cards after the slice — or on the client — leaves
`myTurnTotal` stale and over-claims "50 of 148".

⚠ It belongs **inside `getMyTurn`** — its section gates and its helpers (`getAddedRepoActionablePrIds`,
`getThreadTurns`, `lastActionClocks`) — so the board, the browser notification, the brief count and
the CLI move together. (`getAddedRepoActionablePrIds` once had a second caller,
`getActionableActivityIds`; it was deleted with the dismissals table.)

### Two adjacent bugs the Done button was hiding

⚠ **`getThreadsAwaiting` (now `getThreadTurns`) had no `state = 'open'` predicate.** With dismissals removed it returned 31
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
response must not have "Pushed since" invented over a PR nobody has touched. (S3c is now its own
`pushed_since` type with its own chip, so the chip no longer depends on `ball`; `ball` still carries
the pusher and your last action for the detail line.)

### Settings: gates and promotions

The reader decides which types exist, how My turn orders them and how Pending ranks cards
(Settings → My Turn). FREE, both modes, every tier, PER ACCOUNT: one account is one reader, and the
same settings apply in every workspace.

- **Storage is overrides only.** `accounts.my_turn_settings` is NULL until the reader changes
  something ([DATA-MODEL.md](DATA-MODEL.md)). Every reader resolves it through ONE shared function,
  `resolveMyTurnSettings` (`packages/shared/src/my-turn-settings.ts`); a malformed part falls back
  to its default alone. `compactMyTurnSettings` is the one definition of "an override", used by the
  SPA to build the body and again by the server before it stores, so a Save never freezes a default.
  The server-side read is `getMyTurnSettings` (`db/my-turn-settings.ts`), straight from `accounts`,
  never from the local-account cache. The one writer is `PUT /api/me/my-turn-settings`
  ([API.md](API.md)); its setter refreshes the local-account cache, or `/api/me` would hand the
  Settings form the old value in local mode.
- **A type switched off is REMOVED, not hidden.** The gate runs inside `getMyTurn`, and a
  switched-off section is not computed at all (its queries are skipped). So the list, every count,
  the daily-brief counts, the browser notifications and the CLI shrink together, in the scoped and the
  unscoped call alike. A switched-off type claims nothing, so a PR it would have held falls through
  to the next shown type in the precedence above. Defaults: every summons on except S2
  (`watched_repo_pr`); every promotion off.
- **Five PROMOTIONS move a card from another tab into My turn** — four about your own PRs,
  `own_ci_red` (a red build), `own_conflicts` (a conflict, in a repo you can push to), `own_ready`
  (GitHub will merge it now, or once the branch is updated) and `own_thread` (a review thread with
  no reply and no later commit for a day), plus `trunk_red` (a red default branch, scoped `off` /
  `maintained` / `all`). Each is `direct`.
  - ⚠ **A PROMOTED CARD MOVES, IT IS NEVER LISTED TWICE.** `getWorkspaceInsights` builds
    `promotedCi` / `promotedConflicts` / `promotedReady` / `promotedThreads` / `promotedTrunks`
    from the one `getMyTurn` result, and each home builder (`ci_failing` both arms, `merge` /
    `update_branch`, `conflicts`, `untouched_thread`) drops those ids from its SEED list before its
    `kindTotals`, beside the Dependencies `depPrIds` test. The tab counts move with their lists.
  - **The population is the home card's exactly**: your own open PR, non-draft, with an activity
    event inside `maxQuietDays`, classified by the same functions (`db/pending-classify.ts`:
    `isRedCiStatus`, `isConflicting`, `forwardKindOf`). `own_conflicts` keeps the `conflicts` write
    gate; a thread you started on your own PR stays on its home tab.
  - ⚠ **A PR carrying a dependency tool's marker is never promoted**, even under your own login
    (a Snyk fix pushed with your token): it is a dependency PR and lives in the Dependencies tab.
  - `own_ready` takes `pr_approved`'s claim when both are shown: the ready card carries the approval
    standing and the Merge button, and dropping the approval card without its claim would let the
    PR fall through to `your_pr` and turn one card into two.
  - **`trunk_red` is `direct` in both scopes** (the reader asked for it, so it notifies); `maintained`
    is a display fact that picks the sentence. The landing PR resolves through the same
    `resolveTrunkCommitPrs` as the `ci_failing` trunk arm, and `MyTurnTrunkCard` carries the same
    four author fields, so the People / Automation lens puts it on exactly one side. It is
    REPO-grained: `kind === 'my_turn'` no longer implies a PR, and every consumer branches on
    `reason === 'trunk_red'` before treating one as a PR (the scorer, the card renderer, the Pro
    sprint report).
- **The Pending mute still rides `relevance`** for every new type (`relevanceFor`), so a muted
  repo's rows stay listed as `'none'`; a mute never removes a row. A switched-off type does.
- **The ranking settings.** The type ORDER groups My turn (`tabGroupRank`, `groupByReason`), and the
  three Do next WEIGHTS (integer percents, steps of 10, summing to 100; presets Balanced 50/30/20,
  Mine first 30/10/60, Oldest first 20/70/10, Quick wins 80/10/10) reach `scoreCards` for every tab
  and for the Pro work plan. `rankPendingTabs` returns them as `rules` on `/api/attention`, so the
  board explains the order the reader actually got ([FRONTEND.md](FRONTEND.md) § The Pending tabs).
  Measured on the dev DB before the build (773 listed cards): under Balanced, 401 of them outrank a
  fresh direct review request; under Mine first, none do. Balanced stays the default, so nobody's
  order moves until they choose.
- **The brief counts a promoted red trunk once**: `trunkRed` leaves out
  `WorkspaceInsightsResponse.myTurnTrunkRepoIds` before its cap, and `ciFailing` counts only the
  `ci_failing` cards that were not promoted. A save drops the account's cached roll-up counts
  (`clearDailyBriefCountsFor`), so the banner and Workspace badges never count a type the reader just removed.
- On the dev account (an observer with no PRs of its own) the defaults leave ONE card on My turn —
  three.js #34066, a `comment_reply` — where it held 551 before. With the app now opening on
  Pending, that account's cold open is an almost empty My turn.

## The Dependencies tab — dependency automation and security (CORE)

The sixth Pending tab (`deps` in `PENDING_TABS`) holds two card kinds: **`security`** and
**`dependency_bump`**. Deterministic, free on every tier, no model, no new route and no new table
(the four `pull_requests` columns it reads are in [DATA-MODEL.md](DATA-MODEL.md) § `pull_requests` —
dependency + security signals). Built in `getWorkspaceInsights` (`db/queries.ts`), ranked in
`db/pending-tabs.ts`, scored in `db/work-plan.ts`.

### A dependency PR is listed ONLY there

A **dependency PR** is an open PR whose resolved author role is `'dependency'`
(`authorAutomationFor(…).role`, below): a dependency bot opened it, or a person's PR carries a
dependency tool's own marker (`pull_requests.dependency_vendor`). The fold resolves the set ONCE
(`depPrIds`, right after the open-PR select) and every other PR kind drops those PRs from its SEED
list, **before its `kindTotals` is taken** — so each total is exactly its cards, and one PR never
shows the same merge state in two tabs.

| Kind | Dependency PRs |
|---|---|
| `ci_failing` (the `your_pr` arm) | excluded — the Dependencies card says "CI failing" |
| `merge` / `update_branch` | excluded — the Dependencies card carries the merge actions |
| `conflicts` | excluded — the Dependencies card carries the same resolver entry |
| `stalled_review`, `reviewer_routing` | excluded — the card says "Needs review" |
| `untouched_thread` | excluded — filtered from `threadRows` before the total |
| `my_turn` | **KEPT.** A review requested of you on a Dependabot PR is a direct summons and wins. `getMyTurn` reads no `depPrIds`, so a thread you started on one, or a marker PR under your own account, also stays — except that the own-work PROMOTIONS skip a marker PR (§ My Turn — Settings), which would otherwise be listed twice |
| `reviewer_load` | **KEPT.** It counts a person's review queue the way GitHub holds it, and is a strip about people, not a PR card |

`rg -a "depPrIds.has" apps/backend/src/db/queries.ts` shows the six exclusion sites plus the builder.

### One card per PR

For each PR in the open-PR population (the board's one admission floor, below):

- **a dependency PR** gets a `security` card when its own markers fix a known advisory
  (`security_fix` set) or a live automation alert names one, and a `dependency_bump` card
  otherwise. It carries its merge fields and, on the board, its merge actions. Never both kinds.
- **a person's PR** gets a `security` card (`dependencyUpdate: false`, `depState: null`, `fix: null`)
  only for a live alert, and KEEPS its other cards: the alert is an extra job, not the PR's home.

Card facts, all read off the synced row:

- `depState` (`dependencyPrState`, `db/dependency-cards.ts`), first match wins: `conflicts` →
  `ci_red` → `behind` → `ready` → `needs_review` → `blocked` → `unknown`. NULL columns are NOT
  OBSERVED and fall to `unknown`, never to `ready`. ⚠ **A red build GitHub would still merge is
  `ready`**, not `ci_red`: `unstable` means only NON-required checks are red, and `unstable` is
  mergeable (`READY_MERGE_STATES`, `mergeVerdict`). So a ready dependency PR and a person's `merge`
  card print one sentence for one state: the `ready` detail IS `mergeCardDetail('merge', mss, 0)`.
- `severity`: `high` when a tool's marker or alert names an advisory, `warn` for Dependabot's
  inferred fix with no alert behind it, `info` for a bump.
- `relevance` (direct / maintained / none, the merge block's three tiers) feeds the ranker weight
  and the colour only, never an ownership claim. ⚠ **NOT MUTED**: the Pending mute reaches `my_turn`
  only.
- `viewerCanPush` is a VISIBILITY gate for the merge controls. There is no write gate on the kind
  (the merge/routing precedent), unlike `conflicts`.
- `advisoryIds` is every id the fix and the alerts name, canonical, deduplicated, fix ids first,
  complete up to the 50-id safety cap. `detail` ("Fixes GHSA-… and 2 more") counts the FIX's own
  ids only, never an alert's: the PR may not fix what a tool flagged. `alerts` is the newest 3;
  `alertCount` is the whole population behind the "+N".

### Who opened it — the author resolution

ONE resolution feeds the card's byline, its side of the People / Automation lens and its
Dependencies-tab membership, so the three cannot disagree. It is read ONCE per fold
(`resolveAuthorAutomationInputs`), and `prRef` stays synchronous.

- **The SET** is `hiddenBotUserIds`, widened: `users.isBot` ∪ the review-bot logins ∪ every
  account GitHub TYPES a Bot (`users.github_type = 'Bot'` — the Apps whose login GraphQL returns
  without `[bot]`: 7 such users on the dev DB, who wrote 112 PR comments on open PRs) ∪ every
  `AUTOMATION_VENDORS` login and prefix ∪ the workspace's automated rows. ⚠ A manual "this is a
  human" still removes the actor from EVERY half. The same set drives the Timeline's `excludeBots`
  and the Feed lens: measured, 34 events from five accounts became hidden there (Copilot,
  lumberbot-app, ImgBotApp, diffray-bot, orbisai0security).
- **The KIND** is `classificationKindForUser`, now seeded from the non-review vendors too
  (renovate, snyk-io, imgbot…), so a byline names the tool instead of a nameless "Bot". The
  REVIEW_BOTS seed still wins; a STORED kind beats the new seed, and only a NULL stored kind takes
  it. ⚠ **EXACT LOGINS ONLY** (`exactAutomationVendorUsers`): this map is also the bot drill-downs'
  "is this id classified here" gate, which then resolves the login, so a prefix match
  (`semgrep-code-<org>`) would hand any tenant another org's name. A prefixed login still counts as
  automation and still gets its role; only its brand waits for a workspace row.
  `classificationKindForUserForAccount` is unchanged: it feeds the cross-org benchmark.
- **The ROLE** is `authorAutomationFor` (`db/dependency-cards.ts`, pure): (1) a dependency
  tool's marker on the PR ⇒ `{role: 'dependency', kind: the tool, source: 'account' | 'marker'}` —
  the marker wins the role even over an automated author with another role (Socket Fix and Frogbot
  run as `github-actions`); (2) an author outside the set ⇒ null, a person; (3) otherwise the
  manual role, the login vocabularies, a non-`review` stored role, a review-bot kind, and last
  `code_agent`. ⚠ **The last resort is `code_agent`, NOT `resolveActorLanes`' `quality_gate`**: an
  unknown automation that OPENS a PR writes code. Different question, deliberate divergence.
- `authorIsBot` / `authorBotKind` keep their meaning, a claim about the ACCOUNT. `automation` is a
  claim about the PR, which a marker can make of a person's account.
- `ci_failing` carries the same four author fields: the viewer on `your_pr`, the LANDING PR's
  author on `trunk`, and none (the people side) when no PR resolved. So the lens has ONE predicate
  for every card, `pendingAuthorSideOf` in `packages/shared/src/pending-rules.ts`.
- ⚠ **Pending and Reports can disagree on an actor.** The kind seed reaches `resolveActorLanes`
  (measured: 7 events moved lane, from ImgBotApp and orbisai0security), but `github_type = 'Bot'`
  does not, so Copilot's coding agent and `cdp-github-action` are automation on Pending and people
  in the Reports lanes. `resolveActorLanes` was deliberately left alone.

Two small modules hold what more than one fold asks:

- **`db/pending-classify.ts`** — "is this build red?" (`RED_CI_STATUSES`, `isRedCiStatus`) and
  "does it conflict?" (`isConflicting`), spelled once for the home cards and the Dependencies cards.
  Pure: no `db/client`, no `db/triage`.
- **`db/automation-ids.ts`** — the global readers (`githubTypeBotUserIds`, `automationVendorUserIds`,
  `exactAutomationVendorUsers`, and their union with `users.isBot`, `globalAutomationUserIds` — the
  My Turn ball rule's automation set). Ids only, used as membership tests; `users` is global. A
  separate module so My Turn's mention scanner (`db/pr-mentions.ts`) can reach them without
  importing `queries.ts`.

### Security alerts are derived on read

`deriveSecurityAlerts(prIds, automatedIds, kindOf)` (`db/security-alerts.ts`) folds the stored
comment rows of open PRs into live alerts. The rules are the detector's (`evaluateSecurityAlerts`,
`sync/security-detect.ts`); the file only reads candidates. Nothing is stored.

- ⚠ **TENANCY IS THE ID LIST.** `pr_comments`, `reviews` and `review_comments` carry no
  `account_id`. Every read is keyed by `pr_id IN (prIds)`, and the only caller passes the fold's
  account-scoped `openPrIds`. Never export a variant that takes ids from a request.
  `verify:isolation` checks it directly: the reader answers for the ids it is handed, even when
  another tenant's PR carries the same comment.
- ⚠ **THE SQL PRE-FILTER MAY BE LOOSER THAN THE EVALUATOR, NEVER STRICTER.** It is built from
  `SECURITY_ALERT_PREFILTER`, because a tool's "all clear" (Socket's "All alerts resolved") names no
  advisory and must still reach the evaluator: the latest row decides. The evaluator re-applies
  every literal EXACT-CASE, so SQLite's case-blind `LIKE` and Postgres' case-sensitive one alert on
  the same rows.
- **Comments and reviews are narrowed to the tools' own accounts**, with the same looseness: an
  author-gated rule reads only its tool's login; an author-free rule (Frogbot, Checkmarx, which post
  through `github-actions` or a person's token) reads any row carrying its marker
  (`AUTHOR_FREE_ALERT_MARKERS`, held to the rules by `pending-deps.test.ts`). **Threads are not
  narrowed**: the `reviewer` fallback reads every automated root carrying any literal, which no
  narrower `LIKE` can promise on Postgres. Measured on Erxes (83 active PRs, 5.2 MB of comment text,
  99.8% of it automation's own): all literals over every comment and review took ~65 ms of a
  ~400 ms fold; the narrowed reads take ~10 ms; threads stay ~60 ms. Gating on the automated
  authors instead was slower.
- **Latest row, per tool.** On comments and reviews, the tool's LATEST row per (PR, rule, author)
  decides — per sticky comment, because Socket keeps two on one PR (the alerts report and the
  dependency overview). A later clear from the same tool retracts the alert. Unsubmitted
  (`pending`) reviews are skipped.
- **Thread roots only.** A thread alert comes from the thread's FIRST comment (the earliest
  `(created_at, id)` of the whole thread, from one extra read on `rc_thread_idx`, no correlated
  subquery), never a reply. It clears when the thread is resolved or `likely_addressed`.
- A row with no author never alerts: every alert names who raised it.

### Ranking, the floor and the brief

- **Strict group, then score.** `tabGroupRank` puts every `security` card before every
  `dependency_bump`; each group is ordered by the Do next score. Both kinds are scored for the
  board and are NEVER work-plan rows (the `conflicts` precedent): a dependency PR starts from the
  base its state names (`DEPENDENCY_STATE_BASE`; a `ready` one splits on approval like a `merge`
  card), and a person's flagged PR from `security_alert` (0.55). There is no security bonus: the
  strict group already orders security first.
- **Split totals.** `rankPendingTabs` counts `authorTotals`, `kindAuthorTotals` and (My turn)
  `relevanceAuthorTotals` off the uncapped cards with `pendingAuthorSideOf`, so
  `people + automation === total` by construction. The list cap is per LIST GROUP
  (`listGroupOf`: kind × My turn's "Only yours" side × who opened it), so every view is its own
  true top 50.
- **The board's one admission floor applies** (open, non-draft, an event within `maxQuietDays` =
  90). Measured on the dev DB: 716 of 1,438 open non-draft PRs pass it, and it holds out 8 security
  items (7 fix PRs in drizzle-orm and erxes, and a Socket alert on erxes#7643) and 7 bumps, all in
  repos the viewer only READS. Exempting security would be a one-predicate change plus a separate
  id set, or every other kind would re-admit the quiet PRs.
- **The brief** gains one line, `security` = `kindTotals.security` (uncapped, like the other survey
  lines), which opens the board isolated to `security`. It is templated and is not among the Pro
  narration's inputs, so no stored brief re-bills. `dependency_bump` is counted by no line: an
  update is housekeeping.

Measured on the dev DB when built (workspaces 1–8): `dependency_bump` 7 / 9 / 0 / 0 / 0 / 3 / 9 / 1
and `security` 0 / 0 / 1 / 0 / 2 / 0 / 0 / 0, every one a `dependabot[bot]` PR (the three security
cards are erxes#7874, inferred, and jupyter/notebook #8021 / #8022, proven). CDP's Waiting on review
went from 17 to 8 and Ready to land from 9 to 4. Live comment alerts on active PRs: 0 — the two
CodeRabbit thread roots naming an advisory sit in resolved threads. No active PR is opened by
non-dependency automation, so the People / Automation lens is offered on no tab yet.

Tests: `db/pending-deps.test.ts` (the fold, throwaway DB), `db/dependency-cards.test.ts` (the pure
helpers), `verify:isolation` (the alert reader and the backfill worklist).
