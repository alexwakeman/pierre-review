// "Implement story" on the sprint board (db/sprint-builds.ts + the graph fold's `build` field) — pure.
// Pinned: the newest OPEN session per ticket wins, closed sessions never mark a card, only INCLUDED
// repositories are counted; a ghost carries no build; the change token moves with the build's status and
// counts, and a sprint with NO session keeps the token it had before the field existed.
import { describe, expect, it } from 'vitest';
import { storyBuildMark, storyBuildOffered, trackerTicketIdent, type SprintNodeBuild } from '@pierre-review/shared';
import { foldSprintBuilds } from './sprint-builds.js';
import { foldSprintGraph, sprintChangeTokenOf, type GraphTicketInput } from './sprint-graph-fold.js';

const ROOT = 'https://acme.atlassian.net';
const id = (k: string) => trackerTicketIdent('jira', ROOT, k);
const t = (key: string): GraphTicketInput => ({
  ident: id(key),
  key,
  title: key,
  url: null,
  status: null,
  issueType: null,
  assignee: null,
  epic: null,
  links: null,
  brief: null,
  briefState: 'pending',
});

describe('foldSprintBuilds', () => {
  it('keeps the newest OPEN session per ticket and counts its included repositories', () => {
    const out = foldSprintBuilds(
      [
        { id: 1, ident: 'a', status: 'discarded' },
        { id: 2, ident: 'a', status: 'ready' },
        { id: 3, ident: 'b', status: 'failed' },
        { id: 4, ident: 'c', status: 'building' },
      ],
      [
        { buildId: 2, include: true, status: 'ready' },
        { buildId: 2, include: true, status: 'pushed' },
        { buildId: 2, include: false, status: 'ready' },
        { buildId: 1, include: true, status: 'pushed' },
      ],
    );
    expect(out.get('a')).toEqual({ id: 2, status: 'ready', readyRepos: 1, pushedRepos: 1 });
    expect(out.has('b')).toBe(false);
    expect(out.get('c')).toEqual({ id: 4, status: 'building', readyRepos: 0, pushedRepos: 0 });
  });
});

describe('the card mark and the entry gate (shared)', () => {
  const b = (o: Partial<SprintNodeBuild>): SprintNodeBuild => ({ id: 1, status: 'ready', readyRepos: 0, pushedRepos: 0, ...o });
  it('reads Building… / Plan ready / Ready to push / Pushed', () => {
    expect(storyBuildMark(null)).toBeNull();
    expect(storyBuildMark(b({ status: 'assessing' }))).toBe('building');
    expect(storyBuildMark(b({ status: 'building', readyRepos: 1 }))).toBe('building');
    expect(storyBuildMark(b({ status: 'plan_ready' }))).toBe('plan_ready');
    expect(storyBuildMark(b({ readyRepos: 1, pushedRepos: 1 }))).toBe('ready_to_push');
    expect(storyBuildMark(b({ pushedRepos: 2 }))).toBe('pushed');
    expect(storyBuildMark(b({ status: 'failed' }))).toBeNull();
  });
  it('offers Implement only on a not-started sprint ticket with no PR and no open session', () => {
    expect(storyBuildOffered({ ghost: false, stage: 'not_started', prs: [] })).toBe(true);
    expect(storyBuildOffered({ ghost: false, stage: 'not_started', prs: [], build: null })).toBe(true);
    expect(storyBuildOffered({ ghost: true, stage: 'not_started', prs: [] })).toBe(false);
    expect(storyBuildOffered({ ghost: false, stage: 'in_progress', prs: [] })).toBe(false);
    expect(storyBuildOffered({ ghost: false, stage: null, prs: [] })).toBe(false);
    expect(storyBuildOffered({ ghost: false, stage: 'not_started', prs: [{}] })).toBe(false);
    expect(storyBuildOffered({ ghost: false, stage: 'not_started', prs: [], build: b({ status: 'plan_ready' }) })).toBe(false);
  });
});

describe('the graph fold carries the build', () => {
  const fold = (builds?: ReadonlyMap<string, SprintNodeBuild>) =>
    foldSprintGraph({ provider: 'jira', apiRoot: ROOT, sprint: [t('A-1'), t('A-2')], ghosts: [], stageOf: () => null, ...(builds ? { builds } : {}) });

  it('sets build on sprint nodes (null without one, and when AI is off)', () => {
    const g = fold(new Map([[id('A-1'), { id: 9, status: 'plan_ready', readyRepos: 0, pushedRepos: 0 }]]));
    expect(g.nodes.find((n) => n.key === 'A-1')?.build).toEqual({ id: 9, status: 'plan_ready', readyRepos: 0, pushedRepos: 0 });
    expect(g.nodes.find((n) => n.key === 'A-2')?.build).toBeNull();
    expect(fold().nodes.every((n) => n.build === null)).toBe(true);
  });

  it('moves the change token with the build, and leaves it alone with no session', () => {
    const none = sprintChangeTokenOf(fold());
    expect(sprintChangeTokenOf(fold(new Map()))).toBe(none);
    const planning = sprintChangeTokenOf(fold(new Map([[id('A-1'), { id: 9, status: 'planning', readyRepos: 0, pushedRepos: 0 }]])));
    const ready = sprintChangeTokenOf(fold(new Map([[id('A-1'), { id: 9, status: 'ready', readyRepos: 1, pushedRepos: 0 }]])));
    const pushed = sprintChangeTokenOf(fold(new Map([[id('A-1'), { id: 9, status: 'ready', readyRepos: 0, pushedRepos: 1 }]])));
    expect(new Set([none, planning, ready, pushed]).size).toBe(4);
  });
});
