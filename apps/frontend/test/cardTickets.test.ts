import { describe, expect, it } from 'vitest';
import type { PrTicketLinks } from '@pierre-review/shared';
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
const ident = (key: string) => `jira:https://acme.atlassian.net#${key}`;

describe('cardTickets — the Open PRs ticket row', () => {
  it('nothing known → no row', () => {
    expect(cardTickets(undefined)).toEqual([]);
    expect(cardTickets(detected([]))).toEqual([]);
  });

  it('detected tickets, in detection order, deduped by key, each with its ticket-review ident', () => {
    const out = cardTickets(detected([link('BMD-1043', 'New designs'), link('BMD-7'), link('bmd-1043')]));
    expect(out).toEqual([
      { key: 'BMD-1043', title: 'New designs', url: `${PREFIX}BMD-1043`, ident: ident('BMD-1043'), provider: 'jira' },
      { key: 'BMD-7', title: null, url: `${PREFIX}BMD-7`, ident: ident('BMD-7'), provider: 'jira' },
    ]);
  });

  it('a Linear ticket gets its Linear ident (the ticket review reads Linear since phase 3)', () => {
    const [t] = cardTickets(
      detected([{ key: 'ENG-1', url: 'https://linear.app/acme/issue/ENG-1', provider: 'linear', title: null }], null),
    );
    expect(t).toEqual({
      key: 'ENG-1',
      title: null,
      url: 'https://linear.app/acme/issue/ENG-1',
      provider: 'linear',
      ident: 'linear:https://linear.app/acme#ENG-1',
    });
  });

  it('a GitHub issue keeps its lower-cased owner/repo#n key and gets the GitHub ident', () => {
    const url = 'https://github.com/acme/web/issues/12';
    const out = cardTickets(
      detected(
        [
          { key: 'acme/web#12', url, provider: 'github', title: 'Reset password' },
          { key: 'Acme/Web#12', url, provider: 'github', title: null },
        ],
        null,
      ),
    );
    expect(out).toEqual([
      { key: 'acme/web#12', title: 'Reset password', url, ident: 'github:https://github.com/acme/web#12', provider: 'github' },
    ]);
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
    );
    expect(t).toMatchObject({
      status: 'Ready for QA',
      statusCategory: 'indeterminate',
      assignee: { name: 'Robin Dunn' },
      issueType: 'Bug',
    });
    const [bare] = cardTickets(
      detected([{ ...link('BMD-1'), status: null, statusCategory: null, assignee: null, issueType: '  ' }]),
    );
    expect(Object.keys(bare!).sort()).toEqual(['ident', 'key', 'provider', 'title', 'url']);
  });

  it('does not read the PR review’s stored stories any more (one argument)', () => {
    expect(cardTickets.length).toBe(1);
  });
});
