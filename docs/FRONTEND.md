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
     `workspaceId` CHANGED ⇒ re-derive for the new workspace; **otherwise PRUNE ONLY** (drop ids no
     longer in the workspace, leave a user-narrowed subset — and `null` — alone). Track the
     previous id in a ref: a write-only-if-different guard is necessary but not sufficient, because
     `repos`/`workspaces` are React Query results whose identity changes on every background
     refetch.
3. **Tab state** → `store/pinnedTabs.ts` (`usePinnedTabs`): `ActiveTab = 'timeline' | 'activity'
   | <Tab.key>`; a `Tab{key,kind:'pr-detail'|'pr-focus'}` list. `openPrDetailTab` /
   `openPrFocusTab` / `closeTab`. Exactly one board mounts at a time (App keys the board slot;
   see "focus tabs"). (The old My-Turn tab kind + `openMyTurnTab` + the `m` key were removed —
   situational awareness is the Feed + its "My Turn only" toggle.)
4. **URL** → `useUrlState.ts` mirrors the store to the query string both ways (shareable /
   reloadable); the serializer diffs against **defaults**, so the common case stays clean.
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
    inside `FirstRunOnboarding` (zero-repo first run).
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
- **`AutoMergeBanner`** — a bottom-right toast stack (same shape as `ClaudeReviewBanner`) fed by
  DIFFING `GET /api/auto-merge`: the watcher runs server-side, so an `armed →` terminal
  transition is the only signal the client gets. Transitions only, never current state.
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
  `store/filters.ts` (`{fromActivity:true}` arms Back-to-Activity), a full-`<main>` overlay
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
  drive the timeline. **Back button:** opening a tab from the Activity console pushes ONE deduped
  `{pierreTab}` history entry (the app's ONLY `pushState`); App's single `popstate` handler
  (`consumeActivityReturn`) returns to the Activity console, and the feed scrolls + flashes the
  exact item that was clicked (`activityReturnItemId`). **Landmine:** an isolate-tab
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
  finding.
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

`PeriodPeopleSection` is now a PICKER: a text field that opens `UserSelectPanel`'s extracted
`MemberSectionList` inline (same Maintainers / per-repo / Other grouping) plus a flat
alphabetical BOTS section from `useDetectedReviewers` (the union truth — comment-only reviewers
included), multi-select straight to removable chips, then "Begin report".

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
underneath.

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
