// db/story-selection.ts — the story report's picks, PURE (no DB). Pinned:
//  • the four groups and their caps (done_well 6 · fell_short 6 · no_criteria 4 · outlier 3);
//  • ⚠ a story with NO criteria is NEVER filed under fell_short, even with a review that is not aligned;
//  • the whole-window figures count EVERY story, not the picks;
//  • determinism: the same stories in any order pick the same keys in the same order.
import { describe, expect, it } from 'vitest';
import type { StoryCriteriaSource, StoryIssueInput, StoryReviewSummary, StoryRow } from '@pierre-review/shared';
import type { StoryInternals } from './stories.js';
import { selectStories, storyIssueRates, storyIssuesAsWritten } from './story-selection.js';

let n = 0;
function story(o: {
  key?: string;
  hours?: number;
  lines?: number | null;
  prs?: number;
  criteria?: number | null;
  source?: StoryCriteriaSource;
  review?: Partial<StoryReviewSummary> | null;
  lastMerged?: string;
}): StoryInternals {
  n += 1;
  const key = o.key ?? `ENG-${n}`;
  const review: StoryReviewSummary | null =
    o.review === undefined || o.review === null
      ? null
      : { id: n, alignment: 'aligned', met: 0, partlyMet: 0, notMet: 0, unclear: 0, notChecked: 0, total: 0, missing: 0, checkedAt: null, ...o.review };
  const unmet = review ? review.notMet + review.partlyMet + review.missing : 0;
  const row: StoryRow = {
    ident: `jira:https://acme#${key}`,
    key,
    title: `Story ${key}`,
    url: `https://acme/browse/${key}`,
    provider: 'jira',
    prs: { total: o.prs ?? 1, open: 0, merged: o.prs ?? 1, closed: 0, mergedInWindow: o.prs ?? 1 },
    pullRequests: [],
    firstOpenedAt: '2026-09-01T00:00:00.000Z',
    lastMergedAt: o.lastMerged ?? '2026-09-10T00:00:00.000Z',
    workingHours: o.hours ?? 10,
    clockHours: o.hours ?? 10,
    linesChanged: o.lines === undefined ? 100 : o.lines,
    files: 1,
    unsizedPrs: 0,
    criteria: { count: o.criteria ?? null, source: o.source ?? (o.criteria != null ? 'acceptance_criteria' : 'none') },
    review,
    unmetCount: unmet,
  };
  return { row, ticket: null, review: null, prs: new Map() };
}

