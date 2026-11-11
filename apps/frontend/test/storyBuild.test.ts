// THE BUILD TAB'S PURE HALF (lib/storyBuild.ts), the story view's entry (Implement / Fill gaps / Open
// build — `storyViewBuildEntry` and its inputs) and the sprint card's build mark (components/TicketCard.tsx)
// — "Implement story", docs/STORY-BUILD.md.
//
// Pins: push gating (ready + a patch; Push all from two), the error words, the story view's entry: Implement ONLY on a not-started story
// with no PR and no session (owner decision 4), Fill gaps on a STARTED one whose CURRENT story check found
// gaps, Open build once a session is open; and the card: NO build button, only the mark in words and in
// the accessible name.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/storyBuild.test.ts
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SprintGraphNode, StoryBuild, StoryBuildRepo, TicketReview, TicketReviewState } from '@pierre-review/shared';
import { storyBuildFreeBranch } from '@pierre-review/shared';
import {
  autoPushEditable,
  autoPushRunning,
  autoPushWaitsForNextBuild,
  branchExistsFor,
  buildBranchNames,
  canPushRepo,
  pushAllOffered,
  storyBuildErrorText,
  storyBuildActionLabel,
  storyBuildActionOf,
  sprintNodeBuildOf,
  storyStageOfCategory,
  storyViewBuildEntry,
  storyViewCheck,
} from '../src/lib/storyBuild.js';
import { TicketCard } from '../src/components/TicketCard.js';
import { storyBuildPushBody } from '../src/hooks/useStoryBuild.js';

const repo = (repoId: number, o: Partial<StoryBuildRepo> = {}): StoryBuildRepo => ({
  id: repoId * 10,
  repoId,
  fullName: `acme/r${repoId}`,
  ref: `R${repoId}`,
  include: true,
  status: 'planned',
  order: repoId,
  baseRef: 'main',
  baseSha: 'a'.repeat(40),
  stackedOnPrId: null,
  baseNote: null,
  branch: null,
  summary: null,
  commitMessage: null,
  filesChanged: [],
  changeReport: null,
  checksWanted: [],
  checks: null,
  hasPatch: false,
  prTitle: null,
  pushedBranch: null,
  pushedPrNumber: null,
  pushedPrUrl: null,
  pushedCommitSha: null,
  pushedAt: null,
  pushError: null,
  model: null,
  effort: null,
  costUsd: null,
  numTurns: null,
  error: null,
  startedAt: null,
  completedAt: null,
  ...o,
});

const build = (o: Partial<StoryBuild> = {}): StoryBuild => ({
  id: 7,
  workspaceId: 1,
  ident: 'jira:R#PLAT-310',
  ticketKey: 'PLAT-310',
  ticketTitle: 'Retry within the budget',
  status: 'plan_ready',
  phase: null,
  error: null,
  model: 'claude-opus-5-5',
  effort: null,
  wantDiagram: true,
  wantDocs: false,
  criteriaSource: 'ticket',
  coverage: null,
  candidates: [],
  plan: {
    revision: 1,
    summary: 'One. Two.',
    repos: [
      { ref: 'R1', repoId: 1, why: 'w', branchSlug: 'retry-budget', steps: [], tests: [] },
      { ref: 'R2', repoId: 2, why: 'w', branchSlug: 'paused-chip', steps: [], tests: [] },
    ],
    readOnlyRepos: [],
    criteria: [],
    risks: [],
  },
  planRevision: 1,
  transcript: [],
  design: null,
  docsStatus: 'none',
  docs: null,
  docsDecisions: {},
  acceptedRevision: null,
  acceptedDocs: null,
  repos: [repo(1), repo(2)],
  planCostUsd: null,
  docsCostUsd: null,
  totalCostUsd: null,
  sessionBudgetUsd: 30,
  pushedAll: false,
  createdAt: '2026-10-30T09:00:00.000Z',
  startedAt: null,
  completedAt: null,
  ...o,
});

