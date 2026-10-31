// THE PLAN PASS'S PURE HALF ("Implement story", plan.ts + plan-agent.ts judgeStoryPlan). Pinned:
//   1. refusals say what to fix: an unknown repo ref, too many changed repos, a gap missing or twice, a
//      planned gap with no step citing it, a step citing a non-gap, a 1-sentence or 4-sentence summary;
//   2. a good plan is accepted and normalised: build order kept, repo ids from the candidates, criteria in
//      GAP order, strings clipped, read-only repos never also changed;
//   3. the design is judged as kind 'planned' (steps name repo refs); a bad design is refused until the
//      LAST attempt, which keeps the plan without it;
//   4. branch names: the proposal, and what git accepts at Accept.
import { describe, expect, it } from 'vitest';
import { STORY_BUILD_MAX_REPOS } from '@pierre-review/shared';
import {
  acceptedDesignOf,
  checkStoryPlanSubmission,
  isValidBranchName,
  normalizeStoryPlan,
  proposedBranch,
  renderStoryPlanText,
  sentencesOf,
  slugify,
  type RawStoryPlan,
  type StoryPlanContext,
} from './plan.js';
import { judgeStoryPlan } from './plan-agent.js';
import { promptTools } from '../../ai/prompt-tools.js';

const CTX: StoryPlanContext = {
  candidates: [
    { ref: 'R1', repoId: 11 },
    { ref: 'R2', repoId: 12 },
    { ref: 'R3', repoId: 13 },
  ],
  gapRefs: ['AC1', 'AC3', 'M1'],
  wantDiagram: false,
};

const good = (): RawStoryPlan => ({
  summary: 'The API gains a refund endpoint. The web app calls it from the order page.',
  repos: [
    {
      ref: 'R2',
      why: 'The endpoint lives here.',
      branchSlug: 'Refund Endpoint!',
      steps: [{ title: 'Add POST /refunds', files: ['src/refunds.ts', 'src/refunds.ts'], change: 'Add the handler.', refs: ['ac1', 'M1'] }],
      tests: ['refunds.test.ts covers the happy path'],
    },
    {
      ref: 'r1',
      why: 'The button lives here.',
      branchSlug: 'refund-button',
      steps: [{ title: 'Refund button', files: ['web/Order.tsx'], change: 'Call the endpoint.', refs: ['AC3'] }],
      tests: [],
    },
  ],
  readOnlyRepos: [{ ref: 'R3', why: 'Shared types.' }],
  criteria: [
    { ref: 'M1', how: 'planned', repo: 'R2' },
    { ref: 'AC3', how: 'planned', repo: 'R1' },
    { ref: 'AC1', how: 'planned', repo: 'R2' },
  ],
  risks: ['Card refunds may need a provider call.'],
  reply: null,
  design: null,
});

