# Pierre Pro — Inbox Tab, Per-Repo Digest & Review Memory: Design & Implementation Plan

> ⚠️ **HISTORICAL DESIGN DOC — the plan, not the shipped state.** This is the original
> open-core design (2026-06-29) and it has been **built and evolved substantially** since.
> For the current architecture, **CLAUDE.md is authoritative** (see "Open-core Pro plugin").
> Notable drift to keep in mind while reading: the **contract `apiVersion` is now 11** (not 1);
> the "Inbox" tab shipped as the **Activity** console; and **My Turn / "FYI" feed participation
> is CORE / free on every tier** (`feed/my-turn.ts`) — it is **not** a Pro capability (an
> earlier iteration gated it behind a `feedMyTurn` cap + `registerFyiProvider` seam; both were
> removed). The current Pro capability set is `activityDigest, reviewMemory, aiAnalysis,
> prSummary, aiFix, teamInsights, claudeReview, slackDigest, issueLinks`.

**Prepared:** 2026-06-29
**Source:** 12-agent design workflow (Understand → Design → Synthesize; Inbox UX explored 3 ways and judged).
**Status:** Plan / design — no code written yet. Respects the project's load-bearing conventions (dual-dialect schema, accountId isolation, ESM .js, shared types-only, packaging guards, no premium capability in the public repo).
**Companion doc:** `~/pierre-review-ai-strategy.md` (the strategy + market research this builds on).

> The plan itself recommends living at `docs/PRO-PLATFORM.md` in the repo (it documents *seams*, not premium logic). It's saved here in the home directory to match the prior deliverables; move it into the repo if you prefer.

---

# Pierre Review — Open-Core Pro Plugin, Inbox Tab & Review Memory: Implementation Plan

> Design doc. Three workstreams merged into one sequenced build plan. UI/UX is paramount. Every binding point, file path, function name and column is grounded in the seam maps. An engineer can start executing from Phase 1 immediately.

---

## 1. Reconciliation of decisions

These are the load-bearing resolutions that shape everything below.

- **The Inbox tab is always-on OSS core. It is NOT feature-flagged.** It ships in the public repo, is a peer of Timeline, and is built **entirely on the existing query layer with NO AI**. It reuses `getInsights` / `getRepoAnalytics` / `getOpenPrs` / `getMergers` / `getTimeline` plus one new account-scoped aggregator (`getInbox`). Duplicating some Feed / My Turn functionality is explicitly accepted.
- **The ONLY Pro/flagged surface inside Inbox is the per-repo LLM "headlines digest" banner.** Everything else on a repo card (stats, thread-state breakdown, PRs-by-author, prior Claude reviews) is AI-free core and renders identically with or without Pro. Absent Pro → the banner is simply not rendered (no greyed stub, no layout shift, no upsell inside cards).
- **`@pierre/pro` is a separate PRIVATE package, dynamically imported at runtime.** It is **never** a declared dependency in the published `package.json`. If absent → `await import('@pierre/pro').catch(...)` returns null → clean OSS mode, zero install failure. The public codebase contains only the *seam* (a contract, a guarded import, a capability passthrough) — **no premium backend capability and no premium dependency**.
- **Premium capability flows to the frontend exactly like `claudeReviewEnabled` does today** — through `/api/me`, as a `pro` capability map mirrored from a backend singleton the plugin populates at boot.
- **Repo-oriented Claude-review history needs RETRIEVAL, not new storage.** `claudeReviews` already persists every run keyed `(prId, headSha)` with a direct `accountId` column and a joinable `repoId` via `pullRequests`. We add `listClaudeReviewsByRepo(repoId, accountId)` — no schema change for history.
- **Only Workstream 3 (review learnings/memory) needs net-new storage**, and that storage is **plugin-owned** (lives in `@pierre/pro`), so the public schema and the core `schema-parity.test.ts` stay untouched.

### Decisions — status (locked 2026-06-29 unless noted)

1. ✅ **LOCKED — Base Claude Review stays core-but-flagged and is EXTENDED by `@pierre/pro`.** Base Claude Review remains in core behind `config.claudeReviewEnabled` exactly as today; `@pierre/pro` only adds the learnings capture/retrieval/injection + two UI data surfaces.
2. 🔵 **Default (minor) — doc lives at `docs/PRO-PLATFORM.md` in the repo** (documents *seams*, not premium logic), discoverable next to `docs/SYNC.md`. Currently also kept at `~/pierre-pro-inbox-and-learnings-plan.md` to match prior deliverables; copy into the repo when execution starts.
3. 🔵 **Default — Inbox ships ADDITIVE; do NOT remove Feed / My Turn in this plan.** Revisit deprecating the standalone Feed panel only after Inbox proves out.
4. ✅ **LOCKED — Pro React surfaces render in CORE behind the capability flag** (matches `claudeReviewEnabled`; SPA build stays trivial). Premium *data/logic* stays server-side in `@pierre/pro`. A `<ProSlot>` registry remains a localized future swap if ever wanted.
5. 🔵 **Default — add `config.proEnabled = !isCloud` master gate** (Pro is local-only for now). `bind.ts` skips the import entirely when `!proEnabled`; the plugin self-gates on `ctx.host.isCloud` as defense-in-depth.
6. ✅ **LOCKED — `@pierre/pro` is a git submodule at `packages/pro/`** added to `pnpm-workspace.yaml`. Public CI clones without it → exercises the OSS-degradation path on every push.

*(Items 2, 3, 5 are low-stakes defaults — flag if you want any changed; otherwise execution proceeds on them as written.)*

---

## 2. Open-core plugin architecture (`@pierre/pro`)

### 2.1 The contract (OSS core, `apps/backend/src/pro/contract.ts` — NEW)

`packages/shared` is types-only and cannot hold a runtime registry, so the contract lives in backend core. It defines the `ProPlugin` interface, the `ProContext` the host hands in, the `ProCapabilities` advertised back, and the live singleton.

```ts
// apps/backend/src/pro/contract.ts  (no dependency on @pierre/pro)
import type { FastifyInstance, FastifyRequest, FastifyBaseLogger } from 'fastify';

export interface ProCapabilities {
  inboxDigest: boolean;   // WS2 per-repo LLM headlines digest
  reviewMemory: boolean;  // WS3 Claude Review learnings
}

export interface ProHostQueries {       // curated, stable slice of the read layer
  getInsights(accountId: number, repoIds: number[] | null): Promise<unknown>;
  getRepoAnalytics(accountId: number, repoId: number): Promise<unknown>;
  getOpenPrs(args: { accountId: number; repoIds?: number[] | null }): Promise<unknown>;
  getInbox(accountId: number, repoIds?: number[]): Promise<unknown>;   // WS2 aggregate
}

export interface ProContext {
  log: FastifyBaseLogger;
  host: { version: string; deploymentMode: 'local' | 'cloud'; isCloud: boolean };
  accountIdOf(req: FastifyRequest): number;                  // the single scoping seam
  db: import('../db/client.js').Db;                          // node-postgres-TYPED → stray .get() is a compile error
  schema: typeof import('../db/client.js').schema;
  runTransaction: typeof import('../db/client.js').runTransaction;
  isPg: boolean;
  registerMigrations(dir: string, dirPg: string): Promise<void>;  // plugin-owned dual-dialect migrator hook
  llm: { complete(opts: { model?: string; system?: string; prompt: string; maxTokens?: number; })
           : Promise<{ text: string; usage?: { inputTokens: number; outputTokens: number } }> };
  queries: ProHostQueries;
  reviewEvents: import('../review/events.js').ReviewEventBus;       // WS3 capture seam
  registerLearningsProvider(p: LearningsProvider): void;           // WS3 injection seam
}

export interface LearningsProvider {
  buildContext(a: { accountId: number; prId: number; headSha: string }): Promise<string | undefined>;
}

export interface ProPlugin {
  apiVersion: 1;                                              // contract handshake; host warns on mismatch
  register(app: FastifyInstance, ctx: ProContext): Promise<ProCapabilities>;
}

const EMPTY: ProCapabilities = { inboxDigest: false, reviewMemory: false };
let active = EMPTY;
export function setProCapabilities(c: ProCapabilities): void { active = c; }
export function getProCapabilities(): ProCapabilities { return active; }
```

**Why this shape:** `register` *returns* the capabilities (the plugin is the authority on what it actually wired). The plugin imports **no host internals** — `db`, `schema`, `runTransaction`, `accountIdOf`, `llm`, `queries`, `reviewEvents` all arrive via `ctx`, so the boundary is one typed, versionable surface and the host can refactor freely. The node-postgres typing on `ctx.db` means a stray `.get()/.all()/.run()` is a compile error in the plugin too.

### 2.2 The boot binding (`apps/backend/src/index.ts` + `apps/backend/src/pro/bind.ts` — NEW)

The seam is the window in `index.ts` between `const app = await buildApp()` (L32) and `await app.listen()` (L53) — `app` exists, routes can still register, `config` is fully resolved. The scheduler block (L44–51) is the exact "optional subsystem in try/catch that warns + no-ops" precedent. Insert after the Claude-review reconcile (after L41):

```ts
// apps/backend/src/index.ts — after L41
{ const { bindProPlugin } = await import('./pro/bind.js'); await bindProPlugin(app); }
```

```ts
// apps/backend/src/pro/bind.ts
export async function bindProPlugin(app: FastifyInstance): Promise<void> {
  if (!config.proEnabled) return;                            // master gate (Decision 5)
  const mod = await import('@pierre/pro' as string).catch((err) => {  // 'as string' stops tsc/bundler resolving it
    if ((err as { code?: string })?.code === 'ERR_MODULE_NOT_FOUND')
      app.log.debug('pro plugin not installed — OSS mode');
    else app.log.warn({ err }, 'pro plugin present but failed to load — OSS mode');
    return null;
  });
  if (!mod) return;
  const plugin = (mod.default ?? mod) as ProPlugin;
  if (plugin?.apiVersion !== 1 || !plugin.register) {
    app.log.warn({ apiVersion: plugin?.apiVersion }, 'pro contract mismatch — skipped'); return;
  }
  const ctx: ProContext = { log: app.log,
    host: { version: HOST_VERSION, deploymentMode: config.deploymentMode, isCloud: config.isCloud },
    accountIdOf, db, schema, runTransaction, isPg,
    registerMigrations: (dir, dirPg) => runPluginMigrations(dir, dirPg, isPg),
    llm: { complete: cheapComplete },                        // review/llm.ts Haiku seam
    queries: { getInsights, getRepoAnalytics, getOpenPrs, getInbox },
    reviewEvents, registerLearningsProvider };
  try { setProCapabilities(await plugin.register(app, ctx)); app.log.info('pro plugin active'); }
  catch (err) { app.log.warn({ err }, 'pro register() failed — OSS mode'); }
}
```

Plugin routes call `app.get('/api/pro/...', ...)` on the **same** instance; because `registerAccountContext(app)` already ran inside `buildApp()`, `ctx.accountIdOf(req)` works for plugin routes for free, and the cloud auth gate already 401s `/api/pro/*`.

### 2.3 Capability flag through `/api/me`

```ts
// packages/shared/src/types.ts — extend MeResponse (type-only, additive)
export interface ProCapabilities { inboxDigest: boolean; reviewMemory: boolean; }
export interface MeResponse {
  user: LocalUser | null; counts: MyTurnCounts;
  claudeReviewEnabled: boolean; deploymentMode: 'local' | 'cloud';
  pro: ProCapabilities;                                      // NEW — all-false in OSS mode
}
```

```ts
// apps/backend/src/api/routes/me.ts — one line into the return (alongside L42–43)
pro: getProCapabilities(),
```

```ts
// apps/frontend/src/hooks/useMe.ts — selector mirroring claudeReviewEnabled
export function useProCapabilities() {
  return useMe().data?.pro ?? { inboxDigest: false, reviewMemory: false };
}
```

The Inbox tab itself never reads this flag; only its digest sub-panel checks `pro.inboxDigest`, and the review-memory surfaces check `pro.reviewMemory`.

### 2.4 Private package structure

```
packages/pro/  (private submodule; name "@pierre/pro", "type":"module", private:true, NodeNext)
├─ src/index.ts                 default export ProPlugin (self-gates on ctx.host.isCloud)
├─ src/contract-types.ts        hand-copied import type-only mirror of core contract.ts
├─ src/llm/seam.ts              LlmClient interface + AnthropicHaikuClient (uses ctx.llm)
├─ src/inbox-digest/            routes.ts, metrics.ts (RepoDigestPayload assembler), prompt.ts
├─ src/review-memory/           routes.ts, capture.ts (subscribers), retrieval.ts, schema.sqlite.ts + schema.pg.ts
├─ migrations/  + migrations-pg/   plugin-owned, run via ctx.registerMigrations
└─ test/isolation.test.ts       plugin's OWN verify:isolation-style cross-account test
```

`fastify` is a **peerDependency** (one instance, provided by the host). `@pierre-review/shared` is a devDependency, `import type` only. The plugin reaches DB/queries/LLM **only via `ctx`** — never `import { db } from '@pierre-review/backend/dist/...'`.

### 2.5 Install now vs token-gated later

- **Now (dev):** git submodule at `packages/pro/`, listed in `pnpm-workspace.yaml`. Public CI clones **without** the submodule (opt-in; no token → absent) → `pnpm install` succeeds, `pnpm typecheck` is green, and the dynamic-import `.catch` path is exercised on every push. Your machine inits the submodule with a token → `pnpm install` symlinks it into `node_modules/@pierre/pro` → the runtime import resolves.
- **Later (distribution):** publish `@pierre/pro` to a private scoped registry (`@pierre:registry=...` + token in `.npmrc`); customers `pnpm add @pierre/pro` into their own install. The boot seam (`await import('@pierre/pro')`) is identical regardless of how it landed on disk.
- **Invariant:** the public `package.json` / lockfile / `scripts/build-release.mjs` curated allowlist **never reference it.**

---

## 3. Inbox tab (CORE, always-on, no AI) — "Triage Console with a Briefing Feed"

A master–detail view: a fixed **left rail** of repos (the cross-repo glance) + a scrollable **right detail** that defaults to an all-repos briefing feed and narrows to a single-repo console on selection. One `RepoSection` renderer at two densities.

### 3.1 Desktop layout — default ("All repos" selected, first-open)

```
┌─ HEADER (App.tsx) ──────────────────────────────────────────────────────────────────┐
│ Pierre Review   [ Timeline | ●Inbox ]   <Feed> <Counts>   🔍  ⟳sync  Insights  ⚡Reviews│
├─ FilterBar (REUSED: add-repo, Repos▾, Members▾, range; categories/states hidden) ─────┤
│┌─ LEFT RAIL (w-72) ───────────────────┐┌─ RIGHT DETAIL (flex-1, overflow-auto) ───────┐│
││ STATE OF PLAY     ↻ Refresh · 2m ago ││ All watched repos · 6 repos · 41 open · 7 stall││
││ ▌▸ ALL REPOS         ● ████▏ 41  ◀──┐ ││ [ Sort: Attention ▾ ]  [ ☐ Hide quiet repos ] ││
││  ▌acme/api    🛡 ● ████▏▏ ⚠5 [12]   │ ││ ╔══ acme/api ═══════════════ tint-0 ═══ ▾ ══╗ ││
││   acme/web    🛡 ● ██▏▏▏▏ ⚠1 [6]    │ ││ ║ 🛡 12 open·3 draft·9 merged7d·2 ⏱          ║ ││
││   big/mono       ● ███▏▏▏ ⚠3 [7]    │ ││ ║ TTFR 5h · oldest unreviewed 3d            ║ ││
││   acme/infra     █▏▏▏▏▏    · [1]     │ ││ ║ Threads ▕███▍██▎█▏ ●9 ●4 ●6 ●22           ║ ││
││   acme/cli       ██▏▏▏▏   ⚠1 [4]    │ ││ ║ ┌ ✨ HEADLINES · Pro ──────── Haiku·2m ─┐ ║ ││
││ ── legend ────────────────────────── │ ││ ║ │ Auth refactor + 2 hotfixes from @maya;│ ║ ││
││ █untouched █replied █likely █resolved │ ││ ║ │ 9 untouched threads in src/auth/**    │ ║ ││
│└──────────────────────────────────────┘│ ║ └──────────────────────── regenerate ↻ ┘ ║ ││
│                                         │ ║ ▾ Maya Chen 🛡 3 PRs · 1 ⏱                 ║ ││
│                                         │ ║   ●#412 Rework token refresh ⚠1 ⏱ 🧵2·1·0·3 ⚡2▸║
│                                         │ ║   ●#409 Fix 500 on /sync ✓approved ⚡1▸    ║ ││
│                                         │ ║ ▸ Leo M 2 PRs  ▸ dependabot[bot] 4 PRs    ║ ││
│                                         │ ╚════════════════════════════════════════════╝ ││
│                                         │ ╔══ acme/web ════ tint-1 ════════════ ▸ ══╗   ││
│                                         └──────────────────────────────────────────────┘│
└───────────────────────────────────────────────────────────────────────────────────────┘
```

**Rail row anatomy:** `▌` sky-pulse selection bar (`ev-select-pulse` vocabulary) · `owner/name` · `🛡` `MaintainerShield` (from `useMergers`) · `●` unread dot (any PR `newSinceLastViewed != null`) · 4-segment thread mini-bar (`DERIVED_STATE_META` colors, repo total) · `⚠n` attention badge (PRs with a my-turn reason | stalled | untouched>0) · `[n]` open count (`[—]` = quiet). A pinned **ALL REPOS** pseudo-row aggregates the same. Rail sort: attention desc → unread → alphabetical, computed once per load (stable, not jumpy).

### 3.2 Single repo selected (drill-down console) — strict narrative order

Client-side narrow, no refetch. Same `RepoSection`, expanded density, order: **Digest (Pro) → Stats → Thread State → PRs-by-author → Claude Reviews**.

```
┌─ RIGHT DETAIL ──────────────────────────────────────────────────────────────┐
│ acme/api                                          🛡 4 maintainers            │
│ ┌ ✨ DIGEST · Pro ───────────────────────────────── Haiku · 2m  ↻ regen ─┐    │ ← Pro only; absent → omitted
│ │ ▸ 4 PRs touching auth/* — @maya & @dee shipping the OAuth refactor.    │    │
│ │ ▸ 3 unresolved threads on db/migrations, all on @priya's #4120.        │    │
│ │ ▸ Throughput up: 6 merged vs 2 last week.                              │    │
│ └────────────────────────────────────────────────────────────────────────┘    │
│ STATS  Open 12  Draft 3  Merged7d 9  Stalled 2 · TTFR 5h · oldest unrev 3d    │
│ THREAD STATE  ▕████████▌▌▌▌░░░░▏ 41  ●9 untouched ●4 replied ●6 likely ●22 res │ ← click segment → soft-filters PRs
│ PRs BY AUTHOR                                                                  │
│  ▾ Maya Chen 🛡 (3)                                                            │
│    ●#412 Rework token refresh   ⚠1 ⏱  🧵2·1·0·3  ⚡2 ▸                          │
│       └▾ ⚡ 2 Claude reviews                                                   │
│          • 4f1c2 REQUEST_CHANGES · 3 findings · posted 2d · $0.04 [Open ▸]    │
│          • 88de0 COMMENT · 1 finding · not posted · 4d           [Open ▸]    │
│    ●#409 Fix 500 on /sync       ✓approved  🧵0·0·0·5  ⚡1 ▸                     │
│  ▸ Leo M (2)    ▸ dependabot[bot] (4)                                         │
│ CLAUDE REVIEWS · this repo ──────────────────────────────── 9 runs / 6 PRs ─ │
│  #412 REQUEST_CHANGES · 2d · Maya [▸]    #409 APPROVE · 5d · posted ✓ [▸]     │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Glyph vocabulary is 100% reused from `lib/ui.ts`** (zero new vocabulary): `●`/`◐` `PR_STATE_META`; `✓n`/`⚠n` reviewers; `✗CI`/`✓CI` `CI_META`; `⏱` stalled `REASON_META`; `🧵 a·b·c·d` = `untouched·replied_unresolved·likely_addressed·resolved` from `DERIVED_STATE_META`; `⚡n` prior Claude runs tinted by latest verdict; `🛡` `MaintainerShield`. **Note the canonical thread-state name is `replied_unresolved`** (the task's "unresolved"); the UI labels it "Replied (unresolved)".

**Responsiveness:** below ~900px the rail collapses to a horizontal-scroll chip strip pinned top (name + mini-bar + attention badge); below ~600px digest/charts stack full-width and author groups start collapsed.

### 3.3 Interaction & refresh model

- **First open:** `useInbox` fires once with `staleTime: Infinity`, `refetchOnMount: false` (mirrors IndexedDB-cached PR/thread queries — snapshot intent). Auto-selects ALL REPOS. Repo names paint instantly from `useRepos`; only badges/mini-bars/feed skeleton.
- **Refresh:** lives in the rail header (`STATE OF PLAY ↻ Refresh · 2m ago`) because it re-pulls the whole multi-repo aggregate. Click → `invalidateQueries(['inbox', accountId, repoIds])`. Keep last data dimmed to ~60% with a top progress hairline, then cross-fade — **never blank** (the "modal covers timeline" lesson). Refresh re-queries the **DB read layer only**; it does NOT trigger a GitHub sync. Copy is "Refresh", not "Sync".
- **Staleness:** `generatedAt` → `relativeTime()` ticking on a 30s timer (no fetch); past ~10m turns amber. Per-repo `lastIncrementalSyncAt` shows a `⟳` chip; a background sync since → "new activity synced — refresh".
- **Selecting repo / thread-segment filter / expand-collapse:** all client-side, no refetch. Expansion/sort/hide-quiet persisted to `localStorage['pierre:inboxExpanded']` / `['pierre:inboxPrefs']`, re-asserted after refresh.
- **Clicking a PR row never leaves Inbox** — `usePinnedTabs.pin(prId)` + `setActiveTab(prId)` into the existing overlay. Inbox and pinned-PR overlays share one `activeTab` axis and never both render.

### 3.4 Core backend endpoints (all `accountIdOf(req)`-scoped, no AI)

The data map confirms the gaps: no server-side repo→user→PR grouping, no per-repo current-state thread-state total, no repo-scoped Claude-review retrieval. Three additions, all in `apps/backend/src/db/queries.ts` (because `buildTimelinePrs` L313 / `buildThreadCounts` L277 / `isStalled` L300 are module-private and must be reused in-file):

**`GET /api/inbox?repoIds` → `getInbox(accountId, repoIds?)`** (NEW in `queries.ts`, new route `apps/backend/src/api/routes/inbox.ts`). Returns per watched repo:
```ts
interface InboxRepo {
  repoId: number; repoFullName: string;
  stats: { openPrs; draftPrs; mergedLast7d; stalledPrs;
           medianHoursToFirstReview; oldestUnreviewed };     // RepoInsights subset (reuse getInsights internals)
  threadTotals: ThreadStateCounts;                           // NEW aggregation: sum buildThreadCounts over open-PR ids
  maintainerIds: number[];                                   // from getMergers
  attentionCount: number; hasUnread: boolean;
  prs: TimelinePr[];                                         // from buildTimelinePrs — caller groups by authorId
}
// response: { repos: InboxRepo[]; generatedAt: string }
```
The one genuinely-missing aggregation is `threadTotals` — sum `buildThreadCounts(openPrIds)` per repo. Everything else composes from existing helpers in-file.

**`GET /api/repos/:id/claude-reviews` → `listClaudeReviewsByRepo(repoId, accountId)`** (NEW retrieval query, no schema change). Joins `claudeReviews → pullRequests` filtered on `pullRequests.repoId` + `claudeReviews.accountId`, grouped by `prId`, all runs per PR (newest-first) — richer than the lossy `listAllClaudeReviews` (which keeps only one latest-succeeded run per PR within the window). New id-route → **must pass `verify:isolation`** (404 cross-account); gated on `config.claudeReviewEnabled`. `[Open ▸]` routes into the existing `ClaudeReviewsModal` / per-PR view at that `reviewId`. The per-PR inline `⚡n ▸` drawer reuses `listClaudeReviewHistory(prId)`.

### 3.5 Frontend tab / state / URL wiring

- **`ActiveTab = 'timeline' | 'inbox' | number`** in `store/pinnedTabs.ts` — reuses the `<main>` overlay slot, `inert` a11y, Escape → `showTimeline()` precedence. **Load-bearing:** every `filters.ts` nav action already calls `showTimeline()`, so any timeline navigation auto-exits Inbox for free.
- **`store/filters.ts`:** add `inboxRepoId: number | 'all' | null` and `inboxThreadFilter: DerivedState | null` — transient; add to `freshDefaults()` but **NOT** to `pickFilterBarState` / `sanitizePersistedFilters` (mirror the `myTurnOnly` / `insightsOpen` exclusion).
- **URL (`useUrlState.ts`):** `?view=inbox` + `?inboxRepo=<id>` deep-linkable (read in `readFromUrl`, write only when non-default); `inboxThreadFilter` stays URL-silent. Existing `repos`/`users`/`preset` still scope the aggregate.
- **Hooks:** `useInbox()`, `useRepoClaudeReviews(repoId)`; reuse `useRepos`, `useMergers`, `usePinnedTabs`.

---

## 4. Pro per-repo LLM digest (`@pierre/pro`, flagged)

**Model:** cheap tier = **`claude-haiku-4-5`** ($1.00/1M in, $5.00/1M out, 200K context). Single-shot, non-agentic, no tools, no thinking, no `effort` (both add cost; `effort` 400s on Haiku).

### 4.1 Payload assembler (`packages/pro/src/inbox-digest/metrics.ts`)

A pure, deterministic assembler that consumes the **core `getInbox` output** (via `ctx.queries.getInbox`) plus `getRepoAnalytics` (latest 2–3 weekly buckets for the level-of-change trend) and folds into a token-bounded JSON object per repo. Names/numbers only — no bodies, no diffs, no raw event arrays. **The public repo owns the aggregation (`getInbox`), the private package owns only the compaction + LLM call.**

```jsonc
// RepoDigestPayload — ~1.5–4K tokens/repo, every array capped
{ "repo": "owner/name", "window_days": 14,
  "stats": { "open": 23, "draft": 4, "merged_window": 11, "stalled": 5,
             "median_hours_to_first_review": 9.5,
             "oldest_unreviewed": { "pr": 412, "title": "…", "age_hours": 73 } },
  "threads": { "untouched": 14, "replied_unresolved": 6, "likely_addressed": 9, "resolved": 31 },
  "change_signal": { "throughput_this_week": {opened,merged,closed},
                     "throughput_prev_week": {…}, "trend": "rising" },     // from getRepoAnalytics
  "contributors": [ { "user":"alice","open_prs":5,"merged_window":3,"reviews_given":7,
                      "comments":12,"maintainer":true,"areas":["api/","db/"] } ],
  "prs": [ { "pr":412,"title":"Add OAuth callback","author":"bob","stalled":true,
             "changes_requested":true,"reason":"untouched_threads",
             "threads":{untouched:3,replied_unresolved:1,likely_addressed:0,resolved:2},
             "claude_reviewed":true,"claude_verdict":"REQUEST_CHANGES" } ],     // ≤25, oldest-first
  "unresolved_thread_digest": [ { "pr":412,"path":"api/auth.ts","state":"untouched",
                                  "excerpt":"Token isn't validated before…" } ] }  // ≤15; reviewComments.excerpt (lean-safe)
