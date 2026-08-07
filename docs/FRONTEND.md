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
  - **⚠ Activity, the Feed, Bots and Compare ALWAYS cover every repo in the selected Workspace —
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
  Besides the PR tabs there's a family of **singleton, EPHEMERAL drill-down tabs** (never
  URL/localStorage-persisted; a reload drops them): `metrics-detail`, `bot-prs`, `open-prs`
  (sortable all-open-PRs: age/author/LoC/untouched-threads/CI/approval columns), `bot-only-prs`
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
  `filters.repoConsoleTabs` (and Insights its sub-tab in `insightsSubTab`) — surviving rail
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
  comments / merge-close, each with a "Show on timeline" action. A timeline **commit**
  ("View in Activity") or **review** ("Open in detail pane") popover deep-links here via the
  `activityFocus` signal (matched by `{type, refId}`) → opens this tab, scrolls to + flashes
  the entry. The "Show" links share `ShowOnTimeline`.
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




---

## ML severity badges + the Bots severity rollup

Bot comments carry a severity/category badge, threads a worst-severity rollup, the Threads tab a
severity filter, and the Bots ROI tab a "What the bots are flagging" block. All of it reads ONE
per-PR query (`['ml-labels', prId]`, `staleTime: Infinity`) — the badge never fetches, and a
target with no label renders nothing. Gated on `MeResponse.mlSeverity` (a TOP-LEVEL field, not a
`pro` capability). `threadSeverityFilter` is a global store field and carries the same
`selectedPrId === prId` guard as `threadStateFilter`. Detail: [ML-SEVERITY.md](ML-SEVERITY.md).