describe('push', () => {
  it('pushes a ready repository with a patch, whatever its tests say', () => {
    expect(canPushRepo(repo(1, { status: 'ready', hasPatch: true }))).toBe(true);
    expect(canPushRepo(repo(1, { status: 'ready', hasPatch: false }))).toBe(false);
    expect(canPushRepo(repo(1, { status: 'pushed', hasPatch: true }))).toBe(false);
    expect(canPushRepo(repo(1, { status: 'ready', hasPatch: true, include: false }))).toBe(false);
  });

  it('offers Push all from two ready repositories', () => {
    expect(pushAllOffered(build({ repos: [repo(1, { status: 'ready', hasPatch: true }), repo(2, { status: 'pushed', hasPatch: true })] }))).toBe(false);
    expect(pushAllOffered(build({ repos: [repo(1, { status: 'ready', hasPatch: true }), repo(2, { status: 'ready', hasPatch: true })] }))).toBe(true);
  });

  it('words a known error code, else the server message', () => {
    expect(storyBuildErrorText({ code: 'NotReady', message: 'x' })).toBe('Wait for the current step to finish.');
    expect(storyBuildErrorText({ code: 'Other', message: 'From the server.' })).toBe('From the server.');
  });
});

// ── the sprint card ────────────────────────────────────────────────────────────────────────────

const node = (o: Partial<SprintGraphNode> = {}): SprintGraphNode => ({
  ident: 'jira:R#PLAT-310',
  key: 'PLAT-310',
  title: 'Retry within the budget',
  url: null,
  provider: 'jira',
  ghost: false,
  depth: 0,
  status: { name: 'To Do', category: 'new' },
  stage: 'not_started',
  bucketId: 'todo',
  column: 'todo',
  issueType: 'Story',
  assignee: null,
  epic: null,
  brief: { state: 'current', summary: null, oneLiner: null, criteriaCount: 3, criteriaDerived: false },
  check: null,
  checkRunning: false,
  prs: [],
  degree: 0,
  theme: null,
  build: null,
  ...o,
});

const card = (n: SprintGraphNode): string =>
  renderToStaticMarkup(
    createElement(TicketCard, {
      node: n,
      critical: false,
      waiting: false,
      show: 'person',
      person: null,
      selected: false,
      onSelect: () => {},
      onOpen: () => {},
    }),
  );

const PR = { id: 1, repoId: 1, repo: 'acme/api', number: 5, title: 't', state: 'open', draft: false, ciState: null, url: 'https://github.com/acme/api/pull/5', author: null } as unknown as SprintGraphNode['prs'][number];
const CHECK = { met: 1, partlyMet: 0, notMet: 1, unsettled: 0, total: 2, checkedAt: '2026-10-30T00:00:00.000Z', stale: false, reviewId: 9 };
const started = (o: Partial<SprintGraphNode> = {}) => node({ stage: 'in_progress', prs: [PR], check: CHECK, ...o });
const entryOf = (n: SprintGraphNode) => storyViewBuildEntry({ ...n, build: n.build ?? null, check: n.check ?? null });

describe('the sprint card: a build MARK, never a build button', () => {
  it('has no Implement / Fill gaps / build button, whatever the ticket', () => {
    for (const n of [node(), started(), node({ build: { id: 3, status: 'ready', readyRepos: 1, pushedRepos: 0 } })]) {
      const html = card(n);
      expect(html).not.toContain('ticket-implement');
      expect(html).not.toContain('aria-label="Implement');
      expect(html).not.toContain('aria-label="Fill gaps');
      expect(html).not.toContain('build: Open');
    }
    // "No PR" stays a tag (it was hidden behind the Implement button).
    expect(card(node())).toContain('No PR');
  });

  it('wears the open session\'s mark, in words and in the accessible name', () => {
    const html = card(node({ build: { id: 3, status: 'ready', readyRepos: 1, pushedRepos: 1 }, prs: [PR] }));
    expect(html).toContain('data-build="ready_to_push"');
    expect(html).toContain('Ready to push');
    expect(html).toContain('build: Ready to push');
    expect(card(node({ build: { id: 3, status: 'building', readyRepos: 0, pushedRepos: 0 } }))).toContain('Working…');
    expect(card(node({ build: { id: 3, status: 'plan_ready', readyRepos: 0, pushedRepos: 0 } }))).toContain('Waiting for you');
    expect(card(node())).not.toContain('data-build=');
  });
});

