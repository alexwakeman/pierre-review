# Security & privacy posture

> Split out of CLAUDE.md (2026-08) to keep the root memory file lean. This is the
> authoritative deep-dive for this area; CLAUDE.md keeps only the summary and the
> cross-cutting landmines. Add new detail HERE, not to CLAUDE.md. References to other
> sections of the old CLAUDE.md resolve via the doc map at the top of CLAUDE.md.

## Security & privacy posture (read before touching app.ts, CORS, or any AI route)

Hardened for public release (2026-07-26). Two new **zero-dependency** core plugins own it —
deliberately hand-rolled rather than `@fastify/helmet`/`@fastify/rate-limit`, because a new
runtime dep must also be threaded through the curated release manifest + the pinned lockfile,
and helmet's default CSP is wrong for this app three ways over.

**`api/plugins/security.ts`** — registered FIRST in `app.ts` so headers ride on every response
(redirects, 404s, static assets):
- **CSP per surface**: `/api` → `default-src 'none'`; `/app*` → the SPA policy; else the landing
  policy. `style-src 'unsafe-inline'` is unavoidable and accepted (React style attrs +
  vis-timeline positions items by mutating `element.style`); **`script-src` stays strict** — no
  `'unsafe-inline'`, no `'unsafe-eval'` (verified: no `eval`/`new Function` in vis-timeline /
  vis-data / vis-util). `img-src https:` is REQUIRED — comment bodies are third-party markdown
  embedding arbitrary hosts. Google origins enter the CSP **only in cloud**.
- nosniff, `X-Frame-Options: DENY` + `frame-ancestors 'none'`, `Referrer-Policy:
  strict-origin-when-cross-origin` (app URLs carry repo/PR ids), `Permissions-Policy`, COOP;
  `/api` also gets `Cross-Origin-Resource-Policy: same-origin` + `Cache-Control: no-store`.
  HSTS + the www→apex 301 moved here from `app.ts` (still cloud-gated).
- **`corsOriginDelegate` — CORS is now an ALLOWLIST IN BOTH MODES.** Local mode was
  `origin: true` (reflect ANY origin) *and* has no auth (every request resolves to account 1),
  so **any page the developer had open could read their whole synced GitHub dataset
  cross-origin and drive their write actions**. That was the audit's one CRITICAL. Local now
  allows any **loopback** origin on any port (dev 5173/5174, demo 5273, the packaged CLI's own
  port); cloud allows exactly `config.appBaseUrl`. `ALLOWED_ORIGINS` adds more.
- **`registerCrossOriginGuard` — NOT redundant with CORS.** CORS only decides whether the
  attacker's page may READ the response; a simple cross-origin POST is still delivered and still
  executes. Rejects state-changing `/api` calls whose `Sec-Fetch-Site: cross-site` (falling back
  to `Origin`); header-less clients (curl/CLI/webhooks) pass, since CSRF needs a browser. Also
  guards the mutating GET `/api/auth/reconnect`. Exempts the HMAC-authenticated webhook routes.
- **`registerHostGuard`** (local, loopback binds only) — 421s a non-loopback `Host`, the
  DNS-rebinding case that survives every origin check. `ALLOWED_HOSTS` opts a named host back in.

**`api/plugins/rate-limit.ts`** — fixed-window buckets keyed by **accountId** (the thing that
spends money), IP fallback for unauthenticated routes. Registered AFTER `registerAccountContext`.
Tiers: `ai` 20/min **+ `ai_hourly` 120/h**, `pr_detail` 60/min, `github_write` 60/min, `sync`
20/min, `search` 60/min, `auth` 30/min, `webhook` 600/min, `read` 600/min. **Landmine: Claude
Review kept its PRE-plugin paths** (`/api/prs/:id/claude-review*`, `/api/claude-reviews/*`,
`/api/claude-findings/*`), so `tierFor` matches those EXPLICITLY — a `/api/pro/` prefix test
would leave the most expensive routes on the 600/min read tier. `RATE_LIMIT_DISABLED=true` is the
escape hatch; `RATE_LIMIT_<TIER>` tunes a bucket. The `pr_detail` matcher covers `GET
/api/prs/:id` **plus `/merge-options`, `/files`, `/checks/:jobId/logs` and `/suggested-reviewers`**
— it was anchored to the bare id "because the sub-routes are DB-only reads", which was true when
written and quietly stopped being true, leaving the most GitHub-expensive GETs in the family on the
blanket bucket. **That mistake was then made twice**: the first fix asserted, in `tierFor`'s own
comment AND in a test, that `suggested-reviewers` "really is DB-only" — but
`enrichReviewerSuggestions` takes an access token (`github/reviewer-suggest.ts:35`), reads CODEOWNERS
over REST (`github/codeowners.ts`) and infers review teams over GraphQL (`github/team-reviewers.ts`).
Per-`(account, repo)` TTL caches make repeats free, but a cache-cold loop spends quota. **When in
doubt, follow the token** — and note that the passing test was pinning the wrong answer, so a test
agreeing with the code is only evidence of intent when the code is right. Genuinely DB-only and
correctly on `read`: `/bot-behaviour`, `/bot-dedup`, `/mention-candidates`, the retrieval-only
`/claude-review`, the cached `GET …/annotations`, `GET /api/auto-merge` and `GET /api/branch-status`.

