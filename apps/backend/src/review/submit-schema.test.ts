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
