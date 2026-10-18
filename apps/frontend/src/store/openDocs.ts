import { useDocsView } from './docsView.js';
import { useFilters } from './filters.js';
import { usePinnedTabs } from './pinnedTabs.js';

// Open one reference-library file in Activity → Docs from anywhere (a review's "Reference docs"
// section, a finding's citation): seat it in the docs store, then switch to the Docs rail line.
//
// ⚠ `workspaceId` is the library the reference was checked against. The Docs pane shows the SELECTED
// workspace's library, so a reference from another workspace's PR switches to that workspace first
// (the same public setter openMyTurnInWorkspace uses), or the pane would show a different library.
export function openDocsSection(workspaceId: number, path: string, anchor: string | null): void {
  const filters = useFilters.getState();
  if (filters.workspaceId !== workspaceId) filters.setWorkspace(workspaceId, null);
  useDocsView.getState().openPath(workspaceId, path, anchor);
  usePinnedTabs.getState().showActivity();
  useFilters.getState().setActivityRepo('docs');
}
