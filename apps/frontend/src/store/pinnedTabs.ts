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
//  - my-turn:   the My Turn triage set as its OWN isolated Timeline instance
export type TabKind = 'pr-detail' | 'pr-focus' | 'my-turn';

export interface Tab {
  key: string; // stable: 'pr-detail:123' | 'pr-focus:123' | 'my-turn'
  kind: TabKind;
  prId: number | null; // PR id for pr-detail/pr-focus; null for my-turn
  meta: TabMeta | null; // label meta for PR tabs; null for my-turn
}

// Which "tab" the main area is showing: the standard timeline board, the Inbox
// triage console, or one of the persistent tabs identified by its `Tab.key`.
// These are ONE axis — only one renders at a time.
export type ActiveTab = 'timeline' | 'inbox' | string;

// Contract with the Timeline component: the board slot passes this to
// `<Timeline mode={…}/>`. Absent = today's full shared board.
export type TimelineMode = { kind: 'isolate'; prId: number } | { kind: 'my-turn' };

export const MY_TURN_KEY = 'my-turn';
export const prDetailKey = (id: number): string => `pr-detail:${id}`;
export const prFocusKey = (id: number): string => `pr-focus:${id}`;

/** Parse a Tab.key back into its kind + PR id (null for unknown / my-turn). */
export function parseTabKey(key: string): { kind: TabKind; prId: number | null } | null {
  if (key === MY_TURN_KEY) return { kind: 'my-turn', prId: null };
  const m = /^(pr-detail|pr-focus):(\d+)$/.exec(key);
  return m ? { kind: m[1] as TabKind, prId: Number(m[2]) } : null;
}

interface OpenOpts {
  // Force the Back-to-Inbox history entry. When omitted it is inferred from the
  // active tab at open time (opening any tab while the Inbox is showing arms it).
  fromInbox?: boolean;
}

interface TabsState {
  tabs: Tab[]; // ordered; pr-detail + pr-focus persisted (my-turn is transient)
  activeTab: ActiveTab; // NOT persisted (fresh load 'timeline'; useUrlState → 'inbox')
  // True while an Inbox-launched navigation session has ONE pushed {pierreTab} history
  // entry outstanding, so a browser Back returns to the Inbox (item 4). Deduped: opening
  // further tabs from the Inbox reuses the single entry rather than stacking orphans.
  inboxReturnArmed: boolean;

  pin: (meta: TabMeta) => void; // ensure a pr-detail tab, do NOT activate
  openPrDetailTab: (meta: TabMeta, opts?: OpenOpts) => void; // ensure pr-detail + activate
  openPrFocusTab: (meta: TabMeta, opts?: OpenOpts) => void; // ensure pr-focus + activate
  openMyTurnTab: (opts?: OpenOpts) => void; // ensure my-turn + activate

  syncMeta: (meta: TabMeta) => void; // backfill label on every tab with this prId
  closeTab: (key: string) => void; // remove; fall back to 'timeline' if it was active
  unpin: (id: number) => void; // back-compat: closeTab(prDetailKey(id))

  setActiveTab: (tab: ActiveTab) => void;
  showTimeline: () => void; // idempotent → 'timeline'
  showInbox: () => void; // idempotent → 'inbox'
  consumeInboxReturn: () => void; // browser popped our {pierreTab} entry → return to Inbox
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
            // my-turn is transient and never persisted; drop anything unrecognised.
            if (!parsedKey || parsedKey.kind === 'my-turn') return null;
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

// my-turn is transient → never persisted.
function persist(tabs: Tab[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tabs.filter((t) => t.kind !== 'my-turn')));
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
  // Ensure `tab` exists, activate it, and (if opened from the Inbox) push a single
  // browser-history entry so Back returns to the Inbox (item 4). Deduped: if an
  // Inbox-return entry is already outstanding, reuse it instead of stacking a second
  // (which would leave an orphan that makes a later Back an inert no-op).
  const openTab = (tab: Tab, opts?: OpenOpts): void => {
    const s = get();
    const fromInbox = opts?.fromInbox ?? s.activeTab === 'inbox';
    const exists = s.tabs.some((t) => t.key === tab.key);
    const tabs = exists
      ? s.tabs.map((t) => (t.key === tab.key && tab.meta != null ? { ...t, meta: tab.meta } : t))
      : [...s.tabs, tab];
    if (fromInbox && !s.inboxReturnArmed) {
      try {
        history.pushState({ pierreTab: 1 }, '');
      } catch {
        /* non-fatal */
      }
    }
    if (!exists || tab.meta != null) persist(tabs);
    set({ tabs, activeTab: tab.key, inboxReturnArmed: fromInbox || s.inboxReturnArmed });
  };

  return {
    tabs: loadTabs(),
    activeTab: 'timeline',
    inboxReturnArmed: false,

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
    openMyTurnTab: (opts) =>
      openTab({ key: MY_TURN_KEY, kind: 'my-turn', prId: null, meta: null }, opts),

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
        if (!s.tabs.some((t) => t.key === key)) return s;
        const tabs = s.tabs.filter((t) => t.key !== key);
        persist(tabs);
        return {
          tabs,
          activeTab: s.activeTab === key ? 'timeline' : s.activeTab,
        };
      }),
    unpin: (id) => get().closeTab(prDetailKey(id)),

    setActiveTab: (tab) => set({ activeTab: tab }),
    // Idempotent: a no-op when the board is already showing, so the filters store
    // can call it on EVERY timeline-navigation action without churning subscribers.
    showTimeline: () => {
      if (get().activeTab !== 'timeline') set({ activeTab: 'timeline' });
    },
    showInbox: () => {
      if (get().activeTab !== 'inbox') set({ activeTab: 'inbox' });
    },
    // The browser popped the {pierreTab} entry we pushed on an Inbox-launched open →
    // return to the Inbox and disarm. A no-op if no entry was outstanding.
    consumeInboxReturn: () => {
      if (get().inboxReturnArmed) set({ activeTab: 'inbox', inboxReturnArmed: false });
    },

    clear: () => {
      try {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(LEGACY_KEY);
      } catch {
        /* non-fatal */
      }
      set({ tabs: [], activeTab: 'timeline', inboxReturnArmed: false });
    },
  };
});
