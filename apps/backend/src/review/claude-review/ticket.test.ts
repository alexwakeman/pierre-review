// USER STORY / TASK — reconcileTicketAssessment (claude-review/ticket.ts). Claude enumerates the
// acceptance criteria itself (any format); the server renumbers its list AC1..n, drops rows with no
// text or an unknown status, caps the list, and keeps ONE 'not_checked' row when criteria text
// existed but Claude reported none. The server never invents 'met'.
//
//   pnpm --filter @pierre-review/backend test claude-review-ticket
import { describe, expect, it } from 'vitest';
import { CLAUDE_REVIEW_TICKET_MAX_CRITERIA, type ClaudeReviewTicket } from '@pierre-review/shared';
import {
  reconcileTicketAssessment,
  reconcileTicketAssessments,
  ticketAnalysisCommentBody,
  ticketEntriesOf,
  TICKET_COMMENT_MARKER,
} from './ticket.js';

const ticket: ClaudeReviewTicket = {
  title: 'Reset password',
  description: 'From the sign-in page.',
  acceptanceCriteria: 'Scenario: reset\n  Given a user\n  Then a link is sent\n| expiry | 1h |',
};

describe('reconcileTicketAssessment', () => {
  it('no report ⇒ one not_checked row carrying the pasted criteria, no gaps', () => {
    expect(reconcileTicketAssessment(ticket, undefined)).toEqual({
      alignment: 'not_checked',
      summary: null,
      criteria: [
        { ref: 'AC1', index: 0, text: ticket.acceptanceCriteria, status: 'not_checked', explanation: null, path: null, line: null },
      ],
      missing: [],
      notRequested: [],
    });
  });

  it("keeps Claude's own list in order, renumbered; drops blank text and unknown statuses", () => {
    const a = reconcileTicketAssessment(ticket, {
      alignment: 'partly_aligned',
      summary: '  Mostly there.  ',
      criteria: [
        { text: ' A reset link is emailed ', status: 'met', explanation: 'Sent by mail.ts.' },
        { text: '   ', status: 'met', explanation: 'blank — dropped' },
        { text: 'x', status: 'not_checked' as never, explanation: 'server-only status — dropped' },
        { text: 'The link expires after one hour', status: 'not_met', explanation: 'No expiry.', path: 'src/reset.ts', line: 40 },
      ],
    });
    expect(a.alignment).toBe('partly_aligned');
    expect(a.summary).toBe('Mostly there.');
    expect(a.criteria.map((c) => [c.ref, c.index, c.text, c.status, c.explanation, c.path, c.line])).toEqual([
      ['AC1', 0, 'A reset link is emailed', 'met', 'Sent by mail.ts.', null, null],
      ['AC2', 1, 'The link expires after one hour', 'not_met', 'No expiry.', 'src/reset.ts', 40],
    ]);
  });

  it('a report with no criteria for a ticket that has criteria text ⇒ the one not_checked row', () => {
    const a = reconcileTicketAssessment(ticket, { alignment: 'aligned', summary: 's', criteria: [] });
    expect(a.criteria).toHaveLength(1);
    expect(a.criteria[0]).toMatchObject({ status: 'not_checked', text: ticket.acceptanceCriteria });
  });

  it('caps the list', () => {
    const a = reconcileTicketAssessment(ticket, {
      alignment: 'aligned',
      summary: 's',
      criteria: Array.from({ length: CLAUDE_REVIEW_TICKET_MAX_CRITERIA + 5 }, (_, i) => ({
        text: `c${i}`,
        status: 'met' as const,
        explanation: 'x',
      })),
    });
    expect(a.criteria).toHaveLength(CLAUDE_REVIEW_TICKET_MAX_CRITERIA);
  });

  it('clips long text, caps each gap list at 20 and sanitises path / line', () => {
    const gap = (i: number) => ({ title: `gap ${i} ${'t'.repeat(400)}`, explanation: 'e'.repeat(3_000), path: ' src/a.ts ', line: i });
    const a = reconcileTicketAssessment(ticket, {
      alignment: 'aligned',
      summary: 's'.repeat(5_000),
      criteria: [
        { text: 't'.repeat(900), status: 'met', explanation: 'x', path: 'p'.repeat(600), line: 0 },
        { text: 'two', status: 'met', explanation: 'x', path: '   ', line: -3 },
      ],
      missing: Array.from({ length: 25 }, (_, i) => gap(i + 1)),
      notRequested: [{ title: '   ', explanation: 'no title — dropped' }, gap(1)],
    });
    expect(a.summary!.length).toBeLessThanOrEqual(1_001);
    expect(a.missing).toHaveLength(20);
    expect(a.missing[0]!.title.length).toBeLessThanOrEqual(201);
    expect(a.missing[0]!.explanation!.length).toBeLessThanOrEqual(1_001);
    expect(a.missing[0]!.path).toBe('src/a.ts');
    expect(a.missing[0]!.line).toBe(1);
    expect(a.notRequested).toHaveLength(1);
    expect(a.criteria[0]!.text.length).toBeLessThanOrEqual(501);
    expect(a.criteria[0]).toMatchObject({ path: null, line: null });
    expect(a.criteria[1]).toMatchObject({ path: null, line: null });
  });

  it('a ticket with no criteria still records alignment and gaps', () => {
    const a = reconcileTicketAssessment(
      { ...ticket, acceptanceCriteria: null },
      {
        alignment: 'not_aligned',
        summary: 'Different feature.',
        criteria: [{ text: 'ignored — no criteria text was sent', status: 'met', explanation: 'x' }],
        notRequested: [{ title: 'New page', explanation: 'x' }],
      },
    );
    expect(a.criteria).toEqual([]);
    expect(a.alignment).toBe('not_aligned');
    expect(a.notRequested.map((g) => g.title)).toEqual(['New page']);
  });
});

