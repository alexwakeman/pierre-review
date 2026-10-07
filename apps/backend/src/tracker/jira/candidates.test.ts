// ── ACCEPTANCE-CRITERIA CANDIDATES, read off ONE ticket ────────────────────────────────────────
//
// Real Jira sites carry several fields named "Acceptance Criteria" and the one in use varies by
// issue type, so the panel offers every custom text field on the ticket. Pinned here:
//   1. what counts as text (string, ADF, a single-select option) and what is skipped;
//   2. the exclusion list (system fields incl. summary/description, ranks, sprints, epic links,
//      dates, users, numbers, development metadata);
//   3. the ranking (strong name match, then weak, then the rest by name);
//   4. the cap — ranked FIRST, then cut, with the cut counted — and that no text is truncated.
//
//   ./apps/backend/node_modules/.bin/vitest run --root packages/pro test/jira-candidates.test.ts
import { describe, expect, it } from 'vitest';
import {
  JIRA_AC_CANDIDATE_CAP,
  acNameMatch,
  candidateText,
  extractAcCandidates,
} from './candidates.js';

const adf = (text: string) => ({
  type: 'doc',
  version: 1,
  content: [
    {
      type: 'bulletList',
      content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }],
    },
  ],
});

describe('acNameMatch', () => {
  it.each([
    ['Acceptance Criteria', 'strong'],
    ['acceptance_criteria', 'strong'],
    ['Acceptance-Criterion', 'strong'],
    ['Story acceptance criteria (legacy)', 'strong'],
    ['AC', 'weak'],
    ['AC notes', 'weak'],
    ['Definition of Done', 'weak'],
    ['Accessibility', null],
    ['Tech notes', null],
  ] as const)('%s → %s', (name, want) => {
    expect(acNameMatch(name)).toBe(want);
  });
});

describe('candidateText — what counts as text', () => {
  it('a string (wiki markup rewritten to markdown, like the description), ADF flattened, a single-select option', () => {
    expect(candidateText('* one\r\n* two')).toBe('- one\n- two');
    expect(candidateText('h1. *Criteria*')).toBe('# **Criteria**');
    expect(candidateText(adf('Link is emailed'))).toBe('- Link is emailed');
    expect(candidateText({ self: 'https://x', value: 'Must pass QA', id: '10020' })).toBe('Must pass QA');
  });

  it('empty, arrays, numbers, users and objects without a plain value are skipped', () => {
    expect(candidateText('')).toBeNull();
    expect(candidateText('   ')).toBeNull();
    expect(candidateText(null)).toBeNull();
    expect(candidateText(['a', 'b'])).toBeNull();
    expect(candidateText([{ value: 'x' }])).toBeNull();
    expect(candidateText(3)).toBeNull();
    expect(candidateText({ accountId: 'abc', displayName: 'Sam' })).toBeNull();
    expect(candidateText({ type: 'doc', content: [] })).toBeNull();
  });

  it('metadata-shaped strings are skipped: numbers, dates, the development "{…}" blob', () => {
    expect(candidateText('13')).toBeNull();
    expect(candidateText('2026-09-01')).toBeNull();
    expect(candidateText('2026-09-01T10:20:30.000+0100')).toBeNull();
    expect(candidateText('{}')).toBeNull();
    expect(candidateText('{pullrequest={dataType=pullrequest, state=OPEN}}')).toBeNull();
  });

  it('never truncates', () => {
    expect(candidateText('x'.repeat(30_000))).toHaveLength(30_000);
  });
});

