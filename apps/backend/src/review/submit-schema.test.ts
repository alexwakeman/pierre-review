import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildSubmitReviewShape, submitReviewShape } from './schema.js';

// The schema is BUILT from a zod namespace (ai/runtime.ts supplies the SDK's own in production);
// the test hands it the workspace's zod, which in dev is the same instance.
const submitReviewSchema = z.object(buildSubmitReviewShape(z));

describe('submitReviewSchema', () => {
  it('exposes a shape that assembles into the same object schema', async () => {
    const schema = z.object(await submitReviewShape());
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

// ---- follow-up on the previous review (OPTIONAL); no user-story field at all ----
describe('submitReviewSchema — follow-up fields', () => {
  const base = { summary: 'ok', verdict: 'COMMENT', scopeUsed: 'diff_only' } as const;

  it('still validates the old shape unchanged (no priorRef / followUp)', () => {
    const p = { ...base, findings: [{ path: 'a.ts', line: 1, severity: 'nit', title: 't', body: 'b' }] };
    const parsed = submitReviewSchema.safeParse(p);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.followUp).toBeUndefined();
  });

  it('accepts priorRef + followUp', () => {
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
    };
    expect(submitReviewSchema.safeParse(p).success).toBe(true);
  });

  it('has no story field: a `tickets` report is stripped, never kept as a verdict', () => {
    const p = {
      ...base,
      findings: [],
      tickets: [{ ref: 'T1', alignment: 'aligned', summary: 'Yes.', criteria: [{ text: 'c', status: 'met', explanation: 'x' }] }],
    };
    const parsed = submitReviewSchema.safeParse(p);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect('tickets' in parsed.data).toBe(false);
  });

  it("rejects 'not_checked' as a follow-up status — only the server writes it", () => {
    const p = { ...base, findings: [], followUp: [{ ref: 'P1', status: 'not_checked', explanation: 'x' }] };
    expect(submitReviewSchema.safeParse(p).success).toBe(false);
  });

  it('rejects a follow-up entry with no explanation', () => {
    const p = { ...base, findings: [], followUp: [{ ref: 'P1', status: 'addressed' }] };
    expect(submitReviewSchema.safeParse(p).success).toBe(false);
  });
});

describe('submitReviewSchema — CI failures', () => {
  const base = { summary: 'ok', verdict: 'COMMENT', scopeUsed: 'diff_only', findings: [] } as const;

  it('accepts a CI failure report and rejects a server-only or unknown category', () => {
    const ok = {
      ...base,
      ciFailures: [
        { ref: 'F1', cause: 'Type error', explanation: 'x', category: 'code', fixableInPr: true, relatedFiles: [{ path: 'a.ts', line: 3 }] },
        { ref: 'F2', cause: 'Runner lost', explanation: 'y', category: 'flaky_or_infra', fixableInPr: false, step: null },
      ],
    };
    expect(submitReviewSchema.safeParse(ok).success).toBe(true);
    for (const category of ['not_checked', 'build']) {
      const bad = { ...base, ciFailures: [{ ref: 'F1', cause: 'c', explanation: 'e', category, fixableInPr: true }] };
      expect(submitReviewSchema.safeParse(bad).success).toBe(false);
    }
  });
});
