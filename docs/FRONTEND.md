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
   `timelineCenterAt`), and the transient Feed toggles (`feedAuthors`, the category pills). (The old overlay-focus signals
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
3. **Tab state** → `store/pinnedTabs.ts` (`usePinnedTabs`): `ActiveTab = 'activity' | 'sprint' |
   'timeline' | <Tab.key>` (the three FIXED views, `FIXED_VIEWS`, tested only through `isFixedView`); a `Tab{key,kind:'pr-detail'|'pr-focus'}` list. `openPrDetailTab` /
   `openPrFocusTab` / `closeTab`. Exactly one board mounts at a time (App keys the board slot;
   see "focus tabs"). (The old My-Turn tab kind + `openMyTurnTab` + the `m` key were removed —
   situational awareness is the Feed + its "My Turn only" toggle.)
4. **URL** → `useUrlState.ts` mirrors the store to the query string both ways (shareable /
   reloadable); the serializer diffs against **defaults**, so the common case stays clean.
   - **THE URL IS THE APP'S ONLY HISTORY AUTHORITY, and every view has one.** `view=` names the
     two boards AND the four self-describing tab kinds, spelled as the `Tab.key` VERBATIM
     (`pr-detail:123`, `pr-focus:123`, `user-activity:45`, `bot-detail:45` — one vocabulary, not a
     URL dialect); the narrowings a reader navigates TO are keys of their own (`attn=<InsightKind>`
     for the attention board, `feedPr=<id>` for the Feed, `botsTab` for the Bots sub-tab strip (a
     legacy `feedTab` is parsed, never emitted), `prTab` for PrDetail's inner tab, which is a `{prId, tab}` PAIR in the store
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
     that wipes `syncRound`, `repoConsoleTabs` and every drill-down seed,
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

**No sign-in.** `/api/me` never 401s — the server resolves every request to the one local
account — so `App.tsx` renders the app directly. (`SignInGate`, sign-out, the GitHub App and "Your
data" Settings sections, GA + the cookie banner and `useAuthProviders` were removed 2026-10-22
with the hosted mode; GA and its consent banner live only on the website, `apps/landing`.) An
expired SAML authorisation shows the reconnect banner, which now says `gh auth refresh`.

### UI regions (`App.tsx`) — THE SHELL (redesign, 2026-10)

One sidebar, one slim top bar, the page (`components/shell/`, docs/redesign/DESIGN.md § 1, § 6):

- **`Sidebar`** (`components/shell/Sidebar.tsx`) — top to bottom: the wordmark (the `h1`), the
  **`WorkspaceSelector`**, "Search or jump ⌘K" (opens the palette), the destinations
  (`components/shell/nav.ts` `DESTINATIONS`: Pending · Open pull requests · This Sprint · Timeline;
  Library: Docs (AI only) · Feed; Insights: Reports · Bots Monitoring), **Needs you** (the old
  Welcome-back strip), **Open tabs** (phones only), **Repositories** (collapsible, remembered in
  `localStorage`; each repo opens its console; the thread-state legend is behind the ⓘ), and the
  foot: `SyncStatus` (sidebar variant: "Synced 2m ago" / "Sync error" in words), `AiUsageMenu`,
  the bell, Help, the key sheet, the theme, and the account menu (`UserMenu`, opens UP).
  ⚠ **RENDERED ONCE, NEVER UNMOUNTED**: below `lg` the closed drawer is `display: none`, because
  `SyncStatus` — the sync round's ONE driver — lives in its foot. Anything it must show while
  hidden is PORTALLED (the `SyncProgressModal`). The workspace scope keeper (`useWorkspaceSync`),
  the zero-repo first-run open and the `WorkspaceManagerModal` mount moved OUT of the picker into
  App (`useWorkspaceShell`); the manager's open state is the store's `managerOpen`
  (`openWorkspaceManager()` — the picker, ⌘K and the empty-workspace note all call it).
- **Navigation is `goTo(dest | repoId)`** (`nav.ts`): the same store actions the old tab row and
  Activity rail called (`setActivityRepo` FIRST, then `showActivity`; `showSprint`; `showTimeline`),
  so every URL key keeps its meaning — `'attention'` is Pending, `'insights'` is Reports. The
  highlight is `currentLocation(activeTab, tabs, activityRepoId)`; items carry
  `aria-current="page"` and `data-testid="nav-<store value>"` (e2e selects on those).
- **`TopBar`** (`h-11`, FIXED height): the menu button (below `lg`), where you are (below `lg`),
  the open-tabs strip (`PinnedTabsBar`, md+, dynamic tabs ONLY — the fixed views left it; it
  renders nothing when no tab is open; one-line chips, the author rides the tooltip) and the ONE
  `HeaderToastStrip` (below).
- **`BottomBar`** (below `md`): the four primaries + More (opens the drawer).
- **BELOW `lg` THE SHELL'S STATE STAYS GLANCEABLE** (`components/shell/shellSignals.ts`
  `useShellSignals`, NO new fetch — `['repos']`, the AI budget and the daily brief the shell already
  holds): the menu button and More carry a dot — red for a repo whose last sync failed or the AI
  budget over, amber near it, accent (More only) when other workspaces need you; the bottom bar's
  Pending carries this workspace's personal My Turn count (`activeWorkspaceBadge`); the top bar's
  location reads "<workspace> / <page>". The words stay in the drawer (foot, Needs you).
- **The drawer scrolls as ONE column** (foot included) so Insights is never below a pinned foot;
  the docked sidebar's middle fades at the hidden edge (`ui/edgeFade.ts`). The Repositories group
  is ONE line per repo (unread dot · name · a red dot only when the default branch fails · open
  PRs; everything else in the tooltip / accessible name) and shows 6 rows before "Show all".
- **"Search or jump" from the drawer** skips the drawer's focus restore (`skipRestoreRef`) and the
  palette re-takes focus one frame after opening — otherwise on a phone the keyboard never came up.
- **Keys** (`hooks/useKeyboard.ts`): `/` opens the palette (or focuses `#add-repo-input` while the
  manager is open), `?` the key sheet (`ShortcutsSheet`), `g` then p/o/s/t/d/f/r/b goes to a page —
  the chord's second key is taken in the CAPTURE phase and ALWAYS swallowed (a known letter goes
  somewhere, an unknown one does nothing) so it never also reaches a list's own keys (`o` = open on
  GitHub, `e` = dismiss) — `i` Activity, j/k the board, Esc as before.
- **⌘K** (`hooks/useShellCommands.tsx`): every destination and sub-tab, every repo console, every
  workspace, "Show what needs you in <workspace>", every Settings tab, "Manage repos & workspaces",
  sync, theme, notifications, the key sheet, open tabs + "Close all tabs", "Merge when ready" (opens
  that header card), "Run auto reviews now…" (takes you to the button — the run stays behind its
  `AiRunGate`), every open PR, and the SERVER SEARCH (`hooks/usePaletteSearch.tsx`: the old
  `GlobalSearch` dropdown's request — `useSearchDropdown`, ≥ 2 chars, 300ms, same tier — as Tickets
  and Search rows; "Search everything" still opens the full results tab).
- ⚠ **The splash waits on `me.isPending`, never `isLoading`**: while the persisted cache restores,
  the `me` query is pending but not fetching, so an `isLoading` gate rendered the app, then the
  splash, then the app again ~1s after every load — a whole-tree remount.

- **FilterBar** — **Timeline-only now** (it renders nothing elsewhere): the workspace picker moved
  to the sidebar and the search box to ⌘K. Everything in it, `RepoSelectPanel` included, is
  Timeline-only — with ONE exception: a pr-focus tab also shows exactly two controls, Events
  (`EventSelectPanel`: categories + review verdicts) and a "Hide bots" pill (see below). On a phone
  the filters fold behind one "Filters" button.
  - **`WorkspaceSelector`** (was `TeamSelector`) is a **single-select RADIO list** — no "All
    repos", no "All Teams", no "No team", no checkboxes, no `toggleTeam`. Default first (badged
    "Default"), then the rest by name, each with its repo count; the trigger label is the active
    workspace's NAME (never "All repos" / "N teams"). Its footer opens the
    **`WorkspaceManager`** modal ("Manage repos & workspaces"), where repo add/remove/assignment
    and the debounced GitHub search picker (`RepoSearch` → `/api/repos/search`) live (a successful
    add pops the sync-progress modal via `syncModalSignal`); `RepoSearch` also mounts standalone
    inside `FirstRunOnboarding` (zero-repo first run). ⚠ **A ZERO-REPO account opens straight into
    that modal**, once per PAGE LOAD (a module flag in `WorkspaceSelector`, so a remount or a view
    switch never re-opens it after a close; a reload — which is what signing in is — does). It waits
    for BOTH `['repos']` and `['workspaces']`: `undefined` is "still loading", never "empty", and
    `repos` is not IndexedDB-persisted, so `[]` is the server's answer for this load. In that state
    the modal leads with "Add a repo to get started" and `RepoSearch autoFocus` opens its curated
    suggestions without a click. It never closes itself — an added repo's sync shows in the modal.
    Each row also carries an **amber My-Turn
    badge** and the collapsed trigger carries the OTHER workspaces' total — see *Per-workspace
    "My Turn"* below.
  - **`RepoSelectPanel` is TIMELINE-ONLY, and `filters.repoIds` is therefore timeline-local in
    effect.** It lists **only the active workspace's repos**, never the account's; `repoIds = null`
    means "every repo IN THIS WORKSPACE"; it canonicalises to `null` at all-or-none and won't hide
    the last one. ⚠ **No per-row remove** (a visibility panel that deletes a repo is a footgun;
    removal lives in `WorkspaceManager`) and **no per-row watch toggle** — the "watched" concept is
    gone (migration `0046`); every repo in a workspace is fully live. Its empty state is
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
    PR-DETAIL tabs and every drill-down keep just the scope row. A **pr-focus tab** adds EXACTLY
    TWO controls: Events (`EventSelectPanel`) and a **"Hide bots"** pill, bound to the shared
    `excludeBots` with `aria-pressed` = bots hidden (the same polarity as the Members panel's
    "Exclude bots" checkbox). While `allowedBotIds` is non-empty it reads "Hide bots (except N)",
    because Focus honours the allow-list. Whether they show is decided by `boardSlotMode(activeTab,
    tabs)` (`store/pinnedTabs.ts`, pinned in `test/isolateFilter.test.ts`), the SAME resolver App
    uses for the board slot, so a stale focus key never shows Focus controls over the board. They
    are the SHARED store fields and URL keys (a choice made in Focus applies on the board, and
    back), and the isolate Timeline applies them CLIENT-SIDE over its unfiltered `prIds=<id>`
    payload (`components/Timeline/isolateFilter.ts`; see *Focus is a TAB* below). Nothing else
    renders in Focus: Repos, Status and Range cannot change a single-PR view, Members and Threads
    are not applied there, and Now would leave the tab. In Focus the FilterBar's and the isolate
    instance's `useSearchTimeline` are idle (`enabled`). ⚠ The shared board's `useTimeline()`
    stays LIVE in Focus on purpose: `useKeyboard`'s observer keeps the board payload cached for the
    way out. Idling it made the pane's "Show on timeline" from Focus land on nothing after any
    toggle. The filter STATE persists
    (reachable again from the Timeline tab); the Activity console's queries never send
    `userIds` or the FilterBar's exclude-bots toggle/allow-list anyway (its bot control is the
    Feed's Humans | Bots toggle, which rides the feed route's own `authors` param server-side);
    the board stays member-scoped. **Bots are HIDDEN by default on the
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
- **DetailPane** — resizable bottom pane (height persisted) under a **PR Focus tab's** board
  slot ONLY (`selectedPrId != null && !overlayActive && boardMode != null`; App fires a synthetic
  `resize` on the transition so vis refits). Shows **PrDetail** for the selected PR. ⚠ **The
  SHARED board has no pane**: a PR-bar click (or ↵ on the j/k selection) opens the **PR popover**
  (`Timeline/PrPopover.tsx`, below) and "Open details" opens the PR's own tab. **App lands on Activity → Open PRs by
  default** (a bare load → `?view=activity`; Pending is `?view=activity&activityRepo=attention`;
  `?pr=`/`?thread=` deep links keep the timeline).
- **`AutoMergeBanner`** — the armed-merge PROGRESS STACK, a header toast card fed by `GET /api/auto-merge`. One row per armed PR from the click that
  arms, through the watcher's `phase`, to the outcome — see "The armed-merge progress stack"
  below and docs/MERGE-CI-TRUNK.md.
- **Tabs / board slot** (`PinnedTabsBar` + `App.tsx`). `<main>` renders exactly ONE
  `<Timeline>` "board slot" whose `mode` derives from the active tab: absent = the shared
  board; `{kind:'isolate',prId}` = a **pr-focus** tab's own isolated Timeline. `activity` +
  `pr-detail` render as overlays OVER the warm board; `pr-focus` REPLACES the slot (keyed
  remount → at most one vis instance live). `PinnedTabsBar` is **always shown**: **Activity**,
  **This Sprint** and **Timeline** are the first three chips — permanent, **non-closable** tabs (the header
  segmented control was removed; the tab strip is now the single place to switch views). The
  dynamic tabs (pr-detail / pr-focus) follow as closable PR-named chips. **Closing the active
  tab moves to the adjacent tab** (left, else right, else ACTIVITY — `DEFAULT_FIXED_VIEW`,
  wherever the tabs were opened from) — it does NOT snap back to a fixed view when other tabs
  remain (`closeTab` in `store/pinnedTabs.ts`). ⚠ The last fallback used to be the Timeline
  unconditionally, and then "the fixed view the tab was opened from" (`lastFixedView`, DELETED),
  which still landed on the Timeline for a tab opened by clicking a bar there — the commonest
  case. The user's rule is unconditional: Activity. `test/closeTabs.test.ts` pins it.
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
  moving target in a row of tabs. The fixed Activity / This Sprint / Timeline chips stay content-sized: they have
  no ✕ and are not "tabs that open". **Right-click opens a
  context menu** (floating-ui in a `FloatingPortal` — the strip is `overflow-x-auto`, an
  in-flow menu would clip to the 42px bar — virtual reference at the click point): Close this
  tab / Close other tabs / Close all tabs (`closeOtherTabs`/`closeAllTabs` in the store; on
  the fixed chips the menu shows only "Close all tabs"; "close all" keeps you on a fixed view if
  that's where you are, else lands on Activity, mirroring `closeTab`'s fallback). ⚠ The menu's
  (and an in-flight drag's) Escape MUST `stopPropagation` or `useKeyboard`'s global Escape
  also yanks the user to the Timeline. TabChip is now one shared `ChipShell` — the nine
  per-kind branches collapsed to a config switch, which is what made the drag/menu handlers a
  one-place change; the e2e selectors (`data-testid="pinned-tabs"`, `role="tab"` names, ✕
  aria-labels) are load-bearing and survived.
  **REDESIGN (2026-10-29, `redesign/open-prs`): Open PRs draws ONE-LINE ROWS + a SIDE PANEL**
  (`Activity/OpenPrsRows.tsx`, mounted by `<OpenPrsCards layout="rows">` from `OpenPrsDetail`).
  `OpenPrsCards` still owns EVERY read (the ticket gate, the ONE batched Claude / CI / ticket-review /
  merged-PR requests, the sort, the stacks) and hands the folded answers down; the rows file asks for
  nothing (nothing fetches on selection). The row: lead = `mergeVerdict` (red conflicts/blocked,
  green ready, grey otherwise) · title · repo#N · CI icon · review standing · open threads · ONE AI
  marker · +A −D · author · age; every old chip is in words in the panel (+ the unchanged
  `ClaudeReviewPanel`). Keys: j/k, ↵ panel then PR, `o` GitHub, `r` AI review; double-click opens the
  PR; selection, panel state and the drawn window survive Back (session memo). Grouped by ticket =
  collapsible groups (fold per session, never stored) with one ticket line. Drawing pages are 60
  rows. The story view and Reports → "Merged so far" keep the CARDS described below. The Feed keeps
  its stream but in the row language (no borders, grey category icons, My Turn = accent bar + words,
  `data-my-turn`). Both register their switches in ⌘K. Pinned in `test/openPrsRows.test.ts`.
  **Open PRs is Activity's FIRST RAIL LINE AND THE DEFAULT** (`activityRepoId: 'open-prs'`, the
  one rail value `writeToUrl` omits; null renders it too). It was a third fixed view until
  2026-10-09; the fixed views are now Activity · Timeline (`FIXED_VIEWS`). A URL with NO `view=`
  lands on Activity (`landingTabFromUrl`), and so does a legacy `view=open-prs` (never emitted
  again). Pending now carries `?activityRepo=attention`; a legacy Pending link naming no console but
  carrying an `attn*` key (or `attnView`) still lands on Pending. Every "is this
  a fixed view?" test goes through `isFixedView` / `FIXED_VIEWS` (`store/pinnedTabs.ts`) — never a
  literal pair. The rail line shows N = the workspace's NON-DRAFT open PRs off `useWorkspaceOpenPrs`
  (`lib/openPrsTab.ts` `openPrsTabCount`; ⚠ **unknown is never zero** — no answer yet, the idle
  query while `workspaceId` is null, or the PREVIOUS workspace's `placeholderData` prints no
  figure). It is the same cache entry as the pane body and FeedIsolationBanner, so the count
  adds an observer, not a request. The view is **THE consolidated open-PR view** — the shared
  `OpenPrsCards` (`Activity/OpenPrsCards.tsx`) over `GET /api/open-prs`, ALWAYS workspace-wide:
  drafts included with a "· N drafts" callout. ⚠ **IT IS A LIST OF CARDS WITH NO COLUMN HEADINGS**
  (a pseudo-table with headings was tried and did not read; do not bring the shared grid back). One
  card per PR, the Pending card shell's language (`rounded-lg border bg-white px-3.5 py-2`), FOUR
  layers (five with a ticket) in order of importance:
  1. **Title** — the heaviest text on the card (`text-sm font-semibold`), truncating, + a "Draft"
     marker; the **status chips** sit on the RIGHT of the same line (wrapping below on narrow
     screens): CI (`CI_META`; red chip when failing; NOTHING for `unknown`), review standing
     ("Approved" / "Changes requested"; nothing otherwise), threads (`threadChipLabel`: "N
     untouched" amber, else "N open threads", else "N resolved", with the compact
     `ThreadStateBar`; nothing with no threads), merge readiness (`mergeVerdict()` through
     `MERGE_TONE_CHIP`; a draft shows only `mergeVerdictWarning`'s branch facts; `unknown` and
     `draft` draw nothing).
  2. **The ticket row** (CORE tracker — shown where the workspace has one, `useTrackerOn`; only
     when the PR names a ticket — NEVER an empty row):
     `TicketIcon`, then each ticket as `KEY · title` (key mono, title truncating, the row wraps for
     several), a link through `safeExternalUrl` or PLAIN TEXT when no link is known (never a
     guessed one). Below the chips (status is still read first), above the grey meta line (it says
     what the PR is for). `lib/cardTickets.ts` `cardTickets` merges two batched answers: ONE
     `POST /api/ticket-links` for the whole board (`useTicketLinks`, the tracker gate ANDed into
     `enabled`; the server's detection + the STORED Jira title / status / assignee — no Jira call
     on view, core `tracker_tickets` — re-asked every 3s only while `titlesComplete` is false, i.e. while the
     worker has not read a detected ticket yet) leads in detection order; the latest Claude review's stored Jira
     stories (`ClaudeReviewPrState.tickets`, already on the states answer) fill a missing title and
     add a key detection did not find, linked by its stored url, else `jiraBrowsePrefix + key`.
     ⚠ The Claude panel's story ALIGNMENT pills stay where they are: they are the review's
     judgement of the story, a different fact from "which ticket is this", so not a duplicate.
  **GROUPED BY TICKET — the default where the tracker runs** (`useTrackerOn(workspaceId)`,
  i.e. THIS workspace has a provider and a base URL); header toggle "Group by ticket / List", `OpenPrsViewToggle`, hidden without one). The page becomes
  one STACK per ticket — a `<section>` landmark with an `h3` header over its cards (which drop to
  `h4`). Membership and order are the pure `lib/openPrsStacks.ts` `stackOpenPrs` (pinned in
  `test/openPrsStacks.test.ts`). ⚠ **A stack NEVER collapses** (2026-10-18): no chevron, no header
  toggle — its PR list is always shown (only "Merged (n)" keeps its own disclosure). **Header
  anatomy**: ticket KEY (mono) + ticket TITLE (`text-base`, the heaviest text on the page) as ONE
  button that opens the ticket's STORY VIEW tab (`TicketKeyButton` → `useOpenStory`; a ticket with no
  ident keeps the tracker link on its key, through `safeExternalUrl`, and a plain title) / next line: STATUS pill coloured by `statusCategory` (new grey, indeterminate blue, done
  green; the site's own status words, else To do / In progress / Complete) · issue type (11px) ·
  assignee as INITIALS + name (Jira avatar URLs are third-party and the CSP blocks them — do not
  loosen it) or "Unassigned" when the status is known / right: a quiet roll-up over the stack's
  cards from fields they already carry ("N failing CI · N changes requested · N ready to merge",
  `stackRollup`, zero parts omitted) · "N PRs". **Rules**: a PR naming two tickets sits in BOTH
  stacks and each copy says "Also in BMD-1040" — a button that scrolls to that stack and focuses
  it; the header's "N open" still counts each PR ONCE. PRs with no ticket go in a
  final dashed "No ticket" stack. Inside a stack the card's own ticket row is GONE (the header says
  it). **The Sort menu orders the PRs WITHIN each stack** (the list is sorted first, then grouped
  in that order); **the stacks themselves are in a FIXED order**: open tickets first, then `done`
  ones; within each, the stack whose latest PR update is most recent leads; ties by key,
  numerically; an unknown status counts as open. ⚠ **THE FIRST PAINT WAITS FOR THE TICKETS, ONCE**
  (2026-10-14; it used to paint the list and then redraw into stacks): where the workspace has a
  tracker, the cards' skeleton stays up until the tracker settings AND the `POST /api/ticket-links`
  answer are in (`hooks/useOpenPrsTicketGate.ts`, pure rule `lib/openPrsTicketGate.ts`
  `ticketGate`). What is painted is a SNAPSHOT of PRs + tickets taken together, so a background
  refetch, a repo-filter change or a new PR keeps the last pair on screen until the new pair is
  complete — the loader never flashes again and the stacks never regroup mid-read. ⚠ That hold is
  BOUNDED too: a refetch's ticket answer gets `TICKET_WAIT_MS`, then the new PRs paint with the tickets
  already known; a PR the live list no longer has leaves AT ONCE (`paintedPrs`); and an ANSWERED empty
  list paints the empty state (the hook takes `answered` = the PR query's data is here — a query not
  started yet also reads as "no PRs, not loading"). The latch is pure (`nextTicketSnapshot`, tested).
  ⚠ **But the tracker never blocks the board for long**: a failed answer, or none within `TICKET_WAIT_MS` (6s),
  paints the plain list; if the tickets land later the list STAYS and a "Tickets loaded. Group by
  ticket" line offers the regroup (the reader's jump, never one that happens to them). No PR naming
  a ticket is still the list — no lone "No ticket" header. Every card (and the PR-detail header)
  carries a "Copy PR link" `CopyButton` (`LinkIcon`; `lib/prLink.ts` `githubPrUrl` on the cards,
  which carry no URL of their own). The view is a PER-VIEWER convenience in
  `store/openPrsView.ts` — localStorage only (try/catch), never the URL and never
  `FilterDefaults` (the retired collapsed-stacks key, `pierre:openPrsCollapsedStacks`, is no longer
  read). ⚠ **The board draws NO Story section** — every story read (brief, review, docs, design) starts
  on mount, so it lives in the story view alone, one click on the header away. List mode is exactly the cards described above.
  3. **Meta line** (11px): #number · repo · avatar + author · opened · updated (only when it
     differs) · files +/− · `LargePrFlag` · `BlastRadiusChip` — the same pieces `PrMetaRow` uses.
  4. **The Claude Review panel** (`ClaudeReviewPanel` in `ClaudeReviewCell.tsx`) ONLY where agentic
     AI runs (`me.ai.enabled`): its own AI surface (`border-ai-border bg-ai-surface`) with a 3px
     LEFT ACCENT coloured by outcome (`reviewTone`: red = request changes / failed, green =
     approve, grey = comment, sky = queued/running, none = not reviewed). Left to right: "Claude" ·
     the verdict pill (a size up — the panel's headline) + auto mark + the currency pill | severity
     pills (praise left out; IGNORED findings — `included = false` — left out of the pills and
     the "of M posted" total and shown as a grey "N ignored" from `summary.ignoredCount`; zero
     found and none ignored ⇒ green "No issues") · "N threads to fix" (`threadsToFixLabel` over
     `summary.threadAssessments.validUnaddressed`) | the CI REVIEW's pill ("N CI failures, M
     explained" / "Checking CI…", `ciCardPill` over the ONE batched `useCiReviewStates` answer —
     CURRENT runs and runs in flight only; a stale diagnosis says nothing) | story alignment pills · "Earlier: N fixed / N
     still open" · posted (muted) · design count … right: the AI Fix button ("Fixing…" / "Fix
     ready" → `openAiFix`) and the action (**Review** / **Re-review** / **Open review**).
  ⚠ **The WHOLE panel opens the PR's Claude Review tab** (a click anywhere that is not one of its
  controls; the keyboard route is the "Claude" label, a real button — never a `role=button`
  wrapper around buttons). **The card HEADER carries a work chip** (`ClaudeWorkChip`,
  `reviewWorkInProgress`): "Reviewing · Checking story · Checking CI · Fixing" with a pulsing dot
  while ANY of the code review (queued/running, auto lane included), the ticket review, the CI
  review or AI Fix is in flight — read off the same batched answers, no request of its own. **The
  tab header prints "7 of 20 auto reviews today · resets in 3h 12m"** (`AutoReviewUsageLine`,
  `usage` on `GET /api/workspaces/:id/auto-review`, present only while auto review is on; code
  reviews only, the calendar UTC day the sweeper caps on; re-read once a minute while mounted).
  ⚠ **Absent is never zero**: no summary, no CI reading, no story alignment, no follow-up, no thread
  assessment ⇒ nothing drawn. The pills reuse the Claude Review tab's palette
  (`lib/claudeReviewFollowUp.ts`). **Sorting is ONE "Sort:" menu in the tab header**
  (`OpenPrsSortMenu`; options, labels and the comparator in `lib/openPrsSort.ts`), state owned by
  `OpenPrsDetail`: "Recent activity" (null = `sortOpenPrsByActivity`) plus every key the old headers
  had; a pick lands on the key's natural direction and the arrow button beside it reverses it; the
  trigger always names the order on screen ("Opened, oldest first"). The Claude keys are offered —
  and honoured (`effectiveSort`) — only with Claude Review on. Cards are `<li tabIndex=0>` in
  `<ul aria-label="Open pull requests">`: click or Enter/Space (only when the CARD is the target)
  opens the PR; a click on any `a`/`button` inside does not. ⚠ **THE CARDS ARE DRAWN TEN AT A TIME**
  (2026-10-28, `lib/openPrsWindow.ts`, pinned in `test/openPrsWindow.test.ts`). Measured on the dev
  DB: `GET /api/open-prs` for a 739-PR workspace answers in ~130 ms (840 KB) and the batched state
  reads in 10–20 ms, but drawing every card cost 760 cards, ~46k DOM nodes and ~5–7 s of main-thread
  long tasks (one ~2 s); ten cards: ~5k nodes, ~1 s. So ONLY THE DRAWING is paged — the endpoint is
  not, and the header's counts, the rail's N, the sort, the repo filter, the ticket stacks and every
  batched request (`ticket-links`, Claude/CI states) still cover the WHOLE list; paging is over the
  already sorted, filtered `rows` / stacks. Under the drawn cards a `ShowMoreRow` ("10 of 238 PRs" ·
  Show more, distinct PRs like the header) is also the trigger: an `IntersectionObserver` rooted at
  the nearest scrolling ancestor with a 600px margin draws the next ten, rebuilt after each page so a
  tall screen keeps filling. The button is the keyboard / no-IO path and moves focus to the first new
  card. **In the stacks** (`stackRowsWithin`) a stack of up to ten is drawn WHOLE, and a bigger one —
  above all the ONE "No ticket" stack, which can hold hundreds — is CUT at the limit (its header still
  counts every PR). Show more and the trigger grow from what is DRAWN (`max(limit, drawn) + 10`), so
  each always draws new cards and the observer (rebuilt on `drawnCards`) never stalls.
  **Reset rules**: the window's identity is workspace + repo filter (`windowScope`, passed by
  `OpenPrsDetail` only — Merged so far and the story view draw everything) + sort + layout; a change
  starts again at ten and forgets the old identity; a DATA refresh never resets. The window is held
  in a module memo, so coming back from a PR tab (Activity unmounts while one is open) finds the same
  cards drawn. An "Also in" jump to a stack beyond the window grows it to include that stack first
  (`limitToInclude`). One batched
  `POST /api/claude-review/states` covers every listed card, click-gated starts share the tab's
  mutation key, every panel control `stopPropagation` ([CLAUDE-REVIEW.md](CLAUDE-REVIEW.md) §
  Starting from the Open PRs tab). Every opener just REVEALS it (`openOpenPrsDetail(repoId?)` →
  `showActivity()` + `setActivityRepo('open-prs')`): the Reports → Flow metrics "Open PRs" tile pass nothing and CLEAR
  the tab's repo dropdown; the per-repo "Show all N open PRs" footer (`RepoOpenPrList`) passes its
  repo and PRE-SELECTS it, because the footer promised that repo's count. The pane is headed by
  the workspace's **default-branch strip** (`DefaultBranchesSlot` → `BranchStatusPanel`; it headed
  Pending → My turn until 2026-10-09). The dropdown
  (`MetricRepoFilter`) is `filters.openPrsRepoFilter` — transient, URL-silent, stamped with the
  `workspaceId` it was chosen in and IGNORED under any other (derived in `OpenPrsDetail`, no reset
  effect to race the seed) — and must never write `filters.repoIds` (the Timeline picker). It
  narrows client-side; the fetch is `useScopedOpenPrs(null)`, byte-identical to
  `workspaceOpenPrsSearch` (pinned in `workspaceOpenPrsScope.test.ts`). My turn's old
  "Open PRs · N" button, the `open-prs` `TabKind`, the `OpenPrsScope` seed (and its group arm) and
  the never-mounted `FeedOpenPrsPanel` are DELETED; the old `MetricsDetail` `open_prs` sub-tab is
  GONE too. Pinned in `test/openPrsTab.test.ts` + `landingTab.test.ts`.
  Besides the PR tabs there's a family of **singleton, EPHEMERAL drill-down tabs** (never
  URL/localStorage-persisted; a reload drops them): `metrics-detail`, `bot-prs`, `bot-only-prs`
  (sortable + Age/Updated + cross-repo repo-filter dropdown), and `bot-threads` (sortable +
  DESELECT-by-default + Select-all/Clear across pages + Stop + repo-filter + client pagination;
  scope-wide review & resolve). **`user-activity` is the one drill-down keyed PER USER**, not a
  singleton (`userActivityKey(userId)` / `parseUserActivityKey`): two people's feeds can sit side
  by side and re-clicking a handle re-focuses their tab. It needs no filters-store seed — the tab
  KEY carries the userId, so a stale key can never show the wrong person; `Tab.userMeta` carries
  the chip's label/avatar. It renders `UserActivityDetail` → `<FeedView userIds={[id]}/>`, which
  is a real ACTOR filter (`inArray(events.actorId, …)`); `getConsolidatedFeed` skips the
  actor-less Claude-run items whenever `userIds` is set, and FeedView drops the My-Turn "seen"
  marker under that scope. **Merge/close rows are recorded
  against the PR's AUTHOR** (`sync/upsert.ts` writes `actorId: authorId`), so on this tab they
  mean "a PR they authored was merged" — the header caption says so rather than implying they
  pressed merge. **Row click across ALL these list surfaces (the drill-down TABLES
  + the inline `OpenPrRows` lists) now
  opens the PR's own detail TAB** (`openPrDetailTab`) — the old feed-isolation / timeline-focus
  on-click + the ⧉ button were removed; **feed isolation is reached from PrDetail's "Show in
  Activity feed" header button** (`FeedIcon`: `setRepoConsoleTab(repoId,'activity')`→`setActivityRepo`
  →`setFeedIsolatedPrId`→`showActivity`, order load-bearing). `bot-threads` rows open the PR's
  Changes tab, Threads only view, with the `likely_addressed` pill preset. **Repo-scoped chips show the repo name**
  (`PinnedTabsBar` `TabChip` reads the seed + `useRepos`). Each drill-down = a `TabKind` + key
  const + opener in `pinnedTabs.ts`, a transient read-not-consumed seed + `openXDetail()` action in
  `store/filters.ts` (`{fromActivity:true}` stamps the feed card to flash on a Back — the entry
  itself is the URL's, see the Back-button note below), a full-`<main>` overlay
  branch in `App.tsx` (MUST join `overlayActive`), and a compact chip in `PinnedTabsBar`. The
  drill-down TABLES (bot-only-prs / bot-threads, **plus `MetricsDetail`** — now
  retrofitted, per-tab `sortByTab` state; its four DURATION tabs add a "Longest first" / "Fastest
  first" toggle that only re-seeds the value-column sort — remembered per viewer in localStorage
  `pierre:metricsFastestFirst`, try/catch-wrapped — and a duration with no figure sorts LAST either
  way) share `Activity/sortableTable.tsx`
  (`SortHeader`/`compare`/`nextSort`; numeric columns MUST return a number from `sortValue`, or
  `compare` localeCompares lexicographically). The rail's per-repo console remembers its Activity|Bots sub-tab in
  `filters.repoConsoleTabs` (`insightsSubTab` is GONE — the Insights pane is Reports-first, no sub-tabs) — surviving rail
  switches and tab round-trips; cross-view jumps set it explicitly (e.g. Show-in-feed →
  `setRepoConsoleTab(repoId,'bots')` BEFORE `setActivityRepo`, isolation set AFTER — the
  setter clears `feedIsolatedPrId`).

### The timeline (`components/Timeline/`)

**REDESIGN (2026-10).** The FilterBar is a token toolbar: panel triggers on the raise tone (their panels
become bottom sheets below `sm`, their checkboxes `CheckboxBox`), Range a segmented control, Now / Clear
filters quiet buttons. ⌘K while the Timeline is the page (`Timeline/useTimelineCommands.tsx`): each range,
"centre on now", "clear filters", and on a phone Board / List. ⚠ **A PHONE READS THE TIMELINE AS A LIST** by
default (`Timeline/TimelineList.tsx` over the board, which stays mounted): one line per PR the board would
draw a bar for (`Timeline/listModel.ts` — the board's payload plus its Members and Threads narrowings,
the selected PR always kept), grouped by repo, newest activity first; a tap (or ↵ on the j/k selection)
OPENS THE PR'S TAB directly (`openPrDetailTab`) — a popover there would only be a sheet in front of the
same full-screen tab.
The choice is `store/timelineLayout.ts` (localStorage only, never the URL); the BOARD is one tap away.
On a phone a Focus tab's detail is a FULL-SCREEN sheet (App.tsx, `DetailPane sheet`, Back clears
the selection) instead of the resizable bottom pane; on the phone's BOARD view a bar tap opens the PR
popover as a bottom sheet.

