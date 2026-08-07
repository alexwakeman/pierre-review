# Open-core Pro plugin, Activity tab & the bot platform

> Split out of CLAUDE.md (2026-08) to keep the root memory file lean. This is the
> authoritative deep-dive for this area; CLAUDE.md keeps only the summary and the
> cross-cutting landmines. Add new detail HERE, not to CLAUDE.md. References to other
> sections of the old CLAUDE.md resolve via the doc map at the top of CLAUDE.md.

## Open-core Pro plugin (`@pierre/pro`) + the Activity tab

Three workstreams sit behind one **open-core seam**: the public repo holds only the
contract + a guarded import + inert hooks; **all premium logic lives in the private,
runtime-imported `packages/pro`** package. Docs: **[docs/PRO-PLATFORM.md](docs/PRO-PLATFORM.md)**.

**`packages/pro` is a PRIVATE git submodule** (`github.com/alexwakeman/pierre-pro`, SSH).
A pure-OSS checkout of `pierre-review` does **not** have it — `git clone` leaves
`packages/pro/` empty unless you `git submodule update --init` with access. Because the
public repo is genuinely public, the premium source must never be committed here; only the
`.gitmodules` entry + the submodule gitlink are public. It IS a `pnpm` workspace member
(`packages/*` glob) when checked out, so `pnpm install` installs its deps into
`packages/pro/node_modules`; when absent the glob skips the empty dir and install still
succeeds.

**Three tiers.** **core (free)** = plain feed + timeline + **My Turn / "FYI"** (feed participation —
moved back to core, on every tier; see `feed/my-turn.ts`), no AI. **pro** = AI summaries +
Insights (on whenever the plugin is active — no env flag, like `workspaceInsights`/`reviewMemory`).
**pro+** = the expensive advanced-AI features **AI Analysis + AI
Fix + Claude Review**, all gated together by **one** env flag **`PRO_ADVANCED_AI_ENABLED`**
(`PRO_CLAUDE_REVIEW_ENABLED` kept as a back-compat alias; the single source of truth is
`packages/pro/src/tier.ts` `ADVANCED_AI_ENABLED`, read by `index.ts` for the caps AND by each
feature's route/manager self-gate). The `aiAnalysis`/`aiFix`/`claudeReview` capability fields
remain distinct but flip together.

**The plugin boundary.** `src/pro/contract.ts` defines `ProContext` (the host hands the
plugin `db`/`schema`/`runTransaction`/`isPg`/`accountIdOf`/`llm.complete`/`queries`/
`reviewEvents`/`registerLearningsProvider`/`registerScheduledJob`/`registerPrDetailEnricher`/`registerMigrations`/`aiCredits`), `ProPlugin
{apiVersion:14, register()}`, and a `getProCapabilities()` singleton mirrored to the SPA via
`/api/me` (`pro:{activityDigest,reviewMemory,aiAnalysis,prSummary,aiFix,workspaceInsights,claudeReview,slackDigest,issueLinks}`)
exactly like `claudeReviewEnabled`. `src/pro/bind.ts`
runs in `index.ts` between `buildApp()` and `listen()`: gated on **`config.proEnabled`** — now
`PRO_DISABLED!=='true' && (!isCloud || PRO_CLOUD_ENABLED==='true')`, so Pro is on locally by default
AND can run the **paid summary-AI tier in cloud** behind `PRO_CLOUD_ENABLED=true` (agentic AI stays
off via unset `PRO_ADVANCED_AI_ENABLED`; per-account entitlement via `plan!=='free'` + the
`/api/pro/* 402` gate). It is **NOT a declared dependency** — instead `bind.ts` resolves the plugin by
**filesystem path** (`PRO_PLUGIN_PATH` override → `packages/pro/dist/index.js` → `packages/pro/src/index.ts`,
relative to the repo root via `import.meta.url`) and `await import(...)`s it. **Absent submodule ⇒ no entry file ⇒
clean OSS no-op, and `pnpm install` never fails** (the public-CI path). The path-based loader
(not a bare `@pierre/pro` specifier / workspace dep) is what keeps install working without the
submodule — don't reintroduce a `package.json` dependency on it. The plugin imports **no host
internals** — everything arrives via `ctx`; `ctx.db` is node-postgres-typed so a stray `.get()`
is a compile error in the plugin too. It resolves under **tsx** (dev, `src/index.ts`); a built
`node dist` run would need `packages/pro/dist` (no build step yet — Pro is local/dev-only). The
plugin is **never in the release allowlist** (`build-release.mjs`). Plugin owns its **own**
dual-dialect tables (`review_learnings`, `repo_digests`), migrations
(`packages/pro/migrations{,-pg}/*.sql` run via `ctx.registerMigrations` → `src/pro/migrate.ts`,
the one sanctioned raw-`$client` DDL site + `pro_migrations` bookkeeping), and isolation test.

**`apiVersion` is 14** (bumped from 13 by the Workspace refactor — a breaking `ProContext` change).
⚠ **FOUR literals must agree, not two**, and the one that actually enforces the handshake is the
easiest to miss: `apps/backend/src/pro/contract.ts` (the host's declared `ProPlugin['apiVersion']`),
`packages/pro/src/index.ts` (the plugin's exported value), `packages/pro/src/contract-types.ts` (the
plugin's mirror), and **`apps/backend/src/pro/bind.ts`'s `plugin?.apiVersion !== 14` — THE RUNTIME
GATE**. A half-bump makes `bind.ts` log-and-degrade the ENTIRE plugin to OSS mode: capabilities dark,
every `/api/pro/*` 404, nothing thrown. ⚠ **Nothing currently PINS the handshake** —
`pro/contract.test.ts` asserts capability KEYS (it was updated for the `workspaceInsights` rename)
and contains no `apiVersion` reference at all, so the only detection is `tsc` (TS2367 no-overlap at
the `bind.ts` gate, assignability at `index.ts`) plus a boot check that `/api/me` reports
`pro.workspaceInsights === true`. An assertion pinning the plugin's exported value against
`ProPlugin['apiVersion']` is still worth adding. What v14 changed:

- **`BotScopeWire = { workspaceId: number; repoIds: number[] }`** replaces `repoIds?: number[] |
  null` on `getActivity`, `getBotAnalytics`, `getBotReviewComments`, `getHumanReviewComments` and
  `getWorkspaceInsights` (was `getTeamInsights`); `getWorkspaceMetricsDetail` (was
  `getTeamMetricsDetail`) takes a REQUIRED `repoIds: number[]`.
- **NEW `ctx.queries.workspaceScopeForRepo(accountId, repoId)`** — the repo→workspace direction, for
  the two plugin call sites that hold only a repo id (`insights/routes.ts`'s
  `GET /api/pro/insights/repo/:repoId/metrics`, `activity-digest/metrics.ts`'s digest payload
  builder). Without it both are unimplementable.
- **NEW `ctx.queries.defaultWorkspaceId(accountId)`** — for the two ACCOUNT-WIDE CRON paths that
  have no request and therefore no `?workspace=` (the Slack digest and the AI-policy sprint
  refresh). It is a signature change, not vocabulary: their old `scope = 'all'` default has no image.
- Capability **`teamInsights` → `workspaceInsights`**; the other nine fields (`botTriage` included)
  are untouched.
- `ctx.schema` automatically exposes `workspaces`/`workspaceRepos`/`workspaceReviewers` and no
  longer exposes `teams`/`teamRepos`/`repoReviewers`/`accountReviewers`. ⚠ **`tsc` will NOT catch a
  leftover**: `ProCoreSchema` is `Record<string, any>`, so `ctx.schema.teams` type-checks perfectly,
  evaluates to `undefined`, and drizzle throws only when that path executes. Grep, don't trust the
  compiler.
- `insights/scope.ts` → `insights/workspace-scope.ts`, down to ~25 lines: `parseWorkspaceId`,
  `scopeKeyFor(workspaceId) → \`ws:${id}\`` and `resolveWorkspaceRepoIds`. `normalizeScope`,
  `teamSetIds` and `resolveScope`'s five branches are deleted. `resolveWorkspaceRepoIds` returns
  **exactly the workspace's repos** — there is no second set to intersect with. It briefly
  intersected `repos.inboxWatch = true` (the AI corpus was the WATCHED set, so an unscoped sprint
  report / grounded chat / Themes pass would not bill for repos the user had un-watched) but that
  column is gone with the whole watch concept (migration `0046` / pg `0033`), and the bound it was
  really providing — "an AI pass must not fan out past the scope the user chose" — is now provided
  by the workspace itself. ⚠ **The bound still has to hold**: an unscoped AI generator must resolve
  to ONE workspace's repos and never to the account's, which is what `defaultWorkspaceId` is for
  (below).
- ⚠ **The `scope_key` COLUMN NAME did not change; its VOCABULARY did**, to `ws:<workspaceId>`. The
  `ws:` prefix is deliberate: a bare number would alias a legacy `'3'` (team 3) onto workspace 3,
  whose repo set differs, and a stale cached AI report would then be served for the wrong repos.
  Plugin migration `0020` clears the four regenerable report caches and RE-KEYS the two
  user-authored tables (`pinned_prompts`, `sprint_chat_history`) by case; the prefix is what makes
  a partial replay a cache MISS rather than a wrong answer.

**Activity tab — CORE, always-on, NO AI (not flagged); the DEFAULT landing view.** A peer of
Timeline on the **tab axis** (`ActiveTab = 'timeline' | 'activity' | <Tab.key>` in
`store/pinnedTabs.ts`; the Activity console is a full-`<main>` overlay over the warm board;
`?view=activity&activityRepo`). The rail is a fixed block of pseudo-rows, **then a FLAT list of the
active workspace's repos**:

```
◈ Insights (Pro)      gate: caps.workspaceInsights
✦ Feed                always
🤖 Bots               always (CORE/free)
⚖ Compare workspaces  gate: (workspaces ?? []).length >= 2
⚠ Needs attention     always (CORE/free)
── repos ──           flat: no grouping headers, no colour dots, no "Other" bucket
```

The daily surfaces lead; Compare and Needs attention are the occasional ones. **The rail is no
longer GROUPED** — a repo belongs to exactly one workspace and exactly one workspace is ever in
scope, so there is one list, `renderRailRow`'s key is the bare `String(repoId)` (never a
`${teamId}:${repoId}` composite), and `buildTeamColorMap`/`teamGroups`/`leftoverRows`/the "Other"
bucket are all deleted. (`lib/workspaceColors.ts` survives, imported ONLY by
`WorkspaceComparisonPanel`.) Selecting a repo shows a **compact header** (stats + thread-state bar +
per-repo Pro digest) atop that repo's **open-PR list** (`RepoOpenPrList` — all its open PRs with
at-a-glance CI / approval standing / thread counts) THEN that **repo's own feed** (`RepoFeedHeader`
+ `RepoOpenPrList` + `<FeedView repoId>`). The rail selection is `store/filters.ts` `activityRepoId`
(`'feed'` default | `'bots'` | `'attention'` | `'insights'` | **`'compare'`** | a repoId; `'retro'`
is gone with the Retro panel).