**Fastify factory hardening** (`app.ts`): `trustProxy: config.isCloud` (Railway proxies — without
it the limiter's IP fallback collapses into one bucket; NOT set locally, where it would let a
client choose its own key), `bodyLimit` 256 KiB, `requestTimeout` 60s,
`routerOptions.maxParamLength` 200 (top-level is FSTDEP022-deprecated), and a pino **`redact`**
list — an `err` from a failed HTTP call carries the outgoing `Authorization: token gho_…` /
`x-api-key: sk-ant-…` headers and pino serializes errors deeply.

**Other fixes worth knowing:**
- **`error-handler.ts`**: 5xx bodies are GENERIC in cloud (`err.message` on a 500 is whatever
  Postgres/GitHub/Anthropic said — query fragments, paths, upstream bodies). 4xx stay verbatim
  (author-written contract text); local passes 5xx through (the operator IS the caller).
- **`db/queries.ts` `listUsers(accountId)`** — `users` stays GLOBAL storage but the LISTING is
  account-scoped via 6 correlated subqueries (event actors, PR authors/mergers, requested
  reviewers, review + comment authors). Unscoped, it handed any tenant every other tenant's
  synced contributors. **`PATCH /api/users/:id` + `setUserBot` were DELETED** — a global,
  ownership-free write of the sticky `isBotOverridden` flag, with no frontend caller; bot
  classification is the account-scoped `PATCH /api/bot-reviewers/:userId`.
- **`getTimeline`**: window CLAMPED to `config.retentionDays` in the route + hard row caps
  (`TIMELINE_PR_ROW_CAP` 5k / `TIMELINE_EVENT_ROW_CAP` 20k, newest-first) returning
  `truncated?: true`. `?from=1970&to=2100` used to materialise the whole retained dataset.
- **`github/codeowners.ts` ReDoS**: each `**/` compiled to its own nullable `(?:.*/)?`, so
  `('**/' × 14) + 'zzz.txt'` in a repo-supplied CODEOWNERS froze the single-threaded server for
  every tenant. Runs of `**/` are now COLLAPSED (semantically identical) + caps on file size,
  rule count, pattern length and paths matched.
- **`github/auth.ts`**: `gh auth token` is CACHED (5-min TTL + in-flight coalescing) and has an
  async form. `getAccessToken` used the SYNC one on every request — 50–300ms of blocked event
  loop plus a forked process per request.
- **`sync/hydrate-detail.ts`**: 60s cache + in-flight map. **`persistBodies` is FALSE by default
  in BOTH modes** (the old module comment claimed otherwise), so every `GET /api/prs/:id` ran
  `PR_DETAIL_QUERY` against GitHub — a loop over ids drained the tenant's 5k points/hour.
  **A write that must be visible IMMEDIATELY has to bust that cache** —
  `invalidatePrHydration(accountId, owner, name, number)`. Deleting the cache entry alone is NOT
  enough: a fetch started *before* the write is still in the in-flight map, and the next reader
  would join it and be served pre-write text. So the invalidator also bumps a per-key **epoch**,
  and `fetchGhPrText` refuses both to cache a result whose epoch moved and to share an in-flight
  fetch that began in an older epoch.
- **`sync-manager.ts`**: per-repo manual-sync cooldown (`manualSyncCooldownMs`, 5 min forced-full
  / 30s manual) + `apiSyncSlotsExhausted()` cap (4) → 429 from the route. Also added the missing
  `await` on `runSyncForRepo` (the 409 branch was dead).
- **`review/agent.ts`**: **`Bash` REMOVED from `WORKTREE_TOOLS` and denied outright.** A review
  reads attacker-authored text (title/description/diff/comments); with `bypassPermissions` + a
  shell that is RCE on the developer's machine via a stranger's PR. The old
  `Bash(rm *)`-style blocklist was never a boundary. Both review prompts + the AI-Fix prompt
  gained explicit **untrusted-input / prompt-injection** instructions.
