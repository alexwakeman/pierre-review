# Real-time sync — research & phased plan

> **Status: Phases 0–2 BUILT and LIVE by default in their respective modes** (2026-07-25).
> This is the design for moving pierre-review's sync closer to real-time without increasing
> GitHub API usage, grounded in the current pipeline (see [SYNC.md](SYNC.md)) and in
> research on what GitHub actually offers.
>
> **Adaptive polling (Phase 2) is the PRIMARY strategy in BOTH modes** — `syncAdaptive`
> defaults to `true` everywhere, with the scheduler tick defaulting to `*/1` so the per-repo
> due-check actually governs cadence. `SYNC_ADAPTIVE=false` restores the fixed-clock re-walk.
>
> **Why adaptive rather than webhooks as the default, even in cloud** (decided 2026-07-25):
> webhooks require the GitHub App to be **installed** on each repo, and installation needs
> admin rights on that repo. In practice most tracked repos are **third-party public repos**
> nobody on the deployment can install on (of the first production account's 8 repos, 2 —
> `mrdoob/three.js`, `raspberrypi/…` — are permanently uninstallable). A strategy that only
> works where you hold admin can't be the baseline. Adaptive needs no cooperation from anyone
> and is simultaneously *fresher* on active repos and *cheaper* on quiet ones than the fixed
> clock, so it is the floor everywhere.
>
> **Webhooks (Phase 1) stay strictly ADDITIVE on top**, in cloud, for repos that *are*
> installed: a delivery fires a targeted `syncOnePr` within seconds — better than any poll can
> do — while adaptive keeps reconciling everything else. They compose safely because both
> funnel into the idempotent `persistPr`. Phase 1 needs all three of: the secret env var, the
> seven event subscriptions, AND an installation ([Ops setup](#ops-setup)); a secret alone
> delivers nothing but the `ping`, which is what kept the receiver silently idle until
> 2026-07-25.
>
> Phase 0 (the shared targeted-sync core) is called by the webhook receiver, the live PR-pane
> refresh, the post-write resync and the post-write settle ladder
> ([§ Post-write settle](#post-write-settle)).

## The problem

Sync today is a **fixed-clock re-walk**: a `*/5` cron runs one fat `REPO_ACTIVITY_QUERY`
per repo and walks pages of the `since` window every tick (`sync/sync-manager.ts` →
`syncRepo`). It deliberately re-walks the whole window rather than short-circuiting on
`updatedAt`, because **GitHub doesn't bump a PR's `updatedAt` for every signal we care
about** (CI finishing, a review thread being resolved) — see SYNC.md
"Incremental updates". (The `since` window does not catch those either; see
[§ Post-write settle](#post-write-settle).)

Two consequences:

- **Latency** is bounded by the cron period (up to 5 min), and dropping the period to get
  fresher data multiplies API usage across *every repo × every active tenant*.
- **Cost scales badly** in cloud: N tenants × M repos each re-walked every 5 min, whether
  or not anything changed.

The goal: **near-real-time freshness while *lowering* API usage** — act on what changed
instead of re-walking on a clock.

## What GitHub actually offers (research)

| Question | Finding |
|---|---|
| GraphQL subscriptions / streaming? | **No.** GitHub's GraphQL API has no subscription support and no plans to add it ([community request](https://github.com/orgs/community/discussions/120716)). Real-time can't come from GraphQL. |
| Do webhooks cost rate limit? | **No.** Webhooks are push, not pull — a delivery never touches your quota ([GitHub Apps rate limits](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/rate-limits-for-github-apps)). |
| Do webhook events cover what we track? | **Yes, ~1:1.** `pull_request` (opened/closed/reopened/**synchronize**/review_requested), `pull_request_review` (submitted/dismissed), `pull_request_review_comment`, **`pull_request_review_thread` (resolved/unresolved)**, `issue_comment` (PR-level comments), `push`, `check_run`/`check_suite`/`status` ([event catalog](https://docs.github.com/en/webhooks/webhook-events-and-payloads)). |
| Can polling be made cheaper? | **Yes** — conditional requests (`ETag`/`If-Modified-Since`) return `304`, which **does not count against the primary rate limit** ([REST best practices](https://docs.github.com/rest/guides/best-practices-for-using-the-rest-api)). Works on REST GET, **not** on the GraphQL POST fat query. |
| GitHub App vs OAuth token limits? | App **installation** tokens get **15,000 req/hr** vs 5,000 for user OAuth tokens. |

**The key insight:** webhooks capture precisely the signals a `updatedAt`-based poll
structurally misses (`check_run`, `pull_request_review_thread` are their *own* events), are
free on rate limit, and let us fetch **only the one PR that changed**. So "GraphQL +
webhooks" resolves to: **webhook = trigger + *what changed*; GraphQL = a surgical single-PR
fetch** into the existing idempotent `persistPr`.

## The mode split (why there's no single answer)

Feasibility diverges hard along the local/cloud deployment modes (see CLAUDE.md
"Deployment modes"):

| | **Cloud (Railway)** | **Local (SQLite, `gh` token)** |
|---|---|---|
| Public endpoint to receive webhooks | ✅ yes | ❌ no (behind NAT) |
| GitHub App present | ✅ yes (sign-in + install flow) | ❌ n/a |
| Webhook feasibility | **good, but only where installed** | **poor as primary** (see below) |
| Baseline lever | adaptive + conditional polling | adaptive + conditional polling |
| Extra lever | GitHub-App webhooks (installed repos) | — |

> **Revised 2026-07-25.** This table originally read "best lever: webhooks" for cloud. In
> practice the binding constraint isn't feasibility, it's **permission**: an installation needs
> admin on the repo, so webhooks simply cannot cover third-party public repos — a large share of
> what people track. Adaptive polling is therefore the baseline in both modes, with webhooks as
> an accelerator on the subset that *is* installed.

Local can't be the webhook target: the official `gh webhook forward` CLI extension
([docs](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/using-the-github-cli-to-forward-webhooks-for-testing),
[cli/gh-webhook](https://github.com/cli/gh-webhook)) requires **admin** on each repo to
create the webhook (Pierre monitors repos you often don't own), is **"dev/testing only,
not production"**, and locks to **one user per repo**. So local's lever is cheaper,
adaptive polling — not push.

---

## Design principle

Webhooks (cloud) and adaptive polling (local) are different mechanisms, but they converge
on one new primitive: **"sync exactly PR #N of repo R for account A"** instead of "re-walk
R's whole window." Build that once (Phase 0), feed it from webhooks (Phase 1) and from an
adaptive scheduler (Phase 2). Every phase reuses the idempotent `persistPr` transaction or
the existing window-walk, so correctness risk stays low and webhook + backstop + poll can
all fire on the same PR with **zero duplication** (the current idempotency guarantee holds).

---

## Phase 0 — the shared targeted-sync core ✅ BUILT

Small, no user-visible change; nothing calls it until Phase 1/2. Implemented in
`sync/sync-one-pr.ts` (+ `sync/sync-one-pr.test.ts`, 8 tests).

- **`syncOnePr(repoId, prNumber, log)`** — the single-PR analogue of `runSyncForRepo`.
  Resolves the repo's owner/name/`accountId` from `repoId` (the id already encodes the
  account, so isolation is structural — no `accountId` param to get out of sync), fetches the
  one PR, gathers the same post-threshold commit SHAs as the page walk, and reuses
  `ensureCommitFiles` (permanent cache → usually free) + `persistPr` (idempotent,
  dialect-aware transaction); derived thread state falls out for free. In-memory reservation
  `Set<"${repoId}:${prNumber}">` reserved synchronously, mirroring `sync-manager.ts`'s
  `running` set. Never throws — logs and returns `false` on any no-op (in-flight / repo or PR
  gone / no token / SAML wall → flags the org for the reconnect banner), so the backstop
  reconciles anything missed.
- **`PR_ACTIVITY_ONE_QUERY`** in `github/queries.ts` — fetched via
  `repository(owner,name){ pullRequest(number) }`, selecting the **shared `PR_NODE_FIELDS`
  fragment** now also used by `REPO_ACTIVITY_QUERY`, so the two **can't drift** and `persistPr`
  accepts either unchanged. Cost **~1 point** vs a multi-page walk.
- **`enqueuePrSync(repoId, prNumber, log)`** — coalesces bursts (a push emits `push` +
  `synchronize` + two `check_run`s within seconds) into **one** `syncOnePr` after a quiet
  window (`config.webhookDebounceMs`, default 4s). Pure in-memory `Map` + `unref`'d timer; if
  a sync is mid-flight when the timer fires it **re-arms** rather than dropping the change.

Surface: 1 shared query fragment + 1 new query, 1 new module, **no migration**.

---

## Phase 1 — cloud webhooks (the high-payoff phase) ✅ BUILT

Implemented in `api/routes/webhooks.ts` (+ `api/routes/webhooks.test.ts`, 14 tests),
registered in `app.ts` (both modes), exempted from the auth gate in `api/plugins/auth.ts`.

**Route** `POST /api/webhooks/github`:

- **Exempt from the auth gate** (alongside `/api/health`, `/api/auth/*`, `/api/billing/webhook`
  in `registerAuthGate`). Authenticity is the HMAC signature, not a session.
- **Raw body** via an **encapsulated** `application/json` buffer parser inside a nested
  `register` scope — so ONLY this route sees the raw bytes; the rest of the API keeps normal
  JSON parsing (proven by the sibling-route test). Verifies `X-Hub-Signature-256`
  (HMAC-SHA256 over the raw body with `config.githubAppWebhookSecret`) **before** parsing;
  bad/missing signature → **401**, unconfigured → **501**, `ping` → 200 ack. This mirrors the
  Stripe webhook (`api/routes/billing.ts`) exactly.
- **Routing needs NO new table.** `repos` is keyed `(accountId, owner, name)`, so the handler
  reads `repository.owner.login` + `repository.name` + the PR number(s) from the payload →
  `SELECT id FROM repos WHERE owner=? AND name=?` → `enqueuePrSync(repoId, prNumber, log)` for
  each matching row. Multi-tenant fan-out is automatic; `syncOnePr` resolves each account's own
  token, so an account tracking the same public repo via the OAuth App (no install) even gets
  refreshed for free off another account's App-triggered delivery. Responds
  `{ received, queued }` (`queued` = rows × PR numbers).
- **PR-number extraction** (`extractPrTargets`, pure/tested) per event: `pull_request` /
  `pull_request_review` / `_review_comment` / `_review_thread` → `pull_request.number`;
  `issue_comment` → `issue.number` **only when `issue.pull_request` is present** (it also fires
  on plain issues); `check_run` / `check_suite` → each entry of `pull_requests[].number` (this
  is how a **check finishing** — which never bumps a PR's `updatedAt` — drives a refresh). A
  raw `push` carries no PR (it arrives as `pull_request` `synchronize`), so it's a no-op.

**Events to subscribe** (App config): `pull_request`, `pull_request_review`,
`pull_request_review_comment`, `pull_request_review_thread`, `issue_comment`,
`check_run`/`check_suite`. (`installation`/`installation_repositories` optional, for future
auto-add on install.)

<a id="ops-setup"></a>
**Ops setup** (once, on the GitHub App — not code). **All THREE are required**; any one
missing means zero deliveries, and the failure is silent:
1. App settings → **Webhook**: tick **Active**, URL = `<APP_BASE_URL>/api/webhooks/github`,
   set a **secret**, and put that same value in **`GITHUB_APP_WEBHOOK_SECRET`** on the
   deployment.
2. **Permissions & events → Subscribe to events**: tick the seven events listed above and
   **Save changes**. These default to NONE. A configured-but-unsubscribed App still sends
   the one-off `ping` on save, which makes "Recent Deliveries" look alive while no real
   event ever fires — the exact trap hit here on 2026-07-25.
3. **Install App**: the App must be **installed** on an account/org for its events to fire
   there. On the Install App page an account showing "Install" (rather than "Configure") is
   NOT installed. Public repos tracked via the OAuth App only still rely on the periodic
   poll — which is why Phase 1 is additive.

**Diagnosing silence.** An unsigned `curl -XPOST <base>/api/webhooks/github` returns `401
invalid signature` when the secret is configured and `501` when it isn't — so a 401 proves
the server half is fine and points the finger at steps 2/3. Railway HTTP logs filtered to
`/api/webhooks/github` show whether GitHub is reaching the deployment at all. Note GitHub's
delivery list renders timestamps in **your local timezone** while Railway logs are UTC.

**Backstop (deliberate):** webhooks are layered **on top of** the poll, never replacing it —
a delivery gap, an OAuth-only account (no install → no webhooks), or a repo the App isn't
installed on all still reconcile on the cron. Once delivery is proven, the API-cost win is
widening that backstop via the `SYNC_CRON` **env var on the deployment** (no code change;
cloud's code default stays `*/5`). Target `*/15`.

**Net (once webhooks are configured):** latency → seconds for installed repos; and after the
backstop is later widened, baseline API usage drops sharply (quiet repos cost 0; a change costs
1 targeted fetch instead of a windowed re-walk × every active tenant).

---

## Phase 2 — local adaptive polling + conditional probe ✅ BUILT

Local has no public endpoint, so the lever is **adaptive cadence**, made cheap with
**conditional requests**. Implemented in `sync/adaptive.ts` (+ `sync/adaptive.test.ts`,
9 tests) + a conditional helper `ghRestGetConditional` in `github/client.ts`, wired into
`sync/sync-manager.ts`'s `syncAllRepos`. **All gated on `config.syncAdaptive`, which now
defaults to `true` in BOTH modes** (see the status note for why cloud isn't webhook-first).
Because the due-check can only grant a repo a sync when the loop ticks, the `SYNC_CRON`
**default follows `syncAdaptive`**: `*/1` when adaptive, `*/5` when not. Leaving the tick at
`*/5` would pin every repo to five minutes and throw away the freshness half of the phase —
the hot bucket is 120s. `SYNC_ADAPTIVE=false` restores the classic fixed-clock re-walk (and
the `*/5` default with it); an explicit `SYNC_CRON` always wins — **so a deployment that
pins `SYNC_CRON=*/5` silently keeps the old cadence even with adaptive on.** Unset it to
adopt the default.

**In cloud it composes with two existing gates, in this order:** the activity gate skips
accounts idle > `syncActiveWindowMinutes` first (so an idle tenant costs nothing at all),
then `isDue` skips not-yet-due repos, then the conditional probe skips unchanged ones. The
probe uses `getAccessToken(repo.accountId)` — the tenant's own token — so isolation is
unchanged. Net API usage goes **down** versus the `*/5` full re-walk: a 304 probe is far
cheaper than a windowed GraphQL walk, and quiet repos back off to 15-minute attempts.

**Two known caveats.** (1) Cadence + ETag state is **per-process in-memory**, so multiple
replicas each keep their own — they'd probe independently (the pre-existing `running` set has
the same property, so this is not a new risk, but it does bound horizontal scaling until the
state moves to the DB). (2) A webhook-driven `syncOnePr` does **not** update the cadence map,
so the next probe still sees the moved `updatedAt` and walks — correct and idempotent, just
one redundant walk. Deliberate: sharing state between the two paths couples them for a saving
that doesn't matter at current volumes.

**Adaptive cadence.** Each tick, `isDue(repoId, now)` skips a repo unless its bucket
interval has elapsed since the last attempt. The bucket is by recency of the last observed
change (`lastChangeAt`); state is **in-memory** (no migration — lost on restart just means
one immediate attempt after boot):

| Bucket | Definition | Interval (default) |
|---|---|---|
| hot | a PR changed in the last ~1h | `SYNC_HOT_INTERVAL_SEC` (120s) |
| warm | changed within ~6h | `SYNC_WARM_INTERVAL_SEC` (300s) |
| cold | quiet longer | `SYNC_COLD_INTERVAL_SEC` (900s) |

**Conditional probe (the cost-saver).** For an **incremental** sync, `decideIncrementalWalk`
does a REST **conditional** GET (`/repos/{o}/{n}/pulls?state=all&sort=updated&per_page=1`
with the stored `ETag`) before the fat GraphQL walk. A `304` costs **zero** rate limit, so a
genuinely-idle repo is skipped almost free; a `200` also refreshes `lastChangeAt` (so an
active repo climbs to a faster cadence and a quiet one decays). A probe error → walk anyway
(never skip on uncertainty). First backfills (`mode:'full'`) always walk.

**The re-walk floor, and what it does NOT catch.** `updatedAt` doesn't move for CI finishing,
GitHub finishing its mergeability computation, or a thread resolve, so the probe can't detect
those. A **re-walk floor** (`SYNC_FLOOR_INTERVAL_SEC`, 1800s) forces a walk at least that often
even on a `304` — but ⚠ **the forced walk uses the SAME `since = lastIncrementalSyncAt −
SYNC_OVERLAP_MINUTES` window**, so a PR whose only change left `updatedAt` alone falls outside it
and is NOT re-read. The floor bounds how long a quiet repo goes unwalked; it never refreshed
those signals. Reproduced on real data (2026-09): open PRs stored `unknown` merge state, and CI
stored `pending` for more than two hours, while GitHub reported a known value with the same
`updatedAt`. A raw count of stored-`unknown` rows overstates the problem: 63 of the 132 first
counted sat in one repo whose walks were FAILING (a different fault), and GitHub answers
UNKNOWN on the first request anyway. The fix is the **unsettled-PR backstop** that runs after
every walk ([§ Post-write settle](#post-write-settle)). Webhooks close the same gap for free on
installed repos; a thread resolved on github.com still waits for the PR's next `updatedAt` bump,
a webhook, or an open PR pane.

**Net:** near-real-time where activity actually is, *lower* total API on quiet repos — the
opposite of naïvely dropping `SYNC_CRON`.

---

## Live PR-detail refresh (POST /api/prs/:id/refresh) ✅ BUILT

The phases above are all **repo-grain background cadence**; nothing made the PR a human is
looking at RIGHT NOW any fresher than its repo's bucket. `sync/refresh-pr.ts` +
`usePrLiveRefresh` close that gap client-driven — deliberately **never a backend cron**:

- **Frontend-driven ~5s poll, only while the PR is open AND visible.** The hook gates on
  `pr.state === 'open'` plus the pinned-tabs `activeTab` (a PrDetail mounted beneath the
  Activity overlay must not poll; `refetchIntervalInBackground:false` only covers
  `document.hidden`). On failure/429 it backs off exponentially to 60s, honoring
  `Retry-After` (surfaced via `ApiError.retryAfterSeconds`). Immediate-on-open = the same
  query's mount fetch. The header **Refresh** button is the `{wait:true}` variant through
  the SAME `['pr-refresh', prId]` key (`fetchQuery`), so button + poll share one in-flight
  state.
- **Probe-gated server-side** (the Phase-2 shape at PR grain): a per-`(accountId, prId)`
  in-memory ETag map (bounded FIFO, like the hydrate cache) + `ghRestGetConditional` on
  `/repos/{o}/{n}/pulls/{number}`. A 304 inside the floor window answers
  `{synced:true, changed:false}` at zero GitHub cost — an idle open pane costs ~nothing.
- **A ~30s forced-walk floor** (`WALK_FLOOR_MS`) — the PR-grain counterpart of Phase 2's
  1800s repo floor, much shorter because a human is watching: CI-finish/thread-resolve
  never bump `updated_at`, so a floor-forced walk is reported `changed:true`
  ("potentially-changed for checks") even when `updated_at` held still. Unlike the repo floor,
  this one DOES refresh those signals: it is a targeted `syncOnePr` of the viewed PR, with no
  `since` window to fall outside.
- **Any walk busts hydration BEFORE responding** (the resync-after-write order rule) —
  in lean mode checkRuns render only from the hydration overlay, so a walk that didn't
  bust it would hand the client's refetch a ≤60s-old snapshot.
- **`changed` is the client's only invalidation trigger**: `['pr', id]` + its cached
  thread keys + `['ml-labels', id]` + `['timeline']` + `['open-prs']` + **`['attention-cards']`
  + `['daily-brief']` + `['work-plan']`** on `changed:true`;
  NOTHING on false (a 5s timeline invalidation would churn the vis board). A probe-200
  walk whose `updated_at` didn't move is NOT changed (REST fields like `mergeable_state`
  churn ETags without real activity).
  ⚠ **The last three were added because the walk this poll pays for was invisible to the
  Pending board.** The walk writes fresh `state` / `mergeStateStatus` / `review_requests`, so a
  PR that merged, closed or went behind while its pane was open was already stale in the DB's own
  terms — and the board behind the pane kept the card for up to five minutes (its
  `refetchInterval`). The three are ONE FOLD READ THREE TIMES (`getWorkspaceInsights`), and they
  must be swept TOGETHER: `capFor` gates the board's "50 of 148" disclosure on
  `shown === count`, where `shown` is counted off the cards and `count` comes from the brief.
- **Never a 5xx on sync failure** — `{synced:false}` is a report (the SPA's Refresh icon
  turns amber: a stale note, not an error). A no-wait poll that stands down against an
  in-flight sync reports `synced:true` — that run's freshness IS the answer. The route
  deliberately does NOT use `enqueuePrSync` (the 4s debounce would swallow the cadence).
- **Rate tier `prDetail`** (pinned in `rate-limit.test.ts`); POST so the cross-origin
  guard applies; account-scoped resolve via the exported `getPrSyncTarget` (named in
  `verify-isolation.ts`). Cloud stays enabled — probe-gated is quota-safe in both modes.
- **Cost:** idle pane ≈ 720 free 304s/h; worst case ≈ 200–350 GraphQL pts/h per pane
  (floor walks + the client's re-hydrations) ≈ 4–7% of the 5,000/h budget.

---

## Pending-board liveness (POST /api/attention/liveness) ✅ BUILT

The refresh above makes ONE pull request fresh, for as long as somebody is looking at it. The
**Pending board** has the opposite shape: up to fifty PRs, none of them open in a pane, and its
whole cheapness comes from being served out of already-synced rows (`GET /api/attention` is
DB-only). So a PR merged, closed or unblocked **by somebody else** kept its card until the
adaptive scheduler next walked that repo — 2 min hot, 15 min cold. `sync/pr-liveness-sweep.ts` +
`useAttentionLiveness` close that with ONE batched question per board.

- **The per-card alternative is rejected on cost, permanently.** `GET /api/prs/:id/merge-options`
  is 4–5 upstream calls; fifty cards is 200–250 calls **to paint a screen**. That is the failure
  the board's no-fetch-on-mount rule exists to prevent, and this route is the sanctioned
  alternative to it, not an exception.
- **`nodes(ids:)`, on the `REACTION_NODES_QUERY` template** — scalars only, no connection
  arguments, so the whole query costs **1 GraphQL point** regardless of how many PRs it covers.
- **TWO PASSES, AND THE SECOND ONE'S BATCH IS 25.** ⚠ MEASURED 2026-09-03 against real open PRs:
  the scalar selection answers **90 ids in ~1.4 s**, but adding `mergeable` + `mergeStateStatus`
  **HTTP 502s at 50 ids after ~11 s**. GitHub does not store mergeability — asking for it runs a
  trial merge per PR — so the gateway times out long before the point cost matters. This is a
  WALL-TIME cliff, not the `reactors(first:1)` POINT cliff, and it bites in the same file.
  Expressed as one query with `@include(if: $withMergeState)` so the batch size and the selection
  are chosen by the same flag. **Total: 2 points, ~5–7 s per sweep.**
- **The expensive pass is a RANKED subset** (`rankForMergeStatePass`): PRs whose stored merge
  state already puts a Merge / Update-branch button on the board come first — a stale merge state
  there is a button that 405s — then everything still open, newest first. Anything already merged
  or closed is excluded: GitHub is not recomputing mergeability for it.
- ⚠ **AN OBSERVED `unknown` NEVER DEMOTES A KNOWN STORED VALUE**, a deliberate divergence from
  `persistPr`. GitHub answers UNKNOWN while the trial merge runs; `persistPr` rarely catches that
  window on a 2–15 min cadence, but a 60 s sweep sits in it — and clean→unknown→clean is a
  `changed` on every tick, i.e. a board refetching on a fixed timer with a GitHub call in front of
  it. Verified convergent on real data: sweeps reporting 8 then 14 changes settled to 0 and stayed
  there across three consecutive runs.
- **`changed` is BOARD movement, not "a row was written".** A `reviewDecision` GitHub merely
  restates moves no card (and most open PRs carry a null decision it restates every time), so it
  is written but not counted.
- ⚠ **THE CLIENT REFETCHES; IT NEVER SPLICES.** The response carries counts, never cards —
  structurally, so that "the probe proved this card is dead" cannot be implemented as a local
  removal. Each tab's count and its list come from one server response (and `/api/daily-brief`
  returns the same figures), so dropping one card locally would make a tab list fewer cards than its count
  claims. On `changed > 0` the SPA invalidates
  `['attention-cards']` + `['daily-brief']` + `['work-plan']` together. The same diff raises the
  PR change signal once per repo that moved (below), so every OTHER screen and tab catches up
  too, not just the board that asked.
- **One sweep per ACCOUNT at a time** (a synchronous in-flight claim released in `finally` on
  every bail path, thrown lookups included). Two tabs, or an interval overlapping its own focus
  refetch, report a no-op rather than paying twice.
- **Rate limits are pre-empted**: `isLimited` before asking, `noteBudget` from the query's own
  `rateLimit` block, `isRateLimitError` on failure → `noteLimited` + **degrade to empty**. An
  exhausted window comes back as `paused:{resumeAt}`, which the SPA renders as nothing at all —
  the board keeps its synced rows, exactly as before this route existed.
- **Rate tier `prDetail`** (60/min, pinned in `rate-limit.test.ts`); a POST because it carries an
  id LIST in a body (the `POST /api/reactions/lookup` shape) and so the cross-origin guard applies
  in cloud. `?workspace=` scopes it and is echoed; the id resolve is `accountId` ∩ workspace
  membership and is named in `verify-isolation.ts` — it is the only body-supplied id list in the
  app that then spends GitHub quota.
- **Cadence:** on mount, on window focus, and every 60 s while the board is visible ⇒ ~120
  GraphQL points/hour per open board, ~2.4% of the 5,000/h budget.

---

<a id="post-write-settle"></a>

## Post-write settle, the unsettled-PR backstop and the PR change signal ✅ BUILT

**Why.** GitHub acknowledges a write before it has finished with it. A push is attached to its
PR asynchronously, mergeability is computed only when somebody asks (UNKNOWN, or the old head's
verdict, for seconds to a minute), and CI moves later still. None of this changes the PR's
`updatedAt`, so no walk re-reads it. The conflict resolver's confirming step reported
`visible:true` on a row carrying the pushed head with GitHub's stale CONFLICTING/DIRTY, and the
Pending board showed the Conflicts card again. The server half is three modules below; the SPA
half (one write key set, a 5s `['repos']` poll for 150s after a write) is in
[FRONTEND.md](FRONTEND.md).

### `settlePrAfterWrite` — resync, verify, hand off (`sync/resync-after-write.ts`)

- A ~7s deadline starts at the call. The resync runs first, awaited in full (it queues behind a
  sync already in flight — the old resync contract), then the account-scoped `getPrSettleFacts`
  read (named in `verify-isolation.ts`).
- For a HEAD expectation only, up to 3 inline re-reads (gaps 1s / 1.5s / 2.5s) with no
  `waitForInFlight`, each RACED against the time left — a slow read carries on in the
  background. It stops early while rate-limited. Mergeability is never waited for inline.
- `visible` = the head expectation was met; with no head expectation it keeps the old meaning,
  "a resync ran".
- It hands off to the ladder when anything is unmet, a merge column is unknown, or a
  no-expectation resync failed. Never throws; `visible:false` keeps its copy contract (it will
  show up shortly, never a retry — a retry double-pushes).
- `resyncPrAfterWrite` keeps its signature and behaviour; the two share one body.

### `schedulePrSettle` — the ladder (`sync/pr-settle.ts`)

- One ladder per `(account, PR)`, re-reading at ~5s, 15s, 45s and 120s after the call.
- A newer call merges expectations and restarts the ladder: a newer head expectation replaces
  the old one, `notConflicting` stays set, and `mergeStateNot` / `ciNot` stay set unless the
  newer call restates them.
- **It stops** when the PR is no longer open, or when every expectation is met AND `mergeable` +
  `merge_state_status` are known (a draft needs only `mergeable`: its `merge_state_status` is
  `unknown` for ever).
- Expectations: `headSha` (the stored head must BE it), `headNot` (must differ from it),
  `notConflicting` (no stored CONFLICTING / DIRTY), `mergeStateNot` (an approval → `blocked`),
  `ciNot` (a rerun → the red status it re-ran). ⚠ **A stale DIRTY, BLOCKED or FAILURE is a KNOWN
  value**, so a ladder with no expectation stops on it at its first read. That is why the last
  three exist: a writer whose effect GitHub reflects late must STATE it, or it gets one read.
- A step that sees the head, verdict or CI move busts the PR-detail hydration cache.
- While `isLimited`, a step waits 60s and tries again (at most 70 times, then the entry is
  released) — never an error. At most 500 entries, oldest dropped first; every entry is released
  on every exit path, including a thrown lookup; timers are `unref`'d.
- No `waitForInFlight`, never `enqueuePrSync` (its debounce would swallow the cadence), and
  `refresh-pr.ts` is untouched.

**Who passes what:**

| Writer | Call | Expectation |
|---|---|---|
| Conflict resolver commit (`conflict/land.ts`) | `settlePrAfterWrite` | PR branch: `headSha` = the pushed commit, plus `notConflicting` ONLY for a FULL resolution (rebase is always full). New branch: none, and with `openPr` the new PR is synced by number inside the original PR's `(account, repo)` |
| `POST …/update-branch` | `settlePrAfterWrite`, awaited | local: `headSha` = the pushed sha; cloud: `headNot` = the previous head (GitHub returns no sha) |
| `POST …/approve` | resync, then `schedulePrSettle` | `mergeStateNot: 'blocked'` (an approval that does not satisfy protection costs the ladder's four reads) |
| `POST …/ci/rerun` | `schedulePrSettle` | `ciNot` = the stored status when it was `failure`/`error`. It follows the red status off for ≤120s, NOT the run to its finish — the stale-CI backstop or the open PR pane's poll reads that |
| AI Fix push (`coding/git-ops.ts` `applyAndPush`) | `settlePrAfterWrite`, NOT awaited | existing branch: `headSha` = the pushed commit, only when the pushed repo IS the PR's head repo (a fork PR's head can never become it). New branch: a targeted sync of the new PR. Not awaited because the plugin records the push only after `applyAndPush` returns |
| Auto-merge runner | `schedulePrSettle` | enqueue: none; rebase update: `headSha`; native update: `headNot` = the pinned oid |

### The trunk-moved recheck (`sync/unsettled-prs.ts`)

`noteMergeLanded` runs after every merge we land — the merge route, the runner's direct landing,
the runner's merge-queue landing (ours or outside auto-merge), and `DELETE …/merge-queue` finding
the PR already merged. It raises the change signal and re-reads up to 25 open non-draft PRs of the
repo at ~30s and ~90s, because each one's verdict now describes a base that no longer exists. A
burst of merges restarts both timers. PRs are ranked by `rankForMergeStatePass` (forward cards
first) and read through `fetchPrLivenessForNodes(withMergeState)` + `applyPrLiveness`, guards
unchanged (an observed unknown never demotes a known value); the 90s pass is the 30s pass's
second read. A route awaits `noteMergeLanded`, so the signal is raised before the reply; the
re-reads stay in the background.

### The unsettled-PR backstop (`runUnsettledPrBackstop`)

Fire-and-forget after every successful walk — the scheduled loop AND the manual `runSyncForRepo`
tail, never after a cancel:

- Up to 25 of up to 100 open non-draft PRs whose `mergeable` or `merge_state_status` is unknown or
  NULL, most recently updated first. PRs in their cooldown are excluded in the SQL, so they cannot
  crowd out the rest.
- Any answer still UNKNOWN gets ONE second read ~10s later: GitHub starts the computation on the
  first request (measured: UNKNOWN, then MERGEABLE/CLEAN ~8s later, same `updatedAt`).
- A PR still unsettled after two reads running — answered UNKNOWN, answered without the merge
  fields, or not answered — is skipped for 30 min. A read that fails with anything but a rate
  limit makes the backstop skip the repo for 15 min.
- CI `pending` whose latest `ci_status_events` row is older than 20 min (or absent) goes to the
  settle ladder: at most 5 per walk, a 20-min cooldown per PR. The liveness query carries no CI
  status and deliberately was not given one (it would change its measured point cost).
- Free — no token, no call — when nothing is unsettled; one recheck per `(account, repo)` at a
  time (a synchronous claim).
- ⚠ **IT NEVER ADVANCES `updatedAt`.** An observed newer `updatedAt` means activity the walk has
  not stored yet; stamping it early would hide that activity from the SPA's "newer `updatedAt` →
  refetch the PR detail" rule once the walk stores it.

⚠ **Deliberately NOT head-aware.** `PR_LIVENESS_NODES_QUERY` still omits `headRefOid` (`head_sha`
comes from `commits(last:1)`, a different source), and `persistPr` still writes UNKNOWN
unconditionally: a head-aware keep-known guard would keep a stale `clean` after a BASE move, which
is a Merge button that 405s.

### The PR change signal (`sync/pr-change-signal.ts`)

The SPA learnt about changes only from a finished WALK (`sync_state` on the `['repos']` poll).
Everything outside a walk — a webhook sync, a settle re-read, the backstop, the liveness sweep, a
write route's local stamp — was invisible to every screen but the one that made it.

- `notePrChanged(accountId, repoId)` keeps one timestamp per `(account, repo)` in memory: at most
  5000 entries, strictly increasing. Surfaced as the optional `Repo.lastPrChangeAt` on
  `GET /api/repos` ([API.md](API.md)); lost on restart, which is harmless.
- **`persistPr` raises it** (on every path: walk, webhook, resync, settle) only after its
  transaction commits, and only when a board-visible column moved — `state`, `isDraft`,
  `headSha`, `ciStatus`, `mergeable`, `mergeStateStatus`, `reviewDecision`, and the merge-queue
  pair only when the response carried it — OR GitHub's `updatedAt` moved (new reviews, comments,
  replies and commits are child rows). A first sighting counts ONLY for an OPEN PR: the deep
  backfill's hundreds of merged PRs would otherwise cascade a refetch on every SPA poll. The
  decision is `boardVisibleMoved` (`sync/upsert.ts`, exported for its test), over the `prev` read
  the transitions already made. It cannot see a thread resolved on github.com (`updatedAt` does
  not move).
- **Also raised by** the liveness sweep and the recheck (once per repo that moved), the
  merge-queue stamp when the stored value moved, merge landings, and the local stamps of the
  write routes (comment, review comment, approve, close, reopen, request reviewers, thread reply
  and resolve, both bot-thread resolves) through `notePrChangedForPr(s)`. ⚠ **A ROUTE AWAITS IT
  BEFORE REPLYING**: the SPA's write sweep reads `['repos']` first and treats the stamps it saw as
  covered, so a stamp raised after the reply would buy a second full refetch.
- ⚠ **NEVER A `sync_state` CURSOR.** `last_incremental_sync_at` is the walk cursor `planSync`
  derives `since` from; bumping it for a targeted change would make the next walk skip every PR
  updated in between.
- ⚠ **DIFF-GATED BY EVERY CALLER** — a bump costs the SPA a cascade of refetches, three of them on
  the `search` tier, so it must mean "something visible moved", never "a row was written".
- Server caches subscribe through `onPrChanged`: `db/daily-brief.ts` drops the account's roll-up
  counts, so an "Elsewhere" line cannot keep counting the old board for its 5-min TTL.

**Cost.** A write costs at most 1 resync, ≤3 inline re-reads and ≤4 ladder reads (~1 point
each). A landed merge costs 2 liveness merge-state reads (1 point each, ~5s). A walk costs nothing
extra when no PR is unsettled, otherwise 1-2 points plus ≤5 single-PR syncs for stale CI.

---

## Cross-cutting

| Item | Detail |
|---|---|
| **Config** (`config.ts`) | `GITHUB_APP_WEBHOOK_SECRET`; `WEBHOOK_DEBOUNCE_MS`; `SYNC_ADAPTIVE` (defaults `!isCloud`) + hot/warm/cold/floor interval knobs. `SYNC_CRON`'s default keys off `syncAdaptive` (`*/1` vs `*/5`) — the two must move together, so change them in one place. |
| **Schema** | **None** — Phase 1 routes by `(owner,name)` over existing `repos` rows; Phase 2 keeps cadence + `ETag` state **in-memory** (chosen over a `repos.lastChangeAt` column: lost on restart just means one immediate attempt after boot, harmless). No migration in either phase. The settle ladder, the backstop's cooldowns and the PR change signal are in-memory too, on the same reasoning. |
| **Isolation** | Targeted sync is `accountId`-scoped via the repo row. No new id-addressed *read* route, so exposure is minimal; still run `verify:isolation`. The settle and backstop reads outside `db/queries.ts` (`getPrSettleFacts`, `getPrRepoIds`, `getRepoMergeStateTargets`) are named in `verify-isolation.ts`, and the change signal is keyed by `accountId`. |
| **Tests** | signature-verify unit; payload → `enqueuePrSync` routing/fan-out to N accounts; debounce-coalesce; `syncOnePr` idempotency vs a fixture PR; conditional-probe 304-skip. |
| **Idempotency** | Everything routes through `persistPr`, so webhook + backstop + adaptive poll firing on the same PR never duplicate — the load-bearing guarantee in SYNC.md is preserved. |

## Sequencing & rough effort

1. **Phase 0** — targeted core + debounce queue. ~½–1 day. Shippable unused.
2. **Phase 1** — webhook route + signature + routing + backstop widen + docs. ~1–2 days. Highest payoff.
3. **Phase 2** — adaptive scheduler + conditional probe + floor. ~1 day.

Land 0 → 1 (webhooks are feasible there and the multi-tenant polling cost is worst) → 2.

## References

- GitHub GraphQL — no subscriptions: <https://github.com/orgs/community/discussions/120716>
- Webhook events and payloads: <https://docs.github.com/en/webhooks/webhook-events-and-payloads>
- Rate limits for GitHub Apps: <https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/rate-limits-for-github-apps>
- REST best practices (conditional requests): <https://docs.github.com/rest/guides/best-practices-for-using-the-rest-api>
- `gh webhook forward` (local, dev-only): <https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/using-the-github-cli-to-forward-webhooks-for-testing> · <https://github.com/cli/gh-webhook>
