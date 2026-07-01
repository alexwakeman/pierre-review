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
export type TabKind = 'pr-detail' | 'pr-focus';

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

  pin: (meta: TabMeta) => void; // ensure a pr-detail tab, do NOT activate
  openPrDetailTab: (meta: TabMeta, opts?: OpenOpts) => void; // ensure pr-detail + activate
  openPrFocusTab: (meta: TabMeta, opts?: OpenOpts) => void; // ensure pr-focus + activate

  syncMeta: (meta: TabMeta) => void; // backfill label on every tab with this prId
  closeTab: (key: string) => void; // remove; fall back to 'timeline' if it was active
  unpin: (id: number) => void; // back-compat: closeTab(prDetailKey(id))

  setActiveTab: (tab: ActiveTab) => void;
  showTimeline: () => void; // idempotent → 'timeline'
  showActivity: () => void; // idempotent → 'activity'
  consumeActivityReturn: () => void; // browser popped our {pierreTab} entry → return to Activity
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tabs));
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
    });
  };

  return {
    tabs: loadTabs(),
    activeTab: 'timeline',
    activityReturnArmed: false,
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
    unpin: (id) => get().closeTab(prDetailKey(id)),

    setActiveTab: (tab) => set({ activeTab: tab }),
    // Idempotent: a no-op when the board is already showing, so the filters store
    // can call it on EVERY timeline-navigation action without churning subscribers.
    showTimeline: () => {
      if (get().activeTab !== 'timeline') set({ activeTab: 'timeline' });
    },
    showActivity: () => {
      if (get().activeTab !== 'activity') set({ activeTab: 'activity' });
    },
    // The browser popped the {pierreTab} entry we pushed on an Activity-launched open →
    // return to the Activity console and disarm. A no-op if no entry was outstanding.
    // PROMOTE the pending return-item into the one-shot flash signal (and clear the pending
    // one) so the feed flashes it EXACTLY on this Back — never on an ordinary return to
    // Activity (e.g. clicking the Activity tab chip, which doesn't call this).
    consumeActivityReturn: () => {
      const s = get();
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
      });
    },
  };
});
