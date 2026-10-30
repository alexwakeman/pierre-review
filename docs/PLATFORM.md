# The platform (`apps/backend/src/platform/`), Activity tab & the bot platform

> Split out of CLAUDE.md (2026-08) to keep the root memory file lean. This is the
> authoritative deep-dive for this area; CLAUDE.md keeps only the summary and the
> cross-cutting landmines. Add new detail HERE, not to CLAUDE.md. This file replaces
> PRO-PLUGIN-AND-ACTIVITY.md and PRO-PLATFORM.md (the 2026-06 open-core design plan, deleted —
> git history keeps it).

## The platform — the former Pro plugin, folded into core

**What it is.** `apps/backend/src/platform/` holds reporting (Reports, period reports, Chronology
pointers, the work-plan wording), Bots Monitoring (ROI, behaviour, the peer benchmark, bot
themes, bot classification), the synthesis seam, the blast-radius impact note, the Slack digest and
the per-workspace settings behind them. Until 2026-10-22 it was **`@pierre/pro`**, a private git
submodule at `packages/pro`, loaded by file path through `pro/bind.ts` behind an `apiVersion`
handshake and gated by `ProCapabilities`, a 402 on `/api/pro/*` and per-account entitlement.
**Removed 2026-10-22:** the submodule, `bind.ts` and the `apiVersion` gate, `contract-types.ts`,
every capability (`MeResponse.pro`, `entitledProCapabilities`, `isProPath`, `PRO_DIGEST_ENABLED`,
`proEnabled` / `PRO_CLOUD_ENABLED`), credit metering (`db/credits.ts`, `aiCredits`,
`CreditsExhausted`, `/api/pro/ai-usage`, "Track usage"), Stripe billing and the cloud benchmark
collection (their tables are dormant — [DATA-MODEL.md](DATA-MODEL.md) § Dormant tables). Every
feature here is on for every account; the AI-written parts show while `me.ai.enabled` and swap
their Run button through the one `AiRunGate`.

**How it binds.** Statically, at boot: `index.ts` → `platform/context.ts` `bindPlatform(app)`
builds ONE context (`ProContext`, `platform/contract.ts` — the name is historical) from direct core
imports and calls `platform/index.ts` `registerPlatform(app, ctx)`, which runs the platform's
migrations, registers its retention / erasure / reporting-window / event hooks, its routes and the
Slack cron. A failure there FAILS THE BOOT; there is no OSS fallback to degrade to.

- **The URL paths and table names are historical and stay.** The SPA calls `/api/pro/...`, and
  existing databases hold `pro_*` tables and the `pro_migrations` bookkeeping. Renaming either
  would be a migration and a client change for no behaviour.
- **Migrations**: `platform/migrations/*.sql`, filename-sorted, no journal, recorded by NAME in
  `pro_migrations` (`platform/migrate.ts` `runPluginMigrations`, the ONE raw-driver DDL site), run
  after core's — [MIGRATIONS.md](MIGRATIONS.md).
- **Bundled data**: `platform/data/benchmark/benchmark-fit.json` (the peer-benchmark corpus);
  `build-release.mjs` copies `migrations` and `data` to `release/dist/platform/` and asserts both.
- **Tests**: `platform/test/` runs with the backend's `pnpm test` (it used to need a hand-run
  vitest root), including the platform's cross-account isolation suite.
- **The one LLM client**: `platform/llm/seam.ts` `makeHaikuClient(ctx)` over core `cheapComplete`
  — the ONE credential ladder ([CLAUDE-REVIEW.md](CLAUDE-REVIEW.md) § The credential ladder).
  `SUMMARY_ANTHROPIC_API_KEY`, `localRoute` and the key-only Reports/Bots clients are gone. The
  generation constants live in `platform/llm/gate.ts` (`DIGEST_MODEL`, `MIN_INTERVAL_SEC`; the env
  names keep their historical `PRO_DIGEST_*` spelling).
- **The platform imports no host internals by habit** — most of what it needs arrives on `ctx`
  (`db`/`schema`/`runTransaction`/`accountIdOf`/`llm`/`queries`/`github`/`coding`/
  `registerScheduledJob`/`registerMigrations`/…). `ctx.db` is typed `BetterSQLite3Database`.
  ⚠ **`ctx.schema` is `Record<string, any>`** (`ProCoreSchema`): a leftover `ctx.schema.teams`
  type-checks perfectly, evaluates to `undefined`, and drizzle throws only when that path executes.
  Grep, don't trust the compiler.
- **Removed earlier, still worth knowing** (2026-10-18): the AI PR summary, the per-comment "Check
  review" annotations (validity / addressed / simplify), the single-thread assess and addressed
  checks, the per-hunk conflict suggestion, the per-repo digest, the Feed "Discussion themes", the
  preset prompts and the synthesis `brief` / `rollup` kinds — code, routes and SPA gone, tables
  DORMANT. The agentic features (Claude Review, AI Fix, review memory) left the plugin for core
  in 2026-10 and the issue tracker followed ([CLAUDE-REVIEW.md](CLAUDE-REVIEW.md),
  [TRACKERS.md](TRACKERS.md)). ⚠ **The CI-failure analysis card is DELETED** (`CiAnalysisCard`,
  `GET`/`POST /api/pro/prs/:id/ci-analysis`); the CI review diagnoses failing CI in core, and the
  `ai_pr_analyses` rows of kind `ci_analysis` are DORMANT. `ProContext.github.fetchCheckLogs` has no
  platform caller now.

**The workspace contract on the context** (still true, from the Teams → Workspaces refactor):

- **`BotScopeWire = { workspaceId: number; repoIds: number[] }`** on `getActivity`,
  `getBotAnalytics`, `getBotReviewComments`, `getHumanReviewComments` and `getWorkspaceInsights`;
  `getWorkspaceMetricsDetail` takes a REQUIRED `repoIds: number[]`.
- **`ctx.queries.workspaceScopeForRepo(accountId, repoId)`** — the repo→workspace direction, for the
  call sites that hold only a repo id (`insights/routes.ts`'s `GET /api/pro/insights/repo/:repoId/metrics`).
- **`ctx.queries.defaultWorkspaceId(accountId)`** — `resolveRequestWorkspaceId`'s fallback. The
  Slack sweep no longer needs it: every delivery carries its OWN `workspace_id` on its
  `workspace_slack_targets` row (platform migration 0030).
- `insights/workspace-scope.ts`: `parseWorkspaceId`, `scopeKeyFor(workspaceId) → \`ws:${id}\`` and
  `resolveWorkspaceRepoIds` (**exactly the workspace's repos**). ⚠ **The bound has to hold**: an
  unscoped AI generator must resolve to ONE workspace's repos and never to the account's.
- ⚠ **The `scope_key` COLUMN NAME is old; its VOCABULARY is `ws:<workspaceId>`.** The `ws:` prefix is
  deliberate: a bare number would alias a legacy `'3'` (team 3) onto workspace 3, whose repo set
  differs, and a stale cached AI report would then be served for the wrong repos. Platform migration
  `0020` cleared the regenerable report caches and RE-KEYED the two user-authored tables
  (`pinned_prompts`, `sprint_chat_history`, both dormant now) by case.

**Activity tab — CORE, always-on, NO AI (not flagged); the DEFAULT landing view.** A peer of
Timeline on the **tab axis** (`ActiveTab = 'timeline' | 'activity' | <Tab.key>` in
`store/pinnedTabs.ts`; the Activity console is a full-`<main>` overlay over the warm board;
`?view=activity&activityRepo`). The rail is a fixed block of pseudo-rows, **then a FLAT list of the
active workspace's repos**:

```
⚠ Pending             always — the ranked worklist
✦ Feed                always — the stream alone; a Feed link carries ?activityRepo=feed
🤖 Bots               always (label "Bots Monitoring")
◈ Reports             always — flow metrics above the period report
── repos ──           flat: no grouping headers, no colour dots, no "Other" bucket
```

⚠ **PENDING LEADS BECAUSE IT IS WHERE THE APP OPENS**
(`'attention'` is the store default and the one rail value left out of the URL; see "Default
landing = PENDING" in docs/FRONTEND.md). **Bots sits directly under the Feed** because Bots →
Settings is where the human/bot call that feeds `hiddenBotUserIds` is made — the control that
filters the stream sits next to the stream.
⚠ **"Pending" is a LABEL-ONLY rename of "Needs attention"** — the store/URL literal stays
`'attention'`: it is in bookmarks and in history entries Back replays, and an unknown
`?activityRepo=` value now lands the reader on Pending anyway. (The "Compare workspaces" rail
entry is GONE, and so is the Reports "By workspace" axis that followed it (2026-10-26) — there is
no cross-workspace comparison; `'compare'` left the
`activityRepoId` union and the URL parser, and `lib/workspaceColors.ts` went with
`WorkspaceComparisonPanel`, its only importer.) **The rail is no
longer GROUPED** — a repo belongs to exactly one workspace and exactly one workspace is ever in
scope, so there is one list, `renderRailRow`'s key is the bare `String(repoId)` (never a
`${teamId}:${repoId}` composite), and `buildTeamColorMap`/`teamGroups`/`leftoverRows`/the "Other"
bucket are all deleted. Selecting a repo shows a **compact header** (stats + thread-state bar) atop that repo's **open-PR list** (`RepoOpenPrList` — all its open PRs with
at-a-glance CI / approval standing / thread counts) THEN that **repo's own feed** (`RepoFeedHeader`
+ `RepoOpenPrList` + `<FeedView repoId>`). The rail selection is `store/filters.ts` `activityRepoId`
(`'attention'` default = Pending | `'feed'` | `'bots'` | `'insights'` | a repoId; `'retro'`
is gone with the Retro panel, `'compare'` with the Compare rail entry — no longer URL-parsed, so a
legacy `?activityRepo=compare` link falls through the parseInt branch and lands on the
`'attention'` default (Pending), normalization by construction).

- ⚠ **Branch POSITION in the right-detail chain is load-bearing.** The chain is `noReposAtAll →
  showingBots → (showingAttention && !noRepos) → showingInsights → noRepos → showingFeed`, where
  `noRepos` means "the SELECTED workspace has no repos" (the account may have plenty, living in
  other workspaces — the empty state distinguishes the two, since the remedy differs: add a repo vs.
  move one in). The lesson the deleted `showingCompare` branch taught still applies to any new
  account-wide pseudo-row: it must sit **BEFORE `noRepos`**, or it becomes unreachable whenever the
  selected workspace happens to be empty — exactly when someone is setting workspaces up. Pending is
  the deliberate exception: it is workspace-scoped, so an empty workspace yields to the "move some
  in" guidance rather than "Nothing is your turn right now" (`noRepos` waits for the repo data, so
  the board still paints before that loads).

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
open-PR list**: RepoConsole drops `RepoInsightsPanel`/`RepoOpenPrList`. `FeedView` still reads `feedIsolatedPrId` only to scope its query.
The feed-wide **"New activity — Refresh" banner is GONE**: newly-arrived items are spliced into
the list as they land, each marked with a per-card "New" chip until the reader has seen it
(`feedNewCohorts` — the rules live in [FRONTEND](FRONTEND.md) § "The Activity Feed auto-inserts").
Isolation does not interact with it.

**The rail entries' inner sub-tab bars** (all transient + URL-silent, all built DYNAMICALLY so a
tab exists only where it means something):
- **Feed** — NO sub-tab bar since 2026-10-26: the Feed is a stream only. `feedInnerTab` and
  `Activity/feedTabsModel.ts` are deleted; its "Bot classification" tab moved to Bots Monitoring
  (below), and a legacy `?activityRepo=feed&feedTab=classification` is read onto Bots Monitoring →
  Classification. (The "Discussion themes" tab went 2026-10-18; `Compare teams` left earlier.)
- **Bots Monitoring** (`BotsView`; label-only rename, rail id `'bots'`) — `ROI` (the Measure
  surface — see § The Bots ROI panel) | `Themes` (`BotThemesPanel`, LISTED only while
  `me.ai.enabled` — see § The Bot Themes panel) | `Benchmark` | `Classification` (`BotSettingsPanel`
  — who counts as a bot, its role, vendor and price; rail only, `showClassification = repoId ==
  null`; it was the Feed's "Bot classification" sub-tab, and Bots → Settings before that — a legacy
  `?botsTab=settings` lands here too). The `Advisor` tab is REMOVED (§ Bot Tuning Advisor).
  `'behaviour'` and `'themes'` were both REMOVED from `botsInnerTab` with their tabs:
  per-bot depth is the `bot-detail` pinned drill-down, the workspace charts are a collapsed
  section under ROI (`WorkspaceBotCharts`), and the bot-themes summary became the synthesis seam's
  "What they're flagging" card on Measure. The field is transient + URL-silent, so member removal
  needed no migration. ⚠ **`'themes'` HAS SINCE RETURNED to `botsInnerTab`**, in two steps: the
  themes PANEL came back first as a card at the top of the ROI branch, and was then moved onto a
  sub-tab of its own so the Bots console mirrors the Feed's `Feed | Themes` strip. The union is
  `'roi' | 'themes' | 'benchmark' | 'classification'`; a value outside it (a stale `'advisor'`)
  renders ROI. ⚠ Themes is ABSENT while AI is off (a model writes it), so `effectiveBotsTab`
  (`benchmarkModel.ts`) falls back to ROI. ⚠ Unlike `'classification'` it is
  NOT rail-only: the report is genuinely per-repo, so `showThemes` is `me.ai.enabled` alone, never
  `repoId == null && …`.
- **Insights** — the whole sub-tab apparatus is GONE (`InsightsSubTab`, `insightsSubTab`,
  `normalizeSubTab`, the guarded bar): the pane is Reports-FIRST — `PeriodReportsPanel` is its only
  body (the ad-hoc chat that lived inside it as "Ask about this period" was REMOVED 2026-10-22). Safe to delete
  outright because the field was transient and never URL-emitted (`?report=` reads into
  `insightsReportKey` alone), so no blob or link can carry a stale value.

