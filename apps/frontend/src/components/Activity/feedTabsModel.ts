// The Feed rail's sub-tab strip, as pure decisions so they can be tested without a renderer.
//
// Two members: `feed` (the stream, the default) and `classification` ("Bot classification" — who
// counts as a bot in this Workspace, its role and its vendor). (The `themes` member — "Discussion themes" — is REMOVED; a legacy `?feedTab=themes` lands on the
// Feed because the URL reader seats only listed values.)
//
// ⚠ THE VISIBLE TAB IS DERIVED, NEVER WRITTEN BACK. `effectiveFeedTab` falls back for the render
// only.
import type { FeedInnerTab } from '../../store/filters.js';

export interface FeedTab {
  key: FeedInnerTab;
  label: string;
}

/** The strip, in order. Both members are listed on every tier. */
export function feedTabsFor(): FeedTab[] {
  return [
    { key: 'feed', label: 'Feed' },
    { key: 'classification', label: 'Bot classification' },
  ];
}

/** The member to RENDER: the raw choice when it is listed, else the Feed. */
export function effectiveFeedTab(raw: FeedInnerTab, tabs: readonly FeedTab[]): FeedInnerTab {
  return tabs.some((t) => t.key === raw) ? raw : 'feed';
}
