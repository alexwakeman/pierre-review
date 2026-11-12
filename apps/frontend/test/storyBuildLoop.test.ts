// THE REVIEW LOOP in the build tab (docs/STORY-BUILD.md § The review loop; docs/FRONTEND.md § The build
// tab): the pure helpers in lib/storyBuild.ts, the Review step (lib/sandboxSession.ts `sessionSteps`) and
// ReviewLoopSection's markup.
//
// Pins: the switch is editable only before the loop starts; "running" is the server's running states;
// a pushed loop branch's Push reads "Open the pull request"; the round footer names each target's commit
// or "no change"; coverage counts an accepted not-applicable claim apart; Review is a DERIVED step; the
// section shows each finding's response and hides Continue when the loop cannot continue.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/storyBuildLoop.test.ts
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { StoryBuild, StoryBuildLoop, StoryBuildLoopFinding, StoryBuildLoopRound, StoryBuildLoopTarget, TicketReview } from '@pierre-review/shared';
import {
  loopCoverage,
  loopEditable,
  loopFixLine,
  loopRoundTitle,
  loopRunning,
  loopStateWords,
  loopTargetName,
  pushButtonWords,
} from '../src/lib/storyBuild.js';
import { sessionSteps } from '../src/lib/sandboxSession.js';
import { ReviewLoopSection } from '../src/components/StoryBuild/ReviewLoopSection.js';

const target = (id: number, fullName: string, o: Partial<StoryBuildLoopTarget> = {}): StoryBuildLoopTarget => ({
  kind: 'repo',
  id,
  repoId: id - 900,
  fullName,
  key: null,
  title: null,
  branch: 'ACME-1',
  pushedSha: 'a'.repeat(40),
  pushedAt: '2026-11-12T00:00:00.000Z',
  ended: null,
  prNumber: null,
  prUrl: null,
  pushError: null,
  pushErrorCode: null,
  ...o,
});

const finding = (id: number, o: Partial<StoryBuildLoopFinding>): StoryBuildLoopFinding => ({
  id,
  reviewId: 1,
  path: 'src/a.ts',
  line: 3,
  side: 'RIGHT',
  diffAnchorId: 'x',
  severity: 'warning',
  title: `Finding ${id}`,
  body: 'Body.',
  editedBody: null,
  suggestion: null,
  diffHunk: null,
  anchored: true,
  fileInDiff: true,
  included: true,
  postedAt: null,
  githubCommentId: null,
  postedCommentKind: null,
  createdAt: '2026-11-12T00:00:00.000Z',
  targetKind: 'repo',
  targetId: 911,
  round: 1,
  raisedBy: 'claude',
  response: null,
  ...o,
});

const check = (statuses: Array<'met' | 'not_met' | 'unclear'>): TicketReview => ({
  id: 1,
  ident: 'x',
  ticketKey: 'ACME-1',
  ticketTitle: 'T',
  ticket: null,
  workspaceId: 1,
  originPrId: null,
  trigger: 'manual',
  status: 'succeeded',
  model: 'claude-opus-5-5',
  costUsd: null,
  error: null,
  refused: null,
  createdAt: '2026-11-12T00:00:00.000Z',
  startedAt: null,
  completedAt: null,
  alignment: 'partly_aligned',
  summary: null,
  assessment: {
    alignment: 'partly_aligned',
    summary: null,
    criteria: statuses.map((status, i) => ({ ref: `AC${i + 1}`, index: i, text: `Criterion ${i + 1}`, status, explanation: null, deliveredBy: [], evidence: [], expectedIn: null })),
    missing: [],
    notRequested: [],
  },
  members: [],
  items: [],
});

const round = (n: number, o: Partial<StoryBuildLoopRound> = {}): StoryBuildLoopRound => ({
  round: n,
  closing: false,
  reviews: [],
  storyCheck: null,
  claimVerdicts: [],
  acResponses: [],
  open: { findings: 0, followUps: 0, criteria: 0 },
  fix: null,
  ...o,
});

