// THE REVIEW LOOP'S PR BODY SECTION (loop/pr-body.ts) and its place in the PR body (push.ts).
import { describe, expect, it } from 'vitest';
import { loopBodySection, LOOP_BODY_MAX } from './pr-body.js';
import { storyBuildPrBody } from '../push.js';

describe('loopBodySection', () => {
  it('summarises the rounds, the answers and the criteria; still-open items defanged', () => {
    const s = loopBodySection({
      reviews: 3,
      providers: ['claude', 'codex'],
      fixed: 9,
      answered: 3,
      pushedBackAccepted: 2,
      stillOpen: [{ severity: 'warning', path: 'src/a.ts', title: 'Fixes #12 for @alice' }],
      criteria: { met: 5, notApplicable: [{ ref: 'AC4', why: 'Emails are another team.' }], notMet: 0 },
    });
    expect(s).toContain('## Review in Limn');
    expect(s).toContain('Reviewed 3 times by Claude and Codex before this pull request opened.');
    expect(s).toContain('Fixed: 9 · Answered: 3 · Pushed back and accepted: 2 · Still open: 1');
    expect(s).toContain('Acceptance criteria: 5 met, 1 not applicable (AC4: Emails are another team.), 0 not met.');
    expect(s).toContain('Still open:');
    expect(s).toContain('F​ixes #12');
    expect(s).toContain('@\u200balice');
    expect(s.length).toBeLessThanOrEqual(LOOP_BODY_MAX);
  });

  it('defangs mentions and closing words in a not-applicable reason and its ref', () => {
    const s = loopBodySection({
      reviews: 1,
      providers: ['claude'],
      fixed: 0,
      answered: 0,
      pushedBackAccepted: 0,
      stillOpen: [],
      criteria: { met: 0, notApplicable: [{ ref: '@bob', why: 'Ask @carol; fixes #1 later.' }], notMet: 0 },
    });
    expect(s).toContain('@\u200bbob');
    expect(s).toContain('@\u200bcarol');
    expect(s).toContain('f\u200bixes #1');
    expect(s).not.toMatch(/(^|[^\w`])@[A-Za-z]/);
  });

  it('ends the PR body, with no "Built with Limn" footer', () => {
    const body = storyBuildPrBody({ summary: 's', ticketKey: 'PAY-1', ticketTitle: 't', ticketUrl: null, covers: [], siblings: [], stackedOnPrNumber: null, closes: null, review: '## Review in Limn\n\nReviewed once by Claude before this pull request opened.' });
    expect(body.indexOf('## Review in Limn')).toBeGreaterThan(0);
    expect(body.trimEnd().endsWith('Reviewed once by Claude before this pull request opened.')).toBe(true);
    expect(body).not.toContain('Built with');
    expect(storyBuildPrBody({ summary: 's', ticketKey: 'PAY-1', ticketTitle: 't', ticketUrl: null, covers: [], siblings: [], stackedOnPrNumber: null, closes: null })).not.toContain('Review in Limn');
  });
});
