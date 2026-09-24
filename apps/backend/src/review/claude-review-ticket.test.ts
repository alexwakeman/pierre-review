// The shared Claude Review module — the ONE spelling of the user-story caps, the acceptance-criteria
// split, the ticket validator and the templated follow-up / criteria sentences. It lives in
// packages/shared (which has no test runner), so it is pinned here, where `pnpm test` runs it.
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_REVIEW_MODEL_LABELS,
  CLAUDE_REVIEW_MODELS,
  CLAUDE_REVIEW_TICKET_LIMITS,
  DEFAULT_CLAUDE_REVIEW_MODEL,
  checkClaudeReviewTicket,
  followUpCounts,
  followUpSentence,
  splitAcceptanceCriteria,
  ticketCriteriaSentence,
  type ClaudeFollowUpStatus,
  type ClaudeReviewModel,
  type ClaudeTicketCriterionStatus,
} from '@pierre-review/shared';

describe('splitAcceptanceCriteria', () => {
  it('one item per plain line, blank lines dropped', () => {
    expect(splitAcceptanceCriteria('first\n\n  second  \nthird\n')).toEqual(['first', 'second', 'third']);
  });

  it('strips every supported marker', () => {
    const text = [
      '- dash',
      '* star',
      '• bullet',
      '1. one',
      '2) two',
      '(3) three',
      'a) letter',
      '- [ ] open box',
      '[x] done box',
    ].join('\n');
    expect(splitAcceptanceCriteria(text)).toEqual([
      'dash',
      'star',
      'bullet',
      'one',
      'two',
      'three',
      'letter',
      'open box',
      'done box',
    ]);
  });

  it('joins a plain continuation line onto the previous marker item', () => {
    expect(splitAcceptanceCriteria('- A user can reset\n  their password\n- The link expires')).toEqual([
      'A user can reset their password',
      'The link expires',
    ]);
  });

  it('a plain line before the first marker is its own item', () => {
    expect(splitAcceptanceCriteria('Intro line\n- one\n- two')).toEqual(['Intro line', 'one', 'two']);
  });

  it('handles CRLF and lone CR', () => {
    expect(splitAcceptanceCriteria('- a\r\n- b\r- c')).toEqual(['a', 'b', 'c']);
  });

  it('does not treat "e.g." or "1.5 s" as markers', () => {
    expect(splitAcceptanceCriteria('e.g. the button is blue\n1.5 s load time')).toEqual([
      'e.g. the button is blue',
      '1.5 s load time',
    ]);
  });

  it('null / blank / whitespace ⇒ []', () => {
    expect(splitAcceptanceCriteria(null)).toEqual([]);
    expect(splitAcceptanceCriteria(undefined)).toEqual([]);
    expect(splitAcceptanceCriteria('')).toEqual([]);
    expect(splitAcceptanceCriteria('  \n \t\n')).toEqual([]);
  });

  it('drops a marker line with nothing after it', () => {
    expect(splitAcceptanceCriteria('- [ ]\n- real')).toEqual(['real']);
  });

  // The server numbers criteria AC1..n by position, and the model reports by that ref. A pasted
  // label left in the text would be a SECOND number in the criterion fenced as AC1, so a verdict
  // could land on the wrong row. The person's own text survives verbatim in acceptanceCriteria.
  it('strips a pasted AC label as a marker, alone or after a bullet / number / checkbox', () => {
    expect(splitAcceptanceCriteria('AC2: user can log out\nAC3: session expires after 1h')).toEqual([
      'user can log out',
      'session expires after 1h',
    ]);
    expect(
      splitAcceptanceCriteria('- AC1: one\n- **AC2:** two\n- **AC3**: three\n1. AC-4. four\n- [ ] ac 5) five\nAC6 - six'),
    ).toEqual(['one', 'two', 'three', 'four', 'five', 'six']);
    // Not a label: no separator, or not a number.
    expect(splitAcceptanceCriteria('AC 220 volts supply\nAC power stays on')).toEqual([
      'AC 220 volts supply',
      'AC power stays on',
    ]);
  });

  it('drops section headings instead of making them criteria', () => {
    expect(splitAcceptanceCriteria('Acceptance Criteria:\n- Reset link emailed\n- Link expires after 1h')).toEqual([
      'Reset link emailed',
      'Link expires after 1h',
    ]);
    expect(splitAcceptanceCriteria('**Acceptance Criteria**\n* a')).toEqual(['a']);
    expect(splitAcceptanceCriteria('__Acceptance criteria:__\n* a')).toEqual(['a']);
    expect(splitAcceptanceCriteria('# AC\n- a\n## Non-functional\n- b')).toEqual(['a', 'b']);
    // A colon line between lists is a sub-heading when a marker follows it.
    expect(splitAcceptanceCriteria('- a\n- b\nNon-functional:\n- c')).toEqual(['a', 'b', 'c']);
    // …but a marker line ending in a colon is a criterion, and its continuation joins it.
    expect(splitAcceptanceCriteria('- The error reads:\n  "Invalid password"')).toEqual([
      'The error reads: "Invalid password"',
    ]);
    // With no markers, only a LEADING colon line is a heading.
    expect(splitAcceptanceCriteria('Acceptance criteria:\nUser can log in\nUser can log out')).toEqual([
      'User can log in',
      'User can log out',
    ]);
    // A text made only of headings keeps them: a one-line criterion is never lost.
    expect(splitAcceptanceCriteria('Must support SSO:')).toEqual(['Must support SSO:']);
    expect(splitAcceptanceCriteria('# Must support SSO')).toEqual(['# Must support SSO']);
  });

  it('a Gherkin scenario is ONE criterion', () => {
    expect(splitAcceptanceCriteria('Given a user\nWhen they ask\nThen a link is sent\nAnd it is logged')).toEqual([
      'Given a user When they ask Then a link is sent And it is logged',
    ]);
    expect(
      splitAcceptanceCriteria('Scenario: reset\nGiven a user\nThen a link is sent\nScenario: expiry\nGiven a link\nThen it expires'),
    ).toEqual(['Scenario: reset Given a user Then a link is sent', 'Scenario: expiry Given a link Then it expires']);
    expect(splitAcceptanceCriteria('- Given a user\n- When they ask\n- Then a link is sent')).toEqual([
      'Given a user When they ask Then a link is sent',
    ]);
    // A list whose items merely START with When / And is not a scenario.
    expect(splitAcceptanceCriteria('- When offline, show a banner\n- When online, sync\n- And log it')).toEqual([
      'When offline, show a banner',
      'When online, sync',
      'And log it',
    ]);
  });

  it('Roman numerals are markers (a valid numeral in one case only)', () => {
    expect(splitAcceptanceCriteria('I. first\nII. second\nIII. third\niv) fourth')).toEqual([
      'first',
      'second',
      'third',
      'fourth',
    ]);
    // "mix." is not a numeral and "Ii." is mixed case: both are plain text.
    expect(splitAcceptanceCriteria('mix. the batter\nIi. two')).toEqual(['mix. the batter', 'Ii. two']);
  });

  it('the headline denominator counts real criteria only (the Jira paste)', () => {
    const r = checkClaudeReviewTicket({ acceptanceCriteria: 'Acceptance Criteria:\n- Reset link emailed\n- Link expires after 1h' });
    expect(r.ok && r.ticket?.criteria).toEqual(['Reset link emailed', 'Link expires after 1h']);
  });
});

