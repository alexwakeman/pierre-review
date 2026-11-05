// PINNED TABS (docs/FRONTEND.md § Pinned tabs): browser-style. A pinned tab cannot be closed (no ✕,
// `closeTab` refuses it), survives Close other / Close all, sits before every unpinned tab, and
// persists across a reload — PR, story and build tabs only (`canPinTab`); the seed-only drill-downs
// never pin. A NEW build tab opens pinned and stays so until the reader unpins it.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/pinnedTabsPin.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

type Store = typeof import('../src/store/pinnedTabs.js');
const mod: Store = await import('../src/store/pinnedTabs.js');
const { BOT_PRS_TAB_KEY, canPinTab, prDetailKey, prFocusKey, storyBuildTabKey, ticketTabKey, usePinnedTabs } = mod;

/** A fresh module instance — what a reload does: `loadTabs()` runs again over localStorage. */
async function reload(): Promise<Store> {
  vi.resetModules();
  return import('../src/store/pinnedTabs.js');
}

const meta = (id: number) => ({
  id,
  number: id,
  title: `PR ${id}`,
  repoFullName: 'acme/web',
  authorLogin: null,
  authorDisplayName: null,
  authorAvatarUrl: null,
});
const IDENT = 'jira:https://acme.atlassian.net#PLAT-310';

const s = () => usePinnedTabs.getState();
const keys = () => s().tabs.map((t) => t.key);

beforeEach(() => {
  mem.clear();
  s().clear();
});

describe('pinning', () => {
  it('only PR, story and build tabs can be pinned', () => {
    for (const kind of ['pr-detail', 'pr-focus', 'ticket', 'story-build'] as const) expect(canPinTab({ kind })).toBe(true);
    for (const kind of ['bot-prs', 'metrics-detail', 'search', 'bot-flagging', 'user-activity'] as const)
      expect(canPinTab({ kind })).toBe(false);
    s().openBotPrsTab();
    s().togglePinTab(BOT_PRS_TAB_KEY);
    expect(s().tabs[0]?.pinned).toBeUndefined();
  });

  it('a pinned tab moves to the end of the pinned group; unpinning puts it first among the rest', () => {
    s().openPrDetailTab(meta(1));
    s().openPrDetailTab(meta(2));
    s().openPrDetailTab(meta(3));
    s().togglePinTab(prDetailKey(3));
    expect(keys()).toEqual([prDetailKey(3), prDetailKey(1), prDetailKey(2)]);
    s().togglePinTab(prDetailKey(2));
    expect(keys()).toEqual([prDetailKey(3), prDetailKey(2), prDetailKey(1)]);
    s().togglePinTab(prDetailKey(3));
    expect(keys()).toEqual([prDetailKey(2), prDetailKey(3), prDetailKey(1)]);
    expect(s().tabs.map((t) => t.pinned === true)).toEqual([true, false, false]);
  });

  it('a new tab opens after the unpinned ones, never among the pinned', () => {
    s().openPrDetailTab(meta(1));
    s().togglePinTab(prDetailKey(1));
    s().openPrDetailTab(meta(2));
    expect(keys()).toEqual([prDetailKey(1), prDetailKey(2)]);
  });

  it('a drag never crosses the pinned / unpinned line', () => {
    s().openPrDetailTab(meta(1));
    s().openPrDetailTab(meta(2));
    s().openPrDetailTab(meta(3));
    s().togglePinTab(prDetailKey(1));
    s().moveTab(prDetailKey(3), 0);
    expect(keys()).toEqual([prDetailKey(1), prDetailKey(3), prDetailKey(2)]);
    s().moveTab(prDetailKey(1), 2);
    expect(keys()).toEqual([prDetailKey(1), prDetailKey(3), prDetailKey(2)]);
  });
});

