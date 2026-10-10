// db/story-criteria.ts — the deterministic criteria count Reports → Stories plots against size.
// Pure; no database.
import { describe, expect, it } from 'vitest';
import { acceptanceSectionOf, countCriteriaLines, extractCriteria, textCriteriaCount } from './story-criteria.js';

const md = { jira: false };
const jira = { jira: true };

describe('countCriteriaLines', () => {
  it('counts Markdown bullets and task boxes, top level only', () => {
    expect(countCriteriaLines('- a\n- b\n  - detail of b\n- c', md)).toBe(3);
    expect(countCriteriaLines('- [ ] one\n- [x] two', md)).toBe(2);
    expect(countCriteriaLines('1. one\n2) two\n3. three', md)).toBe(3);
  });

  it('reads Jira * and # runs as list depth, and h-headings as headings', () => {
    expect(countCriteriaLines('h3. Acceptance criteria\n* a\n** sub\n* b', jira)).toBe(2);
    expect(countCriteriaLines('# first\n# second\n## nested', jira)).toBe(2);
  });

  it('treats a Markdown "# " line as a heading, not an item', () => {
    expect(countCriteriaLines('# Acceptance\n- a\n- b', md)).toBe(2);
  });

  it('strips {color} markup and skips blank and label-only lines', () => {
    expect(countCriteriaLines('{color:#172b4d}*Acceptance criteria:*{color}\n\n* one\n* two', jira)).toBe(2);
  });

  it('without bullets, counts lines and folds Given/When/Then into one criterion', () => {
    expect(countCriteriaLines('Given a user\nWhen they log in\nThen they see home\nAnd a toast', md)).toBe(1);
    expect(countCriteriaLines('Users can export CSV\nAdmins can delete rows', md)).toBe(2);
  });

  it('is 0 for nothing', () => {
    expect(countCriteriaLines(null, md)).toBe(0);
    expect(countCriteriaLines('  \n\n', md)).toBe(0);
  });
});

describe('acceptanceSectionOf', () => {
  it('cuts the section under the heading up to the next heading', () => {
    const d = 'Intro text\n## Acceptance criteria\n- a\n- b\n## Notes\n- not a criterion';
    expect(countCriteriaLines(acceptanceSectionOf(d, md), md)).toBe(2);
  });
  it('accepts a bold label line and a Jira heading', () => {
    expect(countCriteriaLines(acceptanceSectionOf('blah\n**Acceptance Criteria**\n- a\n\n**Out of scope**\n- x', md), md)).toBe(1);
    expect(countCriteriaLines(acceptanceSectionOf('h2. Acceptance Criteria\n* a\n* b\nh2. Tech notes\n* c', jira), jira)).toBe(2);
  });
  it('is null with no such heading', () => {
    expect(acceptanceSectionOf('We need acceptance criteria someday.\n- a', md)).toBeNull();
  });
});

describe('textCriteriaCount', () => {
  it('prefers the criteria field, then the description heading, else none (null, never 0)', () => {
    expect(textCriteriaCount({ acceptanceCriteria: '- a\n- b', description: '## Acceptance criteria\n- x' }, 'github')).toEqual({
      count: 2,
      source: 'acceptance_criteria',
    });
    expect(textCriteriaCount({ acceptanceCriteria: '', description: 'h3. Acceptance criteria\n* x\n* y\n* z' }, 'jira')).toEqual({
      count: 3,
      source: 'description_heading',
    });
    expect(textCriteriaCount({ acceptanceCriteria: null, description: 'Just do the thing.' }, 'jira')).toEqual({
      count: null,
      source: 'none',
    });
  });
});

describe('extractCriteria', () => {
  it('returns one string per top-level bullet, markers and task boxes stripped, sub-bullets folded in', () => {
    expect(extractCriteria('- a\n- b\n  - detail of b\n- c', md)).toEqual(['a', 'b detail of b', 'c']);
    expect(extractCriteria('- [ ] one\n- [x] two', md)).toEqual(['one', 'two']);
    expect(extractCriteria('1. one\n2) two', md)).toEqual(['one', 'two']);
  });

  it('reads Jira runs as depth and drops headings, label lines and a preamble', () => {
    expect(extractCriteria('h3. Acceptance criteria\n* a\n** sub\n* b', jira)).toEqual(['a sub', 'b']);
    expect(extractCriteria('{color:#172b4d}*Acceptance criteria:*{color}\n\n# first\n# second', jira)).toEqual([
      'first',
      'second',
    ]);
    expect(extractCriteria('The page must:\n- load\n- save', md)).toEqual(['load', 'save']);
  });

  it('without bullets, one line each with Given/When/Then folded into one', () => {
    expect(extractCriteria('Given a user\nWhen they log in\nThen they see home', md)).toEqual([
      'Given a user When they log in Then they see home',
    ]);
    expect(extractCriteria('Users can export CSV\nAdmins can delete rows', md)).toEqual([
      'Users can export CSV',
      'Admins can delete rows',
    ]);
  });

  it('is [] for nothing', () => {
    expect(extractCriteria(null, md)).toEqual([]);
    expect(extractCriteria('```\n```', md)).toEqual([]);
  });

  it('agrees with countCriteriaLines on every shape (the count IS the list length)', () => {
    const samples = [
      '- a\n- b\n  - c',
      'h3. AC\n* a\n** b\n* c\n\ntext after',
      '# x\n## y\n# z',
      'Given a\nWhen b\nThen c\nUsers can x',
      'intro\n  - deep\n- top',
      '{color:red}* red{color}\n* blue',
      '',
    ];
    for (const t of samples) {
      for (const o of [md, jira]) expect(countCriteriaLines(t, o)).toBe(extractCriteria(t, o).length);
    }
  });
});

describe('acceptanceSectionOf — sub-labels inside the section', () => {
  it('carries "For option N:" onto its items instead of ending the section', () => {
    const d = [
      'Acceptance criteria',
      'For option 1:',
      '- generate:scenarios writes rounded areas.',
      '- The comparison reports no differences.',
      'For option 2:',
      '- Units use the unrounded size.',
      'References:',
      '- G-4 temporal multipliers',
    ].join('\n');
    const sec = acceptanceSectionOf(d, { jira: false });
    expect(extractCriteria(sec, { jira: false })).toEqual([
      'For option 1: generate:scenarios writes rounded areas.',
      'For option 1: The comparison reports no differences.',
      'For option 2: Units use the unrounded size.',
    ]);
  });

  it('still ends at a colon line with no list under it', () => {
    const d = ['Acceptance criteria', '- A works.', 'Owner:', 'Someone'].join('\n');
    expect(extractCriteria(acceptanceSectionOf(d, { jira: false }), { jira: false })).toEqual(['A works.']);
  });
});

it('ends the section at a bare "References" line', () => {
  const d = ['Acceptance criteria', '- A works.', '- B works.', 'References', '- G-4 multipliers'].join('\n');
  expect(extractCriteria(acceptanceSectionOf(d, { jira: false }), { jira: false })).toEqual(['A works.', 'B works.']);
});