- **The Compare gate is `(workspaces ?? []).length >= 2`** — a count over the ACCOUNT-WIDE roster,
  Default included, **never a test on the selection**. It answers "has the user created a workspace
  of their own?", which is only true at 2+. The panel then compares ALL of them, so the entry's data
  does not depend on which workspace is selected. ⚠ `undefined` (not loaded) must read as HIDDEN,
  not "show optimistically" — and the CONVERSE, demoting a deep-linked `?activityRepo=compare` to
  the Feed, must wait until the roster has actually LOADED (`workspaces != null && !canCompare`), or
  that same pre-load window flashes the Feed before Compare.
- **DERIVED, never written back**: when the gate is known-false the render falls back to `'feed'`
  and the store keeps `'compare'`, so deleting and recreating a workspace RESTORES the entry instead
  of having silently forgotten it.
- ⚠ **Branch POSITION in the right-detail chain is load-bearing.** The chain is `noReposAtAll →
  showingBots → showingAttention → showingCompare → showingInsights → noRepos → showingFeed`, where
  `noRepos` means "the SELECTED workspace has no repos" (the account may have plenty, living in
  other workspaces — the empty state distinguishes the two, since the remedy differs: add a repo vs.
  move one in). `showingCompare` must sit **BEFORE `noRepos`** — the natural reading of the rail's
  top-to-bottom order would put it after, which makes Compare unreachable whenever the selected
  workspace happens to be empty, i.e. exactly when someone is setting workspaces up.

Built **entirely on the read layer**: `getActivity` composes
`getInsights`/`getOpenPrs`/`getMergers`; `listClaudeReviewsByRepo` is retrieval-only. **Scoped by
the active WORKSPACE, and by nothing else** — the workspace id flows into the `useActivity` /
`useConsolidatedFeed` query keys (which carry a `ws:<id>` segment), so switching workspace re-scopes
the whole console and refetches (dim, never blank). ⚠ **Neither the Members panel NOR the repo
picker scopes Activity** — both are Timeline-only filters, and the console's queries send
`userIds: null` and never `filters.repoIds`. A `repoIds` on these hooks is always an EXPLICIT caller
scope (the per-repo console passing its own `[repoId]`), never the FilterBar's picker; you narrow
Activity by clicking a repo row in the rail. Refresh re-queries the **DB only**. Open-PR lists show 10 rows; ">10" swaps the old
pagination for a "Show all N" footer opening the sortable `open-prs` drill-down tab.
**Clicking any open-PR row/card opens the PR's detail tab** (`openPrDetailTab`) — no longer
isolates the feed on click. The **"Showing only #N" feed-isolation banner** (`FeedIsolationBanner`,
set from PrDetail's "Show in Activity feed" button or a drill-down, dismissible with Clear) renders
**directly under the panel's summary header** — under `RepoFeedHeader` in the per-repo Activity
console, under the "Review bots" header in `BotsView` (bot-only "Show in feed" lands there), and in
the empty-workspace fallback branch — so it's present in every context isolation can reach (never
sticky; scrolls with content). When isolated, that view also **hides the repo-wide charts +
open-PR list**: RepoConsole drops `RepoInsightsPanel`/`RepoOpenPrList`, and `FeedView` drops its own
cross-repo `FeedOpenPrsPanel`. `FeedView` still reads `feedIsolatedPrId` only to scope its query;
the feed-wide "New activity — Refresh" banner remains sticky as its own element.

**The rail entries' inner sub-tab bars** (all transient + URL-silent, all built DYNAMICALLY so a
tab exists only where it means something):
- **Feed** — `Feed` | `Themes` (Pro, `activityDigest`). Only Themes carries a "pro" pill.
  **`Compare teams` LEFT this bar** for its own rail entry: it compares every workspace in the
  account, which is not a property of the Feed's scope and had no business being nested under it.
  `feedInnerTab` is `'feed' | 'themes'` — `'compare'` is not a member. (It is TRANSIENT: in
  `freshDefaults()` but not in `FilterDefaults`/`pickFilterBarState`/`sanitizePersistedFilters`, and
  `useUrlState` never touches it, so a stale `'compare'` cannot survive a reload and needed no
  migration.)
- **Bots** (`BotsView`) — `ROI` | `Behaviour` | `Themes` (Pro, cross-repo only) | **`Settings`**
  (CORE/free — the classification tab, see below; it shows in the per-repo Bots tab too, where it is
  the same WORKSPACE listing filtered CLIENT-SIDE to the actors with a footprint in that repo).
