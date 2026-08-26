import { create } from 'zustand';

// Lightweight metadata captured when a PR-backed tab is opened, so the tab can
// render its label (title + author) without re-fetching the full PR detail on
// every load. The full detail is still fetched (and IndexedDB-cached) when the
// tab is opened.
export interface TabMeta {
  id: number;
  number: number;
  title: string;
  repoFullName: string;
  authorLogin: string | null;
  authorDisplayName: string | null;
  authorAvatarUrl: string | null;
}
// Back-compat alias: several components still `import type { PinnedPr }`.
export type PinnedPr = TabMeta;

// The kinds of persistent tab the main area can show:
//  - pr-detail: a PR rendered full-screen (PrDetail) over the warm board (today's "pinned PR")
//  - pr-focus:  a PR's OWN isolated Timeline instance (replaces the old overlay focus mode)
//  - metrics-detail: the flow-metric drill-down (a singleton, non-PR, EPHEMERAL tab)
//  - bot-prs: the bot-vendor PR drill-down (a singleton, non-PR, EPHEMERAL tab)
//  - open-prs: the sortable all-open-PRs drill-down (a singleton, non-PR, EPHEMERAL tab)
//  - bot-only-prs: the bot-only-reviewed PR drill-down (a singleton, non-PR, EPHEMERAL tab)
//  - bot-threads: the resolvable-bot-threads review & resolve (a singleton, non-PR, EPHEMERAL tab)
//  - bot-flagging: the ML-strip drill-down ("what the bots are flagging" — a singleton, non-PR,
//    EPHEMERAL tab; which tile/chip it shows is the transient seed, not the key)
//  - bot-volume: the merged-PR list behind the ROI table's "bot comments per PR" column (a
//    singleton, non-PR, EPHEMERAL tab; which bot it is narrowed to is the transient seed)
//  - user-activity: one contributor's activity feed (keyed PER USER, non-PR, EPHEMERAL)
//  - bot-detail: one review bot's depth analytics (keyed PER BOT user id, non-PR, EPHEMERAL —
//    the per-bot drill-down that replaced the Bots "Behaviour" inner tab, plan P1.1/C1)
export type TabKind =
  | 'pr-detail'
  | 'pr-focus'
  | 'metrics-detail'
  | 'bot-prs'
  | 'open-prs'
  | 'bot-only-prs'
  | 'bot-threads'
  | 'bot-flagging'
  | 'bot-volume'
  | 'theme-threads'
  | 'search'
  | 'user-activity'
  | 'bot-detail'
  | 'people-report';

