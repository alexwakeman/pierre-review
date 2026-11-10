// SETTINGS → FEATURES → TIMELINE: off by default, and off means OFF (shared features.ts;
// docs/FRONTEND.md § Features shown). With it off there is no board and no Focus tab:
//  - `view=timeline` lands on the default view, `view=pr-focus:<id>` on that PR's detail tab;
//  - a stored Focus tab becomes a detail tab (pinning kept, no duplicate);
//  - `g t`, ⌘K and the sidebar offer nothing; "Focus" opens the detail tab;
//  - unknown (`timelineOn: null`, /api/me not answered yet) gates nothing.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveFeatures } from '@pierre-review/shared';

const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

const { focusTabsAsDetail, gateTimelineTab, prDetailKey, prFocusKey, usePinnedTabs } = await import(
  '../src/store/pinnedTabs.js'
);
const { DESTINATIONS, goTo, isDestinationShown } = await import('../src/components/shell/nav.js');

const meta = (id: number) => ({
  id,
  number: id,
  title: `PR ${id}`,
  repoFullName: 'acme/web',
  authorLogin: null,
  authorDisplayName: null,
  authorAvatarUrl: null,
});
const tabs = () => usePinnedTabs.getState();

beforeEach(() => {
  mem.clear();
  usePinnedTabs.setState({ tabs: [], activeTab: 'activity', timelineOn: null });
});

describe('gateTimelineTab', () => {
  it('changes nothing while the Timeline is on or not known yet', () => {
    for (const on of [true, null]) {
      expect(gateTimelineTab('timeline', [], on)).toBe('timeline');
      expect(gateTimelineTab(prFocusKey(7), [], on)).toBe(prFocusKey(7));
    }
  });
  it('off: the board is the default view, a Focus tab is the detail tab, a stale key is the default view', () => {
    expect(gateTimelineTab('timeline', [], false)).toBe('activity');
    expect(gateTimelineTab(prFocusKey(7), [], false)).toBe(prDetailKey(7));
    expect(gateTimelineTab('user-activity:9', [], false)).toBe('activity');
    expect(gateTimelineTab('sprint', [], false)).toBe('sprint');
    expect(gateTimelineTab(prDetailKey(3), [], false)).toBe(prDetailKey(3));
  });
});

describe('focusTabsAsDetail', () => {
  it('keeps order and pinning, and never leaves two tabs for one PR', () => {
    const out = focusTabsAsDetail([
      { key: prDetailKey(1), kind: 'pr-detail', prId: 1, meta: meta(1) },
      { key: prFocusKey(1), kind: 'pr-focus', prId: 1, meta: meta(1), pinned: true },
      { key: prFocusKey(2), kind: 'pr-focus', prId: 2, meta: meta(2) },
    ]);
    expect(out.map((t) => [t.key, t.pinned === true])).toEqual([
      [prDetailKey(1), true],
      [prDetailKey(2), false],
    ]);
  });
});

describe('the store with the Timeline off', () => {
  it('switching it off moves off the board and turns Focus tabs into detail tabs', () => {
    tabs().openPrFocusTab(meta(5));
    expect(tabs().activeTab).toBe(prFocusKey(5));
    tabs().setTimelineOn(false);
    expect(tabs().timelineOn).toBe(false);
    expect(tabs().activeTab).toBe(prDetailKey(5));
    expect(tabs().tabs.map((t) => t.kind)).toEqual(['pr-detail']);

    usePinnedTabs.setState({ activeTab: 'timeline', timelineOn: null });
    tabs().setTimelineOn(false);
    expect(tabs().activeTab).toBe('activity');
  });
  it('Focus opens the detail tab; the board, the link and `g t` go nowhere', () => {
    tabs().setTimelineOn(false);
    tabs().openPrFocusTab(meta(8));
    expect(tabs().activeTab).toBe(prDetailKey(8));

    tabs().showActivity();
    tabs().showTimeline();
    expect(tabs().activeTab).toBe('activity');
    goTo('timeline');
    expect(tabs().activeTab).toBe('activity');
    tabs().setActiveTab('timeline');
    expect(tabs().activeTab).toBe('activity');

    tabs().applyUrlTab('timeline');
    expect(tabs().activeTab).toBe('activity');
    tabs().applyUrlTab(prFocusKey(11));
    expect(tabs().activeTab).toBe(prDetailKey(11));
    expect(tabs().tabs.some((t) => t.kind === 'pr-focus')).toBe(false);
  });
  it('switched on, the board and Focus work again', () => {
    tabs().setTimelineOn(false);
    tabs().setTimelineOn(true);
    tabs().showTimeline();
    expect(tabs().activeTab).toBe('timeline');
    tabs().openPrFocusTab(meta(4));
    expect(tabs().activeTab).toBe(prFocusKey(4));
  });
});

describe('the sidebar, the key sheet and ⌘K', () => {
  const timeline = DESTINATIONS.find((d) => d.id === 'timeline')!;
  it('list the Timeline only when it is switched on', () => {
    const facts = { existingInstall: true, reportsReady: true, sprintSource: true };
    expect(isDestinationShown(timeline, { aiOn: true, features: undefined })).toBe(false);
    expect(isDestinationShown(timeline, { aiOn: true, features: resolveFeatures(null, facts) })).toBe(false);
    expect(isDestinationShown(timeline, { aiOn: true, features: resolveFeatures({ timeline: true }, facts) })).toBe(true);
  });
});