describe('checkClaudeReviewTicket', () => {
  const L = CLAUDE_REVIEW_TICKET_LIMITS;

  it('all empty ⇒ ticket null', () => {
    expect(checkClaudeReviewTicket(undefined)).toEqual({ ok: true, ticket: null });
    expect(checkClaudeReviewTicket({})).toEqual({ ok: true, ticket: null });
    expect(checkClaudeReviewTicket({ title: '  ', description: '\n', acceptanceCriteria: '' })).toEqual({
      ok: true,
      ticket: null,
    });
  });

  it('trims each field and stores the split', () => {
    const r = checkClaudeReviewTicket({ title: '  Reset password ', acceptanceCriteria: '- a\n- b\n' });
    expect(r).toEqual({
      ok: true,
      ticket: { title: 'Reset password', description: null, acceptanceCriteria: '- a\n- b', criteria: ['a', 'b'] },
    });
  });

  it('title: 300 ok, 301 refused with the exact message', () => {
    expect(checkClaudeReviewTicket({ title: 'x'.repeat(L.titleChars) }).ok).toBe(true);
    expect(checkClaudeReviewTicket({ title: 'x'.repeat(L.titleChars + 1) })).toEqual({
      ok: false,
      field: 'title',
      message: 'Title is 301 characters; the limit is 300.',
    });
  });

  it('description: 8000 ok, 8001 refused', () => {
    expect(checkClaudeReviewTicket({ description: 'x'.repeat(L.descriptionChars) }).ok).toBe(true);
    expect(checkClaudeReviewTicket({ description: 'x'.repeat(L.descriptionChars + 1) })).toEqual({
      ok: false,
      field: 'description',
      message: 'Description is 8001 characters; the limit is 8000.',
    });
  });

  it('acceptance criteria: 4000 characters ok, 4001 refused', () => {
    expect(checkClaudeReviewTicket({ acceptanceCriteria: 'x'.repeat(L.acceptanceCriteriaChars) }).ok).toBe(true);
    expect(checkClaudeReviewTicket({ acceptanceCriteria: 'x'.repeat(L.acceptanceCriteriaChars + 1) })).toEqual({
      ok: false,
      field: 'acceptanceCriteria',
      message: 'Acceptance criteria is 4001 characters; the limit is 4000.',
    });
  });

  it('acceptance criteria: 30 items ok, 31 refused with the items message', () => {
    const lines = (n: number): string => Array.from({ length: n }, (_, i) => `- item ${i + 1}`).join('\n');
    const ok = checkClaudeReviewTicket({ acceptanceCriteria: lines(30) });
    expect(ok.ok && ok.ticket?.criteria.length).toBe(30);
    expect(checkClaudeReviewTicket({ acceptanceCriteria: lines(31) })).toEqual({
      ok: false,
      field: 'acceptanceCriteria',
      message: 'Acceptance criteria has 31 items; the limit is 30.',
    });
  });

  it('refuses a control character but allows tab and newline', () => {
    expect(checkClaudeReviewTicket({ description: 'a\u0000b' })).toEqual({
      ok: false,
      field: 'description',
      message: "Description contains a control character that can't be stored.",
    });
    expect(checkClaudeReviewTicket({ title: 'a\u0007' }).ok).toBe(false);
    expect(checkClaudeReviewTicket({ description: 'a\tb\nc\r\nd' }).ok).toBe(true);
  });

  it('stored criteria equal the split', () => {
    const text = '1. one\n2. two\n   continued\n3) three';
    const r = checkClaudeReviewTicket({ acceptanceCriteria: text });
    expect(r.ok && r.ticket?.criteria).toEqual(splitAcceptanceCriteria(text));
  });
});

