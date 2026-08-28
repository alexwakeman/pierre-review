# Frontend: state model, UI regions, timeline & PR detail

> Split out of CLAUDE.md (2026-08) to keep the root memory file lean. This is the
> authoritative deep-dive for this area; CLAUDE.md keeps only the summary and the
> cross-cutting landmines. Add new detail HERE, not to CLAUDE.md. References to other
> sections of the old CLAUDE.md resolve via the doc map at the top of CLAUDE.md.

## Frontend

### State model

Three layers, deliberately separated:

1. **Server state** → TanStack Query (`useTimeline`, `usePr`, `useTriage`). Timeline query
   keys are built from the active filters (a filter change refetches); PR/thread detail is
   fetched **on demand** on selection.
2. **Filter & selection state** → the Zustand store `store/filters.ts` (`useFilters`):
   **`workspaceId: number | null`** (the scope), repos/members/range, category + derived-state
   filters, the selected PR/thread, transient timeline hints (`timelineFocusPr/At/Event`,
   `timelineCenterAt`), and the `feedMyTurnOnly` feed filter. (The old overlay-focus signals
   `focusActive`/`myTurnOnly`/`timelineIsolate`/`exitFocusSignal` were **removed** — focus is now
   a tab, see below.)
   - ⚠ **`workspaceId === null` means "not resolved yet"**, and **nothing may render
     workspace-scoped data while it is null** — a sync effect fills it from `listWorkspaces()`'s
     default the moment the query lands. `repoIds: number[] | null` keeps its type but its meaning
     shifted: `null` = every repo IN THE ACTIVE WORKSPACE.
   - **All five `TeamScope` canonicalisers are GONE with no replacement** — `scopeToParam`,
     `teamSetToScope`, `scopeToTeamSet`, `teamIdsInScope`, `isMultiTeamScope`. A number needs no
     canonicalisation; that is the entire point.
   - ⚠ **`useWorkspaceSync` must NOT keep `repoIds` in lockstep with the workspace's membership** —
     that and per-repo show/hide are mutually exclusive and the membership would win. The contract
     is three-branch: `workspaceId` null-or-dead ⇒ set Default and re-derive `repoIds`;
     `workspaceId` CHANGED **BY A SWITCH** ⇒ re-derive for the new workspace; **otherwise PRUNE
     ONLY** (drop ids no longer in the workspace, leave a user-narrowed subset — and `null` —
     alone). Track the previous id in a ref: a write-only-if-different guard is necessary but not
     sufficient, because `repos`/`workspaces` are React Query results whose identity changes on
     every background refetch.
   - ⚠ **A CHANGE OF WORKSPACE IS NOT ALWAYS A SWITCH.** Back/Forward can move that id too, and a
     popped URL that named a workspace AND carried its own `?repos=` is a RESTORE: branch (2) would
     widen the board a tick after the pop narrowed it, which is exactly how `repoIds` used to be
     the one key in the history bundle that did not survive a Back. `applyUrlToStores` arms
     `restoredScopeWorkspaceId` synchronously as it hydrates; branch (2) reads it through
     `consumeRestoredWorkspaceScope(id)` — **keyed on the id and ONE-SHOT**, so it can never
     suppress a later genuine switch — and falls through to the PRUNE path instead, which still
     drops ids that have since left the workspace. The effect body is the exported
     `syncWorkspaceScope()` so the three branches can be exercised by a test with no React
     renderer (`test/urlHistory.test.ts`).
3. **Tab state** → `store/pinnedTabs.ts` (`usePinnedTabs`): `ActiveTab = 'timeline' | 'activity'
   | <Tab.key>`; a `Tab{key,kind:'pr-detail'|'pr-focus'}` list. `openPrDetailTab` /
   `openPrFocusTab` / `closeTab`. Exactly one board mounts at a time (App keys the board slot;
   see "focus tabs"). (The old My-Turn tab kind + `openMyTurnTab` + the `m` key were removed —
   situational awareness is the Feed + its "My Turn only" toggle.)
4. **URL** → `useUrlState.ts` mirrors the store to the query string both ways (shareable /
   reloadable); the serializer diffs against **defaults**, so the common case stays clean.
   - **THE URL IS THE APP'S ONLY HISTORY AUTHORITY, and every view has one.** `view=` names the
     two boards AND the four self-describing tab kinds, spelled as the `Tab.key` VERBATIM
     (`pr-detail:123`, `pr-focus:123`, `user-activity:45`, `bot-detail:45` — one vocabulary, not a
     URL dialect); the narrowings a reader navigates TO are keys of their own (`attn=<InsightKind>`
     for the attention board, `feedPr=<id>` for the Feed, `feedTab`/`botsTab` for the two Activity
     sub-tab strips, `prTab` for PrDetail's inner tab, which is a `{prId, tab}` PAIR in the store
     so one PR's tab can't be read on another's screen).
   - ⚠ **NAVIGATIONS PUSH, REFINEMENTS REPLACE — decided by DIFFING `NAV_KEYS`**, never by a
     `push:true` argument threaded through call sites (the 15th caller forgets) and never per
     store write (Safari throws past ~100 pushes/30s). `pr`/`thread` are deliberately NOT nav
     keys: clicking through PR bars is a selection, and historying it makes Back a per-click undo
     stack.
   - ⚠ **EVERY CORRECTIVE WRITE IS MARKED AT ITS SOURCE — `writeToUrl` never infers one from the
     URL's SHAPE.** A write that reconciles state the reader did not ask for must REPLACE, and the
     only place that knows a write is corrective is the code making it. Four do:
     `syncWorkspaceScope`'s **fallback branch** (`workspaceId` unresolved, or naming a workspace
     this account no longer has), the **first serialization after hydrate**, `applyUrlToStores`'
     **post-pop reconcile**, and PrDetail's deep-link `seedTab`. The workspace half used to be a
     shape test in `writeToUrl` (`prev` names no `workspace`, `p` does) and it was wrong in both
     directions: FALSE during the resolution window (a navigation made before `/api/workspaces`
     lands emits no `workspace` either, so it already pushed correctly) and TRUE forever after for
     any genuine navigation made FROM an entry minted before the scope resolved — the reader's next
     Back left the SPA. ⚠ And the fallback branch is a **TRAP, not merely an extra entry**: pushed,
     it lands ON TOP of the entry the reader just reached, whose URL still names the dead
     workspace — so the next Back pops right back into the same branch and pushes again. Back
     becomes a permanent no-op (reproduced from a mid-session workspace delete AND from a cold load
     off a stale bookmark / cross-account link). Pinned in `test/urlHistory.test.ts`.
   - ⚠ **The serializer is COALESCED into a microtask** (`scheduleUrlWrite`). One gesture is
     routinely several store writes — the Welcome-back banner's line is four setters — and written
     straight through, that click would stack four entries. An effect that fires in a LATER task
     is a genuinely separate write; the ones that seat a tab as a view opens (PrDetail's deep-link
     effects) call `markUrlCorrection()` to replace instead of push.
   - ⚠ **`popstate` REHYDRATES BOTH STORES from the popped URL** (the one listener, in
     `useUrlState`; `App.tsx`'s store-flag handler and pinnedTabs' `{pierreTab}` pushes /
     `navigateBack` are GONE — two authorities reacting to one event is what made Forward change
     the address bar without moving the screen). The pop is **TOTAL**: `readFromUrl` is partial by
     design, so `applyUrlToStores` resets `freshFilterDefaults()` + `freshUrlOwnedDefaults()`
     first, or Back off a narrowed board leaves the narrowing standing. Never `freshDefaults()` —
     that wipes `sprintChatThreads`, `syncRound`, `repoConsoleTabs` and every drill-down seed,
     which the URL never serialized and cannot restore. `workspaceId` is exempt: `null` means "not
     resolved yet", so a URL naming none keeps the live one. The write subscriptions check
     `applyingUrl` **synchronously**, or a pop re-serializes the entry it just landed on.
   - ⚠ **…and the pop then RECONCILES THE ADDRESS BAR, marked as a correction** — the same eager
     replace the cold load does, for the same reason: after `applyUrlToStores` the stores hold the
     CANONICAL reading of the popped URL, which is not always the popped URL. A seed-backed
     drill-down entry emits no `view` at all and drops `activityRepo` with it (both live inside
     `writeToUrl`'s `activity` branch), and a legacy `?team=<int>` is read as `workspace`. Left
     un-reconciled the store says `activity` while the URL says nothing, and the reader's next
     PURE REFINEMENT is diffed as a `view` change and **PUSHES** — destroying the forward stack and
     turning a filter click into a history entry. A replace can only ever rewrite the CURRENT
     entry, so the forward stack survives; an already-agreeing URL costs nothing (`writeToUrl`
     string-compares and returns).
   - **Seed-backed drill-downs stay EPHEMERAL** (`bot-flagging`, `people-report`, `search`, …):
     their identity is an in-memory seed a restored blob could point at a tile that no longer
     exists, so no URL names them. They emit no `view` at all — itself a distinct URL — and a
     refresh or a Forward onto one resolves to Activity.
   - ⚠ **URL-visible ≠ persisted.** `attn`/`feedPr`/`feedTab`/`botsTab`/`prTab` are transient
     store fields that are NOT in `FilterDefaults`, so they owe **no** `FILTER_STORAGE_VERSION`
     bump — a link may name a narrowed board; a fresh tab must not restore one.
   - ⚠ **`repoIds` survives a Back ACROSS A WORKSPACE SWITCH only because the pop ANNOUNCES
     ITSELF.** Seating the popped URL's `?repos=` is half the job: `useWorkspaceSync` runs a tick
     later, sees the workspace id differ from its ref and would re-derive — `setWorkspace(id,
     null)` — widening the board straight back. So `applyUrlToStores` arms
     `restoredScopeWorkspaceId` (workspace + `?repos=` both named) and the sync effect consumes it
     to take the PRUNE path; see the `useWorkspaceSync` bullets in §2 for the exact contract. Every
     other key in the bundle (`workspace`, `activityRepo`, `attn`, `feedPr`) needs no such signal —
     nothing else re-derives them after the pop.
   - ⚠ **`?workspace=` is the ONE exception to the diff-against-defaults rule**: there is no static
     default (the Default workspace's id varies per account), so it is emitted **always once
     resolved** and **omitted entirely while `workspaceId` is null** — `writeToUrl` runs from the
     store subscription, which fires on the very first hydrate, so an unconditional `p.set` writes
     the literal string `?workspace=null` on every bare load.
   - ⚠ **`?team=` is dropped but `?repos=` is NOT, and that combination is the trap.** A link in
     the wild (`?team=3&repos=7,9,11`) would otherwise land the user in Default while hydrating
     another workspace's repo ids — a header saying "Default" over someone else's repos, with the
     request honouring them. The rule: `?workspace` absent **and** `?team=<int>` present ⇒
     `workspaceId = <int>` (migration `0044` preserves the team ids deliberately) and `?repos` is
     honoured; `?team` = `all`/`none`/`teams`/`teams:…` (or absent) ⇒ ignore both and **discard
     `?repos`**; and in every case `repoIds` is **PRUNED to the resolved workspace's membership
     before any query runs**. `sanitizePersistedFilters` likewise **drops a persisted `teamScope`
     key entirely** rather than coercing `teamScope: 3` into `workspaceId: 3` — the ids happen to
     be preserved, but `'all'`/`'teams'`/`[2,4]` have no image, and half-migrating persisted state
     is worse than discarding it.

**Auth gate (cloud only).** `App.tsx` calls `useMe()` first; a **401** (cloud, signed out)
renders `<SignInGate>` instead of the app, and a **sign-out** control shows when
`me.deploymentMode === 'cloud'`. Local `/api/me` never 401s, so the app renders as before.
`api/client.ts` sends `credentials` (the session cookie) on every request.

### UI regions (`App.tsx`)

- **FilterBar** — the scope row is **`WorkspaceSelector` + `GlobalSearch`, which show on EVERY
  view**; everything else, `RepoSelectPanel` included, is Timeline-only.
  - **`WorkspaceSelector`** (was `TeamSelector`) is a **single-select RADIO list** — no "All
    repos", no "All Teams", no "No team", no checkboxes, no `toggleTeam`. Default first (badged
    "Default"), then the rest by name, each with its repo count; the trigger label is the active
    workspace's NAME (never "All repos" / "N teams"). Its footer opens the
    **`WorkspaceManager`** modal ("Manage repos & workspaces"), where repo add/remove/assignment
    and the debounced GitHub search picker (`RepoSearch` → `/api/repos/search`) live (a successful
    add pops the sync-progress modal via `syncModalSignal`); `RepoSearch` also mounts standalone
    inside `FirstRunOnboarding` (zero-repo first run). Each row also carries an **amber My-Turn
    badge** and the collapsed trigger carries the OTHER workspaces' total — see *Per-workspace
    "My Turn"* below.
  - **`RepoSelectPanel` is TIMELINE-ONLY, and `filters.repoIds` is therefore timeline-local in
    effect.** It lists **only the active workspace's repos**, never the account's; `repoIds = null`
    means "every repo IN THIS WORKSPACE"; it canonicalises to `null` at all-or-none and won't hide
    the last one. ⚠ **No per-row remove** (a visibility panel that deletes a repo is a footgun;
    removal lives in `WorkspaceManager`) and **no per-row watch toggle** — the "watched" concept is
    gone (migration `0046` / pg `0033`); every repo in a workspace is fully live. Its empty state is
    the ordinary *empty-workspace* state: "No repos in this workspace — move some in from Manage
    repos & workspaces."
  - **⚠ Activity, the Feed, Bots and Reports ALWAYS cover every repo in the selected Workspace —
    the picker must never silently scope a screen that cannot see it.** It briefly sat outside the
    `isTimeline` gate on the reasoning that the Activity console "reads `repoIds` hardest", which is
    exactly the trap: a control the user set on the Timeline then narrowed a console that renders no
    such control, so the same workspace showed different repos on different tabs with nothing on
    screen to explain it. **The Workspace is the scope; the rail is how you narrow it.** Clicking a
    repo row in the Activity rail is the per-repo view, and that is a DIFFERENT mechanism
    (`filters.activityRepoId`, a single repo id) which is unchanged — as are the drill-down tables'
    own repo-column filter dropdowns (`BotThreadsDetail`, `BotOnlyPrsDetail`, `MetricRepoFilter`),
    which filter rows already on screen rather than scoping a fetch.
  - Timeline-only, i.e. rendered **only when the Timeline board is the active tab**
    (`isTimeline = activeTab === 'timeline'`): Members (auto-scoped, exclude-bots toggle), range
    presets (7/14/30/90d/custom) + a **Now** action (`timelineCenterAt`), event categories,
    derived-state tags, and the right-hand Clear-filters cluster. Activity, Insights,
    PR-detail/focus tabs and every drill-down keep just the scope row. The filter STATE persists
    (reachable again from the Timeline tab); the Activity console's queries never send
    `userIds` or the FilterBar's exclude-bots toggle/allow-list anyway (its bot control is the
    feed's bot-lens pills — whose 'hide', the DEFAULT, rides the feed route's own `excludeBots`
    param server-side); the board stays member-scoped. **Bots are HIDDEN by default on the
    Timeline too** (`excludeBots: true` in `freshFilterDefaults`; the hidden set is the UNION of
    `users.isBot` and the workspace's automated-reviewer verdict, a workspace manual "human"
    winning both ways). The URL follows the excludeStale pattern — `bots=0` = shown, clean URL =
    hidden, legacy `bots=1` still parses — and the persisted blob's v2→v3 migration
    (`migratePersistedFilters`, `useUrlState.ts`) drops only `excludeBots`/`allowedBotIds` so
    existing users get the new default once without losing the rest of their filter bar. ⚠ **`workspaceId` must NOT live in `FilterDefaults`** — persistence and reset
    share one list (`pickFilterBarState` writes exactly `FilterDefaults`, `resetAllFilters` spreads
    `freshFilterDefaults()`), so a persisted `workspaceId` would also be **reset by "Clear
    filters"**, silently teleporting the user into Default whenever they cleared a date range. It
    is persisted in its own slice and `resetAllFilters` preserves it explicitly. The
  **Members panel** (`UserSelectPanel`) shows only each repo's **maintainers by default** and
  collapses the non-maintainers behind a per-repo **"Show N more"** (10 at a time; "Show fewer"
  re-collapses; `shownOthers` per-section state, reset on open) — a **search bypasses the
  collapse** (shows all matches flat) so no member is unreachable. Its sticky per-repo headers
  (member + bots sections) carry `z-10` + an opaque bg so scrolling rows don't bleed through.