- **Insights** — the bar **no longer renders**: `SUB_TABS` is down to `Overview` alone (Retro is
  deleted, Compare moved to the Feed, Sprint folded into Overview long ago), and the bar is guarded
  on `SUB_TABS.length > 1`. The apparatus is kept live and type-checked, with a `normalizeSubTab`
  MEMBERSHIP test (not a chain of `=== 'sprint'` literals) so a stale/deep-linked key falls back to
  `overview` instead of stranding the pane on a tab that renders nothing — which is why
  `InsightsSubTab` stays `'overview' | 'sprint'`: the vestigial member is the one value that keeps
  that redirect reachable AND type-checkable. `'retro'`/`'compare'` were REMOVED from the union.

**Landmine — the visible tab is DERIVED, never written back.** `feedInnerTab` / `botsInnerTab` (and
`activityRepoId === 'compare'`) are single scalars that can legitimately hold a key the current
context doesn't render (Themes without the capability, Compare with one workspace). Each consumer
computes an `effectiveTab` fallback for the RENDER only; a corrective `set…` would permanently
forget the user's choice, so deleting a workspace would LOSE Compare rather than restore it when a
second workspace comes back.

**Activity render-perf (client-side; the console + Bots sub-tab mount fresh on every tab switch).**
Two low-risk levers keep opens fast: (1) **warm snapshots** — `useActivity`/`useConsolidatedFeed`
+ the six bot read-queries carry `gcTime: ACTIVITY_GC_TIME` (45min, exported from `useActivity.ts`,
mirrors usePr's `DETAIL_GC_TIME`) so a switch-away-and-back within a session repaints from cache
instead of the default-5-min-GC → skeleton → refetch; retention-only (staleTime unchanged, so no
stale surprise). (2) **smaller first-paint window** — `FeedView`'s initial virtual window is `end:12`
(not 30); the post-paint rAF `recompute` widens it to viewport+`FEED_OVERSCAN`, so first paint no
longer builds ~30 react-markdown/highlight cards it discards a frame later. The bigger "keep
ActivityView mounted-but-hidden" lever was deferred (medium-risk: hidden-mount windowing/`clientHeight`,
mark-seen/insights-default once-per-mount effects, the 60s head poll).

**Review-bot triage — "the calm layer above your review bot" (CORE, deterministic, NO AI).**
Third-party AI review bots (CodeRabbit/Greptile/Copilot/Qodo/…) are a **first-class, triaged
signal**, not generic excluded noise. **Classifier:** `REVIEW_BOTS` (login → vendor `ReviewBotKind`)
+ `reviewBotKind()` in `@pierre-review/shared` (bundled by the frontend); the backend can't import
shared at runtime so `sync/bot-detection.ts` keeps a **LOCAL copy** (folded into `isLikelyBot`),
kept in lockstep by `bot-detection.test.ts`. Verified logins (2026-07); coding agents (`sweep-ai`,
`copilot-swe-agent`) + dependency bots (`dependabot`/`renovate`/`snyk`) are deliberately EXCLUDED —
still `isBot`, just not *review* bots. **Surfaces:** a PrDetail "Bots" chip ("CodeRabbit · 12 · 3
unresolved", `ChecksTab`) that filters the Threads tab to that vendor (`store.threadBotFilter`); a
feed **bot lens** (hide — the DEFAULT — /all/only, `store.feedBotLens`; 'hide' is server-side via
the feed route's `excludeBots`, union bot definition) + per-row vendor tag (`FeedView`); a **core
per-repo acted-on stat** (`ActivityRepoStats.botThreads/botThreadsActedOn` computed in `getActivity`
→ `RepoStats`, free); a **Pro-gated deterministic `bot_signal` Insights card** (per-vendor volume /
acted-on % / oldest-untouched backlog, computed in core `getWorkspaceInsights`, rides `/api/pro/insights`
+ `workspaceInsights` — no new cap); and confirm-gated **bulk-resolve** of
`likely_addressed` bot threads (`ThreadList` → `resolve-bot-threads`). "Acted-on" = the existing
`derivedState ∈ {resolved, likely_addressed}` heuristic (approximate — the UI says so). No migration,
no new AI/credit surface.

**Bot-Triage Platform (v2) — builds ON the v1 layer; CORE deterministic + PRO panels; NO new
AI/credit surface for the deterministic core.** Detection is now an
**account-scoped multi-signal classifier** (`sync/{review-fingerprint,reviewer-classify,reviewer-behavior,
app-attribution}.ts`), resolution order: **manual override > known vendor login > `users.githubType`
`'Bot'`/app-attribution > branded-marker fingerprint > behavioral score (medium confidence, never
auto-badges) > opt-in Haiku tie-break** (settings-gated OFF — the only AI, for the medium band).
`users.githubType` is captured from the GraphQL author `__typename`; `AUTOMATED_LOGIN_PATTERNS` + a
per-account allowlist catch service-account PATs. Classifications live in the CORE account-scoped
`workspace_reviewers` (manual + auto rows, uniq `(accountId, workspaceId, authorUserId)`) — see
**One bot object** below. New shared type
**`AutomatedReviewerKind = ReviewBotKind | 'in_house' | 'pierre'`** (widens `BotSignalVendorStat.kind`).
**Pierre's own review is tagged bot-derived PER-REVIEW** (not per-account): a compute-on-read join
`claudeReviews.postedReviewId = reviews.databaseId` (both TEXT) sets `provenance` = `ai_verbatim`
(`userBody===summary`) vs `human_curated` and `kind='pierre'` on the `ReviewDetail` ONLY — **the human
who posted (their token) is NEVER reclassified**. An optional hidden marker `<!-- pierre:claude-review
v=1 -->` + visible footer are stamped in `review/post-seam.ts`, gated by `pro_settings`
`bots.tagPierreReviews`/`pierreFooter` (threaded via the back-compat OPTIONAL `PostReviewArgs.pierreMarker?`/
`pierreFooter?`), and dogfooded through the same fingerprint detector. **Bot-ROI** (`getBotAnalytics(accountId,
window, scope)`, CORE) → per-kind volume/actedOn%/untouched/`overdueUntouched`/`medianAddressedMs`/oldest/humanFollowThrough/noiseRatio/`verdict`
(keep|tune|**noisy**) + ≤12wk trend + deterministic tuning suggestions → `BotRoiPanel`; **cost is
SERVER-resolved from the workspace row**, with the `pro_settings` `bots.cost` blob surviving only as
a null-only client fallback. The `noisy` (ex-`kill`)
verdict is **response-time-gated**: it keys on `overdueUntouched` (untouched threads older than a
FIXED 36h grace window, `totals.overdueGraceMs`; `medianAddressedMs` per bot = time-to-addressed, display-only), never raw `untouched`, so a bot
isn't flagged noisy for threads still inside the normal response window (tested in
`bot-analytics-verdict.test.ts`). **Same-line overlap** (ADVISORY): every "same line" claim now
goes through the ONE shared ±3-line clustering helper (`db/line-overlap.ts` — user-distinct, so two
distinct in-house bots CAN overlap; quality checks excluded). `getBotAnalytics` runs it over the
window's review-role threads with **null-line (outdated/file-level) threads EXCLUDED** (they
manufacture overlap) → per-row `overlapThreads`/`overlapPct`/`topOverlapPartner` (an Overlap column
in `BotRoiPanel`) + an advisory `BotTuningSuggestion` (`partnerLabel` set; gates: threads ≥ 5 AND
share ≥ 0.4; pair-level — both bots of a heavy pair may each name the other). botVerdict NEVER
reads overlap. `getBotBehaviourAnalytics.lineOverlapClusters` counts the same clusters (was
exact-line + a null-line lump — the counts stepped once). **Cross-bot dedup**
(`getBotDedupClusters(prId,accountId)`): groups automated-reviewer threads by the same shared
`(path, ±3-line)` clustering, entry gate ≥2 threads from ≥2 DISTINCT USERS (not kinds), members
COLLAPSED per bot (`threadId` = representative + additive `threadIds` — the SPA renders one ×N
pill per bot that cycles through its threads; the old one-member-per-THREAD shape rendered 23
identical pills for one verbose bot), per-reviewer labels (custom → vendor → login), null-line
catch-all group KEPT → consensus/conflict, a rollup in `ThreadList` (its only mount — the old
FeedView claim was stale). Pinned by `bot-dedup.test.ts`. **Slack:** a
deterministic "Review bots" block in `buildSlackReport` (reads the `bot_signal` card from
`getWorkspaceInsights`), gated on `pro_settings` `bot_slack_digest`, sent even when the AI digest is
empty. ⚠ It is a CRON with no request, so it now resolves `ctx.queries.defaultWorkspaceId(accountId)`
and covers the **Default workspace ONLY** — see Known gaps.
**Resolve (user-initiated only):** resolving `likely_addressed` bot threads on GitHub is a strictly
**user-initiated, confirm-gated** action via the shared `resolveThreadsOnGitHub` helper
(`src/bot-triage/resolve.ts`) — the per-PR `resolve-bot-threads` route + the workspace-wide
`bot-threads/resolve` route. **ONLY `likely_addressed` threads, logged, never a merge.** _(REMOVED:
the old `bot_mute_rules` "hide" mute (Pierre-only cosmetic filter) + the standing `auto_resolve` cron
(`getAutoResolveCandidates` + `sync/bot-triage/auto-triage.ts`, `*/30`) were dropped — "mute in Pierre"
changed no behaviour, and the unattended cron was replaced by the confirm-gated manual resolve. The
`bot_mute_rules` table / `/api/bot-mute-rules` routes / `BotMuteRulesEditor` are gone; migration `0029`
still creates an orphan table; `pro_settings.bot_auto_resolve*` columns are now vestigial.)_
**"Only a bot reviewed this" risk flag:** a `bot_only_review` Insights card (`getBotOnlyReviewPrs`;
Pierre-verbatim counts as bot-derived) + a `ChecksTab` caution. **Settings:** the account-wide
"Review bots" section (`BotSection`) backed by `pro_settings`'s 11 `bot_*` columns — the per-reviewer
`DetectedReviewersTable` lives in the Bots **Settings** sub-tab (below), which shows in the per-repo
Bots tab too, where it is the same WORKSPACE listing filtered client-side to that repo's footprints. Deterministic tuning suggestions on the ROI panel are **advisory only** (no mute action).
**Tiers:** detection/analytics/dedup/resolve are **CORE (free)**; the analytics PANELS, Slack block,
and Pierre tag/footer are **PRO** (gated on the existing `workspaceInsights`/`slackDigest` caps — no
new cap). **Migrations:** core `0027` (`users.github_type`), `0028` (`bot_review_classification`), `0029`
(`bot_mute_rules`, now orphaned), `0042` (pg `0029`: RE-KEY to `repo_reviewers`, per repo, and
DROP `bot_review_classification`), `0043` (pg `0030`: NORMALISE the actor grain out into
`account_reviewers`), **`0045` (pg `0032`: COLLAPSE both onto `workspace_reviewers`, and DROP
them)**, pg baseline `0016`; pro `0009` (`pro_settings` + 11 `bot_*` columns), pro `0019` (now a
guarded NO-OP), pro `0020` (the `bot_cost_json` → `workspace_reviewers.monthly_cents` backfill).
**Landmines:** (1) Pierre = **per-review** provenance — the human
author is never reclassified; (2) resolving bot threads is ALWAYS user-initiated + confirm-gated over
**only `likely_addressed`** threads, never a merge (no automatic/cron path exists); (3) the frontend
must use `automatedReviewerMeta()`, NOT `BOT_VENDOR_META[kind]`, for an `AutomatedReviewerKind`;
(4) `getBotAnalytics` **server-resolves cost from the workspace row** — a null there is FINAL, the
client-side `pro_settings` overlay survives ONLY as a null-only fallback for logins the plugin's
backfill could not attach to a row (it only ever UPDATEs, never INSERTs), and the price must **never
be summed across WORKSPACES**; (5) a **JUDGEMENT write may never touch identity, an IDENTITY write
may never touch judgement, and NEITHER may touch the price** — the two-table boundary that used to
guarantee that is gone, so the guarantee is now (a) two independent provenance columns honoured by
NARROWED `set:` objects and (b) cost living on its own route so no combined body can address the
column. It is **NOT** `additionalProperties:false` (ajv runs `removeAdditional:true`, so it strips
unknown keys rather than rejecting them).