describe('checkStoryPlanSubmission', () => {
  it('accepts a good plan', () => {
    expect(checkStoryPlanSubmission(good(), CTX)).toEqual({ problems: [], designProblems: null });
  });

  it('refuses an unknown repo, and too many changed repos', () => {
    const p = good();
    (p.repos as any[])[0].ref = 'R9';
    expect(checkStoryPlanSubmission(p, CTX).problems.join(' ')).toMatch(/"R9" is not one of the repositories shown; use one of R1, R2, R3/);
    const many: StoryPlanContext = { ...CTX, candidates: Array.from({ length: 6 }, (_, i) => ({ ref: `R${i + 1}`, repoId: i + 1 })) };
    const q = good();
    q.repos = Array.from({ length: STORY_BUILD_MAX_REPOS + 1 }, (_, i) => ({ ref: `R${i + 1}`, why: 'w', branchSlug: 's', steps: [{ title: 't', files: [], change: 'c', refs: [] }], tests: [] }));
    expect(checkStoryPlanSubmission(q, many).problems.join(' ')).toMatch(/5 repositories change; at most 4 may/);
  });

  it('refuses a gap missing, a gap twice, and a planned gap no step cites', () => {
    const p = good();
    p.criteria = [
      { ref: 'AC1', how: 'planned', repo: 'R2' },
      { ref: 'AC1', how: 'planned', repo: 'R2' },
      { ref: 'AC3', how: 'planned', repo: 'R2' },
    ];
    const msg = checkStoryPlanSubmission(p, CTX).problems.join(' ');
    expect(msg).toMatch(/AC1 appears twice/);
    expect(msg).toMatch(/AC3 is planned in R2, but no R2 step cites AC3/);
    expect(msg).toMatch(/`criteria` is missing M1/);
  });

  it('refuses a step citing a non-gap, a bad `how`, and an unexplained not_planned', () => {
    const p = good();
    (p.repos as any[])[0].steps[0].refs = ['AC2'];
    p.criteria = [
      { ref: 'AC1', how: 'maybe' },
      { ref: 'AC3', how: 'not_planned' },
      { ref: 'M1', how: 'existing', reason: 'Already there.' },
    ];
    const msg = checkStoryPlanSubmission(p, CTX).problems.join(' ');
    expect(msg).toMatch(/cites "AC2", which is not a gap; use only AC1, AC3, M1/);
    expect(msg).toMatch(/`how` "maybe" must be one of: existing, planned, not_planned/);
    expect(msg).toMatch(/AC3 is not_planned; give a one-sentence `reason`/);
  });

  it('counts the summary sentences (2–3)', () => {
    expect(checkStoryPlanSubmission({ ...good(), summary: 'One sentence only.' }, CTX).problems.join(' ')).toMatch(/1 sentence; write 2 or 3/);
    expect(checkStoryPlanSubmission({ ...good(), summary: 'A. B. C. D.' }, CTX).problems.join(' ')).toMatch(/4 sentences/);
    expect(checkStoryPlanSubmission({ ...good(), summary: '- a bullet' }, CTX).problems.join(' ')).toMatch(/`summary` is empty/);
    expect(sentencesOf('Bump to v1.2 now. Then ship it.')).toHaveLength(2);
  });

  it('a story with no gap refs takes no refs at all', () => {
    const none: StoryPlanContext = { ...CTX, gapRefs: [] };
    const p = { ...good(), criteria: [] };
    expect(checkStoryPlanSubmission(p, none).problems.join(' ')).toMatch(/this story has no gap refs, so every step's `refs` is \[\]/);
    const clean = { ...p, repos: (p.repos as any[]).map((r) => ({ ...r, steps: r.steps.map((s: any) => ({ ...s, refs: [] })) })) };
    expect(checkStoryPlanSubmission(clean, none).problems).toEqual([]);
  });
});

const DESIGN = {
  title: 'Refunds',
  caption: 'A refund goes from the order page to the API.',
  participants: [
    { id: 'btn', kind: 'ui', label: 'Refund button', change: 'new', pr: 'R1' },
    { id: 'ep', kind: 'api', label: 'Refund endpoint', change: 'new', pr: 'R2' },
  ],
  steps: [
    { n: 1, from: 'btn', to: 'ep', kind: 'call', label: 'order id and amount', files: ['web/Order.tsx', 'web/Nope.tsx'] },
    { n: 2, from: 'ep', to: 'ep', kind: 'validate', label: 'amount within the order total', pr: 'R2', files: ['src/refunds.ts'] },
  ],
};

describe('the planned design', () => {
  const withDesign: StoryPlanContext = { ...CTX, wantDiagram: true };

  it('is judged as kind planned: steps name repo refs, files filtered to the planned steps', () => {
    const p = { ...good(), design: DESIGN };
    expect(checkStoryPlanSubmission(p, withDesign).designProblems).toBeNull();
    const d = acceptedDesignOf(p, withDesign)!;
    expect(d.steps.map((c) => [c.pr, c.files])).toEqual([
      ['R1', ['web/Order.tsx']],
      ['R2', ['src/refunds.ts']],
    ]);
  });

  it('a planned design may not decline', () => {
    const p = { ...good(), design: { participants: [], steps: [], noDiagram: 'nothing moves' } };
    expect(checkStoryPlanSubmission(p, withDesign).designProblems).toMatch(/noDiagram is not allowed here/);
  });

  it('a bad design is refused until the last attempt, which keeps the plan without it', () => {
    const p = { ...good(), design: { ...DESIGN, participants: [{ ...DESIGN.participants[0], pr: 'R3' }, DESIGN.participants[1]] } };
    const t = promptTools('claude');
    const first = judgeStoryPlan(p, 1, withDesign, t);
    expect('reply' in first && first.reply).toMatch(/Design:\n- participant "btn" names pr "R3"/);
    const last = judgeStoryPlan(p, 3, withDesign, t);
    expect(last).toMatchObject({ designDropped: true });
    expect(acceptedDesignOf(p, withDesign)).toBeNull();
  });

  it('a missing design is asked for only when one was wanted', () => {
    expect(checkStoryPlanSubmission(good(), withDesign).designProblems).toMatch(/`design` is missing/);
    expect(checkStoryPlanSubmission({ ...good(), design: DESIGN }, CTX).designProblems).toBeNull();
    expect(acceptedDesignOf({ ...good(), design: DESIGN }, CTX)).toBeNull();
  });

  it('Codex: its second answer is the last (no third)', () => {
    const p = { ...good(), design: { ...DESIGN, steps: [] } };
    expect(judgeStoryPlan(p, 2, withDesign, promptTools('codex'), 2)).toMatchObject({ designDropped: true });
    const r = judgeStoryPlan({ ...p, repos: [] }, 1, withDesign, promptTools('codex'), 2);
    expect('reply' in r && r.reply).toMatch(/Fix every point and answer again with the whole plan/);
    expect('reply' in r && r.reply).not.toMatch(/submit_story_plan/);
  });
});

describe('normalizeStoryPlan', () => {
  it('keeps the build order, maps repo ids, puts criteria in gap order, cleans strings', () => {
    const plan = normalizeStoryPlan(good(), CTX, 2);
    expect(plan.revision).toBe(2);
    expect(plan.repos.map((r) => [r.ref, r.repoId, r.branchSlug])).toEqual([
      ['R2', 12, 'refund-endpoint'],
      ['R1', 11, 'refund-button'],
    ]);
    expect(plan.repos[0]!.steps[0]).toEqual({ title: 'Add POST /refunds', files: ['src/refunds.ts'], change: 'Add the handler.', refs: ['AC1', 'M1'] });
    expect(plan.criteria.map((c) => c.ref)).toEqual(['AC1', 'AC3', 'M1']);
    expect(plan.readOnlyRepos).toEqual([{ ref: 'R3', repoId: 13, why: 'Shared types.' }]);
    expect(plan.risks).toEqual(['Card refunds may need a provider call.']);
    expect(renderStoryPlanText(plan)).toMatch(/1\. R2 changes: The endpoint lives here\.[\s\S]*Gaps:\n- AC1: planned in R2/);
  });
});

describe('branches', () => {
  it('proposes limn/<key>-<slug>', () => {
    expect(proposedBranch('ACME-214', 'refund-endpoint')).toBe('limn/acme-214-refund-endpoint');
    expect(proposedBranch('acme/web#12', '')).toBe('limn/acme-web-12-change');
    expect(slugify('  Hello, World!  ')).toBe('hello-world');
  });

  it('accepts only names git accepts', () => {
    for (const ok of ['limn/acme-214-x', 'feature/a.b', 'a_b-1']) expect(isValidBranchName(ok)).toBe(true);
    for (const bad of ['', '/a', 'a/', 'a..b', 'a//b', 'a.lock', 'a b', 'a@{1}', '-a', 'a/.b', 'x'.repeat(121)]) {
      expect(isValidBranchName(bad), bad).toBe(false);
    }
  });
});
