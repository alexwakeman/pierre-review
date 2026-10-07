// Open PRs is a FIXED view (Activity · Open PRs · Timeline), not a closable drill-down tab. This
// pins the three things that make it one: the store treats it like the other fixed views (closing
// dynamic tabs never moves you off it, and it never resolves to a board-slot mode), the openers
// reveal it and seed / clear its own repo dropdown, and the chip's count never invents a zero.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { beforeEach, describe, expect, it } from 'vitest';

// The stores touch localStorage at import; give them a throwaway one.
const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

const { FIXED_VIEWS, boardSlotMode, isFixedView, prDetailKey, usePinnedTabs } = await import(
  '../src/store/pinnedTabs.js'
);
const { useFilters } = await import('../src/store/filters.js');
const { openPrsTabCount, openPrsTabLabel } = await import('../src/lib/openPrsTab.js');

const meta = (id: number) => ({
  id,
  number: id,
  title: `PR ${id}`,
  repoFullName: 'acme/web',
  authorLogin: null,
  authorDisplayName: null,
  authorAvatarUrl: null,
});

describe('Open PRs is a fixed view', () => {
  beforeEach(() => {
    usePinnedTabs.getState().clear();
    useFilters.setState({ workspaceId: 5, openPrsRepoFilter: null });
  });

  it('comes FIRST (the default view), before Activity and Timeline', () => {
    expect(FIXED_VIEWS).toEqual(['open-prs', 'activity', 'timeline']);
    expect(isFixedView('open-prs')).toBe(true);
    expect(isFixedView(prDetailKey(1))).toBe(false);
  });

  it('never resolves to a board-slot mode', () => {
    expect(boardSlotMode('open-prs', [])).toBeNull();
  });

  it('closing every dynamic tab keeps you on Open PRs', () => {
    usePinnedTabs.getState().openPrDetailTab(meta(1));
    usePinnedTabs.getState().showOpenPrs();
    usePinnedTabs.getState().closeAllTabs();
    expect(usePinnedTabs.getState().activeTab).toBe('open-prs');
  });

  it('"close others" keeps you on Open PRs', () => {
    usePinnedTabs.getState().openPrDetailTab(meta(1));
    usePinnedTabs.getState().openPrDetailTab(meta(2));
    usePinnedTabs.getState().showOpenPrs();
    usePinnedTabs.getState().closeOtherTabs(prDetailKey(1));
    expect(usePinnedTabs.getState().activeTab).toBe('open-prs');
  });

  it('is not a dynamic tab: opening it adds nothing to the strip', () => {
    useFilters.getState().openOpenPrsDetail();
    expect(usePinnedTabs.getState().activeTab).toBe('open-prs');
    expect(usePinnedTabs.getState().tabs).toEqual([]);
  });
});

describe('the openers and the tab’s repo dropdown', () => {
  beforeEach(() => {
    usePinnedTabs.getState().clear();
    useFilters.setState({ workspaceId: 5, openPrsRepoFilter: null, repoIds: [] });
  });

  it('a per-repo "Show all" footer pre-selects that repo, stamped with the workspace', () => {
    useFilters.getState().openOpenPrsDetail(42);
    expect(useFilters.getState().openPrsRepoFilter).toEqual({ workspaceId: 5, repoIds: [42] });
    expect(usePinnedTabs.getState().activeTab).toBe('open-prs');
  });

  it('the chip and the Flow tile (no argument) clear it', () => {
    useFilters.getState().openOpenPrsDetail(42);
    useFilters.getState().openOpenPrsDetail();
    expect(useFilters.getState().openPrsRepoFilter).toBeNull();
  });

  it('⚠ never touches the Timeline repo picker', () => {
    useFilters.getState().openOpenPrsDetail(42);
    useFilters.getState().setOpenPrsRepoFilter([1, 2]);
    expect(useFilters.getState().repoIds).toEqual([]);
    expect(useFilters.getState().openPrsRepoFilter).toEqual({ workspaceId: 5, repoIds: [1, 2] });
    useFilters.getState().setOpenPrsRepoFilter(null);
    expect(useFilters.getState().openPrsRepoFilter).toBeNull();
  });
});

describe('the chip’s count', () => {
  it('counts NON-DRAFT open PRs', () => {
    const prs = [{ isDraft: false }, { isDraft: true }, { isDraft: false }];
    expect(openPrsTabCount({ prs }, false)).toBe(2);
    expect(openPrsTabLabel(openPrsTabCount({ prs }, false))).toBe('Open PRs · 2');
  });

  it('⚠ unknown is never zero: no answer, or the previous workspace’s placeholder, has no figure', () => {
    expect(openPrsTabCount(undefined, false)).toBeNull();
    expect(openPrsTabCount({ prs: [{ isDraft: false }] }, true)).toBeNull();
    expect(openPrsTabLabel(null)).toBe('Open PRs');
  });

  it('an answered empty workspace is a real 0, and a missing array reads as nothing', () => {
    expect(openPrsTabLabel(openPrsTabCount({ prs: [] }, false))).toBe('Open PRs · 0');
    expect(openPrsTabCount({}, false)).toBe(0);
  });
});