```
`reviewComments.excerpt` is always populated even under lean storage, so `unresolved_thread_digest` needs no hydration. A 900-PR repo still emits ≤25 PR rows + ≤15 thread rows. A per-PR variant (keyed by `prId`, reusing `getPrDetail` + `listClaudeReviewHistory`) backs an optional "what changed here" expansion.

### 4.2 The cheap-tier seam (swappable)

```ts
// packages/pro/src/llm/seam.ts — OpenAI-compatible shape, NOT the Agent SDK
export interface LlmClient {
  complete(req: { system: string; user: string; maxTokens: number; })
    : Promise<{ text: string; inputTokens: number; outputTokens: number; costUsd: number }>;
}
```
Default impl `AnthropicHaikuClient` → `client.messages.create({ model: config.pro.digestModel /* 'claude-haiku-4-5' */, max_tokens, system: [{ type:'text', text: HEADLINES_SYSTEM, cache_control:{type:'ephemeral'} }], messages:[{ role:'user', content: JSON.stringify(payload) }] })`. No `thinking`, no `effort`, no tools. The model id lives in `@pierre/pro` config — never hardcoded at call sites; a future `OpenAiCompatibleClient` drops in by changing `config.pro.digestProvider`. Auth reuses the existing local key seam (`ANTHROPIC_API_KEY` / `review/local-settings.ts`). Internally the plugin can call `ctx.llm.complete` (core-owned Anthropic wiring) so it adds **no new curated dependency**.

**Grounding system prompt (cached across repos):** *"You will receive a JSON object of pre-computed metrics for ONE repository. Write a 3–6 sentence headline briefing: the types of changes, who is driving them, the level of change vs the prior period, and which review threads remain unresolved. Use ONLY the numbers and names present in the JSON. Do not invent PRs, people, files, counts, or events. Lead with the level-of-change signal. Plain prose, no markdown headers."* The payload is the sole source of truth → output is auditable against `stats`/`prs`.

**Cost:** input ~3K × $1/1M ≈ $0.003 + output ~500 × $5/1M ≈ $0.0025 → **~$0.005–0.006/repo**; with the cached system block, marginal repos pay input-payload only (~$0.004). A 10-repo workspace ≈ **$0.05 per full cold refresh, $0 when nothing changed.**

### 4.3 Caching / refresh

- **Activity key** = `MAX(events.occurredAt) WHERE repoId=…` combined with a **payload content hash** (`sha256` of canonicalized `RepoDigestPayload` minus `generated_at`). The payload hash is the real guard — regenerate iff the underlying metrics moved.
- **Storage** (plugin-owned table `repo_digests`, dual-dialect, §6): `(id, accountId, repoId, payloadHash, latestEventAt, model, summary, costUsd, inputTokens, outputTokens, createdAt)`, unique `(accountId, repoId)`, upsert on regenerate.
- **Trigger:** generation fires solely on Inbox open / explicit Refresh — never a cron / background sweep. Compute `payloadHash`; match → serve cached (free); else → Haiku → upsert. In cloud, reuse the `accounts.lastActiveAt` activity gate (no open tab → no digest). Local: always-on but still only on Refresh/open. Per-account in-flight set (mirror `review-manager`) prevents double-billing.

### 4.4 Endpoints (plugin-supplied) + render + guardrails

```
GET  /api/pro/inbox/digests?repoIds=…   → { digests: RepoDigest[], enabled, model, generatedAt }
POST /api/pro/inbox/digests/refresh     → 202 {started} | 200 {unchanged}
GET  /api/pro/inbox/digests/:repoId     → single (+ optional ?prId)
```
`accountIdOf(req)`-scoped, ownership-verified → 404, passes the plugin's own isolation test. Registered only when the plugin is present AND `config.pro.digestEnabled`. Frontend uses `useRepoDigest(repoId)` — a **separate per-repo query** so a slow Haiku call never blocks the core grid; in the all-feed it lazily fetches only for in-view/expanded sections (no eager fan-out). **Absent → flag `inboxDigest:false` → banner simply not rendered.** One optional dismissible "✨ Enable digests" one-liner may sit in the rail footer — never inside cards.

**Cost guardrails:** three independent gates (plugin present AND `config.pro.digestEnabled` default-false AND LLM key resolvable); on-demand only; `config.pro.digestMaxUsdPerRefresh` (e.g. $0.50) + `digestMaxReposPerRefresh` (e.g. 30) with partial results + "budget reached" marker; per-account min refresh interval (e.g. 60s); bounded payload arrays; prompt caching.

---

## 5. Claude Review learnings / memory (Pro only)

The whole design rests on one rule: **core stays inert and premium-free.** Core gains four tiny generic seams; everything that captures, stores, retrieves, renders-context and serves UI data lives in `@pierre/pro`.

### 5.1 The four core seams (public, premium-free)

**5.1.1 `apps/backend/src/review/events.ts` (NEW, ~30 lines) — inert typed emitter.** Zero subscribers in OSS mode ⇒ every emit is a no-op. Payloads carry **identity + delta only** (no repoId/path enrichment — the subscriber enriches by reading core tables via `ctx.db`).
```ts
export type ReviewEvent =
  | { type:'finding.updated'; accountId; findingId; change:{ included?:boolean; editedBody?:string|null } }
  | { type:'finding.posted';  accountId; findingId; postedCommentKind:'inline'|'pr_comment' }
  | { type:'review.draftUpdated'; accountId; reviewId; change:{ userBody?:string; userVerdict?:Verdict } }
  | { type:'review.posted'; accountId; reviewId; userVerdict:Verdict; inlineFindingIds:number[]; prCommentFindingIds:number[] }
  | { type:'review.requested'; accountId; prId; model; requestedMode };
export const reviewEvents = /* tiny typed EventEmitter */ ;
```

**5.1.2 Five one-liner emit sites in `apps/backend/src/api/routes/claude-review.ts`** (after the existing successful persist, before `reply.send`; `accountId` is already `accountIdOf(req)` in every handler):

| Handler | Emit |
|---|---|
| `PATCH /api/claude-findings/:findingId` (L320, `updateFinding`) | `reviewEvents.emit('finding.updated', {accountId, findingId, change:{included, editedBody}})` |
| `POST /api/claude-findings/:findingId/post` (L342, `markFindingPosted`) | `reviewEvents.emit('finding.posted', {accountId, findingId, postedCommentKind})` |
| `PATCH /api/claude-reviews/:reviewId` (L303, `updateReviewDraft`) | `reviewEvents.emit('review.draftUpdated', {accountId, reviewId, change})` |
| `POST /api/claude-reviews/:reviewId/post` (L446, `markReviewPosted`) | `reviewEvents.emit('review.posted', {accountId, reviewId, userVerdict, inlineFindingIds, prCommentFindingIds})` |
| `POST /api/prs/:id/claude-review` (L194, `startReview`) | `reviewEvents.emit('review.requested', {accountId, prId, model, requestedMode})` |

**5.1.3 Optional pass-through prompt slot (the injection seam).** `buildUserPrompt` (`prompt.ts` L207) gains `priorReviewContext?: string`, spliced as `## Reviewer preferences from past reviews` **before `## Diff`** (core does no interpretation — renders a string the plugin produced). `RunReviewArgs` (`agent.ts` L55) gains the field; the L274 call site passes it through. `review-manager.ts` `startReview` (L48), before `runReview`, calls a registered nullable provider: `const ctx = await learningsProvider?.buildContext({accountId, prId, headSha}); runReview({...args, priorReviewContext: ctx})`. Default null ⇒ OSS prompt is **byte-identical** to today.

**5.1.4 Capability registration** — reuse §2.3: the plugin's `register` returns `reviewMemory:true`; `/api/me` surfaces it as `pro.reviewMemory`. Frontend reads `useProCapabilities().reviewMemory`.

### 5.2 Capture (all in `@pierre/pro`)