- **Timeline** — the centerpiece (below).
- **DetailPane** — resizable bottom pane (height persisted) under the board slot. **Hidden
  until a PR is selected** (`selectedPrId != null && !overlayActive`); no selection → the
  Timeline takes the full height (App fires a synthetic `resize` on the transition so vis
  refits). Shows **PrDetail** for the selected PR. **App lands on the Activity console by
  default** (Activity-first; a bare load → `?view=activity`, deep links keep timeline).
- **`AutoMergeBanner`** — the armed-merge PROGRESS STACK, a bottom-right card (same shape as
  `ClaudeReviewBanner`) fed by `GET /api/auto-merge`. One row per armed PR from the click that
  arms, through the watcher's `phase`, to the outcome — see "The armed-merge progress stack"
  below and docs/MERGE-CI-TRUNK.md.
- **Tabs / board slot** (`PinnedTabsBar` + `App.tsx`). `<main>` renders exactly ONE
  `<Timeline>` "board slot" whose `mode` derives from the active tab: absent = the shared
  board; `{kind:'isolate',prId}` = a **pr-focus** tab's own isolated Timeline. `activity` +
  `pr-detail` render as overlays OVER the warm board; `pr-focus` REPLACES the slot (keyed
  remount → at most one vis instance live). `PinnedTabsBar` is **always shown**: **Activity**
  + **Timeline** are the first two chips — permanent, **non-closable** tabs (the header
  segmented control was removed; the tab strip is now the single place to switch views). The
  dynamic tabs (pr-detail / pr-focus) follow as closable PR-named chips. **Closing the active
  tab moves to the adjacent tab** (left, else right, else the Timeline board) — it does NOT
  snap back to the board when other tabs remain (`closeTab` in `store/pinnedTabs.ts`).
  **Dynamic chips are DRAG-REORDERABLE** (pointer events + 4px threshold, matching the
  splitter/marker-popover precedents — no HTML5 DnD, no dependency; preview order in local
  state, ONE `moveTab` store commit on drop so `persist()`/the URL subscription don't run
  per-frame; avatars get `draggable={false}`; `touch-action:none` or the strip's own
  horizontal scroll swallows touch drags; order persistence is only as durable as tab
  persistence — pr tabs survive a reload, drill-down positions don't). **A drag carries a
  GHOST**: a `position: fixed` copy of the chip that follows the pointer while the original
  stays half-transparent as the hole it came out of. It is a **`cloneNode` of the live chip**,
  not a re-rendered label — the per-kind bodies (PR avatar + two lines, drill-down emoji,
  search magnifier) live in `TabChip`'s config ladder and a hand-built ghost would be a second
  copy of all of it. The clone is stripped of `data-tabkey` (the drop-slot maths enumerates
  those, so a ghost carrying one would count itself) and of its ✕, and its host is a SIBLING of
  the strip: the strip is `overflow-x-auto`, and one `transform` added to it later would make it
  the containing block and clip a `fixed` child to the 42px bar. **Every closable chip is the
  same width** (`w-52` in `ChipShell`, labels absorbing it via `min-w-0 flex-1 truncate`), so the
  ✕ sits at the same offset on every tab — a close button that moves with the label length is a
  moving target in a row of tabs. The fixed Activity/Timeline chips stay content-sized: they have
  no ✕ and are not "tabs that open". **Right-click opens a
  context menu** (floating-ui in a `FloatingPortal` — the strip is `overflow-x-auto`, an
  in-flow menu would clip to the 42px bar — virtual reference at the click point): Close this
  tab / Close other tabs / Close all tabs (`closeOtherTabs`/`closeAllTabs` in the store; on
  the fixed Activity/Timeline chips the menu shows only "Close all tabs"; "close all" keeps
  you on a fixed view if that's where you are, mirroring `closeTab`'s fallback). ⚠ The menu's
  (and an in-flight drag's) Escape MUST `stopPropagation` or `useKeyboard`'s global Escape
  also yanks the user to the Timeline. TabChip is now one shared `ChipShell` — the nine
  per-kind branches collapsed to a config switch, which is what made the drag/menu handlers a
  one-place change; the e2e selectors (`data-testid="pinned-tabs"`, `role="tab"` names, ✕
  aria-labels) are load-bearing and survived.
  Besides the PR tabs there's a family of **singleton, EPHEMERAL drill-down tabs** (never
  URL/localStorage-persisted; a reload drops them): `metrics-detail`, `bot-prs`, `open-prs`
  (**THE consolidated open-PR view** — the shared `OpenPrsTable` over `GET /api/open-prs`:
  age/author/LoC/untouched-threads/CI/approval columns, drafts included with a "· N drafts"
  callout. Reached from BOTH the Feed pane's per-repo "Show all" footers (repo scope) AND the
  Flow-metrics "Open PRs" tile (`openOpenPrsDetail('feed')` = whole workspace, "All repos"
  chip, plus a LOCAL `MetricRepoFilter` that must never write `filters.repoIds`) — the old
  `MetricsDetail` `open_prs` sub-tab is GONE. Its fetch goes through `scopedOpenPrsSearch`,
  byte-identical to `workspaceOpenPrsSearch` when unscoped so the tab shares the Feed's cache
  entry, and always carrying `workspace=` alongside `repoIds=` — pinned in
  `workspaceOpenPrsScope.test.ts`), `bot-only-prs`
  (sortable + Age/Updated + cross-repo repo-filter dropdown), and `bot-threads` (sortable +
  DESELECT-by-default + Select-all/Clear across pages + Stop + repo-filter + client pagination;
  scope-wide review & resolve). **`user-activity` is the one drill-down keyed PER USER**, not a
  singleton (`userActivityKey(userId)` / `parseUserActivityKey`): two people's feeds can sit side
  by side and re-clicking a handle re-focuses their tab. It needs no filters-store seed — the tab
  KEY carries the userId, so a stale key can never show the wrong person; `Tab.userMeta` carries
  the chip's label/avatar. It renders `UserActivityDetail` → `<FeedView userIds={[id]}/>`, which
  is a real ACTOR filter (`inArray(events.actorId, …)`); `getConsolidatedFeed` skips the
  actor-less Claude-run items whenever `userIds` is set, and FeedView drops its cross-repo
  Open-PRs panel + the My-Turn "seen" marker under that scope. **Merge/close rows are recorded
  against the PR's AUTHOR** (`sync/upsert.ts` writes `actorId: authorId`), so on this tab they
  mean "a PR they authored was merged" — the header caption says so rather than implying they
  pressed merge. **Row click across ALL these list surfaces (the drill-down TABLES
  + the inline `OpenPrRows`/`FeedOpenPrsPanel` lists) now
  opens the PR's own detail TAB** (`openPrDetailTab`) — the old feed-isolation / timeline-focus
  on-click + the ⧉ button were removed; **feed isolation is reached from PrDetail's "Show in
  Activity feed" header button** (`FeedIcon`: `setRepoConsoleTab(repoId,'activity')`→`setActivityRepo`
  →`setFeedIsolatedPrId`→`showActivity`, order load-bearing). `bot-threads` rows open the PR's
  Threads tab with the `likely_addressed` pill preset. **Repo-scoped chips show the repo name**
  (`PinnedTabsBar` `TabChip` reads the seed + `useRepos`). Each drill-down = a `TabKind` + key
  const + opener in `pinnedTabs.ts`, a transient read-not-consumed seed + `openXDetail()` action in
  `store/filters.ts` (`{fromActivity:true}` stamps the feed card to flash on a Back — the entry
  itself is the URL's, see the Back-button note below), a full-`<main>` overlay
  branch in `App.tsx` (MUST join `overlayActive`), and a compact chip in `PinnedTabsBar`. The
  drill-down TABLES (open-prs / bot-only-prs / bot-threads, **plus `MetricsDetail`** — now
  retrofitted, per-tab `sortByTab` state) share `Activity/sortableTable.tsx`
  (`SortHeader`/`compare`/`nextSort`; numeric columns MUST return a number from `sortValue`, or
  `compare` localeCompares lexicographically). The rail's per-repo console remembers its Activity|Bots sub-tab in
  `filters.repoConsoleTabs` (`insightsSubTab` is GONE — the Insights pane is Reports-first, no sub-tabs) — surviving rail
  switches and tab round-trips; cross-view jumps set it explicitly (e.g. Show-in-feed →
  `setRepoConsoleTab(repoId,'bots')` BEFORE `setActivityRepo`, isolation set AFTER — the
  setter clears `feedIsolatedPrId`).

### The timeline (`components/Timeline/`)

`vis-timeline` with `stack:false` + `stackSubgroups:true`. Rows are nested groups
**repo → contributor** (ids `repo:<rid>`, `repo:<rid>:user:<uid>`); within a contributor
row, subgroups order a PR-bar line, its own-work event line, and a shared cross-user marker
band. PR bars pack into lanes (`lanes.ts`); events are type-shaped SVG markers that
**cluster** at coarse zoom (`clustering.ts`).

Key behaviors to know about:
- **Selection & highlight.** Clicking an event marker/cluster loads its PR into the
  detail pane + opens a popover; clicking a PR bar selects it. Every highlight (selected
  bar, open popover's marker `ev-selected`, focus glows `pr-cross-linked` /
  `ev-cross-linked`) is the **same soft sky pulse** (`ev-select-pulse`). Outside focus,
  clicking empty canvas dismisses **one level at a time**: popover, else selected bar,
  else a lingering exit-anchor glow (`applyExitGlow(null)`).
- **Focus is a TAB, not an overlay** (`mode?: TimelineMode` prop). The PR-detail **Focus**
  link, **double-clicking a PR bar**, and clicking a **cross-user marker / cluster** call
  `usePinnedTabs.openPrFocusTab(meta)` → a persistent, closable **pr-focus tab** whose board
  slot mounts `<Timeline mode={{kind:'isolate',prId}}/>`. That instance **boots directly into
  isolation** (a `bootedRef` effect reuses the internal `enterPrFocus`/`isolatePrBars`/
  `rebuildMarkers`/`fitWindow` as the initial+only state — collapse to the PR's contributor
  rows, show only its bar, fit the window to its span). There is **no exit/restore** — leaving =
  switching/closing the tab (unmount). The isolation is purely component-LOCAL (only one instance
  is ever mounted), so it does NOT drive shared store flags. **A feed card, by contrast, opens a
  pr-DETAIL tab** (`openPrDetailTab`, not pr-focus) — full PrDetail, whose Show/Focus links then
  drive the timeline. **Back button:** a tab open is an ORDINARY URL NAVIGATION now — `activeTab`
  serializes as `view=<Tab.key>`, and the nav-key diff pushes the entry — so Back works from
  wherever the tab was opened, not only from Activity. (`{pierreTab}`, `activityReturnArmed`,
  `boardReturnTabKey` and `navigateBack` are DELETED; `showBoardFromDetail` no longer pushes its
  own back-step, because leaving `view=pr-detail:<id>` for `view=timeline` already is one.) The
  feed's scroll-to + flash of the exact card that was clicked SURVIVED the move: openers still
  stamp `activityReturnItemId`, and `applyUrlTab` promotes it into the one-shot
  `activityFlashItemId` only on a POP that lands on Activity — never on a click of the Activity
  chip. **Landmine:** an isolate-tab
  range-preset/window effect must be inert (`if (embeddedPrId != null) return`) or a date-preset
  click overrides the
  boot fit. **Known gap:** a PR merged >90d ago is outside the isolate fetch window → can't
  isolate (the boot `selectPr`s it so the pane still shows).
- **Vertical scroll is GATED — route every programmatic scroll through it.** vis
  virtualizes rows (`timeline.focus()` can't reach off-screen stubs), so all programmatic
  scrolling drives the `.vis-vertical-scroll` panel via `setVisScrollTop`. Several
  authorities move it — the background-sync rebuild's `restoreScrollAnchor` (content
  anchor), `centerShowTarget` ("Show" centring + the isolate-tab boot centre), the
  `rangechanged` recluster — arbitrated by **`intentionalScrollRef`
  (is a scroll claimed?) + `scrollLoopRef` (monotonic loop id)**. An intentional scroll
  CLAIMS ownership (`++scrollLoopRef`; `intentionalScrollRef=true`; a backstop that clears
  the gate only if `scrollLoopRef` is still its id — so a newer claim supersedes the older
  and two loops never write `scrollTop` on alternating frames). While set, the others **stand
  down**: the rebuild's anchor-restore + deferred bar-fit re-anchor are gated on
  `!intentionalScrollRef`, and the recluster re-arms past the settle. **Never write
  `scrollTop` / call `focus()` directly from a new path — go through `setVisScrollTop` and
  claim the gate (copy `centerShowTarget` / `restoreScrollAnchorIntentional`), or it WILL
  fight the live loops and jitter.** Position is preserved by CONTENT anchor (the row at the
  viewport top), not raw pixels, so rows growing/re-sorting above don't ride it upward.
  **On unmount** (closing/leaving a focus tab) the vis cleanup bumps `scrollLoopRef`
  (+`intentionalScrollRef=false`) and `setVisScrollTop` no-ops when the instance is gone /
  detached — else a mid-settle `centerShowTarget` loop writes scroll on a torn-down vis and
  triggers its internal `_updateScrollTop`→null crash.
- **Per-row collapse.** A caret per contributor label (`setRowCollapsed`) shrinks the row
  to its name by hiding its subgroup bands via `subgroupVisibility` (distinct from focus's
  whole-row `visible:false`). Persisted to `localStorage['pierre:collapsedRows']`,
  re-asserted after each rebuild. **Gotcha:** vis applies `subgroupVisibility` only during a
  group restack, so `setRowCollapsed` forces `itemSet.markDirty({restackGroups:true})` +
  `redraw()`. Focus suspends it (force-shows kept bands, hides the caret), restores on exit.
- **Show vs Focus (PR detail).** **Show** (`openPrFocused`) just centres + glow-pulses the
  PR on the shared board (no isolation); **Focus** (`openPrFocusTab`) opens the PR's own
  isolated pr-focus **tab** (above). The per-thread/comment/activity "Show" links
  (`ShowOnTimeline` → `showEventOnTimeline`) + `openPrFocused` funnel through the one
  `timelineFocusPr` consumer effect (now centre-only on the shared board) — the place to start
  for any board-navigation change.
- **Commits are hidden by default** (`DEFAULT_CATEGORIES` excludes `commits`);
  enabling them round-trips through the URL.
- **Contributor names open the USER POPOVER** (`UserProfilePopover`), no longer navigating
  straight to GitHub. Three surfaces: `UserName` (PrDetail / ChecksTab / comments / threads /
  the drill-down tables), the **feed card actor** (`FeedView`), and the **vis-timeline row
  labels**. The card shows an enlarged avatar, the contributor's ALL-TIME
  `GET /api/users/:id/stats` totals, a GitHub-profile link, and **View activity →**. Details
  that are load-bearing:
  - **Scope**: `repoId` prop set (rendered in a PR context) → that repo's numbers; else the
    FilterBar-visible set (`filters.repoIds`, already bounded by the active workspace). The caption states
    which — "12 merged" is meaningless without it. **Pass `repoId` at every new call site.**
  - Both flavours stay a real `<a href>` to the profile: a **modified click (⌘/ctrl/shift/alt)
    or non-primary button is left alone** so "open the profile in a new tab" still works; only
    a plain left click is intercepted + `preventDefault`ed.
  - **Landmine (cost a real bug):** `UserName`'s returned tree SHAPE must not depend on
    `open`. It used to return a bare `<a>` when closed and a `<span>`-wrapped one when open;
    React saw the root type change, remounted the `<a>`, and the popover was handed a DETACHED
    node with a zero rect — the card landed in the page's top-left corner. The shape now keys
    on `shield` alone, and the anchor is a **callback ref** (`useState`), not `useRef`, since
    it is read during render.
  - The timeline label is an HTML STRING rebuilt by vis on every rebuild, so it carries a
    `data-user-gid="repo:<rid>:user:<uid>"` handled by a **delegated capture listener** on the
    container (the collapse-caret pattern; an inline `onclick` would need `script-src
    'unsafe-inline'`, which the CSP does not grant). The popover anchors there by **selector**,
    re-resolved each animation frame like `MarkerPopover`, with the click point as fallback.
    `data-user-gid` must also stay in the vis `click` bail list or the label click reaches
    `dismissEmptyCanvas()`.
  - This REPLACED the old bar-chart metrics toggle + `UserStatsPopover` + `computeUserStats`
    (window-scoped, timeline-only); the new card is a superset.
- A **maintainer shield** (`MaintainerShield`) marks anyone with merge rights in the
  in-context repo (has merged a PR there, from `useMergers`); `UserName` takes an optional
  `repoId` and renders it wherever a username appears in a PR context, mirroring the
  timeline rows' HTML-string shield.
- **Zebra tinting.** Each repo block gets one of two muted hues (blue/purple),
  alternating by repo **rank parity** (`repoTintIndexById` — not `id % 2`, so tints
  stay stable as repos toggle in/out), via `tl-repo-tint-N` / `REPO_TINT_COUNT`;
  contributor rows also carry a subtle `nth-child` band.
- **Sticky repo header** (`.tl-repo-sticky` overlay, mirrors the Changes-tab sticky
  filenames). An absolutely-positioned DOM overlay over the left label panel shows the
  repo currently at the top of the viewport while you scroll. It's a **pure READER** of
  the scroll panel + `.vis-label.tl-repo-header` rects (`updateStickyRepoHeader` /
  `scheduleStickyHeader`, rAF-coalesced) — it NEVER writes `scrollTop` / touches the
  scroll gate, so it can't fight the scroll loops. Registered next to the connectors
  overlay (passive `scroll` listener + `timeline.on('changed')` + `resize`, all torn down
  on unmount); hides when the real header is already visible (no double header).
- The timeline endpoint stays lean — the selected PR is never filtered out (force-shown if a
  filter would hide it); detail loads only on selection.

### PR detail (`PrDetail.tsx`)

Header carries **Show** + **Focus** links (drive the timeline). Tabs (Overview / Threads /
Activity / Changes, + a presence-gated **Bot activity** + capability-gated Claude Review / AI):
- **Overview** — `ChecksTab.tsx`: CI/checks (each Actions check expands into the inline log
  viewer — see **Merge, CI logs & trunk status**), the **merge verdict** line (open PRs only,
  from `mergeVerdict` — this row is where the old "mergeable" lie lived), **Reviewers** (all who
  submitted a review, badged by latest state) above **Approvers** (latest decisive review =
  `approved`), then **Merged by**, **Requested** reviewers, labels, meta, an **Actions** row
  (approve / `MergeControl` / `ClosePrControl`) — then the PR **Summary** (markdown,
  clamped to 3 lines, tall images hidden when collapsed). **PR comments** (oldest first) round the
  tab off — each with a "Show" link, a per-comment "Check review", and its AI annotations **BELOW**
  the comment (a judgement read before the thing it judges is backwards; it also matches the
  per-thread block) — but that list is rendered by **`PrDetail` itself**, not `ChecksTab`, which is
  why the per-comment `CommentAnnotations`/`ReviewCheckButton` call sites are there. The **Checks
  row now also carries the CI-failure diagnosis** (`CiAnalysisCard`, `showFix={false}`) under the
  checks list + re-run control; its visibility goes through `checksRowVisible(checkCount, ciStatus,
  prSummary)` — the row opens for a red `ciStatus` with UNhydrated `checkRuns` (lean storage /
  SAML-SSO) so a stored diagnosis is still reachable, but only with `prSummary`, since the card is
  that branch's only possible content and `Row` always paints its label.
- **Threads** — `ThreadList`/`ThreadView`: review threads grouped by file, **newest first**
  (files by most-recent thread; within a file by `createdAt` desc), with code anchors +
  new-comment highlights; each has a "Show" link. A sticky header carries **derived-state filter
  pills** (Untouched/Replied/Likely-addressed/Resolved, `store.threadStateFilter: Set<DerivedState>`)
  ANDed with the vendor `threadBotFilter`; the pills' badge counts come from the full loaded set
  (stable), and the bulk "Resolve N addressed" set is derived from the full list (independent of
  the visible filter). Each card renders its whole "Check review" output as ONE block under the
  conversation (`ThreadCheckOutput` — the three judgements key on three DIFFERENT ids, so no single
  `<CommentAnnotations>` can express a thread: `simplify` per comment, `validity` on the root,
  `addressed` on the thread; each rewrite is sublabelled with whose comment it rewrites since it is
  no longer adjacent to it). The bulk-resolve OFFER now goes through `ThreadList/resolvable.ts`,
  which consults the unscoped `useDetectedReviewers` listing filtered to the PR's OWN `repoId` —
  matching what the server re-derives (a bot is judged per repo), since classifying by vendor login
  alone offered a count the server then refused, leaving a dead button with an unchanged count. Arriving from the
  `bot-threads` tab presets `{likely_addressed}` via
  `openPrThreadsFiltered`. **Landmine:** `threadStateFilter` is a GLOBAL store field reset only in
  the selection actions — PrDetail applies it only when `selectedPrId === prId` (mirroring App's
  `selectedThreadId` guard) so a PR opened via `openPrDetailTab` doesn't inherit a stale preset.
- **Activity** — a chronological feed (**newest first**) of opens / commits / reviews /
  comments / merge-close, each with a "Show on timeline" action. Timestamps render RELATIVE
  ("3h ago", the shared `relativeTime`; date-only past 30 days) with the absolute `dateTime`
  kept as the `title` tooltip — same idiom as the Feed rows. A timeline **commit**
  ("View in Activity") or **review** ("Open in detail pane") popover deep-links here via the
  `activityFocus` signal (matched by `{type, refId}`) → opens this tab, scrolls to + flashes
  the entry. The "Show" links share `ShowOnTimeline`.
- **Changes** — `ChangesTab` → `diff/FileDiffView`: per-file diffs, each file's expand state a
  local `useState` seeded by `startsCollapsed` (null patch / >250 patch lines / >400 changed
  lines) — files with threads override to expanded, EXCEPT **lock files
  (`isLockFile` in `lib/diff.ts`, exact-basename list, deliberately not `*.lock`), which ALWAYS
  start collapsed even with threads** (the header badge still advertises them; a deep-linked
  thread still auto-expands). The rule rides the shared component into the AI Fix tab too.
  A **navigation rail** (`diff/FileTree.tsx`) sits to its left — see below.
- **Bot activity** (`PrBotBehaviourTab.tsx`, EXPERIMENTAL, CORE) — shown only when a bot touched
  the PR (`hasBots`: `reviews.automatedKind` or a bot thread-opener/commenter). Per bot: its on-PR
  touch timeline + TTFR/follow-ups vs the bot's OWN typical (`/api/prs/:id/bot-behaviour`). A ⚠
  tab-label badge fires when a bot is slower-than-typical; `ChecksTab` gains an Overview "N bots
  slower than typical — view" caution that opens this tab. **Landmine:** `usePrBotBehaviour` is
  called at the top of PrDetail (before the loading/error early returns) — hooks-order rule.

**There is no PR-wide "Check review" bar any more.** `ReviewCheckBar` (which sat above the tab
content, spanning threads + PR comments) is DELETED: a whole-PR sweep on a bot-flooded PR is many
billed calls and tens of seconds before anything appears, and the question a reader has is about
the one thread in front of them. The only run surface is the per-item **`ReviewCheckButton`**
(thread-card header / PR-comment actions row) — one anchor, one combined call.

Keyboard (`useKeyboard.ts`): `/` focuses the filter, `j`/`k` cycle the board's PRs (board
only), `i` opens Insights, `esc` leaves any tab/overlay → the board (else clears the
selection).

