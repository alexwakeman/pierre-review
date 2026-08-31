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
{apiVersion:16, register()}`, and a `getProCapabilities()` singleton mirrored to the SPA via
`/api/me` (`pro:{activityDigest,reviewMemory,aiAnalysis,prSummary,aiFix,workspaceInsights,claudeReview,slackDigest,issueLinks}`)
exactly like `claudeReviewEnabled`. `src/pro/bind.ts`
runs in `index.ts` between `buildApp()` and `listen()`: gated on **`config.proEnabled`** — now
`PRO_DISABLED!=='true' && (!isCloud || PRO_CLOUD_ENABLED==='true')`, so Pro is on locally by default
AND can run the **paid summary-AI tier in cloud** behind `PRO_CLOUD_ENABLED=true` (agentic AI stays
off via unset `PRO_ADVANCED_AI_ENABLED`; per-account entitlement via `plan!=='free'` + the
`/api/pro/* 402` gate). It is **NOT a declared dependency** — instead `bind.ts` resolves the plugin by
**filesystem path** (`PRO_PLUGIN_PATH` override → then, **ORDER FLIPS BY ENVIRONMENT**:
`dist/index.js` → `src/index.ts` under `NODE_ENV=production`, `src` FIRST otherwise — a stale
`packages/pro/dist` would otherwise shadow `src` in dev and freeze the plugin at its last build;
paths resolve relative to the repo root via `import.meta.url`) and `await import(...)`s it. **Absent submodule ⇒ no entry file ⇒
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

**`apiVersion` is 21** (bumped from 20 by the tier line — `ProCapabilities` gains `botDepth` and
`ProHostQueries` gains five members in ONE bump; see § "apiVersion 21" below). 19 → 20 was
period-over-period reporting (`getPeriodMetrics`/`getPeriodCoverage`/`getPeriodLanes` +
`computePeriodForecast`, pro migrations `0025`/`0026`, capability `periodReports`). 18 → 19 was
"fix from comments" (§ below — `CodingSeam.generateFix` gained optional `commentVerdicts`).
17 → 18 widened `getBotAnalytics`'s `window` to `kind | {kind, fromMs, toMs}` and added
`'rolling_90'`. 16 → 17 was lean-storage ANCHOR-HUNK hydration (GithubSeam gained
`fetchReviewCommentHunks`; § "Anchor-hunk hydration"). 15 → 16 was the grounded addressed
check (GithubSeam gained `fetchCompareDiff`, the two-sha compare seam). 14 → 15 was the
Bot Tuning Advisor (GithubSeam gained `readRepoFile`/`listRepoDir`/`openIssue`, CodingSeam gained
`commitFilesAndOpenPr`, ProHostQueries gained `getAdvisorFindings`/`getBotEffectPanel`,
`CodingErrorCode` gained `BRANCH_EXISTS`, `llm.complete` gained `credential`, ProCapabilities
gained `botAdvisor`).
⚠ **FOUR literals must agree, not two**, and the one that actually enforces the handshake is the
easiest to miss: `apps/backend/src/pro/contract.ts` (the host's declared `ProPlugin['apiVersion']`),
`packages/pro/src/index.ts` (the plugin's exported value), `packages/pro/src/contract-types.ts` (the
plugin's mirror), and **`apps/backend/src/pro/bind.ts`'s `plugin?.apiVersion !==` comparison — THE
RUNTIME GATE**. A half-bump makes `bind.ts` log-and-degrade the ENTIRE plugin to OSS mode:
capabilities dark, every `/api/pro/*` 404, nothing thrown. ⚠ The gate's number is deliberately not
restated here or in the plugin's own checklist: both sat at `17` through two bumps, so the lines
written to prevent a half-bump were themselves sending the reader to grep for a literal that no
longer existed. **The current number is whatever those four files say — read them; only the count
(four) and which file enforces it are stable facts.** Note also that the plugin half lives in a
SUBMODULE, so "all four" spans two repos and the committed gitlink must point at a plugin carrying
the same number, or a fresh `git submodule update --init` checks out a plugin the host rejects. ⚠ **Nothing currently PINS the handshake** —
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
- **NEW `ctx.queries.defaultWorkspaceId(accountId)`** — for the ACCOUNT-WIDE CRON paths that have
  no request and therefore no `?workspace=`. That was two (the Slack digest and the AI-policy sprint
  refresh); the AI-policy sweep has since been DELETED, so today it is just the Slack digest. It is
  a signature change, not vocabulary: their old `scope = 'all'` default has no image.
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
✦ Feed                always — THE default landing, BriefStrip on top
⚠ Pending             always (CORE/free) — the worklist, led by the ranked "Do next" head
🤖 Bots               always (CORE/free)
◈ Reports             always — FREE flow metrics above the PRO period report
── repos ──           flat: no grouping headers, no colour dots, no "Other" bucket
```

⚠ **ALL FOUR ARE UNGATED.** Reports used to be FIRST and wrapped in `{caps.workspaceInsights && …}`,
from when it was nothing but the Pro period report. The FREE flow-metric header moved into it off
the Feed, so gating the entry would have taken a free feature behind the Pro wall; the pane gates
its own Pro halves internally instead. The two DAILY surfaces now lead — the Feed, and Pending,
which absorbed the "Plan for today" panel and is no longer an occasional surface.
⚠ **"Pending" is a LABEL-ONLY rename of "Needs attention"** — the store/URL literal stays
`'attention'`, because an unknown `?activityRepo=` value falls into the `parseInt` branch, yields
NaN and lands the reader on the Feed, breaking Back on same-session history entries. (The "Compare workspaces" rail
entry is GONE — cross-workspace comparison is Reports' "By workspace" axis; `'compare'` left the
`activityRepoId` union and the URL parser, and `lib/workspaceColors.ts` went with
`WorkspaceComparisonPanel`, its only importer.) **The rail is no
longer GROUPED** — a repo belongs to exactly one workspace and exactly one workspace is ever in
scope, so there is one list, `renderRailRow`'s key is the bare `String(repoId)` (never a
`${teamId}:${repoId}` composite), and `buildTeamColorMap`/`teamGroups`/`leftoverRows`/the "Other"
bucket are all deleted. Selecting a repo shows a **compact header** (stats + thread-state bar +
per-repo Pro digest) atop that repo's **open-PR list** (`RepoOpenPrList` — all its open PRs with
at-a-glance CI / approval standing / thread counts) THEN that **repo's own feed** (`RepoFeedHeader`
+ `RepoOpenPrList` + `<FeedView repoId>`). The rail selection is `store/filters.ts` `activityRepoId`
(`'feed'` default | `'bots'` | `'attention'` | `'insights'` | a repoId; `'retro'`
is gone with the Retro panel, `'compare'` with the Compare rail entry — no longer URL-parsed, so a
legacy `?activityRepo=compare` link falls through the parseInt branch and lands on the `'feed'`
default, normalization by construction).

- ⚠ **Branch POSITION in the right-detail chain is load-bearing.** The chain is `noReposAtAll →
  showingBots → showingAttention → showingInsights → noRepos → showingFeed`, where
  `noRepos` means "the SELECTED workspace has no repos" (the account may have plenty, living in
  other workspaces — the empty state distinguishes the two, since the remedy differs: add a repo vs.
  move one in). The lesson the deleted `showingCompare` branch taught still applies to any new
  account-wide pseudo-row: it must sit **BEFORE `noRepos`**, or it becomes unreachable whenever the
  selected workspace happens to be empty — exactly when someone is setting workspaces up.

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
cross-repo `FeedOpenPrsPanel`. `FeedView` still reads `feedIsolatedPrId` only to scope its query.
The feed-wide **"New activity — Refresh" banner is GONE**: newly-arrived items are spliced into
the list as they land, each marked with a per-card "New" chip until the reader has seen it
(`feedNewCohorts` — the rules live in [FRONTEND](FRONTEND.md) § "The Activity Feed auto-inserts").
Isolation does not interact with it.

**The rail entries' inner sub-tab bars** (all transient + URL-silent, all built DYNAMICALLY so a
tab exists only where it means something):
- **Feed** — `Feed` | `Themes` (Pro, `activityDigest`). Only Themes carries a "pro" pill.
  **`Compare teams` LEFT this bar** for its own rail entry: it compares every workspace in the
  account, which is not a property of the Feed's scope and had no business being nested under it.
  `feedInnerTab` is `'feed' | 'themes'` — `'compare'` is not a member. (It is TRANSIENT: in
  `freshDefaults()` but not in `FilterDefaults`/`pickFilterBarState`/`sanitizePersistedFilters`, and
  `useUrlState` never touches it, so a stale `'compare'` cannot survive a reload and needed no
  migration.)
- **Bots** (`BotsView`) — `ROI` (the Measure surface; the PANEL is Pro `botDepth` and shows a
  badge + locked pane, the caution / resolve backlog / tuning suggestions / bot feed around it stay
  free — see § The Bots ROI panel is paid) | `Advisor` (Pro `botAdvisor`, LISTED only when
  entitled) | **`Settings`** (CORE/free — the classification tab, see below; it shows in the
  per-repo Bots tab too, where it is the same WORKSPACE listing filtered CLIENT-SIDE to the actors
  with a footprint in that repo). ⚠ **The Bots RAIL ENTRY stays ungated on every tier**, exactly as
  the Reports one does, because the free Settings tab and the free triage flows live behind it.
  `'behaviour'` and `'themes'` were REMOVED from `botsInnerTab` with their tabs:
  per-bot depth is the `bot-detail` pinned drill-down, the workspace charts are a collapsed Pro
  section under ROI (`WorkspaceBotCharts`), and the bot-themes summary became the synthesis seam's
  "What they're flagging" card on Measure. The field is transient + URL-silent, so member removal
  needed no migration. ⚠ **`'themes'` did NOT return to `botsInnerTab` when the themes PANEL
  did** — `BotThemesPanel` replaced that SynthesisCard mount on the main ROI view; the union is
  still `'roi' | 'advisor' | 'settings'`.
- **Insights** — the whole sub-tab apparatus is GONE (`InsightsSubTab`, `insightsSubTab`,
  `normalizeSubTab`, the guarded bar): the pane is Reports-FIRST — `PeriodReportsPanel` is its only
  body and the ad-hoc chat lives inside the report as "Ask about this period". Safe to delete
  outright because the field was transient and never URL-emitted (`?report=` reads into
  `insightsReportKey` alone), so no blob or link can carry a stale value.

**Landmine — the visible tab is DERIVED, never written back.** `feedInnerTab` / `botsInnerTab` are
single scalars that can legitimately hold a key the current context doesn't render (Themes /
Advisor without the capability). Each consumer computes an `effectiveTab` fallback for the RENDER
only; a corrective `set…` would permanently forget the user's choice the moment a capability
flickers off.

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
auto-badges)**. `users.githubType` is captured from the GraphQL author `__typename`;
`AUTOMATED_LOGIN_PATTERNS` catches service-account PATs. ⚠ **Detection is now WHOLLY deterministic
and takes NO configuration.** A sixth step used to follow the behavioural band — an opt-in Haiku
tie-break, the only AI in the classifier — alongside a per-account login allowlist that widened
`AUTOMATED_LOGIN_PATTERNS`. Both were REMOVED with the settings that fed them (`bots.aiTiebreak`,
`bots.loginAllowlist`, plus `inhouseDetect`/`autoTagHighConfidence`/`deepDetect`), because those
settings lived in the PLUGIN's `pro_settings` while `classifyReviewer` is CORE — core structurally
cannot read a plugin table, and not one of the four call sites ever passed the flags. They were
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
DECLARED on both contract files (removing an optional field would want an apiVersion bump for no
gain) but nothing passes them — apiVersion stays **19**. **Bot-ROI** (`getBotAnalytics(accountId,
window, scope)` — the FOLD is core and capability-blind; its ROUTE is what gates, and the panel it
feeds is Pro `botDepth`) → per-kind volume/actedOn%/untouched/`overdueUntouched`/`medianAddressedMs`/oldest/humanFollowThrough/noiseRatio/`verdict`
(keep|tune|**noisy**) + ≤12wk trend → `BotRoiPanel`, and deterministic tuning suggestions →
`BotsView` (free — hoisted out of the panel, § The Bots ROI panel is paid); **cost is
SERVER-resolved from the workspace row** and the route STRIPS it for an unentitled account, with the
`pro_settings` `bots.cost` blob surviving only as a null-only client fallback. The `noisy` (ex-`kill`)
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
"Review bots" section (`BotSection`) is down to ONE knob — the `caps.slackDigest`-gated "Slack bot
digest" toggle (`bot_slack_digest`) — plus the explainer pointing at the Bots rail. Its "Detection"
and "Limn attribution" sections were removed (above); their `pro_settings` columns are left DORMANT,
like `bot_auto_resolve*`, with no migration. ⚠ **Keep the section shell and its
`data-testid="bot-settings-section"`** even when the toggle is gated off —
`scripts/capture-shots.mjs` targets it and `pnpm shots` breaks without it. The per-reviewer
`DetectedReviewersTable` lives in the Bots **Settings** sub-tab (below), which shows in the per-repo
Bots tab too, where it is the same WORKSPACE listing filtered client-side to that repo's footprints. Deterministic tuning suggestions are **advisory only** (no mute action) and are **FREE** — they were hoisted OUT of the ROI panel into `BotsView` when the panel went paid.
**Tiers:** detection/dedup/resolve/classification are **CORE (free)**; the ROI ANALYTICS —
`BotRoiPanel` itself and the routes behind it — are **PRO `botDepth`** (§ The Bots ROI panel is
paid), and the analytics PANELS + the Slack block ride the existing
`workspaceInsights`/`slackDigest` caps. No new cap for any of it. The
Pierre marker is now unconditional and therefore free. **Migrations:** core `0027` (`users.github_type`), `0028` (`bot_review_classification`), `0029`
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
  **WORKSPACE**. There is no longer an account-wide *counterpart*: detection takes no configuration
  and the Limn marker is unconditional, so `BotSection` in the Settings modal is left holding only
  the Slack bot-digest toggle. Price is edited INLINE on the reviewer card
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

**Opt-in CI-failure rows (`includeCiFailures`, OFF by default).** Two more SYNTHESIZED kinds with
no `events` rows behind them, following the `claude_review` precedent: **`ci_failed`** (a failed
check on a PR head, from `ci_status_events`) and **`trunk_ci_failed`** (a failed check on the
default branch, from `trunk_ci_status_events` — migration `0052` / pg `0039`). `ConsolidatedFeedItem.
kind` stays a bare `string`, NOT `EventType`, precisely so a synthesized kind needs no widening of
`EVENT_TYPES` / the Timeline's type filter / the Welcome-back counter. What to know before touching
them:
- **Grain: one item per `(PR-or-branch, head sha, check name)`, EARLIEST observation winning.** Both
  sources are TRANSITION logs, so checks going red one at a time write several rows for one broken
  push. Capped at `MAX_CI_ITEMS_PER_HEAD` = 5 names per head, with the overflow DISCLOSED in the
  card's summary; scan capped at 1000 rows per builder.
- **`observedAt` is OUR observation time** (neither branch nor PR query selects `completedAt`), so
  the copy says "detected", never "failed at".
- **Actor-less**, so — exactly like Claude runs — the server skips them under `botsOnly` or any
  member filter, and they are **WITHHELD from `enrichMyTurn`**: a null actor is trivially "not
  you", so handing them over would turn every red build on a participating PR into an UNCAPPED
  My-Turn card, a core-lane behaviour change hidden inside a CI toggle.
- They are NOT in the uncapped `alwaysRows` set (a flaky matrix build would starve the 250-row
  plain-activity budget), the per-page enrichment must NOT overwrite their `ciStatus` with the PR's
  LIVE rollup (the card reports the state AT the observation), and `trunk_ci_failed` has **no PR**
  — its card is non-clickable and carries one `safeExternalUrl`'d commit link instead.
- Client side: `feedShowCiFailures` is a FETCH toggle threaded into the feed key AND the head-poll
  key, and the one feed toggle that PERSISTS with the filter bar. See CLAUDE.md § Frontend.
- ⚠ **No backfill for the trunk log** — see docs/MIGRATIONS.md § known gaps.

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

### apiVersion 21 — the tier line: `botDepth`, five seams, the synthesis platform

ONE bump carrying every seam the calm-consolidation plan needs (its D2: each bump is a
four-literal, two-repo, gitlink-coordinated hazard, so it is paid once — later phases swap
declared-inert seam bodies for real folds, which changes NO contract and needs no 21→22).
What 20 → 21 changed:

- **`ProCapabilities` gains `botDepth`** — the paid NON-AI depth tier: behaviour
  trends/anomalies, the per-bot drill-down, overlap, where-bots-work, inflation history, the
  per-seat ROI cost overlay. Gated exactly like `workspaceInsights` (`PRO_DIGEST_ENABLED` is the
  "paid tier on" proxy — no new env var; `entitledProCapabilities` zeroes it for free cloud
  plans). ⚠ **NOT gated like `botTriage`**, which is `true` whenever the plugin is merely loaded
  — that distinction is the whole tier line. **Its reach WIDENED after 21 shipped, with no
  apiVersion change** (no new capability member, no plugin change): it now covers **the WHOLE
  `BotRoiPanel`**, not just the cost overlay — see § The Bots ROI panel is paid, below.
- **`ProHostQueries` gains FIVE members.** Two landed live: `getBotBehaviour(accountId, window,
  scope, botUserId?)` — the existing CORE rollup (`getBotBehaviourAnalytics`) re-exposed so the
  route could MOVE from core `/api/bot-behaviour` to plugin `GET /api/pro/bot-behaviour`
  (the periodReports precedent: compute stays core, no free surface; a flag-less local run 404s
  a direct hit — `BotBehaviourResponse` has no `enabled` envelope to degrade into). The optional
  `botUserId` narrows to ONE bot for the bot-detail tab's fetch (must not compute fifteen bots'
  heatmaps to render one); core admits only ids in the workspace's role-`'review'` reviewer set,
  so a foreign/non-reviewer id yields the EMPTY response, never someone else's data. And
  `getPeriodMetricsForWorkspaces(accountId, window)` — the Reports "By workspace" axis: the same
  window-pure vector per workspace (listWorkspaces order), each with a per-workspace coverage
  disclosure, and ⚠ **NO cost fields, ever** — cost is per workspace and a cross-workspace
  surface cannot total it honestly, so it simply does not travel. Three landed DECLARED-inert
  (`Promise<unknown>` sketches) and were later implemented behind the unchanged contract:
  `getSynthesisInput` (→ `db/synthesis-input.ts`), `getDailyBriefCounts` (→ `db/daily-brief.ts`),
  `getPersonPeriod` (→ `db/person-period.ts`). Each was then TYPED with the shared wire type
  (`SynthesisInput`/`DailyBriefCounts`/`PersonPeriod`) — a permitted no-version refinement, the
  plugin mirror moving in the same task — **because the plugin's payload hashes fold those very
  values**, and a cast-and-hope seam is exactly where a hash formula drifts.

**apiVersion STAYED 21 for the People report** — and "additive" is a NARROW test, not a mood.
What qualified: a TRAILING optional argument on an existing member (`getPersonPeriod(…, opts?:
{evidence?: boolean})` — an older plugin calls with four args and type-checks; an older HOST
simply never sets `person.evidence`, which the shared type declares optional for exactly that
reason — the `registerAccountErasure` precedent); UNION widenings the old code never emits
(`SynthesisScopeKind += 'person_report'`, `SynthesisItemKind += 'path_area'`); and optional
result fields (`StoredSynthesis.sections?`, `PersonPeriod.evidence?`). ZERO core and ZERO plugin
migrations. A SPA↔plugin **wire** type is not `ProContext` at all and never bumps — that is why
`SprintChatBody.history`, `SprintChatResponse.followUps`/`trimmedTurns`, `BotThemesResult` and
`BotTheme.commentCount` landed at 21 too. What would NOT qualify: changing an existing
parameter's type, making an optional field required, or removing a union member.

**The synthesis seam (`GET`/`POST /api/pro/synthesis` + `pro_synthesis`, plugin migration
`0027`).** ONE endpoint pair and ONE cache table serving every "have the model summarise this
set" grain — per-feature endpoints are exactly what the plan's D3 forbids. The standard
`/api/pro/*` stack (registration only when the plugin loads; `DIGEST_ENABLED` self-gate — the
`activityDigest` capability; the host's automatic cloud 402). The contract:

- **Seven `SynthesisScopeKind`s in two modes.** Four CLUSTERS grains — `'bot-flagging'`,
  `'bot-threads'` (windowless — a current-state backlog), `'bot-volume'`, `'workspace-bots'`
  (the workspace-grain bots question, still serving the three drill-down cards) — three ORDERING
  grains — `'brief'`, `'rollup'`, `'person'` — and, at the same apiVersion, the SECTIONS grain
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
  ref, any digit) is dropped and its strip line renders TEMPLATED; an entirely unparseable
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
- **`pro_synthesis`** (migration `0027`, both dialects): one row per `(account_id, scope_key)`
  (regenerate = overwrite via `onConflictDoUpdate` on exactly that declared unique — the
  0042/0045 lesson is cited AT the write); `output` is validated JSON as **TEXT in both
  dialects** (one serializer owns the blob); `input_count`/`analyzed_count` are REAL COLUMNS
  because "Summarised X of Y" is the disclosure that keeps a capped synthesis honest and must
  survive output-shape drift. Deliberately NO foreign keys (resolver-produced workspace ids
  only; a regenerable scope-keyed cache, the `bot_theme_reports` family). Erasure: listed in
  `retention.ts` `eraseProByAccountId`; deliberately NOT in `pruneProByPrIds` (no pr_id grain —
  it ages by STALENESS, not deletion). ⚠ The pg twin's CREATE is BARE on purpose — no
  `DO $$ … EXCEPTION` wrapper, exactly like 0021's/0025's CREATEs: a missing TABLE cannot
  degrade (every synthesis call would 500 forever while `pro_migrations` records the file
  applied), so a raise is the honest outcome and `IF NOT EXISTS` covers the benign replay.
- **Cost discipline + the TOCTOU fix.** The digest/themes stack: per-account in-flight guard →
  min-interval → credit gate → payload-hash $0 cache → `recordAiUsage` on real generation only.
  ⚠ **The in-flight slot is claimed SYNCHRONOUSLY — no `await` may sit between the `has()` and
  the `add()`.** `BriefStrip` fires the brief + rollup POSTs in one render cycle; with an await
  in that gap both pass the check, both miss the not-yet-written hash cache, and both bill. The
  credit check therefore runs INSIDE the `try/finally` (a blocked call holds the guard only for
  that one lookup; the `finally` releases on every path). The min-interval is armed only when
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

**The daily brief (`GET /api/daily-brief`, CORE/FREE — counts only).** `db/daily-brief.ts`
computes on read behind a module-level 5-min TTL cache (zero core migrations, the plan's D5);
`?rollup=1` adds one count line per OTHER workspace (capped 12, each line riding the same TTL).
⚠ Every line REUSES the fold of the surface it deep-links to — the consolidated feed's my-turn
facet under the default 'hide' lens (inheriting its actor-less CI-row exclusion), the
`/api/attention` card counts, `getResolvableBotThreadPrs().totalThreads`, the repos
default-branch head columns, and a NARROW volume-only anomaly slice (deliberately not the full
behaviour compute — that is priced for an explicit Pro tab open, not an every-morning free
strip). Never a re-derivation that can disagree with the surface it links to. Rate tier
`search`, pinned. The Pro narration is the synthesis seam's ordering kinds (`'brief'`/`'rollup'`)
— this route never touches AI and never carries cost/money (§8.18: the rollup loops per
workspace).

**The my_turn RELEVANCE split and its count pairs.** `DailyBriefCounts` and
`WorkspaceInsightsResponse` carry more my_turn figures beside `myTurn`/`myTurnTotal`:
`myTurnPersonal`/`myTurnPersonalTotal` (unchanged in meaning), plus the three-way split
`myTurnDirect` · `myTurnMaintained` · `myTurnOther`, **each with its own uncapped total**. Every
one of these, and `MyTurnPr.relevance` / `MyTurnCard.relevance` themselves, is a trailing-optional
addition, so **`apiVersion` stays 21** and an older plugin simply never reads them.

- ⚠ **`personal` CONFLATED TWO RELATIONSHIPS; `relevance` is that union un-collapsed.**
  `MyTurnRelevance` is `'direct'` | `'maintained'` | `'none'`: work tied to YOU (card copy "YOUR
  TURN") · a new PR by somebody else in a repo you maintain — ORBIT, NOT OWNERSHIP ("IN YOUR
  REPOS") · everything else ("REVIEW OR REPLY"). `personal` survives as a DERIVED
  `relevance !== 'none'`, still written by the server on every row, still meaning exactly what it
  always meant ("may a notification surface interrupt?"). Read `relevance` for anything that
  LABELS a row; a card that writes "YOUR TURN" off `personal` claims ownership of a stranger's
  work in a repo you happen to have write on — the defect the split exists to end.
- **The rule lives in `getMyTurn`, once.** Five of the six sections are `'direct'` by construction
  (they exist only because the viewer is involved) and are stamped in `toMyTurnPr`. The sixth —
  "New PRs" — has TWO ARMS that answer different questions, and they now **stay two facts all the
  way to the label**. The MAINTAINER arm (`viewerMaintainedRepoIds`) asks *is this your patch of
  ground*: `repos.viewerPermission` ∈ WRITE/MAINTAIN/ADMIN **∪** the repos `getMergers` says the
  viewer has landed a PR on (default branch only) — it yields **`'maintained'`**. The MENTION arm
  (`viewerMentionedPrIds` over `pr_mentions`) asks *did somebody type your name*, holds **even in a
  repo the viewer only READS**, and yields **`'direct'`** — which WINS over the maintainer arm.
  Neither arm ⇒ `'none'`. The insight-card block READS `relevance` off the row and folds
  `personal` from it — the `since` rule applied to the second question this fold would otherwise
  answer twice, and one source of truth so the board's label and the notification's count cannot
  disagree about the same card.
- **The mention arm is DERIVED OFFLINE** (`sync/mention-scan.ts` → `pr_mentions`), never computed
  in the request: the underlying question is a substring scan over every comment body in scope and
  this fold runs on every Feed landing. ⚠ **Absence never widens** — no rows means the flag is
  exactly the maintainer test it was before mentions existed, so a fresh deployment (or one whose
  scanner is off) behaves identically. See [DATA-MODEL.md](DATA-MODEL.md) § `pr_mentions` and
  [SYNC.md](SYNC.md) § "@mention derivation".
- ⚠ **NOTHING IS NARROWED BY IT.** `GET /api/my-turn` keeps returning every row (the CLI status
  board and the Done tab's restorability contract both need the full set) and the "Needs
  attention" board keeps painting every card — a PR in a repo you only read does still need a
  review. The flag exists for the surfaces that INTERRUPT (welcome-back banner, Workspace-dropdown
  badges, browser notifications), which must not summon you for 425 strangers' PRs.
- ⚠ **EVERY total is folded off the PRE-CAP ranked array**, in one pass next to `myTurnTotal`.
  Counted after the 50-card slice any of them would be bounded by 50 and stop being a total.
- **The split is MUTUALLY EXCLUSIVE and EXHAUSTIVE**, at both grains:
  `direct + maintained + other === myTurn(Total)` and `direct + maintained === myTurnPersonal
  (Total)`. So the daily brief renders **TWO lines that never double-count** — "N need your
  attention" (`myTurnPersonal`, the interrupting population) and "M need review or reply"
  (`myTurnOther`) — and each opens a board filtered to ITS OWN number. Notifications keep counting
  `myTurnPersonal`; the banner shows the split ("2 yours · 3 in your repos") off `myTurnDirect` and
  `myTurnMaintained`.
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
- ⚠ **`viewerMerged` ATTRIBUTES LANDING, NEVER BREAKING** — trunk may have been red before that PR
  merged, and the card says so on its face.
- **TWO NEIGHBOURING QUESTIONS ARE DELIBERATELY NOT BUILT** (measured on real data, cut, and
  recorded in the code where somebody would reach for them): *"PRs I MERGED whose CI is failing"* —
  `pull_requests.ci_status` is FROZEN at the merge instant (a merged PR is never re-walked), so it
  answers "did this land red", a retro metric, not an inbox item; and *"the commit that TURNED
  trunk red"* — trunk CI is non-monotone, 21% of `branch_commits` rows are ciStatus `unknown`, and
  chronically-red repos have no streak start, so honest transition attribution needs a NEW
  append-only per-commit table plus a sync step.
- ⚠ **`ciFailing` AND `trunkRed` ARE TWO LINES, NOT ONE.** `trunkRed` names EVERY red trunk in the
  workspace and each of its lines opens that repo's console; `ciFailing` counts the subset that is
  YOURS plus your own red PRs and opens the board isolated to `ci_failing`. Folding either into the
  other gives one of them a list its number does not match.
- **Cap:** it shares `INSIGHT_CARD_CAP` (15) with the survey kinds but, like `my_turn`, DISCLOSES
  it (`ciFailingTotal` + `ciFailingCapDisclosure`) — a worklist the viewer clears may not be
  silently capped. Everything is trailing-optional, so **`apiVersion` stays 21**.
- **The plugin side:** `insightsHash` gets an explicit `ci:<arm>:<repoId>:<sha|prId>` case, and the
  sprint-report payload loop an explicit `continue`. ⚠ That `continue` is load-bearing — falling
  through would count the card into the repo's importance ranking (`cards × 3`) and add a PR ref
  for an issue the report never lists.

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

### The Bots ROI panel is paid — the whole panel, and where the free line falls

`BotRoiPanel` used to be CORE/FREE with three cost surfaces cut out of it on `botDepth` (the
`$/acted-on` column, the "Depth →" pill, the price editor in Settings). That line never held: the
TABLE is the answer people buy — what each bot produced, what got acted on, what sat, what
repeated another bot. **The whole component is now `botDepth`.** No new capability member, no
apiVersion change, no plugin change.

**The reader's experience is VISIBLE-BUT-LOCKED, not absent** — the `ROI` sub-tab keeps its place
for everyone, wears the shared `<ProBadge variant="tab">`, and `BotRoiPanel` renders `ProLockPanel`
in its own place (`data-testid="bot-roi-locked"`; the entitled body keeps `bot-roi-panel`, which
`scripts/capture-shots.mjs` waits on). That reverses this codebase's older "hidden, never upsold"
posture, and the reversal is scoped to six named surfaces — see `components/ProGate.tsx`'s header.
Its sibling `WorkspaceBotCharts` keeps the OLD posture (silently absent on the same capability),
deliberately: two upsells stacked in one tab read as a paywall page.

**⚠ THE RAIL ENTRY AND FOUR SURFACES INSIDE THE `roi` BRANCH STAY FREE.** Gating "the Bots view"
rather than "the panel" takes all of them with it:

| Free (`botTriage`) | Where it lives |
|---|---|
| "Only a bot reviewed N open PRs" governance caution + its list | `BotsView`, reads `totals.botOnlyPrs` |
| `ResolveBacklogBanner` → review-and-resolve | exported FROM `BotRoiPanel.tsx`, mounted in `BotsView` |
| `TuningSuggestions` (the amber advisory box) | **hoisted OUT of the panel** into `BotsView` |
| the bot-only `FeedView` and the whole `Settings` sub-tab | `BotsView` |

`TuningSuggestions` is the one that moved. It is a free surface that was rendered inside the paid
body, so it was exported and re-mounted above the panel; it now reads as a heading over the table
rather than a footnote under it. `QualityCheckSection` did **not** move and goes paid — its
mis-role safeguard survives because the free Settings tab lists "Other automation" with each row's
role picker, which is where the re-role happens anyway.

**Server enforcement — one route NARROWS, six 402.** A client-only gate is not a monetisation gate,
and `/api/bot-analytics/volume/scatter` was already in exactly that state (component gated, route
open). Two predicates in `api/routes/bot-triage.ts` say which is which:

- `botDepthEntitled` → **402** on `…/volume`, `…/volume/prs`, `…/volume/scatter`, `…/flagging`,
  `…/vendor/:key/prs`. Each is ROI-only, so a 402 is honest where an empty list would read as
  "this bot did nothing".
- `botAnalyticsEntitled` = `botDepth || periodReports` → the **three** routes the ROI panel SHARES
  with the People report's bot sections. `…/vendor/:key/comments` and **`/api/bot-authoring`**
  (the report's per-bot AUTHORING vector plus its `?evidence=1` receipt cards) **402** on the union;
  **`GET /api/bot-analytics` NARROWS instead of refusing** — it is also the source of the FREE
  governance caution and the hoisted suggestions, so it keeps `totals.botOnlyPrs`,
  `totals.overdueGraceMs` and `suggestions` and withholds `vendors` (empty), `qualityChecks`/`ml`
  (absent) and the ROI half of `totals` (zeroed). ⚠ **A blanket 402 there deletes the free caution
  with no error anywhere** — the client reads `?? 0` — and re-fires every 5 minutes on the hook's
  poll.
- `GET /api/bot-reviewers` **stays free** (it is the app-wide bot identity/colour backbone and the
  free classification screen) but its **price columns are stripped**: `costMonthlyUsd` and
  `effectiveMonthlyUsd` come back null with `costModel: 'flat'` — the shape a never-priced row
  already has. Previously the client merely hid a price it had received.
  ⚠ **The strip is ONE helper (`stripCost`) applied by ALL FOUR handlers that echo a
  `WorkspaceReviewer`** — the listing, `PATCH :userId`, and BOTH resets. Stripping only the listing
  left `DELETE …/identity` (free, body-less, echoes the whole row) as a perfectly good read path for
  every price a downgraded account had entered. ⚠ **Consumers must decide cost state from `/api/me`,
  never from the value**: `null` now means EITHER "no price set" OR "not entitled to see it", and
  `costStateOf` (frontend `lib/botCost.ts`) maps null → `'none'`, which is only correct beneath a
  capability check. ⚠ **`GET /api/me/export` is the ONE deliberate exemption** and still ships
  `monthly_cents`: Art. 15/20 are about the subject's own data, not a feature tier
  (`db/export-account.ts` records the split).

⚠ **`/api/bot-analytics/bot-only-prs` STAYS FREE and must not be swept in by a later "finish the
job" pass** — it is the list behind the free amber caution, and a caption and its list have to
agree. Likewise the resolvable-thread read/resolve pair and per-PR dedup.

⚠ **`vendors`, `suggestions` and `totals` are REQUIRED on `BotAnalyticsResponse`**, which is why the
narrowed `totals` carries zeros rather than absence (`actedOnPct` takes the honest `null`). Nothing
free renders them and the SPA decides what to draw from `/api/me`, never by sniffing the payload.
⚠ **Making the three optional was CONSIDERED AND DEFERRED, not forgotten**: all three are read by
the PRIVATE plugin submodule as well (`packages/pro/src/insights/chat.ts` grounds on `vendors`,
`totals` and `suggestions`), so widening them is a two-repository, gitlink-coordinated edit for a
distinction nothing currently reads — every consumer is contractually forbidden from sniffing this
payload for entitlement. Do it with the next apiVersion bump, when the plugin half is being touched
anyway. The ambiguity is pinned in `bot-triage-entitlement.test.ts` so it stays a known shape.

⚠ **`useBotAnalytics` MUST STAY UNGATED** for the same reason the route narrows. Every OTHER hook
onto a now-402 route needs `enabled: … && botDepth` (`useBotBehaviour` is the pattern), or a mounted
component re-fires the 402 on its own cadence — twice over for the two infinite queries with scroll
sentinels (`useBotFlagging`, `useBotVolumePrs`).

⚠ **A flag-less `pnpm dev` now shows the ROI panel LOCKED.** `botDepth` is `PRO_DIGEST_ENABLED`
(plugin `index.ts`), which `pnpm demo` and the shots PRO pass set and the ordinary dev loop does
not. That is the same reason the price editor is already invisible on a flag-less local run, so it
is consistent — but the panel is a much more visible casualty.

### The peer benchmark — serving the cohort (`GET /api/pro/bot-benchmark`)

The COHORT half of "how does our bot compare": per-(vendor × activity band) distributions fitted in
`packages/ml` (`bot_monitor.panel.fit`), bundled as a JSON artifact and projected onto the wire.
**Pro on `botDepth`, no new capability, apiVersion stays 21** — nothing was added to `ProContext`,
`ProHostQueries` or `ProCapabilities`, and no host literal moved. It is deterministic: no model, no
database, no GitHub, no write, no cron.

**Files.** `packages/pro/src/bots/benchmark-routes.ts` + `benchmark/{artifact,map,percentile}.ts` ·
`packages/pro/data/benchmark/benchmark-fit.json` (the bundled corpus) · wire types in
`packages/shared/src/types.ts` · `api.botBenchmark()` in the SPA client · the tier entry in
`api/plugins/rate-limit.ts`. Tests: `packages/pro/test/benchmark-{artifact,percentile}.test.ts`
(**hand-run — `packages/pro/test/` is not in CI**) and the host-side
`api/plugins/pro-benchmark-entitlement.test.ts`.

**Nothing about the caller reaches the response, and that is the design.** The artifact is
IDENTICAL FOR EVERY TENANT — the one non-account-scoped body of data in the system — and it names
no repository and no actor. So the route takes **no `?workspace=`** and echoes **no `workspaceId`**:
a deliberate exception to §5.1, because the scope parameter exists to bound which of a tenant's
repos a response covers and this response covers none of them. There is no tenant data, therefore
no IDOR surface and no existence oracle. ⚠ The moment it grows a customer-side PLACEMENT leg, all
of that reverses and the scope rules apply again.

**Why the artifact is BUNDLED, not a table and not a bare env path.** Every plugin table is
account-scoped, joins `registerAccountErasure` and is covered by the plugin's isolation test; a
global singleton table inverts all three, and would need a loader with write access, two dialects
and a story for local SQLite — to buy "refresh without redeploy", which is worth nothing at a
quarterly cadence. And an env-configured path has nowhere to point: `railway.json` declares no
volume, and the runtime stage is `COPY --from=build /app/release ./`. The plugin is already
deployed by rebuilding the image, so a corpus refresh rides an existing motion with zero new
machinery. `PRO_BENCHMARK_FIT_PATH` is an **override only** (dev pointing at a fresh
`packages/ml/data/benchmark/fit_*.json`; an ops escape hatch).

- ⚠ **The path is the `../migrations` precedent, applied deliberately.** `data/` is a SIBLING of
  `src/` and of `dist/`, so `new URL('../../../data/benchmark/…', import.meta.url)` resolves from
  `src/bots/benchmark/` (dev — `bind.ts` prefers `src`), from `dist/bots/benchmark/` (`rootDir:
  src`, so identical depth) and from `/app/pro/dist/bots/benchmark/` in the image. A `./data/…`
  path relative to `dist` would work in production and break under `pnpm dev`. **This is the
  plugin's first runtime file read** — the rule is not inherited from anything.
- ⚠ **`build-release.mjs` copies `data` beside `migrations`, and asserts
  `pro/data/benchmark/benchmark-fit.json` in `mustExist`.** Without the copy the failure is
  PRODUCTION-ONLY and silent: dev and `pnpm demo` read it straight out of the workspace, while the
  cloud image answers `available:false` — indistinguishable from a deliberate OSS build.
  `.dockerignore` excludes `packages/ml` but not `packages/pro/data`, so no change there.
  `pnpm package` WITHOUT `--with-pro` never touches it, so `npx pierre-review` ships no corpus.
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

**Entitlement is the standard three-layer `/api/pro/*` stack** (registration → the `DIGEST_ENABLED`
self-gate 404 → the host's automatic 402). ⚠ The 402 is the CHEAPEST possible gate and the most
deletable, because nothing in the route file mentions it: it comes entirely from `isProPath`, in
the OTHER repository. `api/plugins/pro-benchmark-entitlement.test.ts` pins both directions and is
the only thing that would go red if the route were moved out from under `/api/pro/`.

**Publishing is a THREE-repo motion and the gitlink is the step that gets forgotten** — the same
failure shape as the four `apiVersion` literals. `packages/ml` fits → `fit.py --publish
<path>` writes the artifact into the PRIVATE `packages/pro` submodule → the host gitlink moves.
`--publish` runs `assert_publishable()` first, which re-verifies that **corpus rows never travel**:
it scans every corpus-derived string (skipping the authored-prose blocks) and refuses on a repo
slug, a `[bot]` login or an `@mention`. That property is a property of the artifact's SHAPE, which
one careless new disclosure field would remove silently inside 200 KB of generated JSON — so it is
re-checked on every publish, not assumed. Commit a refreshed corpus only on a material change
(a `fit_key` move); a genuinely weekly cadence would add ~90 MB/year to the submodule's history and
should prompt revisiting the transport rather than living with the bloat.

**The metric-definition reconciliation is DONE and lives in `packages/ml/docs/METRIC-CONTRACT.md`**
— the exact numerator/denominator/population/settle rule/exclusions for all 13 code-derived metrics,
each mapped onto core's tables, plus the band-placement rule and the five refusals. Its proof is a
GOLDEN FIXTURE emitted by the Python side through the real fitter, committed byte-identically at
`packages/ml/tests/fixtures/metric-contract-v1.json` **and** `packages/pro/test/fixtures/metric-contract-v1.json`
(a TEST fixture, so it stays out of `data/` and out of the release image). Three things from it that
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
every number and this cohort route ONLY for the click-gated metric definitions. ⚠ It is the
**SIXTH** visible-but-locked surface, taken deliberately rather than hidden inside the already-
locked `roi` branch: it is the only place in the product that answers "is this bot NORMAL?", and an
absent tab leaves that question undiscoverable. The argument is written down in
`components/ProGate.tsx`'s header beside the other five, and a seventh needs its own.

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
`BotBenchmarkPlacementResponse.rollup?: BotBenchmarkWorkspaceRollup[]` (OPTIONAL and additive —
`apiVersion` stays 21). Tests: `packages/pro/test/benchmark-rollup.test.ts` (the arithmetic, pure) and
the `cost` block of `benchmark-placement.test.ts` (the route).

**The wire, in full** (all in `packages/shared/src/types.ts`, under the
`── THE WORKSPACE ROLLUP ──` banner). Nothing here is a `ProContext` member, so nothing here moves
`apiVersion`:

| Type | What it is |
|---|---|
| `BotBenchmarkWorkspaceRollup` | THE CARD: `key` (the workspace's own automation key — **the identity AND the React key**), `vendor`/`botKind` (labels; `vendor` is `null` for every brand the corpus never saw, so it can never be the key), `reviewers[]` (an ARRAY — two logins the workspace calls one vendor are ONE card), `liveInRepos` / `reposConsidered`, `counters`, `contributions[]`, `spread`, `expectation`, `cost?` |
| `BotBenchmarkRollupContribution` | ONE EVIDENCE ROW: `repoId/repoOwner/repoName`, `mergedPrsLast14d` (ANY author), `band {activityBand, nBands, bandLabel} \| null`, `placementRefusal`, `actedOnRate \| null`, `percentile \| null`, `settledThreads`, `actedThreads`, `spanDays \| null` |
| `BotBenchmarkRollupSpread` | `{status:'value'; placed; below; at; above}` — `below+at+above === placed`, and `placed ≤ liveInRepos` — or a refusal |
| `BotBenchmarkRollupExpectation` | `{status:'value'; yoursRateOnFitted; expectedRate; fittedRepos; excludedRepos; actedAtPeer; actedPerMonthAtPeer; perActedOnUsd; conversionGapUsd; moneyRefusal}` or a refusal. ⚠ A SIBLING of `cost`, not an arm inside it — a vendor the corpus never saw renders its cost while only this refuses |
| `BotBenchmarkWorkspaceCost` | `monthlyUsd \| null`, `costModel`, `unitMonthlyUsd`, `seats`, `pricedReviewers`, `seatPriceUnresolved`, `seatCountZero`, `windowDays`, `windowUsd`, `coveredRepos`, `spanUnobservedRepos`, `partialWindowRepos`, `perMergedPr`, `unacted`, `yours`, `spanNote`. The three arms REUSE `BotBenchmarkCostUnacted`/`…Yours`/`…Refusal`, so one set of components draws both grains |
| `BotBenchmarkRollupRefusal` | `{status:'refused'; reason: BotBenchmarkRollupRefusalReason; message}` — shaped like `BotBenchmarkCostRefusal` for the same reason |
| `BotBenchmarkPlacementResponse.rollup?` | OPTIONAL and ADDITIVE. ⚠ **ABSENT ≠ EMPTY** — a missing key says the fold did not run (a narrowed request, or an older plugin), `[]` says it ran and no reviewer was live anywhere. The panel gives them two different sentences |

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

actedPerMonth   = Σ_R ( acted_r × 30.44 ÷ spanDays_r )      ← RATES ARE ADDITIVE; SPANS ARE NOT
                  ⚠ never Σacted ÷ a UNION span: January in repo A + July in repo B is a
                    seven-month union over two months of work — understates the pace threefold and
                    inflates every $/thread by the same, plausibly. A repo with no observable span
                    contributes NOTHING and is counted in `spanUnobservedRepos`, never imputed.
yours.perActedOnUsd = monthlyUsd ÷ actedPerMonth

pooledActedRate = Σ_R acted_r ÷ Σ_R settled_r               ← the card's HEADLINE rate, over R
unacted.unactedUsd = monthlyUsd × (1 − pooledActedRate)     ← what the price buys that nobody acts
                                                              on, per month

── THE ESTATE-MATCHED EXPECTATION, over C ──────────────────────────────────────────────────────
actedAtPeer          = Σ_C ( settled_r × cohortMedian_r )   ← ONE FACTOR SWAPPED, PER REPOSITORY,
                                                              BEFORE ANYTHING IS SUMMED
actedPerMonthAtPeer  = Σ_C ( settled_r × cohortMedian_r × 30.44 ÷ spanDays_r )
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
  `$/acted-on` column: `showCost = botDepth && repoId == null`, and it must NOT be simplified back to
  `botDepth`.
- ⚠ **RATES ARE ADDITIVE; SPANS ARE NOT.** `actedPerMonth = Σ_r (acted_r × 30.44 ÷ spanDays_r)`,
  never `Σ acted ÷ a union span`. A reviewer that ran in repository A in January and B in July has a
  seven-month union and was active for two — the union form understates the pace threefold, inflates
  every cost-per-thread figure by the same, and reads entirely plausible on screen. A repository with
  no observable span contributes NOTHING (never borrows a sibling's) and is counted in
  `spanUnobservedRepos`.
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
  different sentences: a MISSING key says the fold did not run (an older plugin), `[]` says it ran and
  no reviewer was live anywhere. Collapsing them with a `?? []` told a reader whose bots simply had
  not commented yet that their BUILD was deficient — the ordinary state right after somebody
  classifies a reviewer in Bots → Settings.
- **TEN MONEY REFUSALS AND FIVE COMPARISON REFUSALS — TWO VOCABULARIES, FIFTEEN SENTENCES, ALL
  PAIRWISE DISTINCT AND ALL >40 CHARACTERS.** They are separate because the money's withhold a figure
  a PRICE would fix and the rollup's withhold a comparison no price can buy.
  - `BotBenchmarkCostRefusalReason` (ten): `workspace_truncated` · `repo_window_incomplete` ·
    `no_merges_in_window` · `span_unobserved` · `own_rate_withheld` (carrying WHICH metric and WHICH
    gate) · `nothing_acted_on` · `price_is_zero` · `price_unresolved` · `cohort_rate_unfitted` ·
    `cohort_rate_zero`. ⚠ **THE GUARD ORDER IS `workspace_truncated` → repository → money → reviewer
    → span → cohort** — `cost.ts`'s own order with truncation bolted on TOP, because a partial estate
    makes the exact claim false and no other refusal in the list describes that. At estate grain the
    two REPOSITORY reasons are fatal only when EVERY live repository trips them (one partial repo is
    excluded-and-disclosed instead), and an empty pooled denominator lands on `own_rate_withheld`
    with `metricReason: 'denominator_empty'` — pooling IS the remedy `below_min_units` exists for, so
    no metric gate fires one grain up.
  - `BotBenchmarkRollupRefusalReason` (five): `single_repo` (one point is not a spread — a category
    error, not a thin sample) · `no_placed_repos` · `no_fitted_cohort_rate` (its sentence names the
    ZERO-median cause explicitly, or it would itself be a false claim) · `no_settled_threads` ·
    `vendor_not_in_corpus` (⚠ **the CARD STILL RENDERS** — its counters and its cost are the
    customer's own facts and owe the corpus nothing; only the two comparison sections refuse. Sonar,
    GHAS and `github-actions` are real multi-repo bots and none is in the seven-vendor corpus).

#### Cost on the Benchmark tab — the price per unit of work, and the counterfactual

> ⚠ **THE GRAIN IN THIS SECTION IS SUPERSEDED — READ "THE WORKSPACE ROLLUP" ABOVE FIRST.** The
> per-repository cost block described below is **no longer on the wire and no longer built on any
> request**; money moved to `BotBenchmarkWorkspaceRollup.cost`, one card per vendor. What survives
> verbatim is every RULE it establishes — null-is-not-zero, the per-seat multiply, one-factor-swapped,
> state-a-rate-never-a-history, the two money figures being different quantities, and the
> difference-of-shares bound — because `rollup.ts` IMPORTS them from `cost.ts` piecewise rather than
> restating them, and `benchmark-cost.test.ts` still pins them against `buildUnitCost`. Read the rest
> of this section for the reasoning; read the rollup section for what ships.

**What the reviewer costs per unit of the work it produces, and what better engagement with it
would be worth.** Rides the SAME placement response (no new route, no new capability, no new rate
tier — the whole tab is already `botDepth`). Files: `bots/benchmark/cost.ts` (PURE: no db, no clock,
no request) + the two columns `collect.ts` now selects. Wire: **formerly**
`BotBenchmarkPlacementUnit.cost?`, now `BotBenchmarkWorkspaceRollup.cost?`. Tests:
`packages/pro/test/benchmark-cost.test.ts` (the arithmetic and every refusal, still against
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
at peer engagement     = effectiveMonthlyUsd ÷ (settledThreads × actedOnRate(COHORT p50) × 30.44 ÷ span.days)
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
- **`per_seat` multiplies ON READ**, through the new OPTIONAL host seam
  `ProHostQueries.workspaceHumanSeatCount?` — core's own `workspaceHumanSeatCount`, the same
  multiplier `effectiveMonthlyUsd` and the ROI table use, so the Benchmark cannot quote a different
  monthly figure for the same bot than the Bots tab does. ⚠ **apiVersion STAYS 21** (the
  `getWorkPlan` precedent: optional degrades ONE reading, a required addition would need a bump
  across four literals in two repos). Absent, a per-seat price is EXCLUDED from the figure and
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

### The People report — `?evidence=1`, `person_report`, and the bot half

**It is VISIBLE-BUT-LOCKED on `periodReports`, not absent** — one of the six surfaces that reverse
this codebase's "hidden, never upsold" posture (`components/ProGate.tsx` enumerates them; the
reversal is scoped to those six and nothing else converts). Three locked panes, each with a testid
DISTINCT from its entitled body so no screenshot run can photograph a lock:

| Pane | testid | Stands in for |
|---|---|---|
| `PeopleReportDetail` | `people-report-locked` | the whole report tab |
| `PersonPeriodSection` | `person-period-locked` | the **1:1 prep** section on the contributor-activity tab |
| `PeriodReportsPanel` | `period-reports-locked` | the sibling period report |

⚠ **`PersonPeriodSection`'s lock heads "1:1 prep" and describes ONE person's vector**, not the
multi-pick report — there is no picker on that tab, and the entitled body is a single person. It
names Reports → People as the destination for the multi-pick version rather than promising it here.
⚠ **`PeriodPeopleSection` (the picker) carries a `ProBadge` but no lock**: it sits under the
already-badged pane heading. So does the by-workspace expander — that axis has no independent
surface, so a lock there would be unreachable code. ⚠ **No badge on the people-report tab CHIP in
`PinnedTabsBar`**: a strip of closable drill-downs is not a view.

⚠ **`PeopleReportDetail`'s entitlement check sits BEFORE its seed check**, deliberately: a tab
restored after a live downgrade used to render "This period is no longer listed for the current
workspace" — a disabled query is not `isLoading`, so `period` came out null and a BILLING problem
was reported as a DATA problem. ⚠ In all three, `list.data?.enabled === false` is a SEPARATE branch
that still returns null — that is a paying account whose plugin self-disabled, and the lock would
bill-nudge a customer who already paid.

**Evidence is an option on the ONE fold, never a sibling.** `getPersonPeriod(…, {evidence:
true})` (wire `?evidence=1`) widens each windowed scan from `count()` to a capped
`ORDER BY … LIMIT` over the **identical predicate**, and the two medians hand back the exact PRs
whose hours entered them through the folds' own `samplesOut` sinks (`ReviewSampleRef`) — so
nothing anywhere re-derives "which PRs did this median cover". Every guardrail (scope resolve,
lane admission, membership probe, the global-`users` rule) runs ONCE for both halves. Requesting
evidence never moves a metric cell. `PERSON_EVIDENCE_CAP` = 8 per group, with the undisplayed
remainder in `more` and "and N more" code-rendered; the shape is `PersonPeriodEvidence`
(`prs` keyed by `PersonMetricKey` → `DigestPrRef` rows, `comments` as `BotVendorComment` rows
with bodies + any stored ML label INLINE, `threads` as ONE list carrying today's `derivedState`
as a chip — never a second population — and `pathAreas` bucketed to two path segments).

- The thread cell and the thread CARDS come from ONE query (the extra columns ride the same
  rows) — that is what guarantees the number and the list describe one population.
- `commitFiles` is GLOBAL and is reached only through the tenant-scoped commit shas of the
  already-capped authored PR set, which is also what bounds the scan. `verify:isolation` grew
  166 → 169 for this arm (PR ids, comment bodies + thread excerpts, and path areas), seeded so
  BOTH tenants hold a decoy of every family — a missing predicate leaks rather than finds
  nothing — and the new checks were mutation-tested.
- ⚠ **`personPeriodKey` carries an `ev:` slot.** Without it the report's evidence-bearing
  response and the 1:1 tab's evidence-less one share a cache entry.

**`PERSON_REPORT_VERSION` (core `db/synthesis-input.ts`, now 2) is KIND-SCOPED staleness.** It
prefixes every evidence item id (`pe<v>:pr:` / `:rc:` / `:pc:` / `:th:` / `:area:`), so a bump
moves only this kind's payload hashes: every stored `person_report` row flips `stale` on the
free GET and regenerates, while no other kind is re-billed. **A `person_report` prompt edit
bumps THIS literal, never `SYNTHESIS_PROMPT_VERSION`.** ⚠ A version literal only reaches the
hash through an id that EXISTS, and two ordinary inputs carry zero evidence items — an
awaiting-only admission (every count cell a non-null zero) and a reviewer-only period (the
median sample PRs are deliberately not minted as items). A constant `pe<v>:none` sentinel line
is minted for exactly that slice; without it those rows would read `stale: false` forever and
serve the old prompt's sections at $0. The `pm…` vector items are byte-identical to the
`'person'` grain's (two kinds must not describe two vectors) — only their `authorLabel` differs
(`'brief'`, which is not hashed).

- v1 → v2 was an ATTRIBUTION fix: figure lines are labelled `'brief'` (a dashboard line is not
  something the subject wrote), and a thread root the subject authored themselves carries their
  login instead of `'reviewer'` — it already travels as their own `pe:rc:` comment item, so the
  old label handed the model the same text twice under contradictory attribution and had it
  citing their own note as feedback received. `PersonEvidenceThreadRef.selfAuthoredRoot` is the
  flag; it is optional/additive on the wire.
- The scope key: `'person_report'` joins `WINDOWLESS_KINDS` and the new `PERSON_KINDS` set
  (shared subject triple `userId`/`fromMs`/`toMs`, the required-triple 400, the whole-workspace
  rule that drops any repo narrowing, and the `u:`/`pw:` conditional tail) but is deliberately
  NOT in `ORDERING_KINDS` — it is the SECTIONS mode, and `routes.ts` branches on the kind. The
  `k:` slot is what keeps a `person`row and a `person_report` row apart for one subject+period.

**The bot sections are deterministic — NO AI.** They read the core `/api/bot-analytics` row (ONE
shared fetch per report, rows picked client-side by `u<userId>`) plus the per-bot comments
drill-down, both narrowed to the real period by the routes' `fromMs`/`toMs` pair. Paid depth stays
a "Depth →" link. ⚠ **Those routes are no longer free** — all three the bot half reads take the
UNION `botDepth || periodReports` (§ The Bots ROI panel is paid), so this report's own capability
is what admits them; "core" here names where the code lives, never the tier.

**A bot section now renders TWO vectors, and which ones appear is decided by the DATA, not by the
role.** The review half above answers "what did it flag"; the AUTHORING half — `GET
/api/bot-authoring` over `db/automation-output.ts` (core code, PAID on the union, deterministic) —
answers "what did it write", and the section fetches both for every selection. Either fold returning null hides its
own half; both null is the only real "it did nothing here" state.
- ⚠ **This closed a gap that was previously disclosed in prose.** Authoring-family automation
  (`dependency` / `code_agent` / `release` / `housekeeping`) has no review output at all, so the
  section used to say "PRs this automation authored are not charted here" — honest, but it meant
  the picker offered actors the report could not describe. It is deliberately NOT gated on the
  stored role: a code agent both writes and reviews, and choosing a half by role would be the
  login-heuristic mistake at one remove. The role only captions.
- ⚠ **It is NOT a second spelling of the person vector.** A person's numbers answer "how is this
  teammate doing"; an automation's answer "what is this thing costing us" — hence
  `prs_merged_without_human_review` (the ones nobody had to look at) and
  `human_review_comments_received` (the ones people paid for) instead of response times. Do not
  add a metric there just because `PersonPeriod` has it.
- ⚠ **`prs_closed_unmerged` keys on `mergedAt IS NULL`, never on a bare `closedAt` window** —
  GitHub stamps `closedAt` on a merge too, so the naive predicate reports every successful merge
  as abandoned churn as well. Pinned in `automation-output.test.ts`, whose fixture stamps both
  columns exactly the way GitHub does.
- ⚠ **`merge_rate_pct` is over the RESOLVED population** (merged + closed-unmerged, both
  windowed), never over `prs_opened`: a PR opened on the last day of the window has not had its
  chance yet, and dividing by it makes a busy final week look like a failing bot.
- ⚠ **`prs_merged_without_human_review` probes reviews over ALL TIME on purpose.** The population
  is PRs merged INSIDE the window and a review necessarily predates the merge, so the answer is
  fixed once the PR lands — window it and a March-reviewed, April-merged PR reads as unreviewed.
  The human test runs through `db/actor-lanes.ts`, so one bot reviewing another never counts as
  human attention.
- The evidence groups (merged / closed-unmerged / drew-human-review) are capped at
  `PERSON_EVIDENCE_CAP` like the person receipts. The first two remainders are population
  figures; the third is over what the capped comment scan SAW, which is why its caption says
  "at least".

**⚠ `getBotAnalytics` honoured an explicit `toMs` in only TWO of its folds** — the automated
thread scan, `mergedPastRows`, `getMlWindowAggregates` and `countUnlabelledBotText` were
`>= from` with no upper bound, so under a historical `toMs` ONE ROW mixed two window
populations (the period-report lesson, at the bot grain). ⚠ **And the first fix was itself
wrong:** it applied `lt(col, to)` UNCONDITIONALLY, and those columns are second-granular on
sqlite, so under the ENUM window form (`to ≡ Date.now()`) rows written in the CURRENT SECOND
were excluded — which flaked `verify:isolation` non-deterministically. The rule is:

```ts
const toBound = typeof window === 'string' ? null : to;   // explicit bounds ONLY
…and(gte(col, from), ...(toBound != null ? [lt(col, toBound)] : []))
```

The enum form therefore carries NO upper predicate at all, which also keeps every enum-form scan
byte-identical to the drill-downs reading the same rows — the identity behind "an Inflation
count equals the flagging drill-down's `filteredTotal`". Explicit bounds are half-open `lt`,
never `lte`: the routes advertise `[fromMs, toMs)` and `person-period.ts` already spells it that
way, so a boundary-ms row lands in exactly one period. The same `toBound` rule governs
`getBotVendorComments`, whose `window` parameter was widened to the same
`BotWindowKind | {kind, fromMs, toMs}` form.

**The grounded-figure check (`insights/grounded-figures.ts`) and the timestamp bypass it
closed.** D4 at the report grain: every numeral token in the period-report narrative must
match a figure in the **NARRATION PAYLOAD** — the projection the model was actually shown — or
the narrative is rejected at generation time and the templated summary is stored instead. ⚠ The
grounding base was originally the raw `PeriodReport`, which made the check BYPASSABLE two ways:
`generatedAt` is generation wall-clock (an ISO timestamp donates its
year/month/day/hour/minute/second tokens — "velocity up 37%" grounded whenever the report
happened to generate at :37), and `comparison.subsetRepoIds` are internal DB ids (each admitting
an arbitrary integer). The payload contains neither — the model cannot quote what it was never
shown — and `UNQUOTABLE_KEYS` (`generatedAt`/`model`/`subsetRepoIds`) is the belt for any
report-shaped input. Tolerance rules are enumerated exactly in the module header (sign ignored,
thousands separators stripped, the SPA formatters' roundings accepted, `fmtDuration` units for
`*_hours` keys only, payload-string numerals and array lengths allowed) — do not widen them by
guesswork; `test/grounded-figures.test.ts` pins them.

### The Bot Themes panel — revived, merged with the deterministic layer

`GET /api/pro/bot-themes` + `POST /api/pro/bot-themes/refresh` (`packages/pro/src/bot-themes/`)
are back after the P2.3/C6 retirement, over the never-dropped `bot_theme_reports` table — **no
migration**. `BotThemesPanel` replaces the `SynthesisCard` mount on the MAIN Bots view; the three
drill-down SynthesisCards (`BotVolumeDetail`, `BotFlaggingDetail`, `BotThreadsDetail`) and the
seam's `'workspace-bots'` kind are untouched and still serve slice-scoped Summarise.

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
  SYNCHRONOUSLY (no `await` between `has()` and `add()` — the legacy code awaited the credit
  check in exactly that gap, so two concurrent POSTs both passed, both missed the not-yet-written
  hash cache, and both billed), the credit check runs INSIDE the `try/finally`, and the
  min-interval is armed only when the model actually ran. The in-flight set is ACCOUNT-keyed: the
  legacy `account:workspace:window` grain let one account fan out N parallel Haiku calls by
  opening N scope/window combinations.
- **`VALID_WINDOWS` gained `rolling_90`** (added at apiVersion 18, after the legacy set was
  written). Silently degrading it to `rolling_14` cached the WRONG population under the RIGHT
  client key.
- **`repoIds` narrowing** now rides `resolveRequestScope` (membership ∩ narrow) exactly as
  `behaviour-routes` does. `themesScopeKey` stays `ws:<id>` when unnarrowed — byte-identical to
  the legacy vocabulary, so the isolation-test seeds and the migration-0014 commentary stay true
  — and gains `|r:<sorted deduped csv>` ONLY when narrowed. It keys on the narrowing AS GIVEN,
  not the intersection, so workspace-membership drift does not re-mint the row; correctness never
  rests on the key alone, since the hash folds the actual cluster set.
- ⚠ **`BotReviewCommentRow` is re-declared BY HAND in `build.ts`** (open-core boundary — the
  plugin imports no host internals). It now has TWO consumers: this copy and core's
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

### The Insights chat is multi-turn, and it runs on the REPORT model

"Ask about this period" is a real conversation: the client sends prior turns as
`SprintChatBody.history` (strings only — grounding is REBUILT fresh every turn, so what carries
forward is the transcript, not stale data), and the answer may end in a `FOLLOWUPS:` tail.

- **The depth cap is SERVER-side.** `SPRINT_CHAT_MAX_TURNS` = 10 **counting the live question**;
  the plugin reads at most `CHAT_MAX_PRIOR_TURNS` = 9 prior pairs (an inlined mirror, since the
  plugin only `import type`s from shared — the `AI_CREDITS_PER_USD` pattern; the test file, which
  CAN value-import, compares the two). Verified live: 25 turns sent → `trimmedTurns: 16` → 9
  kept. A client cap is a convenience, not the enforcement.
- **The answering model is the account's resolved REPORT model**, not the hardcoded Haiku
  `DIGEST_MODEL`: `pro_settings.report_model` → `readReportModel` → `DEFAULT_REPORT_MODEL`
  (`PRO_REPORT_MODEL`, default `claude-haiku-4-5`), through `makeReportClient`. There is
  deliberately no per-request override — a follow-up is fresh work billed at the model the
  account chose. The ledger row, the response's `model` and the stored history row all carry the
  RESOLVED id, so `costUsd` (priced from that model's `REPORT_MODEL_PRICING` row) and the ledger
  agree by construction. `CHAT_MAX_TOKENS_BY_MODEL` is a `Record<ReportModel, number>` (Haiku
  900 / Sonnet 3000) so a model added to the PRICING table is a compile error until it gets a
  row — the 750 sized for Haiku prose truncates a reasoning model mid-answer, because the model
  draws its thinking from the same allowance.
  - ⚠ **`REPORT_MODELS` and `REPORT_MODEL_PRICING` are TWO TABLES answering different questions,
    and re-welding them is a silent defect.** Pricing spans every model that has ever narrated a
    stored row — how HISTORY stays priceable and labellable; `REPORT_MODELS` is what a REQUEST may
    select today, and it is **Haiku-only**: Sonnet was retired as a choice (P4.1's "a forwarded
    retro is worth the prose tier" argument no longer held once the two were read side by side)
    while keeping its pricing row. `resolveReportModel`/`isReportModel` gate on **REPORT_MODELS**,
    so a stored `report_model` of `claude-sonnet-5` degrades to the default **without throwing** —
    that path runs on FREE GETs. `packages/pro/test/report-model-allowlist.test.ts` pins the split.
    The SPA hides the picker below two options, so the singleton removes the control by itself. **The optional CHART pass stays on the injected
  Haiku `llm`.**
- ⚠ **The chart pass gets the grounding MINUS `conversation`.** `CHART_SYSTEM`'s provenance rule
  ("use ONLY numbers present in the DATA json") makes everything in DATA a legal chart value, so
  prior model-authored answers sitting there would launder hallucinated or stale figures into
  rendered data (D4) — and re-bill the whole transcript as Haiku chart input on every charted
  turn. The current `answer` rides OUTSIDE `data` for the same reason.
- **`insights/chat-budget.ts` is a PURE module** (no ctx, no clock) because the trim rules are
  the part most likely to be subtly wrong: `estimateTokens` is chars/4;
  `chatInputBudgetTokens` = min(model context − reply allowance − `ESTIMATOR_SLACK_TOKENS`
  20 000, `PRACTICAL_INPUT_CAP_TOKENS` 60 000) — a transcript must never grow toward a million
  tokens just because Sonnet's window would hold it, since the whole thing is re-billed every
  ask; `fitChatHistory` applies the protocol cap first, then drops WHOLE OLDEST pairs until it
  fits. **The grounding is NEVER trimmed** — a payload that busts the budget alone still runs
  with zero turns and every sent pair counted in `trimmedTurns` (= sent − kept, cap drops and
  budget drops in one honest number, which the UI whispers per answer). Total, never throws,
  never reorders.
- **`splitFollowUps` is TOTAL**: only a `FOLLOWUPS:` line that is the LAST non-empty line is
  treated as the tail, and it is stripped whether or not its JSON parses (machinery must never
  render); a marker mid-answer is prose and stays. Survivors are ≤3, ≤120 chars, deduped, and
  **digit-free under the same Unicode gate as the synthesis phrases** — each candidate dropped
  individually. It runs BEFORE `resolveScopePrRefs` and BEFORE `persistChatHistory`, so PR refs
  resolve from clean text and the stored row never carries the marker. Follow-ups are never
  persisted.
- History text is fenced inside the one JSON user message exactly like the `question` it
  extends, so it adds no new trust surface; per-item it is re-capped (`MAX_QUESTION` for the
  question, `CHAT_HISTORY_ANSWER_MAX` 4000 for the answer, both surrogate-safe).

### Fix from comments — the `'comments'` AI-Fix seed (apiVersion 19)

The AI Fix tab gains a picker: the PR's comments and threads on the right, a **fix scope** basket on
the left, drag either way. Launching runs the SAME agentic worktree fixer as every other seed — one
run, one commit, the existing push/rebase flow untouched — but the prompt is a numbered list of the
chosen comments and the agent is told to **judge each comment before fixing it** and to report per
comment. The output is the usual diff + summary PLUS a per-comment verdict card, and where the agent
disagrees it writes an argued **pushback** that the user can send as a reply with one click.

**Why validity-first is the whole point.** A bot comment is not a work order. The seed's system
prompt makes the order explicit — read the real code at the anchor, decide whether the comment is
CORRECT, and only then fix — with `invalid` (wrong), `out_of_scope` (right but not this PR's job)
and `needs_human` as first-class outcomes, not failures. `valid` is stored SEPARATELY from the
disposition because the two genuinely diverge: a valid comment can be out of scope, and an invalid
one can still have been "fixed" defensively. Collapsing them would misreport the run.

**The seam** (`CodingSeam.generateFix` → optional `commentVerdicts: FixItemVerdict[]`) is the only
contract change. Core's `submit_fix` tool gained an OPTIONAL per-item array and stays ignorant of
what the items are: the PLUGIN's prompt assigns the `C1..Cn` ref labels, and
`ai-fix/comment-seed.ts` maps them back to comment rows. A plain / CI-seeded run is byte-identical
to before, which is why the field had to be optional rather than an empty array.

**`ai-fix/comment-seed.ts` owns all three halves, and they share nothing but the refs**:

- `resolveCommentTargets` — (kind, id) pairs → real rows. **Tenancy**: `review_comments` /
  `pr_comments` / `reviews` carry no `account_id`, they reach their account via `pr_id`, so every
  predicate is `prId = <the prId the route already ownership-checked>` and an id that doesn't
  resolve is **silently DROPPED** (a forged id must be inert, not an error that confirms the row
  exists somewhere else). Refs are assigned over the SURVIVORS in the client's order. Cost is
  bounded: a handful of queries regardless of target count, plus **at most ONE** GitHub call for the
  whole PR's anchor hunks — skipped entirely when no review comment is in the basket.
- `buildCommentSeedText` — the prompt block. ⚠ **The seed text was the one uncapped input in the
  whole fix prompt** (the PR body is capped at 4k and the diff at 48k, but `seed.text` was
  interpolated raw), so a bot-flooded PR dumped in wholesale would have failed the run with an
  opaque "prompt is too long" AFTER the clone. Per-comment body/hunk caps plus a whole-seed budget
  now bound it, overflow drops from the END and NAMES what it dropped, and the comments seed takes a
  smaller diff budget than the other seeds because the two now share one window.
- `mapCommentVerdicts` — the agent's self-report → the stored rows. Ref matching is trimmed and
  case-insensitive ("c3." is a ref), a fabricated ref is KEPT with `target: null` (information about
  the run, not a comment), and **a target the agent never mentioned is synthesized as
  `needs_human`** — a silently missing comment is exactly the failure the report exists to prevent.

**Storage: two nullable JSON columns on `ai_fixes`** (plugin migration `0024` + its pg twin) —
`comment_targets` written at INSERT, `comment_verdicts` on success, joined by `ref`. Both NULL on
every other seed. The targets are stored rather than re-resolved because selection is in-session and
gone by the time anyone reads the report, and because the stored list is what keeps the report
honest: it is the set the PROMPT contained, which is not the set the user ticked. The verdicts are
COMMENTARY — `filesTouched` inside one is the agent's own account, and the authoritative changeset
is still the captured git diff.

**Landmines this feature is built around:**

- ⚠ **`resolveSeedText`'s first line is `if (input.seedText) return input.seedText`** — it
  short-circuits before any seed-kind branch. A comments run that reached it carrying client text
  would prompt the agent with whatever the client sent instead of the server-resolved, capped seed.
  The comments branch is structurally unable to take that path and accepts no client seed text.
- ⚠ **`claimed.add(prId)` is reserved synchronously before the awaits**, so every new bail path —
  including "nothing resolved" — must release it. A leak wedges that PR's fixer forever on
  `already_running` with no way out short of a restart.
- ⚠ **The prompt is rendered and stored at START time**, and the run can happen later behind the
  single global slot. Comment bodies and hunks are therefore FROZEN at launch; nothing in the run
  path refreshes them, and it must stay that way.
- ⚠ **NEVER give this mode its own queue or slot.** The worktree path is keyed on the SHA alone and
  `addWorktree` deletes whatever is already there, so two runs at one head sha would remove each
  other's live tree; `applyClaudeReviewAuth` also mutates `process.env` and is only safe because
  AI-Fix concurrency is 1. Route through the existing `enqueue`/`claimed`.
- ⚠ **Every comment body and hunk in the prompt is attacker-authored** — this seed WIDENS the
  untrusted channel from title/description/diff to every comment anyone dragged in, and the fixer
  has `Bash`. The untrusted-input paragraph is the whole mitigation: keep it verbatim, fence each
  comment individually, and never interpolate comment text into a tool name, path or git argument.
- ⚠ **Bot-ness on a stored target is core's global `users.isBot`, not the UI's union rule** (isBot ∪
  the workspace's automated reviewers, manual "human" winning both directions). That set is
  module-private in core's query layer and is not on `ProHostQueries`, so the plugin does not fork
  it; on the target it is a prompt hint ("a bot's comment can be wrong"), never a gate, and the
  PICKER does the authoritative grouping client-side against the PR's OWN workspace.
- ⚠ **The picker's list is a CAPPED view.** The walk and `PR_DETAIL_QUERY` both page
  `reviewThreads/comments/reviews (first: 50)`, so "all of a PR's comments" is the first 50 per
  kind and "Move all" must not claim completeness.
- ⚠ **Thread order on the wire is HEAP order** (`getPrDetail`'s thread select has no `orderBy`, and
  it flips after any UPDATE on Postgres), so the picker imposes its own total order. `line` is NULL
  for ~90% of outdated threads and a review comment has no path/line of its own — they live on
  `review_threads`.
- ⚠ **Selection is a standalone non-persisted store keyed by prId** (`store/aiFixComments.ts`), NOT
  a `FilterDefaults` key: persistence and "Clear filters" share that one list, and a URL-serialized
  basket would let a link seed someone else's paid run. It is a store rather than component state
  because AiFixTab is lazy and its body unmounts on a tab switch.
- ⚠ **Drag is pointer-events, never HTML5 DnD** (the SPA's standing decision), and drag is never the
  only path — every card has a keyboard-reachable +/− and there is a "Move all".
- ⚠ **A pushback never posts itself.** It renders as text with an editable prefilled composer and an
  explicit Send, posting through core's existing thread-reply / PR-comment routes. A double-post is
  not undoable, so a sent pushback is replaced by a sent state rather than re-offered.

### The evidence window anchors on the ROOT comment (`t3|` → `t4|`)

The grounded `addressed` check reported **"Still open"** on a comment that had demonstrably been
fixed, and the cause was the window, not the model.

**What happened.** The base sha was taken from the thread's **LAST** comment. On DEFRA/bng-metric-
frontend#221 the fix commit `c634b2e` landed at 12:23:28 and a human reply — *"both comments have
been addressed"* — at 12:28:31. Base therefore resolved to `c634b2e`, which is also the head, so
`github/compare.ts` short-circuited `reason:'identical'` **without a network call**, `evidence.ts`
mapped that to `outcome:'untouched'`, `formatEvidenceForPrompt` rendered *"NONE — the file was not
modified between those commits"*, and `ADDRESSED_RULES` says — correctly, for what it was told —
to treat NONE as strong evidence the concern was not handled. Verdict: `not_addressed`, confidence
95. The SIBLING thread on the same file had no reply, so it got base `165696b`, returned
`addressed`, and **its stored evidence patch literally contains the fix for the thread marked
not-addressed**.

**The fix.** `addressedWindowFor` anchors the base on the thread's **ROOT** comment — the one that
RAISED the concern. That covers the general shape, not just this instance: *fix → reply → any later
unrelated commit* hid the fix just as thoroughly, which a "widen the window only when the compare
comes back empty" patch would not have caught. Under root anchoring `base === head` means something
TRUE again — nothing has landed on this file since the concern was raised — so the note text became
`no commits landed after the comment was raised` and the prompt section is headed *"Changes to
&lt;file&gt; since the comment was raised"* (`ADDRESSED_RULES` names that exact wording, so the two
move together). No new `outcome` value: the SPA's `parseEvidence` coerces anything it doesn't know
to `unavailable`, and `AddressedEvidence` is hand-duplicated across the seam with no shared type.

**Two things had to move with it.**
- ⚠ **The hash prefix, forced.** `baseSha` is already in `addressedThreadPayloadHash`, so
  re-anchoring moves every stored row's hash whether or not the prefix changes; `t3|` → `t4|` makes
  that a deliberate one-off re-bill instead of a silent one. `commits_after_last_comment` keeps
  counting from the LAST comment on purpose — it answers a different question ("did work continue
  after the conversation?") and is its own hash field.
- ⚠ **The second writer.** `resolution-check/routes.ts` writes the SAME annotation row and had its
  own copy of the window rule (`shaWindowFor(commits, headSha, lastAt)`). It now IMPORTS
  `addressedWindowFor`, exactly as it already imports `addressedThreadPayloadHash` — a window rule
  that drifts between the two surfaces puts a different `baseSha` in each one's hash, so each marks
  the other's row stale forever and re-bills paid work. One exported function is the stronger form
  of "keep these in lockstep".

Pinned by `packages/pro/test/annotations-combined-targets.test.ts` § "addressedWindowForThread",
which asserts the root-anchored window AND — so the assertion cannot go vacuous — that the old
last-comment rule really would have collapsed to `base === head` on the same corpus.

### Anchor-hunk hydration + resolved-thread verification (apiVersion 17)

Two independent reasons "Check review" kept returning a judgement with nothing useful in it. Both
were measured on the live dev DB before anything was changed.

**1. A RESOLVED thread was never asked.** `enumerateCombinedUnits` had
`th.isResolved ? null : slotOf(addressedForThread(corpus, th))`, so a resolved thread got a
`simplify` + `validity` panel and simply NOTHING where the addressed verdict belongs — visually
identical to "the run failed", "you never pressed the button" and "the model declined". **6,066 of
15,037 threads (40.3%)** are resolved. The old rationale ("nothing left to judge") had it exactly
backwards: resolving is a human CLICK, and a thread whose only reply is "done" is the case most
worth verifying.

Resolving now FLIPS the question instead of cancelling it. `ADDRESSED_RULES` branches on the
`human_marked_resolved` signal — you are verifying a claim, a reply of "done" is a CLAIM exactly
like the resolve itself, and the model is told to say plainly when the diff does not back it up —
and the UI retitles the panel **"Resolution check"** (`AnnotationPanel`'s `metaOverride`), because
a panel still labelled "Addressed check" would misdescribe what the reader is looking at.

⚠ **`isResolved` had to enter the hash** (`t2|` → `t3|`; the prefix has since moved on to **`t4|`**
for the window re-anchor — § below): the framing is an INPUT, so a thread
resolved after its verdict was stored must not keep one computed under the other question. And
⚠ **the legacy per-item `resolution-check/routes.ts` writes the SAME row**, so it learned
`isResolved` in lockstep — a field in one writer's hash and not the other's makes each surface mark
the other's row stale forever and re-bill work already paid for. (This file has taken that hit
before; see the `validityPayloadHash` docstring.)

**2. The judgements had no code at all.** `review_comments.diff_hunk` is NULL for **20,428 of
20,970 rows (97.4%)** under lean storage, and the corpus read that column directly — so
`Diff context` was an EMPTY STRING for nearly every prompt and the model correctly answered
"unclear, I can't see the surrounding code", while the SPA rendered that exact hunk directly above
the verdict from the host's hydration cache. The grounding compare (§ below) only ever attaches to
the `addressed` slot, so a thread that got no addressed slot reached the model with no code from
either channel — which is precisely the reported bug.

**The seam.** `GithubSeam.fetchReviewCommentHunks(accountId, {owner, name, prNumber, maxHunkChars?})`
→ `apps/backend/src/sync/hydrate-detail.ts` (**CORE**, like every GitHub primitive). It reuses the
EXISTING `fetchGhPrText` cache — 60s TTL, in-flight coalesced, epoch-invalidated — so a "Check
review" on a PR the SPA just opened is normally free. ⚠ **Not reliably free**: `refresh-pr.ts` busts
that cache on every walk it performs, up to ~twice a minute while a PR pane is open, so budget it as
one `PR_DETAIL_QUERY`. NEVER THROWS (`ok:false` + `reason`), and the token is resolved INSIDE
`fetchGhPrTextUncached`'s own try — unlike the compare wrapper, whose `await getAccessToken()` in the
bind arrow can reject even though `compare.ts` cannot.

**Where it runs, and both halves are load-bearing:**
- **Inside the batch loop** — past the payload-hash cache filter, the run gate, the auth pre-flight
  and the credit check. Same rule as the compare: a fully-cached click reporting `generated: 0` must
  cost zero GitHub quota. Putting it in `loadPrCorpus` would fire it on the FREE cached GET, i.e. on
  every PR open — the single worst placement available.
- **Once per RUN, not per batch** (`hunkHydrationDone`). One call covers the WHOLE PR, unlike the
  compare which is genuinely per sha-window; a 50-target run chunks into 9 combined batches, so
  without the guard that is 9 identical PR fetches.

⚠⚠ **PROMPT CONTEXT ONLY — the hunk must NEVER enter a payload hash.** `validityPayloadHash` folds
in the STORED column, and `currentHashFor` recomputes every stored row's hash on the free cached
`GET /api/pro/prs/:id/annotations` fired on every PR open — a path that hydrates nothing. Put a
hydrated value in that hash and the GET and the run compute different hashes for the same comment
FOREVER: every judgement permanently `stale`, re-billed on the next click, or the free GET forced to
call GitHub. So there is exactly ONE accessor, `hunkFor(corpus, comment)`, used at the three PROMPT
sites (`validityForThreadRoot`, `addressedForThread`, `combinedItemBody`'s shared `Diff context`
block), and `validityPayloadHash` still reads `root.diffHunk`. Pinned by
`annotations-combined-targets.test.ts` — "hydrating a hunk changes the PROMPT but leaves every
payload hash byte-identical", which also asserts the prompt really changed so it cannot go vacuous.

⚠ **The re-bill bomb.** Because the hash keeps seeing NULL, nothing re-bills today. If
`PERSIST_BODIES=true` ever becomes the default, or anything starts writing `diff_hunk` back, every
stored validity row on every PR flips stale simultaneously. `writeBackNullBodies` leaves that column
alone ON PURPOSE ("`diffHunk` stays untouched: it is lean-gated on purpose") — do not change it.

**Hydration now feeds the rate budget.** `sync/hydrate-detail.ts` imported nothing from
`github/rate-budget.ts` and discarded the `rateLimit { remaining resetAt cost }` block
`PR_DETAIL_QUERY` already pays for — so the app's hottest GitHub spender was invisible to
`gateBudget` and kept firing after `adaptive.ts` and `refresh-pr.ts` had both stood down. It now
calls `noteBudget` on success and `noteLimited` on a classified rate-limit failure, and
`fetchReviewCommentHunks` pre-empts via `isLimited` rather than deepening a known limit.

**The deterministic explanation** (why a check couldn't be made). The stored `evidence` JSON gained
an optional `anchor: {available, reason}` — a SEPARATE question from `outcome`, because the two
fail independently: `outcome` is "what changed AFTERWARDS", `anchor` is "what the comment was
POINTING AT". A verdict missing one deserves a stated caveat; missing both, it is reading a
transcript. Reasons: `file_level` · `not_in_snapshot` (the host pages `reviewThreads(first: 50)`, so
on a bot-flooded PR a thread past #50 is genuinely ABSENT rather than anchor-less) · `lean_storage` ·
`rate_limited` · `saml_sso` · `unavailable`. `anchor` is OPTIONAL on read and absent ≠ false —
every row written before this renders silence, not a claim. In the UI the collapsed Evidence row now
states the grounding outcome instead of an unconditional sha range (which read as "grounded"
whatever actually happened), and **an ungrounded verdict opens its own explanation** — the collapsed
default is right for "here is the diff I judged" and wrong for "I had nothing to judge", which was
literally the reported bug: a verdict saying it could not see the code, above a collapsed block
explaining exactly why.

### Grounded `addressed` — the two-sha compare seam (apiVersion 16)

Until this landed, the model judging "was this concern addressed?" had **never seen the change it
was judging**: it got four scalars (`outdated`, `deterministic_signal`,
`deterministic_confidence`, `commits_after_last_comment=<a COUNT>`) plus — only under
`PERSIST_BODIES`, i.e. almost never — the original ANCHOR hunk, which is the code as it was when
the comment was WRITTEN. It now also gets the REAL unified diff of the thread's file between the
commit the thread was last discussed at and the PR head.

**The seam.** `GithubSeam.fetchCompareDiff(accountId, {owner, name, baseSha, headSha, paths?,
maxPatchChars?})` → `apps/backend/src/github/compare.ts` (**CORE** — every diff primitive is, by
the standing PreparedReview policy: the plugin holds no GitHub token). One
`GET /repos/{o}/{n}/compare/{base}...{head}`, so callers coalesce by `(baseSha, headSha)` rather
than per file — GitHub has **no server-side path filter**, `paths` narrows the RESULT (matching
new AND previous name, so a renamed file is still found). It **NEVER THROWS**: `{ok:false,
reason}` for `identical` / `bad_sha` / `not_found` / `forbidden` / `rate_limited` / `error`, and a
rate-limited failure is classified through `isRateLimitError` and fed to the per-account budget.
Modelled rather than hidden: GitHub's 300-file cap (`filesTruncated` — a path's ABSENCE past it
proves nothing) and the omitted `patch` on binary/oversized files. `accountId` is passed through
`bind.ts` so the budget is charged to the right tenant. ⚠ Patches are repo-authored, i.e.
**attacker-authored** — fenced before they reach a model, never executed.

**The window is approximated LOCALLY** (the rule lives in
`annotations/targets.ts#addressedWindowFor`, over `evidence.ts`'s `shaWindowFor` primitive): base =
the newest PR commit at or before the thread's **ROOT** comment (⚠ **not its last** — see § "The
evidence window anchors on the ROOT comment" below), head = the PR's head sha; ties on
`committedAt` break on the sha, and the
corpus commit list is sorted `(time, sha)`, because the pair enters the payload hash and a window
that flipped per request would mark a fresh row stale for nothing. The exact answer is the
comment's own `originalCommit { oid }`, which would drag this into the fat sync query + a new
`review_comments` column + a core migration. ⚠ **Known drift:** after a force-push or rebase
`committedAt` no longer orders the history the reviewer saw, so the base can be a commit that was
never in that branch — the compare then 404s and the judgement degrades to "no diff evidence
available". Wrong-but-silent is not one of the outcomes.

**`t1|` → `t2|` → `t3|` → `t4|` — the payload hash.** `addressedThreadPayloadHash` (exported from
`annotations/targets.ts`) hashes `t4|threadId|isOutdated|isResolved|addressedReason|commitsSince|
baseSha|headSha|<comments>`. Three things about it:
- It is the **PAIR, never the diff TEXT**. `currentHashFor` recomputes every stored row's hash on
  the cached `GET /api/pro/prs/:id/annotations` — a free read fired on every PR open — so a hash
  that needed the patch would turn every PR open into a GitHub compare call.
- There is now **ONE copy**. Resolution-check's per-item route used to carry a hand-copied
  byte-compatible `t1|…` twin with a "do not tidy them" warning (the two surfaces write the SAME
  row; a drift makes each mark the other's row stale forever, re-billing paid work). It imports
  the shared function instead — the `validityPayloadHash` precedent.
- The prefix bump marks every EXISTING addressed row stale **exactly once**: a deliberate one-off
  re-bill on the next "Check review", in exchange for a verdict that has seen the code. Still no
  clock-derived field — a dormant PR stays $0. The `c1|…` PR-comment hash is UNCHANGED (a
  PR-level comment has no file anchor, so nothing about those rows moved).

**Where the fetch may live — the cost landmine.** It sits INSIDE the batch loop in every run
shape (`runCombinedBatch`, and `runBatch`'s `kind === 'addressed'` branch via
`groundAddressedBatch`), i.e. **after** the payload-hash cache filter, the in-flight/interval
gate, the auth pre-flight and `ctx.aiCredits.check`. A fully-cached click must stay $0 **and cost
zero GitHub quota** — fetching earlier would spend it while the response still reported
`generated: 0`. Same rule in resolution-check's per-item route: after the cache-hit
short-circuit, never in the loader (the pure-cached GET calls that loader too). One call per
distinct window carrying that window's union of paths; a failure resolves to an `unavailable`
entry the prompt states outright.

**Where the evidence goes in the prompt — the correctness landmine.** In `combinedItemBody` it is
spliced **INSIDE the `want.has('addressed')` branch**, never into the shared `Diff context` block
above it. That block is emitted for every item whatever it requested, so evidence added there
would silently change the *validity* and *simplify* judgements and inflate their input cost —
**without moving their per-kind payload hashes**, so nothing would re-bill to make it visible. The
single-kind path rebuilds the prompt through `addressedForThread(corpus, thread, evidence)` rather
than string-appending, so both shapes place it identically and the hash comes out byte-identical.
The section is worded as a first-class answer in all three states — the patch (fenced
`---BEGIN DIFF SINCE COMMENT---`), `NONE — the file was not modified between those commits`, or
`NOT AVAILABLE — <reason>` + "say the evidence is indirect" — because a MISSING section reads to
the model as "no information", the opposite of what an empty compare means. `ADDRESSED_RULES`
gained the matching instructions: judge the concern not the churn, and cite the change relied on.

**Storage + the surfaced Evidence block.** Plugin migration **`0022`** adds
`pr_comment_annotations.evidence` (nullable text; `addressed` on a `thread` target only — every
other row writes an explicit NULL) holding `encodeEvidence`'s JSON
`{v:1, baseSha, headSha, path, outcome:'changed'|'untouched'|'unavailable', patch, previousPath,
note}`. Stored rather than re-derived because the annotations GET is a pure cached read on every
PR open — re-fetching to draw the panel would be a GitHub call per open. ⚠ `upsertAnnotation`
writes `evidence: a.evidence ?? null`, never `a.evidence`: drizzle drops `undefined` keys from a
`set:`, which would leave last run's diff sitting under this run's verdict. The wire field
`CommentAnnotation.evidence` is OPTIONAL (an OSS build serves annotations that never set it; rows
predating `0022` have none). `CommentAnnotations.tsx` renders it under the verdict body as a
**collapsed** "Evidence · comparing `abc1234..def5678`" disclosure (the summary is the answer;
the raw patch is what you open when you disagree — and an open diff on every checked thread would
bury the conversation), with `parseEvidence` treating absent and unparseable identically and
rendering nothing rather than throwing (that component is mounted in eight places and the app has
no error boundary). The sha range is the point: "it compared the wrong two commits" is a
completely different bug from "it misread the diff".

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



## Bot Tuning Advisor (Pro, `botAdvisor` — added in apiVersion 15)

Turns the graded-comment corpus (thread states + ML labels + acted-on + overlap + cost) into
**evidence-backed changes to each bot's configuration**, then measures whether the change worked.
The pipeline is `Finding → Intent → Emitter → Output`, and the governing constraint is the
deterministic/templated/LLM boundary: **the recommendation itself is never model-generated**.
Plan of record: `~/limn/plans/bot-tuning-advisor.md` (2026-08-09; four product decisions recorded
there — verification loop Pro-gated, local BYOK+ambient refine ladder, DB-primary manifests with
repo export, GitHub-issue export in v1).

**Core/plugin split (the getBotAnalytics precedent, CI vs not).** CORE owns the deterministic math,
CI-tested: `getAdvisorFindings` (evidence CELLS — (bot × pathBucket) over threads, (bot × category)
over labelled findings with thread-linkage disclosed, (bot → partner) overlap, per-bot totals with
`actedOnNits` + `pathCoveragePct`; floors `ADVISOR_MIN_CELL_THREADS=5` / `ADVISOR_MIN_CELL_FINDINGS=20`
/ `ADVISOR_AMPLIFY_MIN_ACTED_PCT=70` echoed on the wire; quality checks emit rows but NO cells;
**path buckets are ADAPTIVE-DEPTH** — every thread aggregates into its depth-1 parent (`a/**`)
and its depth-2 child (`a/b/**`), emission prefers floor-meeting children and emits the coarse
parent only when NONE qualifies, so emitted globs never overlap and the retro-check glob-identity
holds at either depth (a top-level `apps/**` over a monorepo where apps/ IS the codebase was too
coarse to act on — the free tuning suggestion keeps depth-1); path cells also carry `actedOnNits`,
the QUIET_PATH_NITS retro numerator),
`getBotEffectPanel` (five weekly series over the 84-day span split before/after an anchor; volume
nulls zero-weeks per the behaviour-tab policy) and `db/changepoint.ts` (`detectChangepoints`,
median±MAD segment comparison, `MIN_BASELINE_POINTS=4`). Advisory invariant inherited and pinned:
**nothing the advisor computes feeds `botVerdict`**. The shared `botWindowMs` (db/bot-window.ts)
replaced the seven copy-pasted window ternaries; the shared acted-on predicate
(`isActedOnThreadState`) replaced the two inline copies.

**Plugin (`packages/pro/src/advisor/`).** Deterministic modules are PURE `(data) => data` — no ctx
anywhere under `findings/intents/evidence/retro-check/emitters/outputs`; ctx lives only in
`routes/store/measure/discovery/refine`. `test/advisor/llm-isolation.test.ts` walks the transitive
import graph and pins that no deterministic module can reach `refine/` (where the one LLM module
lives beside its pure diff-guard; `outputs/config-pr.ts` takes the guard as an INJECTED function for
exactly this reason). Intents: SUPPRESS_PATH / QUIET_PATH_NITS / SUPPRESS_CATEGORY /
LOWER_VERBOSITY (reuses core's ML_NIT pair semantics) / SCOPE_OFF (mirrors the overlap pair) /
AMPLIFY_PATH / ESCALATE / PROMOTE_TO_LINT (DeepSource first-backtick title templates only —
measured 1,908 titles → ~250 templates; generic rule-ID regex measured ≤8% yield, not built;
tag-shaped or >120-char first lines are rejected — DeepSource's HTML run-summary banner crossed
the fires floor as a "rule" before that guard) / BOOTSTRAP_CONFIG. **The suppression VETO
(`SUPPRESS_MAX_ACTED_HIGH = 0`):** a path/category cell containing even ONE acted-on high-severity
finding never earns a full suppress — "4 of 5 ignored" is not licence to silence the one that
mattered (the erxes `apps/**` case that motivated it). **The MERGED-PAST gate
(`SUPPRESS_MIN_MERGED_UNTOUCHED = 1`):** a suppression additionally needs ≥1 untouched thread on a
PR that has SINCE MERGED (`mergedUntouched`, on path + category cells and bot totals) — open-PR
silence is not final, a merge over the bot's open thread is; the count rides the rationale, the
evidence line, the brief and the PR body ("N shipped in PRs that merged anyway"). Measured on
erxes before building: 39% of merged PRs carry an untouched CodeRabbit thread, and both live
suppressions pass at 19/19 and 6/6. (The companion "resolved with no code change to the flagged
line" metric was measured and NOT built: commit_files covers only ~32% of erxes's merged-PR
commits and line-level diffs aren't stored, so it is honestly uncomputable today.) A vetoed path cell falls through to
**QUIET_PATH_NITS** — keep the path, stop nit-level comments there — which fires when the cell's
labelled findings are nit-dominated (`QUIET_PATH_MIN_NIT_SHARE = 0.7` over a `floors.minCellThreads`
labelled floor) and those nits are mostly ignored (`QUIET_PATH_MAX_NIT_ACTED_SHARE = 0.3`); a vetoed
cell that is NOT nit-dominated produces nothing, which is the honest outcome. CodeRabbit expresses
it as a `path_instructions` entry for the glob; Greptile degrades to instructions prose; Copilot and
the generic prose adapter carry it in the managed block.

**Adapters (emitters/).** CodeRabbit (`.coderabbit.yaml` via the eemeli `yaml` **Document** API —
comments/anchors/ordering survive; `path_filters` gains `!glob`, `path_instructions[]` entries,
`profile: chill` only when UNSET — a user-set profile degrades to prose, never overwritten),
Greptile (`greptile.json`, key-order + detected-indent-preserving JSON merge; no published schema —
hand-maintained), Copilot (`.github/copilot-instructions.md` under the **hard 4,000-char budget**
computed against existing content; over → lowest-priority slots dropped deterministically and
reported; SUPPRESS_PATH degrades to an `applyTo`-frontmatter scoped instructions file), the generic
prose adapter (managed `<!-- limn:advisor:start/end -->` block + a verbatim intents header line;
never touches a byte outside), and the T3 **manifest interpreter** (executes CONFIRMED
`advisor_bot_profiles.manifestJson` only — never a guessed schema; hand-rolled structural validator,
deliberately NOT ajv so the `removeAdditional` input-rewriting trap cannot exist). **Qodo/Sourcery
are entirely absent, not stubbed** (config surfaces unverified). `yaml` is a dependency of
`packages/pro` ONLY — never core, never the npm release.

**Storage (3 plugin tables, migration 0021, none PR-keyed).** `advisor_recommendations` (one
DECIDED row per (account, workspace, dedupeKey='intent|bot|target|window'); findings stay query
results — a row exists only once the user acts; every onConflictDoUpdate targets exactly the
3-column unique), `advisor_bot_profiles` (the one-bot-object rule: T1 answers + T3 manifest in ONE
row, SEPARATE narrowed `set:` objects per writer — the persist() landmine; **named composite FK
`advisor_bot_profiles_workspace_account_fk` in the migration SQL only** — drizzle can't declare an
FK onto a core table across the open-core boundary; ON DELETE CASCADE because core's
`deleteWorkspace` can't re-home plugin rows), `advisor_config_events` (append-only anchor log —
`user_reported` anchors measure changes Limn never authored; `pr_opened`→`pr_merged` promotion is
compute-on-read off the synced PR row, writing the `advisor_pr` anchor at mergedAt). All three in
`eraseProByAccountId` + isolation-test seeds; deliberately NOT in `pruneProByPrIds`.

**Outputs.** Brief (T5, the universal fallback — deterministic markdown, also the issue body;
client defaults to it until a `pr_merged` row exists in the workspace), config PR (gate chain:
retro-check computable → parse → plan → serialize → validate → **additive assert** (deep containment
for yaml/json, outside-markers equality for prose) → `commitFilesAndOpenPr`), GitHub issue (to the
profile's user-supplied `ownerRepo`). **`POST …/preview` is the config-PR dry-run** — same body,
same derivation, the full gate chain, but it stops before the seam call and returns the exact
files the PR would commit (`before`/`after` + the plan's applied/degraded/unsupported items), so
the generated YAML/JSON/prose is visible before consent; no write permission required, tier
`pr_detail` (it fetches the config files, writes nothing). The **mandatory retro-check** ("this
filter would also have hidden N acted-on, M high-severity") is computable for
SUPPRESS_PATH/SUPPRESS_CATEGORY (cell identity — our emitted globs ARE the cell's aggregated
prefix, at either depth) and LOWER_VERBOSITY/QUIET_PATH_NITS (`actedOnNits`, bot-level and
per-path respectively — the nit-scoped simulation covers only the ML-labelled threads, disclosed);
SCOPE_OFF is honestly **uncomputable → config-PR blocked, brief allowed**. Path coverage (only
`review_comment`-kind labels can carry a path — 41% corpus-wide in the dev DB) is disclosed on
every evidence object and rendered in brief + PR body.

**Refine (the ONE LLM touchpoint).** `POST …/refine`, prose targets only — structured formats have
no LLM code path at all. Cloud: credit gate + `SUMMARY_ANTHROPIC_API_KEY` + `recordAiUsage(seam:
'summary', feature:'advisor_refine')` (the bot-themes pattern). Local: `cheapComplete`'s new
`credential:'local-review-key'` — core resolves the BYO key itself (it never crosses the plugin
boundary) and falls through to the ambient agent-SDK session ($0 ⇒ unmetered by existing design).
Output re-passes the **deterministic diff-guard** (markers intact, intents header verbatim, char
budget, no fences) — and so does any client-supplied `refinedByPath` at config-PR time; rejected ⇒
the templated version ships, never an error.

**Core seams (added in apiVersion 15).** `readRepoFile`/`listRepoDir` (status-returning, `?ref=`,
repo-authored bytes size-capped, never executed), `openIssue` (`createIssue` REST — issues aren't
synced; the URL is stored on the row), `commitFilesAndOpenPr` (`coding/git-ops.ts`:
default-branch worktree → literal file writes (traversal + `.git/` guarded) → commit → **NEW branch,
never force** (existing ⇒ `BRANCH_EXISTS` → 409) → `createPullRequest` → `syncOnePr` tail with a
confirming SELECT; **refuses `.github/workflows/*` outright** — no `workflow` OAuth scope — and the
route re-refuses it, two layers on purpose; after the 201 nothing throws — `visible:false` copy says
"shortly", never a retry). ⚠ The cloud runtime image (`node:22-bookworm-slim`) did NOT ship `git` —
the Dockerfile now installs it (this also un-broke AI Fix's cloud push path, latently dead before).

**Discovery.** T1 ask-once profile card (row presence is the suppressor). T2: workflow-file scan
(count/byte-capped string scan for known bot actions + config args — attacker-authored, never
executed) + `users.appSlug`, which `sync/app-attribution.ts` now PERSISTS instead of discarding
(fill-or-update, never cleared by an app-less comment; the probe itself still has no sync-loop
caller — deep-detect wiring remains future work). T3: structural-tells proposer
(`discovery/tier3.ts` — glob-shaped arrays under ignore/exclude/skip/filter keys, severity-shaped
scalars) → single confirm → `manifestJson`; the repo export `.limn/bot-adapter.yml` publishes via
`manifest-pr`, and on discovery reads the repo copy wins.

**Frontend.** Fifth `botsInnerTab` member `'advisor'` (transient, derived `effectiveTab`, 'pro'
badge, cross-repo rail only — workspace grain, like Themes). **The entry point is the Bots table's
per-row Tune/Drop pills** (Pro-gated, hidden-not-upsold): `focusAdvisor(botKey, intent)` sets the
focus AND switches the tab in one store action; 'drop' renders the drop-case banner (the bot's ROI
numbers + the brief as the deliverable). `BotAdvisorPanel`: intents grouped per bot with evidence /
retro / status chips (dismissed / PR open / PR merged / issue filed), per-intent checkboxes, output
selector (Brief default until first merged PR; selecting Brief renders it immediately — it is a
free DB read), repo picker + **Preview changes** (the `…/preview` dry-run rendered as per-file
generated content + plan-item chips; the result resets when the selection or repo changes so a
stale preview never sits under new checkboxes), effect panel + T1 profile expanders. Hooks in `useAdvisor.ts` — keys carry `ws:<id>` + skipToken; the config-PR and
refine mutations share mutationKeys across mounts (the CiAnalysisCard double-bill lesson). The free
amber `TuningSuggestions` box stays rendered.

**Rate limits.** The `/api/pro/advisor/` block sits ABOVE the `/api/pro/` AI catch-all in `tierFor`
(else every DB-only advisor POST would ride the 20/min AI bucket): config-pr / manifest-pr / issue →
`github_write`; refine → `ai`; findings → `search`; discovery + preview → `pr_detail`; everything
else `read`. Pinned in `rate-limit.test.ts`. (The dry-run route is named `preview`, not
`config-preview`, so no `endsWith('/config-pr')`-style match can ever prefix-collide with it.)

**Known v1 limits** (deliberate): retro-check prefix-matches only OUR emitted prefix globs
(`a/**` / `a/b/**`, whichever depth the cell aggregated; user-authored globs in existing configs
are out of scope, disclosed); CodeRabbit validation is
structural + round-trip fixtures, not the vendored-JSON-schema/ajv pass the plan sketched (our edits
are additive into the USER'S file, whose validity is not ours to adjudicate — revisit if a real
config PR is ever rejected by CodeRabbit's validator); the CodeRabbit assisted-bootstrap
(`@coderabbitai configuration` comment → parse the synced reply) is not built; cloud per-account BYO
Anthropic keys are a designed seam (`credential:'account-key'`), not built; Greptile's `.greptile/`
directory layout is unverified against their docs (single `greptile.json` served first).

---

## The work plan — "what should I work on today"

> **THE CODE RANKS, FREE. THE MODEL NARRATES, PAID.**

**There is no "Plan for today" panel any more.** It was a Pro-only card under the daily-brief strip
rendering a ranked worklist that was, by its own alignment contract, the SAME POPULATION as the
attention board two rail clicks away — one population on two surfaces, one of them behind a
paywall. It has been folded into the **Pending** board:

- the two signals the cards never carried (`merge`, `update_branch`) are now real `InsightKind`s
  emitted by `getWorkspaceInsights`, so **all seven** WorkPlanKinds fold off cards;
- core `GET /api/attention` returns **`doNextIds`** — the ranked head as CARD ids — **free on every
  tier**, and the board renders ONE list partitioned head / divider / tail;
- the `workPlan` capability now gates **the sentences only**: a headline, one `why` per head row,
  and `parked` on the divider. A free or OSS account gets the entire ordered board with no prose.

⚠ **HEAD ∪ TAIL === CARDS, DISJOINT.** The head is a RE-ORDERING, never a filter. Every cap
disclosure on that board gates on `shown === count`, so an "improvement" that filtered `cards` down
to the head — or dropped a tail row because its PR is already in the head — would make "50 of 148"
vanish with no error, on exactly the workspaces where the cap matters. A tail row whose PR is
seated in the head is MARKED ("already in Do next"), never removed.

⚠ **THE HEAD IS SUPPRESSED UNDER AN ISOLATION, NOT UNDER A RELEVANCE LENS.** An isolated board is
single-kind, so there is no cross-kind ordering question and `capWithKindCoverage` is meaningless;
a relevance-lensed board is still multi-kind (`passesRelevanceLens` narrows `my_turn` and nothing
else), so the head is a legitimate re-ordering there. Consequence, stated rather than discovered:
every daily-brief line and `openMyTurnInWorkspace` seat an isolation as well as a lens, so the head
is dark on every notification entry point. That is the ruling, not an oversight.

⚠ **THE TWO FORWARD KINDS INHERIT TWO NARROWINGS** the old standalone query did not have: the card
fold's **90-day ultra-stale gate** and its **15-per-kind cap**. A long-dormant-but-mergeable PR no
longer appears — which is the point, since a ranked row with no card behind it breaks the partition.

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

`score = 0.50·proximity + 0.30·stallRisk + 0.20·relevanceWeight`, sorted descending with a **total**
tie-break chain, so two ticks over unchanged data produce byte-identical order — a panel people read
top-down may not reshuffle between polls.

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

Storage is `pro_work_plans`, unique `(accountId, scopeKey)`, `output` TEXT in both dialects, in
`eraseProByAccountId` and deliberately **not** in `pruneProByPrIds` (no `pr_id` grain).

The cost gates copy the synthesis seam exactly: a synchronous in-flight claim (no `await` between
`has()` and `add()`), the credit check **inside** the `try/finally`, a min-interval armed only on
billed runs, `recordAiUsage` best-effort before the parse can fail, and a stored **empty sentinel**
so an unparseable answer cannot loop-bill.

⚠ **The POST folds the evidence BEFORE the throttle checks** — a deliberate divergence from
synthesis. `WorkPlanResponse.evidence` is "always present when enabled" (the deterministic worklist
renders whatever happens to the narration), so a throttled reply that dropped it would hand the
panel nothing. The cost is bounded by this route's own `ai` bucket, which is tighter than the free
GET's `search` bucket running the identical fold.

⚠ `ctx.queries.getWorkPlan` is **optional** on `ProHostQueries` — called `?.()`, absent ⇒
`{enabled: false}`. A required new member is the one case that forces an `apiVersion` bump; optional
keeps it at 21 and degrades to this one feature going dark against an older host.