The plugin subscribes once per event and **enriches** the thin core event by reading core tables via `ctx.db` (portable `.execute()`, scoped by the event's `accountId`), then appends one row. Enrichment join (the existing `getFindingPostContext` chain): `findingId → claudeReviewFindings(path, severity, body, editedBody) → reviewId → claudeReviews(prId, headSha) → pullRequests(repoId)`.

| Event | `kind` | Captured |
|---|---|---|
| `finding.updated` `included:false` | `finding_dismissed` | repoId, prId, sourceReviewId, findingId, headSha, path, dirPath, ext, category(=severity), claudeTitle, claudeText(=body) |
| `finding.updated` `included:true` | `finding_kept` | same — explicit accept |
| `finding.updated` `editedBody` non-empty | `finding_reworded` | + userText(=editedBody) — richest wording-correction signal |
| `finding.updated` `editedBody:''` | `finding_reword_cleared` | revert (low weight) |
| `finding.posted` | `finding_posted` | + postedCommentKind — strong endorsement |
| `review.draftUpdated` (userBody) | `review_body_rewritten` | claudeText(=summary) vs userText(=userBody) |
| `review.draftUpdated` (userVerdict ≠ Claude) | `verdict_overridden` | + claudeVerdict, userVerdict |
| `review.posted` | `review_posted` | userVerdict + which findingIds shipped vs dismissed |
| `review.requested` | `run_requested` | model, requestedMode — per-repo depth/model preference |

**Path-glob derivation at capture (stored denormalized for indexable retrieval):** `path` verbatim; `dirPath` = POSIX `dirname(path)`; `ext` = extension. Storing *components* (not a glob string) keeps matching portable/indexable across SQLite/Postgres; a human glob is reconstructed for display only. **Idempotency:** `dedupeKey = hash(kind, findingId|reviewId, headSha, normalize(text))`, unique `(accountId, dedupeKey)`, `onConflictDoUpdate` bumping `createdAt` — toggling a finding off/on/off collapses to its latest state (matches the project's structural-idempotency convention).

### 5.3 Retrieval + injection (Pro path)

**`getRelevantLearnings({accountId, repoId, changedPaths, categories?})`:** derive the PR's touched `dirPath`s + `ext`s; portable query `WHERE accountId=? AND repoId=? AND (dirPath IN (:dirs) OR dirPath LIKE :parent||'/%' OR ext IN (:exts))` ordered `createdAt DESC`, capped; **aggregate in TS** into signals keyed by `(dirGlob, category)`: dismissal rate, reword exemplars (claudeText→userText pairs), verdict-override tally, high-endorsement patterns. Each signal carries a **confidence = sample count** (thin evidence is labelled, mirroring the app's heuristic-honesty ethos).

**Injection** (`learningsProvider.buildContext` → `RunReviewArgs.priorReviewContext`): renders a bounded ~600-token markdown block, e.g.:
```
## Reviewer preferences from past reviews (this repo)
Treat as guidance, not rules.
- In `apps/backend/src/api/routes/*.ts`: reviewer dismissed 7/9 `nit` findings about import
  ordering. Down-weight nits here. (confidence: high)
- In `*.sql` migrations: reviewer rewrote findings to require a matching pg twin. (confidence: medium)
- Verdict: on `frontend/**` you proposed REQUEST_CHANGES 4×; reviewer downgraded to COMMENT. (medium)
```
Rendering is **templated/deterministic/free** for now; the shared cheap-LLM seam (§4.2) optionally compacts it via Haiku when over budget. Empty learnings ⇒ provider returns `undefined` ⇒ zero behavior change.

### 5.4 Two UI surfaces (gated on `pro.reviewMemory`)

**Surface 1 — "Matches from past reviews", BEFORE a run.** Mounted in `ClaudeReviewTab.tsx` run-controls block (L1158–1252), above Run/Re-review. Endpoint `GET /api/pro/prs/:id/review-learnings` → `{ matches: LearningMatch[] }`. Collapsed by default to a one-line summary; each match lazily expands an example; confidence is a subtle right-aligned label, never a hard claim; empty `matches` ⇒ panel doesn't render.
```
┌─ Claude Review ────────────────────────────────────────────────┐
│  ▸ From your past reviews in this repo (4 signals)        [hide]│
│  │ ⓘ These will be given to Claude as context for this run.    │
│  │ apps/backend/src/api/routes/*.ts · nit                       │
│  │ You dismissed 7 of 9 nit findings here. ·············high     │
│  │ *.sql · warning                          [show example ▸]    │
│  │ You reworded 3 findings to require a pg twin. ····medium      │
│  │   Claude: "add an index on repo_id"                          │
│  │   You:    "add it in BOTH schema.sqlite.ts + schema.pg"      │
│  Model [Haiku ▾]  Depth [Auto ▾]            [ Run review ]       │
└─────────────────────────────────────────────────────────────────┘
```

**Surface 2 — Header "Claude Reviews history", per-entry collapsible action log.** Augments `ClaudeReviewsModal.tsx` `ReviewRow` (L33). Endpoint `GET /api/pro/claude-reviews/:reviewId/actions` → `{ actions: ReviewAction[] }` (projection of `review_learnings WHERE accountId=? AND sourceReviewId=?`, 404 if not the caller's). Disclosure collapsed by default with the count visible; rows icon-coded by `kind`; reword shows the Claude→You diff; `posted` rows deep-link to the GitHub comment; zero-action rows show `▸ Actions (0)` disabled (honest, no fetch).
```
┌─ Claude Reviews history ───────────────────────────────────────┐
│  pierre-review #412  Fix timeline scroll gate    REQUEST_CHANGES│
│  apps/frontend · 2 days ago · Haiku                             │
│    ▾ Actions on this review (5)                                 │
│    │ • dismissed  nit · Timeline/lanes.ts   "magic number"  2d  │
│    │ • reworded   warning · Timeline/index.tsx                  │
│    │     Claude: "guard against null ref"                       │
│    │     You:    "go through setVisScrollTop + claim the gate"  │
│    │ • posted ↗   warning · Timeline/index.tsx (inline)     2d  │
│    │ • verdict    Claude APPROVE → you REQUEST_CHANGES       2d  │
│    │ • submitted  review posted · 3 inline, 1 PR comment     2d │
│  other-repo #88 …                                ▸ Actions (0)  │
└─────────────────────────────────────────────────────────────────┘
```

**Frontend wiring (Decision 4 recommendation):** the React rendering lives in **core, gated by `pro.reviewMemory`**, fetching the plugin endpoints via `api/client.ts` (`getReviewLearnings(prId)` / `getReviewActions(reviewId)`) + `useReviewLearnings` / `useReviewActions` hooks mirroring `useClaudeReview`. The premium value (captured data + retrieval/injection) stays server-side in `@pierre/pro`. Stricter `<ProSlot>` registry is the documented fallback.

---

## 6. Schema + migrations

### 6.1 Core (public repo) — NO new tables, NO new columns

Workstream 2's Inbox + repo-oriented Claude-review retrieval are **pure reads** over existing tables. `getInbox` / `threadTotals` / `listClaudeReviewsByRepo` add no persisted state. Workstream 3's core seams (`events.ts`, prompt slot) add no storage. **Therefore `db/schema.sqlite.ts`, `db/schema.pg.ts`, `schema-parity.test.ts` and the core migration folders are untouched.** The only public-repo verification additions: extend `apps/backend/src/api/scripts/verify-isolation.ts` to exercise `getInbox` and `listClaudeReviewsByRepo` (both new id/list getters → must return empty/404 cross-account).

### 6.2 Plugin-owned (`@pierre/pro`) — dual-dialect, account-scoped, its own migrator

Two tables, defined in **both** `packages/pro/src/review-memory/schema.sqlite.ts` and `schema.pg.ts` (plugin-side parity test, NOT core's), migrated via `ctx.registerMigrations('packages/pro/migrations', 'packages/pro/migrations-pg')` at bind time, with its own `pro_migrations` bookkeeping table and `CREATE TABLE IF NOT EXISTS` first-run self-provision. Portable terminals only; multi-row writes via `ctx.runTransaction`.

**`review_learnings`** (append-only event log; pg twin = identical names, `timestamptz` / `bigserial`):

| column | type | notes |
|---|---|---|
| `id` | integer PK autoinc | |
| `accountId` | integer NOT NULL | **isolation column** — every query filters it |
| `repoId` | integer NOT NULL | denormalized for repo-oriented retrieval |
| `prId` | integer NOT NULL | |
| `sourceReviewId` | integer NOT NULL | `claudeReviews.id` |
| `findingId` | integer | null for review-level |
| `headSha` | text NOT NULL | |
| `kind` | text enum | the 9 kinds (§5.2) |
| `path` / `dirPath` / `ext` | text | path verbatim / dirname (indexed) / extension (indexed) |
| `category` | text enum | severity: blocker/warning/nit/question/praise |
| `claudeVerdict` / `userVerdict` | text | for verdict_overridden / review_posted |
| `claudeTitle` / `claudeText` / `userText` | text | finding title / Claude body·summary / editedBody·userBody |
| `postedCommentKind` | text | inline / pr_comment |
| `dedupeKey` | text NOT NULL | idempotency |
| `createdAt` | integer ts (sqlite) / timestamptz (pg) | |

Indexes: `unique (accountId, dedupeKey)`; `(accountId, repoId, category)` (primary retrieval); `(accountId, repoId, dirPath)` (glob matching); `(accountId, sourceReviewId)` (Surface 2); `(accountId, repoId, createdAt)` (recency / Surface 1).

**`repo_digests`** (WS2 Pro cache): `(id, accountId, repoId, payloadHash, latestEventAt, model, summary, costUsd, inputTokens, outputTokens, createdAt)`, unique `(accountId, repoId)`.

**Isolation:** `verify:isolation` covers only the core query layer, so the plugin ships its **own** `packages/pro/test/isolation.test.ts` over `review_learnings` + `repo_digests` (every getter scopes `accountId`; id-addressed getters → 404). These tables follow the multi-tenancy rule: `accountId` denormalized, composite uniques.

---

## 7. Phased, sequenced build order

Each phase is independently shippable. Effort = rough; value = sprint-impact.

### Phase 0 — Core seams (OSS, no user-visible change) · value: low · effort: S
Lands the inert plumbing so later phases are pure adds.
- `apps/backend/src/pro/contract.ts`, `pro/bind.ts`, `review/llm.ts` (`cheapComplete` Haiku seam), `review/events.ts` (+5 emit lines in `claude-review.ts`), `plugins`-style `getProCapabilities()` passthrough in `me.ts`, `index.ts` bind block, `config.proEnabled = !isCloud`.
- `packages/shared` `MeResponse.pro` (type-only); frontend `useProCapabilities()`.
- The prompt slot (`prompt.ts` `priorReviewContext`, `agent.ts` `RunReviewArgs`, `review-manager.ts` provider call).
- **Gate:** `pnpm typecheck` + `pnpm test` green with `@pierre/pro` ABSENT (proves degradation). All OSS-core.

### Phase 1 — Inbox tab, AI-free (OSS) · value: HIGH · effort: L
The flagship always-on feature; depends on nothing premium.
- Backend: `getInbox` + `threadTotals` + `listClaudeReviewsByRepo` in `queries.ts`; routes `inbox.ts` + `GET /api/repos/:id/claude-reviews`; extend `verify-isolation.ts`.
- Frontend: `ActiveTab` in `store/pinnedTabs.ts`; header segmented control; left rail + `RepoSection` (two densities); `inboxRepoId`/`inboxThreadFilter` store fields; `useInbox`/`useRepoClaudeReviews`; URL `?view=inbox`/`?inboxRepo`. Reuse `MaintainerShield`, `UserName`, `DERIVED_STATE_META`/`PR_STATE_META`/`CI_META`/`REASON_META`, `ev-select-pulse`, zebra tints, `usePinnedTabs`.
- **Ships value with zero Pro dependency.** All OSS-core.

### Phase 2 — Pro per-repo digest (`@pierre/pro`) · value: HIGH · effort: M
First premium surface; proves the whole open-core machinery end-to-end.
- Stand up `packages/pro` (submodule, `index.ts` self-gate, `contract-types.ts`, `llm/seam.ts` `AnthropicHaikuClient`).
- `inbox-digest/metrics.ts` assembler over `ctx.queries.getInbox` + `getRepoAnalytics`; `repo_digests` table + migrator + payload-hash cache; routes `/api/pro/inbox/digests*`; `register` returns `inboxDigest:true`.
- Frontend: digest banner in `RepoSection` behind `pro.inboxDigest`; `useRepoDigest` lazy per-repo; cost guardrails.
- @pierre/pro (private) except the one capability-gated banner render in core.

### Phase 3 — Review learnings/memory (`@pierre/pro`) · value: MED-HIGH · effort: M-L
Builds on Phase 0's seams + Phase 2's plugin scaffold.
- `review-memory/capture.ts` subscribers + enrichment; `review_learnings` table + migrator + plugin isolation test; `retrieval.ts` (`getRelevantLearnings`) + `buildContext` provider (`registerLearningsProvider`); routes `/api/pro/prs/:id/review-learnings` + `/api/pro/claude-reviews/:reviewId/actions`; `register` returns `reviewMemory:true`.
- Frontend (core, gated `pro.reviewMemory`): Surface 1 panel in `ClaudeReviewTab.tsx`; Surface 2 disclosure in `ClaudeReviewsModal.tsx`; `useReviewLearnings`/`useReviewActions`.
- @pierre/pro (private) except the two capability-gated renders in core.

---

## 8. Risks + convention compliance

| Convention / risk | How respected |
|---|---|
| **No public premium capability** | All premium *logic/data/storage* lives in `@pierre/pro`; the public repo holds only a contract, a guarded import, a capability passthrough, and inert seams (an emitter with zero subscribers, an optional prompt string). `getInbox` / `listClaudeReviewsByRepo` are non-premium aggregations. |
| **Graceful degradation / no install failure** | `await import('@pierre/pro' as string).catch(...)` → null on `ERR_MODULE_NOT_FOUND`; `config.proEnabled` master gate; public CI clones without the submodule and must pass `typecheck`/`test`, exercising the OSS path on every push. |
| **Packaging guards (`build-release.mjs`)** | `@pierre/pro` never added to the curated allowlist (L150–168) → never in the published manifest. No `.ts` leak (plugin not copied into `release/`). No shared runtime import (contract + plugin use `import type` only). New core files compile to `.js`; **zero `build-release.mjs` change required.** The Haiku seam reuses the already-curated `@anthropic-ai/sdk` — no new dep. |
| **`shared` is types-only** | `MeResponse.pro` is a type; runtime contract lives in `apps/backend/src/pro/contract.ts`; plugin mirrors via `import type`. |
| **ESM NodeNext (.js)** | Core + plugin backend use explicit `.js` relative specifiers; frontend stays Bundler (no extensions). The `as string` cast keeps tsc from resolving the runtime-only specifier. |
| **Dual-dialect DB** | Core needs NO schema change. Plugin ships **both** `schema.sqlite.ts` + `schema.pg.ts`, its own parity test + migrations/migrations-pg + `pro_migrations`, run via `ctx.registerMigrations` (folder/migrator picked by `ctx.isPg`). Portable terminals only (`ctx.db` is node-postgres-typed → `.get()` is a compile error); multi-row writes via `ctx.runTransaction`. |
| **Per-account isolation** | Plugin can only get the account via `ctx.accountIdOf(req)` — can't reach `req.account.id` raw. Core: extend `verify-isolation.ts` for `getInbox`/`listClaudeReviewsByRepo`. Plugin: its own isolation test (the harness can't see plugin tables). Pro tables denormalize `accountId` with composite uniques. |
| **Idempotency** | `review_learnings` uses `dedupeKey` + `unique(accountId, dedupeKey)` + `onConflictDoUpdate`; `repo_digests` upserts on `(accountId, repoId)`. |
| **Keep `/api/timeline` lean** | Inbox/digest never touch the timeline endpoint; digest payload uses already-stored `reviewComments.excerpt` (no hydration). |
| **Cost runaway** | Three gates (plugin + `digestEnabled` + key), on-demand only, payload-hash cache (unchanged board = $0), bounded payload arrays, per-refresh USD + repo caps, min-interval. |
| **Heuristic honesty** | Learnings signals carry confidence = sample count; the UI never asserts thin evidence (mirrors `likely_addressed` uncertainty messaging). |
| **`agents git-checkout clobbers uncommitted` (MEMORY)** | This is a planning doc — no code written. When execution begins, prefer targeted Edits over checkout/stash given the repo's typically-large uncommitted state. |

**Top residual risks to watch during execution:** (1) `buildTimelinePrs`/`buildThreadCounts`/`isStalled` are module-private — `getInbox` MUST be authored inside `queries.ts`, not a sibling file. (2) Plugin migrations run *after* core `runMigrations()` (at bind time) — acceptable since Pro tables are independent, but document it. (3) The `ctx` surface is the long-term compat contract — bump `apiVersion` on any breaking change and have `bind.ts` log-and-degrade on mismatch. (4) Confirm the six "Decisions to confirm" before Phase 1, especially #1 (base Claude Review stays core-but-flagged) and #4 (Pro UI renders in core behind the flag).

This plan's file paths, endpoint names, and column names are drawn directly from the verified seam maps; Phases 0–1 are pure OSS-core and can start immediately.

---
---
# APPENDICES — full component designs

*The following are the raw component designs the synthesis above was built from, preserved for reference/detail.*


---

## Appendix — Open-core plugin architecture (full design)

# Open-Core Runtime-Plugin Architecture for `@pierre/pro`

Design for Workstream 1. Grounded in the real seam map; every binding point and convention verified against the current tree.

---

## 0. The core idea in one paragraph

The OSS core defines a **contract** (`ProPlugin` interface) and a **host context** (`ProContext`) — both plain TypeScript in backend core, no runtime dependency on the private package. At boot, after `buildApp()` returns and before `app.listen()`, `index.ts` does one guarded `await import('@pierre/pro').catch(() => null)`. If it resolves, the core calls `plugin.register(app, ctx)`, which (a) registers the plugin's Fastify routes onto the live instance and (b) returns a **capabilities object** the core caches in a module singleton. `/api/me` reads that singleton and surfaces a `pro` capability map to the frontend, exactly mirroring `claudeReviewEnabled`. If the import throws `ERR_MODULE_NOT_FOUND`, the singleton stays empty, no premium routes exist, no premium UI renders — clean OSS mode, zero install failure.

---

## 1. The CONTRACT (defined in OSS core)

`packages/shared` is types-only and cannot hold a runtime registry, and it must not be a runtime bridge. So the **interface lives in backend core** as a new module `apps/backend/src/pro/contract.ts`. It exports both the type contract and the live singleton that holds whatever the plugin advertised.

```ts
// apps/backend/src/pro/contract.ts  (OSS core — no dependency on @pierre/pro)
import type { FastifyInstance, FastifyBaseLogger } from 'fastify';

// ---- Capabilities the plugin advertises back to the host (→ /api/me → SPA) ----
// Keep this a flat, serializable, additive record. Each boolean gates one Pro UI
// surface. Mirrors how `claudeReviewEnabled` flows today.
export interface ProCapabilities {
  inboxDigest: boolean;       // WS2: per-repo LLM "headlines digest"
  reviewMemory: boolean;      // WS3: Claude Review learnings/memory
  // ...future Pro surfaces, additive only.
}

// ---- The host context handed to the plugin's register() ----
// This is the ONLY surface the plugin may use to reach host internals. The plugin
// imports NOTHING from backend dist directly — everything it needs is passed here,
// so the boundary is explicit, swappable, and version-checkable.
export interface ProContext {
  log: FastifyBaseLogger;

  // Host metadata so the plugin can self-gate (e.g. refuse to run in cloud).
  host: { version: string; deploymentMode: 'local' | 'cloud'; isCloud: boolean };

  // The single account-scoping seam, re-exported so plugin routes scope identically
  // to core routes (per-account isolation is load-bearing). Plugin calls
  // ctx.accountIdOf(req) — never reaches for req.account.id itself.
  accountIdOf(req: import('fastify').FastifyRequest): number;

  // Portable DB surface. The plugin receives the SAME drizzle `db`, `schema`,
  // `runTransaction`, `isPg` the core uses — so plugin queries are dual-dialect by
  // construction and run on the active driver. Typed loosely here (`unknown`-ish)
  // to avoid the core depending on plugin-side schema; the plugin re-narrows.
  db: import('../db/client.js').Db;
  schema: typeof import('../db/client.js').schema;
  runTransaction: typeof import('../db/client.js').runTransaction;
  isPg: boolean;

  // A cheap-tier LLM seam (WS2 digest / WS3 memory synthesis). The CORE owns the
  // Anthropic client wiring (auth resolution already exists in review/auth.ts); the
  // plugin calls a narrow function rather than importing the SDK itself. Swappable
  // later (Haiku → other cheap tier) behind this one signature.
  llm: {
    complete(opts: {
      model?: string;            // default 'claude-haiku-*' resolved by the seam
      system?: string;
      prompt: string;
      maxTokens?: number;
    }): Promise<{ text: string; usage?: { inputTokens: number; outputTokens: number } }>;
  };

  // Read access to existing aggregations the plugin composes (WS2 reuses
  // getInsights/getRepoAnalytics/getTimeline/getOpenPrs). Passed as bound functions
  // so the plugin never imports db/queries.js directly.
  queries: ProHostQueries;
}

// A curated, stable slice of the host read-layer the plugin is allowed to call.
// Narrow on purpose — this is the API-compat contract between core and plugin.
export interface ProHostQueries {
  getInsights(accountId: number, repoId: number): Promise<unknown>;
  getRepoAnalytics(accountId: number, repoId: number): Promise<unknown>;
  getOpenPrs(args: { accountId: number; repoIds?: number[] }): Promise<unknown>;
  // ...add as Pro features need them; additive.
}

// ---- The plugin's single entry point ----
export interface ProPlugin {
  // Semver of the contract the plugin was built against; the host warns on mismatch.
  apiVersion: 1;
  register(app: FastifyInstance, ctx: ProContext): Promise<ProCapabilities>;
}

// ---- The live singleton the host caches after a successful register() ----
const EMPTY: ProCapabilities = { inboxDigest: false, reviewMemory: false };
let active: ProCapabilities = EMPTY;
export function setProCapabilities(c: ProCapabilities): void { active = c; }
export function getProCapabilities(): ProCapabilities { return active; }
export function proLoaded(): boolean { return active !== EMPTY; }
```

Key contract decisions:
- **`register` returns the capabilities** rather than the host inferring them — the plugin is the authority on what it actually wired up (a partial install, or a feature it disabled internally, reports `false`).
- **No host internals imported by the plugin.** `db`, `schema`, `runTransaction`, `accountIdOf`, `llm`, `queries` are all handed in via `ctx`. This is the clean-boundary requirement (deliverable 6) made structural.
- **`apiVersion`** lets the host log-and-degrade if a future plugin is built against a newer contract.

---

## 2. The BOOT SEQUENCE — where it binds

The natural seam (confirmed) is in `index.ts` between `const app = await buildApp()` (L32) and `await app.listen()` (L53): the app exists, `config` is fully resolved, routes can still be registered (Fastify allows `register` until the instance is `ready`/listening). The scheduler block (L44–51) is the exact structural precedent — an optional subsystem in a `try/catch` that `app.log.warn`s and no-ops on failure.

Insert a new block right after the Claude-review reconcile (after L41), so it runs in the same "post-build, pre-listen" window:

```ts
// apps/backend/src/index.ts  — inserted after L41, before the scheduler block.

// Optional Pro plugin. Open-core: @pierre/pro is NOT a declared dependency of the
// published package, so on a public `npx pierre-review` this import throws
// ERR_MODULE_NOT_FOUND and we run in clean OSS mode. When present (workspace-linked
// locally, or token-gated install later), it extends the API surface + advertises
// capabilities. Mirrors the conditional `pg` dynamic import in db/client.ts.
{
  const { bindProPlugin } = await import('./pro/bind.js');
  await bindProPlugin(app);   // never throws; logs + degrades internally
}
```

The binder isolates the try/catch and context construction:

```ts
// apps/backend/src/pro/bind.ts  (OSS core)
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { db, schema, runTransaction, isPg } from '../db/client.js';
import { accountIdOf } from '../api/plugins/auth.js';
import { getInsights, getRepoAnalytics, getOpenPrs } from '../db/queries.js';
import { cheapComplete } from '../review/llm.js';   // the Haiku seam (new, core-owned)
import { setProCapabilities, type ProContext, type ProPlugin } from './contract.js';

const HOST_VERSION = '0.1.x'; // from package.json at build

export async function bindProPlugin(app: FastifyInstance): Promise<void> {
  // The boundary import. `.catch(() => null)` swallows ERR_MODULE_NOT_FOUND (absent
  // package) AND any load-time throw, so absence is indistinguishable from clean OSS.
  const mod = await import('@pierre/pro' as string).catch((err) => {
    // Only log at debug for the expected "absent" case; warn for an unexpected throw.
    if ((err as { code?: string })?.code === 'ERR_MODULE_NOT_FOUND') {
      app.log.debug('pro plugin not installed — OSS mode');
    } else {
      app.log.warn({ err }, 'pro plugin present but failed to load — OSS mode');
    }
    return null;
  });
  if (!mod) return;

  const plugin = (mod as { default?: ProPlugin }).default ?? (mod as unknown as ProPlugin);
  if (!plugin?.register || plugin.apiVersion !== 1) {
    app.log.warn({ apiVersion: plugin?.apiVersion }, 'pro plugin contract mismatch — skipped');
    return;
  }

  const ctx: ProContext = {
    log: app.log,
    host: { version: HOST_VERSION, deploymentMode: config.deploymentMode, isCloud: config.isCloud },
    accountIdOf,
    db, schema, runTransaction, isPg,
    llm: { complete: cheapComplete },
    queries: {
      getInsights: (a, r) => getInsights(a, r),
      getRepoAnalytics: (a, r) => getRepoAnalytics(a, r),
      getOpenPrs: (args) => getOpenPrs(args),
    },
  };

  try {
    const caps = await plugin.register(app, ctx);   // plugin adds its routes here
    setProCapabilities(caps);
    app.log.info({ caps }, 'pro plugin active');
  } catch (err) {
    app.log.warn({ err }, 'pro plugin register() failed — OSS mode');
  }
}
```

The `as string` cast on the import specifier is the standard trick to stop the TS module resolver and bundlers from trying to resolve `@pierre/pro` at compile time (it's a runtime-only specifier — see deliverable 5).

How routes extend the surface: the plugin's `register` calls `app.get('/api/pro/...', ...)` on the **same** `FastifyInstance`. Because `registerAccountContext` already ran inside `buildApp()` (L96 there), `request.account` is decorated and `ctx.accountIdOf(req)` works for plugin routes for free. In cloud the auth gate (L99) already 401s any unauthenticated `/api/*` including `/api/pro/*` — no extra wiring. (Pro is local-only for now anyway; see §4 self-gating.)

How absence yields OSS mode: `mod === null` → return early → `getProCapabilities()` stays `EMPTY` → no `/api/pro/*` routes exist (404) → `/api/me` reports every Pro cap `false` → the SPA renders no Pro UI. Identical posture to `claudeReviewEnabled === false`.

---

## 3. Why it must NOT be a declared dependency (+ how you install it now)

**Why not declared:** if `@pierre/pro` were in the published `dependencies`, then `npx pierre-review` for a public user would try to install a package they have no access to → `npm install` fails (private/404), and the whole CLI is dead on arrival. The build-release manifest is a curated allowlist (verified L150–168 of `build-release.mjs`); `@pierre/pro` is simply **never added there**. It has the same posture as an optional/peer dependency that may be absent: the code must tolerate `MODULE_NOT_FOUND` (which §2's `.catch` does). The published tarball contains no premium code and no reference that resolves to one — so the public repo "contains no premium backend capability," satisfied structurally.

**How you install it now (local dev):** a **pnpm workspace link** is cleanest and matches the existing monorepo. Two equally-good options:
- **Sibling private repo + `pnpm link` / `file:` override in a gitignored place.** Keep `pierre-pro/` as a separate private git repo checked out next to `pierre-review/`. Add it to `pnpm-workspace.yaml` only via a **gitignored local overlay** is awkward — pnpm reads one workspace file. So prefer:
- **Git submodule at `packages/pro/` (private), added to `pnpm-workspace.yaml`.** `pnpm-workspace.yaml` lists `packages/pro`. Public CI clones **without** the submodule (submodules are opt-in; no token → it's simply not there), so `@pierre/pro` is absent in public CI and the dynamic import's `.catch` exercises the OSS path. Your machine inits the submodule with a token, `pnpm install` symlinks it into `node_modules/@pierre/pro`, and the runtime import resolves. The published package never includes `node_modules` or the submodule, so nothing leaks.

Either way, **the public `package.json` / lockfile must not reference it.** With the submodule approach, guard CI: the public `ci.yml` runs `pnpm install` with the submodule absent and must still pass `typecheck` (deliverable 5 handles this) — proving graceful degradation on every push.

**Token-gated distribution later:** publish `@pierre/pro` to a **private npm registry** (or GitHub Packages) scoped to `@pierre`. Pro customers add a scoped registry auth line (`@pierre:registry=...` + token) to their `.npmrc` and `pnpm add @pierre/pro` into their own install of `pierre-review`, OR you ship a Pro distribution that pre-bundles it. The runtime contract (`await import('@pierre/pro')`) is identical whether it arrived via submodule, private registry, or a customer install — the boot seam doesn't care how it got onto disk.

---

## 4. CAPABILITY FLAGS through `/api/me`

Add a `pro` field to `MeResponse` in `packages/shared/src/types.ts` (types-only, fine) and to the `/api/me` handler. This is the single source of truth the frontend gates on, exactly like `claudeReviewEnabled`.

```ts
// packages/shared/src/types.ts — extend MeResponse (additive)
export interface ProCapabilities {     // mirror of the backend contract shape
  inboxDigest: boolean;
  reviewMemory: boolean;
}
export interface MeResponse {
  user: LocalUser | null;
  counts: MyTurnCounts;
  claudeReviewEnabled: boolean;
  deploymentMode: 'local' | 'cloud';
  pro: ProCapabilities;               // NEW — empty/all-false in OSS mode
}
```

```ts
// apps/backend/src/api/routes/me.ts — one line added to the return
import { getProCapabilities } from '../../pro/contract.js';
// ...
return {
  user,
  counts: { /* unchanged */ },
  claudeReviewEnabled: config.claudeReviewEnabled,
  deploymentMode: config.deploymentMode,
  pro: getProCapabilities(),          // singleton set during boot; EMPTY if no plugin
};
```

Frontend consumption mirrors the existing `claudeReviewEnabled` pattern (consumers already established: `App.tsx`, `PrDetail.tsx`, `InsightsModal.tsx`, `ClaudeReviewBanner.tsx`). A thin selector hook keeps it ergonomic:

```ts
// apps/frontend/src/hooks/useMe.ts (extend) or a new useProCapabilities.ts
export function useProCapabilities() {
  const me = useMe();
  return me.data?.pro ?? { inboxDigest: false, reviewMemory: false };
}
```

Then Pro UI is gated: the Inbox tab's digest panel renders only when `pro.inboxDigest`; the Claude Review memory surfaces render only when `pro.reviewMemory`. The **Inbox tab itself is NOT gated** (Workstream 2 decision) — it ships in core and only its digest sub-panel checks the flag.

**Optional master flag for cloud safety:** add `config.proEnabled = !isCloud` (Pro is local-only for now, like Claude Review) and have `bind.ts` skip the import entirely when `!config.proEnabled`. The plugin should ALSO self-gate inside `register` (defense-in-depth: read `ctx.host.isCloud` and return all-`false` caps without wiring routes if it ever lands in cloud), mirroring the `if (!config.claudeReviewEnabled) return featureOff(reply)` belt-and-braces inside `claude-review.ts`.

---

## 5. TYPECHECK / PACKAGING safety

**Typecheck against a LOCAL interface, never the package's own types.** The dynamic import is typed against `apps/backend/src/pro/contract.ts` (which lives in the public repo and is always present), NOT against `@pierre/pro`'s declarations (absent in public CI). The `await import('@pierre/pro' as string)` returns `Promise<any>`; we immediately narrow it to the local `ProPlugin` type. Because the specifier is cast to `string`, `tsc` (NodeNext) does not attempt to resolve `@pierre/pro` and does not error on the missing module in public CI. This is the crux: **the compile-time contract is core-owned; the runtime artifact is optional.**

To make this bulletproof, do **not** add a `paths` mapping or `@pierre/pro` type stub to the public `tsconfig` — the `as string` cast is sufficient and keeps public `pnpm typecheck` green with the package absent (which CI must verify on every push).

**Packaging asserts — all already satisfied:**
- *No `.ts` leak* (`walk` L218–227): the plugin is never copied into `release/`, so nothing to leak. `pro/contract.ts`, `pro/bind.ts`, `review/llm.ts` compile to `.js` like any core file.
- *No shared runtime import* (`grepSharedImports` L232–256): `contract.ts` and the plugin both use `import type` for any `@pierre-review/shared` types (the `ProCapabilities` mirror in shared is a type; backend uses its own copy in `contract.ts` to avoid even a type-coupling if desired). The grep matches `from '@pierre-review/shared'` value imports only — `import type` is erased, so it never appears in emitted `.js`. Compliant.
- *Curated deps* (L150–168): `@pierre/pro` is deliberately omitted. The Anthropic SDK that `review/llm.ts` (the Haiku seam) needs is **already** a curated dep (`@anthropic-ai/claude-agent-sdk`, `@anthropic-ai/sdk`) — so the cheap-tier LLM seam adds no new dependency to the manifest. No build-release change is required at all.
- *Required-file asserts* (`mustExist` L194–212): the new core files (`pro/contract.js`, `pro/bind.js`, `review/llm.js`) are always present in `release/dist`; you MAY add them to `mustExist` for safety, but you must **NOT** add anything under `@pierre/pro` there (it is absent by design).

Net: zero changes to `build-release.mjs` are forced; the architecture slots inside every existing assert.

---

## 6. Private package structure (`@pierre/pro`)

```
pierre-pro/                         (private repo, or packages/pro submodule)
├─ package.json                     name "@pierre/pro", "type":"module",
│                                   "main":"dist/index.js", private:true
├─ tsconfig.json                    module/moduleResolution NodeNext, target ES2022
├─ src/
│  ├─ index.ts                      default export: ProPlugin
│  ├─ inbox-digest/
│  │  ├─ routes.ts                  GET /api/pro/inbox/digest, POST .../refresh
│  │  ├─ metrics.ts                 per-repo & per-PR metric assembly (via ctx.queries)
│  │  └─ prompt.ts                  Haiku "headlines digest" prompt builder
│  └─ review-memory/
│     ├─ routes.ts                  GET /api/pro/review-memory?repoId&path
│     ├─ capture.ts                 records UI interactions (WS3)
│     └─ schema.ts                  the plugin's OWN dual-dialect tables (see §7)
└─ migrations/  + migrations-pg/    plugin-owned migrations (run via ctx, see §7)
```

- **`package.json`**: `"type": "module"`, ESM, **NodeNext**. Its only runtime peer expectation is `fastify` (provided by the host at runtime — list it as a `peerDependency`, not a bundled dep, so there's one Fastify instance). It does NOT depend on `@pierre-review/backend` or `@pierre-review/shared` as runtime deps.
- **`import type` only from shared.** If the plugin wants `PrSummary`/`TimelineResponse` shapes, it `import type`s them from `@pierre-review/shared` (devDependency, types only) — erased at emit, so no runtime bridge. Same rule the core lives by.
- **Reaches DB / queries / LLM ONLY via `ctx`.** The plugin never does `import { db } from '@pierre-review/backend/dist/db/client.js'`. It uses `ctx.db`, `ctx.schema`, `ctx.runTransaction`, `ctx.queries.*`, `ctx.llm.complete`, `ctx.accountIdOf`. This keeps the boundary a single typed surface (`ProContext`), versionable via `apiVersion`, and means the host can refactor internals freely as long as `ctx` is stable.

Sample plugin (the whole thing):

```ts
// @pierre/pro — src/index.ts
import type { ProPlugin, ProContext, ProCapabilities } from './contract-types.js';
import { registerInboxDigestRoutes } from './inbox-digest/routes.js';
import { registerReviewMemoryRoutes } from './review-memory/routes.js';

const plugin: ProPlugin = {
  apiVersion: 1,
  async register(app, ctx): Promise<ProCapabilities> {
    // Self-gate: Pro is local-only for now (defense-in-depth, mirrors claude-review).
    if (ctx.host.isCloud) {
      ctx.log.warn('pro plugin loaded in cloud — disabling all Pro features');
      return { inboxDigest: false, reviewMemory: false };
    }
    await registerInboxDigestRoutes(app, ctx);
    await registerReviewMemoryRoutes(app, ctx);
    return { inboxDigest: true, reviewMemory: true };
  },
};
export default plugin;
```

`contract-types.ts` in the plugin is a **hand-copied, `import type`-only mirror** of the core's `contract.ts` interfaces (the same way the project already keeps "local `const` copies" to avoid shared runtime imports). It is structurally compatible because Fastify's contract is structural; the `apiVersion` number is the compatibility handshake.

Sample plugin route (note: `ctx.accountIdOf`, portable terminal `.execute()`):

```ts
// @pierre/pro — src/inbox-digest/routes.ts
import type { FastifyInstance } from 'fastify';
import type { ProContext } from './contract-types.js';