`vis-timeline` with `stack:false` + `stackSubgroups:true`. Rows are nested groups
**repo → contributor** (ids `repo:<rid>`, `repo:<rid>:user:<uid>`); within a contributor
row, subgroups order a PR-bar line, its own-work event line, and a shared cross-user marker
band. PR bars pack into lanes (`lanes.ts`); events are type-shaped SVG markers that
**cluster** at coarse zoom (`clustering.ts`).

Key behaviors to know about:
- **The PR popover** (`Timeline/PrPopover.tsx`, shared board only). A PR-bar click selects the PR
  AND opens a card under the clicked point of the bar (re-anchored every frame on `.pr-bar.vis-selected`,
  so it rides scroll/zoom/rebuilds): repo#N + title, state, author, Merge (`leadStatus` →
  `mergeVerdict()`), CI, review standing, size, age / last activity, ticket (one batched
  `ticket-links` read, only with a tracker) — all from the lean `TimelinePr`, nothing else fetched.
  "Open details" (primary, focused on open, so ↵ ↵ goes bar → tab) = `openPrDetailTab`; "Open on
  GitHub" = `githubPrUrl` (→ `safeExternalUrl`). It holds the ONE popover slot
  (`claimActivePopover`, so j/k are blocked while it is open), captures Escape (a second Escape then
  clears the selection), closes on an outside press — except a press on the board, which the board
  routes (another bar re-targets it, a marker opens the marker popover instead, empty canvas closes it
  as the first of `dismissEmptyCanvas`'s levels) — and closes whenever the selection clears or the
  board stops being the page. ↵ on the j/k selection opens it (not from a focused control). A Focus
  tab never shows it (its pane stays). The **marker popover's** "Open details" (on the board; "Open in
  detail pane" on a Focus tab) opens the PR TAB first, then lands on the event in it: a thread through
  `selectThread` → `showThread`, a PR comment through `showPrComment`, a review / commit through
  `showActivityEntry`.
- **Selection & highlight.** Clicking an event marker/cluster selects its PR (on a Focus tab: its
  pane) + opens the marker popover; clicking a PR bar selects it (+ the PR popover on the board). Every highlight (selected
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
  boot fit. The by-id fetch has NO date window (`buildTimelineSearch` sends `prIds` alone and
  `getTimeline`'s pr-scoped branch has no date predicate), so a PR of any age isolates.
  **Focus filters are client-side.** `isolateEvents` (`Timeline/index.tsx`) is a constant `null` on
  the shared board, so the board never rebuilds extra. On a Focus tab it is the subject PR's events
  that pass `makeIsolateEventFilter`: categories via `categoriesToTypes`; a narrowed `reviewStates`
  drops a `review_submitted` whose `reviewState` is null or unselected (the server's `EXISTS`);
  `excludeBots` drops a bot actor under the UNION verdict of the PR's OWN workspace
  (`lib/unionBot.ts` + `hooks/useUnionBotVerdict.ts`, enabled only in isolate), keeps NULL actors,
  and honours `allowedBotIds`. It drives the rows (`rowEvents`), the markers (`rebuildMarkers`
  skips its category gate on this path) and the PR bar's comment glyph. A toggle re-applies ONLY
  through the heavy rebuild's scroll-anchor capture/restore: no `setWindow`, no scroll write, no
  re-entry into `enterPrFocus`. The boot fit spans ALL events, so a toggle never refits.
  ⚠ The keep-set (`isolateKeepGroupIds`) is RECOMPUTED on every rebuild via
  `focusSubgroups` + `focusRows` and always contains the author's row, so it is never empty
  (`applyContext` reads empty as "no focus"); the old boot-once keep-set hid anyone who first
  appeared after boot, your own reply included. ⚠ **The magnifier-targeted event ALWAYS shows.**
  `timelineFocusEvent` is SUBSCRIBED and resolved during render by `matchFocusEvent` (the same
  resolver the `timelineFocusPr` consumer uses), then LATCHED for the tab's life, so the rebuild
  draws its marker in the commit the consumer centres and glows it. ⚠ The `timelineFocusPr`
  consumer waits for the first payload in BOTH modes, and on the board, when the PR is not in
  `data`, for the member-agnostic search payload's first answer: a board re-keyed out of a Focus
  tab can mount either one cold, and consuming then threw the focus away.
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
  labels**. The card shows an enlarged avatar, the contributor's LAST-90-DAY
  `GET /api/users/:id/stats` counts (captioned "Last 90 days · <scope>" from the shared
  `USER_STATS_WINDOW_DAYS`), a GitHub-profile link, and **Last 14 days of activity →** (the person
  tab is the Feed narrowed to one author, so it reads `FEED_WINDOW_DAYS`; both constants live in
  `packages/shared/src/activity-windows.ts` — never retype 90 or 14 in the copy). Details
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
  filter would hide it); detail loads only on selection. On a pr-focus tab the same rule holds one
  level down: the Focus filters never hide the event a magnifier deep-linked to.

### PR detail (`PrDetail.tsx`)

**`placement: 'pane' | 'fullscreen'` is a REQUIRED prop**, set by the mount site (DetailPane →
`'pane'`, the `pinned-pr-overlay` in App.tsx → `'fullscreen'`), never re-derived from `activeTab`
(the pane can sit mounted under an overlay for another PR). Only the pane (shared Timeline AND a
Focus tab) offers "open full-screen": the ↗ button and the clickable title. Full-screen renders the
title as a plain `<h2>`. Every icon button right of the title (↗, Show on timeline, Focus, Feed,
Refresh, GitHub) and DetailPane's ✕ wear ONE ink, `PR_HEADER_ICON_BTN` (gray-900 / dark gray-100,
the title's colour); Refresh's amber stale state and the Stalled / Auto-merge / new-since chips keep
their colours because they mean something. Pinned in `test/prDetailPlacement.test.ts`.

**Header meta line** (`data-testid="pr-header-meta"`): REPO first, then the author's avatar + name,
"opened …", the file delta button, the large-PR flag and the blast chip — at 14px (`text-sm`,
gray-600 / dark gray-300; the delta's +/− are green-700 / red-600 so they clear AA). It was 12px
and author-first.

**Overview → Ticket + branch, ONE row** (`PrTicketBranchLine` in ChecksTab): the ticket chips, then on
the same line a small "Branch" caption and `PrBranchLine` — the head branch in monospace, a muted
`→ base`, and a `CopyButton` for the HEAD name only (bare, no fork owner — sync does not know the
owner). The row is labelled "Ticket" when the PR has a tracker (`tickets != null`; `[]` reads "No
ticket found") and "Branch" (no caption) when it has none; a null head omits the branch. Long names
`break-all`. Pinned in `test/prBranchRow.test.ts` + `test/prOverviewLayout.test.ts`.

**Tabs: Overview · Comments · Threads · Changes** (+ the gated ones below). ⚠ **Activity is NOT a tab
any more** — it is the collapsed **Activity** section at the foot of Overview (`ActivitySection`, a
compact one-line-per-event list of the same rows: opened, commits, reviews, comments, merged/closed,
each with the timeline magnifier and a GitHub link). `'activity'` stays a `PrDetailTab` member so an
old `?prTab=activity` link, the timeline's commit popover (`activityFocus`) and the header's "N new"
chip still work: it RENDERS Overview with the section open, DERIVED (`effectiveTab`), never written
back; a local flag mirrors it so pressing Overview afterwards does not snap it shut, and shutting the
section while seated on `'activity'` moves the tab to `'overview'`. **Comments** (`?prTab=comments`,
badge = issue comments + review bodies, `prConversationCount`) holds `PrCommentsList` + the composer;
a PR-comment deep link (`commentFocus`) seats it.

Header carries **Show** + **Focus** links (drive the timeline) and, on OPEN PRs only, a **CI
readout**: a 12px `CiDot` plus its word (`prHeaderCi(state, ciStatus)` in `lib/ui.ts`, pinned by
`test/prHeaderCi.test.ts`: the `CI_META` label, or a hollow ring with "No checks" for `unknown`).
It sits between the state chip and the title, `shrink-0`, so it shows on every tab and the title
truncates first. ⚠ It reads `pr.ciStatus`, the synced rollup the Status row, the Timeline bar and
the Pending cards read, never the live `checkRuns`. ⚠ Merged/closed PRs get nothing, because
`ci_status` is FROZEN at the merge instant (real merged rows still say `pending`). The word is an
AA grey pair, never the CI hex; filled dots get a thin edge ring so green and yellow hold on white.
It is a `<button>` (`data-testid="pr-header-ci"`): the click runs `goToTab('overview')`, then
scrolls Overview's Status row into view AND moves focus to it (a `tabIndex={-1}` wrapper with a
focus-visible ring, so a keyboard or screen-reader user lands where the button said). That goes
through a one-shot `statusFocus` nonce that `ChecksTab` uses once and clears, so coming back to
Overview later does not jump. It adds no fetch of its own: it stays fresh through
`usePrLiveRefresh`'s `['pr', prId]` invalidation, and `useDetailCacheReconciler` now also
invalidates `['pr', id]` (never its threads) when the most recently fetched timeline/open-PRs feed
carries a different `ciStatus` and was fetched after the detail (`ciDetailOutdated`) — CI finishing
never bumps `updatedAt`. Tabs (Overview / Comments / Changes, + a presence-gated **Bot activity** + Claude Review / AI Fix, listed whenever
`me.ai.enabled` — see **The agentic AI surfaces** below):
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
  gating it would make the pane say less than its own first row. A reader without push access
  sees the link alone, which is
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
  clickable through to the Changes tab's Threads only view via `onOpenThreads`; ⚠ its thread count is `!isResolved` and therefore INCLUDES
  `likely_addressed`, which is why the Bots chips inches away say "N need a look" rather than "N
  unresolved" — the full three-count table and the never-assert-a-cause rules are in
  **docs/MERGE-CI-TRUNK.md § Why a blocked PR is blocked**), **Reviewers** (all who
  submitted a review, badged by latest state) above **Approvers** (latest decisive review =
  `approved`), then **Merged by**, **Requested** reviewers, labels, meta, an **Actions** row
  (⚠ **HIDDEN BY DEFAULT behind ONE reveal button**, "Show actions" / "Hide actions", in
  `PrActionControls` itself so the Overview and the Claude Review tab's "Reviews and actions" get the
  same gate; ⚠ nothing remembers the choice — every mount (a new tab, another view, another PR)
  starts closed, so the actions show only after a click in the view at hand). Only the
  BUTTONS hide: the closed row still states "You approved" / "You requested changes" and "Merging…"
  (read off the shared mutation keys), and the merge facts stay on the Status row. ⚠ The Claude
  Review tab's "Post to GitHub" composer (its Verdict select + Post) is NOT behind this reveal — it
  has its own "Post as …?" confirm (pending the user's confirmation of that exemption). Inside it, the
  review verdicts in `ApproveControl` — while YOUR approval stands, **Withdraw approval** asks
  inline ("Withdraw your approval?" Yes, withdraw / Cancel), calls `POST /api/prs/:id/withdraw-approval`
  through `useWithdrawApproval` → `invalidateAfterPrWrite`, bridges the standing locally until the
  refetch agrees, and prints GitHub's refusal sentence as the server wrote it; **Approve** posts at once with no text box, **Approve
  with comment** alone opens one and stays shut until something is typed, **Request changes** always
  opens an optional one and a blank box sends "Changes requested." (GitHub refuses an empty one);
  after approving, Request changes stays, and the standing chip reads the server's
  `viewerReviewStanding` so it survives a reload / `MergeControl` / `MergeWhenReadyControl` /
  `ClosePrControl` / `ReopenPrControl` — the
  two merge controls are handed the same `MergeBlockFacts` this tab built, so the merge button's own
  explanation stops being the worst one on the screen. ⚠ **The Actions row is the ONE row that opens
  on a CLOSED PR**, via `viewerCanReopen && state === 'closed'`: before `ReopenPrControl` its gate
  was two `state === 'open'` disjuncts plus the un-state-gated `viewerCanApprove`, so a closed PR
  you AUTHORED showed no actions at all while a closed PR somebody else authored showed one holding
  just Approve. `ReopenPrControl` has **no confirm step**, unlike `ClosePrControl`: a reopen is the
  undo of a close and is itself undone by the Close button beside it, so a two-click gate would be
  ceremony around a reversible act. It prints GitHub's own refusal sentence when the 409 comes back
  — normally the head branch was deleted after the close) — then the PR **Summary** (markdown,
  clamped to 3 lines, tall images hidden when collapsed). The collapsed **Activity** section rounds
  the tab off (rendered by `PrDetail`, not `ChecksTab`); the **PR comments** moved to the Comments
  tab. (The AI PR summary under the description and the per-comment "Check review" + its
  annotations are REMOVED 2026-10-18.) The **Checks
  row** is ONE collapsed summary line (`ChecksSummary`: chevron + the Default branches strip's
  pills — "N passed" / "N failing" (failure + error) / "N running", one per state that exists, "all
  N passed" when every check did — and "N checks" on the right; the whole line toggles, per mount,
  collapsed even when red). Expanded it lists the checks + re-run control; it renders only when
  there are checks to list
  (`checksRowVisible` is DELETED with the old `CiAnalysisCard`: why CI failed is the CI review's
  job now — docs/CLAUDE-REVIEW.md § CI review).
- **There is NO Threads tab** (removed 2026-10-26; a legacy `?prTab=threads` reads as `changes`).
  What it held is the Changes tab's **Threads only** view (see *The sticky bar and the Threads
  only view* under Changes); this bullet describes that list. `ThreadList`/`ThreadView`: review
  threads grouped by file, **newest first**
  (files by most-recent thread; within a file by `createdAt` desc), with code anchors +
  new-comment highlights; each has a "Show" link. **Collapse is per THREAD, never per file**: a
  resolved thread is one line (line, author, first words, "Resolved") until clicked; every other
  state stays open; the file header is a label only. The open set is LOCAL `ThreadList` state keyed
  by thread id and reset on a PR change — the old global `expandedFileGroups`/`collapsedFileGroups`
  slice (by path, across every PR) is DELETED. A selected thread is open — until it is resolved.
  ⚠ **A resolve COLLAPSES the thread AT ONCE, from any surface** (`lib/threadCollapse.ts`): every
  resolve shares `RESOLVE_THREAD_MUTATION_KEY`, and `ThreadList` reads the SUCCESSFUL ones with
  `useMutationState` (each applied once; those already cached at mount are history). It holds a
  local resolved verdict until the refetch agrees (`pruneOverrides` — never longer, or a later
  change on GitHub is masked), drops the thread from the opened set, and RELEASES the selected
  thread's forced-open (a new selection forces open again; the reader can re-open it by clicking).
  Unresolving re-opens it. A sticky header carries **derived-state filter
  pills** (Untouched/Replied/Likely-addressed/Resolved, `store.threadStateFilter: Set<DerivedState>`)
  ANDed with the vendor `threadBotFilter`; the pills' badge counts come from the full loaded set
  (stable), and the bulk "Resolve N addressed" set is derived from the full list (independent of
  the visible filter). (The per-thread "Check review" button and its output block are REMOVED
  2026-10-18; a thread's AI judgement is Claude Review's or a later **Check threads** run's, read
  through `useClaudeThreadJudgements`.) ⚠ **TWO PILLS AND ONE VOCABULARY** (`lib/claudeThreadMarker.ts`,
  the only place the words live): a judged thread wears **validity** (Holds up / Partly / Doesn't hold
  / Unclear) and **state** (Resolved / Addressed / Partly addressed / Open, "· earlier commit" when the
  head moved) in place of the derived pill + confidence marker, then Claude's ONE-LINE reason
  (`ClaudeThreadReason`); the longer explanation opens only on "More". "Resolved" is read off the
  thread NOW (a GitHub fact). No judgement ⇒ the derived pill, unchanged. Every surface — ThreadCard,
  the Timeline popover, the Feed's collapsed row and the Changes tab's inline pill (both inside a
  button, so `noInfo` drops the ⓘ), the Claude Review tab's Review threads rows — prints these words.
  The state chips put an UNRESOLVED judged thread under "Claude judged"; a resolved one stays under
  Resolved. **Check threads** (`CheckThreadsButton`, above the list and in the Claude Review tab's
  Review threads header) starts the threads-only pass; ONE `['thread-check', prId]` status read polls
  every 3s only while queued/running, and a finish it SAW invalidates `['claude-review', prId]` (the
  judgements key sits under it). Gated like Claude Review: `ai.enabled` + `AiRunGate`. The Claude
  Review tab renders its Review threads from `currentThreadAssessments` (latest run only). The bulk-resolve OFFER now goes through `ThreadList/resolvable.ts`,
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
  Inline review threads start OPEN unless resolved, and the reader's toggle is remembered per
  thread — see *Inline thread indicators* below.
  A **navigation rail** (`diff/FileTree.tsx`) sits to its left — see below.

  **The sticky bar and the Threads only view.** The bar above the rail and the code (`Header` in
  `ChangesTab.tsx`, `data-testid="changes-bar"`) is `sticky top-0 z-30` inside PrDetail's scroll
  pane. Everything else that sticks in the tab pins BELOW it: ChangesTab measures the bar (a
  callback ref + `ResizeObserver`, because each render branch mounts its own bar) and sets
  `--diff-sticky-top` on its root; the rail takes it as an inline `top` (and subtracts it from its
  measured max-height), each `FileDiffView` file header is `top-[var(--diff-sticky-top,0px)]`
  with a matching `scroll-mt` on the block, and `ThreadList`'s filter header does the same. Unset
  (the AI Fix tab) it is 0. ⚠ **The bar carries NO file delta** (no file count, no +/− lines):
  the PR header above every tab states it. It holds the **Threads only** toggle (`aria-pressed`,
  with the PR's thread count, absent on a PR with no threads) and the 4-state mix, then Wrap (code
  view only) and the GitHub link.
  - **Threads only** swaps the code for `ThreadList` (built by PrDetail's `renderThreads`, so the
    guarded `threadStateFilter` / severity / vendor filters, the full `BotTriageCard`, Check
    threads, reply, resolve and Claude's judgements all come with it). The state lives in
    PrDetail (`changesThreadsOnly`, LOCAL per PR pane) because deep links switch it: the
    Overview's Bots chip and Blocked row, a Bots-pane state-pill preset, and a selected thread
    whose file has left the diff. **The rail stays**: there a click lists that file's threads
    (`visibleThreadIds`, rename-aware through the same `threadsByPath`; a second click or "All
    files" lists every file) instead of scrolling the code. Resolved threads stay one line.
  - ⚠ **THE CODE STAYS MOUNTED, hidden, under the Threads only view.** Unmounting it dropped every
    file's expand state and each block's `consumedFocus`, so switching the view off by hand
    re-ran the LAST reveal (the focus target is sticky) and teleported the reader to an old line.
  - **"Show in context"** on each card (ThreadCard's `openInChanges`, from `openInChangesFor`)
    calls `openInChanges`, which switches the view OFF and arms a NEW focus in one go: the code
    shows, the file opens, the pill scrolls into view, opens and rings. An outdated thread whose
    live line is gone gets "Show in context ~" (the reconstructed line); a thread whose file left
    the diff has no control, and stays listed. Review comments with no file are not threads (PR
    comments live on the PR's comments list).
  - ⚠ **A RESOLVE COLLAPSES THE THREAD IN BOTH VIEWS, once GitHub said yes**: ThreadList through
    `lib/threadCollapse.ts`, the inline pills through ChangesTab's `resolveBus` (*Inline thread
    indicators* below). Both read the one `useResolveEvents` hook.
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

**There is no "Check review" any more** — neither the PR-wide bar nor the per-item
`ReviewCheckButton` (REMOVED 2026-10-18). The BotTriageCard's "N real issues" reads Claude Review's
thread judgements (`useClaudeThreadJudgements` + the shared `isThreadToFix`, never a run).

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

- ⚠ **ALWAYS RENDERED ON THE PATCHES PATH — there is NO file-count threshold, and a test pins
  that** (`fileTree.test.ts`). It used to auto-hide under `TREE_MIN_FILES = 5` because "a 3-file
  PR does not earn 224px". The argument was about width; what shipped was about IDENTITY — a
  4-file PR had no file browser and a 5-file one did, with nothing on screen accounting for it,
  and it was reported as "sometimes the file browser is not visible, and I don't know why". The
  width objection already had an answer the reader controls: the drag handle, persisted. **Hidden
  below the `md` breakpoint and nowhere else** — a viewport too narrow for a rail AND a diff,
  which is self-evident and reverses when the window grows. ⚠ The rail is also absent on the
  `!havePatches` fallback, but that branch returns early and SAYS SO ("showing the changed-file
  list"), which is the difference that matters: an absence the reader can account for.
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
- **Directory collapse is EPHEMERAL local state** in `FileTree`, never a global store slice — a
  store slice is unkeyed by PR, and directory paths collide across repos. Default: everything open.
- **The truncation disclosure lives INSIDE the tree** (the `note` prop: "Showing N of M files.
  All on GitHub ↗", rendered when `data.truncated`), because a tree implies a completeness a
  scrolling list does not. The pre-existing "Large diff — not all files are shown" line under the
  diff stays.
- **File-type marks** (rail rows, folder rows, and every `FileDiffView` heading) come from
  `components/FileTypeIcons.tsx` — paths COPIED from MIT-licensed Material Icon Theme
  (`material-icon-theme@5.39.0`; notice in the file header and `THIRD_PARTY_NOTICES.md`, which
  `build-release.mjs` ships). Brand-coloured on purpose, NOT `currentColor`, which is why they
  are not in `Icons.tsx`; `aria-hidden`, the file name is the label. The mark is picked by the
  pure `lib/fileTypeIcon.ts` (name, then name families, then extension, then a generic file) —
  ⚠ DISPLAY ONLY, a FIFTH path table that must never be folded into or read by the four path
  classifiers (its own lock-file and test-file lists). The status letter (A/M/D/R) stays: it is
  a status, not a type. pnpm and TOML swap to upstream's `_light` drawing on the light theme.

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
  `openInChanges(path, line, side, threadId?)` sets it + switches to the Changes tab — local because both
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
  nothing highlighted. Same rule as `botsInnerTab` / `insightsInnerTab`, one layer down.
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

#### Line wrap in the diff (`useDiffWrap`, `FileDiffView`'s `DiffTable`)

**No line may leave its box, in either mode.** The table used to be `w-full` under AUTO layout with
a `whitespace-pre` code cell, so the longest line set the table's minimum width and the code ran out
past the pane's right edge while the file header stopped at it. Now:

- **Wrap ON (the default)** — `table-fixed` plus a `<colgroup>`, so the pane decides the columns and
  the content never does; the code cell is `whitespace-pre-wrap` + `overflow-wrap: anywhere` (a URL
  or a minified line has no space to break at). ⚠ **The `<colgroup>` is load-bearing**: fixed layout
  takes widths from the FIRST ROW, which is often a `colSpan={4}` thread pill — four equal columns.
  The gutters are sized in `ch` off the file's largest line number, never narrower than the old `w-9`.
- **Wrap OFF** — the table is `w-max min-w-full` inside its OWN `overflow-x-auto` box, so a long line
  scrolls inside the diff. That box is a size container (`container-type: inline-size`) so the
  full-width rows (inline threads, the comment box) can be pinned to the VISIBLE width in CSS
  (`FullWidthCell`: `sticky` + `100cqw`) — without it a thread card is as wide as the file's longest
  line, off-screen to the right.
- **One value for every mount**: `hooks/useDiffWrap.ts` is a `useSyncExternalStore` over
  localStorage (`pierre:diffWrap`), not `useLocalStorage` — that hook is per-INSTANCE, and the toggle
  (`DiffWrapToggle`, in the Changes tab header and beside the AI Fix diff) is not the component
  that reads it. Never the filter store: a filter reset must not move the furniture.

#### No diff notation, the hunk expander, and loading more (Changes tab)

The diff prints CODE, not diff notation: no `+`/`-` column, no `@@ … @@` header row and no
`\ No newline at end of file`. Added/removed is the row tint plus the gutters (a removed line has
only an old number, an added one only a new number), with an `sr-only` "added"/"removed" word
because the tint is colour-only. `DiffHunk.tsx` (a thread's code anchor) is a different surface and
KEEPS its header — it doubles as the collapse control there.

- ⚠ **`parsePatch` STILL EMITS THE `hunk` ROWS.** They carry the line-number resets, and thread
  anchoring and the reveal address rows BY INDEX. Each now carries `gap {count, oldFrom, newFrom,
  context}`, and the renderer draws GITHUB'S HUNK EXPANDER in its place (`GapRow`): fold arrows in
  the line-number gutter (`FoldIcon` / `UnfoldIcon`), and in the code column, muted, the hidden
  count then the function git names after the header — `20 hidden lines · function foo() {`, just
  the count with no context. No "Show N hidden lines" prose: each arrow's `aria-label` says what it
  reveals ("Expand 20 lines down" / "Expand 20 lines up" / "Expand all N lines"). No row before a
  first hunk at line 1.
- ⚠ **HIGHLIGHTING LEXES ONE HUNK AT A TIME** (`highlightDiffRows`). Joining hunks fed the lexer
  text no file contained: a hunk ending on `/**` whose `*/` sat in the hidden gap turned every row of
  the next hunk into one flat comment colour. A hunk that refuses blanks only itself; the 2,000-line
  gate is still counted per side over the whole file. Pinned in `test/highlightDiffRows.test.ts`.
- **The arrows** (Changes tab only — `fileSource`; the AI Fix tab shows the count with an empty
  gutter). `gapControls(place, remaining)` decides them: BETWEEN two hunks a down arrow (the lines
  just after the code above) stacked over an up arrow (the lines just before the code below), each
  `GAP_EXPAND_STEP` = 20 lines a click, collapsing to ONE expand-all once ≤ 20 remain; before the
  FIRST hunk one up arrow; after the LAST one down arrow. Each gap keeps its own `GapReveal {top,
  bottom}` in the block (keyed by hunk row index, -1 = trailing), drawn as top lines · expander row ·
  bottom lines, the row vanishing at 0 remaining. ⚠ **RENDER-SIDE ONLY** — `rows` never change, so
  thread anchoring and the reveal keep their indices. The first click reads the WHOLE file once
  (`GET …/files/content`, head side; base for a deleted file); revealed lines are coloured from the
  whole file. The trailing arrow is offered BEFORE the load only when `patchReachesEnd` cannot prove
  the patch already runs to EOF (a `\ No newline` row, or < 3 context lines after the last change —
  git always prints 3 when the file has them); its size is unknown (`count: null`, no count shown)
  until the load, which then clamps the reveal and drops the row if nothing follows. ⚠
  `patchMatchesFile` must agree first — a file read at another commit says "This file has changed
  since the diff was loaded" in the row instead of splicing wrong lines. Pure logic pinned in
  `test/gapExpansion.test.ts`.
- ⚠ **`FileDiffView`'s list wrapper is `relative`, and that is load-bearing.** Tailwind's `sr-only`
  is `position: absolute`, PrDetail's scroll pane is not positioned, so every changed line's
  "added"/"removed" word used to take the VIEWPORT as its containing block: hundreds of 1px spans
  ~29,000px down, outside the pane's clip, grew the DOCUMENT's scroll height to match. A file-tree
  click's `scrollIntoView` then scrolled the document too — the whole app shell jumped ~265px up
  with a gap below it. Any new absolutely-positioned element inside the diff relies on the same box.
- **"Load full diff"** on a file GitHub sent no patch for: the server diffs both sides
  (`GET …/files/diff`), refused past ~1 MB a side.
- **"Load next 100 files (N of M shown)"** replaces the three "View all on GitHub" notes — one page
  per click, up to GitHub's 3,000-file ceiling, which is then stated. ⚠ **Page 1 stays the plain,
  persisted `['pr-files', id]`** (PrDetail and ClaudeReviewTab read it as a `PrFilesResponse`; an
  `InfiniteData` blob there would crash with no error boundary); pages 2+ are the unpersisted
  `usePrMoreFiles` infinite query, armed per head.
- ⚠ **EVERY ONE OF THESE IS CLICK-GATED.** Nothing fetches on mount; the content/diff/more-files keys
  stay OUT of `shouldDehydrateQuery`.
- Each file header carries a `CopyButton` for its path (the NEW path on a rename), beside — never
  inside — the collapse button; the metadata fallback rows carry one too.

#### Inline thread indicators in the diff + per-file state rollups

Every review thread — **resolved included** — renders inside the diff as a **pill**
(`InlineThread` in `FileDiffView.tsx`): state dot, author, age, `~` when approximate, reply count,
plain-text excerpt and chevron. Opened, the pill becomes the full `ThreadCard`'s collapse header
("Hide thread"). **Unresolved threads — `untouched`, `replied_unresolved`, `likely_addressed` —
START OPEN; only `resolved` starts SHUT** (dimmed, `✓` for the dot, no coloured border). That is
GitHub's own Files-changed default, and one pure helper decides it: `inlineThreadStartsOpen`
(`lib/diff.ts`, pinned by `test/inlineThreadOpen.test.ts`). It used to be every thread shut,
because full cards at ~200–600px buried the diff (a 47-thread PR rendered ~47 cards). That is now
bounded by resolved staying shut, a one-click Hide remembered per thread, the file chevron, and
lock files, which start collapsed whatever they hold. There is deliberately NO count cap (an
invisible threshold is the rail's lesson). MEASURED on the dev DB's open PRs (2026-09-24): 2,777
of 4,127 threads are unresolved; of 581 PRs with threads, 361 carry 1–5, 23 carry more than 20,
and the most is 532 (29 files, one bot comment each). The Threads only view already mounts a full card
for every one of those (`FileGroup` opens any file holding an unresolved thread), so this default
is bounded by a screen that already exists. An open pill fetches nothing of its own: ThreadCard's
ML and annotation queries are one per PR, and its reaction bars batch per tick (`useReactions`, 60
targets a request, a cache shared with the Threads only view — 532 threads is 9 lookups).

- ⚠ **THE OPEN STATE IS THE READER'S, REMEMBERED PER THREAD ID — AND ONLY THEIR DECISIONS ARE.**
  - How it works: every open/close (the pill click, a thread reveal, the posted-comment
    self-focus) goes through the pill's `decide`. That sets its local state AND writes
    `DiffThreadContext.openMemory`, a plain `Map<threadId, boolean>` owned by **PrDetail**
    (`threadOpenMemory`) and read ONCE, when a pill mounts. A pill with no entry starts from its
    thread's CURRENT state.
  - A pill REMOUNTS far more often than it looks: collapsing and re-expanding its file; the Wrap
    toggle (`DiffTable`/`FullWidthCell` change the tree's shape); a push moving the anchor row or
    dropping the thread to file grain; and a tab switch, which remounts ChangesTab. Without the
    memory, each of those undid the reader's choice. (The Threads only view does NOT remount the
    code: it stays mounted, hidden — see *The Threads only view* below.)
  - A MOUNTED pill never moves on its own (`useState` latches), so the ~5s poll resolving a
    thread under the reader does not snap it shut.
  - The default is never recorded, so a thread resolved elsewhere (a bulk resolve) comes back
    SHUT.
  - ⚠ **A RESOLVE IS A DECISION TOO, made by GitHub's yes.** ChangesTab holds ONE
    `useResolveEvents` subscription (`hooks/useResolveEvents.ts`, the successful writes under
    `RESOLVE_THREAD_MUTATION_KEY`, the same hook `ThreadList` uses): each event writes
    `openMemory.set(id, !resolved)` FIRST, so a pill that is not mounted comes back shut, then
    fans out on `DiffThreadContext.resolveBus` (a per-thread listener map created once per mount,
    stable for the memo) to the one mounted pill, which calls `decide(!resolved)`. An unresolve
    re-opens. Never a context value that changes per resolve: that would repaint every row.
  - ⚠ It lives in PrDetail, not ChangesTab (the round trip), and not the store: the store is not
    keyed by PR (the `threadStateFilter` landmine), and persistence and reset share one list. Both
    PrDetail mounts are keyed by `prId`, so it lives exactly as long as this PR's pane — no store
    field, no URL.
  - ⚠ It is a mutable Map, not lifted state: a click must re-render one pill, never every diff
    row.
- ⚠ **`FileDiffView` is `memo`'d, and ChangesTab memoises what it builds (`threadCtx`,
  `commenting`).** PrDetail re-renders at least twice per ~5s poll tick (`isRefreshing` flips) and
  ChangesTab on every rail-drag frame. Unmemoised, each of those repainted every diff row and, once
  unresolved threads started open, every open ThreadCard. A new unstable prop from ChangesTab
  switches the guard off silently. Cost accepted: a shut pill's "3h ago" refreshes on the next
  data change, not on the poll tick.
  - ⚠ **A caller's callback must not reach `threadCtx` by identity.** The old "In Threads"
    callback closed over the whole `pr`, and every `['pr', prId]` refetch that changes ANY field
    (a CI check finishing, a merge-state move) returns a new `pr` even when `pr.threads` keeps its
    identity. So the memo missed on exactly the ticks that carry data: MEASURED 1.3–1.5s of long
    tasks on a 532-thread PR, for a change that touched nothing in the diff. That callback is gone
    with the Threads tab, and no caller callback reaches `threadCtx` now.
    `test/inlineThreadOpen.test.ts` pins `threadCtx`'s dependencies as an ALLOW-list from source,
    so a new one fails a test instead of getting slow.

- **ONE rename-aware fold, built once per PR.** `indexThreadsByPath` (`lib/diff.ts`, pinned by
  `test/threadsByPath.test.ts`) buckets threads by the **RENDERED** file path and re-homes a
  thread whose `path` matches only a file's `previousPath`. ⚠ Before this the per-view fold keyed
  on `t.path` while the blocks looked up `f.path`, so a thread written before a rename was
  INVISIBLE in Changes. An exact current-path match always beats a `previousPath` re-home (with a
  COPY, both paths are in the diff and the thread belongs to the file that literally has it). It
  is a memoized `Map`, never a per-row `.filter()`.
- **Anchoring is a three-rung ladder** (`anchorRowFor`, shared with `PrDetail.openInChangesFor`
  so the pill's position and the "Show in context ~" scroll target agree): a live `thread.line` → the
  last matching row, RIGHT side preferred; else the anchor hunk reconstructed
  (`anchorLineFromHunk` + `lineRowIndex`, matched honestly on its own side) and marked
  **approximate**; else `null`, and the pill renders at FILE grain above the diff with an
  "outdated" / "line not in this diff" prefix. **A thread never disappears.** Rung 1 never falls
  through to the hunk: a live line absent from the visible patch means the hunks moved on, and a
  reconstruction would contradict stored truth. Known asymmetry: the jump has no side and assumes
  RIGHT, so a live line matching only a LEFT (del) row anchors the pill while the jump's
  `focusRow` is null. That no longer moves the scroll: the target pill scrolls to its own header.
- ⚠ **WHEN A REVEAL NAMES A THREAD THE BLOCK RENDERS, THE PILL OWNS THE SCROLL**
  (`revealScrollsFileHeader`, `lib/diff.ts`, pinned in `test/inlineThreadOpen.test.ts`). The block
  scrolls its file header only when neither the addressed row nor the target pill will scroll
  itself. Both are smooth `scrollIntoView` calls, a later one cancels an earlier one, and React runs
  passive effects child-first, so the block's header scroll used to run after the pill's and win.
  That was invisible while pills started shut (~26px each above the target). With unresolved pills
  open (~300px each), a jump to the fourth of four file-grain threads landed on the file header
  with the ringed target 1,274px below the top of a 297px pane. The two no-table branches (binary,
  and an empty textual diff) list their threads as pills too, because the rule assumes every thread
  in the block has one.
- ⚠ **`consumedFocus` lives on the BLOCK, not the pill.** `DiffFocusTarget` gained an optional
  `threadId` so a thread-card jump opens and flashes the matching pill as part of the same
  reveal, consumed per `nonce`. The focus target is STICKY in `ChangesTab` and collapsing a file
  unmounts the table (and the pill's state with it), so a re-expand remounts the pill against the
  old nonce — without the block-level record the effect would re-open a pill the user
  deliberately closed and teleport the view back to it. It is a **ref read at effect time**, not
  a nulled prop: the mounted pill's props must stay stable mid-flash or any re-render (the ~5s PR
  poll) would trip the reset branch and cut the ring short. Focus also **LATCHES** the pill open
  rather than gating `expanded = open || focused`, so the 6s self-focus timer expiring does not
  snap shut a card the reader is midway through. The two records answer different questions and
  neither replaces the other: `consumedFocus` stops a remount RE-DELIVERING a reveal (the re-open
  AND the teleport); `openMemory` restores what the reader chose. Both scrolls target the pill's
  HEADER, not the card: an open card can be taller than the pane, and `block: 'center'` on the
  whole card put the header above the fold.
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

#### Every thread link lands on Changes (`showThread`), and the thread → code ladder

**ONE landing for a thread, `PrDetail.showThread(threadId)`.** A Pending card, My Turn, a Pending
comment card (`prChangesFocus.threadId`), the Feed, a timeline marker, a search hit, a `?thread=`
link and the Claude Review tab's Review threads rows all end there: the Changes tab with the code,
scrolled to the thread's pill, opened and ringed — never a Threads tab (there is none). Most of
them arrive as `selectThread(prId, id)`; PrDetail's selected-thread effect waits for the PR to
load and shows each selection ONCE (`handledThreadRef`, so a refetch never yanks the reader back).
When the ladder below returns null (the file has left the diff) or the pane does not hold the
thread, it lands on the **Threads only** view with the thread selected, and `ThreadList` scrolls to
it (`block: 'center'`, clear of the two sticky headers).

**Thread → code.** `PrDetail.openInChangesFor(thread)` resolves the jump and hands `ThreadCard` an
`openInChanges` object ("Show in context"); the control is a real `<button>` in the card header.
Four rungs, in order:

1. `thread.line` is live → jump to it on the RIGHT side. Always available for a non-outdated
   thread (measured: 8,844/8,844 have one).
2. the live line is gone → reconstruct it with **`anchorLineFromHunk`** (`lib/diff.ts`) and label
   the jump **approximate** ("Show in context ~"). `review_threads` stores exactly ONE positional
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

**Every thread is in the code.** `ChangesTab` passes **every** thread into `DiffThreadContext`, not
`.filter((t) => !t.isResolved)`. That filter hid 40.3% of threads: a diff line carrying a settled
discussion looked undiscussed, and the round trip was one-way for exactly those. Resolved threads
start as a **shut pill** (`✓`, dimmed) so the diff isn't buried under closed conversations — the
filter existed for volume, not relevance — while unresolved ones start open. A reveal always opens
its target, so a deep link lands on an OPEN thread rather than on something the reader must then
find and open.

Two counters had to stop being `threads.length`, which silently changed meaning once resolved
threads joined the array: the amber `N 💬` header badge still counts UNRESOLVED only (with a
separate grey `✓N`), and the auto-expand heuristic still keys on unresolved, so a file whose
conversations are all settled no longer forces itself open.

The old return leg ("In Threads", `ThreadCard.onOpenInThreads`) is DELETED with the tab.

⚠ `openInChanges` is **optional**, because only ONE of `ThreadCard`'s mounts can honour it: the
Threads only view's `ThreadList`, which sits in the Changes tab without showing the code. The
mount inside `FileDiffView` (the `InlineThread` pill's expansion — both the table and binary
branches route through it) is already in the code, and the Feed / search / attention / themes
mounts have no Changes tab at all (they use `onOpenInPr`). The control is a real `<button>` so
`ThreadCard`'s header-click guard (`closest('a,button,…')`) swallows it — a `<span onClick>` would
ALSO fire `onOpenInPr` and navigate away from the PR the reader is already in.

#### Emoji reactions (`ReactionBar` + `hooks/useReactions.ts`)

CORE, and **nothing is stored or synced** — no column, no migration, no sync step; state is
read live from GitHub. Exactly **two mounts**: `ThreadView/CommentBlock` (which reaches all seven
`ThreadCard` mount sites at once — the Threads only view, Feed, search results, attention cards, the
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

### The AI surfaces — gated on `me.ai` (`useAiCapabilities`)

EVERY model-backed surface gates on the TOP-LEVEL `MeResponse.ai` through
**`hooks/useAiCapabilities.ts`** (pure half: `lib/aiCapabilities.ts`) and swaps its Run button
through the one `AiRunGate`: the agentic ones — Claude Review (run, follow-up, user-story check,
auto review, the review chat), AI Fix, Resolve with Claude, the docs library — AND the one-shot
ones — Bot themes (the Bots Themes sub-tab is ABSENT while AI is off), the synthesis cards,
Chronology pointers, the period-report write-up, the impact note and the work-plan narration. They
run on the reader's own Claude Code login or `ANTHROPIC_API_KEY` (the one credential ladder,
docs/CLAUDE-REVIEW.md § The credential ladder); Limn stores no key and charges nothing. Copy reads
"your own Claude Code login or Anthropic API key". There is no `me.pro`, no `useProCapabilities`,
no `ProGate` (`ProBadge` / `ProLockPanel` / `useProGateState`) and no AI-credit meter ("Track
usage") — all removed 2026-10-22; `test/aiGating.test.ts` fails if a capability, a lock or a meter
reappears.

- **VISIBILITY IS `ai.enabled` ALONE** (`LIMN_AI_DISABLED !== 'true'`). Locally the tabs, the Open
  PRs column, the Feed's Claude pill and the Settings switch ALWAYS render. ⚠ Never
  hide a surface on `runtime`/`auth`: hiding it until a credential is detected hides it from exactly
  the people who have not set one up, and the detection is a heuristic (the run is the real check).
- **What sits in place of a Run button is ONE component, `AiRunGate`** (`components/AiSetup.tsx`),
  wrapped round Claude Review's Run, the chat's Ask, AI Fix's Generate and the CI card's "Fix it". In
  order: runtime not `ready` → `AiRuntimeSetup` ("Set up AI (one-time ~110 MB download)", streaming
  `POST /api/ai/runtime/install` over `sseStream`; `failed` prints its message + Retry); `auth: 'none'`
  (from `/api/me`, or the surface's own route answer passed as `auth`) → the one line "Sign in to
  Claude Code or set ANTHROPIC_API_KEY"; else the button. Past reviews and the story panel stay
  usable either way. The Open PRs cell has no room for the line, so its Review button
  OPENS the PR's Claude Review tab while `ai.ready` is false.
- **The install is ONE per page** — a module-level store in `useAiCapabilities.ts`, so two "Set up
  AI" buttons show one progress line and cannot start two downloads; an install the SERVER reports
  (`runtime: 'installing'`, e.g. `limn ai install` in a terminal) is watched by polling `['me']`.
- **`LIMN_AI_DISABLED=true`**: the agentic tabs are not listed and the one-shot blocks do not
  render; nothing prints in their place.
- **Money, not credits.** Runs show US$ (`formatUsd` in `lib/ui.ts`) — a credit figure would invent
  a Limn price for the reader's own spend.
- **ONE STATUS LINE FOR EVERY AGENTIC PASS** — `components/AiStatusLine.tsx`: the stage in words,
  an optional "N of M", and the elapsed clock; no spinner, and it fetches nothing (each surface feeds
  it what it has: Claude Review's SSE phase, Check threads' poll, the sprint read's `briefs` +
  `passes` via `sprintAiPass`, or a single request's pending state — the impact note, the work-plan
  wording, sprint Ask, the docs check). A new agentic pass uses it; `test/aiStatusAndPrActions.test.ts`
  pins the mounts.
- **The old CI-analysis card is DELETED** (the CI review diagnoses failing CI). The AI summary, the
  CI list and the instruction box LEFT the AI Fix tab; the tab is the fixer and its picker only.
- **Plan mode in the AI Fix tab** ("Plan first" beside the model, then `AiFix/PlanPanel.tsx`;
  contract docs/CLAUDE-REVIEW.md § Plan mode). ⚠ A row with `status === 'planned'` is ALWAYS drawn by
  the plan panel — the tab's `isRunning` excludes it, so a planning pass never shows as a build — and
  the picker stays shut while a plan is open. The stream stays on while `plan.status === 'planning'`
  or a plan action is in flight. The plan actions share `aiFixPlanMutationKey`; "Make a plan"
  shares the start's key. Only "Approve and build" seeds the header AI-fixes card (`noteAiFixRun`);
  the banner treats `'planned'` as terminal ("Plan ready").
- **STORIES ARE THE TICKET REVIEW'S NOW, in its own "Story check" section** (`TicketCoverage.tsx`,
  pure half `lib/ticketReview.ts`, hooks `hooks/useTicketReview.ts`; contract docs/CLAUDE-REVIEW.md
  § Ticket review). "Run a review" sends `{model}` only. One block per ticket the PR is on: key,
  title, "N of M met", the server's currency pill ("2 PRs changed since"), Check / Re-check behind
  `AiRunGate`, criteria with "Done in web#412" / "Belongs in api#88", and ONE Post button per unmet
  item (target named on the button; once posted, never offered again; `visible:false` = "It will
  show up here shortly", no retry). It shows the latest SUCCEEDED run; a newer running or failed one
  is a line above it; each block's header says how long ago the shown run finished (`ReviewedAgo` on
  `completedAt`). The story-tab panel moved here behind a plain **"+ Add story" link** — no
  disclosure box: the link reveals the tabs with a blank story (`storiesOnOpen`), and Close hides
  them and drops blank typed tabs (`storiesOnClose`, `lib/storyTabs.ts`) (pasted stories become
  `manual:` ticket reviews; auto-pull is off — detected tickets are already blocks). ⚠ **Open PRs
  reads ticket coverage through ONE batched `useTicketReviewStates(idents)`** (`POST
  /api/ticket-reviews/states`), never per card; it polls only while a state is `running`. The ident
  is built client-side with shared `jiraApiRoot` on the browse link — the plugin's own fold. Card
  pills ("BMD-1 · 4 of 6 met") come from those states, not from PR-review rows, and a card inside a
  ticket stack skips the stack's own ticket. The start mutation key is `['ticket-review-start',
  ident]`, shared by the pane and the stack.
  - ⚠ **ONE STORY SECTION.** The old "User stories" section is DELETED: an older PR review's story
    verdicts render INSIDE Story check, and only for a story NO ticket review covers
    (`legacyOnlyEntries`, `lib/ticketStory.ts`: same key, or same title when keyless), as its own
    block under a muted "Checked on this PR only" with a Check (a `planStoryStart` of that stored
    ticket). `ClaudesReview` places only THOSE stories' findings (`placeStoryFindings(findings,
    legacyEntries)`) and hands the cards to Story check through its `storyCheck` render prop; a
    story hidden because a ticket review covers it places nothing, so its findings stay in the
    Findings list with their chip. Every finding is still on screen once.
  - **Each block has a collapsible "Story"** (`StoryDisclosure`, `TicketStory.tsx`): key linked to
    Jira, title, description + criteria as markdown (`StoryText`). Source in order: the STORED Jira
    row (`GET /api/prs/:id/tracker-ticket?key=`, ⚠ fetched only once opened — the worker read Jira
    on receipt) when `canFetchDetails`, else the latest ticket review's `ticket` snapshot, else the
    older run's ticket. A Jira story carries the criteria-field picker (`useSetJiraAcField`, no
    "None of these"); a change invalidates `['ticket-reviews']` + the states so the block shows
    "Story edited since". "+ Add story" is only for pasting: a ticket already listed as a block is
    not offered as "Pull KEY from Jira".
  - **THE WHOLE STORY LIVES ONCE, IN THE STORY VIEW; the pane shows its own share.** The Open PRs
    stack header carries the coverage pill, "reviewed X ago" (`state.checkedAt`) and Re-check; the
    story view (§ The story view) adds the "Story" section (`Activity/TicketStorySection.tsx`, always
    open), which reads the run by the states' `latestRunId`: summary, every criterion with "Done in api#88" / "Belongs in …", missing and
    not-asked-for items, currency pill, the Story — and NO Post buttons (`viewedPrId: null` in the
    shared `TicketReviewParts.tsx`). The pane's block goes SLIM where the story view holds the story
    (`slimStoryCheck`, `lib/ticketShare.ts`: a tracker ident, `trackerOn` — `PrDetail.tickets !=
    null`, the PR's own workspace has a tracker, no extra request — an open PR on the ticket): alignment + currency + reviewed-ago + Re-check, then only `prTicketShare` — criteria
    this PR delivers, unmet criteria / missing items owned by it (item `ownerPrId`, else
    `expectedIn.prId`, else `expectedIn.repoId` against its repo; an item naming NO owner stays here,
    since its post lands on the viewed PR and the story view has none), ONE "Post N gaps to this PR"
    (`StoryGapsPost onlyThisPr`; the full view shows one per target PR, `storyGapGroups` — the gaps go
    as ONE collated comment, there is no per-item Post), its not-asked-for work — a
    count of the rest (`shareRestLine`) and "See the whole story", which opens the ticket's story
    view tab (`useOpenStory` with the block's ident, key and title). A pasted `manual:` story keeps
    the full view in the pane.
  - **"What this PR adds" — each member's CONTRIBUTION CARD** (`TicketReviewMember.card`, the card at
    the PR's CURRENT synced head; docs/CLAUDE-REVIEW.md § Ticket review). The stack's body lists
    "What each PR adds" (`MemberCards`): one collapsed `PrCardDisclosure` per member that HAS a card,
    toggled by the PR ref alone (the heading already says what it is; a bare mount with no `label`
    — the slim pane's own card — still reads "What this PR adds") —
    summary, interfaces (Added/Changed/Removed chip, kind word, the exact name, its note), loose ends.
    The slim pane shows THIS PR's card only (`prCardOf`, `lib/ticketShare.ts`) above the rest line.
    ⚠ A member with no card renders NOTHING (`membersWithCards` drops it) — never a placeholder claim.
    Both ride the review already loaded: no request of their own, and the board fetches none of it. Card text is model prose about untrusted input: PLAIN TEXT through `PrRefText`.
  - **Open PRs: a ticket opens its STORY VIEW in a tab** (`TicketKeyButton` → `useOpenStory`): the
    stack header's key AND title (one button), and each card's ticket row — any ticket with an ident
    (Jira, GitHub Issues, Linear); one without stays a tracker link on the key. The ticket-text MODAL
    is GONE (2026-10-18): the story view's Story section carries "As written in Jira". In the story
    view itself (`single`) the header key and title are plain text. ⚠ The button stops the click, or
    the card beneath opens the PR.
  - **No "Claude: " lead** on generated text anywhere in the pane — it is all Claude's.
  - **The stack pill** (`StackCoverage`, `OpenPrsCards.tsx`): ONE chip in the `TicketStack` header —
    "4 of 6 met" toned by alignment (a pulse while running) — then the currency words when stale
    ("#412 pushed since"), then Check story / Re-check (hidden while running, absent without a
    ready AI runtime) and the refusal sentence ("12 PRs are on this ticket; the most is 8"). It
    starts the run with the stack's FIRST row as `prId`.
  - ⚠ **A START REFRESHES EVERY PANE, not just the starter's PR**: `useStartTicketReview` /
    `useStartStoryCheck` invalidate the `['ticket-reviews']` PREFIX plus the states. The run belongs
    to every PR on the ticket and the starter knows only its own; a pane open on another member
    showed the old verdict as current, with no stream and no poll, until a remount. `done` still
    invalidates each member by id.
  - ⚠ **"Already posted" is ONE error code** (`ApiError.code === 'AlreadyPosted'`). The post route
    also 409s `HeadMoved` and `Superseded`, where nothing reached GitHub: those keep the button and
    print the server's sentence. Reading every 409 as posted told the reader not to post a comment
    that did not exist.
- **Claude Review's user-story input is TABS** (`ClaudeReviewTicketPanel`, pure half `lib/storyTabs.ts`):
  one tab per story, Jira tabs read-only markdown with their criteria field shown and changeable,
  detected Jira tickets auto-pulled once per PR per key set (never re-adding a removed one). ⚠ "Story
  N" counts only stories that will be SENT (a blank tab is "New story") — the run, the chips and the
  GitHub lead number the stored list. The Open PRs strip numbers BEFORE dropping unassessed stories
  (`assessedStoryPills`). Contract: docs/CLAUDE-REVIEW.md, the "User stories (optional)" bullet.
- **A user story's results are FINDING CARDS, not a post button — shown INSIDE THEIR STORY.** Every
  not met / partly met criterion and every "Not done" item of a run arrives as an ordinary
  `ClaudeFinding` with `story: {index, ref}` (server-made — docs/CLAUDE-REVIEW.md § User stories).
  ⚠ **LIKE FOR LIKE, AND ONCE**: Story check's older-story blocks render each as THE SAME `FindingRow` the
  Findings list uses (one `findingCard` builder in `ClaudesReview`, handed to
  `ClaudeReviewTicketResults` as `renderFinding`; chip `storyItemChipLabel`: "AC2 · Partly met",
  "Not done"), and the Findings list drops them (`placeStoryFindings(findings, tickets).placed`).
  Met criteria are a compact line; "Not asked for" a compact list; a run stored before story
  findings falls back to read-only rows. A story finding no story places stays in the list with
  `storyChipLabel` ("BMD-1040 · AC2"). One with no file (`path: ''`) shows a "PR comment" chip and
  no code anchor. "See it below" is DELETED (the card is right there).
- **Every section of the Claude Review pane is ONE shell, `ReviewSection`** (`ReviewSection.tsx`):
  bordered rounded box, tinted header band = sentence-case title (one size) + count pills + ⓘ +
  right-aligned actions; cards inside keep their lighter borders (pane → section → card). Order:
  Reviews and actions (the Overview's Reviews + Actions rows, shared via `components/pr/`, plus the
  left-aligned Generate fix button) · Run a review · Claude's review · Previous review · Review threads · Findings · Story check · CI check
  · Review chat (OPEN by default, so its one DB read runs on mount; Hide collapses it) · Post to
  GitHub (summary, verdict, Preview, Post). The code review draws NO CI any more.
- **CI check is the CI REVIEW** (`CiCheckSection.tsx`, `hooks/useCiReview.ts`, pure half
  `lib/ciReview.ts`; docs/CLAUDE-REVIEW.md § CI review) — its own run, not part of Claude's review.
  `GET /api/prs/:id/ci-review` (polls only while `running`); it shows the latest SUCCEEDED run (read
  by id while a newer one runs, failed or was refused), the currency pill ("On latest commit" /
  "Pushed since" / "Other checks failing now" / "Passing now"), "reviewed X ago" on `completedAt`,
  Check CI / Re-check (mutation key `['ci-review-start', prId]`), SSE progress, the refusal sentence
  (`ciRefusalSentence`), the summary (markdown) and one plain-text `CiFailureRow` per failing check
  (cause, "Fix:" suggestion, Why, path links into Changes, the check's details page — never a log
  URL). ⚠ **ONLY THE PR'S CURRENT HEAD** (`ciRunAtCurrentHead`): a CI review run — succeeded or
  failed — or an old code review's `ciFailures` that read an EARLIER commit is never shown, whether
  the head is green (noise) or red (the wrong commit's story; only the current head's run, else the
  offer). An unknown `pr.headSha` hides nothing. The by-id read of the last succeeded run is skipped
  when `state.headSha` is an earlier commit. `ciSectionShow`: a run at the current head → it; else
  an older code review's stored `ciFailures` of THIS commit as HISTORY ("From an earlier Claude
  review of this commit"); else, on red CI, just the button; else nothing. Open PRs and Pending read CI through ONE batched `POST /api/ci-reviews/states` per board.
- **Praise is not a finding.** New reviews raise none (the summary carries one praise line,
  rendered as part of its markdown). An older run's stored praise is HIDDEN, never deleted:
  `withoutPraise` (`lib/claudeReviewFollowUp.ts`) is applied ONCE where `ClaudesReview` takes the
  run (findings list, counts, story placement, the Previous review list), and `findingTotal` leaves
  it out of the cards' "N of M posted".
- **Findings' "Copy all"** (`CopyAllFindingsButton`, left in the header beside the count; pure half
  `lib/findingsMarkdown.ts`, `test/findingsMarkdown.test.ts`) copies the Findings LIST only — never
  Story check's placed findings or CI — as one markdown string for the reader's own coding agent:
  per finding `### <Severity>: <title>`, `` `path:line` `` (`path` alone with no line, "Whole PR"
  when `path === ''`), the body, a ```` ```suggestion ```` fence; blocks separated by a `---` line;
  then "Copied N" for 1.5s. ⚠ **THE REWORD WINS HERE, unlike the per-card Copy** (which stays
  Claude's original): this is a hand-off of what the reader decided to say. ⚠ **IGNORED IS THE CARD'S
  OWN RULE**, `isIgnoredFinding` = editable run && unposted && `!included` — a stored `included:
  false` on an older run or a posted finding shows no Ignore state, so it must not vanish from the
  copy. Praise is excluded again in the lib. Absent (not disabled) when nothing is copyable. ⚠ **The
  label STATES THE COUNT** (`copyFindingsLabel`): "Copy all" only when every listed finding goes,
  "Copy 4" once any is ignored.
- **The verdict LEADS the Claude's review header** (`VerdictBadge`, the Open PRs panel's exported
  `VERDICT_PILL` size), then currency, "reviewed X ago", auto mark, mode. The PR pane's **tab label**
  carries the same outcome ("Claude Review [Approve]", `VERDICT_CLASS`; "Reviewing…" / "Queued" /
  "Failed"; nothing with no run) — `useClaudeReviewTabPill` OBSERVES the tab's own
  `['claude-review', prId]` query (DB-only, no second request when the tab opens) and alone re-reads
  every 5s while a run is in flight, because a shut tab has no SSE stream; pure half `reviewTabPill`.
  ⚠ **A run started or finished ELSEWHERE reaches it through the ACTIVE LIST** (auto review, the
  Open PRs table, another tab): the pill also observes `['claude-reviews-active']` (ONE request for
  every PR, 5s while a pane is open; the banner's 2.5s only after a person starts a run) and polls
  while its PR is in it, and `useClaudeReviewActiveSync` — mounted ONCE in App, a PASSIVE observer
  that never fetches — invalidates `['claude-review', prId]` + the Open PRs column for each PR whose
  entry appeared, changed (`reviewId`/`status`) or left between two polls (pure half
  `lib/claudeReviewActive.ts`). The pane's `changed` refresh also invalidates the review (a new head
  moves the auto-review wait). Never a per-card fetch.
- **Preview (Post to GitHub) renders the WHOLE dry-run payload** (`PostReviewPreviewPanel`): the
  verdict, the summary as markdown (the hidden `<!-- pierre:claude-review -->` marker dropped by
  `visibleReviewBody`), each inline comment as `path:line` + markdown body, and each off-diff PR
  comment. It used to print only the counts although the server always sent the bodies. ⚠ Preview
  and Post SAVE THE DRAFT FIRST (`saveDraftThen`): the server reads the STORED body, and the box's
  blur-save raced the dry run. Editing the summary or verdict clears a shown preview.
- **ONE TYPE SCALE for every section, and the reference is the FINDINGS card**
  (`lib/reviewStyles.ts`): `REVIEW_ITEM_CARD` / `REVIEW_ITEM_TITLE` / `REVIEW_PROSE` (Claude's words,
  13px = `.md-body`, page colour) / `REVIEW_META` / `REVIEW_CHIP` / `REVIEW_ANCHOR(_MUTED)` /
  `REVIEW_SUBHEAD`. Story check once set its prose at 12px grey beside Findings' 13px; do not hand-roll
  a size in a section — import the constant. Muted pairings stay under `test/textContrast.test.ts`.
- **Claude's summary (and a ticket review's) is MARKDOWN** — the prompts ask for one lead sentence
  then a "- " bullet per main issue, only when there are issues. Rendered through `<Markdown prRefs>`,
  so an older plain-prose summary renders as one paragraph, unchanged.
- **EVERY PR REFERENCE IN THE REVIEW TAB OPENS THAT PR IN LIMN** (pure `lib/reviewPrRefs.ts`, React
  `components/ReviewPrRefs.tsx`). "owner/repo#N", "repo#N" and a bare "#N" (= the viewed PR's repo)
  in model prose (summary, findings, threads, CI, follow-up, story check, chat) and in the ticket
  review's member labels ("Done in api#88", "Belongs in", evidence, "Post on") become a button calling
  `openPrDetailTab`. Resolution: data already on screen first (the viewed PR, the ticket reviews'
  members — the same cached query Story check reads), then ONE batched DB-only `POST
  /api/prs/resolve` per pane (`ReviewPrRefsProvider`, keyed on the sorted ref set, `staleTime:
  Infinity`, at most `PR_REF_RESOLVE_MAX`). ⚠ A qualified ref never falls back to a bare-number match
  in another repo, and a bare "repo#N" resolves server-side only when exactly ONE of the account's
  repos has that name. Unresolved refs, refs inside links or code, and the viewed PR itself stay plain
  text. Markdown gets it via the `rehypeReviewPrRefs` plugin, which runs AFTER the sanitizer.
- **When did the review run? ONE component, `ReviewedAgo` (`components/ReviewedAgo.tsx`)** over
  `reviewedAgoLabel()` (`lib/claudeReviewColumn.ts`): muted "reviewed 2 days ago" (past a month,
  "reviewed on <date>"), the exact `dateTime()` on hover. Mounted beside the currency pill on the
  Open PRs panel and the Claude's review header (the shown run's `finishedAt`), and at the end of
  a Pending card's one-line Claude summary on a finished run (`ClaudeReviewPrState.finishedAt`,
  falling back to a `claude_review` My Turn card's `since`). The history select ("Showing …", `ReviewHistoryList` — a native `<select>`, one option per
  review, a Claude + Codex pair ONE option; docs/CLAUDE-REVIEW.md § The review tab's history) prints
  each review's date AND time of day via `reviewRunWhen()` (`finishedAt ?? createdAt`), plus the age
  while recent. A pair is shown as ONE review (the server's consolidated view): one header, one
  summary, one findings list with a quiet source chip per finding.
- **Is the review on the PR's current commit? ONE helper, `reviewCurrency()`
  (`lib/claudeReviewColumn.ts`)**, read by the Claude's review header (second pill, after the verdict; also for a past
  run picked in the run list — always against the PR's CURRENT head) and the Open PRs card's verdict
  row (finished runs only): green "On latest commit" (the pane adds the short sha), amber "N newer
  commits" / "1 newer commit", amber "Branch changed" when the count is 0/null (rewritten history,
  reviewed commit not synced). Either head unknown ⇒ null, no pill. The card reads
  `ClaudeReviewPrState.currentHeadSha` (the PR's synced head). It replaced the pane's "Outdated"
  chip and the Previous review header's "No new commits since that review." — do not re-add either.
  `test/claudeReviewFollowUp.test.ts` pins the section list and that no bare `<section>` remains.
  ⚠ The per-ticket "Post as comment" (`TicketPostControl`, `usePostTicketAnalysis`,
  `api.postClaudeTicketAnalysis`) is DELETED, and `test/claudeReviewFollowUp.test.ts` fails if any of
  them comes back. On the Open PRs panel story findings count in the severity pills like any finding;
  the story alignment pills are unchanged.
- **Auto review** is `AutoReviewSection` over the CORE `GET`/`PUT /api/workspaces/:id/auto-review`
  (`hooks/useWorkspaceAutoReview.ts`), mounted on `ai.enabled`. OFF per workspace until switched on.
  - **Design diagrams** ride the SAME section and Save: "Draw a design diagram after each review"
    (`autoDiagramsEnabled`, ON by default; only a stored false reads off). ⚠ NOT dimmed by auto review
    — a diagram follows EVERY review, yours or automatic. Sent only when changed. The ⓘ says it saves
    about a third of Claude's review usage; the Design ⓘ in the review tab says it can be turned off.
  - **Auto-posting** lives in the SAME section and the SAME Save (`autoPost` on the auto-review route;
    only a changed `autoPost` is sent): the master switch "Post Claude reviews to GitHub
    automatically", a "Which PRs" radio pair (`'mine'` — "PRs you are asked to review, and your own"
    — or `'all'`) and one checkbox per kind (`KIND_ROWS`). ⚠ DIMMED, NEVER DISABLED: the scope and
    kinds dim (`opacity-60`) while the master switch is off and stay editable, and the whole block dims
    while auto review is off (it acts on auto runs only, which the hint line says). The facts (posts as
    you, COMMENT only, counts as your review, never twice, never on merged/closed/draft/bot PRs, team
    requests do not count, failures stay visible) sit behind one `InfoButton`, not in the copy.
  - **Approve by impact**: under "Approve or request changes for me", an "Approve" fieldset with one
    checkbox per blast-radius level (`IMPACT_ROWS` — "High / Medium / Low impact PRs", all ticked by
    default; `autoPost.approveImpact`, stored overrides-only). It dims with the verdict switch and
    stays editable. An unticked level turns an auto APPROVE into a comment-only review; REQUEST_CHANGES
    is never held by it. ⚠ The level is the SAME one the PR's chip shows — the server folds it through
    the ONE shared `blastRadius()` with the account's dial — and a PR with no level counts as HIGH. The
    ⓘ says both; the surface carries only the labels.
  - **Approve with open findings** (migration 0145): under Approve, three radios (`LEFTOVER_ROWS`:
    nothing / nits / nits and questions — the default; `autoPost.approveLeftovers`), dimmed with the
    verdict switch, ⓘ beside the legend. **When Claude and Codex disagree** (`pairStrictness`: Strict
    — the default — / Relaxed) renders ONLY while both are signed in (`pairReviewReady`,
    `lib/aiCapabilities.ts`), under "Auto reviews use", NOT dimmed by the verdict switch (it also
    sets a manual pair's suggested verdict); its ⓘ explains strict vs relaxed for two agents.
  - **"Not approved: …"** (`lib/autoPost.ts` `notApprovedLine`): ONE line under the review's verdict
    in the AI Review tab header — the server's `ClaudeReview.notApproved`, else the record's
    `reasonText`; "… Posted on GitHub." when it went out alone. `autoVerdictLine` no longer repeats a
    reason in the Post section; the replies line (`repliesCheckLine`) appends a pass's `notApproved`.
  - What it did is shown where the posts are: `lib/autoPost.ts` `postedChipLabel` turns a finding's
    "Posted" chip into "Posted automatically · <time ago>" (`ClaudeFinding.postedAuto`), the Post to
    GitHub pill does the same off `ClaudeReview.autoPost`, and `autoPostFailureLine` prints ONE amber
    "Couldn’t post automatically: …" line above the summary box for a `failed` / `partial` record
    (the Post button stays — a skip prints nothing). Story check: `postedLabel` reads
    `TicketReviewItem.posted.auto`, `notRequestedPostedLabel` marks a "Not asked for" row from the
    run's `autoPost.notRequested` by index, and `TicketResults` carries the same failure line. Pinned
    by `test/autoPost.test.ts` (copy + the mounts).
- **"Review threads"** (`ClaudeReviewThreads.tsx`, mounted once in `ClaudesReview` after the
  follow-up) renders `ClaudeReview.threadAssessments` — other reviewers' open threads the run judged
  ([CLAUDE-REVIEW.md](CLAUDE-REVIEW.md) § Other reviewers' threads). `null` renders NOTHING (the run
  did not assess); `[]` prints "No other review threads.". Header pills from the server's
  `threadAssessmentCounts` (zeros dropped). Order and colours are pure helpers in
  `lib/claudeReviewFollowUp.ts` (`partitionThreads`, `THREAD_*_CLASS`): shared `isThreadToFix`
  first, then other open ones, then not checked; addressed / not-valid rows (`isThreadSettled`)
  behind "Show N more" — a to-fix row is never hidden. A not-valid comment's addressed pill is grey (`threadAddressedClass`), never red. path:line opens the thread in the Changes tab, scrolled to it
  (PrDetail's `showThread`: the Changes tab, scrolled to the thread); the GitHub link goes through `safeExternalUrl`; every comment
  and Claude string is plain text. `draftReply` offers Copy only — no route posts it.

### The AI spend budget on screen (`components/AiBudget.tsx`, `lib/aiBudget.ts`)

ONE query, `useAiBudget` (`['ai-budget']`, account-grained, no `ws:` segment, polled every 2 minutes
while the tab is visible), feeds every surface below; the decision is the server's (`ai/budget.ts`),
`lib/aiBudget.ts` only words it.

- **The header usage item** (`components/AiUsageMenu.tsx`, beside the light/dark button; shown while
  `me.ai.enabled` and `usage.route !== 'none'`): ONE figure from `headerUsageOf` — budget on (subscription):
  Limn's used share ÷ its limit, the week or the 5-hour session, whichever is closer (the title says
  which; over budget, the one the server's `limitedBy` names); budget off: Claude's own whole-account
  weekly figure; API key: % of the weekly US$ budget, or this week's US$ with none set. Each figure has
  its own label ("AI quota for Limn:" for a budget, "Claude this week:" for the account figure, "Limn AI,
  last 7 days:" for unbudgeted API spend) — never a bare "Claude", which read as Claude's own quota. The label is
  screen-reader only (and in the title): the item SHOWS just the icon and the figure, at every width. Click → a `role="dialog"` popover (Escape / outside click close it;
  a click inside the ⓘ's portalled popover does not)
  built by `usageDetailsOf`: ONE BLOCK PER PROVIDER IN USE — the default's (`status` + `usage`), then
  each of the response's `others` (every other provider signed in or run this week), each from
  `usageDetailOf` and laid out the same: the heading ("Claude Max 20x", "Codex · ChatGPT Plus"), Limn's
  share of this 5-hour session and of this week, runs and tokens this week, the provider's own account
  windows as used / left / resets, "Updated N min ago"; one link to Settings → AI spend at the foot.
  Each share or window row has a bar under its text (`UsageRow.barPct`): Limn's rows fill against the
  reader's LIMIT, or — no limit set — against 50% (`limnShareScale`; `AI_BUDGET_SHARE_MAX`, the most
  Limn can be given; the value reads "· max 50%", the ⓘ beside the first heading says nothing pauses
  until a limit is set); the account rows show the provider's own % used; amber from 80%, red at 100%;
  counts (runs, tokens) have none. Limn's rows carry one note under the bar (`UsageRow.note`,
  `windowNote`): "Resets Thu 09:00" when the provider told us the reset, else "Last 7 days" / "Last 5
  hours". The popover scrolls past the viewport height. ⚠ Unknown pieces are LEFT OUT, never shown as
  0; a subscription block carries no US$ (an API-key block keeps its US$ rows and draws a bar only
  against a set weekly budget — an API key has no allowance to scale against).
- **A run's cost** (Claude Review's meta line and live estimate, Docs chat, Ask Claude about this
  sprint): ONE wording, `useRunCostText()` → `runCostText(costUsd, usage, runProvider)` — a run of the
  non-default provider is judged by that provider's own reading (`usageForRun`). API key: US$. Claude
  subscription: "0.3% of your week" from the server's `usage.weekPctPerUsd` rate (the frontend holds no
  estimate table); unknown subscription or no answer yet: nothing. ⚠ Never call `formatUsd` on a
  Claude run's cost directly. Bot prices and Chronology's hourly cost are not Claude runs and keep US$.

- **The meter** (`AiBudgetMeter`, mounted by `AiRunGate` beside every Run button while the budget is
  on): "Limn: 2% of your week · limit 5%" on a subscription, "This week $4.10 of $25" on an API key,
  "Limn: pick your subscription" while it is unknown. ⚠ A subscription is worded in percentages
  only — never a US$ figure.
- **The toast** (`AiBudgetToast`, in the ONE header strip): "Limn has used its share of your week.
  Automatic runs resume <day, time>." (`limitedBy: 'five_hour'`: "…its share of this 5-hour
  session…"; API key: "…its weekly budget…").
- **The second press** (`OverBudgetConfirm`): over budget, only the gate's RUN control (`data-ai-run`,
  else the only button) is held once and armed for 15 s; an ⓘ / Discard beside it works as usual.
- **Settings → AI spend** (`ClaudeSpendSection`): subscription = the share (1–50 %), the
  subscription (shown when Claude's report settles it; else a picker of `status.subscription.pickFrom`
  — the Max pair for a reported "max"), "Limn has used X% of your week" and "about N automatic
  reviews a working day" (the SAVED share's figure; hidden while the share is edited). The 5-hour
  share FOLLOWS the weekly one: a collapsed `<details>` "Set a separate 5-hour limit" (open when one
  is stored) holds its box; empty = `fiveHourSharePct: null` = same as weekly, "Use the weekly share"
  clears it (draft/body in `settings/claudeSpendForm.ts`). API key = "Weekly budget (US$)", no 5-hour
  setting. The explanation is behind the ⓘ.

### The AI Fix tab (`AiFixTab.tsx`, `components/AiFix/FixPicker.tsx`, `components/AiFix/FixReport.tsx`)

Backend contract: [docs/CLAUDE-REVIEW.md](CLAUDE-REVIEW.md) § AI Fix.

- **One entry point: the FIX PICKER.** The review is the one handed over from the Claude Review tab
  (`aiFixTabFocus.reviewId`, consumed into local state) or else the PR's latest review when it
  succeeded (`useClaudeReview`). No succeeded review ⇒ one line + "Open Claude Review"
  (`setPrDetailTab(pr.id, 'claude_review')`). Otherwise `useAiFixPreview` (`['ai-fix-preview', prId,
  reviewId]`, invalidated by a start) lists the server's items as toggleable cards grouped by
  section; the reader's ticks are OVERRIDES over each item's `defaultIncluded` (reset when the
  review changes), and Start sends `{seed:'review', sourceReviewId, include: pickedKeys(…)}`.
  `budgetCutKeys` re-folds the server's budget over the ticked items in the preview's order and marks
  the cut ones "Won't fit". With a finished fix on screen the picker folds behind "New fix".
  ⚠ **EACH ITEM IS THE CLAUDE REVIEW TAB'S OWN CARD** — `FindingRow`, `FollowUpRow`, `ThreadRow`,
  `CiFailureRow`, `CriterionRow`/`MissingRow`, each with `actions={false}` (no Post / Reword / Copy /
  chat pin / Ignore / reply buttons) and a real, `aria-label`led checkbox in its `selection` slot.
  Never copy a card's markup into the picker. The server names the card (`AiFixPickerItem.card`);
  findings and earlier findings join the SOURCE review (the latest, or `useClaudeReviewById` for a
  hand-over), ticket gaps join Story check's `useTicketReviews` query — ⚠ that query holds each
  ticket's LATEST run of ANY status while the items come from the latest SUCCEEDED one, so a run id
  it does not hold is fetched by id (`useTicketReviewsByIds`, key `['ticket-review', id]`) — and an
  item whose data is not on hand draws the old plain row. The folds live in `AiFix/fixPickerModel.ts` (no JSX). The CI
  list, the AI summary and the "Or say what to fix…" box are GONE (the route still takes `plain`).
- **An automatic push that failed** shows the succeeded row's `error` ("Automatic push failed: …")
  in an amber line above the summary; Push still works and clears it.
- **`FixReport`** renders the validated `changeReport` under the summary and ABOVE the "no
  changes" branch (a run that judged every item wrong produces no diff, and that is the run whose
  "Not addressed" list matters most): per changed file the summary and ref chips labelled with the
  section (`AI_FIX_REVIEW_ITEM_LABELS`) and the item's title; then Not addressed (reason), No report,
  and Left out (items over the prompt budget). A Finding chip is a button that opens the Claude
  Review tab and scrolls to `claude-finding-<id>` once it renders (gives up after ~3s — an older
  review's finding is not on screen). A file in the diff with no entry says "No summary reported."
- **The tab carries almost no prose.** How the fixer works lives in ONE `InfoButton` beside the "AI
  Fix" title, and one more on Changes / Left out. "Not built or tested here." stays ON SCREEN,
  folded into the diff header beside the file count — never moved into a popover. A row from a
  removed seed prints one source line ("Fix from picked comments (no longer offered).") and its diff.

---

## The calm-consolidation surfaces

**Default landing = OPEN PRS** (Pending until 2026-10-09). The rail reads Open
PRs · Pending · Feed · Bots · Reports and its top entry is what opens. `activityRepoId` defaults to
`'open-prs'`, the ONE rail value omitted from the URL; `'attention'` and `'feed'` are EMITTED and
PARSED so a Pending or Feed link survives. An unknown or legacy value (`compare`, garbage) and a URL
naming no console land on Open PRs — except a legacy Pending link carrying `attn*` keys, which still
lands on Pending. The Feed is the stream alone (`FeedView`). (The landing was the Feed from
P3.1 until Pending took it.) The Insights rail entry is
relabelled **"Reports"** — ⚠ LABEL-ONLY: the store/URL token stays `activityRepoId ===
'insights'` (it is wire/URL-visible across `useUrlState`, FilterBar; renaming it buys nothing
but broken deep links).

- **The daily-brief strip is DELETED** (it duplicated Pending line for line). What stays:
  `GET /api/daily-brief` + `useDailyBrief` (the Welcome-back banner and the Workspace badges read
  it through `useMyTurnByWorkspace`; it still refetches in lockstep with `['attention-cards']` /
  `['work-plan']`). Gone with it: `openBriefLine`, the "Elsewhere" roll-up,
  `myTurnOtherCapDisclosure`, `ciFailingCapDisclosure`, and the Feed's bot-anomaly / red-trunk
  lines (red trunks show atop Activity → Open PRs; bot anomalies on Bots). The synthesis seam's
  `kind:'brief'`/`'rollup'` narration was removed 2026-10-18.
- **`BotTriageCard`** (`components/BotTriageCard.tsx`): the per-PR verdict sentence —
  "N bot comments: X real issues · Y likely addressed · Z nit-flagged — [Resolve]". The "real
  issues" segment reads the latest Claude review's STORED thread judgements
  (`useClaudeThreadJudgements`; the card never runs one) — without them it renders
  "X awaiting a look" from the derived-state rollup in that slot instead. Mounted
  TWICE (full atop the Changes tab's Threads only view, compact in the Overview attention area); renders ONLY at
  ≥5 union-bot review comments and issues NO extra query below the threshold (the
  ThreadAssessment 60-empty-boxes lesson) — everything it reads is already shared (the
  workspace-reviewer listing, the per-PR ML label index, the batched thread-judgement read — the
  card can never bill). ⚠ Bot membership is the CLIENT MIRROR of the server's
  UNION set (workspace judgement wins both ways, the wire `User.isBot` fallback) — deliberately NOT the
  legacy login-string classification PrDetail's bot chips still use; and every figure comes from
  the SAME folds the Threads only view uses (`rollupCounts`/`threadSeverities`/
  `resolvableBotThreadIds`) restricted to the bot subset, so card and tab cannot disagree.
- **Bots view is `ROI ('roi' = Measure) | Themes | Benchmark | Classification`** (`'settings'` LEFT
  the union long ago; `'advisor'` LEFT 2026-10-26 with the Bot Tuning Advisor; `'classification'`
  JOINED 2026-10-26 from the Feed, bullet below)
  (`botsInnerTab` lost `'behaviour'` — transient + URL-silent, so member removal is safe — gained
  `'benchmark'`, and has since REGAINED `'themes'`; see "The Bots Themes panel" below). `'themes'`
  is LISTED only while `me.ai.enabled` and `'classification'` only on the rail (`repoId == null`);
  both degrade to `'roi'` in `effectiveBotsTab` (render-only, never written back), and so does any
  value outside `BOTS_INNER_TABS` (a stale `'advisor'`). Inside `BotRoiPanel`:
  the vendor table, its keep / tune / rarely used verdicts (the label for the `noisy` verdict id),
  the **Inflation column** (the weekly sparkline stays separately conditional on
  `mlInflation.weekly`, an extra scan width — as does `InflationHistoryChart`, the enlarged twin of
  that sparkline in this panel's chart row, on the same field and the same `showMlColumns` gate;
  contract in docs/ML-SEVERITY.md § The enlarged inflation chart), the deterministic **"What the
  bots are flagging"** ML totals strip (`MlTotalsStrip` — no AI), the volume column and every
  drill-down. ⚠ The AI report titled **"What they're flagging"** LEFT this panel and is the
  `Bots → Themes` sub-tab — which is also what pulled the two near-identical headings apart: they
  used to sit on one screen, and now cannot. Around it, in `BotsView`: the amber bot-only
  governance caution, the resolve backlog, the **hoisted `TuningSuggestions` box** (moved OUT of
  the panel — do not move it back; it sits ABOVE the table) and the bot feed. (Until 2026-10-22 the
  whole Bots Monitoring pane was Pro, visible-but-locked; the locks, badges and gated hooks are
  gone.)
- ⚠ **`BotRoiPanel`'s `$/acted-on` COLUMN IS A GRAIN GATE: `showCost = repoId == null`.** A price
  is stored ONCE PER WORKSPACE, so dividing a whole month of it by ONE repository's work reads as
  spend and cannot be summed across repos — the same argument that deleted
  `BotBenchmarkPlacementUnit.cost`. The RAIL mount keeps the column and its footer instruction (that
  data is already workspace-grained and therefore already exact); the per-repo mount loses the
  `<th>`, the `<td>` and the "set a monthly price" clause, and gets a REPLACEMENT sentence naming
  the reason and pointing at the rail — an elision alone reads as a bug or a permissions glitch,
  and invites the next reader to "restore" the column. ⚠ **Do NOT simplify `showCost` to `true`.**
- **Bot classification is a BOTS MONITORING tab** (`?activityRepo=bots&botsTab=classification`,
  rail only). It was the Feed's "Bot classification" sub-tab until 2026-10-26; the Feed has no
  sub-tabs now (`feedInnerTab`, `FEED_INNER_TABS` and `Activity/feedTabsModel.ts` are deleted). ⚠
  Two legacy URLs land here, both mapped by `readFromUrl`: `?activityRepo=feed&feedTab=classification`
  (→ `activityRepo='bots'` + `botsInnerTab='classification'`) and `?activityRepo=bots&botsTab=settings`.
  `feedTab` stays in `NAV_KEYS` (parsed, never emitted), like `attnPersonal`. It mounts
  `BotSettingsPanel` →
  `DetectedReviewersTable`: one CARD per bot in a responsive grid (1 column on a phone, 2 from `md`,
  3 at `2xl`) — the account's own GitHub avatar (an App bot's avatar IS its vendor logo; `... on Bot
  { avatarUrl }` is selected by the sync queries for this), else a monogram tile on the vendor colour
  whose text colour is picked by contrast (`lib/botAvatar.ts`); name + login; Role and vendor chips;
  the vendor colour as a thin LEFT accent (non-text use only); a person-judged row drawn muted. Then
  the controls: Counts as Bot | Person, Role + the explicit **Apply role** button, Vendor + label +
  Save name, the two resets. The PRICE editor ("Price for this Workspace") and the workspace total
  sit on the card too. Tests: `test/botsBenchmark.test.ts` (the derive), `test/botAvatar.test.ts`,
  `test/urlHistory.test.ts` (both legacy URLs).

### Bots → Benchmark (the peer-cohort placement)

`BenchmarkPanel.tsx` + the pure `benchmarkModel.ts` + `hooks/useBotBenchmark.ts`, mounted by
`BotsView`'s `BenchmarkTabBody`. It renders `GET /api/pro/bot-benchmark/placement` — this
workspace's (repository × reviewer) units, folded over the CORPUS's own metric definitions, placed
in a per-vendor activity band and ranked against the fitted cell. Tests:
`apps/frontend/test/botsBenchmark.test.ts` (**hand-run — `apps/frontend/test/` is not in CI**).

- ⚠ **ONE COMPONENT, TWO BODIES, AND `repoId` IS WHAT PICKS ONE.** `BenchmarkPanel({repoId})`
  computes `isRail = repoId == null` and passes it into `Body` **as its own prop** — deliberately
  NOT `data.rollup != null`, so a version skew (an older build serving no rollup) cannot silently
  change which screen the reader believes they are on.
  - **RAIL (`repoId == null`)**: header meta → truncation note → `FindingsSection` → **the ROLLUP
    CARDS** → absent metrics → `MeasuredDisclosure` → disclosures. **NO `UnitCard` renders here.**
  - **REPO TAB (`repoId != null`)**: exactly what it always did — one `UnitCard` per unit, with its
    thirteen metric strips, band placement and refusals — **MINUS money entirely**. The old
    `CostBlock` is DELETED, not hidden: `BotBenchmarkPlacementUnit.cost` is off the wire, and a
    `?repoIds=`-narrowed request receives no `rollup` either, so there is no figure in the payload
    for a future renderer to find. See [docs/PLATFORM.md](PLATFORM.md)
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
    Bots Monitoring → Classification.
  - The truncation note's remedy clause ("open a repository's own Bots tab", plus the sentence
    saying money is withheld while counters and spread still render) is **rail-only**; on the
    repository tab that advice is a no-op, and it shipped unconditional.
- It is the only place in the product that answers "is this bot NORMAL?" — the tab is always
  listed (`benchmark-panel`).
- ⚠ **THE VISIBLE TAB IS DERIVED AND `'benchmark'` IS NEVER CORRECTED.** `effectiveBotsTab()`
  (in `benchmarkModel.ts`, so it can be tested without a renderer) degrades only `'classification'`
  (off the rail), `'themes'` (AI off) and a value outside the union; `?botsTab=benchmark` is parsed off `BOTS_INNER_TABS` itself.
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
  measured" disclosure (`useBotBenchmarkSpecs`) is CLICK-GATED (`enabled: open`) —
  the Pending-board precedent, where an eager per-card fetch became 150 GitHub calls.
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
  [docs/PLATFORM.md](PLATFORM.md) § "The WORKSPACE ROLLUP" (the
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
  `stale` flag → badge + Regenerate, nothing regenerates on its own); with AI off the card renders
  nothing and fetches nothing (`useSynthesis(…, aiEnabled)`, `me.ai.enabled`). Mutation keys share the canonical
  scope-key segment so two mounts of one scope share in-flight state.
- **Reports pane (`PeriodReportsPanel`)**: Reports-FIRST — `InsightsSubTab` and the whole
  sub-tab apparatus are deleted. (The ad-hoc chat that lived INSIDE the report, "Ask about this
  period", was REMOVED 2026-10-22 with its routes, hooks and store slices — `sprintChatDraft` /
  `sprintChatThreads` were transient, so no storage bump.) New: the "**By workspace**" axis (the folded
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
- **People / 1:1 prep — REMOVED 2026-10-22.** `PeriodPeopleSection` (the Reports People picker),
  `PeopleReportDetail` (the ephemeral `people-report` tab, never persisted and never in the URL),
  `PersonPeriodSection` (the contributor tab's 1:1 prep) and the popover's "1:1 prep →" are deleted,
  with `usePersonPeriod`, `lib/peopleReport.ts`, the `peopleReportSeed` slice and the client's
  `personPeriod` / `botAuthoring` methods. `hooks/useMemberSections.ts` STAYS — FilterBar's Members
  dropdown builds from it. A hand-typed `?insightsTab=people` lands on Reports → Overview
  (`test/urlHistory.test.ts`). The `user-activity` tab is the contributor's feed only.
Deleted outright with this wave: `BotBehaviourPanel`,
`WorkspaceComparisonPanel` + `useWorkspaceComparison` + the `'compare'` rail value (no longer
URL-parsed — a legacy `?activityRepo=compare` link lands on the rail default, now Open PRs),
`SprintReportCard` + `useSprintReport`, `lib/workspaceColors.ts`, and `InsightsSubTab`.
(`BotThemesPanel` + `useBotThemes` were deleted here too and have since been RESTORED — see
"The Bots Themes panel" below. ⚠ `botsInnerTab` HAS since regained a `'themes'` member: the panel
was first restored as a card at the top of the ROI view and then moved onto its own sub-tab.)

### The Bots Themes panel — `Bots → Themes`

`BotThemesPanel` is the whole body of the `'themes'` sub-tab, mirroring the Feed rail's
`Feed | Themes` strip. The three drill-down `SynthesisCard` mounts (`BotVolumeDetail`,
`BotFlaggingDetail`, `BotThreadsDetail`) are untouched and still serve slice-scoped Summarise, and
`MlTotalsStrip` — the deterministic "What the bots are flagging" severity totals, a different
surface with a confusingly similar heading — stays INSIDE `BotRoiPanel`, on the same
windowed `/api/bot-analytics` response as the columns beside it.

⚠ **THE TAB IS LISTED ONLY WHILE `me.ai.enabled`** — a model writes the report, so with AI off an
always-listed tab would draw a blank pane. The panel's own gate is the same single `aiEnabled`
check (`useAiCapabilities()`), and `effectiveBotsTab` degrades a stored `'themes'` to `'roi'`.

⚠ **NO WINDOW PICKER, AND NO HEIGHT CAP.** The panel reads `botAnalyticsWindow`, whose one writer
is the picker inside `BotRoiPanel` (which argues on the record against being hoisted); a second
window field would let the cached report and the rest of the Bots console disagree about the
population. If the missing control ever proves painful, hoist the picker to the STRIP so every
sub-tab shares one — never duplicate the field. The body's old `max-h-[32rem] overflow-y-auto`
wrapper is gone with the move: it existed so a long report could not push the deterministic
Measure surface off screen, and nothing sits beneath the panel on its own tab.

⚠ **IT WORKS ON THE PER-REPO BOTS CONSOLE TOO**, unlike `'classification'`. `BotsView` passes `repoScope`
(`[repoId]` on the console, `null` on the rail), the client gives the narrowed report its own
cache slot via `repoKeySlot`, and the platform's `scope_key` carries the matching `|r:` suffix — so a
repo's Bots tab gets its own real report rather than the workspace's. `showThemes` is therefore
`me.ai.enabled` alone, never `repoId == null && …`.

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
— the two-slot rule from `useBotTriage`, and the `ws:<id>` segment is the same string the platform
persists as `scope_key`. ⚠ `useRefreshBotThemes` shares its MUTATION key per scope
(`useIsMutating`), because a board switch mid-run unmounts the panel and a per-mount `isPending`
would reset the button to "Generate" while the Haiku run is still in flight — the
`CiAnalysisCard` lesson. The `setQueryData` write must build the key the same way as the read
(one `workspaceKey` + one `repoKeySlot` call each) or a Regenerate appears to do nothing until
the next refetch.

### This Sprint (a fixed tab — formerly "Activity → This Sprint")

**REDESIGN (2026-10, docs/redesign/DESIGN.md).** One page header (`text-display` "This Sprint", then the
shared `Tabs` — `1`–`4` switch them); a compact toolbar (sprint name + ⓘ, dates · tickets; Ask / Statuses as
ghost buttons, Refresh secondary); quiet cards (surface tone, no border; MARKS not borders — below);
hairline lane rules, no zebra. ⌘K while the board is up (`SprintCommands` in SprintView): Refresh,
Ask, Statuses, both filters, and every ticket ("PLAT-292 · title" shows its story in the tray). ⚠ A
PHONE (`useIsPhone`) gets `StackedLaneBoard` (LaneBoard.tsx): lanes down, each lane's columns down,
cards two to a row, the Complete toggle as a line above, and the ARROWS as a VISIBLE numbered
"Dependencies" list (every sentence) — a routed arrow cannot cross a stack. 768–1023: the grid in
narrow mode, columns ≥ 9rem, scrolling sideways in its own box with snap. The story tray is a
FULL-SCREEN sheet on a phone (Back, top left), a right sheet md–lg, the sticky column at lg+.

(The heading keeps its old name because links point at it.) This Sprint is a **FIXED TAB** beside
Activity — strip order Activity · This Sprint · Timeline; `activeTab === 'sprint'`, `?view=sprint`,
rendered by `components/Sprint/SprintTabView.tsx` in its own `sprint-overlay` (App.tsx). It was an
Activity rail line under Pending (`activityRepo: 'sprint'`) until 2026-10-20; `'sprint'` LEFT the
`activityRepoId` union and the rail entry is gone. The agentic part ("Ask Claude") is gated on
`me.ai.enabled` through `useAiCapabilities()`.
Viewing any of the three views stamps `sprint_reads.viewed_at`, which is what lets the worker read the
sprint. The API route keeps its old name (`GET /api/sprint-graph`); only the SPA's wording changed.

- **No tracker ⇒ the three boards show ONE line** — "Connect Jira, Linear or GitHub Issues to see this
  sprint." with a **Set up in Settings** button (`Sprint/SprintTrackerSetup.tsx`), drawn by SprintView on
  the graph's own `trackerOn: false`. The button calls `openSettings('issue-tracker')`
  (`store/settingsModal.ts`), and the modal opens on its Integrations tab, then scrolls to and focuses the Issue tracker heading
  (`ISSUE_TRACKER_SECTION_HEADING_ID`). The section renders a pending shell until its own GET answers,
  which on a cold cache can take seconds, so the modal WAITS for the heading (a `MutationObserver`, for
  as long as it is open) and gives up the moment the reader scrolls, clicks or types — a late jump must
  never yank them mid-scroll. ⚠ A fixed frame budget (the first cut: ~60 frames) silently did nothing
  on a slow server. The explanation sits behind the ⓘ. **Merged so far needs no
  tracker** and is unaffected.
- **The scroll position is REMEMBERED per tab** for the session (`hooks/useRememberedScroll.ts`, keyed
  `sprint:<tab>`): the tab's overlay is one scroll box shared by its sub-tabs and the board unmounts
  when another screen shows, so Back or re-opening the tab used to land at the top. It
  restores once the box is tall enough (the board arrives after mount) and stops the moment the reader
  scrolls, or after 4s. Module memory only — not persisted, not in the URL.
- **Four tabs, DERIVED, never written back**: Theme (the landing tab, since 2026-10-18) · Critical path · People · Merged
  so far. The store's `sprintInnerTab` (`'paths' | 'themes' | 'people' | 'merged'`) is mirrored to
  `?sprintTab=paths|people|merged` (the `'themes'` default omitted, the key emitted ONLY beside
  `view=sprint`); the render reads `effectiveSprintTab` (`Activity/sprintRailModel.ts`), the
  `botsInnerTab` / `insightsTab` rule. URL only, so no `FILTER_STORAGE_VERSION` bump.
- ⚠ **Legacy links still land ON THE TAB** (`landingTabFromUrl`, test/landingTab.test.ts +
  test/urlHistory.test.ts): the rail line's `?activityRepo=sprint` (with `view=activity` or no view;
  its `sprintTab` kept), and the older Reports tabs' `?insightsTab=sprint|merged` (only when the link
  names Reports or no rail) → Theme / Merged so far. The retired force graph's `?sprintTab=graph` reads
  as Theme (`sprintTabFromUrl`, store/filters.ts). None is written back.

- **THE FORCE GRAPH IS DELETED (2026-10-18)** — `SprintGraph.tsx`, `sprintGraphModel.ts`,
  `SprintPathsStrip.tsx`, `sprintReferences.ts`, the `.sprint-canvas` CSS and their tests, with the
  group-by, split, filter, "2 hops", pinning and zoom controls. ⚠ Do not bring a canvas back: the three
  views below are the ONE way the sprint is drawn. test/storyView.test.ts scans that nothing imports them.

- **THE LANE BOARD** (`components/LaneBoard.tsx`, pure layout `lib/laneBoard.ts`,
  test/laneBoard.test.ts) — ONE renderer for all three views, built from the DESIGN GRID's pieces (§ Design
  diagrams), so the app draws one way:
  - **COLUMNS are `statusLayout.columns`, verbatim** — the workspace's status buckets in order (the gear's
    bucket editor): Not started, In progress, **Code review**, **Product review** (QA and other sign-offs —
    a FIRST-CLASS bucket now; the derived "Merged, not signed off" column is GONE), Complete. A ticket's
    column is `SprintGraphNode.column`, computed ONCE in the server's fold (its bucket, or the first
    Product review bucket when the merge rule moves a Code review ticket whose PRs have all merged) — the
    SPA never re-derives it. Two pseudo-columns appear only when a card needs one: "Outside the sprint"
    at the LEFT (Critical path only) and "Status not known" at the right. Each header shows its card
    count. ⚠ **A Complete bucket (meaning `done`) is COLLAPSED by default** — a narrow column of per-lane
    counts and a "Show" button (`aria-expanded`) that opens the whole column. **Each lane's "n tickets"
    is its own button** (`onToggleCell`, `layoutBoard`'s `expanded` set of `cellKey(lane, column)`): it
    opens THAT lane's cell only — the cell's first row becomes "Hide", its cards sit below, the column
    takes a full track (`widened`) and arrows route to them; every other lane keeps its count. Each view
    keeps its own open sets, in component state. A collapsed cell draws no arrows.
  - **LANES** down, each as many grid rows as its fullest cell (cards stack inside a cell; `layoutBoard`).
    An empty lane is not drawn. Lanes alternate a faint ground under a rule. The lane label is a side
    column; below 760px it moves to a band heading above the lane's cards, as the design grid's layer
    names do. Below the columns' minimum widths the board scrolls INSIDE its own box, never the page.
  - **ARROWS** are `depends_on` edges between two DRAWN cards, FROM the ticket waited on TO the one that
    waits, routed by `routeArrow` (lib/designGrid.ts) through the padded slots and grid gaps and
    re-measured by a ResizeObserver (`useRoutedArrows`; it re-renders only when the drawing changes, so a
    caller's un-memoised arrays cannot loop). A critical arrow is the accent (`--ai-signal-fill`). A
    labelled arrow carries a number keyed in ONE line under the board (`ArrowKey`); arrows with the SAME
    words share a number. An sr-only list ("Dependencies") reads every arrow as "B waits on A: why".
    Hovering a line or its number shows the popover — HOVER / FOCUS ONLY, no pin (§ Design diagrams →
    Arrow popovers). Above the arrow key, `BorderKey` (`components/LaneBoard.tsx`, the SAME component the
    design grid's key uses) names each card MARK the board draws ("Card marks"), each with the card's own icon or ground
    (`ticketCardMarks` / `ticketCardSurface`, `sprintBorderKeyItems`). ⚠ `useRoutedArrows`, `ArrowLayer`, `ArrowKey`,
    `BorderKey` and `ArrowList` are SHARED with `DesignGrid`, which kept its look; change them for both or
    neither. ⚠ The SAME border means different things on the two surfaces (dashed accent = waiting here,
    "Changed" on the design grid) — which is why each surface draws its own visible key.
  - **ONE CARD, `TicketCard`** (`components/TicketCard.tsx`), for every view, ⚠ **ONE HEIGHT whatever
    it carries** (the title reserves two lines, the one-liner, the criteria line and the person-or-theme
    line one each — an EMPTY SLOT IS HELD OPEN —, the tag row is one 20px line — a tag that
    does not fit is cut on the face and stays in the accessible name; a 2px border gives back 1px of
    padding): the key (mono), the title, the brief's
    **ONE-LINER** (`brief.oneLiner`, ≤ 90 chars from the brief pass v5; one line, truncated, the full
    line in the accessible name and the `title`), the **CRITERIA LINE** (`ticketCardCriteria`:
    "3 of 4 criteria met" from the latest SUCCEEDED ticket check, `node.check`, whose own criteria list
    is the denominator; else "4 criteria" / "1 criterion" from the current brief; else empty; ITALIC when
    `check.stale` — the accessible name says "checked before the latest changes" in words; a
    small spinner while `checkRunning`), the **PERSON-OR-THEME LINE** — on Critical path and Theme the
    assignee's name in a PILL on its own line, full width, truncated with an ellipsis (full name in the
    accessible name and the pill's `title`); ⚠ spelled as the People lane spells them (`assigneeLabel` over
    `personIndex(people)`: the matched `SprintPerson.name`, else the tracker's spelling), so one person
    never reads two ways on the page; nobody assigned holds the line open with "Unassigned" (and the
    "No owner" tag is dropped there, never said twice). On People (the lane IS the person) the same line
    carries the ticket's theme, so every card on every view keeps one height —, then the tags as WORDS
    (`ticketCardTags`: "CI failing" on an open PR's red checks, "No PR" or "n PRs · m open" — closed
    unmerged ones ignored —, "No owner"). ⚠ **NO BORDER CARRIES MEANING** (the redesign, 2026-10): state is a MARK beside the key
    (`ticketCardMarks`) — the route (`CriticalPathIcon`, vermilion like the critical arrows) = on a stored
    critical path; the hourglass (`WaitingIcon`) = waiting on another unfinished ticket (`waitingIdents`);
    outside the sprint = RECESSED (`ticketCardSurface`: the page ground with a faint ring), whatever else
    it is. Cards are the surface tone, no border; the open-story arrow shows on hover/focus (always on touch). ⚠ **A CARD WITH A PULL REQUEST** (`hasLivePr`: an open or merged one — the PR
    tag's population; never a ghost) wears the PULL-REQUEST MARK before its key, top left (`data-testid="ticket-pr-dot"`, kept for
    history) — NOT a border or glow. ⚠ **PR cards are GROUPED FIRST in every cell** (`BoardCardDef.group`, 0 = has a PR):
    `layoutBoard` partitions stably, and `orderByLinks` sorts on (group, barycentre, place) so the
    link ordering works WITHIN a group and never lifts a card without a PR above one with a PR — on
    Critical path too, where a cell's PR cards come first and path order follows. `BorderKey` names
    the mark "Has a pull request" when any card wears it. Its accessible name says all of it. ⚠ **A click
    opens the STORY TRAY beside the board** (`Sprint/SprintStoryTray.tsx`; the StoryPeek popover is
    DELETED): an `<aside>` on the RIGHT rendering EXACTLY the story tab's content — the ONE
    `Ticket/StoryViewBody.tsx` the tab mounts too (§ The story view), never a copy — under a header with
    the key, **"Open story tab"** (`useOpenStory`) and a close X. The open card wears a sky RING
    (`aria-pressed`, `aria-controls` = the tray; never the border, which carries meaning). ⚠ **STATE IS
    `sprintStoryIdent`**, a transient filter-store field (never in `FilterDefaults`), mirrored to
    `?sprintStory=<ident>` — a NAV key, emitted only with `view=sprint` on a board sub-tab (not Merged so
    far), so Back closes it and the link reopens it; `setWorkspace` clears it. Escape closes it (capture
    phase, stepping aside for a typing target, an open popover — `hasActivePopover` —, a modal or an
    `ESCAPE_OWNER_ATTR` control) and focus returns to the card. Wide (`lg`): a sticky column beside the
    board, its own scroll; the board narrows and scrolls sideways in its own box (the arrows re-route on
    resize). Below `lg`: a sheet over the right of the page. Its reads are the story view's own, and it
    mounts only after a click — nothing on the board fetches on mount. ⚠ **Other ticket links ON THIS
    PAGE open the tray too** — call-out keys (`actions.onSelect`) and `TicketRefLink` in an Ask Claude
    answer (or in the tray's own ticket text) through `StoryOpenOverride` (`lib/ticketTab.ts`, read by
    `useStoryLinkOpener`), which SprintView provides; elsewhere nothing is provided and a link opens the
    TAB. `useOpenStory` stays the ONLY way to open the tab. **The card's corner arrow** opens the story
    TAB directly.

- **CRITICAL PATH** (`SprintPathsView`, `Activity/SprintBoards.tsx`; state fold `sprintPathsModel.ts`):
  1. **The pace strip** — CODE's `pace` (`paceItems`), every figure with its denominator: "Day 4 of 14"
     with a time bar, "Code merged 21 of 55", "Product review 15 of 55" (`pace.productReview`; only when
     a Product review bucket exists), "Complete 17 of 55", "Open dependencies 6 in 3 chains".
  2. **"Critical paths"** (ⓘ beside it) — one lane per STORED path (`pathsBoard`; by PR count, ties
     riskiest first as stored), its header the risk as a WORD chip ("High risk" / "Medium risk" / "Low risk"), the title and
     the one sentence of advice; its tickets on their columns, every arrow on it critical. A ticket
     outside the sprint sits faint in "Outside the sprint". The state line (`sprintPathsView`, the server's
     `pathsStatus`): "Working out the critical paths…" with a small bar while `writing`; when they will
     come (`queued` / `waiting`) or why they could not ("Couldn't find the critical paths. <reason> Limn
     tries again …"); AI off → "Claude is off here, so there are no critical paths."; none found → the
     heading reads "No critical paths in this sprint."; fewer than 4 sprint tickets → "Critical paths need
     at least 4 tickets in the sprint."; no Claude credential / runtime → the `AiRunGate` line; any other
     `none` → no heading at all (never a heading with nothing under it). A stored path none of whose
     tickets is on today's map draws no lane, and the board mounts only with a card on it. A column's
     header count is DISTINCT tickets (`BoardCardDef.unit`): a ticket on two paths is two cards, one
     ticket. ⚠ STALE paths are ALWAYS shown, with "Updating" or the failure line.
  3. **Call-outs** — Claude's (≤ 3, "Call-out") then Limn's own code cards from `signals` ("Since you last
     looked", "Out of step", "Blocked outside the sprint"; "Pace" is the strip, so it is not repeated),
     each with its ticket keys as buttons that open the story view.
  4. **The count table** (`countTable`) — every sprint ticket once, by theme (+ No theme) and column,
     with totals; rows key on the lane id.
  With no paths stored the pace strip, call-outs and table still show.
- **THEME** (`SprintThemesView`, `themesBoard`) — one lane per stored theme (by PR count, ties in the
  theme pass's order, largest first), then "No theme" for tickets no theme holds (⚠ never "Other": the theme prompt invites a
  catch-all theme of that name); no themes at all → one "All tickets" lane and
  one line saying why ("Themes appear after Claude reads the sprint." / Claude is off). Header: the
  theme's ONE-OR-TWO-SENTENCE SUMMARY (`SprintTheme.summary`, written by the themes pass — Claude, no
  numbers, what the work involves and whether it is development work; null on "No theme" / "All
  tickets"), then the colour bar per column. CODE's ROW LINES (shared `sprintLaneSummary`: "2 In
  progress, 3 Product review, 8 Complete" / "4 with a pull request, 9 without") are NOT printed under
  the name — ⚠ they live ONLY in the colour bar's popover (below), so the model's sentence is the one
  line of prose on the row and the code's counts sit apart from it. Sprint tickets only.
  An arrow is critical when its two tickets sit next to each other on a stored path; its key is the
  brief's `why`.
- **PEOPLE** (`SprintPeopleView`, `peopleBoard`) — one lane per assignee, ALPHABETICAL,
  Unassigned last. ⚠ Never by PR count or load ("prep, not scoring"): on 2026-10-26 the owner moved the
  Theme and Critical path lanes to PR order and kept People alphabetical. A person is
  `SprintGraphResponse.people`'s (shared `sprintMembers`), matched on the tracker spelling. Header: "n
  tickets" and, ONLY when `reviewsWaiting` is a number, "n reviews waiting" — null prints nothing, never
  0; then the same colour bar as Theme, whose popover carries the same CODE row lines (no model; nothing
  about the person the data does not show). Cards carry their theme.
- **ROW ORDER, EVERY VIEW** (owner decision 2026-10-26): lanes sort by their PULL REQUEST count — distinct
  PR ids of ANY state on the lane's DRAWN cards (`lanePrCount`, after the filters) — most first; ties keep
  the view's own order (risk / theme size / name); "No theme", "All tickets" and "Unassigned" stay LAST
  (`byPrCount`, lib/laneBoard.ts). Each lane header says its count ("n PRs"), so the order is checkable.
  The count table under Critical path follows the Theme order.
- **THE FILTERS** (`SprintBoardFilters` in `Activity/SprintBoards.tsx`, mounted by SprintView above
  every view; ⓘ beside them): two toggle chips (`aria-pressed`), "Has PRs" (≥ 1 PR of any state, closed
  included) and "Needs code" (a PR, or `codeJudgement.state` `code` or `pending` — the "needs code"
  judgement on Not started tickets, docs/CLAUDE-REVIEW.md § Sprint code judgements). Both on = both must
  hold. Pure rule `sprintCardFilter`; the boards take it as `keep` and drop the cards BEFORE layout
  (borders and "waiting" still read the whole sprint; a lane left empty is not drawn; a board left empty
  says "No tickets match these filters."). With one on, "n of m tickets" (sprint tickets). A PENDING
  ticket stays under Needs code with a muted "Not judged yet" beside its key (`TicketCard codeMarker`); a
  judged one's reason is the card button's tooltip (`ticketCodeNote`). AI off → every asked ticket reads
  `off`, so Needs code keeps PR tickets only, and the ⓘ says so. STATE: `store/sprintBoardFilter.ts`,
  localStorage ONLY (key `pierre:sprintBoardFilter`) like the Open PRs
  view choice — never the URL or `FilterDefaults`, so no `FILTER_STORAGE_VERSION` bump. The pace strip and
  the count table are NOT filtered (they count the whole sprint).
- **THE COLOUR BAR** (Theme and People headers; `SegmentBar`): a lane's tickets per column. Hovering or
  focusing it opens a HOVER-ONLY popover (`components/HoverPopover.tsx` — anchored, never following the
  mouse, `pointer-events-none`, closes when the pointer leaves) with CODE's two row lines (tickets by
  column; with / without a pull request — `data-testid` `lane-progress` / `lane-code`), then each
  part's swatch, column and count. The bar's accessible name carries the same two lines.
  Placed by `lib/avoidRects.ts` clear of the board's cards (`useBoardObstacles`). An arrow BETWEEN two lanes is a hand-off keyed "<person> waits on
  <person>"; one inside a lane keys the brief's `why`.

- **The toolbar**: the sprint's title + ⓘ ("Reading this sprint": the views, columns, the card's one-liner and criteria line, borders, Refresh, arrows),
  its dates (`sprintDatesLine`: "14 Oct – 27 Oct · day 1 of 14" from `sprintDates`, the day count from
  shared `sprintDayOf`; an end on midnight shows the day before; "due 28 Oct" / "starts in 2 days" /
  "ended"), "n tickets", Ask Claude, Statuses (the gear) and Refresh. Under it ONE thin progress bar
  (`SprintProgressBar`, `sprintProgress`): moving after Refresh until `read.checkedAt` moves (polled every
  2.5 s, 90 s cap), during the first read and a refetch slower than 400 ms; FILLING with the summarised
  share while briefs run; "Working out the critical paths" while the builder runs; still under reduced
  motion. Truncation and "Summarising n tickets…" are one muted line.
- ⚠ **THE BOARD REFRESHES ITSELF ON CHANGE, AND ONLY ON CHANGE** (owner decision 2026-10-22, "refetch
  on change"; the "The sprint has changed since you loaded it." line is DELETED). `useSprintGraph`'s
  `refetchInterval` is `false` once nothing is landing (it still polls during the first read, paths
  writing/queued, pending briefs and a running ticket check). `useSprintChangeToken` polls
  `GET /api/sprint-graph/token` (DB only) every `SPRINT_CHANGE_TOKEN_POLL_MS` (60 s), only while the This
  Sprint tab is mounted and the page is visible (`refetchIntervalInBackground: false`). Its first answer
  is SEEDED from the loaded graph's own `changeToken` (`initialData`, timed at the graph's fetch), so
  nothing fetches on mount. When a token read AFTER the graph loaded differs (`sprintTokenChanged`),
  SprintView re-fetches the graph AUTOMATICALLY (no tracker read, no ticket checks) — not while the
  reader's own Refresh is landing. Nothing changed ⇒ no graph read and no re-layout; an absent token (an
  older server, the e2e catch-all) never triggers one.
- **The toolbar's Refresh** reads the sprint from the tracker AND, with AI on, starts up to
  `SPRINT_REFRESH_TICKET_CHECKS` (3) ticket checks server-side; the response's `ticketChecks` is said
  for 10 s under the toolbar (`ticketChecksNote`: "Checking 2 tickets against their pull requests.", or
  why none could start — no Claude credential; nothing when none needed one).
- **"Ask Claude about this sprint"** (`SprintAskPanel`, inline under the toolbar — never a fixed
  bottom-right element; shown only where `me.ai.enabled` and the response's `aiEnabled`): the transcript
  lives in the module store `useSprintAskTranscript` (per workspace, memory only) and ⚠ the completed turn
  is appended in `useSprintAsk`'s HOOK-level `onSuccess`. Answers render through `Markdown` with
  `ticketLinks` + `rehypeTicketLinks` over the sprint's keys; a key opens its story view (TicketRefLink.tsx
  → `useOpenStory`). Each answer shows its cost in US$.
- **Statuses** (`SprintStatusSettings`) — the BUCKET editor (add / rename / delete / reorder buckets, a
  meaning select per bucket, statuses moved by drag and drop or the keyboard Move up / down buttons across
  buckets, ticket counts, "not placed yet" on a status the buckets do not name, a meaning select that
  offers Code review and Product review, the "Move tickets whose pull requests have all merged into
  Product review" switch with its ⓘ (disabled, with one line, when no bucket means Product review), Save / Cancel / Reset to automatic; Save waits on shared
  `sprintBucketsProblem`'s sentence, run on what Save SENDS; over the 60-status cap Save leaves out
  0-count statuses first — a renamed or retired tracker status lingers as one — and says which
  (`statusesLeftOutOnSave`), so the cap never locks the editor; each bucket's name field and meaning
  select carry their own accessible name; pure helpers in `sprintModel.ts`; docs/TRACKERS.md § The
  status order and buckets). A save moves every view's columns at once.
- DELETED with the drawer (2026-10-18): `SprintTicketDrawer`, `SprintAssessment`, `SprintCodeCheck`,
  `SprintCopyButton`, `lib/copy.ts`, the drawer's grouped references and `Ticket/TicketPrsSections.tsx`.
  DELETED with the chips, findings, highlights, checks and write-back: `SprintTicketCard`,
  `SprintTicketReview`, `SprintUpdatePanel`, `SprintChecksPanel`, `SprintDiffText`, `useTicketDraft`,
  `lib/ticketDraft.ts`, `lib/storyHighlights.ts`, `lib/wordDiff.ts` and the `.story-mark` / `.story-rev`
  CSS.
- **Merged so far** (`?view=sprint&sprintTab=merged`, `MergedPrsView.tsx`) — the Open PRs
  page over the work that LANDED: every PR merged in the
  REPORTING WINDOW from `GET /api/merged-prs` (`useMergedPrs`, `ws:<id>` key, no capability gate), header named through `reportingWindowText.ts` + "N pull requests merged".
  ⚠ **It REUSES `OpenPrsCards` with `variant="merged"`, never a fork** — that prop drops the CI and
  merge-readiness chips (a "Merged" chip and "merged X ago" instead), the stack roll-up, the Claude
  Review panel + CI review AND their batched requests, and the stack's "Merged (n)" panel (the
  stack IS the merged work); default order is newest merge first, and there is no Sort menu.
  ⚠ It KEEPS the TICKET review (where AI runs and the tracker is on): the ONE batched
  `useTicketReviewStates`, the card's coverage pills (`TicketPillsRow`, the pills without the code
  review's Review/Fix), the stack's coverage pill + Check story; the Story section itself is the
  story view's (§ The story view), one click on the stack header away. The
  Group by ticket / List choice is the SAME per-viewer `store/openPrsView.ts`
  state as Open PRs; the repo dropdown is the tab's own local state.

## The Reports pane is three tabs, and the Pending board can now merge

### Reports → Overview | Chronology | Stories (`insightsTab`)

`InsightsView` is a THREE-TAB pane (Overview · Chronology · Stories — Stories sits to the RIGHT of
Chronology since 2026-10-26; This Sprint and Merged so far
left for their own rail line, above). **Overview** is the pane as it was — Flow metrics above the Period reports. **Chronology** is the COURT LEDGER panel (`BottlenecksPanel.tsx`, contract in
[BOTTLENECKS.md](BOTTLENECKS.md)). ⚠ It renders NO PERSON — not a login, not an avatar, not a
per-head count — and the server sends no actor ids, which makes that structural rather than a
convention this file has to remember.

- ⚠ **The visible tab is DERIVED, never written back** — `effectiveTab` normalises an unknown
  `?insightsTab=` FOR THE RENDER ONLY. Exactly the `botsInnerTab` / `sprintInnerTab` rule: a
  corrective `set…()` permanently forgets the reader's choice.
- ⚠ **`effectiveInsightsTab` keeps exactly one job** — normalising a value outside the union. If a
  member ever becomes conditional, the condition lives in the PANE, never in the tab resolution: a
  fallback would silently redirect a bookmarked `?insightsTab=…` with no explanation and make the
  function impure, breaking the round-trip `urlHistory.test.ts` pins.
- The store key lives in `freshDefaults()` only, so **no `FILTER_STORAGE_VERSION` bump is owed**,
  and `'overview'` — the current default — is the OMITTED URL value.
- **Stories** (`?insightsTab=stories`, `StoriesView.tsx` + pure `storiesModel.ts`,
  `test/storiesModel.test.ts`) — how well the TICKETS were written: the two charts, then every story behind ONE "All N stories" disclosure (Fell short · Not reviewed · Reviewed,
  no gaps), over the REPORTING WINDOW (`GET /api/stories`, `useStories`, key `['stories','ws:<id>']`), named by the reporting-window caption. No tracker → one
  sentence. The server orders `shortfall` / `unchecked`; the SPA never re-ranks them. The per-story
  AI notes, their "Write note" buttons and the pattern chips are DELETED.
  - ⚠ **The agentic story report is REMOVED (2026-10-18)** — `StoryReportCard.tsx`,
    `storyReportModel.ts` + its test, the `useStoryReport*` hooks and the `api.storyReport*` methods
    are gone, and so are its window picker and "Write report". Do not re-add a model-written narrative
    here; its `story_reports` table is dormant (docs/DATA-MODEL.md).
  - Charts: "Time and pull requests" is `RepoRows` with two single-segment columns on SEPARATE scales
    (working time via `formatWorkingTime` over `workingDayHours`; PR count), top
    `STORY_TIME_CHART_ROWS` by working hours + "N more not shown". "Size and criteria" is `ScatterChart`
    with the new optional props `yScale: 'linear'`, `legend`, `dotColor` and `ScatterPoint.flagged`
    (a hollow SQUARE — shape, not hue alone — for a story in `shortfall`); an unknown size or a null
    criteria count is LISTED under the chart, never plotted at zero. The old call site
    (`RepoAnalyticsModal`) passes none of them and is unchanged. "Time and pull requests" prints each
    figure BEFORE its bar, right-aligned against it (`RepoRowColumn.valueSide: 'before'`).
    ⚠ **A TICKET'S NAME IS THE LINK** (`StoryLink`: key + title, a button) to its dedicated story TAB
    via `useOpenStory()` — in the "Time and pull requests" rows (through `RepoRows`' optional
    `labelFor`; the row and its bars stay unclickable), in every "All N stories" row and in the "Size
    unknown" / "No criteria found" lists. No separate "Pull requests" button. A story row's small
    external-link icon opens the tracker. The disclosure's toggle line also states "N fell short · N
    not reviewed".
  - Every explanation sits behind an `InfoButton`; no caption paragraphs. No e2e spec mounts
    Reports, so `e2e/mock-api.ts` has no `/api/stories` fixture; add a typed one if a spec ever opens the tab (today the catch-all `{}` reads as "no
    tracker": the tab prints one sentence).
  - ⚠ **Story health is DELETED** (2026-10-11, "not adding anything"): no `StoryHealth.tsx`, no
    `useStoryHealth`, no `GET /api/story-health`. Do not re-add a weekly-chart panel here. The label
    run's client methods (`api.startStoryLabelRun` etc.) remain with no screen calling them.
- ⚠ **`BottlenecksPanel` holds NO gate of its own**, which is what keeps its
  "Measuring…" / "Could not load this workspace's flow." branch a two-state question about the
  REQUEST. `useFlowFindings` gates its own `enabled`
  (unconditionally — the hook has one mount and the query POLLS, so a disabled query also stops the
  five-minute timer).
- **The panel is two halves, WORKING hours above and CLOCK hours below** (docs/BOTTLENECKS.md), and
  every panel is a `Block`: a title, its "i", the body. The header holds "Chronology", its "i"
  ("How Chronology works") and a window picker — the workspace's reporting window ("This sprint" / "Last 14 days", the shared
  `reportingWindowShortTitle`) by default, then 30/60/90 days as longer views (React state remembered for the session —
  not a URL key and not a persisted filter, so "Clear filters" cannot reset it), then the one-line
  disclosures: the calendar, coverage, what was set aside, truncation. The working-hours half, top
  to bottom: **Where the working hours went** (`CourtSplit` over `courtsWork`: a stacked
  bar and three large percentages), **Each wait against its time budget**, **Every pull request** (the
  scatter + its "Show as a table, longest first" keyboard view), **What the quick ones do
  differently** (the contrast table — columns "Quickest N" / "Slowest N" / "Clear difference?", emphasis
  on the Quickest column), **Approved, waiting to merge**, **Who gives the first review**, **Asking for a review**,
  **Pointers** and **Where each pull request sits** (the triangle, labelled context). The clock-hours
  half: **By repository, in clock hours** — the original court ledger, whose call-out rule stays
  calibrated on clock hours; each court prints the server's one-line `summary` above its repository
  rows, and the full `directive` sits in that Block's modal — then **Merged without a human
  review**. Refusals print last, by name. An older server sends none of the working-hour fields
  (`hasWorkingHours`): the page then opens on the CLOCK-hour split and renders the clock half only.
- ⚠ **Every panel's explanation is behind its "i"** (`InfoButton` in `components/InfoModal.tsx`;
  the copy is `Activity/chronologyInfo.tsx`, every number read from `FLOW_RULES`). The page keeps
  only figures, charts and the disclosure lines. ⚠ **EVERY "i" OPENS A POPOVER, NEVER A MODAL** —
  anchored to the button, 22rem (26rem `lg`), 12px, kept in the viewport (flip/shift/size), closed
  by Escape (captured), an outside press, focus leaving it or the button. Its body takes focus on
  open, because it is the part that scrolls and the arrow keys scroll only the focused element. It
  holds the ONE popover slot (`lib/activePopover.ts`) shared with the Pending "i"s and the chart
  popovers. `InfoModal` survives only for content no "i" opens (the Open PRs ticket story).
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
  model's text and is styled apart on the `--ai-*` tokens with the sparkle; it shows while `me.ai.enabled`, the GET never generates, and every mount
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

**ONE REPORTING WINDOW FOR THE WHOLE SECTION.** Every Reports figure is tied to the workspace's
reporting window — this sprint so far when it has a sprint cadence, else the trailing 7/14 days —
resolved ONCE per request on the server (core `db/reporting-window.ts`, asking the platform's
`resolveComparisonWindow`) and echoed as `window` on
`/api/workspace-metrics`. The windowed tiles sit under a heading naming it ("This sprint so far" /
"Last 14 days"); **Open pull requests** and **Red checks now** are SNAPSHOTS and sit apart under
**"Right now"**; the trend band is labelled **"Last 12 weeks"**. Those two groups are the labelled
exceptions here; elsewhere in Reports the other LABELLED exceptions are completed periods / month to
date (Period reports), Chronology's 30/60/90 and its "Over time · Last 26 weeks". Both cards name the window through `Activity/reportingWindowText.ts` (the shared
spelling in `packages/shared/src/reporting-window.ts`). Changing the cadence or the comparison mode
invalidates `['workspace-metrics']`, `['flow-findings']` and `['flow-pointers']` too.

| Card | Population | Source |
|---|---|---|
| **Activity by repository** | PRs opened in the reporting window, and their lines changed | `repoActivity` on the ONE `/api/workspace-metrics` response — it can never be a refresh apart from the tiles above |
| **Reach by repository** | every pull request MERGED in the reporting window, at Low/Medium/High blast radius | `reach` on the same response (per-PR SIGNALS), folded by `foldWorkspaceReach` (`Activity/reachModel.ts`) through `useWorkspaceReach` |

Both are horizontal ROW LISTS drawn by `components/charts/RepoRows.tsx` (a `<table>`, not SVG):
repository name written out in full on the left, a stacked bar per measure, every figure printed.

- ⚠ **THEY MOUNT IN `WorkspaceFlowMetrics`, NEVER INSIDE `WorkspaceMetricsPanel`.** That panel has
  TWO mounts — this one, and `RepoInsightsPanel` for a SINGLE repo. A per-repository comparison
  there degenerates to one row, on the one screen where it answers nothing.
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
- ⚠ **ONE WINDOW, NAMED ON EVERY CARD.** The tiles compare the reporting window against the same
  point of the one before; both cards measure the SAME window with no comparison (the activity
  card's "i" says so). The window is HANDED IN by the route — neither fold resolves it.
- ⚠ **UNKNOWN IS NEVER ZERO, ON EITHER CARD.** `linesChanged: null` prints the words "size unknown"
  in that repository's OWN row — a zero-length bar and an absent one are the same pixels — and the
  unsized PULL REQUEST count is still stated in words below, because the row marks repositories and
  the sentence counts pull requests. On the reach card a null `blastRadius()` verdict (never
  measured, or truncated-and-not-high) is NOT DRAWN and is NOT a fourth segment, so the bars do not
  total the merged count the list is ranked by; that difference is disclosed in words and beside
  the name of any repository it applies to.
  - ⚠ **"SIZE UNKNOWN" IS THE ALL-UNSIZED CASE ONLY, SO A PARTIALLY-SIZED REPOSITORY MARKS ITSELF
    TOO.** The fold nulls `linesChanged` when `sizedPrs === 0` and no sooner, so a repository with
    SOME unsized pull requests draws a full-looking bar over its sized subset, identical to a fully
    sized neighbour — MEASURED on workspace 1: `DEFRA/bng-metric-backend` opened 45 PRs of which 2
    were never sized, beside six neighbours with none. `RepoRows`' `noteFor` prints **"lines cover
    43 of 45 PRs"** under that repository's name. The aggregate sentence stays the COUNT ("2 pull
    requests have no recorded size"); it never says where they are, which is what the row is for.
- ⚠ **THE REACH CARD'S LEVEL COMES FROM THE ONE RESOLVER.** The server sends SIGNALS per merged PR (`blast`, `codeLoc`,
  `codeLocIsLowerBound` — the open-PR rows' folds, `db/merged-reach.ts`), never a level, and
  `foldWorkspaceReach` calls `blastRadius()` — the same function the chip calls, with the same
  config — so a bar and a chip can never disagree, and the Settings sensitivity dial repaints it
  with no cache invalidation (`['me']` only). Drafts do not apply to merged pull requests, so the
  old draft sentence is gone. An empty window prints "No pull requests merged in this window." —
  the card never vanishes (a vanished card read as a removed feature).
- ⚠ **EVERY PRINTED TOTAL ON THE REACH CARD IS FOLDED OVER THE SHOWN ROWS** (`foldWorkspaceReach`).
  `repos` is sliced to 12 while `openPrs`/`unread`/`drafts` used to fold over every repository in
  the workspace, so past the cap the card printed an unread count and a draft count covering
  repositories whose bars are not on screen, beside bars that are — the headline-vs-subset defect,
  one surface over. What the cap cut rides `omitted`, is said in its own sentence, and is never
  subtracted against them. `repoCount` and `workspaceRepos` are deliberately NOT the subset, and
  each says so where it is printed.
- ⚠ **EACH CAP DISCLOSES WHAT IT CUT, ON THE DRAWN MEASURE AS WELL AS THE RANKING ONE.** Both lists
  are ranked by PRs (opened / merged) while the second column draws something else, so the leader
  on that other measure can sit below the fold: the activity card names both ("N more repositories
  saw … pull requests and … lines changed"), and the reach card names the repositories, their merged
  pull requests and **how many of those were high reach** ("…, 12 of them high reach, and are not
  shown"; `none` when the cut held none). Repositories added mid-window are MARKED, never pro-rated
  — scaling one up fabricates PRs nobody opened.
- ⚠ **THE REACH CARD ACCOUNTS FOR THE REPOSITORIES THAT MERGED NOTHING IN THE WINDOW**, or its
  repository count silently disagrees with its neighbour's ("4 of the 8 repositories in this
  workspace merged nothing in this window"), with the membership count folded from `useRepos()`
  narrowed by `Repo.workspaceId`.
- ⚠ **THE NEIGHBOUR IS NAMED, NEVER POSITIONED, AND PROSE COUNTS ARE PRINTED IN FULL.** The grid is
  two columns only at `lg` and above — below it the cards STACK and "the card beside it" is the card
  ABOVE — so the reach card's "i" says it is "the same window as the flow metrics and Activity by
  repository". And every sentence under it is a fraction meant to be checked, so the counts go
  through `toLocaleString()`, never `fmtNum`: "156 of the 1.6k merged pull requests" is not an
  arithmetic a reader can perform.
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

⚠ **A QUEUED CARD IS THE ONE EXCEPTION, AND IT SUBTRACTS.** When GitHub's merge queue holds the
PR, GitHub owns the landing: Merge and Merge-when-ready are HIDDEN (pressing either is meaningless)
and `MergeControl` renders the queue STATUS LINE ("In the merge queue · running checks";
"Leaving the merge queue" for an ejection) and "Remove from queue", COLLAPSED, with no Merge
trigger. ⚠ **On the board the line carries NO position or time** (`showQueuePosition={false}` →
`mergeQueueStatus(…, {withPosition: false})`): nothing there refetches merge-options, so a cached
position is an earlier click's answer printed as current, and whether one was cached decided
whether the card read "position 2 · ~12 min" or not — the same card said different things before
and after a reload. The PR pane keeps position and time (its answer is live).

- **Membership is RESOLVED, not read off the card.** `mergeQueueStatus` (`Activity/pendingLabels.ts`)
  weighs the card's synced `inMergeQueue`/`mergeQueueEntryState` (timed by the board query's
  `dataUpdatedAt`) against the CACHED merge-options answer (never a fetch); the newer wins, a tie
  goes to the live answer, and a synced `null` claims nothing. The row's verb and verdict follow
  that resolved membership (`pendingMergeGate` re-run with it when it overrules the card). The
  verdict line is suppressed.
- ⚠ **THE CARD SAYS IT ONCE.** It used to say it three times in two vocabularies: the header chip
  ("Merge queue · running checks"), the server's sentence ("In the merge queue. GitHub merges it
  from here.") and the row ("In the merge queue · awaiting checks"). Now: ONE word table
  (`QUEUE_STATE_WORDS` → `QUEUE_STATE_LABEL`, so on the board the row's line IS the chip's label);
  the sentence is left off the card (`pendingCardDetail` / `depStateSentence` — the server keeps it
  for the Do next `reason`, the `ci_red` precedent); and (layout B) the header chip is gone: a queued
  merge-row card's HEADING is the line (`useMergeRowQueueLine`, the same newer-wins read as
  `useMergeRowQueued`) and the row passes `queueLine={false}`, keeping only "Remove from queue". It stays for a reader without push access (no row) and while an armed intent
  owns the row. `mergeRowCardOf` names the card whose row a card renders and MUST mirror the
  renderers (pinned in `pendingCardControls.test.ts`), or the chip would vanish over a row that says
  nothing. The type/state chips are suppressed on a queued card (`forwardStateChip`,
  `depStateChip`, and `myTurnTypeChip` on an `own_ready` My Turn card). An armed intent the runner
  has already queued shows no armed headline: the armed chip beside it ("In the merge queue" +
  "Cancel & dequeue") says it.
- ⚠ **The old relabelled "Merge queue ▾" trigger kept its status text inside the EXPANDED panel**,
  and whether the panel is open is per-mount state, so any remount (navigate away and back) showed
  a Merge button — the reported bug. The queued row now renders whether or not the panel is open.
- `MergeControl` and `MergeWhenReadyControl` take `inMergeQueue` / `mergeQueueEntryState` /
  `syncedAt` on BOTH mounts (`ChecksTab` passes `pr.*` + `useQueryDataUpdatedAt(['pr', id])`, a
  cache read that adds no observer; pinned by a source scan and a render test in
  `test/mergeControlQueued.test.ts`). A newer live answer that disagrees fires
  `useQueueDisagreementRepair` once per answer: `['pr', id]` plus the workspace sweep only
  (`skipPrIds` covers this PR and every recently written one). Enqueue and dequeue share
  `mergeQueueMutationKey(prId, verb?)`, so "Removing…" shows on both mounts. An AlreadyQueued 409 on
  arm refetches the write set and settles the arm draft once the refetched merge-options says
  queued.

The rest of the row, queued or not:

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
- `PrCardFrame`'s `onOpen` skips `a`/`button`/`textarea`/`input`/`[data-noactivate]`, so the
  controls do not also open the PR.
- **MID-MERGE IS THREE LAYERS, CHECKED MOST-IMMEDIATE FIRST.** (1) a MANUAL merge or branch update
  the reader started, read off the SHARED mutation keys `mergePrMutationKey(prId)` /
  `updateBranchMutationKey(prId)` via `useIsMutating` — ⚠ never a per-mount `isPending`, because
  `MergeControl` owns the mutation inside this row while PrDetail mounts a second `useMergePr` for
  the same PR, and a per-mount flag is invisible to the other mount (the CiAnalysisCard lesson);
  (2) an ARMED intent, whose live phase is `armedPhaseHeadline` (all thirteen `ArmedMergePhase`
  members, `queued` ≠ `queued_local`); (3) the synced verdict, as before. The manual line OUTRANKS
  the armed one: an armed intent describes what will happen later, a live POST describes now.
  ⚠ Both new reads are CACHE reads — GitHub's merge-queue POSITION and ETA stay off the card's
  wire, because those two are still unsynced by design (they change minute to minute) and reachable
  only through the click-gated merge-options call; the queued row prints them only when that answer
  is already cached. MEMBERSHIP and ENTRY STATE are a different matter: see below.

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

Pending is seven tabs (`PENDING_TABS` in `packages/shared/src/pending-rules.ts`): **My turn** ·
**Claude reviews** (finished Claude reviews you have not acted on — the my_turn cards of type
`claude_review`, moved out of My turn; same ball rule and dismissals, one scored list) ·
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

- **My turn and Claude reviews split ONE kind by type.** `pendingTabHolds(def, card)` (shared) is the
  one predicate — `reasons` / `exceptReasons` on the tab def — read by the server's lists and totals
  and the SPA's `tabsOf` fallback; `pendingTabOfCard` names a card's tab (`pendingTabOf(kind)` still
  answers My turn for `my_turn`). Claude reviews is shown only where `me.ai.enabled`, or while it
  holds something or is on screen. Inside both tabs a `direct` card drops its "Your turn" label.
- **Every card leads with its type's mark** (`PendingCardIcon`, on `PrCardEventHeading`'s `icon`),
  every tab and kind chip with its own (`PendingTabIcon` / `PendingKindIcon`), and the guide's tab and
  My Turn tables carry them too. The marks are purpose-built `Pending*Icon`s in `Icons.tsx`; the maps
  in `Activity/PendingKindIcon.tsx` are `Record`s over the full unions, so a new kind, My Turn type or
  tab fails to compile until it has one. Decorative only — the words beside each say the same.
- **The server ranks the UNCAPPED fold, then caps** (`rankPendingTabs`): up to `boardListCap` per
  LIST GROUP — kind × My turn's "Only yours" side × who opened it — so the whole tab, a kind chip and
  each lens are their own true top. The SPA caps EVERY view to `boardListCap` (a chip or "Only
  yours" is now the union of a People list and an Automation list, and beyond the cap that union
  has gaps) and says "Showing the top 50 of 176. The rest score lower." when it cuts — or, on a
  strict-group view (My turn, Dependencies with no chip), "Showing the first 50 of 65.", because
  there the cut is the LAST GROUPS, which can outscore what is shown (`capSentence`).
- **Every view's count is its own population**: tab → `tab.total`, chip → `tab.kindTotals[kind]`,
  lens → `tab.relevanceTotals[lens]`, author lens → `tab.authorTotals` / `kindAuthorTotals[kind]` /
  `relevanceAuthorTotals[lens]`. `GET /api/daily-brief` returns the same figures (the banner and
  badges show the my-turn ones).
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
  (`openMyTurnInWorkspace`) — `setActivityRepo` early-returns on an
  unchanged rail. Transient, never in `FilterDefaults`.
- **An emptied view says what emptied it** (`pendingEmptyNote`): "Nothing from automation in
  Waiting on review right now." with a "Show all", "Nothing under Bumps right now.", or the tab's
  own sentence. ⚠ The review-load strip counts REVIEWERS, so no PR narrowing hides it: a narrowed
  view with no cards puts the note ABOVE the strip, or the reader got the strip and no word that
  the lens had hidden every card.
- **The tab on screen is DERIVED** (`effectivePendingTab`): a kind (`attentionIsolation`, seated by
  `openMyTurnInWorkspace`, a chip or `?attn=`) names its own tab and wins; else the picked
  `attentionTab` (`?attnTab=`, a NAV key); else My turn. Clicking a tab is ONE write that seats the
  tab and clears the kind (`setAttentionTab`). Old `?attn=<kind>` links land on the right tab with
  that chip selected.
- **No Pending tab has a head.** The default-branch strip that headed My turn (`showsMyTurnHead`,
  `MyTurnHead.tsx` — both gone) now heads Activity → Open PRs (`Activity/DefaultBranchesSlot.tsx`;
  see the Open PRs entry above). ⚠ **NO NEW REQUEST**: the strip's argument-less
  `useBranchStatus()` is the SAME cache entry the rail reads at boot, and trends stay lazy per row.
  ⚠ **COUNT-FREE**: nothing it reads reaches a badge, `myTurn`, the scorer, the liveness sweep or a
  notification. Its slot is a placeholder while pending (idle included), "Couldn’t load the default
  branches." on failure, "No default branch has synced yet." on an answered empty, else the panel.
  ⚠ **`?attnView=branches` shipped**: it is still parsed, only to pick Pending when no console is
  named, never emitted, and is no longer a NAV key — dropping it from a legacy URL replaces the
  entry.
- **Removed with the cross-kind head**: `doNextIds`, the "already in Do next" chip, the header "My turn"
  pill (the tab replaces it), `AttentionIsolationBanner` (the selected tab and chip say the same
  thing on the board itself) and the spread/superseded explanations. The work plan still picks its
  rows across kinds; its headline and `parked` line sit above the tabs and each `why` lands on its
  card in whichever tab — `PendingCard` reads it from `PendingBoardContext` for EVERY kind (before,
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
- **"Customise"** (My turn's Cards view only) opens Settings on its Pending tab, at the My Turn section
  (`useSettingsModal().openSettings('my-turn')`, `store/settingsModal.ts`). It sits at the right end
  of the controls row, after the People / Automation pills, inside ONE right-aligned wrapper — two
  `ml-auto` siblings would split the free space between them. The row always renders on My turn's
  Cards view, empty or not, so the way into Settings is there when the tab holds nothing.
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

**A red CI label names the failing checks.** `PrMetaRow` draws CI through `CiStatusWithChecks`
(the dot, the label and, beside a RED label only, the names): "CI failing: build, clippy, lint and
2 more". Names come from the card's optional `failingChecks` / `failingCheckTotal`, comma-joined
with no "and" between names (a check is often called "Build and test"). The names span truncates
(`min-w-0`); "and N more" never does and is never only a tooltip. They are third-party text,
rendered as plain text nodes. `FailingChecksLine` (the `ci_failing` body, below) and
`CiStatusWithChecks` draw the names through one private `FailingCheckNames`, with the pure
`failingChecksParts` beneath. ⚠ **REAL SPACES between the runs**: the label, the names span and
the "and N more" span each have a `{' '}` text node between them. A flex `gap` is paint, not text,
so without it copied text and screen readers read "CI failing:build" / "lintand 2 more"; a
whitespace-only run between flex items is not rendered, so the layout is unchanged.
`test/failingChecksText.test.ts` pins the rendered textContent of both components, not a helper
string. No names is NOT "0 failing": the label renders alone. The Search card's hand-adapted
`PrMetaFields` carries neither optional field and renders the label alone.

**A Dependencies card** (`renderCard`'s `case 'security': case 'dependency_bump':`): the header
label (`cardKindLabel`: "Security fix", "Likely security fix" for Dependabot's INFERRED fix — never
"Security fix" above a card that cannot back it, and it carries no fix sentence either, the why lives
in the info popover — "Security alert", "Dependency update"), the meta row with its byline, the
review row, the state chip (`DEP_STATE_LABEL`; none for `conflicts` or `needs_review`, whose sentence
already says it, `ci_red`, or `unknown`) with the state sentence (`depStateSentence`; none for
`ci_red`: the meta row already says CI failing and, when it knows them, names the failing checks),
then, on a `security` card, `SecurityDetail`:

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

### One PR card shell — Open PRs and Pending

`Activity/PrCardShell.tsx` is the card layout BOTH lists render: `PrCardFrame` (the bordered `<li>`;
whole-card click + Enter/Space ONLY with `onOpen`, a click on `a`/`button`/`textarea`/`input`/`select`/
`[data-noactivate]` left to that control), `PrCardTitle` (title first; an end slot OUTSIDE the
heading), `PrCardChips` (left-aligned under the title, `empty:hidden`), `PrCardMeta` ("·"-separated
parts, empty ones skipped, then a trailing delta + flags) and the shared `CiChip`/chip classes. It
owns the frame and the type, never the content, and fetches nothing.

- **Open PRs** (`OpenPrCard`) is unchanged on screen: title + Draft, CI/review/threads/merge chips,
  ticket row, meta line, Claude panel.
- **Pending** (`PendingCard` in `AttentionCards.tsx`) uses the shell's optional EVENT-HEADING slot
  (`PrCardEventHeading`) instead of `PrCardTitle` — layout B, below.
- ⚠ **Claude on Pending is ONE batched `useClaudeReviewStates` for the board's PR cards**, gated on
  `me.ai.enabled` like Open PRs — never one request per card (`test/prCardShell.test.ts`).

### The Pending card — layout B, event first (`lib/pendingHeadings.ts`, `PendingCard`)

Every Pending card, on all seven tabs, reads top to bottom in one order, everything LEFT-aligned:

1. **The heading — what happened.** "David Buckley replied: “…” · 2d", "Your build failed:
   SonarCloud · 2h", "main is red in bng-metric-frontend: Run Journey Tests · 14m", "Waiting 4d on
   Priya Shah". Actor by DISPLAY name (never @login), the quote as plain text (markdown/HTML and
   quote-reply lines stripped, cut at ~120 chars on a word boundary), the time ONCE at the end.
   ⚠ NO CSS line clamp — it hid the age whenever the heading wrapped to a third line; the quote's
   character cap is the bound, and it is what `replyBlockShown` reads.
2. **The action line — what to do, and where.** `[In your repos] [muted]` **verb** · where (path,
   sha) · on <PR title> (a button → Overview) · `repo#N` (org dropped when every card on the board
   shares it) · ↗ · ⓘ. Inside My turn "Your turn" is NOT printed (the tab says it); "In your repos"
   and the neutral label stay, and an ABSENT `relevance` is neutral.
3. **The work plan's `why` line** (model prose, labelled apart, only while `me.ai.enabled`), directly under it.
4. **The event's own content** — the attributed reply (only when the heading's quote was cut), up
   to 3 pushed commits, the failing checks the heading did not name, suggested reviewers, the
   advisory, a thread's opening comment (`firstComment`), the trunk card's "Last landed: #354 … by
   Dependabot, merged by … — not necessarily the cause".
5. **ONE fact line chosen by the card's job** (`pendingFactPlan`): people/own-PR cards → CI +
   standing; review cards → CI · standing · "High reach" · code lines; merge/deps → CI · standing ·
   reach; CI and trunk cards → nothing. "GitHub: no review required" is never printed. A fact the
   heading already states is not repeated: no standing under "approved your PR" or "needs an
   approving review", no "No reviews yet" under "Nobody was asked to review this", and on a red
   Dependencies card the CI label goes without names (the heading and the red line list them).
6. **Claude as one line** (`PendingClaude.tsx`: verdict + counts; on a red-build card the diagnosis
   INSTEAD of the verdict) — nothing when Claude has not looked. Threads-to-fix and the CI-diagnosis
   pill live in Details.
7. **The buttons, left:** primary · secondaries (merge row / resolver / Resolve / Open review / AI Fix
   / Open #N) · Details · Dismiss (quiet, My turn only). Resolve conflicts IS the primary on a
   conflicts card. A red build's primary is "Open checks" — the PR's or the commit's `/checks` page
   (`checksPageHref`), never Overview. The CI card's AI Fix is gated on `board.claudeOn` like every
   agentic control. Resolve on a thread card resolves by thread id on the CLICK; nothing mounts that
   fetches.
   ⚠ **No imperative without its button**: a merge / update-branch / ready-bump card the viewer
   cannot push to (row hidden by `pendingMergeGate`) carries NO verb on its action line.

**Details** (per-card local state) holds the reviewer chips, byline · opened · files · +/− · the
reach PHRASE, Claude's other pills, the thread's conversation and the PR summary. ⚠ **The last two
FETCH, so they mount only while Details is open** — the untouched-thread card used to fetch its
thread on mount, which broke the board's no-fetch rule (`e2e/pending-cards.spec.ts` pins it).

**Whole-card click opens the EVENT** (`pendingCardEvent`): a thread card its thread, pushed
commits / your PR's new activity the PR's Activity (`tab: 'activity'` = Overview with the Activity
section open and scrolled to), a mention / comment-after-yours card THE
COMMENT when it carries `comment` (`board.openComment`: a comment on a line of code → Changes via
`openPrChangesAt` with `threadId` + `line`, which PrDetail runs through `openInChangesFor` — the
thread → Changes ladder that opens its inline pill — falling back to the Threads only view when the
file left the diff; a comment with no file — a PR comment or review body — → the Comments tab via
`showPrComment(prId, id, kind)`, keyed `comment:<id>` / `review:<id>` in `PrCommentsList`; without
`comment`, the Comments tab too), a Claude card the
review, a red trunk its checks page on GitHub (the "at <sha>" link is the commit itself); the title
always opens Overview (it seats `prDetailTab` explicitly). A red build on YOUR PR (`ci_failing`'s
`your_pr` arm, no `InsightPrRef`) still prints "on <title> · repo#N" from its own fields.

What went, deliberately: the type chip (`MY_TURN_REASON_LABEL` survives for the filter chips), the
KIND chip, the header queue chip (a queued merge-row card's HEADING is the queue line, from the same
newer-wins answer — `useMergeRowQueueLine`; `MergeControl` gets `queueLine={false}` and keeps only
"Remove from queue"), the second and third clocks, repeated red-CI statements and everything on the
right edge.

- ⚠ **The server's `detail` is never printed whole and never rewritten** — Slack, notifications and
  the work plan print it. The heading lib lifts ONE fact from it where that is the only place it
  lives (the base branch, "N others also requested", the trunk branch, the Claude verdict).
- ⚠ **Absent heading facts drop their clause** (`mentionExcerpt`, `threadPath`, `committerId`,
  `firstComment`, `newActorIds`); an unknown actor is "Someone". A `likely_addressed` card says "A
  commit changed <path> after your comment" — never "addressed".
- ⚠ **A repo-grained card is not drawn as a PR.** `ci_failing`'s trunk arm and a promoted
  `trunk_red` head with the branch and repo, print no PR title, and link the sha to the commit;
  `reviewer_load` heads with the PERSON. `pendingCardPrId` gives neither a PR.
- Pinned by `test/pendingHeadings.test.ts` (every card type, the fallbacks, the relevance labels).

### "opened 3d" — the PR's own age on a Pending card

> **Layout B:** the age now sits in the card's DETAILS meta line (`PrDetails`), and the per-card
> clocks below (`right` / `clockAt` / `clockSaysMore`) are replaced by the heading's ONE time. The
> pure helpers stay exported and pinned; the history below is kept for the reasoning.

`openedAgeLabel(iso)` (exported from `AttentionCards.tsx`) turns `InsightPrRef.openedAt` into
"opened 3d". It is passed to `CardShell` as `openedAt` and **appended** to whatever `right` already
holds, both in the card's META LINE between "#N · repo · author" and the file count; the "·"
separator (`PrCardMeta`), the absolute `dateTime` tooltip and the null degradation live in the shell,
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
- ⚠ **It goes in `CardShell`'s clock parts, NEVER in `PrMetaRow`.** `PrMetaRow` is exported and mounted
  by a second surface (`Search/SearchResultsTab.tsx`) off a hand-adapted `PrMetaFields`; putting the
  age there paints "opened 3d" on every cross-repo search result.
- The `·` carries `decorative-mark` + `aria-hidden`. That is the ONLY sanctioned opt-out from
  `test/textContrast.test.ts`, and a "·" between two metadata items is the case it exists for.

### What the card carries about the merge queue and the review

These ride the card because the board **may not fetch on mount** — a fact the reader needs on
fifty rows has to arrive with the rows.

- **`inMergeQueue` + `mergeQueueEntryState` are SYNCED columns** (`InsightPrRef`, and `PrDetail`
  for the pane). Position and estimated-time-to-merge are NOT, and stay on the lazy
  `…/merge-options` fetch. ⚠ **THREE STATES**: `true` / `false` are positive statements from
  GitHub; `null` is NOT OBSERVED and renders NOTHING — never "not queued". They exist because
  GitHub's `MergeStateStatus` enum has no QUEUED member, so a queued PR reads like any other merge
  state ('clean' and 'unknown' have both been seen here), and every merge surface without these
  two offers a button GitHub will refuse.
- ⚠ **`unmergeable` is the member that earns the state column**: GitHub is EJECTING the entry, the
  thing a reader could previously only discover by pressing Merge and reading the failure.
  `pendingQueueBadge()`, `QUEUE_STATE_LABEL`/`QUEUE_STATE_TITLE` and the merge-row resolver
  `mergeQueueStatus()` (all in `Activity/pendingLabels.ts`, re-exported from `AttentionCards` —
  moved to break the `MergeControl` ↔ `AttentionCards` cycle) are the ONE place those sentences
  live — the PR pane's Overview row imports `pendingQueueBadge`, and both merge controls import
  `mergeQueueStatus`. Two copies is how one screen calls an ejection "in the merge queue".
- A queued card's server detail is `MERGE_QUEUE_CARD_DETAIL` (now in `packages/shared`
  `pending-rules.ts`, because the SPA recognises it to leave it off), and the same sentence is the
  Do next `reason`: one builder, `mergeCardDetail(…, inMergeQueue)`, whose `inMergeQueue` argument
  is REQUIRED so a new caller cannot forget it. A Dependencies card's server sentence says it too
  (`dependencyStateDetail`), except for `conflicts` and `ci_red`.
- **Failing check names** — every `InsightPrRef` on `/api/attention` also carries OPTIONAL
  `failingChecks` (≤ `FAILING_CHECKS_SHOWN` = 3, bare names, alphabetical) and `failingCheckTotal`
  while its `ciStatus` is red. They are absent when no names are known, and absent on every other
  consumer's fold. Rendering: see the `PrMetaRow` paragraph above and § `ci_failing`.
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

### The PR pane's Suggested row stays after the first Assign

The server empties `GET /api/prs/:id/suggested-reviewers` once ANYONE is requested (its gate is
"nobody asked yet", which is what retires the Pending routing card). The pane's row used to unmount
with it, so asking one person took every other suggestion away. `ChecksTab` now keeps the last
non-empty answer per PR for the session (`seenSuggestions`, bounded at 50, survives a tab-switch
remount) while the PR is open and not a draft, and `SuggestedReviewersRow` drops anyone already on
the "Requested" row (user id, or a team by slug / `owner/slug`). Someone asked from the row keeps a
"Requested" tick until the refetched detail lists them above. The server gate is unchanged.

### Suggested reviewers on a `reviewer_routing` card — one Assign per suggestion

- Each suggestion row carries its OWN Assign, asking just that reviewer (`RoutingReviewerRow` in
  `AttentionCards.tsx`; the body is `reviewerRequestBody` in `lib/reviewerRequest.ts`: a synced user
  by id — the path the route STAMPS locally — an unsynced one by login, a GitHub team by its slug).
  "Assign all" is gone: picking WHO is the action. Both callers of `POST /api/prs/:id/request-reviewers`
  now send one reviewer per request (the PR pane's Suggested row already did).
- HIDE, never disable. No button when the row names nobody addressable (body `null`) or
  `card.viewerCanPush` is false — the WRITE/MAINTAIN/ADMIN set (`writableRepoIds`) the route
  re-checks, folded server-side because the board may not fetch on mount. Measured: 703 of 714
  orphans sat in repos the viewer only READS, so without it nearly every button was a certain 403.
  The suggestion itself still shows. A card with no suggestions (every card past `routingSuggestCap`)
  renders no block at all. The block is `data-noactivate`, so a near-miss click does not open the PR
  mid-request. The only `disabled` is the transient in-flight state.
- ⚠ **Row state is read off the MUTATION CACHE**, never a per-mount `isPending`/`isSuccess`:
  `useReviewerRequestState` → `useMutationState` over `requestReviewersMutationKey(prId, rowKey)`,
  latest attempt wins (`reviewerRequestView`). A Pending tab switch remounts the card; a per-mount
  flag would forget an open request (inviting a second POST) and offer "Assign" for someone already
  asked. Two rows are two mutations and may be in flight together.
- ⚠ **The board refresh waits for the LAST request on the PR, and only a success triggers it**
  (`requestReviewersOptions`; `isMutating` still counts the settling request inside `onSuccess`,
  hence `> 1`). The route stamps the request, so a board refetch RETIRES the card and every sibling
  row's outcome with it. A failure refreshes nothing, so the card stays with its words and the retry.
  The last request runs the ONE write set (`invalidateAfterPrWrite`, § The cascading sync), so
  `['attention-cards']` + `['daily-brief']` + `['work-plan']` move together (plus
  `['workspace-insights']`, the capped fold's copy); a request with a sibling still in flight
  refreshes only the PR's own `['pr', id]`, and `['suggested-reviewers', id]` is refreshed on every
  success.
- The card LEAVES after the first stamped request, and that is its job done: routing a PR to A
  reviewer. An unsynced login is not stamped, so its card stays until the next sync, reading
  "Requested" from the cache for up to TanStack's 5-minute mutation `gcTime`.
- Pinned by `test/reviewerRequest.test.ts` (pure half + the refresh rule), `e2e/pending-assign-reviewer.spec.ts`
  (per-row independence, hidden-when-read-only, remount keeps "Requested") and
  `pending-tabs.test.ts` (`viewerCanPush` on both folds).

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

### The cascading sync — ONE write set (`hooks/prCacheSync.ts`)

Every write used to pick its own refetch list (thirteen lists, no two alike), so a write could land
on GitHub and leave a screen on the old state. The worst case was the resolver: it pushed, and the
Pending `conflicts` card stayed until something unrelated refetched the board. The server half
(settle ladder, `Repo.lastPrChangeAt`) is in [REALTIME-SYNC.md](REALTIME-SYNC.md).

- **Every PR write refetches through `invalidateAfterPrWrite(qc, prId | prId[] | null, {merged?,
  armed?, threadIds?})`**, from the mutation's HOOK-LEVEL `onSuccess` (`onSettled` for the chunked
  workspace bot-thread resolve), never a `mutate()` callback and never a hand-picked key list.
  Callers: every `usePrWrites` mutation (reply, resolve, per-PR bot-thread resolve, PR comment,
  approve, merge `{merged}`, enqueue, dequeue, close, reopen, update branch, review comment, and
  request-reviewers, which keeps its `isMutating > 1` guard); `useArmAutoMerge` (and its 409
  `onError`) / `useDisarmAutoMerge` `{armed}`; `AutoMergeBanner`'s landed rows `{merged}`, as ONE
  array; `useRerunCi`; `usePushFix`; `invalidateAfterConflictCommit` and the resolver shell's close
  `{armed}`; `useScopeResolveBotThreads`; Claude Review's `usePostFinding` / `usePostReview` (not
  on a dry run). Enqueue and dequeue RETURN the promise, so their spinner holds until the refetch
  lands. `test/prWriteCascadeGuard.test.ts` is a source guard over those modules; its exempt set is
  EMPTY.
- **The set, in read order**: `['repos']` FIRST; then the PR-scoped keys (`['pr', id]`, the
  `['thread', id]` keys the cached detail lists plus `threadIds`, `['merge-options', id]`,
  `['ml-labels', id]`, `['pr-bot-behaviour', id]` — the Bot activity tab's "acted on" counts move
  on a resolve or reply); then every `ACTIVITY_QUERY_KEYS` entry plus `['timeline']`, `['open-prs']`,
  `['my-turn']`, `['me']`. `merged` adds `['mergers']` and `['branch-status']`; `armed` adds
  `ARMED_MERGES_KEY` (now in the leaf `hooks/queryKeys.ts`, re-exported from `useAutoMerge`, which
  breaks the `prCacheSync` ↔ `useAutoMerge` cycle). The set is DE-DUPLICATED (invalidating a key
  twice cancels the first refetch and sends it again), and a write that touches several PRs passes
  them as one array so the workspace keys are swept once.
- ⚠ **NEVER `prRefreshKey`** (invalidating it fires a POST that walks the PR) **and NEVER
  `['attention-liveness']`** (it spends GitHub quota).
- ⚠ **NOR `['pr-files', id]` — THE CHANGES TAB'S DIFF FOLLOWS THE HEAD INSTEAD.** It is a live
  GitHub read kept at `staleTime: Infinity` and persisted, and nothing refetched it, so after the
  resolver, AI Fix or Update branch pushed, the tab showed the pre-push patches for the session.
  `GET /api/prs/:id/files` now says which stored head it read at (`headSha`), and `usePrFiles`
  refetches the diff when the `['pr', id]` it observes was read AFTER the diff and names another
  head (`prFilesOutdated`; once per detail read, so a failing refetch cannot loop). Every path that
  moves a head ends in a fresh detail read, so this covers them all, including a push made outside
  the app; a reply or a resolve moves no head and re-reads no diff. A cached diff read while the
  tab is closed is corrected when the tab next mounts. Pinned by `test/prFilesHead.test.ts` and
  `api/routes/pr-files-head.test.ts`.
- ⚠ The three board keys ride in together through `ACTIVITY_QUERY_KEYS`. `PrDetail`'s `markViewed`
  now refetches all three too. `usePrLiveRefresh` deliberately keeps its own narrower list: its 30s
  forced floor walk always reports `changed: true`, and the full set would put every workspace
  screen on a 30s timer.
- ⚠ **THE WORKSPACE HALF IS THROTTLED**: at most one sweep per `WORKSPACE_SWEEP_MIN_GAP_MS` (5s)
  per QueryClient, because `/api/attention`, `/api/daily-brief` and `/api/pro/work-plan` share the
  60/min `search` tier. The first write sweeps at once. Writes and server-change sweeps inside the
  gap refetch their own PR keys at once and share ONE trailing sweep carrying the union of their
  extras. Sweeps never overlap. During a burst the board catches up at the end of the gap.
- ⚠ **ABSORBED BY ORDER, NOT BY TIME.** A write's sweep reads `['repos']` before any other read and
  records `AbsorbedSweep {stamps, prIds}` (`absorbedSweep(qc)`): every stamp in that answer predates
  the board read, so the board already shows it. SyncStatus's pure `decidePrChangeSweep({prev,
  next, walkSwept, absorbed})` skips the workspace half only when EVERY moved stamp is at or before
  the recorded ones, and then skips the PR keys that same ordered read covered. A later stamp is
  always swept; a partial absorb, or an effect that runs before the record exists, sweeps again (a
  duplicate, never a lost change). This replaced a 3-second window, which dropped any change landing
  between the write's board read and its `['repos']` read.
- **The fast-poll window**: `invalidateAfterPrWrite` calls `noteLocalPrWrite(now, prIds)`. For
  `FAST_POLL_WINDOW_MS` (150s) SyncStatus polls `['repos']` every `FAST_POLL_INTERVAL_MS` (5s)
  instead of 30s (3s during a sync round), and those PRs count as `recentlyWrittenPrIds`. The
  window covers the server's settle ladder (~5, 15, 45, 120s after a write).
- **A server change** (`Repo.lastPrChangeAt` moved) is handled in SyncStatus's OWN effect, never in
  `mostRecentSync`; the first observation only records. It calls `invalidateAfterServerPrChange(qc,
  {repoIds, workspaceSwept, skipPrIds})`: the workspace half goes through the throttle, and the
  PR-scoped half is DELIBERATELY NARROW — (a) `['pr', id]` + `['merge-options', id]` of PRs this tab
  wrote to inside the window, active or not, when their repo moved or is unknown; (b) any other OPEN
  (`type: 'active'`) merge control in a KNOWN moved repo whose PR has no active `['pr-refresh', id]`
  observer. Nothing else: the Feed, Search and theme folds cache many details, and each re-read can
  hydrate from GitHub. An open pane's own `usePrLiveRefresh` re-reads its PR, and an `updatedAt`
  change reaches a cached detail through `useDetailCacheReconciler`. ⚠ It never opens the fast-poll
  window. ⚠ `prChangeMap` never throws (no error boundary). `useQueueDisagreementRepair` is its one
  other caller (§ The Pending board's merge row).
- ⚠ **THE STAMPS ARE ACCOUNT-WIDE; THE WORKSPACE HALF IS THE VIEWED WORKSPACE'S.** When EVERY moved
  repo sits in another workspace (`decidePrChangeSweep`'s `repoWorkspaces` from the same listing +
  the store's `workspaceId` → `otherWorkspaceIds`), the throttled sweep does not run: those
  workspaces' cached screens are marked stale with `refetchType: 'none'` (they refetch when the
  reader switches), and only the two reads that name no workspace refetch — `['my-turn']` (the
  notification watcher) and a Focus tab's `['timeline', 'prIds=…']`. A repo the listing cannot
  place, or an unresolved workspace, keeps the full sweep.
- Tests (run by hand): `test/prCacheSync.test.ts` (key set, ordered read, throttle, narrowed server
  sweep, the other-workspace case, `decidePrChangeSweep`) and `test/prWriteCascadeGuard.test.ts` (it treats every top-level
  declaration as a slice boundary, so a const-arrow hook cannot pass on its neighbour's call).

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

## The story view (the ticket tab, `kind: 'ticket'`, CORE)

ONE ticket, Open PRs style: `Ticket/StoryViewBody.tsx` renders the SAME ticket stack the Open PRs board
draws — `OpenPrsCards` with `story={{ticket, merged}}` (`storyStack`, `lib/openPrsStacks.ts`) — never a
copy. In order: the stack header (key — on the board it opens this story view in a tab, else the tracker link; in the story view itself it is plain text —, title, status, type,
assignee, "Open in <tracker>" (`TrackerLinkOut`, story view only, absent with no url), PR count, the ticket review's coverage pill + Re-check), the **Story section, ALWAYS OPEN**
(a plain "Story" heading, no disclosure), the open PRs as the Open PRs cards, "Merged (n)", and under
the stack "Closed without merging (n)", collapsed. It works for a ticket with NO pull request (the stack
is drawn with no rows; "No pull requests for this ticket yet."). Stacks never collapse, here or on the
board.

- **THE HEADER IS ITS OWN COMPONENT** (`StoryViewHeader` in `OpenPrsCards.tsx`, `TicketStack` with
  `single`; 2026-10-28 — the shared stack header squeezed the title into a narrow column beside seven
  items). Two rows, never side by side: the key and "Open in <tracker>" (small), then the TITLE on the
  full width; then ONE meta row that wraps as whole groups — status picker, type and assignee
  (`TicketPeopleAndStatus`, shared with the board header); the facts as chips of one kind (coverage
  "3 of 10 met", the roll-up "1 failing CI", "2 PRs"); and, `ml-auto` from `sm`, the ticket review's
  currency as ONE quiet line ("2 PRs changed since · daily limit reached · reviewed 52 mins ago", the
  sweeper's `waiting` through `ticketWaitWords`, the reason as the title) with Re-check beside it
  (`StoryCurrencyLine`). ⚠ The currency is said ONLY here: the Story section no longer draws its
  CurrencyPill. One changed PR is NAMED ("api#88 pushed since"): the line passes `ticketCurrency` a
  `labelOf` (`lib/ticketReview.ts` `prLabelOf`) over the stack's open rows and its merged PRs. The
  board's stack header is unchanged.
- ⚠ **TWO HOSTS, ONE BODY.** The ticket TAB (`Ticket/TicketTabView.tsx`, which parses the active tab's
  ident and meta) and This Sprint's story TRAY (`Sprint/SprintStoryTray.tsx`, ident from
  `?sprintStory=`) both mount `StoryViewBody({ident, meta})`. The body reads nothing about where it is
  mounted (never `activeTab`, or the tray draws the wrong ticket); pinned by test/storyView.test.ts.
- **Tab words** (`storyTabLabels`, `lib/ticketTab.ts`): chip "KEY · Story", tooltip "KEY: story and
  pull requests", close "Close story tab". Internally it stays `kind: 'ticket'` with key
  `ticket:<ident>` (`TICKET_TAB_PREFIX`; the ident verbatim, `URLSearchParams` escapes it in `view=`)
  for old links; SELF-DESCRIBING from the URL, NOT persisted across reloads.
- ⚠ **Opened ONLY through `useOpenStory()`** (`lib/ticketTab.ts`) — This Sprint's ticket clicks, Reports
  → Stories' ticket names (chart rows, story rows, unplotted lists), a ticket key
  in any text (`TicketRefLink`, e.g. an "Ask Claude" answer), the PR pane's Ticket row chips (`PrTicketChip`
  in ChecksTab.tsx: the key opens the story, a small icon opens the tracker; needs `TicketRef.ident`, set
  by the server's `prTicketView`, else the chip only links out), and a search's **Stories** facet (dropdown
  and results tab, listed FIRST; `openSearchStory` in Search/searchNav.ts, the one non-hook caller of
  `openTicketTab`). Never call the store action from a component. The sprint drawer and its reference cards are GONE.
  On This Sprint a ticket LINK opens the page's tray instead (`StoryOpenOverride` / `useStoryLinkOpener`);
  the override never opens a tab, and the tray's "Open story tab" calls `useOpenStory`.
- **Two DB-only reads, both free**: `GET /api/ticket-prs` (`useTicketPrs`, key
  `['ticket-prs','ws:<id>',ident]`: the PRs + the freshest tracker row) and `GET /api/ticket-story`
  (`useTicketStory`, key `['ticket-story','ws:<id>',ident]`: the sprint read's row — type, assignee,
  epic, the text — and the CURRENT brief). The header ticket is `storyViewTicket` (`lib/ticketStory.ts`):
  a sprint ticket leads with the sprint row, any other with the PR row, each field falling back.
- Lists only THIS workspace's repos and counts the rest ("N in other workspaces"). Neither read finding
  the ticket → "This ticket isn't on this workspace's tracker." — never a 404. `workspaceId === null`
  renders nothing.
- `['ticket-prs']` is in `invalidateAfterPrWrite`'s workspace half, so a merge from the view's own
  cards repaints it; the sprint refresh invalidates `['ticket-story', ws]`.
- **The status chip is a PICKER on a Jira ticket** (`Ticket/TicketStatusPicker.tsx`, mounted by
  `TicketStack` when `single` and `provider === 'jira'`; every other tracker keeps the plain chip) — THE
  ONE TRACKER WRITE ([TRACKERS.md](TRACKERS.md) § The status change). Opening it fetches Jira's allowed
  transitions (`useTicketTransitions`, `enabled: open`, `gcTime: 0` — ⚠ never on mount); a pick changes
  the ticket AT ONCE (`useSetTicketStatus`), writes the answer into both story-view caches and refetches
  `ticket-prs`, `ticket-story`, the sprint graph + token, `ticket-links` and `jira-ticket`. A transition
  into the current status is hidden; a refusal stays as one line beside the chip until the next pick.

### The Story section (`Activity/TicketStorySection.tsx`) — the story view only

Mounted ONLY in the story view (`TicketStack` with `single`), ALWAYS OPEN — a plain "Story" heading, no
toggle. ⚠ **The Open PRs board does not render it** (2026-10-18): every read in it starts on mount, so
on a board it would be one request per stack; a reader opens the ticket to see the story. Every ticket
with an ident has it — not only reviewed ones. **The heading row carries the STORY'S ACTIONS**,
right-aligned: the docs check (`StoryDocsButton`) and the story design
(`StoryDesignButton`, labelled "Draw design" / "Redraw design" / "Drawing design…"). The
section owns ONE start mutation for each (`useStartStoryDocsAlignment`; `useStoryDesign` over
`useRedrawStoryDiagram`) and hands it to both the button and its block, so a refusal or error from a
heading click shows in that block; the blocks keep their headings, ⓘ, status lines, results, errors
and refusals, and carry no button. In order, and NOTHING else (no dependency or reference cards or
pills):

1. **Claude's summary and criteria** — `storySummaryOf` (`lib/ticketStory.ts`, test/storyView.test.ts):
   the ticket review's result when one exists (`TicketResults`, `MemberCards`, read by the states'
   `latestRunId`; its currency is the header's). `TicketResults` shows ONLY the summary's leading prose
   (shared `storySummaryProse` — two sentences now; an older stored summary's gap bullets are dropped,
   the rows below say them), each criterion's text without a leading copy of its ref
   (`criterionTextOnly`), and the missing items under "Asked for outside the criteria"
   (`STORY_MISSING_HEADING`, ⓘ `STORY_MISSING_EXPLAINER`), each led by its title — the M-code is never
   drawn; else the CURRENT sprint brief's summary + numbered criteria ("Worked out
   from the description" when derived; the ⓘ explains it; "Show all N criteria" past 10); else
   "Reading this ticket…" while the brief pass will still read it; else nothing. `GET /api/ticket-story`
   is asked only when there is no ticket review. A ticket that is not in a sprint read has no brief:
   "for any story not already summarised", the sprint builder's brief pass is what writes one.
2. **The ticket as written** — `StoryDisclosure` labelled "As written in Jira" (the tracker's name): the
   stored tracker row read through any PR on the ticket, else the ticket review's snapshot, else the
   sprint read's text (`storyFallbackTicket`, for a ticket with no PR).
3. **The story's design** — drawn RIGHT UNDER 1's SUMMARY AND CRITERIA (`afterCriteria` on `TicketResults` / `BriefSummary`; before the missing / not-asked-for lists), listed here for its rules: `StoryDesignSection` (`Activity/StoryDesignSection.tsx`), only with `me.ai`
   and ≥ 1 PR (`storyDesignOffered`); it draws only when a design is stored or the ticket has 2+ PRs
   (the server's `too_few_prs`). When the last finished review skipped drawing it on a limit, the
   slot's `autoSkipped` is the status line (`autoSkippedLine`, `lib/sequenceDiagrams.ts`).

Between 1 and 2 (after `MemberCards` on the review path, after the brief on the other), with `me.ai`
only: **the docs check** — `Activity/StoryDocsAlignment.tsx`, the SPA half of "Check a story against the
docs" ([docs/REFERENCE-DOCS.md](REFERENCE-DOCS.md) § Check a story against the docs, [docs/API.md](API.md)
§ Check a story against the docs). It is the Story section's ONE new block, not a reference card.

- **Reads only in the story view.** `useStoryDocsAlignment` (`hooks/useStoryDocsAlignment.ts`, key
  `['story-docs-alignment','ws:<id>',ident]`, `enabled = ai.enabled && workspaceId != null`, staleTime
  10 s) is called from `TicketStorySection`, which the board never mounts. It polls (1.5 s — a check is one model answer) ONLY while the
  newest run is `queued`/`shortlisting`/`reading`. The start mutation carries ONE key
  `['story-docs-alignment-start','ws:<id>',ident]` (`useStoryDocsStarting` reads it with
  `useIsMutating`), so every story tab of the ticket shows the same "Checking…"; `onSettled` invalidates the read.
- **The block** renders nothing when `available` is false and nothing was ever run. Heading "Docs check" +
  the ⓘ (Sonnet over the whole library when it is short, else over the sections Haiku picks; only linked
  points are kept; where the criteria come from; manual only; nothing changed ⇒ the same check back; what
  "Out of date" means). Its button sits in the Story heading row
  (`StoryDocsButton`), inside `AiRunGate`, shown only when `available` ("Check against docs" /
  "Checking…" / "Check docs again", `docsButtonLabel`). Progress words
  are status-derived (`docsProgressText`: "Choosing sections…", "Reading the docs…"), a failed run's
  `error` is a red line, a refusal prints `STORY_DOCS_REFUSAL_TEXT`. A click the server answered `reused`
  (nothing changed since the shown run) prints "Nothing has changed since this check." with "Check again
  anyway" (`start.mutate({force: true})`, inside `AiRunGate`) and hides an older failed run's red line. The drawn run is `shownRun`: the newest
  when it succeeded, else `lastSucceeded`, so a re-run in flight or a failure never hides the last good
  result; "Out of date" when its `current` is false. The result: a verdict chip (WORD + icon, never colour
  alone; the ticket review's measured met/partly/not-met chip classes), the 2-3 sentence summary, "What to
  do" bullets, "Other parts of the story" rows, or one line for `no_relevant_docs` / `nothing_grounded`.
- **Per-criterion notes sit UNDER the existing criteria rows**, through an optional prop on BOTH lists:
  `BriefSummary`'s `docsItems` (keyed by `c.n`) and `TicketResults`' `docsItems` → `CriterionRow`'s `docs`
  (looked up by array position `i + 1`, i.e. `AC{n}`; drawn in BOTH branches — the compact met line and the
  card). A criterion with no item draws nothing. The PR pane's `TicketCoverage` passes nothing. ⚠ **Notes
  attach ONLY to the list they were written against** — `criteriaMatch` (`lib/storyDocsAlignment.ts`,
  test/storyDocsAlignment.test.ts): the run's `criteriaSource` equals the section's summary kind (review ⇒
  `ticket_review`, brief ⇒ `brief`) AND each checked criterion reads like the shown row at its number
  (whitespace/case-folded; a server-clipped text matches the row's start). Each summary folds this against
  its OWN list (`useDocsNotes`): the review's criteria are known only inside `ReviewSummary`, which keeps
  the section's single `useTicketReviewById` read. Otherwise — and always for a `derived` run — the block
  draws the run's own numbered list with the notes under it.
- **Every reference is the existing in-app opener**, `DocLink` (now exported from
  `components/DocReferences.tsx`): plain click ⇒ `openDocsSection(ref.workspaceId, path, anchor)`, modified
  click ⇒ the `docsDeepLink` href, with the quote as the same italic blockquote beneath. Never a raw href.

## The merge-conflict resolver (`components/conflicts/`, CORE)

The three-pane overlay behind **Resolve conflicts**. What it is, what the wand does and how it
lands: [docs/MERGE-CI-TRUNK.md](MERGE-CI-TRUNK.md) § Resolving conflicts in the app. The SPA
landmines:

- **`ResolveConflictsButton` is the ONE entry, and three surfaces mount it** (the PR pane's
  Conflicts row, `MergeControl`'s expanded conflict box, the Pending `conflicts` card). None
  re-implements the gate; a caller that needs to know whether it will render anything asks the same
  `useConflictResolverEntry`. ⚠ **It fetches nothing** — the gate is four synced facts plus the
  App-root `['me']` cache, so fifty cards on a board issue zero requests, and `?? false` while
  `['me']` loads (an undefined capability must not render a button that 404s on the first click).
- **With `me.ai.enabled` the entry is a MENU — "Resolve manually" / "Resolve with Claude"**
  (MERGE-CI-TRUNK § Resolve with Claude). Still zero requests on mount: the run lives in the module
  store `hooks/useConflictAiResolve.ts` (keyed by PR id, read through `useSyncExternalStore`, so
  every mount shows the same run), and polling starts only on the click. Only the AI Fix tab's card
  RESUMES a run on mount (one GET, the PR pane). The overlay applies Claude's answer through
  `useClaudePrefill`, mounted AFTER the seed effect so the decision store already holds the key;
  `store/conflictClaude.ts` remembers which decisions are Claude's and `useClaudeMark` shows the
  chip only while the live decision still matches. `'edited'` lines reach the centre pane through
  `seedEditLines` (`useRegionEdit`'s module map, with a listener so a mounted pane re-reads it).
  ⚠ **HIDE, never disable.**
- **The overlay mounts in `App.tsx`, not inside `PrDetail`** — it opens from three places and must
  not unmount when the pane behind it closes. It is OPAQUE (`z-[60]`, above an expanded header toast's
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
- ⚠ **AFTER A PUSH, EVERY WAY OUT IS `'committed'` AND REFETCHES AGAIN.** A push may have landed
  when `pushMayHaveLanded(commit, commitMutation)` (`store/conflictResolver.ts`) says so: the stream
  says done; OR the commit POST is still on the wire (checked BEFORE `failed`, so a retry is covered
  while the last failure still shows); OR the 202 arrived, or the stream says running, and the
  stream has not said failed; OR `LandingStep`'s outcome-unknown close fires. Every way out (header
  Close, Escape direct or through the confirm bar, `popstate`, the result panel, `LandingStep`'s
  close) then files `closeReasonAfterPush(…)` = `'committed'`, so `ClosedResolverToast` ("nothing
  pushed") is never offered after a push; a refusal still offers it. The shell's unmount effect
  re-runs `invalidateAfterPrWrite(qc, prId, {armed: true})` whenever a push was EVER possibly sent
  in this shell (a sticky ref; one extra refetch is cheap). The reason: GitHub attaches a push and
  recomputes mergeability seconds later, so the one refetch at "done" can still read conflicting,
  and the Pending `conflicts` card used to outlive the resolver. Pinned by
  `test/resolverPushClose.test.ts`.
- ⚠ **THE HEAD-MOVED GUARD GOES QUIET ONCE A PUSH IS SENT**: `headMoved = useHeadMoved(…) &&
  !pushSent`. Our own push comes back as `pr.headSha`, off both the pin and the anchor; with the
  shell polling the PR, that would put the head-moved warning next to "Confirming…".
- ⚠ **THE SHELL POLLS THE PR ITSELF, BUT NEVER AS A SECOND POLLER.** `ResolverLivePoll` mounts
  `usePrLiveRefresh(prId, true)` only while `useLivePollOwner` says no OTHER enabled observer of
  `['pr-refresh', prId]` exists, counted through a query-cache subscription. Ownership is state set
  BEFORE the poller mounts, so its own observer is already accounted for (deriving it from
  registration races and can mount/unmount in a loop). Opened from the PR pane, PrDetail's poll
  carries on under the overlay; opened from a Pending card, the shell polls, which keeps
  `useHeadMoved` live and lets the post-push state arrive. It pauses in a hidden tab and does not
  poll a PR that is not open.
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
- ⚠ **"TAKE THIS SIDE" (for ONE change) IS THE GUTTER ARROW AND NOTHING ELSE.** `ours`/`theirs` used to sit on the
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
  under the centre cell (the per-hunk "Ask Claude" panel that shared it is REMOVED), for three reasons that each cost something if ignored: `data-mr-cell`
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
  the strip word `Your text` is what says so. Editing is CORE; `unchanged` context is
  read-only and the server refuses it.
- ⚠ **"Ask Claude" is ABSENT, not disabled, while AI is off.** The resolver does its whole job
  without it.
- ⚠ **AN UNSUPPORTED FILE IS LISTED AND DISABLED, NEVER HIDDEN** (`FileMenu`) — it is exactly why
  the PR stays conflicted after a commit, and hiding it leaves nothing on screen to explain that.
  No "partly decided" ring either: a part-decided file says `1 of 3 decided` in words, which is also
  the only form carrying its denominator.
- **The wand's sentence names its own population.** It runs per FILE and counts CONTESTED regions,
  while the header counts every DECIDABLE region across the whole pull request — so a bare "Nothing
  left to decide." sat beside a countdown at a different grain and the two flatly contradicted each
  other on screen. It says "…in this file".
- ⚠ **EVERY PER-FILE NUMBER IS THE GATE'S POPULATION.** The file-menu TRIGGER quoted contested
  regions (`· 1 conflict`) beside a menu row reading `6 to decide` and a Commit button held shut by
  all six — three numbers about one file, and the only one visible without opening the menu was the
  one that understated the work. It also never counted down, because `tally.conflicts` is the file's
  total rather than its remainder. The menu ROWS fold through `fileRowState`; the toolbar now prints
  **"This file: N of M changes left" beside "All files: N of M changes left"**, both off the shell's
  ONE `CommitPlan` (`plan.rows` for the file, `decidedTotal`/`decidableTotal` for the whole), and the
  trigger carries the PATH ONLY — "2 of 6 decided" beside "4 of 6 changes left" was one fact twice.
  The toolbar counts DOWN, the footer counts up; same population, same denominator.
- **"Take your file" / "Take main's file" make the result one branch's version of the WHOLE file**
  (`wholeFilePlan` in `lib/mergeResolver.ts`) — one `apply`, so one undo entry, and they overwrite
  what the reader had already decided in that file, a hand-typed edit included. ⚠ **"Your file" is
  not `'ours'` everywhere**: a region only the other branch changed takes `'base'` (this side's
  version is the ancestor), and `both_same` under "main's file" takes `'ours'` — it offers no
  `theirs`, and `'base'` there would drop an edit main also made. `mergeResolver.test.ts` folds
  every kind through `centreLines` and asserts the result IS that side's text. ⚠ **No key is bound
  to either** (the one toolbar verb without one): `←`/`→` already mean "take this side" for ONE
  change, and a reflex key that rewrites a whole file is not a shortcut. They do not retract the
  gutter-arrow rule below — the arrow is still the one per-CHANGE route to a side; these name the
  FILE so the two never announce alike. Not the wand either: the wand never picks a side because it
  acts for the reader, and this is the reader picking one.
- **`ClosedResolverToast` is a card in the ONE header toast strip**, never its own `fixed`
  element; Reopen stays on its one line.
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

## The Settings modal is TABS, one per area, and the GRAIN split lives inside each tab

`components/settings/SettingsModal.tsx`. A wide dialog (`w-[60rem]`, fixed `h-[85vh]` so a tab
switch never resizes it) with a vertical tab list on the left and one area on the right; below the
`sm` breakpoint the list becomes a scrolling top row. Which section lives in which tab is DATA,
`settingsTabs.ts` `SETTINGS_TABS` (global names first, then workspace names), pinned by
`test/settingsTabs.test.ts` — every `*Section.tsx` file is listed in exactly one tab, and the modal's
`SECTIONS` map names each one.

Inside a tab the old two-halves rule still holds: global sections first, then ONE
`Workspace · <name>` heading and the tab's workspace-scoped sections beneath it. Every tab with
workspace sections draws that heading. Before the halves, the two grains were interleaved and the
only thing announcing a section's grain was a `— acme-web` suffix on its own title.

| Tab | Global sections | Workspace sections | Gate |
|---|---|---|---|
| Pull requests | `LargePrThresholdSection`, `BlastRadiusSection` | — | none |
| Pending | `MyTurnSection` (per ACCOUNT) | `PendingMuteSection` | none |
| AI | `AiProviderSection`, `ClaudeSpendSection` | — | tab shown only with `me.ai.enabled` |
| AI review | — | `AutoReviewSection` (auto review, auto-post, auto fix, diagrams), `ReferenceDocsSection`, `RelatedReposSection` | tab shown only with `me.ai.enabled` |
| Reports and sprint | — | `FlowSettingsSection` (working hours and budgets), `SprintSection` (cadence + comparison window) | none |
| Integrations | — | `IssueLinksSection` (tracker + Jira API access, shown whenever the SAVED tracker is Jira with a base URL — not behind `me.ai.enabled`), `SonarSection`, `SlackSection` (the "Claude review ran" switch only with `me.ai.enabled`) | none |
| Bots | `BotScoringSection` (renders nothing under `LIMN_ML_DISABLED`) | `DependencyAutoMergeSection` | none |

(`GithubAppInstallSection`, `BenchmarkConsentSection` and `YourDataSection` were removed
2026-10-22 with the hosted mode; so was every `caps.*` / `proReady` gate — the modal opens with no
`/api/pro/settings` wait.)

- ⚠ **EVERY PANEL STAYS MOUNTED; only the selected one is shown (`hidden`).** A half-typed form
  must survive a look at another tab (each section re-seeds only when its STORED value changes), and
  every section's GET still fires on open, as the single panel did — so the demo recording answers
  every tab. One scroller serves all panels and resets to the top on a tab switch.
- **Tabs are a real tablist**: `role=tablist/tab/tabpanel`, `aria-selected`, `aria-controls` /
  `aria-labelledby`, roving `tabIndex`, automatic activation. Arrow keys move in BOTH orientations
  (Up/Left back, Down/Right forward, wrapping), Home/End jump (`tabForKey`). With no section to land
  on, opening focuses the selected tab. Escape still closes the modal (capture phase, as before).
- **Which tab opens**: a `SettingsFocus` opens its tab (`SETTINGS_FOCUS_TAB`: `my-turn` → Pending,
  `issue-tracker` → Integrations, `claude-spend` → AI), else the tab last shown in this page load
  (`lastTab` in `store/settingsModal.ts`, memory only), else Pull requests — never a tab that is
  not on screen (`initialSettingsTab`). Not in the URL.
- **The demo scripts click tabs**: `verify-demo.mjs`'s `openSettingsTab(name)` and
  `record-demo.mjs`'s `scrollModal` (visits every tab). A hidden panel's text is not in
  `innerText`, so an `expect` on Settings text must open the right tab first.

- ⚠ **THE HEADING IS THE NAMING RULE NOW, AND IT IS STILL LOAD-BEARING.** There is no workspace
  picker in Settings — the rail's selection is the scope — so a screen that does not say which team
  it is retuning is a set of controls with a hidden blast radius. What changed is that the name is
  stated ONCE, as a BOUNDARY rather than a suffix, which also marks which settings are *not* a
  team's. Sections below it name a workspace only in a sentence that names a DIFFERENT one
  (`SlackSection`'s cap disclosure). A workspace-scoped control mounted anywhere but under that
  heading (in its tab) names its workspace itself.
- ⚠ **A CONTROL AT THE ACCOUNT GRAIN GOES ABOVE THE HEADING, WITH ITS OWN SAVE.** One Save spanning
  two grains is how an edit meant for one team travels to every team. The comparison-window mode was
  the last such control and it is gone from the account grain (platform 0032) — so `SprintSection` has
  one Save because it has one grain, not because mixing became safe.
- ⚠ **`workspaceId === null` HOLDS BACK EACH TAB'S WHOLE WORKSPACE PART, IN ONE PLACE.** Three sections each
  rendering their own `ScopePendingSection` under a heading that cannot yet name anybody reads as
  three broken sections rather than one unfinished request. Each section KEEPS its own guard — that
  one sits at the point of the WRITE, where a PUT with no `?workspace=` would be answered by the
  account's Default.
- ⚠ **The HEADING renders on the scope alone** and no section waits on a request it does not read.

### `MyTurnSection` — Settings → My Turn

What counts as your turn, the order My turn lists the types in, and the Do next weights every
Pending tab ranks by. ACCOUNT-grained (one account is one reader, every workspace), carried RAW by
`/api/me` (`myTurnSettings`), so it sits in the global half above the `pro_settings` gate like its
two neighbours. One Save for the section. The server contract is [BACKEND.md](BACKEND.md) § My Turn
— Settings: gates and promotions; the route is `PUT /api/me/my-turn-settings`.

- **Four parts**: "Show in My Turn" (a checkbox per summons type, each with a one-line hint;
  "Finished Claude reviews" only where `me.ai.enabled`), "Add to My Turn" (the four own-work
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
  (Claude reviews where agentic AI is off) keeps its place and a move steps over it. After a move,
  focus returns to the same button of the moved row (or its other button at an end), and a
  visually hidden `aria-live` line says where it went ("“@mentions of you” moved to 1 of 15"),
  counting only the rows on screen.
- **Opening straight to it**: `store/settingsModal.ts` (zustand, not persisted, not in the URL)
  holds the modal's open state and a `focus`, so Pending's "Customise" can open it from deep in the
  Activity console. With `focus: 'my-turn'` the modal opens on the Pending tab, scrolls the
  section's heading into view and focuses it, one frame after mount. ⚠ `closeSettings` is a store action, so it is referentially
  stable and SettingsModal's capture-phase Escape handler registers once — never pass an inline
  arrow.
- **One save moves five reads, together** (`useSetMyTurnSettings`): `['me']` (seeded at once from
  what the server stored), `['my-turn']`, and the three board keys `['attention-cards']`,
  `['daily-brief']`, `['work-plan']`. The notification watcher then RE-BASELINES on the new
  `configKey` rather than announcing the backlog of a type just switched on (§ Per-workspace "My
  Turn" below).

### `PendingMuteSection` — the Pending mute (CORE)

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
  targets `bot-settings-panel` on Bots Monitoring → Classification instead.

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
- `--ai-signal` is the TEXT-SAFE accent. ⚠ **Since the redesign it is VIOLET, not vermilion**:
  `#6B3FC0` light / `#B69CFA` dark. The brand vermilion (`#B53621` / `#F26B4E`) sat within a few
  degrees of `--ui-danger` (`#B82A26` / `#F07572`), so every AI action and sparkle read as
  "blocked" — against the colour rule (red = what blocks). Measured: on `--ai-surface` 6.49:1,
  `/15` wash 5.17:1, on `--ui-sel` 5.42:1 (light); 8.33:1 on `--ui-bg`, 6.67:1 on `--ui-sel`
  (dark). The landing and `Wordmark` keep the brand vermilion. `--ai-signal-fill` (`#7C4DDB`) is
  **NON-TEXT ONLY** — meters, strokes, rules; dark collapses both to one violet.
- Solid CTAs are `bg-ai-signal text-white dark:text-gray-950`.

**⚠ The surviving `violet-`/`purple-`/`indigo-` hits are a deliberate KEEP-LIST, not leftovers.**
`rg -n "violet-|purple-|indigo-" apps/frontend/src` should return only these; do not "finish the
migration".

| Kept | Why |
|---|---|
| the `#8957e5` maintainer shield (`MaintainerShield`, `Timeline/userRow.ts`, `UserSelectPanel`, `PeriodPeopleSection`) | maintainer identity, not AI |
| `MergeControl` / `MergeWhenReadyControl` / PrDetail's "Auto-merge armed" chip, `HeaderToasts`' `merge` tone border, This Sprint's "has a pull request" card dot (`TicketCard`) | the merge family |
| `lib/ui.ts` event-category colours + `.ev-*` dots, `ML_CATEGORY_COLOR`, `BOT_VENDOR_META` vendor accents, `charts/common.tsx` `PALETTE`/`SERIES_COLORS` | DATA ENCODING — hues must stay identical across every chart |
| `PeriodReportsPanel`'s `LANE_META` (`ai_review` violet, `release` indigo) | the 7-lane palette needs 7 stable distinct hues; vermilion collides with the red already in charts |
| `BotRoiPanel`'s inflation under-call violet | direction encoding — the drill-down matrix keys on the same hues |
| FeedView's "PR events" indigo pill (and the matching card icon), and the PR-event `Kind` sub-chips under it | feed category-pill palette |
| `ChecksTab` / `AttentionCards` "Assign" buttons | suggested reviewers are deterministic CORE (CODEOWNERS + inference) — no model, so not an AI marker |
| `MetricsDetail` / `PinnedTabsBar`'s `violet` tone (Flow metrics) | core deterministic drill-down; a generic active accent |
| `index.css` `.tl-repo-tint-1`, the cross-person chips | timeline layout encoding |

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
- ⚠ **`--mr-conflict` IS NOT `--ai-signal`.** Vermilion is the AI surface's accent; a merge conflict is not an AI marker, and borrowing that hue would make every
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
| Conflict resolver's three panes, compare-base popover | `conflicts/CodeCell.tsx`, `BasePopover.tsx` | the session's file |

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
  `DiffHunk`, `CodeAnchor` and `ClaudeReviewTab`'s `hunkLineClass` each keep their `@@` and context styling, which is not an add/del claim.
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
  CI logs. Neither has a file path, so neither has a language.

⚠ **A hex a component DERIVES a wash from cannot become a var.** `FeedView`'s `itemGlyph`
returns `{color}` and the chip paints `background: glyph.color + '1a'`. A theme-flipping glyph would
need a className branch, not a var in the hex table.

## ML severity badges + the Bots severity rollup

Bot comments carry a severity/category badge, threads a worst-severity rollup, the Threads only view a
severity filter, and the Bots ROI tab a "What the bots are flagging" block. All of it reads ONE
per-PR query (`['ml-labels', prId]`, `staleTime: Infinity`) — the badge never fetches, and a
target with no label renders nothing. Gated on `MeResponse.mlSeverity` (a TOP-LEVEL field). `threadSeverityFilter` is a global store field and carries the same
`selectedPrId === prId` guard as `threadStateFilter`. Detail: [ML-SEVERITY.md](ML-SEVERITY.md).

## The Feed: people OR bots, one Feed, icons on the cards

- **ONE FEED, TWO SIDES, NEVER MIXED.** A segmented `Humans | Bots` control (`feedAuthors`,
  transient, URL-silent, default `'humans'`) sends `?authors=humans|bots`. The server splits per
  ITEM by actor against `hiddenBotUserIds` — the UNION `users.isBot` ∪ `github_type='Bot'` ∪
  vendor logins ∪ the workspace's automated reviewers (a manual "human" winning both ways; the
  Timeline's default bot hiding reads the same union) — before the page
  cap — so a thread a person and a bot both replied on shows on BOTH sides, and an actor-less row
  is a person's. The old Bots-rail bot feed (`botsMode`, `botsOnly`, `botWindowDays`, vendor
  pills) is DELETED; Bot-only-PRs "Show in feed" now opens the Feed's Bots side with the PR
  isolated.
- **A person's activity tab hides the toggle** and picks the side from the subject (all viewed
  actors bots → `'bots'`, else `'humans'`), derived for the render, never written back.
- **No My Turn, Needs review, Claude Reviews or CI-failure pills, and no such items** — Pending
  owns them. My Turn survives only as the card's yellow border + reason pill.
- **Each card wears its filter pill's icon** (`FEED_PILL_META`: Comments → `CommentIcon`, PR events
  → `PullRequestIcon`, Commits → `CommitIcon`), in the pill's ink, `aria-hidden`. The PR-event
  chips have no icons, so every PR event wears the pill's. One table feeds the pills AND the cards.
- `FILTER_STORAGE_VERSION` is 5: the v4 → v5 step drops the retired `feedCiLens`.

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
  rendered; and the feed is an infinite query keyed on `feedSearch`, so every chip click would
  discard pages the reader had already paged in.
- **The badges are the server's `counts.byEventType` facet** — the whole loadable stream, keyed by
  chip, independent of which chips are pressed, with the loaded-page fallback every other badge
  here carries for a stale IndexedDB response. The subtotals sum to the parent's `prEvents` badge,
  which stays the WHOLE bucket: the pill is the way back out of a narrowing, so its count must not
  shrink as chips are pressed. A 0-count chip stays pressable, like every sibling pill in these
  rows.
- **The empty-state ladder names the pressed chips** ("No Opened or Merged PR events in this
  window."), in the row's display order rather than click order. That is the third channel making
  the row legible beside the pressed state and the count line — never ship an include-only toggle
  whose only feedback is a count. Every other narrowing on the screen is now a pure per-item pill
  (or the server-side people/bots split, whose facets the server counts over the same stream), so a
  pressed chip is the only thing that can have emptied the list.
- The group labels in this block (`State`, `Kind`) were 10px uppercase-with-tracking
  and are now **11px, muted pairing** (`text-gray-500 dark:text-gray-400`), matching the new
  `Kind` label rather than leaving one row correct and its neighbours not.

## The Activity Feed auto-inserts, and marks what's new (`feedNewCohorts`)

**There is NO "↑ New activity — Refresh" button any more.** Newly-arrived activity is spliced
into the cross-repo Feed as it arrives and the inserted cards wear a **"New" chip** until the
reader has seen them. Content is never withheld behind a click, and nothing sticky sits over the
feed. (`FeedView.tsx` + `useFeedAutoInsert` in `hooks/useConsolidatedFeed.ts`.)

- **CROSS-REPO FEED ONLY.** `FeedView` has FOUR mounts sharing one `FeedRow` — the cross-repo
  feed, the unresolved-repo fallback, the per-repo console and a person's activity tab.
  Auto-insert AND the marker are gated on the single predicate
  `isCrossRepoFeed = repoId == null && userIds == null` — the same one the server
  "seen" marker uses. The narrowed views are things someone opened on purpose; keeping them live
  would answer a question they didn't ask.
- **The head poll became the insert source.** `['feed-head', ws, search]` still polls every 60s,
  visibility-gated (`refetchIntervalInBackground: false`), but at **`limit: FEED_PAGE_SIZE`, not
  1**. That width is the CONTIGUITY GUARANTEE, not appetite: the server folds the whole stream
  either way (`counts`/`uncappedTotal` are whole-stream facets), so the limit costs payload, not
  query work — and a head as wide as page 0 is what lets `planFeedHeadMerge` PROVE the two lists
  overlap. ⚠ Its scope inputs must stay byte-identical to `useConsolidatedFeed`'s; real rows are
  spliced now, so a divergent `authors`/`includeAllCommits` injects rows the
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
  reads the old key's list. Every re-key (People ↔ Bots, Commits off→on) then mints a spurious cohort of "New" chips on rows that were
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

## Dismissing a My Turn entry, and one card per PR

**Every my_turn card carries "Dismiss"** (`MyTurnActions` in `Activity/AttentionCards.tsx`, the
trunk card included) — for the item the reader cannot act on now, or ever. The rule is the server's
(docs/BACKEND.md § My Turn — dismissals and one card per PR); the SPA asks, re-reads and offers a way
back:

- ⚠ **Keyed on the SUBJECT, never the card** — `{kind: 'pr', id: prId}`, or `{kind: 'repo', id}` for
  a red branch. The board lists ONE card per PR, so a card-keyed dismissal would surface the PR's
  next job in its place and read as "Dismiss did nothing".
- ⚠ **NOTHING IS SPLICED OUT LOCALLY** (`hooks/useMyTurnDismiss.ts`). The mutation stays pending
  ("Dismissing…") until `['my-turn']`, `['attention-cards']`, `['daily-brief']` and `['work-plan']`
  have refetched — the My Turn settings save's list — so the card and every count move in one frame
  and `capFor`'s `shown === count` pairing never sees a half-updated board. Per-target mutation key.
- **Two ways back**: the ONE `UndoToast` in the header strip (10s, "Undo", `z`; the old
  per-card `MyTurnDismissToast` is deleted), and the **Dismissed** disclosure under the My turn tab (`MyTurnDismissedList`, shut by
  default, fed by `AttentionCardsResponse.myTurnDismissed`, each row "Bring back"). Its count is its
  own length and appears in no tab badge, chip or lens.
- ⚠ **A RESTORE MUST NOT RING.** A restored entry comes back with its OLD clock and a new id in the
  notification watcher's diff, so `useRestoreMyTurn` sets a one-shot flag
  (`consumeMyTurnRebaseline`) and `useMyTurnNotifications` re-baselines instead of firing. A
  dismissal needs no flag (items only disappear), and a dismissal VOIDED by new activity must notify,
  which is why this is a client flag and not a `configKey` term: rows are also deleted by discharge
  on a read, and a key over the rows would swallow that same poll's real arrivals.
- **One card per PR is the server's** (`onePerPr` inside `getMyTurn`, for the board's fold only) —
  the SPA renders what it is sent and must not dedupe again. The browser notification keeps
  per-item granularity because `GET /api/my-turn` is not deduplicated.

## Per-workspace "My Turn" — the banner, the dropdown badge and the one deep-link

You can have work on your plate in a workspace you are not currently in. Three surfaces say so,
and they are ONE fold: `hooks/useMyTurnByWorkspace.ts` over the existing
`['daily-brief', ws:<id>]` key.

- **ONE POPULATION EVERYWHERE — standing `my_turn` CARDS, not "new since you looked".** The
  number is a `DailyBriefCounts` my-turn figure, i.e. literally how many `my_turn` cards
  `GET /api/attention` paints for that workspace. So the banner line, the dropdown badge and the
  board a click opens are the same list and the same figure.
- ⚠ **A SURFACE THAT NOTIFIES COUNTS `myTurnPersonal`; A SURFACE YOU OPEN COUNTS `myTurn`.**
  The welcome-back banner, the Workspace-dropdown badges and the
  browser notification reach FOR the reader, so they count only what personally involves them
  (`MyTurnCard.personal` — every type that names you: reviews requested of you, @-mentions,
  replies to you, pushes since your review, your PRs, any type you added in Settings, and — only if
  you switched "New PRs" on — new PRs in repos you MAINTAIN). Adding a repo you have never touched
  used to put every open PR in it on the banner — 425 of 459 items on the reporter's account; "New
  PRs" is now off by default as well. The
  Pending BOARD keeps the BROAD `myTurn`: that work is real,
  it is just not yours, and hiding it would delete work rather than route it.
  ⚠ Absent narrow fields (a response predating the narrowing) ⇒ fall back to `myTurn` /
  `myTurnTotal`. Over-notifying is the safe direction.
  ⚠ The banner used to render `MeResponse.newFeedItems` and both halves of that were wrong at
  once: the count was ACCOUNT-WIDE while the banner sat inside one workspace, and the gesture
  that cleared it (viewing the Feed) was WORKSPACE-scoped — so reading workspace A zeroed a
  number that was mostly workspace B's, and the figure opened no list. There is therefore **no
  per-workspace `seen` state and no schema change**: a line disappears when the work is done.
- **The Welcome-back strip is the sidebar's "Needs you" group now** (`NeedsYou`, still in
  `components/WelcomeBackBanner.tsx`): "Needs you · N" (N+ when capped), one row per workspace with
  a non-zero count (filled dot = the active one), "+N more" with the "Not counted here" note, and a
  × that hides it for the session (`store/shell.ts`). It shows only when it says something the
  Pending item does not — work in ANOTHER workspace, or an uncounted one; the ACTIVE workspace's
  figure rides the sidebar's Pending item (it was the workspace pill's badge).
