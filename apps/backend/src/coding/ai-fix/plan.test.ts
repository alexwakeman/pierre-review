// The REMOVED plan mode's stored columns, read for history only (plan.ts).
//
//   pnpm --filter @pierre-review/backend test ai-fix/plan
import { describe, expect, it } from 'vitest';
import { parsePlan, parseTranscript, planStateOf } from './plan.js';

const stored = {
  revision: 1,
  summary: ['Guard the null user in auth.ts', 'Close the stream on error'],
  steps: [{ title: 'Null guard', files: ['src/auth.ts'], change: 'Return early when user is null.', refs: ['F1'] }],
  notAddressed: [{ ref: 'F2', reason: 'The code already handles it.' }],
  notCovered: [],
};

describe('the stored plan columns', () => {
  it('an older row reads as "never planned", and bad JSON degrades rather than throwing', () => {
    expect(planStateOf({ planStatus: null })).toBeNull();
    const st = planStateOf({ planStatus: 'plan_ready', planRevision: 2, plan: 'not json', planTranscript: '{', planCostUsd: 0.4 });
    expect(st).toEqual({ status: 'plan_ready', revision: 2, plan: null, transcript: [], costUsd: 0.4 });
  });

  it('a stored plan and transcript read back', () => {
    expect(parsePlan(JSON.stringify(stored))?.summary).toHaveLength(2);
    expect(parsePlan('[1]')).toBeNull();
    const t = parseTranscript(JSON.stringify([{ role: 'reader', text: 'hi' }, { role: 'other', text: 'x' }, 7]));
    expect(t).toEqual([{ role: 'reader', text: 'hi' }]);
  });

  it('an unknown plan status reads as never planned', () => {
    expect(planStateOf({ planStatus: 'weird' })).toBeNull();
  });
});
