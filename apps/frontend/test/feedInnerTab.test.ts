// The Feed rail's sub-tab strip: Feed · Themes (Pro, listed only on `activityDigest`) · Bot
// classification (FREE). The visible tab is DERIVED from the raw choice, never written back.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import { effectiveFeedTab, feedTabsFor } from '../src/components/Activity/feedTabsModel.js';
import { FEED_INNER_TABS } from '../src/store/filters.js';

describe('feedTabsFor', () => {
  it('lists Bot classification on every tier', () => {
    expect(feedTabsFor({ activityDigest: false }).map((t) => t.key)).toEqual([
      'feed',
      'classification',
    ]);
    expect(feedTabsFor({ activityDigest: true }).map((t) => t.key)).toEqual([
      'feed',
      'themes',
      'classification',
    ]);
  });

  it('labels the classification tab in plain words', () => {
    const tab = feedTabsFor({ activityDigest: false }).find((t) => t.key === 'classification');
    expect(tab?.label).toBe('Bot classification');
  });

  it('covers every member of the union', () => {
    const keys = feedTabsFor({ activityDigest: true }).map((t) => t.key);
    expect([...keys].sort()).toEqual([...FEED_INNER_TABS].sort());
  });
});

describe('effectiveFeedTab', () => {
  it('renders the raw choice when it is listed', () => {
    const free = feedTabsFor({ activityDigest: false });
    expect(effectiveFeedTab('classification', free)).toBe('classification');
    expect(effectiveFeedTab('feed', free)).toBe('feed');
  });

  // ⚠ Themes is not listed without the AI tier, so a raw 'themes' renders the Feed — FOR THE
  // RENDER ONLY. The function is pure and returns a value; it never writes the store.
  it('degrades an unlisted Themes to the Feed', () => {
    expect(effectiveFeedTab('themes', feedTabsFor({ activityDigest: false }))).toBe('feed');
    expect(effectiveFeedTab('themes', feedTabsFor({ activityDigest: true }))).toBe('themes');
  });

  it('never degrades Bot classification, whatever the tier', () => {
    for (const activityDigest of [false, true]) {
      expect(effectiveFeedTab('classification', feedTabsFor({ activityDigest }))).toBe(
        'classification',
      );
    }
  });
});
