// A STORY READ FROM THE TRACKER (lib/jiraTicket.ts): the pure half.
//
//   1. A FILL REPLACES title + description; the criteria change only through a CHOSEN candidate,
//      and the blank option leaves them as they are.
//   2. THE DEFAULT CHOICE (shared, applied SERVER-side): the workspace's field for this issue type
//      when THIS ticket has it; else the best STRONG name match (exact "Acceptance Criteria" first;
//      weak matches never preselect); else blank. A story uses the field the server names
//      (`serverAcField`), falling back to that rule for an older server that names none.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/jiraTicket.test.ts
import { describe, expect, it } from 'vitest';
import type { JiraAcCandidate, JiraTicketDetails } from '@pierre-review/shared';
import { applyAcCandidate, applyJiraTicket, defaultAcCandidate, jiraSiteOf, serverAcField } from '../src/lib/jiraTicket.js';

const cand = (id: string, name: string, match: JiraAcCandidate['match'], text = `${name} text`) => ({
  id,
  name,
  text,
  match,
});

const candidates: JiraAcCandidate[] = [
  cand('customfield_2', 'Acceptance criteria (Bug)', 'strong'),
  cand('customfield_1', 'Acceptance Criteria', 'strong'),
  cand('customfield_3', 'Definition of Done', 'weak'),
  cand('customfield_4', 'Notes', null),
];

const details = (over: Partial<JiraTicketDetails> = {}): JiraTicketDetails => ({
  prId: 1,
  key: 'ENG-1',
  title: 'Reset password',
  description: 'As a user…',
  issueType: { id: '10001', name: 'Story' },
  candidates,
  omittedCandidates: 0,
  ...over,
});

describe('applying a fill', () => {
  const draft = { title: 'old', description: 'old', acceptanceCriteria: 'my paste' };
  it('replaces title and description, never the criteria', () => {
    expect(applyJiraTicket(draft, details())).toEqual({
      title: 'Reset password',
      description: 'As a user…',
      acceptanceCriteria: 'my paste',
    });
  });
  it('a chosen candidate fills the criteria box; blank leaves it as it is', () => {
    expect(applyAcCandidate(draft, candidates, 'customfield_3').acceptanceCriteria).toBe(
      'Definition of Done text',
    );
    expect(applyAcCandidate(draft, candidates, '')).toBe(draft);
    expect(applyAcCandidate(draft, candidates, 'customfield_999')).toBe(draft);
  });
});

describe('defaultAcCandidate', () => {
  it('a remembered field wins when THIS ticket has it', () => {
    expect(defaultAcCandidate(candidates, 'customfield_4')).toBe('customfield_4');
  });
  it('a remembered field this ticket lacks falls through to the name match', () => {
    expect(defaultAcCandidate(candidates, 'customfield_777')).toBe('customfield_1');
  });
  it('among several strong matches the exact "Acceptance Criteria" name wins', () => {
    expect(defaultAcCandidate(candidates, null)).toBe('customfield_1');
  });
  it('no exact name → the first strong match in the server’s order', () => {
    const c = [cand('customfield_8', 'AC (legacy) acceptance criteria', 'strong'), cand('customfield_9', 'Story acceptance criteria', 'strong')];
    expect(defaultAcCandidate(c, null)).toBe('customfield_8');
  });
  it('only weak matches → blank (a weak match is listed, never preselected)', () => {
    expect(defaultAcCandidate([cand('customfield_3', 'Definition of Done', 'weak'), cand('customfield_4', 'Notes', null)], null)).toBe('');
  });
  it('no name match → blank, so the box is left alone', () => {
    expect(defaultAcCandidate([cand('customfield_4', 'Notes', null)], null)).toBe('');
    expect(defaultAcCandidate([], null)).toBe('');
  });
});

describe('the field the server picked', () => {
  it('is the stored acField; null is none; absent (an older plugin) falls back to the shared rule', () => {
    expect(serverAcField(details({ acField: { id: 'customfield_4', name: 'Notes' } }))).toBe('customfield_4');
    expect(serverAcField(details({ acField: null }))).toBe('');
    expect(serverAcField(details())).toBe('customfield_1');
  });
});

describe('the Jira site', () => {
  it('the site is the ticket link’s host', () => {
    expect(jiraSiteOf('https://Acme.Atlassian.net/browse/ENG-1')).toBe('acme.atlassian.net');
    expect(jiraSiteOf('http://jira.lan:8080/jira/browse/ENG-1')).toBe('jira.lan:8080');
    expect(jiraSiteOf('not a url')).toBeNull();
  });
});
