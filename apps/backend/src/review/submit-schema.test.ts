import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { submitReviewSchema, submitReviewShape } from './schema.js';

describe('submitReviewSchema', () => {
  it('exposes a shape that assembles into the same object schema', () => {
    const schema = z.object(submitReviewShape);
    expect(schema.safeParse({ summary: 'ok', verdict: 'COMMENT', scopeUsed: 'diff_only', findings: [] }).success).toBe(
      true,
    );
  });

  it('accepts a fully-valid payload', () => {
    const p = {
      summary: 'ok',
      verdict: 'APPROVE',
      scopeUsed: 'diff_only',
      findings: [
        { path: 'a.ts', line: 3, side: 'RIGHT', severity: 'warning', title: 't', body: 'b', suggestion: 'x' },
      ],
    };
    expect(submitReviewSchema.safeParse(p).success).toBe(true);
  });

  it('accepts a minimal finding (no line/side/suggestion)', () => {
    const p = {
      summary: 'ok',
      verdict: 'COMMENT',
      scopeUsed: 'worktree',
      findings: [{ path: 'a.ts', severity: 'nit', title: 't', body: 'b' }],
    };
    expect(submitReviewSchema.safeParse(p).success).toBe(true);
  });

  it('accepts a null line', () => {
    const p = {
      summary: 'ok',
      verdict: 'COMMENT',
      scopeUsed: 'diff_only',
      findings: [{ path: 'a.ts', line: null, severity: 'question', title: 't', body: 'b' }],
    };
    expect(submitReviewSchema.safeParse(p).success).toBe(true);
  });

  it('rejects an invalid verdict', () => {
    const p = {
      summary: 'ok',
      verdict: 'LGTM',
      scopeUsed: 'diff_only',
      findings: [],
    };
    expect(submitReviewSchema.safeParse(p).success).toBe(false);
  });

  it('rejects an invalid severity', () => {
    const p = {
      summary: 'ok',
      verdict: 'COMMENT',
      scopeUsed: 'diff_only',
      findings: [{ path: 'a.ts', severity: 'huge', title: 't', body: 'b' }],
    };
    expect(submitReviewSchema.safeParse(p).success).toBe(false);
  });

  it('rejects a payload missing the required summary', () => {
    const p = {
      verdict: 'COMMENT',
      scopeUsed: 'diff_only',
      findings: [],
    };
    expect(submitReviewSchema.safeParse(p).success).toBe(false);
  });

  it('rejects a finding missing the required body', () => {
    const p = {
      summary: 'ok',
      verdict: 'COMMENT',
      scopeUsed: 'diff_only',
      findings: [{ path: 'a.ts', severity: 'nit', title: 't' }],
    };
    expect(submitReviewSchema.safeParse(p).success).toBe(false);
  });

  it('rejects a non-integer line', () => {
    const p = {
      summary: 'ok',
      verdict: 'COMMENT',
      scopeUsed: 'diff_only',
      findings: [{ path: 'a.ts', line: 3.5, severity: 'warning', title: 't', body: 'b' }],
    };
    expect(submitReviewSchema.safeParse(p).success).toBe(false);
  });
});

// ---- follow-up on the previous review + the user story (all OPTIONAL) ----
describe('submitReviewSchema — follow-up and user-story fields', () => {
  const base = { summary: 'ok', verdict: 'COMMENT', scopeUsed: 'diff_only' } as const;

  it('still validates the old shape unchanged (no priorRef / followUp / ticket)', () => {
    const p = { ...base, findings: [{ path: 'a.ts', line: 1, severity: 'nit', title: 't', body: 'b' }] };
    const parsed = submitReviewSchema.safeParse(p);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.followUp).toBeUndefined();
      expect(parsed.data.ticket).toBeUndefined();
    }
  });

  it('accepts priorRef + followUp + a full ticket', () => {
    const p = {
      ...base,
      findings: [
        { path: 'a.ts', line: 3, severity: 'warning', title: 't', body: 'b', priorRef: 'P1' },
        { path: 'b.ts', severity: 'nit', title: 't', body: 'b', priorRef: null },
      ],
      followUp: [
        { ref: 'P1', status: 'not_addressed', explanation: 'Still there.' },
        { ref: 'P2', status: 'addressed', explanation: 'Fixed in a.ts.' },
        { ref: 'P3', status: 'partly_addressed', explanation: 'Half.' },
        { ref: 'P4', status: 'no_longer_applies', explanation: 'Gone.' },
      ],
      ticket: {
        alignment: 'partly_aligned',
        summary: 'Mostly.',
        criteria: [
          { ref: 'AC1', status: 'met', explanation: 'Yes.', path: 'a.ts', line: 4 },
          { ref: 'AC2', status: 'not_met', explanation: 'No.', path: null, line: null },
          { ref: 'AC3', status: 'unclear', explanation: '?' },
          { ref: 'AC4', status: 'partly_met', explanation: 'Some.' },
        ],
        missing: [{ title: 'Expiry', explanation: 'No expiry.' }],
        notRequested: [{ title: 'Extra flag', explanation: 'Adds a flag.', path: 'c.ts', line: 9 }],
      },
    };
    expect(submitReviewSchema.safeParse(p).success).toBe(true);
  });

  it('accepts a ticket carrying only alignment + summary', () => {
    const p = { ...base, findings: [], ticket: { alignment: 'unclear', summary: 'Hard to say.' } };
    expect(submitReviewSchema.safeParse(p).success).toBe(true);
  });

  it("rejects 'not_checked' as a follow-up status — only the server writes it", () => {
    const p = { ...base, findings: [], followUp: [{ ref: 'P1', status: 'not_checked', explanation: 'x' }] };
    expect(submitReviewSchema.safeParse(p).success).toBe(false);
  });

  it("rejects 'not_checked' as a criterion status", () => {
    const p = {
      ...base,
      findings: [],
      ticket: { alignment: 'aligned', summary: 's', criteria: [{ ref: 'AC1', status: 'not_checked', explanation: 'x' }] },
    };
    expect(submitReviewSchema.safeParse(p).success).toBe(false);
  });

  it('rejects a non-integer ticket line', () => {
    const p = {
      ...base,
      findings: [],
      ticket: { alignment: 'aligned', summary: 's', criteria: [{ ref: 'AC1', status: 'met', explanation: 'x', line: 2.5 }] },
    };
    expect(submitReviewSchema.safeParse(p).success).toBe(false);
  });

  it('rejects a follow-up entry with no explanation', () => {
    const p = { ...base, findings: [], followUp: [{ ref: 'P1', status: 'addressed' }] };
    expect(submitReviewSchema.safeParse(p).success).toBe(false);
  });
});
