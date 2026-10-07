// THE CI REVIEW RECONCILE (reconcile.ts). What this pins:
//   1. ⚠ NEVER INVENTS A CAUSE: one item per failing check; an unreported ref is not_checked, a
//      check with no Actions log is no_log; an unknown ref is dropped.
//   2. The fix location is a REPOSITORY-RELATIVE path or nothing (absolute, `..` and URLs refused);
//      a not-checked item carries no path, line or suggestion.
//   3. A carried item keeps the path and suggestion it was explained with.
//
//   pnpm --filter @pierre-review/backend test ci-review/reconcile
import { describe, expect, it } from 'vitest';
import type { CheckRun } from '@pierre-review/shared';
import { planCiReview, selectCiFailures } from '../claude-review/ci-failures.js';
import { reconcileCiReview, safeRepoPath } from './reconcile.js';
import { carryKey } from './prepare.js';

const HEAD = 'a'.repeat(40);
const check = (name: string, state: CheckRun['state'], jobId: number | null): CheckRun => ({
  name,
  state,
  url: jobId != null ? `https://github.com/o/r/actions/runs/1/job/${jobId}` : `https://ci.example/${name}`,
  runId: jobId != null ? 1 : null,
  jobId,
});
const a = check('test', 'failure', 1);
const b = check('lint', 'failure', 2);
const ext = check('sonar', 'failure', null);
const plan = planCiReview(selectCiFailures([a, b, ext, check('ok', 'success', 3)], 'FAILURE', HEAD, null), [
  { check: { checkName: 'test', jobId: 1, url: a.url }, step: 'Run tests', log: { text: 'Error: boom', windowTruncated: false } },
  { check: { checkName: 'lint', jobId: 2, url: b.url }, step: null, log: { text: 'error TS2322', windowTruncated: false } },
]);

describe('reconcileCiReview', () => {
  it('one item per failing check; never an invented cause', () => {
    const r = reconcileCiReview(
      plan,
      {
        summary: '  The test fails on the new default. ',
        failures: [
          { ref: 'f1', cause: 'Snapshot out of date', explanation: 'x', category: 'test', fixableInPr: true, confidence: 80, path: 'src/a.test.ts', line: 9, suggestion: 'Update the snapshot.' },
          { ref: 'F9', cause: 'invented', explanation: 'y', category: 'code', fixableInPr: true, confidence: 80 },
        ],
      },
      new Map(),
    );
    expect(r.summary).toBe('The test fails on the new default.');
    expect(r.items.map((i) => [i.checkName, i.status, i.notCheckedReason])).toEqual([
      ['test', 'diagnosed', null],
      ['lint', 'not_checked', 'not_reported'],
      ['sonar', 'not_checked', 'no_log'],
    ]);
    expect(r.items[0]).toMatchObject({ path: 'src/a.test.ts', line: 9, suggestion: 'Update the snapshot.', fixableInPr: true, confidence: 80 });
    expect(r.items[1]).toMatchObject({ path: null, line: null, suggestion: null });
  });

  it('refuses a path outside the repository, falling back to a safe related file', () => {
    expect(safeRepoPath('/etc/passwd')).toBeNull();
    expect(safeRepoPath('../x')).toBeNull();
    expect(safeRepoPath('a/../../x')).toBeNull();
    expect(safeRepoPath('https://evil.example/x')).toBeNull();
    expect(safeRepoPath('./src/a.ts')).toBe('src/a.ts');
    const r = reconcileCiReview(
      plan,
      {
        summary: 's',
        failures: [
          {
            ref: 'F1',
            cause: 'c',
            explanation: 'e',
            category: 'code',
            fixableInPr: true, confidence: 80,
            path: '/etc/passwd',
            line: 3,
            relatedFiles: [{ path: '../up', line: 1 }, { path: 'src/b.ts', line: 7 }],
          },
        ],
      },
      new Map(),
    );
    expect(r.items[0]).toMatchObject({ path: 'src/b.ts', line: 7, relatedFiles: [{ path: 'src/b.ts', line: 7 }] });
  });

  it('a malformed first report does not shadow a valid second one', () => {
    const r = reconcileCiReview(
      plan,
      {
        summary: 's',
        failures: [
          { ref: 'F1', cause: '', explanation: 'e', category: 'code', fixableInPr: true, confidence: 80, suggestion: 'bad' },
          { ref: 'F1', cause: 'real', explanation: 'e', category: 'code', fixableInPr: true, confidence: 80, suggestion: 'good' },
        ],
      },
      new Map(),
    );
    expect(r.items[0]).toMatchObject({ cause: 'real', suggestion: 'good' });
  });

  it('a carried item keeps the location it was explained with', () => {
    const prior = {
      ref: 'F1',
      checkName: 'test',
      jobId: 1,
      step: 'Run tests',
      url: null,
      sent: true,
      carried: false,
      status: 'diagnosed' as const,
      notCheckedReason: null,
      cause: 'c',
      explanation: 'e',
      category: 'test' as const,
      fixableInPr: true,
      relatedFiles: [],
      assessedAtHead: HEAD,
    };
    const carried = planCiReview(selectCiFailures([a], 'FAILURE', HEAD, [prior]), []);
    const extras = new Map([[carryKey('test', 1), { path: 'src/a.ts', line: 2, suggestion: 'Fix it.' }]]);
    const r = reconcileCiReview(carried, null, extras);
    expect(r.items).toEqual([expect.objectContaining({ carried: true, path: 'src/a.ts', line: 2, suggestion: 'Fix it.' })]);
  });
});