- **Cross-tenant in-memory state (plugin)**: `getReviewStatus`, `listActiveReviews(accountId)`,
  `requestReviewCancel(prId, accountId)` and `getFixStatus` all key on prId in PROCESS-GLOBAL
  maps — they now verify the entry's own `accountId`, and the claude-review SSE stream checks PR
  ownership BEFORE `reply.hijack()` (the ai-fix pattern). Previously a foreign running PR
  streamed another tenant's live agent activity (file paths + source snippets).
- **Slack webhook SSRF (plugin)**: `normalizeSlackWebhookUrl` is an ALLOWLIST
  (`https://hooks.slack.com/services/…` only, exact host — not `endsWith`), enforced at BOTH the
  storage and the `fetch` sink, `redirect: 'error'`, and the response body no longer comes back
  in the error (it was a read primitive against the Railway private network).
- **`resolution-check` fan-out (plugin)**: `MAX_TARGETS_PER_BATCH` 50 + per-account in-flight set
  + 30s interval + abort wiring on the JSON twin. One billed LLM call per thread, uncapped, on an
  app built for bot-flooded PRs.
- **402 entitlement gate** (`plugins/auth.ts` `isProPath`) now covers the non-`/api/pro/`
  Claude-Review paths. Latent today (agentic is off in cloud) — real the day it is enabled.
