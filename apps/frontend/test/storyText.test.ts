// A story read from the tracker, as the story views draw it: the pure half (`lib/storyText.ts`).
//
//   1. The criteria field: the server's pick is used; a changed field rebuilds the story.
//   2. A criteria field that opens with its own heading is not labelled twice.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/storyText.test.ts
import { describe, expect, it } from 'vitest';
import type { JiraAcCandidate, JiraTicketDetails, TicketRef } from '@pierre-review/shared';
import { acFieldText, criteriaHasOwnHeading, jiraStoryFromDetails, pulledAcField } from '../src/lib/storyText.js';

const ref = (key: string): TicketRef => ({
  key,
  url: `https://acme.atlassian.net/browse/${key}`,
  provider: 'jira',
  canFetchDetails: true,
});
const cand = (id: string, name: string, match: JiraAcCandidate['match'] = 'strong'): JiraAcCandidate => ({
  id,
  name,
  match,
  text: `${name} text`,
});
const details = (key: string, candidates: JiraAcCandidate[] = []): JiraTicketDetails => ({
  prId: 1,
  key,
  title: `${key} title`,
  description: 'Some *markdown*',
  issueType: { id: '10001', name: 'Story' },
  candidates,
  omittedCandidates: 0,
});

describe('the acceptance-criteria field', () => {
  const cands = [cand('cf_dod', 'Definition of Done', 'weak'), cand('cf_ac', 'Acceptance Criteria')];

  it('a pull records the field it used, and the tab says which', () => {
    const d = jiraStoryFromDetails(ref('A-1'), details('A-1', cands), pulledAcField(details('A-1', cands)));
    expect(d.acField).toEqual({ id: 'cf_ac', name: 'Acceptance Criteria' });
    expect(d.acceptanceCriteria).toBe('Acceptance Criteria text');
    expect(d.issueTypeId).toBe('10001');
    expect(d.source).toBe('jira');
    expect(acFieldText(d)).toBe('Acceptance Criteria');
    expect(acFieldText({ acField: null })).toBe('none');
    expect(acFieldText({})).toBe('not recorded');
  });

  it('changing the field rebuilds the story from the re-read ticket', () => {
    const d = jiraStoryFromDetails(ref('A-1'), details('A-1', cands), 'cf_dod');
    expect(d.acceptanceCriteria).toBe('Definition of Done text');
    expect(d.acField?.id).toBe('cf_dod');
    // "None of these": no criteria, and the tab says none.
    const none = jiraStoryFromDetails(ref('A-1'), details('A-1', cands), '');
    expect(none.acceptanceCriteria).toBe('');
    expect(none.acField).toBeNull();
  });

  it('a pull uses the field the SERVER picked; null is none; no acField falls back to the name match', () => {
    const base = details('A-1', cands);
    expect(pulledAcField({ ...base, acField: { id: 'cf_dod', name: 'Definition of Done' } })).toBe('cf_dod');
    expect(pulledAcField({ ...base, acField: null })).toBe('');
    expect(pulledAcField(base)).toBe('cf_ac');
  });
});

describe('the criteria label is not printed twice', () => {
  it('a field that opens with its own "Acceptance criteria" heading drops the label', () => {
    expect(criteriaHasOwnHeading('# **ACCEPTANCE CRITERIA**\n\n| a |')).toBe(true);
    expect(criteriaHasOwnHeading('\n## Acceptance Criteria:\n- x')).toBe(true);
    expect(criteriaHasOwnHeading('# Acceptance criteria for upload')).toBe(false);
    expect(criteriaHasOwnHeading('Acceptance criteria\n- x')).toBe(false);
    expect(criteriaHasOwnHeading('')).toBe(false);
  });
});
