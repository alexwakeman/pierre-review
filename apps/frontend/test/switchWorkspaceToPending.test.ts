// A pick in the WorkspaceSelector dropdown is a NAVIGATION: switch workspace, bring Activity
// forward, land on Pending → My turn (Cards), and drop the Timeline's selected PR. Pinned tabs stay.
//
// What this pins, each of which has a quiet way to regress:
//   - the tab and My turn's view are seated EXPLICITLY — `setActivityRepo` no-ops when the rail is
//     already Pending, so a switch from "Needs fixing" or the branches view would keep it;
//   - `setWorkspace` itself does NOT navigate (URL hydrate, Back/Forward and useWorkspaceSync's
//     corrections all call it);
//   - the selector's row click goes through the new action.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { useFilters } from '../src/store/filters.js';
import { usePinnedTabs } from '../src/store/pinnedTabs.js';

const pinned = [
  { key: 'pr-detail:11', kind: 'pr-detail' as const, prId: 11, meta: null },
  { key: 'pr-focus:12', kind: 'pr-focus' as const, prId: 12, meta: null },
];

describe('switchWorkspaceToPending', () => {
  beforeEach(() => {
    useFilters.setState({
      workspaceId: 3,
      repoIds: [1, 2],
      activityRepoId: 'feed',
      attentionTab: null,
      attentionIsolation: null,
      attentionRelevance: null,
      attentionAuthorLens: null,
      selectedPrId: 42,
      selectedThreadId: 7,
    });
    usePinnedTabs.setState({ activeTab: 'timeline', tabs: [...pinned] as never });
  });

  it('from the Timeline: switches, opens Activity → Pending → My turn, clears the selected PR', () => {
    useFilters.getState().switchWorkspaceToPending(5);
    const f = useFilters.getState();
    expect(f.workspaceId).toBe(5);
    expect(f.repoIds).toBeNull();
    expect(f.activityRepoId).toBe('attention');
    expect(f.attentionTab).toBeNull();
    expect(f.selectedPrId).toBeNull();
    expect(f.selectedThreadId).toBeNull();
    expect(usePinnedTabs.getState().activeTab).toBe('activity');
  });

  it('already on Pending with another tab: lands on My turn', () => {
    useFilters.setState({ activityRepoId: 'attention', attentionTab: 'fixing' });
    useFilters.getState().switchWorkspaceToPending(5);
    expect(useFilters.getState().attentionTab).toBeNull();
  });

  it('re-picking the current workspace navigates too', () => {
    useFilters.getState().switchWorkspaceToPending(3);
    expect(useFilters.getState().workspaceId).toBe(3);
    expect(useFilters.getState().activityRepoId).toBe('attention');
    expect(usePinnedTabs.getState().activeTab).toBe('activity');
    expect(useFilters.getState().selectedPrId).toBeNull();
  });

  it('leaves pinned PR / Focus tabs in the strip', () => {
    useFilters.getState().switchWorkspaceToPending(5);
    expect(usePinnedTabs.getState().tabs.map((t) => t.key)).toEqual(['pr-detail:11', 'pr-focus:12']);
  });

  it('setWorkspace alone still does NOT navigate', () => {
    useFilters.getState().setWorkspace(5, null);
    expect(useFilters.getState().activityRepoId).toBe('feed');
    expect(useFilters.getState().selectedPrId).toBe(42);
    expect(usePinnedTabs.getState().activeTab).toBe('timeline');
  });

  it('the dropdown row click is the one caller', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/components/WorkspaceSelector.tsx', import.meta.url)),
      'utf8',
    );
    const select = src.slice(src.indexOf('const select = (id: number)'));
    expect(select.slice(0, select.indexOf('};'))).toContain('switchWorkspaceToPending(id)');
  });
});