describe('extractAcCandidates', () => {
  const fields = {
    summary: 'Reset password',
    description: 'As a user…',
    environment: 'prod', // a system field — never a candidate
    customfield_10019: '0|i0001:', // Rank
    customfield_10020: 'Sprint 12', // Sprint (a plugin may hand back a string)
    customfield_10014: 'ENG-1', // Epic Link
    customfield_10015: '2026-10-01', // Start date
    customfield_10016: 5, // Story points
    customfield_10000: '{}', // Development
    customfield_10050: { accountId: 'x', displayName: 'Sam' }, // a user picker
    customfield_10400: adf('Email is sent'), // Acceptance Criteria (strong)
    customfield_10401: 'Given a user\nWhen…', // Acceptance criteria (Bug) (strong)
    customfield_10402: '', // Acceptance Criteria — empty on this ticket
    customfield_10500: '- tests pass', // Definition of Done (weak)
    customfield_10600: 'Talk to ops first', // Notes
    customfield_10700: { value: 'Needs design' }, // Design state (option)
    customfield_10800: ['a', 'b'], // Labels-ish
  };
  const names = {
    summary: 'Summary',
    description: 'Description',
    environment: 'Environment',
    customfield_10019: 'Rank',
    customfield_10020: 'Sprint',
    customfield_10014: 'Epic Link',
    customfield_10015: 'Start date',
    customfield_10016: 'Story Points',
    customfield_10000: 'Development',
    customfield_10050: 'Reviewer',
    customfield_10400: 'Acceptance Criteria',
    customfield_10401: 'Acceptance criteria (Bug)',
    customfield_10402: 'Acceptance Criteria',
    customfield_10500: 'Definition of Done',
    customfield_10600: 'Notes',
    customfield_10700: 'Design state',
    customfield_10800: 'Checklist',
  };
  const schemas = {
    customfield_10019: { type: 'any', custom: 'com.pyxis.greenhopper.jira:gh-lexo-rank' },
    customfield_10020: { type: 'array', custom: 'com.pyxis.greenhopper.jira:gh-sprint' },
    customfield_10014: { type: 'any', custom: 'com.pyxis.greenhopper.jira:gh-epic-link' },
    customfield_10015: { type: 'date' },
    customfield_10016: { type: 'number' },
    customfield_10000: { type: 'any', custom: 'com.atlassian.jira.plugins.jira-development-integration-plugin:devsummarycf' },
    customfield_10050: { type: 'user' },
    customfield_10400: { type: 'string' },
    customfield_10401: { type: 'string' },
    customfield_10500: { type: 'string' },
    customfield_10600: { type: 'string' },
    customfield_10700: { type: 'option' },
  };

  it('keeps only custom text fields, ranked strong → weak → the rest by name', () => {
    const { candidates, omitted } = extractAcCandidates(fields, names, schemas);
    expect(candidates.map((c) => [c.id, c.match])).toEqual([
      ['customfield_10400', 'strong'],
      ['customfield_10401', 'strong'],
      ['customfield_10500', 'weak'],
      ['customfield_10700', null],
      ['customfield_10600', null],
    ]);
    expect(omitted).toBe(0);
    expect(candidates[0]).toEqual({
      id: 'customfield_10400',
      name: 'Acceptance Criteria',
      text: '- Email is sent',
      match: 'strong',
    });
  });

  it('excludes by name even without a schema (ranks, sprints, epic links, story points)', () => {
    const { candidates } = extractAcCandidates(
      { customfield_1: '0|abc', customfield_2: 'Sprint 3', customfield_3: 'ENG-1', customfield_4: 'x' },
      { customfield_1: 'Rank', customfield_2: 'Sprint', customfield_3: 'Epic Link', customfield_4: 'Story Points' },
      undefined,
    );
    expect(candidates).toEqual([]);
  });

  it(`caps at ${JIRA_AC_CANDIDATE_CAP} AFTER ranking, counts the cut, and truncates no text`, () => {
    const many: Record<string, unknown> = {};
    const nm: Record<string, unknown> = {};
    for (let i = 0; i < JIRA_AC_CANDIDATE_CAP + 7; i++) {
      many[`customfield_${20000 + i}`] = `text ${i}`;
      nm[`customfield_${20000 + i}`] = `Field ${String(i).padStart(3, '0')}`;
    }
    // The strong match sorts LAST by name, so only ranking can keep it inside the cap.
    many.customfield_99999 = 'y'.repeat(12_000);
    nm.customfield_99999 = 'Zz Acceptance Criteria';
    const { candidates, omitted } = extractAcCandidates(many, nm, undefined);
    expect(candidates).toHaveLength(JIRA_AC_CANDIDATE_CAP);
    expect(omitted).toBe(8);
    expect(candidates[0]?.id).toBe('customfield_99999');
    expect(candidates[0]?.text).toHaveLength(12_000);
  });
});
