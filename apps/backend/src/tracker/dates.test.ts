// tracker/dates.ts + each adapter's created / resolved read (migration 0098 / pg 0085).
import { describe, expect, it } from 'vitest';
import { ticketDateFields, trackerDate } from './dates.js';
import { fetchJiraIssue } from './jira/client.js';
import type { JiraTransport } from './jira/fetch.js';
import { toFetchedTicket } from './github/reader.js';
import { toLinearTicket } from './linear/client.js';

describe('trackerDate — the positive-answer rule', () => {
  it('absent = not received, null = none, a value = the instant', () => {
    expect(trackerDate({}, 'created')).toBeUndefined();
    expect(trackerDate(null, 'created')).toBeUndefined();
    expect(trackerDate({ created: null }, 'created')).toBeNull();
    expect(trackerDate({ created: '2026-03-04T10:11:12Z' }, 'created')?.toISOString()).toBe('2026-03-04T10:11:12.000Z');
  });

  it("reads Jira's +hhmm offset, and treats an unreadable value as not received (never as none)", () => {
    expect(trackerDate({ created: '2026-03-04T10:11:12.000+0100' }, 'created')?.toISOString()).toBe('2026-03-04T09:11:12.000Z');
    expect(trackerDate({ created: 'soon' }, 'created')).toBeUndefined();
    expect(trackerDate({ created: 17 }, 'created')).toBeUndefined();
  });

  it('ticketDateFields leaves undefined keys out', () => {
    expect(ticketDateFields({ issueCreatedAt: undefined, issueResolvedAt: null })).toEqual({ issueResolvedAt: null });
    expect('issueCreatedAt' in ticketDateFields({})).toBe(false);
  });
});

describe('each adapter reads its dates', () => {
  it('Jira: created + resolutiondate off the *all read', async () => {
    const transport: JiraTransport = async () => ({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        key: 'ENG-7',
        fields: { summary: 'x', created: '2026-01-02T03:04:05.000+0000', resolutiondate: null },
      }),
    });
    const out = await fetchJiraIssue(
      { apiRoot: 'https://acme.atlassian.net', credentials: { email: null, token: 'pat' }, policy: { cloud: false }, transport },
      'ENG-7',
    );
    expect(out.issueCreatedAt?.toISOString()).toBe('2026-01-02T03:04:05.000Z');
    expect(out.issueResolvedAt).toBeNull();
  });

  it('GitHub Issues: createdAt + closedAt', () => {
    const t = toFetchedTicket('acme/web#1', {
      number: 1,
      title: 't',
      url: null,
      state: 'CLOSED',
      stateReason: 'COMPLETED',
      body: '',
      createdAt: '2026-02-01T00:00:00Z',
      closedAt: '2026-02-03T00:00:00Z',
    });
    expect(t.issueCreatedAt?.toISOString()).toBe('2026-02-01T00:00:00.000Z');
    expect(t.issueResolvedAt?.toISOString()).toBe('2026-02-03T00:00:00.000Z');
    // An answer without the fields (an older query) says nothing about them.
    const bare = toFetchedTicket('acme/web#1', { number: 1, title: 't', url: null, state: 'OPEN', stateReason: null, body: '' });
    expect('issueCreatedAt' in bare).toBe(false);
  });

  it('Linear: createdAt + completedAt', () => {
    const t = toLinearTicket('ENG-1', { identifier: 'ENG-1', title: 't', createdAt: '2026-04-01T00:00:00Z', completedAt: null });
    expect(t.issueCreatedAt?.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(t.issueResolvedAt).toBeNull();
  });
});
