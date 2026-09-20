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
    `users.isBot`, the accounts GitHub types a Bot (`github_type = 'Bot'`), the `AUTOMATION_VENDORS`
    logins and prefixes, and the workspace's automated-reviewer verdict, a workspace manual "human"
    winning both ways — the same set the Pending board calls automation; the two middle halves newly
    hid 34 events from five accounts on the dev DB). ⚠ **The wire `User.isBot` IS that
    workspace-free verdict**, not the raw column (`mapUser`, db/queries.ts): every client-side union
    layers the workspace judgement on top of it, so a narrower flag would have the server hiding an
    actor the client still counted as a person. The URL follows the excludeStale pattern — `bots=0` = shown, clean URL =
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
  default, on its Pending board** (Activity-first; a bare load → `?view=activity`, deep links keep
  timeline).
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
  from `mergeVerdict` — this row is where the old "mergeable" lie lived), a **Conflicts** row on
  the `conflicts` verdict (open PRs only, gated by the pure `conflictsRowVisible(state, verdict)`
  in `lib/ui.ts` — ⚠ **the gate is the RESOLVED verdict, never
  `mergeStateStatus === 'dirty' || mergeable === 'conflicting'`**: `mergeVerdict` ranks the merge
  QUEUE above its conflict test, so a raw-column gate would sprout a second answer to "can this
  land?" directly under a Status row saying "in merge queue"; going through the verdict also
  inherits the `state === 'open'` test, and a merged PR's stored merge state is stale. It renders
  the **action, not the fact** — the **Resolve conflicts** button plus a link out to the PR on
  GitHub — because the fact
  is the red `conflicts` chip on the Status row directly above, whose `· detail` echo is
  SUPPRESSED for this one verdict, the same replacement rule the queue chip uses; the sentence
  survives on the chip's `title`. ⚠ **THE ROW IS NOT GATED ON `viewerCanPush`; THE BUTTON INSIDE IT
  IS.** Unlike the Pending `conflicts` CARD, which is writable-repos-only, this row is a statement of
  fact about a pane that is already open, and the Status chip states it to every reader anyway;
  gating it would make the pane say less than its own first row. A reader without push access — or
  anyone in cloud, where the resolver's routes are not registered — sees the link alone, which is
  exactly what this row was before the button existed. ⚠ **The link carries its own verb**, so the
  row reads correctly with the button present AND absent: its predecessor was the sentence "Resolve
  the conflicts on GitHub.", which, once a button offering to do it here sits beside it, sends the
  reader somewhere else for the thing in front of them. ⚠ It names **no branch**, because
  it cannot without a fetch: `PrDetail` carries no base ref — `pull_requests.base_ref_name` is
  synced but `getPrDetail` does not emit it — and `PrMergeOptions.baseRef` arrives only with the
  click-gated merge-options call, which is why `MergeControl`'s expanded panel is where the branch
  gets named. `mergeVerdict` itself needs and gets NO change), a **Blocked** row on a
  `blocked` PR only (the ranked candidate causes from `deriveMergeBlockers`, ordered by a computed
  certainty — proven first — that is deliberately NOT narrated: the PROVEN/INFERRED chip and the
  note under each row were removed, and only the ordering survives; the `unresolved_threads` row is
  clickable through to the Threads tab via `onOpenThreads`; ⚠ its thread count is `!isResolved` and therefore INCLUDES
  `likely_addressed`, which is why the Bots chips inches away say "N need a look" rather than "N
  unresolved" — the full three-count table and the never-assert-a-cause rules are in
  **docs/MERGE-CI-TRUNK.md § Why a blocked PR is blocked**), **Reviewers** (all who
  submitted a review, badged by latest state) above **Approvers** (latest decisive review =
  `approved`), then **Merged by**, **Requested** reviewers, labels, meta, an **Actions** row
  (approve / `MergeControl` / `MergeWhenReadyControl` / `ClosePrControl` / `ReopenPrControl` — the
  two merge controls are handed the same `MergeBlockFacts` this tab built, so the merge button's own
  explanation stops being the worst one on the screen. ⚠ **The Actions row is the ONE row that opens
  on a CLOSED PR**, via `viewerCanReopen && state === 'closed'`: before `ReopenPrControl` its gate
  was two `state === 'open'` disjuncts plus the un-state-gated `viewerCanApprove`, so a closed PR
  you AUTHORED showed no actions at all while a closed PR somebody else authored showed one holding
  just Approve. `ReopenPrControl` has **no confirm step**, unlike `ClosePrControl`: a reopen is the
  undo of a close and is itself undone by the Close button beside it, so a two-click gate would be
  ceremony around a reversible act. It prints GitHub's own refusal sentence when the 409 comes back
  — normally the head branch was deleted after the close) — then the PR **Summary** (markdown,
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
  - ⚠ **THE TOUCH ROW IS FOLDED, one chip per RUN of ADJACENT touches sharing a rendered time**
    (`groupTouches`), showing that run's count (`×14`) beside a review and/or comment icon. The
    wire is one touch per DB ROW and `relativeTime` rounds past a day to whole days, so the
    unfolded row printed "9 days ago" fourteen times on a real PR — a resolution coarser than the
    differences it existed to show. Adjacency is load-bearing: a global bucket would stop the row
    being a timeline. The chip counts SUM to the `Touches` stat, and the overflow line is spelled
    in TOUCHES so it shares that denominator. ⚠ **The icons say PRESENCE, so the run's
    review/comment SPLIT is spelled in the hover title** ("2 reviews, 12 comments · 04/09/2026,
    09:12 – 04/09/2026, 09:26" — both ends in full, through `dateTime()`; a one-touch group prints
    the instant alone) — without it a run of 1 review + 13 comments and one of
    13 reviews + 1 comment paint identically, which is exactly the decomposition the tab's intro
    line teaches the reader to make. "A touch is one review or one comment" is said ONCE, in that
    intro line, never per chip.
  - ⚠ **The GROUP cap (`TOUCH_GROUP_CAP` = 40) is a safety rail, not a display budget** — measured
    over all 4,525 (PR × bot) cards in the dev DB, the busiest (240 deepsource-io touches on
    erxes/erxes#9178) folds to FOUR chips, the most any card produces is 21, and not one reaches
    40, so the overflow line never appears. Cite that figure, not a second measurement: the code
    comment above the constant carries the same one.
  - ⚠ **ONE NUMBER, ONE PLACE.** The `<Stat>` owns the absolute TTFR; the vs-typical note owns the
    BASELINE ("slower than typical — usually 19m"), never the absolute again. The anomaly badge
    prints the delta over typical ONLY when `dur(delta) !== dur(ttfr)` — a comparison of the
    RENDERED strings, because every review bot on this account has a typical TTFR under 25 minutes
    while sigma is floored at 0.5h, so a day-scale anomaly renders the delta and the absolute as
    the SAME string. When they match the badge reads "slower than usual" with no number and the
    Stat carries the magnitude; when they differ the number stays.

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
- **The rail's WIDTH is user-dragged and persisted** (`hooks/useResizablePane.ts`, localStorage
  key `pierre:changesRailWidth`, default 224px = the old `md:w-56`). The rail and its
  `role="separator"` handle share ONE sticky flex wrapper, so the handle inherits the rail's
  measured height instead of needing a second measurement. ⚠ The width is deliberately NOT in the
  Zustand filter store: persistence and "Clear filters" share one list there, so a filter reset
  would teleport the furniture. ⚠ The ceiling YIELDS to the diff — `min(720, rowWidth − 320)`,
  measured off the split row — so neither pane can be dragged, or restored from a wider window's
  stored value, down to nothing; `clampPaneWidth` is the ONE place that decides, and on a
  container too narrow for both minimums the FLOOR wins (the rail overflows) rather than the
  bounds inverting. Keyboard: ←/→ (×4 with Shift), Home/End, Enter; double-click resets.
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

**Default landing = PENDING, for every tier.** The rail reads Pending · Feed · Bots · Reports and
its top entry is what opens. `activityRepoId` defaults to `'attention'`, the ONE rail value
omitted from the URL; `'feed'` is EMITTED and PARSED (`?activityRepo=feed`) so a Feed link
survives. An unknown or legacy value (`compare`, garbage) and a URL naming no console land on
Pending — including bookmarks from before this change. The Feed is still the stream with
**`BriefStrip`** on top; the brief's lines deep-link INTO Pending. (The landing was the Feed from
P3.1 until this change; the older one-shot "auto-select Insights when Pro is on" effect,
`insightsDefaultApplied` + `suppressInsightsDefault()`, is deleted.) The Insights rail entry is
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
  UNION set (workspace judgement wins both ways, the wire `User.isBot` fallback) — deliberately NOT the
  legacy login-string classification PrDetail's bot chips still use; and every figure comes from
  the SAME folds the Threads tab uses (`rollupCounts`/`threadSeverities`/
  `resolvableBotThreadIds`) restricted to the bot subset, so card and tab cannot disagree.
- **Bots view is `ROI ('roi' = Measure) | Themes | Advisor | Benchmark | Settings`**
  (`botsInnerTab` lost `'behaviour'` — transient + URL-silent, so member removal is safe — gained
  `'benchmark'`, and has since REGAINED `'themes'`; see "The Bots Themes panel" below). ⚠ **TWO
  GATING POSTURES SIT IN THIS ONE STRIP AND BOTH ARE DELIBERATE**: `'roi'` and `'benchmark'` are
  visible-but-locked (`botDepth`) and are NEVER corrected away, while `'advisor'` (`botAdvisor`)
  and `'themes'` (`activityDigest`) are LISTED only when entitled and degrade to `'roi'` in
  `effectiveBotsTab`. `'settings'` is free, and is why the rail entry and the strip stay ungated.
  ⚠ **THE `roi`
  SUB-TAB IS PAID (`botDepth`) AND THE WHOLE `BotRoiPanel` LOCKS IN PLACE** — the tab stays
  selectable (no corrective `setBotsInnerTab`; only `'advisor'` and `'themes'` are corrected, and
  only because neither is LISTED without its capability), wears an
  unconditional `ProBadge variant="tab"`, and the BODY renders `ProLockPanel`
  (`testId="bot-roi-locked"`, distinct from the entitled `bot-roi-panel` so the screenshot pipeline
  can never photograph the lock). Inside the panel and therefore paid: the vendor table, its
  keep/tune/noisy verdicts, the **Inflation column INCLUDING its current-window counts** (the
  weekly sparkline stays separately conditional on `mlInflation.weekly`, an extra scan width — as
  does `InflationHistoryChart`, the enlarged twin of that sparkline in this panel's chart row, on
  the same field and the same `showMlColumns` gate; contract in docs/ML-SEVERITY.md § The enlarged
  inflation chart), the deterministic **"What the bots are flagging"** ML totals strip
  (`MlTotalsStrip` — no AI, paid with the panel), the volume column and every drill-down.
  ⚠ The AI report titled **"What they're flagging"** LEFT this panel and is the `Bots → Themes`
  sub-tab (`activityDigest`, listed only when entitled) — which is also what pulled the two
  near-identical headings apart: they used to sit on one screen, and now cannot. What stays FREE around it, in `BotsView`: the amber bot-only governance caution, the
  resolve backlog, the **hoisted `TuningSuggestions` box** (moved OUT of the panel so the narrowed
  `/api/bot-analytics` can keep feeding it — do not move it back, and note it now sits ABOVE the
  table for entitled readers), the bot feed, and the whole Settings tab. `WorkspaceBotCharts`
  (`botDepth`) keeps the older ABSENCE posture on purpose — a second upsell stacked under the first
  reads as a paywall page.
- ⚠ **`BotRoiPanel`'s `$/acted-on` COLUMN IS A GRAIN GATE AS WELL AS A TIER GATE:
  `showCost = botDepth && repoId == null`.** A price is stored ONCE PER WORKSPACE, so dividing a
  whole month of it by ONE repository's work reads as spend and cannot be summed across repos — the
  same argument that deleted `BotBenchmarkPlacementUnit.cost`. The RAIL mount keeps the column and
  its footer instruction (that data is already workspace-grained and therefore already exact); the
  per-repo mount loses the `<th>`, the `<td>` and the "set a monthly price" clause, and gets a
  REPLACEMENT sentence naming the reason and pointing at the rail — an elision alone reads as a bug
  or a permissions glitch, and invites the next reader to "restore" the column. ⚠ **Do NOT simplify
  `showCost` back to `botDepth`** (its `false` branch used to be unreachable from the live mount and
  the docstring said so; every per-repo Bots tab reaches it now). The `ProLockPanel` body drops its
  cost clause on the per-repo mount too — a lock is a PROMISE about what paying reveals, and paying
  no longer reveals that figure there.
- **The Bots RAIL ENTRY stays ungated on every tier**, exactly like Reports': it owns the free
  classification/Settings screen, the free triage flows and the governance caution. Its tooltip says
  which half is which.

### Bots → Benchmark (the peer-cohort placement, `botDepth`)

`BenchmarkPanel.tsx` + the pure `benchmarkModel.ts` + `hooks/useBotBenchmark.ts`, mounted by
`BotsView`'s `BenchmarkTabBody`. It renders `GET /api/pro/bot-benchmark/placement` — this
workspace's (repository × reviewer) units, folded over the CORPUS's own metric definitions, placed
in a per-vendor activity band and ranked against the fitted cell. Tests:
`apps/frontend/test/botsBenchmark.test.ts` (**hand-run — `apps/frontend/test/` is not in CI**).

- ⚠ **ONE COMPONENT, TWO BODIES, AND `repoId` IS WHAT PICKS ONE.** `BenchmarkPanel({repoId})`
  computes `isRail = repoId == null` and passes it into `Body` **as its own prop** — deliberately
  NOT `data.rollup != null`, so a version skew (an older plugin serving no rollup) cannot silently
  change which screen the reader believes they are on.
  - **RAIL (`repoId == null`)**: header meta → truncation note → `FindingsSection` → **the ROLLUP
    CARDS** → absent metrics → `MeasuredDisclosure` → disclosures. **NO `UnitCard` renders here.**
  - **REPO TAB (`repoId != null`)**: exactly what it always did — one `UnitCard` per unit, with its
    thirteen metric strips, band placement and refusals — **MINUS money entirely**. The old
    `CostBlock` is DELETED, not hidden: `BotBenchmarkPlacementUnit.cost` is off the wire, and a
    `?repoIds=`-narrowed request receives no `rollup` either, so there is no figure in the payload
    for a future renderer to find. See [docs/PRO-PLUGIN-AND-ACTIVITY.md](PRO-PLUGIN-AND-ACTIVITY.md)
    § "The WORKSPACE ROLLUP".
  - ⚠ **THE FINDINGS SECTION LEADS ON BOTH SCREENS, UNCHANGED.** An anomaly is per (repository ×
    reviewer) and stays that way — it is the one thing on the rail that names a repository, because
    "acted on far less of this reviewer than its peers" is work somebody does IN a repository.
    Folding findings up to the vendor would turn n actionable rows into one unactionable average.
  - ⚠ **THREE DISTINCT EMPTY SENTENCES, and collapsing any pair has already shipped a defect.**
    `benchmark-no-units` (nothing is classified as an automated reviewer), `benchmark-no-rollup`
    (`rollup` key ABSENT — this build served placements but no rollup; the rail draws no
    per-repository cards, so it would otherwise be a findings list with nothing under it), and
    `benchmark-no-live-reviewers` (`rollup === []` — the fold RAN and no reviewer has commented
    yet). ⚠ A `?? []` collapsing the last two told a reader whose bots simply had not commented that
    their BUILD was deficient — the ordinary state right after classifying a reviewer in
    Bots → Settings.
  - The truncation note's remedy clause ("open a repository's own Bots tab", plus the sentence
    saying money is withheld while counters and spread still render) is **rail-only**; on the
    repository tab that advice is a no-op, and it shipped unconditional.
- ⚠ **SIXTH VISIBLE-BUT-LOCKED SURFACE, and the argument is in `ProGate.tsx`'s header.** It could
  have hidden inside the already-locked `roi` branch; it does not, because it is the only place in
  the product that answers "is this bot NORMAL?", and an absent tab leaves that question
  undiscoverable. Tab listed on every tier, unconditional `ProBadge variant="tab"`, body renders
  `ProLockPanel testId="benchmark-locked"` — DISTINCT from the entitled `benchmark-panel`.
- ⚠ **THE VISIBLE TAB IS DERIVED AND `'benchmark'` IS NEVER CORRECTED.** `effectiveBotsTab()`
  (in `benchmarkModel.ts`, so it can be tested without a renderer) degrades ONLY `'advisor'`;
  `?botsTab=benchmark` is parsed on every tier off `BOTS_INNER_TABS` itself, so an unentitled
  bookmark lands on the tab it names and meets the lock there.
