// JIRA "FILL FROM KEY" in the Claude Review panel: the pure half.
//
//   1. THE BUTTON ONLY EXISTS FOR A DETECTED JIRA TICKET WITH A SAVED TOKEN — `canFetchDetails`
//      from the server, never inferred from the provider alone (absent reads as false).
//   2. A FILL REPLACES title + description; the criteria box changes only through a CHOSEN
//      candidate, and the blank option leaves it as it is.
//   3. THE DEFAULT CHOICE (shared, applied SERVER-side now): the workspace's field for this issue
//      type when THIS ticket has it; else the best STRONG name match (exact "Acceptance Criteria"
//      first; weak matches never preselect); else blank. The panel uses the field the server names
//      (`serverAcField`), falling back to that rule for an older plugin that names none.
//   4. THE OLD PER-BROWSER CHOICE moves to the server ONCE (`legacyAcFieldToMigrate`): read, then
//      removed; only when the server has no choice of its own; a storage failure is "nothing".
//   5. ONE door to the ticket route: the panel reads tickets only through the query cache
//      (`fetchQuery`), never a render-time `useQuery`. The automatic pull is in storyTabs.test.ts.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/jiraTicket.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JiraAcCandidate, JiraTicketDetails, TicketRef } from '@pierre-review/shared';
import {
  acCandidateLabel,
  unfillableJiraTickets,
  applyAcCandidate,
  applyJiraTicket,
  defaultAcCandidate,
  fillableJiraTickets,
  jiraFillNote,
  jiraSiteOf,
  legacyAcFieldToMigrate,
  serverAcField,
  type AcMemoryStore,
} from '../src/lib/jiraTicket.js';

const jira = (key: string, canFetchDetails?: boolean): TicketRef => ({
  key,
  url: `https://acme.atlassian.net/browse/${key}`,
  provider: 'jira',
  ...(canFetchDetails === undefined ? {} : { canFetchDetails }),
});

