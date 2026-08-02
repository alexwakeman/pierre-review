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
> Phase 0 (the shared targeted-sync core) is called only by Phase 1/2.

## The problem

Sync today is a **fixed-clock re-walk**: a `*/5` cron runs one fat `REPO_ACTIVITY_QUERY`
per repo and walks pages of the `since` window every tick (`sync/sync-manager.ts` →
`syncRepo`). It deliberately re-walks the whole window rather than short-circuiting on
`updatedAt`, because **GitHub doesn't bump a PR's `updatedAt` for every signal we care
about** (CI finishing, a review thread being resolved) — see SYNC.md
"Incremental updates".

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

**The blind-spot floor (honest caveat).** `updatedAt` doesn't move for CI-finish or
thread-resolve, so the probe can't detect those. A **re-walk floor**
(`SYNC_FLOOR_INTERVAL_SEC`, 1800s) forces a full walk at least that often even on a `304`,
so those signals still refresh. This is exactly the gap webhooks close for free — locally
it's the right trade: near-real-time for the common signals, bounded staleness for
CI/thread-resolve on quiet repos.

**Net:** near-real-time where activity actually is, *lower* total API on quiet repos — the
opposite of naïvely dropping `SYNC_CRON`.

---

## Cross-cutting

| Item | Detail |
|---|---|
| **Config** (`config.ts`) | `GITHUB_APP_WEBHOOK_SECRET`; `WEBHOOK_DEBOUNCE_MS`; `SYNC_ADAPTIVE` (defaults `!isCloud`) + hot/warm/cold/floor interval knobs. `SYNC_CRON`'s default keys off `syncAdaptive` (`*/1` vs `*/5`) — the two must move together, so change them in one place. |
| **Schema** | **None** — Phase 1 routes by `(owner,name)` over existing `repos` rows; Phase 2 keeps cadence + `ETag` state **in-memory** (chosen over a `repos.lastChangeAt` column: lost on restart just means one immediate attempt after boot, harmless). No migration in either phase. |
| **Isolation** | Targeted sync is `accountId`-scoped via the repo row. No new id-addressed *read* route, so exposure is minimal; still run `verify:isolation`. |
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