// The label metadata a user-activity tab carries, so its chip renders without a lookup
// (and keeps rendering if the user drops out of the roster). Captured at open time.
export interface TabUserMeta {
  id: number;
  login: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

// The label metadata a bot-detail tab carries (the TabUserMeta pattern for bots): enough to
// render the chip + header without a lookup, captured at open time from the ROI row the tab was
// opened from. `repoId` is the repo narrowing that row was measured at (the per-repo Bots
// console; null = whole workspace) — the tab's fetch inherits it so the depth describes the same
// scope as the table the user clicked.
export interface TabBotMeta {
  id: number; // users.id — the same number the tab key carries
  login: string | null;
  label: string; // classification label → vendor name → login (the ROI row's display name)
  kind: string; // AutomatedReviewerKind (kept as string here — the store stays type-light)
  repoId: number | null;
}

export interface Tab {
  key: string; // stable: 'pr-detail:123' | 'pr-focus:123' | 'user-activity:45' | 'bot-detail:45'
  kind: TabKind;
  prId: number; // PR id for pr-detail / pr-focus
  meta: TabMeta | null; // label meta for PR tabs
  userMeta?: TabUserMeta | null; // label meta for user-activity tabs
  botMeta?: TabBotMeta | null; // label meta for bot-detail tabs
}

// Which "tab" the main area is showing: the standard timeline board, the Activity
// triage console, or one of the persistent tabs identified by its `Tab.key`.
// These are ONE axis — only one renders at a time.
export type ActiveTab = 'timeline' | 'activity' | string;

// Contract with the Timeline component: the board slot passes this to
// `<Timeline mode={…}/>`. Absent = today's full shared board.
export type TimelineMode = { kind: 'isolate'; prId: number };

export const prDetailKey = (id: number): string => `pr-detail:${id}`;
export const prFocusKey = (id: number): string => `pr-focus:${id}`;
// The metric drill-down is a SINGLETON, non-PR tab. Which metric it shows is driven by the
// transient `metricsFocus` signal (store/filters.ts), not the key. EPHEMERAL: excluded from
// persistence (see `persist`) + not matched by parseTabKey, so a reload drops it.
export const METRICS_TAB_KEY = 'metrics-detail';
// The bot-vendor PR drill-down is likewise a SINGLETON, non-PR tab. Which reviewer it shows is
// driven by the transient `botPrsFocusKey` signal (store/filters.ts), not the key. EPHEMERAL:
// excluded from persistence (see `persist`) + not matched by parseTabKey, so a reload drops it.
export const BOT_PRS_TAB_KEY = 'bot-prs';
// The sortable all-open-PRs drill-down is likewise a SINGLETON, non-PR tab. Which scope it
// lists (a repo | the FilterBar-visible 'feed' scope) is driven by the transient `openPrsScope`
// signal (store/filters.ts), not the key. EPHEMERAL like the two above.
export const OPEN_PRS_TAB_KEY = 'open-prs';
// Two more SINGLETON, non-PR bot drill-downs, seeded by transient repo-scope signals
// (store/filters.ts botOnlyFocusRepoId / botThreadsFocusRepoId). EPHEMERAL like the above.
export const BOT_ONLY_PRS_TAB_KEY = 'bot-only-prs';
export const BOT_THREADS_TAB_KEY = 'bot-threads';
// The ML-strip drill-down is likewise a SINGLETON, non-PR tab. WHICH tile or chip it renders (and
// the repo it was opened FROM) is the transient `botFlaggingSeed` signal (store/filters.ts), not
// the key — so clicking a second tile RE-SEEDS this one tab in place rather than opening another.
// EPHEMERAL: excluded from persistence (see `persist`) + not matched by parseTabKey, so a reload
// drops it — which it must, since the seed it renders from lives only in memory.
export const BOT_FLAGGING_TAB_KEY = 'bot-flagging';
// The bot-comment-VOLUME drill-down — the merged PRs behind the ROI table's "bot comments per PR"
// column. A SINGLETON, non-PR tab like the ones above: WHICH bot it is narrowed to (and the repo
// the column was measured at) is the transient `botVolumeSeed` signal (store/filters.ts), not the
// key, so clicking a second bot's cell RE-SEEDS this one tab in place. EPHEMERAL: excluded from
// persistence (see `persist`) + not matched by parseTabKey, so a reload drops it — which it must,
// since the seed it renders from lives only in memory.
export const BOT_VOLUME_TAB_KEY = 'bot-volume';
// The theme-threads drill-down is a SINGLETON, non-PR tab: it lists all the review threads / PR
// comments a Bot/Human theme groups. The theme itself is the transient seed (store/filters.ts
// `themeThreadsSeed`), not the key. EPHEMERAL like the others (dropped on reload).
export const THEME_THREADS_TAB_KEY = 'theme-threads';
// The cross-repo search results drill-down is a SINGLETON, non-PR tab. The query it shows is the
// transient seed (store/filters.ts `searchSeed`), not the key. EPHEMERAL like the others.
export const SEARCH_TAB_KEY = 'search';
// The People report (Reports → People → "Begin report") is likewise a SINGLETON, non-PR tab.
// WHICH period + selection set it renders is the transient `peopleReportSeed` signal
// (store/filters.ts), not the key — so a second Begin RE-SEEDS this one tab in place rather
// than opening another. EPHEMERAL: excluded from persistence (see `persist`) + not matched by
// parseTabKey, so a reload drops it — which it must, since the seed it renders from lives only
// in memory.
export const PEOPLE_REPORT_TAB_KEY = 'people-report';
// The per-contributor activity feed is keyed PER USER (not a singleton) — two people's feeds
// can sit side by side, and re-clicking the same handle re-focuses their existing tab rather
// than replacing it. Still EPHEMERAL: `persist` whitelists only the two PR kinds and
// parseTabKey doesn't match this prefix, so a reload drops it like every other drill-down.
export const userActivityKey = (userId: number): string => `user-activity:${userId}`;
/** The userId behind a user-activity tab key (null for any other key). */
export function parseUserActivityKey(key: string): number | null {
  const m = /^user-activity:(\d+)$/.exec(key);
  return m ? Number(m[1]) : null;
}
// One review bot's depth analytics, keyed PER BOT (the user-activity pattern): two bots' depth
// tabs can sit side by side, and re-clicking the same bot's "Depth →" pill re-focuses its
// existing tab. The NUMERIC slot is the bot's `users.id` — the same id the behaviour route's
// `botUserId` narrowing takes, so the key and the fetch can never name different bots. Still
// EPHEMERAL: `persist` whitelists only the two PR kinds and parseTabKey doesn't match this
// prefix, so a reload drops it like every other drill-down.
export const botDetailKey = (userId: number): string => `bot-detail:${userId}`;
/** The bot's userId behind a bot-detail tab key (null for any other key). */
export function parseBotDetailKey(key: string): number | null {
  const m = /^bot-detail:(\d+)$/.exec(key);
  return m ? Number(m[1]) : null;
}

/** Parse a Tab.key back into its kind + PR id (null for unknown). */
export function parseTabKey(key: string): { kind: TabKind; prId: number } | null {
  const m = /^(pr-detail|pr-focus):(\d+)$/.exec(key);
  return m ? { kind: m[1] as TabKind, prId: Number(m[2]) } : null;
}

interface OpenOpts {
  // Force the Back-to-Activity history entry. When omitted it is inferred from the
  // active tab at open time (opening any tab while the Activity console is showing arms it).
  fromActivity?: boolean;
  // The consolidated-feed item id this open was launched from (if any). Stashed so a
  // browser Back can scroll it into view + flash it on return to the feed.
  returnItemId?: string | null;
}

interface TabsState {
  tabs: Tab[]; // ordered; persisted
  activeTab: ActiveTab; // NOT persisted (fresh load 'timeline'; useUrlState → the URL's view)
  // The feed item id a browser-Back should scroll-to + flash. Two fields so the flash fires
  // ONLY on a real Back, never on an ordinary return to Activity (e.g. clicking the Activity
  // tab chip): `activityReturnItemId` is the PENDING target (set on an Activity-launched
  // open); `applyUrlTab({fromPop:true})` promotes it into the one-shot `activityFlashItemId`
  // (the signal the feed view consumes) only when a POPPED url actually lands on Activity.
  //
  // ⚠ THE HISTORY ENTRY IS NO LONGER OURS. This used to ride a `{pierreTab}` marker pushed by
  // `openTab` — the app's only pushState — consumed by a `navigateBack()` that read store flags
  // and never looked at the URL. There is ONE history authority now (the URL: `useUrlState`
  // pushes on a navigation-key change and rehydrates both stores on popstate), so the flash
  // hangs off the pop that lands on Activity rather than off a private marker. Two authorities
  // reacting to one popstate is what made Forward corrupt the stack.
  activityReturnItemId: string | null;
  activityFlashItemId: string | null;