const cand = (id: string, name: string, match: JiraAcCandidate['match'], text = `${name} text`) => ({
  id,
  name,
  text,
  match,
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

const memory = (): AcMemoryStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
};

describe('the field the server picked', () => {
  it('is the stored acField; null is none; absent (an older plugin) falls back to the shared rule', () => {
    expect(serverAcField(details({ acField: { id: 'customfield_4', name: 'Notes' } }))).toBe('customfield_4');
    expect(serverAcField(details({ acField: null }))).toBe('');
    expect(serverAcField(details())).toBe('customfield_1');
  });
});

const LEGACY = 'limn:jira-ac-field:v1:acme.atlassian.net:10001';
const URL1 = 'https://acme.atlassian.net/browse/ENG-1';

describe('the one-shot move of the old per-browser choice', () => {
  it('answers the old field once and removes the key', () => {
    const m = memory();
    m.data.set(LEGACY, 'customfield_2');
    const d = details({ acField: { id: 'customfield_1', name: 'Acceptance Criteria' }, acFieldSource: 'default' });
    expect(legacyAcFieldToMigrate(m, URL1, d)).toBe('customfield_2');
    expect(m.data.has(LEGACY)).toBe(false);
    expect(legacyAcFieldToMigrate(m, URL1, d)).toBeNull();
  });
  it('never overrides a server choice, a field the ticket lacks, or the same field — and still forgets', () => {
    for (const d of [
      details({ acField: { id: 'customfield_1', name: 'x' }, acFieldSource: 'setting' }),
      details({ acField: { id: 'customfield_2', name: 'x' }, acFieldSource: 'default' }),
    ]) {
      const m = memory();
      m.data.set(LEGACY, 'customfield_2');
      expect(legacyAcFieldToMigrate(m, URL1, d)).toBeNull();
      expect(m.data.size).toBe(0);
    }
    const m = memory();
    m.data.set(LEGACY, 'customfield_999');
    expect(legacyAcFieldToMigrate(m, URL1, details({ acFieldSource: 'default' }))).toBeNull();
  });
  it('keyed by Jira site AND issue type; no store, no site or no issue type → nothing', () => {
    const m = memory();
    m.data.set(LEGACY, 'customfield_2');
    expect(legacyAcFieldToMigrate(m, 'https://other.atlassian.net/browse/ENG-1', details())).toBeNull();
    expect(legacyAcFieldToMigrate(m, URL1, details({ issueType: { id: '10004', name: 'Bug' } }))).toBeNull();
    expect(legacyAcFieldToMigrate(m, URL1, details({ issueType: null }))).toBeNull();
    expect(legacyAcFieldToMigrate(null, URL1, details())).toBeNull();
    expect(m.data.has(LEGACY)).toBe(true);
  });
  it('a throwing store (blocked site data) never throws out', () => {
    const broken: AcMemoryStore = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(legacyAcFieldToMigrate(broken, URL1, details())).toBeNull();
  });
  it('the site is the ticket link’s host', () => {
    expect(jiraSiteOf('https://Acme.Atlassian.net/browse/ENG-1')).toBe('acme.atlassian.net');
    expect(jiraSiteOf('http://jira.lan:8080/jira/browse/ENG-1')).toBe('jira.lan:8080');
    expect(jiraSiteOf('not a url')).toBeNull();
  });
});

describe('labels and the note', () => {
  it('"Name (id) — preview", preview on one line and cut for display only', () => {
    const long = cand('customfield_1', 'Acceptance Criteria', 'strong', `Given a user\n${'x'.repeat(100)}`);
    const label = acCandidateLabel(long);
    expect(label.startsWith('★ Acceptance Criteria (customfield_1) — Given a user x')).toBe(true);
    expect(label.endsWith('…')).toBe(true);
    expect(long.text).toHaveLength(113); // the candidate itself is untouched
  });
  it('stars strong acceptance-criteria matches only', () => {
    expect(acCandidateLabel(cand('customfield_2', 'Definition of Done', 'weak', 'x'))).toBe(
      'Definition of Done (customfield_2) — x',
    );
    expect(acCandidateLabel(cand('customfield_3', 'Notes', null, 'y'))).toBe('Notes (customfield_3) — y');
  });
  it('a detected Jira ticket without a token is listed as unfillable, never as fillable', () => {
    const t = [
      { key: 'BMD-1', url: 'https://x.atlassian.net/browse/BMD-1', provider: 'jira' as const, canFetchDetails: false },
      { key: 'BMD-2', url: 'https://x.atlassian.net/browse/BMD-2', provider: 'jira' as const, canFetchDetails: true },
      { key: 'ENG-3', url: 'https://linear.app/x/issue/ENG-3', provider: 'linear' as const },
    ];
    expect(unfillableJiraTickets(t).map((r) => r.key)).toEqual(['BMD-1']);
    expect(fillableJiraTickets(t).map((r) => r.key)).toEqual(['BMD-2']);
  });
  it('says so when there are no candidates, and asks for a pick when nothing is chosen', () => {
    expect(jiraFillNote(details({ candidates: [] }), '')).toMatch(/no other fields with text/);
    expect(jiraFillNote(details(), '')).toMatch(/Pick the field/);
    expect(jiraFillNote(details(), 'customfield_1')).toBeNull();
  });
});

describe('one door: the panel reads a ticket only through the query cache', () => {
  it('the only call site of api.jiraTicket is the fetchQuery behind fetchTicket', () => {
    const src = readFileSync(join(__dirname, '../src/components/ClaudeReviewFollowUp.tsx'), 'utf8');
    const uses = src.match(/api\.jiraTicket\(/g) ?? [];
    expect(uses).toHaveLength(1);
    expect(src).toMatch(/const ticketKey = \(key: string\) => \['jira-ticket', prId, key\] as const;/);
    expect(src).toMatch(/qc\.fetchQuery\(\{\s*queryKey: ticketKey\(key\),\s*queryFn: \(\) => api\.jiraTicket\(prId, key\)/);
    // The criteria field is the server's now: the panel writes it through the route, never storage.
    expect(src).toMatch(/api\.setJiraAcField\(/);
    expect(src).not.toMatch(/setItem\(|rememberAcField/);
    // Never a render-time query: a ticket is read by the one-shot automatic pull or a click.
    expect(src).not.toMatch(/useQuery\b/);
  });
});
