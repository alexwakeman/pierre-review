// AI Fix PLAN MODE — the pure half (plan.ts): what `submit_plan` accepts, and what is stored.
//
//   pnpm --filter @pierre-review/backend test ai-fix/plan
import { describe, expect, it } from 'vitest';
import { AI_FIX_PLAN_BULLET_MAX_CHARS, AI_FIX_PLAN_MAX_BULLETS } from '@pierre-review/shared';
import {
  checkPlanSubmission,
  normalizePlan,
  parsePlan,
  parsePlanSeed,
  planReply,
  planStateOf,
  shownRefsOf,
} from './plan.js';

const SHOWN = ['F1', 'F2', 'T1'];
const good = {
  summary: ['Guard the null user in auth.ts', 'Close the stream on error'],
  steps: [
    { title: 'Null guard', files: ['src/auth.ts'], change: 'Return early when user is null.', refs: ['F1'] },
    { title: 'Close stream', files: ['./src/io.ts'], change: 'Close in finally.', refs: ['T1'] },
  ],
  notAddressed: [{ ref: 'F2', reason: 'The code already handles it.' }],
};

describe('checkPlanSubmission — the submit_plan tool refuses what the plan may not be', () => {
  it('accepts a plan within the limits', () => {
    expect(checkPlanSubmission(good, SHOWN)).toEqual([]);
  });

  it(`refuses more than ${AI_FIX_PLAN_MAX_BULLETS} summary bullets`, () => {
    const p = checkPlanSubmission({ ...good, summary: ['a', 'b', 'c', 'd', 'e', 'f'] }, SHOWN);
    expect(p.join(' ')).toMatch(/6 bullets; give at most 5/);
  });

  it('refuses an empty summary', () => {
    expect(checkPlanSubmission({ ...good, summary: [] }, SHOWN).join(' ')).toMatch(/at least one bullet/);
    // A bare marker is not a bullet.
    expect(checkPlanSubmission({ ...good, summary: ['- ', '•'] }, SHOWN).join(' ')).toMatch(/at least one bullet/);
  });

  it('refuses a bullet that is not short', () => {
    const long = 'x'.repeat(AI_FIX_PLAN_BULLET_MAX_CHARS + 1);
    expect(checkPlanSubmission({ ...good, summary: [long] }, SHOWN).join(' ')).toMatch(/longer than/);
  });

  it('refuses a ref the pass was not shown, naming the ones it was', () => {
    const p = checkPlanSubmission(
      { ...good, steps: [{ title: 't', change: 'c', refs: ['F9'] }], notAddressed: [{ ref: 'P3', reason: 'r' }] },
      SHOWN,
    );
    expect(p.join(' ')).toMatch(/Unknown refs F9, P3\. Use only the refs you were given: F1, F2, T1/);
  });

  it('a plain run has no refs at all', () => {
    const p = checkPlanSubmission({ summary: ['Do it'], steps: [{ title: 't', change: 'c', refs: ['F1'] }] }, []);
    expect(p.join(' ')).toMatch(/no item refs/);
    expect(checkPlanSubmission({ summary: ['Do it'], steps: [{ title: 't', change: 'c' }] }, [])).toEqual([]);
  });

  it('needs a step unless every item is declined', () => {
    expect(checkPlanSubmission({ summary: ['Nothing to do'], steps: [] }, SHOWN).join(' ')).toMatch(/at least one step/);
    expect(
      checkPlanSubmission({ summary: ['Nothing to do'], steps: [], notAddressed: [{ ref: 'F1', reason: 'wrong' }] }, SHOWN),
    ).toEqual([]);
  });
});

describe('normalizePlan — the stored plan', () => {
  it('keeps the shape, strips bullet markers and ./ prefixes, and reports what is left uncovered', () => {
    const plan = normalizePlan({ ...good, summary: ['- Guard it', '2. Close it'], notAddressed: [] }, SHOWN, 3);
    expect(plan.revision).toBe(3);
    expect(plan.summary).toEqual(['Guard it', 'Close it']);
    expect(plan.steps[1]?.files).toEqual(['src/io.ts']);
    expect(plan.notCovered).toEqual(['F2']);
  });

  it('caps the bullets and clips each one, even if the tool check was bypassed', () => {
    const plan = normalizePlan(
      { ...good, summary: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'x'.repeat(500)] },
      SHOWN,
      1,
    );
    expect(plan.summary).toHaveLength(AI_FIX_PLAN_MAX_BULLETS);
    const clipped = normalizePlan({ ...good, summary: ['x'.repeat(500)] }, SHOWN, 1).summary[0] ?? '';
    expect(clipped.length).toBeLessThanOrEqual(AI_FIX_PLAN_BULLET_MAX_CHARS);
  });

  it('drops unknown refs and keeps the first decline per ref', () => {
    const plan = normalizePlan(
      {
        summary: ['s'],
        steps: [{ title: 't', change: 'c', refs: ['F1', 'F9', 'F1'] }],
        notAddressed: [
          { ref: 'F2', reason: 'first' },
          { ref: 'F2', reason: 'second' },
          { ref: 'Z1', reason: 'invented' },
        ],
      },
      SHOWN,
      1,
    );
    expect(plan.steps[0]?.refs).toEqual(['F1']);
    expect(plan.notAddressed).toEqual([{ ref: 'F2', reason: 'first' }]);
    expect(plan.notCovered).toEqual(['T1']);
  });

  it('never throws on garbage', () => {
    expect(() => normalizePlan({ summary: 7, steps: 'no', notAddressed: [null] }, SHOWN, 1)).not.toThrow();
  });
});

describe('the stored columns', () => {
  it('planReply clips and drops a blank reply', () => {
    expect(planReply({ reply: '  ' })).toBeNull();
    expect(planReply({ reply: 'Moved the guard into the helper.' })).toBe('Moved the guard into the helper.');
  });

  it('shownRefsOf is the INCLUDED items only', () => {
    const item = (ref: string, included: boolean) => ({
      ref,
      kind: 'finding' as const,
      title: ref,
      path: null,
      line: null,
      findingId: null,
      threadId: null,
      ticketIndex: null,
      included,
    });
    expect(shownRefsOf([item('F1', true), item('F2', false)])).toEqual(['F1']);
    expect(shownRefsOf(null)).toEqual([]);
  });

  it('an older row reads as "never planned", and bad JSON degrades rather than throwing', () => {
    expect(planStateOf({ planStatus: null })).toBeNull();
    const st = planStateOf({ planStatus: 'plan_ready', planRevision: 2, plan: 'not json', planTranscript: '{', planCostUsd: 0.4 });
    expect(st).toEqual({ status: 'plan_ready', revision: 2, plan: null, transcript: [], costUsd: 0.4 });
    expect(parsePlan(JSON.stringify(normalizePlan(good, SHOWN, 1)))?.summary).toHaveLength(2);
    expect(parsePlanSeed('{"kind":"review","text":"x"}')).toEqual({ kind: 'review', text: 'x' });
    expect(parsePlanSeed('{"kind":"other","text":"x"}')).toBeNull();
  });
});