export async function registerInboxDigestRoutes(app: FastifyInstance, ctx: ProContext) {
  app.get('/api/pro/inbox/digest', { schema: { /* querystring repoIds */ } }, async (req) => {
    const accountId = ctx.accountIdOf(req);                 // scoping seam
    const repoIds = parseRepoIds(req);
    const out: RepoDigest[] = [];
    for (const repoId of repoIds) {
      // Reuse existing aggregations through the curated ctx.queries surface.
      const analytics = await ctx.queries.getRepoAnalytics(accountId, repoId);
      const open = await ctx.queries.getOpenPrs({ accountId, repoIds: [repoId] });
      const metrics = buildRepoMetrics(analytics, open);    // pure
      const { text } = await ctx.llm.complete({
        system: HEADLINES_SYSTEM,
        prompt: renderDigestPrompt(metrics),                // per-repo, not per-user
        maxTokens: 700,
      });
      out.push({ repoId, headline: text, metrics });
    }
    return { repos: out };
  });
}
```

---

## 7. Isolation & dual-dialect for plugin-supplied routes

Plugin routes are first-class Fastify routes on the host instance, so the **same** load-bearing rules apply, enforced through `ctx`:

- **Account isolation.** Every plugin list/feed query filters by `ctx.accountIdOf(req)`; every id-addressed read/write scopes ownership and returns 404 cross-account. Because the plugin can only obtain the account id via `ctx.accountIdOf`, there's no way for it to skip scoping by reaching `req.account.id` raw. **New id-addressed Pro routes must pass `verify:isolation`** — but that script lives in the public repo and seeds against the public schema. Two options: (a) the plugin ships its own `verify:isolation`-style test in its private CI against its own tables; (b) extend the host's `verify-isolation.ts` with an optional hook that, when the plugin is present, also exercises its getters. Recommend (a) for boundary cleanliness, with the host script documenting the requirement.

- **Dual-dialect storage for Pro-owned tables (WS3 review memory; possibly cached digests).** The plugin owns tables the core knows nothing about (`reviewMemory`, `reviewMemoryAction`, etc.). It must therefore carry **its own** `schema.sqlite.ts` + `schema.pg.ts` pair (parity kept by a plugin-side parity test) and its own `migrations/` + `migrations-pg/`. The host exposes `ctx.isPg` and `ctx.runTransaction`; the plugin's migration runner picks folder + migrator by `ctx.isPg` exactly like the core's `run-migrations.ts`. The cleanest seam: add a `ctx.registerMigrations(dir, dirPg)` callback that the host runs during `bindProPlugin` **before** the plugin registers routes (note: the core's `runMigrations()` at index.ts L16 runs before `buildApp`, so plugin migrations run slightly later — acceptable since Pro tables are independent; document that Pro migrations are applied at plugin-bind time, idempotently).

  Plugin queries use **portable terminals only**: `await q.execute()`, `.returning().execute()`, `onConflictDoUpdate` — never `.get()/.all()/.run()`, never `db.execute(sql)`. The plugin gets the node-postgres-typed `ctx.db`, so a stray `.get()` is a compile error in the plugin too (same guardrail). Pro tables that own GitHub entities denormalize `accountId` and use composite uniques (`(accountId, …)`) per the multi-tenancy rule; WS3's `reviewMemory` keys on `(accountId, repoId, pathGlob, category)`.

- **Transactions.** Multi-row writes (e.g. capturing a review interaction + its findings deltas) go through `ctx.runTransaction(async (tx) => …)`, taking the `tx` executor — the one dialect fork, handled by the host.

---

## Summary of files touched (OSS core, all additive)

| File | Change |
|---|---|
| `apps/backend/src/pro/contract.ts` | NEW — `ProPlugin`/`ProContext`/`ProCapabilities` + the capabilities singleton |
| `apps/backend/src/pro/bind.ts` | NEW — guarded `await import('@pierre/pro')`, context assembly, `register` call |
| `apps/backend/src/review/llm.ts` | NEW — cheap-tier (Haiku) `cheapComplete` seam (reuses existing Anthropic auth) |
| `apps/backend/src/index.ts` | +1 block after L41: `await bindProPlugin(app)` |
| `apps/backend/src/api/routes/me.ts` | +1 line: `pro: getProCapabilities()` |
| `packages/shared/src/types.ts` | extend `MeResponse` with `pro: ProCapabilities` (type-only) |
| `apps/frontend/src/hooks/useMe.ts` | `useProCapabilities()` selector |
| `apps/backend/src/config.ts` | optional `proEnabled: !isCloud` master gate |
| `scripts/build-release.mjs` | **no change required** (plugin never curated; asserts already pass) |

Everything premium (routes, LLM digest logic, review-memory storage + UI capture) lives in `@pierre/pro`. The public codebase contains only the **seam** (a contract, a guarded import, a capability passthrough) — no premium capability, no premium dependency, and a verified clean-degradation path on every public CI run where the plugin is absent.

---

## Appendix — Inbox tab — winning UI/UX (full design)

# Inbox Tab — Final Design: "Triage Console with a Briefing Feed"

**Verdict on the three approaches.** Approach C's master–detail is the only structure that resolves the load-bearing tension — *scan many repos* AND *drill one repo* — in a single view, and its left rail (zebra-tinted rows, thread mini-bars, sky-pulse selection) is the most native to Pierre because it literally re-skins the timeline's repo→contributor rail. So **C is the spine.** Its real weakness is that "state of play across ALL repos on first open" degrades to "state of play of *one* repo" — you must click each. **Approach B fixes exactly that**: its top-to-bottom briefing feed *is* the all-repos state of play. So I graft B's briefing feed in as the detail pane's **default "All repos" mode**, and reuse one `RepoSection` renderer at two densities. **Approach A's** real contribution is *vitals carried in the row itself* — I pull that into the rail so the rail alone is a multi-repo scan, but I **reject A's multi-column card grid** (variable-height masonry reflow, splits a repo's PR list across columns, and pits the digest against PR rows for vertical space — density without focus).

The result: the rail is the cross-repo triage glance; the detail defaults to a B-style briefing feed of *all* repos and narrows to a focused C-style single-repo console on selection. One rendering path, two densities.

---

## 1. Desktop layout (ASCII mockup)

The Inbox replaces the entire `<main>` (Timeline + DetailPane + pinned overlay slot) when `activeTab === 'inbox'`. It is a peer of Timeline via a header segmented control. The FilterBar stays (repo/member/range still scope the aggregate; categories/states hidden). Internally: a fixed **LEFT RAIL** of repos + a scrollable **RIGHT DETAIL**.

### Default — "All repos" selected (first-open = cross-repo briefing)

```
┌─ HEADER (App.tsx, unchanged) ───────────────────────────────────────────────────────────────┐
│ Pierre Review   [ Timeline | ●Inbox ]   <Feed> <Counts>   🔍  ⟳sync  Insights  ⚡Reviews  ? ◑ │
├─ FilterBar (REUSED) ─────────────────────────────────────────────────────────────────────────┤
│  + add repo │ Repos ▾ │ Members ▾ │ 7·14·30·90·custom                                          │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│┌─ LEFT RAIL (w-72) ───────────────────┐┌─ RIGHT DETAIL (flex-1, overflow-auto) ───────────────┐│
││ STATE OF PLAY      ↻ Refresh · 2m ago ││  All watched repos · 6 repos · 41 open · 7 stalled    ││
││ ───────────────────────────────────── ││  [ Sort: Attention ▾ ]   [ ☐ Hide quiet repos ]      ││
││ ▌▸ ALL REPOS          ● ████▏ 41  ◀──┐ ││ ════════════════════════════════════════════════════ ││
││   ─────────────────────────────────  │ ││ ╔══ acme/api ═══════════════ tint-0 (blue) ═══ ▾ ══╗ ││
││  ▌acme/api      🛡  ● ████▏▏  ⚠5 [12] │ ││ ║ 🛡 acme/api   12 open·3 draft·9 merged7d·2 ⏱      ║ ││
││   acme/web      🛡  ● ██▏▏▏▏  ⚠1 [6]  │ ││ ║              TTFR 5h · oldest unreviewed 3d      ║ ││
││   big/monorepo     ● ███▏▏▏  ⚠3 [7]  │ ││ ║ Threads ▕███▍██▎█▏  ●9 ●4 ●6 ●22                  ║ ││
││   acme/infra       █▏▏▏▏▏     ·  [1]  │ ││ ║ ┌ ✨ HEADLINES · Pro ──────────── Haiku·2m ─┐    ║ ││
││   acme/cli         ██▏▏▏▏    ⚠1 [4]   │ ││ ║ │ Auth refactor + 2 hotfixes from @maya;    │    ║ ││
││   old/legacy       ▏▏▏▏▏▏     ·  [—]  │ ││ ║ │ 9 untouched threads cluster in src/auth/**│    ║ ││
││                                       │ ││ ║ └───────────────────────────── regenerate ↻ ┘    ║ ││
││ ── legend ───────────────────────────  │ ││ ║ ▾ Maya Chen 🛡  3 PRs · 1 ⏱                       ║ ││
││ █untouched █replied █likely █resolved   │ ││ ║   ●#412 Rework token refresh ⚠1 ⏱ 🧵2·1·0·3 ⚡2▸║ ││
│└─────────────────────────────────────────┘ ││ ║   ●#409 Fix 500 on /sync    ✓approved ⚡1▸     ║ ││
│                                            ││ ║ ▸ Leo M 2 PRs   ▸ dependabot[bot] 4 PRs          ║ ││
│                                            ││ ╚══════════════════════════════════════════════════╝ ││
│                                            ││ ╔══ acme/web ═══════════════ tint-1 (purple) ═ ▸ ══╗ ││
│                                            ││ ║ 🛡 acme/web   6 open·1 draft·4 merged·0 ⏱  …  ▸  ║ ││
│                                            ││ ╚══════════════════════════════════════════════════╝ ││
│                                            ││  … remaining repos, attention-sorted, collapsed …    ││
│                                            │└──────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Rail row anatomy (one line, the multi-repo vitals scan):

```
 ▌acme/api      🛡  ●  ████▏▏  ⚠5  [12]
 │  └ owner/name  │   │   │       │    └ open-PR count, [—] = quiet repo
 │  (plain text)  │   │   │       └ attention badge: PRs w/ my-turn reason | stalled | untouched>0
 │                │   │   └ 4-seg thread MINI-BAR (DERIVED_STATE_META colors, repo-total)
 │                │   └ unread dot (any PR newSinceLastViewed != null)
 │  selected ──┘  └ MaintainerShield (viewer can merge here, from useMergers)
 │  sky-pulse left bar (ev-select-pulse vocabulary)
```

### Single repo selected (drill-down console)

Clicking a rail repo narrows the detail to that repo — no refetch, client-side. Same `RepoSection` renderer, expanded density; the all-feed's other sections drop away:

```
┌─ RIGHT DETAIL ───────────────────────────────────────────────────────────────┐
│ acme/api                                             🛡 4 maintainers           │
│ ┌ ✨ DIGEST · Pro ───────────────────────────────────── Haiku · 2m  ↻ regen ─┐ │  ← Pro only; absent → omitted
│ │ ▸ 4 PRs touching auth/* — @maya & @dee shipping the OAuth refactor.        │ │
│ │ ▸ 3 unresolved threads on db/migrations, all on @priya's #4120.            │ │
│ │ ▸ Throughput up: 6 merged vs 2 last week.                                  │ │
│ └────────────────────────────────────────────────────────────────────────────┘ │
│ ┌ STATS ──────────────────────────────────────────────────────────────────────┐ │
│ │ Open 12  Draft 3  Merged7d 9  Stalled 2 · TTFR 5h · oldest unreviewed 3d     │ │
│ └──────────────────────────────────────────────────────────────────────────────┘ │
│ ┌ THREAD STATE (repo total) ──────────────────────────────────────────────────┐ │
│ │ ▕████████▌▌▌▌░░░░▏  41   ●9 untouched ●4 replied ●6 likely ●22 resolved      │ │  ← click a segment → soft-filters PRs below
│ └──────────────────────────────────────────────────────────────────────────────┘ │
│ ┌ PRs BY AUTHOR ──────────────────────────────────────────────────────────────┐ │
│ │ ▾ Maya Chen 🛡 (3)                                                            │ │
│ │   ●#412 Rework token refresh    ⚠1 ⏱   🧵2·1·0·3   ⚡2 ▸                       │ │
│ │      └▾ ⚡ 2 Claude reviews                                                    │ │
│ │         • 4f1c2  REQUEST_CHANGES · 3 findings · posted 2d · $0.04  [Open ▸]   │ │
│ │         • 88de0  COMMENT · 1 finding · not posted · 4d            [Open ▸]   │ │
│ │   ●#409 Fix 500 on /sync        ✓approved   🧵0·0·0·5   ⚡1 ▸                  │ │
│ │ ▸ Leo M (2)     ▸ dependabot[bot] (4)                                         │ │
│ └──────────────────────────────────────────────────────────────────────────────┘ │
│ ┌ CLAUDE REVIEWS · this repo ───────────────────────────────── 9 runs / 6 PRs ─┐ │
│ │ #412 REQUEST_CHANGES · 2d · Maya   [▸]      #409 APPROVE · 5d · posted ✓ [▸]  │ │
│ └──────────────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────┘
```

Glyph key (all from `lib/ui.ts`, zero new vocabulary): `●` open / `◐` draft (`PR_STATE_META`); `✓n`/`⚠n` reviewers approved/changes-requested; `✗CI`/`✓CI` (`CI_META`); `⏱` stalled (`REASON_META`); `🧵 a·b·c·d` = `untouched·replied_unresolved·likely_addressed·resolved` colored from `DERIVED_STATE_META`; `⚡n` prior Claude runs, tinted by latest verdict (APPROVE green / REQUEST_CHANGES red / COMMENT grey); `🛡` `MaintainerShield`.

**Responsiveness.** Below ~900px the master–detail collapses to one column: the rail becomes a horizontal-scroll chip strip pinned top (name + mini-bar + attention badge); tapping a chip swaps the detail below with a back-chevron returning to "All repos". Below ~600px the digest + charts stack full-width and PRs-by-author groups start collapsed. The FilterBar keeps its own responsive collapse.

---

## 2. Information architecture (repo-oriented, coarse → fine)

**The rail is the spine; the detail narrows from all-repos to one-repo.** Six disclosure tiers:

- **Tier 0 — Rail (glance, all repos at once).** One `getInbox` call. Each row carries A-style vitals: name, `MaintainerShield`, unread dot, attention badge, 4-segment thread mini-bar (repo-total `ThreadStateCounts`), open count. A pinned **ALL REPOS** pseudo-row at top aggregates the same. This is the triage surface. Rail sort: attention badge desc → unread → alphabetical, computed once per load/refresh (stable, not jumpy).
- **Tier 1 — Detail mode = ALL (the briefing feed, B).** Default on first open. Stacked, attention-sorted, collapsible `RepoSection`s — header stats + thread bar + digest banner + a *collapsed* PRs-by-author summary. This is the "state of play across ALL repos" the brief demands, read top-to-bottom.
- **Tier 2 — Detail mode = single repo (the console, C).** Selecting a rail repo expands one `RepoSection` to full density in B's strict narrative order: **Digest → Stats → Thread State → PRs-by-author → Claude Reviews**.
- **Tier 3 — Stats + Thread State.** `RepoInsights` subset (open/draft/merged7d/stalled/TTFR/oldest-unreviewed) + a `DERIVED_STATE_META` stacked bar of the repo-summed `ThreadStateCounts`. The "unresolved" the brief mentions is the code's `replied_unresolved`; the UI labels it "Replied (unresolved)". Clicking a segment soft-filters the PR list (no refetch).
- **Tier 4 — PRs by author.** Open PRs grouped by `authorId`. Group header = `Avatar` + `UserName repoId={…}` (inline shield) + count + a tiny roll-up dot. Author with an attention PR expands by default; quiet authors and bots collapse, bots last. PR rows show `#number Title` (PR name), reason/CI chips, per-PR thread mini-bar, `⚡n` badge. Expansion state persisted to `localStorage['pierre:inboxExpanded']` (A's idea), re-asserted after refresh.
- **Tier 5 — Prior Claude reviews.** Badge-then-expand on each PR row (inline drawer, newest-first runs) **and** a repo-level CLAUDE REVIEWS card at the bottom. No new storage — see §4.

**Clicking a PR row never leaves Inbox** — it pins the PR (`usePinnedTabs.pin` + `setActiveTab(prId)`) into the existing overlay, so the user drills in and returns. Inbox and pinned-PR overlays share one `activeTab` axis and never both render.

---

## 3. Interaction model

- **First open:** `useInbox` fires once with `staleTime: Infinity`, `refetchOnMount: false` (mirrors the IndexedDB-cached PR/thread queries — snapshot intent, no silent refetch under you). Auto-selects **ALL REPOS**. Rail skeletons only the badges/mini-bars (repo names already known from `useRepos`, so headers paint instantly); the briefing feed cross-fades in.
- **Refresh button:** top of the rail header (`STATE OF PLAY  ↻ Refresh · 2m ago`) — the rail header owns it because Refresh re-pulls the whole multi-repo aggregate. Click → `invalidateQueries(['inbox', accountId, repoIds])`. Spinner on the glyph; rail + detail keep last data dimmed to ~60% with a thin top progress hairline, then cross-fade — **never blank** (the "modal covers timeline" lesson). Refresh re-queries the **DB read layer only**; it does *not* trigger a GitHub sync. Copy is "Refresh" (data view), not "Sync".
- **Staleness:** `generatedAt` drives `relativeTime()` ("2m ago"), ticking on a cheap 30s timer (no fetch). Past ~10m it turns amber ("12m ago — refresh?"). Per-repo `lastIncrementalSyncAt` renders as a small `⟳` chip; if a background sync landed since, the label nudges "new activity synced — refresh".
- **Selecting a repo / segment filter / expand-collapse:** all client-side, no refetch.
- **Digest (Pro):** a separate per-repo query (`useRepoDigest(repoId)`) so a slow Haiku call never blocks the core grid. In the all-feed it shows a one-line teaser lazily (only for in-view/expanded sections — no per-repo LLM call up front); full prose on drill-down. Cached server-side by a `(repoId, head-SHAs fingerprint)` so re-selecting/refresh is free unless activity changed; `↻ regenerate` forces a run (warns if recent, like re-review).

---

## 4. The Pro pieces (gated exactly like `claudeReviewEnabled`)

**Per-repo headlines digest (the only flagged surface).** Renders at the **top of the detail** (single-repo) / as the banner inside each `RepoSection` (all-feed). Per-repo prose (never per-user): types of changes, who's driving them, summaries of unresolved threads, a "level of change" line — Haiku over the `InboxRepo` metric packet + `replied_unresolved`/`untouched` thread excerpts; cheap-tier LLM seam, swappable. Capability flows via `inboxDigestEnabled: boolean` on `MeResponse`, read `me.data?.inboxDigestEnabled ?? false`. The endpoint lives in `@pierre/pro`, bound at runtime — **absent → route 404, flag false, banner simply not rendered** (no greyed teaser, no upsell stub in cards). The non-AI Stats + Thread-State cards + per-author roll-ups *are* the "high-level summary", so a Pro-less tab reads complete. One optional dismissible "✨ Enable digests" one-liner may sit in the rail footer — never inside cards.

**Prior Claude reviews — repo-oriented RETRIEVAL, no new storage.** The data already persists every run keyed `(prId, headSha)` with a direct `accountId` column; what's missing is repo-scoped retrieval (the existing `listAllClaudeReviews` is too lossy). Add `listClaudeReviewsByRepo(repoId, accountId)` → runs grouped by `prId`. Surfaced two ways, both collapsed by default: the inline `⚡n ▸` badge (per-PR `listClaudeReviewHistory`) and the repo-level CLAUDE REVIEWS card. `[Open ▸]` routes into the existing `ClaudeReviewsModal`/per-PR view at that `reviewId`. This same expand drawer is the natural future home for Workstream 3's "actions taken on this review".

---

## 5. State, URL, endpoints

**Frontend state.**
- `ActiveTab = 'timeline' | 'inbox' | number` in `store/pinnedTabs.ts` — reuses the `<main>` overlay slot, `inert` a11y, Escape→`showTimeline()` precedence, and (load-bearing) **every `filters.ts` nav action already calls `showTimeline()`**, so any timeline navigation auto-exits Inbox for free.
- `store/filters.ts`: `inboxRepoId: number | 'all' | null`, `inboxThreadFilter: DerivedState | null` — transient; add to `freshDefaults()` but **NOT** to `pickFilterBarState`/`sanitizePersistedFilters` (mirror `myTurnOnly`/`insightsOpen` exclusion). Expansion/sort/hide-quiet → `localStorage['pierre:inboxExpanded']` / `['pierre:inboxPrefs']`.

**URL (`useUrlState.ts`).** `?view=inbox` and `?inboxRepo=<id>` are deep-linkable (read in `readFromUrl`, write only when non-default). `inboxThreadFilter` stays URL-silent. Existing `repos`/`users`/`preset` still scope the aggregate.

**Backend (all `accountIdOf(req)`-scoped, no AI, public repo):**
- `GET /api/inbox?repoIds` → `getInbox(accountId, repoIds?)` in `queries.ts`: per-repo `{ stats (RepoInsights subset), threadTotals (NEW — sum buildThreadCounts over open-PR ids, the one genuinely missing aggregation), maintainerIds, attentionCount, hasUnread, prs (TimelinePr-shaped) }` + `generatedAt`. Lives inside `queries.ts` because `buildTimelinePrs`/`buildThreadCounts`/`isStalled` are module-private.
- `GET /api/repos/:id/claude-reviews` → `listClaudeReviewsByRepo` (retrieval only; no schema change). New id-route → **must pass `verify:isolation`** (404 on cross-account repo); gated on `config.claudeReviewEnabled`.
- `GET /api/inbox/repos/:id/digest` → **in `@pierre/pro`, runtime-bound** (Workstream-1 plugin seam); consumes the `InboxRepo` packet; absent → unregistered.

Conventions honored: dual-dialect (no schema change needed for core; if `threadTotals` needs nothing persisted, it's pure read); portable async terminals only; `inboxDigestEnabled` added to `MeResponse` in `packages/shared` (`import type` only); the Pro digest never appears in the published `package.json` (dynamic import).

---

## 6. What I took from each / what I rejected

**From C (the spine):** master–detail; the rail with thread mini-bars, attention badges, unread dots, sky-pulse selection and rank-parity zebra tints (most native — it re-skins the timeline rail); auto-select; transient `inboxRepoId`; thread-segment soft filter; digest at top of detail; repo-level Claude card + inline badge; PR-row → pinned tab.

**From B (the first-open fix):** the briefing feed as the **ALL-REPOS detail mode** (so first open is a true cross-repo state of play, not one repo); the strict Stats → Thread → Digest → People → PRs → Reviews narrative order; attention-weighted sort; the digest banner provenance/styling; single-column, reflow-free detail.

**From A (the rail enrichment):** vitals carried *in the row* so the rail alone scans many repos; per-user progressive disclosure with bots-last; `localStorage` expansion persistence; the `⚡` repo roll-up.

**Rejected:** A's **multi-column card grid** — variable-height masonry reflow, splits a repo's PR list across columns, and the in-card digest competes with PR rows for vertical space; it gives density but loses focused drill-down. B's **pure endless single scroll with no overview** — with 20+ repos there's no glance-all triage; we keep B's feed but gate it behind the rail and an "All" selection. C's **thin name+count rail** — not enough to triage without clicking, so it's enriched with A's vitals and B's teaser. And **eager per-repo digest fetches across the all-feed** — cost-prohibitive; digests load lazily for in-view/expanded sections only.

---

## Appendix — Per-repo LLM digest (full design)

# Design: Per-repo LLM "headlines digest" (Pro, flagged) — `@pierre/pro`

**Model decision (from `claude-api` skill):** cheap tier = **`claude-haiku-4-5`** — $1.00 / 1M input, $5.00 / 1M output, 200K context, 64K max output. Single-shot, non-agentic, no tools, no thinking (effort/adaptive add cost and `effort` 400s on Haiku — omit both).

---

## 1. Metrics-retrieval mechanism — the "repo digest payload" assembler

A **pure, deterministic assembler** living in `@pierre/pro` that fans out across the EXISTING account-scoped read layer (no new sync, no new GitHub calls) and folds the results into a compact, token-budgeted JSON object per repo. It reuses, in one pass:

- `getInsights({ accountId, repoIds:[repoId] })` → `RepoInsights` (queries.ts L823): `openPrs`, `draftPrs`, `mergedLast7d`, `stalledPrs`, `medianHoursToFirstReview`, `oldestUnreviewed`, `reviewLoad[]`, `openPrList: InsightsOpenPr[]` (each carries `authorId`, `isStalled`, `isDraft`, `openedAt`).
- `getOpenPrs({ accountId, repoIds:[repoId] })` → `TimelinePr[]` — each carries `repoId`, `authorId`, `threadCounts: ThreadStateCounts` (`{resolved, likely_addressed, replied_unresolved, untouched}`), `reasonTag`, `isStalled`, `isApproved`, `isChangesRequested`. **This is the per-PR thread-state + triage source.** Summing `threadCounts` over the repo's open PRs gives the per-repo thread-state total the Inbox needs (the gap #2 the data map flagged — no `buildThreadCounts` export required, since `getOpenPrs` already surfaces it per PR).
- `getTimeline({ accountId, from: now−Nd, to: now, repoIds:[repoId], types:[…], excludeBots:true })` → `events[]` — windowed event stream for "what changed and by whom" (pr_opened / pr_merged / review_submitted / review_comment / commit_pushed). Folded into per-author and per-type counts, NOT passed raw.
- Optionally `getRepoAnalytics(accountId, repoId)` for the `level-of-change` trend signal (`throughput`, `reviewLatencyTrend`) — only the latest 2–3 weekly buckets, to keep tokens down.
- `getMergers(accountId)` for the maintainer set (who can merge).
- User display names resolved once from the global `users` table (already returned alongside these queries).

The assembler is the metrics seam — both the AI digest (this workstream) and the AI-free core Inbox can call the same core-side aggregator. **Recommendation:** add the deterministic per-repo aggregate `getInbox(accountId, repoIds?)` to the OSS core (queries.ts, account-scoped, `verify:isolation`-covered), returning the raw repo→{stats, prsByAuthor, threadTotals, claudeReviews} structure. `@pierre/pro` then consumes `getInbox`'s output and shapes the **token-efficient payload** below — so the public repo holds the aggregation (reusable, non-premium) and the private package holds only the compaction + LLM call.

### Payload shape (`RepoDigestPayload` — compact, ~1.5–4K tokens/repo)

Deterministic, grounding-friendly. Names/numbers only; no prose, no bodies, no diffs. Counts and short labels — never raw event arrays.

```jsonc
{
  "repo": "owner/name",
  "window_days": 14,
  "generated_at": "2026-06-29T…",
  "stats": {
    "open": 23, "draft": 4, "merged_window": 11, "stalled": 5,
    "median_hours_to_first_review": 9.5,
    "oldest_unreviewed": { "pr": 412, "title": "…", "age_hours": 73 }
  },
  "threads": {                      // SUM of TimelinePr.threadCounts across open PRs
    "untouched": 14, "replied_unresolved": 6,
    "likely_addressed": 9, "resolved": 31
  },
  "change_signal": {                // from getRepoAnalytics latest buckets — the "level of change"
    "throughput_this_week": { "opened": 8, "merged": 5, "closed": 2 },
    "throughput_prev_week": { "opened": 3, "merged": 4, "closed": 1 },
    "trend": "rising"               // derived: rising | steady | falling
  },
  "contributors": [                 // folded from getOpenPrs + windowed getTimeline counts
    { "user": "alice", "open_prs": 5, "merged_window": 3,
      "reviews_given": 7, "comments": 12, "maintainer": true,
      "areas": ["api/", "db/"] }    // optional: top changed-path prefixes (from commitFiles if cheap; else omit)
  ],
  "prs": [                          // capped (≤25, oldest-first), the "PR names" the Inbox shows
    { "pr": 412, "title": "Add OAuth callback", "author": "bob",
      "state": "open", "stalled": true, "approved": false,
      "changes_requested": true, "reason": "untouched_threads",
      "threads": { "untouched": 3, "replied_unresolved": 1,
                   "likely_addressed": 0, "resolved": 2 },
      "age_hours": 73,
      "claude_reviewed": true, "claude_verdict": "REQUEST_CHANGES" }
  ],
  "unresolved_thread_digest": [     // the substantive "threads not resolved" feed, capped ≤15
    { "pr": 412, "path": "api/auth.ts", "state": "untouched",
      "excerpt": "Token isn't validated before…" }   // reviewComments.excerpt — already stored, lean-safe
  ]
}
```

`reviewComments.excerpt` is always populated (even under lean storage), so `unresolved_thread_digest` needs no hydration. Cap every array; the payload is bounded regardless of repo size (a 900-PR repo still emits ≤25 PR rows + ≤15 thread rows).

**Per-PR variant.** Same assembler keyed by `prId` (reuse `getPrDetail` + `listClaudeReviewHistory(prId)`) emits a `PrDigestPayload` (single PR's threads, reviews, change counts) — for an optional per-PR "what changed here" expansion. Same shape, one element.

---

## 2. The cheap-tier LLM call — swappable OpenAI-compatible seam

A single-shot, non-agentic completion behind a provider-agnostic interface, so the model swaps by config later.

```ts
// @pierre/pro/src/llm/seam.ts — OpenAI-compatible shape (NOT the Agent SDK)
export interface LlmClient {
  complete(req: {
    system: string;
    user: string;
    maxTokens: number;
    // no tools, no thinking — cheap single-shot
  }): Promise<{ text: string; inputTokens: number; outputTokens: number; costUsd: number }>;
}
```

- **Default impl** = `AnthropicHaikuClient` backed by `@anthropic-ai/sdk` `client.messages.create({ model: "claude-haiku-4-5", max_tokens, system:[{type:"text", text:SYSTEM, cache_control:{type:"ephemeral"}}], messages:[{role:"user", content: JSON.stringify(payload)}] })`. No `thinking`, no `effort`, no tools.
- The interface is **OpenAI-compatible-shaped** (system + user + maxTokens → text) so a future `OpenAiCompatibleClient` (GPT/Gemini/local via `/v1/chat/completions`) drops in by changing one config value `config.pro.digestModel` / `config.pro.digestProvider`. The model id is **never hardcoded in call sites** — it lives in `@pierre/pro` config, defaulting to `claude-haiku-4-5`.
- **Auth** reuses the existing local key seam: `ANTHROPIC_API_KEY` ambient, or the user-supplied key already wired via `review/local-settings.ts` / `PUT /api/claude-review/key`. Pro digest and Claude Review share the same key source.

**Grounding instruction (system prompt, cached across repos):**

> You are summarizing GitHub repository activity for an engineering team. You will receive a JSON object of pre-computed metrics for ONE repository. Write a short headline briefing (3–6 sentences) of what is happening: the types of changes being made, who is driving them, the level of change vs. the prior period, and which review threads remain unresolved and need attention. **Use ONLY the numbers and names present in the JSON. Do not invent PRs, people, files, counts, or events. If a field is absent, omit it. Do not speculate about intent.** Lead with the level-of-change signal. Output plain prose, no markdown headers.

The grounding ("use only the payload; do not invent") is load-bearing — the payload is the sole source of truth, which also makes the output auditable against `stats`/`prs`.

**Token & cost ballpark (per repo, per regeneration):**
- Input: system+grounding ~400 tokens (prompt-cached → ~0.1× after first repo in a batch) + payload ~1.5–4K tokens.
- Output: ~300–600 tokens (3–6 sentences).
- Cost: input ≈ 3K × $1/1M = **$0.003**, output ≈ 500 × $5/1M = **$0.0025** → **~$0.005–0.006 per repo**. With the system prompt cached across a multi-repo refresh, marginal repos are input-payload-only (~$0.004). A 10-repo workspace ≈ **$0.05 per full refresh**.

---

## 3. Caching / refresh — regenerate only when the repo changed

Digests are keyed to a **repo content hash** so a dormant repo never regenerates.

- **Activity key** = the repo's latest event `occurredAt` (cheap `MAX(events.occurredAt) WHERE repoId=…`) combined with a **payload content hash** (`sha256` of the canonicalized `RepoDigestPayload` minus `generated_at`). The payload hash is the real guard — it captures stats/threads/PR changes, so a digest regenerates iff the underlying metrics moved, not merely on any event.
- **Storage** (new Pro-owned table, dual-dialect, account-scoped — but defined/migrated by `@pierre/pro` so the public schema stays clean; see Workstream 1's runtime-binding contract): `repoDigests(id, accountId, repoId, payloadHash, latestEventAt, model, summary, costUsd, inputTokens, outputTokens, createdAt)`, unique `(accountId, repoId)`, upsert on regenerate. History optional (keep last N for a "level of change over time" view).
- **Refresh trigger:** generation is tied to the **Inbox Refresh action** and/or first-open, never a background sweep. On Inbox open / Refresh, for each watched repo: compute `payloadHash`; if it matches the stored row → serve cached summary (free); else → call Haiku, upsert. So clicking Refresh on an unchanged board costs **$0**.
- **Dormancy gate:** reuse the cloud `accounts.lastActiveAt` activity gate exactly as periodic sync does — generation only happens on a request from a loaded SPA (an active tab). No tenant with no open tab is ever digested. There is **no cron / no background fan-out** across tenants. (Local mode: always-on, but still only on Refresh/open.)
- **Concurrency:** per-account in-flight set (mirror `review-manager`'s one-job pattern) so a double-click doesn't double-bill; a budget cap (below) bounds a single Refresh.

---

## 4. Backend endpoint (plugin-supplied) + render location

**Endpoint (defined in `@pierre/pro`, bound at runtime into Fastify):**

```
GET  /api/pro/inbox/digests?repoIds=…   → { digests: RepoDigest[], enabled, model, generatedAt }
POST /api/pro/inbox/digests/refresh     → 202 { started } | 200 { unchanged } ; regenerates changed repos
GET  /api/pro/inbox/digests/:repoId     → single repo digest (+ optional ?prId for per-PR)
```

- `accountId`-scoped via `accountIdOf(req)`; every repo getter verifies ownership → 404. Passes `verify:isolation` (new id-routes).
- Routes are **only registered when the Pro plugin is present AND `config.pro.digestEnabled` is true** — identical pattern to how `claude-review` routes are conditionally registered. Absent plugin or flag off → routes don't exist (404), exactly like Claude Review in cloud.
- Capability advertised to the frontend through `/api/me` as `proDigestEnabled: boolean` (mirrors `claudeReviewEnabled`/`deploymentMode` flow). Frontend reads it from `useMe()`.

**Render location (Inbox tab, per-repo section):** each watched-repo block in the Inbox renders a **digest banner** at the top of that repo's card — above the per-user PR groups, stats, and thread-state breakdown. The banner shows the Haiku summary prose, a small "AI summary · Haiku" label, the `generatedAt` time, and a per-repo refresh affordance. The AI banner is the ONLY flagged element on the card; everything below it (PR groups, stats, thread totals, prior Claude reviews) is the AI-free core that renders identically with or without Pro.

**Graceful absence:** when `proDigestEnabled` is false (plugin not installed, flag off, or no LLM key) the frontend simply **omits the digest banner** — the rest of the repo card renders unchanged from existing aggregations. No empty state, no error, no layout shift placeholder beyond a subtle "Enable AI summaries" hint if the user has Pro but no key (reusing the Claude Review no-key affordance). The Inbox tab itself is core and always present (Workstream 2 invariant).

---

## 5. Cost guardrails + future model-swap

- **Flag-gated, off by default:** `config.pro.digestEnabled` (default `false`) AND requires the Pro plugin present AND an LLM key resolvable. Three independent gates, all must pass.
- **On-demand only:** generation fires solely on Inbox open / explicit Refresh, never on a timer or background sweep. Dormant tenants (no active tab via `lastActiveAt`) never generate.
- **Budget cap:** `config.pro.digestMaxUsdPerRefresh` (e.g. $0.50) and `digestMaxReposPerRefresh` (e.g. 30) — a single Refresh stops calling Haiku once the cap is hit, returning partial digests + a "budget reached" marker; remaining repos serve last-cached or "not yet generated". Per-run cost accumulated from `usage` (input/output tokens × rate) and persisted on each `repoDigests` row.
- **Rate-limit:** per-account min interval between full Refreshes (e.g. 60s) + the per-account in-flight gate; payload-hash caching means repeated Refreshes on an unchanged board are free and instant.
- **Content cap:** every payload array is bounded (≤25 PRs, ≤15 threads), so input tokens are bounded regardless of repo size — a runaway repo can't blow the budget.
- **Prompt caching:** the cached system+grounding block makes multi-repo refreshes cheaper (marginal repos pay input-payload only).
- **Swappable model:** the model id and provider live in `@pierre/pro` config (`digestModel` / `digestProvider`), consumed only by the `LlmClient` factory. Default `claude-haiku-4-5` via `AnthropicHaikuClient`; swapping to a cheaper/newer tier (or an OpenAI-compatible endpoint) is a config change + an alternate `LlmClient` impl — zero call-site changes, because every call goes through the `LlmClient.complete()` seam.

**Net:** a 10-repo active workspace pays ~$0.05 for a full cold Refresh and $0 for any Refresh where nothing changed; cost scales only with genuine repo change, gated behind flag + plugin + key + budget, on-demand, never background.

---

## Appendix — Claude Review learnings/memory (full design)

I now have the exact seams confirmed. Here is the design.

---

# Workstream 3 — Pro-only Claude Review Learnings / Memory: design

Confirmed against the code: findings carry `path` / `severity` / `title` / `body` / `editedBody` / `included` / `postedCommentKind`; reviews carry `summary` / `verdict` (Claude, read-only) vs `userBody` / `userVerdict` (user); repo is joinable `claudeReviews.prId → pullRequests.repoId`. `buildUserPrompt` has no prior-context slot today; `RunReviewArgs` is the single struct threaded into `runReview`. No table stores the *interaction*, only the resulting state — so capture needs new, **plugin-owned** storage.

The whole design rests on **one rule**: core stays inert and premium-free. Core gains (a) an inert typed event emitter, (b) an optional pass-through prompt slot, (c) a capability registry surfaced on `/api/me`, (d) a plugin loader. Everything that *captures, stores, retrieves, ranks, renders-context, and serves UI data* lives in `@pierre/pro`.

---

## 0. The core seam (minimal, premium-free) — prerequisite for all three parts

Four small, generic additions to the public repo. None of them know what a "learning" is.

**0.1 `apps/backend/src/review/events.ts` (NEW, ~30 lines) — inert typed emitter.**
```ts
// A tiny typed pub/sub. Zero subscribers in OSS mode ⇒ every emit is a no-op.
export type ReviewEvent =
  | { type: 'finding.updated'; accountId; findingId; change: { included?: boolean; editedBody?: string | null } }
  | { type: 'finding.posted';  accountId; findingId; postedCommentKind: 'inline'|'pr_comment' }
  | { type: 'review.draftUpdated'; accountId; reviewId; change: { userBody?: string; userVerdict?: Verdict } }
  | { type: 'review.posted';   accountId; reviewId; userVerdict: Verdict; inlineFindingIds: number[]; prCommentFindingIds: number[] }
  | { type: 'review.requested'; accountId; prId; model; requestedMode };
export const reviewEvents = new EventEmitter(); // emit(e.type, e)
```
Payloads carry **identity + the delta only** (no repoId/path enrichment). The subscriber (Pro) enriches by reading core tables through the shared `db`. This keeps each core emit a trivial one-liner and puts *all* domain logic in the plugin.

**0.2 Emit sites — 5 one-liners in `api/routes/claude-review.ts`** (after the existing successful persist, before `reply.send`):

| Existing handler (from the map) | Add after success |
|---|---|
| `PATCH /api/claude-findings/:findingId` (L320, `updateFinding`) | `reviewEvents.emit('finding.updated', {accountId, findingId, change:{included, editedBody}})` |
| `POST /api/claude-findings/:findingId/post` (L342, `markFindingPosted`) | `reviewEvents.emit('finding.posted', {accountId, findingId, postedCommentKind})` |
| `PATCH /api/claude-reviews/:reviewId` (L303, `updateReviewDraft`) | `reviewEvents.emit('review.draftUpdated', {accountId, reviewId, change})` |
| `POST /api/claude-reviews/:reviewId/post` (L446, `markReviewPosted`) | `reviewEvents.emit('review.posted', {accountId, reviewId, userVerdict, inlineFindingIds, prCommentFindingIds})` |
| `POST /api/prs/:id/claude-review` (L194, `startReview`) | `reviewEvents.emit('review.requested', {accountId, prId, model, requestedMode})` |

These fire **only on the real persisted change** (so `included` toggles, reword saves, draft saves, posts, and run kickoffs are each captured once). `accountId` is already `accountIdOf(req)` in every handler.

**0.3 Optional pass-through prompt slot (the injection seam).**
- `buildUserPrompt` (`prompt.ts` L207) gains `priorReviewContext?: string` — when present, spliced as a `## Reviewer preferences from past reviews` section **before `## Diff`**. Core does no interpretation; it renders a string the plugin produced.
- `RunReviewArgs` (`agent.ts` L55) gains `priorReviewContext?: string`; the L274 call site passes `priorReviewContext: args.priorReviewContext`.
- `review-manager.ts` `startReview` (L48), before `runReview`, calls a registered provider if one exists: `const ctx = await learningsProvider?.buildContext({accountId, prId, headSha}); runReview({...args, priorReviewContext: ctx})`. `learningsProvider` is a single nullable callback the plugin registers (default null ⇒ OSS unchanged).

**0.4 Capability registry surfaced on `/api/me`.**
- `apps/backend/src/plugins/capabilities.ts` (NEW): a mutable `Set<string>` + `register(cap)`. `/api/me` (route already returns `claudeReviewEnabled`) adds `capabilities: string[]`. Pro registers `'review.learnings'` when it binds. Frontend reads `me.capabilities.includes('review.learnings')` exactly as it reads `claudeReviewEnabled` today.

**0.5 Plugin loader `apps/backend/src/plugins/pro.ts` (NEW, the open-core boundary).**
```ts
export async function loadProPlugin(app, deps) {
  try {
    const pro = await import('@pierre/pro');         // absent ⇒ catch ⇒ OSS mode
    await pro.register({ app, db, isPg, schema, config, accountIdOf,
                         reviewEvents, registerLearningsProvider, registerCapability });
  } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') log.warn(e); /* graceful */ }
}
```
Called once in `app.ts` after core routes register. `@pierre/pro` is **never** in the published `package.json` (Workstream 1) so `build-release.mjs` asserts pass; the dynamic import simply fails closed.

That is the entire core footprint. Everything below is inside `@pierre/pro`.

---

## 1. CAPTURE HOOKS — what each interaction records (all in `@pierre/pro`)

The plugin subscribes once: `reviewEvents.on('finding.updated', enrich→insert)` etc. Each handler **enriches** the thin core event by reading core tables through `ctx.db` (portable `.execute()` terminals, scoped by the event's `accountId`), then appends one append-only row. Enrichment join (already used by `getFindingPostContext`): `findingId → claudeReviewFindings(path, severity, body, editedBody) → reviewId → claudeReviews(prId, headSha) → pullRequests(repoId)`.

| Event | `kind` written | Captured columns |
|---|---|---|
| `finding.updated` with `included:false` | `finding_dismissed` | repoId, prId, sourceReviewId, findingId, headSha, path, dirPath, ext, category(=severity), claudeTitle, claudeText(=body), createdAt |
| `finding.updated` with `included:true` (re-include) | `finding_kept` | same; signals an explicit accept |
| `finding.updated` with `editedBody` (non-empty) | `finding_reworded` | same + `userText`(=editedBody) — the richest wording-correction signal (Claude `body` vs user `editedBody`) |
| `finding.updated` with `editedBody:''` | `finding_reword_cleared` | revert signal (low weight) |
| `finding.posted` | `finding_posted` | same + `postedCommentKind`; strong endorsement |
| `review.draftUpdated` (`userBody`) | `review_body_rewritten` | repoId, prId, sourceReviewId, headSha, claudeText(=`summary`), userText(=`userBody`) |
| `review.draftUpdated` (`userVerdict`) ≠ Claude `verdict` | `verdict_overridden` | + claudeVerdict, userVerdict (PR-scope divergence) |
| `review.posted` | `review_posted` | userVerdict + the **ground-truth split**: which findingIds shipped (inline + prComment) vs which were dismissed for this review (derivable from `included`) |
| `review.requested` | `run_requested` | model, requestedMode — per-repo depth/model preference |

**Idempotency:** the table is append-only (an event log of *what the reviewer did over time*), but to avoid duplicate rows from rapid toggles, each row carries a `dedupeKey = hash(kind,findingId|reviewId,headSha, normalize(text))` with a unique index `(accountId, dedupeKey)` and `onConflictDoUpdate` bumping `createdAt` — so toggling a finding off/on/off collapses to its latest state, matching the existing "structural idempotency" convention.

**Path-glob derivation (at capture, stored denormalized for indexable retrieval):**
- `path` = finding path verbatim.
- `dirPath` = POSIX `dirname(path)` (e.g. `apps/backend/src/api/routes`).
- `ext` = extension incl. compound where useful (`.ts`, `.tsx`, `.sql`).
Storing the two *components* (not a glob string) keeps matching portable and indexable across SQLite/Postgres — retrieval matches by `dirPath` equality/prefix + `ext` equality (Section 3). A human-readable glob (`apps/backend/src/api/routes/*.ts`) is reconstructed for display only.

---

## 2. STORAGE — plugin-owned, dual-dialect, accountId-scoped

**Recommendation: tables live in the PLUGIN, not core.** Rationale tied to the spec ("the PUBLIC repo must contain NO premium backend capability"): a learnings schema *is* premium backend surface. Keeping it in `@pierre/pro` means it is absent from the public `schema.sqlite.ts`/`schema.pg.ts` and therefore **not** subject to `schema-parity.test.ts` (which only guards the two core schemas) and not in the release tarball. The plugin ships its own dual-dialect twin internally and its own migrator.

**How plugin migrations run.** `pro.register(ctx)` calls `await pro.migrate({db, isPg})` at bind time. The plugin keeps `pro/migrations/` (sqlite) + `pro/migrations-pg/` (pg) exactly like core, and a tiny runner that, on the shared `db` handle, applies any unapplied files (tracked in its own `pro_migrations` bookkeeping table) using portable `.execute()`. Because it runs against the *same* connection after core's `run-migrations.ts`, it composes cleanly in both local (SQLite) and cloud (Postgres) — though note this feature is local-only in practice (Claude Review is force-disabled in cloud), the Postgres twin is kept for parity discipline and self-host completeness. The plugin uses `CREATE TABLE IF NOT EXISTS` (idempotent first-run create) so a fresh install with the plugin present self-provisions.

**Table `review_learnings`** (append-only event log; sqlite shown, pg twin identical names with `timestamptz`/`bigserial`/`jsonb`):

| column | type | notes |
|---|---|---|
| `id` | integer PK autoinc | |
| `accountId` | integer NOT NULL | **isolation column** — every query filters it |
| `repoId` | integer NOT NULL | denormalized for repo-oriented retrieval |
| `prId` | integer NOT NULL | |
| `sourceReviewId` | integer NOT NULL | `claudeReviews.id` |
| `findingId` | integer | null for review-level events |
| `headSha` | text NOT NULL | |
| `kind` | text enum | the 9 kinds above |
| `path` | text | null for review-level |
| `dirPath` | text | dirname, indexed |
| `ext` | text | extension, indexed |
| `category` | text enum | severity: blocker/warning/nit/question/praise |
| `claudeVerdict` | text | for verdict_overridden / review_posted |
| `userVerdict` | text | |
| `claudeTitle` | text | finding title |
| `claudeText` | text | Claude's `body` / review `summary` |
| `userText` | text | `editedBody` / `userBody` |
| `postedCommentKind` | text | inline / pr_comment |
| `dedupeKey` | text NOT NULL | |
| `createdAt` | integer timestamp | |

**Indexes:**
- `unique (accountId, dedupeKey)` — idempotency.
- `(accountId, repoId, category)` — the primary retrieval predicate.
- `(accountId, repoId, dirPath)` — path-glob matching.
- `(accountId, sourceReviewId)` — Surface 2 (per-review action history).
- `(accountId, repoId, createdAt)` — recency ranking + Surface 1.

**Optional second table `review_learning_digests`** (cache): a per-`(accountId, repoId)` rolled-up, optionally Haiku-compacted context blob + `builtAt`, so injection (Section 3) doesn't recompute on every run. Recommend deferring — start with live aggregation over the indexed log; add the cache only if injection latency bites.

No new core storage is needed for *retrieval* of past reviews (Workstream 2's per-repo Claude-review listing is a new query over existing `claudeReviews`/`claudeReviewFindings`). Only this *interaction* log is net-new, and it is plugin-owned.

**Isolation note:** `verify:isolation` covers only the core query layer. The plugin must ship its **own** isolation test over `review_learnings` (every getter scopes `accountId`; id-addressed getters `→ 404`), since the harness won't see plugin queries.

---

## 3. RETRIEVAL + INJECTION (Pro path only)

**Retrieval — `getRelevantLearnings({accountId, repoId, changedPaths, categories?})`** (plugin):
1. Derive the PR's touched `dirPath`s + `ext`s from `changedPaths` (same `dirname`/ext logic as capture).
2. Portable query over `review_learnings`:
   `WHERE accountId=? AND repoId=? AND ( dirPath IN (:dirs) OR dirPath LIKE :parent||'/%' OR ext IN (:exts) )`
   ordered `createdAt DESC`, capped.
3. **Aggregate into signals** (in TS, not SQL) keyed by `(dirGlob, category)`:
   - dismissal rate (`finding_dismissed` vs total findings in that glob/category),
   - reword exemplars (Claude `claudeText` → `userText` pairs, most recent N),
   - verdict-override tally (Claude verdict vs user verdict),
   - high-endorsement patterns (`finding_posted`).
   Each signal carries a **confidence** = sample count, so thin evidence is labelled, not asserted (mirrors the project's "communicate heuristic uncertainty" ethos).

**Injection at the model seam** (`agent.ts` L274, via `RunReviewArgs.priorReviewContext`):
`learningsProvider.buildContext` renders the signals into a bounded (~600-token) markdown block, e.g.:
```
## Reviewer preferences from past reviews (this repo)
These reflect how THIS reviewer has historically adjusted reviews of similar files.
Treat as guidance, not rules.
- In `apps/backend/src/api/routes/*.ts`: the reviewer dismissed 7/9 `nit` findings about
  import ordering. Down-weight nits here. (confidence: high)
- In `*.sql` migrations: the reviewer rewrote findings to require a matching pg twin.
  e.g. you wrote "add an index" → they posted "add the index in BOTH schema.sqlite.ts and
  schema.pg.ts (parity-test guarded)". Prefer that framing. (confidence: medium)
- Verdict: on `frontend/**` you proposed REQUEST_CHANGES 4×; reviewer downgraded to COMMENT
  each time. Reserve REQUEST_CHANGES for blockers here. (confidence: medium)
```
For now the rendering is **templated** (deterministic, free). The "swappable cheap-LLM seam" (shared with Workstream 2's Haiku digest) optionally compacts the templated block via Haiku when it exceeds the token budget — behind the same model-tier interface so it's swappable later. Empty learnings ⇒ provider returns `undefined` ⇒ core prompt is byte-identical to today (zero behavior change without the plugin).

---

## 4. TWO UI SURFACES (plugin-supplied data; rendered by Pro frontend components mounted into existing slots)

Both are gated on `me.capabilities.includes('review.learnings')`. Endpoints are bound by the plugin under `/api/pro/*` (isolation-scoped via `accountIdOf(req)`).

### Surface 1 — "Matches from past reviews", BEFORE initialising a run
Mounted in `ClaudeReviewTab.tsx` run-controls block (L1158–1252), **above** the Run/Re-review button. Endpoint: **`GET /api/pro/prs/:id/review-learnings`** → `{ matches: LearningMatch[] }`, where each match = `{ glob, category, signal: 'dismiss'|'reword'|'verdict'|'endorse', confidence, count, headline, example?: {claude, user} }`. Data derives from `getRelevantLearnings` for the PR's currently-touched paths (the PR detail already knows changed files).

```
┌─ Claude Review ────────────────────────────────────────────────┐
│  ▸ From your past reviews in this repo (4 signals)        [hide]│
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ ⓘ These will be given to Claude as context for this run.  │ │
│  │                                                           │ │
│  │  apps/backend/src/api/routes/*.ts · nit                   │ │
│  │  You dismissed 7 of 9 nit findings here. ·············high │ │
│  │                                                           │ │
│  │  *.sql · warning                          [show example ▸]│ │
│  │  You reworded 3 findings to require a pg twin. ····medium  │ │
│  │     Claude: "add an index on repo_id"                     │ │
│  │     You:    "add it in BOTH schema.sqlite.ts + schema.pg" │ │
│  │                                                           │ │
│  │  frontend/** · verdict                                    │ │
│  │  You downgraded REQUEST_CHANGES→COMMENT 4× ·······medium   │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                 │
│  Model [Haiku ▾]   Depth [Auto ▾]        [ Run review ]        │
└─────────────────────────────────────────────────────────────────┘
```
UX: collapsed by default to a one-line summary (`4 signals`), expandable; each match's example is itself lazily expandable (`[show example ▸]`) so the panel stays compact. Confidence shown as a subtle right-aligned label, never a hard claim — consistent with the app's heuristic-honesty stance. If `matches` is empty the panel doesn't render (no empty state noise).

### Surface 2 — Header "Claude Reviews history": per-entry collapsible action area
Augments `ClaudeReviewsModal.tsx` `ReviewRow` (L33). The plugin doesn't fork the modal — it provides a slot component `<ReviewActionsDisclosure reviewId=…>` that the modal renders **when the capability is present** (core modal stays flat in OSS). Endpoint: **`GET /api/pro/claude-reviews/:reviewId/actions`** → `{ actions: ReviewAction[] }`, ordered `createdAt ASC`, each = `{ kind, path?, category?, claudeText?, userText?, claudeVerdict?, userVerdict?, postedCommentKind?, githubUrl?, createdAt }` — a direct projection of `review_learnings WHERE accountId=? AND sourceReviewId=?` (404 if the review isn't the caller's).

```
┌─ Claude Reviews history ───────────────────────────────────────┐
│  pierre-review #412  Fix timeline scroll gate    REQUEST_CHANGES│
│  apps/frontend · 2 days ago · Haiku                             │
│    "The scroll loop can double-write scrollTop on…"             │
│    ▾ Actions on this review (5)                                 │
│    ┌─────────────────────────────────────────────────────────┐ │
│    │ • dismissed  nit · Timeline/lanes.ts                     │ │
│    │     "Consider extracting this magic number"  2d ago      │ │
│    │ • reworded   warning · Timeline/index.tsx                │ │
│    │     Claude: "guard against null ref"                     │ │
│    │     You:    "go through setVisScrollTop + claim the gate"│ │
│    │ • posted ↗   warning · Timeline/index.tsx  (inline)   2d │ │
│    │ • verdict    Claude APPROVE → you REQUEST_CHANGES      2d │ │
│    │ • submitted  review posted · 3 inline, 1 PR comment   2d │ │
│    └─────────────────────────────────────────────────────────┘ │
│  ────────────────────────────────────────────────────────────  │
│  other-repo #88  …                                ▸ Actions (0) │
└─────────────────────────────────────────────────────────────────┘
```
UX: the disclosure is collapsed by default (`▾ Actions on this review (N)`), counts visible without expanding; each action row icon-coded by `kind` (dismissed / reworded / posted↗ / verdict / submitted); reword shows the Claude→You diff inline; `posted` rows deep-link to the GitHub comment (`githubUrl` from `postedCommentKind` + stored ids). Rows with zero actions show `▸ Actions (0)` disabled — honest, no fetch.

**Frontend wiring:** both surfaces are Pro React components shipped in `@pierre/pro` and lazy-mounted into named slots the core exposes (a thin `<ProSlot name="reviewLearnings"/>` registry), OR — simpler and recommended — core renders them itself behind the capability flag, fetching the plugin endpoints via the existing `api/client.ts` pattern (new `client.getReviewLearnings(prId)` / `client.getReviewActions(reviewId)` methods + `useReviewLearnings`/`useReviewActions` hooks mirroring `useClaudeReview`). Since the *frontend* is open source, the recommendation is: **the React rendering lives in core, gated by the flag; only the data/endpoints/storage are premium.** This keeps the SPA build simple (no dynamic frontend plugin), matches how `claudeReviewEnabled` already gates UI, and the premium value (the captured data + retrieval/injection logic) stays server-side in `@pierre/pro`. If a stricter boundary is wanted later, the slot-registry path is the fallback.

---

## Summary of files touched

**Core (public, premium-free):** `review/events.ts` (new), `plugins/pro.ts` (new), `plugins/capabilities.ts` (new); edits to `api/routes/claude-review.ts` (5 emit lines), `api/routes/me.ts` (capabilities field), `review/prompt.ts` (`priorReviewContext` slot), `review/agent.ts` (`RunReviewArgs` field + call-site passthrough), `review/review-manager.ts` (provider call), `app.ts` (`loadProPlugin`). Frontend: capability-gated rendering + 2 hooks/client methods (open-source UI, premium data).

**`@pierre/pro` (private):** subscribers + enrichment, `review_learnings` dual-dialect schema + migrator + own isolation test, `getRelevantLearnings` + `buildContext` (templated, optional Haiku compaction via the shared cheap-LLM seam), routes `GET /api/pro/prs/:id/review-learnings` and `GET /api/pro/claude-reviews/:reviewId/actions`, capability registration `review.learnings`.

**Conventions respected:** dual-dialect (plugin ships both twins, runs its own migrator, excluded from core parity test by living outside core), portable async terminals + `runTransaction`, accountId isolation (event payloads carry it; plugin getters scope it; plugin ships its own `verify:isolation`-style test), NodeNext `.js` imports in plugin backend, `shared` stays types-only, and the dynamic-import-or-degrade boundary keeps `build-release.mjs` asserts green (the plugin is never a published dep).

**One open recommendation to confirm:** plugin-owned storage + core-rendered/flag-gated frontend is the cleanest split honoring "no premium *backend* capability in public" while keeping the SPA build trivial. If you instead want the premium UI itself out of the public repo, switch Surface 1/2 to the `<ProSlot>` registry path (noted above) — the backend design is unchanged either way.

---

## Appendix — Reference map — backend plugin/route seam

I now have a complete map of the backend extensibility seam. Here is the precise reference map.

---

# BACKEND PLUGIN-SEAM REFERENCE MAP

All paths absolute. Line numbers are current as of this read.

## (1) Route registration in `apps/backend/src/app.ts`

`buildApp()` is the single composition root. Signature:
```ts
export async function buildApp(): Promise<FastifyInstance>   // line 27
```

Static imports of every route module are at the top (lines 13–25), each a named export of shape `(app: FastifyInstance) => Promise<void>`. Registration is a flat, ordered sequence of `await app.register(...)` calls. The ordering is load-bearing — middleware/hooks first, then routes:

- **L46–80** `if (config.isCloud)` — canonical-host + HSTS `onRequest` hook (registered first so the 301 short-circuits before CORS/routing).
- **L84–87** `await app.register(cors, {...})` — `origin`/`credentials` gated on `config.isCloud`.
- **L91** `if (config.isCloud) await registerSession(app)` — cookie/session, MUST precede account context.
- **L96** `registerAccountContext(app)` — attaches `request.account` (synchronous, not awaited).
- **L99** `if (config.isCloud) registerAuthGate(app)` — 401 gate, after account context.
- **L106–127** `@fastify/static` SPA + landing mounts (existence-gated).
- **L131–136** `registerErrorHandler(app, {...})` — single not-found/error handler.
- **L139** `if (config.isCloud) await app.register(authRoutes)` — OAuth.
- **L141–151** the always-on data routes, registered unconditionally in order: `healthRoutes, repoRoutes, userRoutes, timelineRoutes, prRoutes, threadRoutes, meRoutes, openPrsRoutes, feedRoutes, mergersRoutes, insightsRoutes`.

**The exact conditional gate for premium routes (the precedent to mirror)** — L152–154:
```ts
// Claude Review is local-only + opt-in. Only register its routes when enabled,
// so the clone-manager / gh-CLI dependency is unreachable in cloud mode.
if (config.claudeReviewEnabled) await app.register(claudeReviewRoutes);
```
Then `return app;` (L156). Note: `buildApp` itself does NOT register any external/dynamic plugin today — every `register` target is a statically-imported local module. There is no prefix/encapsulation used; all routes self-declare absolute `/api/...` paths.

## (2) Feature flags in `apps/backend/src/config.ts`

Flags are plain fields on a single frozen `export const config = {...} as const` (L70–220), `export type Config = typeof config` (L222). Env helpers: `intFromEnv` (L21), `floatFromEnv` (L28), `effortFromEnv` (L41). The two master derivations:

```ts
const deploymentMode: 'local' | 'cloud' =
  process.env.DEPLOYMENT_MODE === 'cloud' ? 'cloud' : 'local';   // L53–54
const isCloud = deploymentMode === 'cloud';                       // L55
```
Exposed as `config.deploymentMode` (L71), `config.isCloud` (L72), `config.dbDialect` (L74).

**The exact flag pattern to copy** — L140–141:
```ts
claudeReviewEnabled:
  !isCloud && process.env.ENABLE_CLAUDE_REVIEW === 'true',
```
So a flag = a boolean field on `config`, derived from an env var, optionally AND-ed with `!isCloud`/`isCloud`. A new flag (e.g. a Pro flag) is added as one more field here. `assertCloudConfig()` (L226–249) is the precedent for fail-loud required-env validation, called only from `index.ts` when cloud.

## (3) Capability advertisement in `apps/backend/src/api/routes/me.ts`

`meRoutes(app)` (L28). `GET /api/me` (L29–45) returns a `MeResponse`. The capability flags are passed straight through from `config`:
```ts
claudeReviewEnabled: config.claudeReviewEnabled,   // L42
deploymentMode: config.deploymentMode,             // L43
```
The contract type is `apps/.../packages/shared/src/types.ts` → `interface MeResponse` (L296–305): `user`, `counts: MyTurnCounts`, `claudeReviewEnabled: boolean`, `deploymentMode: 'local' | 'cloud'`. Frontend consumers of these flags: `apps/frontend/src/App.tsx`, `components/PrDetail.tsx`, `components/InsightsModal.tsx`, `components/ClaudeReviewBanner.tsx`, `lib/analytics.ts`. So a new frontend-visible capability = one new boolean on `config` + one new field on `MeResponse` + return it here. (`shared` is types-only — `import type` only; see §packaging.)

## (4) Auth/scoping plugins in `apps/backend/src/api/plugins/auth.ts`

- **`declare module 'fastify'`** (L12–19) augments `FastifyRequest` with `account: Account | null`.
- **`registerAccountContext(app: FastifyInstance): void`** (L28–52) — `app.decorateRequest('account', null)` then an `onRequest` hook: cloud reads `readSessionAccountId(req)` → `getAccountById`; local synthesizes the single `LOCAL_ACCOUNT_ID` account. Also `stampAccountActive` for `/api/` requests in cloud.
- **`readSessionAccountId(req)`** (L56–62) — reads `{accountId}` off the sealed session, guarded for pre-registration.
- **`registerSession(app): Promise<void>`** (L68–84) — **the dynamic-import precedent inside this file**: `const cookie = await import('@fastify/cookie')`, `const secureSession = await import('@fastify/secure-session')`, then registers them. Cloud-only.
- **`registerAuthGate(app): void`** (L90–103) — `onRequest` hook that 401s unauthenticated `/api/*` (skips `/api/health`, `/api/auth/*`).
- **`requireAuth(req, reply): Promise<void>`** (L108–118) — optional per-route preHandler guard; no-op in local.
- **`accountIdOf(req: FastifyRequest): number`** (L122–126) — THE single scoping seam every handler calls; returns `req.account.id`, else `LOCAL_ACCOUNT_ID` in local, else throws.

An externally-supplied route gets account scoping for free: it receives the same `FastifyInstance` (so `request.account` is already decorated) and imports `accountIdOf` from this module. **Isolation gate new id-routes must pass:** `apps/backend/src/api/scripts/verify-isolation.ts` (npm script `verify:isolation` in `apps/backend/package.json` L18) — seeds two accounts and asserts every id-addressed getter returns null/false cross-account.

## (5) Anatomy of a route file + how an external module supplies one

Minimal example `apps/backend/src/api/routes/timeline.ts`:
```ts
export async function timelineRoutes(app: FastifyInstance): Promise<void> {   // L80
  app.get('/api/timeline', async (req) => {
    const filters: TimelineFilters = { accountId: accountIdOf(req), ... };
    return getTimeline(filters);
  });
}
```
The richer `claude-review.ts` (`claudeReviewRoutes`, L143) is the premium template: declares JSON-schema objects (`idParam` L62, `generateSchema` L86, etc.), uses `{ schema }` per route, calls `accountIdOf(req)` for every scoped read/write, and even internally re-checks `if (!config.claudeReviewEnabled) return featureOff(reply)` (L135–141, used at L150/200/221/243/255/271/281/291/307/323/346/450) — defense-in-depth so the routes 404 even if registered.

The contract is purely structural: **any function `(app: FastifyInstance) => Promise<void>` is a registrable Fastify plugin.** An external module exporting such a function can be registered identically via `await app.register(externalRoutes)`. It would import `accountIdOf` (and `config`, `runTransaction`, `db`, etc.) from the host's compiled `dist/` (NodeNext relative `.js` specifiers, or the host re-exporting a stable surface). Nothing in the register call distinguishes a local vs an external plugin.

## (6) The dynamic-import precedent — `apps/backend/src/db/client.ts`

The canonical "load a driver only when its mode is active" pattern. `export const isPg = config.dbDialect === 'postgres'` (L28), then at module top level (top-level await):
```ts
if (isPg) {
  const pg = await import('pg');                              // L38
  const Pool = pg.Pool ?? (pg as unknown as {default: typeof pg}).default.Pool;  // L39
  const { drizzle } = await import('drizzle-orm/node-postgres');  // L40
  ...
} else {
  const { default: Database } = await import('better-sqlite3');   // L48
  const { drizzle } = await import('drizzle-orm/better-sqlite3'); // L49
  ...
}
```
`pg` is a dependency that is shipped in the curated release manifest but only `await import()`-ed in cloud (build-release.mjs L165–166 comments this). This is the precedent for "package present but loaded conditionally." Other `await import()` precedents (grep): `index.ts` L26/37/46, `cli.ts` L167/175, `run-migrations.ts` L16/21, `auth.ts` L69/70. **None currently guard for the import THROWING (missing package) — every existing dynamic import targets a guaranteed-present dependency.** A plugin that may be absent introduces the new requirement of a `try/catch` around `await import('@pierre/pro')` (the graceful-degradation seam does not yet exist).

## (7) Boot sequence — where a dynamic plugin import would attach

Two-stage boot. `apps/backend/src/cli.ts` `main()` (L113): parses flags → maps to env BEFORE config loads (L122–125) → gh pre-check → `const { start } = await import('./index.js')` (L175) → `await start()`.

`apps/backend/src/index.ts` `start(): Promise<{app, port}>` (L11):
1. L13 `if (config.isCloud) assertCloudConfig()`
2. L16 `await runMigrations()`
3. L19 `cleanupRedundantReviewEvents()`
4. L25–30 local-account synthesis
5. **L32 `const app = await buildApp();`** ← app constructed here
6. L36–41 `if (config.claudeReviewEnabled)` heal mid-flight reviews (`reconcileReviewsOnStartup`)
7. L44–51 scheduler (wrapped in `try/catch`, `app.log.warn` on failure — the existing "optional subsystem, degrade gracefully" precedent)
8. L53 `await app.listen({...})` → returns `{ app, port }`.

**The natural seam to bind an external plugin** is the window between `buildApp()` returning at L32 and `app.listen()` at L53 in `index.ts` (the `app` is built but not yet listening, and `config` is fully resolved). The scheduler block (L44–51) is the structural model: a `try { const mod = await import(...); register/start } catch (err) { app.log.warn(...) }` that no-ops when absent. Alternatively, `buildApp` in `app.ts` could take the bound plugin as a parameter / await an internal optional import right after L154 (after the claude-review gate, before `return app`), mirroring exactly how `claudeReviewRoutes` is conditionally registered. Either location has full access to `config` flags and the live `FastifyInstance`.

## Packaging constraints any plugin must not break (`scripts/build-release.mjs`)

- **Curated deps** — the release `package.json` is generated with an explicit allowlist (L150–168). `@pierre/pro` would NOT be added here; it is never in the published manifest, only `await import()`-ed at runtime (same posture as a peer/optional dep — must therefore tolerate `MODULE_NOT_FOUND`).
- **No `.ts` leak** — `walk()` (L218–227) fails the build on any `.ts` under `release/`.
- **No shared runtime import** — `grepSharedImports()` (L232–256) fails on real `from '@pierre-review/shared'` / `require('@pierre-review/shared')` in shipped `.js`. The plugin's host-facing imports must use `import type` for shared types.
- **Required-file asserts** — `mustExist` (L194–212) lists `dist/...` artifacts; a new always-present route would belong here, but the optional plugin must NOT, since it is absent from the public package.
- ESM is NodeNext in backend (relative imports need explicit `.js`); frontend is Bundler (no extensions). `packages/shared` is TYPES ONLY.

---

## Appendix — Reference map — Inbox data sources + gap analysis

Map complete. Findings below.

# map:inbox-data — Existing read/aggregation capability vs. gaps for a repo-oriented, AI-free Inbox

All paths absolute. Line numbers are current.

## A. `apps/backend/src/db/queries.ts` — read/aggregation capabilities

### Module-private helpers (NOT exported — reuse needs export or a new wrapper query)
- `tsBound = (d: Date): Date | number` (L98) — portable epoch bind for raw `sql` (Pg→Date, SQLite→unix seconds). Used in window predicates.
- `buildThreadCounts(prIds: number[]): Promise<Map<number, ThreadStateCounts>>` (L277) — the ONLY per-PR thread-state aggregator. Groups `reviewThreads.derivedState` by `prId`. **Not exported.**
- `buildTimelinePrs(prRows: PrRow[], accountId): Promise<TimelinePr[]>` (L313) — enriches raw PR rows with thread counts + triage → full `TimelinePr[]`. **Not exported.**
- `mapTimelinePr(p, counts, tr): TimelinePr` (L341), `isStalled(pr, counts): boolean` (L300), `emptyCounts()` (L122), `prStatusWhere(statuses)` (L254), `staleOpenPrIds(...)` (L226), `botUserIds()` (L268). All **not exported.**
- `REASON_PRIORITY: ReasonTag[]` (L75) — sort order used by `getOpenPrs`.

### Exported queries (signatures + return shapes)

`getTimeline(filters: TimelineFilters): Promise<TimelineResponse>` (L374)
- `TimelineFilters` (L194): `{ accountId; from: Date; to: Date; repoIds: number[]|null; userIds: number[]|null; types: EventType[]|null; statuses: PrStatus[]|null; reviewStates: ReviewState[]|null; excludeBots: boolean; excludeStale: boolean }`.
- Returns `{ prs: TimelinePr[]; events: TimelineEvent[] }`. Window-bounded (PRs overlapping `[from,to]`). Repo-filterable via `repoIds` but result is FLAT (not grouped by repo or user). Heavy (loads events).

`getOpenPrs(filters: OpenPrsFilters): Promise<TimelinePr[]>` (L741)
- `OpenPrsFilters` (L735): `{ accountId; repoIds: number[]|null; userIds: number[]|null }`.
- Returns flat `TimelinePr[]` (open only), sorted by `reasonTag` priority then oldest-first. Each `TimelinePr` carries `repoId`, `authorId`, `threadCounts: ThreadStateCounts`, `reasonTag`, `isStalled`, `isApproved`, `isChangesRequested`, `reviewRequestedFromMe`, `newSinceLastViewed`. **This is the cleanest building block** for "PRs grouped per user per repo" — but grouping must be done by the caller; no server-side grouping.

`getMyTurn(accountId): Promise<MyTurnResponse>` (L1888)
- `MyTurnResponse` (types.ts L748): `{ awaitingReview: AwaitingReviewItem[]; yourPrs: YourPrActivityItem[]; approvedPrs: ApprovedPrItem[]; threadsAwaiting: ThreadAwaitingItem[]; watchedRepoPrs: WatchedRepoPrItem[]; claudeReviewsToAction: ClaudeReviewToAction[]; users: User[] }`. ME-centric (filters to local user / dismissals), NOT repo-oriented. Reuses `getWatchedActionablePrIds` (L1782), `getThreadsAwaiting` (L2102), `getUnactionedClaudeReviews` (L2793).

`getMergers(accountId): Promise<RepoMergers[]>` (L1299)
- Returns `[{ repoId, userIds }]` — distinct default-branch mergers per repo (maintainer proxy). Already repo-grouped; useful for "who can merge" per repo.

`getInsights(filters: InsightsFilters): Promise<InsightsResponse>` (L823)
- `InsightsFilters` (L767): `{ accountId; repoIds: number[]|null }`.
- Returns `InsightsResponse` (types.ts L430): `{ repos: RepoInsights[]; mergedWindowDays; reviewWindowDays; stallThresholdDays; chartWindowDays; generatedAt }`.
- `RepoInsights` (types.ts L396): `{ repoId; repoFullName; openPrs; draftPrs; mergedLast7d; stalledPrs; medianHoursToFirstReview; oldestUnreviewed; reviewLoad: RepoReviewLoad[]; openPrList: InsightsOpenPr[]; openDurationTrend: InsightsTimePoint[] }`.
- `InsightsOpenPr` (types.ts L368): `{ prId; number; title; authorId; isDraft; isStalled; openedAt; githubUrl }` — has `authorId`, so per-user grouping of a repo's open PRs is derivable client-side. **This is the closest existing "per-repo PR stats" capability.** Note: it does NOT include per-repo thread-state totals.

`getRepoAnalytics(accountId, repoId): Promise<RepoAnalytics | null>` (L1006)
- Single-repo deep analytics (null → 404 if not owned). Returns weekly-bucketed series: `throughput {opened,merged,closed}`, `backlog {open,stalled}`, `reviewLatencyTrend`, `cycleBreakdown`, `reviewLatencyDist`, `threadMix {resolved,likely_addressed,replied_unresolved,untouched}` (L1217 — **per-week buckets, windowed by thread `createdAt`, NOT a current-state total**), `reviewVerdicts`, `reviewerLoad`, `sizeDist`, `sizeVsCycle`, `sizeCycleByBucket`, `activityHeatmap[168]`. Per-repo but trend-shaped, not a snapshot breakdown.

`getFeed(accountId, daysBefore=14): Promise<FeedResponse>` (L589) — flat denormalized activity across WATCHED repos (`repos.inboxWatch=true`), newest-first, excludes commits. `FeedEvent` carries `repoId`, `repoFullName`, `prId/prNumber/prTitle/prState`, `actorId`, `reviewState`, `excerpt`. Repo data present but flat (not grouped).

`listRepos(accountId): Promise<Repo[]>` (L136) — each `Repo` carries `inboxWatch`, `lastFullSyncAt`, `lastIncrementalSyncAt`, `lastSyncStatus`. The watched-repo set comes from here.

### Per-repo / per-user aggregation helpers (the specifically-named ones)
- `buildTimelinePrs` (L313) — exists, not exported (above).
- `computeApprovalInfoByPr(prIds): Promise<Map<number, ApprovalInfo>>` — lives in **triage.ts** (L66), re-exported from queries via import (L88). `ApprovalInfo = { approved; changesRequested; approvals; latestApprovalAt }`.
- `tsBound` (L98) — above.
- There is **NO** per-repo grouping helper that returns "repo → {users → PRs}" or "repo → thread-state totals". Every aggregator is either per-PR (`buildThreadCounts`), flat (`getOpenPrs`, `getTimeline`), or per-repo-array-of-metrics (`getInsights`).

## B. `apps/backend/src/db/triage.ts` — `computeTriage`

`computeTriage(prs: TriagePrInput[], accountId): Promise<Map<number, TriageResult>>` (L126)
- `TriagePrInput` (L16): `{ id; state; authorId; ciStatus; mergeable; mergeStateStatus; isStalled; threadCounts }`.
- `TriageResult` (L27): `{ reasonTag: ReasonTag; reviewRequestedFromMe: boolean; otherReviewersRequested: number; isApproved: boolean; isChangesRequested: boolean; newSinceLastViewed: NewSinceLastViewed|null }`.
- `newSinceLastViewed = { commits; comments; reviews }` (L41), computed from `events` after each PR's `prViews.lastViewedAt`; null on non-open or never-viewed PRs.
- `reasonTag` cascade in `deriveReasonTag` (L219), open-PRs-only, first match wins: `awaiting_your_review` → `your_pr_new_comments` → `ci_failing` → `merge_conflicts` → `approved_ready` (needs `mergeable==='mergeable'`) → `stalled` → `untouched_threads` (when `threadCounts.untouched > 0`) → default `in_progress`.
- `isStalled` is an INPUT to triage (computed by queries.ts `isStalled`, L300: open + `untouched+replied_unresolved ≥ 1` + last commit older than `config.stallThresholdDays`), not produced by triage.

## C. `apps/backend/src/sync/derive-thread-state.ts` — thread states

`deriveThreadState(thread, prCommitsByDate, commitFilesBySha): DerivedState` (L37). Four states (note: the canonical names differ from the task's wording):
- `resolved` — GitHub-resolved.
- `likely_addressed` — a commit touched the file after the last comment.
- `replied_unresolved` — someone other than the original commenter replied, no subsequent commit. **(This is the task's "unresolved".)**
- `untouched` — none of the above.

Counts per PR: the derived state is PERSISTED on `reviewThreads.derivedState` (computed at sync time). Per-PR counts are produced ONLY by `buildThreadCounts(prIds)` (queries.ts L277) → `Map<prId, ThreadStateCounts>`; `ThreadStateCounts = { resolved; likely_addressed; replied_unresolved; untouched }` (types.ts L136). Every `TimelinePr.threadCounts` already carries this. **No per-REPO total breakdown exists** — would require summing `buildThreadCounts` over a repo's PR ids (and `buildThreadCounts` is currently unexported).

## D. Schema + routes — Claude reviews

### Tables (`apps/backend/src/db/schema.sqlite.ts`)
`claudeReviews` (L438, table `claude_reviews`): `id` PK; `accountId` (NOT NULL, FK accounts — **direct account scoping column present**); `prId` (FK pullRequests); `headSha`; `status` enum(queued/running/succeeded/failed/cancelled); `model`; `scope` enum(diff_only/worktree)|null; `reviewMode` enum(skip/diff_only/worktree)|null; `routeReason` json `ReviewRouteReason`; `summary`; `verdict` enum(COMMENT/REQUEST_CHANGES/APPROVE); `userBody`; `userVerdict`; cost/token fields (`costUsd`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `numTurns`); `diffBytes`, `diffCapped`; `error`; `excludedFiles` json string[]; `postedReviewId`; `postedAt`; `createdAt`; `finishedAt`. Indexes: `cr_pr_idx(prId)`, `cr_pr_sha_idx(prId, headSha)`, `cr_account_idx(accountId)`. **Keyed by `(prId, headSha)` via the composite index; history kept (multiple rows per PR, autoincrement `id`).** NOTE: **no `repoId` column** — repo association is only via `prId → pullRequests.repoId`.

`claudeReviewFindings` (L507, table `claude_review_findings`): `id` PK; `reviewId` FK; `path`; `line`; `side` enum(LEFT/RIGHT); `severity` enum(blocker/warning/nit/question/praise); `title`; `body`; `editedBody`; `suggestion`; `diffHunk`; `anchored` bool; `fileInDiff` bool; `included` bool; `postedAt`; `githubCommentId`; `postedCommentKind` enum(inline/pr_comment); `createdAt`. Index `crf_review_idx(reviewId)`. (`pg` parity copy exists in schema.pg.ts.)

Row types: `ClaudeReviewRow = typeof claudeReviews.$inferSelect`, `ClaudeFindingRow = typeof claudeReviewFindings.$inferSelect` (queries.ts L2583-2584). Mappers `mapReview` (L2616) / `mapFinding` (L2592).

### Claude-review READ queries (queries.ts)
- `getClaudeReviewById(reviewId, accountId): Promise<ClaudeReview|null>` (L2648) — joins `claudeReviews→pullRequests→repos`, filters `repos.accountId`.
- `getLatestClaudeReview(prId, accountId): Promise<ClaudeReview|null>` (L2672) — most-recent run for ONE PR.
- `listClaudeReviewHistory(prId, accountId): Promise<ClaudeReviewSummary[]>` (L2691) — ALL runs for ONE PR, newest-first. `ClaudeReviewSummary` (types.ts L1135): `{ id; headSha; status; model; scope; reviewMode; verdict; userVerdict; costUsd; postedAt; createdAt; finishedAt }`.
- `listAllClaudeReviews(accountId): Promise<ClaudeReviewListItem[]>` (L2723) — CROSS-PR, ONE entry per PR = most-recent **succeeded** run, account-scoped, restricted to PRs within the timeline window (open or touched within `config.backfillDays`), newest-first. `ClaudeReviewListItem` (types.ts L1153) carries `repoFullName`, `prNumber`, `prTitle`, `prState`, `summary`, `verdict`, `headSha`. **Carries `repoFullName` → client CAN group by repo, but server returns flat and drops non-succeeded + older-than-window + non-latest runs.**
- `getUnactionedClaudeReviews(accountId): Promise<ClaudeReviewToAction[]>` (L2793) — open-PR latest-succeeded-unposted only (My Turn feed).

### Routes (`apps/backend/src/api/routes/claude-review.ts`)
- `GET /api/prs/:id/claude-review` (L145) → `ClaudeReviewResponse { enabled, auth, hasUserKey, review: ClaudeReview|null, history: ClaudeReviewSummary[] }` (per-PR: latest + full history). All gated on `config.claudeReviewEnabled`.
- `GET /api/claude-reviews` (L268) → `{ reviews: ClaudeReviewListItem[] }` (= `listAllClaudeReviews`). Static path, registered before `:reviewId`.
- `GET /api/claude-reviews/:reviewId` (L287) → full `ClaudeReview` (with findings).
- `GET /api/claude-reviews/active` (L278), plus POST/PATCH mutators (generate/post/cancel/update-finding/update-review).
- Feature gating: whole feature behind `config.claudeReviewEnabled`; flows to FE via `/api/me` (me.ts referenced) + `ClaudeReviewResponse.enabled`.

### Repo-relevant read routes already exposed (reusable as-is, no AI, no new sync)
`/api/timeline` (timeline.ts L81), `/api/open-prs` (open-prs.ts L16), `/api/insights` + `/api/insights/:repoId/analytics` (insights.ts L18/L28), `/api/my-turn` (me.ts L47), `/api/mergers` (mergers.ts L8), `/api/feed` (feed.ts L10), `/api/repos` (repos.ts L95), `/api/claude-reviews` + `/api/claude-reviews/:reviewId`, `/api/prs/:id/claude-review`. All scope via `accountIdOf(req)` (plugins/auth.ts).

## E. Gap analysis — what's ALREADY queryable vs MISSING for the repo-oriented Inbox

| Inbox need (per watched repo) | Already queryable | Gap |
|---|---|---|
| List of PRs **grouped per user** | `getOpenPrs` (flat `TimelinePr[]` w/ `repoId`+`authorId`) and `getInsights.repos[].openPrList` (`InsightsOpenPr` w/ `authorId`) | No server query returns repo→user→PRs **grouped**. Grouping is derivable caller-side but no `getInbox`-style aggregate exists. |
| **PR stats** per repo (open/draft/merged/stalled/TTFR/oldest-unreviewed/review-load) | `getInsights` / `RepoInsights` — complete | None for these metrics. |
| **Thread-state breakdown** per repo (resolved/likely_addressed/replied_unresolved/untouched **totals**) | Per-PR only via `buildThreadCounts` (unexported) and `TimelinePr.threadCounts`; `getRepoAnalytics.threadMix` is per-week+`createdAt`-windowed, not a current-state total | **Missing:** a per-repo current-state thread-state total. Must sum `buildThreadCounts` across a repo's PR ids; `buildThreadCounts`/`buildTimelinePrs`/`isStalled` are **unexported**. |
| High-level "state of play" summary (non-AI) | Composable from `getInsights` + `getOpenPrs` + `getMergers` + per-PR `threadCounts` | No single combined endpoint; needs a new aggregator OR client fan-out across existing routes. |
| Prior **Claude reviews per PR** listed repo-wise | `getLatestClaudeReview(prId)`, `listClaudeReviewHistory(prId)`, `getClaudeReviewById(reviewId)`, `listAllClaudeReviews(accountId)` (flat, one-per-PR, succeeded-only, window-bounded, carries `repoFullName`) | **Missing:** a `repoId`-scoped claude-review query. No query takes `repoId`; no "all PRs in repo → their review history" grouping. `listAllClaudeReviews` filters to one latest-succeeded run per PR + timeline window — too lossy for a full repo-oriented history view. |

### Concrete missing pieces
1. **`getInbox(accountId, repoIds?)`** — a repo-grouped aggregate returning, per watched repo: PRs (grouped by author), the `RepoInsights`-style stats, AND a per-repo thread-state total. None of this is grouped server-side today.
2. **Per-repo thread-state total** — requires exporting/wrapping `buildThreadCounts` (L277) and summing across a repo's open PR ids; `getRepoAnalytics.threadMix` does not satisfy it (week-bucketed, `createdAt`-windowed).
3. **Repo-scoped Claude-review retrieval** — e.g. `listClaudeReviewsByRepo(repoId, accountId)` returning each PR's runs grouped under the repo. Today only `prId`-scoped (`listClaudeReviewHistory`) or account-wide flat one-per-PR (`listAllClaudeReviews`). The data is fully present (`claudeReviews.prId → pullRequests.repoId`, plus a direct `claudeReviews.accountId` column for cheap scoping); only the **repo-oriented retrieval** is missing — **no new storage is needed**, the `(prId, headSha)` history already persists every run.
4. **Export surface** — `buildTimelinePrs`, `buildThreadCounts`, `isStalled` are module-private; any new repo-oriented query reusing them must be added inside queries.ts (they cannot be imported elsewhere as-is).

### Naming caveat for the plan
The task lists thread states as "unresolved, likely_addressed, untouched, resolved"; the code's canonical fourth state is **`replied_unresolved`** (not `unresolved`). `ThreadStateCounts` keys are exactly `{ resolved, likely_addressed, replied_unresolved, untouched }`.

---

## Appendix — Reference map — frontend shell/navigation

Map complete. Here is the frontend shell map for adding a top-level "Inbox" tab.

## 1. App.tsx — top-level layout regions & view composition

`/Users/alex/Projects/pierre-review/apps/frontend/src/App.tsx` — single default export `App()`. **There is NO router** (`main.tsx` mounts `<App/>` directly under `PersistQueryClientProvider`; no react-router). The "view" is a hand-composed flex column; "tabs" are a Zustand concept, not routes.

Render tree (top → bottom), all inside `<div className="flex h-full flex-col">`:
- `<header>` (lines 205-373): brand title, signed-in user chip (`meUser`), `<FeedPill/>`, `<CountsPill/>`, then an `ml-auto` cluster: `<TimelineSearch/>`, `<SyncStatus/>`, **Insights button** (`setInsightsOpen(true)`), notifications toggle, **Claude Reviews button** (gated by `claudeReviewEnabled`, opens `reviewsOpen` modal state — line 303-329), Help `?`, dark-mode toggle, and cloud-only Sign-out. This header is where a new top-level nav control most naturally lives.
- Modals mounted as siblings (375-385): `<InsightsModal/>`, `<HelpModal/>`, `<ClaudeReviewsModal/>` (only mounted when `claudeReviewEnabled`).
- `<WelcomeBackBanner/>`, `<FilterBar/>`, `<PinnedTabsBar/>` (above `<main>`).
- `<main className="relative flex min-h-0 flex-1 flex-col ...">` (394-431) — the swappable region. Contains:
  - `<section ref={timelineSectionRef}>` → `<Timeline/>` (399-401)
  - resize separator (drag handle, 402-411)
  - `<section ref={paneRef} style={{height: paneH}}>` → `<DetailPane/>` (412-418) — resizable bottom pane, height persisted via `useLocalStorage('pierre:detailPaneHeight', 384)`.
  - **the pinned-PR overlay** (423-430): `{activePinnedId != null && <div className="absolute inset-0 z-20 bg-white dark:bg-gray-950"><PrDetail .../></div>}`
- `<ClaudeReviewBanner/>` (432) — global footer banner.

**So the main view is NOT a tab switcher.** It is always Timeline + DetailPane, and the *only* existing "full-screen swap" is the pinned-PR overlay (`activePinnedId`). Two focus *modes* (`focusActive`, `myTurnOnly`) only draw a CSS `focus-frame` border (line 396) — they don't replace the view. The cleanest insertion point for an Inbox "view" is a new absolute overlay sibling inside `<main>` (mirroring the `activePinnedId` overlay at 423-430) OR — cleaner given Inbox is a peer of Timeline — branching the whole `<main>` contents on a new top-level mode. Both options key off a store value; see §2/§3.

Capability flags read at top of `App`: `isCloud = me.data?.deploymentMode === 'cloud'` (81), `meUser` (85), `claudeReviewEnabled = me.data?.claudeReviewEnabled ?? false` (86). These directly gate header buttons — the pattern an Inbox-PRO digest flag would mirror.

## 2. PinnedTabsBar + the absolute-overlay mechanism

Store: `/Users/alex/Projects/pierre-review/apps/frontend/src/store/pinnedTabs.ts` — `usePinnedTabs` (Zustand).
- `type ActiveTab = 'timeline' | number` (line 18) — **the existing "which top-level view" enum.** A string sentinel `'timeline'` plus PR-id numbers. An `'inbox'` sentinel would slot in here, but note many call sites treat "not a number" as "the board".
- State: `pinned: PinnedPr[]` (persisted to `localStorage` key `pierre:pinnedTabs`), `activeTab` (NOT persisted — fresh load always lands on `'timeline'`, line 101/27-28).
- Actions: `pin`, `unpin`, `syncMeta`, `setActiveTab(tab)`, **`showTimeline()`** (138-140, idempotent — only sets if not already `'timeline'`), `clear()` (on sign-out).
- **`showTimeline()` invariant**: every timeline-navigation action in `filters.ts` calls `usePinnedTabs.getState().showTimeline()` *before* mutating selection — see `openPrFocused` (638), `showEventOnTimeline` (666), `openFeedEventOnTimeline` (677), `focusPrOnTimeline` (693), `centerTimelineNow` (712). This guarantees a timeline nav pops you out of any pinned overlay. **Adding an Inbox view means auditing these call sites**: any nav that should leave Inbox must also clear the Inbox mode (or Inbox must be modeled on the *same* `activeTab` axis so `showTimeline()` already exits it).

Component: `/Users/alex/Projects/pierre-review/apps/frontend/src/components/PinnedTabsBar.tsx` — exports `PinnedTabsBar()`. Returns `null` when `pinned.length === 0` (line 77) so default UI is unchanged. Renders a `sticky left-0` "Timeline" tab button (`showTimeline`, with a hamburger SVG, 90-117) followed by `pinned.map(<PinnedTab/>)`. `PinnedTab` (5-66) is `w-52`, two-line (title + author), active styling `border-gray-300 bg-white dark:bg-gray-950 text-blue-600`. **This is the visual template for a top-level tab bar** — but it's conditionally hidden and PR-centric.

Overlay rendering: lives in **App.tsx 423-430**, not in the bar. `activePinnedId` computed at 110-113 (guards against a stale active id no longer pinned). When set, the timeline+pane sections are marked `inert` (129-136) for a11y, and `<PrDetail key={activePinnedId}/>` is drawn `absolute inset-0 z-20`. `DetailPane.tsx` (33-34) also suppresses re-mounting the same PR behind the overlay (`showBody = bodyPrId != null && bodyPrId !== activeTab`). Keyboard: `useKeyboard.ts` 34-38 — Escape with `activeTab !== 'timeline'` calls `showTimeline()` first (takes precedence over focus/selection); 61-66 suppresses `j/k/m` while an overlay is up.

## 3. store/filters.ts — view/selection/visibility state & focus modes

`/Users/alex/Projects/pierre-review/apps/frontend/src/store/filters.ts` — `useFilters` (Zustand), `interface FilterState` (66-347). This is the big store (server-query filters + selection + transient signals). Key axes a new top-level tab interacts with:

**Focus modes** (two discrete, never overlapping — documented 84-94):
- `myTurnOnly: boolean` (95) — "My Turn Focus Mode": isolates the board to the inbox. **Transient — deliberately NOT URL/localStorage-synced** (see 132, and `sanitizePersistedFilters` 440-451 which strips a legacy persisted `myTurnOnly`). Entered via `enterMyTurnFocus()` (588), `openMyTurnPr()` (564), `openMyTurnClaudeReview()` (577); left via `exitMyTurnFocus()` (599). `myTurnFromMs` (103) widens the fetch range.
- `focusActive: boolean` (190) + `exitFocusSignal` counter (195) — PR-isolation overlay, owned by Timeline. `setFocusActive`/`exitFocus` (746-748).

**Feed vs My Turn modeling** — this is the closest existing precedent for "Inbox is a peer view, not feature-flagged." There is **no enum**; it's derived in `DetailPane.tsx` (14-63): the bottom pane shows, in priority order, `PrDetail` (if `selectedPrId`) → `MyTurnPanel` (if `myTurnOnly`) → else `FeedPanel` (the default home). So "Feed" and "My Turn" are not stored modes — Feed is the *fallback*, My Turn is `myTurnOnly===true`. The header `<FeedPill/>` / `<CountsPill/>` toggle these via `exitMyTurnFocus`/`enterMyTurnFocus`. An Inbox top-level tab is broader than this pane-only switch — it's a whole-`<main>` replacement, so it more closely resembles the `activeTab` axis (§2) than the DetailPane fallback chain.

**Selection**: `selectedPrId`/`selectedThreadId`/`selectedCommentId` (117-124). **Strip state**: `stripCollapsed` (142), `stripFilter: 'all'|'my_turn'|'needs_attention'` (143, type `StripFilter` line 16). **Insights**: `insightsOpen` (145) + `setInsightsOpen` (755) — the simplest precedent for "a transient boolean opening a top-level surface from the header." **Search**: `searchQuery` (152).

**How a new mode slots in**: a top-level Inbox is either (a) a new `activeTab` sentinel `'inbox'` in `pinnedTabs.ts` (reuses the overlay+inert+Escape plumbing, and `showTimeline()` already exits it everywhere) or (b) a new transient boolean in `filters.ts` like `insightsOpen` (but full-view not modal). Given Inbox must be a persistent peer of Timeline (not a transient modal), option (a) is mechanically closest to existing code. Note `freshDefaults()` (500-532) resets all non-action state; a new field added here must be listed there. `pickFilterBarState`/`FilterDefaults` (367-431) and `sanitizePersistedFilters` are the persistence whitelist — **a transient view flag must NOT be added to those** (mirror how `myTurnOnly`/`insightsOpen` are excluded).

## 4. useUrlState.ts — URL mirroring

`/Users/alex/Projects/pierre-review/apps/frontend/src/hooks/useUrlState.ts` — exports `useUrlState()` (called once in `App` line 49). Two-way sync between `useFilters` and `window.location` query string + `localStorage('pierre:filterBarState')`.
- `readFromUrl()` (42-107) parses params (`preset`, `repos`, `users`, `bots`, `stale`, `cats`, `status`, `reviews`, `states`, `pr`, `thread`, `strip`, `open`). `writeToUrl(s)` (109-143) serializes via diff-against-defaults, using **`window.history.replaceState`** (142) — no pushState, so there's no history-stack navigation for filters.
- **Transient modes are intentionally excluded** — explicit comments: `myTurnOnly` "transient — intentionally not serialized" (90-91, 132); selection (`pr`/`thread`) IS synced (133-134). So an Inbox view flag follows the `myTurnOnly` precedent: **add nothing here** if it should be a fresh-load-resets transient. If Inbox *should* be deep-linkable (e.g. `?view=inbox`), this is the one file to extend (add to both `readFromUrl` and `writeToUrl`), plus a `PRESETS`-style guard.
- Hydration order (181-197): URL params win; else last active saved view; else persisted filter blob. `hydrate(partial)` is `filters.ts` 783.

## 5. hooks/useMe.ts — capability flag gating

There is no `hooks/useMe.ts`; `useMe` lives in `/Users/alex/Projects/pierre-review/apps/frontend/src/hooks/useTriage.ts` (34-38): `useQuery<MeResponse>({ queryKey: ['me'], queryFn: api.me, retry: false })`.

`MeResponse` is at `/Users/alex/Projects/pierre-review/packages/shared/src/types.ts` lines 296-305:
```
export interface MeResponse {
  user: LocalUser | null;
  counts: MyTurnCounts;
  claudeReviewEnabled: boolean;          // gates the Claude Review tab/UI
  deploymentMode: 'local' | 'cloud';
}
```
**This is the exact flag-flow to mirror for a Pro/digest capability.** Consumption pattern is a one-liner at each call site: `App.tsx` 86 `const claudeReviewEnabled = me.data?.claudeReviewEnabled ?? false;` → gates header button (303) + modal mount (380). Same pattern in `InsightsModal.tsx` 287 (`canReview = useMe().data?.claudeReviewEnabled ?? false` → gates per-PR Review button) and `MyTurnPanel/index.tsx` 30. A new capability (e.g. `inboxDigestEnabled`) would be added to `MeResponse` and read identically. `useMe` is also used for `deploymentMode` gating (cloud sign-out, GA). The Inbox *tab itself* (core, unflagged) needs none of this; only the PRO per-repo digest does.

## 6. Visual system — reusable building blocks

**`/Users/alex/Projects/pierre-review/apps/frontend/src/lib/ui.ts`** — the state-color/label vocabulary:
- `DERIVED_STATE_META: Record<DerivedState, {label,color,description}>` (19-42) — **the thread-state breakdown colors/labels Inbox needs** (`untouched` #ef4444, `replied_unresolved` "Replied" #f59e0b, `likely_addressed` #3b82f6, `resolved` #22c55e). Note: shared `DerivedState` uses `replied_unresolved`; the workstream's "likely_addressed/untouched/resolved" vocabulary maps here.
- `PR_STATE_META` (44-48), `EVENT_META` (50-63, includes `shape`), `REASON_META` (67-79, `myTurn` flag), `CI_META` (82-92), `CHECK_STATE_META` (95-106).
- Helpers: `userLabel` (119), `profileUrl` (125), `indexUsers` (129, builds `Map<id,User>` — used everywhere), `formatDate`/`relativeTime`/`dateTime` (140-174), `WATCHED_TITLE` + `watchedGlyphHtml` (189-198).

**Repo zebra tints** — `/Users/alex/Projects/pierre-review/apps/frontend/src/index.css` lines 505-579: `.tl-repo-tint-0 { --tl-tint: 59 130 246 }` (blue), `.tl-repo-tint-1 { --tl-tint: 139 92 246 }` (purple); applied as `background-color: rgb(var(--tl-tint)/0.10)` (0.13 dark). The tint **index is assigned in `Timeline/index.tsx`**: `REPO_TINT_COUNT` (const ~91) and `tintClass = \`tl-repo-tint-${ridx % REPO_TINT_COUNT}\`` (line 2799). These CSS classes are scoped to vis-timeline labels/groups (`.vis-labelset`/`.vis-foreground`), so reusing the *zebra* idea for a React Inbox grid means replicating the alternation logic (the `--tl-tint` custom-prop pattern is reusable, the selectors are not).

**Avatars / names / shields** (all reusable, repo-aware):
- `Avatar` — exported from `/Users/alex/Projects/pierre-review/apps/frontend/src/components/CommentCard.tsx` (6-34); `size` prop, avatarUrl-or-initials fallback.
- `UserName` (`components/UserName.tsx`) — profile link + appends `<MaintainerShield/>` when `repoId` given and user has merge rights (via `useMaintainersByRepo()` from `hooks/useMaintainers.ts`).
- `MaintainerShield` (`components/MaintainerShield.tsx`) — purple #8957e5 shield SVG.
- `WatchedBadge` (`components/WatchedBadge.tsx`) — sky eye glyph; `inboxWatch` flag comes from `Repo.inboxWatch`.

**MyTurnPanel layout** (`components/MyTurnPanel/index.tsx`) — **the strongest template for a sectioned, repo/user-grouped Inbox.** Header row with uppercase `text-xs font-semibold text-gray-400` title + tab buttons + `ml-auto` action (76-111); body `min-h-0 flex-1 overflow-auto p-4`; tabbed `'todo'|'done'|'summary'` (19-24). Reusable section components in the same dir: `AwaitingReviewSection`, `ApprovedPrsSection`, `YourPrsSection`, `WatchedRepoPrsSection` (**repo-grouped already**), `ThreadsAwaitingSection`, `ClaudeReviewsToActionSection` (**lists Claude reviews to action**), `DismissedSection`, `FeedSection`, `CountsPill`. `SummaryStats` (`components/SummaryStats.tsx`) is a **per-repo open/stalled/untouched/replied table built purely from `useTimeline()` + `useRepos()`** — a ready-made no-AI repo aggregation Inbox can reuse/extend.

**Charts toolkit** — `/Users/alex/Projects/pierre-review/apps/frontend/src/components/charts/`:
- `common.tsx` exports `useChartWidth()`, `PALETTE` (named hexes), `SERIES_COLORS`, `interface Series`, `fmtDuration`/`fmtDate`/`fmtNum`/`niceMax`, and the card primitives **`Legend`, `FloatingTip`, `ChartCard` (titled card w/ note), `ChartEmpty`**.
- Chart components: `BarChart.tsx`, `LineChart.tsx`, `StackedAreaChart.tsx`, `ScatterChart.tsx`, `Heatmap.tsx` (zero-dep SVG, theme via `currentColor`). Consumed today by `InsightsModal`/`RepoAnalyticsModal`/`InsightsChart.tsx`.

**Modal shell pattern** (for the PRO digest, or an Inbox sub-panel): `InsightsModal.tsx` (278-407) and `ClaudeReviewsModal.tsx` are the canonical templates — `fixed inset-0 z-50 bg-black/50` backdrop, `role="dialog" aria-modal`, capture-phase Escape handler (`stopImmediatePropagation` so it doesn't reach the global hook), `↻` refresh invalidating a query key, pagination (`PAGE_SIZE`). `InsightsModal` is **per-repo `RepoCard` (134-276)** showing exactly the stats Inbox wants (Open/Draft/Merged/Stalled/median-first-review, reviewLoad-by-reviewer, collapsible per-PR list, oldest-unreviewed) — built from `useInsights`/`useRepoAnalytics` (`useTriage.ts` 47-66 → `/api/insights`, `/api/insights/:repoId/analytics`).

## Data/query layer Inbox can reuse (no-AI, existing)
`api` client `/Users/alex/Projects/pierre-review/apps/frontend/src/api/client.ts` — relevant terminals already exist: `insights` (133), `repoAnalytics` (135), `openPrs` (131), `timeline` (129), `myTurn` (172), `feed` (175), and **`listAllClaudeReviews()` → `/api/claude-reviews`** (245-246, "one entry per PR, most-recent succeeded review, within the timeline window") + `claudeReviewById` (207). Hooks: `useInsights`/`useRepoAnalytics`/`useOpenPrs`/`useMyTurn` (`useTriage.ts`); `useRepos`/`useUsers`/`useTimeline`/`useMergers` (`useTimeline.ts`); `useAllClaudeReviews` (`hooks/useClaudeReview.ts`, used by `ClaudeReviewsModal`).

**Claude-review history retrieval is currently PR-window-oriented, not repo-oriented**: `listAllClaudeReviews()` returns one item per PR scoped to the timeline window (`ClaudeReviewListItem` carries `repoFullName`, `prId`, `prNumber`, `verdict`, `summary` — see `ClaudeReviewsModal` `ReviewRow` 33-69). So for the Inbox "previous Claude reviews per repo" requirement, the *retrieval/grouping* is what's missing (group existing `ClaudeReviewListItem[]` by `repoFullName`/repoId), not necessarily new storage — matching the task's hypothesis.

## Cleanest insertion point (mechanical summary, not a design)
- **Top-level tab axis already exists**: `ActiveTab = 'timeline' | number` in `store/pinnedTabs.ts` (18). Adding `'inbox'` reuses `setActiveTab`, the `<main>` overlay slot (App.tsx 423-430), the `inert` a11y handling (129-136), the Escape→`showTimeline()` precedence (`useKeyboard.ts` 34-38), and — critically — **every `filters.ts` nav action already calls `showTimeline()`** (638/666/677/693/712), so timeline navigations auto-exit Inbox for free.
- **Header is where the tab control lives** (App.tsx 205-373), alongside Insights/Claude-Reviews buttons; an unflagged Timeline|Inbox segmented control sits naturally next to `<FeedPill/>`/`<CountsPill/>` (241-242).
- **Inbox body** = a new full-`<main>` component reusing `MyTurnPanel`'s sectioned-scroll layout, `SummaryStats`/`InsightsModal` repo aggregations, the `charts/common.tsx` cards, and the `lib/ui.ts` + `Avatar`/`UserName`/`WatchedBadge`/`MaintainerShield` primitives.
- **PRO digest** = mirror `claudeReviewEnabled`: add a capability to `MeResponse` (`packages/shared/src/types.ts` 296-305), read it `me.data?.x ?? false` (App.tsx 86 pattern), render the digest sub-section only when true.

---

## Appendix — Reference map — Claude Review UI interaction points

I now have a complete end-to-end map. Here are my findings.

---

# Claude Review feature — end-to-end map

## A. Backend module map (`apps/backend/src/review/`)

**`agent.ts` — the model-invocation seam.** `runReview(args: RunReviewArgs)` (L111) owns the whole run. The actual model call is `query({ prompt: buildUserPrompt(...), options: { model, effort?, systemPrompt, cwd, allowedTools, disallowedTools, maxTurns, maxBudgetUsd, mcpServers: { review: server }, abortController } })` (L273-302) from `@anthropic-ai/claude-agent-sdk`. **Structured output leaves the agent through exactly ONE seam**: the in-process MCP tool `tool('submit_review', …, submitReviewShape, async (a) => { captured = a … })` (L261-270). After capture, findings are line-anchored against `strippedDiff` (L366-385: each gets `anchored: isFindingAnchored(...)`, `fileInDiff: index.has(f.path)`, `diffHunk: extractHunk(...)`) then handed to `saveReviewSuccess`. `buildUserPrompt` (`prompt.ts` L207) and `systemPromptForMode` (L186) are the **prompt-construction seam** where any learnings/memory context would be injected — note `buildUserPrompt`'s input has no slot for prior-review context today; it takes PR metadata + `changedFiles` + `diff` only.

**`persist.ts` — all DB writes.** Key write functions and what they stamp:
- `insertQueuedReview(prId, headSha, model, accountId)` → returns new review id (L66).
- `saveReviewSuccess(id, data)` (L107) — one transaction: stamps Claude's read-only `summary`/`verdict`/`scope`/telemetry, then inserts each finding with `included: true` (opt-OUT model, L148-152).
- **`updateReviewDraft(id, {userBody?, userVerdict?})`** (L193) — saves the user's authored draft; never touches Claude's summary/verdict.
- **`updateFinding(findingId, {included?, editedBody?})`** (L216) — tick/untick + reword; empty-string `editedBody` clears the reword to null.
- `markReviewPosted(id, postedReviewId, inlineFindingIds, prComments)` (L240) and `markFindingPosted(findingId, githubCommentId, kind)` (L277) — stamp GitHub-post results.

**`post-review.ts` — line-anchoring + the single review POST.** Re-exports the pure anchoring helpers from `github/diff-anchor.ts` (L25-36). `buildReview(input)` (L108) routes each included finding: anchorable → inline `comments[]`; unanchored-but-file-in-diff → inline on first change (fallback note); file-not-in-diff → `prComments[]`. `findingCommentBody(f, opts)` (L168) picks `f.editedBody` (reword) over `f.body` (Claude's). GitHub calls: `submitGithubReview` (L252, the single review with inline comments+body+verdict), `submitGithubComment` (L285, single inline), `submitGithubIssueComment` (L316, PR-level). `fetchCurrentHeadSha` (L221) drives the head-moved 409 guard.

**`review-manager.ts` — job/concurrency.** In-memory `running`/`pending`/`claimed`/`controllers` maps. `startReview` (L48) reserves `claimed` synchronously, inserts the queued row, launches or queues by `config.reviewConcurrency`. `requestReviewCancel` (L153) aborts via `AbortController`. `getReviewStatus` (L174) / `listActiveReviews` (L194) feed the live banner. Hard-coded `LOCAL_ACCOUNT_ID` throughout (local-only feature).

**`routing.ts` — the skip/diff_only/worktree gate.** `decideReviewMode({diff, requested})` (L157) — forced modes bypass the gate; `auto` → `skip` when `linesChanged===0`, else conservative ceiling/apiTouch gate. Produces `ReviewRouteReason` with `{changedFiles, linesChanged, dirsTouched, subsystems, apiTouch, decidedBy, trippedBy}` — recorded via `markReviewRouted`. **This metric object is the natural per-PR "level of change" signal Workstream 2 wants** (computed from the diff, no AI).

**`schema.ts` — the `submit_review` tool contract.** `submitReviewShape` (L6) — zod shape: `{summary, verdict, scopeUsed, findings: [{path, line?, side?, severity, title, body, suggestion?}]}`. This is the canonical finding shape (path/line/side/severity/title/body) every capture hook will mirror.

**`local-settings.ts` — BYO-key.** `getUserAnthropicKey`/`hasUserAnthropicKey`/`setUserAnthropicKey` persist to `~/.pierre-review/config.json` (mode 0600). `applyUserAnthropicKey()` (L63) mutates `process.env` for one run, gated on `reviewConcurrency===1`. `config.isCloud` short-circuits everything (local-only).

## B. Routes (`apps/backend/src/api/routes/claude-review.ts`)

Whole file is gated by `config.claudeReviewEnabled`; mutating routes call `featureOff(reply)` → 404 when off.

| Route | Handler line | Persist/query touched |
|---|---|---|
| `GET /api/prs/:id/claude-review` | L145 | `getLatestClaudeReview` + `listClaudeReviewHistory` + auth/key status |
| `PUT /api/claude-review/key` | L174 | `setUserAnthropicKey` (local only) |
| `POST /api/prs/:id/claude-review` | L194 | `startReview(id, model, mode??'auto')` → 202 |
| `GET /api/prs/:id/claude-review/status` | L238 | `getReviewStatus` (poll target) |
| `POST /api/prs/:id/claude-review/cancel` | L250 | `requestReviewCancel` |
| `GET /api/claude-reviews` | L268 | `listAllClaudeReviews` (cross-PR, one per PR) |
| `GET /api/claude-reviews/active` | L278 | `listActiveReviews` |
| `GET /api/claude-reviews/:reviewId` | L287 | `getClaudeReviewById` |
| **`PATCH /api/claude-reviews/:reviewId`** | L303 | **`updateReviewDraft`** (userBody/userVerdict) — *manual rewrite hook* |
| **`PATCH /api/claude-findings/:findingId`** | L320 | **`updateFinding`** (included/editedBody) — *tick/untick + reword hook* |
| **`POST /api/claude-findings/:findingId/post`** | L342 | head-move guard → `submitGithubComment`/`submitGithubIssueComment` → `markFindingPosted` — *post-comment hook* |
| **`POST /api/claude-reviews/:reviewId/post`** | L446 | `updateReviewDraft({userVerdict})` then `buildReview` → `submitGithubReview` → `markReviewPosted` (`?dryRun=true` returns payload only) — *submit-review hook* |

`accountIdOf(req)` (from `../plugins/auth.js`) is the single scoping seam on every read.

## C. Frontend map

**`components/ClaudeReviewTab.tsx`** (the entire interactive surface, 1538 lines). Mounted in **`components/PrDetail.tsx`** as the `'claude_review'` tab — the tab array itself is gated: `claudeReviewEnabled ? [...,'claude_review'] : [...]` (L611), rendered `<ClaudeReviewTab pr={pr} usersById={usersById}/>` (L696). `claudeReviewEnabled = useMe().data?.claudeReviewEnabled` (L379); the store's `claudeTabFocus` auto-switches to this tab when set (L427-431).

**`hooks/useClaudeReview.ts`** — one hook per mutation: `useGenerateReview` (model+mode), `useUpdateReview` (userBody/userVerdict), `useUpdateFinding` (included/editedBody), `usePostFinding`, `usePostReview` (dryRun + real), `useCancelReview`, `useSetClaudeKey`, plus queries `useClaudeReview`/`useClaudeReviewById`/`useClaudeReviewStatus`/`useActiveClaudeReviews`/`useAllClaudeReviews`. API methods live in `api/client.ts` L199-250.

**Header "Claude Reviews history" button** — lives in **`App.tsx` L303-329**, gated by `claudeReviewEnabled`, `onClick={() => setReviewsOpen(true)}`. It opens **`components/ClaudeReviewsModal.tsx`** (mounted L380-385, also gated). The modal fetches `useAllClaudeReviews(open)` → `GET /api/claude-reviews` and renders one row per PR (`ReviewRow`, L33). Clicking a row calls `openClaudeReview(prId)` (store action in `store/filters.ts` L734) which sets `claudeTabFocus` → PrDetail snaps to the Claude Review tab. **The modal rows today show only: prTitle, prNumber, repoFullName, verdict, relative time, summary line — there is NO per-entry collapsible action history (Workstream 3's requirement is net-new here).**

## D. EXACT user-interaction capture hooks for learnings/memory

Every interaction below already round-trips through a backend route, so each is a clean capture point. Data each carries:

1. **Finding accept/reject (tick/untick "Ignore"/"Un-ignore")** — UI: `FindingRow` `onToggle(included)` → `useUpdateFinding.mutate({findingId, included})` (ClaudeReviewTab L1365-1367, L654/L710). Route: `PATCH /api/claude-findings/:findingId` body `{included}`. **Captured signal**: which finding the user excluded/kept. Data available on the finding row: `path`, `line`, `side`, `severity` (category), `title`, `body` (Claude's wording), `suggestion`, `editedBody`, `anchored`, `fileInDiff` — all on `claude_review_findings` (`schema.sqlite.ts` L507-551). `included=false` = reject signal; default-true-kept = implicit accept.

2. **Manual reword of a finding** — UI: `onReword(editedBody)` → `useUpdateFinding.mutateAsync({findingId, editedBody})` (L1368-1370; saveReword L426, clearReword L430). Route: same PATCH, body `{editedBody}`. **Captured signal**: the user rewrote Claude's wording → `body` (original) vs `editedBody` (user's words) for a given `path`/`severity`/`title`. The single richest "wording correction" signal.

3. **Manual rewrite of the overall review draft (body + verdict)** — UI: `userBody` textarea `onBlur`/Save → `useUpdateReview.mutate({reviewId, userBody})` (L1392-1394, L1402-1404); verdict `<select>` `onChange` → `updateReview.mutate({reviewId, userVerdict})` (L1419). Route: `PATCH /api/claude-reviews/:reviewId` body `{userBody?, userVerdict?}` → `updateReviewDraft`. **Captured signal**: `summary`/`verdict` (Claude's) vs `userBody`/`userVerdict` (user's) — a verdict-divergence + summary-rewrite signal at PR scope.

4. **Post a single finding as a comment** — UI: `handlePost` → `usePostFinding.mutateAsync({findingId})` (L1371, L442-455). Route: `POST /api/claude-findings/:findingId/post` → `markFindingPosted`. **Captured signal**: the user endorsed this finding enough to ship it; carries `path`/`line`/`side`/the posted `editedBody||body`, and `postedCommentKind` ('inline'|'pr_comment').

5. **Submit the whole review to GitHub** — UI: `runPost` → `usePostReview.mutate({reviewId, userVerdict})` (L1128-1135). Route: `POST /api/claude-reviews/:reviewId/post` → `markReviewPosted`. **Captured signal**: final `userVerdict`, and exactly which findings shipped (`built.inlineFindingIds` + `prComments`) vs which were ignored — the strongest accept/reject ground-truth, plus the user's overall `userBody`.

6. **(Secondary) Copy buttons** — `copy()` per finding (L415) and there is no overall-copy; purely client-side `navigator.clipboard`, no network call → **NOT a capturable hook without new instrumentation.**

7. **(Secondary) Run kickoff with model/mode** — `runGenerate` → `useGenerateReview.mutate({model, mode})` (L1098). Carries `model` + `RequestedReviewMode` choice — a per-repo depth/model preference signal.

**The dimensions Workstream 3 wants to key on (repoID + path glob + category) are all present:** `path` (→ glob) and `severity` (→ category) live on `claude_review_findings`; `repoID` is reachable via the existing join chain `claudeReviews.prId → pullRequests.repoId → repos` (used in `getClaudeReviewById` L2655-2657, `getFindingPostContext` L2878-2882). No table currently stores the *interaction* itself — only the resulting state (`included`, `editedBody`, `userVerdict`, `postedAt`). Capturing longitudinal actions (tick history, reword diffs, verdict overrides) requires NEW storage; the *signals* are all derivable at these 5 hooks.

## E. The TWO surfaces to render past-review matches

**Surface 1 — pre-new-review (before initialising a run).** Lives in `ClaudeReviewTab.tsx`, the run-controls block at L1158-1252 (Model/Depth selects + "Run review"/"Re-review" button, the depth hint at L1210, the same-SHA confirm at L1221). This is where past-review matches for the PR's touched paths/categories would surface before the user clicks run. The data source already exists per-PR: `data.history` (`ClaudeReviewSummary[]`) from `GET /api/prs/:id/claude-review` is rendered only as a `<select>` history dropdown today (L1332-1352) — there is no "here's what we learned last time" panel yet.

**Surface 2 — the Header "Claude Reviews history" button.** `App.tsx` L303-329 button → `ClaudeReviewsModal.tsx`. The modal's `ReviewRow` (L33-69) is where each history entry needs the new **collapsible "actions made upon this review"** area. Currently each row is a flat button (prTitle/verdict/summary) with no expand. The list is one-row-per-PR from `listAllClaudeReviews` (queries.ts L2723) — **repo-oriented retrieval is the gap, not storage**: `claude_reviews` is already keyed by `prId`+`headSha` with full history kept (`listClaudeReviewHistory` L2691 returns all runs per PR), and the repo is joinable, but no query groups reviews *by repo* or returns *per-entry action history*. Workstream 2's "list previous full Claude reviews per PR in a repo-oriented way" is achievable by a new repo-scoped retrieval query over the existing `claudeReviews`/`claudeReviewFindings` tables — no new review storage needed for retrieval; only the *learnings/action-capture* (Workstream 3) needs a new table.

**Dual-dialect note for any new table/columns:** `claude_reviews`/`claude_review_findings` are defined in BOTH `db/schema.sqlite.ts` (L438-551) and `db/schema.pg.ts` (parity-guarded); all reads use portable terminals (`.execute()`) and `runTransaction` (see `saveReviewSuccess` persist.ts L111, `markReviewPosted` L247). Any learnings table must follow the same dual-dialect + `accountId`-scoping pattern.