#### The Changes-tab file-tree rail + the ONE `focus` mechanism

**The rail** (`components/diff/FileTree.tsx`, tree built by the pure `buildFileTree` in
`lib/diff.ts`, unit-tested in `apps/frontend/test/fileTree.test.ts`) lists the PR's **changed
files only**, arranged in their real project directory hierarchy: directories before files at
every level, byte-ish ordering (**not `localeCompare`** — a machine listing of paths must sort
identically across locales and be reproducible in a test), per-node `+/−` rollups, the shared
one-letter status glyph, and lock files dimmed (they always start collapsed in the diff, so the
rail reads the same way). **Single-child directory chains collapse into one row**
(`apps/frontend/src` rather than three nested rows) — a chain with one child offers no choice, so
nothing is hidden. `STATUS_META` moved out of `FileDiffView` into `components/diff/status.ts` so
the header and the rail can never disagree about what "R" means.

- **Auto-hidden under `TREE_MIN_FILES = 5`** (a 3-file PR does not earn 224px, and the bottom
  detail pane is 384px tall by default) and hidden below the `md` breakpoint.
- **Sticky, with its own bounded scroller (`max-h-[70vh]`) — deliberately NOT an `h-full
  overflow-auto` column.** The Changes tab has no scroll container of its own: PrDetail's
  `min-h-0 flex-1 overflow-auto` is what every per-file `sticky top-0` header sticks to, and a
  nested full-height scroller here would move that containing block and break them.
- **Directory collapse is EPHEMERAL local state** in `FileTree`, deliberately not the global
  `expandedFileGroups`/`collapsedFileGroups` slice — those are unkeyed by PR, and directory paths
  collide across repos far more than file paths do. Default: everything open.
