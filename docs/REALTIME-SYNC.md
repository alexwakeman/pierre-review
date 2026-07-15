# Real-time sync — research & phased plan

> **Status: Phase 0 BUILT; Phases 1–2 planned.** This is the design for moving
> pierre-review's sync closer to real-time without increasing GitHub API usage, grounded
> in the current pipeline (see [SYNC.md](SYNC.md)) and in research on what GitHub actually
> offers. **Phase 0 (the shared targeted-sync core) is implemented and tested but not yet
> wired to any trigger** — it's inert until Phase 1 (webhooks) / Phase 2 (adaptive polling)
> call it. Phases 1–2 are still plan.

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
| Webhook feasibility | **excellent** — natural fit | **poor as primary** (see below) |
| Best lever | GitHub-App webhooks | adaptive + conditional polling |

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

## Phase 1 — cloud webhooks (the high-payoff phase)

**Route** `POST /api/webhooks/github` (`api/routes/webhooks.ts`):

- **Exempt from the auth gate** — add alongside `/api/health` + `/api/auth/*` in
  `registerAuthGate` (`api/plugins/auth.ts`). Its auth is the HMAC signature, not a session.
- **Raw-body gotcha:** signature verification needs the *raw* request bytes, but Fastify
  parses JSON by default. Register a route-scoped raw-body parser and verify
  `X-Hub-Signature-256` (HMAC-SHA256 with `GITHUB_APP_WEBHOOK_SECRET`) **before** parsing.
  Bad signature → 401; otherwise **2xx fast** (GitHub retries non-2xx, so do the sync work
  async after responding).
- **Routing needs NO new table.** `repos` is keyed `(accountId, owner, name)`, so read
  `repository.owner.login` + `repository.name` + the PR number from the payload →
  `SELECT id, accountId FROM repos WHERE owner=? AND name=?` → `enqueuePrSync` for each
  matching `(accountId, repoId)`. Multi-tenant fan-out is automatic; `getAccessToken(accountId)`
  resolves each account's own token. An account watching the same repo via OAuth-App (no
  install) even gets refreshed for free off another account's App-triggered delivery.
- **Events to subscribe:** `pull_request`, `pull_request_review`,
  `pull_request_review_comment`, `pull_request_review_thread`, `issue_comment`, `push`,
  `check_run`/`check_suite`. Optionally `installation`/`installation_repositories` to
  auto-add/remove watched repos on install changes.

**App config (ops, documented not coded):** set the App's webhook URL to
`<APP_BASE_URL>/api/webhooks/github` + a webhook secret + event subscriptions + the
matching read permissions. Add to `docs/GITHUB-AUTH-SETUP.md` / `docs/DEPLOY-RAILWAY.md`.

**Backstop:** keep the cron but widen the **cloud** cadence to 15–30 min (webhooks carry
freshness). It catches dropped deliveries (delivery isn't guaranteed) and serves OAuth-only
accounts. The existing `lastActiveAt` activity-gate stays.

**Net:** latency → seconds; baseline API usage drops sharply (quiet repos cost 0; a change
costs 1 targeted fetch instead of a windowed re-walk × every active tenant).

---

## Phase 2 — local adaptive polling + conditional probe

Local has no public endpoint, so the lever is **adaptive cadence**, made cheap with
**conditional requests**.

**Adaptive cadence.** Run the cron frequently (e.g. `*/1`) but inside `syncAllRepos` skip a
repo unless its per-repo **next-due** time has arrived, bucketed by recent activity:

| Bucket | Definition | Cadence |
|---|---|---|
| hot | produced new events in the last ~1h | every 1–2 min |
| warm | some recent activity | ~5 min (today's default) |
| cold | quiet for hours | 15–30 min |

The "did it change?" signal comes from `syncRepo` reporting whether the run persisted
anything new (it already knows per-PR) → stamp a per-repo `lastChangeAt`.

**Conditional probe (the cost-saver).** Before the fat GraphQL query, do a REST
**conditional** GET (`GET /repos/{o}/{r}/pulls?state=open&sort=updated&per_page=1` with the
stored `ETag`). A `304` costs **zero** rate limit, so a genuinely-idle repo is skipped
almost free — letting the hot cadence run aggressively without burning quota.

**The blind-spot floor (honest caveat).** `updatedAt` doesn't move for CI-finish or
thread-resolve, so the conditional probe can't detect those. Keep a **periodic full
re-walk floor** (≤ the cold cadence, e.g. every 15–30 min) so those signals still refresh
even when the probe reports "unchanged." This is exactly the gap webhooks close for free —
locally it's the right trade: near-real-time for the common signals, bounded staleness for
CI/thread-resolve on quiet repos.

**Net:** near-real-time where activity actually is, *lower* total API on quiet repos — the
opposite of naïvely dropping `SYNC_CRON`.

---

## Cross-cutting

| Item | Detail |
|---|---|
| **Config** (`config.ts`) | `GITHUB_APP_WEBHOOK_SECRET`; `WEBHOOK_DEBOUNCE_MS`; `SYNC_ADAPTIVE=true` + hot/warm/cold interval knobs; cloud backstop cadence. Local `SYNC_CRON` default unchanged for anyone who doesn't opt into adaptive. |
| **Schema** | Phase 1: **none** (routing by `(owner,name)`). Phase 2: one nullable `repos.lastChangeAt` + a per-repo `ETag` store — or keep both in-memory to avoid a migration (lost on restart = one extra full sync, harmless). If persisted, edit **both** `schema.sqlite.ts` + `schema.pg.ts` by hand + parity + `db:generate` + `db:generate:pg`. |
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
