# Redesign ledger — what must survive

The audit for the redesign ticks this list off. Every line is something that exists in the app
today (main `019834eb`). **Moving a thing is fine** (into the side panel, a hover, a menu, ⌘K);
**deleting it is not.** Tick a line only after you have seen it in the redesigned UI, at desktop
width AND at 390px. If a line moved, write where it went after the tick: `- [x] … → side panel`.

Rules that apply to every line: plain-English copy (CLAUDE.md § Product voice), explanation behind
an ⓘ `InfoButton`, every icon from `components/Icons.tsx`, every AI run button through
`AiRunGate`, store/URL keys unchanged (`?view=`, `?pr=`, `?activityRepo=`, `'insights'`, …),
nothing under 11px, touch targets ≥ 40px on touch screens. The design rules are in
[DESIGN.md](DESIGN.md).

Paths are relative to `apps/frontend/src` unless they start with `apps/`, `scripts/` or `docs/`.
"Tests" lists what pins the surface today; a redesign that changes what a test pins updates the
test deliberately and says so in the commit.

Contents:

1. [App shell](#1-app-shell)
2. [Pending, Open PRs, Feed](#2-pending-open-prs-feed)
3. [PR detail and the story view](#3-pr-detail-and-the-story-view)
4. [This Sprint, Timeline, Reports, Bots Monitoring, Docs, Settings](#4-this-sprint-timeline-reports-bots-monitoring-docs-settings)

---

## 1. App shell

Scope: `App.tsx` and everything around the content (demo bar, header + toast strip, welcome strip,
scope row / FilterBar, tab strip, Activity rail, board slot / detail pane, overlays, modals,
keyboard, URL state). Shots: `/tmp/limn-demo-shots/open-prs.png`, `timeline.png`.

Known debts the redesign must clear here:

- [x] → one sidebar + a 44px top bar (+24px demo bar). Stacked chrome at 1440px today is ~184px before content (demo bar 28 · header 44 · welcome
  strip 28 · FilterBar ~42 · tab strip 42). Target: one sidebar + one slim page header.
- [x] → drawer below lg, bottom bar below md, no page overflow at 390/768 (checked). Mobile today: the Activity rail becomes a horizontal chip strip below md (w-56 chips,
  overflow-x-auto, legend hidden); the header hides the "Sync" word, the user name and the toast
  words below sm. Nothing else adapts. Target: every screen works at 390px and 768px.
- [x] → `BellIcon`, `RefreshIcon` (catalogue), `GearIcon`, `BarsIcon`, `InboxIcon`, `TimelineIcon`. Off-catalogue inline SVGs to move into `Icons.tsx`: the bell (`App.tsx`), `RefreshIcon`
  (`SyncStatus.tsx`), the gear in `UserMenu.tsx`, `MetricsIcon` / `ActivityIcon` / `TimelineIcon`
  in `PinnedTabsBar.tsx`.
- [x] → `QuestionIcon`; the "+" sup is gone with the strip. Two literal characters used as icons: the Help button's "?" and the WelcomeBack "+" sup.
- [x] Under-11px text in the shell (rail legend 10px, rail generatedAt 10px, BranchStatusChip 10px,
  rail attention chip 10px, workspace "Default" badge 9px, PR-chip author line 10px, PR-chip
  initials 8px, WelcomeBack "+" sup 8px, search People header 10px, search hit meta 10px) → raised
  to the 11px floor app-wide in the foundation commit.

### [x] Demo notice bar (static demo only) → kept, slimmer (24px, no rule under it: demo/demo.css)
- Entry: always on top in the demo build only (`vite --mode demo`, base `/demo/`). Mounted by
  `src/demo/entry.ts` before the app loads; plain DOM outside React, so the app cannot unmount it.
- Files: `demo/banner.ts`, `demo/entry.ts`, `demo/demo.css`
- Essential info:
  - [ ] "Demo: sample data, nothing is sent." (`DEMO_NOTICE`)
  - [ ] "Run it on your own repos: npx limn-review" (`INSTALL_COMMAND` in `<code>`)
  - [ ] Link "Back to the website" (href `/`)
- Actions:
  - [ ] Follow "Back to the website"
- States:
  - [ ] Present only in the demo build; a normal `vite build` stays byte-free of it
  - [ ] `body.limn-demo` class; `#root` gives up the bar's height (`demo.css`)
  - [ ] Holds the site's CSP: no inline style or script
  - [ ] On a narrow screen `demo.css` hides `.limn-demo-install`
- Tests: `scripts/verify-demo.mjs` (every VIEW runs under it), `docs/DEMO.md`

### [x] Boot splash → kept; its gate is `me.data == null && me.isPending` (an `isLoading` gate remounted the whole app ~1s after every load)
- Entry: first paint while `/api/me` is loading (`me.isLoading && !me.data`)
- Files: `App.tsx`, `components/Wordmark.tsx`
- Essential info:
  - [ ] Centred Limn wordmark on `bg-gray-950`; nothing else
- States:
  - [ ] Shown only until `/api/me` settles. A failed `/api/me` falls through to the app with
    `meUser` null, so UserMenu is hidden

### [ ] AuthNoticeBanner (GitHub SSO not authorized) → kept, unchanged, above the shell
- Entry: automatic full-width strip above the header when `/api/me` `authNotices` is non-empty
- Files: `components/AuthNoticeBanner.tsx`, `App.tsx`
- Essential info:
  - [ ] "Your GitHub login is not authorized for {orgs}." — lists every org
  - [ ] Why it matters: that org's PRs, CI checks and comments can't be synced until the login is
    authorized for single sign-on
  - [ ] The fix: run `gh auth refresh` in a terminal
- Actions: none. Not dismissible; clears itself after the next clean sync
- States:
  - [ ] Hidden when there are no notices
  - [ ] Amber tone today
- Tests: `e2e/mock-api.ts` `/api/me` fixture (`authNotices`)

### [x] Header bar + wordmark → the wordmark (h1, same title) heads the sidebar; the header is the slim `TopBar` (h-11, fixed): menu button · location (below lg) · open tabs (md+) · toast strip
- Entry: top of every screen, fixed height `h-11` (load-bearing: toast cards must never move the page)
- Files: `App.tsx`, `components/Wordmark.tsx`
- Essential info:
  - [ ] Limn wordmark (h1, title "Limn — to depict, to make clear")
  - [ ] Order left to right: wordmark · toast strip (flex-1) · Sync · bell · ? · theme · AI usage · user menu
- Actions: none on the wordmark (it is not a link)
- States:
  - [ ] The controls cluster gap shrinks below sm
- Tests: `docs/FRONTEND.md` § There is ONE header toast strip

### [x] HeaderToastStrip + HeaderToast (the ONE toast strip) → unchanged component, now the right of `TopBar`; same order (+ AiBudgetToast, UndoToast)
- Entry: fills the header between the wordmark and the controls. Every toast in the app is a card
  here; never a fixed element and never a second strip.
- Files: `components/HeaderToasts.tsx`, `lib/toastAnchor.ts`, `App.tsx`
- Essential info:
  - [ ] Card order (fixed, left to right): AI reviews, AI fixes, AI budget paused, Closed resolver
    reopen, My Turn dismissed undo, Dependency updates, Merge when ready, Loading data
  - [ ] Each card is one line: icon + bold label + " · " + summary, an optional inline action
    button and an optional dismiss ×
  - [ ] Optional progress bar (value + label)
  - [ ] Tone colours its left border: neutral, ai, merge (violet), sync (sky), attention (amber), conflicts
- Actions:
  - [ ] Click the line to expand the card over the page; anchored at the card's top-left, fixed
    via `anchorToastPanel`. Only one card expanded at a time
  - [ ] Escape, an outside pointerdown, scroll or resize collapses it
  - [ ] The inline action (Undo, Reopen, Settings)
  - [ ] Dismiss × (`dismissLabel`)
  - [ ] Footer "Show N more" / "Show fewer" (`ToastShowMore`) inside an expanded card
- States:
  - [ ] `role=status aria-live=polite`, aria-label "Notifications"
  - [ ] Slot is `h-7 w-28 sm:w-56 lg:w-64`; below sm the words are sr-only and only the icon shows
  - [ ] Several cards scroll the strip sideways (`overflow-x-auto`)
  - [ ] A card expands only when it has detail or its line is truncated
- Tests: `test/toastAnchor.test.ts`, `test/catchupLine.test.ts`, `test/armedPhaseHeadline.test.ts`,
  `test/autoMergeOutcomes.test.ts`, `test/aiFixProgress.test.ts`, `test/aiFixRuns.test.ts`;
  testIds `header-toast-strip`, `claude-review-toast`, `ai-fix-toast`, `ai-budget-toast`,
  `closed-resolver-toast`, `my-turn-dismiss-toast`, `dependency-merge-toast`, `auto-merge-toast`,
  `global-loading-bar`

### [ ] Toast: AI reviews (ClaudeReviewBanner)
- Entry: appears while Claude/Codex reviews started this session are running or ready
- Files: `components/ClaudeReviewBanner.tsx`
- Essential info:
  - [ ] Summary "N running" or "N ready"
  - [ ] Per row: spinner or check, "owner/repo #N", PR title, the phase label ("Starting…", a
    `PHASE_LABEL` value) or "Ready — open it"
- Actions:
  - [ ] Click a row → that PR's Claude Review tab (`openClaudeReview`)
  - [ ] Dismiss one finished row
  - [ ] Dismiss the whole card, only when all are done
  - [ ] Fires a browser Notification when a review completes (bell preference on + permission)
- States:
  - [ ] Gated on `me.ai.enabled`
  - [ ] Hidden when there are no visible entries
  - [ ] tone ai
- Tests: testId `claude-review-toast`

### [ ] Toast: AI fixes (AiFixBanner)
- Entry: appears for AI Fix runs started this session
- Files: `components/AiFixBanner.tsx`
- Essential info:
  - [ ] Running / finished counts
  - [ ] Per run: repo #N, phase label ("Working…") with a progress bar (`fixProgressPct`), the
    terminal outcome line (`doneLine`), "Fix ready" on success
- Actions:
  - [ ] Click a row → the PR's AI Fix tab
  - [ ] Dismiss one run
  - [ ] Dismiss all when finished
- States:
  - [ ] Gated on `me.ai.enabled`
  - [ ] Hidden when there are no rows
- Tests: `test/aiFixProgress.test.ts`, `test/aiFixRuns.test.ts`

### [ ] Toast: automatic runs paused (AiBudgetToast)
- Entry: appears when the AI spend budget is over
- Files: `components/AiBudget.tsx`, `lib/aiBudget.ts`
- Essential info:
  - [ ] "Automatic {provider} runs paused" + a sentence on why and until when
- Actions:
  - [ ] Settings: `openSettings('claude-spend')`
  - [ ] Dismiss (remembered per budget key)
- States:
  - [ ] Shown only when `status.overBudget`
  - [ ] tone ai
  - [ ] A subscription account never shows US$
- Tests: `test/aiBudget.test.ts`, `test/claudeSpendForm.test.ts`

### [ ] Toast: reopen closed conflict resolver (ClosedResolverToast)
- Entry: appears for 20s after the reader closes the resolver with decisions still held
- Files: `components/conflicts/ClosedResolverToast.tsx`, `store/conflictResolver.ts`
- Essential info:
  - [ ] Label "owner/repo #N"
  - [ ] Summary `closedToast(decidedCount)` — how many decisions are kept
  - [ ] This is the ONLY route back into the resolver: it has no URL and no history entry
- Actions:
  - [ ] Reopen (`REOPEN`)
  - [ ] Dismiss
- States:
  - [ ] Never after a commit
  - [ ] Auto-hides after `TOAST_MS` 20000
  - [ ] tone conflicts
- Tests: testId `closed-resolver-toast`

### [ ] Toast: My Turn dismissed, with Undo (MyTurnDismissToast)
- Entry: appears for 10s after a Pending entry is dismissed
- Files: `components/Activity/MyTurnDismissToast.tsx`, `hooks/useMyTurnDismiss.ts`
- Essential info:
  - [ ] "Dismissed" · "{label} — until something new happens on it"
- Actions:
  - [ ] Undo (`useRestoreMyTurn`; reads "Bringing it back…" while pending)
  - [ ] Dismiss the offer
- States:
  - [ ] `TOAST_MS` 10000
  - [ ] tone attention
- Tests: testId `my-turn-dismiss-toast`

### [ ] Toast: dependency merge-all outcome (DependencyMergeToast)
- Entry: appears for 15s after Pending → Dependencies "Merge or arm all"
- Files: `components/Activity/DependencyMergeAll.tsx`
- Essential info:
  - [ ] Summary counts: "N merged · N set to merge when ready · N skipped · N failed" or "Nothing changed."
  - [ ] One red row per failure: "Failed — {label}: {message}"
- Actions:
  - [ ] Show more / Show fewer for the failed rows
  - [ ] Dismiss
- States:
  - [ ] `TOAST_MS` 15000
  - [ ] tone merge
- Tests: testId `dependency-merge-toast`

### [ ] Toast: Merge when ready (AutoMergeBanner) — the "merge pill" in the top bar
- Entry: appears while any PR is armed or has a fresh outcome. Fed by `GET /api/auto-merge`
- Files: `components/AutoMergeBanner.tsx`, `hooks/useAutoMerge.ts`
- Essential info:
  - [ ] Summary: "N armed · N merged · N not merged"
  - [ ] Per live row: status dot (working, waiting, stalled, good, bad), "owner/repo #N", title,
    phase headline (`armedPhaseHeadline`, e.g. queue position "N of M"), "armed by policy" line,
    `lastReason` detail
  - [ ] Per outcome row: merged or not, with the reason
  - [ ] Footer: "Auto-merge only runs while Limn is running."
- Actions:
  - [ ] Click a row → the PR detail tab
  - [ ] Cancel on a live row (disarm)
  - [ ] Dismiss one outcome
  - [ ] Dismiss finished
  - [ ] Show N more / Show fewer (`MAX_ROWS` 4)
  - [ ] Dismiss all, only when nothing is live
  - [ ] A landed outcome triggers `invalidateAfterPrWrite` (cascade)
- States:
  - [ ] Hidden when total is 0
  - [ ] tone merge
  - [ ] Outcomes remembered 5 at a time
- Tests: `test/armedPhaseHeadline.test.ts`, `test/autoMergeOutcomes.test.ts`, testId `auto-merge-toast`

### [ ] Toast: Loading data (GlobalLoadingBar)
- Entry: appears during backfills, catch-up syncs and ML bot-comment scoring
- Files: `components/GlobalLoadingBar.tsx`
- Essential info:
  - [ ] "N% · ETA" or "estimating…", "finishing up…", "Done"
  - [ ] Paused headline: "Paused — GitHub rate limit, resumes …" or "Paused — waiting for another sync"
  - [ ] Detail rows: "Backfilling N repos · P% · N waiting" or "Backfill queued · N waiting", the
    catch-up sentence, "Classifying bot comments · X of Y · P%", "Classification waiting…"
  - [ ] Progress bar
- Actions:
  - [ ] Expand for the detail rows. Not dismissible: it is an indicator
- States:
  - [ ] Fades out 1s after work ends
  - [ ] The percent only goes up (resets in 3 cases)
  - [ ] tone sync
- Tests: `test/catchupLine.test.ts`; ETA helpers are exported pure functions
  (`docs/FRONTEND.md` § ETA mechanics); testId `global-loading-bar`

### [x] SyncStatus (Sync button, sole driver of the sync round) → sidebar foot: icon + words ("Synced 2m ago", "Syncing 2 repos…", "Sync error" in danger ink + dot), same tooltip and click; still always mounted (the sidebar is never unmounted), its SyncProgressModal portalled to body; ⌘K "Sync all repos now"
- Entry: header button "Sync" (refresh icon; word hidden below sm). Always mounted, every screen
- Files: `components/SyncStatus.tsx`, `components/SyncProgressModal.tsx`,
  `components/SyncProgressPanel.tsx`, `lib/syncTooltip.ts`, `hooks/prCacheSync.ts`
- Essential info:
  - [ ] Icon spins while a GitHub walk OR ML scoring runs
  - [ ] Red dot when any repo's `lastSyncStatus` is error
  - [ ] Tooltip lines: "Sync error: repo — error (and N more)", the progress line ("syncing N
    repos…", "loading older history…", "scoring bot comments — N to go · N unscorable"), "Click to
    sync all repos now", last sync and last check times (`syncTooltip`)
- Actions:
  - [ ] Click to shallow-sync all repos (no-op while one is in flight)
  - [ ] Registers the `syncRoundActions` others call: cancel, syncAllShallow, syncAllDeep, syncOneDeep, dismiss
  - [ ] Opens SyncProgressModal ("Sync progress") for an onboarding add path when the manager is
    closed, with cancel and dismiss
  - [ ] Owns the post-write 5s `['repos']` fast poll and the PR-change invalidation sweep
    (non-visual; must stay mounted)
- States:
  - [ ] Renders null when there are no repos
  - [ ] `aria-busy` while syncing or scoring
  - [ ] Modal only when `round.modal` and the manager is not open
  - [ ] Auto-closes the round 1.2s after done
- Tests: `test/syncTooltip.test.ts`, `test/prCacheSync.test.ts`, `test/prWriteCascadeGuard.test.ts`,
  `docs/FRONTEND.md` § The sync round

### [x] My Turn notifications bell → sidebar foot (`BellIcon`, filled + pressed when on, same titles); ⌘K "Turn on/off My Turn notifications"
- Entry: header bell button (inline SVG). Shown only where `window.Notification` exists
- Files: `App.tsx`, `hooks/useNotificationPref.ts`, `hooks/useMyTurnNotifications.ts`
- Essential info:
  - [ ] On/off state (filled bell, blue border, `aria-pressed`)
  - [ ] Title: "Notifications on — alerts when a new item enters your My Turn…"
- Actions:
  - [ ] Toggle. First enable requests browser permission; denied permission means it cannot turn on
  - [ ] While on, OS notifications fire "Limn — N new in My Turn{where}" with a time stamp and
    workspace names (counts `myTurnPersonal`); Claude review-complete notifications fire too
- States:
  - [ ] Hidden when Notification is unsupported
  - [ ] The pref is shared with ClaudeReviewBanner

### [x] Help button + HelpModal → (restyled: tone, no borders, a bottom sheet below sm; opening closes the drawer) sidebar foot (`QuestionIcon`), ⌘K "Help and keyboard shortcuts"; the Keyboard and sidebar sections rewritten for the shell; plus the new `?` key sheet
- Entry: header "?" button (aria-label Help)
- Files: `components/HelpModal.tsx`, `App.tsx`
- Essential info:
  - [ ] Sections: Add repos & scope with Workspaces; Activity console; Review-bot triage; Pending;
    Reports; PR detail & threads; Timeline; AI Review and AI Fix (on your machine); Bot comment
    scoring (on your machine, `LIMN_ML_*` env vars, `npx limn-review ml status`); Keyboard
- Actions:
  - [ ] Open
  - [ ] Close (×, Esc, backdrop)
- States:
  - [ ] No URL. Local state in App
  - [ ] Keyboard section must be updated to the new key map

### [x] Theme toggle → sidebar foot; ⌘K "Switch light / dark theme"
- Entry: header sun/moon button
- Files: `App.tsx` (`useDarkMode`), `components/Icons.tsx` (`SunIcon`, `MoonIcon`)
- Essential info:
  - [ ] Current theme. Dark is the default; localStorage `theme`
- Actions:
  - [ ] Toggle dark/light (`html.dark` class)
- Tests: textContrast / vendorInk tests cover both themes

### [x] AI usage menu (AiUsageMenu, the header %) → sidebar foot, "AI usage 40%" (tone: warn / danger ink), popover opens upward; same testIds
- Entry: header button with sparkle + figure (e.g. "40%")
- Files: `components/AiUsageMenu.tsx`, `lib/aiBudget.ts`, `hooks/useAiBudget.ts`
- Essential info:
  - [ ] Headline figure (`headerUsageOf`), toned normal, near (amber) or over (red)
  - [ ] Popover per provider: heading, a "paused" line, sections (5-hour session / week) with
    label, value and a bar (sky, amber at 80%, red at 100%), a note, "updated…"
  - [ ] ⓘ "Limn's share" explanation (InfoButton)
  - [ ] Percentages only on a subscription; US$ only on an API key
- Actions:
  - [ ] Open (refetches the budget)
  - [ ] AI spend settings: `openSettings('claude-spend')`
  - [ ] Escape or outside click closes and returns focus
- States:
  - [ ] Hidden when `!me.ai.enabled`, no data, or no headline
  - [ ] Below sm the popover is fixed full-width at the bottom
- Tests: `test/aiBudget.test.ts`, testIds `ai-usage-button`, `ai-usage-provider-{provider}`

### [x] User menu (account) + the Settings entry → sidebar foot (shared `Menu`, opens upward; "@login" heading; title still "Signed in as …", item still "Settings")
- Entry: header far right: avatar (or initials) + name (sr-only below sm) + caret. Title "Signed in as …"
- Files: `components/UserMenu.tsx`, `App.tsx`, `store/settingsModal.ts`
- Essential info:
  - [ ] Who is signed in: display name and @login (from gh)
- Actions:
  - [ ] Settings (ungated; opens SettingsModal)
  - [ ] Open Profile on GitHub (external link)
- States:
  - [ ] Hidden when `me.user` is null (offline)
- Tests: `scripts/verify-demo.mjs` `openSettings()` clicks `button[title^="Signed in as"]` then
  menuitem "Settings" — keep a reachable path or update the script;
  `e2e/pending-keyboard.spec.ts` (Settings open/close, focus return)

### [x] Settings modal (shell part: openers and tabs) → unchanged; every tab is also a ⌘K command
- Entry: no URL. Opened by User menu → Settings; Pending's "Customise" (focus `my-turn` → Pending
  tab); AiUsageMenu "AI spend settings", AiBudgetToast "Settings" and AiBudgetMeter (focus
  `claude-spend` → AI tab); This Sprint tracker setup (focus `issue-tracker` → Integrations tab)
- Files: `components/settings/SettingsModal.tsx`, `components/settings/settingsTabs.ts`, `store/settingsModal.ts`
- Essential info:
  - [ ] Tabs: Pull requests; Pending; AI (AI only); AI review (AI only); Reports and sprint; Integrations; Bots
  - [ ] Each tab shows global sections, then ONE "Workspace · {name}" heading with that workspace's sections
  - [ ] Remembers the last tab
- Actions:
  - [ ] Switch tab (arrow keys, Home and End)
  - [ ] Close (×, Esc captured, backdrop); focus returns to the opener
  - [ ] A deep-link focus scrolls to and focuses its section heading
- States:
  - [ ] AI tabs hidden when `!me.ai.enabled`
  - [ ] The workspace part waits for the scope to resolve
  - [ ] Escape is captured so the global Esc does not fire
- Tests: `test/settingsTabs.test.ts`, `e2e/pending-keyboard.spec.ts`, `scripts/verify-demo.mjs`
  settings views (`openSettingsTab('AI')`, "AI review", …)

### [x] Welcome back strip (WelcomeBackBanner) → sidebar "Needs you · N" group (rows per workspace, filled dot = active, +N more popover with "Not counted here", × for the session) shown when another workspace has work or is uncounted; the active workspace's count is the Pending item's badge; ⌘K "Show what needs you in <workspace>"
- Entry: automatic h-7 amber strip under the header when any workspace has My Turn items
- Files: `components/WelcomeBackBanner.tsx`, `hooks/useMyTurnByWorkspace.ts`
- Essential info:
  - [ ] "Welcome back · N(+) need(s) you" (the + when any count is capped)
  - [ ] Up to 4 workspace chips: dot (filled for the active one), count with "+" when capped
    (sr-only "of total"), workspace name; title with the cap detail or "Switch to X and show these"
  - [ ] "+N more" popover: overflow workspaces with counts, and "Not counted here: names. Switch to
    one to see its own count."
- Actions:
  - [ ] Click a workspace chip: `openMyTurnInWorkspace(id)` switches workspace, lands on Pending →
    My turn and dismisses the strip
  - [ ] +N more popover with the same action per row
  - [ ] Dismiss × (this session only, local state)
- States:
  - [ ] Hidden when dismissed, when `me.user` is null, or when no lines
- Tests: `test/myTurnCapDisclosure.test.ts`, `docs/FRONTEND.md` § Per-workspace "My Turn"

### [x] Workspace selector (FilterBar scope row) → top of the sidebar (full-width trigger; a dot + title say work waits elsewhere; menu rows unchanged with counts and "N repos"; Escape now closes it); the trigger's own My Turn badge → the Pending item; manager open state → store `managerOpen` (⌘K "Manage repos & workspaces"); `useWorkspaceSync` + first-run open → `useWorkspaceShell` in App
- Entry: FilterBar left, on EVERY view: pill with the workspace icon, the active name, the My Turn badge and a caret
- Files: `components/WorkspaceSelector.tsx`, `hooks/useMyTurnByWorkspace.ts`, `hooks/useWorkspaces.ts`,
  `store/filters.ts` (`switchWorkspaceToOpenPrs`, `setWorkspace`)
- Essential info:
  - [ ] The active workspace NAME (never "All")
  - [ ] Amber badge with THIS workspace's personal My Turn count ("N+" when capped; title gives the
    exact pair and says they are on the Pending board)
  - [ ] Trigger title: how many items need you in OTHER workspaces
  - [ ] Menu: radio rows, Default first (badged "Default") then by name; each row has its My Turn
    count (title with the direct/maintained split), "—" when not counted, and "N repos"
  - [ ] Footer note when some workspaces are beyond the roll-up
- Actions:
  - [ ] Pick a workspace: `switchWorkspaceToOpenPrs` (lands on Activity → Open PRs)
  - [ ] "Manage repos & workspaces" (gear, count of workspaces) opens WorkspaceManagerModal: add a
    repo (RepoSearch), move a repo between workspaces, deep re-sync one or all, remove a repo
    (confirm), create / rename / delete a workspace (confirm; repos and bot settings move to
    Default), and the embedded sync panel
- States:
  - [ ] "Loading workspaces…"
  - [ ] A zero-repo account opens the manager automatically once per page load ("Add a repo to get
    started", autofocused suggestions)
  - [ ] `useWorkspaceSync` three-branch logic (null-or-dead → Default, changed, prune only) lives
    here and must stay mounted
  - [ ] `workspaceId` null means render nothing scoped
- Tests: `test/workspaceScope.test.ts`, `test/switchWorkspaceToOpenPrs.test.ts`,
  `test/myTurnCapDisclosure.test.ts`, `e2e/activity-feed.spec.ts` ("claims no counts before the
  workspace resolves", "empty workspace" guidance), verify-demo `ws2:*` views (`?workspace=2`)

### [x] Global search (GlobalSearch + SearchResultsTab) → ⌘K / `/`: the same dropdown request (stories → Tickets, people, hits → Search rows with kind + repo#N) via `usePaletteSearch`; "Search everything" opens the unchanged results tab (snippets, highlights, kind filters, paging); the FilterBar input is gone
- Entry: FilterBar, every view: input `#global-search-input` "Search PRs, threads, people…". "/" focuses it
- Files: `components/Search/GlobalSearch.tsx`, `components/Search/SearchResultsTab.tsx`,
  `components/Search/searchNav.ts`, `components/Search/highlight.tsx`, `hooks/useSearch.ts`
- Essential info:
  - [ ] Dropdown after 2+ characters (300ms debounce): Stories (key, status, "N open PRs", title),
    People (avatar, login · name, match count), hits (kind icon + PR/Review/Thread/Comment, repo #N,
    title, snippet), matched terms highlighted
  - [ ] "Searching…" / "No matches."
  - [ ] Footer "See all results (N) for “q”"
- Actions:
  - [ ] Story → the ticket story tab
  - [ ] Person → search tab for their login
  - [ ] Hit → PR detail tab (a thread hit selects the thread)
  - [ ] Enter or "See all" → the search drill-down tab (editable box, kind filters, People facet,
    Load more, each thread inline)
  - [ ] Esc closes and blurs
- States:
  - [ ] Scoped to the active workspace
  - [ ] The search tab is ephemeral: no `view=` and dropped on reload
- Tests: testIds `search-story`, `search-overlay`

### [x] FilterBar: Timeline-only board filters → unchanged, Timeline only (the bar renders nothing elsewhere); on a phone folded behind "Filters" with Now kept on the line
- Entry: FilterBar row, only when `activeTab === 'timeline'`
- Files: `components/FilterBar.tsx`, `components/RepoSelectPanel.tsx`, `components/UserSelectPanel.tsx`,
  `components/StatusSelectPanel.tsx`, `components/EventSelectPanel.tsx`,
  `components/ThreadStateSelectPanel.tsx`, `hooks/useMemberSections.ts`
- Essential info:
  - [ ] Repos (N): active workspace's repos only, show/hide and "only"; empty state "No repos in
    this workspace — move some in from Manage repos & workspaces."
  - [ ] Members: maintainers by default, "Show N more" per repo, search bypasses the collapse, an
    Exclude bots checkbox, and a bot allow-list
  - [ ] Status: PR statuses + exclude stale
  - [ ] Events: categories + review verdicts
  - [ ] Threads: derived-state tags (untouched, replied, likely addressed, resolved)
  - [ ] RANGE: 7d/14d/30d/90d (custom from/to via URL) + Now
- Actions:
  - [ ] Toggle each filter
  - [ ] Now: `centerTimelineNow`
  - [ ] Clear filters: `resetAllFilters` (keeps the workspace)
- States:
  - [ ] Hidden on every other view
  - [ ] `repoIds` null = every repo in the workspace; never hides the last one
- Tests: `test/memberSections.test.ts`, `test/filterStorageMigration.test.ts`,
  `test/isolateFilter.test.ts`, `scripts/ui-smoke.mjs` (`pnpm verify:ui`, `.tl-repo-header`)

### [ ] FilterBar: PR Focus-only controls → unchanged
- Entry: FilterBar when a pr-focus tab is active (`boardSlotMode != null`)
- Files: `components/FilterBar.tsx`, `components/Timeline/isolateFilter.ts`, `store/pinnedTabs.ts` (`boardSlotMode`)
- Essential info:
  - [ ] Events panel
  - [ ] "Hide bots" pill (`aria-pressed` = bots hidden); reads "Hide bots (except N)" while the allow-list is non-empty
- Actions:
  - [ ] Toggle events
  - [ ] Toggle `excludeBots` (shared store field and URL key)
- States:
  - [ ] Decided by the same `boardSlotMode` resolver as App, so a stale focus key shows no Focus controls
- Tests: `test/isolateFilter.test.ts`

### [x] Tab strip: fixed views (PinnedTabsBar) → sidebar primaries (Pending · Open pull requests · This Sprint · Timeline) + the phone's bottom bar; "Activity" itself is `i` / the Activity destinations; "Close all tabs" → any chip's right-click, ⌘K, the phone drawer
- Entry: always-shown strip under the FilterBar (`data-testid pinned-tabs`, role tablist "Views").
  Three permanent chips: Activity, This Sprint, Timeline
- Files: `components/PinnedTabsBar.tsx`, `store/pinnedTabs.ts`
- Essential info:
  - [ ] Which fixed view is active
  - [ ] Activity (default view, Open PRs rail line); This Sprint (Theme, Critical path, People,
    Merged so far); Timeline (the board)
- Actions:
  - [ ] Click to switch (`setActiveTab('activity')`, `showSprint`, `showTimeline`)
  - [ ] Right-click → "Close all tabs"
- States:
  - [ ] Not closable or draggable
- Tests: `e2e/activity-feed.spec.ts` ("the tab strip is Activity, This Sprint, Timeline", "This
  Sprint is a fixed tab…", "the Activity | Timeline tabs toggle the board"); selectors
  `getByTestId('pinned-tabs').getByRole('tab', {name})` are load-bearing; `test/landingTab.test.ts`

### [x] Tab strip: dynamic tabs (PR and drill-down chips) → `TopBar` strip at md+ (one-line chips: avatar · #N title; author/"PR focus" in the tooltip + accessible name; drag, ×, right-click menu kept); phone: the drawer's "Open tabs" list (activate, ×, Close all); ⌘K "Tab: …"
- Entry: opened from across the app (rows, search, toasts, links). Chips follow the fixed views
- Files: `components/PinnedTabsBar.tsx`, `store/pinnedTabs.ts`, `App.tsx` (one overlay per kind)
- Essential info:
  - [ ] pr-detail chip: author avatar or initials, "#N title", author name; title "repo #N · title"
  - [ ] pr-focus chip: magnifier, "#N title", "PR focus"
  - [ ] metrics-detail "Flow metrics"
  - [ ] bot-prs "Bot Drill-Down"
  - [ ] bot-only-prs "Bot-only PRs · repo"
  - [ ] bot-threads "Bot threads · repo"
  - [ ] bot-flagging "Flagged · selector" (repo in the title)
  - [ ] bot-volume "Comments/PR · bot"
  - [ ] theme-threads (theme title)
  - [ ] search "“q”"
  - [ ] user-activity (avatar + login)
  - [ ] bot-detail "{bot} · depth"
  - [ ] ticket (`storyTabLabels` key)
  - [ ] Closable chips are all one width (w-52)
- Actions:
  - [ ] Activate
  - [ ] Close × (aria "Close detail tab for PR #N", etc.). Closing the active tab moves to the left
    neighbour, else the right one, else Activity
  - [ ] Drag to reorder (pointer, 4px threshold, cloned ghost)
  - [ ] Right-click menu: Close this tab / Close other tabs / Close all tabs (its Esc stops propagation)
- States:
  - [ ] Only pr-detail and pr-focus persist in localStorage. user-activity, bot-detail and ticket
    are self-describing via `view=`; the others are ephemeral seeds dropped on reload
  - [ ] A stale key falls back to the board
- Tests: `test/closeTabs.test.ts`, `test/ticketTab.test.ts`, `test/urlHistory.test.ts`; e2e
  role=tab names and × aria-labels are load-bearing

### [x] Activity rail: destination rows → the sidebar (Library: Docs AI-only, Feed; Insights: Reports, Bots Monitoring); tooltips kept + the g-key; Open PRs count kept (unknown is blank); Pending now carries this workspace's personal My Turn count; "generated N ago" + refetch hairline → the Repositories group header
- Entry: Activity view left rail (`md:w-72`; a horizontal chip strip below md)
- Files: `components/Activity/index.tsx`, `lib/openPrsTab.ts`, `hooks/useTriage.ts` (`useWorkspaceOpenPrs`)
- Essential info:
  - [ ] Order: Open PRs, Pending, Docs, Feed, Reports, Bots Monitoring
  - [ ] Open PRs carries N = non-draft open PRs (unknown is never zero: no figure while
    unresolved or on placeholder data)
  - [ ] Pending has no count on the rail; the workspace badge carries it
  - [ ] Tooltips: "Every open pull request in this workspace" / "Everything waiting on you or your
    workspace, ranked most actionable first" / "Reference documents for this workspace, and a chat
    that answers from them" / "One chronological stream across every repo in this workspace" /
    "Flow metrics and period reports for this workspace" / "Measure and triage this workspace's review bots"
  - [ ] "just now" style generatedAt stamp at the top (full time in the title)
  - [ ] A refetch hairline, and the rail dims while fetching
- Actions:
  - [ ] `setActivityRepo('open-prs'|'attention'|'docs'|'feed'|'insights'|'bots')`
- States:
  - [ ] Docs shown only when `me.ai.enabled` (a `?activityRepo=docs` link still lands on DocsView's own line)
  - [ ] Store and URL values stay `'attention'` for Pending and `'insights'` for Reports
- Tests: `e2e/activity-feed.spec.ts` ("the rail reads Open PRs, Pending, Feed, Reports, Bots
  Monitoring": first 5 `button[aria-pressed] .truncate` text; `railButton(name)` aria-pressed),
  `test/openPrsTab.test.ts`, `test/docsRailUrl.test.ts`, verify-demo views open-prs, pending:*,
  feed, bots:*, reports:*, docs

### [x] Activity rail: per-repo rows + thread-state legend → sidebar "Repositories" (collapsible, remembered): name · shield · unread dot · attention count · open PRs on line 1; thread bar · default-branch line on line 2; same sort; legend behind the ⓘ beside the heading; ⌘K lists every repo
- Entry: below the destination rows, one per repo in the workspace
- Files: `components/Activity/index.tsx` (`RailRow`), `components/Activity/ThreadStateBar.tsx`,
  `components/Activity/BranchStatusChip.tsx`, `components/MaintainerShield.tsx`, `lib/ui.ts` (`DERIVED_STATE_META`)
- Essential info:
  - [ ] Repo full name
  - [ ] Maintainer shield ("Has merge rights — has merged a PR in this repo")
  - [ ] Sky "new activity" dot (`hasUnread`)
  - [ ] Compact thread-state health bar (untouched, replied, likely addressed, resolved)
  - [ ] Amber warning chip with the attention count ("PRs needing attention")
  - [ ] Open PR count as [N], or [—]
  - [ ] Default branch line: CI dot, branch name (mono), last commit relative time (title "main: CI passing · last commit …")
  - [ ] Sort order: attention desc, unread first, then name
  - [ ] Legend (md+ only): untouched, replied, likely addressed, resolved, each with its description tooltip
- Actions:
  - [ ] Select a repo: `setActivityRepo(repoId)` opens its per-repo console
- States:
  - [ ] Before `/api/activity` answers, fallback rows (name only) from `/api/repos`
  - [ ] Metrics lines appear only once loaded; the branch line hides until the branch is synced
- Tests: `scripts/record-demo-steps.mjs` "repo-console" (`?view=activity&activityRepo=2`)

### [x] Activity right pane: routing and empty states → `ActivityView` is the pane alone; empty-workspace copy names the workspace menu in the sidebar and carries a "Manage repos & workspaces" button
- Entry: right of the rail; content follows `activityRepoId`
- Files: `components/Activity/index.tsx`, `FirstRunOnboarding.tsx`, `OpenPrsDetail.tsx`,
  `AttentionView.tsx`, `InsightsView.tsx`, `DocsView.tsx`, `BotsView.tsx`, `FeedView.tsx` (all under `components/Activity/`)
- Essential info:
  - [ ] Zero repos at all: FirstRunOnboarding ("Add the repos you work on", detected repos with
    stars and open PR counts, "Add selected", "Adding i/n — repo…")
  - [ ] Empty workspace: "No repos in this workspace yet. Open "Manage repos & workspaces" in the
    header to move some in." or "Detecting the repos you work on…" — the copy must name where the
    manager lives in the NEW shell
  - [ ] 3-card skeleton while loading
  - [ ] Fallback: FeedIsolationBanner + FeedView
- States:
  - [ ] The pane is the scroll box (`relative` is load-bearing). The overlay uses overflow-clip, not hidden
- Tests: `e2e/activity-feed.spec.ts` ("lands on the Activity console with Open PRs selected by
  default", "an empty workspace opens on the guidance…", "a bare URL lands on Activity → Open
  PRs"); testIds `activity-overlay`, `open-prs-view`

### [x] Per-repo console → unchanged; its Activity | Bots sub-tabs are the `Tabs` primitive
- Entry: a per-repo rail row (`?activityRepo=<id>`)
- Files: `components/Activity/index.tsx` (`RepoConsole`), `RepoFeedHeader.tsx`, `RepoStats.tsx`,
  `BranchStatusPanel.tsx`, `RepoInsightsPanel.tsx`, `RepoOpenPrList.tsx`, `FeedIsolationBanner.tsx`
- Essential info:
  - [ ] Activity | Bots sub-tabs, remembered per repo in `filters.repoConsoleTabs`
  - [ ] Header: repo name, maintainer count, attention count, [open PRs], the stats line, the
    thread-state bar, a compact default-branch panel
  - [ ] "Showing only #N" isolation banner with a clear action (`feedPr`)
  - [ ] Per-repo insights tiles and charts ("More charts")
  - [ ] The repo's open PR list ("Show all N open PRs" → Open PRs pre-filtered to that repo)
  - [ ] The repo feed
  - [ ] Bots tab: BotsView for this repo
- Actions:
  - [ ] Switch sub-tab
  - [ ] Clear the isolation
  - [ ] Show all open PRs (`openOpenPrsDetail(repoId)`)
- States:
  - [ ] Insights and the open-PR list are hidden while isolated to one PR
- Tests: testId `repo-console`

### [ ] Board slot + resizable detail pane (Timeline)
- Entry: the Timeline tab (`?view=timeline`), or `?pr=` / `?thread=` deep links
- Files: `App.tsx`, `components/DetailPane.tsx`, `components/Timeline/index.tsx`
- Essential info:
  - [ ] Exactly one `<Timeline>` mounted: the shared board, or a pr-focus isolate instance (keyed remount)
  - [ ] Bottom PrDetail pane for the selected PR (placement `'pane'`); hidden when nothing is selected
  - [ ] Height persisted in localStorage `pierre:detailPaneHeight` (default 384, 160px to 70vh)
- Actions:
  - [ ] Drag the separator to resize ("Resize detail pane", pointer capture)
  - [ ] Clear selection × ("Clear selection (Esc)", `data-testid detail-clear`)
- States:
  - [ ] Board and pane are set inert under any overlay
  - [ ] A synthetic resize fires when the pane appears or disappears
- Tests: testIds `detail-pane`, `detail-clear`; `e2e/cluster-back-nav.mjs`,
  `e2e/selection-glow.mjs`, `e2e/focus-retained-on-reopen.mjs`; verify-demo "timeline" (`?view=timeline&preset=30d`)

### [x] Full-main overlays (one per tab kind) → unchanged testIds, `bg-ui-bg`; `<main>` is `overflow-clip` so a too-wide page never widens the phone's layout viewport
- Entry: an absolute inset-0 z-20 layer over the warm board, one per active tab kind
- Files: `App.tsx`, `PrDetail.tsx`, `Sprint/SprintTabView.tsx`, `Activity/MetricsDetail.tsx`,
  `Activity/BotPrsDetail.tsx`, `Activity/BotOnlyPrsDetail.tsx`, `Activity/BotThreadsDetail.tsx`,
  `Activity/BotFlaggingDetail.tsx`, `Activity/BotVolumeDetail.tsx`, `Activity/ThemeThreadsDetail.tsx`,
  `Activity/UserActivityDetail.tsx`, `Activity/BotDetailPanel.tsx`, `Ticket/TicketTabView.tsx`,
  `Search/SearchResultsTab.tsx` (all under `components/`)
- Essential info (each testId must still mount):
  - [ ] `pinned-pr-overlay` (PrDetail fullscreen, deep-links `selectedThreadId`)
  - [ ] `activity-overlay`
  - [ ] `sprint-overlay`
  - [ ] `metrics-overlay`
  - [ ] `bot-prs-overlay`
  - [ ] `bot-only-prs-overlay`
  - [ ] `bot-threads-overlay`
  - [ ] `bot-flagging-overlay`
  - [ ] `bot-volume-overlay`
  - [ ] `theme-threads-overlay`
  - [ ] `user-activity-overlay`
  - [ ] `bot-detail-overlay`
  - [ ] `ticket-overlay`
  - [ ] `search-overlay`
- States:
  - [ ] Each new kind MUST join `overlayActive`
  - [ ] `overflow-auto` on the bot-flagging and bot-volume overlays is load-bearing (the
    auto-load sentinel roots on it)
  - [ ] user-activity, bot-detail and ticket are keyed on the tab so they remount
- Tests: e2e and capture-shots use these data-testids

### [ ] Conflict resolver overlay mount
- Entry: mounted once in App, above main. Opened from PrDetail's Conflicts row, the merge panel,
  Pending's conflicts card, or ClosedResolverToast
- Files: `components/conflicts/ConflictResolverOverlay.tsx`, `store/conflictResolver.ts`
- Essential info:
  - [ ] Outlives the pane that opened it
- States:
  - [ ] Gated to `writableRepoIds` at its openers
- Tests: `docs/FRONTEND.md` § The merge-conflict resolver

### [x] Global keyboard (useKeyboard) → kept `/` (now the palette, add-repo field first) · `i` · j/k (board) · Esc; added `g`+letter (capture phase) and `?`
- Entry: window keydown, everywhere
- Files: `hooks/useKeyboard.ts`, `components/HelpModal.tsx` (documents it)
- Essential info:
  - [ ] "/" focuses `#add-repo-input` when the manager is open, else `#global-search-input`
  - [ ] "i" shows Activity
  - [ ] j/k cycle the shared board's PRs by openedAt (Timeline only)
  - [ ] Esc: blurs an input; off the board it goes to the Timeline (the tab stays open); on the
    board it clears the selection
- States:
  - [ ] Typing targets are ignored
  - [ ] Popovers, menus, modals and the resolver stopPropagation on Escape (`lib/activePopover.ts`),
    or Esc yanks the reader to the Timeline
- Tests: `test/activePopover.test.ts`, `e2e/pending-keyboard.spec.ts`

### [x] URL state map (useUrlState: read, write, popstate) → unchanged; the shell writes only through the same store actions (`components/shell/nav.ts` `goTo`)
- Entry: address bar, Back/Forward, bookmarks. `/app/` (`/` → 302 `/app`)
- Files: `hooks/useUrlState.ts`, `store/pinnedTabs.ts`, `store/filters.ts`,
  `lib/docReferences.ts` (`parseDocsDeepLink`), `store/docsView.ts`
- Essential info (every key keeps working):
  - [ ] `view`: timeline | sprint | activity (default when absent) | pr-detail:<id> | pr-focus:<id> |
    user-activity:<id> | bot-detail:<id> | ticket:<ident>. Legacy `view=open-prs` → Activity/Open
    PRs; no view + `?pr`/`?thread` → timeline
  - [ ] `workspace=<int>`, or legacy `team=<int>` when no workspace. Unknown means Default
  - [ ] `activityRepo`: <repoId> | attention (Pending) | feed | bots | insights (Reports) | docs.
    Omitted = open-prs. Legacy sprint → This Sprint tab; compare → ignored
  - [ ] Pending: `attn=<InsightKind>`, `attnTab=my_turn|claude|fixing|review|threads|land|deps`,
    `attnRel=mine|others`, `attnBy=people|automation`. Legacy `attnPersonal=1` → `attnRel=mine`;
    `attnView` ignored; any attn* with no activityRepo means Pending
  - [ ] `feedPr=<prId>`; `feedTab=classification` (legacy → Bots Classification)
  - [ ] `botsTab=roi (default)|themes|benchmark|classification`; legacy `botsTab=settings` → classification
  - [ ] `insightsTab=overview (default)|bottlenecks|stories`; legacy sprint|merged → This Sprint.
    `report=<periodKey>`, `reportGrain=month`
  - [ ] `sprintTab=themes (default)|paths|people|merged`; legacy graph → themes. `sprintStory=<ident>`
  - [ ] `prTab=overview|comments|activity|changes|bot_activity|claude_review|ai_fix`, only with
    `view=pr-detail:<id>`; legacy threads → changes
  - [ ] Docs one-shot: `doc`, `section`, `anchor`, `quote` (with `activityRepo=docs`)
  - [ ] Timeline filters: `preset` (14d default; 7d/30d/90d/custom), `from`/`to`, `repos`, `users`,
    `bots=0` (legacy `bots=1`), `allowBots`, `stale=0`, `cats`, `status`, `reviews`, `states`, `pr`, `thread`
  - [ ] `perf` (dev probe, `main.tsx`)
  - [ ] `NAV_KEYS` push history; other keys replace. Ephemeral drill-downs emit no view
- Actions:
  - [ ] Back/Forward re-applies the URL to both stores (one popstate listener)
  - [ ] `markUrlCorrection` makes the next write a replace
- States:
  - [ ] Persisted filter blob is `FILTER_STORAGE_VERSION` v5 (`migratePersistedFilters` chains)
  - [ ] `workspaceId` is never in FilterDefaults
- Tests: `test/landingTab.test.ts`, `test/urlHistory.test.ts`, `test/attentionIsolation.test.ts`,
  `test/periodReportUrl.test.ts`, `test/docsRailUrl.test.ts`, `test/feedPrEventChips.test.ts`,
  `test/ciFailingCard.test.ts`, `test/pendingTabs.test.ts`, `test/filterStorageMigration.test.ts`,
  `test/ticketTab.test.ts`, `e2e/activity-feed.spec.ts`; `scripts/verify-demo.mjs` VIEWS and
  `scripts/record-demo-steps.mjs` drive every screen by these URLs

### [x] InfoButton / InfoModal (explanation primitive) → same API and behaviour (click, Esc captured, focus trap/return); tone, no borders, `ui-pop`; the ⓘ gets a 40px touch hit area; InfoModal is a bottom sheet below sm
- Entry: ⓘ buttons beside headings app-wide (in the shell: AiUsageMenu "Limn's share")
- Files: `components/InfoModal.tsx`
- Essential info:
  - [ ] Explanatory copy lives here, never in captions
- Actions:
  - [ ] Open by click (never hover)
  - [ ] Close (×, Esc captured, backdrop)
- States:
  - [ ] Escape is captured so the global handler does not fire
- Tests: `test/activePopover.test.ts`

---

## 2. Pending, Open PRs, Feed

Shared rules: `packages/shared/src/pending-rules.ts`. Today's keyboard: "/" search, "i" Activity,
Esc to Timeline or blur; j/k ONLY on the Timeline board; on Activity a focused card opens with
Enter/Space (PrCardFrame). Back from a PR scrolls to and flashes the card or row it came from
(`activityFlashItemId`, `returnItemId`) on Pending and the Feed — **must survive**. Toasts go through
the ONE HeaderToastStrip (MyTurnDismissToast, DependencyMergeToast).

### [x] Activity rail entries for these three areas (shell entry points) → the sidebar (Pending, Open pull requests, Feed; repo rows under Repositories); see § 1
- Entry: Activity → rail: "Open PRs" (default landing; `?view=activity` with no activityRepo;
  legacy `?view=open-prs`), "Pending" (`?activityRepo=attention`), "Feed" (`?activityRepo=feed`).
  Per-repo rows (`?activityRepo=<repoId>`) open a repo console that also mounts the Feed.
- Files: `components/Activity/index.tsx`, `lib/openPrsTab.ts`, `hooks/useUrlState.ts`,
  `components/Activity/RepoFeedHeader.tsx`, `RepoOpenPrList.tsx`, `BranchStatusChip.tsx`
- Essential info:
  - [ ] Open PRs count = NON-DRAFT open PRs; blank (never 0) until it answers or while it is the
    previous workspace's placeholder (`openPrsTabCount`)
  - [ ] Pending has no count on the rail and uses a stopwatch (`TimerIcon`), not a warning glyph
  - [ ] Rail "generated N ago" staleness line (refreshes every 30s) and a refetch hairline that keeps the last data
  - [ ] Per-repo row: name, maintainer shield, unread dot, thread-state bar, attention count,
    open PRs [N] or [—], default-branch line (branch · CI dot · last commit)
  - [ ] Legend: untouched / replied / likely addressed / resolved colours
  - [ ] Rail order: Open PRs · Pending · Docs (AI only) · Feed · Reports · Bots Monitoring · repos
- Actions:
  - [ ] Select Open PRs / Pending / Feed / a repo (`setActivityRepo`)
  - [ ] Repo console: Activity | Bots sub-tabs (`repoConsoleTabs`); Activity = RepoFeedHeader +
    FeedIsolationBanner + RepoInsightsPanel + RepoOpenPrList + FeedView(repoId)
- States:
  - [ ] First run → FirstRunOnboarding replaces the whole body, whichever entry is selected
  - [ ] Empty workspace → guidance sentence (Pending falls through to it; Open PRs shows it as the list's empty label)
  - [ ] "Detecting the repos you work on…" while there are no repos anywhere
  - [ ] Loading → three pulse skeletons; an unknown numeric repo id falls back to the cross-repo
    Feed with the isolation banner
  - [ ] `workspaceId` null → nothing workspace-scoped renders
- Tests: `e2e/activity-feed.spec.ts` (landing, rail order, empty workspace, bare URL, legacy
  `?view=open-prs`, no counts before workspace resolves), `test/openPrsTab.test.ts`,
  `test/switchWorkspaceToOpenPrs.test.ts`, `scripts/record-demo-steps.mjs` "repo-console", ws2:* views

### [ ] Pending board header + work-plan narration
- Entry: rail → Pending (`?view=activity&activityRepo=attention`). Notifications and banner links
  seat a tab, kind or lens via `attnTab`, `attn`, `attnRel` (legacy `attnPersonal=1`), `attnBy`;
  legacy `attnView=branches` lands on My turn
- Files: `components/Activity/AttentionView.tsx`, `PendingInfo.tsx`, `hooks/useWorkPlan.ts`,
  `hooks/useAttentionCards.ts`, `components/AiSetup.tsx`, `components/AiStatusLine.tsx`
- Essential info:
  - [ ] Heading "Pending" + ⓘ PendingOrderInfo popover (click, not hover): tab count rule, score
    weights (proximity/stall/relevance %, preset name when not balanced), "top 5 are Do next", "My
    turn groups by type in the Settings order", the per-card ⓘ, a "How Pending works" link
  - [ ] PendingGuideModal "How Pending works": tables for The tabs, Inside a tab, The score,
    Colours, Who opened it, When it is your turn (appears / goes away), and the meaning of Your
    turn / In your repos / Review or reply / muted — **the Colours table must be rewritten for the
    new colour rules**
  - [ ] Work plan (AI only, only when the board has cards): "written N ago" (title = `aiRunLabel`
    model), amber "stale" chip when the list moved since the plan, AI-ink headline and "parked"
    line with sparkle mark, "N references the model named were not on this board and were
    discarded", the error text, notices "A plan is already being written…" / "Nothing needs doing
    in this workspace right now."
  - [ ] AiRunGate meter beside the button (e.g. "Limn: 2% of your week · limit 5%")
- Actions:
  - [ ] Plan my day / Re-plan my day (`AiRunGate kind='complete'`; shared mutation key so a tab
    switch mid-run never shows the button again; while running: AiStatusLine "Writing the plan")
  - [ ] Open the ⓘ order popover → "How Pending works" guide modal (Esc / Close)
- States:
  - [ ] Narration hidden unless `me.ai.enabled`; the board is complete without it
  - [ ] Loading = workspaceId null OR fetching (tab counts show "…"), never "0"
  - [ ] Error: "Couldn’t load what needs attention."
  - [ ] Board liveness: ONE batched `POST /api/attention/liveness` (≤ `ATTENTION_LIVENESS_MAX_IDS`,
    ranked merge/update/conflicts/deps/own_ready first, then on-screen) → invalidates
    attention-cards + daily-brief + work-plan; never edits the list itself
- Tests: `test/pendingExplain.test.ts`, `test/activePopover.test.ts`, `e2e/pending-keyboard.spec.ts`,
  `test/aiGating.test.ts`, verify-demo `pending:<tab>` (pending.png, pending-deps.png)

### [ ] Pending tab strip (the seven PENDING_TABS)
- Entry: inside the Pending board; `?attnTab=my_turn|claude|fixing|review|threads|land|deps`
- Files: `components/Activity/AttentionView.tsx`, `pendingTabs.ts`, `PendingKindIcon.tsx`,
  `packages/shared/src/pending-rules.ts`
- Essential info:
  - [ ] Seven tabs in order, icon each: My turn (my_turn except claude_review; grouped by type in
    the reader's order) · AI reviews (my_turn claude_review) · Needs fixing (ci_failing +
    conflicts) · Waiting on review (stalled_review + reviewer_routing; reviewer_load is the strip)
    · Unanswered threads (untouched_thread) · Ready to land (merge + update_branch) · Dependencies
    (security before dependency_bump)
  - [ ] Each tab's count = its whole UNCAPPED population (same figure as `/api/daily-brief`); under
    the People/Automation lens the badge counts that side only (the server's figure, never total − other)
  - [ ] A zero tab stays visible, dimmed, so "0" is a fact
  - [ ] AI reviews tab hidden when AI is off, unless it holds cards or is the current tab
  - [ ] The tab on screen is DERIVED (`effectivePendingTab`), never written back
- Actions:
  - [ ] Switch tab (`setAttentionTab`) — also clears a seated kind
  - [ ] NEW: number keys 1–7 switch tabs (see DESIGN.md keyboard map)
- States:
  - [ ] Counts show "…" while loading
  - [ ] Bot kinds (bot_signal, bot_only_review) never reach this board
- Tests: `test/pendingTabs.test.ts`, `test/attentionIsolation.test.ts`, `test/ciFailingCard.test.ts`,
  verify-demo `pending:my_turn…pending:deps`, record-demo-steps `pending:<tab>`

### [ ] Pending tab controls row (kind chips, Only yours, Anyone/People/Automation, Customise)
- Entry: under the tab strip; rendered when the tab has kind chips, an offered lens, or is My turn
  (always on My turn, even empty)
- Files: `components/Activity/AttentionView.tsx`, `pendingTabs.ts`, `store/settingsModal.ts`
- Essential info:
  - [ ] Kind chips on a two-kind tab: "All N" + one chip per kind with icon and count (Security /
    Bumps; CI failing / Merge conflicts; Stalled review / Needs a reviewer; Ready to merge / Behind trunk)
  - [ ] "Only yours N" (My turn only): items you are named on plus repos you maintain; tooltip explains
  - [ ] "Not tied to you N" pill shown only while `attnRel=others` is seated, so it can be turned off
  - [ ] "Who opened it" group: Anyone N (= `view.allTotal`) · People N · Automation N — offered only
    when both sides are non-empty or the lens is on
  - [ ] Pill figures are the server's own split, never a subtraction
- Actions:
  - [ ] Pick a kind chip / All (`setAttentionTab(tab, kind)`)
  - [ ] Toggle Only yours (`setAttentionRelevance 'mine'|null`); clear "Not tied to you"
  - [ ] Set author lens Anyone/People/Automation (one store field, survives tab switches; `?attnBy=`)
  - [ ] Customise → Settings on the My Turn section (`openSettings('my-turn')`), focus returns on close
- States:
  - [ ] Hidden while loading or on error
- Tests: `e2e/pending-keyboard.spec.ts` ("Customise closes the open popover…", "Customise opens
  Settings on the Pending tab…"), `test/pendingTabs.test.ts`, record-demo-steps `pending:mine`,
  `pending:others`, `pending:people`, `pending:automation`

### [ ] Pending list body: sections, cap line, empty notes, Dismissed list
- Entry: the tab panel under the controls
- Files: `components/Activity/AttentionView.tsx`, `AttentionCards.tsx`, `pendingExplain.ts`,
  `MyTurnDismissedList.tsx`, `hooks/useMyTurnDismiss.ts`
- Essential info:
  - [ ] ONE list (one AttentionCards mount, so the Back-flash is not raced): "Reviews waiting on
    people · not ranked" strip (reviewer_load cards, Waiting on review tab), then "Do next" (top
    `PENDING_DO_NEXT_SIZE`=5 by score), then "Everything else" divider
  - [ ] Cap sentence when shown < total (`capSentence`)
  - [ ] Per-tab empty sentences: "Nothing is your turn right now." / "No finished AI reviews are
    waiting on you." / "No failing builds or merge conflicts are yours to fix." / "No reviews are
    waiting." / "No review threads are waiting for an answer." / "Nothing is ready to land." / "No
    dependency updates or security alerts are waiting."
  - [ ] Narrowed empty notes: "Nothing from <people|automation> in <tab> right now." + "Show all";
    "Nothing under <Kind> right now."; "Nothing on My turn personally involves you right now." +
    "Show everyone’s". Placement above the people strip when a narrowing emptied the cards
  - [ ] My turn only: collapsible "Dismissed N" — each item: repo #N, title, ↗ GitHub link, reason
    label, "dismissed N ago", and "Each comes back by itself when something new happens on it."
  - [ ] Card severity accent (SEV map) — becomes the row's status icon colour under the new rules
- Actions:
  - [ ] Show all (clears author lens) / Show everyone’s (clears relevance lens)
  - [ ] Dismissed → expand/collapse; "Bring back" per item (`useRestoreMyTurn`; "Bringing it back…")
  - [ ] Dependencies tab: "Merge or arm all" (own surface below)
- States:
  - [ ] Loading: three pulse skeletons
  - [ ] Error sentence
  - [ ] Empty alone vs empty above the strip
- Tests: `test/pendingExplain.test.ts`, `test/myTurnCapDisclosure.test.ts`, `test/pendingTabs.test.ts`,
  `e2e/pending-cards.spec.ts`

### [ ] Pending card anatomy (shared by every kind)
- Entry: each row; clicking anywhere not on a control opens "the event" (thread → Changes at the
  thread; comment → Changes/Comments scrolled to it; PR → a given tab; claude_review → the AI
  review; trunk → GitHub checks page in a new window, else the landing PR). Enter/Space on the
  focused card does the same.
- Files: `components/Activity/AttentionCards.tsx`, `PrCardShell.tsx`, `lib/pendingHeadings.ts`,
  `pendingLabels.ts`, `PendingInfo.tsx`, `BlastRadiusChip.tsx`, `LargePrFlag.tsx`
- Essential info (one-line row + side panel must carry ALL of it):
  - [ ] 1 Heading: kind icon + what happened, who, quoted reply text, compact age once ("Your
    review was requested · 4d", "Priya Nair replied: “…” · 14h", "Sam Carter pushed 1 commit since
    you commented · 22d"; age title = full date)
  - [ ] 2 Action line: ownership label off relevance ("Your turn" outside My turn/AI reviews · "In
    your repos" · neutral) · "muted" (title explains repo mute, Settings → Workspace) · bold verb
    ("Review it", "Reply or resolve", "Check it answers you, then resolve", "Answer on the PR",
    "Read it and reply", "Re-review the new commits", "Take a first look", "Read what’s new ·
    clears when you open it", "Open to merge", "Merge"/"Update branch"/"Let it land", "Resolve
    conflicts", "Fix the build", "Fix it or chase it", "Chase them or review it", "Assign a
    reviewer", "Merge the fix", "Check the alert", dep verbs) · where (your comment on path:line; a
    commit sha link) · "on" PR title (button → Overview) · repo#N (org dropped when every card shares
    it) · "by <author>" · after-items ("1 other asked", "N done this sprint") · ↗ GitHub · ⓘ
    CardPlacementInfo ("Why this card is here": rank "Nth of M", Do next or not, score parts, link to the guide)
  - [ ] 3 Work-plan "why" line (AI ink, sparkle) when the plan names this card
  - [ ] 4 Event content: reply body (Markdown, clamped ~4 lines, Show more/less, "Open
    thread/comment/PR" when truncated, byline name · time); pushed commit list (sha, headline or
    "Message not synced yet", @author when several, "and N more"); thread opening comment
    (own_thread, untouched_thread); failing check names in red + "and N more"; "Last landed: <PR> by
    X, merged by Y — not necessarily the cause" on trunk cards; suggested reviewers; security
    advisory detail; reviewer_load pending PR list
  - [ ] 5 Fact line by the card's job: CI status with failing names, queue fact, review standing
    ("No reviews yet", "1 approval", "No approval yet", with icon) + GitHub's decision (except
    "GitHub: no review required"), reach word (Low/Medium/High reach), large-PR flag
  - [ ] 6 AI review line (own surface below)
  - [ ] 7 Buttons: primary · secondaries · Details ▸ · Dismiss (my_turn only)
  - [ ] Details (click only; fetches only on click): standing if not already said, reviewer chips
    (humans with standing + avatar, bots collapsed, "+N more"), byline with vendor/source chip for
    bot-authored PRs, opened age, file count, +/− lines, large-PR flag, reach phrase, AI review
    extras (currency "on latest commit / N newer", Earlier: fixed/settled/still open, threads to
    fix, CI pill, posted/not posted, N design), and the full thread conversation (ThreadCard with
    inline Reply + Resolve; "Loading conversation…" / "Couldn’t load this conversation.")
- Actions:
  - [ ] Open the event (row click / Enter / Space)
  - [ ] Open the PR on Overview (title)
  - [ ] Open on GitHub (↗)
  - [ ] Open the commit (sha link)
  - [ ] ⓘ Why this card is here → How Pending works
  - [ ] Details toggle
  - [ ] Show more/less on a reply
- States:
  - [ ] NOTHING on the board fetches on mount (thread, PR description, merge options all click-gated)
    — a side panel opened by j/k selection counts as "click" only if it still issues no request on
    mere selection; fetch on explicit open only
  - [ ] Flash ring on Back-return
  - [ ] A new InsightKind still renders a heading off `KIND_LABEL`
- Tests: `e2e/pending-cards.spec.ts` ("leads with what happened, says what to do, and claims no
  "Your turn" inside My turn", "the conversation waits for Details — nothing is fetched to paint
  the board"), `test/pendingHeadings.test.ts`, `test/pendingCardControls.test.ts`,
  `test/prCardShell.test.ts`, `test/failingChecksText.test.ts`, `test/reachModel.test.ts`,
  `test/largePrFlag.test.ts`

### [ ] My turn card types (my_turn reasons) and their buttons
- Entry: My turn tab (grouped by reason in Settings order); claude_review cards live in AI reviews
- Files: `components/Activity/AttentionCards.tsx`, `lib/pendingHeadings.ts`,
  `packages/shared/src/types.ts` (`MyTurnCardReason`)
- Essential info:
  - [ ] 15 reasons: review_request, mention, thread, thread_reply, comment_reply, pushed_since,
    own_ci_red, own_conflicts, trunk_red, pr_approved, own_ready, your_pr, own_thread,
    claude_review, watched_repo_pr
  - [ ] isLikelyAddressed thread → "Check it answers you, then resolve" and an "Open thread" primary
  - [ ] own_ready shows the merge row; own_conflicts shows the resolver entry
  - [ ] trunk_red is a repo card (dismiss target = repo)
- Actions:
  - [ ] thread: Reply (or Open thread if likely addressed) + Resolve
  - [ ] thread_reply / own_thread: Reply + Resolve
  - [ ] comment_reply: Answer (lands on the comment, else Comments tab)
  - [ ] mention: Read it
  - [ ] review_request: Start review (Changes tab) + "Review with <provider>" (AI)
  - [ ] pushed_since: See the commits (Activity tab) + Review with AI
  - [ ] watched_repo_pr: Open PR + Review with AI
  - [ ] own_ci_red: Open checks ↗ (GitHub checks page) else Open PR; + AI Fix
  - [ ] claude_review: Read the review
  - [ ] own_ready: Merge / Update branch / Merge when ready (merge row)
  - [ ] own_conflicts: Resolve conflicts (resolver)
  - [ ] pr_approved: Open to merge
  - [ ] your_pr / default: Open PR
  - [ ] trunk_red: Open checks ↗ / Open the commit ↗, Open #N (landing PR); on your PR arm: Open checks + AI Fix
  - [ ] Dismiss (all my_turn) → undo toast
- States:
  - [ ] Resolve shows "Resolving…" → "Resolved", error inline beside it (GitHub decides permission)
  - [ ] AI buttons only where `me.ai.enabled`
- Tests: `test/pendingHeadings.test.ts`, `test/ciFailingCard.test.ts`, `e2e/pending-cards.spec.ts`

### [ ] Needs fixing / Waiting on review / Unanswered threads card kinds
- Entry: Needs fixing (ci_failing, conflicts), Waiting on review (stalled_review, reviewer_routing,
  the reviewer_load strip), Unanswered threads (untouched_thread)
- Files: `components/Activity/AttentionCards.tsx`, `components/conflicts/ResolveConflictsButton.tsx`,
  `hooks/useRequestReviewers.ts`
- Essential info:
  - [ ] ci_failing: arm "trunk" (a repo's default branch is red: failing checks, last landed PR +
    caveat) vs "your_pr"; conflicts: "Merge conflicts", state chip, "Your PR" when the viewer authored it
  - [ ] stalled_review: "Chase them or review it", who asked, how long
  - [ ] reviewer_routing: heading "Nobody was asked to review this · opened …"; "Suggested
    reviewers" list: user/team chip (@team) + reason
  - [ ] reviewer_load (strip): person, "N done this sprint", their pending PR list (title + repo#N, each opens the PR)
  - [ ] untouched_thread: thread opener comment (name · time · text clamped 3 lines), "Reply or resolve", by author
- Actions:
  - [ ] Trunk: Open checks ↗ / Open the commit ↗ + Open #N
  - [ ] conflicts: Resolve conflicts → (AI on) split menu "Resolve manually" / "Resolve with
    <provider>" with a progress bar; (AI off) one button opening the resolver; plus armed-intent
    headline + Merge when ready control when an intent is armed
  - [ ] stalled_review: Open PR + Review with AI
  - [ ] reviewer_routing: Open PR + Review with AI + per-suggestion "Assign" (POST request reviewers;
    "Assigning…" → "✓ Requested"; error inline; button only when viewerCanPush)
  - [ ] untouched_thread: Reply + Resolve
  - [ ] reviewer_load: open any listed PR
- States:
  - [ ] Conflicts action only in writable repos (viewerCanPush; `me.conflictResolver`); hidden, never disabled
- Tests: `e2e/pending-assign-reviewer.spec.ts`, `test/ciFailingCard.test.ts`,
  `test/mergeResolver.test.ts`, `test/claudeConflictPrefill.test.ts`

### [ ] Ready to land merge row (merge / update_branch / own_ready / dependency cards)
- Entry: Ready to land tab, own_ready My turn cards, Dependencies cards
- Files: `components/Activity/AttentionCards.tsx` (`PendingMergeActions`, `pendingMergeGate`,
  `mergeRowCardOf`), `components/MergeControl.tsx`, `components/MergeWhenReadyControl.tsx`, `lib/ui.ts` (`mergeVerdict`)
- Essential info:
  - [ ] Gate from synced fields via `mergeVerdict`: Merge on clean/unstable/has_hooks; Update
    branch (never Merge) when behind; nothing (and the verdict sentence with tone + detail) when
    blocked / conflicts / unknown
  - [ ] Heading "Ready to merge" / "Ready to merge · non-required checks are red" / "Behind its
    base branch — GitHub blocks the merge"; queue line ("In the merge queue · running checks")
  - [ ] In-flight text "Merging…" / "Updating the branch…"; armed intent headline
    (`armedPhaseHeadline`); stopped intent "Auto-merge stopped — reason"
  - [ ] Merge button method caret: expanding fetches live merge options ONCE (Create a merge
    commit / Squash and merge / Rebase and merge), "Checking merge status…"; queue repos: Add to
    merge queue / Remove from queue
  - [ ] A QUEUED PR never shows Merge; Merge when ready hidden while queued unless armed (Cancel /
    Cancel & dequeue always possible)
- Actions:
  - [ ] Merge (method picker) — NEW key `m` only when this gate allows Merge
  - [ ] Update branch
  - [ ] Add to merge queue / Remove from queue
  - [ ] Merge when ready / Queue when ready (arm; "Arming…"), Cancel auto-merge / Cancel & dequeue
- States:
  - [ ] Row hidden entirely when `!viewerCanPush` (writableRepoIds rule) or a non-dependency security card
  - [ ] Errors: "Failed to merge the PR.", "Failed to update the branch.", "Merge-queue action
    failed.", "Failed to arm auto-merge."
  - [ ] An optimistic row removal on merge must restore the row if the merge fails
- Tests: `test/pendingCardControls.test.ts`, `test/mergeControlQueued.test.ts`,
  `test/mergeWhenReadyEligibility.test.ts`, `test/autoMergeOutcomes.test.ts`,
  `test/mergeBlockers.test.ts`, record-demo-steps (attnTab=land step)

### [ ] Dependencies tab (security + dependency_bump) and "Merge or arm all"
- Entry: Pending → Dependencies (`?attnTab=deps`); chips All / Security / Bumps
- Files: `components/Activity/AttentionCards.tsx` (`SecurityDetail`, `DependencyActions`,
  `advisoryParts`), `DependencyMergeAll.tsx`, `hooks/useDependencyMergeAll.ts`
- Essential info:
  - [ ] Security card: heading "Flagged for <ID>" / "<Bot> fixes <GHSA…>"; fix sentence with
    advisory chips (each links to the advisory ↗; red, amber when only inferred), alert lines
    "<source> flagged <ID> and N more" + "in a review thread" (opens the thread), up to 3 extra chips
    "+N more", "+N more alerts"
  - [ ] Bump card: "<Bot> bump can land now", dep state verb (Merge it / Update branch / Resolve
    conflicts / Fix the build / Review it / See what blocks it / Open it), failing checks when red
  - [ ] Merge or arm all dialog: "Checking N pull requests…", "Merges N now. Sets N to merge when
    their checks pass.", "Nothing here can be merged or armed.", "Skips N:" with each reason;
    confirm "Merge N, arm N"
  - [ ] Result toast in HeaderToasts: "Dependency updates" summary + Show more list of failures
- Actions:
  - [ ] Start review (needs_review) / Open checks ↗ (ci_red) / Open PR (blocked/unknown) / merge
    row / Resolve conflicts (depState conflicts)
  - [ ] Open PR (security with no dependency update)
  - [ ] Merge or arm all → dry-run dialog (fetches only when opened) → confirm; Esc/Close
- States:
  - [ ] "Merge or arm all" renders nothing when no listed card is a dependency PR; running label "Merging and arming…"
  - [ ] Dialog error "Couldn’t check these pull requests."
- Tests: verify-demo `pending:deps` (pending-deps.png), `test/pendingHeadings.test.ts`

### [ ] AI review on Pending cards (line + buttons)
- Entry: every PR card on Pending when `me.ai.enabled`; one batched claude-review-states +
  ci-review-states request for the board
- Files: `components/Activity/PendingClaude.tsx`, `hooks/useClaudeReview.ts`
- Essential info:
  - [ ] "AI review" label + state: Review failed (opens the review) / Starting… / Queued (+auto
    mark) / Reviewing… (pulse) / verdict pill (Approve/Comment/Request changes, icon) — verdict
    omitted on claude_review cards
  - [ ] Severity pills ("1 blocker", "2 warnings", "2 nits", "1 question") or "No issues"
  - [ ] On a red-build card the CI diagnosis pill replaces the verdict ("1 CI failure explained")
  - [ ] "reviewed N ago"
- Actions:
  - [ ] Open review (or the primary "Read the review" on claude_review cards)
  - [ ] Re-review when the head moved
  - [ ] Review with <provider> / Review again after a failure — if AI not ready, opens the review tab instead
  - [ ] AI Fix / fix-state pill (running pulse, "ready" = review and push in the AI Fix tab) —
    offered on own_ci_red and when a fix exists
  - [ ] Error "Could not start the review." inline
- States:
  - [ ] Hidden entirely without `me.ai.enabled` (no request either)
  - [ ] Auto-review hold errors suppressed unless held
- Tests: `test/claudeReviewColumn.test.ts`, `test/ciReview.test.ts`, `test/claudeAutoReview.test.ts`,
  `test/aiStatusAndPrActions.test.ts`, `test/aiProviderCopy.test.ts`

### [ ] Dismiss + undo toast
- Entry: "Dismiss" quiet button on every My turn card (PR or trunk repo); toast in the ONE header strip
- Files: `components/Activity/AttentionCards.tsx` (`DismissButton`), `MyTurnDismissToast.tsx`,
  `hooks/useMyTurnDismiss.ts`, `components/HeaderToasts.tsx`, `App.tsx`
- Essential info:
  - [ ] Tooltip "Take this off My turn until something new happens on it"
  - [ ] Toast: "Dismissed" — "<repo #N> — until something new happens on it", 10s, Undo
- Actions:
  - [ ] Dismiss ("Dismissing…"; error "Couldn’t dismiss it.") — NEW key `e`
  - [ ] Undo ("Bringing it back…") — NEW key `z`
  - [ ] Close the undo offer
- States:
  - [ ] Per-SUBJECT dismissal, expires on the next related event
- Tests: `test/pendingMutePatch.test.ts`, `test/myTurnSettingsForm.test.ts`

### [ ] Open PRs header and controls
- Entry: rail → Open PRs (default landing, `?view=activity`)
- Files: `components/Activity/OpenPrsDetail.tsx`, `OpenPrsCards.tsx` (`OpenPrsSortMenu`,
  `OpenPrsViewToggle`, `AutoReviewUsageLine`, `RunAutoReviewsButton`), `MetricRepoFilter.tsx`,
  `lib/openPrsSort.ts`, `store/openPrsView.ts`, `hooks/useTriage.ts`
- Essential info:
  - [ ] "Open PRs" + scope ("every repo in this Workspace" / one repo / "N repos") · "N open"
    (non-draft, matches the rail) · "N drafts"
  - [ ] Auto review usage (AI on, auto review on): "N of M auto reviews today · resets in Xh Ym"
    (amber when full; refreshes each minute; UTC day)
  - [ ] Sort menu (radio items, arrow keys, Esc): Recent activity (default) · Updated · Opened ·
    Size · Untouched threads · CI · Approval · AI review* · AI findings* · Repo · Author · PR number
    (*AI only); reverse-order button with direction arrow; sort is local state
  - [ ] Layout toggle "Group by ticket" | "List" (only with a tracker; localStorage `pierre:openPrsView`)
  - [ ] Repo filter dropdown: "All Workspace repos" / "Repos (n/N)", checkbox per repo + "Show only
    <repo>", "No repos with data."; stored per workspace (`openPrsRepoFilter`)
- Actions:
  - [ ] Run auto reviews now (`AiRunGate kind=review`, meter off; "Checking…"; result/status line
    for 15s; errors inline) — only when auto review is on for this workspace
  - [ ] Change sort / reverse
  - [ ] Group by ticket / List
  - [ ] Filter repos / Show all
  - [ ] Refresh (refetch; spinning icon)
- States:
  - [ ] FirstRunOnboarding when the account has no repos
  - [ ] Empty workspace label; "No open PRs for the selected repos — adjust the repo filter."; "No open PRs here."
  - [ ] Error "Couldn’t load the open PRs."; loading = 4 skeletons (aria-busy)
- Tests: `test/openPrsSort.test.ts`, `test/openPrsTab.test.ts`, `test/workspaceOpenPrsScope.test.ts`,
  `test/switchWorkspaceToOpenPrs.test.ts`, `test/claudeAutoReview.test.ts`, verify-demo "open-prs"
  (open-prs.png), record-demo-steps open-prs, ws2:open-prs

### [ ] Default branches (trunk) strip
- Entry: top of Open PRs (hidden in an empty workspace); compact non-collapsible copy in the per-repo console header
- Files: `components/Activity/DefaultBranchesSlot.tsx`, `BranchStatusPanel.tsx`, `hooks/useBranchStatus.ts`
- Essential info:
  - [ ] Collapsed by default (whole header is the toggle): "DEFAULT BRANCHES" · "N green" / "all N
    green" · "N failing" · "N running" · "N repos"
  - [ ] Row per repo: CI dot, repo name, branch name, CI label ("no CI reported"), first failing
    check (link ↗) + "+N" (others in tooltip), last commit age / "never synced"
  - [ ] Expanded row: "Trunk CI · daily" day strip (red failing / green passing commits, merged-PR
    line; ⓘ legend), then merged PRs: CI dot, #N (opens in app; grey GitHub link when not synced),
    title, "N commits" (tooltip lists up to 20 commit headlines), author avatar+login, merged age;
    "No merged PRs in the retained window — direct pushes only."
  - [ ] Informational only — never a count, badge or My Turn
- Actions:
  - [ ] Expand/collapse strip
  - [ ] Expand a repo row (fetches trends on expand)
  - [ ] Open a merged PR in the app or on GitHub
  - [ ] Open a failing check on GitHub
- States:
  - [ ] Skeleton while unknown (incl. unresolved workspace)
  - [ ] "Couldn’t load the default branches."
  - [ ] "No default branch has synced yet."
  - [ ] Trends: "Loading trends…" / "Couldn’t load trends" / "No trunk history yet"
- Tests: `e2e/activity-feed.spec.ts` ("the Open PRs trunk strip arrives collapsed, even with a red
  default branch", "Open PRs is headed by the default branches; My turn is not"),
  `test/branchName.test.ts`, `test/prBranchRow.test.ts`

### [ ] Open PR card
- Entry: each PR in Open PRs (List, or inside a ticket stack); click or Enter opens the PR detail tab (`fromActivity`)
- Files: `components/Activity/OpenPrsCards.tsx` (`OpenPrCard`, `ReviewChip`, `ThreadsChip`,
  `MergeChip`, `ClaudeWorkChip`), `PrCardShell.tsx`, `lib/cardTickets.ts`
- Essential info (row + panel must carry all of it):
  - [ ] Title; Draft badge; AI working chip ("<provider> is working on this PR": Reviewing / CI
    check / Story check, pulse); copy GitHub link button
  - [ ] Chips: CI (passing/failing/running), Changes requested (red) / Approved (green), threads
    (thread-state bar + "N untouched" amber / "N open threads" / "N resolved"), merge readiness via
    `mergeVerdict` ("ready to merge", "blocked", "behind", "conflicts", draft warning; detail in tooltip)
  - [ ] Ticket row (List view only, when the PR names tickets): key · title per ticket — opens the
    STORY VIEW (`useOpenStory`) or links to the tracker
  - [ ] Inside a stack: "Also in <KEY>" jumps to that ticket's stack (grows the window to draw it)
  - [ ] Meta: #N · repo · author avatar + name · opened X ago · updated X ago · N files · +A −D ·
    large-PR flag · reach chip ("High · infrastructure", "Medium · 6 code files across 3 directories")
- Actions:
  - [ ] Open PR (row / Enter / Space)
  - [ ] Copy PR link
  - [ ] Open ticket story / tracker link
  - [ ] Jump to another ticket stack
- States:
  - [ ] Merged variant (This Sprint → Merged so far) drops CI/merge chips, shows "Merged" and "merged X ago"
- Tests: `test/prCardShell.test.ts`, `test/cardTickets.test.ts`, `test/ticketLinks.test.ts`,
  `test/largePrFlag.test.ts`, `test/reachModel.test.ts`

### [ ] AI review panel on Open PR cards
- Entry: bottom of each Open PR card when `me.ai.enabled` (whole panel click opens the AI review)
- Files: `components/Activity/ClaudeReviewCell.tsx` (`ClaudeReviewPanel`, `TicketPillsRow`), `lib/claudeReviewCell.ts`
- Essential info:
  - [ ] "AI review" + outcome: Not reviewed / "Reviewed by @x" or "Being reviewed by @x" (team
    claim skip) / Review failed / Starting… / Queued / Reviewing… / verdict pill, "Auto review"
    mark, currency pill ("On latest commit", "N newer"), "reviewed N ago"
  - [ ] Severity pills or "No issues"; "N ignored"; "N threads to fix"
  - [ ] CI check pill ("1 CI failure explained", running)
  - [ ] Ticket pills "<KEY> · N of M met" (tone; warning when changed since)
  - [ ] "Earlier:" N fixed / N settled / N still open
  - [ ] "N of M posted" / "Posted" / "Not posted"
  - [ ] Fix pill ("Fix ready" / running)
  - [ ] Left accent by review tone
- Actions:
  - [ ] Open review
  - [ ] Review / Re-review (head moved) — opens the review when AI is not ready
  - [ ] Open AI Fix tab via the fix pill
  - [ ] Error "Could not start the review."
- States:
  - [ ] Absent without `me.ai.enabled`; merged variant shows ticket pills only
- Tests: `test/claudeReviewColumn.test.ts`, `test/claudeReviewActive.test.ts`,
  `test/claudeReviewFollowUp.test.ts`, `test/ticketReview.test.ts`

### [ ] Open PRs grouped by ticket (ticket stacks)
- Entry: Open PRs → "Group by ticket" (tracker on); while tickets load the list is held, then a
  "Tickets loaded. [Group by ticket]" offer appears
- Files: `components/Activity/OpenPrsCards.tsx` (`TicketStack`, `StackCoverage`, `StoryViewHeader`,
  `StoryCurrencyLine`, `MergedPanel`, `TicketPeopleAndStatus`, `ShowMoreRow`), `lib/openPrsStacks.ts`,
  `lib/openPrsWindow.ts`, `components/Activity/TicketStorySection.tsx`
- Essential info:
  - [ ] Stack header: ticket icon + KEY (opens story view) + title; or "No ticket" (dashed); status
    pill (To do / In progress / Complete or tracker's word), issue type, assignee initials + name or "Unassigned"
  - [ ] Story check coverage pill ("0 of 3 met", tone ok/partial/bad), stale currency label, "reviewed N ago"
  - [ ] Roll-up ("1 failing CI", "1 ready to merge"; red/green) and "N PR" count
  - [ ] "Merged (N)" collapsible panel: merged PRs (title, repo#N, author, merged ago) opening the PR
  - [ ] Windowed list: "N of M PRs" + Show more, auto-loads on scroll (IntersectionObserver), focus
    moves to the first new card
  - [ ] Single-story variant (story view): fuller header, Jira status picker and the Story section —
    pinned by ticketShare/storyView tests
- Actions:
  - [ ] Open the ticket story / tracker
  - [ ] Check story / Re-check (AI ticket_review; "Starting…"; refusal sentence; "Could not start the check.")
  - [ ] Expand Merged (N); open a merged PR
  - [ ] Show more
  - [ ] Group by ticket (release the held list)
- States:
  - [ ] Ticket gate waits (skeletons) until tickets are known; stacks only when worth it (`stacksWorthShowing`)
  - [ ] Check story requires AI ready for ticket_review
- Tests: `test/openPrsStacks.test.ts`, `test/openPrsTicketGate.test.ts`, `test/openPrsWindow.test.ts`,
  `test/ticketShare.test.ts`, `test/storyView.test.ts`, `test/storyHeaderAndSummary.test.ts`,
  `test/ticketStatusPicker.test.ts`, `test/ticketStory.test.ts`

### [ ] Feed filter bar (people vs bots, categories, kinds, state)
- Entry: rail → Feed (`?activityRepo=feed`); also inside a repo console and person-scoped (userIds) mounts
- Files: `components/Activity/FeedView.tsx`, `lib/ui.ts` (`FEED_PR_EVENT_CHIPS`, `DERIVED_STATE_META`),
  `hooks/useConsolidatedFeed.ts`, `store/filters.ts`
- Essential info:
  - [ ] Humans | Bots segmented radio (server-side; never mixed; bots = union hiddenBotUserIds rule;
    hidden on a person's tab where the side follows the person)
  - [ ] Category pills with counts: Comments (review threads + PR comments), PR events, Commits
    (opt-in fetch toggle: off = only pushes that addressed a thread)
  - [ ] "Kind" row under PR events: Opened · Reviewed · Merged · Closed with counts (remembered when the parent is off)
  - [ ] "State" pills: Untouched · Replied · Likely addressed · Resolved, colour dot + count
  - [ ] Count line: "N of M loaded" / "N shown · N loaded of M" · "M most recent of U in window"
- Actions:
  - [ ] Switch Humans/Bots (`feedAuthors`, persisted filter)
  - [ ] Toggle Comments / PR events / Commits (persisted)
  - [ ] Toggle PR-event kinds
  - [ ] Toggle thread-state pills (local state)
- States:
  - [ ] Opening the cross-repo Feed marks it seen (`markFeedSeen`)
- Tests: `test/feedPrEventChips.test.ts`, `test/botReviewerQueryKey.test.ts`,
  `e2e/activity-feed.spec.ts` ("the Feed is the stream alone…", "a Feed link opens the Feed and
  survives a reload", "the legacy My Turn / Feed header pills are removed"), verify-demo "feed"

### [ ] Feed row (one event card)
- Entry: each item in the Feed stream; click opens the PR at the thread / comment / PR
- Files: `components/Activity/FeedView.tsx` (`FeedRowImpl`, `InlineThread`, `PrOpenedExtras`,
  `AffectedThreadsList`), `components/ThreadView/index.tsx`, `components/PrCommentComposer.tsx`
- Essential info:
  - [ ] Header: category icon in the pill's ink, Focus magnifier, "NEW" chip (arrived since you were
    last at the top), relative time (title = full date), avatar, actor name (UserName popover), bot
    vendor tag (`botColor`) with hover "not a bot?", event chip ("Review: Comment", "Review comment",
    PR opened/merged…), "MY TURN" badge + reason pill (yellow card border → new colour rule)
  - [ ] PR ref line: repo · #N title (button) · large-PR flag · reach chip (labelled on pr_opened) · file name
  - [ ] pr_opened: CI label, "N files changed", reach chip, Show/Hide summary (PR description fetched on click)
  - [ ] Markdown body clamped 160px with Show more/less; legacy null PR-comment body hydrated on demand
  - [ ] "Also commented" folded comments
  - [ ] Change summary ("pushed N commits") + affected threads (state dot, file:line, state,
    author: “excerpt”) with "Show N resolved threads"
  - [ ] "Merged by X" · "Reviewed by A, B"
  - [ ] Review-thread cards render the whole conversation inline (ThreadCard: reactions, Reply,
    Resolve, View thread on GitHub, highlighted comment); a resolved thread collapses to "Resolved
    file:line N comments [Show]"
- Actions:
  - [ ] Open PR at the event (row / PR title)
  - [ ] Focus → the PR's isolated timeline tab at this event (`openPrFocusTab` + `focusEventInTab`)
  - [ ] Not a bot? → confirm dialog → workspace-wide judgement (undo in Bots Monitoring › Classification)
  - [ ] Reply to a PR comment (PrCommentComposer pre-filled with a quote + @mention; Cancel)
  - [ ] Reply / Resolve inside the inline thread
  - [ ] Open an affected thread
  - [ ] Show summary / Show more / Show resolved threads
- States:
  - [ ] Inline thread: "Loading conversation…" / "Couldn’t load this conversation."
  - [ ] "Loading summary…", "No description.", "Loading comment…"
- Tests: `e2e/activity-feed.spec.ts` ("flat chronological list (no tiers)", "a My Turn item is
  marked with a yellow-bordered card" — pins the yellow border; update deliberately if the marker
  changes, "clicking a My Turn item opens the PR detail tab", "clicking a plain feed event opens
  the PR detail tab", "the feed has no Done/seen control"), `test/claudeThreadMarker.test.ts`

### [ ] Feed stream states, paging, new-item insertion and single-PR isolation
- Entry: Feed; `?feedPr=<id>` isolates to one PR (also from a repo console), with the "Showing only #N" banner
- Files: `components/Activity/FeedView.tsx`, `FeedIsolationBanner.tsx`, `lib/feedNewCohorts.ts`
- Essential info:
  - [ ] Virtualised list (initial window 12, overscan 800px) with measured row heights
  - [ ] New items spliced in live, each with a "New" chip until seen; no Refresh banner
  - [ ] Isolation banner: "Showing only #N <title>" (or "the selected PR") + Clear; in a repo console
    isolation hides the repo charts and open-PR list
  - [ ] Empty sentences: "Nothing in the last N days. Last synced X ago." (stale >24h), "No bot
    activity on this pull request.", "No bot activity in the last N days.", "Nothing to show yet —
    activity across your repos will appear here.", "Nothing matches these state filters.", "No
    <kinds> PR events in this window.", "No bot activity in this window.", "Nothing in this window."
- Actions:
  - [ ] Auto-load next page on scroll; manual "Load more" fallback ("Loading more…")
  - [ ] Clear isolation
- States:
  - [ ] Loading skeleton (role=status "Loading activity") while workspaceId null or loading; "Loading…" for placeholder data
  - [ ] Back-return scrolls to and flashes the row (up to 12 rAF tries)
- Tests: `test/feedNewCohorts.test.ts`, record-demo-steps "feed", "feed:isolated"
  (`?activityRepo=feed&feedPr=113`), `e2e/activity-feed.spec.ts`

---

## 3. PR detail and the story view

Shots: `/tmp/limn-demo-shots/pr-113-*.png`, `pr-114-*.png`, `pr-105-claude_review.png`, `story-view.png`.

Cross-cutting:

- [ ] URL/store keys survive: `?view=pr-detail:<id>`, `?prTab=overview|comments|changes|bot_activity|claude_review|ai_fix`
  (legacy `activity` → Overview with Activity open; legacy `threads` → Changes), `?pr=<id>&thread=<id>`
  (bottom pane on the Timeline), `pr-focus:<id>`, `?view=ticket:<ident>`, `?sprintStory=<ident>`.
  Store fields: `prDetailTab {prId,tab}`, `selectedPrId`, `selectedThreadId`, `threadStateFilter`,
  `threadSeverityFilter`, `threadBotFilter`, `commentFocus`, `selectedCommentId`, `activityFocus`,
  `claudeTabFocus`, `aiFixTabFocus`, `prChangesFocus`, `feedIsolatedPrId`. Local-only:
  `changesThreadsOnly`, `changesFocus`, `threadOpenMemory`, `activityOpenLocal`, `statusFocus`.
  localStorage: Changes rail width (`RAIL_W_KEY`), diff wrap (`useDiffWrap`), `limn.blastImpactNote.collapsed.v1`.
- [ ] Every tab change goes through `goToTab` / `seedTab` / `openInChanges` / `showThread`; deep-link
  effects use `markUrlCorrection` (replace, not push).
- [ ] Gates: `me.ai.enabled` hides AI Review, AI Fix, Check threads, the impact note and the AI menu
  items. AiRunGate kinds used here: review, fix, plan, resolve, thread_check, review_chat,
  ci_review, ticket_review, story_docs, complete. `me.mlSeverity` controls ML badges and Severity
  pills. `me.conflictResolver` controls the resolver entry. PR permissions: viewerCanPush,
  viewerCanApprove, viewerCanClose, viewerCanReopen. Demo writes/AI runs are simulated by `src/demo`.
- [ ] Mobile debts: Changes file rail hidden below md (`hidden md:flex`) — mobile has no file
  navigation today; resolver stacks panes when narrow (NARROW_PANES); rest is desktop-only (pr-28
  gutter for the pane close button, 112px w-28 label columns in Overview, native selects/checkboxes).
- [x] Sub-12px text: text-[11px] on tab pills, Activity header, check pills, section counts
  (allowed at the floor); text-[10px] on ReviewStateTag and AutomatedReviewerBadge → raised to 11px.

### [ ] PR detail shell: mounts, loading, error, live refresh, mark-viewed
- Entry: bottom DetailPane under the Timeline (click a bar, j/k on the board, `?pr=<id>[&thread=<id>]`),
  resizable, close button (Esc). Full-screen overlay (pinned tab `pr-detail:<id>`) opened by
  `openPrDetailTab` from Pending cards, Open PRs, Feed, Search, This Sprint, story view, Reports and
  Bots drill-downs, AutoMerge/ClaudeReview banners, ReviewPrRefs links, the pane title or the
  pane's open-full-screen button. Pinned-tab chip shows #number, title and author, with close.
- Files: `PrDetail.tsx`, `DetailPane.tsx`, `App.tsx`, `store/pinnedTabs.ts`, `store/filters.ts`,
  `hooks/useUrlState.ts`, `hooks/usePr.ts`, `hooks/usePrLiveRefresh.ts`, `hooks/useKeyboard.ts`, `PinnedTabsBar.tsx`
- Essential info:
  - [ ] Which PR is open (tab label: #number, title, author avatar)
  - [ ] Pane says "Select a PR on the timeline to see its details…" when nothing is selected
  - [ ] Tab label kept fresh on rename (`syncPinnedMeta`)
- Actions:
  - [ ] Close the pane / clear selection (close button or Esc)
  - [ ] Resize the pane height by dragging
  - [ ] Esc returns to the Timeline from an overlay
  - [ ] j/k move the selection on the Timeline board only
  - [ ] "/" focuses search; "i" opens Activity
  - [ ] Opening marks viewed (POST markPrViewed) → invalidates open-prs, timeline, my-turn, me,
    attention-cards, daily-brief, work-plan
  - [ ] Live poll: POST `/api/prs/:id/refresh` ~5s, only while open and visible
- States:
  - [ ] Loading: PrDetailSkeleton
  - [ ] Error or not found: red text with the error or "PR not found"
  - [ ] `placement='pane'` vs `'fullscreen'` is REQUIRED; only the pane shows the clickable title and open-full-screen button
  - [ ] No auto-poll on merged/closed PRs (manual Refresh works)
  - [ ] Selecting a thread deep-links once per selection (`handledThreadRef`)
- Tests: `test/prDetailPlacement.test.ts`, `test/closeTabs.test.ts`, `test/landingTab.test.ts`,
  `test/urlHistory.test.ts`, `test/prCacheSync.test.ts`, `test/prHeaderCi.test.ts`,
  `e2e/activity-feed.spec.ts` (→ pinned-pr-overlay), verify-demo `pr:113|114|105|116:<tab>`,
  record-demo-steps PR_TABS

### [ ] PR header: row 1 (status, CI, title, toolbar icons, chips)
- Entry: top of every PR detail, every tab
- Files: `PrDetail.tsx`, `Activity/BranchStatusChip.tsx` (CiDot), `CopyButton.tsx`, `ShowOnTimeline.tsx`,
  `lib/ui.ts` (`PR_STATE_META`, `prHeaderCi`)
- Essential info:
  - [ ] State badge: Open, Merged, Closed or Draft
  - [ ] CI readout (open PRs only): dot + CI_META word (passing / failing / running / unknown ring), from synced `pr.ciStatus`
  - [ ] "#number Title" (truncates; full title in the button's title attribute in full-screen)
  - [ ] "Stalled" chip: open, no recent commits, open threads
  - [ ] "Auto-merge armed" chip with timer icon (title explains the watcher; cancel from Overview → Actions)
  - [ ] "N new comments · N new reviews · N new commits" chip (eye icon), from `newSinceLastViewed`
  - [ ] Refresh icon amber when stale: "Couldn't refresh from GitHub — showing the last synced state."
- Actions:
  - [ ] Click the CI readout → Overview, scroll to and focus the Status row (`statusFocus` nonce)
  - [ ] Title / external-link icon (pane only) → full-screen in its own tab
  - [ ] Timeline icon: show this PR on the shared timeline (`openPrFocused`)
  - [ ] Magnifier: Focus → isolated timeline tab (`pr-focus:<id>`)
  - [ ] Feed icon: show in Activity feed — switches workspace if needed, then repo console tab,
    activityRepo, feedIsolatedPrId, then `showActivity` (order matters)
  - [ ] Refresh: re-read from GitHub now (spins; disabled while running; shares state with live poll)
  - [ ] Copy the PR's GitHub link
  - [ ] Open on GitHub
  - [ ] "N new …" chip → Overview with Activity open, filtered to events since last view, scrolled to
- States:
  - [ ] CI readout hidden on merged/closed and when `prHeaderCi` returns null
  - [ ] Copy only when `safeExternalUrl` ok
  - [ ] Refresh disabled while refreshing; amber stale variant
- Tests: `test/prHeaderCi.test.ts`, `test/prDetailPlacement.test.ts`, verify-demo `pr:113:overview`

### [ ] PR header: meta line (repo, author, age, size, large-PR flag, blast radius)
- Entry: second header row, every tab
- Files: `PrDetail.tsx`, `Activity/LargePrFlag.tsx`, `Activity/BlastRadiusChip.tsx`,
  `hooks/useLargePr.ts`, `hooks/useBlastRadius.ts`, `UserName.tsx`, `UserProfilePopover.tsx`
- Essential info:
  - [ ] Repository full name (first)
  - [ ] Author avatar and name (UserName popover)
  - [ ] "opened <relative>"
  - [ ] "N files +X −Y" (absent when changedFilesCount is 0)
  - [ ] Large-PR flag (warning icon + short text; accessible name is the full sentence)
  - [ ] Blast radius chip Low/Medium/High, EXPANDABLE here only: the reason list and "Read from the
    diff: real code changes / formatting only / comments only". A null verdict is not drawn
- Actions:
  - [ ] Author → user popover
  - [ ] "N files +X −Y" → Changes
  - [ ] Expand the blast-radius chip
- States:
  - [ ] Large-PR flag renders nothing when unmeasured or under threshold
  - [ ] Blast chip absent when unmeasured
- Tests: `test/prOverviewLayout.test.ts` ("the header meta line is 14px and names the repo before
  the author" — pins `text-sm`; conflicts with the 12/13/15/22 scale, update deliberately),
  `test/themeMetrics.test.ts`, `test/textContrast.test.ts`, `test/vendorInk.test.ts`

### [ ] Impact note ("What could this break?")
- Entry: under the header meta line, only when `me.ai.enabled`, a blast chip exists and Settings → showImpactNote is on
- Files: `Activity/BlastImpactNote.tsx`, `AiSetup.tsx` (AiRunGate complete), `AiStatusLine.tsx`, `hooks/useAnnotations*.ts`
- Essential info:
  - [ ] Verdict: "Flagged on a closer read" (warning, amber) or a plain note
  - [ ] Two-sentence body on what the change could break
  - [ ] "Written by <model>"
  - [ ] "Re-reading the change" status line when stale and running
- Actions:
  - [ ] "What could this break?" (sparkle, AiRunGate complete)
  - [ ] Collapse/expand (localStorage)
  - [ ] Re-run when stale
- States:
  - [ ] Hidden without AI, without a blast chip or with the setting off
  - [ ] Running: AiStatusLine "Reading the change"
  - [ ] Collapsed stub only when a note exists (collapsing never hides the ask button)
  - [ ] No request of its own: reads the shared `['pr-annotations', prId]` index
- Tests: `test/aiStatusAndPrActions.test.ts`, verify-demo `pr:113:overview`

### [ ] PR tab strip
- Entry: below the header; `?prTab=` paired with the PR id
- Files: `PrDetail.tsx` (`TAB_LABELS`, `ReviewTabOutcome`, `effectiveTab`), `store/filters.ts`,
  `hooks/useClaudeReview.ts` (`useClaudeReviewTabPill`), `lib/claudeReviewColumn.ts`
- Essential info:
  - [ ] Order: Overview · Comments · Changes · Bot activity (conditional) · AI Review (me.ai) · AI Fix (me.ai)
  - [ ] Overview: red dot when any non-Limn check is failing/errored ("N failing")
  - [ ] Comments: count of PR comments plus review bodies
  - [ ] Changes: count of changed files
  - [ ] AI Review: outcome pill — verdict in its colour with VerdictIcon, pulsing "running", "failed" with warning, or neutral
  - [ ] Bot activity: red warning when a bot was slower than typical on this PR
- Actions:
  - [ ] Switch tabs (`goToTab` clears a pending Changes focus target)
- States:
  - [ ] Bot activity shows only when the server confirms automated reviewers; stays while loading
    for a reader who arrived on it; falls back to Overview only after the answer (derived)
  - [ ] "activity" is not a tab; it renders Overview with Activity open
  - [ ] AI tabs absent when `me.ai.enabled` is false
- Tests: `test/prOverviewLayout.test.ts`, `test/changesThreads.test.ts`,
  `test/claudeReviewTabPill.test.ts` (pill mounted on the strip: `t === 'claude_review' && reviewPill != null`),
  `test/urlHistory.test.ts`

### [ ] Overview: SAML notice and compact bot-triage card
- Entry: top of Overview
- Files: `ChecksTab.tsx` (authNotice), `BotTriageCard.tsx` (compact)
- Essential info:
  - [ ] SAML SSO notice: "Some data from <org> is hidden…" with links to start an SSO session and to Authorized OAuth Apps
  - [ ] Bot triage line: "N bot comments", then "X real issues" (Claude judged) or "Y awaiting a
    look", then "Z likely addressed" and "W nit-flagged"
- Actions:
  - [ ] "Resolve the N addressed →" / "View threads →" / "Judge the rest →" → Changes Threads only
  - [ ] Follow the SSO links
- States:
  - [ ] Triage card renders nothing below `MIN_BOT_COMMENTS`, no extra query
  - [ ] "real issues" only with stored Claude judgements (me.ai)
  - [ ] SAML notice only when `pr.authNotice.kind === 'saml_sso'`
- Tests: `test/resolvableBotThreads.test.ts`, verify-demo `pr:113:overview`

### [ ] Overview: Status row (CI and merge verdict / merge queue)
- Entry: first Overview row; header CI readout scrolls to and focuses it
- Files: `ChecksTab.tsx`, `lib/ui.ts` (`mergeVerdict`, `MERGE_TONE_CLASS`, `CI_META`), `Activity/pendingLabels.ts` (`pendingQueueBadge`)
- Essential info:
  - [ ] CI dot and label linking to the PR's GitHub Checks tab, plus "· N passed · N failed · N
    running"; "no checks" when unknown (no link)
  - [ ] Open PRs: the merge verdict label in its tone ("ready to merge", "blocked", "behind",
    "conflicts", "draft") + "· detail" (suppressed for conflicts)
  - [ ] Merge queue state replaces the verdict; an ejection shows red with its sentence ("Leaving the merge queue …")
- Actions:
  - [ ] Open the PR Checks page on GitHub
- States:
  - [ ] Verdict and queue only on open PRs
  - [ ] `unstable` is mergeable; `behind` is not
- Tests: `test/mergeBlockers.test.ts`, `test/conflictsRow.test.ts`, `test/pendingCardControls.test.ts`,
  `test/verdictStrictness.test.ts`

### [ ] Overview: Conflicts row and conflict-resolver entry
- Entry: Overview, under Status, when `conflictsRowVisible(state, verdict)`. Other resolver entries:
  MergeControl's conflict box, the Pending conflicts card, AI Fix's ConflictAiCard and the "Also
  resolve merge conflicts with <base>" checkbox
- Files: `ChecksTab.tsx`, `conflicts/ResolveConflictsButton.tsx`, `store/conflictResolver.ts`, `lib/ui.ts`
- Essential info:
  - [ ] The row exists whenever conflicts block the merge, even without push access
  - [ ] "Resolve on GitHub" link (always)
  - [ ] While a Claude conflict run is active: phase label, progress bar "Resolving conflicts with <name>" and Cancel
  - [ ] The last AI run's failure message
- Actions:
  - [ ] "Resolve conflicts" menu: "Resolve manually" opens the resolver; "Resolve with <provider>"
    starts an AI conflict run (AiRunGate resolve). Menu note "You check <name>'s choices before anything is pushed."
  - [ ] Cancel a running AI conflict run
  - [ ] Esc closes the menu
- States:
  - [ ] Button hidden (never disabled) unless viewerCanPush, verdict conflicts, PR open and `me.conflictResolver`
  - [ ] Without me.ai the button opens the resolver directly
  - [ ] A queued conflicting PR gets no button; an armed one does
- Tests: `test/conflictsRow.test.ts`, `test/conflictResolverEntry.test.ts`, `test/claudeConflictPrefill.test.ts`

### [ ] Overview: Auto-merge stopped row and Blocked row
- Files: `ChecksTab.tsx`, `AutoMergeBanner.tsx` (`TERMINAL_LABEL`), `hooks/useAutoMerge.ts` (`usePrStoppedIntent`), `lib/ui.ts`
- Essential info:
  - [ ] Auto-merge row (open PR, stopped intent): warning icon, terminal headline, the watcher's
    lastReason and "· armed <relative>"; persists until the server drops it (24h) or re-armed
  - [ ] Blocked row (verdict blocked): ranked blocker sentences, proven first; certainty not in
    words; unresolved threads never claimed as THE blocker
- Actions:
  - [ ] The "unresolved threads" blocker opens Threads only
- States:
  - [ ] Auto-merge row not on merged/closed PRs, not dismissible
  - [ ] Blocked row only for the blocked verdict
- Tests: `test/mergeBlockers.test.ts`

### [ ] Reviews row (ReviewsChips), shared by Overview and AI Review
- Files: `pr/ReviewsRow.tsx`, `lib/ui.ts` (`REVIEW_STATE_META`, `automatedReviewerMeta`, `vendorInk`)
- Essential info:
  - [ ] One chip per reviewer with server-folded standing (approved, changes requested, commented,
    dismissed): icon, avatar, name; title gives standing and date
  - [ ] Automated reviewer badge with vendor label/colour; Limn adds "· verbatim" or "· curated" (`reviewer-provenance`)
  - [ ] "N reviews from deleted accounts"
  - [ ] "only bots reviewed" warning chip (`only-bots-reviewed`)
- Actions:
  - [ ] Name → user popover
- States:
  - [ ] Hidden when no reviewers (`reviewsRowVisible`)
  - [ ] Uncapped (no "+N")
- Tests: `test/pendingHeadings.test.ts`, `test/prCardShell.test.ts`, `test/vendorInk.test.ts`

### [ ] Overview: Bots row and Bot activity caution row
- Files: `ChecksTab.tsx`, `hooks/useBotTriage.ts` (`usePrBotBehaviour`)
- Essential info:
  - [ ] One chip per review-bot vendor: bot icon, label, "· N" threads and "· M need a look"
    (likely-addressed excluded); title explains the difference from the Blocked count
  - [ ] "<Bot> slower than typical" or "N bots slower than typical — view"
- Actions:
  - [ ] Vendor chip → sets `threadBotFilter` and opens Threads only filtered to that vendor
  - [ ] Slower chip → Bot activity tab
- States:
  - [ ] Bots row only with bot threads
  - [ ] Caution row only with a ttfrAnomaly and a visible Bot activity tab
- Tests: `test/botReviewerQueryKey.test.ts`

### [ ] Actions row: "Show actions" reveal and ApproveControl
- Entry: Overview "Actions" row; AI Review "Reviews and actions" → Actions
- Files: `pr/PrActionsRow.tsx`, `ApproveControl.tsx`, `MentionTextarea.tsx`, `hooks/usePrWrites.ts`
- Essential info:
  - [ ] Closed state still shows the viewer's standing: "You approved" / "You requested changes"
  - [ ] "Merging…" / "Updating the branch…" while in flight (shared mutation keys)
  - [ ] Approved: disabled "Approved" chip ("Your approval stands") beside "Withdraw approval"
  - [ ] Changes requested: a "Changes requested" chip
- Actions:
  - [ ] "Show actions" / "Hide actions" — never remembered; every mount starts closed (facts never hide)
  - [ ] "Approve" approves at once — NEW key `a` where an approve is allowed
  - [ ] "Approve with comment" → markdown box with @-mentions; Approve disabled until text
  - [ ] "Request changes" → optional box; blank sends "Changes requested."
  - [ ] "Withdraw approval" → "Withdraw your approval?" → "Yes, withdraw" / Cancel
  - [ ] Cancel any open panel
- States:
  - [ ] Visible only when `prActionsVisible` (viewerCanApprove, or viewerCanPush+open+not draft, or
    viewerCanClose+open+not armed, or viewerCanReopen+closed)
  - [ ] Approve controls only when viewerCanApprove (author excluded)
  - [ ] Busy labels "Approving…", "Sending…", "Withdrawing…"
  - [ ] Errors: GitHub's refusal as written, or "GitHub did not accept the review." / "GitHub did not withdraw the approval."
- Tests: `test/aiStatusAndPrActions.test.ts`, `test/prWriteCascadeGuard.test.ts`,
  `test/mergeControlQueued.test.ts`, record-demo-steps clicks "Show actions"

### [ ] MergeControl (merge methods, merge queue, update branch, armed panel, conflict box)
- Entry: Actions row after "Show actions", when viewerCanPush, open and not draft
- Files: `MergeControl.tsx`, `hooks/usePrWrites.ts`, `hooks/useMergeQueueStatus.ts`, `lib/ui.ts`
- Essential info:
  - [ ] Queued (synced facts): queue status line ("In the merge queue · position N · running checks · ~12 min"); red when ejected
  - [ ] Expanded: live verdict label and "— detail"
  - [ ] "This PR conflicts with <baseRef>." box with ResolveConflictsButton and "Resolve on GitHub"
  - [ ] "N commits behind <baseRef>."
  - [ ] Armed panel: "Auto-merge armed · <method or via the merge queue> · armed <relative>",
    lastReason or "Waiting for the blockers to clear.", "Limn merges it while the app is running…",
    "A new commit on the branch disarms it…", "Expires <date>"
- Actions:
  - [ ] "Merge ▾" fetches merge options on click, never on mount
  - [ ] Pick a method (Create a merge commit / Squash and merge / Rebase and merge) then Merge
    (disabled when it cannot merge now; title explains) — the native select becomes the custom Select
  - [ ] "Add to merge queue" (replaces Merge on a queue branch)
  - [ ] "Remove from queue"
  - [ ] "Update branch" with strategy ("Rebase onto <base>" / "Merge <base> in")
  - [ ] "Cancel auto-merge"
  - [ ] Cancel (collapses, resets mutations)
- States:
  - [ ] "Checking merge status…"
  - [ ] "Couldn't load merge status." with Close
  - [ ] Busy: "Merging…", "Queueing…", "Removing…", "Updating…", "Cancelling…"
  - [ ] Errors: "Failed to merge the PR.", "Failed to update the branch.", "Merge-queue action failed.", "Failed to change auto-merge."
- Tests: `test/mergeControlQueued.test.ts`, `test/pendingCardControls.test.ts`,
  `test/prWriteCascadeGuard.test.ts`, record-demo-steps clicks `/^(Merge|Merge when ready)$/`

### [ ] MergeWhenReadyControl (arm or cancel auto-merge)
- Files: `MergeWhenReadyControl.tsx`, `hooks/useAutoMerge.ts`
- Essential info:
  - [ ] Armed: timer chip "Armed — merging when ready" / "Armed — queueing when ready" / "In the merge queue" (full explanation in title)
  - [ ] `ARMED_BY_POLICY_LABEL` when armed by the dependency policy
  - [ ] Confirm contract line "Updates from trunk if needed and merges when checks pass — while Limn is running." (or queue variant)
  - [ ] "Nothing to arm." when not eligible (explanatory title)
- Actions:
  - [ ] "Merge when ready" (idle) asks GitHub for live merge state ("Checking merge state…")
  - [ ] "Merge when ready" / "Queue when ready" → confirm; title adds "Right now: <first blocker>"
  - [ ] "Arm auto-merge" / Cancel
  - [ ] "Cancel auto-merge" / "Cancel & dequeue"
- States:
  - [ ] Hidden when queued by GitHub or when eager and ineligible
  - [ ] "Arming…" / "Cancelling…"; errors "Failed to arm auto-merge." / "Failed to cancel auto-merge."
- Tests: `test/mergeControlQueued.test.ts`

### [ ] Close PR and Reopen PR
- Files: `ClosePrControl.tsx`, `ReopenPrControl.tsx`
- Essential info:
  - [ ] Close confirm: "Close PR" / Cancel (title says reversible on GitHub)
- Actions:
  - [ ] Close → "Close PR" (confirm)
  - [ ] Reopen
- States:
  - [ ] "Closing…" / "Reopening…"; errors "Failed to close the PR." / "Couldn't reopen the PR."
  - [ ] Close hidden while auto-merge is armed
- Tests: `test/prWriteCascadeGuard.test.ts`

### [ ] Overview: Merged by, Ticket/Branch, Summary, Checks, Labels, Requested, Suggested reviewers, Meta
- Files: `ChecksTab.tsx` (`PrTicketBranchLine`, `PrBranchLine`, `PrTicketChip`, `PrSummary`,
  `ChecksSummary`, `SuggestedReviewersRow`), `CheckList.tsx` (`ChecksList`, `CheckRow`,
  `CiRerunControl`), `hooks/usePr.ts`, `hooks/useTicketRefs.ts`, `lib/ticketTab.ts`
- Essential info:
  - [ ] Merged by: avatar, name, merge date and time
  - [ ] Ticket row: key chips (key → story; external icon → tracker) or "No ticket found"; "Branch"
    caption; head branch mono, "→ base", copy button. Labelled "Branch" when no tracker
  - [ ] Summary: PR description markdown, clamped to 3 lines, tall images hidden
  - [ ] Checks: one collapsed line with pills ("all N passed" / "N passed", "N failing", "N running") and "N checks"
  - [ ] Per check: state disc, name (links to workflow run or checks tab), "Limn" tag on a
    Limn-posted status ("Not CI"), logs toggle
  - [ ] Log viewer: line count and bytes ("… of total"), "Load earlier" (also on scroll up), GitHub
    link, "(empty log)", reason when unavailable
  - [ ] Labels: GitHub label colour dot and name
  - [ ] Requested: requested users and teams (@team)
  - [ ] Suggested: user or team chip, reason text, "Assign" / "Requested"
  - [ ] Meta: repo, "opened <rel>", "updated <rel>"
- Actions:
  - [ ] Open the story / tracker from a ticket chip
  - [ ] Remove a manually added ticket
  - [ ] Copy the branch name
  - [ ] Show more / less on the summary
  - [ ] Expand checks; open a check; show/hide the job log; load earlier chunks
  - [ ] "Re-run failed jobs" / "Re-run all jobs" (viewerCanPush, Actions runs only); "Re-run
    requested — CI updates on the next sync." + count of runs that could not be re-run
  - [ ] "Assign" a suggested reviewer (viewerCanPush only)
- States:
  - [ ] Tickets tri-state: null = no tracker (Branch), [] = "No ticket found", list = chips
  - [ ] Suggested reviewers keep the last seen list (LRU 50), hide already-requested
  - [ ] Log errors "Couldn't load logs." / reason; "Loading logs…"
  - [ ] Rerun errors and "Requesting…"
  - [ ] Assign error "Couldn't request the reviewer."; "Assigning…"
- Tests: `test/prBranchRow.test.ts`, `test/prOverviewLayout.test.ts`, `test/ciReview.test.ts`,
  `e2e/pending-assign-reviewer.spec.ts`, record-demo-steps clicks `pr-checks-summary` and "View log|Show log"

### [ ] Overview: Activity section (collapsed event list)
- Entry: foot of Overview, collapsed by default; opened by its header, `?prTab=activity`, the
  timeline commit popover (`activityFocus`) or the header's "N new" chip
- Files: `PrDetail.tsx` (`ActivitySection`, `ActivityList`, `buildActivity`)
- Essential info:
  - [ ] Header "ACTIVITY" and "N events"
  - [ ] Rows newest first: opened, each commit (7-char SHA link + copy full hash), each review
    ("reviewed (state)"), each comment, merged/closed; avatar, actor, label, first line, relative time (full date in title)
  - [ ] "Showing N since you last looked" with "Show all"
- Actions:
  - [ ] Expand / collapse
  - [ ] Per row: show on this PR's own timeline (ShowOnTimeline → pr-focus) and open on GitHub
  - [ ] Copy the commit hash
  - [ ] "Show all" clears the since-filter
  - [ ] A deep link scrolls to the row and flashes it (activity-flash, 1.8s)
- Tests: `test/prOverviewLayout.test.ts`, record-demo-steps clicks `pr-activity-section`

### [ ] Comments tab (conversation and composer)
- Entry: `?prTab=comments`; a timeline pr_comment popover ("Open in detail pane") or a Pending mention seeds `commentFocus`
- Files: `PrDetail.tsx` (`PrCommentsList`, `ReviewStateTag`), `PrCommentComposer.tsx`,
  `ReactionBar.tsx`, `MlSeverityBadge.tsx`, `LimnSeverityChip.tsx`, `ThreadView/NewCommentHighlight.tsx`
- Essential info:
  - [ ] Issue comments and review bodies merged, oldest first
  - [ ] Per item: avatar, author, review-state tag ("approved", "changes requested", "review",
    "dismissed", "pending"), relative time (full date title), "new" tag since last view
  - [ ] Limn severity chip and ML severity badge (`me.mlSeverity`)
  - [ ] Markdown body
  - [ ] Emoji reactions (fetched on demand, never stored)
  - [ ] Permanent amber border for the selected comment; flash on a deep link
- Actions:
  - [ ] Show on timeline per item
  - [ ] Copy the body
  - [ ] React / remove a reaction ("Add a reaction")
  - [ ] Reply → inline composer pre-filled with a quote
  - [ ] "View comment on GitHub" / "View review on GitHub"
  - [ ] Bottom composer "Add a comment to this PR (markdown, @ to mention)…" → Comment ("Commenting…")
- States:
  - [ ] Empty: "No PR comments on this PR."
  - [ ] Composer error "Failed to post the comment."; visible:false with a comment id → "it'll show up shortly", no retry
  - [ ] ML badge hidden when ML is off
- Tests: `test/mlSeverityBadge.test.ts`, verify-demo `pr:<id>:comments`

### [ ] Changes tab: sticky bar, file tree rail and diff
- Entry: `?prTab=changes`, header "N files", AI Review finding anchors ("Show in Changes"), a
  thread "Show in context", design-grid cards, `prChangesFocus` deep links
- Files: `ChangesTab.tsx`, `diff/FileTree.tsx`, `diff/FileDiffView.tsx`, `diff/status.ts`,
  `FileTypeIcons.tsx`, `ThreadList/ThreadCountChips.tsx`, `hooks/useResizablePane.ts`, `hooks/useResolveEvents.ts`
- Essential info:
  - [ ] Sticky bar: "Threads only N" toggle (aria-pressed), thread-state count chips, "Wrap lines"
    checkbox (code view only), "Files changed ↗" GitHub link. No file delta (deliberate)
  - [ ] Rail: changed files in their directory tree (single-child chains collapsed), file/folder
    type icons, status icons, +/− per file or folder, per-file thread-state counts, selected file. No file-count threshold
  - [ ] File block header: collapse chevron, status icon, file-type icon, path (rename shows old
    path), copy path, thread count chips, +/−, GitHub link
  - [ ] Diff rows: old and new gutters, add/del/hunk tints, syntax highlighting, wrap
  - [ ] Lockfiles, missing patches and large patches start collapsed
  - [ ] Inline thread pills: state colour bar or check icon, Claude pills, Limn severity chip,
    "outdated" / "line not in this diff", (shut only) author, age, reply count, excerpt;
    approximate line noted ("may be a few lines off")
  - [ ] Gap expanders: up, down, unfold-all (click-gated reads)
  - [ ] No-patch notes: "over 1 MB", "Binary file", "isn't on GitHub at either commit", "GitHub didn't send this diff…"
  - [ ] Focus-missing banner "… It may be in the files not loaded yet / outside this PR's changed files." + GitHub link
  - [ ] Truncated list: "Load next 100 files (N of M)", "GitHub lists at most 3,000 files.", "All on GitHub"
- Actions:
  - [ ] Toggle Threads only
  - [ ] Toggle wrap (persisted)
  - [ ] Rail file → scroll to it (in Threads only: list that file's threads; again for all)
  - [ ] Resize the rail (drag or ←/→, Shift×4, Home/End, Enter resets; double-click resets; persisted)
  - [ ] Collapse / expand a file
  - [ ] Copy a path; open a file on GitHub
  - [ ] "+" on a line ("Comment on this line") → inline composer: Send ("Posting…"), "Posted on
    GitHub. It couldn't be loaded back just now — it'll show up here shortly."
  - [ ] Open / shut an inline thread pill (remembered per thread id; resolve events shut it)
  - [ ] Expand gap lines; "Load full diff"
  - [ ] Load the next 100 files
- States:
  - [ ] Empty "No file changes on this PR."; loading "Loading diff…"
  - [ ] No patches: "The full diff couldn't be loaded — showing the changed-file list." or "Inline
    diffs aren't available…", with metadata rows (path link and copy)
  - [ ] Code stays mounted (hidden) under Threads only
  - [ ] Rail hidden below md — mobile needs file navigation (a sheet or menu)
  - [ ] Gap load states: Loading…, Couldn't load these lines., too large, binary, missing, moved
- Tests: `test/changesThreads.test.ts` (sticky bar `sticky top-0 z-30`, aria-pressed, no file
  delta; `threadsOnly ? 'hidden' : 'min-w-0 flex-1'`; the resolve bus), `test/fileTree.test.ts`,
  `test/inlineThreadOpen.test.ts`, `test/threadsByPath.test.ts`, `test/anchorLineFromHunk.test.ts`,
  `test/lockFile.test.ts`, `test/codeTokens.test.ts`, verify-demo `pr:<id>:changes`

### [ ] Changes → Threads only view (threads, filters, bulk resolve, Check threads)
- Entry: "Threads only" toggle; Overview Bots chips (`threadBotFilter`); Blocked "unresolved
  threads"; bot-triage links; resolvable-bot-thread presets (`openPrThreadsFiltered`); a selected
  thread whose file left the diff; Pending/Feed/timeline thread links (`showThread`, the ONE landing)
- Files: `PrDetail.tsx` (`renderThreads`, `showThread`, `openInChangesFor`), `BotTriageCard.tsx`
  (full), `CheckThreadsButton.tsx`, `ThreadList/index.tsx`, `ThreadList/FileGroup.tsx`,
  `ThreadList/resolvable.ts`, `ThreadView/ThreadCard.tsx`, `ThreadView/CommentBlock.tsx`,
  `ThreadView/CodeAnchor.tsx`, `ThreadView/ReplyComposer.tsx`, `ThreadView/ResolveThread.tsx`,
  `ThreadView/ClaudeThreadBadge.tsx`, `lib/threadCollapse.ts`, `lib/claudeThreadMarker.ts`
- Essential info:
  - [ ] "Threads on <file>" header with "All files" when narrowed by the rail
  - [ ] Full bot-triage card (counts plus the exact list to resolve)
  - [ ] Filter header: State pills (colour dot, description in title), "AI judged", Clear; Severity
    pills (only with ML labels); active vendor chip with "N threads" and "Show all threads"
  - [ ] "Resolve N addressed" (vendor-scoped) and result "Resolved N · M failed."
  - [ ] Bot dedup box "Multiple bots flagged the same line(s)", vendor chips, "both/all flagged
    :line", "bots agree" / "bots disagree here"
  - [ ] Threads grouped by file with collapsible resolved threads
  - [ ] ThreadCard: state pill with confidence (likely_addressed stays fuzzy), Limn severity, worst
    ML severity, show on timeline, path:line, "· outdated", Claude's reason line (validity and state
    pills, "The pull request has new commits since."), code anchor hunk with "Show the full code
    context", each comment (avatar, name, time, new tag, ML badge, copy, reactions)
- Actions:
  - [ ] Check threads (AiRunGate thread_check): "Checking N threads", "Waiting for a free slot", refusals
  - [ ] Toggle state / AI judged / severity filters; Clear
  - [ ] Clear the vendor filter
  - [ ] Bulk resolve addressed bot threads with confirm ("Resolve N likely-addressed threads on GitHub?" → "Yes, resolve" / Cancel)
  - [ ] Cycle through a dedup cluster's threads
  - [ ] Per thread: "Show in context" / "Show in context ~" / "Show file", Resolve / Unresolve,
    reply ("Reply to this thread…" → Send), "View thread on GitHub" / "Reply on GitHub", show on
    timeline, copy a comment, react, expand the code context
- States:
  - [ ] Empty: "No review threads on this PR.", "No threads from this bot on this PR.", "No threads
    in the selected state(s).", "No threads on this file."
  - [ ] `threadStateFilter` / `threadSeverityFilter` apply only when `selectedPrId === prId`
  - [ ] Severity pills hidden with no ML labels; disabled at zero
  - [ ] Check threads hidden without me.ai or without threads
- Tests: `test/changesThreads.test.ts`, `test/aiStatusAndPrActions.test.ts`,
  `test/resolvableBotThreads.test.ts`, `test/claudeThreadMarker.test.ts`,
  `test/claudeReviewThreads.test.ts`, verify-demo `pr:113|105:changes-threads` (expects "Threads only", "Show in context")

### [ ] Bot activity tab
- Entry: "Bot activity" tab (only with confirmed automated reviewers); Overview "slower than typical — view"
- Files: `PrBotBehaviourTab.tsx`, `hooks/useBotTriage.ts`
- Essential info:
  - [ ] Per bot: label, vendor chip, "first touch <rel>", red anomaly flag when slower than typical
  - [ ] Stats: Time to first review, Follow-ups, Comments, Touches (warn colour when anomalous)
  - [ ] Evidence line: "building baseline" / "within typical (X)" / "slower than typical — usually
    X", "· from ready-for-review|opened", "· N follow-ups vs M typical (more than usual)", "· baseline: N PRs"
  - [ ] Touch timeline chips (review/comment icons, "×N" runs, absolute date range in title) and "+N more touches"
- Actions:
  - [ ] ⓘ "Bot activity"
- States:
  - [ ] Error "Couldn't load bot behaviour for this PR."
  - [ ] Lazy-loaded (Suspense "Loading…")
- Tests: record-demo-steps PR_TABS includes bot_activity

### [ ] AI Review: "Reviews and actions" section
- Entry: top of AI Review (`?prTab=claude_review`); also from ClaudeReviewBanner "Ready — open it"
  (`claudeTabFocus`), the Open PRs review column and AI Fix "Open AI Review"
- Files: `ClaudeReviewTab.tsx` (`PrReviewActionsSection`, `TopRow`, `GenerateFixButton`),
  `pr/ReviewsRow.tsx`, `pr/PrActionsRow.tsx`, `ReviewSection.tsx`
- Essential info:
  - [ ] Same Reviews chips and Actions controls as Overview
  - [ ] Fix row (latest succeeded run, me.ai): "Generate fix from this review →" with ⓘ (nothing pushed until Push)
- Actions:
  - [ ] Everything in the Actions row
  - [ ] "Generate fix from this review" (`openAiFixFromReview`)
- States:
  - [ ] Renders nothing when no row has content
- Tests: `test/mergeControlQueued.test.ts`, verify-demo `pr:113:claude_review`

### [ ] AI Review: "Run a review" section
- Files: `ClaudeReviewTab.tsx`, `ModelPicker.tsx`, `AiSetup.tsx` (AiRunGate review), `AiStatusLine.tsx`,
  `TeamClaimLine.tsx`, `RepliesCheckLine.tsx`, `ReviewHistoryList.tsx`, `lib/aiBudget.ts`, `hooks/useClaudeReview.ts`
- Essential info:
  - [ ] Model menu (aria-label "Model"; every ready provider and model, e.g. "Claude Opus 5.5 (most
    thorough)", value `codex:gpt-6.1-sol`) — becomes the custom Select; verify-demo selects by value
  - [ ] AiRunGate meter ("Limn: 2% of your week · limit 5%"; US$ on API key, % on subscription), or the setup/sign-in line
  - [ ] "Auto review running" / "Auto review queued" / auto-review waiting label
  - [ ] "This commit is already reviewed." confirm
  - [ ] Auto-fix outcome line; team-claim line ("Your auto review didn't finish…" and Clear)
  - [ ] Running: progress bar, AiStatusLine stage and clock, "Auto review", "<Depth> review",
    progress message, tokens out/in/cache with "~cost", live activity log
  - [ ] Failed: the error or "The review failed."; failed auto run "Auto review failed: <reason>" with Retry; cancelled note
  - [ ] Replies line: "Check replies" state ("Checking replies", "Every reply already has a judgement.", …)
  - [ ] "Showing" history select: every run, labelled provider, model, effort, head, date, trigger
- Actions:
  - [ ] Pick a model
  - [ ] "Run review" / "Re-review" (highlighted when behind the head), "Run anyway" or Cancel
  - [ ] Stop a running review
  - [ ] Retry a failed auto review (AiRunGate review, meter off)
  - [ ] Clear a pending team claim
  - [ ] Check replies (AiRunGate thread_check)
  - [ ] Pick a past run to view it read-only
- States:
  - [ ] Tab hidden when `!me.ai.enabled`; tab empty when `data.enabled === false`
  - [ ] Run disabled while running, starting or an auto run is held
  - [ ] Error "Failed to start review." (except auto-hold errors)
  - [ ] History select only with more than one run
- Tests: `test/perRunModelPicker.test.ts`, `test/aiGating.test.ts`, `test/aiProviderCopy.test.ts`,
  `test/teamClaims.test.ts`, `test/repliesCheck.test.ts`, `test/claudeReviewReplies.test.ts`,
  `test/reviewPair.test.ts`, verify-demo `pr:105:claude_review` (selects `codex:gpt-6.1-sol` in
  "Model"; "Showing" lists "Codex · GPT-6.1 Sol · high" and "Claude Opus 5.5 · high"),
  record-demo-steps `pr:105:review-history`

### [ ] AI Review: "<Provider>'s review" section (verdict, currency, summary)
- Files: `ClaudeReviewTab.tsx` (`ClaudesReview`, `VerdictBadge`, `CurrencyPill`, `metaLine`,
  `UsageBreakdown`), `ReviewedAgo.tsx`, `InfoModal.tsx`, `lib/claudeReviewFollowUp.ts`
- Essential info:
  - [ ] Title "<By>'s review" or "<By> review" for a pair
  - [ ] Pills: verdict, currency ("On latest commit · cb59021" or behind), "reviewed <rel>", "Auto
    review", fresh label, "Replies check", "<Mode> review"
  - [ ] Meta line: head SHA · model · effort · share of the week or US$
  - [ ] Not-approved reason line (auto verdict)
  - [ ] Failed half of a pair
  - [ ] "Also read: <repo> @ <branch>"
  - [ ] Follow-up sentence ("Last review's 4 comments: 2 addressed, 2 not addressed.")
  - [ ] Summary markdown with PR references linked
- Actions:
  - [ ] ⓘ: how the pair worked, usage breakdown, turns, "The diff was too large to send whole…", "Left out as noise: N files"
- States:
  - [ ] Historic run is read-only (no Post, no edits)
- Tests: `test/claudeReviewFollowUp.test.ts`, `test/verdictStrictness.test.ts`, `test/autoPost.test.ts`,
  verify-demo `pr:113:claude_review` (expects "Also read: acme/infrastructure @ PLAT-292-upsert-transaction-boundaries")

### [ ] AI Review: Previous review (follow-up) section
- Files: `ClaudeReviewFollowUp.tsx` (`ClaudeReviewFollowUpSection`, `FollowUpRow`, `ReplyBlock`, `SettledEarlierRow`)
- Essential info:
  - [ ] Prior head SHA; pills counting each status; "N settled earlier"
  - [ ] Per row: status or reply heading, severity word, title, code anchor (path:line → Changes),
    explanation, resolved-pushback marker
  - [ ] Draft reply ("Draft reply: …") and posted state ("Reply posted.", "Replied and resolved.", "Resolved.")
  - [ ] Left-out sentence (previous findings not checked, and why)
- Actions:
  - [ ] Show in Changes from the anchor
  - [ ] "Post reply", "Reply and resolve", "Resolve"
  - [ ] Jump to the re-raised finding
  - [ ] Expand the closed or settled list
- States:
  - [ ] Hidden when there is nothing to follow up
- Tests: `test/claudeReviewFollowUp.test.ts`, `test/claudeReviewReplies.test.ts`

### [ ] AI Review: Review threads section
- Files: `ClaudeReviewThreads.tsx`, `CheckThreadsButton.tsx`
- Essential info:
  - [ ] Thread rows with Claude's current judgement (validity and code-state pills, reason), folded
    from the latest review plus later Check threads runs
  - [ ] Counts; "No other review threads."
- Actions:
  - [ ] Open a thread (`showThread` on Changes)
  - [ ] "Show N more" / "Show fewer"
  - [ ] Check threads (AiRunGate thread_check) on the latest run only
- States:
  - [ ] A historic run shows its own stored assessments
- Tests: `test/claudeReviewThreads.test.ts`, `test/aiStatusAndPrActions.test.ts`

### [ ] AI Review: Findings section (FindingRow)
- Files: `ClaudeReviewTab.tsx` (`FindingRow`, `FindingHunk`, `SuggestionBlock`, `CopyAllFindingsButton`),
  `ClaudeReviewChat.tsx` (`SendToChatButton`), `DocReferences.tsx` (`DocCitationLinks`)
- Essential info:
  - [ ] "N findings"; "N more under Story check"
  - [ ] Per finding: severity, title, lens label, pair source chip, story chip ("BMD-1040 · AC2"),
    "Raised in the previous review", already-posted chip, posted chip linking to GitHub, reminder
    chip, auto-resolve label, reworded marker, unanchored note
  - [ ] path:line link (Show in Changes, or GitHub blob permalink at the reviewed SHA), the hunk, a
    suggestion block, the markdown body, doc citations
  - [ ] Ignored findings collapsed
- Actions:
  - [ ] "Copy all findings"
  - [ ] "Post as comment" / "Post as PR comment", "Post reminder", "Reword" / "Edit wording", Copy,
    "Send to chat", Ignore / restore, Show / Collapse for ignored
- States:
  - [ ] "No line-level findings." / "None outside Story check."
  - [ ] Per-finding posting and error state ("Failed to post comment")
  - [ ] Read-only for historic runs and the fix picker
- Tests: `test/findingsMarkdown.test.ts`, `test/reviewPrRefs.test.ts`, `test/docQuoteMatch.test.ts`,
  `e2e/docs-quote-highlight.spec.ts`

### [ ] AI Review: Story check section (TicketCoverageSection)
- Files: `TicketCoverage.tsx`, `TicketPasteBox.tsx`, `ClaudeReviewFollowUp.tsx` (`ClaudeReviewTicketPanel`,
  `AcFieldPicker`, `ClaudeReviewTicketResults`), `TicketReviewParts.tsx`, `hooks/useTicketReview.ts`
- Essential info:
  - [ ] Per ticket: currency, criteria met or not with evidence, missing items ("Belongs in <PR>"),
    "Not asked for (N)", "Checked on this PR only"
  - [ ] Slim share for a tracker ticket with a story to link to
  - [ ] "N new comments" on the ticket (`ticket-new-comments`)
  - [ ] Story-finding cards placed here
  - [ ] Stories to check: add by key or URL, or paste; "Pull <key> from <tracker>" / "Pull all";
    criteria-field picker ("Criteria from:"); remove a story
- Actions:
  - [ ] "Check this story" / "Check N stories" / "Re-check" (AiRunGate ticket_review)
  - [ ] Post story gaps ("Posted" / "Already posted")
  - [ ] Open the story view
  - [ ] Add, pull or remove stories; change the AC field
- States:
  - [ ] "Not checked yet.", "No result stored.", "No criteria are this PR's.", "Loading…", "Could
    not load the story checks.", "Could not start the check.", "The check failed."
  - [ ] Hidden without me.ai
- Tests: `test/ticketShare.test.ts`, `test/ticketReview.test.ts`, `test/jiraTicket.test.ts`, `test/ticketStory.test.ts`

### [ ] AI Review: CI check section
- Files: `CiCheckSection.tsx`, `ClaudeReviewCiFailures.tsx`
- Essential info:
  - [ ] Currency pill; per failing check: cause, "Fix: …", "Not from this change", "Not checked"
  - [ ] "Posted to the PR automatically."; "From an earlier AI review of this commit."; "Checks
    outside GitHub Actions have no log to read, so they are listed only."
- Actions:
  - [ ] Run the CI check (AiRunGate ci_review); ⓘ "CI check"
  - [ ] Show in Changes
- States:
  - [ ] "Not checked yet.", "Could not load the CI check.", "Could not start the check.", "The check failed."
  - [ ] Hidden without me.ai
- Tests: `test/claudeReviewCi.test.ts`, `test/ciReview.test.ts`

### [ ] AI Review: SonarCloud, Reference docs, Design diagrams
- Files: `ClaudeReviewSonar.tsx`, `DocReferences.tsx`, `ClaudeReviewDiagrams.tsx`, `DesignGrid.tsx`
- Essential info:
  - [ ] Sonar: quality gate pill, new-code measures, issue rows (Code smell / Vulnerability /
    Security hotspot; where; "Why it matters"; "How to fix"), post state ("Posted automatically", "Posting failed: …")
  - [ ] Reference docs: passages labelled Supports / Contradicts / Context, with a "Reference:" link
  - [ ] Design: grid for this PR and for the whole story; "Drawn for an earlier commit."
- Actions:
  - [ ] "Post SonarCloud findings", Refresh
  - [ ] Open a doc link
  - [ ] Design card → its file in Changes (or the member PR's file); Draw / Redraw ("Drawing…")
- States:
  - [ ] Sonar: "No open issues on this commit.", "Not read for this commit yet.", "SonarCloud could
    not be read.", "Reading…"; absent with no SonarCloud
  - [ ] Docs: "Nothing in the library bears on this change."; absent when the library was not read
  - [ ] Diagrams absent without me.ai
- Tests: `test/docQuoteMatch.test.ts`, `e2e/mock-api.ts` (`/sonar`, `/sequence-diagrams`)

### [ ] AI Review: Review chat
- Files: `ClaudeReviewChat.tsx` (`ReviewChatSection`, `ReviewChatThread`, `EarlierChats`, `SendToChatButton`)
- Essential info:
  - [ ] Pinned items ("In chat", "Items sent"); explanation cards (What it means, Why it matters, What would fix it)
  - [ ] "Answers are about the reviewed commit; the PR has moved on."
  - [ ] Earlier chats per run ("No earlier review of this PR has a chat.")
- Actions:
  - [ ] "Ask <provider> about this review" / "Ask about this finding" (AiRunGate review_chat)
  - [ ] Remove a pinned item
  - [ ] Collapse / expand
  - [ ] Open earlier chats
- States:
  - [ ] "Answering…", "Answering another question…", "Loading…", "Could not load this conversation.", "Could not load earlier chats."
- Tests: `test/perRunModelPicker.test.ts`

### [ ] AI Review: Post to GitHub
- Files: `ClaudeReviewTab.tsx` (`PostReviewPreviewPanel`), `lib/claudeAutoReview.ts`
- Essential info:
  - [ ] Pill "Posted automatically · <rel>" or "Posted <date>"
  - [ ] Auto-post failure, skip, verdict and lift lines
  - [ ] Preview: exactly the body and every inline and PR comment that would be sent
  - [ ] Result "Posted review #N · N inline comments", "Plus N PR comments."
- Actions:
  - [ ] Summary textarea (MentionTextarea; saves on blur)
  - [ ] "Save draft"
  - [ ] Verdict select (Comment, Request changes, Approve)
  - [ ] Preview (dry run)
  - [ ] "Post to GitHub" → "Post as <verdict>?" → "Confirm post" / Cancel
  - [ ] ⓘ Post to GitHub
- States:
  - [ ] "Failed to post review to GitHub."; posting spinner
- Tests: `test/claudeReviewTabPill.test.ts`, `test/autoPost.test.ts`

### [ ] AI Fix tab (picker, plan first, run, result, push, history)
- Entry: `?prTab=ai_fix`, "Generate fix from this review" (`aiFixTabFocus`), AiFixBanner rows
- Files: `AiFixTab.tsx`, `AiFix/FixPicker.tsx`, `AiFix/fixPickerModel.ts`, `AiFix/PlanPanel.tsx`,
  `AiFix/FixReport.tsx`, `AiFix/ConflictAiCard.tsx`, `AiFixBanner.tsx`, `ModelPicker.tsx`
- Essential info:
  - [ ] ⓘ AI Fix: no shell, builds and tests nothing; what is ticked by default; Plan first; nothing pushed until Push
  - [ ] ConflictAiCard when resolvable ("Resolve merge conflicts with <name>", AiRunGate resolve, "Run again")
  - [ ] Without a review: "A fix starts from a finished AI review." (or "… One is running.") and "Open AI Review"
  - [ ] Picker sections: <By>'s findings, Earlier findings still open, Threads <By> says need a fix,
    Unanswered threads, CI failures, SonarCloud issues, Style bot comments, Ticket gaps; "Won't
    fit"; "The review found nothing to fix."; older-review note
  - [ ] "N items" / "Nothing ticked."
  - [ ] Plan panel: bullets, details, revision and model, transcript, "Not in the plan", "Will not fix", "Built from your plan"
  - [ ] Running: progress bar "Running AI fix", phase, "Auto fix" chip, last 8 activity lines
  - [ ] Result: source line, run label (provider, model, effort), time, auto-push failure, summary,
    FixReport (per-file changes, "Not addressed", "Left out"), "N files changed · Not built or tested here.", the diff (wrap)
  - [ ] Push: commit message, target (PR branch with headRef, or new branch plus PR), pushed card (branch, "PR #N", time)
  - [ ] "Earlier fixes pushed" history
- Actions:
  - [ ] "New fix"
  - [ ] Tick / untick items, "Tick all" / "Untick all"
  - [ ] "Also resolve merge conflicts with <base>" checkbox
  - [ ] Pick a model
  - [ ] "Plan first" checkbox
  - [ ] "Start fix" / "Make a plan" (AiRunGate fix)
  - [ ] Cancel a run; Close
  - [ ] Plan: send a change message (Cmd/Ctrl+Enter; AiRunGate plan), approve and build (AiRunGate fix), discard
  - [ ] Push: radio PR branch or new branch, branch name input, "Push" / "Push + open PR"
- States:
  - [ ] Tab hidden without me.ai; "The agentic fixer is turned off." when `data.enabled` is false
  - [ ] Errors: plan failed, "The fix run failed: …", "The fix run was cancelled.", "The plan was discarded.", start errors, push errors
  - [ ] "You need write access to push this fix." when !viewerCanPush; same-branch radio disabled
    for a fork ("The PR head is a fork you cannot push to — use a new branch")
  - [ ] "No files changed."
  - [ ] Plan message too long: "Keep it under N characters."
- Tests: `test/fixPicker.test.ts`, `test/aiFixModelDefault.test.ts`, `test/perRunModelPicker.test.ts`,
  `test/aiGating.test.ts`, verify-demo `pr:113|114:ai_fix`

### [ ] Conflict resolver overlay
- Entry: ResolveConflictsButton → "Resolve manually" (Overview Conflicts row, MergeControl
  conflict box, Pending conflicts card) or a "Resolve with <provider>" run. Mounted once at App root
- Files: `conflicts/ConflictResolverOverlay.tsx`, `ResolverToolbar.tsx`, `ResolverPanes.tsx`,
  `FileMenu.tsx`, `SlotStrip.tsx`, `SlotRow.tsx`, `RegionRibbons.tsx`, `RegionEditPanel.tsx`,
  `OutstandingPopover.tsx`, `BasePopover.tsx`, `LandingStep.tsx`, `CommitResultPanel.tsx`,
  `CloseResolverConfirm.tsx`, `ClosedResolverToast.tsx`, `ClaudeResolutionBanner.tsx`, `copy.ts`
  (all under `components/conflicts/`), `store/conflictResolver.ts`
- Essential info:
  - [ ] Three panes (your version, result, base version) with ink/wash classes for change, conflict, applied, ignored
  - [ ] File menu with decided counts ("N of M files"), Prev / Next file, "Next file that needs
    decisions" (blocked: "Decide every change in this file first")
  - [ ] "Take your file" / "Take <base>'s file"; "Take the obvious ones" (the wand never picks a side); "Merge base" compare; Undo
  - [ ] Per region: take yours or theirs, swap order, ignore, undo, edit (opaque editId)
  - [ ] Unsupported / truncated notices ("N files need resolving on GitHub."); "The window is too
    narrow for three columns, so the versions are stacked."
  - [ ] Claude resolution banner (a run the reader started)
  - [ ] Landing step: what goes in, still conflicted / still to decide, PARTIAL_COMMIT_NOTE, "How to
    land it" (merge or rebase), "Where to put it" (push to the branch, a new branch, "Open a pull
    request for it"), pinned on <head>/<base>, AUTO_MERGE_ARMED warning
  - [ ] Commit progress (preparing, fetching, merging, committing, pushing, confirming) and the result panel
- Actions:
  - [ ] Every decision above; edit a region; Commit & push / Rebase & force-push (hard-blocked until
    every decidable region is decided, `CommitPlan.canCommit`)
  - [ ] Close (confirm "Close the conflict resolver?"); a toast after closing
- States:
  - [ ] Sessions pinned to (headSha, baseSha, modelHash); `CONFLICT_MODEL_VERSION`
  - [ ] Narrow layout stacks the panes
- Tests: `test/resolverControls.test.ts`, `test/mergeResolver.test.ts`,
  `test/conflictResolverEntry.test.ts`, `test/claudeConflictPrefill.test.ts`

### [ ] Story view (ticket tab) and the sprint story tray
- Entry: ticket chip keys (Overview Ticket row, Pending and Open PRs cards, This Sprint) via
  `useOpenStory` → pinned tab `ticket:<ident>` (`?view=ticket:<ident>`). This Sprint's tray
  (`?sprintStory=<ident>`) draws the same StoryViewBody. Tab label "<KEY> · Story" with close
- Files: `lib/ticketTab.ts`, `Ticket/TicketTabView.tsx`, `Ticket/StoryViewBody.tsx`,
  `Ticket/TicketStatusPicker.tsx`, `Activity/OpenPrsCards.tsx` (StoryViewHeader, StoryCurrencyLine,
  TicketPeopleAndStatus, TicketStack), `Activity/TicketStorySection.tsx`,
  `Activity/StoryDocsAlignment.tsx`, `Activity/StoryDesignSection.tsx`, `TicketStory.tsx`,
  `TicketComments.tsx`, `TicketReviewParts.tsx`, `TrackerLinkOut.tsx`, `lib/ticketStory.ts`, `lib/storyDocsAlignment.ts`
- Essential info:
  - [ ] Header: key with tracker link-out, title, people and status (TicketStatusPicker "Status: X.
    Change status"), coverage label, rollup pills, currency line ("N PRs changed since" naming one
    PR, "N new comments since this check", wait reason)
  - [ ] Story section (h4 "Story", actions in the heading): ticket review result (summary, criteria
    with evidence and docs notes, missing items, Not asked for, references) or the brief ("Summary
    and criteria", "Show all N criteria", "Worked out from the description", "No acceptance
    criteria.") or "Reading this ticket…"
  - [ ] "What each PR adds" member cards (summary, Interfaces (N), Loose ends (N))
  - [ ] Docs check block: verdicts, "What to do", "Other parts of the story", the criteria checked,
    "Nothing in the reference docs bears on this story.", "Nothing has changed since this check."
  - [ ] Story design ("Story design" with ⓘ)
  - [ ] "As written in <tracker>" disclosure: ticket text, AC field ("Criteria from:" + Change),
    "Comments (N)" (Automation app hidden)
  - [ ] PR cards for open PRs, "Merged (n)" panel, "Closed without merging (N)" (repo#number, closed <rel>)
  - [ ] "No pull requests for this ticket yet." / "N pull requests in other workspaces." / "Showing the latest pull requests only."
- Actions:
  - [ ] Change the Jira status (the ONE tracker write: list, pick, arrow keys)
  - [ ] "Check story" / "Re-check" (aiReadyFor ticket_review)
  - [ ] "Check against the docs" / "Check docs again" / "Check again anyway" (AiRunGate story_docs)
  - [ ] "Draw design" / "Redraw design" / "Drawing design…" (needs two or more member PRs)
  - [ ] Open a PR (`openPrDetailTab`, fromActivity)
  - [ ] Expand "As written", comments and the closed list
  - [ ] Change the AC field ("Saving…")
  - [ ] Post story gaps
- States:
  - [ ] Loading skeleton ("Loading the story"); "Couldn't load this story."; "This ticket isn't on this workspace's tracker."
  - [ ] Nothing renders while workspaceId is null
  - [ ] Docs and design actions hidden without me.ai
  - [ ] Status picker: loading, error, no permission (`TICKET_STATUS_NO_PERMISSION`), "Jira offers no other status from here."
- Tests: `test/ticketShare.test.ts` (structural: `>Story</h4>` heading; StoryDocsButton,
  StoryDesignButton, StoryDesignSection exact JSX; TicketResults and BriefSummary props; no collapse
  toggles; TicketStorySection under `{single && t?.ident != null && (`), `test/storyView.test.ts`,
  `test/storyHeaderAndSummary.test.ts`, `test/storyDocsAlignment.test.ts`, `test/ticketTab.test.ts`,
  `test/ticketStory.test.ts`, `test/jiraTicket.test.ts`, verify-demo `ticket:PLAT-292`,
  `ticket:PLAT-292:comments`, `ticket:PLAT-301`, `ticket:PLAT-301:docs-reuse`, `ticket:INFRA-260`,
  `ticket:notion:WEB-34`, `sprint:tray`

### [ ] Global banners that deep-link into PR detail
- Entry: the App-level toast strip (ClaudeReviewBanner, AiFixBanner, AutoMergeBanner)
- Files: `ClaudeReviewBanner.tsx`, `AiFixBanner.tsx`, `AutoMergeBanner.tsx`, `HeaderToasts.tsx`
- Essential info:
  - [ ] Review progress per PR (Starting, Cloning, Deciding scope, Fetching diff, Reviewing, Saving findings, "Ready — open it")
  - [ ] AI Fix per PR: Working…, "Fix ready", "Plan ready", "The fix did not finish/start", Cancelled
  - [ ] Auto-merge armed count ("Merge when ready · 1 armed") and terminal outcomes (`TERMINAL_LABEL`)
- Actions:
  - [ ] Open the review (`claudeTabFocus` → AI Review tab)
  - [ ] Open the AI Fix tab; dismiss
  - [ ] Open the armed PR
- States:
  - [ ] Per page load, not polled in a background tab (which is why the Overview Auto-merge row exists)
- Tests: `scripts/verify-demo.mjs` (banner visible in every pr-* screenshot)

---

## 4. This Sprint, Timeline, Reports, Bots Monitoring, Docs, Settings

### [ ] This Sprint tab shell (sub-tab strip)
- Entry: fixed tab "This Sprint", `?view=sprint`; `?sprintTab=themes|paths|people|merged` (invalid
  or retired "graph" → Theme, derived). Legacy: `?activityRepo=sprint`, `?insightsTab=sprint|merged`
- Files: `Sprint/SprintTabView.tsx`, `Activity/sprintRailModel.ts`, `store/filters.ts`
  (`sprintInnerTab`, `SPRINT_INNER_TABS`), `hooks/useUrlState.ts`, `PinnedTabsBar.tsx`
- Essential info:
  - [ ] Page title "This Sprint"
  - [ ] Sub-tabs in order: Theme (landing), Critical path, People, Merged so far
- Actions:
  - [ ] Switch sub-tab (role=tab)
  - [ ] Scroll position remembered per sub-tab (`useRememberedScroll` key `sprint:<tab>`)
  - [ ] Back/Forward restore the sub-tab
- States:
  - [ ] Every sub-tab available on every tier
- Tests: `test/landingTab.test.ts`, `test/urlHistory.test.ts`, `e2e/activity-feed.spec.ts` ("This
  Sprint is a fixed tab beside Activity, opening on Theme…", legacy link), verify-demo
  `sprint:themes|paths|people|merged`, `ws2:sprint` (expects "Web Sprint 9")

### [ ] Sprint page toolbar and page-level states (SprintView)
- Entry: Theme, Critical path or People
- Files: `Activity/SprintView.tsx`, `Activity/SprintProgressBar.tsx`, `Activity/sprintPathsModel.ts`,
  `AiStatusLine.tsx`, `hooks/useSprintStories.ts`, `lib/sprintChangeToken.ts`
- Essential info:
  - [ ] Sprint title from the tracker source (`sprintSourceTitle`), else "This sprint"
  - [ ] ⓘ "Reading this sprint"
  - [ ] Sprint dates line "Oct 21 – Nov 3 · day 9 of 14" (`sprint-dates`)
  - [ ] Ticket count "16 tickets"
  - [ ] "Reading the sprint…" while the first read runs
  - [ ] Thin progress bar (busy / awaiting read / briefs / paths writing)
  - [ ] After Refresh, a 10s note: "Checking N tickets against their pull requests." or "Ticket
    checks need <provider> set up first." (`sprint-checks-note`)
  - [ ] Tracker read error text
  - [ ] Truncation lines: "Showing the first <SPRINT_TICKETS_MAX> tickets."; Critical path only
    "Showing <SPRINT_GHOST_MAX> tickets outside the sprint."
  - [ ] One AI status line, one pass at a time: "Summarising tickets" (N of M), "Grouping tickets
    into themes", "Working out the critical paths"
- Actions:
  - [ ] "Ask <provider>" toggle (aria-pressed); only when useSprintAiOn and data.aiEnabled
  - [ ] "Statuses" (gear) toggle → SprintStatusSettings inline
  - [ ] "Refresh": reads the sprint now, starts up to 3 ticket checks; disabled while reading; icon
    spins; polls 2.5s up to 90s until read.checkedAt moves
  - [ ] Automatic re-fetch: change token polled every minute while mounted and visible
- States:
  - [ ] isError "Could not load this sprint."
  - [ ] Loading / workspaceId null "Loading…"
  - [ ] No tracker → SprintTrackerSetup replaces the board
  - [ ] Zero tickets "No tickets in this sprint." (unless a read is running)
  - [ ] Viewing stamps `sprint_reads.viewed_at` (lets the worker read)
  - [ ] A ticket shows its story in the tray through `StoryOpenOverride.Provider`
- Tests: `test/sprintPathsModel.test.ts`, `test/sprintChangeToken.test.ts`, `test/aiProviderCopy.test.ts`,
  `test/aiStatusAndPrActions.test.ts`, `test/storyView.test.ts`, `e2e/mock-api.ts` sprint-graph fixtures, verify-demo sprint:*

### [ ] Sprint board filters (Has PRs / Needs code)
- Files: `Activity/SprintBoards.tsx` (`SprintBoardFilters`, `NoMatch`), `store/sprintBoardFilter.ts`, `lib/laneBoard.ts`
- Essential info:
  - [ ] Two toggle chips "Has PRs" and "Needs code" (aria-pressed)
  - [ ] ⓘ "Filters" (Needs code explained differently with AI on / off)
  - [ ] "N of M tickets" (`sprint-filter-count`)
  - [ ] "Not judged yet" beside an unjudged card's key under Needs code; reason in tooltip
- Actions:
  - [ ] Toggle Has PRs
  - [ ] Toggle Needs code (both may be on)
- States:
  - [ ] "No tickets match these filters."
- Tests: `test/laneBoard.test.ts`, `test/sprintModel.test.ts`

### [ ] Theme view (lane board by theme)
- Files: `Activity/SprintBoards.tsx` (`SprintThemesView`), `LaneBoard.tsx`, `lib/laneBoard.ts`, `TicketCard.tsx`
- Essential info:
  - [ ] One lane per theme, "No theme" last (or one "all tickets" lane)
  - [ ] Lane header: theme name, PR count, the AI's one-sentence summary, Limn's tickets-by-column line + open/merged PR count
  - [ ] Colour bar per lane by column; hover/focus key (`lane-progress` / `lane-code`, "Each part is as wide as its share of the row's N tickets.")
  - [ ] Rows ordered by PR count; No theme last
  - [ ] Columns = status buckets with counts; Complete columns collapse to a count
  - [ ] Card borders key (BorderKey: On a critical path, Waiting on another ticket, On a path and
    waiting, Outside the sprint, Has a pull request dot)
  - [ ] Dependency arrows, numbered where labelled; numbers keyed under the board
- Actions:
  - [ ] Card → story in the tray (`?sprintStory=`)
  - [ ] Card corner arrow → story tab
  - [ ] Show/Hide a collapsed column
  - [ ] A lane's "n tickets" in a collapsed column opens that cell only
  - [ ] Hover/focus an arrow or number → popover explaining the dependency
- States:
  - [ ] No themes: "Themes appear after <provider> reads the sprint." / "AI is off here, so the sprint has no themes."
  - [ ] Filtered empty
- Tests: `test/laneBoard.test.ts`, `test/sprintModel.test.ts`, `test/storyView.test.ts`, verify-demo sprint:themes

### [ ] Critical path view (pace, paths, call-outs, count table)
- Files: `Activity/SprintBoards.tsx` (`SprintPathsView`, `PaceStrip`, `PathsInfo`, `Callouts`,
  `CountTableView`), `Activity/sprintPathsModel.ts`, `lib/laneBoard.ts`, `AiRunLabel.tsx`, `AiSetup.tsx` (AiRunGate sprint_paths)
- Essential info:
  - [ ] Pace strip (`sprint-pace`): "Time used: Day X of Y" + bar, "Code merged: n of m", "Product
    review: n of m" (only with that bucket), "Complete: n of m", "Open dependencies"
  - [ ] "Critical paths" heading, or "No critical paths in this sprint."; ⓘ
  - [ ] Model that wrote the paths (AiRunLabel) and "Updating"
  - [ ] One lane per path, riskiest first: risk word chip, path title, PR count, one sentence of advice
  - [ ] Messages: writing in progress, "AI is off here, so there are no critical paths.", failed-pass note naming the provider
  - [ ] Call-outs (AI first, then Limn's): "Since you last looked", "Out of step", "Blocked outside the sprint" — label, title, sentence, ticket-key buttons
  - [ ] Table "Every ticket, by theme and column" (`sprint-count-table`) with totals
  - [ ] `data-state` carries pathsStatus.state
- Actions:
  - [ ] Card → tray; corner arrow → story tab
  - [ ] Call-out key → that story in the tray
  - [ ] Column / cell toggles
  - [ ] Arrow popovers
  - [ ] AiRunGate line when no path and no credential
- States:
  - [ ] view.kind paths | message | off | none
  - [ ] Filtered empty
  - [ ] Gated on me.ai.enabled and the sprint_paths credential
- Tests: `test/sprintPathsModel.test.ts`, `test/laneBoard.test.ts`, verify-demo sprint:paths

### [ ] People view (lane board by assignee)
- Files: `Activity/SprintBoards.tsx` (`SprintPeopleView`), `lib/laneBoard.ts`
- Essential info:
  - [ ] One lane per assignee, "Unassigned" last, by PR count
  - [ ] Lane header: name, "N tickets · M PRs · K reviews waiting"
  - [ ] Colour bar with hover key
  - [ ] Cards show the THEME in the person slot
  - [ ] An arrow between two people's rows is a hand-off
- Actions: same as Theme view
- States: filtered empty
- Tests: `test/laneBoard.test.ts`, `test/peopleRosterScope.test.ts`, verify-demo sprint:people

### [ ] Ticket card (shared by all three sprint views)
- Files: `TicketCard.tsx`, `lib/laneBoard.ts`, `LaneBoard.tsx`
- Essential info:
  - [ ] Ticket key mono, violet dot when it has an open or merged PR (those sit first)
  - [ ] Title over two lines, reserved; "Not read" when missing
  - [ ] Brief one-line summary (full in title and accessible name)
  - [ ] Criteria line "3 of 4 criteria met" / "4 criteria"; italic when older than the PRs' latest change; "being checked" marker
  - [ ] Tags: "CI failing", "No PR" or "n PRs · m open", "No owner"
  - [ ] Bottom-right pill: assignee ("Unassigned") or theme (People)
  - [ ] Border meaning (solid accent = critical path, dashed = waiting, faint dashed tinted = outside sprint), also in the accessible name
  - [ ] Needs-code judgement + reason as tooltip
  - [ ] Selection ring for the card open in the tray
- Actions:
  - [ ] Click → tray (aria-controls the tray)
  - [ ] Corner arrow "Open story tab"
- States:
  - [ ] Ghost styling; "Not judged yet" marker
- Tests: `test/storyView.test.ts`, `test/laneBoard.test.ts`, `test/textContrast.test.ts`

### [ ] No-tracker state (SprintTrackerSetup)
- Files: `Sprint/SprintTrackerSetup.tsx`
- Essential info:
  - [ ] "Connect Jira, Linear or GitHub Issues to see this sprint."
  - [ ] ⓘ "Setting up an issue tracker"
- Actions:
  - [ ] "Set up in Settings" → `openSettings('issue-tracker')`
- States:
  - [ ] Keeps `data-testid sprint-view`

### [ ] Merged so far
- Entry: `?sprintTab=merged`; needs no tracker
- Files: `Activity/MergedPrsView.tsx`, `Activity/OpenPrsCards.tsx` (merged variant), `Activity/reportingWindowText.ts`
- Essential info:
  - [ ] Header: the reporting window in words with dates, "N pull requests merged"
  - [ ] Same cards and ticket stacks as Open PRs, plus "No ticket" stack
  - [ ] "Showing the latest N merges in this window; earlier ones are not listed." when capped
- Actions:
  - [ ] Repo dropdown narrowing client-side (its own state)
  - [ ] Group by ticket / List (shared with Open PRs)
  - [ ] Open a PR; open a ticket's story
- States:
  - [ ] Loading / error via OpenPrsCards
  - [ ] Empty: "No merged PRs for the selected repos — adjust the repo filter." / "No pull requests
    merged <window phrase>." / "No pull requests merged in this window."
- Tests: `e2e/mock-api.ts` `/api/merged-prs`, verify-demo sprint:merged

### [ ] Ask <provider> about this sprint (SprintAskPanel)
- Files: `Activity/SprintAskPanel.tsx`, `TicketRefLink.tsx`, `lib/aiBudget.ts`
- Essential info:
  - [ ] Panel "Ask <provider> about this sprint" with ⓘ (remembers earlier questions; gone on leaving)
  - [ ] Example "For example: what is blocking the work in review?"
  - [ ] Each answer: provider and run cost (US$ on API key, share of week on subscription)
  - [ ] Ticket keys in an answer open that story in the tray (sprint's own keys only)
- Actions:
  - [ ] Type a question ("Your question", placeholder "Ask about this sprint")
  - [ ] Send (AiRunGate complete; disabled while asking or empty)
  - [ ] Close (×)
  - [ ] Click a ticket key
- States:
  - [ ] Asking state; gated on me.ai.enabled and data.aiEnabled
  - [ ] A completed answer survives closing mid-answer
- Tests: `test/aiGating.test.ts`, `test/aiStatusAndPrActions.test.ts`

### [ ] Statuses (sprint status buckets editor)
- Files: `Activity/SprintStatusSettings.tsx`, `Activity/sprintModel.ts`
- Essential info:
  - [ ] "Statuses · <source>" with ⓘ
  - [ ] "Coding begins: <status> · Coding ends: <status>" (`sprint-coding-bounds`)
  - [ ] Each bucket: editable name, meaning (Not started, In progress, Code review, Product review, Complete), statuses with ticket counts
  - [ ] Server validation problem in its own words
  - [ ] "Save keeps 60 statuses at most, so it leaves out …"
  - [ ] Review-rule checkbox; "Add a bucket meaning Product review to use this." when none
  - [ ] Polite live region announcing moves
- Actions:
  - [ ] Drag a status (native drag) within or across buckets, incl. an empty one
  - [ ] Move up / Move down per status
  - [ ] Move a bucket earlier/later; delete; rename; set meaning (select)
  - [ ] Add a bucket
  - [ ] Toggle the merge rule
  - [ ] "Save statuses" ("Saving…"), Cancel, "Reset to automatic"
- States:
  - [ ] "No statuses read yet."; draft until Save; only when `data.statusLayout` exists
- Tests: `test/sprintModel.test.ts`

### [ ] Sprint story tray
- Entry: card, call-out key or ticket key in an Ask answer; `?sprintStory=<ident>` (navigation key: Back closes it)
- Files: `Sprint/SprintStoryTray.tsx`, `Ticket/StoryViewBody.tsx`, `lib/ticketTab.ts`
- Essential info:
  - [ ] Ticket key in the tray header
  - [ ] The story body (same as the story tab)
- Actions:
  - [ ] "Open story tab"
  - [ ] Close (×), Escape (capture; focus returns to the card)
  - [ ] Resize from the left edge (drag, arrows, Home or double-click resets; width in localStorage)
- States:
  - [ ] Wide: sticky column beside the board; below lg: sheet over the right — on phones a full-screen sheet
  - [ ] Nothing fetches until a ticket is clicked
- Tests: `test/storyView.test.ts`, verify-demo sprint:tray

### [ ] Story view (ticket tab) body, incl. the Story section
- See § 3 "Story view (ticket tab) and the sprint story tray" — one checklist covers both. Extra
  entries here: Reports → Stories ticket names; `?view=ticket:notion:<url>#WEB-34`.
- Tests: `test/storyTabs.test.ts` in addition to § 3's list

### [ ] Timeline board (vis-timeline)
- Entry: fixed tab "Timeline" (`?view=timeline`) with `?preset=`/`?from`/`?to` and filter keys;
  bar click sets `?pr=`. Keys j/k, Esc, /
- Files: `Timeline/index.tsx`, `Timeline/prBar.ts`, `Timeline/userRow.ts`, `Timeline/lanes.ts`,
  `Timeline/clustering.ts`, `Timeline/eventMarker.ts`, `Timeline/markerTemplate.ts`,
  `hooks/useTimeline.ts`, `hooks/useKeyboard.ts`, `App.tsx`, `index.css` (`.tl-repo-tint-N`,
  `.pr-bar`, `.tl-cross-connectors`, `.tl-repo-sticky`)
- Essential info:
  - [ ] Repo groups with two-colour zebra tint, sticky repo-name header over the label gutter
  - [ ] Contributor rows: avatar, name, maintainer shield, collapse caret
  - [ ] PR bars sized by real time span, leading CI dot on open PRs, "#num · author · title";
    stalled bars orange; open bars run to now
  - [ ] Bar tooltip: CI, merge-verdict warning, thread-state breakdown, "stalled", large-PR flag,
    blast-radius level with every reason (incl. Low)
  - [ ] Event markers per kind and +N cluster badges per kind
  - [ ] Current-time line with padded margins
  - [ ] Skeleton while loading
- Actions:
  - [ ] Bar click: select (detail pane, `?pr=`)
  - [ ] Marker / cluster click → MarkerPopover
  - [ ] Double-click bar/marker/cluster → PR-focus tab (`openPrFocusTab`)
  - [ ] Empty-canvas click dismisses one level at a time
  - [ ] Contributor name → UserProfilePopover
  - [ ] Collapse / expand a contributor row
  - [ ] Cmd/Ctrl + wheel zoom; drag to pan; re-clusters on zoom
  - [ ] j/k next/previous PR; Esc clears selection
- States:
  - [ ] TimelineSkeleton; error text; "No activity in this window. Add a repo or widen the date range."
  - [ ] Bots hidden by default (union hiddenBotUserIds) unless Exclude bots is unchecked
  - [ ] Vertical scroll gated (`setVisScrollTop`); content anchor across a rebuild
  - [ ] Mobile: the board must remain usable (pan/zoom by touch) or offer a clear alternative — never a broken canvas
- Tests: `test/isolateFilter.test.ts`, `test/memberSections.test.ts`, `test/peopleRosterScope.test.ts`,
  `test/urlHistory.test.ts`, `test/filterStorageMigration.test.ts`, `test/largePrFlag.test.ts`,
  `test/claudeThreadMarker.test.ts`, `e2e/activity-feed.spec.ts`, `e2e/cluster-back-nav.mjs`,
  `e2e/selection-glow.mjs`, `e2e/focus-retained-on-reopen.mjs`, `scripts/ui-smoke.mjs`,
  `e2e/mock-api.ts` `/api/timeline`, verify-demo timeline

### [ ] Timeline marker popover, user popover and bottom detail pane
- Files: `Timeline/MarkerPopover.tsx`, `UserProfilePopover.tsx`, `DetailPane.tsx`, `App.tsx`
- Essential info:
  - [ ] Popover: event(s), actor, "on <owner>'s #<n> <title>", time, body or verdict; expanded cluster lists
  - [ ] Marker glow, linked PR glow, rows focused (combined context overlay)
  - [ ] Detail pane: the selected PR's PrDetail, or a hint
- Actions:
  - [ ] "Open in detail pane", "Show this commit in the PR's Activity tab", "Open commit on GitHub"
    / comment URL (`safeExternalUrl`), prev/next through a cluster, drag by the grip, Close
  - [ ] Detail pane: resize; "Clear selection (Esc)"
- States:
  - [ ] In a PR-focus tab, clicking an event highlights it and opens its popover without leaving focus
- Tests: `test/prDetailPlacement.test.ts`, `test/claudeThreadMarker.test.ts`

### [ ] FilterBar (workspace scope + Timeline-only filters)
- See § 1 Workspace selector, Global search, FilterBar: Timeline-only board filters and PR Focus-only
  controls. Extra details:
  - [ ] Repos panel: "Last sync failed" marker, "Show every repo in this workspace", isolate-one
  - [ ] Members panel: section per repo (repeated across repos), "Other" group, maintainer shield,
    "Select every maintainer", select/clear per repo, "Exclude bots", stale checkbox
  - [ ] Status: Draft, Merged, Closed, "Show stale PRs", reset
  - [ ] Events: Commits, Reviews (Approved, Changes requested, Commented, Dismissed, Pending), Review comments, reset
  - [ ] Bots on/off toggle (BotIcon)
  - [ ] Threads: thread-state filter with clear
  - [ ] Range chips 7d, 14d, 30d, 90d, custom from/to; "Now" keeps zoom; "Clear filters"
  - [ ] Panels close on Escape; Members query idles on a Focus tab
- Tests: `test/memberSections.test.ts`, `test/filterStorageMigration.test.ts`,
  `test/switchWorkspaceToOpenPrs.test.ts`, `test/workspaceOpenPrsScope.test.ts`, `test/isolateFilter.test.ts`

### [ ] Tab strip and PR focus tabs (PinnedTabsBar)
- See § 1 tab strip surfaces. Extra:
  - [ ] PR-focus tab: its own isolated Timeline fitted to the PR, cross-person connectors, hour-free zoom floor
  - [ ] "Tab actions" menu (as well as right-click): Close this / other / all
  - [ ] ShowOnTimeline (magnifier or "Timeline view" link on threads and comments): opens the PR's
    focus tab and highlights the event, or centres it on the shared board
  - [ ] Closing every dynamic tab lands on Activity
- Tests: `test/closeTabs.test.ts`, `test/isolateFilter.test.ts`, `test/urlHistory.test.ts`, `e2e/activity-feed.spec.ts`

### [ ] Reports shell (Overview · Chronology · Stories)
- Entry: rail "Reports" (`?activityRepo=insights`; store value stays `'insights'`);
  `?insightsTab=overview|bottlenecks|stories` ("bottlenecks" labelled Chronology); `?reportGrain=`, `?report=`
- Files: `Activity/InsightsView.tsx`, `Activity/index.tsx`, `store/filters.ts`
- Essential info:
  - [ ] Title "Reports"
  - [ ] Sub-tabs Overview, Chronology, Stories (derived)
  - [ ] Covers the whole workspace; the repo picker does not apply
- Actions:
  - [ ] Switch sub-tab
- States:
  - [ ] No measurable history: "Nothing to measure in this Workspace yet." / "Flow metrics appear
    once this workspace has merged pull requests to measure." (Period reports still render)
- Tests: `test/urlHistory.test.ts`, `test/landingTab.test.ts`, `test/periodReportUrl.test.ts`,
  `e2e/activity-feed.spec.ts`, verify-demo reports:overview, reports:bottlenecks, reports:stories,
  reports:month, ws2:chronology

### [ ] Reports → Overview: flow metrics tiles and trend charts
- Files: `Activity/WorkspaceFlowMetrics.tsx`, `Activity/WorkspaceMetricsPanel.tsx`,
  `charts/LineChart.tsx`, `charts/BarChart.tsx`, `charts/ChartPopover.tsx`, `charts/common.tsx`,
  `hooks/useRepoWorkspaceMetrics.ts`, `hooks/useWorkspaceInsights.ts`
- Essential info:
  - [ ] "Flow metrics" with ⓘ
  - [ ] Window group named after the reporting window. Tiles with delta vs prior (coloured by
    direction, dropped on low confidence): Merged, Time to merge, Time to first review, Checks green
    at merge, Time to fix red checks
  - [ ] "Right now": "Open pull requests" (drafts not counted) and "Red checks now" (red when above
    zero, "red for ~X (median)" or "all green")
  - [ ] Charts: "Reviews and comments per merged pull request" (People and Bots), "Pull requests
    opened and merged" (weekly), "Time to fix red checks", "Failing checks" (12 weeks)
  - [ ] "More charts": Time to merge, Checks green at merge, Changes requested, Review coverage
    (Human-reviewed, Bot-only, Unreviewed), Rework after review (ⓘ), Time to resolve threads
    (Human-resolved, Bot self-resolved; ⓘ), Time from review request to first review
  - [ ] "12-week trend" label (labelled exception to the reporting window)
  - [ ] Chart empty labels ("No CI recoveries yet — accrues from sync")
- Actions:
  - [ ] Tile → metrics-detail drill-down tab
  - [ ] Open pull requests tile → Activity → Open PRs (every repo)
  - [ ] Red checks now tile → drill-down at ci_red
  - [ ] Expand "More charts"
  - [ ] Hover or pin a chart point (ChartPopover)
- States:
  - [ ] Self-hides with no metrics or no repos; idle while workspaceId null
  - [ ] "Nothing to measure…" empty card
- Tests: `test/reportingWindowLabels.test.ts`, `test/activePopover.test.ts`, verify-demo reports:overview

### [ ] Reports → Overview: "Where the work is happening" (repo rows + reach)
- Files: `Activity/WorkspaceRepoActivityCharts.tsx`, `Activity/WorkspaceReachCard.tsx`,
  `Activity/reachModel.ts`, `charts/RepoRows.tsx`
- Essential info:
  - [ ] "Activity by repository" (ⓘ): row per repo: full name, People/Automation segment bar,
    Lines changed bar; each column its own scale with max printed; "size unknown" never zero
  - [ ] "Reach by repository" (ⓘ): merged PRs by Low/Medium/High; unmeasured stated as a count;
    disclosure of what the cap left out; levels follow Settings → Blast radius
- Actions:
  - [ ] Hover for row detail
- States:
  - [ ] Self-hides when nothing was opened in the window; absent on an older server response
- Tests: `test/repoActivityChart.test.ts`, `test/reachModel.test.ts`

### [ ] Flow metrics drill-down tab (metrics-detail)
- Files: `Activity/MetricsDetail.tsx`, `Activity/sortableTable.tsx`, `hooks/useWorkspaceMetricsDetail.ts`
- Essential info:
  - [ ] Title "Flow metrics", ⓘ
  - [ ] Sub-tab per metric: Merged, Time to merge, Time to first review, Checks green at merge, Time to fix red checks, Red checks now
  - [ ] Population line per tab
  - [ ] Columns: PR, metric value, CI, diff size, author, Reviewers / Merged by / Opened, updated
- Actions:
  - [ ] Switch metric
  - [ ] Sort any column
  - [ ] "Longest first" / "Fastest first" (localStorage)
  - [ ] Row → PR detail tab
- States:
  - [ ] "Couldn’t load the metric detail."; loading
- Mobile: a wide table must scroll inside its own box, never the page

### [ ] Reports → Overview: Period reports
- Files: `Activity/PeriodReportsPanel.tsx`, `Activity/periodReportMarkdown.ts`,
  `Activity/PeriodMetricSpark.tsx`, `Activity/RegenProgressBar.tsx`, `hooks/usePeriodReports.ts`
- Essential info:
  - [ ] Grain switch Sprint / Month
  - [ ] Period chips (last 8) + "Earlier…" select; archived reports ("Older than the period grid reaches back")
  - [ ] Title: date range (sprint) or month name; current month "in progress" (live, no Generate, no staleness)
  - [ ] Metric table: Metric | This period | Prior | Change | Next period | Trend spark; null "—"
    never 0; insignificant delta shows raw figures, no %; direction tooltips; "thin sample"
  - [ ] Disclosures: "Partial coverage.", "Figures only.", "No comparison." + reason, "Stale", "Archived", Earlier cadences
  - [ ] "Effort vs automation" chart (ⓘ) by automation lane
  - [ ] The AI narrative when generated
- Actions:
  - [ ] Switch grain; pick a period / earlier / archived
  - [ ] "Generate" / "Regenerate" (AiRunGate complete); "Already had this one — served from cache."
  - [ ] "Copy as Markdown"
  - [ ] Print to PDF (print styles hide rail, tabs, buttons — must hide the new sidebar too)
- States:
  - [ ] No sprint cadence: points to "Settings → Sprint cadence and comparison window" or Month
  - [ ] Load errors; Generate error text
- Tests: `test/periodMetricRow.test.ts`, `test/periodReportMarkdown.test.ts`,
  `test/periodReportUrl.test.ts`, `test/aiGating.test.ts`, verify-demo reports:month

### [ ] Reports → Chronology (court ledger)
- Files: `Activity/BottlenecksPanel.tsx`, `bottlenecksModel.ts`, `chronologyModel.ts`,
  `chronologyInfo.tsx`, `ChronologyCharts.tsx`, `ChronologyTables.tsx`, `charts/ScatterChart.tsx`
- Essential info:
  - [ ] "Chronology" with ⓘ "How Chronology works"
  - [ ] Window picker: reporting window (default), 30, 60, 90 days
  - [ ] Disclosures: calendar line ("Set per workspace in Settings."), coverage line, exclusions line, truncation warning
  - [ ] Blocks with ⓘ: "Where the working hours went"; "Each wait against its time budget"; "Every
    pull request" (scatter; "Never back to author", size or "Size unknown", "Click to open"); "What
    the quick ones do differently" + "Time to merge, by size" + comparison table; "Approved,
    waiting to merge" ("Merged by its author"); "Who gives the first review" (names no person);
    "Asking for a review"; "Where each pull request sits"; "Where the time went, in clock hours";
    "By repository, in clock hours"; "Merged without a human review"
  - [ ] "Not enough data to say." refusals
  - [ ] Bot-opened PRs marked "Opened by automation"
- Actions:
  - [ ] Pick a window
  - [ ] Scatter dot / PR row → the PR
  - [ ] "Open on GitHub"
- States:
  - [ ] "Measuring…"; "Could not load this workspace’s flow."; "Nothing to measure in this workspace yet."; older-server layout
- Tests: `test/chronologyModel.test.ts`, verify-demo reports:bottlenecks, ws2:chronology

### [ ] Chronology → Over time (26-week trend, savings, before/after)
- Files: `Activity/ChronologyTrend.tsx`, `Activity/chronologyTrendModel.ts`, `hooks/useFlowTrend.ts`
- Essential info:
  - [ ] "Over time" with ⓘ
  - [ ] Weekly "Where the working hours went" and "Each wait against its budget" ("Three in four within…" table; "This week")
  - [ ] Verdicts "Real improvement", "Real slowdown", "Too few to judge"
  - [ ] "Some weeks hit a scan limit, so not every pull request is counted."
  - [ ] "Hours saved in dollars" (ⓘ)
  - [ ] "Before and after" from a chosen baseline week
- Actions:
  - [ ] "Hourly cost $" input (per workspace; "Could not save.")
  - [ ] Click a week to measure from it; click a marker to compare
- States:
  - [ ] "Could not load the last 26 weeks." / "Measuring…"; "Nothing to measure" cells; "Too few…"; "Before the baseline"
- Tests: `test/chronologyTrendModel.test.ts`

### [ ] Chronology → Pointers (AI)
- Files: `Activity/FlowPointersPanel.tsx`, `hooks/useFlowPointers.ts`
- Essential info:
  - [ ] "Pointers" with ⓘ; "Written by AI from the pull requests on this page."
  - [ ] Each pointer labelled "Pattern" or "Worth copying"
- Actions:
  - [ ] "Write pointers" / "Rewrite" (AiRunGate complete; "Writing…")
- States:
  - [ ] Hidden unless me.ai.enabled and server enables it; empty/loading/error lines; "Written moments ago — try again in a minute."
- Tests: `test/aiGating.test.ts`

### [ ] Reports → Stories
- Files: `Activity/StoriesView.tsx`, `Activity/storiesModel.ts`, `hooks/useStories.ts`
- Essential info:
  - [ ] "Stories — <reporting window caption>" with ⓘ
  - [ ] Lists "Fell short", "Not reviewed", "Reviewed, no gaps", each with an empty label
  - [ ] Chart "Time and pull requests" (ⓘ)
  - [ ] Chart "Size and criteria" (scatter; Fell short hollow squares; ⓘ); "Size unknown" and "No criteria found" lists
  - [ ] "All N stories" list
- Actions:
  - [ ] Ticket name → story tab (`useOpenStory`)
  - [ ] Small arrow → tracker
- States:
  - [ ] "Could not load stories." / "Loading…"; "No tickets with a pull request merged <window phrase>."; "No ticket has both a known size and a criteria count."
- Tests: `test/storiesModel.test.ts`, verify-demo reports:stories

### [ ] Bots Monitoring shell (+ the per-repo Bots tab)
- Entry: rail "Bots Monitoring" (`?activityRepo=bots`), `?botsTab=roi|themes|benchmark|classification`
  (legacy `botsTab=settings`, `feedTab=classification` → Classification); also each repo console's Bots tab
- Files: `Activity/BotsView.tsx`, `Activity/benchmarkModel.ts`, `Activity/index.tsx`, `store/filters.ts`
- Essential info:
  - [ ] Title "Bots Monitoring"
  - [ ] Sub-tabs ROI, Themes (AI on only), Benchmark, Classification (rail only)
- Actions:
  - [ ] Switch sub-tab (derived)
- States:
  - [ ] Themes hidden with AI off; Classification hidden per-repo; repoId narrows data only
- Tests: `test/botsBenchmark.test.ts`, `test/aiGating.test.ts`, verify-demo bots:roi, bots:themes, bots:benchmark, bots:classification

### [ ] Bots → ROI (cautions, tuning suggestions, ROI table, flagging strip, charts)
- Files: `Activity/BotsView.tsx`, `Activity/BotRoiPanel.tsx`, `Activity/InflationHistoryChart.tsx`,
  `Activity/SeverityAgreementMatrix.tsx`, `Activity/WorkspaceBotCharts.tsx`, `hooks/useTriage.ts`,
  `hooks/useBotVolume.ts`, `hooks/useBotColors.ts`, `lib/botReviewers.ts`, `lib/botCost.ts`,
  `lib/botSavings.ts`, `lib/botVolume.ts`, `lib/botMlSeries.ts`, `lib/unionBot.ts`
- Essential info:
  - [ ] Caution "Only a bot reviewed N open PRs — no human review yet…" + "Open PRs only, any age." + "Show list →"
  - [ ] Resolve backlog banner with "Review & resolve"
  - [ ] Tuning suggestions (advisory)
  - [ ] ROI heading ⓘ "How Bot ROI is measured"
  - [ ] Window picker 7d, 14d, 30d, Sprint (shared store field)
  - [ ] "What the bots are flagging" strip (ⓘ; ML): coverage %, Findings, High severity, Nits, Top topic, Same-line overlap; capped-read disclosure
  - [ ] Quality checks table (Check, Threads, Comments, Last active) + ⓘ
  - [ ] Per-bot table: Threads, inline comments, Comments/PR, Used, Not addressed, Merged past,
    Median to address, Oldest waiting, Not addressed %, Overlap %, severity mix, High %, Nits %, not
    addressed by severity, Inflation (↑/↓; "—" for a bot that badges nothing), $ per used thread,
    Verdict (Keep, Tune, Rarely used), Depth →; every header has a tooltip
  - [ ] "Turning it off would save" lines
  - [ ] Charts: Thread volume, Bot effectiveness, Used vs not addressed, Inflation history
  - [ ] Price prompt "Set a bot’s monthly price in Bots Monitoring → Classification…"
  - [ ] Collapsed "Workspace charts" (fetch on open)
- Actions:
  - [ ] Caution → bot-only-prs tab; "Review & resolve" → bot-threads tab
  - [ ] Pick a window
  - [ ] Bot row → bot-prs; "Depth →" → bot-detail; Comments/PR cell → bot-volume; flagging tile / severity cell / inflation count → bot-flagging
  - [ ] Expand "Workspace charts"
- States:
  - [ ] "Couldn’t load bot analytics."; "No review-bot activity in this window." / "Try a wider window above."
  - [ ] ML columns need mlSeverity; blank (never zero) with nothing scored
  - [ ] Dormant rows dashed with tooltip
  - [ ] Cost per workspace, never summed across workspaces
  - [ ] Mobile: the wide table scrolls in its own box
- Tests: `test/botReviewers.test.ts`, `botCost`, `botSavings`, `botVolume`, `botVolumeSize`,
  `botMlSeries`, `inflationHistory`, `severityAgreement`, `resolvableBotThreads`,
  `botReviewerQueryKey`, `mlScoring`, `vendorInk`, `textContrast`, `botsBenchmark` (all `test/*.test.ts`), verify-demo bots:roi

### [ ] Bots drill-down tabs (bot-detail, bot-prs, bot-only-prs, bot-threads, bot-flagging, bot-volume)
- Files: `Activity/BotDetailPanel.tsx`, `BotPrsDetail.tsx`, `BotCommentCard.tsx`, `BotOnlyPrsDetail.tsx`,
  `BotThreadsDetail.tsx`, `BotFlaggingDetail.tsx`, `BotVolumeDetail.tsx`, `charts/DayStrip.tsx`, `charts/Heatmap.tsx`
- Essential info:
  - [ ] bot-detail: four headline stats, three weekly trend minis, daily-coverage strip,
    latency/cadence/coverage/consistency charts, severity over time, category mix
  - [ ] bot-prs: sub-tab per bot, Comments | PRs toggle; comments severity-badged and filterable;
    per PR: thread volume, acted-on %, still untouched, bot-only badge
  - [ ] bot-only-prs: "Bot-only PRs", sortable table (age, last update, author, bot, state, Repo), repo filter, window picker
  - [ ] bot-threads: PRs with likely-addressed bot threads, sortable table (author, CI, age, last update, thread-state mix, resolvable count)
  - [ ] bot-flagging: "showing N of M", server totals only
  - [ ] bot-volume: merged PRs behind a Comments/PR average, biggest first, "showing N of M"
- Actions:
  - [ ] bot-only-prs: "Show merged" checkbox, "Show in feed", sort, row → PR
  - [ ] bot-threads: per-PR checkboxes, "Select all" across pages, "Clear", confirm-gated bulk
    resolve in sequential POSTs with Stop; row → PR's Changes (Threads only) with likely_addressed preselected
  - [ ] Others: sort, page, row → PR detail tab
- States:
  - [ ] Loading and error per tab; lists lazy
- Tests: `test/resolvableBotThreads.test.ts`, `test/botComments.test.ts`, `test/mlSeverityBadge.test.ts`, verify-demo bot-detail:8

### [ ] Bots → Themes (+ theme-threads drill-down)
- Files: `Activity/BotThemesPanel.tsx`, `Activity/ThemesReportView.tsx`, `Activity/ThemeThreadsDetail.tsx`, `hooks/useBotThemes.ts`
- Essential info:
  - [ ] "AI read" label; themes and narrative labelled approximate
  - [ ] Per theme: title, severity chip, category, comment count (computed vs approximate; tooltips say which), "Where"
  - [ ] Severity strip from approximate estimates
  - [ ] Deterministic per-bot volume and acted-on rollup
  - [ ] Theme-threads tab: metrics strip, threads grouped by PR (ThreadCard)
- Actions:
  - [ ] "Generate" / "Regenerate" (AiRunGate complete; "Summarising…")
  - [ ] Theme → theme-threads
  - [ ] Open the PR in its own tab
- States:
  - [ ] "No summary yet — generate one…"; "Couldn’t generate the summary."; hidden with AI off
- Tests: `test/themeCardCount.test.ts`, `test/themeMetrics.test.ts`, `test/aiGating.test.ts`, verify-demo bots:themes

### [ ] Bots → Benchmark
- Files: `Activity/BenchmarkPanel.tsx`, `Activity/benchmarkModel.ts`, `hooks/useBotBenchmark.ts`
- Essential info:
  - [ ] Anomaly findings first, with how much was checked
  - [ ] Rail: rollup card per vendor (pooled counters, money, spread of placements, estate-matched
    expectation, per-repo evidence table). Repo console: per-repo unit cards, 13 metric strips, band placement
  - [ ] Every percentile carries its cohort n and band count
  - [ ] Refusal notes as sentences
  - [ ] ⓘ "How Benchmark works", ⓘ "Where these numbers come from"
- Actions:
  - [ ] Open the definitions disclosure (click-gated)
  - [ ] "Open a repository’s own Bots tab to place it on its own."
- States:
  - [ ] Skeleton; error card; no gate (test pins it ungated); money only on the workspace rollup
- Tests: `test/botsBenchmark.test.ts`, verify-demo bots:benchmark

### [ ] Bots → Classification
- Files: `Activity/BotSettingsPanel.tsx`, `settings/DetectedReviewersTable.tsx`, `hooks/useBotTriage.ts`, `lib/botAvatar.ts`
- Essential info:
  - [ ] "Bot classification" with ⓘ
  - [ ] Sections "Review bots", "Other automation", "Marked “not a bot” by you"
  - [ ] Card per bot: avatar/monogram, vendor-colour accent, name and login, Role and Vendor chips,
    "Active in" repo chips ("+N more"), 90-day counts, "Detected: <source>"; person row muted
  - [ ] Workspace monthly cost total ("$X/mo")
  - [ ] Pointer to Settings → Workspace → Slack digest
- Actions:
  - [ ] "Counts as" bot / person (this workspace only)
  - [ ] Role select (six roles)
  - [ ] Vendor select and Label text
  - [ ] Price monthly $ or per seat; "Save price" / "Clear"
  - [ ] Two resets: judgement and identity
  - [ ] "Add a review bot" search
- States:
  - [ ] "Loading…"; price hints "Unchanged.", "No price set. Type a number to add one (0 means “free”)."
- Tests: `test/botReviewers.test.ts`, `test/botAvatar.test.ts`, `test/botCost.test.ts`,
  `test/vendorInk.test.ts`, verify-demo bots:classification

### [x] Docs (workspace reference library: list, add, tree, reader, chat) → a page header (Docs ⓘ, "N documents", the pane tabs); library rows are two lines (title · source, pages, sections, model) with a red mark + line where a row blocks (unreachable, failed); the open document's row opens up with Checked/last edited, figures and Refresh now / Rebuild / Remove; below lg one column with Library · Read · Ask tabs (lg–xl: library beside Read / Ask); custom Selects for depth and conversation; ⌘K: every document, "Ask about these docs", "Add a document to Docs"
- Entry: rail "Docs" (`?activityRepo=docs`), only when `me.ai.enabled`. Also from a review's
  "Reference docs", a finding citation or a story docs check (`store/openDocs.ts`)
- Files: `Activity/DocsView.tsx`, `Activity/DocsViewer.tsx`, `Activity/DocsChat.tsx`,
  `hooks/useReferenceDocs.ts`, `store/docsView.ts`, `store/openDocs.ts`, `lib/docsLayout.ts`,
  `lib/referenceDocs.ts`, `lib/docQuoteMatch.ts`, `hooks/useResizablePane.ts`
- Essential info:
  - [ ] Library column "Docs" with ⓘ
  - [ ] Add area (AiRunGate docs_build): drop zone ("or drop PDF, Word, text or markdown files
    here"; Codex: "Codex cannot read PDFs"); web address + depth ("This page only" / "Follow links,
    N levels"); Confluence/Notion: "With child pages, N levels", "Add <Confluence|Notion> page"; ⓘ; per-file upload errors
  - [ ] "All documents" row; each doc: title, source label, page count ("Confluence · 3 pages"), section count, model
  - [ ] Wiki status: "Checked <time>", "last edited <date>"; "Can’t reach this page in <Confluence> since <date>. <reason>" (`wiki-unreachable`)
  - [ ] Figures line: "N figures described by AI", "N diagrams read from source", "N waiting for the next refresh"
  - [ ] Build progress "Building <title>: <stage>"
  - [ ] Failed: error or "The build failed." + "The last built version is still here."
  - [ ] Contents tree collapsed to chapters, "Expand all" / "Collapse all"
  - [ ] Viewer: "Where you are" breadcrumb; open file; quote highlight strip
  - [ ] Chat "Ask about these docs" (ⓘ): answers with "Sources" citations and run cost
- Actions:
  - [ ] Upload (picker or drop); add web / Confluence / Notion page with depth
  - [ ] Per doc: expand contents; open CONTENTS; "Refresh now"; "Rebuild" / "Try again"; "Cancel";
    "Remove" with confirm ("Remove this document?" → Remove / Keep)
  - [ ] Tree: expand/collapse; open a section
  - [ ] Viewer: library links in-app, #anchors scroll, outside links new tab
  - [ ] Chat: conversation select ("New conversation"), ask (AiRunGate docs_chat), delete
    (confirm "Delete this conversation?"), citation → viewer
  - [ ] Layout: hide/show the document list; drag or arrow-key the two separators; double-click
    resets; narrow screens get a Read / Ask switch
- States:
  - [ ] Rail entry hidden when AI is off; a direct link shows one line saying why
  - [ ] workspaceId null "Loading…"; "No documents yet."; viewer empty line; "This page is no longer in the library."
  - [ ] Tree "Loading…", "No sections."
  - [ ] Chat "Add a document first."; "This conversation could not be loaded."; "Reading the docs…"
  - [ ] Model controls swap to the AiRunGate line without runtime/credential; reading never needs either
  - [ ] Open state per workspace for the visit, not in the URL
- Tests: `test/docsLayout.test.ts`, `test/docsRailUrl.test.ts`, `test/docQuoteMatch.test.ts`,
  `test/docReferencesLink.test.ts`, `test/referenceDocsLinks.test.ts`, `test/referenceDocsStreams.test.ts`,
  `test/aiGating.test.ts`, `e2e/docs-quote-highlight.spec.ts`, `e2e/mock-api.ts` docs routes,
  verify-demo docs (expects "Release handbook", "Confluence · 3 pages", "Refresh now", "Can’t
  reach this page in Confluence since", "Checkout design notes", "Notion · 2 pages", "1 figure described by AI")

### [x] Settings modal shell (tabs, workspace boundary, focus landing) → md+: a sheet with the areas column (surface) beside the area (title in its header); phone: full screen, the list of areas (each with a one-line summary) THEN the area with Back; deep links open straight on the area; the boundary is a tone band whose copy names "the top of the sidebar"; Escape also yields to an open Select/Menu; opening closes the drawer
- See § 1 Settings modal. Extra:
  - [ ] Title "Settings", Close "Close (Esc)"
  - [ ] Tabs vertical at sm+, a top row on narrow screens (→ phones: full-screen sheet)
  - [ ] Boundary heading "Workspace · <name>" + "Everything below applies to <name> alone — every
    other workspace keeps its own. Switch workspace in the rail to configure a different one."
    (copy must name the NEW place the workspace is switched)
  - [ ] Escape: a control that owns Escape (time-zone list) closes first
  - [ ] Every panel stays mounted (drafts survive a tab switch); each section a draft until its own Save; ScopePendingSection
- Tests: `test/settingsTabs.test.ts`, `test/activePopover.test.ts`, `test/escapeOwner.test.ts`,
  `test/workspaceScope.test.ts`, `e2e/pending-keyboard.spec.ts`, verify-demo settings:ai,
  settings:ai-effort, settings:ai-codex, settings:related-repos, settings:confluence, settings:notion, ws2:settings:notion

### [x] Settings → Pull requests (Large pull requests, Blast radius) → restyled; radios/checkboxes are the restyled real inputs (`CheckInput`/`RadioInput`)
- Files: `settings/LargePrThresholdSection.tsx`, `settings/BlastRadiusSection.tsx`
- Essential info:
  - [ ] "Large pull requests": line threshold (code churn only), one number per account
  - [ ] "Blast radius": dial Cautious / Balanced / Relaxed ("Currently the product default."),
    surfaces: Database migrations, Database schemas and models, Auth and security code,
    Infrastructure (Terraform, Helm, Kubernetes), Service contracts (protobuf, GraphQL, Thrift),
    Published type definitions, Dependencies
- Actions:
  - [ ] Type threshold + Save (empty = default)
  - [ ] Pick dial (radio); tick surfaces; Save
- States:
  - [ ] "Enter a number greater than zero." / "Enter a whole number of lines, or leave empty."; save errors
- Tests: `test/largePrFlag.test.ts`, `test/reachModel.test.ts`

### [x] Settings → Pending (My Turn; Pending mute) → restyled; presets are a segmented control (same radiogroup, one Tab stop); sliders on --ui-* tokens
- Files: `settings/MyTurnSection.tsx`, `settings/myTurnSettingsForm.ts`, `settings/PendingMuteSection.tsx`,
  `packages/shared/src/my-turn-settings.ts`
- Essential info:
  - [ ] "Show in My Turn" types with hints (Review requests, @mentions of you, Replies in threads you
    started, Replies to your comments in other threads, Comments after yours on a PR, New commits
    since you reviewed, Your PRs that are approved, New activity on your PRs, Finished Claude
    reviews, New PRs nobody asked you about)
  - [ ] "Add to My Turn" (off by default): Failing builds on your PRs, Merge conflicts on your PRs,
    Your PRs ready to land, Unanswered threads on your PRs
  - [ ] Red default branch scope radio: Off, Repos you maintain, Every repo in the workspace
  - [ ] "Order of My turn" with move buttons
  - [ ] "How Pending ranks cards": presets Balanced, Mine first, Oldest first, Quick wins, Custom; three weight sliders adding to 100%
  - [ ] Pending mute (workspace): checkbox per repo + what a mute does
- Actions:
  - [ ] Toggle types; trunk scope; reorder; preset (one Tab stop, arrow keys apply the next preset); sliders; Save
  - [ ] Tick repos to mute; Save
- States:
  - [ ] Save errors; "Loading this workspace’s repositories…"
- Tests: `test/myTurnSettingsForm.test.ts`, `test/pendingMutePatch.test.ts`,
  `test/myTurnCapDisclosure.test.ts`, `e2e/pending-keyboard.spec.ts`

### [x] Settings → AI (provider, sign-in, effort, AI spend) → `#ai-effort` and "Your subscription" are custom Selects (hidden input `name=ai-effort`; verify-demo clicks the option); `input[name=ai-provider]` radios unchanged in behaviour
- Files: `settings/AiProviderSection.tsx`, `settings/ClaudeSpendSection.tsx`, `settings/claudeSpendForm.ts`,
  `hooks/useAiCapabilities.ts`, `hooks/useAiProvider.ts`, `hooks/useAiBudget.ts`
- Essential info:
  - [ ] "Automatic runs and default:" radios Claude, Codex, Auto (+ explanation); "Default: Claude." /
    "Default: Codex."; "Set by LIMN_AI_PROVIDER." when pinned (disabled)
  - [ ] Per-provider status lines (Claude signed in / API key / sign-in prompt; Codex signed in with
    ChatGPT (Plus), Not set up, Not signed in; "Codex signs in with ChatGPT only. An OPENAI_API_KEY is not used.")
  - [ ] "Effort for AI Review and AI Fix:" select `#ai-effort`, cost hint, "Set by REVIEW_EFFORT."
  - [ ] "AI spend" (focus target `claude-spend`): "Pause automatic runs over budget"; subscription:
    plan, share of week (%), 5-hour share; API key: "$ a week"; status line `#ai-budget-status`
- Actions:
  - [ ] Pick provider (radio `name=ai-provider` — verify-demo clicks `input[name=ai-provider][value=codex]`)
  - [ ] "Set up Codex" ("Setting up Codex…"); "Sign in with ChatGPT"; "Sign out"
  - [ ] Pick effort (verify-demo selects `#ai-effort` = high)
  - [ ] Budget toggle, plan, shares, weekly $; Save
- States:
  - [ ] Tab hidden when AI is off; budget load/save errors; nothing-to-limit lines; no US$ on a subscription
- Tests: `test/claudeSpendForm.test.ts`, `test/aiBudget.test.ts`, `test/aiProviderCopy.test.ts`,
  verify-demo settings:ai, settings:ai-effort, settings:ai-codex. ⚠ A custom Select/Radio must keep
  these selectors working (or the scripts are updated in the same commit)

### [x] Settings → AI review (Auto review, Reference docs, Confluence, Notion, Related repos) → restyled; "Auto reviews use" and the Repository picker are custom Selects
- Files: `settings/AutoReviewSection.tsx`, `settings/ReferenceDocsSection.tsx`, `settings/ConfluenceSection.tsx`,
  `settings/NotionSection.tsx`, `settings/RelatedReposSection.tsx`, `hooks/useWorkspaceAutoReview.ts`,
  `hooks/useRelatedRepos.ts`, `lib/modelPick.ts`
- Essential info:
  - [ ] Auto review (ⓘ): "Review new PRs automatically"; "Mark auto reviews on GitHub"; "Auto
    reviews use" (incl. Claude + Codex); "When Claude and Codex disagree" (Strict / Relaxed); "When
    an auto review finishes" (Keep it in Limn / Post to GitHub); "Which PRs"; "What to post"
    checkboxes (Blockers, Warnings, Nits, Questions, CI failure reasons, SonarCloud issues, Story
    gaps, Work the story did not ask for); "Approve or request changes for me"; Approve by impact
    (High, Medium, Low; unmeasured counts as High); Approve with open findings (three options);
    "Resolve Limn’s threads once fixed"; "Up to N auto reviews a day (UTC)"; "Auto AI Fix on your
    own PRs" with "Always include" options and "Push automatically"; "Draw a design diagram after
    each review" (ⓘ); "Nothing is reviewed until AI is set up."
  - [ ] Reference docs: "Use reference docs in AI Review" (off by default)
  - [ ] Confluence: Site, Email, API token (sealed; "Replaces the saved token when you save." /
    "Removed when you save"); "Pages on <jira site> use your Jira token."; "Add Confluence pages to Docs."
  - [ ] Notion: Integration token; "Add Notion pages to Docs."
  - [ ] Related repos: Repository picker, "Reviewed together with" ticks, list of pairs, what it reads
- Actions:
  - [ ] Every toggle/radio/select/number + that section's Save
  - [ ] Confluence / Notion "Test connection" ("Testing…"; "Save first."); replace / remove token
  - [ ] Related repos: pick, tick, Save
- States:
  - [ ] Tab hidden with AI off; save errors; Auto AI Fix disabled while auto review is off; related
    repos needs two+ repos; ScopePendingSection on a failed GET
- Tests: `test/autoPost.test.ts`, `test/verdictStrictness.test.ts`, `test/claudeAutoReview.test.ts`,
  `test/relatedRepos.test.ts`, verify-demo settings:related-repos, settings:confluence, settings:notion

### [x] Settings → Reports and sprint (Working hours and budgets; Sprint cadence and comparison window) → restyled; Sprint length and Comparison window are custom Selects
- Files: `settings/FlowSettingsSection.tsx`, `settings/flowSettingsForm.ts`, `settings/BudgetSliders.tsx`,
  `settings/TimeZoneCombobox.tsx`, `settings/timeZones.ts`, `settings/SprintSection.tsx`
- Essential info:
  - [ ] "Working hours and budgets": Working days (day toggles), Working day start/end (time
    inputs), Time zone (searchable combobox "Time zones"; defaults to me.workTimeZone or browser),
    "Budgets, in working hours" Good/Acceptable slider per wait
  - [ ] "Sprint cadence and comparison window": Sprint length (days, "Custom…"), Start date, "No
    sprint — this workspace doesn’t run one"; Comparison window (Sprint position / Rolling 7 / Rolling 14 default); "Earlier cadences"
- Actions:
  - [ ] Toggle days, times, time zone (Escape closes the list, not the modal), sliders; Save
  - [ ] Cadence, start, comparison; Save (only the changed half is sent)
- States:
  - [ ] "Enter the working day as two times, like 09:00 and 18:00." / "Pick at least one working day."; save error
- Tests: `test/flowSettingsForm.test.ts`, `test/timeZones.test.ts`, `test/sprintSectionPatch.test.ts`, `test/escapeOwner.test.ts`

### [x] Settings → Integrations (Issue tracker; SonarCloud; Slack) → restyled; Provider, Where to look, Notion property mappings, Current sprint, Cadence / Send at / And at are custom Selects; API-access boxes are tone panels
- Files: `settings/IssueLinksSection.tsx`, `settings/JiraApiAccess.tsx`, `settings/LinearApiAccess.tsx`,
  `settings/NotionTrackerSetup.tsx`, `settings/SonarSection.tsx`, `settings/SlackSection.tsx`,
  `hooks/useWorkspaceTracker.ts`, `hooks/useSlackTarget.ts`, `hooks/useSonar.ts`
- Essential info:
  - [ ] "Issue tracker": Provider (None, Jira, Linear, GitHub Issues, Notion); "Where to look" (PR
    title and branch name (default) / PR title only; "Commit messages are never read."); Jira: Base
    URL, Project keys, Email, API token ("Saved"); Linear: Workspace URL, Team keys, Personal API
    key; GitHub Issues: auto; Notion: Integration token, Database URL, "Read database", mapping form
    (Status, Sprint, Current sprint, Sprint dates, Assignee, Type, Acceptance criteria, Blocked by,
    key format "keys look like WEB-123"); "Not mapped yet. Nothing is read until it is."; "Limn only reads Notion. It never changes a page."
  - [ ] "SonarCloud": Organization key, Project keys, Token (sealed; "Saved, but unreadable here. Replace it."); per-project "Not found"
  - [ ] "Slack" digest: description; Incoming webhook URL (+ where to create one); Cadence (Off,
    Daily, Twice daily); "Send at" / "And at"; "Include a review-bot summary"; "Post when an auto
    review finishes" (only when reviews can run); "Post when a pull request merges"; "N of CAP
    workspaces have a digest" + at-maximum warning
- Actions:
  - [ ] Provider + fields; "Check connection" (Jira, Linear; "Checking…"); Notion "Read database"
    (`notion-read-database`, "Reading…") and "Change mapping" (`notion-mapping-form`); Save
  - [ ] Sonar "Test connection"; replace/remove token; Save
  - [ ] Slack: Save, "Send test" ("Sending…", "Sent — check Slack.", "Not sent."), "Stop sending (delete the channel)" ("Stopping…")
- States:
  - [ ] "Save a key first." / "Save a token first." / "Save an organization and a token first." /
    "Save first."; "A webhook URL is required."; Save disabled over the digest cap; save error
- Tests: `test/githubTracker.test.ts`, `test/jiraTicket.test.ts`, verify-demo ws2:settings:notion

### [x] Settings → Bots (Bot comment scoring; Dependency updates) → restyled
- Files: `settings/BotScoringSection.tsx`, `settings/DependencyAutoMergeSection.tsx`, `hooks/useMlInstall.ts`
- Essential info:
  - [ ] "Bot comment scoring" (global): "Score how serious each bot review comment is."; one-time
    model download; "Set up. Bot review comments are scored on this machine."
  - [ ] "Dependency updates" (workspace): merge dependency updates automatically (off by default; "Applies to this workspace only.")
- Actions:
  - [ ] Download / set up the scorer ("The download failed.")
  - [ ] Toggle dependency auto-merge; Save
- States:
  - [ ] Bot scoring renders nothing where `me.ml` is absent; the divider then disappears (peer-empty); save error
- Tests: `test/mlScoring.test.ts`, `test/settingsTabs.test.ts`
