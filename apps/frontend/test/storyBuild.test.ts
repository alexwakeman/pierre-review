// THE BUILD TAB'S PURE HALF (lib/storyBuild.ts) and the sprint card's Implement button / build mark
// (components/TicketCard.tsx) — "Implement story", docs/STORY-BUILD.md.
//
// Pins: the step line ("Assess · Plan · Docs · Build · Push", the current step), the docs groups and
// their defaults (suggestions ticked, superseded unticked, grounded no box — owner decision 6), the
// "not in the plan yet" count, the Accept body (branch checks, at least one repository), push gating
// (ready + a patch; Push all from two), and the card: Implement ONLY on a not-started ticket with no
// PR and no session (owner decision 4), never without `onImplement`, the mark in words and in the
// accessible name, and ONE height (the corner button is absolutely placed).
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/storyBuild.test.ts
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SprintGraphNode, StoryBuild, StoryBuildDocs, StoryBuildRepo } from '@pierre-review/shared';
import {
  acceptBody,
  branchNameProblem,
  canPushRepo,
  canRetryRepo,
  docsItemIncluded,
  docsPointsNotInPlan,
  pushAllOffered,
  storyBuildCancellable,
  storyBuildDocsGroups,
  storyBuildErrorText,
  storyBuildSteps,
} from '../src/lib/storyBuild.js';
import { TicketCard } from '../src/components/TicketCard.js';

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

const docs: StoryBuildDocs = {
  summary: 'Two points.',
  nothingGrounded: false,
  planRevision: 1,
  items: [
    { id: 'D1', kind: 'suggestion', about: 'AC1', note: 'n', suggestion: 's', refs: [] },
    { id: 'D2', kind: 'superseded', about: 'story', note: 'n', suggestion: null, refs: [] },
    { id: 'D3', kind: 'grounded', about: 'R1:step 1', note: 'n', suggestion: null, refs: [] },
  ],
};

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

const current = (b: StoryBuild | null, wantDocs?: boolean): string | undefined => storyBuildSteps(b, wantDocs).find((s) => s.state === 'current')?.word;

describe('the step line', () => {
  it('lists Docs only when the reader asked for it', () => {
    expect(storyBuildSteps(null).map((s) => s.word)).toEqual(['Assess', 'Plan', 'Build', 'Push']);
    expect(storyBuildSteps(null, true).map((s) => s.word)).toEqual(['Assess', 'Plan', 'Docs', 'Build', 'Push']);
    expect(storyBuildSteps(build({ wantDocs: true })).map((s) => s.word)).toContain('Docs');
  });

  it('marks the step the session is on', () => {
    expect(current(null)).toBeUndefined();
    expect(current(build({ status: 'assessing', phase: 'reading_story', planRevision: 0, plan: null }))).toBe('Assess');
    expect(current(build({ status: 'planning', phase: 'checking_out', planRevision: 0, plan: null }))).toBe('Assess');
    expect(current(build({ status: 'planning', phase: 'planning', planRevision: 1 }))).toBe('Plan');
    expect(current(build({ status: 'plan_ready' }))).toBe('Plan');
    expect(current(build({ status: 'plan_ready', wantDocs: true, docsStatus: 'running' }))).toBe('Docs');
    expect(current(build({ status: 'building' }))).toBe('Build');
    expect(current(build({ status: 'ready' }))).toBe('Push');
    const pushed = storyBuildSteps(build({ status: 'ready', pushedAll: true }));
    expect(pushed.every((s) => s.state === 'done')).toBe(true);
  });
});

describe('the docs', () => {
  it('groups by kind; suggestions ticked, superseded unticked by default', () => {
    const g = storyBuildDocsGroups(docs);
    expect(g.suggestions.map((i) => i.id)).toEqual(['D1']);
    expect(g.superseded.map((i) => i.id)).toEqual(['D2']);
    expect(g.grounded.map((i) => i.id)).toEqual(['D3']);
    expect(docsItemIncluded(docs.items[0]!, {})).toBe(true);
    expect(docsItemIncluded(docs.items[1]!, {})).toBe(false);
    expect(docsItemIncluded(docs.items[1]!, { D2: 'include' })).toBe(true);
    expect(docsItemIncluded(docs.items[0]!, { D1: 'ignore' })).toBe(false);
  });

  it('counts the ticked points the current plan has not seen', () => {
    expect(docsPointsNotInPlan(build({ docs, docsDecisions: { D1: 'include', D2: 'ignore' } }))).toBe(1);
    expect(docsPointsNotInPlan(build({ docs, docsDecisions: { D1: 'include', D2: 'include' } }))).toBe(2);
    // A plan pass ran after the docs: it had the ticks.
    expect(docsPointsNotInPlan(build({ docs, planRevision: 2, docsDecisions: { D1: 'include' } }))).toBe(0);
  });
});