describe('reconcileTicketAssessments — one per ticket, by ref', () => {
  const t2: ClaudeReviewTicket = { title: 'Audit log', description: null, acceptanceCriteria: null };

  it('matches reports by ref; a ticket with no report is not_checked; unknown/repeated refs dropped', () => {
    const out = reconcileTicketAssessments(
      [ticket, t2],
      [
        { ref: 'T2', alignment: 'aligned', summary: 'Done.' },
        { ref: 'T2', alignment: 'not_aligned', summary: 'ignored repeat' },
        { ref: 'T9', alignment: 'aligned', summary: 'unknown' },
      ],
    );
    expect(out).toHaveLength(2);
    expect(out[0]!.alignment).toBe('not_checked');
    expect(out[1]).toMatchObject({ alignment: 'aligned', summary: 'Done.' });
  });

  it('reads the legacy single report as T1', () => {
    const out = reconcileTicketAssessments([t2], undefined, { alignment: 'unclear', summary: 'Hm.' });
    expect(out[0]).toMatchObject({ alignment: 'unclear', summary: 'Hm.' });
  });
});

describe('ticketEntriesOf — the stored pair → the wire list', () => {
  it('a legacy run (one object each) reads as a one-element list', () => {
    const a = reconcileTicketAssessment(ticket, { alignment: 'aligned', summary: 'ok' });
    expect(ticketEntriesOf(ticket, a)).toEqual([
      { index: 0, ref: 'T1', ticket, assessment: a, posted: null },
    ]);
    expect(ticketEntriesOf(null, null)).toEqual([]);
  });

  it('lifts `posted` off the stored assessment', () => {
    const a = reconcileTicketAssessment(ticket, { alignment: 'aligned', summary: 'ok' });
    const posted = { githubCommentId: '9', url: 'https://x/1#issuecomment-9', postedAt: '2026-10-01T00:00:00.000Z' };
    const [e] = ticketEntriesOf([ticket], [{ ...a, posted }]);
    expect(e!.posted).toEqual(posted);
    expect('posted' in e!.assessment!).toBe(false);
  });
});

describe('ticketAnalysisCommentBody', () => {
  it('a concise markdown comment: heading, verdict, criteria, gaps, the commit, the marker', () => {
    const a = reconcileTicketAssessment(ticket, {
      alignment: 'partly_aligned',
      summary: 'Most of it, @alice.',
      criteria: [
        { text: 'A link is sent', status: 'met', explanation: 'In mail.ts.', path: 'src/mail.ts', line: 4 },
        { text: 'Link expires', status: 'not_met', explanation: 'No expiry.' },
      ],
      missing: [{ title: 'Rate limit', explanation: 'Not done.' }],
    });
    const body = ticketAnalysisCommentBody(
      { ...ticket, key: 'ENG-7', url: 'https://acme.atlassian.net/browse/ENG-7' },
      a,
      'abcdef1234567890',
    );
    expect(body).toContain('### [ENG-7](https://acme.atlassian.net/browse/ENG-7) · Reset password');
    expect(body).toContain('**Partly matches the user story**');
    expect(body).toContain('@\u200balice'); // no mention ping
    expect(body).toContain('1 of 2 criteria met.');
    expect(body).toContain('- **Met:** A link is sent — In mail.ts. (`src/mail.ts:4`)');
    expect(body).toContain('**Not done**');
    expect(body).toContain('`abcdef1`');
    expect(body.endsWith(TICKET_COMMENT_MARKER)).toBe(true);
  });
});

describe('sameHeadTicketCarry — only new commits may change a criterion', () => {
  const story = { title: 'Reset', description: 'd', acceptanceCriteria: '* emailed' };
  const assessed = {
    alignment: 'partly_aligned' as const,
    summary: 's',
    criteria: [{ index: 1, text: 'emailed', status: 'not_met' as const, explanation: 'e' }],
    missing: [],
    notRequested: [],
    posted: { githubCommentId: '1', url: null, postedAt: '2026-09-01T00:00:00.000Z' },
  };

  it('carries an unchanged story\'s assessment (without the posted record) and skips edited ones', async () => {
    const { sameHeadTicketCarry } = await import('./ticket.js');
    const out = sameHeadTicketCarry(
      [story, { ...story, acceptanceCriteria: '* emailed\n* logged' }],
      { tickets: [story], ticketAssessments: [assessed as never] },
    );
    expect(out[0]).toMatchObject({ alignment: 'partly_aligned' });
    expect((out[0] as { posted?: unknown }).posted).toBeUndefined();
    expect(out[1]).toBeNull();
  });

  it('carries nothing without a same-head prior, or for a not_checked assessment', async () => {
    const { sameHeadTicketCarry } = await import('./ticket.js');
    expect(sameHeadTicketCarry([story], null)).toEqual([null]);
    expect(
      sameHeadTicketCarry([story], { tickets: [story], ticketAssessments: [{ ...assessed, alignment: 'not_checked' } as never] }),
    ).toEqual([null]);
  });
});