**One bot object: `workspace_reviewers` — the quality-check ROLE, and the merge that ended the
two-table split (CORE, deterministic; migrations `0044`/`0045`, pg `0031`/`0032`).**
The two migrations are ONE change in two steps, and are best read together:

```
0044 / pg 0031  RE-HOME   repo grouping:  teams (m2m)  →  workspaces (1:N), + a Default per account
0045 / pg 0032  COLLAPSE  the bot object: repo_reviewers + account_reviewers → workspace_reviewers
```

**1. A BOT IS A PER-WORKSPACE OBJECT.** "Is this login a bot" is answered once per workspace. This
is the third key this table has had, and the history is worth a paragraph because each move was
paid for:

| key | why it went |
|---|---|
| `(account, TEAM, actor)` + an inheritance chain (team row → team-0 default → auto-detect) | the answer MOVED when someone re-bagged a team's repos, and null-means-inherit leaked into every read, every write body and every badge on the row |
| `(account, REPO, actor)` + `(account, actor)` for identity | correct about installation, but it needed a UNION FOLD at every read, and it was two tables to keep the two facts apart |
| **`(account, WORKSPACE, actor)` — one row, one table** | one workspace is the only scope there is, so both facts are about the same key and there is nothing left to fold |

⚠ **There is NO team key, NO repo key, NO inheritance, NO union fold and NO `resolveJudgements`.**
A vendor running in the six repos of a workspace is **ONE row** — one judgement, one price, one
brand colour — and every "resolve N rows into one answer" helper died with the repo grain. The
per-repo Bots tab is that same one listing, filtered CLIENT-SIDE to the actors with a footprint in
that repo. `workspace_id` arrives in a REQUEST BODY, so tenancy is a COMPOSITE FK against
`workspaces(id, account_id)`: the cross-account insert fails in the database, in every code path.

**2. THE VENDOR-IDENTITY BUG, AND WHY THE FIX SURVIVED THE MERGE.** The reason `account_reviewers`
ever existed: when `kind`/`label` sat on per-repo rows, marking CodeRabbit "not a bot" in ONE repo
nulled that row's kind, that row was the most recently updated, identity resolution reported
`kind = null` account-wide, and **CodeRabbit lost its brand colour and vendor name in every repo the
user never touched** — with no surface anywhere able to undo it. A most-recently-updated tie-break
picks a winner but cannot make the losing rows editable or even visible.

That bug was killed by a TABLE BOUNDARY. **The boundary is gone**, so the same bug is now
representable inside a single row, and what prevents it is code discipline that must not be
loosened:

- **TWO independent provenance columns.** `source` owns `automated`/`role`/`confidence`/`reasons`;
  `identitySource` owns `kind`/`label`. A pass or a handler that respects only one of them either
  reverts a human's vendor correction or freezes auto-detection.
