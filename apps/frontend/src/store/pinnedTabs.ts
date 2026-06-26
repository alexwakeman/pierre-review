import { create } from 'zustand';

// Lightweight metadata captured when a PR is pinned, so the tab can render its
// label (title + author) without re-fetching the full PR detail on every load.
// The full detail is still fetched (and IndexedDB-cached) when the tab is opened.
export interface PinnedPr {
  id: number;
  number: number;
  title: string;
  repoFullName: string;
  authorLogin: string | null;
  authorDisplayName: string | null;
  authorAvatarUrl: string | null;
}

// Which "tab" the main area is showing: the standard timeline board, or a pinned
// PR rendered full-screen (by its PR id).
export type ActiveTab = 'timeline' | number;

interface PinnedTabsState {
  // The pinned PRs, in pin order — each becomes a tab under the Open-PRs strip.
  // Persisted to localStorage so the tabs survive a reload (they stay until the
  // user removes them).
  pinned: PinnedPr[];
  // The currently-shown tab. NOT persisted: a fresh load always lands on the
  // timeline (matching the app's "fresh load = the board" philosophy); the pinned
  // tabs themselves reappear, but the board is shown first.
  activeTab: ActiveTab;

  // Pin a PR (add its tab). No-op if already pinned. Does NOT switch to it — pinning
  // just creates the tab; the user clicks the tab to open the full-screen view.
  pin: (pr: PinnedPr) => void;
  // Remove a PR's tab. If it was the active tab, fall back to the timeline.
  unpin: (id: number) => void;
  // Refresh a pinned tab's label from fresh PR detail (e.g. a renamed PR). No-op
  // when the PR isn't pinned or nothing changed, so it's safe to call from an effect.
  syncMeta: (pr: PinnedPr) => void;
  setActiveTab: (tab: ActiveTab) => void;
  showTimeline: () => void;
  // Drop all pins (and the persisted blob). Called on cloud sign-out so one user's
  // pinned PRs — which carry account-scoped ids + titles/authors — don't leak to the
  // next user on a shared browser.
  clear: () => void;
}

const STORAGE_KEY = 'pierre:pinnedTabs';

function loadPinned(): PinnedPr[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive: keep only well-formed entries (an old/partial blob shouldn't crash
    // the bar). Coerce the optional author fields to the null contract.
    return parsed
      .filter(
        (p): p is Record<string, unknown> =>
          p != null &&
          typeof p === 'object' &&
          typeof (p as { id?: unknown }).id === 'number' &&
          typeof (p as { number?: unknown }).number === 'number' &&
          typeof (p as { title?: unknown }).title === 'string',
      )
      .map((p) => ({
        id: p.id as number,
        number: p.number as number,
        title: p.title as string,
        repoFullName: typeof p.repoFullName === 'string' ? p.repoFullName : '',
        authorLogin: typeof p.authorLogin === 'string' ? p.authorLogin : null,
        authorDisplayName:
          typeof p.authorDisplayName === 'string' ? p.authorDisplayName : null,
        authorAvatarUrl: typeof p.authorAvatarUrl === 'string' ? p.authorAvatarUrl : null,
      }));
  } catch {
    return [];
  }
}

function persist(pinned: PinnedPr[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pinned));
  } catch {
    /* quota / private mode — non-fatal, the tabs just won't persist */
  }
}

function sameMeta(a: PinnedPr, b: PinnedPr): boolean {
  return (
    a.number === b.number &&
    a.title === b.title &&
    a.repoFullName === b.repoFullName &&
    a.authorLogin === b.authorLogin &&
    a.authorDisplayName === b.authorDisplayName &&
    a.authorAvatarUrl === b.authorAvatarUrl
  );
}

export const usePinnedTabs = create<PinnedTabsState>((set, get) => ({
  pinned: loadPinned(),
  activeTab: 'timeline',

  pin: (pr) =>
    set((s) => {
      if (s.pinned.some((p) => p.id === pr.id)) return s; // already pinned
      const pinned = [...s.pinned, pr];
      persist(pinned);
      return { pinned };
    }),

  unpin: (id) =>
    set((s) => {
      if (!s.pinned.some((p) => p.id === id)) return s;
      const pinned = s.pinned.filter((p) => p.id !== id);
      persist(pinned);
      return {
        pinned,
        activeTab: s.activeTab === id ? 'timeline' : s.activeTab,
      };
    }),

  syncMeta: (pr) =>
    set((s) => {
      const idx = s.pinned.findIndex((p) => p.id === pr.id);
      if (idx === -1) return s;
      const cur = s.pinned[idx];
      if (cur == null || sameMeta(cur, pr)) return s;
      const pinned = s.pinned.slice();
      pinned[idx] = pr;
      persist(pinned);
      return { pinned };
    }),

  setActiveTab: (tab) => set({ activeTab: tab }),
  // Idempotent: a no-op when the board is already showing, so the filters store can
  // call it on EVERY timeline-navigation action without churning subscribers when no
  // pinned tab is open (the common case).
  showTimeline: () => {
    if (get().activeTab !== 'timeline') set({ activeTab: 'timeline' });
  },

  clear: () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* non-fatal */
    }
    set({ pinned: [], activeTab: 'timeline' });
  },
}));
