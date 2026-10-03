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
  storyFindingsFrom,
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

// A diff touching src/mail.ts lines 1-6 (all added) — the anchoring input.
const DIFF = [
  'diff --git a/src/mail.ts b/src/mail.ts',
  '--- a/src/mail.ts',
  '+++ b/src/mail.ts',
  '@@ -0,0 +1,6 @@',
  '+a',
  '+b',
  '+c',
  '+d',
  '+e',
  '+f',
].join('\n');

describe('storyFindingsFrom — a story\'s unmet results become findings (no model call)', () => {
  const jira: ClaudeReviewTicket = { ...ticket, key: 'BMD-1040', source: 'jira', url: null, fetchedAt: null };
  const manual: ClaudeReviewTicket = { title: 'Audit log', description: 'Log it.', acceptanceCriteria: '* logged' };
  const a1 = reconcileTicketAssessment(jira, {
    alignment: 'partly_aligned',
    summary: 's',
    criteria: [
      { text: 'A link is sent', status: 'met', explanation: 'ok', path: 'src/mail.ts', line: 2 },
      { text: 'Link expires after 1h', status: 'not_met', explanation: 'No expiry is set.', path: 'src/mail.ts', line: 4 },
      { text: 'Ping @alice on reset', status: 'partly_met', explanation: 'Only on success.', path: 'src/other.ts', line: 9 },
      { text: 'Hard to say', status: 'unclear', explanation: 'x' },
    ],
    missing: [{ title: 'Rate limit resets', explanation: 'Nothing limits it.' }],
    notRequested: [{ title: 'A new banner', explanation: 'Not asked.', path: 'src/mail.ts', line: 1 }],
  });
  const a2 = reconcileTicketAssessment(manual, {
    alignment: 'not_aligned',
    summary: 's',
    criteria: [{ text: 'Every reset is logged', status: 'not_met', explanation: null as never, path: 'src/mail.ts' }],
  });

  it('maps not met → warning, partly met → nit, not done → warning; never met/unclear/notRequested', () => {
    const out = storyFindingsFrom([jira, manual], [a1, a2], DIFF);
    expect(out.map((f) => [f.story, f.severity, f.title])).toEqual([
      [{ index: 0, ref: 'AC2' }, 'warning', 'Link expires after 1h'],
      [{ index: 0, ref: 'AC3' }, 'nit', 'Ping @alice on reset'],
      [{ index: 0, ref: 'M1' }, 'warning', 'Rate limit resets'],
      [{ index: 1, ref: 'AC1' }, 'warning', 'Every reset is logged'],
    ]);
  });

  it('the body is Claude\'s explanation alone; the story line is built for GitHub, with no mention ping', () => {
    const out = storyFindingsFrom([jira, manual], [a1, a2], DIFF);
    expect(out.map((f) => f.body)).toEqual(['No expiry is set.', 'Only on success.', 'Nothing limits it.', '']);
    const entries = [
      { index: 0, ref: 'BMD-1040', ticket: jira, assessment: a1 },
      { index: 1, ref: 'Story 2', ticket: manual, assessment: a2 },
    ];
    expect(out.map((f) => storyCommentLead(f, entries))).toEqual([
      'BMD-1040 · AC2 (not met): Link expires after 1h',
      'BMD-1040 · AC3 (partly met): Ping @\u200balice on reset',
      'BMD-1040 · Not done: Rate limit resets',
      // A story with no key is "Story N".
      'Story 2 · AC1 (not met): Every reset is logged',
    ]);
    // A story the run no longer lists still names itself.
    expect(storyCommentLead(out[0]!, [])).toBe('Story 1 · AC2: Link expires after 1h');
  });

  it('an older row\'s stored lead is stripped on read; other bodies are untouched', () => {
    const story = { index: 0, ref: 'AC2' };
    expect(stripStoredStoryLead('BMD-1040 · AC2 (partly met): X\n\nWhy.', story)).toBe('Why.');
    expect(stripStoredStoryLead('Story 1 · Not done: X', { index: 0, ref: 'M1' })).toBe('');
    expect(stripStoredStoryLead('Why.', story)).toBe('Why.');
    expect(stripStoredStoryLead('BMD-1040 · AC2 (partly met): X\n\nWhy.', null)).toBe('BMD-1040 · AC2 (partly met): X\n\nWhy.');
  });

  it('anchors exactly like a model finding: on-line inline, in-diff file re-anchors, off-diff PR-level, no path PR-level', () => {
    const out = storyFindingsFrom([jira, manual], [a1, a2], DIFF);
    // On an addable line of a changed file.
    expect(out[0]).toMatchObject({ path: 'src/mail.ts', line: 4, side: 'RIGHT', anchored: true, fileInDiff: true });
    expect(out[0]!.diffHunk).toContain('+d');
    // A file outside the diff → PR-level.
    expect(out[1]).toMatchObject({ path: 'src/other.ts', line: 9, anchored: false, fileInDiff: false, diffHunk: null });
    // No path at all → a PR-level comment about the change.
    expect(out[2]).toMatchObject({ path: '', line: null, anchored: false, fileInDiff: false, diffHunk: null });
    // A changed file but no line → posts on the file's first change.
    expect(out[3]).toMatchObject({ path: 'src/mail.ts', line: null, anchored: false, fileInDiff: true });
  });

  it('a path-less story finding posts PR-level without a file line or the outside-the-diff note', () => {
    const [, , missing] = storyFindingsFrom([jira], [a1], DIFF);
    const entries = [{ index: 0, ref: 'BMD-1040', ticket: jira, assessment: a1 }];
    const body = prLevelFindingBody({ ...missing!, editedBody: null, storyLead: storyCommentLead(missing!, entries) });
    expect(body).toBe(`BMD-1040 · Not done: Rate limit resets\n\nNothing limits it.\n\n${FINDING_COMMENT_MARKER}`);
    // The off-diff one keeps the file line and the note, after the story line.
    const [, partly] = storyFindingsFrom([jira], [a1], DIFF);
    const off = prLevelFindingBody({ ...partly!, editedBody: null, storyLead: storyCommentLead(partly!, entries) });
    expect(off.startsWith('BMD-1040 · AC3 (partly met): Ping @\u200balice on reset\n\n**`src/other.ts:9`**\n\nOnly on success.')).toBe(true);
    // Inline: the story line, then the body (or the reword), then the marker.
    expect(
      findingCommentBody({ ...partly!, editedBody: 'Mine', storyLead: storyCommentLead(partly!, entries) }),
    ).toBe(`BMD-1040 · AC3 (partly met): Ping @\u200balice on reset\n\nMine\n\n${FINDING_COMMENT_MARKER}`);
    // An explanation-less finding posts the story line alone.
    expect(findingCommentBody({ body: '', editedBody: null, suggestion: null, storyLead: 'Story 2 · AC1 (not met): X' })).toBe(
      `Story 2 · AC1 (not met): X\n\n${FINDING_COMMENT_MARKER}`,
    );
  });

  it('nothing to report ⇒ no findings; a null assessment (run not finished) is skipped', () => {
    expect(storyFindingsFrom([jira], [null], DIFF)).toEqual([]);
    expect(storyFindingsFrom([ticket], [reconcileTicketAssessment(ticket, undefined)], DIFF)).toEqual([]);
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
