// JIRA API ACCESS in the SPA: the pure half.
//
//   1. THE BUTTON ONLY EXISTS FOR A DETECTED JIRA TICKET WITH A SAVED TOKEN — `canFetchDetails`
//      from the server, never inferred from the provider alone (and absent reads as false).
//   2. A FILL REPLACES title + description, and replaces the criteria ONLY when the workspace maps
//      a criteria field — otherwise Jira was never asked, and the reader's paste is kept.
//   3. The AC picker still shows the SAVED field before the list is loaded.
//   4. The button is click-gated: the panel never calls the ticket route on mount.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/jiraTicket.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JiraTicketDetails, TicketRef } from '@pierre-review/shared';
import {
  acFieldName,
  acFieldOptions,
  applyJiraTicket,
  fillableJiraTickets,
  jiraFillNote,
} from '../src/lib/jiraTicket.js';

const jira = (key: string, canFetchDetails?: boolean): TicketRef => ({
  key,
  url: `https://acme.atlassian.net/browse/${key}`,
  provider: 'jira',
  ...(canFetchDetails === undefined ? {} : { canFetchDetails }),
});

describe('fillableJiraTickets', () => {
  it('keeps only Jira tickets the server marked fetchable', () => {
    const tickets: TicketRef[] = [
      jira('ENG-1', true),
      jira('ENG-2', false),
      jira('ENG-3'),
      { key: 'OPS-4', url: 'https://linear.app/x/issue/OPS-4', provider: 'linear', canFetchDetails: true },
    ];
    expect(fillableJiraTickets(tickets).map((t) => t.key)).toEqual(['ENG-1']);
  });
  it('nothing detected → no button', () => {
    expect(fillableJiraTickets(null)).toEqual([]);
    expect(fillableJiraTickets([])).toEqual([]);
  });
});

const details = (over: Partial<JiraTicketDetails> = {}): JiraTicketDetails => ({
  prId: 1,
  key: 'ENG-1',
  title: 'Reset password',
  description: 'As a user…',
  acceptanceCriteria: '- Link emailed',
  acField: { id: 'customfield_10400', name: 'Acceptance Criteria' },
  ...over,
});

describe('applyJiraTicket', () => {
  const draft = { title: 'old', description: 'old', acceptanceCriteria: 'my paste' };
  it('replaces all three when a criteria field is mapped', () => {
    expect(applyJiraTicket(draft, details())).toEqual({
      title: 'Reset password',
      description: 'As a user…',
      acceptanceCriteria: '- Link emailed',
    });
  });
  it('replaces the criteria with "" when the mapped field is empty on this ticket', () => {
    expect(applyJiraTicket(draft, details({ acceptanceCriteria: '' })).acceptanceCriteria).toBe('');
  });
  it('keeps the reader’s criteria when no field is mapped', () => {
    expect(
      applyJiraTicket(draft, details({ acField: null, acceptanceCriteria: '' })).acceptanceCriteria,
    ).toBe('my paste');
  });
});

describe('jiraFillNote', () => {
  it('says so in one line when no criteria field is set', () => {
    expect(jiraFillNote(details({ acField: null }))).toMatch(/No acceptance criteria field/);
  });
  it('names the field when the ticket has nothing in it', () => {
    expect(jiraFillNote(details({ acceptanceCriteria: '  ' }))).toBe(
      'ENG-1 has nothing in Acceptance Criteria.',
    );
  });
  it('says nothing on a full fill', () => {
    expect(jiraFillNote(details())).toBeNull();
  });
});

describe('the acceptance-criteria picker', () => {
  const saved = { id: 'customfield_10400', name: 'Acceptance Criteria' };
  it('shows the saved field before the list is loaded', () => {
    expect(acFieldOptions(saved, null)).toEqual([
      { id: 'customfield_10400', label: 'Acceptance Criteria (customfield_10400)' },
    ]);
  });
  it('does not duplicate it once loaded', () => {
    const loaded = [{ id: 'customfield_10400', name: 'Acceptance Criteria', custom: true, type: 'string' }];
    expect(acFieldOptions(saved, loaded)).toHaveLength(1);
    expect(acFieldName('customfield_10400', saved, loaded)).toBe('Acceptance Criteria');
    expect(acFieldName('', saved, loaded)).toBeNull();
  });
});

describe('click-gated: the panel never fetches a ticket on mount', () => {
  it('the only call site of api.jiraTicket is the mutation behind the button', () => {
    const src = readFileSync(join(__dirname, '../src/components/ClaudeReviewFollowUp.tsx'), 'utf8');
    const uses = src.match(/api\.jiraTicket\(/g) ?? [];
    expect(uses).toHaveLength(1);
    expect(src).toMatch(/useMutation<JiraTicketDetails, Error, string>\(\{\s*mutationFn: \(key\) => api\.jiraTicket\(/);
    expect(src).not.toMatch(/useQuery[^;]*jiraTicket/);
  });
});
