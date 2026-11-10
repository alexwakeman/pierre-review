import { currentLocation, type DestinationId, type Location } from '../components/shell/nav.js';
import type { Tab, TabKind } from '../store/pinnedTabs.js';

// THE "?" BUTTON'S TARGET: the public docs at limn-review.com, on the page for where the reader is.
//
// The SPA must not import the landing, so the page keys (`<section>/<slug>`) are hard-coded here.
// They must exist in apps/landing/src/docs/manifest.ts: test/docsLink.test.ts lists them, and the
// landing's docs test reads this file and checks each one. A key that is not mapped opens /docs.

export const DOCS_SITE = 'https://limn-review.com/docs';

/** Each sidebar destination's docs page. */
export const DESTINATION_DOCS: Record<DestinationId, string> = {
  'open-prs': 'open-pull-requests/overview',
  attention: 'pending/overview',
  sprint: 'this-sprint/overview',
  timeline: 'timeline/overview',
  docs: 'docs-library/overview',
  feed: 'feed/overview',
  insights: 'reports/overview',
  bots: 'bots-monitoring/overview',
};

/** A repository's page (the sidebar's repo rows). */
export const REPO_DOCS = 'getting-started/repository-pages';

/** The dynamic tabs that have a page of their own. The rest open the docs home. */
export const TAB_DOCS: Partial<Record<TabKind, string>> = {
  'pr-detail': 'pull-request/overview',
  'pr-focus': 'timeline/focus-a-pull-request',
  'story-build': 'implement-story/overview',
};

/** Every page key this file can link to (for the tests). */
export function allDocsKeys(): string[] {
  return [...Object.values(DESTINATION_DOCS), REPO_DOCS, ...Object.values(TAB_DOCS)];
}

/** The docs URL for where the reader is: a sidebar location, else the active dynamic tab's kind. */
export function docsUrlFor(location: Location, tabKind: TabKind | null): string {
  const key =
    typeof location === 'number'
      ? REPO_DOCS
      : location != null
        ? DESTINATION_DOCS[location]
        : tabKind != null
          ? TAB_DOCS[tabKind]
          : undefined;
  return key == null ? DOCS_SITE : `${DOCS_SITE}/${key}`;
}

/** The same, read from the two stores' values (the sidebar's "?" and ⌘K's "Open the Limn docs"). */
export function docsUrlForView(
  activeTab: string,
  tabs: readonly Pick<Tab, 'key' | 'kind'>[],
  activityRepoId: Parameters<typeof currentLocation>[2],
): string {
  return docsUrlFor(currentLocation(activeTab, tabs, activityRepoId), tabs.find((t) => t.key === activeTab)?.kind ?? null);
}