**Landmine — the visible tab is DERIVED, never written back.** `botsInnerTab` / `insightsInnerTab`
are single scalars that can legitimately hold a key the current context doesn't render (Themes with
AI off, Classification on a repo). Each consumer computes an `effectiveTab` fallback for the RENDER only;
a corrective `set…` would permanently forget the user's choice the moment AI flickers off.

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
unresolved", `ChecksTab`) that opens the Changes tab's Threads only view filtered to that vendor (`store.threadBotFilter`); a
Feed **Humans | Bots** toggle (`store.feedAuthors`, default humans, never mixed; server-side via
the feed route's `authors`, union bot definition) + per-row vendor tag (`FeedView`); a **core
per-repo acted-on stat** (`ActivityRepoStats.botThreads/botThreadsActedOn` computed in `getActivity`
→ `RepoStats`); a **deterministic `bot_signal` Insights card** (per-vendor volume / acted-on % /
oldest-untouched backlog, computed in core `getWorkspaceInsights`, rides `/api/pro/insights`); and confirm-gated **bulk-resolve** of
`likely_addressed` bot threads (`ThreadList` → `resolve-bot-threads`). "Acted-on" = the existing
`derivedState ∈ {resolved, likely_addressed}` heuristic (approximate — the UI says so). No migration, no AI.

**Bot-Triage Platform (v2) — builds ON the v1 layer; deterministic, no AI.** Detection is now an
**account-scoped multi-signal classifier** (`sync/{review-fingerprint,reviewer-classify,reviewer-behavior,
app-attribution}.ts`), resolution order: **manual override > known vendor login > `users.githubType`
`'Bot'`/app-attribution > branded-marker fingerprint > behavioral score (medium confidence, never
auto-badges)**. `users.githubType` is captured from the GraphQL author `__typename`;
`AUTOMATED_LOGIN_PATTERNS` catches service-account PATs. ⚠ **Detection is now WHOLLY deterministic
and takes NO configuration.** A sixth step used to follow the behavioural band — an opt-in Haiku
tie-break, the only AI in the classifier — alongside a per-account login allowlist that widened
`AUTOMATED_LOGIN_PATTERNS`. Both were REMOVED with the settings that fed them (`bots.aiTiebreak`,
`bots.loginAllowlist`, plus `inhouseDetect`/`autoTagHighConfidence`/`deepDetect`), because those
settings lived in the PLUGIN's `pro_settings` while `classifyReviewer` is CORE — core could not
read a plugin table, and not one of the four call sites ever passed the flags. They were
switches wired to nothing. `app-attribution.ts` survives with no caller as a documented future
probe (`ReviewerEvidence.appAttributed` is still honoured); if a per-account allowlist ever returns
it needs a CORE home. Classifications live in the CORE account-scoped
`workspace_reviewers` (manual + auto rows, uniq `(accountId, workspaceId, authorUserId)`) — see
**One bot object** below. New shared type
**`AutomatedReviewerKind = ReviewBotKind | 'in_house' | 'pierre'`** (widens `BotSignalVendorStat.kind`).
**Pierre's own review is tagged bot-derived PER-REVIEW** (not per-account): a compute-on-read join
`claudeReviews.postedReviewId = reviews.databaseId` (both TEXT) sets `provenance` = `ai_verbatim`
(`userBody===summary`) vs `human_curated` and `kind='pierre'` on the `ReviewDetail` ONLY — **the human
who posted (their token) is NEVER reclassified**. The hidden marker `<!-- pierre:claude-review v=1 -->`
is stamped **UNCONDITIONALLY** in `review/post-seam.ts` and dogfooded through the same fingerprint
detector. ⚠ **It used to be a setting (`pro_settings bots.tagPierreReviews`) and must never be one
again**: that marker is the ONLY producer of the `'pierre'` `AutomatedReviewerKind`, so switching it
off silently deleted the Bot-ROI "Limn · Claude" row, the verbatim-vs-curated provenance,
`BotPrsDetail`'s `'pierre'` tab and the `bot_only_review` risk flag — a config toggle for turning an
analytics lane dark. The paired **visible footer** (`bots.pierreFooter`, "🤖 Reviewed with Limn +
Claude") appeared in NO detector and is DELETED. `PostReviewArgs.pierreMarker?`/`pierreFooter?` stay
DECLARED on the contract but nothing passes them. **Bot-ROI** (`getBotAnalytics(accountId,
window, scope)`, a core fold) → per-kind volume/actedOn%/untouched/`overdueUntouched`/`medianAddressedMs`/oldest/humanFollowThrough/noiseRatio/`verdict`
(keep|tune|**noisy**) + ≤12wk trend → `BotRoiPanel`, and deterministic tuning suggestions →
`BotsView` (hoisted out of the panel, § The Bots ROI panel); **cost is SERVER-resolved from the
workspace row**, with the `pro_settings` `bots.cost` blob surviving only as a null-only client
fallback. The `noisy` (ex-`kill`)
verdict is **response-time-gated**: it keys on `overdueUntouched` (untouched threads older than a
FIXED 36h grace window, `totals.overdueGraceMs`; `medianAddressedMs` per bot = time-to-addressed, display-only), never raw `untouched`, so a bot
isn't flagged noisy for threads still inside the normal response window (tested in
`bot-analytics-verdict.test.ts`). ⚠ **The verdict also takes ONE ML input** (it is no longer
ML-free): a bot past the nit gates — findings ≥ 20 AND nit share ≥ 0.7, the SAME
`ML_NIT_MIN_FINDINGS`/`ML_NIT_MIN_SHARE` pair the nit tuning suggestion uses, so chip and
advisory always agree — is **escalated `keep` → `tune`**. Escalation only: `tune`/`noisy` are
never softened, a label can never produce `noisy`, the gate reads the RAW share (not the rounded
`mlNitPct`), and `vendorSeverity` is never read. See docs/ML-SEVERITY.md. **Same-line overlap** (ADVISORY): every "same line" claim now
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
`getWorkspaceInsights` for THIS delivery's workspace), gated on **that delivery's own
`workspace_slack_targets.bot_digest`** (platform migration 0033), sent even when the AI digest is
empty. ⚠ **THE TOGGLE WAS ACCOUNT-WIDE UNTIL 0033 AND THE JUSTIFICATION FOR THAT DIED IN 0030.**
`report.ts` carried a comment reading *"the `bot_slack_digest` TOGGLE stays account-wide: it is a
'do I want this block at all' preference, not a per-team fact"* — true while there was ONE digest
per account, false the moment 0030 made the digest one row per (account, workspace): from then on a
single account flag decided the CONTENT of N independently-scheduled messages about N different
teams' bots, and a team with no bots got a section about somebody else's problem. The flag now lives
on the row that IS the delivery; 0033 copied the account value onto every existing target row (an
UPDATE, never an INSERT — a row here is a delivery, and `webhook_url` is NOT NULL), and
`pro_settings.bot_slack_digest` is dormant. `buildBotBlocks` RE-READS the target row rather than
taking the flag as a parameter, even though both callers hold it: one extra indexed read per send
buys the guarantee that the flag governing the block is the flag on the delivery being built.
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
"Review bots" section (`BotSection`) is **DELETED**. Its last knob, the "Slack bot digest" toggle, moved to the per-workspace Slack section with the
flag itself in platform 0033 (`WorkspaceSlackTargetUpdate.botDigest`), which left the section holding only an explainer
pointing at the Bots rail — a signpost, not a setting. Its "Detection" and "Limn attribution"
sections were removed earlier (above); every one of those `pro_settings` columns is left DORMANT,
like `bot_auto_resolve*`, with no migration — `ProSettings.bots.slackDigest` survives on the wire as
a husk that always reads `false`. ⚠ **`data-testid="bot-settings-section"` IS GONE WITH IT** — shot
7d in `scripts/capture-shots.mjs` targets `data-testid="bot-settings-panel"`, the classification
screen (now Bots Monitoring → "Classification"; a legacy `?botsTab=settings` or
`?feedTab=classification` lands there). The
per-reviewer `DetectedReviewersTable` lives there. Deterministic tuning suggestions are **advisory
only** (no mute action), hoisted OUT of the ROI panel into `BotsView`. **Migrations:** core `0027` (`users.github_type`), `0028` (`bot_review_classification`), `0029`
(`bot_mute_rules`, now orphaned), `0042` (RE-KEY to `repo_reviewers`, per repo, and
DROP `bot_review_classification`), `0043` (NORMALISE the actor grain out into
`account_reviewers`), **`0045` (COLLAPSE both onto `workspace_reviewers`, and DROP
them)**; platform `0009` (`pro_settings` + 11 `bot_*` columns), platform `0019` (now a
guarded NO-OP), platform `0020` (the `bot_cost_json` → `workspace_reviewers.monthly_cents` backfill).
**Landmines:** (1) Pierre = **per-review** provenance — the human
author is never reclassified; (2) resolving bot threads is ALWAYS user-initiated + confirm-gated over
**only `likely_addressed`** threads, never a merge (no automatic/cron path exists); (3) the frontend
must use `automatedReviewerMeta()`, NOT `BOT_VENDOR_META[kind]`, for an `AutomatedReviewerKind`;
(4) `getBotAnalytics` **server-resolves cost from the workspace row** — a null there is FINAL, the
client-side `pro_settings` overlay survives ONLY as a null-only fallback for logins the platform's
backfill could not attach to a row (it only ever UPDATEs, never INSERTs), and the price must **never
be summed across WORKSPACES**; (5) a **JUDGEMENT write may never touch identity, an IDENTITY write
may never touch judgement, and NEITHER may touch the price** — the two-table boundary that used to
guarantee that is gone, so the guarantee is now (a) two independent provenance columns honoured by
NARROWED `set:` objects and (b) cost living on its own route so no combined body can address the
column. It is **NOT** `additionalProperties:false` (ajv runs `removeAdditional:true`, so it strips
unknown keys rather than rejecting them).

**One bot object: `workspace_reviewers` — the quality-check ROLE, and the merge that ended the
two-table split (CORE, deterministic; migrations `0044`/`0045`).**
The two migrations are ONE change in two steps, and are best read together:

```
0044  RE-HOME   repo grouping:  teams (m2m)  →  workspaces (1:N), + a Default per account
0045  COLLAPSE  the bot object: repo_reviewers + account_reviewers → workspace_reviewers
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
  **WORKSPACE**. There is no longer an account-wide *counterpart*: detection takes no configuration
  and the Limn marker is unconditional, and the Slack bot-digest toggle became a field on the
  DELIVERY row in platform 0033 — so `BotSection` in the Settings modal is DELETED outright. Price is
  edited INLINE on the reviewer card
  (`DetectedReviewersTable`) and its label reads **"Price for this Workspace"** — not a bare "Price",
  which on an otherwise workspace-scoped card would read as a global setting and invite exactly the
  cross-workspace totalling that is forbidden. `BotSection`'s old "Per-bot cost (account-wide)"
  picker is DELETED — do not reinstate it. Moving the table out of that modal also closed a real
  gap: it was gated on a plugin capability, so an `npx` user without the plugin could not classify a
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
member: a login would have to give up its brand identity to be marked a linter, and every
review-bot cohort (`REVIEW_BOT_KINDS`, the peer benchmark's vendor cells) would have to learn to
exclude it.
A quality check stays `automated: true`, so `excludeBots`, the Feed people/bots split and the vendor tag are
unchanged. **The role splits exactly two sets** (`automatedReviewerUserIds(accountId, workspaceId, role)`
takes the filter POSITIONALLY and REQUIRED, so every call site had to be re-read). ⚠ **`null` is gone
from every workspace-scoped getter**: the scope is a `BotScope {workspaceId, repoIds}` whose
`repoIds` is always concrete, and `[]` now simply means "this workspace is empty" — an ordinary
state (a freshly created workspace), not an edge case. The one account-wide sweep there
was, the cross-org benchmark rollup (removed 2026-10-22), got **two explicitly named functions**
rather than a null sentinel, and they remain, caller-less:
`automatedReviewerUserIdsForAccount(accountId, role)` (the UNION over all workspaces) and
`classificationKindForUserForAccount(accountId)` (a non-null vendor kind in ANY workspace WINS, ties
broken by lowest `workspaceId`). The two role filters:

| `role: 'review'` — SCORING | `role: 'all'` — EXCLUSION / visibility |
|---|---|
| behaviour + per-PR behaviour (`getBotBehaviourAnalytics`/`getPrBotBehaviour`), dedup, bot themes (`getBotReviewComments`), all three resolvable-thread-backlog getters, `getActivity`'s acted-on stat, `getWorkspaceInsights`' `bot_signal` | the bots-only feed (`getConsolidatedFeed`), the human-themes exclusion set (`getHumanReviewComments`), human-follow-through detection (inside `getBotVendorPrs` — "was the replier a HUMAN"), **bot-only PRs** (`getBotOnlyReviewPrs`), **and `getBotAnalytics`** |

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
the duplication. **My Turn / "FYI" is CORE** — it was moved back out of the plugin early on (the `feedMyTurn`
capability and the `registerFyiProvider` seam were removed; `feed/fyi-provider.ts` is gone). The participation compute lives in the core module **`src/feed/my-turn.ts`** (`enrichMyTurn`
+ reason pills + `countNewMyTurnFeedItems`); `getConsolidatedFeed` calls it directly, and `/api/me`
uses `countNewMyTurnFeedItems` for `me.newFeedItems`. Everyone gets the My Turn cards/toggle/badge
+ Welcome-back banner. `isMyTurn` rows are the **content-rich, yellow-bordered
cards** with a "My Turn" badge (there is no "My Turn only" filter — Pending owns that); they're
uncapped, plain activity is capped (`FEED_EVENT_CAP`). Cards render the **full comment/review body
as markdown**, the affected threads inline, + a merge/review credit line
(`mergedById`/`reviewers`). The **`authors=humans|bots`** param splits the stream per item BEFORE
the page cap, using the UNION bot definition `hiddenBotUserIds` (`users.isBot` ∪ `github_type='Bot'`
∪ the review-bot and `AUTOMATION_VENDORS` logins ∪ the workspace's automated set, a manual "human"
winning over every half) — never mixed; a person's activity tab picks its side from the person
(derive-for-render, never written back). **PAGINATED**
— `useConsolidatedFeed` is a `useInfiniteQuery` (page 0 loads `FEED_PAGE_SIZE`=50, "Load more" by
`offset`; `total` tells the client when to stop). **No "seen"/Done concept.**
**Click → pr-DETAIL tab:** clicking ANY feed card → `usePinnedTabs.openPrDetailTab(meta,
{fromActivity, returnItemId: item.id})` opens the full-height PR detail tab (its Show/Focus links
then drive the timeline), pushing a Back-to-Activity history entry; **Back returns to the feed and
scrolls + flashes the clicked item** (`activityReturnItemId`). A digest's `#N` PR ref also opens a
`pr-detail` tab. (The old pr-focus-on-click, the My-Turn tab, and the MyTurnPanel/FeedPanel/pills
are all gone.)

**No CI-failure, Claude Review or "Needs review" rows.** The synthesized `ci_failed` /
`trunk_ci_failed` / `claude_review` feed kinds, their builders and their pills are DELETED — Pending
owns those. Every feed item is an `events` row.

**The annotations module (`platform/annotations/`) holds ONE kind, `impact`** — the blast-radius
impact note ([BLAST-RADIUS.md](BLAST-RADIUS.md)). Its table `pr_comment_annotations` (platform
migration `0017`) is keyed `(accountId, kind, targetKind, targetId)`; the comment kinds
(`validity` / `addressed` / `simplify`, the "Check review" platform) were REMOVED 2026-10-18 and
their rows are DORMANT, skipped by the read. What it kept from that platform: the GET is a pure
cached read (nothing generates on PR open), the POST `{kind:'impact'}` is the ONE billing path,
and the run route watches `reply.raw.on('close')` (never `req.raw` — BACKEND.md § the POST close)
to stop a run the reader walked away from. ⚠ **A run answers 200 for outcomes that produce
nothing** (no credential), so `AnnotationRunResponse.noAuth?` says it outright and
`lib/annotationRun.ts` `annotationRunMessage` turns it into words — a click must never be silent.
(The per-repo digests, Retro, preset prompts and the Reports chat that used to be described here
are gone; their tables are DORMANT.)

### The host query seams and the synthesis platform

What the platform reads from core it reads through `ProHostQueries` (`ctx.queries`) — the folds stay
in core, the routes and narration in the platform:

- `getBotBehaviour(accountId, window, scope, botUserId?)` — the CORE rollup
  (`getBotBehaviourAnalytics`) behind `GET /api/pro/bot-behaviour` (it used to be core
  `/api/bot-behaviour`). The optional
  `botUserId` narrows to ONE bot for the bot-detail tab's fetch (must not compute fifteen bots'
  heatmaps to render one); core admits only ids in the workspace's role-`'review'` reviewer set,
  so a foreign/non-reviewer id yields the EMPTY response, never someone else's data.
  (`getPeriodMetricsForWorkspaces`, the seam behind the Reports "By workspace" axis, was REMOVED
  with it 2026-10-26.) And `getSynthesisInput` (→ `db/synthesis-input.ts`), `getDailyBriefCounts` (→ `db/daily-brief.ts`),
  `getPersonPeriod` (→ `db/person-period.ts`, caller-less since the People report went), each
  TYPED with the shared wire type (`SynthesisInput`/`DailyBriefCounts`/`PersonPeriod`) **because
  the platform's payload hashes fold those very values**, and a cast-and-hope seam is exactly where
  a hash formula drifts.

### The synthesis seam

**`GET`/`POST /api/pro/synthesis` + `pro_synthesis`, platform migration `0027`.** ONE endpoint pair
and ONE cache table serving every "have the model summarise this set" grain — per-feature endpoints
are exactly what the plan's D3 forbids. The SPA shows the cards while `me.ai.enabled`. The contract:

- ⚠ **Since 2026-10-22 only the four CLUSTERS kinds remain** — `'brief'`/`'rollup'` went on
  2026-10-18 and `'person'`/`'person_report'` with the People report; the ORDERING and SECTIONS
  modes (their prompts, parsers and `StoredSynthesis.ordering`/`sections`) are deleted. The text
  below is the history of how those grains were built; their stored rows are DORMANT.