const LOOP: StoryBuildLoop = {
  on: true,
  rounds: 3,
  editable: false,
  state: 'paused',
  round: 2,
  pause: 'budget',
  pauseLine: 'Paused: the AI spend limit is reached. Press Continue to go on.',
  canContinue: true,
  error: null,
  targets: [target(911, 'acme/api'), target(910, 'acme/web')],
  history: [
    round(1, {
      reviews: [
        {
          targetKind: 'repo',
          targetId: 911,
          headSha: 'c'.repeat(40),
          baseSha: 'b'.repeat(40),
          runs: [],
          verdict: 'REQUEST_CHANGES',
          summary: 'Two points.',
          findings: [
            finding(1, { severity: 'blocker', response: { action: 'fixed', text: 'Done.', round: 1 } }),
            finding(2, { severity: 'question', response: { action: 'pushed_back', text: 'Kept on purpose.', round: 1 } }),
          ],
          followUp: [],
        },
        { targetKind: 'repo', targetId: 910, headSha: 'f'.repeat(40), baseSha: 'b'.repeat(40), runs: [], verdict: 'APPROVE', summary: null, findings: [], followUp: [] },
      ],
      storyCheck: check(['met', 'not_met', 'unclear']),
      acResponses: [{ ref: 'AC3', response: 'not_applicable', text: 'Out of scope.' }],
      open: { findings: 2, followUps: 0, criteria: 2 },
      fix: { state: 'done', pushed: [{ targetKind: 'repo', targetId: 911, sha: 'd'.repeat(40), error: null }] },
    }),
    round(2, { storyCheck: check(['met', 'met', 'unclear']), claimVerdicts: [{ ref: 'AC3', verdict: 'accepted', why: 'Out of scope.' }] }),
  ],
  next: 'Paused: the AI spend limit is reached. Press Continue to go on.',
};

describe('the review loop helpers', () => {
  it('the switch changes only before the loop starts', () => {
    const b = { repos: [], prs: [], autoPushAt: null };
    expect(loopEditable({ ...b, loop: { ...LOOP, editable: true } })).toBe(true);
    expect(loopEditable({ ...b, loop: LOOP })).toBe(false);
    // An older server sends no loop: the push-automatically rule.
    expect(loopEditable({ ...b, loop: undefined })).toBe(true);
    expect(loopEditable({ ...b, autoPushAt: '2026-11-12T00:00:00.000Z', loop: null })).toBe(false);
  });

  it('runs while it works by itself, never while paused, stopped or done', () => {
    for (const state of ['waiting', 'pushing', 'reviewing', 'fixing', 'opening'] as const) expect(loopRunning({ loop: { ...LOOP, state } })).toBe(true);
    for (const state of ['paused', 'done', 'stopped', 'failed', null] as const) expect(loopRunning({ loop: { ...LOOP, state } })).toBe(false);
    expect(loopRunning({ loop: { ...LOOP, on: false, state: 'reviewing' } })).toBe(false);
    expect(loopRunning({ loop: null })).toBe(false);
  });

  it('the state words', () => {
    expect(loopStateWords({ state: 'reviewing', round: 2, rounds: 3 })).toBe('Reviewing round 2 of 3');
    expect(loopStateWords({ state: 'reviewing', round: 4, rounds: 3 })).toBe('Final review');
    expect(loopStateWords({ state: 'pushing', round: 0, rounds: 3 })).toBe('Pushing the branch');
    expect(loopStateWords({ state: 'pushing', round: 1, rounds: 3 })).toBe('Pushing the fixes');
    expect(loopStateWords({ state: null, round: 0, rounds: 3 })).toBeNull();
    expect(loopRoundTitle({ round: 4, closing: true })).toBe('Final review');
    expect(loopTargetName({ fullName: 'acme/api', key: 'PR2' })).toBe('PR2 · acme/api');
  });

  it('a branch the loop pushed opens its pull request on Push', () => {
    const b = { loop: LOOP };
    expect(pushButtonWords(b, 'repo', 911, false)).toBe('Open the pull request');
    expect(pushButtonWords(b, 'repo', 911, true)).toBe('Open as draft');
    expect(pushButtonWords(b, 'repo', 999, true)).toBe('Push as draft');
    expect(pushButtonWords({ loop: { ...LOOP, targets: [target(911, 'acme/api', { ended: 'manual_push' })] } }, 'repo', 911, false)).toBe('Push');
  });

  it('the round footer names each reviewed target', () => {
    expect(loopFixLine(LOOP.history[0]!, LOOP.targets)).toBe('Fixes pushed: acme/api ddddddd, acme/web no change.');
    expect(loopFixLine(LOOP.history[1]!, LOOP.targets)).toBeNull();
    expect(loopFixLine(round(1, { fix: { state: 'running', pushed: [] } }), LOOP.targets)).toBe('The agent is working on the fixes.');
  });

  it('coverage reads the latest story check, an accepted claim apart', () => {
    expect(loopCoverage(LOOP).map((c) => `${c.ref}:${c.state}`)).toEqual(['AC1:met', 'AC2:met', 'AC3:not_applicable']);
    expect(loopCoverage({ history: [] })).toEqual([]);
  });

  it('Review is a derived step between Build and Push', () => {
    const cur = (phase: Parameters<typeof sessionSteps>[0], loop: Parameters<typeof sessionSteps>[1]) =>
      sessionSteps(phase, loop).find((s) => s.state === 'current')?.word ?? null;
    expect(sessionSteps({ phase: 'built' }).map((s) => s.word)).toEqual(['Set up', 'Talk', 'Build', 'Push']);
    expect(sessionSteps({ phase: 'built' }, { on: true, state: null }).map((s) => s.word)).toEqual(['Set up', 'Talk', 'Build', 'Review', 'Push']);
    expect(cur({ phase: 'building' }, { on: true, state: null })).toBe('Build');
    expect(cur({ phase: 'building' }, { on: true, state: 'fixing' })).toBe('Review');
    expect(cur({ phase: 'built' }, { on: true, state: 'reviewing' })).toBe('Review');
    expect(cur({ phase: 'built' }, { on: true, state: 'paused' })).toBe('Review');
    expect(cur({ phase: 'built' }, { on: true, state: 'opening' })).toBe('Push');
    expect(sessionSteps({ phase: 'pushed' }, { on: true, state: 'done' }).every((s) => s.state === 'done')).toBe(true);
    // Off: the four steps, as before.
    expect(cur({ phase: 'built' }, { on: false, state: null })).toBe('Push');
  });
});

