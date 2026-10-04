// USER STORY / TASK — reconcileTicketAssessment (claude-review/ticket.ts). Claude enumerates the
// acceptance criteria itself (any format); the server renumbers its list AC1..n, drops rows with no
// text or an unknown status, caps the list, and keeps ONE 'not_checked' row when criteria text
// existed but Claude reported none. The server never invents 'met'.
//
//   pnpm --filter @pierre-review/backend test claude-review-ticket
import { describe, expect, it } from 'vitest';
import { CLAUDE_REVIEW_TICKET_MAX_CRITERIA, storyCommentLead, stripStoredStoryLead, type ClaudeReviewTicket } from '@pierre-review/shared';
import {
  reconcileTicketAssessment,
  reconcileTicketAssessments,
  storyMatchKey,
  ticketEntriesOf,
} from './ticket.js';
import { prLevelFindingBody, findingCommentBody, FINDING_COMMENT_MARKER } from '../post-review.js';

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
      { index: 0, ref: 'T1', ticket, assessment: a },
    ]);
    expect(ticketEntriesOf(null, null)).toEqual([]);
  });

  it('an OLD row\'s retired `posted` record still reads — and is ignored (never served)', () => {
    const a = reconcileTicketAssessment(ticket, { alignment: 'aligned', summary: 'ok' });
    const posted = { githubCommentId: '9', url: 'https://x/1#issuecomment-9', postedAt: '2026-10-01T00:00:00.000Z' };
    const [e] = ticketEntriesOf([ticket], [{ ...a, posted } as never]);
    expect(e).toEqual({ index: 0, ref: 'T1', ticket, assessment: a });
    expect('posted' in e!).toBe(false);
    expect('posted' in e!.assessment!).toBe(false);
  });
});

// LEGACY story findings. A PR review makes none any more (stories went to the ticket review), but
// rows written before still read, still render their story line and can still be posted.
describe('legacy story findings — reading and posting', () => {
  const jira: ClaudeReviewTicket = { ...ticket, key: 'BMD-1040', source: 'jira', url: null, fetchedAt: null };
  const a1 = reconcileTicketAssessment(jira, {
    alignment: 'partly_aligned',
    summary: 's',
    criteria: [
      { text: 'A link is sent', status: 'met', explanation: 'ok' },
      { text: 'Link expires after 1h', status: 'not_met', explanation: 'No expiry is set.' },
      { text: 'Ping @alice on reset', status: 'partly_met', explanation: 'Only on success.', path: 'src/other.ts', line: 9 },
    ],
    missing: [{ title: 'Rate limit resets', explanation: 'Nothing limits it.' }],
  });
  const entries = [{ index: 0, ref: 'BMD-1040', ticket: jira, assessment: a1 }];
  const stored = (over: { path: string; line: number | null; title: string; body: string; story: { index: number; ref: string } }) => ({
    side: 'RIGHT' as const,
    suggestion: null,
    anchored: false,
    fileInDiff: false,
    ...over,
  });
  const missing = stored({ path: '', line: null, title: 'Rate limit resets', body: 'Nothing limits it.', story: { index: 0, ref: 'M1' } });
  const partly = stored({ path: 'src/other.ts', line: 9, title: 'Ping @alice on reset', body: 'Only on success.', story: { index: 0, ref: 'AC3' } });

  it("an older row's stored lead is stripped on read; other bodies are untouched", () => {
    const story = { index: 0, ref: 'AC2' };
    expect(stripStoredStoryLead('BMD-1040 · AC2 (partly met): X\n\nWhy.', story)).toBe('Why.');
    expect(stripStoredStoryLead('Story 1 · Not done: X', { index: 0, ref: 'M1' })).toBe('');
    expect(stripStoredStoryLead('Why.', story)).toBe('Why.');
    expect(stripStoredStoryLead('BMD-1040 · AC2 (partly met): X\n\nWhy.', null)).toBe('BMD-1040 · AC2 (partly met): X\n\nWhy.');
  });

  it('the story line is built for GitHub, with no mention ping', () => {
    expect(storyCommentLead(partly, entries)).toBe('BMD-1040 · AC3 (partly met): Ping @\u200balice on reset');
    expect(storyCommentLead(missing, entries)).toBe('BMD-1040 · Not done: Rate limit resets');
    // A story the run no longer lists still names itself.
    expect(storyCommentLead(partly, [])).toBe('Story 1 · AC3: Ping @\u200balice on reset');
  });

  it('a path-less story finding posts PR-level without a file line or the outside-the-diff note', () => {
    const body = prLevelFindingBody({ ...missing, editedBody: null, storyLead: storyCommentLead(missing, entries) });
    expect(body).toBe(`BMD-1040 · Not done: Rate limit resets\n\nNothing limits it.\n\n${FINDING_COMMENT_MARKER}`);
    // The off-diff one keeps the file line and the note, after the story line.
    const off = prLevelFindingBody({ ...partly, editedBody: null, storyLead: storyCommentLead(partly, entries) });
    expect(off.startsWith('BMD-1040 · AC3 (partly met): Ping @\u200balice on reset\n\n**`src/other.ts:9`**\n\nOnly on success.')).toBe(true);
    // Inline: the story line, then the body (or the reword), then the marker.
    expect(findingCommentBody({ ...partly, editedBody: 'Mine', storyLead: storyCommentLead(partly, entries) })).toBe(
      `BMD-1040 · AC3 (partly met): Ping @\u200balice on reset\n\nMine\n\n${FINDING_COMMENT_MARKER}`,
    );
    // An explanation-less finding posts the story line alone.
    expect(findingCommentBody({ body: '', editedBody: null, suggestion: null, storyLead: 'Story 2 · AC1 (not met): X' })).toBe(
      `Story 2 · AC1 (not met): X\n\n${FINDING_COMMENT_MARKER}`,
    );
  });

  it('storyMatchKey: kind + folded text; ordinary findings have none', () => {
    expect(storyMatchKey({ title: '  Link  expires ', story: { index: 0, ref: 'AC2' } })).toBe(
      storyMatchKey({ title: 'link expires', story: { index: 3, ref: 'AC7' } }),
    );
    expect(storyMatchKey({ title: 'x', story: { index: 0, ref: 'AC1' } })).not.toBe(
      storyMatchKey({ title: 'x', story: { index: 0, ref: 'M1' } }),
    );
    expect(storyMatchKey({ title: 'x' })).toBeNull();
  });
});
