// Open PRs is Activity's FIRST rail line and the default (`activityRepoId: 'open-prs'`), no longer
// a fixed tab of its own. This pins: the fixed views are Activity · Timeline; the openers reveal
// Activity → Open PRs and seed / clear its own repo dropdown; and the count never invents a zero.
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

const { FIXED_VIEWS, isFixedView, prDetailKey, usePinnedTabs } = await import(
  '../src/store/pinnedTabs.js'
);
const { useFilters, freshUrlOwnedDefaults } = await import('../src/store/filters.js');
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

describe('Open PRs is an Activity rail line', () => {
  beforeEach(() => {
    usePinnedTabs.getState().clear();
    useFilters.setState({ workspaceId: 5, openPrsRepoFilter: null, activityRepoId: 'feed' });
  });

  it('is not a fixed view: those are Activity then Timeline', () => {
    expect(FIXED_VIEWS).toEqual(['activity', 'timeline']);
    expect(isFixedView('open-prs')).toBe(false);
    expect(isFixedView(prDetailKey(1))).toBe(false);
  });

  it('is the default rail line', () => {
    expect(freshUrlOwnedDefaults().activityRepoId).toBe('open-prs');
  });

  it('opening it shows Activity on the Open PRs line and adds nothing to the strip', () => {
    usePinnedTabs.setState({ activeTab: 'timeline' });
    useFilters.getState().openOpenPrsDetail();
    expect(usePinnedTabs.getState().activeTab).toBe('activity');
    expect(useFilters.getState().activityRepoId).toBe('open-prs');
    expect(usePinnedTabs.getState().tabs).toEqual([]);
  });

  it('closing every dynamic tab keeps you on Activity', () => {
    usePinnedTabs.getState().openPrDetailTab(meta(1));
    useFilters.getState().openOpenPrsDetail();
    usePinnedTabs.getState().closeAllTabs();
    expect(usePinnedTabs.getState().activeTab).toBe('activity');
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
    expect(usePinnedTabs.getState().activeTab).toBe('activity');
    expect(useFilters.getState().activityRepoId).toBe('open-prs');
  });

  it('the rail line and the Flow tile (no argument) clear it', () => {
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

describe('the rail line’s count', () => {
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
