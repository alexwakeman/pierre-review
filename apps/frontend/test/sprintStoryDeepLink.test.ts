// `?sprintStory=<ident>` must survive the FIRST workspace resolution.
//
// The URL hydrates `sprintStoryIdent` while `workspaceId` is still null; `useWorkspaceSync` then
// resolves the default workspace through `setWorkspace(id, null)`. That call used to clear the tray
// unconditionally, so a deep link never opened it. Only a real switch (id A → id B) leaves the story
// behind — its ticket belongs to the workspace being left.
//
// Not run in CI (see CLAUDE.md § Verifying changes). By hand:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { beforeEach, describe, expect, it } from 'vitest';
import { useFilters } from '../src/store/filters.js';

describe('setWorkspace and the sprint story tray', () => {
  beforeEach(() => {
    useFilters.setState({ workspaceId: null, repoIds: null, sprintStoryIdent: null });
  });

  it('keeps a deep-linked story when the workspace is first resolved (null → id)', () => {
    useFilters.setState({ sprintStoryIdent: 'jira:ACME-12' });
    useFilters.getState().setWorkspace(3, null);
    expect(useFilters.getState().workspaceId).toBe(3);
    expect(useFilters.getState().sprintStoryIdent).toBe('jira:ACME-12');
  });

  it('keeps it when the same workspace is written again', () => {
    useFilters.setState({ workspaceId: 3, sprintStoryIdent: 'jira:ACME-12' });
    useFilters.getState().setWorkspace(3, null);
    expect(useFilters.getState().sprintStoryIdent).toBe('jira:ACME-12');
  });

  it('clears it on a real switch between two workspaces', () => {
    useFilters.setState({ workspaceId: 3, sprintStoryIdent: 'jira:ACME-12' });
    useFilters.getState().setWorkspace(4, null);
    expect(useFilters.getState().workspaceId).toBe(4);
    expect(useFilters.getState().sprintStoryIdent).toBeNull();
  });
});
