// THE TICKET'S OWN STORY — the pure half (lib/ticketStory.ts) and its wiring.
//
//   1. ONE STORY SECTION: an older PR review's story shows only where no ticket review covers it.
//   2. SOURCE: the stored Jira row when Limn can read it, else the first stored ticket with text.
//   3. THE MODAL'S FACTS: the stored row's, else the card's.
//   4. WIRING: click-gated reads, the modal on Open PRs, no "Pull KEY" for a listed ticket.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/ticketStory.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClaudeReviewTicket, ClaudeReviewTicketEntry, JiraTicketDetails, TicketRef } from '@pierre-review/shared';
import {
  jiraRefFor,
  legacyOnlyEntries,
  storySourceOf,
  storyUrlOf,
  ticketModalFacts,
  ticketModalTitle,
} from '../src/lib/ticketStory.js';

const ticket = (over: Partial<ClaudeReviewTicket> = {}): ClaudeReviewTicket => ({
  title: null,
  description: null,
  acceptanceCriteria: null,
  ...over,
});
const entry = (index: number, t: Partial<ClaudeReviewTicket>): ClaudeReviewTicketEntry => ({
  index,
  ref: `T${index + 1}`,
  ticket: ticket(t),
  assessment: null,
});

describe('legacyOnlyEntries', () => {
  const legacy = [
    entry(0, { key: 'bmd-1040', title: 'Engine' }),
    entry(1, { title: '  Pasted   story ' }),
    entry(2, { key: 'BMD-7', title: 'Other' }),
    entry(3, { title: null }),
  ];

  it('drops a story whose key or (keyless) title a ticket review already covers', () => {
    const known = [
      { ticketKey: 'BMD-1040', ticketTitle: 'Engine' },
      { ticketKey: null, ticketTitle: null, review: { ticket: { key: null, title: 'pasted story' } } },
    ];
    expect(legacyOnlyEntries(legacy, known).map((e) => e.index)).toEqual([2, 3]);
  });

  it('keeps every story while nothing is known', () => {
    expect(legacyOnlyEntries(legacy, [])).toHaveLength(4);
  });

  it('a keyed story never matches by title alone', () => {
    expect(legacyOnlyEntries([entry(0, { key: 'A-1', title: 'Same' })], [{ ticketKey: 'B-2', ticketTitle: 'Same' }])).toHaveLength(1);
  });
});

describe('storySourceOf', () => {
  const ref = (over: Partial<TicketRef> = {}): TicketRef => ({
    key: 'BMD-1',
    url: 'https://x.atlassian.net/browse/BMD-1',
    provider: 'jira',
    ...over,
  });

  it('reads the stored Jira row only when Limn can read it', () => {
    expect(storySourceOf(ref({ canFetchDetails: true }), [])).toMatchObject({ kind: 'jira' });
    expect(storySourceOf(ref(), [])).toEqual({ kind: 'none' });
  });

  it('else the first stored ticket that has text', () => {
    const empty = ticket({ title: '  ' });
    const snap = ticket({ acceptanceCriteria: '- it works' });
    expect(storySourceOf(null, [null, empty, snap])).toEqual({ kind: 'stored', ticket: snap });
  });

  it('finds the detected Jira link by key, case-insensitive; never a Linear one', () => {
    const tickets: TicketRef[] = [ref({ key: 'LIN-1', provider: 'linear' }), ref()];
    expect(jiraRefFor(tickets, ' bmd-1 ')?.key).toBe('BMD-1');
    expect(jiraRefFor(tickets, 'LIN-1')).toBeNull();
    expect(jiraRefFor(tickets, null)).toBeNull();
    expect(storyUrlOf(null, [ticket(), ticket({ url: 'https://j/browse/A-1' })])).toBe('https://j/browse/A-1');
  });
});

describe('ticketModalFacts', () => {
  const card = { key: 'BMD-1', title: 'Card title', status: 'To Do', issueType: 'Story' };

  it('the card answers before the stored row loads', () => {
    const f = ticketModalFacts(card, null);
    expect(f).toMatchObject({ title: 'Card title', status: 'To Do', issueType: 'Story', assignee: null });
    expect(ticketModalTitle(f)).toBe('BMD-1 · Card title');
  });

  it('an unread ticket never claims "Unassigned"', () => {
    expect(ticketModalFacts({ key: 'BMD-2', title: null }, null).read).toBe(false);
    expect(ticketModalFacts({ key: 'BMD-2', title: null }, undefined).read).toBe(false);
    expect(ticketModalFacts(card, null).read).toBe(true);
  });

  it('the stored row wins once it is here', () => {
    const details = {
      prId: 1,
      key: 'BMD-1',
      title: 'Row title',
      description: '',
      issueType: { id: '1', name: 'Bug' },
      candidates: [],
      omittedCandidates: 0,
      status: 'In Review',
      statusCategory: 'indeterminate',
      assignee: { name: 'Ada' },
    } satisfies JiraTicketDetails;
    expect(ticketModalFacts(card, details)).toMatchObject({
      title: 'Row title',
      status: 'In Review',
      statusCategory: 'indeterminate',
      issueType: 'Bug',
      assignee: { name: 'Ada' },
    });
    expect(ticketModalTitle({ key: 'K-1', title: null })).toBe('K-1');
  });
});

describe('the wiring', () => {
  const src = (p: string) => readFileSync(join(__dirname, '..', 'src', p), 'utf8');

  it('the stored row is read only when the disclosure opens or the modal mounts', () => {
    const story = src('components/TicketStory.tsx');
    // The disclosure renders the reader only inside `open &&`.
    expect(story).toMatch(/\{open && \(/);
    expect(story).toMatch(/useStoredJiraTicket\(prId, jiraRef\.key, true\)/);
    const cards = src('components/Activity/OpenPrsCards.tsx');
    // The modal mounts only while open; no stored-row read anywhere else on the cards.
    expect(cards).toMatch(/\{open && \(/);
    expect(cards).toMatch(/<TicketStoryModal ticket=\{ticket\} prId=\{prId\} onClose=\{close\} \/>/);
    expect(cards).not.toMatch(/useStoredJiraTicket|api\.jiraTicket/);
  });

  it('a field change re-reads the ticket reviews so the block can say the story changed', () => {
    const hook = src('hooks/useJiraTicket.ts');
    expect(hook).toMatch(/invalidateQueries\(\{ queryKey: \['ticket-reviews'\] \}\)/);
    expect(hook).toMatch(/TICKET_REVIEW_STATES_KEY/);
  });

  it('"Add a story" offers no pull for a ticket already listed as a block', () => {
    const cov = src('components/TicketCoverage.tsx');
    expect(cov).toMatch(/tickets=\{unlisted\}/);
  });
});
