import { useDocsView } from './docsView.js';
import { useFilters } from './filters.js';
import { usePinnedTabs } from './pinnedTabs.js';

// Open one reference-library file in Activity → Docs from anywhere (a review's "Reference docs"
// section, a finding's citation): seat it in the docs store, then switch to the Docs rail line — the
// same move "See the whole story in Open PRs" makes (store/stackStoryCheck.ts).
export function openDocsSection(workspaceId: number, path: string, anchor: string | null): void {
  useDocsView.getState().openPath(workspaceId, path, anchor);
  usePinnedTabs.getState().showActivity();
  useFilters.getState().setActivityRepo('docs');
}