describe('Accept', () => {
  it('sends the plan revision and every planned repository with its branch', () => {
    const r = acceptBody(build(), new Map([[2, { include: false }]]));
    expect('body' in r && r.body).toEqual({
      planRevision: 1,
      repos: [
        { repoId: 1, include: true, branch: 'PLAT-310-retry-budget', checks: [] },
        { repoId: 2, include: false, branch: 'PLAT-310-paused-chip', checks: [] },
      ],
    });
  });

  it('refuses no repository, and a bad branch name', () => {
    const none = acceptBody(build(), new Map([[1, { include: false }], [2, { include: false }]]));
    expect('problem' in none && none.problem).toBe('Include at least one repository.');
    const bad = acceptBody(build(), new Map([[1, { branch: 'has space' }]]));
    expect('problem' in bad).toBe(true);
    expect(branchNameProblem('')).toBe('Name the branch.');
    expect(branchNameProblem('a..b')).not.toBeNull();
    expect(branchNameProblem('PLAT-310/retry')).toBeNull();
  });
});

describe('Cancel', () => {
  it('is offered while a plan or build pass runs, and while ONLY the docs run (⌘K Cancel stops it)', () => {
    expect(storyBuildCancellable(build({ status: 'planning' }))).toBe(true);
    expect(storyBuildCancellable(build({ status: 'plan_ready', docsStatus: 'running' }))).toBe(true);
    expect(storyBuildCancellable(build({ status: 'plan_ready', docsStatus: 'ready' }))).toBe(false);
  });

  it('a stale docs tick reads in words', () => {
    expect(storyBuildErrorText({ code: 'DocsMoved', message: 'x' })).toBe('The docs points changed since you looked. Tick them again.');
  });
});

describe('push and retry', () => {
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

  it('retries a failed repository only while nothing else runs', () => {
    const failed = repo(2, { status: 'failed' });
    expect(canRetryRepo(build({ status: 'ready', repos: [repo(1, { status: 'ready' }), failed] }), failed)).toBe(true);
    expect(canRetryRepo(build({ status: 'building', repos: [repo(1, { status: 'building' }), failed] }), failed)).toBe(false);
  });

  it('words a known error code, else the server message', () => {
    expect(storyBuildErrorText({ code: 'PlanMoved', message: 'x' })).toBe('The plan changed. Read the new one, then accept it.');
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

const card = (n: SprintGraphNode, implement = true): string =>
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
      ...(implement ? { onImplement: () => {} } : {}),
    }),
  );

const PR = { id: 1, repoId: 1, repo: 'acme/api', number: 5, title: 't', state: 'open', draft: false, ciState: null, url: 'https://github.com/acme/api/pull/5', author: null } as unknown as SprintGraphNode['prs'][number];

describe('the Implement button (owner decision 4)', () => {
  it('shows on a not-started ticket with no pull request', () => {
    expect(card(node())).toContain('aria-label="Implement PLAT-310"');
  });

  it('never shows without onImplement (AI off), on a started ticket, with a PR, or on a ghost', () => {
    expect(card(node(), false)).not.toContain('data-testid="ticket-implement"');
    expect(card(node({ stage: 'in_progress' }))).not.toContain('data-testid="ticket-implement"');
    expect(card(node({ prs: [PR] }))).not.toContain('data-testid="ticket-implement"');
    expect(card(node({ ghost: true }))).not.toContain('data-testid="ticket-implement"');
    expect(card(node({ stage: null }))).not.toContain('data-testid="ticket-implement"');
  });

  it('turns into the build mark once a session is open, in words and in the accessible name', () => {
    const html = card(node({ build: { id: 3, status: 'ready', readyRepos: 1, pushedRepos: 1 }, prs: [PR] }));
    expect(html).toContain('data-build="ready_to_push"');
    expect(html).toContain('Ready to push');
    expect(html).toContain('build: Ready to push');
    expect(html).toContain('aria-label="Open PLAT-310&#x27;s build: Ready to push"');
    expect(card(node({ build: { id: 3, status: 'building', readyRepos: 0, pushedRepos: 0 } }))).toContain('Building…');
    expect(card(node({ build: { id: 3, status: 'plan_ready', readyRepos: 0, pushedRepos: 0 } }))).toContain('Plan ready');
  });

  it('keeps ONE height: the button is absolutely placed, the mark sits in the key line', () => {
    const plain = card(node(), false);
    const offered = card(node());
    // The same rows (title, one-liner, criteria, tags) in both; the extra button is `absolute`.
    for (const id of ['ticket-one-liner', 'ticket-criteria', 'ticket-person-line']) {
      expect(plain).toContain(`data-testid="${id}"`);
      expect(offered).toContain(`data-testid="${id}"`);
    }
    expect(offered).toMatch(/data-testid="ticket-implement"[^>]*class="[^"]*absolute/);
  });
});