describe('the story view\'s entry (owner decision 4; shared `storyBuildOffered`)', () => {
  it('offers Implement on a not-started story with no pull request', () => {
    expect(entryOf(node())).toEqual({ kind: 'offer', action: 'implement', reviewId: null });
  });

  it('offers nothing on a started ticket with no gaps known, with a PR and no check, on a ghost, or with no stage', () => {
    expect(entryOf(node({ stage: 'in_progress' }))).toBeNull();
    expect(entryOf(node({ prs: [PR] }))).toBeNull();
    expect(entryOf(node({ ghost: true }))).toBeNull();
    expect(entryOf(node({ stage: null }))).toBeNull();
  });

  it('offers Fill gaps (with the check behind it) on a started story whose current check found gaps', () => {
    expect(entryOf(started())).toEqual({ kind: 'offer', action: 'fill_gaps', reviewId: 9 });
    expect(entryOf(started({ check: null }))).toBeNull();
    expect(entryOf(started({ check: { ...CHECK, stale: true } }))).toBeNull();
    expect(entryOf(started({ check: { ...CHECK, notMet: 0, met: 2 } }))).toBeNull();
    expect(entryOf(started({ stage: 'done' }))).toBeNull();
  });

  it('opens the session instead once one is open, with its mark', () => {
    expect(entryOf(node({ build: { id: 3, status: 'ready', readyRepos: 1, pushedRepos: 0 } }))).toEqual({ kind: 'open', mark: 'ready_to_push' });
    expect(entryOf(started({ build: { id: 3, status: 'planning', readyRepos: 0, pushedRepos: 0 } }))).toEqual({ kind: 'open', mark: 'building' });
  });

  it('reads the stage from the tracker status category where the board is not known', () => {
    expect(storyStageOfCategory('new')).toBe('not_started');
    expect(storyStageOfCategory('indeterminate')).toBe('in_progress');
    expect(storyStageOfCategory('done')).toBe('done');
    expect(storyStageOfCategory(null)).toBeNull();
    expect(storyStageOfCategory(undefined)).toBeNull();
  });

  it('folds the view\'s check state and latest run into the card\'s check', () => {
    const state = {
      ident: 'x',
      status: 'current',
      staleBecause: [],
      changedPrIds: [],
      latestRunId: 9,
      runningRunId: null,
      alignment: null,
      counts: null,
      memberCount: 1,
      checkedAt: '2026-10-30T00:00:00.000Z',
    } as TicketReviewState;
    const run = {
      id: 9,
      createdAt: '2026-10-29T00:00:00.000Z',
      completedAt: '2026-10-30T00:00:00.000Z',
      assessment: {
        criteria: [{ status: 'met' }, { status: 'not_met' }, { status: 'partly_met' }, { status: 'unclear' }, { status: 'not_checked' }],
        missing: [{}],
      },
    } as unknown as TicketReview;
    expect(storyViewCheck(state, run)).toMatchObject({ met: 1, notMet: 1, partlyMet: 1, unsettled: 2, total: 5, missing: 1, reviewId: 9, stale: false });
    expect(storyViewCheck({ ...state, status: 'stale' }, run)?.stale).toBe(true);
    expect(storyViewCheck({ ...state, staleBecause: ['ticket_edited'] as TicketReviewState['staleBecause'] }, run)?.stale).toBe(true);
    // A run that is not the latest, none, or none read yet: no check.
    expect(storyViewCheck({ ...state, latestRunId: 10 }, run)).toBeNull();
    expect(storyViewCheck(state, undefined)).toBeNull();
    expect(storyViewCheck(undefined, run)).toBeNull();
  });

  it('folds a full session into the board\'s coarse build: open only, included repositories only', () => {
    const b = (status: StoryBuild['status'], repos: StoryBuildRepo[]) => ({ id: 4, status, repos });
    expect(sprintNodeBuildOf(b('ready', [repo(1, { status: 'ready' }), repo(2, { status: 'pushed' }), repo(3, { status: 'ready', include: false })]))).toEqual({
      id: 4,
      status: 'ready',
      readyRepos: 1,
      pushedRepos: 1,
    });
    expect(sprintNodeBuildOf(b('failed', []))).toBeNull();
    expect(sprintNodeBuildOf(b('discarded', []))).toBeNull();
    expect(sprintNodeBuildOf(null)).toBeNull();
  });
});

