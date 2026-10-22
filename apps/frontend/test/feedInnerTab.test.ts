// The Feed rail's sub-tab strip: Feed · Bot classification (FREE). The visible tab is DERIVED from
// the raw choice, never written back. (The "Discussion themes" tab is REMOVED.)
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import { effectiveFeedTab, feedTabsFor } from '../src/components/Activity/feedTabsModel.js';
import { FEED_INNER_TABS } from '../src/store/filters.js';

describe('feedTabsFor', () => {
  it('lists the Feed and Bot classification on every tier', () => {
    expect(feedTabsFor().map((t) => t.key)).toEqual(['feed', 'classification']);
  });

  it('labels the classification tab in plain words', () => {
    const tab = feedTabsFor().find((t) => t.key === 'classification');
    expect(tab?.label).toBe('Bot classification');
  });

  it('covers every member of the union', () => {
    const keys = feedTabsFor().map((t) => t.key);
    expect([...keys].sort()).toEqual([...FEED_INNER_TABS].sort());
  });

  it("no longer carries the retired 'themes' member", () => {
    expect((FEED_INNER_TABS as readonly string[]).includes('themes')).toBe(false);
  });
});

describe('effectiveFeedTab', () => {
  it('renders the raw choice when it is listed', () => {
    expect(effectiveFeedTab('classification', feedTabsFor())).toBe('classification');
    expect(effectiveFeedTab('feed', feedTabsFor())).toBe('feed');
  });
});

