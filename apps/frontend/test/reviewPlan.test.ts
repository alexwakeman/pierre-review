import { describe, expect, it } from 'vitest';
import type { ClaudeCoverageItem } from '@pierre-review/shared';
import { reviewPlanCounts, reviewPlanLine } from '../src/components/ReviewPlan.js';

const item = (ref: string, status: ClaudeCoverageItem['status']): ClaudeCoverageItem => ({
  ref,
  path: `src/${ref}.js`,
  reasons: ['+1 −0'],
  status,
  note: null,
});

describe('the review plan line', () => {
  it('counts what was checked and names what was not', () => {
    const items = [item('W1', 'issues'), item('W2', 'no_issues'), item('W3', 'not_reviewed')];
    expect(reviewPlanCounts(items)).toEqual({ total: 3, checked: 2, notReviewed: 1 });
    expect(reviewPlanLine(items)).toBe('Review plan: 3 files, 2 checked, 1 not reviewed');
    expect(reviewPlanLine([item('W1', 'no_issues')])).toBe('Review plan: 1 file, 1 checked');
  });
});
