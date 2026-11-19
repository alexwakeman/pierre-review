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
    expect(s).toContain('## Review in Ensemble');
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

  it('a criterion the agent says it cannot meet is counted NOT MET and listed with its reason, defanged', () => {
    const s = loopBodySection({
      reviews: 2,
      providers: ['claude'],
      fixed: 1,
      answered: 0,
      pushedBackAccepted: 0,
      stillOpen: [],
      criteria: { met: 1, notApplicable: [], notMet: 1, cannotMeet: [{ ref: 'AC2', why: 'Billing sends it; ask @dana.' }] },
    });
    expect(s).toContain('Acceptance criteria: 1 met, 0 not applicable, 1 not met.');
    expect(s).toContain('Not met, and the agent says these cannot be done:');
    expect(s).toContain('- AC2: Billing sends it; ask @\u200bdana.');
  });

  it('ends the PR body, with no "Built with Limn" footer', () => {
    const body = storyBuildPrBody({ summary: 's', ticketKey: 'PAY-1', ticketTitle: 't', ticketUrl: null, covers: [], siblings: [], stackedOnPrNumber: null, closes: null, review: '## Review in Ensemble\n\nReviewed once by Claude before this pull request opened.' });
    expect(body.indexOf('## Review in Ensemble')).toBeGreaterThan(0);
    expect(body.trimEnd().endsWith('Reviewed once by Claude before this pull request opened.')).toBe(true);
    expect(body).not.toContain('Built with');
    expect(storyBuildPrBody({ summary: 's', ticketKey: 'PAY-1', ticketTitle: 't', ticketUrl: null, covers: [], siblings: [], stackedOnPrNumber: null, closes: null })).not.toContain('Review in Ensemble');
  });

  it('names criteria met outside the ticket apart, in the counts\' own words', () => {
    const s = loopBodySection({
      reviews: 2,
      providers: ['claude'],
      fixed: 1,
      answered: 0,
      pushedBackAccepted: 0,
      stillOpen: [],
      criteria: { met: 4, outsideTicket: 1, notApplicable: [], notMet: 0, unlinked: 1 },
    });
    expect(s).toContain(
      'Acceptance criteria: 4 met, 1 already outside the ticket, 0 not applicable, 0 not met, 1 only in a pull request on the same branch that is not linked to the ticket.',
    );
    const plain = loopBodySection({ reviews: 1, providers: ['claude'], fixed: 0, answered: 0, pushedBackAccepted: 0, stillOpen: [], criteria: { met: 2, notApplicable: [], notMet: 1 } });
    expect(plain).toContain('Acceptance criteria: 2 met, 0 not applicable, 1 not met.');
  });
});