- **NARROWED `set:` OBJECTS, never one shared `values` object.** `persist` loops per workspace,
  reads the existing row's two flags, and assigns the judgement half only when
  `source !== 'manual'` and the identity half only when `identitySource !== 'manual'`; if neither
  half may be written it emits **no statement at all**. The old shared-object pattern is correct for
  a single-grain table and would, here, overwrite a human's vendor name on every auto pass.
- **`monthlyCents` (and its reading rule `costModel`) is in NEITHER half** — not in the `set:`, not
  as a derived INSERT value, nowhere in `reviewer-classify.ts`. A row `persist` creates has no
  price and reads 'flat' by column default.
- **`persistHumanJudgement` carries no `kind`/`label`** at all, so a human "this is a bot" cannot
  rename the vendor as a side effect.
- **`useBotColors` is now WORKSPACE-SCOPED**, and this is the single most dangerous consequence of
  the merge. It used to call `useDetectedReviewers()` with no arguments *on purpose*, because
  identity was account-wide; under a per-workspace identity that reads an arbitrary workspace's
  answer. The hook's `workspaceId` is therefore the **first, REQUIRED, non-optional parameter**
  (`number | null` — null only for "not resolved yet") so `tsc` is the gate, not a grep — and the
  grep that would be used instead misses the worst offender
  (`ThreadList`'s `useDetectedReviewers(undefined, null, …)` is equally unscoped and does not match
  `useDetectedReviewers()`).

**⚠ IDENTITY AND PRICE ARE NOW PER WORKSPACE. That is the accepted, deliberate consequence.**
CodeRabbit named or priced in workspace A does not carry either into workspace B, and B may
legitimately hold different values or none. Nothing reconciles them and nothing is meant to: there
is no fan-out writer, no INSERT seed and no cross-workspace coupling. Migration `0045` copies the
old account-wide `kind`/`label`/`monthly_cents` into every workspace row of that actor as a ONE-TIME
SEED of a value that *was* account-wide — not an invariant, and the copies diverge freely from the
first edit. Bots are configured at the Workspace level, **all attributes included**; do not
re-derive the old behaviour from the "you buy one subscription per vendor" argument, which was
considered and overruled.

**3. THE WRITE SURFACE IS TWO ROUTES, NOT ONE AND NOT THREE** (full contract in the HTTP API table):
`PATCH :userId {workspaceId, automated?, role?, kind?, label?}` and
`PUT …/cost {workspaceId, monthlyUsd, costModel?}`.

- The four PATCH fields merged because they are all **re-derivable** — a wrong write is fixed by the
  next classification pass or a reset — so one body keyed by two independent provenance flags
  removes a whole class of "which endpoint do I call" bugs. **Do not split them back apart by
  grain**; the grain mismatch they defended against no longer exists.
- **Cost stayed separate because it is derivable by nothing and it is money.** Its own body means no
  combined body can address `monthly_cents` at all — the same structural guarantee the two-table
  split gave, with one fewer table. **Do not fold it into the PATCH.**
- **`cost_model` ('flat' | 'per_seat', NOT NULL DEFAULT 'flat') is the price's READING RULE and is
  part of the price half**: it rides ONLY the cost body (it changes what the stored number MEANS,
  so it is money the same way the number is), shares `setReviewerCost`'s single UPDATE, and a CLEAR
  (`monthlyUsd: null`) resets it to 'flat' in that same statement. Under `per_seat` the stored
  `monthly_cents` is a PER-SEAT UNIT and every displayed monthly figure is
  **unit × the workspace's derived seat count, computed ON READ** — the product is never stored
  (seats × cents can exceed int4, and a stored copy goes stale). A **seat** =
  `workspaceHumanSeatCount(accountId, workspaceId)`: distinct HUMAN PR authors across the
  workspace's MEMBERSHIP repos (never a repoIds narrowing) over the trailing 30 days, with the bot
  exclusion routed through `automatedReviewerUserIds` ∪ the global `users.isBot`/`githubType='Bot'`
  markers, minus the workspace's manual-human rows (which win both directions). The wire serves the
  unit on `costMonthlyUsd`, the derived figure on `WorkspaceReviewer.effectiveMonthlyUsd` and — for
  the analytics — AS `BotVendorAnalytics.costMonthlyUsd` (already-effective; the unit survives as
  `costUnitMonthlyUsd`), so exactly ONE side multiplies seats: the server. The listing carries one
  `workspaceSeatCount` per response; `monthlyCostTotal` sums `effectiveMonthlyUsd`; the resets and
  the deleteWorkspace re-home carry BOTH price columns; still never summed across workspaces.
- The classifier honours BOTH provenance flags, which is what lets a manual "not a bot" in workspace
  A coexist with fresh auto verdicts in B and C: there is **no "manual override wins" early return**
  — the derivation always runs and `persist` declines only the halves a human owns.
- **The division now:** *is this login a bot, who is it, and what does it cost* are all per
  **WORKSPACE**; *how we detect bots and how we attribute Limn's own reviews* stays per **ACCOUNT**
  (`BotSection` in the Settings modal). Price is edited INLINE on the reviewer card
  (`DetectedReviewersTable`) and its label reads **"Price for this Workspace"** — not a bare "Price",
  which on an otherwise workspace-scoped card would read as a global setting and invite exactly the
  cross-workspace totalling that is forbidden. `BotSection`'s old "Per-bot cost (account-wide)"
  picker is DELETED — do not reinstate it. Moving the table out of that modal also closed a real
  gap: it was gated on `caps.botTriage`, so an OSS (plugin-absent) `npx` user could not classify a
  reviewer at all.

**RESETTING TO AUTO — two routes, one per provenance flag, and they are now SYMMETRIC.** Both
`DELETE …/judgement?workspaceId=` and `DELETE …/identity?workspaceId=` are an **UPDATE + an
immediate re-derive in the same request**, and both answer **200** with the fresh row.

- ⚠ **Neither may DELETE the row.** The old per-repo judgement reset did exactly that, and it was
  right *then*: the row held nothing else, and the listing's lazy pass fires on a MISSING row, so
  the next pass rebuilt it with a fresh auto verdict. This row also holds the vendor identity AND
  the price, so a delete is lossy.
- ⚠ **Neither may pass an empty scope list.** The old identity reset called `classifyReviewer(…, [])`
  and relied on `persist` writing the two halves as two statements against two TABLES with only the
  second guarded on `repoIds.length > 0`. With one merged row there is a single per-workspace loop,
  so an empty list means **zero iterations and zero writes** — "Reset name" would become a permanent
  un-naming, with the lazy pass (which only fires on a missing row) never re-deriving it,
  `buildIdentity` falling back to the raw login, and `useBotColors` (which filters `kind != null`)
  dropping the brand colour forever. The mechanism is now the explicit
  `PersistOpts { only: 'judgement' | 'identity' }` with a REAL workspace id.
- ⚠ **The identity reset KEEPS THE PRICE.** Un-naming a vendor is not a statement about what it
  costs, and that coupling is precisely what the old two-grain split existed to remove.
- ⚠ **Order is load-bearing:** clear the provenance BEFORE deriving, or `persist` skips the
  still-`manual` row.

⚠ **Without these resets, touching any row pinned it forever** — `source: 'manual'` means detection
never re-derives, and flipping the value back by hand leaves it just as pinned. That is also what
makes the trade below acceptable.

⚠ **A role-only judgement patch stamps `source: 'manual'`**, which also pins `automated` for that
workspace. The alternative — leaving `source` alone — lets the next classification pass re-derive
`role` from the login seed and silently revert the user's edit. The visible, undoable pin was chosen
over an edit that quietly disappears. (This is NOT the old "typing a price froze the classification"
trap: price has its own route and its own `set:`, and cannot reach `source`.)

