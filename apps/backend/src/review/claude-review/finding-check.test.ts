// THE FINDING CHECK (finding-check.ts): each blocker and warning checked again in a fresh context.
// Pinned: it can only ask a finding as a question, never remove it; "unsure", a bad answer, a failed
// or missing completion change nothing; the most severe are checked first, capped; the run's own
// provider and model at medium effort; untrusted text is fenced.
//
//   pnpm --filter @pierre-review/backend test claude-review/finding-check
import { describe, expect, it } from 'vitest';
import type { AgentContext } from '../agent-context.js';
import {
  FINDING_CHECK_FILE_CHARS,
  FINDING_CHECK_MAX,
  applyFindingChecks,
  checkFindings,
  fileExcerpt,
  findingCheckPrompt,
  findingsToCheck,
  parseFindingCheck,
} from './finding-check.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const f = (severity: any, title = 't', line: number | null = 3) => ({ path: 'src/a.ts', line, severity, title, body: 'Body.' });

describe('the pure half', () => {
  it('parses the answer; anything else is ignored', () => {
    expect(parseFindingCheck('{"verdict":"wrong","reason":"Line 4 checks it."}')).toEqual({ verdict: 'wrong', reason: 'Line 4 checks it.' });
    expect(parseFindingCheck('```json\n{"verdict":"stands","reason":""}\n```')).toEqual({ verdict: 'stands', reason: '' });
    // "wrong" must say why.
    expect(parseFindingCheck('{"verdict":"wrong","reason":"  "}')).toBeNull();
    expect(parseFindingCheck('{"verdict":"drop"}')).toBeNull();
    expect(parseFindingCheck('no json')).toBeNull();
  });

  it('only "wrong" changes a finding, and only into a question; nothing is removed', () => {
    const fs = [f('blocker'), f('warning'), f('warning'), f('nit')];
    const answers = new Map([
      [0, { verdict: 'wrong' as const, reason: 'Line 4 checks it.' }],
      [1, { verdict: 'unsure' as const, reason: '' }],
      [3, { verdict: 'wrong' as const, reason: 'x' }],
    ]);
    const out = applyFindingChecks(fs, answers);
    expect(out.findings).toHaveLength(4);
    expect(out.downgraded).toBe(1);
    expect(out.findings[0]).toMatchObject({ severity: 'question' });
    expect(out.findings[0]!.body).toContain('Line 4 checks it.');
    expect(out.findings.slice(1).map((x) => x.severity)).toEqual(['warning', 'warning', 'nit']);
  });

  it('checks blockers first, then warnings, capped; never nits, questions or praise', () => {
    expect(findingsToCheck([f('nit'), f('warning'), f('blocker'), f('question'), f('praise'), f('warning')])).toEqual([2, 1, 5]);
    expect(findingsToCheck(Array.from({ length: FINDING_CHECK_MAX + 5 }, () => f('warning')))).toHaveLength(FINDING_CHECK_MAX);
  });

  it('shows a small file whole and a big one as a numbered window around the line', () => {
    expect(fileExcerpt('a\nb', 1)).toBe('a\nb');
    const big = Array.from({ length: 5000 }, (_, i) => `line ${i + 1} ${'x'.repeat(20)}`).join('\n');
    expect(big.length).toBeGreaterThan(FINDING_CHECK_FILE_CHARS);
    const ex = fileExcerpt(big, 2500);
    expect(ex).toContain('2500: line 2500');
    expect(ex.startsWith('(lines 2400-2599 of 5000)')).toBe(true);
  });

  it('fences the finding, the diff and the file with the nonce', () => {
    const p = findingCheckPrompt(f('warning', 'Null check'), '@@ -1 +1 @@\n+x', null, 'n0nce');
    expect(p).toContain('---BEGIN FINDING n0nce---\nNull check');
    expect(p).toContain('---BEGIN DIFF n0nce---');
    expect(p).toContain('---BEGIN FILE n0nce---\n(not available');
  });
});

describe('checkFindings', () => {
  const run = { accountId: 1, prId: 7, owner: 'acme', name: 'api', headSha: 'a'.repeat(40), diff: '', provider: 'codex' as const, model: 'gpt-6.1-sol' };
  const ctxWith = (complete: any, auth = 'ok'): AgentContext =>
    ({
      log: { info: () => {}, warn: () => {}, error: () => {} },
      recordAiUsage: async () => {},
      llm: { detectAuth: () => ({ status: auth }), detectProviderAuth: () => ({ status: auth }), complete },
    }) as any;

  it("runs on the run's provider and model at medium effort, and asks a wrong one as a question", async () => {
    const seen: any[] = [];
    const out = await checkFindings(
      ctxWith(async (o: any) => {
        seen.push(o);
        return { text: o.prompt.includes('Off-by-one') ? '{"verdict":"wrong","reason":"The loop stops at length - 1."}' : '{"verdict":"stands","reason":"ok"}' };
      }),
      run,
      [f('warning', 'Null check'), f('warning', 'Off-by-one'), f('nit', 'Name')],
    );
    expect(seen).toHaveLength(2);
    expect(seen.every((o) => o.provider === 'codex' && o.model === 'gpt-6.1-sol' && o.effort === 'medium')).toBe(true);
    expect(out.findings.map((x) => x.severity)).toEqual(['warning', 'question', 'nit']);
    expect(out).toMatchObject({ checked: 2, downgraded: 1 });
  });

  it('a failing completion, a thrown call, no credential or no seam change nothing', async () => {
    const fs = [f('blocker')];
    for (const ctx of [
      ctxWith(async () => {
        throw new Error('down');
      }),
      ctxWith(() => {
        throw new Error('sync');
      }),
      ctxWith(async () => ({ text: '{"verdict":"wrong","reason":"x"}' }), 'none'),
      ctxWith(undefined),
    ]) {
      const out = await checkFindings(ctx, run, fs);
      expect(out.findings).toEqual(fs);
    }
  });
});