describe('selectStories', () => {
  it('files a reviewed shortfall under fell_short and an all-met review with ≥3 criteria under done_well', () => {
    const s = selectStories(
      [
        story({ key: 'A-1', criteria: 4, source: 'review', review: { alignment: 'partly_aligned', notMet: 2, total: 4 } }),
        story({ key: 'A-2', criteria: 5, source: 'review', review: { alignment: 'aligned', met: 5, total: 5 } }),
        story({ key: 'A-3', criteria: null, source: 'none' }),
      ],
      8,
    );
    const g = Object.fromEntries(s.candidates.map((c) => [c.key, c.group]));
    expect(g).toEqual({ 'A-1': 'fell_short', 'A-2': 'done_well', 'A-3': 'no_criteria' });
    expect(s.candidates.find((c) => c.key === 'A-2')!.whyPicked).toContain('review: all 5 criteria met');
    expect(s.internalsByKey.get('A-1')!.row.key).toBe('A-1');
  });

  it('⚠ a story with no criteria is NEVER fell_short, even when its review is not aligned', () => {
    const s = selectStories(
      [story({ key: 'B-1', criteria: null, source: 'none', review: { alignment: 'not_aligned', missing: 3, total: 0 } })],
      8,
    );
    expect(s.candidates).toHaveLength(1);
    expect(s.candidates[0]!.group).toBe('no_criteria');
    expect(s.candidates.every((c) => c.group !== 'fell_short' || c.criteriaSource !== 'none')).toBe(true);
  });

  it('caps every group', () => {
    const many = [
      ...Array.from({ length: 10 }, (_, i) => story({ key: `W-${i}`, criteria: 5, source: 'review', review: { alignment: 'aligned', met: 5, total: 5 } })),
      ...Array.from({ length: 10 }, (_, i) => story({ key: `S-${i}`, criteria: 4, source: 'review', review: { alignment: 'partly_aligned', notMet: 1 + (i % 3), total: 4 } })),
      ...Array.from({ length: 10 }, (_, i) => story({ key: `N-${i}`, criteria: null, source: 'none' })),
    ];
    const s = selectStories(many, 8);
    const count = (g: string) => s.candidates.filter((c) => c.group === g).length;
    expect(count('done_well')).toBe(6);
    expect(count('fell_short')).toBe(6);
    expect(count('no_criteria')).toBe(4);
    expect(s.candidates.length).toBeLessThanOrEqual(19);
    // The biggest shortfalls first.
    expect(s.candidates.filter((c) => c.group === 'fell_short')[0]!.review!.notMet).toBe(3);
  });

  it('picks a small slow story with criteria as an odd one out', () => {
    const base = Array.from({ length: 9 }, (_, i) => story({ key: `P-${i}`, hours: 5 + i, lines: 500 + i, criteria: 1 }));
    const s = selectStories([...base, story({ key: 'O-1', hours: 400, lines: 3, criteria: 1 })], 8);
    const o = s.candidates.find((c) => c.key === 'O-1')!;
    expect(o.group).toBe('outlier');
    expect(o.whyPicked).toContain('small change that took a long time');
  });

  it('counts the WHOLE window in the figures, not just the picks', () => {
    const all = [
      story({ criteria: 2, source: 'acceptance_criteria', hours: 4 }),
      story({ criteria: 2, source: 'description_heading', hours: 8 }),
      story({ criteria: null, source: 'none', hours: 20 }),
      story({ criteria: 2, source: 'review', review: { alignment: 'aligned', met: 2, total: 2 }, hours: 30 }),
      story({ criteria: 2, source: 'review', review: { alignment: 'aligned', partlyMet: 1, total: 2 }, hours: 50 }),
    ];
    const s = selectStories(all, 8, true);
    expect(s.population).toEqual({
      storiesInWindow: 5,
      withWrittenCriteria: 1,
      criteriaOnlyInDescription: 1,
      noCriteriaFound: 1,
      checkedByTicketReview: 2,
      checkedAndFullyMet: 1,
      checkedWithGaps: 1,
      medianWorkingHours: 20,
      workingDayHours: 8,
      truncated: true,
    });
    expect(selectStories([], 8).population.medianWorkingHours).toBeNull();
  });

  it('is deterministic under input order', () => {
    const xs = [
      story({ key: 'D-1', criteria: 4, source: 'review', review: { alignment: 'partly_aligned', notMet: 1, total: 4 } }),
      story({ key: 'D-2', criteria: 4, source: 'review', review: { alignment: 'partly_aligned', notMet: 1, total: 4 } }),
      story({ key: 'D-3', criteria: null, source: 'none' }),
      story({ key: 'D-4', criteria: 6, source: 'review', review: { alignment: 'aligned', met: 6, total: 6 } }),
    ];
    const a = selectStories(xs, 8).candidates.map((c) => c.key);
    const b = selectStories([...xs].reverse(), 8).candidates.map((c) => c.key);
    expect(b).toEqual(a);
  });

  it('carries each pick\'s story issues AS WRITTEN and whole-window issue rates by the measure rule', () => {
    const a = story({ key: 'I-1', criteria: 4, source: 'review', review: { alignment: 'aligned', met: 4, total: 4 } });
    const b = story({ key: 'I-2', criteria: null, source: 'none' });
    const c = story({ key: 'I-3', criteria: 12 }); // not picked; unlabelled
    const d = story({ key: 'I-4', criteria: 5 }); // ticket never read
    const crit = (k: number) => Array.from({ length: k }, (_, i) => `c${i + 1}`);
    const label = {
      criteria: crit(4).map((_, i) => ({ n: i + 1, testable: i !== 2, reason: i === 2 ? 'no expected result' : null })),
      story: { dependencies: [], gaps: [{ type: 'data' as const, text: 'No source for the prices' }] },
    };
    // I-1's only blocker is FINISHED: it still waited on it, so as written it is Blocked.
    const done = { key: 'X-9', title: 'Pricing API', status: 'Done', category: 'done' as const, relation: 'is blocked by', url: null };
    const inputs = new Map<string, StoryIssueInput | null>([
      [a.row.ident, { criteria: crit(4), label, links: [done] }],
      [b.row.ident, { criteria: [], label: null }],
      [c.row.ident, { criteria: crit(12), label: null }],
      [d.row.ident, null],
    ]);
    const s = selectStories([a, b, c, d], 8, false, inputs);
    const by = new Map(s.candidates.map((x) => [x.key, x]));
    expect(by.get('I-1')!.issues!.map((i) => i.id)).toEqual(['unclear_done', 'blocked', 'spec_gaps']);
    expect(by.get('I-1')!.issues![0]!.criteria).toEqual([{ n: 3, reason: 'no expected result' }]);
    expect(by.get('I-1')!.issues![1]!.blockers.map((x) => [x.ticketKey, x.resolved])).toEqual([['X-9', true]]);
    expect(by.get('I-2')!.issues!.map((i) => i.id)).toEqual(['unclear_done']);
    expect(by.get('I-1')!.issueStates).toEqual({ unclear_done: true, blocked: true, spec_gaps: true });
    // No label: what code knows is true, the rest NOT KNOWN — never false.
    expect(by.get('I-2')!.issueStates).toEqual({ unclear_done: true, blocked: null, spec_gaps: null });
    // ⚠ ONE population: only the labelled story counts, for every issue — the no-criteria story is
    // `noCriteriaFound`, the unlabelled story and the unread ticket are out.
    expect(s.population.noCriteriaFound).toBe(1);
    expect(s.population.issueRates).toEqual([
      { id: 'unclear_done', stories: 1, of: 1 },
      { id: 'blocked', stories: 1, of: 1 },
      // spec_gaps is HELD (STORY_HEALTH_HELD), so its rate is not handed to the report.
    ]);
    // Without inputs, no issue fields are written (old callers, old rows).
    const plain = selectStories([a, b], 8);
    expect(plain.population.issueRates).toBeUndefined();
    expect(plain.candidates[0]!.issues).toBeUndefined();
    expect(storyIssueRates([])).toHaveLength(3);
  });

  it('storyIssuesAsWritten: an unlabelled story with only a link is blocked and nothing else is known', () => {
    const open = { key: 'X-1', title: 'API', status: 'To Do', category: 'new' as const, relation: 'depends on', url: null };
    const w = storyIssuesAsWritten({ criteria: ['a', 'b'], label: null, links: [open] });
    expect(w.issues.map((i) => [i.id, i.reasons])).toEqual([['blocked', ['linked']]]);
    expect(w.states).toEqual({ unclear_done: null, blocked: true, spec_gaps: null });
  });
});
