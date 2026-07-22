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
export type TabKind =
  | 'pr-detail'
  | 'pr-focus'
  | 'metrics-detail'
  | 'bot-prs'
  | 'open-prs'
  | 'bot-only-prs'
  | 'bot-threads'
  | 'theme-threads';

export interface Tab {
  key: string; // stable: 'pr-detail:123' | 'pr-focus:123'
  kind: TabKind;
  prId: number; // PR id for pr-detail / pr-focus
  meta: TabMeta | null; // label meta for PR tabs
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
// The theme-threads drill-down is a SINGLETON, non-PR tab: it lists all the review threads / PR
// comments a Bot/Human theme groups. The theme itself is the transient seed (store/filters.ts
// `themeThreadsSeed`), not the key. EPHEMERAL like the others (dropped on reload).
export const THEME_THREADS_TAB_KEY = 'theme-threads';

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
  activeTab: ActiveTab; // NOT persisted (fresh load 'timeline'; useUrlState → 'activity')
  // True while an Activity-launched navigation session has ONE pushed {pierreTab} history
  // entry outstanding, so a browser Back returns to the Activity console. Deduped: opening
  // further tabs from Activity reuses the single entry rather than stacking orphans.
  activityReturnArmed: boolean;
  // The feed item id a browser-Back should scroll-to + flash. Two fields so the flash fires
  // ONLY on a real Back, never on an ordinary return to Activity (e.g. clicking the Activity
  // tab chip): `activityReturnItemId` is the PENDING target (set on an Activity-launched
  // open); `consumeActivityReturn` promotes it into the one-shot `activityFlashItemId` (the
  // signal the feed view consumes) only when the {pierreTab} entry is actually popped.
  activityReturnItemId: string | null;
  activityFlashItemId: string | null;
  // Second history level (the "Show" back-step): when a board-"Show" is launched FROM an
  // Activity-opened pr-detail tab, we push an extra {pierreTab} entry and remember the tab
  // here, so a browser Back returns to that detail tab (NOT all the way to the feed). A
  // second Back then pops the outer entry → the Activity console. null when no back-step is
  // outstanding. Deduped: reused rather than restacked.
  boardReturnTabKey: string | null;

  pin: (meta: TabMeta) => void; // ensure a pr-detail tab, do NOT activate
  openPrDetailTab: (meta: TabMeta, opts?: OpenOpts) => void; // ensure pr-detail + activate
  openPrFocusTab: (meta: TabMeta, opts?: OpenOpts) => void; // ensure pr-focus + activate
  openMetricsTab: (opts?: OpenOpts) => void; // ensure the singleton metrics drill-down + activate
  openBotPrsTab: (opts?: OpenOpts) => void; // ensure the singleton bot-vendor PR drill-down + activate
  openOpenPrsTab: (opts?: OpenOpts) => void; // ensure the singleton all-open-PRs drill-down + activate
  openBotOnlyPrsTab: (opts?: OpenOpts) => void; // ensure the singleton bot-only-PRs drill-down + activate
  openBotThreadsTab: (opts?: OpenOpts) => void; // ensure the singleton bot-threads resolve tab + activate
  openThemeThreadsTab: (opts?: OpenOpts) => void; // ensure the singleton theme-threads drill-down + activate

  syncMeta: (meta: TabMeta) => void; // backfill label on every tab with this prId
  closeTab: (key: string) => void; // remove; fall back to 'timeline' if it was active
  unpin: (id: number) => void; // back-compat: closeTab(prDetailKey(id))

  setActiveTab: (tab: ActiveTab) => void;
  showTimeline: () => void; // idempotent → 'timeline'
  // Navigate to the board for a "Show", pushing a back-step to the current detail tab when
  // it was Activity-launched (so Back returns here, not to the feed). Otherwise ≡ showTimeline.
  showBoardFromDetail: () => void;
  showActivity: () => void; // idempotent → 'activity'
  // Handle a browser Back: first the "Show" back-step (→ the remembered detail tab), then the
  // Activity-return level (→ the feed, flashing the launching item). A no-op if neither armed.
  navigateBack: () => void;
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
  // Ensure `tab` exists, activate it, and (if opened from Activity) push a single
  // browser-history entry so Back returns to the Activity console. Deduped: if an
  // Activity-return entry is already outstanding, reuse it instead of stacking a second
  // (which would leave an orphan that makes a later Back an inert no-op).
  const openTab = (tab: Tab, opts?: OpenOpts): void => {
    const s = get();
    const fromActivity = opts?.fromActivity ?? s.activeTab === 'activity';
    const exists = s.tabs.some((t) => t.key === tab.key);
    const tabs = exists
      ? s.tabs.map((t) => (t.key === tab.key && tab.meta != null ? { ...t, meta: tab.meta } : t))
      : [...s.tabs, tab];
    if (fromActivity && !s.activityReturnArmed) {
      try {
        history.pushState({ pierreTab: 1 }, '');
      } catch {
        /* non-fatal */
      }
    }
    if (!exists || tab.meta != null) persist(tabs);
    set({
      tabs,
      activeTab: tab.key,
      activityReturnArmed: fromActivity || s.activityReturnArmed,
      // Remember which feed row launched this (latest wins) so Back can flash it; a
      // non-feed Activity open (e.g. a digest #N ref) clears any stale target.
      activityReturnItemId: fromActivity ? (opts?.returnItemId ?? null) : s.activityReturnItemId,
      // A fresh Activity-launched open starts a NEW navigation session, so drop any
      // dangling "Show" back-step from a previous one (e.g. returning to Activity via the
      // tab chip after a Show, then opening another feed card). Leaving it set would make a
      // browser Back detour through that stale detail tab instead of returning to the feed.
      // navigateBack then falls straight through to the armed Activity-return level; the old
      // pushed entry becomes a benign orphan.
      boardReturnTabKey: fromActivity ? null : s.boardReturnTabKey,
    });
  };