⚠ **Deleting a workspace must re-home its `workspace_reviewers` rows to Default BEFORE deleting the
row — this is a failure mode the merge CREATED.** Under the old model deleting a team touched no
classification at all (`repo_reviewers` keyed on repo, `account_reviewers` on account). Now the FK
cascade would destroy every `source='manual'` verdict, every `identity_source='manual'` vendor name
and every `monthly_cents` in the workspace — money the user typed — while the repos survive, with no
warning and no undo. `deleteWorkspace` does it as `INSERT … SELECT … ON CONFLICT (account_id,
workspace_id, author_user_id) DO NOTHING` + a DELETE of the leftovers, and **the `DO NOTHING` is the
collision RULE, not an optimisation: DEFAULT'S EXISTING ROW WINS, UNTOUCHED.** Prices are per
workspace, so the two rows may hold different numbers; deleting a workspace is an explicit
destructive act the user confirmed, so losing that workspace's price with it is the expected cost,
whereas silently OVERWRITING a price the user set in Default as a side effect of deleting a
*different* workspace would be strictly worse and would have no undo.

**One door along, same class:** MOVING a repo between workspaces leaves the source workspace's
reviewer row behind (correct — it may still cover other repos, and a footprint-less stored row must
stay editable) and produces a fresh auto row in the destination that inherits **nothing** — not the
price, not the manual judgement, not the vendor label. Its `monthlyCents` is NULL until someone
prices it there. That is the intended per-workspace semantics, not a gap.

**4. `role: ReviewerRole = 'review' | 'quality_check'`** — WHAT an automation is FOR, **orthogonal
to `AutomatedReviewerKind`** (WHO it is). SonarQube / Codecov / Hound post review comments and ARE
automated, but they are not reviewing, and counting them as reviewers is what makes the ROI numbers
lie. Seeded from `QUALITY_CHECK_BOTS` (shared, with the usual hand-synced backend copy in
`sync/bot-detection.ts` + drift test) and re-derived by `defaultRoleFor`, so an unclassified
SonarQube is right before anyone opens the settings tab. It is **NOT** a new `AutomatedReviewerKind`
member: a login would have to give up its brand identity to be marked a linter, and
`getBenchmarkContributions` filters kinds with a RUNTIME string test against exactly
`in_house|pierre|vendor`, so a new member would sail through and ship linters into the **cross-org
benchmark** as a named review-bot cohort — data that leaves the tenant and cannot be un-shipped.
A quality check stays `automated: true`, so `excludeBots`, the feed bot lens and the vendor tag are
unchanged. **The role splits exactly two sets** (`automatedReviewerUserIds(accountId, workspaceId, role)`
takes the filter POSITIONALLY and REQUIRED, so every call site had to be re-read). ⚠ **`null` is gone
from every workspace-scoped getter**: the scope is a `BotScope {workspaceId, repoIds}` whose
`repoIds` is always concrete, and `[]` now simply means "this workspace is empty" — an ordinary
state (a freshly created workspace), not an edge case. The ONE genuine account-wide sweep, the
cross-org benchmark rollup, gets **two explicitly named functions** rather than a null sentinel:
`automatedReviewerUserIdsForAccount(accountId, role)` (the UNION over all workspaces — automated in
ANY workspace counts) and `classificationKindForUserForAccount(accountId)`. ⚠ The latter needs a
WRITTEN tie-break because identity is per workspace and an actor can be `coderabbit` in A and null
in B: **a non-null vendor kind in ANY workspace WINS, ties broken by lowest `workspaceId`.** It is a
named function with a stated rule rather than an incidental `Map` build because its value decides
what leaves the tenant into a CROSS-ORG benchmark and cannot be un-shipped:

| `role: 'review'` — SCORING | `role: 'all'` — EXCLUSION / visibility |
|---|---|
| behaviour + per-PR behaviour (`getBotBehaviourAnalytics`/`getPrBotBehaviour`), dedup, bot themes (`getBotReviewComments`), all three resolvable-thread-backlog getters, `getActivity`'s acted-on stat, `getWorkspaceInsights`' `bot_signal`, the benchmark (`getBenchmarkContributions`) | the bots-only feed (`getConsolidatedFeed`), the human-themes exclusion set (`getHumanReviewComments`), human-follow-through detection (inside `getBotVendorPrs` — "was the replier a HUMAN"), **bot-only PRs** (`getBotOnlyReviewPrs`), **and `getBotAnalytics`** |

**`getBotAnalytics` is the exception that reads like a bug and isn't** — it is the ROI getter, yet
it passes `'all'`. It narrows by SPLITTING, not by filtering: it computes a row for EVERY automated
reviewer and then routes `role:'quality_check'` ones into `qualityChecks[]` (via `reviewerRoleForUser`)
so they are excluded from `vendors`/`totals`/`suggestions` but still RENDERED, in a collapsed
"excluded from ROI" section. Filtering them out of the id set instead would have made a mis-roled bot
silently vanish from the one screen where you'd fix the role. So "ROI scores only review bots" is true
of the OUTPUT and false of the argument — don't grep for `'review'` expecting to find it here.
_(The two in-code comments that used to contradict this — `schema.sqlite.ts`'s `role` comment and
`queries.ts`' `ReviewerRoleFilter` comment, both listing "bot-only PRs" among the sets that narrow —
were corrected during the workspace rename. They now agree with the code and with the paragraph
below.)_

**Bot-only PRs DELIBERATELY DO NOT NARROW**, and the symmetry is tempting enough that it is worth
stating: that list answers "did a human look at this before it merged". A PR reviewed only by
SonarQube has no human reviewer — exactly what the banner exists to surface. Narrowing it to
role `'review'` leaves that PR with zero qualifying bot reviews, fails the "at least one automated
review" leg, and DROPS it from the list, hiding the risk instead of flagging it. The scoring sets
narrow because a linter's volume makes a reviewer's numbers lie; the risk set does not, because a
linter's approval is not a human's.

**Consolidated Feed — CORE, the Activity "Feed" entry (`getConsolidatedFeed` → `FeedView`).** ONE
flat, purely-**chronological** (newest-first) stream of **real activity events** (opens / merges /
reviews / comments), plus **commit-push items that ADDRESSED a review thread**
(`getCommitThreadItems`): consecutive commits by one author on one PR are coalesced into a run
(a >6h gap splits runs), kept only if a commit touched a still-`likely_addressed` thread's file
after that thread's last comment, carrying the addressed threads inline (`affectedThreads` +
`commitCount` + `changeSummary` — "pushed N commits · addressed M threads"); plain
(non-thread-touching) pushes stay excluded. **Each item carries `isMyTurn`** — true when it's an
event on a PR the viewer PARTICIPATES in (authored / requested reviewer / previously reviewed or
commented) AND the actor isn't the viewer. That flag **replaces the old two-source (`my_turn` vs
`feed`) synthesis + its dedup** — there is now exactly one row per underlying event, which killed
the duplication. **My Turn / "FYI" is CORE (free, every tier)** — it was moved back out of Pro
(the `feedMyTurn` capability and the `registerFyiProvider` seam were removed; `feed/fyi-provider.ts`
is gone). The participation compute lives in the core module **`src/feed/my-turn.ts`** (`enrichMyTurn`
+ reason pills + `countNewMyTurnFeedItems`); `getConsolidatedFeed` calls it directly, and `/api/me`
uses `countNewMyTurnFeedItems` for `me.newFeedItems`. Every tier gets the My Turn cards/toggle/badge
+ Welcome-back banner — no capability gate. `isMyTurn` rows are the **content-rich, yellow-bordered
cards** with a "My Turn" badge + a `feedMyTurnOnly` "My Turn only" toggle; they're
uncapped, plain activity is capped (`FEED_EVENT_CAP`). Cards render the **full comment/review body
as markdown**, the affected threads inline, + a merge/review credit line
(`mergedById`/`reviewers`). The **`excludeBots`** filter drops bot-authored activity BEFORE the
page cap, using the UNION bot definition (`users.isBot` ∪ the workspace's automated set, manual
"human" wins) — it is what the lens's default 'hide' sends; a bot contributor's own activity tab
derives an effective 'all' so it isn't empty (derive-for-render, never written back). **PAGINATED**
— `useConsolidatedFeed` is a `useInfiniteQuery` (page 0 loads `FEED_PAGE_SIZE`=50, "Load more" by
`offset`; `total` tells the client when to stop). **No "seen"/Done concept.**
**Click → pr-DETAIL tab:** clicking ANY feed card → `usePinnedTabs.openPrDetailTab(meta,
{fromActivity, returnItemId: item.id})` opens the full-height PR detail tab (its Show/Focus links
then drive the timeline), pushing a Back-to-Activity history entry; **Back returns to the feed and
scrolls + flashes the clicked item** (`activityReturnItemId`). A digest's `#N` PR ref also opens a
`pr-detail` tab. (The old pr-focus-on-click, the My-Turn tab, and the MyTurnPanel/FeedPanel/pills
are all gone.)