describe('the action words and the build tab\'s action', () => {
  it('labels each action', () => {
    expect(storyBuildActionLabel('implement', 'A-1')).toEqual({ label: 'Implement A-1', title: 'Implement this ticket' });
    expect(storyBuildActionLabel('fill_gaps', 'A-1').label).toBe('Fill gaps in A-1');
  });

  it("the tab's action: the session's coverage first, then the card's gate, then the ticket's PRs", () => {
    const cov = (n: number) => ({ coverage: { existingPrs: Array.from({ length: n }, () => ({})) } }) as unknown as StoryBuild;
    expect(storyBuildActionOf(cov(1), node())).toBe('fill_gaps');
    expect(storyBuildActionOf(cov(0), started())).toBe('implement');
    expect(storyBuildActionOf(null, started())).toBe('fill_gaps');
    expect(storyBuildActionOf(null, node())).toBe('implement');
    // A session still assessing (no coverage yet) on a ticket with an open PR fills gaps.
    expect(storyBuildActionOf({ coverage: null }, started({ check: null }))).toBe('fill_gaps');
    expect(storyBuildActionOf(null, null)).toBe('implement');
    // No node in memory: what the story view offered when it opened the tab.
    expect(storyBuildActionOf(null, null, 'fill_gaps')).toBe('fill_gaps');
    expect(storyBuildActionOf(null, node(), 'fill_gaps')).toBe('implement');
  });
});

describe('rename after BRANCH_EXISTS, and push automatically', () => {
  it('the press answer decides; without one, the stored code', () => {
    expect(branchExistsFor('BRANCH_EXISTS', null)).toBe(true);
    expect(branchExistsFor(null, 'BRANCH_EXISTS')).toBe(true);
    expect(branchExistsFor(undefined, 'BRANCH_EXISTS')).toBe(true);
    // A newer answer with another code wins over the stored one.
    expect(branchExistsFor('PUSH_DENIED', 'BRANCH_EXISTS')).toBe(false);
    expect(branchExistsFor(null, null)).toBe(false);
  });

  it('suggests a free -vN name that avoids the build branches, planned PR-2 names included', () => {
    const b = { repos: [repo(1, { branch: 'limn/acme-1', pushedBranch: null })], prs: [] };
    const taken = buildBranchNames(b);
    expect(taken).toEqual(['limn/acme-1']);
    expect(storyBuildFreeBranch('limn/acme-1', taken)).toBe('limn/acme-1-v2');
    expect(storyBuildFreeBranch('limn/acme-1', [...taken, 'limn/acme-1-v2'])).toBe('limn/acme-1-v3');
  });

  it('sends branch only when the reader named one', () => {
    expect(storyBuildPushBody(true)).toEqual({ draft: true });
    expect(storyBuildPushBody(false, '  ')).toEqual({ draft: false });
    expect(storyBuildPushBody(true, ' limn/x-v2 ')).toEqual({ draft: true, branch: 'limn/x-v2' });
  });

  it('the option changes until something pushed or the automatic push started', () => {
    const ready = { repos: [repo(1, { status: 'ready' })], prs: [], autoPush: true, autoPushAt: null, autoPushError: null, autoPushRunning: false };
    expect(autoPushEditable(ready)).toBe(true);
    expect(autoPushRunning(ready)).toBe(false);
    const claimed = { ...ready, autoPushAt: '2026-11-11T00:00:00Z', autoPushRunning: true };
    expect(autoPushEditable(claimed)).toBe(false);
    expect(autoPushRunning(claimed)).toBe(true);
    // Claimed but no longer running in the process (a restart; the reader's own press took over): never "Pushing…".
    expect(autoPushRunning({ ...claimed, autoPushRunning: false })).toBe(false);
    expect(autoPushRunning({ ...claimed, autoPushError: 'A branch named x already exists on a/b.' })).toBe(false);
    const pushed = { ...ready, repos: [repo(1, { status: 'pushed' })] };
    expect(autoPushEditable(pushed)).toBe(false);
    expect(autoPushRunning({ ...pushed, autoPushAt: '2026-11-11T00:00:00Z', autoPushRunning: true })).toBe(false);
  });

  it('says the option waits for the next build when the build already settled', () => {
    const built = { repos: [repo(1, { status: 'ready' })], prs: [], autoPush: true, autoPushAt: null, autoPushRunning: false, session: { phase: 'built' } };
    expect(autoPushWaitsForNextBuild(built)).toBe(true);
    expect(autoPushWaitsForNextBuild({ ...built, session: { phase: 'building' } })).toBe(false);
    expect(autoPushWaitsForNextBuild({ ...built, autoPush: false })).toBe(false);
    expect(autoPushWaitsForNextBuild({ ...built, autoPushRunning: true })).toBe(false);
    expect(autoPushWaitsForNextBuild({ ...built, autoPushAt: '2026-11-11T00:00:00Z' })).toBe(false);
  });
});