  pin: (meta: TabMeta) => void; // ensure a pr-detail tab, do NOT activate
  openPrDetailTab: (meta: TabMeta, opts?: OpenOpts) => void; // ensure pr-detail + activate
  openPrFocusTab: (meta: TabMeta, opts?: OpenOpts) => void; // ensure pr-focus + activate
  openMetricsTab: (opts?: OpenOpts) => void; // ensure the singleton metrics drill-down + activate
  openBotPrsTab: (opts?: OpenOpts) => void; // ensure the singleton bot-vendor PR drill-down + activate
  openOpenPrsTab: (opts?: OpenOpts) => void; // ensure the singleton all-open-PRs drill-down + activate
  openBotOnlyPrsTab: (opts?: OpenOpts) => void; // ensure the singleton bot-only-PRs drill-down + activate
  openBotThreadsTab: (opts?: OpenOpts) => void; // ensure the singleton bot-threads resolve tab + activate
  openBotFlaggingTab: (opts?: OpenOpts) => void; // ensure the singleton ML-strip drill-down + activate
  openBotVolumeTab: (opts?: OpenOpts) => void; // ensure the singleton bot-volume PR drill-down + activate
  openThemeThreadsTab: (opts?: OpenOpts) => void; // ensure the singleton theme-threads drill-down + activate
  openSearchTab: (opts?: OpenOpts) => void; // ensure the singleton search-results drill-down + activate
  openPeopleReportTab: (opts?: OpenOpts) => void; // ensure the singleton People-report drill-down + activate
  // Ensure (and activate) one contributor's activity-feed tab. Keyed per user; `user` is the
  // chip's label metadata, captured at open time from whatever the caller already had.
  openUserActivityTab: (userId: number, user: TabUserMeta | null, opts?: OpenOpts) => void;
  // Ensure (and activate) one review bot's depth drill-down tab. Keyed per bot (users.id);
  // `bot` is the chip/header label metadata, captured at open time from the ROI row.
  openBotDetailTab: (userId: number, bot: TabBotMeta | null, opts?: OpenOpts) => void;

