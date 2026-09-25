// The shared Claude Review module — the ONE spelling of the user-story caps, the ticket validator and the templated follow-up / criteria sentences. It lives in
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
  ticketCriteriaSentence,
  type ClaudeFollowUpStatus,
  type ClaudeReviewModel,
  type ClaudeTicketCriterionStatus,
} from '@pierre-review/shared';

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

  it('trims each field and stores the criteria text as pasted, unsplit', () => {
    const r = checkClaudeReviewTicket({ title: '  Reset password ', acceptanceCriteria: '- a\n- b\n' });
    expect(r).toEqual({
      ok: true,
      ticket: { title: 'Reset password', description: null, acceptanceCriteria: '- a\n- b' },
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

  it('acceptance criteria: 8000 characters ok, 8001 refused', () => {
    expect(checkClaudeReviewTicket({ acceptanceCriteria: 'x'.repeat(L.acceptanceCriteriaChars) }).ok).toBe(true);
    expect(checkClaudeReviewTicket({ acceptanceCriteria: 'x'.repeat(L.acceptanceCriteriaChars + 1) })).toEqual({
      ok: false,
      field: 'acceptanceCriteria',
      message: 'Acceptance criteria is 8001 characters; the limit is 8000.',
    });
  });

  it('any shape of acceptance criteria is accepted — there is no item cap and no split', () => {
    const many = Array.from({ length: 80 }, (_, i) => `- item ${i + 1}`).join('\n');
    expect(checkClaudeReviewTicket({ acceptanceCriteria: many }).ok).toBe(true);
    const gherkin = '| role | can |\n|---|---|\n| admin | delete |\nScenario: x\n  Given a\n  Then b';
    const r = checkClaudeReviewTicket({ acceptanceCriteria: gherkin });
    expect(r.ok && r.ticket?.acceptanceCriteria).toBe(gherkin.trim());
    expect(r.ok && r.ticket && 'criteria' in r.ticket).toBe(false);
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