- **Seven `SynthesisScopeKind`s in two modes.** Four CLUSTERS grains — `'bot-flagging'`,
  `'bot-threads'` (windowless — a current-state backlog), `'bot-volume'`, `'workspace-bots'`
  (the workspace-grain bots question, still serving the three drill-down cards) — three ORDERING
  grains — `'brief'`, `'rollup'`, `'person'` — and the SECTIONS grain
  **`'person_report'`** (the People report's per-person narrative). All six non-cluster grains
  are windowless in the enum slot; the two PERSON kinds carry their period as real
  `fromMs`/`toMs` bounds, sanity-capped at `PERSON_WINDOW_MAX_MS` (200d) so a client cannot mint
  cache rows for arbitrary spans, and drop every bot-narrowing field. ⚠ `'person_report'` shares
  `PERSON_KINDS` (subject triple, required-triple 400, whole-workspace scope, `u:`/`pw:` tail)
  but is deliberately NOT in `ORDERING_KINDS` — the `k:` slot is what keeps the 1:1 narration and
  the report's sections in separate cache rows for one subject+period.
- **Scope canonicalisation IS billing correctness** (`synthesis/scope.ts`): defaults filled,
  fields a kind does not consume DROPPED before keying — two spellings of one drill-down must
  not mint two cache rows and bill twice. Validation splits by who minted the value:
  `workspace`/`repoIds` DEGRADE (Default / membership intersection — a stale bookmark), every
  population-naming param (`kind`, `direction`, `select`, `severities`, `category`) REJECTS →
  400, or the card would silently summarise a different set than the list beside it. The
  canonical serialised `scope_key` (fixed slot order, absent slots `'-'`) is the row identity
  AND the client's shared mutation-key segment.
- **CLUSTERS mode = D4 enforced server-side**: the model returns
  `{clusters: [{label, itemIds[]}], remainderIds[]}`; ids outside the input set are DROPPED and
  logged, counts are `|validated itemIds|` computed server-side, the remainder is recomputed. A
  completely unparseable output **502s** — the deterministic list stays primary and the spend is
  already on the ledger. **ORDERING mode never 502s on a weak parse**: each item is an input ref
  + a phrase that must be **DIGIT-FREE** (regex-validated); an invalid item (unknown/repeated
  ref, any digit) is dropped and its line renders TEMPLATED; an entirely unparseable
  output is an empty list, STORED so the click doesn't loop-bill. `'person'` swaps only the
  system prompt (prep-not-scoring register) — brief/rollup prompts stay byte-identical, no
  `SYNTHESIS_PROMPT_VERSION` churn. **SECTIONS mode never 502s either** (see § "The People
  report"): it keeps the mode-agnostic ORDERING user payload byte-for-byte and swaps only the
  system prompt, and its staleness rides core's `PERSON_REPORT_VERSION` rather than the global
  prompt version.
- **The payload hash** (`synthesis/hash.ts`): sha256 over the SORTED input item ids + each
  item's stable created-at + the analyzed/total counts + `SYNTHESIS_SCHEMA_VERSION` +
  `SYNTHESIS_PROMPT_VERSION` + the scope key. Nothing `Date.now()`-derived, nothing hydrated —
  the free GET recomputes it from `getSynthesisInput` alone to report `stale`, and a
  version-const bump is self-executing invalidation (the period-vector discipline).
- **`pro_synthesis`** (migration `0027`): one row per `(account_id, scope_key)`
  (regenerate = overwrite via `onConflictDoUpdate` on exactly that declared unique — the
  0042/0045 lesson is cited AT the write); `output` is validated JSON as **TEXT**
  (one serializer owns the blob); `input_count`/`analyzed_count` are REAL COLUMNS
  because "Summarised X of Y" is the disclosure that keeps a capped synthesis honest and must
  survive output-shape drift. Deliberately NO foreign keys (resolver-produced workspace ids
  only; a regenerable scope-keyed cache, the `bot_theme_reports` family). Erasure: listed in
  `retention.ts` `eraseProByAccountId`; deliberately NOT in `pruneProByPrIds` (no pr_id grain —
  it ages by STALENESS, not deletion).
- **Cost discipline + the TOCTOU fix.** The themes stack: per-account in-flight guard →
  min-interval → payload-hash $0 cache → `recordAiUsage` on real generation only.
  ⚠ **The in-flight slot is claimed SYNCHRONOUSLY — no `await` may sit between the `has()` and
  the `add()`.** Two POSTs can land in one render cycle (the deleted `BriefStrip` fired the brief +
  rollup pair); with an await
  in that gap both pass the check, both miss the not-yet-written hash cache, and both bill. The
  `finally` releases the guard on every path. The min-interval is armed only when
  money actually moved (a $0 cache hit never locks the account out), and `recordAiUsage` is
  called the moment the model answered — BEFORE the parse can fail, because the spend happened
  either way.
- **§8.3 — one predicate, three consumers.** `db/synthesis-input.ts` routes every kind through
  the drill-down's OWN fold (`foldBotFlaggingPopulation`, `getResolvableBotThreadPrs`,
  `foldPrBotVolumePopulation`, `getBotReviewComments`, the brief fold), so the model summarises
  exactly the set the receipt list shows — a synthesis with its own SQL would drift silently.
  Rows come back capped with `analyzed`/`total` + `truncated`, never silently truncated.
- **Bots Themes was retired into this seam and then REVIVED beside it.** The seam's
  `'workspace-bots'` kind is untouched and still serves the three drill-down SynthesisCards;
  what came back is the merged **Bot Themes panel** (§ below), which replaces the SynthesisCard
  mount on the MAIN Bots view only. `bot_theme_reports` was never dropped, so the revival needed
  no migration.
- **SECTIONS is the THIRD output mode** (`'person_report'`, the People report's per-person
  narrative). CLUSTERS returns labelled id-clusters; ORDERING returns digit-free `{ref, phrase}`
  lines; SECTIONS returns `{sections:[{id, prose, refs}]}` over a CLOSED four-id vocabulary
  (`worked_on` / `nature_of_changes` / `collaboration` / `waiting_and_risk` —
  `PersonReportSectionId`). `parsePersonReportOutput` drops an entry per defect (unknown or
  ALREADY-ACCEPTED duplicate id, empty/over-`SECTION_PROSE_CAP` prose, any digit, zero surviving
  refs after the `⊆ input` filter) and returns `[]` rather than throwing — the row is STORED
  anyway so a click cannot loop-bill, and the deterministic vector + evidence cards stay primary
  (§8.20). A rejected entry does NOT burn its section id, so a later well-formed duplicate can
  still land (the `parseOrderingOutput` rule). It reuses `buildOrderingUserPrompt` VERBATIM —
  the "BRIEF LINES JSON" heading must stay byte-identical, since renaming it is a
  `SYNTHESIS_PROMPT_VERSION` event.
- ⚠ **The D4 digit gate is `\p{Nd}\p{No}\p{Nl}`, not `[0-9]`.** Item bodies are attacker-authored
  (PR titles, comment excerpts), and a prompt-injected "write the count in full-width digits"
  walked straight through the ASCII spelling: `２３`/`٣` (Nd), `²` (No) and `Ⅻ` (Nl) all read as
  numbers to a human while `[^0-9]` waved them through. The gate is now
  `/^[^\p{Nd}\p{No}\p{Nl}]*$/u`, shared by ORDERING and SECTIONS and mirrored by the chat's
  follow-up validator. Spelled-out counts ("twenty-three") stay regex-unverifiable and remain a
  prompt-only rule by design.

**The daily brief (`GET /api/daily-brief`, CORE — counts only).** `db/daily-brief.ts`
computes on read behind a module-level 5-min TTL cache (zero core migrations, the plan's D5);
`?rollup=1` adds one count line per OTHER workspace (capped 12, each line riding the same TTL).
⚠ Every line REUSES the fold of the surface it deep-links to — the consolidated feed's my-turn
facet under the default 'hide' lens (inheriting its actor-less CI-row exclusion), the
`/api/attention` card counts, `getResolvableBotThreadPrs().totalThreads`, the repos
default-branch head columns, and a NARROW volume-only anomaly slice (deliberately not the full
behaviour compute — that is priced for an explicit tab open, not an every-morning strip). Never a re-derivation that can disagree with the surface it links to. Rate tier
`search`, pinned. This route never touches AI and never carries cost/money (the `'brief'`/`'rollup'` narration kinds
were removed 2026-10-18) (§8.18: the rollup loops per
workspace).

**The my_turn RELEVANCE split and its count pairs.** `DailyBriefCounts` and
`WorkspaceInsightsResponse` carry more my_turn figures beside `myTurn`/`myTurnTotal`:
`myTurnPersonal`/`myTurnPersonalTotal` (unchanged in meaning), plus the three-way split
`myTurnDirect` · `myTurnMaintained` · `myTurnOther`, **each with its own uncapped total**. Every
one of these, and `MyTurnPr.relevance` / `MyTurnCard.relevance` themselves, is a trailing-optional
addition.

- ⚠ **`personal` CONFLATED TWO RELATIONSHIPS; `relevance` is that union un-collapsed.**
  `MyTurnRelevance` is `'direct'` | `'maintained'` | `'none'`: work tied to YOU (card copy "YOUR
  TURN") · a new PR by somebody else in a repo you maintain — ORBIT, NOT OWNERSHIP ("IN YOUR
  REPOS") · everything else ("REVIEW OR REPLY"). `personal` survives as a DERIVED
  `relevance !== 'none'`, still written by the server on every row, still meaning exactly what it
  always meant ("may a notification surface interrupt?"). Read `relevance` for anything that
  LABELS a row; a card that writes "YOUR TURN" off `personal` claims ownership of a stranger's
  work in a repo you happen to have write on — the defect the split exists to end.
- **The rule lives in `getMyTurn`, once.** Every section but "New PRs" is `'direct'` by
  construction — it exists only because the viewer is involved, or because they added the type in
  Settings → My Turn (the own-work promotions and red default branches) — and is stamped through
  `relevanceFor`. "New PRs" (`watched_repo_pr`, off by default) is the one section that needs a
  test: the MAINTAINER test (`viewerMaintainedRepoIds`) asks *is this your patch of ground* —
  `repos.viewerPermission` ∈ WRITE/MAINTAIN/ADMIN **∪** the repos `getMergers` says the viewer has
  landed a PR on (default branch only) — and yields **`'maintained'`**, else `'none'`. The MENTION
  arm that used to lift a New PR to `'direct'` is gone: a mention is its own `mention` type
  ([BACKEND.md](BACKEND.md) § My Turn, S6), `'direct'` **even in a repo the viewer only READS**.
  The insight-card block READS `relevance` off the row and folds `personal` from it — the `since`
  rule applied to the second question this fold would otherwise answer twice, and one source of
  truth so the board's label and the notification's count cannot disagree about the same card.
- **Mentions are DERIVED OFFLINE** (`sync/mention-scan.ts` → `pr_mentions`, stamped with the
  newest human mention's time and author), never computed in the request: the underlying question
  is a substring scan over every comment body in scope and this fold runs on every Feed landing.
  ⚠ **Absence never widens** — a row the scanner has not stamped yet, or no rows at all, means no
  mention card. See [DATA-MODEL.md](DATA-MODEL.md) § `pr_mentions` and [SYNC.md](SYNC.md)
  § "@mention derivation".
- ⚠ **RELEVANCE NARROWS NOTHING.** `GET /api/my-turn` returns every row of every shown type (the
  CLI status board needs the full set) and the Pending board keeps painting every card — a PR in a
  repo you only read does still need a review. (Switching a TYPE off in Settings does remove its
  rows, everywhere at once — a separate gate, inside `getMyTurn`.) The flag exists for the surfaces that INTERRUPT (welcome-back banner, Workspace-dropdown
  badges, browser notifications), which must not summon you for 425 strangers' PRs.
- ⚠ **EVERY total is folded off the PRE-CAP ranked array**, in one pass next to `myTurnTotal`.
  Counted after the 50-card slice any of them would be bounded by 50 and stop being a total.
- **The split is MUTUALLY EXCLUSIVE and EXHAUSTIVE**, at both grains:
  `direct + maintained + other === myTurn(Total)` and `direct + maintained === myTurnPersonal
  (Total)`. Notifications and the Workspace badges count `myTurnPersonal`; the banner shows the
  split ("2 yours · 3 in your repos") off `myTurnDirect` and `myTurnMaintained`. (`myTurnOther` was
  the deleted Feed brief strip's "M need review or reply" line; it is still sent, with no reader.)
- ⚠ **THE PAIR MUST BE NARROW-WITH-NARROW, AND NO COUNT MAY BE A SUBTRACTION.**
  `myTurnCapDisclosure` fires only when the displayed figure EQUALS the count it qualifies, so a
  narrow line borrowing `myTurnTotal` as its denominator would both mix two populations in one row
  and silently lose its "of N" on every capped workspace. **`myTurnOther` is therefore its own
  fold, never `myTurn - myTurnPersonal`**: the subtraction is arithmetically correct and produces
  no denominator at all, which is the same defect wearing a different hat. That is the entire
  reason every one of these counts ships with a matching `…Total`.

**The `ci_failing` card — red builds the VIEWER is on the hook for (CORE, deterministic, no AI).**
A `ci_failing` InsightKind, computed in `getWorkspaceInsights` beside `my_turn`, counted by the
brief as `ciFailing`/`ciFailingTotal`, and painted on the "Needs attention" board like any other
card. **TWO ARMS, carried on one kind by `CiFailingCard.arm`:**

- **`'your_pr'`** — an open, non-draft PR you AUTHORED whose head CI is red. No new query: it folds
  the open-PR population `getWorkspaceInsights` already builds (`pull_requests.ci_status` is NOT
  lean-gated — `sync/upsert.ts` writes it on every walk; only `check_runs` is), so it hydrates
  nothing.
- **`'trunk'`** — the default branch of a repo you MAINTAIN is red RIGHT NOW
  (`repos.default_branch_ci_status`), naming the LANDING PR of the red head through
  `resolveTrunkCommitPrs` (which now also selects `mergedById`) and setting `viewerMerged` when
  that was you. The maintainer set is the SAME `viewerMaintainedRepoIds` My Turn's relevance gate
  uses — "a repo you maintain" means one thing in this app.

- ⚠ **RED IS ALWAYS THE PAIR `failure` | `error`**, never one of them (`error` is GitHub's
  infra/permissions half — the one that most often needs a human). ONE spelling, `RED_CI_STATUSES`,
  used by both the row test and the SQL `inArray`.
- ⚠ **THE BLOCK RUNS ABOVE `getWorkspaceInsights`' `openPrIds.length === 0` EARLY RETURN**, and
  that guard is WORKSPACE-WIDE. The trunk arm needs no open PR, so under the guard a quiet
  workspace paints a green board over a red trunk. `ci-failing-cards.test.ts` pins it with a
  SECOND workspace of quiet repos — with everything in one workspace the trap cannot be tested.
- ⚠ **EVERY PR FIELD IS NULLABLE AND A NULL IS ORDINARY.** ~11% of red heads are DIRECT PUSHES to
  trunk (a legitimate steady state, not a sync gap). The card still says trunk is red; it just
  names no PR.
- **It names who opened its PR** — `authorId`, `authorIsBot`, `authorBotKind`, `automation`, all
  REQUIRED: the viewer on `your_pr`, the LANDING PR's author on `trunk` (`resolveTrunkCommitPrs`
  selects `authorId` and `dependencyVendor` for it), and nobody when no PR resolved. The Pending
  board's People / Automation lens then has one predicate for every card. A dependency PR's red
  build is not a `your_pr` card at all: it is on its Dependencies card.
- ⚠ **`viewerMerged` ATTRIBUTES LANDING, NEVER BREAKING** — trunk may have been red before that PR
  merged, and the card says so on its face.
- **TWO NEIGHBOURING QUESTIONS ARE DELIBERATELY NOT BUILT** (measured on real data, cut, and
  recorded in the code where somebody would reach for them): *"PRs I MERGED whose CI is failing"* —
  `pull_requests.ci_status` is FROZEN at the merge instant (a merged PR is never re-walked), so it
  answers "did this land red", a retro metric, not an inbox item; and *"the commit that TURNED
  trunk red"* — trunk CI is non-monotone, 21% of `branch_commits` rows are ciStatus `unknown`, and
  chronically-red repos have no streak start, so honest transition attribution needs a NEW
  append-only per-commit table plus a sync step.
- ⚠ **`ciFailing` AND `trunkRed` ARE TWO POPULATIONS, NOT ONE.** `trunkRed` names EVERY red trunk
  in the workspace; `ciFailing` counts the subset that is YOURS plus your own red PRs (the
  `ci_failing` cards). Folding either into the other gives one of them a number its list does not
  match. (Both are still sent on the daily brief with no SPA reader since its Feed strip was
  deleted.) What the reader PROMOTED into My Turn
  (Settings → My Turn) leaves them: a promoted red build leaves `ciFailing`, a promoted red trunk
  leaves both (`trunkRed` drops `myTurnTrunkRepoIds` before its cap), and each is counted once, in
  `myTurn`.
- **Cap:** it shares `INSIGHT_CARD_CAP` (15) with the survey kinds but, like `my_turn`, DISCLOSES
  it (`ciFailingTotal`; the board states its cut with `capSentence` — the brief-line rule was
  deleted with the strip) — a worklist the viewer clears may not be
  silently capped. Everything is trailing-optional.
- **Which checks are failing.** `CiFailingCard` and `MyTurnTrunkCard` carry REQUIRED
  `failingChecks: string[] | null` + `failingCheckTotal: number | null`; `InsightPrRef` carries
  them OPTIONAL, absent when there are no names (never `[]`, never `0`). Bare names, deduped,
  alphabetical, at most `FAILING_CHECKS_SHOWN` (3, `packages/shared/src/pending-rules.ts`), with
  the uncapped total behind them. `'your_pr'`: the newest `ci_status_events` row for the PR's
  CURRENT head, used only when that row is red. `'trunk'` and the promoted `trunk_red`: the head's
  `branch_commits` row, through `trunkHeadFailingChecks` (MERGE-CI-TRUNK.md § Default-branch
  status), looked up by the red head itself, so a direct push is named too. ⚠ **null is "no names",
  never "0 failing"** — render the CI label alone. ⚠ **The total counts every STORED name, not every
  failure**: a trunk head's row keeps at most `MAX_FAILING_CHECKS_PER_COMMIT` (20) and a PR's sync
  reads at most 100 contexts, so a total AT a bound is a floor (one stored trunk row sits at 20; the
  PR side peaks at 38). ⚠ **Only `GET /api/attention` folds them** — `getWorkspaceInsights(…, {
  withFailingChecks: true })`; the daily brief, the work plan's uncapped fold and every platform
  consumer (sprint report, Slack, `/api/pro/insights`) get null or absent and
  pay nothing for them. ⚠ **DISPLAY ONLY**: never in `detail`, `insightsHash`, `WorkPlanFacts` or
  any model payload, so no stored report or plan re-bills.
- **The platform side:** `insightsHash` gets an explicit `ci:<arm>:<repoId>:<sha|prId>` case, and the
  sprint-report payload loop an explicit `continue`. ⚠ That `continue` is load-bearing — falling
  through would count the card into the repo's importance ranking (`cards × 3`) and add a PR ref
  for an issue the report never lists.

> ⚠ **REMOVED 2026-10-22.** The route `GET /api/pro/insights/person/:userId` and both narration kinds are
> gone. `db/person-period.ts` stays, wired to the caller-less `ProHostQueries.getPersonPeriod` seam
> (and pinned by `person-period.test.ts` + `verify:isolation`), so the description below still
> describes what that fold returns.

**The person vector (`GET /api/pro/insights/person/:userId`, `db/person-period.ts`).** The 1:1
prep read: a small fixed vector for one person in one workspace over one cadence period, with
its own **`PERSON_METRICS_SCHEMA_VERSION` (= 1, in `@pierre-review/shared`)** and per-person
coverage honesty (onboarded-mid-window repos AND a first-observed-mid-window person both
disclose). Window-pure two-sided predicates on every windowed key; THREE keys are deliberately
`basis: 'live'` (`their_pr_threads_addressed` / `awaiting_their_review` / `open_prs_authored`)
— now-questions a stored period must not pretend to reproduce. ⚠ `users` is GLOBAL: the subject
is admitted only via a workspace activity probe (the `listUsers` precedent), only login/name
leave, and the ONE lane resolver rejects automation-lane actors (`null` — no 1:1 with
Dependabot); the first-human-review figure reuses `loadFirstHumanReviewHours` via its
authorUserId narrowing (the one-fold rule). **Prep, not scoring**: one userId in, one person
out — no batch/ranking spelling exists at any layer. The route degrades without oracles
(unknown/foreign/bot id and off-grid period are all the same `person: null`;
`cadenceConfigured: false` is the one distinct refusal), never generates, and sits EXPLICITLY on
`[search, read]` in core's `tierFor` (not inherited from the `/api/pro/` catch-all). The
narration rides synthesis kind `'person'` (and, for the People report, `'person_report'`).

⚠ **"Prep, not scoring" was RESTATED for the People report, not relaxed.** The report renders
several sections by LOOPING this route one person at a time, client-side — that is sanctioned.
What is still refused at every layer is a cross-person SHAPE: no batch/list spelling of the
route, core takes one id, and every consuming surface orders sections ALPHABETICALLY with no
rank, no cross-person sort by any metric and no comparison table. The guardrail comments in
`db/person-period.ts`, `insights/person-routes.ts` and `PeriodPeopleSection.tsx` were reworded
in lockstep; if they ever disagree, the narrow reading (no cross-person shape) wins.

### The sprint cadence is PER-WORKSPACE (platform migration 0029)

`pro_workspace_settings` — one row per `(account_id, workspace_id)` holding
`sprint_cadence_days` + `sprint_start_at`, with the named composite FK
`pro_workspace_settings_workspace_account_fk` against core's `workspaces (id, account_id)`.
`resolveSprintCadence(ctx, accountId, workspaceId)` (settings/store.ts) is the ONE resolver — the
account-level fallback was retired in 0031; `GET`/`PUT
/api/pro/settings/workspace?workspace=<id>` is its control surface.

⚠ **A cadence change is REFUSE-AND-PRESERVE, and it closed three silent defects** (a stored artifact
being overwritten in place, most of the history listing as clickable-but-blank, and every colliding
row reading `stale` forever). The full contract — `cadenceCurrentPool`, the widened
`workspace_period_reports` unique index and the archive at `<periodKey>@cad<days>` — is in
[PERIOD-REPORTING.md](PERIOD-REPORTING.md) § The sprint cadence is PER-WORKSPACE.

### The Slack digest is PER-WORKSPACE (platform migration 0030), bot block included (0033)

`workspace_slack_targets` — one row per `(account_id, workspace_id)` holding `webhook_url`,
`cadence`, `hour1`/`hour2`, `timezone`, `bot_digest` and the **per-row** `last_sent_slot` /
`last_sent_at`, with
the named composite FK `workspace_slack_targets_workspace_account_fk` against core's
`workspaces (id, account_id)`. Control surface: `GET`/`PUT`/`DELETE
/api/pro/slack/target?workspace=<id>`, plus `POST /api/pro/slack/test?workspace=<id>`.
The host hands the platform `host.appWebUrl` (the SPA's browser-facing base) for deep links.

**A ROW IS A DELIVERY TARGET.** It exists ⇒ that workspace's digest is generated on this schedule
and posted to this channel; no row ⇒ nothing.

Slack is a TEAM feature: no personal tab, no card ABOUT the configuring account, never its name.
(Until 2026-10-22 it was strictly Pro, `slackDigest`, 402 on every route; it is ungated now.)

**WHAT THE MESSAGE SAYS — the TEAM tabs of the Pending board** (`slack/pending-blocks.ts`),
then a SHORT AI sprint summary (one section), then the optional bot block, then the footer link.
The per-repo AI digests are no longer sent. The board comes from the OPTIONAL host seam
`ProHostQueries.getPendingBoard(accountId, workspaceId)` → `PendingBoardSnapshot` (core
`getPendingBoardSnapshot` over `buildPendingBoard`, the ONE fold `GET /api/attention` also calls, so
the two cannot list different cards). The seam runs WITHOUT the route's two live extras
(failing-check names, suggested reviewers): a cron send spends no GitHub budget.
- ⚠ **THE AUDIENCE IS THE TEAM.** Sections follow `PENDING_TABS` minus `PERSONAL_PENDING_TABS`
  (My turn, Claude reviews — one person's board, the configuring account's): Needs fixing, Waiting
  on review, Unanswered threads, Ready to land, Dependencies. Nothing names the configuring account.
  A new tab key fails to compile in `PENDING_TAB_LABEL` until it is labelled or declared personal.
  ⚠ A CARD ABOUT THE VIEWER is dropped from a team tab too (`isViewerScopedCard`): `ci_failing`'s
  `your_pr` arm lists only the configuring account's own red PRs — neither listed nor counted. A
  red default branch and a conflicting PR stay: facts about a branch or PR that the viewer's
  access merely COVERS.
  The sprint report drops EVERY `my_turn` card too (no hash moves — my_turn has no hash slot).
  Empty sections are skipped; the review-load people strip is not a PR and is left out.
- ⚠ **A PR IS MENTIONED ONCE**, in the first tab (board order) that lists it; a red default branch
  likewise, keyed by repo. A later tab neither lists nor counts it.
- Top `PENDING_DO_NEXT_SIZE` (5) per section in the board's own order (`tab.cardIds`), then
  "and N more" linking to that tab (`?view=activity&workspace=<id>&activityRepo=attention&attnTab=<key>`).
  N is the tab's `total` less what this section listed and what an earlier section already named;
  cards past `boardListCap` cannot be de-duplicated, so N can over-count a PR that also sits in an
  earlier tab beyond its cap.
- Card wording is a small server-side map (`pendingCardText`, `MY_TURN_REASON_TEXT`) — a SECOND
  copy of the SPA's `pendingLabels.ts`, which the backend cannot import. It reads only fields the
  card carries; `test/slack-pending-blocks.test.ts` fails on a kind or reason with no wording.
- ⚠ **LIVE STATE**: nothing from the board enters any payload hash (the sprint report's included).
- Block budget, counted across the top level and every attachment: header 1 + 5 team tabs × ≤ 2
  sections + sprint 1 + bot 1 + footer 1 = 14, well under Slack's 50; the `SLACK_MAX_BLOCKS` (48)
  backstop stays, trims body blocks from the end and never drops the footer.
  Every mrkdwn object stays `verbatim: true` (PR titles are attacker-authored) and every link goes
  through `links.ts`.

⚠ **THE "REVIEW BOTS" BLOCK IS PART OF THE DELIVERY, NOT AN ACCOUNT PREFERENCE (platform migration
0033).** `bot_digest` on this row replaces `pro_settings.bot_slack_digest`, whose account grain was
justified as "a 'do I want this block at all' preference, not a per-team fact". **That premise died
with 0030**: once the digest became one row per workspace, a single account flag was deciding the
CONTENT of N independently-scheduled messages about N different teams' bots — a team drowning in
bot comments and a team with no bots at all got the same answer. The migration COPIES the account
value onto every EXISTING target row so nobody loses the block on upgrade; it is an `UPDATE` and
never an `INSERT`, because a row here is a delivery (and `webhook_url` is NOT NULL, so there would
be nothing honest to insert). `buildBotBlocks` re-reads the target row rather than accepting the
flag as a parameter — one indexed read buys the guarantee that the flag governing the block belongs
to the delivery being built. Wire: `SlackTarget.botDigest` (always present, null → false) and
`WorkspaceSlackTargetUpdate.botDigest?` (omitted = unchanged).

⚠ **THE WRITE IS SINGLE-WORKSPACE AND `DELETE` IS THE OFF SWITCH.** The multi-select picker and the
whole-selection PUT are GONE: settings are for the workspace the reader is currently in, so
`writeTarget` upserts exactly one row and `deleteTarget` removes exactly one. Under the old shape,
"stop sending to this workspace" was expressed by OMITTING it from a submitted list — which meant
any client bug that shortened the list silently cancelled deliveries. `cadence: 'off'` PAUSES and
keeps the channel; `DELETE` removes the row, frees a cap slot, and takes the dedupe marker with it
(re-configuring later is a new delivery, and a surviving marker would swallow its first digest).

⚠ **THERE IS NO ACCOUNT-LEVEL WEBHOOK AND NO INHERITANCE.** A nullable "inherit" column would be
the null-means-INHERIT bug class CLAUDE.md names, and a webhook is its worst case: a new team's
private figures would silently land in a channel somebody configured years ago. Two states: a
channel, or none. As of platform `0031` the sprint cadence and the issue tracker are the SAME shape —
per-workspace with nothing beneath them — so this is no longer the exception it was when `0029`
kept an account pair as a product default.

⚠ **THE OLD `pro_settings.slack_*` COLUMNS ARE MIGRATED, THEN DORMANT.** `0030` copies each
account's configured webhook — **including `slack_last_sent_slot`** — into a row for that account's
DEFAULT workspace, which is exactly the population the old cron served; the seven columns are then
left in place and removed from the drizzle schema (the `ai_update_mode` precedent), so nothing
selects or writes them. **ONE live spelling.** `ProSettings.slack` / `ProSettingsUpdate.slack` are
gone from the wire; a stale client sending one is silently stripped by
`additionalProperties: false` and still gets a 200.

⚠ **THE DEDUPE MARKER HAD TO MOVE WITH IT.** One `last_sent_slot` per ACCOUNT under a per-workspace
sweep re-sends the workspaces that already went out and skips the ones that had not — and the
in-process guard had to move too (`Set<string>` keyed `${accountId}:${workspaceId}`, not
`Set<number>` of account ids). Both halves, plus the upgrade case where the migration's carried
marker is the only thing preventing a duplicate first send, are pinned in
`platform/test/slack-targets.test.ts`.

**THE COST STORY — this feature REVERSED a documented reduction, on purpose, capped.** Only the
SPRINT REPORT multiplies (keyed (account, workspace); $0 for a workspace whose insights have not
moved). The Pending sections are a DB fold and cost nothing; the per-repo AI digests are no longer
sent. The bound is `SLACK_TARGET_WORKSPACE_CAP` (12), and ⚠ **it survived the picker with a
different job**: the sweep's population is now *every workspace that HAS a row* rather than a
user's submitted selection, so the cap is what stands between "add a Slack channel", repeated, and
N billed report generations per send. It is enforced on the write that would ADD a row past it
(REFUSED, with the count in the message — editing an existing row is always allowed, since that
adds no cost and an account at the bound must still be able to turn things off), TRUNCATED in the
sweep (nobody is there to be told), and DISCLOSED on the read: `cap` + `configuredCount` ride
`WorkspaceSlackTargetResponse`, because with no picker there is no screen that lists every delivery
and the count is the only warning a reader gets before a Save is refused. That honours the "state
it in the Settings copy" obligation [MIGRATIONS.md](MIGRATIONS.md) had carried unhonoured since the
reduction shipped.

**The app deep links.** `host.appWebUrl` (core `config.appWebUrl`) reaches the platform on the
context — ⚠ the platform must never read `process.env` for it itself, which would duplicate core's
fallback (the "two spellings must agree" hazard).

⚠ **`appWebUrl` IS NOT `appBaseUrl`, AND CONFLATING THEM SHIPPED 404ing LINKS.** `appBaseUrl` is
the API origin, naming *this server* whatever serves the SPA. `appWebUrl` answers "where do I send
a person to open the app?". They are the same string in the SINGLE-ORIGIN packaged release and
differ under `pnpm dev`, where the backend is `:4000` and
serves NO SPA while Vite serves it on `:5173`. The first cut of this feature linked the API origin
and every digest link 404'd locally. Resolution order in `config.ts`: `APP_WEB_URL` (explicit
override, for a split deployment) → `appBaseUrl` **when this process actually serves the SPA** →
`http://localhost:${FRONTEND_PORT ?? 5173}`.
⚠ The middle test is `serverServesSpa` — whether the built SPA is on disk beside the server — and
NOT "is APP_BASE_URL set". Serving the files is the only ground truth; it is spelled ONCE, in
`config.ts`, and `app.ts` reads it from there to decide its static root.
⚠ `FRONTEND_PORT` is read by `apps/frontend/vite.config.ts` TOO, so the dev server's port and the
link move together — `scripts/demo-stack.mjs` passes it (`:5273`) for the same reason. Pinned by
`apps/backend/src/config-app-web-url.test.ts` (6 cases, mutation-checked: 4 go red if the
`serverServesSpa` branch is removed). The message carries a footer workspace link
(`?view=activity&workspace=<id>&activityRepo=feed`), per-repo heading links
(`&activityRepo=<repoId>`) and per-PR links. **Every link in the message points into Limn.** A PR
reference is `?workspace=<id>&view=pr-detail%3A<prId>`: the SPA's own tab-key vocabulary, built from
the LOCAL `prId` the resolved ref carries, and pinned by a source scan in `slack-pr-links.test.ts`.
The github.com rule was reversed at the user's request. A reader with no access to this Limn gets
an unreachable host. Absent the seam every builder returns null
and every link is plain text — never a GitHub fallback.

⚠ **Resolution stays repo-aware.** A qualified `owner/name#N` resolves by exact key only. A bare
`#N` resolves only within the section's repo or the current `**owner/name**` heading, never across
repos. Sprint refs are narrowed to the workspace's repos.

The first mention of a PR in a line reads `#123 Title by @login`. The repo prefix is dropped under
the PR's own heading. The title is capped at 80 characters and not repeated if the line already has
it. A repeat mention in the same line is a bare link. ⚠ A line naming FOUR or more titled PRs
(`LIST_MIN_REFS`) keeps its numbers as plain text and lists each PR on its own indented
`◦ <url|#N Title> by @login` line beneath it: the digest prompt puts a whole theme on one bullet,
and twenty inline references made a line longer than a Slack section, which was cut mid-list and
pushed the next bullet out of the repo's two sections. The list lets a split fall between
references. An unknown part is omitted. With no base URL
or no local id the reference is plain text. Digest sections re-resolve with
`resolvePrRefs(…, {includeClosed: true})`, because the open-only filter is the SPA table's rule.
Titles and authors are read at send time and never enter a payload hash.

Model text and titles are Slack-escaped, and every mrkdwn object is `verbatim: true`. Any github.com
URL the model writes is rewritten: a PR or issue URL becomes its `owner/name#N` token, and anything
else becomes plain text. Sections split at line boundaries (`fitSections`): up to 3 for the sprint
and 2 per repo, inside a 48-block budget. A cut never lands inside a link.

### Colour and icons in every Slack message (`slack/tones.ts`)

Slack paints a coloured bar only beside an ATTACHMENT, so every part of a message is one attachment
(`SlackMessage.attachments`, each `{ color, fallback, blocks }`) and the top-level `blocks` hold
only what sits above every bar — the digest's `header`. One TONE per part, `SLACK_TONE_COLOUR`:
merged `#8250df` purple · good `#1f883d` green · bad `#cf222e` red · waiting `#d4a72c` amber · info
`#8c959f` grey.
- **Digest**: one part per team Pending tab (`PENDING_TAB_TONE`: Needs fixing red, Waiting on review
  and Unanswered threads amber, Ready to land green, Dependencies grey), then the sprint summary and
  the bot block in grey; the footer `context` closes the last part. The dividers are gone — each
  part has its own bar. `buildPendingSections` returns the tabs with their tone; `buildPendingBlocks`
  is the same blocks flattened.
- **Event signals**: a merge is purple; a review by its verdict — Approve green, Request changes
  red, Comment or none grey. They have NO top-level blocks: `send.ts` `slackBody` leaves the empty
  key out, so `text` is the line Slack shows above the bar and in the notification.
- **Icons**: one standard Slack shortcode per heading (`PENDING_TAB_EMOJI`, `SPRINT_EMOJI`,
  `BOTS_EMOJI`, `MERGED_EMOJI`, `verdictEmoji`) and, in place of the bullet, one per Pending line
  by card kind (`pendingCardEmoji`: `:x:` red PR, `:red_circle:` red default branch,
  `:crossed_swords:` conflicts, `:hourglass_flowing_sand:` waiting on review, …). Never more than
  one per line, never a custom emoji (it renders as `:name:` text in another Slack workspace).
- ⚠ **COLOUR IS NEVER THE ONLY SIGNAL.** Every part keeps its words (the tab label, "Verdict:
  Request changes", "Merged") and a plain `fallback`; the bar and the icon only repeat them. Pinned
  by `test/slack-tones.test.ts` and `test/slack-pending-blocks.test.ts`.
- There is no message preview in Settings; "Send test" posts the real digest.

### The Slack EVENT signals (platform migration 0040)

Two per-workspace switches on the delivery row, **both OFF by default**, sent to the same webhook
(`slack/signals.ts`); `cadence: 'off'` pauses the digest, not these.
- **"Claude Review ran"** (`notify_reviews`) — PR link (Limn + GitHub), author, verdict and the run's
  own `summary`, trimmed to 700 characters. Never the findings. Only a SUCCEEDED run, never a
  `skip`-routed one. ⚠ **AUTO REVIEWS ONLY** (since 2026-10-27): a run the reader started is never
  posted — the event's `trigger` AND the stored `claude_reviews.trigger` must both be `'auto'`,
  checked BEFORE the claim, so a manual run leaves no `slack_signal_notices` row. Settings labels
  it "Post when an auto review finishes" / "Reviews you start yourself are never posted." Ticket,
  CI and thread-check runs have no Slack signal. The Settings switch shows only where Claude Review
  can run (`me.ai.enabled`).
- **"Pull request merged"** (`notify_merges`) — PR, repo and who merged it (`pull_requests.merged_by_id`,
  already synced). Only for a merge SEEN LIVE: core's `sync/merge-notice.ts` requires the row was
  known OPEN (persistPr's pre-upsert row, or the liveness sweep's open → merged flip, which writes no
  merger and so leaves an in-memory note for the walk that follows) and `mergedAt` within 2 hours. A
  first sighting, the deep backfill and any re-walk of a merged row stay silent.
- Host → platform through `ProContext.registerEventHooks({ onClaudeReviewCompleted,
  onPullRequestMerged })` (`platform/event-hooks.ts`), fired AFTER the commit, fire-and-forget,
  ids only.
- ⚠ **CLAIM, THEN SEND, NEVER RETRY.** `slack_signal_notices` (unique `(account_id, kind, ref_id)`;
  `merge` keys the PR, `review` the run) is inserted before the webhook call; a failed post is logged
  and stays claimed — a retry double-posts when Slack accepted but answered late. In the erasure list.

**Rate limits, erasure, secrets.** `PUT`/`DELETE /api/pro/slack/target` is a SETTINGS WRITE on
`read` (one upsert or one delete, no model, no GitHub) and `POST /api/pro/slack/test` stays on
`ai` + `ai_hourly`
because it runs the cron's real billed path — both spelled explicitly in `tierFor`, above the
`/api/pro/` catch-all, and pinned in `rate-limit.test.ts`. The table joins the platform's
`registerAccountErasure` list (`eraseProByAccountId`). The webhook URL stays
PLAINTEXT — the decision was RE-MADE when the count went from one to N; see
[SECURITY.md](SECURITY.md) and migration `0030`'s header.

### The issue tracker is PER-WORKSPACE too (platform migration 0031) — and the comparison MODE (0032)

> ⚠ **HISTORY for the tracker half.** The Jira/Linear tracker left this row for CORE (2026-10)
> (`workspace_trackers`, `GET`/`PUT /api/workspaces/:id/tracker` — [TRACKERS.md](TRACKERS.md)); a
> boot-time move copied each workspace's values out and NULLed these columns. What follows about
> the tracker records why it became per-workspace; the comparison-mode half is still current.

The Jira/Linear settings left `pro_settings` and joined the sprint cadence on
`pro_workspace_settings` — same table, same `(account_id, workspace_id)` key, same named composite
FK. **Platform 0032 added the third and last one: `comparison_mode`.** Control surface: `GET`/`PUT
/api/pro/settings/workspace?workspace=<id>`, a partial patch (`{sprint?, issue?, comparisonMode?}`)
served by ONE writer, `writeWorkspaceSettings` (`WorkspaceProSettings.comparisonMode`,
`WorkspaceProSettingsUpdate.comparisonMode?`).

**Platform 0041 added `hourly_cost_cents`** — the hourly cost of engineering time, a READING setting
for Reports → Chronology → Over time ("≈ $X of engineering time at $Y an hour" beside the working
hours saved; `ChronologyTrend.tsx` `HourlyCost`, priced by `chronologyTrendModel.ts`
`hoursCostUsd`). Wire: `WorkspaceProSettings.hourlyCostUsd: number | null` (US$, null = not set) and
`WorkspaceProSettingsUpdate.hourlyCostUsd?` (`null` clears; > 0 and ≤ `HOURLY_COST_MAX_USD`, else
400). Stored as whole cents, no account default beneath it. It prices the hours estimate and adds no
claim of its own.

⚠ **THE MODE MOVED BECAUSE THE CLAIM THAT KEPT IT ACCOUNT-WIDE WAS FALSE.** Four sites asserted it
was "a reading preference with no per-team meaning"; `resolveComparisonWindow` falsifies that —
under `'sprint'` a workspace WITH a cadence gets a sprint-position window and one WITHOUT silently
gets rolling-14, so one account setting produced two different window SHAPES with nothing on screen
naming which. It composes with the cadence, so it lives on the cadence's row, with the same
two-state rule (a stored mode, or the product default `'rolling_14'` — no chain) and the same
dormancy treatment for `pro_settings.comparison_mode`. `comparisonMode` is TOP-LEVEL on the patch
rather than inside `sprint`, because that section declares `cadenceDays` REQUIRED so that clearing a
cadence is always explicit — which would make a mode-only patch inexpressible. Full contract:
[PERIOD-REPORTING.md](PERIOD-REPORTING.md) § `comparisonMode` IS PER-WORKSPACE TOO.

**Why the workspace is reachable at all.** The enricher's input is a PULL REQUEST, and
`PrEnrichInput` ALREADY carries `repoId`. A repo belongs to EXACTLY ONE workspace
(`workspace_repos` is unique on `(account_id, repo_id)`; assignment is an upsert = a MOVE), so one
indexed read answers it. **The host seam did not have to widen.**

⚠ **A REPO WITH NO MEMBERSHIP ROW DEGRADES TO `{configured:false}`.** That state is reachable —
core's `ensureRepoMemberships` insert keeps `ON CONFLICT … DO NOTHING` precisely because a repo can
exist without one. Falling back to the account's DEFAULT workspace was the tempting option and is
the wrong one: it renders one team's tracker configuration against another team's pull request —
ticket chips deep-linking into a Jira instance this PR's team does not use, from a setting they
cannot see or edit. **Absent, never wrong.** Throwing is also wrong (`resolvePrTickets` swallows it
into `null` anyway, so it would be an invisible failure with a stack trace attached).

⚠ **THE BACKFILL COPIED INTO EVERY WORKSPACE, NOT JUST THE DEFAULT** — the OPPOSITE of `0030`'s
shape, and deliberately. A webhook had only ever delivered to one channel, so Default-only was the
population the old cron served. The tracker was account-wide and **applied to every PR on the
account**, so a Default-only copy would have silently dropped ticket links for every other
workspace on upgrade. The upsert is `DO UPDATE`, not `DO NOTHING`: a workspace that already had a
`0029` cadence row must gain the tracker columns too, or the most engaged users get the worst
upgrade.

**The match scope — `IssueMatchScope` = `'title' | 'title_branch'`.** A per-workspace choice of
where a configured project key is looked for, defaulting (NULL column ⇒ `'title_branch'`) to
today's behaviour so no existing detection changes.

⚠ **NOTHING HAS EVER SCANNED COMMIT MESSAGES**, in any scope. `extractTicketKeys` reads the PR
TITLE and the HEAD BRANCH NAME and nothing else — commit messages are not even loaded on the
lean-storage read path this enricher runs on. Recorded because "it also needs commit messages" is a
natural reading of the two-source behaviour.

⚠ **`'title'` IS INERT WITHOUT A PROJECT-KEY ALLOWLIST.** The branch is only scanned in allowlist
mode to begin with: a lowercase branch key (`eng-123`) is structurally indistinguishable from
`node-18` / `release-2` / a dependency bump, which is why branch scanning is allowlist-gated. So
the setting narrows an allowlisted setup and changes nothing otherwise — a UI offering the choice
beside an empty keys field is offering a control that does nothing, and should say so.

⚠ **THE ROW NOW HOLDS TWO SETTINGS, SO A PATCH MUST NOT CLOBBER ITS NEIGHBOUR.** `mergeWorkspace`
seeds EVERY column from the stored row; a column in `WorkspaceMutableCols` that is not seeded is
NULLED by the upsert on any unrelated patch. And clearing a cadence NULLS THE PAIR rather than
deleting the row — the old `writeWorkspaceCadence` delete would now take the tracker with it. Both
are pinned in `platform/test/workspace-settings.test.ts`.

**Erasure.** `pro_workspace_settings` was already in the platform's `registerAccountErasure` list, so
`0031` added no entry — which is exactly why it is easy to stop thinking about. The row now carries
a customer's internal tracker hostname: infrastructure disclosure, not just a number.

### Jira API access and the stored Jira tickets — MOVED TO CORE

These two sections (platform migrations 0035 and 0038/0039: the sealed per-workspace Jira token, the
`pro_pr_jira_tickets` worker, the acceptance-criteria field choice, the Open PRs ticket row and
stacks, the ticket review's peers seam) now describe CORE code. The whole contract — the tracker
seam, the worker, the idents, the credential, the routes and how the plugin-era data was moved — is
**[TRACKERS.md](TRACKERS.md)**. The platform keeps none of it: `src/jira/` and `src/issue-links/` are
deleted, platform `0038`/`0039` are `SELECT 1;` stubs, the `issue_*` / `jira_*` columns on
`pro_workspace_settings` are dormant, and `ProContext` lost `registerPrDetailEnricher`,
`registerAgenticProviders`, `registerRepoSyncedHook` and `host.sealSecret` / `openSecret`.

### The Bots ROI panel — and what lives beside it

`BotRoiPanel` is the Measure surface of Bots Monitoring: what each bot produced, what got acted
on, what sat, what repeated another bot, and the price. Until 2026-10-22 the WHOLE panel was
Pro on `botDepth` (visible-but-locked, a 402 on six routes and a cost strip on the free ones);
every gate, lock and strip went with the plugin.

Four surfaces live in `BotsView`, BESIDE the panel rather than inside it:

| Surface | Where it lives |
|---|---|
| "Only a bot reviewed N open PRs" governance caution + its list | `BotsView`, reads `totals.botOnlyPrs` |
| `ResolveBacklogBanner` → review-and-resolve | exported FROM `BotRoiPanel.tsx`, mounted in `BotsView` |
| `TuningSuggestions` (the amber advisory box) | **hoisted OUT of the panel** into `BotsView` |
| the bot-only `FeedView` | `BotsView` |

`TuningSuggestions` reads as a heading over the table rather than a footnote under it.
`QualityCheckSection` stays in the panel; its mis-role safeguard survives because the
classification screen (Bots Monitoring → Classification) lists "Other automation" with each row's role
picker, which is where the re-role happens anyway.

**"Turning it off would save …" (`lib/botSavings.ts` `stopPayingLine`).** Under the table, ONE
templated sentence per review bot (`vendors` is the `=== 'review'` cohort already) with a positive
`costMonthlyUsd`, at least `RARELY_USED_MIN_THREADS` (10) threads and `actedOnPct` under
`RARELY_USED_MAX_PCT` (30 — the same cut as the "Rarely used" verdict): "Cursor Bugbot costs $40 a
month and your team used 12% of its threads in the last 14 days. Turning it off would save $480 a
year." Annual = monthly × 12. It reads the ROI row's own figures (no new acted-on measure) and is
gated on the SAME `showCost = repoId == null` as the `$ per used thread` column, so a repo-narrowed
mount shows none. No model, no total across bots or Workspaces.

⚠ **`vendors`, `suggestions` and `totals` are REQUIRED on `BotAnalyticsResponse`.** The SPA decides
what to draw from the payload's own content, never by inferring a state from zeros.

### The peer benchmark — serving the cohort (`GET /api/pro/bot-benchmark`)

The COHORT half of "how does our bot compare": per-(vendor × activity band) distributions fitted in
`packages/ml` (`bot_monitor.panel.fit`), bundled as a JSON artifact and projected onto the wire.
It is deterministic: no model, no
database, no GitHub, no write, no cron.

**Files.** `platform/bots/benchmark-routes.ts` + `benchmark/{artifact,map,percentile}.ts` ·
`platform/data/benchmark/benchmark-fit.json` (the bundled corpus) · wire types in
`packages/shared/src/types.ts` · `api.botBenchmark()` in the SPA client · the tier entry in
`api/plugins/rate-limit.ts`. Tests: `platform/test/benchmark-{artifact,percentile}.test.ts` (run by
`pnpm test`).

**Nothing about the caller reaches the response, and that is the design.** The artifact is
IDENTICAL FOR EVERY INSTALL — the one non-account-scoped body of data in the system — and it names
no repository and no actor. So the route takes **no `?workspace=`** and echoes **no `workspaceId`**:
a deliberate exception to §5.1, because the scope parameter exists to bound which of an account's
repos a response covers and this response covers none of them. There is no account data, therefore
no IDOR surface and no existence oracle. ⚠ The moment it grows a customer-side PLACEMENT leg, all
of that reverses and the scope rules apply again.

**Why the artifact is BUNDLED, not a table and not a bare env path.** Every platform table is
account-scoped, joins `registerAccountErasure` and is covered by the isolation test; a global
singleton table inverts all three, and would need a loader with write access — to buy "refresh
without a release", which is worth nothing at a quarterly cadence. A corpus refresh rides the npm
release, an existing motion with zero new machinery. `PRO_BENCHMARK_FIT_PATH` is an **override only** (dev pointing at a fresh
`packages/ml/data/benchmark/fit_*.json`; an ops escape hatch).

- ⚠ **The path is relative to the compiled module.** `artifact.ts` resolves
  `new URL('../../data/benchmark/benchmark-fit.json', import.meta.url)` — `src/platform/data/` in
  dev, `dist/platform/data/` in the release, at identical depth.
- ⚠ **`build-release.mjs` copies `platform/data` beside `platform/migrations`, and asserts
  `dist/platform/data/benchmark/benchmark-fit.json` in `mustExist`.** Without the copy the failure
  is RELEASE-ONLY and silent: dev and `pnpm demo` read it straight out of `src/`, while the package
  answers `available:false`.
- ⚠ **Identity lives INSIDE the file.** Fixed filename, no date suffix, no directory scan, no
  newest-by-mtime. `fit_key` (`fit-v1+corpus-v3+panel-…+model-unscored+params-…`) is the whole
  identity and rides every response.

**Refusals are the product, not a degraded state.** ⚠ **This paragraph used to read "8
repositories, `cells_fitted: 0`"; the bundled corpus is now REAL** — fit v2, 2,204 repositories,
`cells_total: 45, cells_fitted: 43` over seven vendors and 415 of 585 metric-cells fitted, with 2
cells and 170 metric-cells still refusing on `rule: 'cell_floor'` and severity/category absent
entirely (`scoring.state: 'unscored'`). A refusing cell is still correct output, and several vendor
cells will refuse permanently even at full panel size — so `cellsFitted === 0` remains a
first-class state to render, it is simply no longer today's. The response lets the SPA tell **five**
situations apart:

| Situation | Shape |
|---|---|
| Whole artifact refuses | `manifest.summary.cellsFitted === 0` — ONE banner, not 13 identical paragraphs per cell; `metricCellsRefusedByRule` gives the reason distribution |
| A cell / a metric refuses | the `status: 'refused'` arm: `refusal {rule, message, observed, required}` and **no distribution keys** |
| A metric refuses INSIDE a fitted cell | real and common — `cell.status === 'fitted'` means ANY metric cleared the floor, so `metricsFitted`/`metricsTotal` ride the cell |
| No cell exists | the `status: 'absent'` arm — `vendor_unfittable` / `cell_not_in_corpus` / `vendor_not_in_corpus_vocabulary`, three different sentences |
| No corpus in this build | `available: false, reason: 'artifact_missing'` — **200, not 500** |

- ⚠ **NEVER NORMALISE A REFUSAL INTO A DISTRIBUTION SHAPE.** No `{quantiles: null}`, no
  `{nRepos: 0}`, no `grid: []`. `fit.py`'s `_refusal()` omits those keys so that reading a
  percentile off a refusal RAISES instead of returning a plausible small number; the discriminated
  union is the TypeScript equivalent, and the mapper is the single place it can be lost. An
  interface with optional fields silently discards the guarantee.
- ⚠ **STALENESS IS RECOMPUTED PER REQUEST**, against `corpus.observed_at_max` — the stored
  `corpus_age_days`/`state` pair is as-of `generated_at` and DECAYS ON DISK (the explicit inverse
  of the walk's frozen-age rule; `fit.py` says so on the artifact). Copying it ships a corpus that
  reports "fresh" forever.
- ⚠ **`metricSpecs` ships IN FULL and is never trimmed as "just docs".** Each spec's
  `numerator`/`denominator`/`population`/`minUnits`/`direction` is the mitigation for this
  feature's biggest correctness risk — **the app's own columns are not these columns.**
  `getBotAnalytics`' `actedOnPct` folds in the `likely_addressed` COMMIT HEURISTIC
  (`isActedOnThreadState`) and divides by every in-window thread; the cohort's `acted_on_rate`
  divides by SETTLED (≥72h), fully-read threads. `overdueUntouched` uses a fixed 36h grace vs the
  cohort's 72h/168h; `overlapPct` uses ±3-line clustering vs an exact `(path, line)`; six of the
  thirteen have no app counterpart at all. A size optimisation that deletes this prose is a
  correctness regression, not a saving.
- ⚠ **`absentMetrics` rides every response** — the three model-derived metrics are STRUCTURALLY
  ABSENT (no cell holds the key) while `scoring.state !== 'scored'`, so the SPA can say "severity
  comparison arrives when the corpus is scored" rather than showing nothing.
- ⚠ **The vendor vocabularies of the two repos DIVERGE.** `packages/ml` knows `codeant`; the host's
  `REVIEW_BOT_KINDS` does not. The host knows `github_code_quality`, `github_advanced_security`,
  `pierre`, `vendor`; the fitter has never seen them. The overlap is exact for the seven vendors in
  the current corpus, which makes the divergence easy to miss — hence the explicit
  `vendor_not_in_corpus_vocabulary` absent-reason instead of a silent empty.

**Selection, the cap, and the tier.** `?cells=<vendor>:<band>,…`, at most **24** pairs; omitted ⇒
manifest only. ⚠ **Over-cap is a 400, never a truncation** — a truncated cell list reads to the
consumer as "those cohorts do not exist", the one claim this feature must never make by accident.
The route sits on `[TIERS.search, TIERS.read]` as an **exact `===` match ABOVE the `/api/pro/`
catch-all**, because *the response body is the work*: measured, the manifest is 16 KB, a 24-cell
refused request 44 KB, a fitted cell ~10 KB, and no `@fastify/compress` is registered in this
backend, so the JSON size is the wire size. The cap bounds work per request; the tier bounds
request count. ⚠ Exact match, not `startsWith` — `/api/pro/bot-b…` is one sibling away from
swallowing `/api/pro/bot-behaviour`. ⚠ **`?cells=` is caller-controlled, so the artifact's cells are
re-keyed into a `Map` at parse time** — `parsed.cells[vendor][band]` on a plain object is reachable
with `__proto__`/`constructor`.

**Publishing is a TWO-repo motion.** `packages/ml` fits → `fit.py --publish <path>` writes the
artifact to `apps/backend/src/platform/data/benchmark/benchmark-fit.json` in this repo → commit it
(and move the `packages/ml` gitlink if the fitter changed). The file ships in the public npm
package, which is exactly why the next check matters.
`--publish` runs `assert_publishable()` first, which re-verifies that **corpus rows never travel**:
it scans every corpus-derived string (skipping the authored-prose blocks) and refuses on a repo
slug, a `[bot]` login or an `@mention`. That property is a property of the artifact's SHAPE, which
one careless new disclosure field would remove silently inside 200 KB of generated JSON — so it is
re-checked on every publish, not assumed. Commit a refreshed corpus only on a material change
(a `fit_key` move); a genuinely weekly cadence would add ~90 MB/year to the repo's history and
should prompt revisiting the transport rather than living with the bloat.

**The metric-definition reconciliation is DONE and lives in `packages/ml/docs/METRIC-CONTRACT.md`**
— the exact numerator/denominator/population/settle rule/exclusions for all 13 code-derived metrics,
each mapped onto core's tables, plus the band-placement rule and the five refusals. Its proof is a
GOLDEN FIXTURE emitted by the Python side through the real fitter, committed byte-identically at
`packages/ml/tests/fixtures/metric-contract-v1.json` **and** `apps/backend/src/platform/test/fixtures/metric-contract-v1.json`
(a TEST fixture, so it stays out of `data/` and out of the release). Three things from it that
reverse a natural guess: ⚠ **the banding axis `panel_prs_per_period` counts merged PRs of ANY
AUTHOR** — `frame.py`'s extractor has no author predicate, while the volume DENOMINATOR excludes
machine-authored merges, so the two populations differ on purpose (machine merges are a median 13.2%
of merges per cell); ⚠ **the corpus's per-repo population is the `min(150, round(P*90/14))`
most-recently-updated PRs**, which actually bound in 85.5% of live repos in the median cell, so a
customer fold over full history measures an older, wider population; ⚠ **`thread_resolved_rate` is
the ONE outcome metric whose denominator includes TRUNCATED threads** (`isResolved` survives
truncation), so copying the `*_complete` denominator across all of them is the likeliest single
port error.

**The Bots → Benchmark TAB now renders both halves** — see
[docs/FRONTEND.md](FRONTEND.md) § "Bots → Benchmark". It consumes the PLACEMENT route (below) for
every number and this cohort route ONLY for the click-gated metric definitions. It is the only
place in the product that answers "is this bot NORMAL?".

### The peer benchmark — placing the customer (`GET /api/pro/bot-benchmark/placement`)

**A SIBLING ROUTE, not a leg of the one above.** Serving the cohort and placing a customer in it are
two decisions with two costs: the cohort route's cost is its RESPONSE BODY, this one's is a
DATABASE FOLD. So they carry two rate-tier arguments (both `search`, by two different arguments —
`api/plugins/rate-limit.ts` spells each), and this one is workspace-scoped and echoes `workspaceId`
while that one takes no scope at all. Files: `bots/benchmark/{fold,collect,place,anomalies,
placement-routes}.ts`.

- **`fold.ts` is the CORPUS's definitions, ported — never the app's.** The host already has columns
  with these names and they are DIFFERENT columns: `getBotAnalytics.actedOnPct` folds
  `likely_addressed` into its numerator and divides by every in-window thread; `overdueUntouched`
  uses a fixed 36 h grace; `overlapPct` clusters anchors within ±3 lines. All three stay as they
  are. ⚠ Two independent implementations of `acted_on_rate` do not compare a customer to a cohort —
  they compare two questions and render the difference as a finding.
- **`test/benchmark-metric-contract.test.ts` is the proof, and it is the most important test in the
  feature.** It drives the golden fixture (`test/fixtures/metric-contract-v1.json`, emitted by the
  REAL Python fold) through the TypeScript one and compares **every counter and every value with
  `===`, never a tolerance** — each rate is one IEEE-754 division of two integers, so two correct
  implementations agree bit for bit. All 14 units reproduce exactly. ⚠ **Counters are compared
  FIRST**: a value that disagrees says something is wrong, a counter says which population, which
  gate and which row.
- ⚠ **Three refusal families, and none may be normalised into a distribution shape.** The cohort
  side (`vendor_not_in_corpus_vocabulary` / `vendor_unfittable` / `vendor_unstratifiable` /
  `cell_not_in_corpus`), the customer side (the corpus's own five exclusion reasons, plus
  `body_unobserved` where `body` AND `excerpt` are both null), and `repo_window_incomplete` — the
  ONE refusal about the customer rather than the corpus: a repository held for less than 14 days has
  a partial window, so its merge count is an undercount that places it too LOW, silently.
- ⚠ **An anomaly needs BOTH a share and a magnitude** — the Chronology lesson verbatim. A percentile
  alone invents a crisis in a healthy repository: somebody is always in the 95th percentile. Four
  kinds, four actions, all templated (there is no model anywhere in this feature), and a THIRD gate
  the cohort supplies — a value inside the cohort's 95 % median CI is suppressed, because at the
  30-repo floor that interval routinely spans 20 points and "your 41% vs the cohort's 38%" inside it
  is noise reported as a gap. `direction` and `ci_median_95` are SERVED by the cohort route and
  CONSUMED here.
- ⚠ **The band rule reads the HIGH edges only** and a tie resolves DOWNWARD. The ranges OVERLAP at
  ties (coderabbit band 0 is `2..2`, band 1 is `2..3`), so "the band whose interval contains the
  value" is not a function; the derivation is in `place.ts` and the alternative low-edge reading is
  pinned as an in-test mutation that must disagree at exactly 2 and 3. The customer's axis is
  **merged PRs in 14 days, ANY AUTHOR** — machine merges are IN the banding axis and OUT of the
  volume denominator, two populations doing two jobs.
- ⚠ **`SUPPORTED_FIT_VERSIONS` is `{1, 2}` and getting it wrong is SILENT.** It was `1` while the
  bundled artifact moved to fit v2, so `loadBenchmarkArtifact()` refused and every caller got
  `available: false` on a 200 — with `test/fixtures/benchmark-fit-smoke.json` still at v1, so the
  pro suite stayed green. fit v2 also made `activity_bands` PER VENDOR (10/10/9/7/4/3/2) and added
  `cohort.n_bands`/`band_label`, both of which now ride the wire: "upper fifth" is honest at 5 bands
  and a misrepresentation at 10.
- **The SPA half is `Bots → Benchmark`** — `BenchmarkPanel.tsx` + the pure `benchmarkModel.ts` +
  `hooks/useBotBenchmark.ts`, contract in [docs/FRONTEND.md](FRONTEND.md) § "Bots → Benchmark". Two
  things the wire's shape assumes and the panel therefore keeps: **the anomaly list leads and the
  distributions sit beneath it** (a percentile is trivia; the templated `action` is the product),
  and **a rank's denominator is the metric's own `cohort.nRepos`, not `anomaly.cohortRepos`** —
  that field is the band-SUPPORT count, and printing it as "of N" beside a percentile puts the rank
  in a population it was not ranked within. ⚠ Everything the panel draws comes from THIS route; the
  cohort route is reached only by a click-gated definitions disclosure, so the tab makes exactly one
  request on mount.

#### The WORKSPACE ROLLUP — one card per vendor, and the only place money lives

**The Bots RAIL's Benchmark tab is the rollup ONLY** (one card per vendor + a compact
one-line-per-repository evidence table); the full per-repository card moved to **the repository's own
Bots tab**. Files: `bots/benchmark/rollup.ts` (PURE — no db, no clock, no request; `cost.ts` is its
sibling and its dependency, so every null-vs-zero, seat and money-refusal SENTENCE is imported rather
than restated) + the `buildRollups` fold in `placement-routes.ts`. Wire:
`BotBenchmarkPlacementResponse.rollup?: BotBenchmarkWorkspaceRollup[]` (OPTIONAL and additive).
Tests: `platform/test/benchmark-rollup.test.ts` (the arithmetic, pure), the
`cost` block of `benchmark-placement.test.ts` (the route), and
`platform/test/benchmark-roi-agreement.test.ts` — ⚠ **the cross-tab check**, which drives
`getBotAnalytics` and this route over ONE database and one fixture and fails if their
`$ per acted-on thread` diverge. Nothing pinned that agreement before, which is why it broke twice.

**The wire, in full** (all in `packages/shared/src/types.ts`, under the
`── THE WORKSPACE ROLLUP ──` banner):

| Type | What it is |
|---|---|
| `BotBenchmarkWorkspaceRollup` | THE CARD: `key` (the workspace's own automation key — **the identity AND the React key**), `vendor`/`botKind` (labels; `vendor` is `null` for every brand the corpus never saw, so it can never be the key), `reviewers[]` (an ARRAY — two logins the workspace calls one vendor are ONE card), `liveInRepos` / `reposConsidered`, `counters`, `contributions[]`, `spread`, `expectation`, `cost?` |
| `BotBenchmarkRollupContribution` | ONE EVIDENCE ROW: `repoId/repoOwner/repoName`, `mergedPrsLast14d` (ANY author), `band {activityBand, nBands, bandLabel} \| null`, `placementRefusal`, `actedOnRate \| null`, `percentile \| null`, `settledThreads`, `actedThreads`, `spanDays \| null` (⚠ a DISCLOSURE — the observation-period column; no money divides by it any more) |
| `BotBenchmarkRollupSpread` | `{status:'value'; placed; below; at; above}` — `below+at+above === placed`, and `placed ≤ liveInRepos` — or a refusal |
| `BotBenchmarkRollupExpectation` | `{status:'value'; yoursRateOnFitted; expectedRate; fittedRepos; excludedRepos; actedAtPeer; actedPerMonthAtPeer; perActedOnUsd; conversionGapUsd; moneyRefusal}` or a refusal. ⚠ A SIBLING of `cost`, not an arm inside it — a vendor the corpus never saw renders its cost while only this refuses |
| `BotBenchmarkWorkspaceCost` | `monthlyUsd \| null`, `costModel`, `unitMonthlyUsd`, `seats`, `pricedReviewers`, `seatPriceUnresolved`, `seatCountZero`, `windowDays`, `windowUsd`, `coveredRepos`, `spanUnobservedRepos`, `partialWindowRepos`, `costWindowDays?`, `costWindowIncompleteRepos?`, `perMergedPr`, `unacted`, `yours`, `basisNote`. The three arms REUSE `BotBenchmarkCostUnacted`/`…Yours`/`…Refusal`, so one set of components draws both grains. ⚠ **TWO WINDOWS, TWO FIELDS**: `windowDays` is the cohort's fortnight and `perMergedPr`'s basis ALONE; `costWindowDays` is the calendar month `yours` divides by. ⚠ `yours` carries the WINDOW's thread pair while `unacted` carries the SLICE's, under the same field names — the renderer names each. ⚠ `basisNote` REPLACED `spanNote`: one sentence printing both numbers the figure divides ("US$783.00 a month divided by the 243 threads acted on in the last 30 days. Both halves cover the same month."), because the 106-word span caveat it replaced described a time base that no longer exists |
| `BotBenchmarkRollupRefusal` | `{status:'refused'; reason: BotBenchmarkRollupRefusalReason; message}` — shaped like `BotBenchmarkCostRefusal` for the same reason |
| `BotBenchmarkPlacementResponse.rollup?` | OPTIONAL and ADDITIVE. ⚠ **ABSENT ≠ EMPTY** — a missing key says the fold did not run (a narrowed request), `[]` says it ran and no reviewer was live anywhere. The panel gives them two different sentences |

**The arithmetic — five folds, and every one of them is a sum over the LIVE repositories `R`** (a
repository where `commentsObserved > 0`; `liveInRepos = |R|`). `windowDays` is the corpus's
`activity_window_days`, 14. `C ⊆ R` is the FITTED subset: the repositories whose own cohort cell
published a usable `acted_on_rate` median.

```
POOLED COUNTERS   every key of every counter map, summed over R, absent-key-contributes-0
                  ⚠ THE ADDITIVITY INVARIANT: the whole IS the sum of the parts, for EVERY key —
                    which is what makes the evidence table checkable against the headline.

windowUsd       = monthlyUsd × windowDays ÷ 30.44
perMergedPr     = windowUsd ÷ Σ_R mergedPrsLast14d_r        ← a fortnight at BOTH ends; the only
                                                              14-day figure, and the only one that
                                                              asks nothing of the reviewer
                  ⚠ a PARTIAL-WINDOW repo leaves this denominator (undercount ⇒ inflates the cost,
                    flatteringly) and is disclosed in `partialWindowRepos`. Its counters still pool.

── THE COST WINDOW, `COST_WINDOW_DAYS` = 30.44 — one CHOSEN calendar month ─────────────────────
actedInWindow   = Σ_R ( acted_r whose SETTLE POINT — thread creation + 72 h — fell in
                        [now − 30.44 d, now) )                ← two-sided, half-open, `<` not `<=`
settledInWindow = Σ_R ( the same population's denominator )
yours.perActedOnUsd = monthlyUsd ÷ actedInWindow             ← BOTH HALVES COVER ONE MONTH
yours.actedPerMonth === yours.actedThreads                    ← the window IS a month, so a count
                                                                inside it already is a pace

pooledActedRate = Σ_R acted_r ÷ Σ_R settled_r               ← the card's HEADLINE rate, over R
unacted.unactedUsd = monthlyUsd × (1 − pooledActedRate)     ← what the price buys that nobody acts
                                                              on, per month

── THE ESTATE-MATCHED EXPECTATION, over C ──────────────────────────────────────────────────────
actedAtPeer          = Σ_C ( settled_r × cohortMedian_r )   ← ONE FACTOR SWAPPED, PER REPOSITORY,
                                                              BEFORE ANYTHING IS SUMMED
actedPerMonthAtPeer  = Σ_C ( settledInWindow_r × cohortMedian_r )   ← THE SAME MONTH, one factor
                                                                     swapped, per repository
perActedOnUsd        = monthlyUsd ÷ actedPerMonthAtPeer
expectedRate         = Σ_C (settled_r × cohortMedian_r) ÷ Σ_C settled_r   ← thread-count WEIGHTED
yoursRateOnFitted    = Σ_C acted_r ÷ Σ_C settled_r          ← ⚠⚠ OVER C, NOT OVER R
conversionGapUsd     = monthlyUsd × (expectedRate − yoursRateOnFitted)
```

⚠ **`pooledActedRate` AND `yoursRateOnFitted` ARE TWO DIFFERENT NUMBERS AND MUST NEVER BE
SUBTRACTED FROM ONE ANOTHER** — one is over `R`, the other over `C`, and the wire carries both
plus `fittedRepos`/`excludedRepos` precisely so a renderer is physically able to label them apart
and a test can assert that it did. ⚠ **THE ROLLUP COMPUTES NO PERCENTILE ANYWHERE.** Pooling is
volume-weighted and every corpus distribution is one-repo-one-vote, so an estate rate is a number
no cohort member resembles — and there is no distribution of workspaces to rank it in regardless.
Every rank on the card is a per-repository one, in the evidence table, each against its own band.

- ⚠ **`BotBenchmarkPlacementUnit.cost` IS DELETED FROM THE WIRE AND NOTHING MAY PUT IT BACK.** A unit
  is one (repository, vendor) pair; a price is stored ONCE PER WORKSPACE. The old block therefore
  divided a whole subscription by one repository's work and disclosed, via `sharedWithUnits`, that n
  other cards carried the same number — a caveat compensating for a grain mismatch. The GRAIN MOVED
  instead: numerator and denominator now describe the same population, so there is nothing to
  disclose and nothing a reader can double-count. `sharedWithUnits` retired with it.
  `BotBenchmarkPlacementCost`/`buildUnitCost` survive as the pinned executable specification of the
  rules `rollup.ts` imports piecewise; **no request builds one any more.**
- ⚠ **NO MONEY IN A REPO-GRAINED VIEW, STRUCTURALLY.** A `?repoIds=`-narrowed request builds no
  rollup, so there is no figure in the payload to find — rather than every present and future
  renderer declining to draw one. ⚠ **It is the NARROWING that decides, not the resulting repository
  count**: a workspace that genuinely holds one repository DOES get its rollup (price and work then
  describe the same population), which is why `narrowed` travels into `buildPlacement` as its own
  argument — `resolveRequestScope` cannot tell the two apart. The same rule governs `BotRoiPanel`'s
  `$/acted-on` column: `showCost = repoId == null`, and it must NOT be simplified to `true`.
- ⚠⚠ **THE MONEY DIVIDES BY A CHOSEN CALENDAR MONTH, NEVER BY AN OBSERVED SPAN** —
  `COST_WINDOW_DAYS`, in `cost.ts`. `perActedOnUsd = monthlyUsd ÷ actedInWindow`, where
  `actedInWindow` counts the threads whose SETTLE POINT (creation + the corpus's 72 h) fell in
  `[now − 30.44 d, now)`. **What it replaced** was `Σ_r (acted_r × 30.44 ÷ spanDays_r)`, `spanDays`
  being the reviewer's earliest-to-latest comment on the walked slice — a window NOBODY CHOSE (237
  days on a real card, for a repository this build had held for 52), an ORDER STATISTIC one old
  comment on one long-lived pull request could set, and a number NO COMPONENT EVER RENDERED
  (`grep -rn spanDays apps/frontend/src` returned nothing), so the figure could not be recomputed
  from anything on screen. It printed **US$23.94** where the ROI tab, one tab away, said US$3.2 for
  the same reviewer at the same price.
  - ⚠ **WHY 30.44 AND NOT 30, AND IT IS PINNED.** `monthlyUsd` is a price for a CALENDAR month;
    `DAYS_PER_MONTH` is named rather than inlined precisely because a 30-day stand-in is wrong by
    1.4 % in the flattering direction. And the ROI tab computes
    `monthlyUsd ÷ ((acted × DAYS_PER_MONTH) ÷ windowDays)`, which collapses to this module's
    `monthlyUsd ÷ acted` at **exactly one** window length. Anywhere else the two tabs disagree
    forever. `test/benchmark-roi-agreement.test.ts` drives both folds over ONE database and fails if
    the constant moves.
  - ⚠ **FIXED, NOT THE ROI TAB'S CHIP.** A peer placement that changed because somebody flipped a
    window selector on another tab would be worse than the contradiction it fixed — the argument
    `dormantVendorKeys` already makes for bot dormancy.
  - ⚠ **THE SETTLE POINT, NOT THE THREAD'S BIRTH.** Windowing on creation admits the last 72 h of
    threads that CANNOT yet be acted on and reports them un-acted: a denominator inflated by the
    calendar.
  - ⚠ **RATES ARE ADDITIVE; SPANS ARE NOT — now VACUOUS, and kept for its argument.** No figure
    divides by a span, so spans have nothing to be non-additive about; the rule is written down in
    `rollup.ts`'s header because the defect it guards (a per-month claim resting on a window nobody
    chose) is the shape of the one this change fixed. A repository with no observable span now
    contributes NORMALLY; `spanUnobservedRepos` survives as a note about the evidence table's
    observation-period column, not about the money.
  - ⚠ **THE TWO TABS STILL DIFFER, AND IT IS NOW A POPULATION DIFFERENCE RATHER THAN AN ARITHMETIC
    ONE — DO NOT "FIX" IT.** On the real erxes/CodeRabbit card the ROI tab reads US$1.97 over 398
    acted-on threads and the Benchmark US$3.22 over 243, because `getBotAnalytics.actedOnPct` folds
    `likely_addressed` in and divides by every in-window thread while `acted_on_rate` divides by the
    SETTLED ones on the walked slice of human-authored pull requests. Those are the two definitions
    this feature exists to keep apart (§ `fold.ts` is the CORPUS's definitions). Before this change
    the same pair read US$1.97 against US$23.94.
- ⚠⚠ **THE COMPARISON'S TWO HALVES SHARE ONE POPULATION.** `expectedRate` exists only over the
  repositories whose cohort published a usable median — the FITTED subset — so the customer rate set
  against it is `yoursRateOnFitted` over that SAME subset, **never** the card's pooled headline rate
  (`cost.unacted.actedOnRate`), which is a different number over a different denominator. Both rates
  AND both counts (`fittedRepos`, `excludedRepos`) ride the wire so a renderer can label them apart
  and a test can assert it did. This is [docs/PERIOD-REPORTING.md](PERIOD-REPORTING.md)'s "ONE ROW
  MUST NEVER MIX THE HEADLINE AND SUBSET POPULATIONS", which shipped three times there.
- ⚠ **A COHORT MEDIAN OF `0` IS NO MEDIAN** — `cohortMedianOf` gates `p50 <= 0`, spelled identically
  to `cost.ts`'s `cohortActedOnRate` (which refuses `cohort_rate_zero`). **Not hypothetical: all
  THREE `qodo` bands in the shipped corpus publish exactly 0**, so every Qodo repository hits it.
  Admitting the cell diluted `expectedRate` toward zero (an estate reported a peer expectation of
  30 % where the one usable cohort said 60 %, and a gap of US$12 against a true US$48 — understated
  fourfold, in the flattering direction), and an all-degenerate estate drove `actedPerMonthAtPeer` to
  zero, which the span guard then reported as `span_unobserved`: a flat lie about repositories whose
  spans were observed. Such a cell now leaves the subset and lands in `excludedRepos`; an estate with
  none left refuses `no_fitted_cohort_rate`, whose sentence names the zero cause explicitly.
- ⚠ **ONE FACTOR IS SWAPPED, PER REPOSITORY, BEFORE ANYTHING IS SUMMED** —
  `actedAtPeer = Σ_r (settled_r × cohortMedian_r)`. Blending medians into one estate figure and
  multiplying by an estate thread count is the median-of-a-product error wearing a sum.
- ⚠ **TRUNCATION KILLS THE MONEY AND SPARES THE REST**, and outranks every other guard.
  `workspace_truncated` is the TENTH `BotBenchmarkCostRefusalReason`, reachable ONLY from the rollup,
  and it fires on all three cost arms AND on `expectation.moneyRefusal`. Counters and the spread
  still render — a sum of counts over eight repositories is an honest sum over eight repositories.
  ⚠ `benchmark-cost.test.ts`'s nine-reason sweep is still CORRECT at nine: it folds `buildUnitCost`
  outputs, which can never reach the tenth. The vocabulary is asserted whole elsewhere.
- ⚠ **A PARTIAL-WINDOW REPOSITORY LEAVES `perMergedPr`'s DENOMINATOR ALONE** (its merge count is a
  known undercount, and leaving it in inflates the estate's cost-per-merged-PR in the flattering
  direction) — counted in `partialWindowRepos`; its counters and threads still pool, because only the
  merge count is windowed. Fatal only when EVERY live repository is partial.
- ⚠ **`liveInRepos` IS DERIVED IN THE FOLD, NOT PASSED IN** (`commentsObserved > 0`). The workspace's
  declared lineup emits a unit for every reviewer in EVERY repository, so a vendor on 1 of 11 arrives
  with 10 all-zero units; counting those would claim "live in 11 of 11" and drop 10 silent
  repositories' merge counts into a denominator the reviewer had no part in. A vendor with zero live
  repositories gets **NO CARD** (the per-repository unit still ships and still says `vendor_silent`).
- ⚠ **ABSENT `rollup` AND `rollup: []` ARE TWO DIFFERENT FACTS** and the panel gives them two
  different sentences: a MISSING key says the fold did not run (an older build), `[]` says it ran and
  no reviewer was live anywhere. Collapsing them with a `?? []` told a reader whose bots simply had
  not commented yet that their BUILD was deficient — the ordinary state right after somebody
  classifies a reviewer in Bots → Settings.
- **ELEVEN MONEY REFUSALS AND FIVE COMPARISON REFUSALS — TWO VOCABULARIES, SIXTEEN SENTENCES, ALL
  PAIRWISE DISTINCT AND ALL >40 CHARACTERS.** They are separate because the money's withhold a figure
  a PRICE would fix and the rollup's withhold a comparison no price can buy.
  - `BotBenchmarkCostRefusalReason` (**eleven**): `workspace_truncated` · `repo_window_incomplete` ·
    `no_merges_in_window` · `span_unobserved` · `own_rate_withheld` (carrying WHICH metric and WHICH
    gate) · `nothing_acted_on` · **`window_underpopulated`** · `price_is_zero` · `price_unresolved` ·
    `cohort_rate_unfitted` · `cohort_rate_zero`. ⚠ **THE GUARD ORDER IS `workspace_truncated` →
    repository → money → reviewer → WINDOW → cohort** — `cost.ts`'s own order with truncation bolted
    on TOP and the span step replaced by the cost window's, because a partial estate makes the exact
    claim false and no other refusal in the list describes that. The WINDOW step is three gates in
    order, and none of them falls back:
    `repo_window_incomplete` (a repository held for less than `COST_WINDOW_DAYS` — a partial month
    of work against a WHOLE price, inflating; ⚠ **excluding it would push the figure HIGHER**, since
    the price does not shrink with it, so it refuses rather than being disclosed and carried) →
    `nothing_acted_on` (a whole and EMPTY month — a DORMANT reviewer, and a lifetime average smeared
    against today's price is a plausible number measuring nothing) → `window_underpopulated`
    (< **10** acted-on threads: `below_min_units`' argument applied to money, whose remedy is TIME
    rather than pooling, and which withholds the per-thread figure ALONE — counters, the pooled rate
    and `unacted` are over the whole read slice and are unaffected). ⚠ `span_unobserved` is now
    UNREACHABLE from the rollup and survives only in `buildUnitCost`'s pinned per-repository
    specification. At estate grain the two 14-day REPOSITORY reasons are fatal only when EVERY live
    repository trips them (one partial repo is excluded-and-disclosed instead), and an empty pooled
    denominator lands on `own_rate_withheld` with `metricReason: 'denominator_empty'` — pooling IS
    the remedy `below_min_units` exists for, so no metric gate fires one grain up.
  - `BotBenchmarkRollupRefusalReason` (five): `single_repo` (one point is not a spread — a category
    error, not a thin sample) · `no_placed_repos` · `no_fitted_cohort_rate` (its sentence names the
    ZERO-median cause explicitly, or it would itself be a false claim) · `no_settled_threads` ·
    `vendor_not_in_corpus` (⚠ **the CARD STILL RENDERS** — its counters and its cost are the
    customer's own facts and owe the corpus nothing; only the two comparison sections refuse. Sonar,
    GHAS and `github-actions` are real multi-repo bots and none is in the seven-vendor corpus).

#### Cost on the Benchmark tab — the price per unit of work, and the counterfactual

> ⚠ **THE TIME BASE IN THIS SECTION IS ALSO SUPERSEDED.** Every `span`-anchored figure below
> describes `buildUnitCost`, which no request builds; the rollup's `$ per acted-on thread` divides by
> a CHOSEN calendar month (`COST_WINDOW_DAYS`) at both ends and reads no span at all. The reasoning
> is kept because its argument outlives its conclusion — see "THE MONEY DIVIDES BY A CHOSEN CALENDAR
> MONTH" above.
>
> ⚠ **THE GRAIN IN THIS SECTION IS SUPERSEDED — READ "THE WORKSPACE ROLLUP" ABOVE FIRST.** The
> per-repository cost block described below is **no longer on the wire and no longer built on any
> request**; money moved to `BotBenchmarkWorkspaceRollup.cost`, one card per vendor. What survives
> verbatim is every RULE it establishes — null-is-not-zero, the per-seat multiply, one-factor-swapped,
> state-a-rate-never-a-history, the two money figures being different quantities, and the
> difference-of-shares bound — because `rollup.ts` IMPORTS them from `cost.ts` piecewise rather than
> restating them, and `benchmark-cost.test.ts` still pins them against `buildUnitCost`. Read the rest
> of this section for the reasoning; read the rollup section for what ships.

**What the reviewer costs per unit of the work it produces, and what better engagement with it
would be worth.** Rides the SAME placement response (no new route, no new rate tier). Files: `bots/benchmark/cost.ts` (PURE: no db, no clock,
no request) + the two columns `collect.ts` now selects. Wire: **formerly**
`BotBenchmarkPlacementUnit.cost?`, now `BotBenchmarkWorkspaceRollup.cost?`. Tests:
`platform/test/benchmark-cost.test.ts` (the arithmetic and every refusal, still against
`buildUnitCost`) + the `cost —` describe in `benchmark-placement.test.ts` (end to end at the ROLLUP
grain, over a real database and the real shipped corpus).

**STATE A RATE, NEVER A HISTORY.** Two facts are available and neither is historical: a price
recorded TODAY and a throughput observed RECENTLY. So every money figure is a rate at the current
price, and the observed span is used ONLY to annualise the WORK. The repository figure is the one
exception and is internally closed: a fortnight's price over a fortnight's merges.

```
windowUsd        = effectiveMonthlyUsd × activityWindowDays ÷ 30.44
$ per merged PR  = windowUsd ÷ mergedPrsLast14d                  ← the ONLY 14-day figure

span             = [earliest, latest] comment THIS REVIEWER left on the walked slice
                   ← the measurement window for the WORK. IT CARRIES NO MONEY.
actedThreads     = threadsSettledCompleteActed   ← a COUNT off the fold, never a projection
settledThreads   = threadsSettledComplete        ← acted_on_rate's own denominator
yourRate         = actedThreads ÷ settledThreads
actedPerMonth    = actedThreads × 30.44 ÷ span.days          ← the COUNT, as a monthly pace

$ per acted-on thread  = effectiveMonthlyUsd ÷ actedPerMonth
at the peer median rate= effectiveMonthlyUsd ÷ (settledThreads × actedOnRate(COHORT p50) × 30.44 ÷ span.days)
SENTENCE 1, measured   = effectiveMonthlyUsd × (1 − yourRate)      ← what the price buys UNACTED, a month
SENTENCE 2, what-if    = effectiveMonthlyUsd × (actedOnRate(COHORT p50) − yourRate) ← what CLOSING THE GAP is worth, a month
```

- ⚠ **STATE A RATE, NEVER A HISTORY — THE SPAN MEASURES THE WORK AND NEVER THE MONEY.** The second
  cut shipped `spanUsd = effectiveMonthlyUsd × span.days ÷ 30.44` and made every reviewer figure a
  share of it, so the card asserted "US$236.53 over 8.6 weeks": a spend nothing here can evidence —
  the price may have changed, the subscription may be younger than the span, and nothing bounds the
  span by `repoHeldDays`. ⚠ **A CAP WOULD HAVE KEPT THE FALSE CLAIM AND MERELY SHRUNK IT**, so
  `BotBenchmarkCostSpan.usd` is DELETED from the wire rather than clamped (a field nobody reads is a
  field somebody reads later) and the arithmetic was re-expressed. ⚠ **THE VALUES OF THE PER-THREAD
  FIGURES DID NOT MOVE** — `spanUsd ÷ acted` == `monthlyUsd ÷ actedPerMonth` — which is why the
  change is pinned as a change of CLAIM: `perActedOnUsd` keeps its digits, `unactedUsd` and
  `conversionGapUsd` moved from "over the span" to "a month", and the tests name both answers.
  ⚠ **THE SPAN STAYS ON THE WIRE AND STAYS DISCLOSED** as the window the work was measured over
  ("2 of 20 threads acted on, over 9 days"), and `spanNote` says exactly that — it previously said
  the price was "prorated over exactly that stretch", which contradicted the figure beside it.
- ⚠ **MEASURE, DO NOT PROJECT.** The FIRST cut computed `mergedPrsLast14d × threadsPerMergedPr ×
  actedOnRate`: a STRICT 14-day merge count multiplied by two rates folded over the walked slice,
  which is `ORDER BY updated_at DESC LIMIT walkBudget` with **no time predicate** and a budget
  calibrated to roughly **ninety days**. Three factors, two periods, and the served disclosure named
  a *population* mismatch while calling the bias "slightly high". The fold already holds the real
  number, so the block divides the monthly price by a COUNT restated as a pace. ⚠ The span is read
  off the reviewer's own **COMMENTS**, not off merge times: the thread-outcome population is every
  human-authored pull request in the slice, merged or not, and a bot writes while a pull request is
  OPEN, so a merge-time span would be narrower than the population it measures.
- ⚠ **A UNIT WHOSE SPAN CANNOT BE OBSERVED REFUSES ALL THREE ARMS** (`span_unobserved`), including
  the two whose arithmetic no longer divides by it. A per-month rate asserts a RECENT PACE, and
  counts with no observable stretch of time behind them are not evidence of one — the warrant comes
  from the observation, not from the formula. `perMergedPr` is unaffected: it carries the fortnight
  at both ends. ⚠ `resolveSpan` also refuses a span whose `days` ROUNDS to zero at six places: that
  rounded figure is both the wire value and the divisor, so a sub-0.09 s span would make
  `actedPerMonth` an `Infinity` (under the old basis the same input was a finite WRONG ZERO).
- ⚠ **TWO MONEY FIGURES, TWO SENTENCES, AND THEY MUST NEVER SHARE ONE.** `unacted.unactedUsd` is
  what the price CURRENTLY BUYS AND NOBODY ACTS ON, per month (measured, own data only);
  `atPeerEngagement.conversionGapUsd` is what CLOSING THE GAP to the median is worth, per month.
  They differ by a factor of the cohort's rate and the first is always the larger while that rate is
  below 1. The headline shipped printing the SECOND under the FIRST's words — "US$11.04 of your
  US$55.19 is buying feedback nobody acts on", where the figure nobody acted on was US$33.11 — so
  `CostHeadline` is `{ tone, spend, comparison }` and a renderer cannot reunite them by accident.
- ⚠ **THE GAP IS A DIFFERENCE OF SHARES, NEVER A RATIO — that is what BOUNDS it.** `× (1 − yours ÷
  cohort)` is bounded in [0,1] only while the customer sits at or below the median; the shipped
  corpus has real fitted `acted_on_rate` medians as low as **0.242857**, so a team acting on
  everything produced −4.1 × the spend and the 'ahead' branch rendered "US$172.06 more of the
  US$55.19 reaches something". Both `unactedUsd` and the gap are now `effectiveMonthlyUsd` times a
  quantity in **[−1, 1]** — a rate, and a difference of two rates — so both are bounded by the
  MONTHLY PRICE **structurally**, not by a clamp (a clamp hides the next such error instead of
  preventing it).
- ⚠ **A RATIO NEVER CARRIES THE WINDOW AS A UNIT.** `costWindowLabel` belongs on the windowed
  TOTAL and nowhere else. Both value rows shipped suffixed with it — "Per merged PR · US$5.52 per 14
  days" — which reads as $/PR/fortnight and invites doubling for a month, while a cost per merged
  pull request does not scale with the window at all (both halves of the fraction scale together).
  A ratio's basis goes in its detail line, as prose.

- ⚠ **NO PRICE ⇒ THE BLOCK IS ABSENT — not empty, not zero, and not a "set a price" prompt.**
  `monthly_cents` NULL means nobody has said what this costs; `0` is a real, deliberate "we pay
  nothing for this". `buildUnitCost` returns `null` for the first and the key never reaches the wire.
  A "US$0.00 per acted-on thread" is a CLAIM about a reviewer nobody priced.
- ⚠ **A PRICE OF EXACTLY 0 RENDERS, AND ITS DERIVED FIGURES REFUSE.** Every division of 0 is 0.00 —
  true, and indistinguishable on screen from a broken panel. The price shows as "recorded as free";
  the three derived figures refuse with `price_is_zero` and a sentence.
- ⚠ **A PRICE THAT WAS ENTERED AND COULD NOT BE STATED IS A THIRD STATE, AND IT IS NOT SILENCE.**
  `monthlyUsd: null` + `pricedReviewers: 0` + every arm refusing `price_unresolved`: every priced row
  folded into this unit is per-seat and every one was dropped (no seam, or zero seats).
  `resolveUnitPrice` used to answer `null` here, which is the NO-PRICE answer — so a workspace whose
  ONLY priced reviewer for a unit is per-seat got no block at all, and `seatCountZero` could reach
  the screen only when some OTHER login kept the card alive. That is total silence where somebody
  typed US$15 a developer, and "a missing disclosure is the same defect as a wrong number, one line
  quieter". `costPriceLine` renders "No monthly figure — …" rather than `formatUsd(null)`, and
  `costSharedNote` is the ONE caveat gated off in this state, because it points at a figure.
- ⚠ **SWAP ONE FACTOR, NEVER TWO, AND LABEL IT A COUNTERFACTUAL.** `atPeerEngagement` replaces the
  customer's `acted_on_rate` with the cohort's median and NOTHING ELSE — "your volume, your price,
  their engagement rate". Multiplying a cohort-p50 volume by a cohort-p50 rate and calling it "what
  a peer pays" is a real statistical error (**the median of a product is not the product of the
  medians**), invisible on screen and wrong in a direction nobody could check. Both tests pin it
  with a fixture whose cohort thread-rate DIFFERS from the customer's — without that the mutation is
  unobservable — and both were mutation-tested by actually making the swap.
- ⚠ **NINE REFUSALS, NINE SENTENCES** (`BotBenchmarkCostRefusalReason` — a TENTH,
  `workspace_truncated`, was added later and is reachable ONLY from the rollup, so `buildUnitCost`
  still produces exactly these nine and `benchmark-cost.test.ts`'s nine-reason sweep is CORRECT at
  nine), joining the fourteen the
  tab already distinguishes: `repo_window_incomplete` · `no_merges_in_window` · `span_unobserved` ·
  `own_rate_withheld` (carrying WHICH metric and WHICH gate) · `nothing_acted_on` · `price_is_zero` ·
  `price_unresolved` · `cohort_rate_unfitted` · `cohort_rate_zero`. ⚠ The newest pair is the
  sharpest: `price_is_zero` ("recorded as free") and `price_unresolved` ("we could not multiply your
  per-seat price out") are one branch apart in the code and opposite claims on screen. The first two
  REUSE the placement's own headlines —
  two sentences for one cause on one card is how a reader stops believing either. ⚠ **The guard
  order is repository → money → REVIEWER → span → cohort**: a reviewer that said nothing here has no
  span either, and "said nothing here" is the half of that pair with a remedy attached, so
  `span_unobserved` is reserved for a reviewer that demonstrably spoke and still left no measurable
  stretch of time.
- ⚠ **THE METRIC IS THE GATE AND THE COUNTERS ARE THE VALUE.** `acted_on_rate` decides whether
  anything may be said (`below_min_units` exists because a rate over a handful of threads is noise
  wearing a percentage sign, and the counts sit right there to be read past it); the fold's own
  counters then say it, and `yourRate` is DERIVED from them so the rate and the counts beside it on
  screen cannot drift apart.
- ⚠ **`$ per merged PR` SURVIVES A WITHHELD REVIEWER RATE, deliberately.** It divides a price by the
  repository's own merges and asks nothing of the bot, so it renders when every metric about the
  reviewer was excluded — which is when it is most worth reading. It does NOT survive the two
  repository refusals: a partial window is an undercount that lands in the DENOMINATOR here (it
  under-places one level up but *inflates* here — a three-day repository would report several times
  its true cost), and zero merges is the divide-by-zero the placement already refused.
- ⚠ **THE PRICE IS PER WORKSPACE AND THE UNIT IS PER (REPOSITORY, VENDOR)**, so one US$120
  subscription over six repositories produces SIX blocks each carrying US$120. Apportioning it would
  be an allocation invented out of nothing, so instead every figure is an UPPER BOUND and the panel
  says so — unconditionally, because `sharedWithUnits` counts the cards in THIS response and the
  per-repo Bots tab narrows to one. Two logins the workspace calls one vendor are ONE unit and their
  rows are SUMMED (the sanctioned within-workspace total; `pricedReviewers` discloses the count).
- **`per_seat` multiplies ON READ**, through the host seam
  `ProHostQueries.workspaceHumanSeatCount?` — core's own `workspaceHumanSeatCount`, the same
  multiplier `effectiveMonthlyUsd` and the ROI table use, so the Benchmark cannot quote a different
  monthly figure for the same bot than the Bots tab does. If it ever answers nothing, a per-seat
  price is EXCLUDED from the figure and
  counted in `seatPriceUnresolved` — reading the per-developer unit as the monthly one would
  understate by the seat count, silently.
- ⚠ **A SEAT COUNT OF ZERO IS RULE 1 ONE LEVEL DOWN, AND IT HAS ITS OWN COUNTER**
  (`seatCountZero`, its own sentence, its own testid). The seat count is a PROXY — distinct human
  pull-request authors over a fixed trailing 30 days — and an empty one is the proxy failing, not
  the invoice. `resolveUnitPrice` multiplied straight through it, so `buildUnitCost`'s
  `monthlyUsd === 0` test could not tell that COMPUTED zero from a STORED one and the card printed
  "Recorded as free: this reviewer is recorded as costing this Workspace nothing" about a reviewer
  priced at US$15 a developer. Reachable without any repository gate firing: a maintenance-mode
  workspace whose recent pull requests are all Dependabot's still MERGES. The row is now dropped
  and counted, exactly like an unresolvable one — different fact, different remedy, different
  sentence — and when the drop empties the unit the answer is `price_unresolved`, never silence
  (above).
- ⚠ **THE TIME BASE'S OWN CAVEAT IS SERVED** (`spanNote`, so a renderer cannot drop it): the
  reviewer-side figures are RATES at today's price over a pace measured across the observed span,
  and `$ per merged PR` sits on the fortnight, and a card carrying both has to say which is which.
  ⚠ It must NOT describe a billing period: the version before this one said the price was "prorated
  over exactly that stretch", which contradicted the per-month figure printed beside it — the defect
  relocated into prose. It REPLACED `expectedActedOnNote`, which disclosed a human-vs-any-author
  population mismatch and said nothing about the time one — the larger error, on the same line.
- **Three sources in one block, labelled apart** (`COST_BASIS_LABEL`): a price a HUMAN TYPED, rates
  COUNTED from this workspace's rows, and an engagement rate FITTED from the corpus. That is the
  tab's own model-vs-code rule with a third arm, and the fitted one is the one that must never read
  as an invoice. Currency renders as `US$` — a bare "$412" is four currencies — and the WINDOW rides
  the price line only, never a ratio (above).
- **Assertions are on VALUES, never on `JSON.stringify`.** Two shipped as
  `expect(JSON.stringify(cost)).not.toMatch(/Infinity|NaN/)`, which **cannot fail**: that function
  writes `Infinity`, `-Infinity` and `NaN` as the literal `null`, so neither token can appear in the
  string being searched. Replaced by an `expectAllFinite` walk plus a **240**-shape sweep that
  drives every divisor through its zero and asserts NOTHING about status, so it can fail on its own
  — mutation-verified in isolation, with the guard it does NOT kill recorded at the test. ⚠ The last
  string-shaped assertion on this block (`not.toMatch(/"perActedOnUsd"|"unactedUsd"|"value":0/)` in
  the zero-price placement test) is now `not.toHaveProperty` on the live arms, like its sibling in
  `benchmark-cost.test.ts`: it was falsifiable, but it proved a SERIALISATION where the union
  guarantees a SHAPE, and it named no arm when it failed.

### The People report — REMOVED 2026-10-22

The People report (Reports → People), the contributor tab's 1:1 prep and "Ask about this period"
(the Reports chat, its pins and history) were removed with their routes. `pinned_prompts`,
`sprint_chat_history` and the `pro_synthesis` rows of kind `person` / `person_report` are DORMANT.
`ProHostQueries.getPersonPeriod` (core `db/person-period.ts`) stays wired with no caller.

### The Bot Themes panel — revived, and now the `Bots → Themes` sub-tab

`GET /api/pro/bot-themes` + `POST /api/pro/bot-themes/refresh` (`platform/bot-themes/`)
are back after the P2.3/C6 retirement, over the never-dropped `bot_theme_reports` table — **no
migration**. `BotThemesPanel` first replaced the `SynthesisCard` mount at the top of the Bots
Measure surface and now owns the **`Bots → Themes` sub-tab** outright (listed only while
`me.ai.enabled`; details in docs/FRONTEND.md § The Bots Themes panel). The three drill-down SynthesisCards (`BotVolumeDetail`,
`BotFlaggingDetail`, `BotThreadsDetail`) and the seam's `'workspace-bots'` kind are untouched and
still serve slice-scoped Summarise. ⚠ The move is SPA-only: same routes, same `scope_key`.

**⚠ The panel renders TWO CLASSES OF FIGURE and the caption must say which is which.** An early
draft claimed the whole panel was exact.

| Exact (code folds, D4) | Approximate (the model's read) |
|---|---|
| per-theme `commentCount` — Σ each cited cluster's code-computed `count` over the theme's **deduplicated** validated `memberIds` (an id outside the payload contributes 0) | `occurrences` — the model's own estimate, kept as the render fallback for legacy/pre-count stored rows and for the human sibling |
| per-bot volume + acted-on % (`BotThemeBotRollup`, keyed `u<userId>` like the ROI row), the top-level-dir `byArea` split, `coverage` | `byCategory` / `bySeverity`, which are aggregated FROM the model's per-theme estimates |

`ThemeThreadsDetail`'s per-theme metrics strip inherits the same split: its linked-member / PR /
repo / thread-state chips are client-side folds over data the view already fetched (its queries
are byte-identical to the groups' and badges' own, so React Query dedupes them and the strip
issues nothing new), and the strip discloses `n of m PRs loaded` while partial — but the ML
severity mix it shows is over that same loaded sample, not a population figure.

**What the revival had to re-fix in the legacy code:**

- **The payload hash dropped the day-quantised `windowKey`** and carries the version literal
  `bt2` instead. The old formula re-billed every dormant scope daily — the exact "nothing
  volatile in the sig" rule the synthesis seam already states. Consequence, stated on purpose:
  with generation manual-only there is now NO time-based staleness at all — a Regenerate on an
  unchanged corpus is free forever. The SET of cluster keys is content-derived, so membership
  drift regenerates while pure volume drift is a $0 hit; counts stay excluded (they slide with
  the clock). Rows hashed under the legacy formula simply miss once and regenerate.
- **The refresh was rebuilt on the synthesis TOCTOU shape**: the per-account slot is claimed
  SYNCHRONOUSLY (no `await` between `has()` and `add()` — the legacy code awaited a lookup in
  exactly that gap, so two concurrent POSTs both passed, both missed the not-yet-written hash
  cache, and both billed), and the min-interval is armed only when the model actually ran. The in-flight set is ACCOUNT-keyed: the
  legacy `account:workspace:window` grain let one account fan out N parallel Haiku calls by
  opening N scope/window combinations.
- **`VALID_WINDOWS` gained `rolling_90`** (added after the legacy set was
  written). Silently degrading it to `rolling_14` cached the WRONG population under the RIGHT
  client key.
- **`repoIds` narrowing** now rides `resolveRequestScope` (membership ∩ narrow) exactly as
  `behaviour-routes` does. `themesScopeKey` stays `ws:<id>` when unnarrowed — byte-identical to
  the legacy vocabulary, so the isolation-test seeds and the migration-0014 commentary stay true
  — and gains `|r:<sorted deduped csv>` ONLY when narrowed. It keys on the narrowing AS GIVEN,
  not the intersection, so workspace-membership drift does not re-mint the row; correctness never
  rests on the key alone, since the hash folds the actual cluster set.
- ⚠ **`BotReviewCommentRow` is re-declared BY HAND in `build.ts`** (a habit kept from the open-core
  boundary, when the plugin could import no host internals). It now has TWO consumers: this copy and core's
  `db/synthesis-input.ts`, which imports the declaration directly. A change to
  `queries.ts`'s `getBotReviewComments` return shape must be mirrored here.
- Rate tiers (pinned in core's `rate-limit.test.ts`): the refresh POST lands on the `/api/pro/`
  catch-all's `ai` pair; the GET stays on the plain `read` bucket. **DELIBERATE deviation from
  the synthesis GET**, which sits on `search`: this GET has no `stale` probe, because probing
  would re-run the whole `getBotReviewComments` fold on every Bots-tab open. Freshness here is
  the manual Regenerate, free when the corpus is unchanged.
- A gone-quiet scope answers with the STORED report, not `result: null`. Returning null had the
  client `setQueryData` a "No summary yet" box over the report it was showing, which the next
  GET refetch resurrected — a flicker whose CTA invited repeating the same no-op.

### The fix agent has no shell

`Bash` is gone from the fixer's tool surface. `FIX_TOOLS` (`apps/backend/src/coding/agent.ts`) is
Read/Glob/Grep + Write/Edit/MultiEdit + `submit_fix`, and `DISALLOWED_TOOLS` is
`['Bash','NotebookEdit']` — the same call Claude Review made (the comment above `WORKTREE_TOOLS` in
`apps/backend/src/review/agent.ts` is the long version of the argument, and this is the identical
input shape). The fixer reads and edits. It
installs nothing, builds nothing and runs no tests.

**Why.** Two reasons, either sufficient.

- **Safety.** The run is `permissionMode:'bypassPermissions'` with `settingSources:[]`, so nothing
  else was constraining the shell — and its entire input (title, description, diff, and on the
  `'comments'` seed nothing BUT review comments) is written by whoever opened the PR. The blocklist
  that stood in for a boundary was `Bash(rm *)`, `Bash(sudo *)`, `Bash(git push *)`,
  `Bash(git commit *)`, `Bash(git config *)`: five literal prefixes, silent on `curl -d @~/.ssh/…`
  and every other spelling. *A blocklist cannot enumerate the badness of a shell.*
- **Speed and cost.** The builds and tests it ran were read by NOTHING: `runCodingAgent`'s success
  criterion is a captured diff under `aiFixPatchMaxBytes`, `launchFix` marks the row succeeded the
  moment the seam returns un-aborted, and no column on the fix row records a verification. The bill
  was real — `aiFixMaxTurns` (40) and `aiFixBudgetUsd` ($5) are the only stoppers, there is **no
  wall-clock timeout**, a suite's output returns as a `tool_result` billed as input on the next
  turn, and `MAX_CONCURRENT = 1` (then the plugin's AI Fix manager) was ONE global slot, so one
  account's test run queued every other account's fix behind it.

⚠ **THOSE `Bash(git …)` ENTRIES WERE THE MECHANICAL HALF OF "THE HOST OWNS THE COMMIT".** The rule
is unchanged and now strictly harder — a denied shell cannot run git at all — but the grep-able
evidence is gone, so it is written out in the comment above `FIX_TOOLS` and still SAID in the
prompt (`WORKTREE_RULES`' "Do NOT commit, push, create branches", pinned by a test). The agent
leaves edits in the working tree, `captureWorktreeDiff` makes a patch, `coding/git-ops.ts` commits
and pushes it after the reader picks a target.

⚠ **THE PROMPT AND THE TOOL LIST CHANGE IN THE SAME COMMIT.** Removing the tool alone would leave
the prompt offering a shell, and every refused call costs one of 40 turns and a slice of the $3.
The text is `WORKTREE_RULES` (now core `coding/ai-fix/prompts.ts`), ONE constant interpolated into
every fix prompt so they cannot drift. (The second text, the old CI-analysis capability sentence, went
with the CI analysis.) `apps/backend/src/coding/tool-surface.test.ts` pins the tool lists and
mutation-tests its own scan.

**What the reader is told.** One templated line beside the diff, above the Push controls:
*"Not built or tested here."* It promises no CI: whole repos here report no checks at all, so "CI
will run on push" would invent the verification the sentence exists to deny. ⚠ **Not in the model's
summary** — a product fact is not model prose. Nothing had to be
retracted: the fixer never made a verification claim on screen. (The `verifying` phase this section
once warned about went with the rebase path below — its only emitter and its SPA label are gone.)

**What this costs, honestly.** A fix that wanted a codegen step, a formatter, or `git log` for
context must now write the edit by hand or decline. Accepted, for the reason Claude Review accepted
it. The way back is a container/VM boundary, or `canUseTool` under a non-bypass permission mode —
**not** re-adding `Bash` with a longer blocklist.

### AI Fix pushes as-is (trunk reconciliation removed)

**What went.** When the tab loaded, a succeeded fix POSTed `…/merge-preview`: two or three GitHub
REST calls plus a token from the `ai`/`ai_hourly` buckets (the `/api/pro/` mutating catch-all) on
EVERY tab load, including every revisit of an already-pushed fix — all 9 real pushes were to the
PR's own branch, so each one re-rendered "Reconcile with the trunk". And its answer described the
PR as it stood on GitHub, not the unpushed fix. Removed with it: "Checking against the trunk…",
Re-check trunk, "Rebase onto X" / "Merge X in", "Let Claude resolve conflicts", `ResolvedReview`
(the rebased diff + "Push rebased (force-with-lease)"), the `…/rebase` (+ `/stream`, `/cancel`)
and `…/push/stream` / `/push/cancel` routes, the manager's resolve/push jobs, the agentic conflict
resolver (`coding/agent.ts` `runConflictResolver`, `RESOLVE_TOOLS`, `submit_resolution`; the
plugin's `buildResolverSystemPrompt`), and the `CodingSeam` members `mergePreview` /
`rebaseResolve` / `mergeResolveAndPush` / `pushResolved`.

**Why.** A product decision: a fix is pushed as it is, and a conflict with the trunk shows on
GitHub like any other. Two defects went with the removed path: `pushResolved` leased on the
CURRENT remote head rather than the fix's `baseSha`, so commits pushed after generation would have
been force-overwritten; and the resolver paths gated on a credit meter but never charged it.

**What remains.** `POST /api/pro/ai-fixes/:fixId/push` is synchronous and never forced. An existing
branch is guarded by `HEAD_MOVED` (409 — the branch moved since the fix was generated) and
`PUSH_DENIED` (422); a new branch opens a PR against the base. A pushed fix, to either target,
renders `PushedCard` only. ⚠ A body naming a `strategy` other than `'plain'` (a tab still on the old
bundle) → `400 {error:'UnsupportedStrategy', message:'Reload the page to push this fix.'}` — never a
quiet plain push the reader did not click; `autoResolve` and `model` are ignored.

- **Accepted behaviour change:** a PR branch that moved since generation has no in-app rebase
  escape. Push to a new branch, or regenerate.

- **CORE "Update branch from trunk" is unaffected** (`coding/merge.ts` `updatePrBranchFromTrunk`,
  the PR route and the auto-merge runner): any conflict aborts with `CONFLICTS_UNRESOLVED`, and
  `aiFixRebaseMaxSteps` still bounds the continue/skip loop. Every `CodingErrorCode` member is kept.
- The eight `ai_fixes.resolved_*` / `resolve_error` columns are DORMANT — see
  [docs/MIGRATIONS.md](MIGRATIONS.md).

**`review/llm.ts` `cheapComplete` — the one-shot model seam.** Core-owned, so the platform adds
no Anthropic dependency of its own. It takes THE ONE CREDENTIAL LADDER like every agent run — the
Claude Code login through the Agent SDK (single turn, no tools), else `ANTHROPIC_API_KEY` through
the Anthropic API — and refuses under `LIMN_AI_DISABLED` ([CLAUDE-REVIEW.md](CLAUDE-REVIEW.md)
§ The credential ladder). Any new one-shot caller goes through it, never a client of its own.
(The grounded "addressed" check, its anchor-hunk hydration and its root-anchored evidence window,
described here before, were removed with the comment annotations; `GithubSeam.fetchCompareDiff` /
`fetchReviewCommentHunks` stay on the contract, unread.)

## Bot Tuning Advisor — REMOVED 2026-10-26

The Advisor (Bots Monitoring → Advisor: evidence cells → intents → config-PR / brief / issue
outputs, the effect panel, Tune/Drop pills on the ROI table) is gone, UI AND backend: the tab,
`BotAdvisorPanel`, `useAdvisor`, every `/api/pro/advisor/*` route and its rate-limit block, the
`platform/advisor/` modules and adapters, core `getAdvisorFindings` / `getBotEffectPanel`, the
platform seams only it used (`ctx.coding.commitFilesAndOpenPr`, `github.readRepoFile` /
`listRepoDir` / `openIssue` / `openPullRequest`), `coding/safe-path.ts`, `prepWorktreeAtRef`,
`createIssue`, `ghRestGetContentDir`, the `Advisor*` wire types and the `yaml` dependency.
⚠ **Its three tables stay DORMANT** — `advisor_recommendations`, `advisor_bot_profiles`,
`advisor_config_events` (platform migration 0021), never dropped. `platform/advisor/schema.sqlite.ts`
survives ONLY so `retention.ts` still ERASES them and `test/isolation.test.ts` still seeds them; do
not add a reader. An old `?botsTab=advisor` link is not a member any more and opens the ROI tab.
`users.app_slug` is still written; its one reader (the discovery tier) went with the Advisor.

## Chronology pointers — the work plan's shape, over Chronology's evidence

Three to five pointers beside Reports → Chronology (a pattern, an example worth copying, a thing to
try), each citing the pull requests behind it. Full contract: docs/BOTTLENECKS.md § Pointers.

- **Seam**: `ProHostQueries.getFlowPointerEvidence?`. Core folds the evidence in `db/flow-pointers.ts` from the same
  `getFlowCourts` pass the panel renders and sends NO PERSON: no actor ids, @handles masked in the
  one piece of free text (the first thing a reviewer said on each exemplar PR).
- **Module**: `platform/flow-pointers/` (routes, prompt, hash, schema), cache table
  `pro_flow_pointers` (migration 0034), listed in `eraseProByAccountId`, isolation-tested. The SPA
  shows the block while `me.ai.enabled`.
- **The parse is the mechanism**: citations ⊆ evidence (strays counted), the Unicode digit gate, an
  @-handle gate, a length cap, and a pointer with no surviving citation dropped whole. Per-reason
  drop counts go to the log so the prompt can be tuned against real refusals.
- `FLOW_POINTERS_PROMPT_VERSION` is folded into the payload hash — bump it with any prompt change,
  or accounts keep the old prose until their evidence happens to move.

---

## The work plan — "what should I work on today"

> **THE CODE RANKS. THE MODEL NARRATES.**

**There is no "Plan for today" panel any more.** It was a card under the daily-brief strip
rendering a ranked worklist that was, by its own alignment contract, the SAME POPULATION as the
attention board two rail clicks away — one population on two surfaces. It has been folded into the
**Pending** board:

- the two signals the cards never carried (`merge`, `update_branch`) are now real `InsightKind`s
  emitted by `getWorkspaceInsights`, so **all seven** WorkPlanKinds fold off cards;
- core `GET /api/attention` serves the board as **seven tabs**, each ordered by the SAME Do next
  scorer the plan ranks with (`db/work-plan.ts` `scoreCards`), with or without AI;
- the model writes **the sentences only**: a headline and `parked` above the tabs, and one `why`
  per planned row, shown on that row's card in whichever tab it sits, while `me.ai.enabled`. With
  AI off the reader gets the entire ordered board with no prose.

The plan still chooses its rows ACROSS kinds (its own per-PR dedup and kind/repo spread, capped at
`WORK_PLAN_ITEM_CAP`) — that is the evidence the model narrates and the plan hash covers, unchanged.
The board no longer shows that cross-kind selection as a section; it only carries its lines.

⚠ **A PLAN ROW MUST NAME A CARD THE BOARD LISTS.** `getWorkPlan` folds the board's UNCAPPED
`getWorkspaceInsights` and draws its rows only from `listedCardIds` (db/pending-tabs.ts — the
board's own listing rule, `boardListCap` per list group). It used to rank the capped fold (15 per
kind by severity / newest), and the kind/repo spread then seated low-scoring rows the board did not
list: on real data up to 10 of 12 `why`s had no card to sit on. `totals` still counts every row.

⚠ **THE TWO FORWARD KINDS INHERIT A NARROWING** the old standalone query did not have: the card
fold's **90-day ultra-stale gate**. A long-dormant-but-mergeable PR no longer appears — which is the
point, since a ranked row with no card behind it has nowhere to show its line.

⚠ **`conflicts` IS A CARD, NOT A PLAN ROW — AND THE SEVEN `WorkPlanKind`s ARE UNCHANGED.** The
Pending board's third merge-state kind falls out of `db/work-plan.ts`'s card→job chain and produces
nothing, deliberately. A plan row needs a `WorkPlanKind`, and that vocabulary spans **two
repositories**: the union and `BASE_PROXIMITY` in core (compile-checked) and the platform's prompt,
which enumerates `merge|update_branch|unblock_ci|review|reply|thread|nudge` as a **STRING**
(`platform/work-plan/prompt.ts`) that no compiler checks — so an addition on one side only hands the
model a kind it was never told about. (The board still RANKS conflicts cards inside Needs fixing —
with a board-only `conflicts` proximity base — but they never become plan rows.) Its PR facts are
gathered, because the board scores it, and `foldCounts` still ignores it: a kind that builds no plan
row is counted by no plan figure.

⚠ **AND THE SPRINT REPORT NEEDED A LINE FOR IT, WHICH NOTHING WOULD HAVE CAUGHT.**
`platform/insights/sprint-report.ts`'s card loop does `bump(repoFullName)` /
`agg.cards += 1` / `agg.loc += additions + deletions` / `addRef(c)` **before** its if/else chain, so
a kind matching no branch is not dropped — it is counted into that repo's `importance`
(cards × 3 + LOC/50) and added to the linkable PR table while contributing zero action items.
`ConflictsCard extends InsightPrRef`, so every field that code reads EXISTS: no compile error, no
failing test, just a report that silently re-orders itself around work it never lists. It now has its
own `continue` beside `ci_failing` and the two forward kinds, and
`platform/test/sprint-report-kind-coverage.test.ts` scans both source files and fails when an
`InsightKind` is not named in that loop. `insightsHash`'s `default: return ''` is filtered out (an unmatched kind contributes
nothing, not an empty slot), `chat.ts`'s if/else chain folds nothing before matching, and
`preset-prompt.ts` uses per-kind type-guard filters — all three are safe as written.

⚠ **THE DEPENDENCIES TAB'S TWO KINDS FOLLOW THE `conflicts` PRECEDENT EXACTLY** (`security`,
`dependency_bump`; [BACKEND.md](BACKEND.md) § The Dependencies tab). `scoreCards` scores them for the
board — into the same `boardOnly` list as `conflicts`, from the base their state names
(`DEPENDENCY_STATE_BASE`, plus the board-only `security_alert` 0.55 and `waiting` 0.3) — and they
never become plan rows: `WorkPlanKind` is unchanged, and so is `foldCounts` / `WorkPlanEvidence.counts`.
The sprint report needed its own `continue` for them, the fourth such line, or both would have been
counted into repo `importance` and the PR table (`SecurityCard` and `DependencyBumpCard` extend
`InsightPrRef`, so nothing fails to compile); the kind-coverage test fails without it. `chat.ts` needs
no code: its chain folds nothing before it matches.  ⚠ **The plan and the sprint report re-key ONCE** per workspace that had dependency
PRs: those PRs left `stalled_review`, `untouched_thread`, `reviewer_routing` and the forward kinds, so
the cards both hashes cover changed. Expect one `stale` and one regeneration, not a recurring one —
nothing `now`-derived entered either hash.

⚠ **MERGE PROXIMITY IS APPROVAL-CONDITIONAL** (0.95 approved / 0.45 not, the latter deliberately
below `review` 0.55 and `reply` 0.5). A clean PR nobody has reviewed is ready for GitHub, not ready
for a human — and because the per-PR dedup survivor is chosen by proximity, the old flat 0.95 also
let a merge row beat that same PR's `review` row, so the head said "nothing is blocking this" while
the board said "your turn" about one pull request. Measured context: on the reporting account, 9 of
11 and 7 of 8 merge-ready PRs on two workspaces are bot-authored.

### The division of labour, which is the safety property

**Every figure, id, link and rank is CODE-derived.** The model receives the already-ranked items
and may only (a) choose which to foreground, (b) order those, (c) write one sentence each about
why now, plus a headline and an optional "what can wait". It may not invent an item, restate a
number, or take work off the board — anything it omits still renders, below the divider, in the
board's own tail.

Enforced three ways, none of them the prompt alone:

- ids the model names are intersected with the evidence; strays are dropped **and counted** into
  `StoredWorkPlan.droppedIds`, which the board shows when non-zero;
- the **D4 digit gate** (`/^[^\p{Nd}\p{No}\p{Nl}]*$/u`, Unicode numerals — the input includes
  attacker-authored PR titles) runs on the headline, every `why`, and `parked`. A string carrying a
  digit is **dropped, never rewritten**;
- the **second-person gate** fires on steps whose item `relevance === 'none'` and nowhere else —
  second person is a *fact* for `direct`/`maintained` rows and a guess for shared work. This is a
  deliberate narrowing of the synthesis rule; do not widen it "because the surface is personal" —
  the reader's DAY is personal, the ROW is not, and this matters MORE now that the narration sits on
  a board explicitly holding other people's work.

### Alignment with the brief

> THE BRIEF SAYS HOW MUCH. THE PLAN SAYS IN WHAT ORDER. THEY ARE ONE POPULATION.

**All seven** signals are folded off `getWorkspaceInsights`' `InsightCard[]` — the same fold
`computeBriefCounts` counts — rather than re-derived, because a second predicate for "an untouched
thread" is a second number for one population, inches away on screen. (It was six until `merge` and
`update_branch` became card kinds; the seventh was the standalone open-PR query that made the plan
a second population.) `WorkPlanEvidence.counts`
travels on the wire **so the agreement is assertable**; `work-plan.test.ts` pins it field-by-field
against `getDailyBriefEntry`, and that assertion is mutation-tested.

Two signals the cards never carried come from one query over open non-draft PRs in scope:

| kind | predicate |
|---|---|
| `merge` | `READY_MERGE_STATES` (**imported** from `db/triage.ts`, never re-spelled) and `mergeable !== 'conflicting'` |
| `update_branch` | `mergeStateStatus === 'behind'`, and only that |

⚠ `behindBy` is **not stored** (every read is a live GitHub `/compare`) and is the wrong signal
anyway — `behindBy > 0` is true of most healthy PRs, while `'behind'` means GitHub is actually
refusing the merge.

### The rank

`score = w.proximity·proximity + w.stall·stallRisk + w.relevance·relevanceWeight`, with the READER's
weights (Settings → My Turn; the default, Balanced, is 0.50 / 0.30 / 0.20), sorted descending with a
**total** tie-break chain, so two ticks over unchanged data produce byte-identical order — a panel
people read top-down may not reshuffle between polls.

⚠ **MY TURN SETTINGS REACH THE PLAN.** `rankWorkPlan` reads the account's
weights (`getMyTurnSettings`) exactly as the board's `rankPendingTabs` does, so the plan and the
tabs rank one way. The platform reads no weight and the plan hash folds no score, but a weight
change can swap which rows the cap keeps, and promoting `own_thread` or `trunk_red` changes those
rows' `relevance` (a home untouched-thread row is scored `'none'`; the promoted one is the reader's,
`'direct'`) — either makes a stored plan read `stale` ONCE; nothing regenerates on its own. A
promoted row keeps its home row's `WorkPlanKind`, id and facts (`wp:unblock_ci:<prId>`,
`wp:<merge|update_branch>:<prId>`, `wp:thread:<prId>:<threadId>`, `wp:unblock_ci:trunk:<repoId>`;
`own_conflicts` stays board-only like `conflicts`) — only `relevance` and `cardId` differ, and the
SPA joins each `why` by the current `cardId`. `WorkPlanKind`, `WorkPlanItem` and
`ProHostQueries.getWorkPlan` are unchanged. ⚠ **The sprint report skips a promoted card for the
same reason it skips its home kind** (`c.reason === 'trunk_red' || MY_TURN_OWN_WORK_REASONS.has(…)`
— the `trunk_red` literal is REQUIRED: `Set.has` does not narrow the union, and the repo-grained
`MyTurnTrunkCard` has no `additions` for `bump`). So an own untouched thread leaves that report's
untouched count while the reader has it promoted — a reading setting, stated.
`sprint-report-kind-coverage.test.ts` pins the skip.

⚠ **`ageHours`, `stallRisk` and `score` are derived from `now`** and must never enter
`workPlanPayloadHash`, or a dormant workspace re-bills on a timer *and* the free GET (which
recomputes the hash from a fresh fold) disagrees with the POST forever: permanently `stale`,
re-billed on every click.

⚠ **The cap seats one row per non-empty kind before filling by score** (`capWithKindCoverage`). A
plain `slice(0, CAP)` deletes a whole signal — the relevance weight means a dozen `direct` rows
out-score every shared-work row — and the panel then tells the reader that nothing is behind trunk.
The absence looks like a fact; it is an artifact of the cap.

### ⚠ ONE PR IS ONE JOB

Deduping on the item id is **not enough**. The my_turn fold and the merge fold reach the same PR
under different ids, so an approved, mergeable PR of yours arrived twice — `wp:merge:<id>` saying
"nothing is blocking this" and `wp:review:<id>` saying "your PR is approved and waiting on you".
One instruction printed twice, burning two of the twelve slots. It was invisible to every unit
test, because each fold is individually correct, and was found by looking at the running app.

A second pass therefore keys on `prId`:

- the survivor is the **highest-`proximity`** row (the action furthest along), tie-broken by the
  time-free `tieRank`;
- ⚠ **proximity, not score** — score folds `stallRisk`, so choosing by it would let the survivor,
  and therefore its `reason` (a **hashed** field), change on a timer and re-bill;
- ⚠ **PR-grained rows only.** Two untouched threads on one PR are two jobs, and a red trunk is
  repo-grained. The grain is read back off the id (`wp:<kind>:<prId>` ⇒ PR-grained), so a new row
  kind cannot get the two out of step.

### ⚠ A repo-grained row is about the BRANCH, not a PR

The trunk arm of `unblock_ci` resolves the current red head to the PR that **landed** it. That prId
is a link target and nothing more — trunk CI is non-monotone, ~21% of commit rows carry `unknown`,
and roughly one red head in nine is a direct push belonging to no PR. All three of these shipped
wrong once:

- **the model payload** gets `subject: 'the repository default branch — NOT a pull request'`
  instead of `number`/`title`. Handed a PR number, the model wrote *"needs this merge to let all
  pending work build"* and called another row *"the newest blocker"* — causal claims the card
  refuses to make. The system prompt also forbids naming a cause outright;
- **the facts** carry only `ciStatus` + `observed` age. Approvals and diff size belong to the
  landing PR, and "one approval" beside "default branch" is a claim about the wrong object;
- **the row** leads with "`owner/repo` **default branch**" and demotes the PR to "landed by #N",
  matching the `ci_failing` card's existing wording on the attention board.

### Routes, storage and cost

`GET /api/pro/work-plan` (free: evidence + cached plan + a `stale` probe, tier `[search, read]`)
and `POST` (billed, tier `[ai, ai_hourly]`). Both spelled explicitly in `tierFor` **above** the
`/api/pro/` catch-all, because that catch-all tiers on the verb and this GET re-runs the fold.

Storage is `pro_work_plans`, unique `(accountId, scopeKey)`, `output` TEXT, in
`eraseProByAccountId` and deliberately **not** in `pruneProByPrIds` (no `pr_id` grain).

The cost gates copy the synthesis seam exactly: a synchronous in-flight claim (no `await` between
`has()` and `add()`), a min-interval armed only on billed runs, `recordAiUsage` best-effort before the parse can fail, and a stored **empty sentinel**
so an unparseable answer cannot loop-bill.

⚠ **The POST folds the evidence BEFORE the throttle checks** — a deliberate divergence from
synthesis. `WorkPlanResponse.evidence` is "always present when enabled" (the deterministic worklist
renders whatever happens to the narration), so a throttled reply that dropped it would hand the
panel nothing. The cost is bounded by this route's own `ai` bucket, which is tighter than the free
GET's `search` bucket running the identical fold.

`ctx.queries.getWorkPlan` is optional on `ProHostQueries` — called `?.()`, absent ⇒
`{enabled: false}`.

## Moved from CLAUDE.md (2026-10-26)

Verbatim text taken out of CLAUDE.md to keep it under its size budget. CLAUDE.md keeps a
shorter form of each rule; this is the full wording.

### Bound statically at boot

- **Bound statically at boot**: `platform/context.ts` `bindPlatform` builds ONE context
  (`platform/contract.ts` `ProContext`: db, host queries, GitHub helpers, `cheapComplete`,
  scheduled jobs, retention/erasure/reporting-window registrars) and calls
  `platform/index.ts` `registerPlatform`. Platform modules read the host ONLY through that ctx —
  inject a new host dependency there, never import it directly. Tests pass a fake ctx.

### The peer benchmark

- **The peer benchmark** (`GET /api/pro/bot-benchmark[/placement]`) reads the BUNDLED fit at
  `platform/data/benchmark/benchmark-fit.json` (copied by `build-release.mjs` — a miss is
  production-only and silent). ⚠ **Refusals are the product** — never normalise one into a
  distribution shape; staleness is recomputed per request; `?cells=` 400s over 24. ⚠ **Money lives
  at WORKSPACE grain only**: a `?repoIds=`-NARROWED request builds no rollup, the rollup carries no
  percentile of its own, `BotRoiPanel` shows cost only when `repoId == null`. ⚠ `$ per acted-on
  thread` divides by `COST_WINDOW_DAYS` = `DAYS_PER_MONTH` (30.44, pinned by
  `benchmark-roi-agreement.test.ts`) and REFUSES rather than falling back; `workspace_truncated`
  outranks every other cost refusal; a cohort median of `0` is NO median.

### Its own migrations

- **Its own migrations**: `platform/migrations/*.sql`, run by `platform/migrate.ts` after core's,
  filename-sorted, each once by NAME in `pro_migrations` (existing installs re-run nothing). NO
  journal, NO `--> statement-breakpoint`. A failure now FAILS THE BOOT. Its tables keep their
  `pro_*` names; typed access via `proSchemaFor()` (`platform/db.ts`).

### Generation is cost-gated

- **Generation is cost-gated**: the payload-hash cache (⚠ **zero `Date.now()`-derived fields** and
  never hash a HYDRATED or derived value, or every judgement reads `stale` forever); a per-account
  in-flight slot claimed SYNCHRONOUSLY; min-intervals armed on billed runs only. Two mounts of one
  generation card share the MUTATION key.
