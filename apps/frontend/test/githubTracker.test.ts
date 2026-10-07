import { describe, expect, it } from 'vitest';
import type { TicketRef } from '@pierre-review/shared';
import { fillableJiraTickets, hasFixedAcSource, trackerNameOf, unfillableJiraTickets } from '../src/lib/jiraTicket.js';
import { jiraRefFor } from '../src/lib/ticketStory.js';
import { ticketIdentOf } from '../src/lib/ticketReview.js';

// GitHub Issues is a READING tracker (docs/TRACKERS.md § GitHub Issues): its tickets fill a story,
// key their ticket review by the GitHub ident, and say "GitHub" — never "Jira".
const gh: TicketRef = {
  key: 'acme/web#12',
  url: 'https://github.com/acme/web/issues/12',
  provider: 'github',
  canFetchDetails: true,
};
const jira: TicketRef = { key: 'ENG-7', url: 'https://acme.atlassian.net/browse/ENG-7', provider: 'jira', canFetchDetails: false };
// A Linear ticket in a workspace with NO saved API key (`canFetchDetails` false).
const linear: TicketRef = { key: 'ENG-8', url: 'https://linear.app/acme/issue/ENG-8', provider: 'linear', canFetchDetails: false };

describe('GitHub Issues tickets in the SPA', () => {
  it('a GitHub ticket can be filled; it never asks for a Jira token', () => {
    expect(fillableJiraTickets([gh, jira, linear])).toEqual([gh]);
    // Jira and Linear need a saved credential; GitHub never does.
    expect(unfillableJiraTickets([gh, jira, linear])).toEqual([jira, linear]);
  });

  it('copy names the tracker the tickets come from', () => {
    expect(trackerNameOf([gh])).toBe('GitHub');
    expect(trackerNameOf([jira])).toBe('Jira');
    expect(trackerNameOf([gh, jira])).toBe('the tracker');
  });

  it('the story disclosure finds the GitHub link by key, any case — and a Linear one (Linear reads too)', () => {
    expect(jiraRefFor([gh], 'ACME/WEB#12')).toEqual(gh);
    expect(jiraRefFor([linear], 'eng-8')).toEqual(linear);
  });

  it('the ticket review ident is the GitHub one', () => {
    expect(ticketIdentOf(gh)).toBe('github:https://github.com/acme/web#12');
    expect(ticketIdentOf(linear)).toBe('linear:https://linear.app/acme#ENG-8');
  });

  it('a GitHub ticket has no criteria field to pick', () => {
    expect(hasFixedAcSource(gh)).toBe(true);
    expect(hasFixedAcSource(jira)).toBe(false);
  });
});