**Pro: Haiku digests — per-repo, rendered as a COLLECTION** (`packages/pro/src/activity-digest/`).
The flagged AI panel: a per-repo banner in each repo's console (`DigestBanner` → `RepoDigestCard`,
collapsible) AND, atop the Activity "Feed" entry, the **COLLECTION of per-repo digest cards**
(`FeedDigestList` → `useRepoDigests`) — one collapsible `RepoDigestCard` per repo. Each digest is a
**bulleted markdown change-report** referencing PRs as `#<number>` tokens (resolved via
`activity-digest/refs.ts`, scoped to `(accountId, repoId)`) **chained from the prior stored
summary**. `metrics.ts` compacts `getActivity`+`getRepoAnalytics` into a bounded `RepoDigestPayload`;
one non-agentic `ctx.llm.complete` (Haiku) → stored in `repo_digests`. **There is NO separate
cross-repo "Feed digest" route/LLM pass** — the collection simply reads the same `repo_digests`
rows (one source of truth for the caps; the old `feed-digest/` dir was removed). **Scoped to the
active WORKSPACE's repos** — `FeedDigestList` passes that workspace's ids, and an unscoped request
resolves to one workspace, never the account, so the Feed digest never fans out to every added repo.
(It used to intersect the FilterBar-visible set with `inboxWatch=true`; the watch column is gone —
migration `0046` / pg `0033` — and the picker is Timeline-only, so the workspace is the whole bound
now.) Per-repo collapse state persists via
`store/digestCollapse.ts`. **Cost-safe:** generation only on `POST …/digests/refresh`; a
**payload-hash cache** (unchanged repo = $0; the hash MUST zero `Date.now()`-derived fields like
`age_hours` or a dormant repo re-bills hourly), per-account min-interval + in-flight guard,
USD/repo caps. Capability `activityDigest` tracks `PRO_DIGEST_ENABLED`.

**Pro: the Insights pane is now the grounded chat ALONE — "Retro" is DELETED.** The Insights
"Retro" sub-tab, its view + hook, the plugin generator (`insights/retro.ts`), the
`/api/pro/retro[/refresh]` routes and the `retro_reports` **table** (plugin migration `0018`,
both dialects) are all gone. The retrospective is a **quick-question pill** in `AdHocChatPanel`
(`RETRO_PROMPT`, a frontend-local const paired with `SPRINT_REPORT_PROMPT` — backward-looking vs
forward-looking), answering from the SAME grounded chat payload every other pill uses: one billing
path, one cache, one prompt surface instead of a second parallel generator. `RETRO_PROMPT` asks for
a short narrative followed by **ONE GFM pipe table** of the retro items (columns `Item | Category |
PRs | Note`, Category pinned to shipped / went well / dragged / CI, PR refs as plain
`owner/name#N`): `SummaryMarkdown`/`parseBlocks` (`prRefTable.tsx`) parses a model-authored pipe
table — a `|` run whose second line is the `---` separator row, cell counts matching — into an
`mdtable` block rendered in PrTable's visual shell, every cell through `renderInlineMarkdown` so
refs/bold still work; a malformed table DEGRADES to plain lines, never crashes, and table detection
runs BEFORE the PR-ref coalescer so a ref-citing row can't be swallowed into a `PrTable` group. It
deliberately asks
only for what `buildChatPayload` HOLDS — merged PRs, flow metrics, CI failure reasons, attention
items — **not themes or sentiment**, which needed the retro's own 50-item corpus of raw comment
bodies; asking would just trip the chat's "the JSON doesn't hold the answer" decline. Discussion
themes live in the Feed's Pro **Themes** tab. A third frontend-local catch-all pill, **"About this
Workspace"** (`WORKSPACE_ABOUT_PROMPT`), asks purpose-per-repo then current priorities; its
grounding is the payload's `repos` map (owner/name → the repo's GitHub "About" description,
truncated ~200 chars, null when unset — the payload's ONLY repo-purpose text). The description is
synced by the per-repo activity walk (`REPO_ACTIVITY_QUERY` → `upsertRepo`) into
`repos.description` under the three-state partial-response policy (`undefined` = selection not
received → preserve; `null` = GitHub positively says none → clear; string → overwrite —
`sync/branch-status.ts` is the reference), so the add-repo path and tolerant partials never wipe a
synced description. Every pill prompt must stay **≤500 chars** — the server's `MAX_QUESTION`
truncates SILENTLY, which would ship a live mispowered pill. It is a **NOT a new `PresetPromptKey`**: each key is
consumed by the plugin as two EXHAUSTIVE `Record<PresetPromptKey, string>` maps plus its own cache
row and throttle, for a pill that only prefills the chat box. The table was **dropped rather than
orphaned** because it carried `account_id`: an orphan would have to stay in `eraseProByAccountId`'s
checklist (and keep both drizzle definitions alive) forever — deleting the feature while keeping
100% of its schema surface. Historical `ai_usage` rows with `feature='retro_report'` survive on
purpose: that money was really spent and must keep counting toward month-to-date credits (the
column is free text, so no migration). `PresetPromptPanel` is likewise **importer-less** but kept,
because its server side (`preset-prompt.ts` + its cache rows/throttles) is still live and this is
its only client — delete both together or neither.

**Pro: Comment annotations — the "Check review" platform** (`packages/pro/src/annotations/`,
capability `prSummary`). ONE plugin-owned table `pr_comment_annotations` (migration `0017`) holds
any AI judgement ABOUT a review comment, discriminated by **`(accountId, kind, targetKind,
targetId)`** — that key exists because targets span `thread` / `review_comment` / `pr_comment`
and the superseded `comment_assessments` keyed a bare comment id, so `prComments.id` and
`reviewComments.id` would have silently collided. Three stored `AnnotationKind`s: `validity`
(does the point hold up — the old `comment_assessments`, whose rows migration `0017` backfills
`INSERT OR IGNORE`; that TABLE is deliberately not dropped, so a rollback is a code change rather
than a data restore), `addressed` (was the concern
dealt with, plus what is still open), `simplify` (a faithful rewrite of a bot wall-of-text,
rendered ADDITIVELY beside the untouched original). Staleness is **PASSIVE** — the GET is a pure
cached read that marks rows stale; nothing regenerates on PR open, which would bill per open of a
bot-flooded PR. The re-check is simply pressing the same per-item "Check review" again (there is no
bulk "re-check the stale ones" any more — there is no PR-wide sweep to hang it off).