describe('closing around pinned tabs', () => {
  it('closeTab refuses a pinned tab', () => {
    s().openPrDetailTab(meta(1));
    s().togglePinTab(prDetailKey(1));
    s().closeTab(prDetailKey(1));
    expect(keys()).toEqual([prDetailKey(1)]);
    expect(s().activeTab).toBe(prDetailKey(1));
  });

  it('Close all keeps pinned tabs; from a closed tab it lands on Activity', () => {
    s().openPrDetailTab(meta(1));
    s().openPrDetailTab(meta(2));
    s().togglePinTab(prDetailKey(1));
    s().setActiveTab(prDetailKey(2));
    s().closeAllTabs();
    expect(keys()).toEqual([prDetailKey(1)]);
    expect(s().activeTab).toBe('activity');
  });

  it('Close all from a pinned tab stays on it', () => {
    s().openPrDetailTab(meta(1));
    s().openPrDetailTab(meta(2));
    s().togglePinTab(prDetailKey(2));
    s().closeAllTabs();
    expect(keys()).toEqual([prDetailKey(2)]);
    expect(s().activeTab).toBe(prDetailKey(2));
  });

  it('Close all with only pinned tabs is a no-op', () => {
    s().openPrDetailTab(meta(1));
    s().togglePinTab(prDetailKey(1));
    const before = s().tabs;
    s().closeAllTabs();
    expect(s().tabs).toBe(before);
  });

  it('Close other tabs keeps the named tab and the pinned ones', () => {
    s().openPrDetailTab(meta(1));
    s().openPrDetailTab(meta(2));
    s().openPrDetailTab(meta(3));
    s().togglePinTab(prDetailKey(1));
    s().setActiveTab(prDetailKey(2));
    s().closeOtherTabs(prDetailKey(3));
    expect(keys()).toEqual([prDetailKey(1), prDetailKey(3)]);
    expect(s().activeTab).toBe(prDetailKey(3));
  });

  it('closing the active unpinned tab next to a pinned one lands on its left neighbour', () => {
    s().openPrDetailTab(meta(1));
    s().openPrDetailTab(meta(2));
    s().togglePinTab(prDetailKey(1));
    s().closeTab(prDetailKey(2));
    expect(s().activeTab).toBe(prDetailKey(1));
  });
});

describe('the build tab opens pinned', () => {
  it('a new build tab is pinned and placed with the pinned', () => {
    s().openPrDetailTab(meta(1));
    s().openStoryBuildTab({ ident: IDENT, key: 'PLAT-310', title: 'Export' });
    expect(keys()).toEqual([storyBuildTabKey(IDENT), prDetailKey(1)]);
    expect(s().tabs[0]?.pinned).toBe(true);
    s().closeAllTabs();
    expect(keys()).toEqual([storyBuildTabKey(IDENT)]);
  });

  it('re-opening keeps the reader’s choice: once unpinned it stays unpinned', () => {
    s().openStoryBuildTab({ ident: IDENT, key: 'PLAT-310', title: 'Export' });
    s().togglePinTab(storyBuildTabKey(IDENT));
    s().openStoryBuildTab({ ident: IDENT, key: 'PLAT-310', title: 'Export' });
    expect(s().tabs).toHaveLength(1);
    expect(s().tabs[0]?.pinned).toBeUndefined();
  });
});

describe('a reload', () => {
  it('keeps pinned PR, story and build tabs with their flag and words, and drops unpinned story tabs', async () => {
    s().openPrDetailTab(meta(1));
    s().openPrFocusTab(meta(2));
    s().togglePinTab(prFocusKey(2));
    s().openTicketTab({ ident: IDENT, key: 'PLAT-310', title: 'Export' });
    s().togglePinTab(ticketTabKey(IDENT));
    s().openTicketTab({ ident: 'jira:https://acme.atlassian.net#PLAT-9', key: 'PLAT-9', title: null });
    s().openStoryBuildTab({ ident: IDENT, key: 'PLAT-310', title: 'Export', buildOffer: { action: 'fill_gaps', reviewId: 7 } });
    s().openBotPrsTab();

    const fresh = (await reload()).usePinnedTabs.getState();
    expect(fresh.tabs.map((t) => [t.key, t.pinned === true])).toEqual([
      [prFocusKey(2), true],
      [ticketTabKey(IDENT), true],
      [storyBuildTabKey(IDENT), true],
      [prDetailKey(1), false],
    ]);
    expect(fresh.tabs[1]?.ticketMeta).toEqual({ ident: IDENT, key: 'PLAT-310', title: 'Export' });
    expect(fresh.tabs[2]?.kind).toBe('story-build');
    expect(fresh.tabs[2]?.ticketMeta?.buildOffer).toEqual({ action: 'fill_gaps', reviewId: 7 });
  });

  it('a stored pinned key of an unknown kind is dropped, and a bad label falls back to the key', async () => {
    mem.set(
      'pierre:tabs',
      JSON.stringify([
        { key: 'bot-prs', kind: 'bot-prs', prId: 0, meta: null, pinned: true },
        { key: storyBuildTabKey(IDENT), pinned: true, ticketMeta: { key: 42, title: ['x'] } },
      ]),
    );
    const fresh = (await reload()).usePinnedTabs.getState();
    expect(fresh.tabs).toHaveLength(1);
    expect(fresh.tabs[0]?.ticketMeta).toEqual({ ident: IDENT, key: 'PLAT-310', title: null });
  });
});