- **`useFilters.openMyTurnInWorkspace(workspaceId)` is THE deep-link** — used by the
  `WelcomeBackBanner` lines (the strip's "Elsewhere" roll-up went with the strip). ⚠ A bare
  `setWorkspace` there HALF-navigates — it re-scopes and
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
  **`attentionRelevance: 'mine'`** (the deleted brief's "review or reply" line seated `'others'`,
  and its whole-kind lines **`null`**, for the same reason). Seating is not optional and a
  conditional seat is not enough: `setActivityRepo` early-returns an empty patch when the rail is
  already `attention`, so a lens left over from an earlier click survives the click that was
  supposed to change it.
- **`attentionRelevance` is a SIBLING of `attentionIsolation`, never a member of it.** That
  field is compared against `card.kind` and could not carry a second, orthogonal predicate. Same
  transience contract (`freshDefaults()` only, out of `FilterDefaults` ⇒ **no
  `FILTER_STORAGE_VERSION` bump**, cleared by any rail/scope change) and the same URL contract: it
  is a NAV key, `?attnRel=mine|others`, emitted only on the attention rail, parsed only for those
  two literals, and in `UrlOwnedState` so a pop onto a URL that omits it CLEARS it.
  ⚠ **IT IS THREE-VALUED BECAUSE THE (NOW DELETED) BRIEF HAD TWO MY-TURN LINES.** It shipped (8b8a2b1) as
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
  paints an EMPTY `'others'` board rather than a mislabelled full one — and `'others'` is now
  reachable only from a `?attnRel=others` link.
  ⚠ **`merge` AND `update_branch` ARE EXEMPT TOO, even though they DO carry `relevance`.** They
  carry it for the RANKER's weight, not as an ownership claim — a PR being ready to land says
  nothing about whose turn it is — and filtering them would stop the two lenses partitioning the
  board, which is the one job this predicate has.
- **The board's order, counts and narrowings are the tabs** — see § The Pending tabs. The
  cross-kind "Do next" head, its `head ∪ tail` partition, the head's suppression under an isolation
  and `AttentionIsolationBanner` are gone with it: `openMyTurnInWorkspace` or a link
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
  than borrowing the broad total. The "review or reply" half rides the wire as its own population
  (`myTurnOther` / `myTurnOtherTotal`), and ⚠ **`myTurnOther` is never `myTurn - myTurnPersonal`**:
  the arithmetic agrees, but a subtracted figure has no denominator of its own, and `capFor` gates
  the "of N" on `shown === count`, so any line built on it silently loses its cap. Both rules share
  one `capFor` body; extend it, never fork it.
  Pinned in `apps/frontend/test/myTurnCapDisclosure.test.ts`. The ROLL-UP cap (`ROLLUP_WORKSPACE_CAP`, server
  side) surfaces as `uncounted`: those rows render a dim "—" rather than a zero, plus a footer
  line in the dropdown and a line in the banner. ⚠ **Absence is not zero** — do not "tidy" a
  missing line into a 0.
- ⚠ **The dropdown badge is INFORMATIONAL; the ROW is a navigation** (reversed 2026-09-30; lands
  on Activity → Open PRs). A pick — the current workspace included — runs
  `useFilters.switchWorkspaceToOpenPrs(id)`: `setWorkspace(id, null)` → `showActivity()` +
  `setActivityRepo('open-prs')` → `clearSelection()` (the Timeline's selected PR belonged to the workspace left). Pinned PR / Focus
  tabs stay. All writes are synchronous in one handler, so `useUrlState` pushes ONE history entry.
  ⚠ `setWorkspace` itself NEVER navigates — URL hydrate, Back/Forward, `useWorkspaceSync`'s
  corrections, PrDetail's "Show in Activity feed" and the `WorkspaceManager` call it and must stay
  put. Pinned in `test/switchWorkspaceToOpenPrs.test.ts`.
- ⚠ **COST.** The hook rides the EXISTING daily-brief key (the one key the banner and badges
  share), but mounting it in the always-visible FilterBar and banner
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

## `MyTurnRelevance` — three labels, one split banner

`MyTurnCard.personal` shipped as a boolean and **conflated two different relationships**: "this is
tied to me" (I wrote it, it was requested of me, someone replied to my thread, I was @-mentioned)
and "this happened in a repo I maintain". A new PR by someone else in your repo is **orbit, not
ownership** — reporting the two as one figure is what made the banner read as a nag. `relevance` is
that boolean un-collapsed: `'direct'` · `'maintained'` · `'none'`. Wire contract:
[PLATFORM.md](PLATFORM.md). On the client:

- **THREE CARD LABELS, from `cardKindLabel` (`AttentionCards.tsx`)** — `'direct'` → "Your turn",
  `'maintained'` → "In your repos", `'none'` → the neutral `KIND_LABEL.my_turn` ("Review or
  reply"). The KIND stays neutral; only the CARD claims you.
  ⚠ **An ABSENT `relevance` renders the NEUTRAL label — even on a card with `personal: true`.**
  That is the opposite of the wire's tolerance rule (absent ⇒ personal, because over-notifying is
  the safe direction), deliberately: a missing field may never invent an ownership claim ON SCREEN.
  The only way to see it is a server too old to send the field, where the neutral label is true.
- The brief's two my-turn lines went with the strip; the wire still carries both halves
  (`myTurnPersonal`/`myTurnOther` + totals) and both lenses stay seatable (`?attnRel=`).
- **THE WELCOME-BACK BANNER HEADLINE IS ONE FIGURE** — "Welcome back · 5 need you" (+ the "+" cap
  disclosure). The "2 yours · 3 in your repos" split it printed was DROPPED 2026-10-07; the hook's
  `totalSplit` / `relevanceSplit` and the server's split fields remain (the dropdown tooltip still
  reads them) but the banner no longer does.
- The dropdown badge keeps the summed figure and carries the split in its **tooltip only**, where
  it costs no layout.
- ⚠ **`relevance` IS ALSO THE CARRIER OF THE PENDING MUTE.** Muting a workspace or a repo
  (Settings → Workspace → Pending mute) forces every one of its my-turn rows to `'none'` inside
  `getMyTurn`, so all of the above follows with no client change: the card relabels to the neutral
  string, the row leaves "Only yours", the
  banner split and the dropdown badges drop it, and `useMyTurnNotifications` stops firing for it.
  Nothing on the client tests for a mute. The one visible addition is a `muted` chip on the card —
  **DISPLAY ONLY**, off `MyTurnCard.muted`, so a card the reader last saw as theirs does not demote
  itself with no explanation. ⚠ **No counter, lens, cap disclosure or ranker may read that field**;
  a second classifier beside `relevance` is exactly the drift the single server-side fold exists to
  prevent.

## `ci_failing` — the red-build card, and the two SILENT lists a new InsightKind must reach

A `ci_failing` card is a red build the viewer is on the hook for: `arm: 'your_pr'` (an open PR they
authored whose head CI is red) or `arm: 'trunk'` (the default branch of a repo they MAINTAIN is red
now). Server contract + the two things it deliberately does NOT compute:
[PLATFORM.md](PLATFORM.md) § "The `ci_failing` card". On the client:

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
- The board states its cut with `capSentence`; the brief-line disclosure went with the strip.
- **It names the failing checks.** `FailingChecksLine` draws a 12px red line
  (`text-red-600 dark:text-red-400`, `CHECK_STATE_META.failure.icon` aria-hidden, an sr-only
  "Failing checks:") under the CI-dot/sha row, from the card's REQUIRED `failingChecks` /
  `failingCheckTotal` (null = no names known: nothing renders, never "0 failing"). The names
  truncate; "and N more" never does and is never only a tooltip. A promoted red trunk reaches this
  body through `asCiFailingCard`, which COPIES both fields (pinned in `pendingCardControls.test.ts`).
  Names are bare check/job names, never workflow-prefixed, unlike `BranchStatusPanel`'s
  `checkLabel` ("workflow / name"): the PR side stores no workflow name, so the cards keep one
  vocabulary. Shared rendering with the meta row: see *Every PR card names who opened it* above.

⚠ **TWO OF THE THREE CLIENT TOUCH POINTS ARE SILENT — only `KIND_LABEL` is compiler-enforced:**

1. `renderCard`'s `switch` in `AttentionCards.tsx`. Its `default: return null` means a kind the
   brief COUNTS but the switch cannot RENDER simply vanishes — "header 5, list 3" with no server
   involved. That is exactly how `my_turn` shipped invisible.
2. `INSIGHT_KINDS` in `hooks/useUrlState.ts`, a hand-written runtime array. A kind missing there
   makes `?attn=<kind>` a no-op, so a `?attn=<kind>` link opens an UN-isolated board and a
   browser Back cannot return to the narrowed one. **`test/ciFailingCard.test.ts` now compares that
   array against `KIND_LABEL`**, forwarding the compiler's exhaustiveness onto it.

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
- `SyncStatus` ALSO owns the post-write fast `['repos']` poll (5s for 150s after
  `noteLocalPrWrite`) and the per-repo `Repo.lastPrChangeAt` effect. That is a separate effect
  declared AFTER the walk effect, never folded into `mostRecentSync`, and its decision is the pure
  `decidePrChangeSweep`. See § The cascading sync.
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

## There is ONE header toast strip (`HeaderToasts.tsx`) + `GlobalLoadingBar`

⚠ **Never add an independent `fixed` toast element, and never a second strip.** The old
bottom-right column (itself the fix for three `fixed bottom-4 right-4` elements painting over
each other) is GONE: every toast is now a horizontal card in the top header, in
`<HeaderToastStrip>`, which fills the right of the slim `TopBar` (components/shell/TopBar.tsx; the
controls that used to flank it — Sync · bell · ? · theme · AI usage · user — are in the sidebar's
foot). App.tsx mounts, left to right: `UndoToast` (FIRST — it lives seconds and must be reachable
now; last, a merge pill pushed it past the bar's clipped edge at 768px), the Claude reviews frame,
`AiFixBanner`, `AiBudgetToast`, `ClosedResolverToast`, `DependencyMergeToast`, `AutoMergeBanner`,
`GlobalLoadingBar`. ⚠ A `SidePanel` SHEET starts BELOW the top bar (`[data-shell-topbar]`), never over
it, so the Undo for an action taken in the sheet stays on screen; an expanded card is `z-[60]`.

- **EVERY CARD IS THE SAME CARD.** One `HeaderToast`, one slot size (`h-7`, `w-28 sm:w-56 lg:w-64`;
  below `sm` the words are `max-sm:sr-only`, leaving the icon, the action and the X), one line
  layout: icon · label · summary · [one on-line action] · [X]. ⚠ **ONE LINE WHEN COLLAPSED, ALWAYS**
  — the words are `truncate` (nowrap + ellipsis) and the full text is in the expanded panel and the
  toggle's accessible name. ⚠ Never `sr-only sm:not-sr-only`: `not-sr-only` sets `white-space:
  normal` + `overflow: visible`, which beat `truncate` and wrapped "Merge when ready · 2 armed · 4
  merged" onto a second, clipped line inside the 26px card.
- **THE TOP BAR HAS A FIXED HEIGHT** (`h-11`, no vertical padding, `TopBar`). It used to be
  content-sized (`py-2`), so a 28px card made it 45px against 43px with no toast and the whole page
  jumped as cards came and went; measured 44px both ways now.
- **EXPANDS ON CLICK, NEVER ON HOVER OR FOCUS, and only when it has more to show** (`children` /
  `footer`, or a line truncated sideways — including the words hidden at a narrow width). The whole
  line is the click target; a `<button aria-expanded>` inside it is the keyboard stop (Enter /
  Space) and its click bubbles to the same toggle. A card that opened under a passing pointer
  covered the page the reader was aiming at. **The expanded panel is laid out the same on every
  card**: the card's line again (now wrapping, so the full text shows), then the rows (`ToastList` +
  `ToastRow`), then the `footer` (secondary actions such as `ToastShowMore` / "Dismiss finished",
  and a short note). The detail is MOUNTED ONLY WHILE EXPANDED, so nothing focusable hides inside a
  clipped one-line card. The panel lifts to `position: fixed` and OVERLAYS the page — fixed, not
  absolute, because the strip is a horizontal scroller and a scroller clips both axes. ⚠ **It
  anchors at the card's TOP-LEFT** (`anchorToastPanel`, `lib/toastAnchor.ts`): its top-left corner
  sits exactly on the collapsed card's, it grows RIGHT and DOWN only (at least 320px wide, at most
  448px tall), and only a panel that would cross the viewport's right gutter shifts left, by just
  enough. (The old "grow leftwards from the slot's right edge" rule existed for hover-to-expand,
  which is gone.) It closes on a second click on the line, on any press outside the panel
  (`pointerdown`, capture — so pressing another card closes this one before that one opens), on
  Escape wherever focus is, and on any scroll or resize (the rect is stale). Only one card is
  expanded at a time. ⚠ The X and the on-line `action` (`ToastLineButton`) STOP PROPAGATION, so
  dismissing or pressing Undo / Reopen never toggles the card.
- ⚠ **THE PANEL IS ITS OWN ONE SCROLLER, `overscroll-behavior: contain`, AND THE ROOT IS
  `overscroll-behavior: none`** (`index.css`). A fixed box's scroll parent is the VIEWPORT, not the
  pane under it, so a wheel the panel could not use chained to the root — and this app's root never
  scrolls, so on macOS the gesture became the root's ELASTIC OVERSCROLL: the whole shell slid up with
  a blank band at the bottom, and because a wheel gesture latches to the scroller it began on,
  wheeling the page afterwards kept rubber-banding it (a content pane reaching its own end did the
  same). Rows therefore never carry their own `max-h-* overflow-auto` (a second scroller is a second
  chain), and the strip is `overscroll-contain` too. Reproduced and verified by
  `scripts/.ui-artifacts/toasts2-verify.mjs` (blank rows at the bottom mid-gesture: 82 before, 0
  after).
- **ITS BORDER NAMES ITS SOURCE, AND ITS PROGRESS BAR WEARS THE SAME TONE** (`tone`,
  `HEADER_TOAST_TONE` — ONE record holding `border` and `fill` per tone): `ai`
  (`ai-signal-fill` — Claude reviews, AI fixes), `merge` (the merge family's violet — merge when
  ready, dependency results), `sync` (`sky-500` — loading data), `attention` (the Pending rail's
  `amber-500` — My Turn undo), `conflicts` (`--mr-conflict` — the resolver reopen), `neutral`
  default. Border ONLY on the card: the background stays neutral, and the icon and label already say
  the same thing in words. Error states keep their own red text and icon.
- **`HeaderToast` props**: `label` (leads the line, names the card's `role="group"`), `icon` (from
  `Icons.tsx`, `size={13}`), `summary`, `action` (ONE compact `ToastLineButton` kept on the line —
  Undo, Reopen — never hidden behind a hover), `onDismiss` + `dismissLabel` (the X, named
  "Dismiss …"; ABSENT = not dismissible, no X), `progress` (a bar along the bottom of the line, which
  stays on the collapsed card), `tone` (the border and the bar, above), `children` (the rows),
  `footer` (the panel's last line).
  Each toast keeps its own dismiss semantics: AI fixes and merge-when-ready offer the X only once
  nothing is still running/armed; the loading bar is an INDICATOR with no X and no action; the
  timed toasts (resolver reopen 20s, dependency results 15s, My Turn undo 10s) still auto-remove.
- **A CAPPED LIST NEVER ENDS IN A DEAD "+N more".** A card that draws only the first few rows
  (merge when ready: 4; dependency results: 3 failures) puts `ToastShowMore` in its footer: a
  button "Show N more" (`aria-expanded`, `aria-controls` the list) that reveals EVERY row inside
  the expanded panel, which scrolls within its max height, and then reads "Show fewer". It sits
  inside the panel, so clicking it keeps the card open and Escape still collapses it.
- **Claude reviews** (`ClaudeReviewBanner`) is a `HeaderToast` like the rest: "N running" / "N ready"
  on the line, each review (open it, or its own X once ready) in the expanded panel, the card's X once
  nothing is running.
- **The strip is the polite live region** (`role="status"`, `aria-atomic="false"`,
  `aria-relevant="additions"`) — cards are not, so a card (or a row in one) appearing is
  announced and a percentage ticking in place is not.

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
  freshen action. Rows are click-to-open (`openPrDetailTab`), capped at 4; a "Show N more" button (`ToastShowMore`, `HeaderToasts.tsx`) reveals every row inside the expanded card, which scrolls within its max height, then reads "Show fewer". Outcomes are still remembered 5 at a time.

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
  `sync/bot-resolution-markers.ts`, `platform/bot-themes/build.ts` and `db/queries.ts`
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

## Design diagrams (review tab section, the Story section)

`components/DesignGrid.tsx` is the ONE renderer of a stored `DesignDiagram` (Mermaid is GONE — no
`mermaid` or `uuid` dependency, no lazy chunk). A CSS grid: a narrow layer-label column plus one
`minmax(0, 1fr)` column per act, so it shrinks to the pane (Claude Review tab; the Story section of an
Open PRs stack or the story view) with NO horizontal scroll, labels wrapping and nothing under 11px.
Under 760px wide (NARROW) the layer names become a band heading above each layer instead of a side
column, so the stages get the width. Every card sits in a PADDED slot inside wide gaps — the space
the arrows run through. Only the layers some card uses get a row; empty slots stay empty. The pure
fold lives in `lib/designGrid.ts` (`layoutDesign`, `memberForRef`, `routeArrow`, `prBadgeTexts`;
test/designGrid.test.ts).
- **Cards**: change mark, pattern chip (11px) and PR badge on one line, then the label (13px, ≤ 2
  lines). The badge is `#N`, or `<repo part> #N` across repositories with the repos' shared word
  prefix dropped (`backend #498`, `harness #170`). The change mark is a WORD + icon (`New` + PlusIcon,
  `Changed` + PencilIcon) AND a border style (solid / dashed / plain) — never colour alone.
- **Arrows**: RIGHT-ANGLED lines with arrowheads in an SVG layer under the cards, routed by
  `routeArrow` ONLY through the slot padding and the grid gaps — out of the source's side, down the
  column gap beside the target, into its side; a card in the way sends the line to the row gap first
  (leaving off-centre, so it never shares a straight arrow's line). Re-measured by a ResizeObserver.
  ⚠ **LINKED CARDS SIT NEAR EACH OTHER** (lane boards, `orderByLinks` in `lib/laneBoard.ts`): within
  a lane the order of a column's cards is free, so each is placed at the mean row of the cards it is
  linked to (a barycentre sweep across the columns, both ways, four rounds); a card with no links
  keeps its place, and with no arrows the input order stands.
  ⚠ **NO TWO LINES SHARE A RUN** (`separateArrowRuns`, run on ALL the arrows after routing): runs on
  the same x (or y) whose ranges overlap are a BUNDLE, and each arrow in it gets its own parallel track
  (≤ `ARROW_TRACK_PX` = 17 apart, narrower to fit the gap + slot padding — the boards use a 48px column gap for it; an entry into a card's side spreads over half the card's height); which arrow takes which
  track is the order with the FEWEST crossings (`crossings`; every order for ≤ 5 lines), or lines
  turning out of the bundle cross at the arrowhead. The numbered marker sits on its own line clear of
  every OTHER line and marker (`placeArrowLabels`), so it never hides another arrow's head.
  A labelled arrow carries a NUMBER near the middle of its longest run, keyed in one line under the grid (a 20-40px
  gap is too narrow for words, and a label there covered card text). `aria-hidden`; the same
  hand-offs are an sr-only list. Cards read row by row.
- **Arrow popovers** (`ArrowLayer` / `ArrowMarker` in `components/LaneBoard.tsx`, shared by the design
  grid and This Sprint's boards): hovering an arrow's LINE (a 12px invisible hit stroke) or its NUMBER,
  or focusing the number, shows what the arrow means beside the number. ⚠ **HOVER / FOCUS ONLY — the
  click-to-pin is REMOVED** (2026-10-19): the panel is `pointer-events-none`, closes ~80ms after the
  pointer leaves, and Escape closes it. It is placed by `lib/avoidRects.ts` (test/avoidRects.test.ts):
  each side of the number at three alignments, clamped to the viewport, keeping the one that covers the
  least of the cards (`useRoutedArrows`' `cardRects`, passed as `ArrowLayer`'s `avoid`). The numbers are
  focusable (`tabIndex=0`), named "Dependency n: <words>". ⚠ The router hook (`useRoutedArrows`), the arrow
  layer with its numbered markers (`ArrowLayer`), the key (`ArrowKey`) and the sr-only list (`ArrowList`)
  live in `components/LaneBoard.tsx` and are SHARED with This Sprint's lane board (§ Activity → This
  Sprint), so the two draw one way; change them for both.
- **Click-through**: a card with files is a button. One file opens it; several open a small list
  (a floating-ui popover, the ONE open popover via `claimActivePopover`), each row opening its file.
  THIS PR's file → the review tab's `onOpenInChanges` (PrDetail's `openInChanges`: Changes tab, then
  the focus). ANOTHER PR's (a story card, or any card in the Story section) → the store's `openPrChangesAt`
  (mounts that PR's pane like `openClaudeReview`, and sets the transient `prChangesFocus`), which
  PrDetail consumes through the same `openInChanges` as a URL correction.
- **A VISIBLE KEY under the grid names each card border it draws** (`BorderKey` from
  `components/LaneBoard.tsx`, the SAME component under This Sprint's boards; `data-testid=
  "design-border-key"`), above the arrow key: "New: added by the change" (solid accent), "Changed:
  existing code it edits" (dashed accent), "Existing code it relies on" (thin grey) — `CHANGE_KEY_LABEL`,
  only the kinds present (`changesPresent`, DESIGN_CHANGES order, lib/designGrid.ts), each swatch the
  card's own `CARD_CHANGE` classes. ⚠ This REVERSES the old "legend only behind the ⓘ" rule: a key NAMES
  marks, so it is a label, not an explanation. The explanation (how Claude draws it, empty cells,
  click-through, when it redraws, check it before relying on it) stays behind the heading's ⓘ
  (`DesignLegend`).

`components/ClaudeReviewDiagrams.tsx` — `ClaudeReviewDiagramsSection` ("Design", mounted in
`ClaudesReview` after SonarCloud, absent without `me.ai`) shows the PR's slot and each multi-PR
ticket's "Story design" slot through `DiagramSlotView`; `Activity/StoryDesignSection.tsx` shows the
story slot as the last part of the story view's Story section (only with `me.ai` and a PR on the ticket, and it draws
only when the ticket has 2+ pull requests or a stored design; its Draw / Redraw button sits in the Story
heading row). The status folds live in `lib/sequenceDiagrams.ts` (test/sequenceDiagram.test.ts). ⚠
POLLING: the reads poll every 5 s only while a run is queued or running, and the PR read also for 90 s
after the shown review's `finishedAt` while nothing is stored at the current head for the PR OR for
any story of 2+ pull requests (the server queues them a moment AFTER the review is saved; a docs-only
PR's `no_code` row is current at once, so the PR slot alone would stop the wait before the story's row
exists). The Redraw buttons share one mutation key per subject (`useIsMutating`).

## SonarCloud (review tab section, picker card, Settings)

`components/ClaudeReviewSonar.tsx` holds `SonarIssueRow` (the ONE SonarCloud card — the review tab's
section and the AI Fix picker both draw it; the picker passes its tick box as `selection`) and
`ClaudeReviewSonarSection` (mounted in `ClaudesReview` after CI check, reading the STORED snapshot —
`usePrSonar`, never SonarCloud on mount; Refresh and "Post SonarCloud findings" are buttons, the post's
"Posting…" read off the shared mutation key with `useIsMutating`). Settings → Workspace → SonarCloud is
`settings/SonarSection.tsx`: draft + Save, a write-only token ("Saved" with Replace / Remove), per-repo
project keys with SonarCloud's `<owner>_<repo>` as the placeholder, and a click-gated "Test connection"
that asks for a save first. Contract: [SONARCLOUD.md](SONARCLOUD.md).


## Activity → Docs (the reference library)

A rail line under Pending, `activityRepoId: 'docs'` / `?activityRepo=docs` (parsed AND emitted —
pinned by test/docsRailUrl.test.ts). The rail ENTRY renders only on `me.ai.enabled`
(`useAiCapabilities`); a `?activityRepo=docs` link opened where AI is off still selects the pane, which
says in one line why it is empty. Contract: [REFERENCE-DOCS.md](REFERENCE-DOCS.md)
§ The SPA.

`Activity/DocsView.tsx` (library column + layout), `DocsViewer.tsx` (one library file), `DocsChat.tsx`
(the chat); server half `hooks/useReferenceDocs.ts`; view state (open file, expanded docs, the
conversation on screen, the narrow-width Read / Ask tab) per WORKSPACE in the module store
`store/docsView.ts` — not in the URL, not persisted. Pure folds in `lib/referenceDocs.ts`
(test/referenceDocsLinks.test.ts).

- ⚠ **ONE LINK RESOLVER, `resolveDocLink(fromPath, href)`**, for INDEX.md, CONTENTS.md, a section AND
  a chat answer (which speaks from the library root). It joins the relative link onto the file's
  folder, refuses `..` past the root, `/`, `%`, `?` and `\`, then holds the result to the client copy
  of the server's strict grammar (`parseLibraryPath`). Library → opens in the viewer; `#anchor` →
  scrolls the viewer's OWN box (never `scrollIntoView`); absolute → `safeExternalUrl`, new tab;
  anything else → plain text. It reaches the shared `Markdown` through its `renderLink` prop. Its optional
  `quoteFor` lookup gives a library result the checked `quote` it carries (the chat's citations).
- Headings get `data-doc-anchor` from a rehype plugin run AFTER the sanitizer (which prefixes every
  `id`), using a copy of the server's `headingAnchor` + duplicate numbering, so `#anchor` lands.
- The left tree is built from the structured `sections` (`docTreeRows`, the shape of CONTENTS.md),
  never by parsing CONTENTS.md; it is fetched only while that document is expanded, keyed on
  `builtAt` so a finished rebuild shows its new tree.
- **The left tree is COLLAPSED by default** (2026-10-26): `docTreeNodes` nests the flat rows (a row is
  the child of the nearest earlier row with a smaller depth), only the top level renders at first,
  and each row with children carries its own chevron button (`aria-expanded`, keyboard reachable; a
  group heading's title toggles too but stays out of the tab order). "Expand all" / "Collapse all"
  (`ExpandAllIcon` / `CollapseAllIcon`, `aria-label` + `title`) sit above it, open every
  `docTreeBranchKeys` key or none, and disable themselves when there is nothing left to do. The open
  set is `useState` in `DocTree` — closing the document forgets it; nothing reaches the store or URL.
- **Build progress**: an SSE stream per document the server is WORKING ON (`GET /api/docs/:id/stream`)
  patches its row in the list cache; `done` patches the status and invalidates the list, trees and
  sections. ⚠ **A `queued` row is NEVER streamed and at most `MAX_DOC_STREAMS` (2) are open**: each
  stream holds an HTTP/1.1 connection (~6 per origin), so a 20-file drop that streamed every queued row
  starved the uploads, the list poll and the chat, and the pane froze. The list polls as the fallback
  (`docsListPollMs`) — 3 s while a building document's stream failed or ended without `done`, 5 s while
  one is unstreamed (queued or past the cap), 15 s otherwise, never when nothing builds. ⚠ That
  "trouble" is PER DOCUMENT (a set of ids, pruned when one stops building), never one shared flag a
  later healthy stream would clear. The bar's words come from the STATUS (`docStageLabel`: Waiting
  to start / Converting / Splitting into sections / Indexing).
- **Adding**: a drop zone + file picker (each file sent as the raw body, one at a time; per-file
  refusals listed by name) and "Add web page". `AiRunGate` swaps the add controls (and Ask) when the
  runtime or credential is missing; Rebuild / Try again show only when `ai.ready`. Reading never needs
  either. Remove and Delete conversation confirm INLINE (no `window.confirm`).
- **The chat**: one shared mutation key per workspace (`useIsMutating`), and the completed turn is
  written in `useAskDocs`' HOOK-level onSuccess, which also seats a NEW conversation's id in
  `store/docsView.ts` (only while the reader is still on "new") — never a `mutate()` callback.
  Citations render as "Document › Section" buttons that open the section (at its anchor).
- **The wide layout is the reader's** (lg+ only; the stacked layout and the xl- Read / Ask tabs are
  unchanged): the library column COLLAPSES from the chevron in its header to a 40px strip (expand
  chevron, book mark, document count — the count is in the button's `aria-label`), and the
  library | viewer | chat widths are dragged on two `role="separator"` handles from
  `useResizablePane` (arrows / Home / End / Enter, double-click resets). The chat handle uses the
  hook's `side: 'right'` (the pane sits right of its handle, so dragging LEFT widens it). Ceilings come
  from the pure `docsPaneBounds` (`lib/docsLayout.ts`, test/docsLayout.test.ts): library 200–480, chat
  280–720, each capped so the viewer keeps 360px given the OTHER column's width; a floor still wins in
  a too-narrow row. All three are per-browser localStorage (`pierre:docsLibraryWidth`,
  `pierre:docsChatWidth`, `pierre:docsLibraryCollapsed`), never the store or the URL. ⚠ Widths are
  applied inline ONLY while the columns sit side by side (`useMediaQuery`), so a stacked layout is never
  pinned to a dragged width.
- **Settings → AI review → Reference docs** (`settings/ReferenceDocsSection.tsx`, beside Auto review,
  only on `me.ai.enabled`): "Use reference docs in Claude Review", draft + Save, OFF by default.

**Reference links from reviews.** `components/DocReferences.tsx` draws a run's checked `docReferences`
(the Claude Review tab's "Reference docs" section after SonarCloud; a compact block in Story check — the
whole story and this PR's share — and in This Sprint's Code check) and a finding's `docCitations`
("Reference: Document › Section"). A plain click opens the section in-app (`store/openDocs.ts`:
`openPath` → `showActivity()` → `setActivityRepo('docs')`); the
href is a DEEP LINK (`lib/docReferences.ts` `docsDeepLink`:
`/app/?workspace=&activityRepo=docs&doc=<slug>&section=<NN-name.md>&anchor=`) for a modified click / new
tab. ⚠ The URL hydrate seats it in `useDocsView.pendingDeepLink` (`parseDocsDeepLink`, the strict
grammar again) and the pane opens it ONCE, where the workspace is known, then expands that document; the
serializer never emits `doc`/`section`/`anchor`/`quote`, so the link is one-shot by design. Quotes and notes render
as plain text.

**The quote highlight** ([REFERENCE-DOCS.md](REFERENCE-DOCS.md) § The SPA → The quote highlight).
`DocsOpen.quote` (store) carries the checked words from every entry point — `DocLink` (`target.quote`:
review / ticket / story-docs references, and `DocCitationLinks`' `borrowedQuote` from the run's
references), the chat's citation buttons and inline links (`useDocLinkRenderer`'s `quoteFor`, looked up
in `message.citations` by `path#anchor`), and the deep link's `quote=` (≤ 300 chars on parse, plain text).
`DocsViewer` walks ITS OWN page's text nodes into segments (a block or cell boundary = one space), skips
the server header (the leading H1 + the blockquote after it), and asks `lib/docQuoteMatch.ts`
`findQuoteRanges` — the occurrence at or after the anchor heading wins, else the first in the body.
- ⚠ **Painted with the CSS Custom Highlight API** (`CSS.highlights.set('doc-quote', …)`, styled by
  `::highlight(doc-quote)` in index.css) — never a `<mark>` spliced into React's DOM and never a rehype
  plugin keyed on the quote (it would re-parse the memoised Markdown on every open). No API ⇒ scroll only.
  Cleared on every open, on Clear and on unmount.
- ⚠ **Explicit text colour in both themes** (the Search `<mark>` lesson); `textContrast.test.ts` reads the
  four hexes from index.css and measures them.
- Scrolls the viewer's OWN box (the passage a third of the way down; `.md-table-scroll` sideways too) —
  never `scrollIntoView`. Not found ⇒ the anchor as before, plus the strip's not-found line.
- ⚠ No RegExp over the document's text: the fold is a character walk, the search `indexOf`.

## The static demo runtime (`src/demo/`)

The website's `/demo/` is THIS SPA, built from a different entry with every `/api/*` request
answered in the browser from a recording. End to end (seed → record → build → serve):
[DEMO.md](DEMO.md); the format and matching rules: `apps/frontend/src/demo/README.md`.

- `vite build --mode demo` (`pnpm --filter @pierre-review/frontend build:demo`, or `dev:demo` on the
  Vite dev server) — `vite.config.ts` `limnDemo()` sets `base: '/demo/'`, writes `dist-demo/`,
  defines `import.meta.env.VITE_LIMN_DEMO = '1'` and rewrites `index.html` to load
  `src/demo/entry.ts` instead of `src/main.tsx`. ⚠ **The normal build is byte-for-byte unchanged**:
  the demo is a separate entry and a plugin enabled only in `--mode demo`, so no app module may
  import from `src/demo/`, and no app module needs to know it is in a demo.
- `entry.ts` loads the recording (`virtual:limn-demo-recording` → `data/recording.json` when it
  exists, else `data/sample-recording.json`), wraps `window.fetch` (`install.ts`), CLEARS the
  persisted query cache (`pierre-query-cache` in IndexedDB — a reload must start from the recording
  again), mounts the notice bar ("Demo: sample data, nothing is sent." — `banner.ts`, `demo.css`) and
  only then imports `../main.tsx`.
- ⚠ **The SPA's own URLs must follow `import.meta.env.BASE_URL`**, never a literal `/app/` — that
  is what lets routing work under `/demo/`.
- ⚠ **No inline script, no `eval`**: the site's demo CSP (`apps/site/src/security.ts`) holds the
  demo to the same `script-src 'self'` as the app.
- Writes are simulated into an in-memory overlay (`overlay.ts`, `routes.ts`); agentic starts replay a
  recorded finished run of the same kind (`runs.ts`, `sse.ts`). `window.__limnDemo.log` lists every
  request and which stage answered it.
- ⚠ **A route the SPA calls at boot needs a recorded answer or a `GET_FALLBACKS` entry**, exactly
  like the e2e fixtures (`e2e/mock-api.ts`, from which the sample recording is generated): an
  unrecorded GET answers `404 NotInDemo`, and an unguarded `.map` over a missing array blanks the app.

## Moved from CLAUDE.md (2026-10-26)

Verbatim text taken out of CLAUDE.md to keep it under its size budget. CLAUDE.md keeps a
shorter form of each rule; this is the full wording.

### The Feed

- **The Feed is a STREAM (`FeedView`) and nothing else** — no survey panels. It has no My Turn /
  Needs review / Claude / CI-failure items (Pending owns them). It has no sub-tabs: bot CLASSIFICATION is
  Bots Monitoring → Classification (since 2026-10-26). The "PR events" pill's `Kind` chip row is a PARTITION (empty =
  all four), client-side, NOT cleared when the parent goes off. A default flip on a persisted key
  needs a `FILTER_STORAGE_VERSION` bump (now v5; `migratePersistedFilters` steps CHAIN).

### "Where the work is happening"

- **"Where the work is happening" = two `charts/RepoRows` cards in `WorkspaceFlowMetrics`**
  (never `WorkspaceMetricsPanel`): repo activity and merged reach. Each column scales to ITS OWN
  max; repo names written in full; **unknown is never zero** (`linesChanged: null` → "size
  unknown"; a null reach verdict is undrawn). Reach rows ship SIGNALS folded by `blastRadius()`.

### Pending card actions

- **Pending card actions: NOTHING ON THE BOARD MAY FETCH ON MOUNT.** Merge buttons gate on the
  card's synced `mergeStateStatus`/`mergeable`/`viewerCanPush` through `mergeVerdict()`; the live
  merge-options fetch is CLICK-gated; HIDE, never disable. A QUEUED PR shows queue status +
  "Remove from queue", never Merge (`mergeQueueStatus()`). `conflicts` carries ONE action, the
  resolver entry, and is minted only in `writableRepoIds`.

### Notify vs open, and the Pending mute

- **A surface that NOTIFIES counts `myTurnPersonal`; one you OPEN counts `myTurn`.**
  `attentionRelevance` is three-valued (`'mine'`/`'others'`/`null`) and every entry point SEATS
  it. `myTurnOther` is never `myTurn - myTurnPersonal`. An ABSENT `relevance` renders the neutral
  label. `?attnPersonal=1` is still PARSED; `?attnRel=` is the only key emitted.
- **THE PENDING MUTE rides `relevance`, once, inside `getMyTurn`** (`db/pending-mute.ts`): a muted
  repo's rows become `relevance: 'none'` — no screen's population changes. Workspace switch ∪ named
  repos, OR-ed; ⚠ the write must scope its delete to the named workspace's membership. `muted` is
  display only.

### The AI Run gate

- **Every AI surface gates VISIBILITY on `me.ai.enabled` and its Run button on the ONE
  `AiRunGate`** (`components/AiSetup.tsx`) — agentic and one-shot alike (bot themes, synthesis,
  pointers, period write-up, impact note, work-plan wording). Never credits: on an API key a run
  shows US$; on a subscription it shows its share of the week, never US$ — always through ONE
  formatter, `useRunCostText()` (`lib/aiBudget.ts` `runCostText`).

### `InsightPrRef.authorIsBot`

- **`InsightPrRef.authorIsBot`** resolves like the bot-hiding union (manual judgement, then
  `users.isBot`, then the login seed); a NULL kind with `authorIsBot: true` renders "Bot".

### The Pending board

- **The Pending board is SEVEN scored TABS** (`PENDING_TABS`, `db/pending-tabs.ts`), each ranked by
  the ONE scorer (`db/work-plan.ts` `scoreCards`); the top 5 are "Do next". ⚠ **It ranks the
  UNCAPPED fold, then caps** per list group (`boardListCap` 50); only `/api/attention` passes
  `uncapped` and `withFailingChecks`. ⚠ **Each count is its own population** (`tab.total`,
  `kindTotals`, lens totals), and `/api/daily-brief` returns the same figures. ⚠ **The tabs are an
  ALLOW-list** (a compiler-checked test). Every floor/cap/threshold lives ONCE in
  `packages/shared/src/pending-rules.ts`. Visible tab is DERIVED (`effectivePendingTab`).
  "Pending" is a label-only rename; the literal stays `'attention'`.

### Board freshness

- **Board freshness is ONE batched sweep, `POST /api/attention/liveness`** (one `nodes(ids:)`
  call; mergeability for a ranked subset ≤ 25 — 50 ids 502s). ⚠ An observed `unknown` never
  demotes a known merge state. ⚠ **It returns COUNTS, never cards**: refetch `['attention-cards']`
  + `['daily-brief']` + `['work-plan']` together — the only keys opting out of
  `refetchOnWindowFocus: false`.

### This Sprint

- **This Sprint** (fixed tab, `?view=sprint`; [docs/FRONTEND.md](FRONTEND.md) § This Sprint):
  `GET /api/sprint-graph` is DB only; nodes placed in the workspace's STATUS BUCKETS
  (`db/sprint-status-layout.ts`); edges from ONE fold (`db/sprint-graph-fold.ts`). Briefs (Haiku)
  and critical paths (Sonnet, no digits in its text, daily cap) are made after a read, never on a
  view. ONE `LaneBoard` draws Theme / Critical path / People; a card opens the story tray
  (`Ticket/StoryViewBody.tsx`); tickets open the story view only through `useOpenStory()`. Never
  bring the force-graph canvas back. The ONE tracker write is the Jira status the reader picks in the
  story view's header (§ The story view); nothing on the boards writes.

### Colour and contrast

- **Colour and contrast are MEASURED.** ⚠ A raw brand hex may not be TEXT colour — go through
  `vendorInk()` (two variants are FORCED: no single colour clears 4.5:1 on both themes; it sets the
  `--ink-*` variables only, never `color`). `decorative-mark` is the only contrast opt-out, never
  on text that says something.

### Icons

- **EVERY ICON IS A COMPONENT IN `components/Icons.tsx`** (exception: `FileTypeIcons.tsx`); no
  icon emoji/library. What stayed a character is listed in that file's header (regexes over vendor
  bodies must not change). `CaretIcon` = menu trigger, `ChevronIcon` = expand/collapse.

## Pending is an inbox: one line per item, the card in a side panel (the redesign)

`AttentionView.tsx` is one page header (title + ⓘ, the work plan's quiet sentences, Re-plan inside
`AiRunGate`), the shared `Tabs` (`1`–`7`), the controls row, then `AttentionCards` — now a
`List` of one-line rows (`pendingRow.ts`: tone mark, reason, title + repo#N, plan mark, size,
author, age) beside a `SidePanel` that renders the WHOLE card (`PendingCard`): heading, action
line, why line, content, fact line, AI line, Details, and every button in the footer. Nothing was
removed from the card; it moved one click (or Enter) away.

- **Colour**: a row's mark is red when it blocks, green when it can land, amber when `severity` is
  `high` and neither applies, grey otherwise. Severity is named as urgency (Urgent / Soon /
  Routine) in the ⓘ popover and the guide.
- **Keys** (`useListKeyboard`): j/k, Enter (opens the panel; with it open, the card's own "open"),
  `a` approve (a review asked of you, not your PR), `m` merge (only where `pendingMergeGate`
  offers Merge, not queued, not armed), `e` dismiss (My turn), `z` undo, `o` GitHub. A key that
  cannot act writes one line into the board's status line.
- **Optimistic removal** (`removeOptimistically`, scope `pending`): dismiss is immediate with a
  restore as Undo; approve and merge are DEFERRED (they fire when the Undo offer ends). After the
  write's refetch the key is un-hidden, so a card the server still lists comes back instead of
  vanishing for the session. The tab counts stay the server's figures.
- ⚠ **Nothing fetches on selection or on opening the panel** (`e2e/pending-cards.spec.ts`). `m`
  buys the live merge options only when the deferred merge fires.
- ⌘K: the selected row's actions (`pending-row`), the page's controls (`pending-page`), and every
  Pending item across tabs (provider `pending-items`, which switches tab, selects and opens it).