- **`assertCloudConfig`** now rejects a `SESSION_SECRET` under 32 bytes or a placeholder (it is
  stretched by a single SHA-256 into the session sealing key, bypassing secure-session's own
  minimum + its slow KDF, so a weak one is brute-forceable → forge any account's cookie), and a
  non-https `APP_BASE_URL` (the cookie's `secure` flag derives from that scheme).
- **SQLite file perms** 0600 + dir 0700 (incl. the `-wal`/`-shm` siblings).
- **Dockerfile** runs as `USER node`, not root. **CI** gained a **blocking** `pnpm audit
  --audit-level high --prod`; all 8 highs that existed were cleared (see Dependency posture).
- **`.gitignore`** is `.env*` + `!*.example` — it was `.env` + `.env.local` only, and the docs
  tell readers to create `.env.cloud` with `SESSION_SECRET`/`ENCRYPTION_KEY` in it.

**GDPR / privacy.** GA4 is now **consent-gated in BOTH bundles** (`lib/consent.ts` +
`CookieBanner`, storage key shared so answering on the landing carries into the app): gtag.js is
never FETCHED before an explicit grant (configuring-but-denying still contacts Google), Consent
Mode v2 defaults denied, Google Signals + ad personalisation off, withdrawal deletes the `_ga`
cookies. **The brand font is SELF-HOSTED** (`src/fonts/*.woff2`, relative `url()` so Vite
base-prefixes it to `/app/`) — the Google Fonts `<link>` leaked every viewer's IP to Google
(breaking local mode's no-phone-home promise) and forced an inline `onload` handler that would
have needed `script-src 'unsafe-inline'`. New landing routes **`/privacy`, `/cookies`, `/terms`**
(+ footer column, sitemap, a terms line on `SignInGate`). Data-subject rights are SELF-SERVICE:
`GET /api/me/export` (`db/export-account.ts` — explicit column lists; the sealed token is NEVER
in the output) and `DELETE /api/me/account` (`db/erase-account.ts`, confirm-by-typing-your-login,
refused in local mode). Erasure reuses `deleteRepo` per repo, then the enumerated account-level
tables, then calls the **new optional `ctx.registerAccountErasure` seam** so the plugin drops its
own 14 account-scoped tables (`eraseProByAccountId`).
**Landmine: `accountScopedTables()` in `erase-account.ts` is a CHECKLIST the test iterates** — a
new `accountId`-bearing table that isn't added there fails `erase-account.test.ts` rather than
silently surviving a deletion the user was told was complete. (It caught `teamRepos` once already.)
The Workspace refactor took **FOUR** entries out (`repoReviewers`, `accountReviewers`, `teams`,
`teamRepos`) and put **THREE** in (`workspaces`, `workspaceRepos`, `workspaceReviewers`) — the net
drop of one is correct and intended (two bot tables collapsed into one), and it is spelled out here
because an off-by-one in a checklist is exactly how a table gets missed. ⚠ **`workspaceRepos`
carries its own `accountId`, not only `workspaceId`/`repoId`**, so it belongs on the list in its own
right rather than as a cascade dependent. `eraseAccountData` deletes child-before-parent
(`workspaceReviewers` → `workspaceRepos` → `workspaces`) inside one transaction: Postgres checks FKs
immediately, so relying on the cascades alone would be dialect-dependent. `export-account.ts` was a
RENAME, not an addition — both bot collections became the single `workspaceReviewers`, and `teams`
became `workspaces` with each row carrying its `repoIds`.

**Dependency posture (2026-07-26).** The dev tree went from `8 high / 10 moderate / 1 low` to
`1 moderate / 1 low`, and **the PUBLISHED npm package audits clean — 0 vulnerabilities**. CI now
BLOCKS on high. (The two are different trees: root `pnpm.overrides` do NOT travel with the
published manifest, so the release was audited separately as an `npx` user would receive it.) Two of the fixes were live vulnerabilities in
code this app actually runs, so they are worth knowing:
- **`@fastify/static` 9.1.3 → ^10.1.2** — route-guard bypass via path traversal + a
  non-canonical-path authorization bypass. This app serves TWO static roots. v10 needed no code
  change; verified against the packaged release (SPA index, deep links, hashed assets, the
  self-hosted font, `/` → 302, JSON 404 on unknown `/api`, and five traversal payloads — no leak).
- **`drizzle-orm` 0.38.4 → ^0.45.2** — SQL injection via improperly escaped SQL identifiers, in
  the whole query layer. Also bumped `drizzle-kit` → ^0.31.10, and `fastify` → ^5.10.0.
  **`packages/pro` declares the same two as devDeps and MUST stay in lockstep**, or the plugin
  type-checks against a different drizzle than `ctx.db` actually is.
- Transitives no direct bump reaches are pinned in root `pnpm.overrides`: `fast-uri` ^3.1.4,
  `find-my-way` ^9.7.0, `hono` ^4.12.32, `@hono/node-server` ^2.0.12, `shell-quote` ^1.9.0
  (arrived with drizzle 0.45's `gel`), and `brace-expansion@>=3.0.0 <5.0.7` → ^5.0.8 — note the
  **scoped selector**: a blanket pin would drag 1.x/2.x consumers onto a different major.
- **`node-cron` 3.0.3 → ^4.6.0** cleared the last advisory from the published package (v3
  pinned a vulnerable `uuid`). `@types/node-cron` was DROPPED — v4 ships its own typings and the
  DefinitelyTyped stub is for v3. Only four API surfaces are used (`schedule`, `validate`,
  `ScheduledTask`, `task.stop()`) and all survive; verified at runtime that `schedule()` still
  AUTO-STARTS without an explicit `.start()` (the sync loop depends on it) and that `stop()`
  halts it.
- **Knowingly left below the gate in the DEV tree only**, neither shipped nor reachable: `uuid`
  (moderate — via `vis-data`, and the bug needs v3/v5/v6 with a `buf` argument; vis-data calls v4
  with none) and `body-parser` (low — inside express inside the MCP SDK, an AI dep that ships in
  no release artifact).
- **Verification beyond the unit suite** (which runs on SQLite only): a Postgres smoke on a
  throwaway container exercised `getTimeline` / `getActivity` / `getOpenPrs` / `getMyTurn` /
  `getMergers` / `listUsers` / `getConsolidatedFeed` / `searchPrs` (raw-`sql` templates) /
  the scope resolver / the workspace metrics getter — 10/10 on drizzle 0.45 + node-postgres, plus
  pg migrations from empty. **Gotcha found doing it:** `DROP SCHEMA public CASCADE` does NOT
  reset a pg dev database — drizzle keeps its journal in a separate `drizzle` schema, so the
  migrator then reports "Migrations applied" having done nothing. Drop both schemas.
- Fastify 5.10 deprecated the top-level `disableRequestLogging` (FSTDEP023); it moved to
  `logController: new LogController({...})`. Same class of fix as `routerOptions.maxParamLength`
  — a boot-time deprecation warning is noise in the terminal of every packaged-CLI user.

**Tests:** `api/plugins/security.test.ts` (15), `api/plugins/rate-limit.test.ts` (15),
`db/erase-account.test.ts` (8), a codeowners ReDoS regression, and
`packages/pro/test/slack-webhook-url.test.ts`.

**Two suites exist that CI does not run — a known gap, both needing a devDependency + script
decision (each would touch the root lockfile, which is why neither was taken unilaterally):**
- `packages/pro/test/` — **9 files / 135 tests**, runnable via `packages/pro/vitest.config.ts`
  (which aliases `better-sqlite3` to the backend's copy and exports a PLAIN object, since
  `vitest/config` is unresolvable from a package without vitest): `./apps/backend/node_modules/.bin/vitest
  run --root packages/pro`. The plugin still declares no `test` script and no vitest devDep, so
  `pnpm -r test` skips it — including its cross-account isolation suite, whose fixture replays a
  **hardcoded, curated** plugin-migration list against an in-memory SQLite holding only plugin
  tables (so plugin `0020`, which reads core `workspaces`, needs a minimal core stub in that
  fixture) and whose scope-isolation assertions are non-vacuous only because its seeded rows use
  the `ws:` vocabulary.
- `apps/frontend/test/` — **9 files / 127 tests**, same arrangement (`apps/frontend/vitest.config.ts`,
  `include` pinned to `test/**` so vitest can't collect the Playwright `e2e/*.spec.ts` and fail).
  Kept OUTSIDE `src/` so `pnpm typecheck` never tries to resolve the uninstalled vitest types.
  Where the pure logic extracted from components is pinned: `annotationRun.test.ts`
  (`annotationRunMessage`), **`workspaceScope.test.ts`** (persistence of `workspaceId` — that all
  five legacy `teamScope` shapes are DISCARDED not coerced, that it is absent from
  `pickFilterBarState` so "Clear filters" can't teleport you into Default, and that the wire emits
  `?workspace=` always-once-resolved and `repoIds` **including when empty**),
  `botReviewerQueryKey.test.ts` (the three-segment key, and that a `repoIds`-narrowed listing never
  shares a slot with the workspace-wide one `useBotColors` reads), `botReviewers.test.ts`,
  `botCost.test.ts`, `resolvableBotThreads.test.ts` and `checksRow.test.ts`; `prRef.test.ts`
  predates them all. (`teamScope.test.ts` was DELETED with the canonicalisers it pinned.)
  **`workspaceOpenPrsScope.test.ts`** pins the Timeline-only-picker rule from the client side: the
  two open-PR search builders must disagree **exactly once** — when the board is narrowed —
  `buildOpenPrsSearch` honouring `filters.repoIds` (Timeline) and `workspaceOpenPrsSearch` ignoring
  it (Activity). Both failure modes are silent: pick up `repoIds` on the Activity side and a list
  comes back short, scoped by a control that is not on screen; let the two strings diverge in the
  common case and they stop sharing a React Query cache entry (the key IS the string), so the same
  list is fetched twice forever with both copies rendering correctly.
  ⚠ **Known hole, flagged in that file's own header:** the legacy `?team=` URL rule lives in
  `readWorkspaceFromUrl`/`readFromUrl` in `hooks/useUrlState.ts`, neither of which is exported, so
  re-implementing it in the test would pin a copy rather than the code — it is unit-tested nowhere.

The backend suite itself is **55 files / 534 tests** and DOES run in CI. Dropping the "watched"
concept added **`db/my-turn-new-prs.test.ts`**, which pins My Turn's clock: an open, non-draft PR by
a non-bot human other than you enters the "New PRs" section iff `openedAt >= repos.createdAt` FOR
ITS OWN REPO. It seeds two repos added eight days apart and — the case a lax fixture misses — a PR
in the later repo that clears the EARLIER repo's cutoff, so a single global cutoff fails it. Three
mutations were run against `getAddedRepoActionablePrIds` to prove the assertions bite: dropping the
comparison (caught by the before-cutoff PR), replacing the per-repo lookup with a global minimum
(caught by that cross-repo PR), and `>=` → `>` (caught by the exactly-at-cutoff PR). The
you-authored-it / bot-authored / draft exclusions are seeded as controls in the same loop. The
Workspace refactor renamed
`db/team-comparison.test.ts` → `db/workspace-comparison.test.ts` (dropping the `TeamScope`
wire-form cases — there are no wire forms — and keeping the two-way account scoping with a seeded
second account so the negative check isn't vacuous) and rewrote `db/bot-reviewer-grains.test.ts` →
**`db/workspace-reviewer.test.ts`**, which pins the same six directions in PAIRS now that there is
no table boundary to do it: a judgement patch leaves identity + price byte-identical and vice versa,
a cost write leaves everything else alone, a full `classifyReviewer` pass honours each provenance
flag independently, the identity RESET actually re-derives (`kind` non-null again), and **a
`setReviewerCost` in workspace A leaves that actor's rows in B and C byte-identical** — including a
row already holding a *different* price and a row whose price is still NULL. The three team-keyed
bot suites (`bot-cost-per-team`, `bot-vendor-prs-team`, `detected-reviewers-scope`) were deleted
with the grain they tested. `vitest.config.ts` raises `hookTimeout` to 30s because a dozen suites
migrate a throwaway SQLite DB in `beforeAll` and lost the 10s default under parallel load — failures
that look exactly like real regressions (a different subset each run, always in a hook, never an
assertion).