- **`AnnotationRunKind = AnnotationKind | 'review'`, and the split is load-bearing.** `'review'`
  is a RUN kind ONLY: one combined model call per target emitting all three judgements, writing
  the SAME rows three separate runs would. **It must never reach the DB** — there is no `review`
  row, no `review` payload hash, no `counts.review`, and it is excluded from the `KINDS` set the
  cached GET's `kinds=` filter validates against. A combined run and three single-kind runs are
  indistinguishable in storage, which is exactly what keeps each kind's staleness and
  $0-on-unchanged cache independent. **Each of the three rows keeps its OWN per-kind payload
  hash**: a single combined hash would mark all three stale the moment any one input moved and
  re-bill three judgements for one change (the trap the digest cache already taught us).
  Economically it is also a win — 50 threads was 50 billed `addressed` calls, combined it is
  `ceil(50/6)` = 9 calls for all three.
- **`COMBINED_CHUNK_SIZE` = 6, smaller than the single-kind `CHUNK_SIZE` = 8**: a combined item
  emits a rewrite AND a validity rationale AND the two-section addressed summary (~3.4× a
  `simplify` item's output), so 8 would want ~6.5–7k output tokens. Overflow does not error — it
  truncates and the salvage parse silently drops the cut items, surfacing only as a lower
  `generated`. The chunked shape is used even for ONE unit (`parseSingle`'s "verdict:" first line
  can't carry three judgements). `recordAiUsage` fires ONCE per call (the authoritative cost);
  per-row `costUsd` is a double approximation divided by what each unit REQUESTED.
- **The clock exemption is measured in BILLED CALLS, not units.** A run of
  `ceil(units / COMBINED_CHUNK_SIZE) <= 1` bypasses the 30s per-account interval clock and does
  not stamp it. It was `SMALL_RUN_UNITS = 1`, which broke the very case it exists for: a thread
  anchor EXPANDS to the thread plus one unit per long reply, so on a bot-flooded PR a single
  per-thread click is already 2+ units and the next click seconds later was refused `too_soon` →
  429 — while both clicks cost exactly one call. Spend is still bounded by the per-account
  in-flight serialiser, `MAX_TARGETS_PER_RUN` 50 (resumable), the credit gate, and the `ai`
  20/min + `ai_hourly` 120/h buckets.
- **Landmine — EXPANSION.** The three kinds key their rows on DIFFERENT `(targetKind, targetId)`
  pairs for the SAME thread: `addressed` on `('thread', T)`, `validity` on the thread's ROOT
  `('review_comment', id)`, `simplify` on `('review_comment', id)` for EVERY comment in it. So a
  plain equality match against a `{'thread', T}` anchor finds only the `addressed` target: "Check
  review" on one thread reports `generated: 1`, renders one chip, and silently produces neither a
  validity nor a simplify verdict — with no error anywhere. A thread anchor therefore matches on
  THREAD IDENTITY (`targetMatchesAnchor`), resolved from the corpus; comment anchors match
  themselves.
- **Landmine — INTERSECTION ONLY.** `targets[]` is a POST-FILTER over targets enumerated from the
  already-account-scoped PR corpus, and is **NEVER a fetch key**. The ids come from the client, so
  a "load the named targets" implementation would let `{'review_comment', <another tenant's
  id>}` posted against a PR I own read a foreign comment body, spend my credits summarising it,
  and store the result where my own cached GET serves it back. An anchor matching nothing is
  counted `skipped`; the route SHAPE-validates only, on purpose.
- Counting unit: `requested`/`generated`/`cached`/`skipped` count the things a human pointed at
  (a thread, a comment) — never rows, of which a combined unit writes up to three. With anchors,
  the PR's other ineligible candidates are not counted as `skipped` (that read as nonsense on a
  300-thread PR); only unmatched anchors are.
- **UI: it is now PER-ITEM ONLY.** The three original buttons ("Simplify all" / "Check validity" /
  "Check addressed"), then the **PR-wide `ReviewCheckBar`** that replaced them (with its
  "Re-check N stale"), are ALL gone — a whole-PR sweep is many billed calls and tens of seconds,
  and the answer wanted is about the one thread on screen. A **SECOND** PR-wide sweep went with it:
  `PrAddressedCheckButton`, rendered once per ROW of the `bot-threads` drill-down, posting the
  plugin's `POST /api/pro/prs/:id/addressed/check` — one billed call **per target, up to 50**, a
  worse cost model than the combined runner's `ceil(units/6)`. That route + its SSE twin +
  `runPrBatch`/`enumeratePrTargets` and the per-account batch gate they needed are deleted; the
  drill-down row now shows only the deterministic addressed-confidence mix it is already sorted on.
  Also deleted: the **SSE run path** end to end (`…/annotations/run/stream`, `AnnotationRunProgress`
  in both the plugin and its frontend mirror, the hook's `stop`/`reset`/progress state) — a per-item
  run is one billed call, so there is no progress worth streaming — and **`onlyStale`**, whose only
  sender was the bar. The `AbortController` STAYS: it closes the socket, and the route's
  `reply.raw.on('close')` is what stops the billing loop for a run the user walked away from (a fat
  thread anchor really is several calls). What remains: **`ReviewCheckButton`** (thread-card header /
  PR-comment actions) + the render-only panels. `AddressedMarker` / `AddressedCheckControl` /
  `ThreadAssessment` / `useAddressedCheck` / `usePrAddressedCheck` / `useCommentAssessment` are all
  deleted; the legacy PER-ITEM routes (`/api/pro/threads/:id/assess`, `…/{threads,pr-comments}/:id/
  addressed/check`) stay registered as callerless alternate writers into the same rows.
- **Output rendering: ONE block per target.** A thread's judgements render under the whole
  conversation (`ThreadCheckOutput` in `ThreadCard`) instead of scattering a rewrite above each
  comment body; a PR comment's render under its card. The "the original is always still on screen,
  unedited" invariant survives (the conversation is above the block) and each rewrite is
  sublabelled ("@coderabbitai's opening comment", "reply 2") since it is no longer adjacent.
- **`lib/annotationRun.ts` `annotationRunMessage` — a click must never be silent.** The run route
  answers **200** for outcomes that produce nothing (no Anthropic credential, exhausted credits), so
  a 200 alone tells the reader nothing, and with the SSE `{type:'error'}` events and the bar's
  "· out of credits" suffix both gone the button just flipped back to its idle label.
  `AnnotationRunResponse.noAuth?` says it outright; the counter arithmetic
  (`requested - cached - skipped > 0` with no `generated`/`failed`) is kept as a FALLBACK for older
  plugin builds and worded with "may", because it is an inference.

**Pro: Claude Review learnings/memory** (`packages/pro/src/review-memory/`). Core seam =
`src/review/events.ts`: an **inert** typed event-bus (5 emit sites in `claude-review.ts`,
zero subscribers in OSS) + a learnings-provider registry, plus an optional
`priorReviewContext` prompt slot threaded `review-manager → agent → prompt` (byte-identical
when no provider). The plugin subscribes, enriches via `ctx.db`, appends `review_learnings`
rows (9 `kind`s, `dedupeKey`-idempotent), and on a new run injects a bounded markdown context
block. Two capability-gated UI surfaces in core: a pre-run "matches" panel (`ClaudeReviewTab`)
and a per-entry action log (`ClaudeReviewsModal`).

**`review/llm.ts` `cheapComplete` — the cheap-tier LLM seam (auth is load-bearing).** Core-owned
so the plugin adds no Anthropic dep. It MUST accept **every** credential Claude Review does:
explicit `ANTHROPIC_API_KEY`/local key → raw `@anthropic-ai/sdk` (metered); **otherwise the
Claude Agent SDK `query()`** (single-turn, no tools) — the same runtime Claude Review uses —
which resolves a `CLAUDE_CODE_OAUTH_TOKEN` **or an ambient logged-in `claude` session**. The
raw SDK alone can't use an ambient session (the common Pro/Max local case), which silently
broke the digest. Any new core LLM seam must follow this dual-auth pattern.


