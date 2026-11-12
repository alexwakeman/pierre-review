// THE REVIEW LOOP'S ANSWERS (sandbox/workspace/review-response.ts): ONE validator text, compiled on the host
// and embedded in the checker. Pinned: every shown ref answered once; an unknown ref, a repeat or a bad
// action named and dropped; `not_applicable` only on a criterion (AC) or missing item (M); the reply's
// length; the checker script runs the SAME text (OK / problems, exit 0 / 1).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { REVIEW_RESPONSE_REPLY_MAX, reviewResponseCheckerSource, validateReviewResponse } from './review-response.js';

const SHOWN = ['F1', 'F2', 'AC3', 'M1'];
const dir = mkdtempSync(join(tmpdir(), 'limn-review-response-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('validateReviewResponse', () => {
  it('accepts one answer per shown ref', () => {
    const r = validateReviewResponse(
      {
        items: [
          { ref: 'F1', action: 'fixed', reply: 'Added the check.' },
          { ref: 'f2', action: 'pushed_back', reply: 'The caller validates it.' },
          { ref: 'AC3', action: 'not_applicable', reply: 'Emails are out of scope.' },
          { ref: 'M1', action: 'answered', reply: 'Done in F1.' },
        ],
      },
      SHOWN,
    );
    expect(r.problems).toEqual([]);
    expect(r.notReported).toEqual([]);
    expect(r.payload!.items.map((i) => `${i.ref}:${i.action}`)).toEqual(['F1:fixed', 'F2:pushed_back', 'AC3:not_applicable', 'M1:answered']);
  });

  it('names unknown refs, repeats, bad actions, not_applicable on a finding, a missing or long reply, and what has no answer', () => {
    const r = validateReviewResponse(
      {
        items: [
          { ref: 'F1', action: 'fixed', reply: 'ok' },
          { ref: 'F1', action: 'answered', reply: 'again' },
          { ref: 'F9', action: 'fixed', reply: 'unknown' },
          { ref: 'F2', action: 'not_applicable', reply: 'nope' },
          { ref: 'AC3', action: 'ignored', reply: 'x' },
          { ref: 'M1', action: 'answered', reply: 'x'.repeat(REVIEW_RESPONSE_REPLY_MAX + 1) },
        ],
      },
      SHOWN,
    );
    expect(r.payload!.items.map((i) => i.ref)).toEqual(['F1']);
    expect(r.notReported).toEqual(['F2', 'AC3', 'M1']);
    expect(r.problems.join('\n')).toMatch(/F1 is answered more than once/);
    expect(r.problems.join('\n')).toMatch(/"F9" is not an item in REVIEW\.md/);
    expect(r.problems.join('\n')).toMatch(/F2: "not_applicable" is only for a criterion/);
    expect(r.problems.join('\n')).toMatch(/\.action must be/);
    expect(r.problems.join('\n')).toMatch(/at most 600 characters/);
  });

  it('refuses a report that is not {items: [...]}', () => {
    expect(validateReviewResponse([], SHOWN).payload).toBeNull();
    expect(validateReviewResponse({ items: 'x' }, SHOWN).payload).toBeNull();
    expect(validateReviewResponse({ items: 'x' }, SHOWN).notReported).toEqual(SHOWN);
  });
});

describe('the checker script', () => {
  it('runs the same validator: OK, or the problems', () => {
    const report = join(dir, 'review-response.json');
    const refs = join(dir, 'review-refs.json');
    const checker = join(dir, 'check.cjs');
    writeFileSync(checker, reviewResponseCheckerSource({ reportFile: report, refsFile: refs }));
    writeFileSync(refs, JSON.stringify({ shown: ['F1', 'AC1'] }));
    writeFileSync(report, JSON.stringify({ items: [{ ref: 'F1', action: 'fixed', reply: 'done' }, { ref: 'AC1', action: 'not_applicable', reply: 'n/a' }] }));
    expect(execFileSync(process.execPath, [checker], { encoding: 'utf8' }).trim()).toBe('OK');
    writeFileSync(report, JSON.stringify({ items: [{ ref: 'F1', action: 'fixed', reply: 'done' }] }));
    let out = '';
    try {
      execFileSync(process.execPath, [checker], { encoding: 'utf8' });
    } catch (err) {
      out = String((err as { stdout?: string }).stdout ?? '');
    }
    expect(out).toContain('AC1 has no answer.');
  });
});