describe('ReviewLoopSection', () => {
  const build = { id: 41, workspaceId: 1, ident: 'x', repos: [], prs: [], loop: LOOP } as unknown as StoryBuild;
  const render = (b: StoryBuild): string =>
    renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(ReviewLoopSection, { build: b })));

  it('shows the pause, Continue, the coverage and each finding with its response', () => {
    const html = render(build);
    expect(html).toContain('data-testid="story-build-loop"');
    expect(html).toContain('the AI spend limit is reached');
    expect(html).toContain('data-story-build-action="loop-continue"');
    expect(html).toContain('2 of 3 met, 1 not applicable');
    // Round 2 (the newest) is open; round 1 is closed until clicked.
    expect(html).toContain('data-round="2"');
    expect(html).toMatch(/AC3<\/span> · Accepted/);
    expect(html).not.toContain('data-action="pushed_back"');
  });

  it('a running loop offers Stop and no Continue; with nothing to show it renders nothing', () => {
    const html = render({ ...build, loop: { ...LOOP, state: 'reviewing', pause: null, pauseLine: null, canContinue: false, next: 'Next: x.' } });
    expect(html).not.toContain('data-story-build-action="loop-continue"');
    expect(html).toContain('Stop review loop');
    expect(render({ ...build, loop: { ...LOOP, on: false } })).toBe('');
  });

  it('the newest round open shows the responses', () => {
    const one = { ...LOOP, history: [LOOP.history[0]!] };
    const html = render({ ...build, loop: one });
    expect(html).toContain('data-action="fixed"');
    expect(html).toContain('data-action="pushed_back"');
    expect(html).toContain('Kept on purpose.');
    expect(html).toContain('Fixes pushed: acme/api ddddddd, acme/web no change.');
  });
});