  syncMeta: (meta: TabMeta) => void; // backfill label on every tab with this prId
  closeTab: (key: string) => void; // remove; fall back to 'timeline' if it was active
  moveTab: (key: string, toIndex: number) => void; // drag-reorder; never touches activeTab
  closeOtherTabs: (key: string) => void; // keep only that tab (context menu)
  closeAllTabs: () => void; // remove every dynamic tab (context menu)
  unpin: (id: number) => void; // back-compat: closeTab(prDetailKey(id))

  setActiveTab: (tab: ActiveTab) => void;
  showTimeline: () => void; // idempotent → 'timeline'
  // Navigate to the board for a "Show" from a PR-detail tab. ≡ showTimeline: the back-step it
  // used to push by hand is now the ordinary URL history entry
  // (`view=pr-detail:<id>` → `view=timeline`),
  // so Back returns to the detail tab for free. Kept as its own name because two call sites read
  // as "leave this detail for the board", which is a different intent from a rail click.
  showBoardFromDetail: () => void;
  showActivity: () => void; // idempotent → 'activity'
  /**
   * Seat the tab a URL names (`useUrlState`'s `view=`), on load AND on every browser Back /
   * Forward. `fromPop` distinguishes the two: only a real pop promotes the pending feed
   * return-item into the one-shot flash, so returning to Activity by clicking its chip never
   * flashes a card.
   *
   * ⚠ A `view=pr-detail:<id>` naming a tab THIS BROWSER HAS NEVER SEEN (a shared link, a cleared
   * `pierre:tabs`) is CREATED here with a null meta rather than discarded — PrDetail loads the PR
   * by id and `syncMeta` backfills the chip a moment later. Anything else unrecognised falls back
   * to whatever `landingTabFromUrl` normalised it to; this action never invents a kind.
   */
  applyUrlTab: (tab: ActiveTab, opts?: { fromPop?: boolean }) => void;
  clearActivityFlashItem: () => void; // feed flashed the returned item → forget it
  clear: () => void; // sign-out reset
}

const STORAGE_KEY = 'pierre:tabs';
const LEGACY_KEY = 'pierre:pinnedTabs';

function metaFrom(p: Record<string, unknown>): TabMeta {
  return {
    id: p.id as number,
    number: typeof p.number === 'number' ? p.number : 0,
    title: typeof p.title === 'string' ? p.title : '',
    repoFullName: typeof p.repoFullName === 'string' ? p.repoFullName : '',
    authorLogin: typeof p.authorLogin === 'string' ? p.authorLogin : null,
    authorDisplayName: typeof p.authorDisplayName === 'string' ? p.authorDisplayName : null,
    authorAvatarUrl: typeof p.authorAvatarUrl === 'string' ? p.authorAvatarUrl : null,
  };
}

function loadTabs(): Tab[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .filter(
            (t): t is Record<string, unknown> =>
              t != null && typeof t === 'object' && typeof (t as { key?: unknown }).key === 'string',
          )
          .map((t): Tab | null => {
            const parsedKey = parseTabKey(t.key as string);
            // Drop anything unrecognised (e.g. a legacy transient 'my-turn' key).
            if (!parsedKey) return null;
            return {
              key: t.key as string,
              kind: parsedKey.kind,
              prId: parsedKey.prId,
              meta:
                t.meta != null && typeof t.meta === 'object'
                  ? metaFrom(t.meta as Record<string, unknown>)
                  : null,
            };
          })
          .filter((t): t is Tab => t != null);
      }
    }
    // One-time migration of the old pinned-PR blob → pr-detail tabs.
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const arr: unknown = JSON.parse(legacy);
      if (Array.isArray(arr)) {
        return arr
          .filter(
            (p): p is Record<string, unknown> =>
              p != null && typeof p === 'object' && typeof (p as { id?: unknown }).id === 'number',
          )
          .map((p): Tab => {
            const meta = metaFrom(p);
            return { key: prDetailKey(meta.id), kind: 'pr-detail', prId: meta.id, meta };
          });
      }
    }
  } catch {
    /* ignore */
  }
  return [];
}

