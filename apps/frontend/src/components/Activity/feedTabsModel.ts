// The Feed rail's sub-tab strip, as pure decisions so they can be tested without a renderer.
//
// Three members: `feed` (the stream, the default), `themes` (Pro, LISTED only on `activityDigest`
// — the "absent, never upsold" posture) and `classification` ("Bot classification", FREE on every
// tier — who counts as a bot in this Workspace, its role and its vendor).
//
// ⚠ THE VISIBLE TAB IS DERIVED, NEVER WRITTEN BACK. A capability blinking off must not strand the
// pane on a tab that is not listed — but a corrective `setFeedInnerTab` would also FORGET the
// reader's choice, so the capability returning would not restore it. `effectiveFeedTab` falls back
// for the render only.
import type { FeedInnerTab } from '../../store/filters.js';

export interface FeedTab {
  key: FeedInnerTab;
  label: string;
}

/** The strip, in order. `classification` is listed on every tier; `themes` only with the AI tier. */
export function feedTabsFor(opts: { activityDigest: boolean }): FeedTab[] {
  const tabs: FeedTab[] = [{ key: 'feed', label: 'Feed' }];
  if (opts.activityDigest) tabs.push({ key: 'themes', label: 'Themes' });
  tabs.push({ key: 'classification', label: 'Bot classification' });
  return tabs;
}

/** The member to RENDER: the raw choice when it is listed, else the Feed. */
export function effectiveFeedTab(raw: FeedInnerTab, tabs: readonly FeedTab[]): FeedInnerTab {
  return tabs.some((t) => t.key === raw) ? raw : 'feed';
}
