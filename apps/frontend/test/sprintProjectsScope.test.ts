// This Sprint's GitHub Projects line (docs/TRACKERS.md § GitHub Projects iterations): shown only when a
// GitHub read fell back to milestones / the status fallback because the gh login lacks read:project;
// an iteration source is named by the iteration's title.
import { describe, expect, it } from 'vitest';
import { GITHUB_PROJECTS_SCOPE_COMMAND, needsGithubProjectsScope, sprintSourceTitle, type SprintSource } from '@pierre-review/shared';

const iteration: SprintSource = {
  kind: 'iteration',
  provider: 'github',
  name: 'Sprint 7',
  project: 'Web',
  field: 'Sprint',
  startsOn: '2026-10-26',
  endsOn: '2026-11-09',
  repos: ['acme/web'],
};

describe('needsGithubProjectsScope', () => {
  it('only a fallback that noted the missing scope', () => {
    expect(needsGithubProjectsScope({ kind: 'milestone', provider: 'github', name: 'v2', dueOn: null, repos: [], projectsAccess: 'needs_scope' })).toBe(true);
    expect(
      needsGithubProjectsScope({ kind: 'status_fallback', provider: 'github', reason: 'none_active', from: '', to: '', projectsAccess: 'needs_scope' }),
    ).toBe(true);
    expect(needsGithubProjectsScope({ kind: 'milestone', provider: 'github', name: 'v2', dueOn: null, repos: [] })).toBe(false);
    expect(needsGithubProjectsScope(iteration)).toBe(false);
    expect(needsGithubProjectsScope(null)).toBe(false);
  });

  it('names the gh command', () => {
    expect(GITHUB_PROJECTS_SCOPE_COMMAND).toBe('gh auth refresh -s read:project');
  });
});

describe('sprintSourceTitle', () => {
  it('an iteration reads as its own title', () => {
    expect(sprintSourceTitle(iteration)).toBe('Sprint 7');
  });
});