function persist(tabs: Tab[]): void {
  try {
    // Only PR-backed tabs persist; the singleton drill-downs (metrics / bot-PRs / open-PRs)
    // are ephemeral.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(tabs.filter((t) => t.kind === 'pr-detail' || t.kind === 'pr-focus')),
    );
  } catch {
    /* quota / private mode — non-fatal, the tabs just won't persist */
  }
}

function sameMeta(a: TabMeta, b: TabMeta): boolean {
  return (
    a.number === b.number &&
    a.title === b.title &&
    a.repoFullName === b.repoFullName &&
    a.authorLogin === b.authorLogin &&
    a.authorDisplayName === b.authorDisplayName &&
    a.authorAvatarUrl === b.authorAvatarUrl
  );
}

export const usePinnedTabs = create<TabsState>((set, get) => {
  // Ensure `tab` exists and activate it. The BROWSER HISTORY ENTRY IS NOT PUSHED HERE any more:
  // `activeTab` is serialized as `view=` (useUrlState), whose navigation-key diff pushes the
  // entry — so a tab open is historied wherever it was launched from, not only from Activity,
  // and Back lands on the URL that produced it rather than on a store flag's idea of "back".
  const openTab = (tab: Tab, opts?: OpenOpts): void => {
    const s = get();
    const fromActivity = opts?.fromActivity ?? s.activeTab === 'activity';
    const exists = s.tabs.some((t) => t.key === tab.key);
    const tabs = exists
      ? s.tabs.map((t) => (t.key === tab.key && tab.meta != null ? { ...t, meta: tab.meta } : t))
      : [...s.tabs, tab];
    if (!exists || tab.meta != null) persist(tabs);
    set({
      tabs,
      activeTab: tab.key,
      // Remember which feed row launched this (latest wins) so Back can flash it; a
      // non-feed Activity open (e.g. a digest #N ref) clears any stale target.
      activityReturnItemId: fromActivity ? (opts?.returnItemId ?? null) : s.activityReturnItemId,
    });
  };

  return {
    tabs: loadTabs(),
    activeTab: 'timeline',
    activityReturnItemId: null,
    activityFlashItemId: null,

    pin: (meta) =>
      set((s) => {
        const key = prDetailKey(meta.id);
        if (s.tabs.some((t) => t.key === key)) return s;
        const tabs = [...s.tabs, { key, kind: 'pr-detail' as const, prId: meta.id, meta }];
        persist(tabs);
        return { tabs };
      }),

    openPrDetailTab: (meta, opts) =>
      openTab({ key: prDetailKey(meta.id), kind: 'pr-detail', prId: meta.id, meta }, opts),
    openPrFocusTab: (meta, opts) =>
      openTab({ key: prFocusKey(meta.id), kind: 'pr-focus', prId: meta.id, meta }, opts),
    openMetricsTab: (opts) =>
      openTab({ key: METRICS_TAB_KEY, kind: 'metrics-detail', prId: 0, meta: null }, opts),
    openBotPrsTab: (opts) =>
      openTab({ key: BOT_PRS_TAB_KEY, kind: 'bot-prs', prId: 0, meta: null }, opts),
    openOpenPrsTab: (opts) =>
      openTab({ key: OPEN_PRS_TAB_KEY, kind: 'open-prs', prId: 0, meta: null }, opts),
    openBotOnlyPrsTab: (opts) =>
      openTab({ key: BOT_ONLY_PRS_TAB_KEY, kind: 'bot-only-prs', prId: 0, meta: null }, opts),
    openBotThreadsTab: (opts) =>
      openTab({ key: BOT_THREADS_TAB_KEY, kind: 'bot-threads', prId: 0, meta: null }, opts),
    openBotFlaggingTab: (opts) =>
      openTab({ key: BOT_FLAGGING_TAB_KEY, kind: 'bot-flagging', prId: 0, meta: null }, opts),
    openBotVolumeTab: (opts) =>
      openTab({ key: BOT_VOLUME_TAB_KEY, kind: 'bot-volume', prId: 0, meta: null }, opts),
    openThemeThreadsTab: (opts) =>
      openTab({ key: THEME_THREADS_TAB_KEY, kind: 'theme-threads', prId: 0, meta: null }, opts),
    openSearchTab: (opts) =>
      openTab({ key: SEARCH_TAB_KEY, kind: 'search', prId: 0, meta: null }, opts),
    openPeopleReportTab: (opts) =>
      openTab({ key: PEOPLE_REPORT_TAB_KEY, kind: 'people-report', prId: 0, meta: null }, opts),
    openUserActivityTab: (userId, user, opts) =>
      openTab(
        {
          key: userActivityKey(userId),
          kind: 'user-activity',
          prId: 0,
          meta: null,
          userMeta: user,
        },
        opts,
      ),
    openBotDetailTab: (userId, bot, opts) =>
      openTab(
        {
          key: botDetailKey(userId),
          kind: 'bot-detail',
          prId: 0,
          meta: null,
          botMeta: bot,
        },
        opts,
      ),

    syncMeta: (meta) =>
      set((s) => {
        let changed = false;
        const tabs = s.tabs.map((t) => {
          // ⚠ A NULL meta is FILLED, not skipped. `applyUrlTab` creates a tab from a `view=pr-detail:<id>`
          // key with no label at all, and the old `t.meta == null → return t` guard left that tab
          // reading "#undefined" forever. Non-PR tabs are excluded by the id compare (their
          // `prId` is 0), which is what that clause was really protecting.
          if (t.prId !== meta.id) return t;
          if (t.meta != null && sameMeta(t.meta, meta)) return t;
          changed = true;
          return { ...t, meta };
        });
        if (!changed) return s;
        persist(tabs);
        return { tabs };
      }),

    closeTab: (key) =>
      set((s) => {
        const idx = s.tabs.findIndex((t) => t.key === key);
        if (idx === -1) return s;
        const tabs = s.tabs.filter((t) => t.key !== key);
        persist(tabs);
        // Closing a non-active tab leaves the active one alone. Closing the ACTIVE tab
        // moves to a logical neighbour rather than snapping back to the board: the tab
        // immediately to its LEFT (still present in `tabs` at idx-1), else the one to its
        // RIGHT (now the leftmost, tabs[0]), else — no dynamic tabs remain — the board.
        if (s.activeTab !== key) return { tabs };
        const nextActive: ActiveTab =
          idx - 1 >= 0
            ? (s.tabs[idx - 1] as Tab).key
            : tabs.length > 0
              ? (tabs[0] as Tab).key
              : 'timeline';
        return { tabs, activeTab: nextActive };
      }),
    // Drag-to-reorder: move a tab to `toIndex` (clamped) in the strip. Pure presentation —
    // it deliberately never touches activeTab.
    moveTab: (key, toIndex) =>
      set((s) => {
        const from = s.tabs.findIndex((t) => t.key === key);
        if (from === -1) return s;
        const to = Math.max(0, Math.min(s.tabs.length - 1, toIndex));
        if (to === from) return s;
        const tabs = [...s.tabs];
        const [moved] = tabs.splice(from, 1);
        tabs.splice(to, 0, moved as Tab);
        persist(tabs);
        return { tabs };
      }),
    closeOtherTabs: (key) =>
      set((s) => {
        const kept = s.tabs.find((t) => t.key === key);
        if (!kept || s.tabs.length <= 1) return s;
        const tabs = [kept];
        persist(tabs);
        // If the active tab was one of the closed dynamic tabs, land on the survivor;
        // the two fixed views (and the survivor itself) stay put.
        const activeTab =
          s.activeTab === 'timeline' || s.activeTab === 'activity' || s.activeTab === key
            ? s.activeTab
            : key;
        return { tabs, activeTab };
      }),
    closeAllTabs: () =>
      set((s) => {
        if (s.tabs.length === 0) return s;
        persist([]);
        // Stay on a fixed view; only fall back to the board when the active tab was one
        // of the dynamic tabs just destroyed (mirrors closeTab's fallback).
        const activeTab =
          s.activeTab === 'timeline' || s.activeTab === 'activity' ? s.activeTab : 'timeline';
        return { tabs: [], activeTab };
      }),
    unpin: (id) => get().closeTab(prDetailKey(id)),

    setActiveTab: (tab) => set({ activeTab: tab }),
    // Idempotent: a no-op when the board is already showing, so the filters store
    // can call it on EVERY timeline-navigation action without churning subscribers.
    showTimeline: () => {
      if (get().activeTab !== 'timeline') set({ activeTab: 'timeline' });
    },
    // ≡ showTimeline. The "Show" back-step is the URL's own entry now: leaving `view=pr-detail:<id>`
    // for `view=timeline` is a navigation-key change, so useUrlState pushes and a browser Back
    // returns to the detail tab without this store remembering anything.
    showBoardFromDetail: () => {
      if (get().activeTab !== 'timeline') set({ activeTab: 'timeline' });
    },
    showActivity: () => {
      if (get().activeTab !== 'activity') set({ activeTab: 'activity' });
    },
    applyUrlTab: (tab, opts) =>
      set((s) => {
        // A tab this browser has no record of (shared link / cleared storage): re-create it from
        // the key alone. The four self-describing kinds can be — the key IS the identity — and a
        // null meta is only a LABEL, which the PR fetch backfills (syncMeta) and the user/bot
        // panels derive from their own roster. Dropping the tab instead would silently redirect a
        // link to the front door. Seed-backed drill-downs are never named by a URL at all.
        const missing = !s.tabs.some((t) => t.key === tab);
        const parsedPr = parseTabKey(tab);
        const newTab: Tab | null =
          !missing
            ? null
            : parsedPr != null
              ? { key: tab, kind: parsedPr.kind, prId: parsedPr.prId, meta: null }
              : parseUserActivityKey(tab) != null
                ? { key: tab, kind: 'user-activity', prId: 0, meta: null, userMeta: null }
                : parseBotDetailKey(tab) != null
                  ? { key: tab, kind: 'bot-detail', prId: 0, meta: null, botMeta: null }
                  : null;
        const tabs = newTab != null ? [...s.tabs, newTab] : s.tabs;
        if (tabs !== s.tabs) persist(tabs);
        // The Back-flash: EXACTLY on a pop that lands on Activity with a launching item pending.
        const flashing =
          opts?.fromPop === true && tab === 'activity' && s.activityReturnItemId != null;
        return {
          tabs,
          activeTab: tab,
          ...(flashing
            ? { activityFlashItemId: s.activityReturnItemId, activityReturnItemId: null }
            : {}),
        };
      }),
    clearActivityFlashItem: () => {
      if (get().activityFlashItemId != null) set({ activityFlashItemId: null });
    },

    clear: () => {
      try {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(LEGACY_KEY);
      } catch {
        /* non-fatal */
      }
      set({
        tabs: [],
        activeTab: 'timeline',
        activityReturnItemId: null,
        activityFlashItemId: null,
      });
    },
  };
});
