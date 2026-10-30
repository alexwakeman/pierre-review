// "Implement story" on the sprint board (db/sprint-builds.ts + the graph fold's `build` field) — pure.
// Pinned: the newest OPEN session per ticket wins, closed sessions never mark a card, only INCLUDED
// repositories are counted; a ghost carries no build; the change token moves with the build's status and
// counts, and a sprint with NO session keeps the token it had before the field existed.
import { describe, expect, it } from 'vitest';
import {
  storyBuildCheckGaps,
  storyBuildGapsOf,
  storyBuildMark,
  storyBuildOffered,
  trackerTicketIdent,
  type ClaudeTicketCriterionStatus as SprintCriterionStatus,
  type SprintNodeBuild,
  type SprintTicketCheck,
  type TicketCriterion,
} from '@pierre-review/shared';
import { foldSprintBuilds } from './sprint-builds.js';
import { sprintTicketCheckOf } from './sprint-ticket-checks.js';
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
    expect(storyBuildOffered({ ghost: false, stage: 'not_started', prs: [] })).toBe('implement');
    expect(storyBuildOffered({ ghost: false, stage: 'not_started', prs: [], build: null })).toBe('implement');
    expect(storyBuildOffered({ ghost: true, stage: 'not_started', prs: [] })).toBeNull();
    expect(storyBuildOffered({ ghost: false, stage: 'in_progress', prs: [] })).toBeNull();
    expect(storyBuildOffered({ ghost: false, stage: null, prs: [] })).toBeNull();
    expect(storyBuildOffered({ ghost: false, stage: 'not_started', prs: [{}] })).toBeNull();
    expect(storyBuildOffered({ ghost: false, stage: 'not_started', prs: [], build: b({ status: 'plan_ready' }) })).toBeNull();
  });
  it('offers Fill gaps only on a started ticket whose CURRENT story check found gaps', () => {
    const check = (o: Partial<SprintTicketCheck> = {}): SprintTicketCheck => ({
      met: 2,
      partlyMet: 0,
      notMet: 0,
      unsettled: 0,
      total: 2,
      checkedAt: '2026-10-30T00:00:00.000Z',
      stale: false,
      ...o,
    });
    const started = { ghost: false, stage: 'in_progress' as const, prs: [{}] };
    expect(storyBuildOffered({ ...started, check: check({ notMet: 1 }) })).toBe('fill_gaps');
    expect(storyBuildOffered({ ...started, check: check({ partlyMet: 1 }) })).toBe('fill_gaps');
    expect(storyBuildOffered({ ...started, check: check({ unsettled: 1 }) })).toBe('fill_gaps');
    expect(storyBuildOffered({ ...started, check: check({ missing: 1 }) })).toBe('fill_gaps');
    // A PR makes a Not started ticket started; a status past Not started does too, PR or not.
    expect(storyBuildOffered({ ...started, stage: 'not_started', check: check({ notMet: 1 }) })).toBe('fill_gaps');
    expect(storyBuildOffered({ ...started, stage: 'in_review', prs: [], check: check({ notMet: 1 }) })).toBe('fill_gaps');
    expect(storyBuildOffered({ ...started, stage: null, check: check({ notMet: 1 }) })).toBe('fill_gaps');
    // Nothing when the gaps are not known (no check, a stale one), there are none, or it is complete.
    expect(storyBuildOffered({ ...started })).toBeNull();
    expect(storyBuildOffered({ ...started, check: null })).toBeNull();
    expect(storyBuildOffered({ ...started, check: check({ notMet: 1, stale: true }) })).toBeNull();
    expect(storyBuildOffered({ ...started, check: check() })).toBeNull();
    expect(storyBuildOffered({ ...started, stage: 'done', check: check({ notMet: 1 }) })).toBeNull();
    expect(storyBuildOffered({ ...started, ghost: true, check: check({ notMet: 1 }) })).toBeNull();
    expect(storyBuildOffered({ ...started, check: check({ notMet: 1 }), build: b({ status: 'plan_ready' }) })).toBeNull();
    expect(storyBuildCheckGaps(check({ notMet: 1, partlyMet: 1, unsettled: 1, missing: 2 }))).toBe(5);
    expect(storyBuildCheckGaps(check({ notMet: 1, stale: true }))).toBe(0);
  });
  it('lists a check\'s gaps: unmet criteria, then the missing items', () => {
    const crit = (ref: string, status: SprintCriterionStatus, text: string): TicketCriterion => ({
      ref,
      index: 0,
      text,
      status,
      explanation: null,
      deliveredBy: [],
      evidence: [],
      expectedIn: null,
    });
    const gaps = storyBuildGapsOf({
      criteria: [crit('AC1', 'met', 'Done'), crit('AC2', 'not_met', 'AC2: Removes the request'), crit('AC3', 'unclear', 'Logs once')],
      missing: [{ ref: 'M1', title: 'A migration', explanation: null, expectedIn: null }],
    });
    expect(gaps).toEqual([
      { ref: 'AC2', text: 'Removes the request', verdict: 'not_met' },
      { ref: 'AC3', text: 'Logs once', verdict: 'unclear' },
      { ref: 'M1', text: 'A migration', verdict: null },
    ]);
    expect(storyBuildGapsOf(null)).toEqual([]);
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

describe('"Fill gaps": the card check carries its missing items and run id', () => {
  const assessment = (missing: number) =>
    ({
      alignment: 'partly_aligned',
      summary: null,
      criteria: [
        { ref: 'AC1', index: 0, text: 'a', status: 'met', explanation: null, deliveredBy: [1], evidence: [], expectedIn: null },
        { ref: 'AC2', index: 1, text: 'b', status: 'not_met', explanation: null, deliveredBy: [], evidence: [], expectedIn: null },
      ],
      missing: Array.from({ length: missing }, (_, i) => ({ ref: `M${i + 1}`, title: 'm', explanation: null, expectedIn: null })),
      notRequested: [],
    }) as never;
  const run = (missing: number) => ({ id: 42, status: 'succeeded', assessment: assessment(missing), completedAt: new Date('2026-10-30T00:00:00Z') });
  const live = new Map([[1, { headSha: 'h', state: 'open' }]]);
  const members = [{ prId: 1, headSha: 'h', prState: 'open' as const }];

  it('counts the missing items and names the run', () => {
    const c = sprintTicketCheckOf(run(2), members, live, [{ prId: 1, state: 'open' }]);
    expect(c).toMatchObject({ met: 1, notMet: 1, missing: 2, reviewId: 42, stale: false });
    expect(storyBuildCheckGaps(c)).toBe(3);
  });

  it('the token moves with the missing count, and a check with none keeps its old token', () => {
    const base = { met: 1, partlyMet: 0, notMet: 1, unsettled: 0, total: 2, checkedAt: '2026-10-30T00:00:00.000Z', stale: false };
    const tokenOf = (check: SprintTicketCheck) =>
      sprintChangeTokenOf(
        foldSprintGraph({ provider: 'jira', apiRoot: ROOT, sprint: [t('A-1')], ghosts: [], stageOf: () => null, checks: new Map([[id('A-1'), { check, running: false }]]) }),
      );
    expect(tokenOf({ ...base, missing: 0, reviewId: 7 })).toBe(tokenOf(base));
    expect(tokenOf({ ...base, missing: 1 })).not.toBe(tokenOf(base));
  });
});
