import { describe, expect, it } from 'vitest';
import type { ClaudeReviewTicket, PrTicketLinks } from '@pierre-review/shared';
import { cardTicketLabel, cardTickets } from '../src/lib/cardTickets.js';

const PREFIX = 'https://acme.atlassian.net/browse/';
const detected = (tickets: PrTicketLinks['tickets'], jiraBrowsePrefix: string | null = PREFIX): PrTicketLinks => ({
  prId: 1,
  tickets,
  jiraBrowsePrefix,
});
const link = (key: string, title: string | null = null) => ({
  key,
  url: `${PREFIX}${key}`,
  provider: 'jira' as const,
  title,
});
const story = (over: Partial<ClaudeReviewTicket>): ClaudeReviewTicket => ({
  title: null,
  description: null,
  acceptanceCriteria: null,
  ...over,
});

describe('cardTickets — the Open PRs ticket row', () => {
  it('nothing known → no row', () => {
    expect(cardTickets(undefined, undefined)).toEqual([]);
    expect(cardTickets(detected([]), [])).toEqual([]);
    // A typed story has no key, so it names no ticket.
    expect(cardTickets(undefined, [story({ title: 'Typed by hand', source: 'manual' })])).toEqual([]);
  });

  it('detected tickets lead, in detection order, deduped by key', () => {
    const out = cardTickets(detected([link('BMD-1043', 'New designs'), link('BMD-7'), link('bmd-1043')]), undefined);
    expect(out).toEqual([
      { key: 'BMD-1043', title: 'New designs', url: `${PREFIX}BMD-1043` },
      { key: 'BMD-7', title: null, url: `${PREFIX}BMD-7` },
    ]);
  });

  it('a stored story fills a title Jira did not give; Jira’s own title wins', () => {
    const out = cardTickets(detected([link('BMD-1', null), link('BMD-2', 'Live title')]), [
      story({ source: 'jira', key: 'BMD-1', title: 'Stored one', url: `${PREFIX}BMD-1` }),
      story({ source: 'jira', key: 'BMD-2', title: 'Old title' }),
    ]);
    expect(out.map((t) => t.title)).toEqual(['Stored one', 'Live title']);
  });

  it('a stored story detection did not find is added after, with its own link', () => {
    const out = cardTickets(detected([link('BMD-1')]), [
      story({ source: 'jira', key: 'NFR2-9', title: 'Picked by hand', url: 'https://acme.atlassian.net/browse/NFR2-9' }),
    ]);
    expect(out.map((t) => t.key)).toEqual(['BMD-1', 'NFR2-9']);
    expect(out[1]).toEqual({ key: 'NFR2-9', title: 'Picked by hand', url: 'https://acme.atlassian.net/browse/NFR2-9' });
  });

  it('a stored key with no link is linked through the known Jira site, else stays plain text', () => {
    const s = [story({ source: 'jira', key: 'BMD-5', title: 'T' })];
    expect(cardTickets(detected([]), s)[0]?.url).toBe(`${PREFIX}BMD-5`);
    expect(cardTickets(detected([], null), s)[0]?.url).toBeNull();
    expect(cardTickets(undefined, s)).toEqual([{ key: 'BMD-5', title: 'T', url: null }]);
  });

  it('ignores malformed stored keys and blank titles', () => {
    const out = cardTickets(undefined, [
      story({ source: 'jira', key: 'not a key', title: 'x' }),
      story({ source: 'jira', key: 'BMD-3', title: '   ' }),
    ]);
    expect(out).toEqual([{ key: 'BMD-3', title: null, url: null }]);
  });

  it('the label is "KEY · title", or the key alone', () => {
    expect(cardTicketLabel({ key: 'BMD-1043', title: 'New Designs', url: null })).toBe('BMD-1043 · New Designs');
    expect(cardTicketLabel({ key: 'BMD-1043', title: null, url: null })).toBe('BMD-1043');
  });

  it('carries the stored Jira extras the stack header reads — only when known', () => {
    const [t] = cardTickets(
      detected([
        {
          ...link('BMD-1040', 'Thirty years'),
          status: 'Ready for QA',
          statusCategory: 'indeterminate',
          assignee: { name: 'Robin Dunn', avatarUrl: 'https://example.com/a.png' },
          issueType: 'Bug',
        },
      ]),
      undefined,
    );
    expect(t).toMatchObject({
      status: 'Ready for QA',
      statusCategory: 'indeterminate',
      assignee: { name: 'Robin Dunn' },
      issueType: 'Bug',
    });
    const [bare] = cardTickets(
      detected([{ ...link('BMD-1'), status: null, statusCategory: null, assignee: null, issueType: '  ' }]),
      undefined,
    );
    expect(Object.keys(bare!).sort()).toEqual(['key', 'title', 'url']);
  });
});