  return {
    tabs: loadTabs(),
    activeTab: 'timeline',
    activityReturnArmed: false,
    activityReturnItemId: null,
    activityFlashItemId: null,
    boardReturnTabKey: null,

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
    openThemeThreadsTab: (opts) =>
      openTab({ key: THEME_THREADS_TAB_KEY, kind: 'theme-threads', prId: 0, meta: null }, opts),

    syncMeta: (meta) =>
      set((s) => {
        let changed = false;
        const tabs = s.tabs.map((t) => {
          if (t.prId !== meta.id || t.meta == null) return t;
          if (sameMeta(t.meta, meta)) return t;
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
        // Forget a "Show" back-step that pointed at the tab just closed (navigateBack would
        // otherwise fall back to the board — harmless, but clearer to drop it now).
        const boardReturnTabKey = s.boardReturnTabKey === key ? null : s.boardReturnTabKey;
        // Closing a non-active tab leaves the active one alone. Closing the ACTIVE tab
        // moves to a logical neighbour rather than snapping back to the board: the tab
        // immediately to its LEFT (still present in `tabs` at idx-1), else the one to its
        // RIGHT (now the leftmost, tabs[0]), else — no dynamic tabs remain — the board.
        if (s.activeTab !== key) return { tabs, boardReturnTabKey };
        const nextActive: ActiveTab =
          idx - 1 >= 0
            ? (s.tabs[idx - 1] as Tab).key
            : tabs.length > 0
              ? (tabs[0] as Tab).key
              : 'timeline';
        return { tabs, activeTab: nextActive, boardReturnTabKey };
      }),
    unpin: (id) => get().closeTab(prDetailKey(id)),

    setActiveTab: (tab) => set({ activeTab: tab }),
    // Idempotent: a no-op when the board is already showing, so the filters store
    // can call it on EVERY timeline-navigation action without churning subscribers.
    showTimeline: () => {
      if (get().activeTab !== 'timeline') set({ activeTab: 'timeline' });
    },
    showBoardFromDetail: () => {
      const s = get();
      const parsed = parseTabKey(s.activeTab);
      const onActivityDetail =
        parsed?.kind === 'pr-detail' && s.activityReturnArmed && s.boardReturnTabKey == null;
      if (onActivityDetail) {
        // Push the inner back-step so a browser Back returns to THIS detail tab; the outer
        // {pierreTab} entry (pushed when the feed opened it) then returns to the feed.
        try {
          history.pushState({ pierreTab: 1 }, '');
        } catch {
          /* non-fatal */
        }
        set({ activeTab: 'timeline', boardReturnTabKey: s.activeTab });
        return;
      }
      if (s.activeTab !== 'timeline') set({ activeTab: 'timeline' });
    },
    showActivity: () => {
      if (get().activeTab !== 'activity') set({ activeTab: 'activity' });
    },
    // The browser popped the {pierreTab} entry we pushed on an Activity-launched open →
    // return to the Activity console and disarm. A no-op if no entry was outstanding.
    // PROMOTE the pending return-item into the one-shot flash signal (and clear the pending
    // one) so the feed flashes it EXACTLY on this Back — never on an ordinary return to
    // Activity (e.g. clicking the Activity tab chip, which doesn't call this).
    navigateBack: () => {
      const s = get();
      // Inner level first: the "Show" back-step → the remembered detail tab (or the board
      // if it was closed meanwhile). Consumes only this level; a further Back handles the
      // Activity-return entry below.
      if (s.boardReturnTabKey != null) {
        const exists = s.tabs.some((t) => t.key === s.boardReturnTabKey);
        set({ activeTab: exists ? s.boardReturnTabKey : 'timeline', boardReturnTabKey: null });
        return;
      }
      // Outer level: the Activity-launched entry → the feed, flashing the launching item.
      if (!s.activityReturnArmed) return;
      set({
        activeTab: 'activity',
        activityReturnArmed: false,
        activityFlashItemId: s.activityReturnItemId,
        activityReturnItemId: null,
      });
    },
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
        activityReturnArmed: false,
        activityReturnItemId: null,
        activityFlashItemId: null,
        boardReturnTabKey: null,
      });
    },
  };
});