- **The truncation disclosure lives INSIDE the tree** (the `note` prop: "Showing N of M files.
  All on GitHub ↗", rendered when `data.truncated`), because a tree implies a completeness a
  scrolling list does not. The pre-existing "Large diff — not all files are shown" line under the
  diff stays.

**One focus mechanism, two grains that are not interchangeable.** `FileDiffView` takes
`focus?: DiffFocusTarget` (`{path, line?, side?, nonce}`) addressing a **FILE (optionally a
LINE)**; `DiffThreadContext.focusThreadId` addresses a **THREAD** (the just-posted-comment
self-focus). Every caller-side reveal goes through the first — the tree's clicks AND the Claude
Review finding deep-link. Do not add a third.

- **`nonce` is load-bearing**: an effect keyed on a boolean cannot re-fire for the same target,
  so clicking the same file/line twice would do nothing. Any monotonic value (`Date.now()`).
- `ChangesTab` owns the live target: the rail's clicks and the `focus` prop feed the same state,
  which is **STICKY** (never cleared once shown — it doubles as the rail's selected row; the
  highlight fades on its own timer). `PrDetail` owns `changesFocus` as **LOCAL** state and
  `openInChanges(path, line, side)` sets it + switches to the Changes tab — local because both
  tabs live in this one `PrDetail` instance, so unlike `threadStateFilter` there is no global
  field to leak across PRs and no `selectedPrId === prId` guard to remember. Picking a tab BY
  HAND clears the pending target, so opening Changes to browse doesn't re-jump to the last
  finding. (The TAB itself is the opposite call: it moved INTO the store as `prDetailTab`, a
  `{prId, tab}` PAIR, because it has to be URL-addressable — `?view=pr-detail:<id>&prTab=changes`.
  The pair is that guard, made structural. Deep-link effects seat it through `seedTab`, which
  marks the write a URL CORRECTION so the tab a view opens ON doesn't get a history entry of its
  own between the reader and where they came from.)
- ⚠ **A DATA-GATED tab is DERIVED for the render, never written back — and it must not fall back
  while the data that decides its visibility is still LOADING.** `bot_activity` shows only when the
  server confirms an automated REVIEWER, and the fallback used to be a corrective
  `seedTab('overview')`. Now that `prDetailTab` is URL-owned that write DESTROYED the link it was
  correcting: on a refresh or a shared deep link to `?view=pr-detail:<id>&prTab=bot_activity`, `pr`
  is still loading on the first effect run → the `hasBots` fetch gate is false → `usePrBotBehaviour`
  has not even STARTED → the tab "isn't visible" → `seedTab` REPLACES the entry and `?prTab=` is
  gone, unrecoverable by Back. So `PrDetail` computes an `effectiveTab` and the fallback waits for
  an ANSWER — a LOADED PR whose client gate found nothing (`hasBots` is a superset of the server's
  set, and the fetch is deliberately never made) or a SETTLED `prBotBehaviour`; the strip also lists
  the tab while that answer is in flight, so a reader who arrived on it never sees a strip with
  nothing highlighted. Same rule as `feedInnerTab` / `botsInnerTab`, one layer down.
- `FileDiffView` matches the target to **at most ONE block**, and a **renamed file is addressable
  under either name** (blocks are keyed on the NEW path; a caller may hold the old one).
- Inside the block: **an explicit reveal always wins over the collapse heuristic** — including
  lock files and >250-line patches; a deliberate click landing on a closed `▸` header reads as a
  broken link. The addressed row is found by `lineRowIndex(rows, line, side)` (`lib/diff.ts`),
  which is deliberately NOT `commentTarget`/`anchorIndexFor` — those map a context row to the
  RIGHT side only (correct for anchoring a comment, silently lossy for a LEFT-side target). It is
  computed from the parsed patch, so it is known while collapsed. No addressable row (file-level
  target, a line outside the current diff, a binary file) ⇒ scroll the FILE header (`block:
  'start'`); a row scrolls `block: 'center'` because the sticky per-file header would cover a
  top-aligned one. Then a 4s flash. **These are ordinary `scrollIntoView` calls — the gated
  programmatic-scroll rules are the vis TIMELINE's, and don't apply here; never write `scrollTop`
  by hand either way.**
- **A reveal for a file this view isn't rendering says so** (`focusMissing`): the live diff is
  capped at 100 files and a Claude Review finding describes the head sha ITS run read. An amber
  banner + a GitHub link, rather than letting the click land as a silent no-op.
- The Claude Review side (`ClaudeReviewTab`) turns a finding's anchor into an in-app jump only
  when the file is in the changeset, computed **without issuing a request**: `pr.files` (the lean
  metadata already on the payload) ∪ the Changes tab's own `['pr-files', prId]` cache read
  opportunistically via `qc.getQueryData` — NOT `usePrFiles`, which is a live GitHub round trip
  and would spend quota just to pick a link style. Empty set ⇒ fall back to the finding's own
  `fileInDiff`. The jump is a `<button>`, never an `<a href="#…">` (a hash navigation would write
  to the URL `useUrlState` owns), with a small `↗` beside it keeping the GitHub diff-line escape.

#### Inline thread indicators in the diff + per-file state rollups

Every review thread — **resolved included** — renders inside the diff as a one-line collapsed
**pill** (`InlineThread` in `FileDiffView.tsx`): state dot, author, age, `~` when approximate,
reply count, plain-text excerpt, chevron. Clicking expands the full `ThreadCard` IN PLACE with
the pill as its collapse header. One mechanism for all four states — resolved is merely quieter
(no coloured left border, dimmed, `✓` for the dot) — because the alternative failure modes are
both real: filtering resolved out hid 40% of threads and made settled lines look undiscussed,
while rendering every thread as a full card at ~200–600px each buried the diff (a 47-thread PR
rendered ~47 cards interleaved in the hunks). Pills use **no hooks beyond local expand state**;
`ThreadCard`, with its shared per-PR annotation/ML queries, mounts only on expand. Expansion is
EPHEMERAL component state — no store field, no URL (the "derived, never written back" rule).

- **ONE rename-aware fold, built once per PR.** `indexThreadsByPath` (`lib/diff.ts`, pinned by
  `test/threadsByPath.test.ts`) buckets threads by the **RENDERED** file path and re-homes a
  thread whose `path` matches only a file's `previousPath`. ⚠ Before this the per-view fold keyed
  on `t.path` while the blocks looked up `f.path`, so a thread written before a rename was
  INVISIBLE in Changes. An exact current-path match always beats a `previousPath` re-home (with a
  COPY, both paths are in the diff and the thread belongs to the file that literally has it). It
  is a memoized `Map`, never a per-row `.filter()`.
- **Anchoring is a three-rung ladder** (`anchorRowFor`, shared with `PrDetail.openInChangesFor`
  so the pill's position and the "In Changes ~" scroll target agree): a live `thread.line` → the
  last matching row, RIGHT side preferred; else the anchor hunk reconstructed
  (`anchorLineFromHunk` + `lineRowIndex`, matched honestly on its own side) and marked
  **approximate**; else `null`, and the pill renders at FILE grain above the diff with an
  "outdated" / "line not in this diff" prefix. **A thread never disappears.** Rung 1 never falls
  through to the hunk: a live line absent from the visible patch means the hunks moved on, and a
  reconstruction would contradict stored truth. Known asymmetry: the jump has no side and assumes
  RIGHT, so a live line matching only a LEFT (del) row anchors the pill here while the jump falls
  back to the file header (the pill still opens and rings; only the scroll target diverges).
- ⚠ **`consumedFocus` lives on the BLOCK, not the pill.** `DiffFocusTarget` gained an optional
  `threadId` so a thread-card jump opens and flashes the matching pill as part of the same
  reveal, consumed per `nonce`. The focus target is STICKY in `ChangesTab` and collapsing a file
  unmounts the table (and the pill's state with it), so a re-expand remounts the pill against the
  old nonce — without the block-level record the effect would re-open a pill the user
  deliberately closed and teleport the view back to it. It is a **ref read at effect time**, not
  a nulled prop: the mounted pill's props must stay stable mid-flash or any re-render (the ~5s PR
  poll) would trip the reset branch and cut the ring short. Focus also **LATCHES** the pill open
  rather than gating `expanded = open || focused`, so the 6s self-focus timer expiring does not
  snap shut a card the reader is midway through.
- **Per-file and per-directory state rollups.** `ThreadCountChips` is now THE one renderer of the
  `DERIVED_STATE_META` palette (the byte-identical `ThreadDots` in `StateBadge.tsx` was deleted —
  rationale recorded at `ThreadCountChips.tsx`), and gained a `compact` dots-only mode for the
  224px tree rail (4 × dot+number cannot compete with a file name; the file header two inches
  right has the numbers, and resolved is dimmed at dot grain so a settled PR does not shout).
  `FileTreeEntry.threadCounts` is optional (the AI-Fix changeset has no threads) and
  `FileTreeNode.threadCounts` sums per directory exactly like `additions`/`deletions`, so a
  collapsed `▸` row with a red dot says an untouched thread hides inside it. The file header
  shows the full 4-state mix, replacing the old binary amber-`N 💬` + grey-`✓N` split which
  blended untouched / replied / likely-addressed into one number; the `unresolvedCount > 0`
  auto-expand heuristic keeps its `isResolved` definition, so that change is display-only.
  ⚠ The **tab header** counts `pr.threads`, not the indexed map, so the PR-grain aggregate never
  under-reports a thread whose file fell outside the 100-file diff cap.
- Rail chrome: a sticky header with the file count and a **Collapse all / Expand all** toggle
  over the same ephemeral `collapsed` set (default-all-open is right for small trees; a 60-file /
  12-dir PR costs a scroll per directory without it). Directory `+/−` counts render MUTED so the
  leaves — the click targets — stop competing with their own rollups, and the trailing
  chips + counts are pinned as ONE `ml-auto` group so narrow widths are absorbed by name
  truncation rather than column drift.

#### Thread ↔ Changes navigation (both directions)

**Thread → Changes.** `PrDetail.openInChangesFor(thread)` resolves the jump and hands `ThreadCard`
an `openInChanges` object; the control is a real `<button>` in the card header. Four rungs, in
order:

1. `thread.line` is live → jump to it on the RIGHT side. Always available for a non-outdated
   thread (measured: 8,844/8,844 have one).
2. the live line is gone → reconstruct it with **`anchorLineFromHunk`** (`lib/diff.ts`) and label
   the jump **approximate** (`⤷ In Changes ~`). `review_threads` stores exactly ONE positional
   column — no `original_line`, no `start_line`, no `diff_side`, and the sync never asks GitHub for
   them — so for the 5,572 of 6,195 outdated threads with a NULL line this is the only line data
   that exists. It works because GitHub's `diffHunk` convention ends at the commented line (which
   is already how `CodeAnchor` renders it): the last real parsed row gives back the original line
   AND its side. Spot-checked against 25 live threads — 23 exact, the 2 misses being genuine
   moved anchors. ⚠ It is the line in the commit the comment was WRITTEN against, so the wording
   must stay hedged; a non-null `thread.line` always wins.
3. no line at all → `line: null`, which `DiffFocusTarget` already means "reveal the FILE".
4. the file has left the diff → `openInChangesFor` returns **null** and no control renders. The
   changed-file set is `pr.files` ∪ a `qc.getQueryData(['pr-files', id])` read — **never
   `usePrFiles`**, same rule as the Claude Review side: `ThreadCard` is mounted in the Feed across
   many PRs and a fetch per card is a request storm on the `prDetail` tier.

⚠ The jump routes through the existing **`openInChanges`**, never a hand-rolled
`goToTab('changes')` + `setChangesFocus` — `goToTab` CLEARS the focus, and `openInChanges` is the
one deliberate exception that orders the two correctly.

**Changes → Threads.** `ChangesTab` now passes **every** thread into `DiffThreadContext`, not
`.filter((t) => !t.isResolved)`. That filter hid 40.3% of threads: a diff line carrying a settled
discussion looked undiscussed, and the round trip was one-way for exactly those. Resolved threads
render as a **collapsed one-line stub** (`✓ Resolved thread · N comments · <first line>`) so the
diff isn't buried under closed conversations — the filter existed for volume, not relevance.
`focused` always overrides the stub, so a deep link lands on the thread rather than on something
the reader must then find and open.

Two counters had to stop being `threads.length`, which silently changed meaning once resolved
threads joined the array: the amber `N 💬` header badge still counts UNRESOLVED only (with a
separate grey `✓N`), and the auto-expand heuristic still keys on unresolved, so a file whose
conversations are all settled no longer forces itself open.

The return leg is `ThreadCard.onOpenInThreads`, supplied only by the inline mount. ⚠ It calls
`goToTab('threads')` **itself** rather than relying on the `selectedThreadId` effect: that effect
keys on the VALUE, so re-selecting an already-selected thread — precisely what happens when the
reader arrived in Changes FROM that thread — would not re-fire. It still calls `selectThread`,
which also clears the state/severity pill presets that could otherwise filter the target out.

⚠ Both new props are **optional**, because only ONE of `ThreadCard`'s **seven** mounts can honour
each. `ChangesTab` has a single mount (PrDetail), so only the Threads-tab mount sits beside a
Changes tab without BEING one; the single mount inside `FileDiffView` (the `InlineThread` pill's
expansion — both the table and binary branches route through it) is already in the diff, and
the Feed / search / attention / themes mounts have no Changes tab at all (they use `onOpenInPr`).
Both controls are real `<button>`s so `ThreadCard`'s header-click guard
(`closest('a,button,…')`) swallows them — a `<span onClick>` would ALSO fire `onOpenInPr` and
navigate away from the PR the reader is already in.

#### Emoji reactions (`ReactionBar` + `hooks/useReactions.ts`)

CORE/free, and **nothing is stored or synced** — no column, no migration, no sync step; state is
read live from GitHub. Exactly **two mounts**: `ThreadView/CommentBlock` (which reaches all seven
`ThreadCard` mount sites at once — Threads tab, Feed, search results, attention cards, the Pro
themes drill-down, the diff's inline pill) and PrDetail's conversation list (PR comments + review bodies,
the kind riding the same `isComment` discriminator as the ML badge). There is deliberately **no
thread-level bar** (`PullRequestReviewThread` is not in GitHub's `Reactable` interface) and no
read-only variant — the write gate is GitHub's own `viewerCanReact`.

- **The loader is MICROTASK-BATCHED.** Each bar runs an ordinary per-target query
  (`['reactions', kind, id]`) whose queryFn does not fetch: it drops the target in a shared queue
  and returns a promise; one tick's registrations become ONE `POST /api/reactions/lookup`
  (`MAX_BATCH = 60`, which also flushes immediately when reached). That is what lets the feature
  render everywhere: a 60-thread PR costs one request, not sixty (the `ThreadAssessment` storm),
  and **the Feed — which spans many PRs — works unchanged**, where a per-PR index route (the
  `useMlLabelIndex` shape) could not have served it.
- React Query underneath for two reasons: caching stops a re-render refetching, and the shared
  cache entry keeps **two mounts of the same comment** in agreement. The toggle carries a
  per-target MUTATION key for the same reason at the in-flight level (the `CiAnalysisCard` rule).
  **`staleTime` is a FUNCTION of what was learned**: 5 min for a real answer, 30s when the entry
  is `null` — the server's rate-limit degrade returns an empty result set rather than a 502, so a
  transient exhaustion would otherwise cache "unknown" for the full window. `retry: false`;
  `refetchOnMount` left at its default (a card scrolling back in within the window costs nothing;
  one that aged out re-registers with the batcher, so it is still one request per screen).
- **Deliberately NOT in `main.tsx`'s `shouldDehydrateQuery` allowlist** — a reaction is other
  people's live state, and a week-old persisted copy would be a confident lie.
- **`undefined` ≠ "no reactions"**: unknown renders NOTHING (no placeholder box under every
  comment on screen), and so does "no groups AND `!viewerCanReact`". The toggle is optimistic with
  rollback; **success REPLACES the cache entry** with the server's authoritative post-write groups
  (a refetch would be a second GraphQL call for what we were just handed), only failure
  invalidates. `applyReactionToggle` is pure + exported so the "last reactor removes the chip"
  case is pinned by a test rather than leaving a permanent `0` pill on screen.
- The returned tree's **SHAPE is fixed** regardless of the picker being open (only the panel is
  conditional inside it) — a shape that changed with `open` would remount the trigger and detach
  the node the panel anchors to, the bug that once parked the user popover in the top-left corner.
  Chips carry `stopPropagation` + a `data-noactivate` marker because they sit inside
  click-to-open cards.

### The AI-Fix comment picker + validity report (`components/AiFix/`)

The `'comments'` AI-Fix seed's two UI halves. Backend contract:
[docs/PRO-PLUGIN-AND-ACTIVITY.md](PRO-PLUGIN-AND-ACTIVITY.md) § "Fix from comments".

- **`CommentPicker`** — the PR's comments on the **left**, the **fix scope** basket on the right,
  drag either way, plus "Move all" and a per-row `+`/`−`. Reading order matches the movement, and
  the DOM order matches both, so a keyboard pass walks the list before the basket. The `+`/`−` is a
  **full-height column down the card's right edge**, not a glyph in the header row: it is the
  PRIMARY way into the scope (drag is the shortcut, not the reverse), it points the way the comment
  travels, and an already-added card shows a tick rather than a greyed-out `+` — down a 60-row list
  "done" and "broken" must not look alike. It renders inside `FixerSection`, so it is
  gated on the `aiFix` capability exactly like the launch button (the tab itself is visible under
  `aiAnalysis || aiFix`, so gating it on the tab would draw a basket with no way to launch).
  `disabled` while a run is in flight rather than hidden — the basket is the record of what that
  run was given.
- **`lib/aiFixCommentModel.ts` holds every decision** (grouping, ordering, caps, root/reply) as pure
  functions, and the component is chrome + drag plumbing. Not a style preference: the frontend
  vitest config has no React plugin and no jsdom, so logic is only testable at all once it is out
  of the component.
- **Selection lives in `store/aiFixComments.ts`** — a standalone, non-persisted, non-URL store keyed
  by prId. NOT a `FilterDefaults` key (persistence and "Clear filters" share that list, and a
  URL-serialized basket would let a link seed someone else's paid run), but a store rather than
  component state because AiFixTab is lazy and its body unmounts on a tab switch. The cap is
  enforced in the store, not just the UI: the server truncates, and a silently dropped tail means
  watching a paid run work through a scope missing the comments you cared about.
- **Drag is POINTER EVENTS** (the tab strip / splitter / marker-popover precedent), for two reasons:
  one drag model in one codebase, and HTML5 DnD does not work on touch at all. ⚠ Drag is never the
  ONLY path — the per-row `+`/`−` buttons carry `aria-label`s and are what a keyboard reaches.
- **Ordering is imposed here, not inherited.** `getPrDetail`'s thread select has no `orderBy`, so
  wire order is heap order and flips after any UPDATE on Postgres. Bots sort worst-finding-first
  with **unlabelled last**, humans newest-first, and both tiebreak on the key so the result never
  depends on input order. `praise`/`isSummary` rows are NON-findings and SINK (a walkthrough scored
  `major` would otherwise outrank every real finding), and when there is no label data at all the
  model reports `botsSortedBySeverity: false` so the UI can stop claiming a severity ranking —
  ML labels exist only for bot text and only when `SEVERITY_API_URL` is set.
- **Honesty about what the list is not**: bodies may be a ~160-char excerpt (`body ?? excerpt ?? ''`
  with no flag), the list is capped at GitHub's page size per kind (so "Move all" ≠ everything —
  `capNotice`), and a review comment's line is NULL for most outdated threads, in which case the
  anchor renders as `~<line>` reconstructed from the hunk and says so. Replies are hidden behind one
  toggle and render subordinate to their root; the basket renders from `byKey` (all comments) so a
  deliberately-dragged reply does not vanish when replies are collapsed.
- ⚠ The bot listing is fetched for the **PR's OWN workspace** (`useRepos()` + `pr.repoId`),
  unnarrowed — never `filters.workspaceId`. A PR tab can hold a PR from any workspace via `?pr=`, a
  restored tab or a search hit, and the wrong workspace's judgements are the pinned dead-control
  regression (`test/resolvableBotThreads.test.ts`).
- **`CommentFixReport`** — the per-comment verdicts under the fix summary, mounted ABOVE the "no
  changes" branch because a run that correctly judged every comment invalid produces no diff at all,
  and that is the run whose report matters most. It has NO hooks in the exported component (`seed` /
  `commentVerdicts` are row fields, so a re-run flips the early returns and a `useMemo` above them
  would change the hook count mid-life), issues zero requests, and returns `null` when there is
  nothing to report. `valid` renders as its own pill next to the disposition because the two
  diverge. Disagreement is purple, never red — the agent arguing back is a legitimate outcome.
- ⚠ **A pushback never posts itself**: it renders as text with an editable prefilled composer and an
  explicit Send, through core's existing thread-reply / PR-comment routes. Because a double-post is
  not undoable, the sent claim is keyed `${fixId}|${ref}` in module state (those write hooks declare
  no `mutationKey`, so `useIsMutating` is not reachable), claimed on click, promoted on success and
  RELEASED on failure, and settlement chains on the `mutateAsync` promise — React Query drops
  per-call callbacks when the component unmounts, which is exactly the tab-switch-mid-request case.

---

## The calm-consolidation surfaces (apiVersion 21 wave)

**Default landing = the FEED, for every tier.** The one-shot "auto-select Insights when Pro is
on" effect (`insightsDefaultApplied` + `suppressInsightsDefault()`, which the Welcome-back
banner had to call defensively) is DELETED — the store's plain `'feed'` default IS the landing,
and the daily surface is the Feed with **`BriefStrip`** on top. The Insights rail entry is
relabelled **"Reports"** — ⚠ LABEL-ONLY: the store/URL token stays `activityRepoId ===
'insights'` (it is wire/URL-visible across `useUrlState`, FilterBar; renaming it buys nothing
but broken deep links).

- **`BriefStrip`** (`Activity/BriefStrip.tsx`, rendered inline at the top of the Feed branch —
  no new fixed element, the one-toast-column rule): one compact line per thing that needs the
  viewer, each DEEP-LINKING to the surface that owns its number (the strip grows no drill-downs
  of its own), plus an "Elsewhere" line of per-workspace counts (`?rollup=1`). FREE = templated
  count lines from `GET /api/daily-brief`; PRO (`activityDigest`) = the synthesis seam's
  ORDERING mode (`kind:'brief'`/`'rollup'`) — the model orders and phrases lines DIGIT-FREE, the
  FIGURES always come from the counts response (D4). A missing/failed narration renders the
  templated lines exactly; the strip never waits on AI. Generation is lazy-on-read: at most one
  auto-POST per stale scope per mount; ⚠ it fires the brief + rollup POSTs in ONE render cycle,
  which is why the server's in-flight guard is claimed synchronously. Self-hides at all-zero.
- **`BotTriageCard`** (`components/BotTriageCard.tsx`, CORE/free): the per-PR verdict sentence —
  "N bot comments: X real issues · Y likely addressed · Z nit-flagged — [Resolve]". The "real
  issues" segment is the PRO fold (stored validity/addressed annotations behind `prSummary`;
  the annotation-index query isn't even issued without it) — a free account renders
  "X awaiting a look" from the derived-state rollup in that slot instead. Mounted
  TWICE (full atop the Threads tab, compact in the Overview attention area); renders ONLY at
  ≥5 union-bot review comments and issues NO extra query below the threshold (the
  ThreadAssessment 60-empty-boxes lesson) — everything it reads is already shared (the
  workspace-reviewer listing, the per-PR ML label index, the per-PR annotation index; a pure
  cached GET — the card can never bill). ⚠ Bot membership is the CLIENT MIRROR of the server's
  UNION set (workspace judgement wins both ways, `users.isBot` fallback) — deliberately NOT the
  legacy login-string classification PrDetail's bot chips still use; and every figure comes from
  the SAME folds the Threads tab uses (`rollupCounts`/`threadSeverities`/
  `resolvableBotThreadIds`) restricted to the bot subset, so card and tab cannot disagree.
- **Bots view is down to `ROI ('roi' = Measure) | Advisor | Settings`** (`botsInnerTab` lost
  `'behaviour'`/`'themes'` — transient + URL-silent, so member removal is safe). Measure =
  cautions + the ROI table (now carrying the **Inflation column**, free current-window counts;
  the weekly sparkline renders only when the server sent `mlInflation.weekly`, i.e. `botDepth`)
  + the "What they're flagging" block with its `SynthesisCard` verdict + the collapsed Pro
  "**Workspace charts**" section (`WorkspaceBotCharts` — the old BotBehaviourPanel's
  workspace-grain charts behind `useBotBehaviour`, gated on `botDepth`) + the bot feed.
- **`bot-detail` is a new `TabKind`** (the per-bot depth drill-down that replaced the Behaviour
  tab): keyed PER BOT on `users.id` (`bot-detail:<userId>` — the user-activity pattern; the key's
  id and the fetch's `botUserId` narrowing can never name different bots), `TabBotMeta` chip
  metadata captured at open time from the ROI row (label, kind, and the `repoId` the row was
  measured at, inherited so depth describes the scope the user clicked), EPHEMERAL (not
  persisted, not URL-parsed). Opened by the ROI table's "Depth →" pill
  (`openBotDetailTab`); `BotDetailPanel` is a sibling full-`<main>` overlay in App.tsx (joins
  `overlayActive`), keyed on the tab so switching bots remounts. It re-slices the SAME per-bot
  data shapes the workspace charts read — nothing recomputes client-side.
- **`SynthesisCard`** (+ `hooks/useSynthesis.ts`) — the verdict card the drill-down surfaces and
  the Measure flagging block mount. Contract: `children` is the host's own receipt list and is
  ALWAYS rendered whatever the synthesis state (a failed/absent synthesis adds NOTHING and the
  deterministic list stays primary); every rendered number is SERVER-computed (`cluster.count`,
  `remainderCount`, analyzed/total — the card never counts); staleness is PASSIVE (the GET's
  `stale` flag → badge + Regenerate, nothing regenerates on its own); free-tier posture is the
  cost-nudge precedent (cloud → Pro chip + one-line nudge, OSS/local → null; nothing fetched
  either way — `useSynthesis` gates on `activityDigest`). Mutation keys share the canonical
  scope-key segment so two mounts of one scope share in-flight state.
- **Reports pane (`PeriodReportsPanel`)**: Reports-FIRST — `InsightsSubTab` and the whole
  sub-tab apparatus are deleted; the ad-hoc chat lives INSIDE the report ("Ask about this
  period", window-bound to the viewed period). New: the "**By workspace**" axis (the folded
  Compare — a per-metric expansion showing every workspace's current + prior figures from the
  window-pure per-workspace vectors; ⚠ one population per row, low-coverage annotated, NO money
  ever), "**Copy as Markdown**" (`periodReportMarkdown.ts` — ONE deterministic exporter serving
  both the panel's rendering rules and the clipboard, so the copy cannot drift from the screen)
  and **Print** (`@media print` in `index.css` + `print:hidden` on picker/controls/chat;
  print-to-PDF is the board-pack path). `?report=<periodKey>` pairs with
  `?activityRepo=insights` as before — it no longer needs to seed a sub-tab.
- **People / 1:1 prep** (Pro `periodReports`): `PeriodPeopleSection` in Reports lists the
  workspace's humans (roster minus the UNION bot verdict) — ⚠ ALPHABETICAL, no metrics on the
  row, deliberately un-rankable ("prep, not scoring"); each row opens the EXISTING
  `user-activity` tab, whose header now mounts **`PersonPeriodSection`** (the person-period
  vector in the period table's idiom: null renders "—" never 0, `lowSample` flagged, the three
  `basis:'live'` keys labelled "now", coverage annotations; period selector defaults to the
  report being read via `insightsReportKey`; Pro narration phrases via synthesis kind
  `'person'`). `UserProfilePopover` gains a second, capability-gated "1:1 prep →" entry beside
  "View activity →" — same tab, named entry point; absent (never a nudge) when the capability is
  off.

Deleted outright with this wave: `BotBehaviourPanel`,
`WorkspaceComparisonPanel` + `useWorkspaceComparison` + the `'compare'` rail value (no longer
URL-parsed — a legacy `?activityRepo=compare` link falls through to the `'feed'` default),
`SprintReportCard` + `useSprintReport`, `lib/workspaceColors.ts`, and `InsightsSubTab`.
(`BotThemesPanel` + `useBotThemes` were deleted here too and have since been RESTORED — see
"The Bots Themes panel" below. `botsInnerTab` did NOT regain a `'themes'` member: the panel sits
on the main ROI view.)

### The Bots Themes panel (restored)

`BotThemesPanel` replaces the `SynthesisCard` mount in `BotsView.tsx` **only**; the three
drill-down `SynthesisCard` mounts (`BotVolumeDetail`, `BotFlaggingDetail`, `BotThreadsDetail`)
are untouched and still serve slice-scoped Summarise. It copies `SynthesisCard`'s tier posture
verbatim — OSS renders nothing, free cloud renders the one-line Pro nudge, paid renders the
report — and its body is `max-h-[32rem] overflow-y-auto overscroll-contain` so a long report
cannot push the deterministic Measure surface off screen.

⚠ **The caption must distinguish the two figure classes**: per-theme comment counts, per-bot
volume/acted-on and the area split are exact code folds; the themes themselves and the
category/severity rollups are an AI read. The shipped copy says "Themes are an AI read
(approximate); the volumes, per-theme comment counts and 'where' are exact" — do not simplify it
to "exact". The same rule governs `ThemeThreadsDetail`'s new per-theme metrics strip: its chips
are client-side folds over data the view had ALREADY fetched (queries byte-identical to the
groups' and badges' own, so React Query dedupes them and the strip issues nothing new), it
discloses `n of m PRs loaded` while partial, and its **ML severity mix is over that loaded
sample, not a population**.

`useBotThemes` keys on `['bot-themes', window, workspaceKey(workspaceId), repoKeySlot(repoIds)]`
— the two-slot rule from `useBotTriage`, and the `ws:<id>` segment is the same string the plugin
persists as `scope_key`. ⚠ `useRefreshBotThemes` shares its MUTATION key per scope
(`useIsMutating`), because a board switch mid-run unmounts the panel and a per-mount `isPending`
would reset the button to "Generate" while the Haiku run is still in flight — the
`CiAnalysisCard` lesson. The `setQueryData` write must build the key the same way as the read
(one `workspaceKey` + one `repoKeySlot` call each) or a Regenerate appears to do nothing until
the next refetch.

### The ad-hoc chat is a transcript (`AdHocChatPanel` + `adHocChatModel.ts`)

Expanded by DEFAULT, completed turns rendered oldest→newest ABOVE the input, each turn keeping
its OWN caption (window · generated time · answering model) so a transcript that legitimately
spans two report periods stays honest. State is `sprintChatThreads: Record<string,
SprintChatTurn[]>` in the filters store, keyed `workspaceScopeKey(workspaceId)` (`ws:<id>` — the
same vocabulary the server persists; never a bare `String(id)`), transient and URL-silent. A
turn holds the wire response VERBATIM rather than a projection, so a field added later flows
through without a store change. Clearing a thread destroys no record: every turn was persisted
server-side as its own history row at answer time.

- ⚠ **The completed turn is appended in `useSprintChat`'s HOOK-level `onSuccess`, never a
  `mutate()` callback.** Mutate-scoped callbacks die with the observer, and the panel fires
  `chat.reset()` on a workspace switch / history pick / "New conversation" while clicking a PR
  ref unmounts it mid-flight — either would `removeObserver` the pending mutation, so a billed,
  server-persisted answer would silently miss the live transcript and the NEXT ask would send a
  history missing that turn (so "why is that?" resolves against the wrong previous answer).
  Hook-level callbacks run from `Mutation.execute` regardless of observers. The scope is captured
  as **`onMutate` context**, because the options closure is not ask-stable — every re-render
  while pending `setOptions`-swaps it, so by completion `workspaceId` can be another workspace's.
- Only a response carrying a real `answer` becomes a turn; throttled / out-of-credits shapes
  render as notices off the mutation's own data and must not occupy one of the ten slots. The
  composer clears on send-success (guarded so text typed toward the NEXT question survives) and
  is RETAINED on error/throttle on purpose — it aids retry.
- **The cap UX**: at `SPRINT_CHAT_MAX_TURNS` pairs the input disables behind a "New
  conversation" affordance. The server independently re-caps, so this is ergonomics, not
  enforcement. `trimmedTurns > 0` on an answer is whispered under it — a reference the model
  visibly missed otherwise reads as a model failure.
- **Scrolling is STICKY, not unconditional**: `stickToBottomRef` is tracked continuously via
  `onScroll` (it must be read as it stood BEFORE new content grew `scrollHeight`, so it cannot be
  computed inside the effect), and a SEND always re-arms it while an arrival respects where the
  reader scrolled to — Sonnet-length waits are long enough to re-read earlier turns.
- **Suggestion pills are TWO LABELLED GROUPS** (`suggestionGroups` in the pure
  `adHocChatModel.ts`): "From this report" — templated from the viewed report's own significant
  deltas, so it renders only when a report is on screen — and "Quick questions", the built-ins.
  They are different claims (client-computed figures vs generic asks) and one merged array also
  carried a latent duplicate-`key` risk. Once a conversation exists the BUILT-INS collapse behind
  their caption (derived from `thread.length` per render, never written back). Model-proposed
  follow-up chips are FILLED pills inside the transcript, attached to the NEWEST answer only and
  hidden while an ask is pending. ⚠ Every pill prompt must stay ≤500 chars — the server's
  `MAX_QUESTION` truncates SILENTLY, so a mid-sentence cut would ship a live mispowered pill with
  no error anywhere (pinned by `test/sprintChatThread.test.ts`).

### The Reports People picker + the People report tab

`PeriodPeopleSection` is a PICKER: a row of maintainer shortcut pills, then a text field with
"Begin report" beside it, opening `UserSelectPanel`'s extracted `MemberSectionList` (same
Maintainers / per-repo / Other grouping) plus a flat alphabetical BOTS section from
`useDetectedReviewers` (the union truth — comment-only reviewers included), multi-select straight
to removable chips.

- **The panel opens UPWARD, as an OVERLAY** — `absolute bottom-full left-0 mb-1 w-full max-w-md
  z-30` (the `ReactionBar` spelling) on a `relative` wrapper that stays INSIDE the click-outside
  `<section>`, because `useClickOutside` needs one root over both the field and the panel. It used
  to be a plain in-flow block: the picker is the LAST child of a long report inside
  `Activity/index.tsx`'s scroll pane, so opening it pushed the field itself down and out from under
  the cursor. Being out of flow, it now needs `shadow-lg` and an opaque background to read as a
  panel. **"Begin report" lives in the FLEX ROW with the field** (`flex max-w-md items-center
  gap-2`, input `flex-1`, button `shrink-0`) — never inside the panel, which unmounts on close.
  Its `disabled`/`title`/`onClick` bindings are unchanged (`beginDisabledReason` and
  `openPeopleReport` are unit-pinned).
- ⚠ **The panel's scroller carries NO PADDING, and that is load-bearing.** Chromium clamps
  `position: sticky; top: 0` to the scroll container's CONTENT box, so `p-1.5` on the same element
  as `overflow-y-auto` pinned every repo header 6px below the panel's inner edge, with rows
  passing visibly through the band. The padded SHELL and the bare `max-h-72 overflow-y-auto`
  scroller are two elements — `UserSelectPanel`'s own dialog/scroller shape, which is exactly why
  the toolbar Members dropdown never had the gap — and the "Maintainers · select all" quick-select
  sits in the shell so it stops sliding under the pinned repo names. **Do NOT fix this with a
  negative `top`/`-mt` on the header**: `MemberSectionList` is SHARED, and the toolbar dropdown
  (whose scroller is already unpadded) would gain the 6px back as an overlap.
- **The maintainer pills are a SHORTCUT, not a ranking.** Up to ten pill-shaped `<label>`
  checkboxes above the field, one per maintainer of the workspace — `maintainerIds` straight off
  the builder, so already workspace-narrowed and bot-free (humans only: nothing can earn a pill
  without merge rights, so there is no bot half). DEFAULT-VISIBLE and DEFAULT-UNCHECKED: ⚠ each
  checked chip is a separately BILLED narrative generation when Begin runs, so a pre-selected row
  would spend credits on a page load. The cut to ten is made on repo BREADTH — how many of the
  workspace's in-scope repos list the person in `mergers`, a fact about merge RIGHTS, not about
  output — and that breadth **never reaches the screen**: after the cut the row re-sorts
  ALPHABETICALLY (the `orderSelections` idiom, `userId` tiebreak) and renders no number, no count,
  no figure. That is what keeps the row on the right side of PREP, NOT SCORING; a strip sorted
  visibly by an N beside each name is the scoreboard the three guardrail comments forbid.
  ⚠ **The sort must be TOTAL before the slice** — `maintainerIds` iterates in the `mergers`
  payload's order, i.e. `getMergers`' `selectDistinct` with no `ORDER BY` = server HEAP order,
  which flips after any UPDATE on Postgres, so a bare `.slice(0, 10)` hands local and cloud a
  different ten.
- ⚠ **The section used to list the ACCOUNT's users across every workspace.** FilterBar's member
  `useMemo` was extracted to the pure `hooks/useMemberSections.ts` (`buildMemberSections`) so the
  picker reuses ONE fold with a different SCOPE and a different BOT VERDICT: `inScopeRepoIds` =
  the WHOLE active workspace's membership (the repo picker is Timeline-only), the UNION bot
  predicate (workspace `automated` ∪ `users.isBot`, a manual "human" winning both ways), and
  **`includeRosterRemainder: false`** — that remainder was the cross-workspace bleed. FilterBar
  passes exactly the inputs it always computed, so its output is byte-identical (fixture-pinned
  by `test/memberSections.test.ts`).
- ⚠ **MAJOR BUG CAUGHT IN REVIEW: the picker first used `useSearchTimeline`/`useSearchOpenPrs`,
  which are TIMELINE-ONLY.** `buildTimelineSearch` emits `filters.repoIds` and windows by the
  board's Range preset — neither control is mounted on the Reports pane, so a narrowing left on
  the board silently dropped workspace members with no visible cause, and an older completed
  period could not offer anyone quiet since. It now uses `rosterTimelineSearch` /
  `useRosterTimeline` (workspace-wide, `excludeBots=false`, windowed by the PERIOD BEING
  REPORTED so the string is STABLE per period rather than churning with the board's live `to`)
  plus `useWorkspaceOpenPrs`. It deliberately does NOT share the board's cache entry — one extra
  lean fetch, accepted for the same reason `useSearchTimeline` accepts its own. Pinned by
  `test/peopleRosterScope.test.ts` in the `workspaceOpenPrsScope` idiom, including the
  falsifiable half. The reported window is DERIVED from `insightsReportKey` (falling back to the
  newest listed period), never written back.
- **The report is an ephemeral SINGLETON pinned tab**: `TabKind 'people-report'` /
  `PEOPLE_REPORT_TAB_KEY`, a full-main overlay in `App.tsx` at `max-w-[100rem]`, rendered from
  the transient `peopleReportSeed { workspaceId, periodKey, selections[] }` (the
  `themeThreadsSeed` discipline — read-not-consumed for the tab's lifetime, a second Begin
  RE-SEEDS in place, excluded from `persist` and from `parseTabKey` so a reload drops it, which
  it must since the seed lives only in memory). ⚠ **`workspaceId` IS PART OF THE SEED**: period
  keys are cadence-grid strings, so another workspace sharing the grid would resolve the key and
  render the OLD workspace's selections against the NEW workspace's data under the same heading.
- **Sections render ALPHABETICALLY by label with humans and bots interleaved** (`orderSelections`
  in the pure `lib/peopleReport.ts`, unit-tested) — the seed preserves click order and the render
  ignores it. Never metric-sorted, never kind-grouped-then-ranked: PREP, NOT SCORING. Human
  sections loop the one-person GET with `evidence=1`; the Pro `person_report` narrative is
  generated SEQUENTIALLY through a narration queue so two sections never bill concurrently, with
  a throttle backoff and a one-attempt-per-staleness-observation guard (a hard failure must stop
  ASKING, or it holds the queue's single grant under a "queued…" label with nothing running).
  Bot sections are deterministic, no AI. Every per-section query key carries `ws:` + `u:<userId>`
  + `pw:<from>-<to>` fixed-arity slots, so two chips can never share a cache entry.

## The AI-surface palette (`ai-*` tokens) — and the purple that STAYS

The AI panels moved off violet/purple onto the landing's ink · vermilion · paper vocabulary.
**Eight semantic tokens**, defined as theme-flipping CSS custom properties in
`apps/frontend/src/index.css` (`:root` for light, `.dark` for dark — the SPA is
`darkMode: 'class'`, so the vars inherit to every panel and must NOT be scoped to a component
selector) and exposed to Tailwind in `apps/frontend/tailwind.config.ts` as
`rgb(var(--x) / <alpha-value>)`:

`--ai-surface` · `--ai-surface-2` · `--ai-border` · `--ai-hairline` · `--ai-ink` · `--ai-muted`
· `--ai-signal` · `--ai-signal-fill`

- ⚠ **The vars MUST stay space-separated RGB channel triplets** (`22 22 26`, the `--tl-tint`
  precedent). Any other format makes `<alpha-value>` fail SILENTLY — `bg-ai-surface/10` simply
  paints nothing.
- Because the var flips, an `ai-*` class needs **no `dark:` twin**; the swap deleted the old
  `dark:` halves rather than duplicating them.
- `--ai-signal` is the TEXT-SAFE accent and the only vermilion allowed to carry or back text. It
  is `#B53621` in light — deliberately DARKER than the landing's brand `#C13A20` — because every
  text-on-wash recipe has to clear WCAG (`/15` over `--ai-surface` measures 4.55:1, `/10` over a
  panel 4.92:1; the brand hex measured 4.14 / 4.46). The landing and `Wordmark` keep the brand
  hex. `--ai-signal-fill` (`#E2492C`) is **NON-TEXT ONLY** — meters, strokes, rules. Dark mode
  collapses both to one vermilion (`#F26B4E`).
- Solid CTAs are `bg-ai-signal text-white dark:text-gray-950`.

**⚠ The surviving `violet-`/`purple-`/`indigo-` hits are a deliberate KEEP-LIST, not leftovers.**
`rg -n "violet-|purple-|indigo-" apps/frontend/src` should return only these; do not "finish the
migration".

| Kept | Why |
|---|---|
| the `#8957e5` maintainer shield (`MaintainerShield`, `Timeline/userRow.ts`, `UserSelectPanel`, `PeriodPeopleSection`) | maintainer identity, not AI |
| `MergeControl` / `MergeWhenReadyControl` / PrDetail's "Auto-merge armed" chip | the merge family |
| `lib/ui.ts` event-category colours + `.ev-*` dots, `ML_CATEGORY_COLOR`, `BOT_VENDOR_META` vendor accents, `charts/common.tsx` `PALETTE`/`SERIES_COLORS` | DATA ENCODING — hues must stay identical across every chart |
| `PeriodReportsPanel`'s `LANE_META` (`ai_review` violet, `release` indigo) | the 7-lane palette needs 7 stable distinct hues; vermilion collides with the red already in charts |
| `BotRoiPanel`'s inflation under-call violet | direction encoding — the drill-down matrix keys on the same hues |
| FeedView's "PR events" / "Needs review" indigo pills | feed category-pill palette |
| `ChecksTab` / `AttentionCards` "Assign" buttons | suggested reviewers are deterministic CORE (CODEOWNERS + inference) — no model, so not an AI marker |
| `MetricsDetail` / `PinnedTabsBar`'s `violet` tone (Flow metrics) | core deterministic drill-down; a generic active accent |
| `index.css` `.tl-repo-tint-1`, the cross-person chips | timeline layout encoding |
| `AiFix/CommentFixReport`'s `DISAGREE_COLOR` (`#8957e5`) | its own comment pins "deliberately NOT red — red would read as the fix failed"; vermilion is red-adjacent and would recreate exactly that bug |

The documented split is **controls join the family, data keeps the chart palette**: the Inflation
column's under-call COUNTS stay violet while the chip the click opens is vermilion, and the
`ai_review` LANE stays violet in lane charts.

⚠ **A hex a component DERIVES a wash from cannot become a var.** `FeedView`'s `itemGlyph`
returns `{color}` and the chip paints `background: glyph.color + '1a'`. The `claude_review` kind
therefore returns a `className` (`bg-ai-signal/10 text-ai-signal`) with an empty `color`, and the
chip skips the `style` attribute whenever a className is present. Adding a second theme-flipping
glyph means extending that branch, not the hex table.

## ML severity badges + the Bots severity rollup

Bot comments carry a severity/category badge, threads a worst-severity rollup, the Threads tab a
severity filter, and the Bots ROI tab a "What the bots are flagging" block. All of it reads ONE
per-PR query (`['ml-labels', prId]`, `staleTime: Infinity`) — the badge never fetches, and a
target with no label renders nothing. Gated on `MeResponse.mlSeverity` (a TOP-LEVEL field, not a
`pro` capability). `threadSeverityFilter` is a global store field and carries the same
`selectedPrId === prId` guard as `threadStateFilter`. Detail: [ML-SEVERITY.md](ML-SEVERITY.md).

## The Activity Feed auto-inserts, and marks what's new (`feedNewCohorts`)

**There is NO "↑ New activity — Refresh" button any more.** Newly-arrived activity is spliced
into the cross-repo Feed as it arrives and the inserted cards wear a **"New" chip** until the
reader has seen them. Content is never withheld behind a click, and nothing sticky sits over the
feed. (`FeedView.tsx` + `useFeedAutoInsert` in `hooks/useConsolidatedFeed.ts`.)

- **CROSS-REPO FEED ONLY.** `FeedView` has FIVE mounts sharing one `FeedRow` — the cross-repo
  feed, the unresolved-repo fallback, the per-repo console, the Bots pane's bot-only feed and a
  person's activity tab. Auto-insert AND the marker are gated on the single predicate
  `isCrossRepoFeed = repoId == null && !botsMode && userIds == null` — the same one the server
  "seen" marker uses. The narrowed views are things someone opened on purpose; keeping them live
  would answer a question they didn't ask.
- **The head poll became the insert source.** `['feed-head', ws, search]` still polls every 60s,
  visibility-gated (`refetchIntervalInBackground: false`), but at **`limit: FEED_PAGE_SIZE`, not
  1**. That width is the CONTIGUITY GUARANTEE, not appetite: the server folds the whole stream
  either way (`counts`/`uncappedTotal` are whole-stream facets), so the limit costs payload, not
  query work — and a head as wide as page 0 is what lets `planFeedHeadMerge` PROVE the two lists
  overlap. ⚠ Its scope inputs must stay byte-identical to `useConsolidatedFeed`'s; real rows are
  spliced now, so a divergent `excludeBots`/`includeCiFailures`/`botWindowDays` injects rows the
  loaded request would never have returned.
- ⚠ **The merge must keep the loaded pages a contiguous PREFIX of the stream.** Paging is by
  OFFSET, so `planFeedHeadMerge` (pure, tested) prepends only the head's prefix above the first
  already-loaded id; an unloaded id BELOW that point is a mid-stream backfill and is ignored, and
  **zero overlap is a `'gap'` verdict → full invalidate, never a splice**. React Query has no
  per-page refetch (`refetch()` refetches EVERY page and replaces the list under the reader), so
  the write is a `setQueryData` touching page 0 only. `pages[0].total` is re-adopted from the
  same head fold that supplied the rows — `getNextPageParam` compares the loaded count against
  it, so a prepend that doesn't raise it stops "Load more" N items early.
- ⚠ **A PREPEND MUST NOT MOVE CONTENT UNDER THE READER'S EYES**, and the hand-rolled
  variable-height windower makes that harder than usual: `recompute` derives the viewport
  position from live rects (`rel`), which a prepend does NOT change, so the same pixel offset
  silently resolves to rows N further back. **There is exactly ONE compensation path and it is
  driven by the COMMITTED ITEM LIST, never by a writer's callback** — for the same reason the
  markers are (below): the head poll can announce itself, the sync round's `invalidateData()`
  refetch cannot, and it is the more frequent of the two. A **`useLayoutEffect`, before paint**,
  runs in two passes: (1) the list changed and its head grew → shift `win` and stash the
  pre-insert anchor; (2) re-entered by that `win` change → re-measure the anchor and add the delta
  to `scrollTop`. The shift MOVES the anchor, so the measurement must be read after it. The
  anchor itself (`anchorRef`, the topmost mounted row + the container's `scrollHeight`) is
  refreshed on every scroll and every settled layout, and `onBeforeInsert` refreshes it once more
  the instant before the splice writes — it does nothing else. The anchor delta is exact; the
  `scrollHeight` delta is the fallback when a batch larger than the mounted window shifts the
  anchor out of the slice. **The compensation is SKIPPED at the top of the feed** (a null anchor)
  — arriving in view is the point — and skipped across a re-key or a `placeholderData` swap,
  which are not arrivals.
  ⚠ **The shift is by the rows that reach `visible`, NOT the raw arrival count** — that is what
  `countHeadArrivals(prev, next, narrow)` (pure, tested) exists for. The window indexes the
  NARROWED list (the My Turn / Claude / CI-lens / category / bot-lens / thread-state /
  needs-review pills), which the arriving server rows know nothing about; shifting by the raw
  count slides the window past the anchor, the anchor unmounts, the carried-over `bottom`
  double-reserves the rows the window slid past, and the `scrollHeight` fallback then yanks the
  pane by the estimated height of rows that were never rendered — once per poll. Its other guard:
  **no overlap answers 0, never "everything is new"** (a gap refetch / re-key / window roll is a
  replacement, and scrolling by a whole list's height is the worst possible answer).
  ⚠ This is a plain DOM pane (`nearestScrollParent`), **not** the Timeline's gated vis viewport:
  it must never be routed through `setVisScrollTop` / `intentionalScrollRef`.
- ⚠ **THE MARKERS ARE MINTED BY DIFFING THE ITEM LIST, NOT INSIDE THE INSERT.** Auto-insert is
  not the only way rows reach the feed: `SyncStatus` is mounted in the header on every screen and
  its `invalidateData()` sweeps the `['consolidated-feed']` prefix on every sync round, which for
  an active infinite query refetches EVERY page and replaces the list. Minting in an `onInserted`
  callback would leave the chip missing for the arrivals a reader most often gets, and which path
  won the race would decide whether a card said "New". So FeedView keeps a per-mount known-id set
  and mints a cohort from the run of ids ABOVE the first already-known one. ⚠ **Only that head
  prefix counts** — "Load more" appends 50 OLDER rows the reader deliberately asked for, and
  flagging those would light up the whole page they just pulled. The first settled list for a
  scope IS the baseline (a freshly-opened feed is all equally new), and zero overlap marks
  nothing rather than every row.
  ⚠ **SETTLED means `!isPlaceholderData`, and the guard is load-bearing.** `placeholderData:
  (prev) => prev` keeps the PREVIOUS query key's rows on screen while a re-keyed fetch is in
  flight, and `scopeKey` flips in that same render — so seeding the baseline from `items` there
  reads the old key's list. Every WIDENING re-key (bot lens `hide`→`only`/`all`, Commits off→on,
  CI failures `off`→`feed`/`only`) then mints a spurious cohort of "New" chips on rows that were
  merely hidden a moment ago. Narrowing flips are harmless (`cut === 0`) and a workspace switch
  shares nothing (`cut === -1`) — which is exactly why the bug survives casual testing.
- **SEEN = COHORT + SCROLL POSITION.** `feedNewCohorts` in `store/filters.ts` holds
  `{scopeKey, cohorts: {ids, seen}[]}` — one entry per inserted BATCH. There is deliberately **no
  per-card IntersectionObserver** (the SPA's only IOs are bottom-of-list auto-load sentinels);
  being at or near the top of the feed (`FEED_AT_TOP_PX`) is what credits the cohorts up there as
  read. ⚠ The removal rule has TWO halves: a **seen** cohort clears WHOLESALE when more content
  arrives; an **unseen** one SURVIVES it. Collapsing that to "clear everything on each batch"
  passes every at-the-top test and hides exactly the content the marker exists to announce for a
  reader who was scrolled down. Unseen cohorts are capped so a never-returning reader can't grow
  the slice forever.
- **The slice is TRANSIENT** — `freshDefaults()` only, NOT in `FilterDefaults` /
  `freshFilterDefaults` / `pickFilterBarState` / `sanitizePersistedFilters`, never URL-serialized,
  so **no `FILTER_STORAGE_VERSION` bump is owed** (the `attentionIsolation` precedent). ⚠ But it
  must live in the STORE, not in `FeedView`: the Activity console UNMOUNTS on every tab switch
  while its query data survives 45 minutes (`ACTIVITY_GC_TIME`), so component state would clear
  the markers on every Timeline round-trip — telling a reader who opened a PR and came back that
  nothing arrived while they were away.
- ⚠ **`isNew` had to join `FeedRow`'s memo comparator**, which is a hand-written ALLOW-LIST: a
  prop missing from it doesn't re-render the row when it flips, so the chip would appear or clear
  only when something unrelated happened to change. And it renders as a **chip beside the
  timestamp, never a border** — the card border is a strict `flash → isMyTurn → isClaude →
  default` ladder, and a fifth branch would silently outrank (or be outranked by) a yellow
  My-Turn card depending on where it was inserted.
- **The SERVER "seen" marker is a different thing and still fires.** `POST /api/activity/feed/
  mark-seen` bumps account-level `accounts.feedLastSeenAt` once per cross-repo mount. Deleting the
  refresh button did not take it with it — nothing else writes that column. ⚠ **It no longer has a
  reader.** `WelcomeBackBanner` used to render the count it gates (`MeResponse.newFeedItems`) and
  now counts standing `my_turn` cards per workspace instead (below), so `newFeedItems` /
  `feedLastSeenAt` are still computed on every `/api/me` and read by nothing in the SPA.
- Rules pinned in `apps/frontend/test/feedNewCohorts.test.ts` (run by hand — that directory is
  not in CI).

## Per-workspace "My Turn" — the banner, the dropdown badge and the one deep-link

You can have work on your plate in a workspace you are not currently in. Three surfaces say so,
and they are ONE fold: `hooks/useMyTurnByWorkspace.ts` over the existing
`['daily-brief', ws:<id>]` key.

- **ONE POPULATION EVERYWHERE — standing `my_turn` CARDS, not "new since you looked".** The
  number is a `DailyBriefCounts` my-turn figure, i.e. literally how many `my_turn` cards
  `GET /api/attention` paints for that workspace. So the banner line, the dropdown badge, the
  daily-brief strip line and the board a click opens are the same list and the same figure.
- ⚠ **A SURFACE THAT NOTIFIES COUNTS `myTurnPersonal`; A SURFACE YOU OPEN COUNTS `myTurn`.**
  The welcome-back banner, the Workspace-dropdown badges, `BriefStrip`'s "Elsewhere" rows and the
  browser notification reach FOR the reader, so they count only what personally involves them
  (`MyTurnCard.personal` — reviews requested of you, your PRs, threads awaiting your reply, plus
  new PRs in repos you MAINTAIN or were @-mentioned on). Adding a repo you have never touched used
  to put every open PR in it on the banner — 425 of 459 items on the reporter's account. The
  "Needs attention" BOARD and the strip's own lines keep the BROAD `myTurn`: that work is real,
  it is just not yours, and hiding it would delete work rather than route it.
  ⚠ Absent narrow fields (a response predating the narrowing) ⇒ fall back to `myTurn` /
  `myTurnTotal`. Over-notifying is the safe direction.
  ⚠ The banner used to render `MeResponse.newFeedItems` and both halves of that were wrong at
  once: the count was ACCOUNT-WIDE while the banner sat inside one workspace, and the gesture
  that cleared it (viewing the Feed) was WORKSPACE-scoped — so reading workspace A zeroed a
  number that was mostly workspace B's, and the figure opened no list. There is therefore **no
  per-workspace `seen` state and no schema change**: a line disappears when the work is done.
- **`WelcomeBackBanner` is one line per workspace with a non-zero count**, the ACTIVE one
  visually distinguished (filled dot + "this Workspace") because the others are the ones the
  reader cannot see from where they are. Dismissal is component-local and therefore lasts the
  session — that is the only mute there is now, since standing work is never "marked seen".
  Hidden on the Activity console, where `BriefStrip` says it better.
- **`useFilters.openMyTurnInWorkspace(workspaceId)` is THE deep-link — used by BOTH
  cross-workspace surfaces**: the `WelcomeBackBanner` lines and `BriefStrip`'s collapsed
  "Elsewhere" roll-up. ⚠ A bare `setWorkspace` in either place HALF-navigates — it re-scopes and
  then leaves the reader on that workspace's Feed, hunting for the cards the line just counted.
  It exists as a store action because the sequence is order-sensitive twice over: `setWorkspace(id, null)` **first**
  (it clears `repoIds` / `feedIsolatedPrId` / `attentionIsolation`, and the `null` also stops
  `useWorkspaceSync`'s case-2 branch writing a second `setWorkspace` that would wipe what comes
  next), then `showActivity()`, then `setActivityRepo('attention')`, then
  `setAttentionIsolation('my_turn')`, then `setAttentionRelevance('mine')`. The workspace write is
  **skipped when already there** so a Timeline repo narrowing survives. Pinned in
  `apps/frontend/test/attentionIsolation.test.ts`.
- ⚠ **THE DIVERGENCE RULE: A NARROW COUNT MAY ONLY NAVIGATE THROUGH ITS OWN LENS.** A banner
  line reading 4 that opened a board of 50 is the "the strip says 5, the board lists 3" defect
  (747c9c9) in a new place — which is why `openMyTurnInWorkspace` seats
  **`attentionRelevance: 'mine'`** as its last step, why the brief's "review or reply" line seats
  `'others'`, and why every whole-kind line seats **`null`**. Seating is not optional and a
  conditional seat is not enough: `setActivityRepo` early-returns an empty patch when the rail is
  already `attention`, so a lens left over from an earlier click survives the click that was
  supposed to change it.
- **`attentionRelevance` is a SIBLING of `attentionIsolation`, never a member of it.** That
  field is compared against `card.kind` and could not carry a second, orthogonal predicate. Same
  transience contract (`freshDefaults()` only, out of `FilterDefaults` ⇒ **no
  `FILTER_STORAGE_VERSION` bump**, cleared by any rail/scope change) and the same URL contract: it
  is a NAV key, `?attnRel=mine|others`, emitted only on the attention rail, parsed only for those
  two literals, and in `UrlOwnedState` so a pop onto a URL that omits it CLEARS it.
  ⚠ **IT IS THREE-VALUED BECAUSE THE BRIEF HAS TWO MY-TURN LINES.** It shipped (8b8a2b1) as
  `attentionPersonalOnly: boolean`, which can express "what involves me" but not "the rest" — two
  mutually exclusive lines plus the un-lensed board is three views, and a boolean has two states.
  ⚠ **`?attnPersonal=1` IS STILL PARSED**, as `'mine'`, and never emitted: it shipped, so it is in
  bookmarks and — worse — in history entries a browser Back replays verbatim. The new key wins when
  both appear. Both keys stay in `NAV_KEYS`, because leaving a legacy entry (dropping one, gaining
  the other) is a real navigation and the diff must see both halves of that swap.
- ⚠ **THE LENS NARROWS `my_turn` AND NOTHING ELSE, IN BOTH DIRECTIONS** (`passesRelevanceLens`).
  Relevance is a property of the my-turn fold; no other kind carries the field, and `ci_failing` is
  personal BY CONSTRUCTION — hiding it under `'others'` would hide work that IS yours from a reader
  who asked only to see the backlog. ⚠ The two halves are **not exact complements over
  unclassifiable rows**: `'mine'` reads `personal` (which the server writes on every row, so it
  survives a pre-split response) and `'others'` reads `relevance === 'none'`, so an old response
  paints an EMPTY `'others'` board rather than a mislabelled full one — and the brief does not
  offer that line on such a response, so nobody lands there.
  ⚠ **`merge` AND `update_branch` ARE EXEMPT TOO, even though they DO carry `relevance`.** They
  carry it for the RANKER's weight, not as an ownership claim — a PR being ready to land says
  nothing about whose turn it is — and filtering them would stop the brief's two my-turn lines
  partitioning the lensed board, which is the one job this predicate has.
- ⚠ **THE PENDING BOARD IS `head ∪ tail === cards`, DISJOINT, AND THE HEAD IS A RE-ORDERING — NEVER
  A FILTER.** `GET /api/attention` returns `doNextIds` (card ids in `db/work-plan.ts`'s score
  order, free on every tier); `AttentionView` partitions the FINAL `cards` array into head and
  tail and renders ONE `<ul>` with a divider between them. Everything above the partition —
  `visible`, `myTurnShown`, `cap`, `placement`, `ciCap`, both empty states — is computed off
  `all`/`visible`/`cards` and untouched by it, which is exactly what keeps every cap disclosure
  true. **The coupling is invisible and expensive:** `capFor` gates on `shown === count`, so an
  "improvement" that filtered `cards` down to the head — or dropped a tail row because its PR is
  already seated in the head — would make "50 of 148" vanish with no error, on precisely the
  workspaces where the cap matters. A tail row whose PR is in the head is MARKED ("already in Do
  next"), never removed. ⚠ ONE `<AttentionCards>` MOUNT, never a head list and a tail list: two
  mounts race on the single `activityFlashItemId` token, each clearing it unconditionally.
- ⚠ **THE HEAD IS SUPPRESSED UNDER AN ISOLATION, NOT UNDER A RELEVANCE LENS.** An isolated board is
  single-kind, so there is no cross-kind ordering question and `capWithKindCoverage`'s
  one-slot-per-kind pass is meaningless; a relevance-lensed board is still multi-kind (the lens
  narrows `my_turn` alone), so the head is a legitimate re-ordering of the lensed set. `headCount
  === 0` is therefore the COMMON case, which is why the divider is guarded on `headCount > 0 &&
  headCount < cards.length` — without the lower bound the board opens with an "Everything else"
  rule and nothing above it. **Consequence, stated rather than discovered:** every daily-brief line
  and `openMyTurnInWorkspace` seat an isolation as well as a lens, so the head is dark on every
  notification entry point. That is the ruling, not an oversight. The Pro narration — headline,
  every `why`, `parked`, the dropped-id note — is suppressed with it, and the generate button is
  DISABLED rather than hidden (an enabled button whose output cannot render spends a credit for
  nothing and gets clicked twice).
- **The lens must be VISIBLE, NAMED and REVERSIBLE.** `AttentionIsolationBanner` carries both
  narrowings, says WHICH lens is on (one shared `LENS_COPY` table, so the banner and
  `AttentionView`'s filtered empty state cannot phrase the same narrowing two ways), names how many
  cards it is holding back, and offers "Show everyone's" beside "Clear". ⚠ The empty state tests
  `attentionRelevance != null` — **all three values reach it**; a lens that hides real work and
  falls through to "Nothing needs attention 🎉" reads as "my items disappeared".
- **FRESHNESS IS ASYMMETRIC AND THAT IS THE POINT.** `GET /api/daily-brief?rollup=1` computes the
  ACTIVE workspace's counts FRESH per request and serves the other workspaces' lines from a 5-min
  TTL (`db/daily-brief.ts`). The hook preserves the split (`fresh` per line) rather than
  flattening it: a stale badge on the workspace you are LOOKING AT would contradict the board on
  screen, while a ≤5-min badge on a workspace you are not in cannot be contradicted by anything —
  switching there re-derives it before any list renders.
- **NO SILENT CAPS, BOTH KINDS.** The 50-card cap goes through the ONE `myTurnCapDisclosure`
  rule (`Activity/AttentionView.tsx`) — the figure stays the CARD count with a "+" and the exact
  pair in a `title`, never the uncapped total. ⚠ **PAIR NARROW WITH NARROW**: that rule gates on
  `shown === counts.myTurn`, so a PERSONAL figure must go through
  `myTurnPersonalCapDisclosure` (`myTurnPersonal` / `myTurnPersonalTotal`). Handing the broad rule
  a narrow count fails the equality on exactly the workspaces the narrowing exists for — the line
  silently loses its "of N" — and had it passed it would have printed a narrow numerator over a
  broad denominator. A `myTurnPersonal` with no `myTurnPersonalTotal` discloses NOTHING rather
  than borrowing the broad total. The "review or reply" half has its OWN rule too —
  `myTurnOtherCapDisclosure` (`myTurnOther` / `myTurnOtherTotal`) — and ⚠ **it may never be spelled
  `myTurn - myTurnPersonal`**: the arithmetic agrees, but a subtracted figure has no denominator of
  its own, and `capFor` gates the "of N" on `shown === count`, so the line silently loses its cap.
  ⚠ Unlike the personal twin it does **not** fall back to the broad pair — nothing displays an
  "other" figure on a pre-split response, so there is nothing to qualify. All four rules share one
  `capFor` body; extend it, never fork it.
  Pinned in `apps/frontend/test/myTurnCapDisclosure.test.ts`. The ROLL-UP cap (`ROLLUP_WORKSPACE_CAP`, server
  side) surfaces as `uncounted`: those rows render a dim "—" rather than a zero, plus a footer
  line in the dropdown and a line in the banner. ⚠ **Absence is not zero** — do not "tidy" a
  missing line into a 0.
- ⚠ **The dropdown badge is INFORMATIONAL.** A row's click still means "switch scope" and nothing
  more: `WorkspaceSelector` is mounted on every board, so a badged row that also hijacked the rail
  would teleport someone who only wanted to re-scope the Timeline.
- ⚠ **COST.** The hook rides the EXISTING daily-brief key (shared with `BriefStrip` and the
  attention board's cap disclosure), but mounting it in the always-visible FilterBar and banner
  means the Timeline now pays one `search`-tier request per stale window where it paid none.
  Never add a second query key for these numbers.
- **`useMyTurnNotifications` stays ACCOUNT-WIDE** — an OS notification is read outside the app,
  where "only the selected workspace" is a silence bug. What it owes is PROVENANCE, so the title
  names the workspace (`… in Acme` / `… across 2 Workspaces`, resolved via `repos.workspaceId`,
  the client's only repo→workspace mapping) and the absolute stamp keeps leading the body.
  ⚠ The lookup lives in a **ref, out of the diff effect's deps**: that effect advances the
  notification baseline on every run, so re-running it because a reference query landed would
  consume a real diff and swallow the notification.
  ⚠ It fires **only for `personal !== false` rows** (an OS banner is the most interrupting surface
  there is), but the **baseline still tracks EVERY id** — dropping the others would re-diff them
  as new on every poll, and a row that later becomes personal (you get @-mentioned) would fire as
  if it had just appeared.

## `MyTurnRelevance` — three labels, two brief lines, one split banner

`MyTurnCard.personal` shipped as a boolean and **conflated two different relationships**: "this is
tied to me" (I wrote it, it was requested of me, someone replied to my thread, I was @-mentioned)
and "this happened in a repo I maintain". A new PR by someone else in your repo is **orbit, not
ownership** — reporting the two as one figure is what made the banner read as a nag. `relevance` is
that boolean un-collapsed: `'direct'` · `'maintained'` · `'none'`. Wire contract:
[PRO-PLUGIN-AND-ACTIVITY.md](PRO-PLUGIN-AND-ACTIVITY.md). On the client:

- **THREE CARD LABELS, from `cardKindLabel` (`AttentionCards.tsx`)** — `'direct'` → "Your turn",
  `'maintained'` → "In your repos", `'none'` → the neutral `KIND_LABEL.my_turn` ("Review or
  reply"). The KIND stays neutral; only the CARD claims you.
  ⚠ **An ABSENT `relevance` renders the NEUTRAL label — even on a card with `personal: true`.**
  That is the opposite of the wire's tolerance rule (absent ⇒ personal, because over-notifying is
  the safe direction), deliberately: a missing field may never invent an ownership claim ON SCREEN.
  The only way to see it is a server too old to send the field, where the neutral label is true.
- **TWO MUTUALLY EXCLUSIVE BRIEF LINES** replace the single my-turn line (`BriefStrip`):
  "N need your attention" (`myTurnPersonal` = direct + maintained, lens `'mine'`) and "M need
  review or reply" (`myTurnOther`, lens `'others'`). ⚠ **Each line pairs with its OWN total and
  seats its OWN lens** — that pairing is the whole point of splitting the line, and handing the
  broad `counts` object to a narrow line both mixes populations and silently drops the "of N".
  ⚠ **Both halves or neither**: a response missing either field degrades to the single broad line
  (`counts.myTurn`, `myTurnCapDisclosure`, no lens) rather than rendering one half and implying
  the other is zero. `'myTurnOther'` is its own `ScalarKey`, because the Pro ordering map keys on
  that string and a shared key would let one phrase reword both lines.
- **THE WELCOME-BACK BANNER HEADLINE SHOWS THE SPLIT** — "2 yours · 3 in your repos" instead of a
  bare 5 (`useMyTurnByWorkspace.totalSplit`). ⚠ **The POPULATION is unchanged**: the chips, the
  dropdown badges and `useMyTurnNotifications` all still count the sum, and the click still opens
  the whole `'mine'` board. Only the headline says which half is which — splitting the chips would
  cost a second number per workspace on a row whose one-line guarantee is why the component exists.
  ⚠ `relevanceSplit` takes **both fields or neither** (never `count - direct`, which would absorb
  a future third relevance into "in your repos"), and `sumRelevanceSplit` **refuses whenever ANY
  contributing line lacks the split** — mixed responses are real (the active workspace is computed
  fresh while the roll-up rides a 5-min cache), and summing halves over some lines and wholes over
  others prints two numbers that do not add up to the total beside them.
- The dropdown badge keeps the summed figure and carries the split in its **tooltip only**, where
  it costs no layout.

## `ci_failing` — the red-build card, and the three SILENT lists a new InsightKind must reach

A `ci_failing` card is a red build the viewer is on the hook for: `arm: 'your_pr'` (an open PR they
authored whose head CI is red) or `arm: 'trunk'` (the default branch of a repo they MAINTAIN is red
now). Server contract + the two things it deliberately does NOT compute:
[PRO-PLUGIN-AND-ACTIVITY.md](PRO-PLUGIN-AND-ACTIVITY.md) § "The `ci_failing` card". On the client:

- **The KIND label stays neutral** (`KIND_LABEL.ci_failing = 'CI failing'` — the isolation banner
  reads it); the OWNERSHIP claim is per card, from `arm`, in `cardKindLabel` — the same split
  `my_turn`/`personal` draws one layer up.
- **Every PR field is nullable and a null is ORDINARY** (a direct push to trunk has no PR), so the
  card renders the REPO as its subject and the PR as an optional line — it does NOT reuse `PrLine`,
  which requires all four PR fields. A card with no PR has no whole-card `onActivate` either: a
  click that does nothing is the inert card this board exists to remove.
- **The `viewerMerged` caveat is ON THE CARD** ("Trunk is red at this commit — not necessarily
  because of it"). We store no per-commit CI transition history, so nothing here can name the
  commit that broke trunk; saying so is cheaper than being asked.
- **The cap is DISCLOSED** (`ciFailingCapDisclosure`, `AttentionView`), unlike the survey kinds
  that share `INSIGHT_CARD_CAP`. Pair narrow with narrow: it reads `counts.ciFailing` /
  `ciFailingTotal` and never borrows `myTurnTotal`.

⚠ **THREE OF THE FOUR CLIENT TOUCH POINTS ARE SILENT — only `KIND_LABEL` is compiler-enforced:**

1. `renderCard`'s `switch` in `AttentionCards.tsx`. Its `default: return null` means a kind the
   brief COUNTS but the switch cannot RENDER simply vanishes — "header 5, list 3" with no server
   involved. That is exactly how `my_turn` shipped invisible.
2. `INSIGHT_KINDS` in `hooks/useUrlState.ts`, a hand-written runtime array. A kind missing there
   makes `?attn=<kind>` a no-op, so the brief line that counts it opens an UN-isolated board and a
   browser Back cannot return to the narrowed one. **`test/ciFailingCard.test.ts` now compares that
   array against `KIND_LABEL`**, forwarding the compiler's exhaustiveness onto it.
3. `BriefStrip`'s `hasAnything` — the strip self-hides when every figure is zero, so a kind left
   out of it can hide a line the strip has something to say on (a red build on your own PR leaves
   `trunkRed` empty).

## The sync round — a transient store slice with ONE driver (`syncRound` / `managerOpen`)

**One user-visible "sync round"** = the GitHub walk **plus** the ML scoring pass that follows it,
shared between the header sync button and the WorkspaceManager's embedded progress panel.

- **State** lives in `store/filters.ts` as `SyncRoundState`
  `{open, modal, syncing, cancelling, scopeIds}` plus the sibling flag `managerOpen`. Both are
  **transient** — not persisted, not URL-serialized.
- **`SyncStatus` (`components/SyncStatus.tsx`) is the SINGLE DRIVER.** It is **always mounted in
  the header**, so the round survives the manager opening and closing. It owns the
  `['sync-status']` + `['ml-status']` polls, the completion effects and every invalidation, and
  it is the **only writer** of the slice. Everything else consumes state and calls the actions
  `SyncStatus` registers.
- **The actions ride a MODULE-LEVEL registry** (`registerSyncRoundActions` /
  `getSyncRoundActions` — `{cancel, syncAllShallow, syncAllDeep, syncOneDeep, dismiss}`),
  deliberately **not store state**: they are per-render closures, and putting them in the store
  would churn every subscriber on each `SyncStatus` render. `SyncStatus` re-registers after every
  render so the closures see fresh data and unregisters on unmount; **null while unmounted means
  callers no-op, never queue**.
- **Routing.** The progress UI embeds **INSIDE the WorkspaceManager panel** (it must render
  within `panelRef`, or click-outside closes the manager). `SyncProgressModal` survives ONLY for
  the onboarding add path — `modal: true` **iff the manager isn't open**
  (`modal: !useFilters.getState().managerOpen`). Header-initiated rounds keep `modal: false`: the
  header never opens a dialog, the icon spin is the whole surface.

### Landmines

- ⚠ **The signal mailbox is an ARRAY (`syncModalRepoIds`), not a scalar.** A multi-add calls
  `requestSyncModal` once per repo in a **synchronous loop**; React 18 batches those sets and the
  effect runs **ONCE** for all of them. A last-writer-wins scalar read would scope the round to
  only the final repo. The effect **drains the whole pending list** and clears it.
- ⚠ **An open round's EMPTY `scopeIds` is the "all repos" SENTINEL — never append to it.**
  Appending would *narrow* a round that already covers everything down to just the newcomers.
  Merging only fills in `missing` ids when `scopeIds.length > 0`.
- ⚠ **Merging into an open round must re-arm `syncing: true`.** Past the walk phase (i.e. during
  the ML-scoring linger, where `syncing` is already false) the `['sync-status']` poll is
  **disabled**, so a repo added then renders frozen at 0% forever.
- ⚠ **Merging must NOT call `beginSyncRound()`.** That resets `seenRunning` and cancels the
  auto-close, stomping completion tracking for repos already being watched. The completion effect
  keys off `runningCount === 0` across the *now-larger* scope, so it naturally waits for all of
  them.
- ⚠ **The `foregroundComplete` handoff EXCLUDES `paused.reason === 'queued'` rows.** Queued rows
  can't start their foreground pass until the repos ahead of them finish their *whole* backfill,
  so counting them would block a multi-add round's handoff forever. The predicate is
  `nonQueuedRunning.length > 0 && nonQueuedRunning.every(s => s.progress?.foregroundComplete)`.
- **`seenRunning` is a latch, and it is load-bearing.** A just-triggered repo isn't reflected in
  the status poll for a tick or two, so `runningCount === 0` alone cannot tell "not started yet"
  apart from "finished" — without the latch the round declares done and refetches half-written
  data.
- **Auto-close is gated on BOTH halves** (`!syncing && !cancelling && !mlScoring && !mlUnknown`)
  and lives in its own effect. The walk ending used to schedule the close directly, which is
  exactly what made the model pass unrepresentable: the overlay closed on "✓ done" while scoring
  was only just starting.
- **Adding a repo from the manager AUTO-SWITCHES the active workspace to the destination** once
  the move commits — the "synced fine but nothing loaded" fix; the scope used to stay behind.

## There is ONE bottom-right toast column (App.tsx) + `GlobalLoadingBar`

⚠ **Never add a new independent `fixed bottom-4 right-4` element.** Three of them were painting
over each other at the same coordinate. `App.tsx` renders exactly one column —

```jsx
<div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
  <ClaudeReviewBanner /> <AutoMergeBanner /> <GlobalLoadingBar />
</div>
```

— and `ClaudeReviewBanner`, `AutoMergeBanner` and the ambient `GlobalLoadingBar` render as
**plain cards inside it**. `GlobalLoadingBar` is the BOTTOM-MOST card; the two toast stacks sit
above it rather than over it. The column is `pointer-events-none`: the bar is an **INDICATOR, not
a dialog** — no close button, no click target, and it must never steal a click from the board
underneath. The two toast stacks DO take clicks, and each re-enables `pointer-events-auto` on its
own card rather than on the column.

### The armed-merge progress stack (`AutoMergeBanner`)

ONE CARD PER MERGE, for the whole lifecycle. It used to toast only on an `armed → terminal`
transition, which meant arming produced nothing global and the outcome arrived as an unrelated
second surface. Now a row appears on the CLICK that arms, tracks the watcher's `phase`, and is
REPLACED IN PLACE by its outcome — ⚠ never re-add a separate terminal toast for a PR the stack is
already showing.

- **Immediate**: `useArmAutoMerge` SEEDS `ARMED_MERGES_KEY` with the POST's own response
  (`setQueryData` beside the invalidate — the arm route returns the full row, identity and
  `phase:'pending_first_check'` included). `useDisarmAutoMerge` symmetrically DROPS the row.
- **Live rows are derived from the polled list; outcomes are local state** captured on the
  transition. The list carries 24h-resolved rows, so the FIRST poll still seeds a silent baseline
  (a page load must not replay yesterday's merges), and deriving — not copying — the live half is
  what makes a cancel clear the card at once.
- **Terminals render off `state`; `lastReason` is only ever the secondary line** (it is NULL at
  success, so a card bodied on it goes blank exactly when it should read "Merged"). Phase copy
  comes from `phase`, with a `lastReason`-only fallback when it is null.
- **Adaptive poll, one query**: `useArmedMerges` is 8s while any row is `armed`, 45s otherwise,
  `refetchIntervalInBackground:false`. ⚠ The stack must NEVER call `useMergeOptions` per armed PR
  (~3 GitHub calls each) — the row carries its own repo/PR identity precisely so it doesn't.
- **Indicator + Cancel only.** Arming is consent anchored to `expectedHeadOid` and exactly ONE UI
  path (`MergeWhenReadyControl`) may arm; the stack must never grow a re-arm / "update now" /
  freshen action. Rows are click-to-open (`openPrDetailTab`), capped at 4 with a "+N more" line.

### What the loading bar covers, and why it exists

**HEAVY work only**: any **full-mode** sync walk (first-sync backfill / deep re-sync /
queued-for-full, via `GET /api/sync-activity`) **plus** the ML scoring pass that follows a walk,
strictly under `isMlScoring` — never a raw `pending > 0`. It exists because a user added
`redis/go-redis`: the walk finished fine and then ~733 bot comments (~735k chars) ground the
CPU-bound ONNX classifier for minutes **with no ambient indicator anywhere**, so the board looked
dead.

⚠ The two hooks are **circular** — the ML hook only raises its cadence when a walk is `active`,
while `useSyncActivity` needs `scoring` — so the walk flag rides a **ref one render behind**
(`backfillsActiveRef`). Walk percents change on effectively every fast poll, so the lag is one
poll at most.

### ETA mechanics (all pure + exported from `GlobalLoadingBar.tsx`, so they read as tests)

- **An UNCHANGED poll value is NO OBSERVATION AT ALL** (`observeDrain`). Work drains in **batch
  grain** — an ML batch of long comments lands tens of seconds apart — so the anchor stays put and
  the eventual drop is averaged over the whole gap. Sampling zero-drain polls instead would decay
  the EWMA between batches and make the ETA **flap several-fold on a ~30s cycle**.
- A **GROWN** value re-anchors **without** sampling (new work arriving is not negative drain);
  samples are clamped at ≥ 0 for the same reason.
- `STALL_CUTOFF_SEC` = 90: no drain for that long drops the learned rate (keeping the anchor) and
  degrades to "estimating…", rather than letting a dead rate quote a live countdown.
  `MIN_RATE_SAMPLES` = 3 gates the first stable estimate; `EWMA_ALPHA` = 0.3.
- **A rate-limit pause is ANCHORED, not sampled** (`anchorDrain`) — the pause window must read as
  neither a stall nor progress, or rate-limit minutes decay the rate into a nonsense post-resume
  ETA. Samples key on `dataUpdatedAt`, not wall clock, so a render without fresh data re-anchors.
- The stages run **CONCURRENTLY**, so `blendPercent` is a **remaining-time-weighted** average (the
  stage with more time left dominates — the bar tracks the work that actually gates "done"), with
  equal weights whenever any stage's ETA is unknown. `headlineEtaSeconds` is the **MAX** of the
  known stage ETAs, for the same concurrency reason.

### ⚠ The monotonic percent clamp and its three resets

`shownPercentRef` clamps the bar monotonically **within one stage composition** — a re-estimate
must never walk it backwards. It **RESETS** on:

1. **a stage-set change** (`walk-only` → `walk+ML` → `ML-only`, keyed by the `'b'`/`'m'` string);
2. **backfill-set churn** — a repo joining or leaving the list (`nextPercents.size <
   prevPercents.size`);
3. **a per-repo percent REGRESSION** (`p < old - 0.02`).

Reset 3 is not defensive coding: **the two-phase first sync legitimately restarts the
server-side percent from ~1.0 back to ~0.16 when phase 2 begins**, and pinning across that would
hold a stale ~100% through minutes of real work. The churn check is idempotent across data-less
re-renders (same map, no drops). A new burst can also begin **inside** the previous burst's 1s
fade window, so all the trackers reset on the idle→active transition itself, not only in the
fade-out.

`backfillFinishing` (rows still listed but every walk at ~100%, `remaining <= 0.01`) suppresses
the countdown: the post-walk tails (ML-label purge, CI-history backfill) leave no drain to
estimate, and a "~5 sec left" would sit frozen for minutes.

---

## Iconography — `components/Icons.tsx`

The SPA ships **no icon library and no rendered emoji**. Every icon is a hand-written inline SVG
component in one module. Read that file's header before adding one: it states the contract (24×24
viewBox, `currentColor`, a `size` prop, `title` as the a11y switch — absent means decorative and
`aria-hidden`, present makes it `role="img"`) and, at the bottom, exactly what stayed a character.

### Why the migration happened

~500 rendered glyphs were replaced. Three things were wrong with all of them:

1. **An emoji paints its own colour.** 🙂 stayed a yellow face on both themes, could not be dimmed
   with the button around it, and ignored every hover and disabled state. Same for 🤖 💬 ✨ 🎉.
2. **A glyph is a font lookup**, so its advance width, baseline and weight are the platform's
   choice. ✕ and ✓ sat on different baselines; ▾ and ▸ had visibly different optical sizes; ⚠ and
   ✅ become full-colour emoji on several platforms via the variation-selector default.
3. **It cannot be sized.** The AI-Fix picker's drag grip was a braille cell (⠿) whose "~11×12px"
   box the 4px drag threshold was reasoned against — a guess the gesture depended on.

### ⚠ What is deliberately NOT an icon

Each of these is a decision, not an oversight, and "finishing the migration" would break something:

- **Regex matchers and test fixtures.** `sync/review-fingerprint.ts`,
  `sync/bot-resolution-markers.ts`, `packages/pro/src/bot-themes/build.ts` and `db/queries.ts`
  (~9195, use `grep -a`) match ⚠️ 🛠️ 🧹 💡 ✅ **that review vendors write into their own comment
  bodies**. Changing one silently breaks bot classification and no test fails loudly.
- **`Activity/periodReportMarkdown.ts`** — a markdown export people paste elsewhere. It has no DOM,
  so its ▲ ▼ ▵ stay characters.
- **The backend CLI** (`apps/backend/src/status.ts`) — a terminal, not a browser.
- **Glyphs inside `title=` / `aria-label=` strings.** An attribute value is text; those sites were
  **reworded** (e.g. "the ✕ on the tab" → "the close button on the tab").
- **Typographic arrows in prose and chart labels** ("open → 1st review", "Reports → People"),
  maths/punctuation (· − ≥ ≈ ∪ ∩), and the landing arcade's ← → key legend.

### Two rules that are easy to get wrong

- ⚠ **`▾` was TWO controls.** `CaretIcon` (solid triangle) for a control that opens a **menu**;
  `ChevronIcon` for an **expand/collapse** disclosure. Decide by what the click does. They were the
  same character before, which is why the two roles were indistinguishable.
- ⚠ **`lib/ui.ts` is `.ts` and cannot hold JSX**, so `CHECK_STATE_META.icon` is a component
  **reference**, rendered `<m.icon size={11} />`. Its seven states each keep their own mark:
  "it decided nothing", "it never ran" and "GitHub told us nothing" are three different facts, and
  collapsing any into the failure mark would report a red nobody observed.