- ⚠ **THE ANOMALY LIST IS THE HEADLINE; the distributions are evidence beneath it.** A percentile
  alone is trivia — the server's four templated `action` sentences are the product. Each finding
  renders BOTH gates separately (`share` and `magnitude`), never their conjunction, so a reader can
  argue with the threshold instead of the verdict. Empty renders a tally ("N comparisons across M
  placed reviewers") so "nothing stands out" reads as CHECKED, not as NOT RUN.
- ⚠ **EVERY RENDERED PERCENTILE CARRIES ITS COHORT n AND ITS BAND COUNT** (`percentileSentence`).
  The seven fitted vendors carry 10/10/9/7/4/3/2 bands, so "upper fifth" is honest at 5 and a
  misrepresentation at 10. The rank's denominator is the METRIC's own `cohort.nRepos`, NOT
  `anomaly.cohortRepos` (the repositories that defined the band cut) — two different numbers.
- ⚠ **FOURTEEN DISTINCT REFUSAL SENTENCES, pairwise asserted.** Five placement refusals, three
  whole-artifact ones ("this build ships no corpus" is NOT "there isn't enough peer data yet"), six
  per-metric exclusions, plus a fourteenth for "no automated reviewer to place". A customer's
  biggest bot can be absent from the corpus entirely (DeepSource is real) — it renders NAMED, with
  "we have never measured this reviewer", never a zero. ⚠ The rail adds two more vocabularies on top
  of those fourteen: **eleven** `COST_REFUSAL_HEADLINE` entries (the tenth is `workspace_truncated`,
  the eleventh `window_underpopulated` — "too few acted-on threads this month to price", which is a
  different fact from `nothing_acted_on`'s whole-and-empty month and must not borrow its words) and
  **five** `ROLLUP_REFUSAL_HEADLINE` entries. `vendor_not_in_corpus` deliberately reuses
  `PLACEMENT_REFUSAL_HEADLINE.vendor_not_in_corpus_vocabulary`'s exact words — same fact, same
  sentence; two wordings for one cause on one card is how a reader stops believing either.
- ⚠ **ONE FETCH ON MOUNT, AND THE ROLLUP RIDES IT.** `rollup[]` arrives on the SAME placement
  response as `units[]` — do not add a second eager query for it. `useBotBenchmarkPlacement` uses
  `skipToken` (not `enabled`) while `workspaceId === null`, which means NOT RESOLVED YET; leave that
  alone. ⚠ `repoKeySlot([])` and `repoKeySlot(null)` BOTH return `'all'` while the wire distinguishes
  them, so a caller that ever passes a FILTERED array would serve an empty selection's answer out of
  the whole-workspace cache slot. `useBotBenchmarkPlacement` is the tab's only query; the "How these are
  measured" disclosure (`useBotBenchmarkSpecs`) is CLICK-GATED (`enabled: botDepth && open`) —
  the Pending-board precedent, where an eager per-card fetch became 150 GitHub calls. Both hooks AND
  `botDepth` into their own `enabled`, because a mounted-but-unentitled pane would otherwise poll a
  402 on a timer.
- ⚠ **THE DEFINITIONS ARE SERVED, NEVER RE-TYPED.** `METRIC_LABEL` holds DISPLAY names only; the
  numerator/denominator/population comes from `metricSpecs` on the cohort route, because the app's
  own bot columns are NOT these columns.
- ⚠ **SEVERITY AND CATEGORY ARE STRUCTURALLY ABSENT, not empty and not zero** — model-derived, and
  the corpus is unscored. They render in their own block, labelled `Model-derived` against every
  other figure's `Counted`, with the precondition spelled out.
- **THE ROLLUP CARD (`RollupCard`, rail only) — one per vendor, in this order:** reviewer pill +
  `row.coverage` ("live in 4 of 8 repositories") + folded logins → `PooledCounters` →
  `WorkspaceCostBlock` (only when `rollup.cost != null`) → the spread sentence → the estate-matched
  expectation → `EvidenceTable`. It takes a whole `RollupRow` from `benchmarkModel`'s `rollupRows`,
  so the key, title, label and colour are resolved in ONE place.
  - ⚠ **THE REACT KEY IS `rollup.key` — the WORKSPACE's vendor key.** `UnitCard`'s
    `${repoId}:${vendor}` collides with itself on a card that has n repositories, and `vendor` is
    `null` for every brand the corpus never saw (most of what a real workspace runs), so keying on
    it collapses every unbranded bot onto one card. `unitTitle` is likewise the SORT KEY for
    `anomalyRows`/`orderedUnits` and cannot serve here; `orderedRollups` sorts spread-bearing cards
    first, then reviewer label, then key — **never by a figure**.
  - ⚠ **THE CARD RENDERS NO PERCENTILE OF ITS OWN, EVER.** There is no distribution of workspaces,
    and a volume-weighted pool against a one-repo-one-vote cohort is a number no cohort member
    resembles. Its two comparisons — the spread and the expectation — are both built out of the
    PER-REPOSITORY placements, and every rank on the card lives in the evidence table against its
    own band.
  - **The header prints the pill + `row.coverage` with `row.title` on the `title=` attribute** —
    rendering `rollupTitle` verbatim beside the pill prints the vendor's name twice.
- **`PooledCounters` renders ALL FOUR counter maps IN FULL**, in a fixed `COUNTER_GROUPS` order
  (never `Object.entries` order), `formatCount` on every value, `tabular-nums`. ⚠ **A curated
  shortlist would break the additivity invariant the section exists to make checkable** — the whole
  is the sum of the parts for EVERY key, and a reader must be able to check the headline against the
  table below it. Density, not omission, is the answer if it gets heavy. ⚠ The two overdue maps stay
  their own groups rather than being joined into "4 untouched of 11", because the join needs an
  absent key to read as `0`, which this panel refuses everywhere else.
- **`EvidenceTable` — the audit trail, one row per LIVE repository** (`contributionRows`, fold
  order preserved): Repository · Activity band · Merged PRs, 14 days · Acted on · Rank in its band.
  Inside its own `overflow-x-auto` with `min-w-[32rem]` — the panel body must never scroll
  horizontally and five columns do not fit a laptop rail.
  - ⚠ **A DASH IS A WITHHELD FIGURE, NEVER A ZERO**, and the footnote says so: `actedOnRate` and
    `percentile` are `null` whenever that repository's own metric was withheld, and printing `0%` /
    `0th` would read as "worst in the cohort" for a comparison that never happened. **Its COUNTS
    still pool into the headline** — pooling is the remedy for a thin sample, which is why the gate
    is on the ROW and not on the fold.
  - ⚠ **A REPOSITORY WHOSE PLACEMENT REFUSED STILL EARNS A ROW**, with the refusal's headline
    (+ `ThinSampleIcon`) in the band cell instead of a band. Dropping it would make the table
    disagree with `liveInRepos` — and the money above it is divided by that estate.
  - The footnote also states that each rank is read against that repository's OWN cohort band, so
    the ranks are not comparable with each other.
- **The spread and the expectation are TWO SIBLING conditionals, each with its own refusal note.**
  `rollupSpreadSentence` names every non-zero side ("sits below it in 5 and above it in 1"), and its
  denominator is spelled "placed with a comparable acted-on rate" so it can never be read as
  `liveInRepos`. ⚠ **`rollupExpectationSentence` PRINTS BOTH RATES SIDE BY SIDE AND SUBTRACTS
  NEITHER** — "across the 3 repositories with a fitted peer median, your team acts on 41% … where an
  estate of this shape at its cohorts' medians acts on 58%", then names the excluded repositories
  and says the pooled rate above is a different number. That is PERIOD-REPORTING's "ONE ROW MUST
  NEVER MIX THE HEADLINE AND SUBSET POPULATIONS", one grain over.
- ⚠ **THE COST BLOCK IS WORKSPACE-GRAINED AND ABSENT WHEN NO PRICE IS SET — not empty, not zero, and
  not a "set a price" prompt.** `WorkspaceCostBlock({cost, expectation})` mounts on
  `rollup.cost != null` and nothing else; the per-repository `CostBlock` and `unit.cost` are GONE.
  TWO other states are DIFFERENT and both RENDER: a price of exactly **0** is real and deliberate
  ("recorded as free"), and a **`monthlyUsd` of `null`** is a price somebody entered whose per-seat
  unit could not be multiplied out (`price_unresolved`). Both refuse every derived figure with a
  sentence rather than printing US$0.00 three times. Contract:
  [docs/PRO-PLUGIN-AND-ACTIVITY.md](PRO-PLUGIN-AND-ACTIVITY.md) § "The WORKSPACE ROLLUP" (the
  superseded per-repository § "Cost on the Benchmark tab" keeps the reasoning behind every rule the
  fold still imports). What the renderer owns:
  - ⚠ **TESTIDS ARE `benchmark-workspace-cost-*` WHEREVER THE CLAIM CHANGED GRAIN** (the block, its
    three figure rows, the collapsed refusal, the headline, the coverage note, the two disclosures);
    ids emitted by a shared primitive or describing the PRICE — `benchmark-cost-basis-*`,
    `benchmark-cost-refused-*`, `benchmark-cost-seat-unresolved`, `benchmark-cost-seat-zero` — kept
    their names, because a price was per-Workspace at both grains. Reusing the old ids wholesale
    would let a test written against the per-repository claim stay green while asserting it about a
    new number.
  - **`workspaceCostHeadline` takes TWO arguments, `(cost, expectation)`** — at this grain the
    counterfactual is a SIBLING of cost, not an arm inside it, so a vendor the corpus never saw
    renders its money while only the comparison refuses. Sentence one quotes the POOLED population,
    sentence two OPENS by naming the fitted subset before either rate.
  - **`AtPeerEngagementRow` renders NOTHING when the expectation refused** — the sibling expectation
    section states that refusal in full a few elements below, and a dimmed row carrying the same
    headline reads as two measurements that each came back empty. It DOES render a money-half
    refusal (`moneyRefusal`), which is a cost-vocabulary reason nothing else on the card accounts
    for.
  - ⚠ **THE `$ per acted-on thread` ROW IS THE ONE FIGURE A READER CAN CHECK, AND IT IS BUILT TO BE.**
    `workspaceCostActedOnLabel` names the window from the SERVER's `costWindowDays` (never an inlined
    "30"), and `workspaceCostActedOnDetail` prints the two numbers the figure divides — "243 of 479
    threads acted on · US$783.00 a month", against a figure of US$3.22. The row it replaced read
    "255 of 544 threads acted on across 1 repository — about 32.7 a month" beside US$23.94, where the
    32.7 came from dividing by a 237-day observed span that appeared NOWHERE on the card. ⚠ "across
    1 repository" is DROPPED at `coveredRepos === 1` — that clause exists to make a POOLED figure
    legible and is noise otherwise. ⚠ The server's `basisNote` says the same division in a sentence
    and renders whenever the money does.
  - ⚠ **`yours` AND `unacted` CARRY DIFFERENT POPULATIONS UNDER THE SAME FIELD NAMES.** `yours` is
    the last calendar month (the money's window); `unacted` is every pull request the walk read.
    Each sentence names its own — the headline's spend clause ends "…on every pull request read
    here" for exactly that reason. Dropping either qualifier rebuilds PERIOD-REPORTING's
    headline-vs-subset defect as two rows a reader takes for one.
  - **`workspaceCostSpanUnobservedNote`, `workspaceCostPartialWindowNote` and
    `workspaceCostWindowIncompleteNote` must all render — THREE causes, three sentences.** An
    unrendered `partialWindowRepos` makes `$/merged PR` silently inflate in the flattering direction;
    `costWindowIncompleteRepos` explains a WITHHELD per-thread figure (a repository younger than the
    cost window has a partial month of work against a whole price, and excluding it would push the
    quotient higher still). ⚠ `workspaceCostSpanUnobservedNote` was REWORDED, not kept: it said those
    repositories "contributed nothing to the per-month pace", which was true while the pace divided
    by an observed span and became FALSE the moment the money moved to a chosen month. A caveat that
    no longer describes the arithmetic is worse than none. "A missing disclosure is the same defect
    as a wrong number, one line quieter."
  - **`workspaceCostCoverageNote` REPLACED `costSharedNote`** — the "upper bound / n other cards
    carry this same number" caveat retired with the grain it compensated for. ⚠ Its own FIRST HALF
    then went too: it argued that the price and the work describe the same repositories "so there is
    nothing here to add together", a rebuttal of `unit.cost`, which was DELETED FROM THE WIRE before
    this shipped. What survives is the one claim still true and still actionable — a subscription may
    cover repositories outside this Workspace, and in that direction the figure is an upper bound. ⚠ `costSharedNote`'s
    full argumentative docstring survives verbatim as a `── HISTORICAL ──` block above its
    replacement: it is the written record of a shipped defect, and the function itself is dead code
    awaiting a delete-with-test-rewrites.
  - **`formatUsd` prints `US$`, never a bare `$`**, and a non-zero sub-cent figure prints `<US$0.01`
    rather than rounding to `US$0.00` — that is the zero-price failure mode arriving from the other
    direction. The windowed TOTAL carries `per 14 days` (`costWindowLabel`), because a bare "US$412"
    beside a monthly subscription invites the reader to assume a month.
  - ⚠ **A RATIO NEVER CARRIES THE WINDOW.** Both value rows shipped with the label appended, so
    "Per merged PR" read "US$5.52 per 14 days" and "Per acted-on thread" read "US$27.60 per 14 days"
    — which reads as $/PR/fortnight and invites doubling for a month. Neither scales with the
    window: both halves of each fraction scale together, so the figure is the same at any window
    length. The basis moved into the detail line, as prose, and the frontend test carries a SOURCE
    GUARD on the three `figure=` props.
  - ⚠ **THE HEADLINE IS TWO SENTENCES CARRYING TWO DIFFERENT FIGURES** (`CostHeadline` is
    `{tone, spend, comparison}`). `spend` is what the price CURRENTLY BUYS AND NOBODY ACTS ON, per
    month — measured, own data only — and `comparison` is what CLOSING THE GAP to the cohort median
    is worth, per month. They differ by a factor of the cohort's rate; the first cut printed the
    second's number under the first's words. Two fields, so a renderer cannot reunite them. `tone`
    gains `'measured'` for the case where the cohort published no median: the measured sentence
    stands alone rather than the whole headline vanishing, which is what shipped.
  - ⚠ **EVERY REVIEWER FIGURE IS A RATE AT TODAY'S PRICE, NEVER A SPEND OVER THE SPAN.** The
    sentences shipped as shares of a prorated `span.usd` — "US$189.22 of this reviewer's US$236.53
    over the 8.6 weeks its comments span here" — which is a history the app cannot evidence, and a
    cap would have kept the claim and shrunk it. `span.usd` is gone from the wire; the span still
    renders as the window the WORK was measured in, and the per-month divisors
    (`cost.yours.actedPerMonth`, `expectation.actedPerMonthAtPeer`) ride the wire beside their
    quotients so the rows are checkable. `$ per merged PR` is the one 14-day figure on the card, and
    `spanNote` says which figure sits on which basis. ⚠ At the rollup grain the pace is **a SUM of
    per-repository rates**, and the served `spanNote` (`ROLLUP_SPAN_NOTE`, a second note beside
    `cost.ts`'s original) adds the sentence saying the stretches are NOT joined — a union span would
    understate the pace and inflate every $/thread by the same factor.
  - **`costSeatZeroNote` is a DIFFERENT sentence from `costSeatUnresolvedNote`** — "this build
    cannot read your seat count" and "your Workspace has no human authors this month" have
    different remedies, and a per-seat price silently multiplied by 0 is what put "recorded as
    free" on a reviewer somebody priced. ⚠ **BOTH ARE REACHABLE ON A CARD WITH NO MONTHLY FIGURE**,
    which is why that state renders at all: when the drop empties the unit the server sends
    `monthlyUsd: null` rather than no block, and these two lines are the only thing on screen
    explaining a price the reader typed. `costPriceLine` says "No monthly figure — …" instead of
    `formatUsd(null)`, and `workspaceCostCoverageNote` is the one caveat GATED OFF there (it points
    at a figure); every other line stays. ⚠ These four — `costPriceLine`, `costPricedReviewersNote`,
    `costSeatUnresolvedNote`, `costSeatZeroNote` — take STRUCTURAL parameter types
    (`PriceLineFacts` / `SeatDisclosureFacts`) so both grains call the SAME functions. A second copy
    would let the per-seat multiply and the two dropped-row disclosures be worded differently
    depending on which card the reader is standing on.
  - **Three sources, three chips** (`COST_BASIS_LABEL`): a price a human TYPED, rates COUNTED from
    this workspace, an acted-on rate FITTED from the corpus. Same model-vs-code rule as the
    absent-metrics block, with a third arm — and the fitted one is the one that must never read as
    an invoice, so the counterfactual row is worded "your threads and price with each repository's
    own cohort median acted-on rate …", never "what a peer pays".
  - ⚠ **THE COUNTERFACTUAL ROW IS LABELLED `At the peer median rate`, AND THAT NOUN IS THE CARD'S
    ONLY ONE FOR THIS FACT.** Its predecessor, "At peer engagement", named a quantity nothing on the
    card points at — the row's whole claim is that ONE number was substituted, each repository's own
    cohort's median acted-on rate, and the label now says which. The same words carry the two
    refusals that stand IN PLACE of the row (`COST_REFUSAL_HEADLINE.cohort_rate_unfitted`,
    `ROLLUP_REFUSAL_HEADLINE.no_fitted_cohort_rate`) and `workspaceCostHeadline`'s `ahead` branch,
    because two wordings for one fact on one card is how a reader stops believing either. The label
    is SPA copy on purpose: "the definitions are served" governs the corpus's fitter metrics via
    `metricSpecs`, which is not on this response at all, and every word of this row — label, detail,
    basis chip — is already SPA-authored exactly like `Per merged PR` beside it. ⚠ It is a
    counterfactual PRICE, never a rank: the rollup carries no percentile of its own.
  - **`workspaceCostCoverageNote` states what the figure IS and keeps the ONE surviving caveat** —
    that a subscription may cover repositories outside this Workspace. Its predecessor
    `costSharedNote` shipped gated on `sharedWithUnits > 1`, which counted cards in THIS response,
    so the caveat was invisible on the per-repo tab — the screen most likely to read a
    Workspace-wide subscription as one repository's bill. ⚠ That whole caveat existed to compensate
    for a grain mismatch; **the grain moved instead**, so there is now nothing to disclose and
    nothing a reader can double-count.
  - **`collapsedWorkspaceCostRefusal` is `collapsedCostRefusal`'s rule at estate grain, over THREE
    arms** (`perMergedPr`, `yours`, `unacted`) — a zero price refuses all three for one reason, and
    three identical dimmed rows read as three measurements that each came back empty. ⚠ `unacted` is
    in the arm list even though it has no row of its own: it is the headline's first sentence, and a
    collapse blind to it would fold the rows into one line while the headline vanished for a reason
    nobody was told about. ⚠ It does NOT reach across to the expectation — that section's money
    halves carry the SAME `BotBenchmarkCostRefusal` object, so one sentence already covers both.
  - **`formatThreadCount` never rounds a fractional counterfactual count to a whole `0`** — "0
    acted on" beside a real cost-per-thread figure is a contradiction on one line — and never adds
    a decimal point to the customer's own measured integer.
  - **The gap headline is a FIGURE, not a finding**, so it uses the block's own neutral chrome and
    not the amber anomaly card: it cleared no share gate, no magnitude gate and no median CI. A
    NEGATIVE gap is a good state (this team engages more than the cohort's median) and is worded as
    one — never as "-US$27.60 wasted". ⚠ It is also BOUNDED: the server's `conversionGapUsd` is a
    difference of two rates times the MONTHLY PRICE, so the 'ahead' branch can never render more
    money than the price it is a share of. The ratio it replaced could, and did — a team at 1.0
    against a real fitted median of 0.242857 rendered "US$172.06 more of the US$55.19 reaches
    something".
- Charts: small-multiple SVG strips over the existing zero-dependency toolkit (ONE `useChartWidth`
  for the whole panel, not one per row). ⚠ **NO RADAR CHART** — a rate, a count-per-PR and a
  duration on one polygon claims they share a scale. `stripGeometry()` returns `null` rather than
  drawing a partial grid, and its domain always CONTAINS the customer's value (a clipped dot reads
  as "nothing there"). The dot carries NO verdict colour: `direction` is rendered as words, and the
  only coloured mark is on a row that produced a finding.
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
  **A GRAIN TOGGLE (`Sprint | Month`) sits above every loading branch** — the two grains COEXIST
  and sprint stays the default. It reads `filters.insightsReportGrain`, mirrored to
  `?reportGrain=month` (omitted at the default, per the standing URL rule), and ⚠
  **`setInsightsReportGrain` CLEARS `insightsReportKey`**: `sprint-2026-08-18` names no period on
  the calendar grid and `month-2026-08` names none on the sprint grid, so carrying the key across
  would render the ordinary "not generated yet" box for a document that cannot exist. Titles are
  grain-aware (`periodTitle(start, end, grain)` — a month is NAMED, "August 2026"; the sprint
  formatter would print the EXCLUSIVE end and read "1 Aug – 1 Sep", a 32-day span). At month grain
  the picker leads with **month to date**, marked `· to date`, whose body comes from
  `usePeriodMonthToDate` — a LIVE read with no stored row, so **Generate is ABSENT (not disabled)**
  and no staleness badge is possible. Full contract:
  [PERIOD-REPORTING.md](PERIOD-REPORTING.md) § The CALENDAR-MONTH grain.
- **People / 1:1 prep** (Pro `periodReports`): `PeriodPeopleSection` in Reports lists the
  workspace's humans (roster minus the UNION bot verdict) — ⚠ ALPHABETICAL, no metrics on the
  row, deliberately un-rankable ("prep, not scoring"); each row opens the EXISTING
  `user-activity` tab, whose header now mounts **`PersonPeriodSection`** (the person-period
  vector in the period table's idiom: null renders "—" never 0, `lowSample` flagged, the three
  `basis:'live'` keys labelled "now", coverage annotations; period selector defaults to the
  report being read via `insightsReportKey`; Pro narration phrases via synthesis kind
  `'person'`). ⚠ **`PeriodPeopleSection` must read the SAME `insightsReportGrain` the panel does** —
  it holds its own `usePeriodReportsList` call and that key is grain-scoped, so the default would
  land on a different cache entry, fail to resolve a `month-…` key, and silently seat the newest
  FORTNIGHT under a month heading. It also drops `inProgress` periods from the "Begin report" seed
  (the person route resolves against the grid, which refuses an open period) and clamps an open
  period's roster window to `now`. `UserProfilePopover` gains a second, capability-gated "1:1 prep →" entry beside
  "View activity →" — same tab, named entry point; **still absent (never a nudge) when the
  capability is off**, and that is now a deliberate asymmetry rather than the default: its sibling
  "View activity →" reaches the same tab, which DOES carry the lock, so hiding one of two entry
  points costs the reader nothing.
- ⚠ **`PersonPeriodSection` NO LONGER RENDERS NOTHING.** It was the codebase's stock example of the
  absent-not-upsold posture and is now one of the six VISIBLE-BUT-LOCKED surfaces: on the
  contributor-activity tab it renders `ProLockPanel` (`testId="person-period-locked"`) — the ONLY
  place an unentitled reader can meet the People report at all, since the picker lives inside the
  Reports Pro half and the report tab opens only from that picker. ⚠ Its lock heads **"1:1 prep"**
  and describes ONE person's period vector, which is what the entitled body renders here; an
  earlier draft advertised the multi-pick report, which lives on a different rail entry and would
  not have been there after upgrading. Cite `AskAboutPeriod` or `NarrativePanel` (both
  `activityDigest`, both deliberately silent) as the absence example instead.
- ⚠ The gate on the picker is now INTRINSIC, not positional: `PeriodPeopleSection` carries its own
  `if (!periodReports) return null` above the eight roster/repo/workspace/reviewer queries it
  fires, rather than relying on where it happens to be mounted. `PeopleReportDetail`'s check sits
  deliberately BEFORE its seed check — a tab restored after a live downgrade used to report a
  billing problem as "This period is no longer listed for the current workspace".
- ⚠ A `list.data?.enabled === false` branch is KEPT SEPARATE from the lock in all three components
  and still returns null: that is a PAYING account whose plugin self-disabled, and showing it the
  lock would bill-nudge a customer who already paid.

Deleted outright with this wave: `BotBehaviourPanel`,
`WorkspaceComparisonPanel` + `useWorkspaceComparison` + the `'compare'` rail value (no longer
URL-parsed — a legacy `?activityRepo=compare` link lands on the `'attention'` (Pending) default,
per "Default landing = PENDING"),
`SprintReportCard` + `useSprintReport`, `lib/workspaceColors.ts`, and `InsightsSubTab`.
(`BotThemesPanel` + `useBotThemes` were deleted here too and have since been RESTORED — see
"The Bots Themes panel" below. ⚠ `botsInnerTab` HAS since regained a `'themes'` member: the panel
was first restored as a card at the top of the ROI view and then moved onto its own sub-tab.)

### The Bots Themes panel — `Bots → Themes`

`BotThemesPanel` is the whole body of the `'themes'` sub-tab, mirroring the Feed rail's
`Feed | Themes` strip. The three drill-down `SynthesisCard` mounts (`BotVolumeDetail`,
`BotFlaggingDetail`, `BotThreadsDetail`) are untouched and still serve slice-scoped Summarise, and
`MlTotalsStrip` — the deterministic "What the bots are flagging" severity totals, a different
surface with a confusingly similar heading — stays INSIDE the paid `BotRoiPanel`, on the same
windowed `/api/bot-analytics` response as the columns beside it.

⚠ **THE TAB IS LISTED ONLY WHEN `activityDigest` HOLDS, and that posture is the whole point.** It
is the Feed's, not ROI's. A listed-and-locked Themes body would be a SEVENTH visible-but-locked
surface, and `components/ProGate.tsx` keeps that set at six with a written argument that the next
one needs its own; and on the OSS build the panel returns `null`, so an always-listed tab would
draw a blank pane. The panel's gate is therefore a single `if (!activityDigest) return null` —
`HumanThemesPanel`'s exactly. The free-cloud Pro nudge it inherited from `SynthesisCard` is
DELETED, not disabled: on a conditionally-listed tab it was unreachable, and reviving it would
quietly re-open the seventh-surface argument.

⚠ **NO WINDOW PICKER, AND NO HEIGHT CAP.** The panel reads `botAnalyticsWindow`, whose one writer
is the picker inside `BotRoiPanel` (which argues on the record against being hoisted); a second
window field would let the cached report and the rest of the Bots console disagree about the
population. If the missing control ever proves painful, hoist the picker to the STRIP so every
sub-tab shares one — never duplicate the field. The body's old `max-h-[32rem] overflow-y-auto`
wrapper is gone with the move: it existed so a long report could not push the deterministic
Measure surface off screen, and nothing sits beneath the panel on its own tab.

⚠ **IT WORKS ON THE PER-REPO BOTS CONSOLE TOO**, unlike `'advisor'`. `BotsView` passes `repoScope`
(`[repoId]` on the console, `null` on the rail), the client gives the narrowed report its own
cache slot via `repoKeySlot`, and the plugin's `scope_key` carries the matching `|r:` suffix — so a
repo's Bots tab gets its own real report rather than the workspace's. `showThemes` is therefore
`activityDigest` alone, never `repoId == null && activityDigest`.

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
  predicate (workspace `automated` ∪ the wire `User.isBot`, a manual "human" winning both ways), and
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

## The Reports pane is two tabs, and the Pending board can now merge

### Reports → Overview | Chronology (`insightsTab`)

`InsightsView` is a TWO-TAB pane. **Overview** is the pane as it was — free Flow metrics above the
Pro-badged Period reports. **Chronology** is the COURT LEDGER panel (`BottlenecksPanel.tsx`, contract in
[BOTTLENECKS.md](BOTTLENECKS.md)). ⚠ It renders NO PERSON — not a login, not an avatar, not a
per-head count — and the server sends no actor ids, which makes that structural rather than a
convention this file has to remember.

- ⚠ **The visible tab is DERIVED, never written back** — `effectiveTab` normalises an unknown
  `?insightsTab=` FOR THE RENDER ONLY. Exactly the `feedInnerTab` / `botsInnerTab` rule: a
  corrective `set…()` permanently forgets the reader's choice.
- ⚠ **`'bottlenecks'` IS NOW GATED AND THE DERIVE STILL MUST NOT LEARN ABOUT IT.** The parenthetical
  "the moment a member becomes gated" is no longer hypothetical: Chronology went PRO on
  `periodReports`. `effectiveInsightsTab` keeps exactly one job — normalising a value outside the
  union — and must NOT gain a capability fallback. An unentitled `?insightsTab=bottlenecks` ships in
  bookmarks and in history entries Back replays; it has to land on the tab the URL named and render
  the LOCKED pane there. A fallback would silently redirect the reader to Overview with no
  explanation, and would make the function impure, breaking the round-trip `urlHistory.test.ts`
  pins. **The gate lives in the PANE, never in the tab resolution.**
- The store key lives in `freshDefaults()` only, so **no `FILTER_STORAGE_VERSION` bump is owed**,
  and `'overview'` — the current default — is the OMITTED URL value.
- **The RAIL ENTRY stays ungated on every tier** (the free flow metrics live under Overview
  precisely so it can), and BOTH tabs stay listed and selectable. What is gated is two BODIES, each
  VISIBLE-BUT-LOCKED: `PeriodReportsPanel` (`period-reports-locked`) and the Chronology tab
  (`chronology-locked`, wrapping `BottlenecksPanel`). Both wear a `ProBadge` from
  `components/ProGate.tsx` — `variant="heading"` on the "Period reports" `<h3>`, `variant="tab"`
  inside the Chronology `<button>` so the accessible name composes as "Chronology, Pro feature" —
  and both badges are UNCONDITIONAL: they tell a paying admin which panes a free teammate cannot
  open, and a badge keyed on the capability would flicker while `/api/me` is in flight.
- ⚠ **Route the body through `useProGateState(cap)`, never a naked `!cap`.** `useProCapabilities()`
  reads all-false until `/api/me` resolves, so the obvious branch paints "See what Pro includes" for
  one frame at an account that PAYS. `'pending'` (which now also covers an /api/me ERROR — entitlement
  unknown is not entitlement denied) renders null or the host's own skeleton.
- ⚠ **`BottlenecksPanel` itself holds NO capability read**, which is what keeps its
  "Measuring…" / "Could not load this workspace's flow." branch a two-state question about the
  REQUEST rather than a paywall it has to render. `useFlowFindings` gates its own `enabled`
  (unconditionally — the hook has one mount and the query POLLS, so a disabled query also stops the
  five-minute timer).
- **The panel is two halves, WORKING hours above and CLOCK hours below** (docs/BOTTLENECKS.md), and
  every panel is a `Block`: a title, its "i", the body. The header holds "Chronology", its "i"
  ("How Chronology works") and a 30/60/90 window picker (React state remembered for the session —
  not a URL key and not a persisted filter, so "Clear filters" cannot reset it), then the one-line
  disclosures: the calendar, coverage, what was set aside, truncation. The working-hours half, top
  to bottom: **Who was holding it, in working hours** (`CourtSplit` over `courtsWork`: a stacked
  bar and three large percentages), **Each wait against its budget**, **Every pull request** (the
  scatter + the "20 slowest" table that is its keyboard view), **What the slow ones have in
  common**, **Approved and waiting**, **Who gives the first review**, **Asking for a review**,
  **Pointers** and **Where each pull request sits** (the triangle, labelled context). The clock-hours
  half: **By repository, in clock hours** — the original court ledger, whose call-out rule stays
  calibrated on clock hours; each court prints the server's one-line `summary` above its repository
  rows, and the full `directive` sits in that Block's modal — then **Merged without a human
  review**. Refusals print last, by name. An older server sends none of the working-hour fields
  (`hasWorkingHours`): the page then opens on the CLOCK-hour split and renders the clock half only.
- ⚠ **Every panel's explanation is behind its "i"** (`components/InfoModal.tsx`: focus-trapped,
  Escape captured, 14px; the copy is `Activity/chronologyInfo.tsx`, every number read from
  `FLOW_RULES`). The page keeps only figures, charts and the disclosure lines. The modal body takes
  focus on open, because it is the only part that scrolls and the arrow keys scroll only the focused
  element; opening a modal also closes any pinned chart popover, whose own Escape listener would
  otherwise take the first Escape.
- ⚠ **Budget figures live in `ChartPopover`** (`components/charts/ChartPopover.tsx`: hover or
  keyboard focus opens, click/tap pins, Escape or an outside press closes, one open at a time). A
  bar past the axis carries an arrow, because the popover is the only place its true value appears.
  A row with no verdict shows a "Too few" or "None" chip on the page and the server's reason in its
  popover.
- ⚠ **Court colours are the VALIDATED set** — amber-500/teal-600/indigo-500 light, amber-600/
  teal-600/indigo-500 dark, one `COURT_SWATCH` for every mark. The old `-400` dark shades failed
  the lightness band.
- ⚠ **Every sentence is still the server's.** The panel adds LABELLED FIGURES ("took more than a
  working day"), never a composed claim. The one exception is `FlowPointersPanel`, which is a
  model's text and is styled apart on the `--ai-*` tokens with the sparkle; its hook
  (`useFlowPointers`) ANDs `periodReports` into `enabled`, the GET never generates, and every mount
  of one scope shares the `['flow-pointers-generate', ws, days]` mutation key.
- ⚠ **Working-hour figures never print in days** (`formatWorkHours`): "2d" reads as calendar days.
- **Settings → Workspace → "Working hours and budgets"** (`FlowSettingsSection`, CORE, above the
  pro-settings gate like the Pending mute). The form sends only what differs from a default
  (`flowSettingsForm.ts`), and refuses a "good" above the DEFAULT "acceptable", which the server
  would otherwise silently widen. Budgets are **two range sliders per wait** (Good | Acceptable,
  `BudgetSliders`) on ONE stepped scale, half an hour to 5 working days of THIS workspace's day,
  plus every default and every in-range stored value (`budgetScaleSteps`). A slider resting on its
  default writes nothing; a stored value outside the scale is pinned at the end, shown with its true
  value and never rewritten by Save; Good never passes Acceptable and neither pushes the other. The
  **time zone is a combobox** (`TimeZoneCombobox`, `settings/timeZones.ts`): Intl's zones + UTC +
  modern names for the legacy ones V8 lists (Kyiv, Kolkata …), today's UTC offset beside each, a
  "Default (<zone>)" entry for blank, values limited to the list. ⚠ It portals INTO the Settings
  dialog (inside `aria-modal`), and while open it marks itself `data-owns-escape` so
  `SettingsModal`'s capture-phase Escape steps aside (`lib/escapeOwner.ts`).

### Reports → Overview → Flow metrics → "Where the work is happening"

`WorkspaceFlowMetrics` renders `WorkspaceMetricsPanel` (tiles + the 12-week trend band) and, under
it, `WorkspaceRepoActivityCharts` — which owns a section holding TWO CARDS side by side, both
answering the question the workspace-wide tiles cannot: *which* repository.

| Card | Population | Source |
|---|---|---|
| **Activity by repository** | PRs opened in a rolling 14 days, and their lines changed | `repoActivity` on the ONE `/api/workspace-metrics` response — it can never be a refresh apart from the tiles above |
| **Reach by repository** | every pull request OPEN RIGHT NOW, at Low/Medium/High blast radius | `WorkspaceReachCard` + `useWorkspaceReach`, a CLIENT fold over `useWorkspaceOpenPrs` |

Both are horizontal ROW LISTS drawn by `components/charts/RepoRows.tsx` (a `<table>`, not SVG):
repository name written out in full on the left, a stacked bar per measure, every figure printed.

- ⚠ **THEY MOUNT IN `WorkspaceFlowMetrics`, NEVER INSIDE `WorkspaceMetricsPanel`.** That panel has
  TWO mounts — this one, and `RepoInsightsPanel` for a SINGLE repo behind the Pro
  `workspaceInsights` gate. A per-repository comparison there degenerates to one row, and would
  appear only for paying accounts, on the one screen where it answers nothing.
- ⚠ **TWO COLUMNS, TWO SCALES, TWO ORIGINS — NEVER ONE BLENDED SCORE.** `RepoRows` computes one
  maximum PER COLUMN and divides by it, so a drawn bar length is a ratio *inside* one column and
  never a number the reader compares across the two. That division is NOT the banned normalised
  index: nothing is z-scored, weighted, or summed across measures, and the printed figure beside
  every bar is the fact. A normalised activity index is the shape CLAUDE.md rejects in five places
  — "a number no PR resembles". A GROUPED `BarChart` was never available either: `niceMax` gives
  every series ONE y-axis, so a PR count (≈5) beside a line count (≈5000) draws the count
  sub-pixel (MEASURED at 50 vs 50k on real data).
- ⚠ **THE REPOSITORY NAME IS WRITTEN OUT IN FULL, AND WRAPS.** This replaced a rotated 8px axis
  label budgeted at 13 characters, which `BarChart`'s FIXED 40px `rotateLabels` band then clipped
  silently — MEASURED, six of seven real repositories rendered as "…tric-backend", and the clipped
  glyph was the leading "…" that said so. `axisLabels()`, `MAX_LABEL_CHARS` and the "In order:"
  recovery line are all DELETED with it. ⚠ **A `title=` TOOLTIP IS NOT THE ALTERNATIVE** —
  unavailable on touch and to a keyboard, and the deleted recovery line existed precisely because
  a reader who cannot recover the name from either place is looking at an unlabelled bar.
- ⚠ **THE KEY IS DRAWN DELIBERATELY.** `BarChart` used to render a `Legend` for free on a
  multi-series chart, and that legend is the relief the automation orange's sub-3:1 surface
  contrast obliges (2.80:1 on the light ground; the lines teal is 2.49:1). `RepoRows` renders the
  same shared `Legend` from every column's segments, so dropping it is a colour regression, not a
  tidy-up.
- ⚠ **FOUR FRAMINGS ON ONE PANEL, SO EACH SAYS ITS OWN.** The tiles compare a rolling 14 days
  against the prior 14; the trend band is a fixed 12 weeks; the activity card is 14 days with NO
  comparison; the reach card is a SNAPSHOT with no window at all. The activity card cannot follow
  the team's SPRINT CADENCE: that setting is plugin-owned and this surface is free, so it uses
  `INSIGHT_SPRINT_DAYS`, which is what the tiles beside it already use.
- ⚠ **UNKNOWN IS NEVER ZERO, ON EITHER CARD.** `linesChanged: null` prints the words "size unknown"
  in that repository's OWN row — a zero-length bar and an absent one are the same pixels — and the
  unsized PULL REQUEST count is still stated in words below, because the row marks repositories and
  the sentence counts pull requests. On the reach card a null `blastRadius()` verdict (never
  measured, or truncated-and-not-high) is NOT DRAWN and is NOT a fourth segment, so the bars do not
  total the open-PR count the list is ranked by; that difference is disclosed in words and beside
  the name of any repository it applies to.
  - ⚠ **"SIZE UNKNOWN" IS THE ALL-UNSIZED CASE ONLY, SO A PARTIALLY-SIZED REPOSITORY MARKS ITSELF
    TOO.** The fold nulls `linesChanged` when `sizedPrs === 0` and no sooner, so a repository with
    SOME unsized pull requests draws a full-looking bar over its sized subset, identical to a fully
    sized neighbour — MEASURED on workspace 1: `DEFRA/bng-metric-backend` opened 45 PRs of which 2
    were never sized, beside six neighbours with none. `RepoRows`' `noteFor` prints **"lines cover
    43 of 45 PRs"** under that repository's name. The aggregate sentence stays the COUNT ("2 pull
    requests have no recorded size"); it never says where they are, which is what the row is for.
- ⚠ **THE REACH CARD IS FREE, AND ITS LEVEL COMES FROM THE ONE RESOLVER.** No `ProGate`, no
  capability read, no 402. `useWorkspaceReach` calls `blastRadius()` — the same function the chip
  calls, on the same rows, with the same config — so a bar and a chip can never disagree, and the
  Settings sensitivity dial repaints it with no cache invalidation (`['me']` only). ⚠ It reads
  `useWorkspaceOpenPrs`, NEVER `useSearchOpenPrs`: that one carries the Timeline board's
  `filters.repoIds`, whose picker is not mounted on Reports.
- ⚠ **THE REACH CARD INCLUDES DRAFTS AND THE "OPEN PRS" TILE DOES NOT** (`state === 'open' &&
  !isDraft`), so on a real workspace they read 210 and 204. The draft count is stated in words
  rather than reconciled by dropping the drafts: a draft touching a migration is reach sitting in
  the repository. ⚠ **THAT SENTENCE CARRIES ITS OWN DENOMINATOR AND ITS OWN NOUN** — "6 of the 210
  open pull requests are drafts". It used to read "6 of them", which printed 210 NOWHERE whenever
  the unread sentence above it was absent (it is, on a fully-read corpus), leaving the one
  reconciliation this card exists to make missing half its arithmetic; and when that sentence WAS
  present, "them" read as the unread subset, which drafts is not counted over.
- ⚠ **EVERY PRINTED TOTAL ON THE REACH CARD IS FOLDED OVER THE SHOWN ROWS** (`useWorkspaceReach`).
  `repos` is sliced to 12 while `openPrs`/`unread`/`drafts` used to fold over every repository in
  the workspace, so past the cap the card printed an unread count and a draft count covering
  repositories whose bars are not on screen, beside bars that are — the headline-vs-subset defect,
  one surface over. What the cap cut rides `omitted`, is said in its own sentence, and is never
  subtracted against them. `repoCount` and `workspaceRepos` are deliberately NOT the subset, and
  each says so where it is printed.
- ⚠ **EACH CAP DISCLOSES WHAT IT CUT, ON THE DRAWN MEASURE AS WELL AS THE RANKING ONE.** Both lists
  are ranked by PRs (opened / open now) while the second column draws something else, so the leader
  on that other measure can sit below the fold: the activity card names both ("N more repositories
  saw … pull requests and … lines changed"), and the reach card names the repositories, their open
  pull requests and **how many of those were high reach** ("…, 12 of them high reach, and are not
  shown"; `none` when the cut held none). Repositories added mid-window are MARKED, never pro-rated
  — scaling one up fabricates PRs nobody opened.
- ⚠ **THE REACH CARD ACCOUNTS FOR THE REPOSITORIES HOLDING NOTHING OPEN**, or its repository count
  silently disagrees with its neighbour's. MEASURED on workspace 1: 8 member repositories, 7 saw a
  PR opened in the fortnight, 4 hold anything open right now — "Activity by repository · 7
  repositories" beside "Reach by repository · 4 repositories". So it prints "4 of the 8 repositories
  in this workspace have nothing open right now", the mirror of the neighbour's own sentence, with
  the membership count folded from `useRepos()` narrowed by `Repo.workspaceId`.
- ⚠ **THE NEIGHBOUR IS NAMED, NEVER POSITIONED, AND PROSE COUNTS ARE PRINTED IN FULL.** The grid is
  two columns only at `lg` and above — below it the cards STACK and "the card beside it" is the card
  ABOVE — so the reach card says "Activity by repository covers the last 14 days". And every
  sentence under it is a fraction meant to be checked, so the counts go through `toLocaleString()`,
  never `fmtNum`: "156 of the 1.6k open pull requests" is not an arithmetic a reader can perform.
  `fmtNum` stays INSIDE the table, where a cell shares its formatter with the column maximum printed
  under it.
- **Not clickable.** No row is a button and no cell carries a handler, so a decorative table adds
  no unlabelled keyboard stops. The bar itself is `aria-hidden`; a column that prints only a total
  carries its split in an `sr-only` twin.

### The Pending board's merge row (`PendingMergeActions`)

The two FORWARD kinds (`merge`, `update_branch`) carry Merge · Merge-when-ready · Cancel · Update
branch, and so does a Dependencies card whose PR is a dependency update, and a My Turn `own_ready`
card (your ready PR, promoted in Settings → My Turn — the same row through `asForwardCard`).
Nothing else does — a `my_turn` "review this" card gets no Merge button.

⚠ **A DEPENDENCIES CARD IS MINTED BY WHO OPENED THE PR, NOT BY ITS MERGE STATE**, so
`pendingMergeGate` takes its verb from the verdict alone: `behind` → Update branch, `canMerge` →
Merge, anything else → no button. Its `mergeStateStatus` is NULLABLE (not observed) and reaches
`mergeVerdict` as `'unknown'`. A `security` card on a person's PR (`dependencyUpdate: false`) gets
no row at all — that PR keeps its own cards, which carry its landing. `verdictLine` is false for
both kinds: the card's state row ("Blocked · Required checks or reviews aren’t satisfied") already
says it, and the verdict line printed it a second time. `DependencyActions` routes a `conflicts`
state to `PendingConflictActions`, which reads the CARD's own `viewerCanPush` (a Dependencies card
is not write-gated, unlike the `conflicts` kind), and everything else to `PendingMergeActions`.

⚠ **A QUEUED CARD IS THE ONE EXCEPTION, AND IT SUBTRACTS.** When the card's synced `inMergeQueue`
is `true`, GitHub owns the landing: Merge and Merge-when-ready are HIDDEN (pressing either is
meaningless), `MergeControl` is relabelled "Merge queue" so **Remove-from-queue survives**, and the
verdict line is suppressed — the header's queue chip already said it.

- ⚠ **NOTHING ON THE BOARD FETCHES ON MOUNT.** `MergeWhenReadyControl` fetches merge-options
  EAGERLY (`useMergeOptions(prId, true)`, ~3 GitHub calls per PR); fifty cards mounting it is 150
  GitHub calls to paint a board. The board passes the eager-fetch opt-out and gates its buttons on
  the CARD's own synced `mergeStateStatus` / `mergeable` / `viewerCanPush` through `mergeVerdict()`.
  The live fetch is CLICK-GATED, the way `MergeControl` already does it.
- The arm/cancel logic stays in ONE component. `MergeWhenReadyControl` is documented as the one
  path that arms; the board passes a prop rather than forking it.
- The armed state is FREE to read — `usePrArmedIntent(prId)` selects over the already-polled
  account-wide list. Never add a per-card fetch for it.
- ⚠ `viewerCanPush` is a VISIBILITY gate only. The merge route re-checks permission, the head oid
  and the live merge state before anything irreversible. **HIDE, never disable** — what ChecksTab
  does — so a reader without write access sees a clean card rather than a wall of dead buttons.
- `mergeVerdict().canMerge` is true in exactly three cases (`armed`, `unstable`, `clean`/
  `has_hooks`). ⚠ `behind` is FALSE (GitHub 405s), so a `update_branch` card's control is **Update
  branch**, never Merge.
- ⚠ The buttons must not filter, reorder or drop a card: each tab's order and count are the
  server's, and a local edit would make a tab list fewer cards than its count claims
  (`apps/frontend/test/pendingTabs.test.ts`).
- `CardShell`'s `onActivate` skips `a`/`button`/`textarea`/`input`/`[data-noactivate]`, so the
  controls do not also open the PR.
- **MID-MERGE IS THREE LAYERS, CHECKED MOST-IMMEDIATE FIRST.** (1) a MANUAL merge or branch update
  the reader started, read off the SHARED mutation keys `mergePrMutationKey(prId)` /
  `updateBranchMutationKey(prId)` via `useIsMutating` — ⚠ never a per-mount `isPending`, because
  `MergeControl` owns the mutation inside this row while PrDetail mounts a second `useMergePr` for
  the same PR, and a per-mount flag is invisible to the other mount (the CiAnalysisCard lesson);
  (2) an ARMED intent, whose live phase is `armedPhaseHeadline` (all thirteen `ArmedMergePhase`
  members, `queued` ≠ `queued_local`); (3) the synced verdict, as before. The manual line OUTRANKS
  the armed one: an armed intent describes what will happen later, a live POST describes now.
  ⚠ Both new reads are CACHE reads — GitHub's merge-queue POSITION and ETA stay off the card,
  because those two are still unsynced by design (they change minute to minute) and reachable only
  through the click-gated merge-options call. MEMBERSHIP and ENTRY STATE are a different matter:
  see below.

### The `conflicts` card — the third merge-state kind, and the one with exactly one button

GitHub cannot merge the PR: the head conflicts with its base. Not a summons like `my_turn`, not an
opportunity like the two forward kinds. `KIND_LABEL.conflicts` is **"Merge conflicts"**, the spelling
`REASON_META.merge_conflicts` already uses; do not mint a third.

⚠ **THIS SECTION USED TO SAY THE CARD HAD NOTHING TO PRESS.** That was true until the in-app
resolver landed: the card now carries `ResolveConflictsButton`, and it is the ONLY thing it carries
besides an armed intent's Cancel.

- ⚠ **THE POPULATION IS "REPOS YOU CAN PUSH TO", AND THAT IS THE WHOLE CARD.** The server mints it
  only inside `writableRepoIds`. Measured: 474 open non-draft PRs conflict on a real account and 470
  are in repos the viewer only READS. Without the gate the 15-row cap fills instantly with strangers'
  stale branches and the reader's own conflicting PR is capped out — silently, because this kind
  discloses no cap.
- **STILL no merge affordance, and that is still the point.** `PendingConflictActions` is a SEPARATE
  component from `PendingMergeActions`, never a widened one: `mergeVerdict` returns `canMerge: false`
  on both mint predicates, GitHub 405s a merge on a conflicting branch, and "Update branch" cannot
  resolve a conflict (`pendingMergeGate` already refuses it on an `update_branch` card whose
  `mergeable === 'conflicting'`). `MergeWhenReadyControl` renders ONLY when an intent is already
  armed, and then with **`eager={false}`** — so the reader keeps the Cancel for an intent parked at
  `waiting_conflicts`, at zero requests. It is never mounted un-armed: that would offer to arm a
  watcher whose blocker only a human can clear.
- ⚠ **THE `armed == null` EARLY RETURN IS GONE, AND ITS REMOVAL IS THE WHOLE FIX.** It used to be
  right — with nothing armed there was nothing to press — and it is exactly the shape of defect that
  leaves a feature built, gated and unreachable: the resolver button would have been mounted on a row
  that returns `null` for the overwhelming majority of cards. The row now drops out only when BOTH
  halves are absent, and it asks the SAME `useConflictResolverEntry` the button asks rather than
  growing a second, disagreeing copy of the rule.
- **No `viewerCanPush` on the wire, and it must not become a field.** Write access IS the population
  (`writableRepoIds`), so the flag would be a constant `true` — which is why `ResolveConflictsButton`
  is handed a literal here.
- **`conflictsStateChip` is the one non-obvious display decision**, exported so a test can pin it.
  The header already says "Merge conflicts", so `MERGE_STATE_LABEL.dirty` under it is one sentence
  twice — suppressed. But the kind is minted on TWO predicates, and on the `mergeable === 'conflicting'`
  arm GitHub's own state says something else (`blocked`), which the reader can get nowhere else on the
  row — printed. `null`/`unknown` say nothing. ⚠ Do NOT route it through `mergeVerdict()` instead: its
  queue branch runs first, so a queued conflicting PR would report `queued` and lose the conflict
  statement — and the queue is already stated by `pendingQueueBadge` in the header.
- ⚠ **It is NOT a forward kind** — a conflicting PR IS waiting on someone (its author). Do not let
  the relevance lens (`passesLens`) narrow it: the lens narrows `my_turn` and nothing else, and
  `pendingCardIsPersonal` must keep returning false for it — write access to a repo is not
  ownership of a stranger's PR.
- A conflicts card can share a `prId` with another kind; each sits in its own tab (conflicts in
  Needs fixing), so neither hides the other.
- ⚠ **`INSIGHT_KINDS` in `useUrlState.ts` must carry `'conflicts'`** or `?attn=conflicts` is a
  discarded parse — see the four touch points below.

### The Pending tabs (`AttentionView.tsx`, `pendingTabs.ts`, `db/pending-tabs.ts`)

Pending is six tabs (`PENDING_TABS` in `packages/shared/src/pending-rules.ts`): **My turn** ·
**Needs fixing** (CI failing, merge conflicts) · **Waiting on review** (stalled review, needs a
reviewer; review load as a "Reviews waiting on people" strip above the list, unranked and uncounted)
· **Unanswered threads** · **Ready to land** (ready to merge, behind trunk) · **Dependencies**
(Security, Bumps). Each is a SCORED list — the server's order, highest Do next score first — and the
first `PENDING_DO_NEXT_SIZE` (5) of whatever view is on screen sit under "Do next", the rest under
"Everything else". ⚠ **My turn and Dependencies are STRICT-GROUP tabs**, whatever the scores: My
turn lists its cards by type in the READER's order (`groupByReason`, Settings → My Turn), and
Dependencies puts every security card before every bump (`groupByKind`); each group is scored
within. There are no group headings — each card's type chip names its group, and "Do next" /
"Everything else" stay the only dividers. A PR a dependency bot opened is listed ONLY in
Dependencies (plus My turn for a direct summons); the server contract is [BACKEND.md](BACKEND.md)
§ The Dependencies tab, and My Turn's is § My Turn — the ball rule.

- **The server ranks the UNCAPPED fold, then caps** (`rankPendingTabs`): up to `boardListCap` per
  LIST GROUP — kind × My turn's "Only yours" side × who opened it — so the whole tab, a kind chip and
  each lens are their own true top. The SPA caps EVERY view to `boardListCap` (a chip or "Only
  yours" is now the union of a People list and an Automation list, and beyond the cap that union
  has gaps) and says "Showing the top 50 of 176. The rest score lower." when it cuts — or, on a
  strict-group view (My turn, Dependencies with no chip), "Showing the first 50 of 65.", because
  there the cut is the LAST GROUPS, which can outscore what is shown (`capSentence`).
- **Every view's count is its own population**: tab → `tab.total`, chip → `tab.kindTotals[kind]`,
  lens → `tab.relevanceTotals[lens]`, author lens → `tab.authorTotals` / `kindAuthorTotals[kind]` /
  `relevanceAuthorTotals[lens]`. The daily brief's lines say the same figures and each opens its
  tab with its own chip / lens seated, so the number clicked is the list landed on.
- **The People / Automation lens** (`attentionAuthorLens`: null = everyone, `'people'`,
  `'automation'`; `?attnBy=`, a NAV key). The side is the server's `pendingAuthorSideOf` — automation
  iff the card's PR has `automation` set — so the list and every figure beside it are one
  population, and `people + automation === total` by construction. The pills read "Anyone ·
  People · Automation", right-aligned; "Anyone", never a second "All", because the kind row's "All"
  beside it counts the tab UNDER the lens. They show only where both sides are non-empty, or while
  the lens is on (so it can be turned off) — on the dev DB that is no tab yet, since every
  automation-authored active PR is a dependency PR. Under the lens a tab badge, a chip and "Only
  yours" each count their own lensed side. ⚠ It PERSISTS across tab switches (`setAttentionTab`
  does not clear it; it is a question about the whole board), is cleared by a rail or scope change,
  and is SEATED to `null` by every entry point that opens the board from a count
  (`openMyTurnInWorkspace`, `BriefStrip`'s `openBriefLine`) — `setActivityRepo` early-returns on an
  unchanged rail. Transient, never in `FilterDefaults`.
- **An emptied view says what emptied it** (`pendingEmptyNote`): "Nothing from automation in
  Waiting on review right now." with a "Show all", "Nothing under Bumps right now.", or the tab's
  own sentence. ⚠ The review-load strip counts REVIEWERS, so no PR narrowing hides it: a narrowed
  view with no cards puts the note ABOVE the strip, or the reader got the strip and no word that
  the lens had hidden every card.
- **The tab on screen is DERIVED** (`effectivePendingTab`): a kind (`attentionIsolation`, seated by a
  brief line) names its own tab and wins; else the picked `attentionTab` (`?attnTab=`, a NAV key);
  else My turn. Clicking a tab is ONE write that seats the tab and clears the kind
  (`setAttentionTab`). Old `?attn=<kind>` links land on the right tab with that chip selected.
- **Removed with the cross-kind head**: `doNextIds`, the "already in Do next" chip, the header "My turn"
  pill (the tab replaces it), `AttentionIsolationBanner` (the selected tab and chip say the same
  thing on the board itself) and the spread/superseded explanations. The Pro plan still picks its
  rows across kinds; its headline and `parked` line sit above the tabs and each `why` lands on its
  card in whichever tab — `CardShell` reads it from `PendingBoardContext` for EVERY kind (before,
  only three kinds were passed a `why`, so most narrated rows never showed theirs).
- **Liveness** sweeps merge-state cards first (ready to merge, behind trunk, conflicts, every
  dependency update, which carries its own merge row, and a My Turn `own_ready` / `own_conflicts`
  card, which carries the same rows), then the view on screen, then the rest.
- **The order is the READER's, and the response says which.** `GET /api/attention` carries
  `rules` (`PendingRankRules`: the weights, their preset or `custom`, the My turn type order, the
  types switched off) — what the server ranked THIS response with. Every explanation reads it:
  `scoreBreakdown` multiplies by `rules.weights`, the header ⓘ adds "My turn groups its cards by
  type first, in the order set in Settings." and, off Balanced, "Weights: <preset>.", and the guide
  prints the reader's weights and "Switched off in Settings: …". `DO_NEXT_RULES.weights` is only the
  fallback for a response predating `rules`. ⚠ **There is deliberately no "resolved settings" hook
  for the board**: between a Settings save and the board's refetch the two differ, and an
  explanation must describe the list on screen.
- **"Customise"** (My turn only) opens Settings on its My Turn section
  (`useSettingsModal().openSettings('my-turn')`, `store/settingsModal.ts`). It sits at the right end
  of the controls row, after the People / Automation pills, inside ONE right-aligned wrapper — two
  `ml-auto` siblings would split the free space between them. The row always renders on My turn,
  empty or not, so the way into Settings is there when the tab holds nothing.
- **A promoted card keeps its home card's controls**, through pure adapters in `AttentionCards.tsx`
  (pinned in `pendingCardControls.test.ts`): `own_ready` → `PendingMergeActions` (`asForwardCard`),
  `own_conflicts` → `PendingConflictActions` (`asConflictsCard`), `trunk_red` → the `ci_failing`
  trunk body with the landing PR's byline (`CiFailingBody` via `asCiFailingCard`), and `own_thread`
  a `BotVendorPill` when a bot opened the thread. Nothing new fetches on mount. The chip is
  `myTurnReasonLabel` (fifteen short labels, `MY_TURN_REASON_LABEL`; a ready card says "Ready to
  merge" or "Behind trunk"). ⚠ **The `my_turn` case is an EXHAUSTIVE inner `switch (card.reason)`
  ending in `never`**: the outer `default: return null` would hide a new type while the tab still
  counted it — how `my_turn` once shipped invisible. The trunk card is REPO-grained (`prId` may be
  null), so nothing may treat a `my_turn` card as a PR before checking `reason !== 'trunk_red'`.

**Every PR card names who opened it** (`PrByline`, drawn from the pure `authorByline` +
`bylineParts`, pinned in `pendingCardControls.test.ts`). It reads `automation`, the SAME field the
lens filters on, so a card can never sit under "People" wearing a bot chip:

| `automation` | Byline |
|---|---|
| null | avatar + name ("Deleted account" when `authorId` is null) |
| `source: 'account'`, a branded kind | avatar + the vendor chip ("Dependabot"); the chip IS the name |
| `source: 'account'`, unbranded (`in_house`/`vendor`/`pierre`/null) | avatar + the role chip (`AUTHOR_ROLE_CHIP`: "Dependency bot", "Coding agent", "CI bot"…) + the login |

⚠ An automation account's avatar is drawn only when it has a PICTURE. Every GitHub-typed Bot row in
the real DB has a NULL `avatar_url`, and the shared `Avatar`'s fallback is two 10px initials ("DE"
beside "Dependabot") — below the 11px floor and saying nothing the chip does not. A person keeps
the initials.
| `source: 'marker'` | the tool's chip, "via", then the person's avatar and name |

`PrMetaRow` draws the byline first when it has both the board's `usersById` and a card carrying
`automation`, and then skips the trailing `BotVendorPill` (the bot is not said twice). The Search
card passes no map and keeps the old positive-claim-only chip. A branded chip takes its ink through
`vendorInk`. On a `ci_failing` trunk card the landing-PR line carries the byline of the landing PR
(`landingPrByline`).

**A Dependencies card** (`renderCard`'s `case 'security': case 'dependency_bump':`): the header
label (`cardKindLabel`: "Security fix", "Likely security fix" for Dependabot's INFERRED fix — never
"Security fix" above a card that cannot back it, and it carries no fix sentence either, the why lives
in the info popover — "Security alert", "Dependency update"), the meta row with its byline, the
review row, the state chip (`DEP_STATE_LABEL`; none for `conflicts` or `needs_review`, whose sentence
already says it, `ci_red`, or `unknown`) with the state sentence (`depStateSentence`; none for
`ci_red`, which the meta row's CI dot already says), then, on a `security` card, `SecurityDetail`:

- the fix sentence and each alert row ("Socket flagged GHSA-… and 2 more"), behind a `ShieldIcon`.
  ⚠ **EACH ADVISORY ID IS WRITTEN ONCE**: an id a sentence names is linked INSIDE that sentence
  (`advisoryParts`), and the chip row under it lists only the ids no sentence names — the first 3,
  then "+N more" counted off that remaining list (`advisoryChips`). Links go through
  `safeExternalUrl(advisoryUrl(id))`; `AIKIDO-` and Semgrep `ssc-` ids have no public page and
  render as plain chips.
- a thread alert's `where` ("in a review thread") is its own button that opens the thread — the
  ids in the lead are links, and a link may not sit inside a button (`securityAlertLine` returns the
  two halves). A `reviewer` alert is named by its author's brand, else the login.
- "+N more alerts" off `alertCount`, never `alerts.length`.
- inferred-only cards are amber, everything else red; chips are 11px mono.

Then `DependencyActions` (see the merge row above). Nothing on the card fetches on mount.

**The info popovers** (`PendingInfo.tsx`, `pendingExplain.ts`): the header ⓘ is a four-sentence
summary; each card's ⓘ says why it is here (and what clears it), its colour rule, its place ("4th of
176 in Waiting on review · Do next" — position i of the list IS rank i of the view's population) and
its score as three weighted parts that add up to the total. Both lead to the **"How Pending works"**
modal (tabs, inside a tab, the score, colours, when it is your turn).

- ⚠ **EVERY NUMBER IN THE COPY IS READ FROM `pending-rules.ts`** — the table `db/queries.ts`
  (admission floors, caps, colour thresholds, My Turn section colours) and `db/work-plan.ts` (bases
  incl. the board-only `conflicts` base, adjustments, stall buckets, the weight presets) fold with.
  Retune THERE. The one exception is the weights themselves, which are the reader's and come from
  the response's `rules`.
- **The per-card working rides `GET /api/attention` as `scores`**, off the same pass that ordered the
  tabs. Nothing on the client may sort or filter by it.
- ⚠ **NOTHING FETCHES, AND IT IS A CLICK, NEVER A HOVER.** The popover is a `FloatingPortal` carrying
  `data-noactivate`: React bubbles portal clicks through the COMPONENT tree to the card's own
  `onClick`, which would otherwise open the PR.
- `KIND_LABEL`, `cardKindLabel`, `MY_TURN_REASON_LABEL` and `myTurnReasonLabel` live in
  `pendingLabels.ts` (importing them from `AttentionCards` would be a cycle); `AttentionCards`
  re-exports them.

### "opened 3d" — the PR's own age on a Pending card

`openedAgeLabel(iso)` (exported from `AttentionCards.tsx`) turns `InsightPrRef.openedAt` into
"opened 3d". It is passed to `CardShell` as `openedAt` and **appended** to whatever `right` already
holds; the "·" separator, the absolute `dateTime` tooltip and the null degradation live in the shell,
once, so a kind that opts in cannot forget or double them.

⚠ **AND `right` IS DROPPED WHEN IT SAYS THE SAME THING — `clockSaysMore(clockAt, openedAt)`.** A kind
whose `right` IS a clock passes the instant it measures as `clockAt`; when that rounds to the same
label as `openedAt`, the shell renders the NAMED age alone and drops the bare relative time. Nothing
is lost — it was the same number — and the survivor says which clock it is.

This is the one thing about this feature that no test could see, and it was found by opening the
board: **ten of ten cards** on the reporting account's own workspace read "8 hours ago · opened 8h".
Measured across the whole live database, **779 of 1,411 open non-draft PRs (55%) have no commit after
the one they opened with** — a dependency bump is the common shape — so a forward card's
`lastCommitAt` and its `openedAt` are the same instant; `my_turn` collapses identically whenever
nobody has touched a PR since it appeared, because the ball arrived when it opened.

- Two kinds pass `clockAt`: `my_turn` (`since`) and the shared `merge`/`update_branch` case
  (`lastCommitAt`). `reviewer_routing` does NOT — its `right` is the string "unassigned", not a clock,
  so it always renders and the age is simply appended. `conflicts` has no `right` at all.
- ⚠ **TWO TESTS, AND-ed, because the two sides go through DIFFERENT FORMATTERS.** `right` renders
  through `relativeTime` (hours→days at **24h**); the age renders through `ageLabel` (hours→days at
  **48h**). The first cut compared two `ageLabel` strings and left a live 12-hour window — a head
  commit 36–47h old on a PR opened 48–59h ago — printing "2 days ago · opened 2d", the exact
  duplication it exists to remove. So the clock survives only when **the printed FIGURES differ**
  (unit and number, each side through its own formatter) **and the LABELS differ**. The second half
  is not redundant: 30.4h beside 30h prints "1 day ago · opened 30h", two different figures that
  invite the reader to subtract a six-hour gap that is not there.
- ⚠ Never compare the instants directly, and never compare one formatter's output against itself —
  it is what the row PRINTS that the reader compares.
- ⚠ An **unreadable `openedAt` keeps the clock** (`clockSaysMore` returns true): suppressing both
  would leave the row with no time on it at all.

- **It is a SIBLING of `ageLabel`, never a replacement.** `ageLabel` takes a SERVER-computed
  `ageHours`; `openedAgeLabel` rounds here-side with the identical spelling
  (`Math.round(ms / 3_600_000)`) so one PR can never read "waiting 47h" on one card and "opened 2d"
  on another. ⚠ `ageLabel` does NOT round its argument — it interpolates it, so an unrounded float
  lands on the card as "opened 3.7166666666666663h".
- **Null, never "0h".** An unreadable or absent value renders no age at all; a future timestamp
  (clock skew) clamps to "opened 0h".
- **Four kinds carry it: `my_turn`, `reviewer_routing`, `merge`, `update_branch`** — plus `conflicts`,
  which carries it as its ONLY clock (it has no `lastCommitAt` by design, and the shell's
  `right != null` guard drops the separator so the row reads a bare "opened 3d").
- ⚠ **FOUR OMISSIONS, EACH A DECISION.** `stalled_review` is the one where adding it would be
  actively WRONG — its server `ageHours` is computed from `pull_requests.opened_at`, so "waiting 3d ·
  opened 3d" is one number twice under two names. `untouched_thread`'s clock is the THREAD's
  `created_at`, and the thread is that card's subject. `ci_failing` does not extend `InsightPrRef` and
  carries no `openedAt`: on the `trunk` arm the subject is a REPOSITORY and the PR it names is the
  MERGED landing PR of the red head. `reviewer_load`'s subject is a PERSON — `pendingPrs[]` is a list,
  so there is no single PR to date.
- ⚠ **It goes in `CardShell`'s right slot, NEVER in `PrMetaRow`.** `PrMetaRow` is exported and mounted
  by a second surface (`Search/SearchResultsTab.tsx`) off a hand-adapted `PrMetaFields`; putting the
  age there paints "opened 3d" on every cross-repo search result.
- The `·` carries `decorative-mark` + `aria-hidden`. That is the ONLY sanctioned opt-out from
  `test/textContrast.test.ts`, and a "·" between two metadata items is the case it exists for.

### What the card carries about the merge queue and the review

Both were added because the board **may not fetch on mount** — a fact the reader needs on fifty
rows has to arrive with the rows.

- **`inMergeQueue` + `mergeQueueEntryState` are SYNCED columns** (`InsightPrRef`, and `PrDetail`
  for the pane). Position and estimated-time-to-merge are NOT, and stay on the lazy
  `…/merge-options` fetch. ⚠ **THREE STATES**: `true` / `false` are positive statements from
  GitHub; `null` is NOT OBSERVED and renders NOTHING — never "not queued". They exist because
  GitHub's `MergeStateStatus` enum has no QUEUED member, so a queued PR reports `blocked` and every
  merge surface without these two offers a button GitHub will refuse.
- ⚠ **`unmergeable` is the member that earns the state column**: GitHub is EJECTING the entry, the
  thing a reader could previously only discover by pressing Merge and reading the failure.
  `pendingQueueBadge()` (exported from `Activity/AttentionCards.tsx`) is the ONE place those five
  sentences live — the PR pane's Overview row IMPORTS it. Two copies is how one screen calls an
  ejection "in the merge queue".
- **The card carries REVIEW STANDING**: `reviewDecision` (GitHub's verdict) beside our own
  `reviewApprovals` / `reviewChangesRequested` / `reviewers` / `reviewerCount`, folded by
  `computeReviewStandingsByPr`. ⚠ `reviewDecision: null` means THIS REPO REQUIRES NO REVIEW (~90%
  of open non-draft PRs) and may never render as "nobody looked" — that question is
  `reviewerCount`. ⚠ `reviewChangesRequested` COEXISTS with `reviewApprovals > 0`: lead with the
  block, do not delete the approvals to say so. ⚠ Render "+N" as `reviewerCount - reviewers.length`
  and gate any cap disclosure on `reviewers.length === reviewerCount` — never subtract your way to
  a total you were not given.
- **BOT REVIEWERS COLLAPSE INTO ONE CHIP.** Measured: 39% of reviewer standings on open PRs are
  bot-authored and 477 of 478 of those are merely `commented`, so an unranked list buries the one
  human approval under four bot rows. `InsightReviewer.isBot` comes from the SAME union the
  Timeline's hide-bots lens uses — never a second classifier — and `isBot: true` with
  `botKind: null` is real and common (an unbranded CI account) → a generic "Bot".
- **The PR pane reads the SAME fold** (`PrDetail.reviewStandings` / `reviewerCount`), uncapped and
  in the fold's own order. Before this, `ChecksTab` folded `pr.reviews` client-side with "latest
  non-pending review wins", which demoted an approver who later left a bare comment: 59 disagreeing
  reviewer-PR pairs on live open PRs. ⚠ **A reviewer whose approval GitHub later DISMISSED still
  reads `approved`** on both surfaces — a deliberate, measured divergence kept so the hashed
  `approvals` count cannot move; the argument is at the fold in `db/triage.ts`, and neither
  surface re-decides it.
- ⚠ `REVIEW_STATE_META` (`lib/ui.ts`) is the ONE table for a reviewer's mark, ink, chip and word,
  shared by the card's chips and the pane's Reviews row. `icon` is a COMPONENT reference
  (`lib/ui.ts` is `.ts` and holds no JSX) — render `<m.icon size={12} />`.

### The Pending board's LIVENESS sweep (`useAttentionLiveness`)

`GET /api/attention` is DB-only, which is the whole reason fifty cards paint in one request. Its
cost is staleness against GITHUB: a PR merged, closed or unblocked BY SOMEBODY ELSE keeps its card
until the adaptive walk (2-15 min). `AttentionView` mounts ONE batched sweep for the whole board —
2 GraphQL points, ~5-7s — and the route contract is in [API.md](API.md) + [REALTIME-SYNC.md](REALTIME-SYNC.md).

- ⚠ **IT IS NOT AN EXCEPTION TO THE NO-FETCH-ON-MOUNT RULE, IT IS THE ALTERNATIVE TO BREAKING IT.**
  Per-card liveness is ~200 upstream calls to paint a screen. One board-level batch is one request.
- ⚠ **ON `changed > 0` IT REFETCHES; IT NEVER SPLICES A CARD OUT.** The response carries counts,
  never cards — deliberately, so a local removal is not even expressible. `capFor` gates the
  "50 of 148" disclosure on `shown === count` with `shown` off these cards and `count` off
  `useDailyBrief`, so `['attention-cards']`, `['daily-brief']` and `['work-plan']` are invalidated
  TOGETHER and the server re-ranks.
- ⚠ **THE QUERY KEY DOES NOT CARRY THE IDS** (`['attention-liveness', 'ws:<id>']`; the ids ride the
  closure). Keying on them would refetch the sweep every time the board refetched — and a sweep can
  CAUSE a board refetch, which is a loop with a GitHub call in it.
- **The ids are RANKED, then sliced to `ATTENTION_LIVENESS_MAX_IDS` (90, mirroring the server's
  enforcing cap, which 400s over-cap rather than truncating).** Forward kinds, conflicts and
  dependency updates first — those rows offer a button, where a stale merge state is a button that
  405s — then the ranked head,
  then the rest. Built off `all`, not `cards`: a lensed-away card is still a card the next
  unfiltered render shows. ⚠ `prId` is NULLABLE on some kinds (a `ci_failing` 'trunk' card names a
  PR only when the red head's landing PR resolved), and those rows are simply not sent.
- **Cadence: mount + window focus + 60s while visible.** Focus is what covers "I merged three PRs
  on GitHub and came back"; `staleTime: 30_000` bounds a burst of tab-flipping to one sweep.
- **A failed or `paused` sweep renders NOTHING** — `retry: false`, no error surface. The board keeps
  its synced rows, which is what it had before this existed; rate limits are pre-empted, never red.

### The three keys that opt OUT of `refetchOnWindowFocus: false`

`main.tsx` turns focus-refetching off globally, which is right for a persisted PR-detail cache and
a heavy vis board. It also left the ONE surface whose claim is "here is what is still outstanding"
frozen at whatever it fetched before you switched to GitHub and retired half of it. `useAttentionCards`,
`useDailyBrief` and `useWorkPlan` each set `refetchOnWindowFocus: true`.

- ⚠ **ALL THREE OR NONE.** They are one fold (`getWorkspaceInsights`) read three times: the board,
  the strip whose count is the board's cap denominator, and the plan beneath it. A focus policy on
  one of them is two snapshots of one population — the "the strip says 5, the board lists 3" defect.
  They already share one `refetchInterval` and sit together in `ACTIVITY_QUERY_KEYS` for this reason.
- The shared `staleTime: 60_000` bounds it: rapid tab flipping refetches at most once a minute,
  well inside `/api/attention`'s 60/min `search` tier.

### The per-repo landing queue on screen

A waiting intent reads **"Waiting its turn — N of M on this repo"**, from the trailing-optional
`queuePosition`/`queueDepth`. `armedPhaseHeadline` is THE ONE spelling, shared by the
`AutoMergeBanner` stack and the board's merge row — two surfaces describing one intent must not
phrase it two ways.

- ⚠ **`queued_local` suppresses the `lastReason` line.** For every other phase the reason carries
  the specifics (which branch, which error) beneath the headline; for this one the watcher writes
  "waiting its turn — 3rd of 3 armed on acme/mine", which is the same fact the headline already
  derived, in a second spelling. Both lines are correct and the pair reads as two statuses. The
  prose stays ON THE WIRE — it is the fallback for a client that does not know the phase — and is
  simply not drawn beneath its own restatement.

## The merge-conflict resolver (`components/conflicts/`, CORE/free, BOTH MODES)

The three-pane overlay behind **Resolve conflicts**. What it is, what the wand does and how it
lands: [docs/MERGE-CI-TRUNK.md](MERGE-CI-TRUNK.md) § Resolving conflicts in the app. The SPA
landmines:

- **`ResolveConflictsButton` is the ONE entry, and three surfaces mount it** (the PR pane's
  Conflicts row, `MergeControl`'s expanded conflict box, the Pending `conflicts` card). None
  re-implements the gate; a caller that needs to know whether it will render anything asks the same
  `useConflictResolverEntry`. ⚠ **It fetches nothing** — the gate is four synced facts plus the
  App-root `['me']` cache, so fifty cards on a board issue zero requests, and `?? false` while
  `['me']` loads (an undefined capability must not render a button that 404s on the first click).
  ⚠ **HIDE, never disable.**
- **The overlay mounts in `App.tsx`, not inside `PrDetail`** — it opens from three places and must
  not unmount when the pane behind it closes. It is OPAQUE (`z-[60]`, above the one toast column's
  `z-50`), not a scrim: a translucent backdrop over a live timeline is unreadable at 12px.
- ⚠ **THERE IS NO URL KEY, NO HISTORY ENTRY AND NO `PrDetailTab` MEMBER, DELIBERATELY.** A
  `?prTab=conflicts` would make Back a way to lose work — a `popstate` cannot be cancelled and the
  only guard available is `useUrlState.ts`'s documented permanent-no-op trap — and it would make the
  resolver deep-linkable, so every address-bar visit would spend a clone. `popstate` CLOSES and
  pushes nothing; `ClosedResolverToast` is the way back, and it is filed `null` after a commit
  (the pins have moved, so the offer would be a lie).
- ⚠ **THE FIVE WAYS OUT ARE NOT ONE RULE.** Close closes outright; `Escape` raises the confirm bar
  once there is work to lose; `popstate` closes because it cannot be cancelled; a click on the
  overlay's own chrome is ignored; a reload is caught by `beforeunload`, the one gesture the store
  cannot survive.
- ⚠ **ONE SCROLLER, ONE GRID, FIVE TRACKS.** `minmax(0,1fr) 1.75rem minmax(0,1fr) 1.75rem
  minmax(0,1fr)`, every region emitting its five cells straight into it via `display: contents`. A
  row's height is its tallest cell and the browser stretches the rest, so the panes line up with no
  spacer, no measurement and **no scroll-sync driver** — three scrollers kept in step by handlers is
  the design this replaces, and it drifts on every wrapped line. `min-h-0` on the scroller is
  load-bearing: without it the flex child refuses to shrink and the grid overflows the viewport.
  Below `NARROW_PX` (1100, measured live) the columns stack.
  ⚠ **There is now ONE read-only exception, and it is read-only in both directions.**
  `RegionRibbons.tsx` measures `[data-mr-cell]` boxes and joins an accepted hunk to its result with
  a bezier across the gutter — but it holds no React state, never writes `scrollTop`, never calls
  `focus()`, and adds no scroller. It caches rects in CONTENT coordinates on a structural change
  only, so a scroll frame reads `scrollTop`/`clientHeight` and does arithmetic; it re-measures
  SYNCHRONOUSLY in a layout effect when a decision changes row heights (an rAF there paints one
  frame of ribbons on the rows they used to join), and through the rAF from its `ResizeObserver`
  (a draw inside an RO callback can loop). It is suppressed entirely below `NARROW_PX`. Anything
  that gives it a scroll-sync job, or routes a scroll frame through React, brings back everything
  this invariant exists to prevent. Full contract: docs/MERGE-CI-TRUNK.md § The ribbons.
- ⚠ **KEYBOARD SCOPE: only `Escape` is on `window`.** Everything else is `onKeyDown` on the panes'
  `tabIndex={-1}` container, so `←`/`→`/`b`/`x`/`u` cannot fight a text caret in the branch-name
  field or the file list's own `↑↓`. That is the `HelpModal` precedent — one key globally, never a
  scheme.
- ⚠ **THE TOOLBAR'S "Commit and push" IS GATED, AND `Enter` ON THE PANES CARRIES THE SAME LOCK.**
  Both read `commitBlockedReason(plan, headMoved)` — null exactly when `plan.canCommit &&
  !headMoved`, otherwise the ONE sentence the button wears (tooltip + `aria-describedby`) and the
  landing step prints above its own button. It was "Continue", never disabled, because pressing it
  was the only way to the list explaining the block; that list is now a popover off the
  toolbar's "N of M changes decided" counter (`OutstandingPopover`, the same per-file jump rows).
  ⚠ **"Next" walks OUTSTANDING files** (`nextOutstandingFile`, wraps) and is ABSENT once there is
  nowhere to jump — the chevrons page the manifest and say so ("Next file in the list"), `n`/`p`
  walk regions. Full contract: docs/MERGE-CI-TRUNK.md § Resolving conflicts in the app.
- ⚠ **ROVING TAB STOPS.** Only the ACTIVE region's buttons are in the tab order; every other
  `SlotStrip`'s — **and every other row's two gutter arrows**, which read the same `active` prop —
  are `tabIndex={-1}`. Four hundred regions is four hundred strips, and without this Tab walks two
  thousand buttons before it reaches the toolbar. `role="group"` + `aria-label` live
  on the STRIP, not the row: the row wrapper is `display: contents`, which removes it from the
  accessibility tree entirely, so the grouping and the "Conflict 2 of 5 in src/…" position have
  nowhere else to go.
- ⚠ **"TAKE THIS SIDE" IS THE GUTTER ARROW AND NOTHING ELSE.** `ours`/`theirs` used to sit on the
  strip AND again as a hover-revealed, `aria-hidden` arrow in each gutter: one verb, two controls,
  every region announcing as a pair of identical buttons. The strip gave the verb up; the arrow is
  now ALWAYS drawn, really named (`gutterLabel` in `copy.ts` — it carries the region's position,
  because the arrows sit in their own grid cells OUTSIDE the strip's `role="group"`), really
  focusable. It renders only where `sideOffered(region, side)` — the SAME predicate the wash reads —
  so an unofferable pane gets neither paint nor arrow, AND only while that side is not already in
  the result (`sideOutcome(slot, side) !== 'contributed'`): an arrow is an offer to ADD, and on an
  added side it offers a no-op. Undo or Ignore brings it back, derived from the slot with no
  re-reveal state.
  ⚠ **Below `NARROW_PX` the gutter CELLS are not emitted at all**, so `SlotStrip`'s `sideTakes`
  puts the two side verbs back on the strip: one control per verb in each layout, never two in
  either. Nothing in the resolver is reachable only by hovering.
  ⚠ Three rules follow from it being a REAL control rather than a decorative twin, each of which was
  a live defect the moment the strip's copies went: **it carries NO `aria-pressed`, because presence
  IS the state.** It briefly did, reading `sideOutcome(slot, side) === 'contributed'` — which is now
  exactly the condition under which the button does not render, so it could only ever have announced
  "not pressed", on every arrow, forever. A dead ARIA attribute reads as a considered claim, so it is
  gone; the strip's word still says the state in words. **The keyboard reveal aims at `data-mr-take`**, left
  then right, falling back to the strip — `el.querySelector('button')` inside `[data-mr-region]` is
  the STRIP, whose first button is now "Ignore this change and keep the ancestor" on every one-sided
  change, so `n` parked focus one reflex Space from discarding it. ⚠ **That fallback is now
  UNREACHABLE from the keyboard, and only by luck of one filter**: an arrow also goes away once its
  side is in the result, so a decided region can have none — but `step()` (the `n`/`p` walk) visits
  only regions that are `kind !== 'unchanged'` AND undecided, which always have at least one. Widen
  `step()` to walk decided regions and the Ignore-focus bug comes back. And **the panes' `Enter` binding
  exempts any real control** (`closest('button, a[href], [role="button"]')`): a button fires its
  click on Enter DOWN, so `preventDefault()` on the way up cancelled the press and sent the reader to
  the commit step with no side taken, while Space worked.
  ⚠ A painted pane with NO ROWS still gets one line of height (`CodeCell`) — the wash sits on the
  content box, so a side whose answer is "delete these lines" would paint nothing at all, and with
  C1's rule that silence now claims "nothing here to take" beside a live arrow.
- **The store (`store/conflictResolver.ts`) holds CHOICES ONLY** — no file text, no regions, no
  suggestion lines, and no EDIT lines either — and it is deliberately NOT a slice of `store/filters.ts`, which is persisted
  and URL-mirrored. ⚠ **The pins are part of the key** (`${prId}:${headSha}:${baseSha}:${modelHash}`):
  a pushed branch or a moved base mints a different key and the old decisions are simply not found,
  never migrated onto a merge the reader did not see. Same reasoning as the auto-merge intent's
  `expectedHeadOid`.
- ⚠ **AN ACCEPTED "Ask Claude" SUGGESTION'S LINES MUST OUTLIVE THE PANES' MOUNT.** `ResolverPanes`
  unmounts the moment the reader presses the toolbar's "Commit and push" (the entry to the landing
  step, not the press), so component state alone loses them on `Back` —
  `slotFor` would then render an ACCEPTED suggestion as undecided while the commit still carried its
  `suggestionId`: the counter says decided, the pane says "Needs a decision", and the push lands
  Claude's text. They live in a module map keyed by SERVER SESSION, pruned to the live one on every
  mount. The STORE keeps the opaque handle and deliberately not the text.
- ⚠ **THE CENTRE PANE IS EDITABLE, AND THE EDITOR IS A PANEL UNDER THE CELL — never a
  `contenteditable`, never a textarea replacing `CodeCell`.** `RegionEditPanel` mounts in the slot
  `HunkSuggestionPanel` uses, for three reasons that each cost something if ignored: `data-mr-cell`
  stays on a CONTENT-SIZED box (the ribbon overlay measures that rectangle, so an editor inside it
  points every ribbon in the file at a textarea-sized rect); `CodeCell` stays a pure memo with no
  local state; and hljs output never goes under a caret (`hljsLines.ts` allows only hljs output to
  reach `dangerouslySetInnerHTML`). ⚠ **The draft lives in the PANEL**, seeded ONCE per opening from
  the region's current folded centre — a `useEffect` mirroring the seed would overwrite what the
  reader had typed — the STORE holds the `editId`, and `useRegionEdit`'s module map holds the lines,
  keyed by SERVER session, for exactly the reason the Ask hook's map exists. ⚠ **`onKeyDown`'s field
  guard is now load-bearing**: the textarea is inside the scroller, so without the early return `b`
  would take both sides of the region being edited and Enter would leave for the commit step.
  `resolverControls.test.ts` pins the guard AND its position. ⚠ **An edited region's centre is
  green, both sides paint NOTHING and it draws NO ribbon** — the text came from neither pane — and
  the strip word `Your text` is what says so. Editing is CORE and free; `unchanged` context is
  read-only and the server refuses it.
- ⚠ **"Ask Claude" is ABSENT, not locked, when unentitled.** The six visible-but-locked surfaces are
  an ENUMERATED exception in `components/ProGate.tsx` and a seventh needs its own written argument
  there. This is one paid control inside a screen already doing its whole job for a free reader; a
  lock would advertise into a working feature.
- ⚠ **AN UNSUPPORTED FILE IS LISTED AND DISABLED, NEVER HIDDEN** (`FileMenu`) — it is exactly why
  the PR stays conflicted after a commit, and hiding it leaves nothing on screen to explain that.
  No "partly decided" ring either: a part-decided file says `1 of 3 decided` in words, which is also
  the only form carrying its denominator.
- **The wand's sentence names its own population.** It runs per FILE and counts CONTESTED regions,
  while the header counts every DECIDABLE region across the whole pull request — so a bare "Nothing
  left to decide." sat beside a countdown at a different grain and the two flatly contradicted each
  other on screen. It says "…in this file".
- ⚠ **EVERY PER-FILE NUMBER FOLDS THROUGH `fileRowState`.** The file-menu TRIGGER quoted contested
  regions (`· 1 conflict`) beside a menu row reading `6 to decide` and a Commit button held shut by
  all six — three numbers about one file, and the only one visible without opening the menu was the
  one that understated the work. It also never counted down, because `tally.conflicts` is the file's
  total rather than its remainder.
- **`ClosedResolverToast` is a plain card in the ONE bottom-right toast column**, never its own
  `fixed bottom-4 right-4` element.
- The `--mr-*` state washes and the shared `--code-hl-*` syntax colours, with their hand-run guards:
  see **The AI-surface palette** above.

### Two defects that only running it found — and both will come back

⚠ **A SWALLOWED PER-FILE FETCH FAILURE PLUS AN EFFECT KEYED ON "NO REGIONS YET" IS AN UNBOUNDED
RETRY LOOP.** `loadFile` caught its error and returned; the selection effect's condition was "this
file has no regions", which the swallow left true, so it re-fired the instant `loadingFiles` cleared.
**MEASURED at 655 requests against one 429'd endpoint**, with nothing on screen but "Reading …". A
failed read is now REMEMBERED in `useConflictSession`'s `fileErrors`, and **only an explicit retry
clears an entry** (`retryFile`). The general rule: an effect that keys on the ABSENCE of data must
have a third state for "we asked and it failed", or the absence is a spin.

⚠ **THE SERVER RE-ATTACHES AN EXISTING SESSION ON OPEN, SO A NAIVE UNMOUNT CLEANUP DELETES THE
SESSION THE NEW MOUNT IS HOLDING.** `POST …/conflicts` without `restart` returns the LIVE session
(`claimSession`), so a remount does not get a new one — and the OLD mount's cleanup then `DELETE`d
it out from under the new one, which sat on "Reading …" forever. React 18 StrictMode remounts every
effect in dev, so this fired on the FIRST open of every resolver; in production it is a fast
close-and-reopen. The close is now **refcounted per PR and DEFERRED** in
`apps/frontend/src/hooks/useConflictSession.ts`: the last detach schedules it, an attach inside
`CLOSE_GRACE_MS` (400ms) cancels it. The grace only has to outlive a synchronous remount, and the
server's 30-minute TTL is still the backstop.

## The Settings modal is TWO HALVES, split by GRAIN, and the split IS the layout

`components/settings/SettingsModal.tsx`. Every GLOBAL section first, then ONE `Workspace · <name>`
heading and every workspace-scoped section beneath it. Before this the two grains were interleaved
— an account key, cloud account sections, a per-workspace cadence, an account-wide bot toggle, two
more per-workspace sections — and the only thing announcing a section's grain was each
workspace-scoped one appending `— acme-web` to its own title, which said nothing about the ones
that carried no suffix.

| # | Section | Grain | Gate |
|---|---|---|---|
| 1 | `GithubAppInstallSection` | global | `isCloud` (+ self-gates on the App provider) |
| 2 | `BenchmarkConsentSection` | global | `isCloud` |
| 3 | `LargePrThresholdSection` | global | none — both modes, every tier |
| 4 | `BlastRadiusSection` | global | none — both modes, every tier |
| 5 | `MyTurnSection` (Settings → My Turn) | global (per ACCOUNT) | none — CORE/free, both modes, every tier |
| 6 | `YourDataSection` | global | `isCloud` |
| — | **`Workspace · <name>`** | — | none — the scope resolving is the only gate |
| 7 | `PendingMuteSection` | workspace | none — CORE/free, both modes, every tier |
| 8 | `FlowSettingsSection` (working hours and budgets) | workspace | none — CORE/free, both modes, every tier |
| 9 | `SprintSection` (cadence + comparison window) | workspace | `caps.workspaceInsights` + `proReady` |
| 10 | `SlackSection` (schedule + the bot block) | workspace | `caps.slackDigest` + `proReady` |
| 11 | `IssueLinksSection` | workspace | `caps.issueLinks` + `proReady` |

- ⚠ **THE HEADING IS THE NAMING RULE NOW, AND IT IS STILL LOAD-BEARING.** There is no workspace
  picker in Settings — the rail's selection is the scope — so a screen that does not say which team
  it is retuning is a set of controls with a hidden blast radius. What changed is that the name is
  stated ONCE, as a BOUNDARY rather than a suffix, which also marks which settings are *not* a
  team's. Sections below it name a workspace only in a sentence that names a DIFFERENT one
  (`SlackSection`'s cap disclosure). A workspace-scoped control mounted anywhere but under that
  heading names its workspace itself.
- ⚠ **A CONTROL AT THE ACCOUNT GRAIN GOES ABOVE THE HEADING, WITH ITS OWN SAVE.** One Save spanning
  two grains is how an edit meant for one team travels to every team. The comparison-window mode was
  the last such control and it is gone from the account grain (plugin 0032) — so `SprintSection` has
  one Save because it has one grain, not because mixing became safe.
- ⚠ **THE GLOBAL HALF SITS ABOVE THE `pro_settings` LOADING GATE AND MUST STAY THERE.** Every
  section in it reads `/api/me` or `/api/auth/providers`, never `pro_settings` (which 404s with no
  plugin), so an OSS install still gets its large-PR threshold and a cloud account still gets
  export/delete when the Pro fetch fails outright. That fetch is now PURELY a gate — no section
  reads account `ProSettings` any more — and `useProSettings` is enabled only when the Workspace
  half has something in it.
- ⚠ **`workspaceId === null` HOLDS BACK THE WHOLE HALF, IN ONE PLACE.** Three sections each
  rendering their own `ScopePendingSection` under a heading that cannot yet name anybody reads as
  three broken sections rather than one unfinished request. Each section KEEPS its own guard — that
  one sits at the point of the WRITE, where a PUT with no `?workspace=` would be answered by the
  account's Default.
- ⚠ **THE WORKSPACE HALF'S GATE IS SPLIT, AND THE SPLIT WAS A CORRECTNESS FIX RATHER THAN A LAYOUT
  CHANGE.** It used to be ONE `useHasProWorkspaceSettings()` gate (three PAID caps) with a
  `proReady` wait inside it, so a FREE per-workspace control could not be mounted here at all: with
  no plugin the heading never rendered — which is the public `npx pierre-review` release — and with
  a plugin present it would still have waited on `/api/pro/settings`, a request it does not read.
  That is the same defect the global half is built to avoid, one grain over. Now the HEADING renders
  on the scope alone (the free `PendingMuteSection` is what makes it never empty, exactly as
  `LargePrThresholdSection` is for the global half), and `proReady` wraps ONLY the paid sections,
  with the "Workspace settings unavailable." line speaking for them alone. **A free workspace-scoped
  section must never be placed below `proReady`.**
- ⚠ **TWO GATE FUNCTIONS, DELIBERATELY.** `useHasProSettings` stays wide (it gates the avatar-menu
  entry and `BotRoiPanel`'s legacy-cost fetch); `useHasProWorkspaceSettings` is the PRO SECTION
  INVENTORY — the list where every cap must still own a section — and gates the `/api/pro/settings`
  FETCH plus the paid sections. It no longer gates the heading, and must not again. Narrowing the
  first would take the Settings entry away from accounts that still have the global half.

### `MyTurnSection` — Settings → My Turn (CORE, free)

What counts as your turn, the order My turn lists the types in, and the Do next weights every
Pending tab ranks by. ACCOUNT-grained (one account is one reader, every workspace), carried RAW by
`/api/me` (`myTurnSettings`), so it sits in the global half above the `pro_settings` gate like its
two neighbours. One Save for the section. The server contract is [BACKEND.md](BACKEND.md) § My Turn
— Settings: gates and promotions; the route is `PUT /api/me/my-turn-settings`.

- **Four parts**: "Show in My Turn" (a checkbox per summons type, each with a one-line hint;
  "Finished Claude reviews" only where `claudeReview` is on), "Add to My Turn" (the four own-work
  promotions, plus "Red default branch" as Off · Repos you maintain · Every repo in the workspace),
  "Order of My turn" (an ordered list with up / down buttons) and "How Pending ranks cards" (preset
  pills, three range sliders, Reset). Type names come from the shared `MY_TURN_SETTING_LABEL`, the
  one spelling Settings, the CLI and the guide use. The copy says "Show in My Turn", never "mute":
  the Pending mute is a different control that KEEPS a card.
- **Pure form logic in `myTurnSettingsForm.ts`**, pinned by `test/myTurnSettingsForm.test.ts` (the
  `flowSettingsForm.ts` pattern). The body is built with the shared `compactMyTurnSettings`, so a
  Save of untouched defaults sends `null` and nothing is frozen into the account; "unsaved changes"
  compares two compactions. The form re-seeds only when the STORED value changes (keyed on its
  compaction), never on a refetch that would throw away a half-made edit. Errors are the shared
  validator's sentence, shown before the request is sent.
- ⚠ **The weights are whole tens that add up to 100**, because every Do next part is a multiple of
  0.05 and the info popover's working must add up to the score. Moving one slider re-shares the rest
  between the other two in proportion (`rebalanceWeights`), and ALWAYS from the weights the slide
  STARTED from (`slideWeight`) — re-sharing already-rounded weights drifted 50/30/20 → 80 → back to
  50/40/10 and flipped the preset to Custom. A slide continues only while the same slider moves and
  the weights are still what it last produced; a preset, Reset, another slider or a re-seed starts a
  new one. The preset is DERIVED from the weights (`presetOf`), never stored; a "Custom" pill appears
  only when the sliders match no preset, and cannot be clicked. Reset restores the order and the weights and leaves the switches alone.
- **Reordering is buttons, not drag** — keyboard- and touch-native, no dependency. A hidden type
  (Claude reviews without the capability) keeps its place and a move steps over it. After a move,
  focus returns to the same button of the moved row (or its other button at an end), and a
  visually hidden `aria-live` line says where it went ("“@mentions of you” moved to 1 of 15"),
  counting only the rows on screen.
- **Opening straight to it**: `store/settingsModal.ts` (zustand, not persisted, not in the URL)
  holds the modal's open state and a `focus`, so Pending's "Customise" can open it from deep in the
  Activity console. With `focus: 'my-turn'` the modal scrolls the section's heading into view and
  focuses it, one frame after mount. ⚠ `closeSettings` is a store action, so it is referentially
  stable and SettingsModal's capture-phase Escape handler registers once — never pass an inline
  arrow.
- **One save moves five reads, together** (`useSetMyTurnSettings`): `['me']` (seeded at once from
  what the server stored), `['my-turn']`, and the three board keys `['attention-cards']`,
  `['daily-brief']`, `['work-plan']`. The notification watcher then RE-BASELINES on the new
  `configKey` rather than announcing the backlog of a type just switched on (§ Per-workspace "My
  Turn" below).

### `PendingMuteSection` — the Pending mute (CORE, free)

One workspace switch plus a checkbox list of that workspace's repositories, one Save.
`PUT /api/workspaces/:id/pending-mute`; current state is read off the `Workspace` row
(`pendingMuted` + `mutedRepoIds`), so there is no GET and the existing `['workspaces']` query is
the source.

- ⚠ **IT MUTES NOTHING ON SCREEN, AND THE COPY LEADS WITH THAT.** A muted repo's items STAY on the
  Pending board and in the broad `myTurn` count; what stops is the ownership claim — the server
  downgrades those rows to `relevance: 'none'`, so `cardKindLabel` prints the neutral
  "Review or reply", the browser notification stops firing and every `myTurnPersonal` figure drops
  them into the "review or reply" line. A reader who thinks this HIDES work will not use it, and
  hiding work would be the different, worse feature the board's broad-population rule forbids.
- ⚠ **THE TWO CONTROLS ARE A UNION, NOT A PARENT AND A CHILD.** A repo is muted when the workspace
  switch OR its own checkbox says so. The checkboxes therefore stay ENABLED and keep their values
  while the workspace switch is on (a note says they are already covered) — disabling or clearing
  them would be the inheritance chain this model refuses, and un-muting the workspace must reveal
  the per-repo choices unchanged.
- ⚠ **ONE SAVE, DIRTY HALVES ONLY** (`buildPendingMutePatch`, pinned by
  `apps/frontend/test/pendingMutePatch.test.ts` — the `buildSprintPatch` pattern). A key that rides
  along unchanged is an assertion the user never made and overwrites the other grain's stored value.
  `mutedRepoIds: []` is a REAL answer ("nothing in this workspace is muted"), never `undefined`.
- ⚠ **THE ROSTER COMES FROM `Repo.workspaceId`**, the client's only repo→workspace mapping — never
  from the timeline's repo picker, which is a Timeline-only board control not mounted here.
- The mutation reuses `useWorkspaceMutations`' shared invalidation set: `['my-turn']` (the
  account-wide inbox the notification watcher reads) plus `['attention-cards']` / `['daily-brief']`
  / `['work-plan']`, the three reads of the one fold whose whole contract is that they agree.
- On the board, a muted `my_turn` card carries a `muted` chip beside its label
  (`AttentionCards.tsx`). ⚠ **DISPLAY ONLY — no counter, lens or ranker reads it**; they all read
  `relevance`, which has already absorbed the mute. It exists so a card the reader last saw as
  theirs does not silently demote itself with no explanation.
- **Deleted, and neither returns:** `AnthropicKeySection` (the stored BYO key is retired — local
  Claude Review is an ambient Claude session, else `ANTHROPIC_API_KEY`; the routes and the three
  `useClaudeReview` key hooks went with it) and `BotSection` (an explainer pointing at
  Activity → Bots → Settings plus one toggle, which became a per-delivery field inside
  `SlackSection`). ⚠ `data-testid="bot-settings-section"` died with the latter — `pnpm shots`' 7d
  targets `bot-settings-panel` on the Bots rail instead.

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
| FeedView's "PR events" / "Needs review" indigo pills, and the PR-event `Kind` sub-chips under the first | feed category-pill palette |
| `ChecksTab` / `AttentionCards` "Assign" buttons | suggested reviewers are deterministic CORE (CODEOWNERS + inference) — no model, so not an AI marker |
| `MetricsDetail` / `PinnedTabsBar`'s `violet` tone (Flow metrics) | core deterministic drill-down; a generic active accent |
| `index.css` `.tl-repo-tint-1`, the cross-person chips | timeline layout encoding |
| `AiFix/CommentFixReport`'s `DISAGREE_COLOR` (`#8957e5`) | its own comment pins "deliberately NOT red — red would read as the fix failed"; vermilion is red-adjacent and would recreate exactly that bug |

The documented split is **controls join the family, data keeps the chart palette**: the Inflation
column's under-call COUNTS stay violet while the chip the click opens is vermilion, and the
`ai_review` LANE stays violet in lane charts.

**⚠ THE RESOLVER'S `--mr-*` TOKENS LIVE IN THE SAME FILE AND ARE NOT PART OF THIS FAMILY.**
`--mr-change` · `--mr-conflict` · `--mr-applied` · `--mr-ignored` — **two conflict TYPES and two
decision STATES**, not decorations (one side changed these lines · both sides changed them
differently · a decision puts a change into the result · a decision keeps the ancestor).
⚠ **Which pane wears which is not one answer.** A SIDE pane is painted **only while it is offering
the reader something** — the test is `region.allowed` (through the one `sideOffered` predicate, which
the gutter arrow reads too, though the arrow additionally goes away once that side's lines are in the
result: an arrow is an offer to ADD, and paint is a statement about what a pane holds, so the two
part company on a taken side), so `ours_only` paints the left, `theirs_only` the right, **`both_same`
the LEFT ONLY** (nothing on the right to bring in, so main's identical copy is ordinary unpainted
text) and a `conflict` both. It wears the conflict TYPE while UNDECIDED and turns **`applied` green**
once its lines reach the result; a side the decision turned down, and both sides of an ignored
region, paint **NOTHING**. The CENTRE is unchanged: it wears the STATE and carries **NO wash at all
while the region is undecided**, leaving the 2px rule and the strip's word as its two surviving
encodings. `lib/mergeResolver.ts`'s `panePaint` is the ONE decider (`sideOutcome` beside it has
THREE values — undecided / contributed / rejected — because a boolean made "nobody answered" and
"this side is in the result" the same fact); `slotRole` is the STATE role and is deliberately not the
pane's paint. The ribbon overlay's SVG fill is **one class, `.mr-fill-applied`** — it joins an
accepted (green) side to the green result, so a type-hued band between them read as a third thing —
⚠ and it must be a CLASS, because `var()` works as a CSS property and paints NOTHING inside an SVG
presentation attribute. Same space-separated-channel rule, same silent failure if it is broken.
The seven syntax colours that used to live here as `--mr-hl-*` inside `.mr-code` are now
`--code-hl-*` inside `.code-hl` and are **shared by every code surface in the app** — see
**Where code is rendered** below.
- ⚠ **`.mr-edge-*` IS DELETED AND MUST NOT COME BACK.** A turned-down side used to keep a 1px inset
  outline in its own hue rather than lose its paint ("this was the other option" and "this pane has
  nothing here" are different facts). On screen it ringed an untaken block in red beside the green
  one that won. `codeTokens.test.ts` asserts no such SELECTOR exists — it matches a rule, not a
  mention, so the reasoning can stay written down in `index.css` beside the deletion.
- ⚠ **`--mr-conflict` IS NOT `--ai-signal`.** Vermilion is the AI surface's accent and the Pro badge
  draws in it; a merge conflict is not an AI marker, and borrowing that hue would make every
  contested hunk look like something a model produced.
- ⚠ **`test/textContrast.test.ts` CANNOT SEE ANY OF THEM.** That scanner resolves Tailwind utilities
  with a numeric shade (`text-gray-400`); a custom property matches nothing it looks for. The guard
  is **`apps/frontend/test/codeTokens.test.ts`** (it was `resolverTokens.test.ts` until the syntax
  colours stopped being the resolver's), which parses the declarations back out of
  `index.css`, composites each wash at ITS OWN declared alpha over the page ground and asserts AA in
  both directions in both themes. Both suites are HAND-RUN
  (`./apps/backend/node_modules/.bin/vitest run --root apps/frontend`). The measured ratios are
  tabulated in `index.css`'s own header; if you change a channel, re-run that test rather than
  eyeballing it.
- ⚠ **A `.hljs-*` CLASS THAT REACHES NO `--code-hl-*` TOKEN IS OUTSIDE THAT LOOP ENTIRELY.** The
  contrast test walks the seven declared tokens, so five classes github-dark colours and `.code-hl`
  did not — `hljs-subst` (every `${…}` in a template literal), `hljs-code`, `hljs-formula`,
  `hljs-emphasis`, `hljs-strong` — fell through to #c9d1d9 / #8b949e and measured 1.32:1 to 3.08:1
  on the light-mode grounds, while the suite stayed green. `codeTokens.test.ts` now PARSES the
  installed `github-dark.css` and fails on any coloured class the palette does not match, so a
  highlight.js bump cannot reopen it silently.

### Where code is rendered, and which surfaces highlight it

Every surface that shows source goes through **`lib/hljsLines.ts`** — one highlighter, three gates,
and the `.code-hl` palette above — with exactly one deliberate exception, `Markdown.tsx`.

| Surface | Component | Path comes from |
|---|---|---|
| Changes tab + AI Fix diff | `diff/FileDiffView.tsx` | `file.path` |
| Thread code anchor (collapsed line and expanded hunk) | `ThreadView/CodeAnchor.tsx` → `DiffHunk.tsx` | `thread.path` |
| Timeline marker popover's anchor line | `Timeline/MarkerPopover.tsx` | `thread.path` |
| Claude Review finding hunk + its suggestion | `ClaudeReviewTab.tsx` | `finding.path` |
| Addressed-check evidence patch | `components/CommentAnnotations.tsx` | `evidence.path` |
| Bot Advisor's generated config file | `Activity/BotAdvisorPanel.tsx` | `f.path` |
| Conflict resolver's three panes, compare-base popover, Ask-Claude suggestion | `conflicts/CodeCell.tsx`, `BasePopover.tsx` | the session's file |

- ⚠ **A DIFF IS NOT SOURCE, SO IT GOES THROUGH `highlightDiffRows` (`lib/diff.ts`), NEVER
  `highlightLines`.** Consecutive `-`/`+` rows are two versions of ONE line; one lexer pass over
  them leaves the lexer in a state no version of the file was ever in, and a pair that opens a
  string or a block comment on one side only mis-colours everything after it. The fold reconstructs
  the OLD side (context + del) and the NEW side (context + add), highlights each, and zips each row
  back to its own side. A context row takes the new side. An EMPTY side (a newly-added file has no
  old one) is not a refusal; one side refusing refuses both, because half a coloured file reads as a
  rendering bug.
- ⚠ **THE +/-/space MARKER NEVER REACHES THE LEXER AND IS NEVER COLOURED AS CODE.** It is diff
  notation — a `-` is not a minus operator. `splitDiffMarker` is the one strip rule, and it strips a
  CONTEXT row only when it really has a leading space: `parsePatch` classifies any unmarked line as
  context (a truncated hunk, a body that is not a diff), and a blind `slice(1)` there eats the
  line's first character. `@@` headers and the `\ No newline at end of file` row are not code at all
  and are skipped whole.
- ⚠ **WHERE A SURFACE SET BOTH A BACKGROUND AND AN ADD/DEL TEXT COLOUR, THE TEXT COLOUR IS DROPPED
  ON HIGHLIGHTED ROWS ONLY.** The tint already carries add/del on its own (`FileDiffView` has always
  relied on it); green ink under green tokens is two claims fighting for the same characters.
  `DiffHunk`, `CodeAnchor`, `ClaudeReviewTab`'s `hunkLineClass` and `CommentAnnotations`'
  `diffLineClass` each keep their `@@` and context styling, which is not an add/del claim.
- ⚠ **A ONE-LINE-FROM-A-HUNK SURFACE HIGHLIGHTS THE WHOLE HUNK AND TAKES THE LAST ENTRY**
  (`useHunkHighlight`, exported from `DiffHunk.tsx`). Highlighting that line alone is the mid-file
  lexer start `hljsLines.ts` forbids: a line inside a block comment comes back coloured as code.
- ⚠ **`Markdown.tsx` IS THE ONE EXCEPTION AND STAYS ONE.** It highlights fenced blocks through
  `rehype-highlight` with `detect: true` — auto-detection, which `hljsLines.ts` refuses. Both are
  right: there a language is resolved from a FILE PATH and a wrong guess is a claim about the code,
  here there is no path and most bot comments fence code with no language tag. `.md-body pre` also
  keeps its own fixed `#0d1117` ground, which is the only ground the global `github-dark.css` is
  correct against — markdown blocks do NOT use `.code-hl`. Do not route one through the other, and
  do not change the plugin order (raw → sanitize → highlight).
- **`MAX_HIGHLIGHT_LINES` stays at 400** even though it now also gates a whole Changes-tab FILE and
  not just one resolver cell: a file past 400 patch lines already starts collapsed
  (`LARGE_PATCH_LINES` = 250) and is scrolled rather than read. A real case where colour visibly
  drops out gets a per-call limit, not a raise for every surface at once.
- ⚠ **ONLY highlight.js OUTPUT MAY REACH `dangerouslySetInnerHTML`.** `highlightLines` /
  `highlightDiffRows` / `highlightBlock` escape through hljs's own emitter and return `null` on
  every gate they cannot clear; the null branch is React's ordinary text rendering. Nothing else
  goes through that door, on any surface.
- **Not code, and deliberately left plain:** the AI-Fix agent's `recentActivity` log, `CheckList`'s
  CI logs, `ClaudeReviewTab`'s "exact context sent to Claude" block and `BotAdvisorPanel`'s brief
  markdown. None of them has a file path, so none of them has a language.

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

## The Feed's "PR events" pill has a dependent chip row

Pressing **PR events** opens a second row under it — `Kind`, then `Opened` / `Reviewed` /
`Merged` / `Closed` — narrowing the bucket the pill isolates. With the pill off the row is not
rendered. (`FeedView.tsx`, `FEED_PR_EVENT_CHIPS` + `feedPrEventChip` in `lib/ui.ts`, store field
`feedPrEventKinds`.)

- **THE FOUR CHIPS ARE A PARTITION of the pill's six event kinds** — `opened` covers `pr_opened`
  + `pr_ready_for_review` + `pr_reopened`, the other three are one kind each. That equality is
  what everything else rests on, so `test/feedPrEventChips.test.ts` pins it against the shared
  `EVENT_TYPES` enum: a SEVENTH literal added later would fall through to `null` and silently
  make the parent pill narrower than it was, with no error and no visible symptom.
  ⚠ `pr_ready_for_review` (23) and `pr_reopened` (6) get no chip of their own — together 1.7% of
  the human bucket over 14 days, so either would read 0 most days, advertising a filter that can
  only return nothing. All three answer "this PR is (again) asking for review", the reading
  `matchesNeedsReview` already takes. **The CARD RENDERER still labels them apart** ("PR
  reopened"): the chip groups, it does not relabel.
- **EMPTY MEANS ALL FOUR**, and that is the default — a fresh feed is byte-identical to the
  behaviour before the row existed. It also makes an all-off selection unreachable by clicking:
  turning the last pressed chip off lands back on empty. And it keeps the default stable if a
  fifth chip is ever added.
- ⚠ **THE SELECTION IS REMEMBERED WHEN THE PARENT GOES OFF, never cleared.** The row stops
  rendering and `catMatch` reads a hoisted empty array instead of the field. A corrective `set()`
  here is the derived-sub-tab defect one surface over — it permanently forgets a choice the
  reader made (`BotPrsDetail`'s `activePills` is the same shape).
- **CLIENT-SIDE, like its parent, and that is a constraint rather than an accident.** It narrows
  through `catMatch` inside `applyFeedPills` — no `types` query param, no re-keyed request.
  A server-side narrowing would break three things at once: `computeFeedCounts` runs over the
  already-narrowed stream, so every other pill's badge would read 0 while the pill stayed
  rendered; the CI lens' `'only'` state and `feedClaudeOnly` are CLIENT filters over rows the
  server would no longer send (defeating the deliberate category-pill skip that exists to stop
  those combinations yielding a provably empty feed); and the feed is an infinite query keyed on
  `feedSearch`, so every chip click would discard pages the reader had already paged in.
- **The badges are the server's `counts.byEventType` facet** — the whole loadable stream, keyed by
  chip, independent of which chips are pressed, with the loaded-page fallback every other badge
  here carries for a stale IndexedDB response. The subtotals sum to the parent's `prEvents` badge,
  which stays the WHOLE bucket: the pill is the way back out of a narrowing, so its count must not
  shrink as chips are pressed. A 0-count chip stays pressable, like every sibling pill in these
  rows.
- **The empty-state ladder names the pressed chips** ("No Opened or Merged PR events in this
  window."), in the row's display order rather than click order. That is the third channel making
  the row legible beside the pressed state and the count line — never ship an include-only toggle
  whose only feedback is a count. ⚠ It is withheld under all FOUR narrowings `applyFeedPills`
  runs BEFORE `catMatch`: the CI lens' `'only'` (which skips `catMatch` outright), `feedClaudeOnly`
  (whose rows are in no category, so the parent pill alone already empties the list),
  `feedMyTurnOnly`, and the BOT LENS' `'only'`. Naming chips under any of them blames the wrong
  control — and the chip badges beside the sentence would contradict it outright, since
  `byEventType` is computed server-side over the whole stream and is blind to every client-side
  pill ("Only mine" + "Merged" said "No merged PR events in this window" under a Merged chip
  badging 533). ⚠ **The bot lens is TWO mechanisms and only `hide` is safe**: `hide` sets
  `excludeBots`, so the facet is computed over the same excluded stream and agrees by
  construction, but `'only'` sends `excludeBots: false` and narrows on the CLIENT, so the facet
  still counts the human rows the list is hiding — 36 merged events on workspace 3 of which 0 are
  a bot's. Gate on the lens value, never on "the bot lens is server-side". With the chips
  withheld, "Only mine" claims the empty state itself ("Nothing needs
  your attention right now.") ahead of the bot-lens branches, whose default `hide` would otherwise
  claim "only bot activity here" about a stream the server already stripped bots from.
- The three group labels in this block (`Vendor`, `State`, `PR`) were 10px uppercase-with-tracking
  and are now **11px, muted pairing** (`text-gray-500 dark:text-gray-400`), matching the new
  `Kind` label rather than leaving one row correct and its neighbours not.

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
  (`MyTurnCard.personal` — every type that names you: reviews requested of you, @-mentions,
  replies to you, pushes since your review, your PRs, any type you added in Settings, and — only if
  you switched "New PRs" on — new PRs in repos you MAINTAIN). Adding a repo you have never touched
  used to put every open PR in it on the banner — 425 of 459 items on the reporter's account; "New
  PRs" is now off by default as well. The
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
  `setAttentionIsolation('my_turn')`, then `setAttentionRelevance('mine')`, then
  `setAttentionAuthorLens(null)` (the figure clicked counts every author). The workspace write is
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
- **The board's order, counts and narrowings are the tabs** — see § The Pending tabs. The
  cross-kind "Do next" head, its `head ∪ tail` partition, the head's suppression under an isolation
  and `AttentionIsolationBanner` are gone with it: a daily-brief line or `openMyTurnInWorkspace`
  now lands on its tab with its chip / lens visibly selected on the board itself, reversible there
  ("All", or pressing "Only yours" again / "Show everyone's" on an emptied lens). ⚠ ONE
  `<AttentionCards>` MOUNT still — the people strip, Do next and Everything else are sections of one
  `<ul>`, because two mounts race on the single `activityFlashItemId` token.
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
  as new on every poll, and a row that later becomes personal (its repo is un-muted) would fire as
  if it had just appeared.
  ⚠ **It RE-BASELINES, WITHOUT FIRING, when `configKey` changes** — which it does exactly when WHICH
  types are shown changes (Settings → My Turn), never for a new order or new weights. Otherwise
  switching on "Unanswered threads on your PRs" would announce every existing one at once. Each
  section has its own id prefix and sentence bit (`mention:`, `treply:`, `creply:`, `push:`, `ci:`,
  `conflict:`, `land:`, `othread:`, `trunk:`, beside the older one-letter `r:`/`t:`/`p:`/`a:`/`w:`);
  every prefix is a word, so `startsWith('p:')` never matches `push:`. `w:` now counts untouched New
  PRs only.

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
- ⚠ **`relevance` IS ALSO THE CARRIER OF THE PENDING MUTE.** Muting a workspace or a repo
  (Settings → Workspace → Pending mute) forces every one of its my-turn rows to `'none'` inside
  `getMyTurn`, so all of the above follows with no client change: the card relabels to the neutral
  string, the row moves from the "need your attention" line to the "need review or reply" line, the
  banner split and the dropdown badges drop it, and `useMyTurnNotifications` stops firing for it.
  Nothing on the client tests for a mute. The one visible addition is a `muted` chip on the card —
  **DISPLAY ONLY**, off `MyTurnCard.muted`, so a card the reader last saw as theirs does not demote
  itself with no explanation. ⚠ **No counter, lens, cap disclosure or ranker may read that field**;
  a second classifier beside `relevance` is exactly the drift the single server-side fold exists to
  prevent.

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