describe('templated sentences', () => {
  const items = (...s: ClaudeFollowUpStatus[]) => ({ items: s.map((status) => ({ status })) });

  it('followUpSentence — the example, "0 addressed", singular and the other parts', () => {
    expect(
      followUpSentence(items('addressed', 'addressed', 'addressed', 'partly_addressed', 'not_addressed')),
    ).toBe("Last review's 5 comments: 3 addressed, 1 partly addressed, 1 not addressed.");
    expect(followUpSentence(items('not_addressed', 'not_addressed'))).toBe(
      "Last review's 2 comments: 0 addressed, 2 not addressed.",
    );
    expect(followUpSentence(items('addressed'))).toBe("Last review's 1 comment: 1 addressed.");
    expect(followUpSentence(items('no_longer_applies', 'not_checked'))).toBe(
      "Last review's 2 comments: 0 addressed, 1 no longer applies, 1 not checked.",
    );
    expect(followUpSentence(items('no_longer_applies', 'no_longer_applies'))).toBe(
      "Last review's 2 comments: 0 addressed, 2 no longer apply.",
    );
    expect(followUpSentence(items())).toBeNull();
    expect(followUpSentence(null)).toBeNull();
  });

  it('followUpSentence — names carried (older) comments apart from the last review\'s own', () => {
    const mixed = {
      items: [
        { status: 'addressed' as const },
        { status: 'addressed' as const },
        { status: 'not_addressed' as const },
        { status: 'not_checked' as const, carried: true },
        { status: 'addressed' as const, carried: true },
      ],
    };
    expect(followUpSentence(mixed)).toBe(
      "Last review's 3 comments and 2 older ones: 3 addressed, 1 not addressed, 1 not checked.",
    );
    expect(followUpSentence({ items: [{ status: 'addressed' }, { status: 'addressed', carried: true }] })).toBe(
      "Last review's 1 comment and 1 older one: 2 addressed.",
    );
    expect(followUpSentence({ items: [{ status: 'not_checked', carried: true }] })).toBe(
      '1 older comment: 0 addressed, 1 not checked.',
    );
    expect(followUpSentence({ items: [{ status: 'addressed', carried: false }] })).toBe(
      "Last review's 1 comment: 1 addressed.",
    );
  });

  it('followUpCounts', () => {
    expect(followUpCounts(items('addressed', 'partly_addressed', 'not_checked').items)).toEqual({
      total: 3,
      addressed: 1,
      partly: 1,
      notAddressed: 0,
      noLongerApplies: 0,
      notChecked: 1,
    });
  });

  it('ticketCriteriaSentence', () => {
    const a = (...s: ClaudeTicketCriterionStatus[]) => ({
      criteria: s.map((status, index) => ({
        ref: `AC${index + 1}`,
        index,
        text: 't',
        status,
        explanation: null,
        path: null,
        line: null,
      })),
    });
    expect(ticketCriteriaSentence(a('met', 'met', 'not_met', 'met', 'met', 'unclear'))).toBe('4 of 6 criteria met.');
    expect(ticketCriteriaSentence(a('met'))).toBe('1 of 1 criterion met.');
    expect(ticketCriteriaSentence(a())).toBeNull();
    expect(ticketCriteriaSentence(null)).toBeNull();
  });
});

describe('the model list', () => {
  it('Opus 5.5 is the default and the first offered model', () => {
    expect(DEFAULT_CLAUDE_REVIEW_MODEL).toBe('claude-opus-5-5');
    expect(CLAUDE_REVIEW_MODELS[0]).toBe(DEFAULT_CLAUDE_REVIEW_MODEL);
  });

  it('Opus 4.8 is no longer offered, but every stored id still has a label', () => {
    expect(CLAUDE_REVIEW_MODELS).not.toContain('claude-opus-4-8');
    const all: ClaudeReviewModel[] = [
      'claude-opus-5-5',
      'claude-sonnet-5',
      'claude-opus-4-8',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
    ];
    for (const m of all) expect(CLAUDE_REVIEW_MODEL_LABELS[m]).toBeTruthy();
    expect(CLAUDE_REVIEW_MODEL_LABELS['claude-opus-5-5']).toBe('Claude Opus 5.5 (most thorough)');
  });
});
