// USER STORY / TASK — reconcileTicketAssessment (claude-review/ticket.ts). Claude enumerates the
// acceptance criteria itself (any format); the server renumbers its list AC1..n, drops rows with no
// text or an unknown status, caps the list, and keeps ONE 'not_checked' row when criteria text
// existed but Claude reported none. The server never invents 'met'.
//
//   pnpm --filter @pierre-review/backend test claude-review-ticket
import { describe, expect, it } from 'vitest';
import { CLAUDE_REVIEW_TICKET_MAX_CRITERIA, type ClaudeReviewTicket } from '@pierre-review/shared';
import { reconcileTicketAssessment } from './ticket.js';

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
